/**
 * Trust anchors for checking who signed: the public DoD PKI bundle (roots + issuing CAs) shipped in
 * public/trust/dod-pki.json, converted from DISA's unclass-certificates_pkcs7_DoD.zip. Only the four
 * DoD roots pinned below are used as roots, whatever the file says; everything else in it is an
 * intermediate that helps build the chain when the signature doesn't embed it.
 * Revocation (CRL/OCSP) is not checked: that needs the network.
 */
import { sha256 } from './cms';
import { assetUrl } from '@/core/util';

const URL_ = assetUrl('trust/dod-pki.json');

/** SHA-256 fingerprints of DoD Root CA 3–6. */
const PINNED_ROOTS = new Set([
  'B107B33F453E5510F68E513110C6F6944BACC263DF0137F821C1B3C2F8F863D2',
  '559A5189452B13F8233F0022363C06F26E3C517C1D4B77445035959DF3244F74',
  '1F4EDE9DC2A241F6521BF518424ACD49EBE84420E69DAF5BAC57AF1F8EE294A9',
  '2A5E41ACA93DF7CC496D2369B7A0A037045D502F1ABAAF76975FC07C6660CF93',
]);

export interface TrustAnchors {
  roots: Uint8Array[];
  intermediates: Uint8Array[];
}

let cached: Promise<TrustAnchors> | null = null;

const dec = (s: string) => {
  const bin = atob(s);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
};

export function trustAnchors(): Promise<TrustAnchors> {
  cached ??= (async () => {
    try {
      const res = await fetch(URL_);
      if (!res.ok) return { roots: [], intermediates: [] };
      const j = (await res.json()) as { certificates: { der: string }[] };
      const roots: Uint8Array[] = [];
      const intermediates: Uint8Array[] = [];
      for (const c of j.certificates) {
        const der = dec(c.der);
        const fp = [...(await sha256(der))].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
        (PINNED_ROOTS.has(fp) ? roots : intermediates).push(der);
      }
      return { roots, intermediates };
    } catch {
      return { roots: [], intermediates: [] };
    }
  })();
  return cached;
}
