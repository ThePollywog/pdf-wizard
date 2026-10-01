/**
 * "Sign with CAC" dialog and flow: pick a certificate from the card, optional reason / location,
 * then sign. The PIN is typed into the operating system's own prompt, never into PDF Wizard.
 */
import { useEffect, useState } from 'react';
import { CreditCard, FileSignature, ShieldAlert, TriangleAlert } from 'lucide-react';
import { actions, getDoc } from '@/core/store';
import type { DocId } from '@/core/types';
import { Button, Checkbox, confirmDialog, Modal, Select, Spinner, TextField } from '@/core/ui';
import * as engine from '@/core/engine';
import { bridgeStatus, type BridgeStatus, type SigningCertificate } from './bridge';
import { certInfo, type CertInfo } from './cms';
import { refresh } from './model';
import type { SignTarget } from './pdf';
import { brokenSignatures, signDocument } from './sign';

interface Choice {
  cert: SigningCertificate;
  info: CertInfo;
  expired: boolean;
}

const REASONS = ['', 'I am the author of this document', 'I have reviewed this document', 'I approve this document', 'I certify this information is correct'];

const fmt = (d: Date) => d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });

/** Signing certificates first (non-repudiation), then other digital-signature certificates; encryption-only ones dropped. */
async function choicesOf(certs: SigningCertificate[]): Promise<Choice[]> {
  const now = new Date();
  const out: Choice[] = [];
  for (const cert of certs) {
    try {
      const info = await certInfo(cert.der);
      if ((!info.digitalSignature && !info.nonRepudiation) || !info.hasName) continue;
      out.push({ cert, info, expired: now > info.notAfter || now < info.notBefore });
    } catch {
      /* unreadable certificate: skip */
    }
  }
  return out.sort((a, b) => Number(a.expired) - Number(b.expired) || Number(b.info.nonRepudiation) - Number(a.info.nonRepudiation));
}

export function NoBridgeHelp({ status }: { status: BridgeStatus }) {
  if (status.state === 'ready') return null;
  return (
    <div className="digital-sign-notice is-warning" role="status" data-testid="digital-sign-no-bridge">
      <TriangleAlert size={16} aria-hidden />
      <div>
        {status.state === 'no-extension' ? (
          <>
            <strong>The PDF Wizard CAC extension isn’t installed.</strong> Browsers can’t reach a smart card on their own; the extension
            and its small helper app pass the signing request to your card. Ask your administrator to install “PDF Wizard CAC
            Signing”, or see <code>extension/README.md</code>.
          </>
        ) : (
          <>
            <strong>The CAC helper app isn’t responding.</strong> The extension is installed but its helper isn’t (or couldn’t start).
            Run the installer from <code>native/</code> and reload this page.{status.detail ? <span className="muted"> ({status.detail})</span> : null}
          </>
        )}
      </div>
    </div>
  );
}

function SignBody({ docId, target, close }: { docId: DocId; target: SignTarget; close(signed: boolean): void }) {
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [choices, setChoices] = useState<Choice[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [certId, setCertId] = useState('');
  const [reason, setReason] = useState('');
  const [customReason, setCustomReason] = useState('');
  const [location, setLocation] = useState('');
  const [visible, setVisible] = useState(true);

  const load = async () => {
    setError(null);
    setChoices(null);
    const s = await bridgeStatus();
    setStatus(s);
    if (s.state !== 'ready') return;
    try {
      const c = await choicesOf(await s.signer.list());
      setChoices(c);
      setCertId(c.find((x) => !x.expired)?.cert.id ?? '');
    } catch (e) {
      setError((e as Error).message);
      setChoices([]);
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const chosen = choices?.find((c) => c.cert.id === certId) ?? null;
  const finalReason = reason === 'custom' ? customReason.trim() : reason;
  const canSign = status?.state === 'ready' && !!chosen && !chosen.expired;

  const sign = async () => {
    if (!canSign || status?.state !== 'ready' || !chosen) return;
    close(false);
    await runSigning(docId, target, chosen, status.signer, { reason: finalReason || undefined, location: location.trim() || undefined, visible });
  };

  return (
    <Modal
      title="Sign with CAC"
      icon={FileSignature}
      iconColor="var(--brand)"
      width={540}
      onClose={() => close(false)}
      className="digital-sign-dialog"
      footerStart={
        status?.state !== 'ready' ? (
          <Button variant="ghost" onClick={() => void load()} data-testid="digital-sign-retry">
            Check again
          </Button>
        ) : undefined
      }
      footer={
        <>
          <Button variant="secondary" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button variant="primary" icon={FileSignature} disabled={!canSign} onClick={() => void sign()} data-testid="digital-sign-confirm">
            Sign
          </Button>
        </>
      }
    >
      {!status ? (
        <div className="row muted">
          <Spinner size={16} /> Looking for your card…
        </div>
      ) : status.state !== 'ready' ? (
        <NoBridgeHelp status={status} />
      ) : !choices ? (
        <div className="row muted">
          <Spinner size={16} /> Reading certificates from your card…
        </div>
      ) : (
        <div className="digital-sign-form">
          {error && (
            <div className="digital-sign-notice is-error" role="alert">
              <ShieldAlert size={16} aria-hidden /> <span>{error}</span>
            </div>
          )}
          {!choices.length && !error && (
            <div className="digital-sign-notice is-warning" role="status" data-testid="digital-sign-no-certs">
              <CreditCard size={16} aria-hidden />
              <span>No signing certificates found. Insert your CAC into the reader and choose “Check again”.</span>
            </div>
          )}
          {choices.length > 0 && (
            <>
              <Select
                label="Certificate"
                value={certId}
                onChange={(v) => setCertId(String(v))}
                data-testid="digital-sign-cert"
                options={choices.map((c) => ({
                  value: c.cert.id,
                  label: `${c.info.subjectCN}${c.info.nonRepudiation ? ' (signature)' : ''}${c.expired ? ' (expired)' : ''}`,
                }))}
              />
              {chosen && (
                <div className="digital-sign-cert" data-testid="digital-sign-cert-details">
                  <div>
                    Issued by <strong>{chosen.info.issuerCN}</strong>
                  </div>
                  <div className="muted small">
                    Valid {fmt(chosen.info.notBefore)} – {fmt(chosen.info.notAfter)}
                    {chosen.cert.hardware ? ' · on your smart card' : ' · software certificate'}
                  </div>
                  {chosen.expired && <div className="digital-sign-expired">This certificate has expired and can’t be used to sign.</div>}
                </div>
              )}
              <Select
                label="Reason (optional)"
                value={reason}
                onChange={(v) => setReason(String(v))}
                data-testid="digital-sign-reason"
                options={[...REASONS.map((r) => ({ value: r, label: r || 'None' })), { value: 'custom', label: 'Other…' }]}
              />
              {reason === 'custom' && <TextField label="Reason" value={customReason} onChange={setCustomReason} maxLength={200} />}
              <TextField label="Location (optional)" value={location} onChange={setLocation} maxLength={120} placeholder="e.g. Fort Bragg, NC" data-testid="digital-sign-location" />
              <Checkbox label="Show name and date in the signature box" checked={visible} onChange={setVisible} />
              <p className="muted small">
                When you choose Sign, your computer asks for your CAC PIN. PDF Wizard never sees the PIN or the private key. After
                signing, any change other than filling form fields or adding another signature invalidates the signature.
              </p>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

export function openSignDialog(docId: DocId, target: SignTarget): Promise<boolean | undefined> {
  return actions.openModal<boolean>((close) => <SignBody docId={docId} target={target} close={(v) => close(v)} />);
}

async function runSigning(
  docId: DocId,
  target: SignTarget,
  chosen: Choice,
  signer: Parameters<typeof signDocument>[3],
  opts: Parameters<typeof signDocument>[4],
) {
  // Earlier signatures that the pending changes would invalidate: say so before signing.
  let base: Uint8Array;
  try {
    base = await engine.exportPdf(docId, { purpose: 'save' });
  } catch (e) {
    actions.toast(`Couldn’t prepare the document: ${(e as Error).message}`, { kind: 'error' });
    return;
  }
  const broken = await brokenSignatures(base);
  if (broken.length) {
    const ok = await confirmDialog({
      title: 'Existing signatures will be invalid',
      message: `Changes made since the document was signed (comments, drawings, page or content edits) break ${broken.length === 1 ? 'the signature of' : 'the signatures of'} ${broken.join(', ')}. Only filling form fields keeps earlier signatures valid. Sign anyway?`,
      confirmLabel: 'Sign anyway',
      danger: true,
    });
    if (!ok) return;
  }
  const done = await actions.withBusy(`Signing as ${chosen.info.subjectCN}… enter your PIN if asked`, async () => {
    await signDocument(docId, target, chosen.cert, signer, opts, base);
    return true;
  });
  if (!done) return;
  await refresh(docId);
  const d = getDoc(docId);
  actions.toast(`Signed “${d?.name ?? 'the document'}” as ${chosen.info.subjectCN}. Save or send it to keep the signature.`, { kind: 'success', duration: 7000 });
}
