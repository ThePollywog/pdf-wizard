/**
 * Sign a document and verify the signatures in one. Everything but the private-key operation runs
 * here in the browser; see bridge.ts for how the key operation reaches the CAC.
 */
import * as engine from '@/core/engine';
import { getDoc } from '@/core/store';
import type { DocId } from '@/core/types';
import type { Signer, SigningCertificate } from './bridge';
import { assembleSignedData, buildSignedAttributes, certInfo, ecdsaP1363ToDer, trimDer, verifyCms, type CertInfo } from './cms';
import { prepareSignature, readSignatures, type SignTarget } from './pdf';
import { trustAnchors } from './trust';

export interface SignOptions {
  reason?: string;
  location?: string;
  /** Show the signer's name and date in the field (default true). */
  visible?: boolean;
}

/** "2026.09.29 14:03:22 -04'00'", the date line DoD forms usually show. */
export function displayDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const a = Math.abs(off);
  return `${d.getFullYear()}.${p(d.getMonth() + 1)}.${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${off >= 0 ? '+' : '-'}${p(Math.floor(a / 60))}'${p(a % 60)}'`;
}

/** Signatures that the export about to be signed no longer keeps valid (changes made after they were applied). */
export async function brokenSignatures(bytes: Uint8Array): Promise<string[]> {
  const results = await verifyDocument(bytes);
  return results.filter((r) => r.status !== 'valid').map((r) => r.signer?.subjectCN ?? r.fieldName);
}

/**
 * Sign `docId` into `target` with `cert`. The document (with every pending change) is exported,
 * one incremental update with the signature is appended, and the result becomes the document's
 * file (undoable; saving or downloading it writes exactly these bytes).
 */
export async function signDocument(
  docId: DocId,
  target: SignTarget,
  cert: SigningCertificate,
  signer: Signer,
  opts: SignOptions = {},
  /** The export to sign, when the caller already made it. */
  exported?: Uint8Array,
): Promise<Uint8Array> {
  if (!getDoc(docId)) throw new Error('The document is no longer open.');
  const base = exported ?? (await engine.exportPdf(docId, { purpose: 'save' }));
  const info = await certInfo(cert.der);
  const now = new Date();
  const lines = [`Date: ${displayDate(now)}`];
  if (opts.reason) lines.push(`Reason: ${opts.reason}`);
  if (opts.location) lines.push(`Location: ${opts.location}`);
  const prepared = await prepareSignature(
    base,
    target,
    opts.visible === false ? null : { heading: 'Digitally signed by', name: info.subjectCN, lines },
    { signerName: info.subjectCN, reason: opts.reason, location: opts.location, date: now, subFilter: 'ETSI.CAdES.detached' },
  );
  const content = prepared.signedData();
  const req = await buildSignedAttributes(content, cert.der);
  const value = await signer.sign(cert.id, req.digest);
  const sig = value.format === 'ecdsa-p1363' ? ecdsaP1363ToDer(value.signature) : value.signature;
  const cms = assembleSignedData(req, sig, cert.chain);
  const check = await verifyCms(cms, content);
  if (!check.intact) throw new Error('The card’s signature doesn’t match the selected certificate. Choose the certificate again and retry.');
  const signed = prepared.finish(cms);
  const committed = await engine.replaceBytes(docId, 'Digital signature', () => signed, { dropObjects: true });
  engine.markPristine(docId, committed);
  return committed;
}

// ── verification ─────────────────────────────────────────────────────────────

export type SignatureStatus = 'valid' | 'invalid' | 'unknown';

export interface SignatureReport {
  fieldName: string;
  pageIndex: number;
  status: SignatureStatus;
  signer: CertInfo | null;
  /** /M of the signature dictionary, parsed. */
  signedAt: Date | null;
  reason?: string;
  location?: string;
  /** The file was changed (incremental updates) after this signature; the signed revision itself is intact. */
  laterChanges: boolean;
  /** Chains to a trusted root (DoD PKI bundle, if present). null = no trust list available. */
  trusted: boolean | null;
  /** Certificate was valid at signing time. */
  certValidAtSigning: boolean | null;
  message: string;
}

export function parsePdfDate(s: string | undefined): Date | null {
  const m = s && /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?([Zz+-])?(\d{2})?'?(\d{2})?/.exec(s);
  if (!m) return null;
  const n = (i: number, d = 0) => (m[i] ? Number(m[i]) : d);
  let t = Date.UTC(n(1), n(2, 1) - 1, n(3, 1), n(4), n(5), n(6));
  if (m[7] === '+' || m[7] === '-') t -= (m[7] === '+' ? 1 : -1) * (n(8) * 60 + n(9)) * 60_000;
  return new Date(t);
}

export async function verifyDocument(bytes: Uint8Array): Promise<SignatureReport[]> {
  const sigs = await readSignatures(bytes);
  const roots = sigs.length ? await trustAnchors() : { roots: [], intermediates: [] };
  const out: SignatureReport[] = [];
  for (const s of sigs) {
    const [a, b, c, d] = s.byteRange;
    const base: Omit<SignatureReport, 'status' | 'signer' | 'trusted' | 'certValidAtSigning' | 'message'> = {
      fieldName: s.fieldName,
      pageIndex: s.pageIndex,
      signedAt: parsePdfDate(s.date),
      reason: s.reason,
      location: s.location,
      laterChanges: false,
    };
    if (s.byteRange.length !== 4 || [a, b, c, d].some((x) => !Number.isInteger(x) || x < 0) || a !== 0 || c < b || c + d > bytes.length) {
      out.push({ ...base, status: 'invalid', signer: null, trusted: null, certValidAtSigning: null, message: 'The signature’s byte range is damaged.' });
      continue;
    }
    const content = new Uint8Array(b + d);
    content.set(bytes.subarray(0, b), 0);
    content.set(bytes.subarray(c, c + d), b);
    if (!/^(ETSI\.CAdES\.detached|adbe\.pkcs7\.detached)$/.test(s.subFilter)) {
      out.push({ ...base, status: 'unknown', signer: null, trusted: null, certValidAtSigning: null, message: `Signature format ${s.subFilter || '(none)'} isn’t supported for checking.` });
      continue;
    }
    const v = await verifyCms(trimDer(s.contents), content, roots.roots, roots.intermediates);
    const at = base.signedAt ?? new Date();
    const certValid = v.signer ? at >= v.signer.notBefore && at <= v.signer.notAfter : null;
    const laterChanges = c + d < bytes.length;
    out.push({
      ...base,
      laterChanges,
      status: v.intact ? 'valid' : 'invalid',
      signer: v.signer,
      trusted: v.trusted,
      certValidAtSigning: certValid,
      message: !v.intact
        ? v.error ?? 'The signature is invalid.'
        : laterChanges
          ? 'Signed content unchanged. The document was updated after this signature (e.g. form fields filled or later signatures added).'
          : 'Signed content unchanged since it was signed.',
    });
  }
  return out;
}
