/** Task panel ("Digitally sign") and right-rail "Signatures" panel. */
import { useEffect, useState } from 'react';
import { FileSignature, ShieldCheck, ShieldQuestion, ShieldX, SquareDashedMousePointer } from 'lucide-react';
import { actions, useApp } from '@/core/store';
import type { DocId } from '@/core/types';
import { Button, EmptyState, Spinner } from '@/core/ui';
import { bridgeStatus, enableTestSigner, type BridgeStatus } from './bridge';
import { TOOL_PLACE, useSignatures } from './model';
import type { SignatureReport } from './sign';
import { NoBridgeHelp, openSignDialog } from './SignDialog';

const fmtDate = (d: Date | null) =>
  d ? d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'unknown time';

function statusOf(r: SignatureReport): { tone: 'ok' | 'warn' | 'bad'; label: string; Icon: typeof ShieldCheck } {
  if (r.status === 'invalid') return { tone: 'bad', label: 'Invalid', Icon: ShieldX };
  if (r.status === 'unknown') return { tone: 'warn', label: 'Not checked', Icon: ShieldQuestion };
  if (r.trusted === false || r.certValidAtSigning === false) return { tone: 'warn', label: 'Valid, identity not verified', Icon: ShieldQuestion };
  return { tone: 'ok', label: r.trusted ? 'Valid, DoD PKI' : 'Valid', Icon: ShieldCheck };
}

export function SignatureList({ docId }: { docId: DocId }) {
  const st = useSignatures(docId);
  if (!st || (st.checking && !st.reports)) {
    return (
      <div className="row muted small">
        <Spinner size={14} /> Checking signatures…
      </div>
    );
  }
  const reports = st.reports ?? [];
  const empty = st.fields.filter((f) => !f.signed);
  return (
    <div className="digital-sign-list" data-testid="digital-sign-list">
      {reports.length === 0 && empty.length === 0 && <p className="muted small">This document has no signatures or signature fields.</p>}
      {reports.map((r) => {
        const s = statusOf(r);
        return (
          <div key={r.fieldName} className={`digital-sign-item is-${s.tone}`} data-testid="digital-sign-signature" data-status={r.status} data-trusted={String(r.trusted)}>
            <s.Icon size={18} className="digital-sign-item-icon" aria-hidden />
            <div className="digital-sign-item-body">
              <div className="digital-sign-item-name">{r.signer?.subjectCN ?? r.fieldName}</div>
              <div className="small">
                <span className={`digital-sign-badge is-${s.tone}`}>{s.label}</span> · {fmtDate(r.signedAt)}
              </div>
              <div className="muted small">{r.message}</div>
              {r.signer && <div className="muted small">Issued by {r.signer.issuerCN}</div>}
              {r.trusted === false && (
                <div className="muted small">The certificate doesn’t chain to a DoD root in PDF Wizard’s trust list. Check the signer before relying on it.</div>
              )}
              {r.reason && <div className="small">Reason: {r.reason}</div>}
              {r.pageIndex >= 0 && (
                <button className="link-btn small" onClick={() => actions.goToPage(docId, r.pageIndex)}>
                  Go to page {r.pageIndex + 1}
                </button>
              )}
            </div>
          </div>
        );
      })}
      {empty.map((f) => (
        <div key={f.fieldRef} className="digital-sign-item is-empty" data-testid="digital-sign-empty-field" data-field-name={f.name}>
          <FileSignature size={18} className="digital-sign-item-icon" aria-hidden />
          <div className="digital-sign-item-body">
            <div className="digital-sign-item-name">{f.name}</div>
            <div className="muted small">Empty signature field{f.pageIndex >= 0 ? ` · page ${f.pageIndex + 1}` : ''}</div>
          </div>
          <Button size="sm" variant="primary" onClick={() => void openSignDialog(docId, { kind: 'field', fieldRef: f.fieldRef })} data-testid="digital-sign-sign-field">
            Sign
          </Button>
        </div>
      ))}
    </div>
  );
}

export function DigitalSignPanel() {
  const docId = useApp((s) => s.activeDocId);
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  useEffect(() => {
    let alive = true;
    void bridgeStatus().then((s) => alive && setStatus(s));
    return () => {
      alive = false;
    };
  }, []);
  if (!docId) {
    return (
      <div className="digital-sign-panel">
        <EmptyState icon={FileSignature} title="No document open" description="Open a PDF to sign it with your CAC." compact />
      </div>
    );
  }
  return (
    <div className="digital-sign-panel" data-testid="digital-sign-panel">
      <p className="digital-sign-intro">Sign with your Common Access Card. Click an empty signature field, or draw a new one.</p>
      {status && <NoBridgeHelp status={status} />}
      {status?.state === 'ready' && status.signer.kind === 'test' && (
        <div className="digital-sign-notice is-warning" role="status">
          <ShieldQuestion size={16} aria-hidden /> <span>Development test certificate in use. Signatures made with it aren’t trusted.</span>
        </div>
      )}
      <Button icon={SquareDashedMousePointer} onClick={() => actions.setTool(TOOL_PLACE)} data-testid="digital-sign-place">
        Draw a signature field
      </Button>
      {import.meta.env.DEV && status?.state !== 'ready' && (
        <Button
          variant="ghost"
          size="sm"
          onClick={async () => {
            await enableTestSigner();
            setStatus(await bridgeStatus());
          }}
          data-testid="digital-sign-use-test"
        >
          Use a test certificate (development only)
        </Button>
      )}
      <div className="digital-sign-section-title">Signatures in this document</div>
      <SignatureList docId={docId} />
    </div>
  );
}

export function SignaturesRailPanel({ docId }: { docId: DocId }) {
  return (
    <div className="digital-sign-panel" data-testid="digital-sign-rail">
      <SignatureList docId={docId} />
    </div>
  );
}
