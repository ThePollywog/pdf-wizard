/**
 * Standard security handler password checks (PDF 32000-2 §7.6.4). pdf.js and pdf-lib accept
 * either password without saying which one matched; the engine needs to know so that a document
 * opened with its permissions (owner) password keeps its original open (user) password when saved.
 *
 *   identifyPassword(bytes, password) → which role the password has, the user password when it
 *     can be determined (recovered from the owner password for RC4/AES-128 files), and the file
 *     encryption key + /Encrypt entries (`KeptEncryption`) when pdf-lib can reproduce the cipher.
 *   keptEncryptionOptions / restoreKeptEncryption → re-encrypt a saved copy with the ORIGINAL
 *     key and /Encrypt entries, so both passwords and the permissions stay exactly as they were
 *     (what desktop editors do when you save a protected file without changing its security).
 *
 * AES-256 (R5/R6) user passwords can't be recovered from the owner password (only an empty one
 * can be detected). Hashing uses Web Crypto (secure contexts only); MD5 and RC4 are implemented here.
 */
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString, type PDFObject } from '@cantoo/pdf-lib';

export interface PasswordRole {
  user: boolean;
  owner: boolean;
  /** The document's open password when it could be determined ('' = none), else undefined. */
  userPassword?: string;
  /** Set when the file can be re-encrypted exactly as it was (see restoreKeptEncryption). */
  kept?: KeptEncryption;
}

type Algorithm = 'AES-256' | 'AES-128' | 'RC4-128' | 'RC4-40';

/** The original encryption of a file: its file key and the /Encrypt and /ID entries that go with it. */
export interface KeptEncryption {
  algorithm: Algorithm;
  v: number;
  r: number;
  length: number;
  p: number;
  o: Uint8Array;
  u: Uint8Array;
  oe?: Uint8Array;
  ue?: Uint8Array;
  perms?: Uint8Array;
  ids: [Uint8Array, Uint8Array];
  fileKey: Uint8Array;
}

interface EncryptParams {
  v: number;
  r: number;
  length: number;
  p: number;
  o: Uint8Array;
  u: Uint8Array;
  oe: Uint8Array | null;
  ue: Uint8Array | null;
  perms: Uint8Array | null;
  id0: Uint8Array;
  ids: [Uint8Array, Uint8Array] | null;
  encryptMetadata: boolean;
  /** The cipher when pdf-lib's writer can reproduce it (standard crypt filter layout), else null. */
  algorithm: Algorithm | null;
}

const PAD = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);

// ── primitives ───────────────────────────────────────────────────────────────

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function equal(a: Uint8Array, b: Uint8Array, n = Math.max(a.length, b.length)): boolean {
  if (a.length < n || b.length < n) return false;
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return false;
  return true;
}

function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = new Uint8Array(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
    out[k] = data[k] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}

const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
const MD5_K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);

function md5(data: Uint8Array): Uint8Array {
  const len = data.length;
  const blocks = ((len + 8) >>> 6) + 1;
  const buf = new Uint8Array(blocks * 64);
  buf.set(data);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(buf.length - 8, (len * 8) >>> 0, true);
  dv.setUint32(buf.length - 4, Math.floor(len / 0x20000000), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const m = new Uint32Array(16);
  for (let off = 0; off < buf.length; off += 64) {
    for (let i = 0; i < 16; i++) m[i] = dv.getUint32(off + i * 4, true);
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number, g: number;
      if (i < 16) [f, g] = [(b & c) | (~b & d), i];
      else if (i < 32) [f, g] = [(d & b) | (~d & c), (5 * i + 1) % 16];
      else if (i < 48) [f, g] = [b ^ c ^ d, (3 * i + 5) % 16];
      else [f, g] = [c ^ (b | ~d), (7 * i) % 16];
      const s = MD5_S[(i >> 4) * 4 + (i % 4)];
      const x = (a + f + MD5_K[i] + m[g]) >>> 0;
      [a, d, c] = [d, c, b];
      b = (b + ((x << s) | (x >>> (32 - s)))) >>> 0;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  [a0, b0, c0, d0].forEach((v, i) => ov.setUint32(i * 4, v, true));
  return out;
}

async function sha(alg: 'SHA-256' | 'SHA-384' | 'SHA-512', data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest(alg, data as BufferSource));
}

async function aes128cbc(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key as BufferSource, 'AES-CBC', false, ['encrypt']);
  // Web Crypto always appends a PKCS#7 padding block; `data` is block-aligned, so drop it.
  const out = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: iv as BufferSource }, k, data as BufferSource));
  return out.subarray(0, data.length);
}

/** AES-CBC decryption of block-aligned data without padding (Web Crypto insists on PKCS#7). */
async function aesCbcDecryptRaw(key: Uint8Array, iv: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key as BufferSource, 'AES-CBC', false, ['encrypt', 'decrypt']);
  // Append a block that decrypts to a full padding block: E(0x10… XOR last ciphertext block).
  const last = data.subarray(data.length - 16);
  const padBlock = new Uint8Array(16).fill(16);
  const extra = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: last as BufferSource }, k, padBlock)).subarray(0, 16);
  const out = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: iv as BufferSource }, k, concat(data, extra) as BufferSource);
  return new Uint8Array(out);
}

// ── R2–R4 (RC4 / AES-128) ────────────────────────────────────────────────────

/** PDFDocEncoding-ish password bytes, like pdf.js (low byte of each UTF-16 code unit). */
const latin1Bytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

function padPassword(pw: Uint8Array): Uint8Array {
  const out = new Uint8Array(32);
  const n = Math.min(32, pw.length);
  out.set(pw.subarray(0, n));
  out.set(PAD.subarray(0, 32 - n), n);
  return out;
}

const keyLength = (e: EncryptParams) => (e.r === 2 ? 5 : Math.max(5, Math.min(16, (e.length || 40) >> 3)));

function fileKeyR4(e: EncryptParams, padded: Uint8Array): Uint8Array {
  const p = new Uint8Array(4);
  new DataView(p.buffer).setInt32(0, e.p, true);
  const noMeta = e.r >= 4 && !e.encryptMetadata ? Uint8Array.from([0xff, 0xff, 0xff, 0xff]) : new Uint8Array(0);
  const n = keyLength(e);
  let h = md5(concat(padded, e.o.subarray(0, 32), p, e.id0, noMeta));
  if (e.r >= 3) for (let i = 0; i < 50; i++) h = md5(h.subarray(0, n));
  return h.subarray(0, n);
}

const xorKey = (key: Uint8Array, i: number) => key.map((b) => b ^ i);

function checkUserR4(e: EncryptParams, padded: Uint8Array): boolean {
  const key = fileKeyR4(e, padded);
  if (e.r === 2) return equal(rc4(key, PAD), e.u, 32);
  let x = rc4(key, md5(concat(PAD, e.id0)));
  for (let i = 1; i <= 19; i++) x = rc4(xorKey(key, i), x);
  return equal(x, e.u, 16);
}

/** Algorithm 7: decrypt /O with the owner password → the padded user password. */
function paddedUserFromOwnerR4(e: EncryptParams, ownerPw: Uint8Array): Uint8Array {
  const n = keyLength(e);
  let h = md5(padPassword(ownerPw));
  if (e.r >= 3) for (let i = 0; i < 50; i++) h = md5(h);
  const key = h.subarray(0, n);
  if (e.r === 2) return rc4(key, e.o.subarray(0, 32));
  let x = e.o.subarray(0, 32);
  for (let i = 19; i >= 0; i--) x = rc4(xorKey(key, i), x);
  return x;
}

function unpad(padded: Uint8Array): string {
  for (let n = 0; n <= 32; n++) {
    if (equal(padded.subarray(n), PAD.subarray(0, 32 - n), 32 - n)) return String.fromCharCode(...padded.subarray(0, n));
  }
  return String.fromCharCode(...padded);
}

// ── R5/R6 (AES-256) ──────────────────────────────────────────────────────────

async function hashR6(e: EncryptParams, pw: Uint8Array, salt: Uint8Array, udata: Uint8Array): Promise<Uint8Array> {
  let k = await sha('SHA-256', concat(pw, salt, udata));
  if (e.r === 5) return k;
  for (let round = 0; ; round++) {
    const k1 = concat(pw, k, udata);
    const rep = new Uint8Array(k1.length * 64);
    for (let i = 0; i < 64; i++) rep.set(k1, i * k1.length);
    const enc = await aes128cbc(k.subarray(0, 16), k.subarray(16, 32), rep);
    let mod = 0;
    for (let i = 0; i < 16; i++) mod += enc[i];
    mod %= 3;
    k = await sha(mod === 0 ? 'SHA-256' : mod === 1 ? 'SHA-384' : 'SHA-512', enc);
    if (round >= 63 && enc[enc.length - 1] <= round - 31) break;
  }
  return k.subarray(0, 32);
}

const utf8Password = (s: string) => new TextEncoder().encode(s).subarray(0, 127);

const checkUserR6 = async (e: EncryptParams, pw: Uint8Array) =>
  equal(await hashR6(e, pw, e.u.subarray(32, 40), new Uint8Array(0)), e.u, 32);
const checkOwnerR6 = async (e: EncryptParams, pw: Uint8Array) =>
  equal(await hashR6(e, pw, e.o.subarray(32, 40), e.u.subarray(0, 48)), e.o, 32);

// ── reading the /Encrypt dictionary ──────────────────────────────────────────

function bytesOf(obj: PDFObject | undefined): Uint8Array | null {
  if (obj instanceof PDFString || obj instanceof PDFHexString) return obj.asBytes();
  return null;
}

async function readEncrypt(bytes: Uint8Array): Promise<EncryptParams | null> {
  const lib = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
  const trailer = lib.context.trailerInfo as { Encrypt?: PDFObject; ID?: PDFObject };
  const enc = trailer.Encrypt && lib.context.lookup(trailer.Encrypt);
  if (!(enc instanceof PDFDict)) return null;
  const num = (k: string, dflt: number) => {
    const v = enc.lookup(PDFName.of(k));
    return v instanceof PDFNumber ? v.asNumber() : dflt;
  };
  if ((enc.lookup(PDFName.of('Filter')) as PDFName | undefined)?.asString() !== '/Standard') return null;
  const o = bytesOf(enc.lookup(PDFName.of('O')));
  const u = bytesOf(enc.lookup(PDFName.of('U')));
  const ids = trailer.ID && lib.context.lookup(trailer.ID);
  const id0 = ids instanceof PDFArray ? bytesOf(ids.lookup(0)) : null;
  if (!o || !u) return null;
  const em = enc.lookup(PDFName.of('EncryptMetadata'));
  const id1 = ids instanceof PDFArray ? bytesOf(ids.lookup(1)) : null;
  const v = num('V', 0);
  const params: EncryptParams = {
    v,
    r: num('R', 2),
    length: v === 1 ? 40 : v === 5 ? 256 : num('Length', 40),
    p: num('P', -1) | 0,
    o,
    u,
    oe: bytesOf(enc.lookup(PDFName.of('OE'))),
    ue: bytesOf(enc.lookup(PDFName.of('UE'))),
    perms: bytesOf(enc.lookup(PDFName.of('Perms'))),
    id0: id0 ?? new Uint8Array(0),
    ids: id0 && id1 ? [id0, id1] : null,
    encryptMetadata: em?.toString() !== 'false',
    algorithm: null,
  };
  params.algorithm = reproducibleAlgorithm(enc, params);
  return params;
}

/** pdf-lib writes V1/V2 (RC4) or V4/V5 with one StdCF crypt filter (AESV2/AESV3) for strings and streams. */
function reproducibleAlgorithm(enc: PDFDict, e: EncryptParams): Algorithm | null {
  if (!e.encryptMetadata || !e.ids) return null;
  if (e.v === 1 && e.r === 2) return 'RC4-40';
  if (e.v === 2 && (e.r === 3 || e.r === 4) && e.length % 8 === 0 && e.length >= 40 && e.length <= 128) return 'RC4-128';
  if (e.v !== 4 && e.v !== 5) return null;
  const name = (k: string) => (enc.lookup(PDFName.of(k)) as PDFName | undefined)?.asString();
  if (name('StmF') !== '/StdCF' || name('StrF') !== '/StdCF') return null;
  const eff = name('EFF');
  if (eff && eff !== '/StdCF') return null;
  const cf = enc.lookup(PDFName.of('CF'));
  const std = cf instanceof PDFDict ? cf.lookup(PDFName.of('StdCF')) : undefined;
  const cfm = std instanceof PDFDict ? (std.lookup(PDFName.of('CFM')) as PDFName | undefined)?.asString() : undefined;
  if (e.v === 4 && e.r === 4 && cfm === '/AESV2' && e.length === 128) return 'AES-128';
  if (e.v === 5 && (e.r === 5 || e.r === 6) && cfm === '/AESV3' && e.oe && e.ue) return 'AES-256';
  return null;
}

async function keep(e: EncryptParams, fileKey: Uint8Array): Promise<KeptEncryption | undefined> {
  if (!e.algorithm || !e.ids) return undefined;
  if (e.r === 6 && e.perms) {
    // Sanity check of the key (Algorithm 13): the decrypted /Perms carries "adb" at bytes 9–11.
    const perms = await aesCbcDecryptRaw(fileKey, new Uint8Array(16), e.perms.subarray(0, 16));
    if (perms[9] !== 0x61 || perms[10] !== 0x64 || perms[11] !== 0x62) return undefined;
  }
  const { algorithm, v, r, length, p, o, u, ids } = e;
  return {
    algorithm, v, r, length, p, o, u, ids, fileKey,
    ...(e.oe ? { oe: e.oe } : {}),
    ...(e.ue ? { ue: e.ue } : {}),
    ...(e.perms ? { perms: e.perms } : {}),
  };
}

/**
 * Which role `password` has for the encrypted PDF `bytes`, or null when it can't be determined
 * (not a Standard security handler, unknown revision, no Web Crypto, parse errors).
 */
export async function identifyPassword(bytes: Uint8Array, password: string): Promise<PasswordRole | null> {
  try {
    const e = await readEncrypt(bytes);
    if (!e) return null;
    if (e.r >= 2 && e.r <= 4) {
      const pw = latin1Bytes(password);
      const user = checkUserR4(e, padPassword(pw));
      const fromOwner = paddedUserFromOwnerR4(e, pw);
      const owner = checkUserR4(e, fromOwner);
      const userPassword = user ? password : owner ? unpad(fromOwner) : undefined;
      const padded = user ? padPassword(pw) : owner ? fromOwner : null;
      const kept = padded ? await keep(e, fileKeyR4(e, padded).slice()) : undefined;
      return { user, owner, userPassword, ...(kept ? { kept } : {}) };
    }
    if ((e.r === 5 || e.r === 6) && typeof crypto !== 'undefined' && crypto.subtle) {
      const pw = utf8Password(password);
      const [user, owner] = await Promise.all([checkUserR6(e, pw), checkOwnerR6(e, pw)]);
      let userPassword: string | undefined = user ? password : undefined;
      if (!user && owner && (await checkUserR6(e, new Uint8Array(0)))) userPassword = '';
      // Algorithm 2.A: the file key is /UE (or /OE) decrypted with the password's intermediate key.
      let kept: KeptEncryption | undefined;
      if ((user || owner) && e.oe && e.ue) {
        const intermediate = user
          ? await hashR6(e, pw, e.u.subarray(40, 48), new Uint8Array(0))
          : await hashR6(e, pw, e.o.subarray(40, 48), e.u.subarray(0, 48));
        const fileKey = await aesCbcDecryptRaw(intermediate, new Uint8Array(16), (user ? e.ue : e.oe).subarray(0, 32));
        kept = await keep(e, fileKey);
      }
      return { user, owner, userPassword, ...(kept ? { kept } : {}) };
    }
    return null;
  } catch (err) {
    console.warn('[engine] could not check the document password', err);
    return null;
  }
}

// ── re-encrypting with the original key ─────────────────────────────────────

/** Options for `PDFDocument.encrypt` that select the kept cipher (the passwords are placeholders). */
export function keptEncryptionOptions(k: KeptEncryption) {
  return { userPassword: '', ownerPassword: 'kept', algorithm: k.algorithm, allowWeakCryptography: true };
}

interface LibSecurity {
  encryptionKey: Uint8Array;
  keyBits: number;
  encryption: { V: number };
}

const hexOf = (b: Uint8Array) => PDFHexString.of(Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''));

/**
 * After `lib.encrypt(keptEncryptionOptions(k))`: swap in the original file key, /Encrypt entries
 * and /ID so the saved file is encrypted exactly like the original. Relies on @cantoo/pdf-lib's
 * PDFSecurity fields (encryptionKey, keyBits) — throws if they aren't there.
 */
export function restoreKeptEncryption(lib: PDFDocument, k: KeptEncryption): void {
  const sec = lib.context.security as unknown as LibSecurity | undefined;
  const trailer = lib.context.trailerInfo as { Encrypt?: PDFObject; ID?: PDFObject };
  const dict = trailer.Encrypt && lib.context.lookup(trailer.Encrypt);
  if (!sec || !(sec.encryptionKey instanceof Uint8Array) || typeof sec.keyBits !== 'number' || sec.encryption?.V !== k.v || !(dict instanceof PDFDict)) {
    throw new Error('pdf-lib security internals changed; cannot keep the original encryption');
  }
  sec.encryptionKey = k.fileKey;
  sec.keyBits = k.length;
  const set = (key: string, value: PDFObject) => dict.set(PDFName.of(key), value);
  set('R', PDFNumber.of(k.r));
  set('P', PDFNumber.of(k.p));
  if (k.v >= 2) set('Length', PDFNumber.of(k.length));
  set('O', hexOf(k.o));
  set('U', hexOf(k.u));
  if (k.oe) set('OE', hexOf(k.oe));
  if (k.ue) set('UE', hexOf(k.ue));
  if (k.perms) set('Perms', hexOf(k.perms));
  else dict.delete(PDFName.of('Perms'));
  trailer.ID = lib.context.obj([hexOf(k.ids[0]), hexOf(k.ids[1])]);
}
