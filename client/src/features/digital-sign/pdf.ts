/**
 * PDF side of digital signing, all in the browser:
 *
 *  - `listSignatureFields(bytes)`: the AcroForm /Sig fields (signed or empty) with their widgets.
 *  - `prepareSignature(bytes, target, appearance)`: appends ONE incremental update to `bytes` that
 *    adds (or fills) a signature field, its visible appearance and a /Sig dictionary whose
 *    /Contents is a zero-filled placeholder. The bytes before the update are never touched, so
 *    earlier signatures stay valid. Returns the prepared file, the /ByteRange and a `finish(cms)`
 *    that writes the CMS signature into the placeholder.
 *
 * The update uses the same cross-reference format as the file's last section (classic table or
 * xref stream). Encrypted files are refused for now (new objects would have to be encrypted
 * with the document key).
 */
import {
  PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString, type PDFObject,
} from '@cantoo/pdf-lib';
import type { Rect } from '@/core/types';

/** Bytes reserved for the CMS signature (a CAC RSA-2048 signature with a 3-certificate chain is ~6 KB). */
export const SIGNATURE_RESERVE = 24_576;

const enc = new TextEncoder();
const latin1 = (s: string) => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
};
const asLatin1 = (b: Uint8Array, start = 0, end = b.length) => {
  let s = '';
  for (let i = start; i < end; i += 0x8000) s += String.fromCharCode(...b.subarray(i, Math.min(end, i + 0x8000)));
  return s;
};

export async function loadForSigning(bytes: Uint8Array): Promise<PDFDocument> {
  const lib = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
  if (lib.context.trailerInfo.Encrypt) {
    throw new Error('This PDF is password protected. Signing protected PDFs isn’t supported yet: remove the security (Protect › Remove security) and try again.');
  }
  return lib;
}

// ── signature fields ─────────────────────────────────────────────────────────

export interface SignatureField {
  /** Fully qualified field name (parent names joined with '.'). */
  name: string;
  pageIndex: number;
  /** Widget rect in PDF user space (unrotated). null for invisible signatures. */
  rect: Rect | null;
  signed: boolean;
  /** Object numbers of the field and its (first) widget, used to address the field when signing it. */
  fieldRef: string;
}

const lookupDict = (lib: PDFDocument, o: PDFObject | undefined): PDFDict | undefined => {
  const v = o instanceof PDFRef ? lib.context.lookup(o) : o;
  return v instanceof PDFDict ? v : undefined;
};
const lookupArray = (lib: PDFDocument, o: PDFObject | undefined): PDFArray | undefined => {
  const v = o instanceof PDFRef ? lib.context.lookup(o) : o;
  return v instanceof PDFArray ? v : undefined;
};
const textOf = (o: PDFObject | undefined) => (o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : undefined);

function rectOf(lib: PDFDocument, widget: PDFDict): Rect | null {
  const arr = lookupArray(lib, widget.get(PDFName.of('Rect')));
  if (!arr || arr.size() < 4) return null;
  const n = [0, 1, 2, 3].map((i) => {
    const v = arr.lookup(i);
    return v instanceof PDFNumber ? v.asNumber() : 0;
  });
  const x = Math.min(n[0], n[2]);
  const y = Math.min(n[1], n[3]);
  const width = Math.abs(n[2] - n[0]);
  const height = Math.abs(n[3] - n[1]);
  return width < 1 || height < 1 ? null : { x, y, width, height };
}

interface FieldNode {
  name: string;
  ref: PDFRef | null;
  dict: PDFDict;
  widgets: { ref: PDFRef | null; dict: PDFDict }[];
}

/** Terminal /Sig fields of the AcroForm (inherits /FT from parents). */
function sigFields(lib: PDFDocument): FieldNode[] {
  const acro = lookupDict(lib, lib.catalog.get(PDFName.of('AcroForm')));
  const fields = acro && lookupArray(lib, acro.get(PDFName.of('Fields')));
  if (!fields) return [];
  const out: FieldNode[] = [];
  const seen = new Set<PDFDict>();
  const walk = (o: PDFObject, parentName: string, parentFT: string | undefined, depth: number) => {
    const ref = o instanceof PDFRef ? o : null;
    const dict = lookupDict(lib, o);
    if (!dict || seen.has(dict) || depth > 32) return;
    seen.add(dict);
    const t = textOf(dict.lookup(PDFName.of('T')));
    const name = t ? (parentName ? `${parentName}.${t}` : t) : parentName;
    const ftObj = dict.lookup(PDFName.of('FT'));
    const ft = ftObj instanceof PDFName ? ftObj.decodeText() : parentFT;
    const kids = lookupArray(lib, dict.get(PDFName.of('Kids')));
    // Kids that have a /T are fields; kids without one are widgets of this field.
    const kidFields: PDFObject[] = [];
    const widgets: FieldNode['widgets'] = [];
    if (kids) {
      for (let i = 0; i < kids.size(); i++) {
        const k = kids.get(i);
        const kd = lookupDict(lib, k);
        if (!kd) continue;
        if (kd.has(PDFName.of('T'))) kidFields.push(k);
        else widgets.push({ ref: k instanceof PDFRef ? k : null, dict: kd });
      }
    }
    for (const k of kidFields) walk(k, name, ft, depth + 1);
    if (ft !== 'Sig' || kidFields.length) return;
    if (!widgets.length && dict.lookup(PDFName.of('Subtype')) === PDFName.of('Widget')) widgets.push({ ref, dict });
    out.push({ name, ref, dict, widgets });
  };
  for (let i = 0; i < fields.size(); i++) walk(fields.get(i), '', undefined, 0);
  return out;
}

function pageIndexOfWidget(lib: PDFDocument, widget: { ref: PDFRef | null; dict: PDFDict }): number {
  const pages = lib.getPages();
  const p = widget.dict.get(PDFName.of('P'));
  if (p instanceof PDFRef) {
    const i = pages.findIndex((pg) => pg.ref === p);
    if (i >= 0) return i;
  }
  if (widget.ref) {
    for (let i = 0; i < pages.length; i++) {
      const annots = lookupArray(lib, pages[i].node.get(PDFName.of('Annots')));
      if (annots && annots.asArray().some((a) => a === widget.ref)) return i;
    }
  }
  return -1;
}

export async function listSignatureFields(bytes: Uint8Array): Promise<SignatureField[]> {
  let lib: PDFDocument;
  try {
    lib = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
  } catch {
    return [];
  }
  return sigFields(lib).map((f) => {
    const w = f.widgets[0];
    return {
      name: f.name,
      pageIndex: w ? pageIndexOfWidget(lib, w) : -1,
      rect: w ? rectOf(lib, w.dict) : null,
      signed: f.dict.get(PDFName.of('V')) !== undefined,
      fieldRef: f.ref ? `${f.ref.objectNumber} ${f.ref.generationNumber}` : f.name,
    };
  });
}

// ── appearance ───────────────────────────────────────────────────────────────

export interface AppearanceText {
  /** e.g. "Digitally signed by" */
  heading: string;
  /** Signer display name, e.g. "DOE.JANE.Q.1234567890" */
  name: string;
  /** Further lines (date, reason…). */
  lines: string[];
}

/** WinAnsi-safe text for Helvetica (anything else becomes '?'). */
function winAnsi(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    out += (c >= 32 && c < 127) || (c >= 160 && c <= 255) ? ch : '?';
  }
  return out;
}
const pdfLiteral = (s: string) => `(${winAnsi(s).replace(/[\\()]/g, (m) => `\\${m}`)})`;

/** Helvetica advance widths (per 1000 em) for ASCII 32..126. */
const HELV = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const HELV_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];
function textWidth(s: string, size: number, bold = false): number {
  const t = bold ? HELV_BOLD : HELV;
  let w = 0;
  for (const ch of winAnsi(s)) {
    const c = ch.charCodeAt(0);
    w += c >= 32 && c <= 126 ? t[c - 32] : 556;
  }
  return (w * size) / 1000;
}

/** Content stream of the visible signature: heading, bold name, detail lines, fitted to the box. */
export function appearanceContent(text: AppearanceText, width: number, height: number): string {
  const pad = Math.min(4, width * 0.04);
  const lines = [
    { s: text.heading, bold: false, rel: 0.8 },
    { s: text.name, bold: true, rel: 1.15 },
    ...text.lines.map((s) => ({ s, bold: false, rel: 0.8 })),
  ];
  const availW = width - 2 * pad;
  const availH = height - 2 * pad;
  // Largest base size so every line fits the width and all lines (1.2 leading) fit the height.
  let size = availH / lines.reduce((n, l) => n + l.rel * 1.3, 0);
  for (const l of lines) {
    const w = textWidth(l.s, 1, l.bold) * l.rel;
    if (w > 0) size = Math.min(size, availW / w);
  }
  size = Math.max(3, Math.min(size, 14));
  let y = height - pad;
  const ops = ['q', `0 0 ${width.toFixed(2)} ${height.toFixed(2)} re W n`, '0 0 0 rg', 'BT'];
  for (const l of lines) {
    const fs = size * l.rel;
    y -= fs * 0.95;
    ops.push(`/${l.bold ? 'HelvB' : 'Helv'} ${fs.toFixed(2)} Tf`, `1 0 0 1 ${pad.toFixed(2)} ${y.toFixed(2)} Tm`, `${pdfLiteral(l.s)} Tj`);
    y -= fs * 0.35;
  }
  ops.push('ET', 'Q');
  return ops.join('\n');
}

// ── incremental update writer ────────────────────────────────────────────────

/** Offset of the last `startxref` value and whether that section is an xref stream. */
function lastXref(bytes: Uint8Array): { offset: number; stream: boolean } {
  const tail = asLatin1(bytes, Math.max(0, bytes.length - 2048));
  const m = /startxref\s+(\d+)\s+%%EOF\s*$/.exec(tail) ?? [...tail.matchAll(/startxref\s+(\d+)/g)].pop();
  if (!m) throw new Error('The PDF has no cross-reference section (it may be damaged).');
  const offset = Number(m[1]);
  const head = asLatin1(bytes, offset, Math.min(bytes.length, offset + 32));
  return { offset, stream: !/^\s*xref/.test(head) };
}

function serialize(obj: PDFObject): Uint8Array {
  const buf = new Uint8Array(obj.sizeInBytes());
  obj.copyBytesInto(buf, 0);
  return buf;
}

const pad10 = (n: number) => String(n).padStart(10, '0');

function randomHex(bytes: number): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
}

/** `D:YYYYMMDDHHmmSS+HH'mm'` in local time. */
export function pdfDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const a = Math.abs(off);
  return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${sign}${p(Math.floor(a / 60))}'${p(a % 60)}'`;
}

/** UTF-16BE hex string (safe for any text in the raw /Sig dictionary). */
function hexText(s: string): string {
  let h = 'FEFF';
  for (let i = 0; i < s.length; i++) h += s.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
  return `<${h}>`;
}

export type SignTarget =
  | { kind: 'field'; fieldRef: string }
  | { kind: 'new'; pageIndex: number; rect: Rect; name?: string };

export interface SigDictInfo {
  signerName: string;
  reason?: string;
  location?: string;
  contactInfo?: string;
  date: Date;
  subFilter: 'ETSI.CAdES.detached' | 'adbe.pkcs7.detached';
}

export interface PreparedSignature {
  /** The whole file with the placeholder. */
  bytes: Uint8Array;
  byteRange: [number, number, number, number];
  fieldName: string;
  /** The signed content: every byte except the /Contents placeholder. */
  signedData(): Uint8Array;
  /** Write the DER CMS into the placeholder; returns the final file. */
  finish(cms: Uint8Array): Uint8Array;
}

export async function prepareSignature(
  bytes: Uint8Array,
  target: SignTarget,
  appearance: AppearanceText | null,
  info: SigDictInfo,
): Promise<PreparedSignature> {
  const lib = await loadForSigning(bytes);
  const ctx = lib.context;
  const xref = lastXref(bytes);
  const changed = new Map<number, { gen: number; obj: PDFObject }>();
  const mark = (ref: PDFRef, obj: PDFObject) => changed.set(ref.objectNumber, { gen: ref.generationNumber, obj });

  // Where the field lives.
  const catalogRef = ctx.trailerInfo.Root as PDFRef;
  let acroRef: PDFRef | null = null;
  let acro = lib.catalog.get(PDFName.of('AcroForm')) as PDFObject | undefined;
  if (acro instanceof PDFRef) {
    acroRef = acro;
    acro = ctx.lookup(acro);
  }
  let acroDict = acro instanceof PDFDict ? acro : undefined;
  if (!acroDict) {
    acroDict = ctx.obj({ Fields: [] }) as PDFDict;
    lib.catalog.set(PDFName.of('AcroForm'), acroDict);
    acroRef = null;
  }
  const markAcro = () => (acroRef ? mark(acroRef, acroDict!) : mark(catalogRef, lib.catalog));
  acroDict.set(PDFName.of('SigFlags'), PDFNumber.of(3));
  markAcro();

  const sigRef = ctx.nextRef();
  let fieldName: string;
  let widget: PDFDict;
  let widgetRef: PDFRef;
  let pageIndex: number;

  if (target.kind === 'field') {
    const f = sigFields(lib).find((x) => (x.ref ? `${x.ref.objectNumber} ${x.ref.generationNumber}` : x.name) === target.fieldRef);
    if (!f) throw new Error('The signature field no longer exists in the document.');
    if (f.dict.get(PDFName.of('V')) !== undefined) throw new Error(`“${f.name}” is already signed.`);
    if (!f.ref) throw new Error(`“${f.name}” can’t be signed (it isn’t an indirect object).`);
    fieldName = f.name;
    f.dict.set(PDFName.of('V'), sigRef);
    mark(f.ref, f.dict);
    const w = f.widgets[0];
    if (!w || !w.ref) throw new Error(`“${f.name}” has no widget to show the signature in.`);
    widget = w.dict;
    widgetRef = w.ref;
    pageIndex = pageIndexOfWidget(lib, w);
    if (w.ref !== f.ref) mark(w.ref, w.dict);
  } else {
    const pages = lib.getPages();
    const page = pages[target.pageIndex];
    if (!page) throw new Error('The page no longer exists.');
    pageIndex = target.pageIndex;
    const taken = new Set(sigFields(lib).map((f) => f.name));
    fieldName = target.name && !taken.has(target.name) ? target.name : '';
    for (let i = 1; !fieldName; i++) if (!taken.has(`Signature${i}`)) fieldName = `Signature${i}`;
    const r = target.rect;
    widget = ctx.obj({
      Type: 'Annot',
      Subtype: 'Widget',
      FT: 'Sig',
      T: PDFHexString.fromText(fieldName),
      F: 132, // Print | Locked
      Rect: [r.x, r.y, r.x + r.width, r.y + r.height],
      P: page.ref,
      V: sigRef,
    }) as PDFDict;
    widgetRef = ctx.register(widget);
    // Page /Annots (inline array → the page changes; indirect array → that array changes).
    const annotsRaw = page.node.get(PDFName.of('Annots'));
    if (annotsRaw instanceof PDFRef) {
      const arr = ctx.lookup(annotsRaw);
      if (arr instanceof PDFArray) {
        arr.push(widgetRef);
        mark(annotsRaw, arr);
      } else {
        page.node.set(PDFName.of('Annots'), ctx.obj([widgetRef]));
        mark(page.ref, page.node);
      }
    } else if (annotsRaw instanceof PDFArray) {
      annotsRaw.push(widgetRef);
      mark(page.ref, page.node);
    } else {
      page.node.set(PDFName.of('Annots'), ctx.obj([widgetRef]));
      mark(page.ref, page.node);
    }
    // AcroForm /Fields.
    const fieldsRaw = acroDict.get(PDFName.of('Fields'));
    if (fieldsRaw instanceof PDFRef && ctx.lookup(fieldsRaw) instanceof PDFArray) {
      (ctx.lookup(fieldsRaw) as PDFArray).push(widgetRef);
      mark(fieldsRaw, ctx.lookup(fieldsRaw)!);
    } else if (fieldsRaw instanceof PDFArray) {
      fieldsRaw.push(widgetRef);
      markAcro();
    } else {
      acroDict.set(PDFName.of('Fields'), ctx.obj([widgetRef]));
      markAcro();
    }
  }

  // Visible appearance.
  const rect = rectOf(lib, widget);
  if (appearance && rect) {
    const helv = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' }));
    const helvB = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica-Bold', Encoding: 'WinAnsiEncoding' }));
    const stream = ctx.stream(appearanceContent(appearance, rect.width, rect.height), {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [0, 0, rect.width, rect.height],
      Resources: { Font: { Helv: helv, HelvB: helvB } },
    });
    const apRef = ctx.register(stream);
    widget.set(PDFName.of('AP'), ctx.obj({ N: apRef }));
    mark(widgetRef, widget);
    for (const [ref, obj] of [[helv, ctx.lookup(helv)!], [helvB, ctx.lookup(helvB)!], [apRef, stream]] as const) mark(ref, obj);
  } else {
    mark(widgetRef, widget);
  }
  if (target.kind === 'new') mark(widgetRef, widget);

  // ── write the update ──
  const parts: Uint8Array[] = [bytes];
  let pos = bytes.length;
  const push = (b: Uint8Array) => {
    parts.push(b);
    pos += b.length;
  };
  if (bytes[bytes.length - 1] !== 0x0a) push(latin1('\n'));
  const offsets = new Map<number, { gen: number; offset: number }>();

  // /Sig dictionary first, written by hand so the placeholder offsets are known.
  const brPlaceholder = '/ByteRange [0 0000000000 0000000000 0000000000]';
  const contentsHexLen = SIGNATURE_RESERVE * 2;
  const sigHead =
    `${sigRef.objectNumber} 0 obj\n<< /Type /Sig /Filter /Adobe.PPKLite /SubFilter /${info.subFilter} ${brPlaceholder}\n/Contents <`;
  const sigTail =
    `>\n/M (${pdfDate(info.date)}) /Name ${hexText(info.signerName)}` +
    (info.reason ? ` /Reason ${hexText(info.reason)}` : '') +
    (info.location ? ` /Location ${hexText(info.location)}` : '') +
    (info.contactInfo ? ` /ContactInfo ${hexText(info.contactInfo)}` : '') +
    ` /Prop_Build << /App << /Name /PDFWizard >> /Filter << /Name /Adobe.PPKLite >> >> >>\nendobj\n`;
  offsets.set(sigRef.objectNumber, { gen: 0, offset: pos });
  const byteRangeAt = pos + sigHead.indexOf(brPlaceholder) + '/ByteRange ['.length;
  const contentsStart = pos + sigHead.length - 1; // the '<'
  push(latin1(sigHead));
  push(latin1('0'.repeat(contentsHexLen)));
  const contentsEnd = pos + 1; // after the '>'
  push(latin1(sigTail));

  for (const [num, { gen, obj }] of [...changed.entries()].sort((a, b) => a[0] - b[0])) {
    offsets.set(num, { gen, offset: pos });
    push(latin1(`${num} ${gen} obj\n`));
    push(serialize(obj));
    push(latin1('\nendobj\n'));
  }

  const trailer = ctx.trailerInfo;
  const idArr = trailer.ID instanceof PDFArray ? trailer.ID : undefined;
  const firstId = idArr?.get(0) instanceof PDFHexString ? (idArr.get(0) as PDFHexString).toString() : `<${randomHex(16)}>`;
  const id = `[${firstId} <${randomHex(16)}>]`;
  const info0 = trailer.Info instanceof PDFRef ? ` /Info ${trailer.Info.objectNumber} ${trailer.Info.generationNumber} R` : '';
  const root = ` /Root ${catalogRef.objectNumber} ${catalogRef.generationNumber} R`;

  if (!xref.stream) {
    const nums = [...offsets.keys()].sort((a, b) => a - b);
    const size = Math.max(ctx.largestObjectNumber + 1, nums[nums.length - 1] + 1);
    let table = 'xref\n';
    for (let i = 0; i < nums.length; ) {
      let j = i;
      while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
      table += `${nums[i]} ${j - i + 1}\n`;
      for (let k = i; k <= j; k++) {
        const e = offsets.get(nums[k])!;
        table += `${pad10(e.offset)} ${String(e.gen).padStart(5, '0')} n\r\n`;
      }
      i = j + 1;
    }
    const xrefAt = pos;
    push(latin1(`${table}trailer\n<< /Size ${size}${root}${info0} /ID ${id} /Prev ${xref.offset} >>\nstartxref\n${xrefAt}\n%%EOF\n`));
  } else {
    const xrefRef = ctx.nextRef();
    const xrefAt = pos;
    offsets.set(xrefRef.objectNumber, { gen: 0, offset: xrefAt });
    const nums = [...offsets.keys()].sort((a, b) => a - b);
    const size = Math.max(ctx.largestObjectNumber + 1, nums[nums.length - 1] + 1);
    const index: number[] = [];
    const rows: number[] = [];
    for (let i = 0; i < nums.length; ) {
      let j = i;
      while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
      index.push(nums[i], j - i + 1);
      for (let k = i; k <= j; k++) {
        const e = offsets.get(nums[k])!;
        rows.push(1, (e.offset >>> 24) & 0xff, (e.offset >>> 16) & 0xff, (e.offset >>> 8) & 0xff, e.offset & 0xff, (e.gen >> 8) & 0xff, e.gen & 0xff);
      }
      i = j + 1;
    }
    const data = new Uint8Array(rows);
    push(latin1(`${xrefRef.objectNumber} 0 obj\n<< /Type /XRef /Size ${size} /W [1 4 2] /Index [${index.join(' ')}]${root}${info0} /ID ${id} /Prev ${xref.offset} /Length ${data.length} >>\nstream\n`));
    push(data);
    push(latin1(`\nendstream\nendobj\nstartxref\n${xrefAt}\n%%EOF\n`));
  }

  const out = new Uint8Array(pos);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  const byteRange: [number, number, number, number] = [0, contentsStart, contentsEnd, out.length - contentsEnd];
  const br = `${byteRange[0]} ${pad10(byteRange[1])} ${pad10(byteRange[2])} ${pad10(byteRange[3])}`;
  out.set(latin1(br), byteRangeAt);

  return {
    bytes: out,
    byteRange,
    fieldName,
    signedData() {
      const d = new Uint8Array(byteRange[1] + byteRange[3]);
      d.set(out.subarray(0, byteRange[1]), 0);
      d.set(out.subarray(byteRange[2]), byteRange[1]);
      return d;
    },
    finish(cms: Uint8Array) {
      if (cms.length > SIGNATURE_RESERVE) throw new Error(`The signature is too large (${cms.length} bytes, ${SIGNATURE_RESERVE} reserved).`);
      const signed = out.slice();
      let hex = '';
      for (const b of cms) hex += b.toString(16).padStart(2, '0').toUpperCase();
      signed.set(enc.encode(hex), contentsStart + 1);
      return signed;
    },
  };
}

/** The raw /Contents and /ByteRange of every signature dictionary, read from the file bytes. */
export interface EmbeddedSignature {
  fieldName: string;
  pageIndex: number;
  rect: Rect | null;
  byteRange: number[];
  contents: Uint8Array;
  subFilter: string;
  signerName?: string;
  reason?: string;
  location?: string;
  /** /M as written (PDF date string). */
  date?: string;
}

export async function readSignatures(bytes: Uint8Array): Promise<EmbeddedSignature[]> {
  let lib: PDFDocument;
  try {
    lib = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false, throwOnInvalidObject: false });
  } catch {
    return [];
  }
  const out: EmbeddedSignature[] = [];
  for (const f of sigFields(lib)) {
    const v = lookupDict(lib, f.dict.get(PDFName.of('V')));
    if (!v) continue;
    const br = lookupArray(lib, v.get(PDFName.of('ByteRange')));
    const c = v.lookup(PDFName.of('Contents'));
    if (!br || !(c instanceof PDFHexString || c instanceof PDFString)) continue;
    const sub = v.lookup(PDFName.of('SubFilter'));
    const w = f.widgets[0];
    out.push({
      fieldName: f.name,
      pageIndex: w ? pageIndexOfWidget(lib, w) : -1,
      rect: w ? rectOf(lib, w.dict) : null,
      byteRange: br.asArray().map((n) => (n instanceof PDFNumber ? n.asNumber() : NaN)),
      contents: c.asBytes(),
      subFilter: sub instanceof PDFName ? sub.decodeText() : '',
      signerName: textOf(v.lookup(PDFName.of('Name'))),
      reason: textOf(v.lookup(PDFName.of('Reason'))),
      location: textOf(v.lookup(PDFName.of('Location'))),
      date: textOf(v.lookup(PDFName.of('M'))),
    });
  }
  return out;
}
