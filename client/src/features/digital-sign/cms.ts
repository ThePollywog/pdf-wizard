/**
 * CMS (PKCS #7) signatures for PDF: build a detached CAdES/PAdES-B-B SignedData around a signature
 * value produced elsewhere (the CAC, via the signing bridge), and verify embedded signatures.
 *
 * Signing is split in two so the private key never has to be in the browser:
 *   const req = await buildSignedAttributes(documentBytes, signerCert)   // → req.digest to sign
 *   const cms = assembleSignedData(req, signatureValue, chain)          // → DER for /Contents
 */
import * as asn1js from 'asn1js';
import * as pkijs from 'pkijs';

const OID = {
  data: '1.2.840.113549.1.7.1',
  signedData: '1.2.840.113549.1.7.2',
  contentType: '1.2.840.113549.1.9.3',
  messageDigest: '1.2.840.113549.1.9.4',
  signingTime: '1.2.840.113549.1.9.5',
  signingCertificateV2: '1.2.840.113549.1.9.16.2.47',
  sha256: '2.16.840.1.101.3.4.2.1',
  rsaEncryption: '1.2.840.113549.1.1.1',
  ecdsaSha256: '1.2.840.10045.4.3.2',
  ecPublicKey: '1.2.840.10045.2.1',
  commonName: '2.5.4.3',
  email: '1.2.840.113549.1.9.1',
  organizationalUnit: '2.5.4.11',
  organization: '2.5.4.10',
  keyUsage: '2.5.29.15',
  extKeyUsage: '2.5.29.37',
  subjectAltName: '2.5.29.17',
} as const;

const buf = (u8: Uint8Array): ArrayBuffer => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', buf(data)));
}

// ── certificates ─────────────────────────────────────────────────────────────

export function parseCertificate(der: Uint8Array): pkijs.Certificate {
  const asn = asn1js.fromBER(buf(der));
  if (asn.offset === -1) throw new Error('The certificate could not be read.');
  return new pkijs.Certificate({ schema: asn.result });
}

function rdn(name: pkijs.RelativeDistinguishedNames, oid: string): string | undefined {
  const v = name.typesAndValues.find((t) => t.type === oid)?.value as { valueBlock?: { value?: string } } | undefined;
  return v?.valueBlock?.value;
}

export interface CertInfo {
  subjectCN: string;
  /** The subject has a common name (the PIV card-authentication certificate doesn't). */
  hasName: boolean;
  issuerCN: string;
  organization?: string;
  email?: string;
  serialHex: string;
  notBefore: Date;
  notAfter: Date;
  /** keyUsage digitalSignature / nonRepudiation bits (true when the extension is absent). */
  digitalSignature: boolean;
  nonRepudiation: boolean;
  keyAlgorithm: 'RSA' | 'EC' | 'other';
  /** SHA-256 of the DER, hex. */
  fingerprint: string;
}

export async function certInfo(der: Uint8Array): Promise<CertInfo> {
  const c = parseCertificate(der);
  const ku = c.extensions?.find((e) => e.extnID === OID.keyUsage);
  let digitalSignature = true;
  let nonRepudiation = true;
  if (ku) {
    const bits = asn1js.fromBER(ku.extnValue.valueBlock.valueHexView.slice().buffer).result as asn1js.BitString;
    const b0 = new Uint8Array(bits.valueBlock.valueHexView)[0] ?? 0;
    digitalSignature = !!(b0 & 0x80);
    nonRepudiation = !!(b0 & 0x40);
  }
  let email = rdn(c.subject, OID.email);
  const san = c.extensions?.find((e) => e.extnID === OID.subjectAltName)?.parsedValue as pkijs.AltName | undefined;
  if (!email && san?.altNames) email = san.altNames.find((n) => n.type === 1)?.value as string | undefined;
  const alg = c.subjectPublicKeyInfo.algorithm.algorithmId;
  const fp = await sha256(der);
  return {
    subjectCN: rdn(c.subject, OID.commonName) ?? 'Unknown signer',
    hasName: rdn(c.subject, OID.commonName) !== undefined,
    issuerCN: rdn(c.issuer, OID.commonName) ?? 'Unknown issuer',
    organization: rdn(c.subject, OID.organization),
    email,
    serialHex: [...new Uint8Array(c.serialNumber.valueBlock.valueHexView)].map((b) => b.toString(16).padStart(2, '0')).join(''),
    notBefore: c.notBefore.value,
    notAfter: c.notAfter.value,
    digitalSignature,
    nonRepudiation,
    keyAlgorithm: alg === OID.rsaEncryption ? 'RSA' : alg === OID.ecPublicKey ? 'EC' : 'other',
    fingerprint: [...fp].map((b) => b.toString(16).padStart(2, '0')).join(''),
  };
}

// ── signing ──────────────────────────────────────────────────────────────────

export interface SignRequest {
  signerCert: pkijs.Certificate;
  signerDer: Uint8Array;
  signerInfo: pkijs.SignerInfo;
  /** SHA-256 of the DER signed attributes: what the card signs. */
  digest: Uint8Array;
}

/** Build the signed attributes (contentType, messageDigest, signingCertificateV2) for `content`. */
export async function buildSignedAttributes(content: Uint8Array, signerDer: Uint8Array, opts: { signingTime?: Date } = {}): Promise<SignRequest> {
  const cert = parseCertificate(signerDer);
  const contentDigest = await sha256(content);
  const certHash = await sha256(signerDer);
  const attrs: pkijs.Attribute[] = [
    new pkijs.Attribute({ type: OID.contentType, values: [new asn1js.ObjectIdentifier({ value: OID.data })] }),
    new pkijs.Attribute({ type: OID.messageDigest, values: [new asn1js.OctetString({ valueHex: buf(contentDigest) })] }),
    new pkijs.Attribute({
      type: OID.signingCertificateV2,
      values: [
        // SigningCertificateV2 ::= SEQUENCE { certs SEQUENCE OF ESSCertIDv2 }  (hashAlgorithm defaults to SHA-256)
        new asn1js.Sequence({ value: [new asn1js.Sequence({ value: [new asn1js.Sequence({ value: [new asn1js.OctetString({ valueHex: buf(certHash) })] })] })] }),
      ],
    }),
  ];
  // PAdES forbids signing-time in the signed attributes (the time is /M); CMS for adbe.pkcs7.detached may carry it.
  if (opts.signingTime) attrs.push(new pkijs.Attribute({ type: OID.signingTime, values: [new asn1js.UTCTime({ valueDate: opts.signingTime })] }));

  const isEc = cert.subjectPublicKeyInfo.algorithm.algorithmId === OID.ecPublicKey;
  const signerInfo = new pkijs.SignerInfo({
    version: 1,
    sid: new pkijs.IssuerAndSerialNumber({ issuer: cert.issuer, serialNumber: cert.serialNumber }),
    digestAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: OID.sha256 }),
    signatureAlgorithm: isEc
      ? new pkijs.AlgorithmIdentifier({ algorithmId: OID.ecdsaSha256 })
      : new pkijs.AlgorithmIdentifier({ algorithmId: OID.rsaEncryption, algorithmParams: new asn1js.Null() }),
    signedAttrs: new pkijs.SignedAndUnsignedAttributes({ type: 0, attributes: attrs }),
  });
  // The signature covers the attributes DER-encoded as a SET (tag 0x31), not the [0] IMPLICIT form.
  const encoded = new Uint8Array(signerInfo.signedAttrs!.toSchema().toBER(false));
  encoded[0] = 0x31;
  return { signerCert: cert, signerDer, signerInfo, digest: await sha256(encoded) };
}

/** IEEE P1363 (r‖s) ECDSA signature → DER SEQUENCE { r INTEGER, s INTEGER }. */
export function ecdsaP1363ToDer(sig: Uint8Array): Uint8Array {
  const half = sig.length / 2;
  const int = (b: Uint8Array) => {
    let i = 0;
    while (i < b.length - 1 && b[i] === 0) i++;
    let v = b.subarray(i);
    if (v[0] & 0x80) v = new Uint8Array([0, ...v]);
    return new asn1js.Integer({ valueHex: buf(v) });
  };
  return new Uint8Array(new asn1js.Sequence({ value: [int(sig.subarray(0, half)), int(sig.subarray(half))] }).toBER(false));
}

/** DER ContentInfo(SignedData) with the signature value and the certificates (signer first). */
export function assembleSignedData(req: SignRequest, signature: Uint8Array, chainDer: Uint8Array[] = []): Uint8Array {
  req.signerInfo.signature = new asn1js.OctetString({ valueHex: buf(signature) });
  const seen = new Set<string>();
  const certs: pkijs.Certificate[] = [];
  for (const der of [req.signerDer, ...chainDer]) {
    const key = [...der.subarray(0, 64)].join(',') + der.length;
    if (seen.has(key)) continue;
    seen.add(key);
    certs.push(der === req.signerDer ? req.signerCert : parseCertificate(der));
  }
  const sd = new pkijs.SignedData({
    version: 1,
    encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: OID.data }),
    digestAlgorithms: [new pkijs.AlgorithmIdentifier({ algorithmId: OID.sha256 })],
    certificates: certs,
    signerInfos: [req.signerInfo],
  });
  const ci = new pkijs.ContentInfo({ contentType: OID.signedData, content: sd.toSchema(true) });
  return new Uint8Array(ci.toSchema().toBER(false));
}

// ── verification ─────────────────────────────────────────────────────────────

/** Strip the zero padding after the DER object in /Contents. */
export function trimDer(b: Uint8Array): Uint8Array {
  if (b[0] !== 0x30 || b.length < 2) return b;
  let len = b[1];
  let hdr = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[2 + i];
    hdr = 2 + n;
  }
  return b.subarray(0, Math.min(b.length, hdr + len));
}


export interface CmsVerification {
  /** The signed bytes match the signature (document integrity + signature math). */
  intact: boolean;
  signer: CertInfo | null;
  signerDer: Uint8Array | null;
  /** Chain validated to one of `trustedRoots` (null when no roots were given). */
  trusted: boolean | null;
  error?: string;
}

export async function verifyCms(
  cmsDer: Uint8Array,
  signedContent: Uint8Array,
  trustedRoots: Uint8Array[] = [],
  intermediates: Uint8Array[] = [],
): Promise<CmsVerification> {
  // /Contents is zero-padded: parse only the DER object at the start.
  const asn = asn1js.fromBER(buf(cmsDer));
  if (asn.offset === -1) return { intact: false, signer: null, signerDer: null, trusted: null, error: 'The signature data is damaged.' };
  let sd: pkijs.SignedData;
  try {
    const ci = new pkijs.ContentInfo({ schema: asn.result });
    sd = new pkijs.SignedData({ schema: ci.content });
  } catch (e) {
    return { intact: false, signer: null, signerDer: null, trusted: null, error: `Unsupported signature format: ${(e as Error).message}` };
  }
  const si = sd.signerInfos[0];
  let signerCert: pkijs.Certificate | undefined;
  if (si?.sid instanceof pkijs.IssuerAndSerialNumber) {
    const sid = si.sid;
    signerCert = sd.certificates?.find(
      (c): c is pkijs.Certificate => c instanceof pkijs.Certificate && c.serialNumber.isEqual(sid.serialNumber) && c.issuer.isEqual(sid.issuer),
    );
  }
  const signerDer = signerCert ? new Uint8Array(signerCert.toSchema().toBER(false)) : null;
  const signer = signerDer ? await certInfo(signerDer) : null;
  let intact = false;
  let error: string | undefined;
  try {
    const r = await sd.verify({ signer: 0, data: buf(signedContent), extendedMode: true, checkChain: false });
    intact = r.signatureVerified === true;
    if (!intact) error = 'The document was changed after it was signed, or the signature is invalid.';
  } catch (e) {
    const r = e as { message?: string; signatureVerified?: boolean };
    intact = false;
    error = r.message || 'The signature could not be verified.';
  }
  let trusted: boolean | null = null;
  if (trustedRoots.length && signerCert) {
    try {
      const engine = new pkijs.CertificateChainValidationEngine({
        trustedCerts: trustedRoots.map(parseCertificate),
        // The engine validates the LAST certificate of `certs`: the signer goes last.
        certs: [
          ...intermediates.map(parseCertificate),
          ...(sd.certificates ?? []).filter((c): c is pkijs.Certificate => c instanceof pkijs.Certificate && c !== signerCert),
          signerCert,
        ],
      });
      const r = await engine.verify();
      // Belt and braces: the validated path must include the signer's own certificate.
      trusted = r.result === true && !!r.certificatePath?.some((c) => c.serialNumber.isEqual(signerCert!.serialNumber) && c.issuer.isEqual(signerCert!.issuer));
    } catch {
      trusted = false;
    }
  }
  return { intact, signer, signerDer, trusted, error };
}
