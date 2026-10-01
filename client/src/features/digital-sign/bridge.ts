/**
 * Signing backends. The page never sees a private key or a PIN: it asks a backend to sign a
 * SHA-256 digest with a certificate's key.
 *
 *  - CAC bridge (production): the PDF Wizard CAC extension (extension/) injects a content script that
 *    relays window messages to its background worker, which talks to the native helper
 *    (native/macos, native/windows) over Chrome native messaging. The helper signs with the smart
 *    card through the OS keystore (macOS CryptoTokenKit / Windows CNG), which shows the PIN prompt.
 *
 *      page → window.postMessage({ channel: 'pdfwizard-cac', dir: 'request', id, type, ...payload })
 *      page ← window.postMessage({ channel: 'pdfwizard-cac', dir: 'response', id, ok, result | error })
 *      types: 'status' → { helper: boolean, version? }
 *             'list'   → { certificates: { id, label, der (base64), chain?: base64[], hardware? }[] }
 *             'sign'   → { signature (base64), format: 'pkcs1' | 'ecdsa-der' | 'ecdsa-p1363' }  for { id, digest (base64), hash: 'sha256' }
 *
 *    The content script marks <html data-pdfwizard-cac="<version>"> so the page can tell it's there.
 *
 *  - Test signer (development builds only): a throwaway RSA key and self-signed certificate made
 *    with WebCrypto, for trying signing without a card and for the e2e suite
 *    (`window.__digitalSign.enableTestSigner()`).
 */
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';

export interface SigningCertificate {
  id: string;
  /** What the OS calls it (usually the subject CN). */
  label: string;
  der: Uint8Array;
  /** Issuing CA certificates the helper found (may be empty). */
  chain: Uint8Array[];
  /** Key lives on a smart card / hardware token. */
  hardware: boolean;
}

export interface SignatureValue {
  signature: Uint8Array;
  format: 'pkcs1' | 'ecdsa-der' | 'ecdsa-p1363';
}

export interface Signer {
  kind: 'cac' | 'test';
  list(): Promise<SigningCertificate[]>;
  sign(certId: string, digest: Uint8Array): Promise<SignatureValue>;
}

export type BridgeStatus =
  | { state: 'ready'; signer: Signer; version?: string }
  | { state: 'no-extension' }
  | { state: 'no-helper'; detail?: string };

const b64 = {
  enc(u8: Uint8Array): string {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    return btoa(s);
  },
  dec(s: string): Uint8Array {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
};

// ── extension bridge ─────────────────────────────────────────────────────────

const CHANNEL = 'pdfwizard-cac';
let seq = 0;
const pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void; timer: number }>();
let listening = false;

function listen() {
  if (listening) return;
  listening = true;
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const m = e.data as { channel?: string; dir?: string; id?: number; ok?: boolean; result?: unknown; error?: string };
    if (!m || m.channel !== CHANNEL || m.dir !== 'response' || typeof m.id !== 'number') return;
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.ok) p.resolve(m.result);
    else p.reject(new Error(m.error || 'The CAC helper reported an error.'));
  });
}

function request<T>(type: string, payload: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
  listen();
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pending.delete(id);
      reject(new Error('The CAC helper didn’t answer. Check that the card reader is connected and try again.'));
    }, timeoutMs);
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
    window.postMessage({ channel: CHANNEL, dir: 'request', id, type, ...payload }, location.origin);
  });
}

const extensionVersion = () => document.documentElement.dataset.pdfwizardCac;

const cacSigner: Signer = {
  kind: 'cac',
  async list() {
    const r = await request<{ certificates: { id: string; label: string; der: string; chain?: string[]; hardware?: boolean }[] }>('list');
    return r.certificates.map((c) => ({
      id: c.id,
      label: c.label,
      der: b64.dec(c.der),
      chain: (c.chain ?? []).map(b64.dec),
      hardware: c.hardware ?? true,
    }));
  },
  async sign(certId, digest) {
    // Generous timeout: the user is typing their PIN into the OS prompt.
    const r = await request<{ signature: string; format: SignatureValue['format'] }>('sign', { certId, digest: b64.enc(digest), hash: 'sha256' }, 180_000);
    return { signature: b64.dec(r.signature), format: r.format };
  },
};

let testSigner: Signer | null = null;

/** Which backend is available right now. */
export async function bridgeStatus(): Promise<BridgeStatus> {
  if (testSigner) return { state: 'ready', signer: testSigner, version: 'test' };
  // The content script runs at document_start; give it a moment on a fresh page load.
  for (let i = 0; i < 10 && !extensionVersion(); i++) await new Promise((r) => setTimeout(r, 50));
  const version = extensionVersion();
  if (!version) return { state: 'no-extension' };
  try {
    const s = await request<{ helper: boolean; version?: string; error?: string }>('status', {}, 5_000);
    if (!s.helper) return { state: 'no-helper', detail: s.error };
    return { state: 'ready', signer: cacSigner, version: s.version ?? version };
  } catch (e) {
    return { state: 'no-helper', detail: (e as Error).message };
  }
}

// ── test signer (development builds) ─────────────────────────────────────────

/** RSA PKCS#1 v1.5 signature of a SHA-256 digest with a JWK private key (what a card does). */
async function rsaSignDigest(jwk: JsonWebKey, digest: Uint8Array): Promise<Uint8Array> {
  const big = (s: string) => {
    const b = b64.dec(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
    return BigInt('0x' + ([...b].map((x) => x.toString(16).padStart(2, '0')).join('') || '0'));
  };
  const n = big(jwk.n!);
  const d = big(jwk.d!);
  const k = Math.ceil(n.toString(16).length / 2);
  const prefix = [0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05, 0x00, 0x04, 0x20];
  const t = [...prefix, ...digest];
  const em = [0x00, 0x01, ...new Array(k - t.length - 3).fill(0xff), 0x00, ...t];
  let m = BigInt('0x' + em.map((x) => x.toString(16).padStart(2, '0')).join(''));
  let result = 1n;
  let e = d;
  m %= n;
  while (e > 0n) {
    if (e & 1n) result = (result * m) % n;
    m = (m * m) % n;
    e >>= 1n;
  }
  const hex = result.toString(16).padStart(k * 2, '0');
  return new Uint8Array(hex.match(/../g)!.map((h) => parseInt(h, 16)));
}

/** A self-signed certificate like a CAC signature certificate (digitalSignature + nonRepudiation). */
export async function makeTestIdentity(commonName = 'DOE.JANE.Q.1234567890'): Promise<{ der: Uint8Array; jwk: JsonWebKey }> {
  const keys = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const cert = new pkijs.Certificate();
  cert.version = 2;
  cert.serialNumber = new asn1js.Integer({ value: Date.now() % 2 ** 31 });
  const name = (cn: string) => [
    new pkijs.AttributeTypeAndValue({ type: '2.5.4.6', value: new asn1js.PrintableString({ value: 'US' }) }),
    new pkijs.AttributeTypeAndValue({ type: '2.5.4.10', value: new asn1js.PrintableString({ value: 'PDF Wizard Test' }) }),
    new pkijs.AttributeTypeAndValue({ type: '2.5.4.3', value: new asn1js.Utf8String({ value: cn }) }),
  ];
  cert.issuer.typesAndValues = name('PDF Wizard Test CA');
  cert.subject.typesAndValues = name(commonName);
  cert.notBefore.value = new Date(Date.now() - 86_400_000);
  cert.notAfter.value = new Date(Date.now() + 365 * 86_400_000);
  const ku = new asn1js.BitString({ valueHex: new Uint8Array([0xc0]).buffer, unusedBits: 6 });
  cert.extensions = [new pkijs.Extension({ extnID: '2.5.29.15', critical: true, extnValue: ku.toBER(false) })];
  await cert.subjectPublicKeyInfo.importKey(keys.publicKey);
  await cert.sign(keys.privateKey, 'SHA-256');
  return { der: new Uint8Array(cert.toSchema(true).toBER(false)), jwk: await crypto.subtle.exportKey('jwk', keys.privateKey) };
}

export async function enableTestSigner(commonName?: string): Promise<SigningCertificate> {
  const { der, jwk } = await makeTestIdentity(commonName);
  const cert: SigningCertificate = { id: 'test', label: commonName ?? 'DOE.JANE.Q.1234567890', der, chain: [], hardware: false };
  testSigner = {
    kind: 'test',
    list: async () => [cert],
    sign: async (_id, digest) => ({ signature: await rsaSignDigest(jwk, digest), format: 'pkcs1' }),
  };
  return cert;
}

/** For scripts/sign-selftest.ts. */
export const __rsaSignDigest = rsaSignDigest;

export function clearTestSigner() {
  testSigner = null;
}
