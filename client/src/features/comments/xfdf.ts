/**
 * XFDF (XML Forms Data Format, Adobe XFDF 3.0) import / export of comments.
 *
 * Export: the comments are written through the normal PDF export (so every comment kind of every
 * feature produces its real annotation dictionary), then each annotation dictionary — with its
 * replies (/IRT /RT /R), review states (/State /StateModel) and grouped members (/RT /Group) — is
 * converted to its XFDF element. Keys without an XFDF attribute are kept in a private namespaced
 * attribute so our own files round-trip exactly; other readers ignore it.
 *
 * Import: every XFDF element is turned back into an annotation dictionary in a scratch pdf-lib
 * document and read with the registered annotation importers (the same code that opens PDFs), so
 * XFDF files from other editors and ours behave like annotations in a PDF. Comments with an id that already
 * exists replace it; replies / states pointing at existing comments are merged into them.
 */
import {
  decodePDFRawStream, PDFArray, PDFBool, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNull, PDFNumber, PDFRawStream, PDFRef, PDFStream,
  PDFString, type PDFObject,
} from '@cantoo/pdf-lib';
import type { DocId, PdfObject, Reply, ReviewStatus } from '@/core/types';
import { actions, getDoc } from '@/core/store';
import * as engine from '@/core/engine';
import { importObjectsFromLib } from '@/core/annotations';
import { parsePdfDate, pdfDate } from '@/core/engine/lib';
import { baseName, downloadBlob, pickFiles, rgb01ToHex, uid } from '@/core/util';
import { canAnnotate, commentsUi } from './model';
import { allComments } from './ops';

const XFDF_NS = 'http://ns.adobe.com/xfdf/';
const AW_NS = 'urn:x-pdfwizard:xfdf';

const N = (k: string) => PDFName.of(k);

// ── PDF object helpers ──────────────────────────────────────────────────────

function res(lib: PDFDocument, o: PDFObject | undefined): PDFObject | undefined {
  return o instanceof PDFRef ? lib.context.lookup(o) : o;
}
function textOf(o: PDFObject | undefined): string | undefined {
  return o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : undefined;
}
function nameOf(o: PDFObject | undefined): string | undefined {
  return o instanceof PDFName ? o.decodeText() : undefined;
}
function numsOf(lib: PDFDocument, o: PDFObject | undefined): number[] | undefined {
  const a = res(lib, o);
  if (!(a instanceof PDFArray)) return undefined;
  const out: number[] = [];
  for (let i = 0; i < a.size(); i++) {
    const v = res(lib, a.get(i));
    if (v instanceof PDFNumber) out.push(v.asNumber());
  }
  return out;
}
const fmt = (v: number) => String(Math.round(v * 10000) / 10000);
const list = (a: number[]) => a.map(fmt).join(',');

function colorHex(c: number[] | undefined): string | undefined {
  if (!c || c.length === 0) return undefined;
  const cl = (x: number) => Math.min(1, Math.max(0, x));
  let hex: string;
  if (c.length === 1) hex = rgb01ToHex(cl(c[0]), cl(c[0]), cl(c[0]));
  else if (c.length === 3) hex = rgb01ToHex(cl(c[0]), cl(c[1]), cl(c[2]));
  else if (c.length === 4) hex = rgb01ToHex((1 - c[0]) * (1 - c[3]), (1 - c[1]) * (1 - c[3]), (1 - c[2]) * (1 - c[3]));
  else return undefined;
  return hex.toUpperCase();
}

const FLAG_NAMES = ['invisible', 'hidden', 'print', 'nozoom', 'norotate', 'noview', 'readonly', 'locked', 'togglenoview', 'lockedcontents'];
const flagsToString = (f: number) => FLAG_NAMES.filter((_, i) => (f & (1 << i)) !== 0).join(',');
const flagsFromString = (s: string) =>
  s
    .split(/[\s,]+/)
    .map((x) => FLAG_NAMES.indexOf(x.trim().toLowerCase()))
    .filter((i) => i >= 0)
    .reduce((f, i) => f | (1 << i), 0);

const TAG_OF: Record<string, string> = {
  Text: 'text', Highlight: 'highlight', Underline: 'underline', StrikeOut: 'strikeout', Squiggly: 'squiggly', Caret: 'caret',
  FreeText: 'freetext', FileAttachment: 'fileattachment', Ink: 'ink', Line: 'line', Square: 'square', Circle: 'circle',
  Polygon: 'polygon', PolyLine: 'polyline', Stamp: 'stamp', Sound: 'sound', Redact: 'redact',
};
const SUBTYPE_OF: Record<string, string> = Object.fromEntries(Object.entries(TAG_OF).map(([k, v]) => [v, k]));

const STYLE_OF: Record<string, string> = { S: 'solid', D: 'dash', B: 'bevelled', I: 'inset', U: 'underline' };
const STYLE_FROM: Record<string, string> = Object.fromEntries(Object.entries(STYLE_OF).map(([k, v]) => [v, k]));
const JUSTIFY = ['left', 'centered', 'right'];

/** Keys expressed by XFDF attributes / child elements (everything else goes to aw:keys). */
const MAPPED = new Set([
  'Type', 'Subtype', 'Rect', 'P', 'F', 'NM', 'M', 'T', 'CreationDate', 'Subj', 'Contents', 'C', 'IC', 'CA', 'BS', 'Border', 'IRT', 'RT',
  'Popup', 'AP', 'AS', 'IT', 'Rotate', 'State', 'StateModel', 'Open', 'Name', 'QuadPoints', 'RD', 'Sy', 'DA', 'DS', 'RC', 'Q', 'CL', 'LE',
  'FS', 'InkList', 'L', 'Vertices', 'LL', 'LLE', 'Cap', 'Parent', 'StructParent', 'OC',
]);

// Generic JSON form of direct PDF values (for keys XFDF has no attribute for).
type J = number | boolean | null | string | J[] | { n: string } | { d: Record<string, J> };

function toJson(lib: PDFDocument, o: PDFObject | undefined, depth = 0): J | undefined {
  if (depth > 8) return undefined;
  const v = res(lib, o);
  if (v === undefined) return undefined;
  if (v === PDFNull) return null;
  if (v instanceof PDFNumber) return v.asNumber();
  if (v instanceof PDFBool) return v.asBoolean();
  if (v instanceof PDFName) return { n: v.decodeText() };
  if (v instanceof PDFString || v instanceof PDFHexString) return v.decodeText();
  if (v instanceof PDFArray) {
    const out: J[] = [];
    for (let i = 0; i < v.size(); i++) {
      const x = toJson(lib, v.get(i), depth + 1);
      if (x !== undefined) out.push(x);
    }
    return out;
  }
  if (v instanceof PDFStream) return undefined;
  if (v instanceof PDFDict) {
    const d: Record<string, J> = {};
    for (const [k, x] of v.entries()) {
      const kk = k.decodeText();
      if (kk === 'P' || kk === 'Parent') continue;
      const j = toJson(lib, x, depth + 1);
      if (j !== undefined) d[kk] = j;
    }
    return { d };
  }
  return undefined;
}

function fromJson(lib: PDFDocument, j: J): PDFObject {
  const c = lib.context;
  if (j === null) return PDFNull;
  if (typeof j === 'number') return PDFNumber.of(j);
  if (typeof j === 'boolean') return j ? PDFBool.True : PDFBool.False;
  if (typeof j === 'string') return PDFHexString.fromText(j);
  if (Array.isArray(j)) {
    const a = PDFArray.withContext(c);
    for (const x of j) a.push(fromJson(lib, x));
    return a;
  }
  if ('n' in j) return N(j.n);
  const d = PDFDict.withContext(c);
  for (const [k, x] of Object.entries(j.d)) d.set(N(k), fromJson(lib, x));
  return d;
}

// ── export ──────────────────────────────────────────────────────────────────

interface AnnotEntry {
  dict: PDFDict;
  ref: PDFRef | null;
  pageIndex: number;
  subtype: string;
  nm?: string;
}

function hexOf(bytes: Uint8Array): string {
  const h = '0123456789ABCDEF';
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += h[bytes[i] >> 4] + h[bytes[i] & 15];
  return s;
}

function streamBytes(lib: PDFDocument, o: PDFObject | undefined): { bytes: Uint8Array; dict: PDFDict } | null {
  const v = res(lib, o);
  if (!(v instanceof PDFStream)) return null;
  try {
    const bytes = v instanceof PDFRawStream ? decodePDFRawStream(v).decode() : v.getContents();
    return { bytes: new Uint8Array(bytes), dict: v.dict };
  } catch {
    return null;
  }
}

/** Builds the XFDF document for the annotations named in `ids` (plus their replies / states / group members). */
export function buildXfdf(lib: PDFDocument, ids: Set<string>, fileName: string): string {
  const all: AnnotEntry[] = [];
  lib.getPages().forEach((page, pageIndex) => {
    const annots = res(lib, page.node.get(N('Annots')));
    if (!(annots instanceof PDFArray)) return;
    for (let i = 0; i < annots.size(); i++) {
      const raw = annots.get(i);
      const dict = res(lib, raw);
      if (!(dict instanceof PDFDict)) continue;
      const subtype = nameOf(dict.get(N('Subtype'))) ?? '';
      if (!subtype || subtype === 'Popup' || !TAG_OF[subtype]) continue;
      all.push({ dict, ref: raw instanceof PDFRef ? raw : null, pageIndex, subtype, nm: textOf(res(lib, dict.get(N('NM')))) });
    }
  });
  // Top-level comments, then everything that (transitively) replies to one of them.
  const included = new Set<AnnotEntry>(all.filter((a) => a.nm && ids.has(a.nm)));
  const byRef = new Map<PDFRef, AnnotEntry>();
  for (const a of all) if (a.ref) byRef.set(a.ref, a);
  const parentOf = (a: AnnotEntry) => {
    const irt = a.dict.get(N('IRT'));
    return irt instanceof PDFRef ? byRef.get(irt) : undefined;
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const a of all) {
      if (included.has(a)) continue;
      const p = parentOf(a);
      if (p && included.has(p)) {
        included.add(a);
        changed = true;
      }
    }
  }
  // Every included annotation needs a name for /IRT links.
  for (const a of included) if (!a.nm) a.nm = uid('xfdf');

  const doc = document.implementation.createDocument(XFDF_NS, 'xfdf', null);
  const root = doc.documentElement;
  root.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:space', 'preserve');
  root.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:aw', AW_NS);
  const annotsEl = doc.createElementNS(XFDF_NS, 'annots');
  root.appendChild(annotsEl);

  for (const a of all) {
    if (!included.has(a)) continue;
    const el = annotElement(lib, doc, a, parentOf(a));
    if (el) annotsEl.appendChild(el);
  }
  const f = doc.createElementNS(XFDF_NS, 'f');
  f.setAttribute('href', fileName);
  root.appendChild(f);
  return `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(doc)}`;
}

function annotElement(lib: PDFDocument, doc: XMLDocument, a: AnnotEntry, parent: AnnotEntry | undefined): Element | null {
  const d = a.dict;
  const get = (k: string) => res(lib, d.get(N(k)));
  const el = doc.createElementNS(XFDF_NS, TAG_OF[a.subtype]);
  const attr = (k: string, v: string | undefined) => {
    if (v !== undefined && v !== '') el.setAttribute(k, v);
  };
  const child = (tag: string, text: string | undefined) => {
    if (text === undefined) return;
    const c = doc.createElementNS(XFDF_NS, tag);
    c.textContent = text;
    el.appendChild(c);
  };

  // common
  attr('page', String(a.pageIndex));
  const rect = numsOf(lib, d.get(N('Rect')));
  if (rect && rect.length >= 4) attr('rect', list([Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])]));
  attr('name', a.nm);
  attr('title', textOf(get('T')));
  attr('subject', textOf(get('Subj')));
  attr('creationdate', textOf(get('CreationDate')));
  attr('date', textOf(get('M')));
  const flags = get('F');
  if (flags instanceof PDFNumber) attr('flags', flagsToString(flags.asNumber()));
  attr('color', colorHex(numsOf(lib, d.get(N('C')))));
  attr('interior-color', colorHex(numsOf(lib, d.get(N('IC')))));
  const ca = get('CA');
  if (ca instanceof PDFNumber) attr('opacity', fmt(ca.asNumber()));
  const it = nameOf(get('IT'));
  attr('intent', it);
  const rot = get('Rotate');
  if (rot instanceof PDFNumber) attr('rotation', fmt(rot.asNumber()));
  if (parent) {
    attr('inreplyto', parent.nm);
    const rt = nameOf(get('RT'));
    attr('replyType', rt === 'Group' ? 'group' : 'reply');
  }
  const state = textOf(get('State'));
  if (state) {
    attr('state', state);
    attr('statemodel', textOf(get('StateModel')) ?? 'Review');
  }
  // border
  const bs = get('BS');
  if (bs instanceof PDFDict) {
    const w = res(lib, bs.get(N('W')));
    if (w instanceof PDFNumber) attr('width', fmt(w.asNumber()));
    const s = nameOf(res(lib, bs.get(N('S'))));
    if (s && STYLE_OF[s]) attr('style', STYLE_OF[s]);
    const dash = numsOf(lib, bs.get(N('D')));
    if (dash && s === 'D') attr('dashes', list(dash));
  } else {
    const border = numsOf(lib, d.get(N('Border')));
    if (border && border.length >= 3) attr('width', fmt(border[2]));
  }

  // per type
  const quads = numsOf(lib, d.get(N('QuadPoints')));
  if (quads && quads.length >= 8) attr('coords', list(quads));
  const rd = numsOf(lib, d.get(N('RD')));
  if (rd && rd.length >= 4) attr('fringe', list(rd));
  const name = nameOf(get('Name'));
  switch (a.subtype) {
    case 'Text': {
      attr('icon', name);
      const open = get('Open');
      if (open instanceof PDFBool) attr('open', open.asBoolean() ? 'yes' : 'no');
      break;
    }
    case 'Stamp':
      attr('icon', name);
      break;
    case 'Caret':
      attr('symbol', nameOf(get('Sy')) ?? 'None');
      break;
    case 'FreeText': {
      const q = get('Q');
      if (q instanceof PDFNumber) attr('justification', JUSTIFY[q.asNumber()] ?? 'left');
      const cl = numsOf(lib, d.get(N('CL')));
      if (cl && cl.length >= 4) attr('callout', list(cl));
      attr('head', nameOf(get('LE')));
      break;
    }
    case 'Line': {
      const l = numsOf(lib, d.get(N('L')));
      if (l && l.length >= 4) {
        attr('start', list(l.slice(0, 2)));
        attr('end', list(l.slice(2, 4)));
      }
      const le = get('LE');
      if (le instanceof PDFArray) {
        attr('head', nameOf(res(lib, le.get(0))));
        attr('tail', nameOf(res(lib, le.get(1))));
      }
      const ll = get('LL');
      if (ll instanceof PDFNumber) attr('leaderLength', fmt(ll.asNumber()));
      const lle = get('LLE');
      if (lle instanceof PDFNumber) attr('leaderExtend', fmt(lle.asNumber()));
      const cap = get('Cap');
      if (cap instanceof PDFBool) attr('caption', cap.asBoolean() ? 'yes' : 'no');
      break;
    }
    case 'PolyLine': {
      const le = get('LE');
      if (le instanceof PDFArray) {
        attr('head', nameOf(res(lib, le.get(0))));
        attr('tail', nameOf(res(lib, le.get(1))));
      }
      break;
    }
    case 'FileAttachment':
      attr('icon', name);
      break;
  }

  // children
  const contents = textOf(get('Contents'));
  child('contents', contents);
  const rc = textOf(get('RC'));
  if (rc) {
    const parsed = new DOMParser().parseFromString(rc.replace(/^\s*<\?xml[^>]*\?>/, ''), 'application/xml');
    if (!parsed.querySelector('parsererror') && parsed.documentElement) {
      const c = doc.createElementNS(XFDF_NS, 'contents-richtext');
      c.appendChild(doc.importNode(parsed.documentElement, true));
      el.appendChild(c);
    }
  }
  child('defaultappearance', textOf(get('DA')));
  child('defaultstyle', textOf(get('DS')));
  if (a.subtype === 'Ink') {
    const ink = get('InkList');
    if (ink instanceof PDFArray) {
      const il = doc.createElementNS(XFDF_NS, 'inklist');
      for (let i = 0; i < ink.size(); i++) {
        const pts = numsOf(lib, ink.get(i)) ?? [];
        const g = doc.createElementNS(XFDF_NS, 'gesture');
        const pairs: string[] = [];
        for (let k = 0; k + 1 < pts.length; k += 2) pairs.push(`${fmt(pts[k])},${fmt(pts[k + 1])}`);
        g.textContent = pairs.join(';');
        il.appendChild(g);
      }
      el.appendChild(il);
    }
  }
  if (a.subtype === 'Polygon' || a.subtype === 'PolyLine') {
    const v = numsOf(lib, d.get(N('Vertices')));
    if (v) {
      const pairs: string[] = [];
      for (let k = 0; k + 1 < v.length; k += 2) pairs.push(`${fmt(v[k])},${fmt(v[k + 1])}`);
      child('vertices', pairs.join(';'));
    }
  }
  if (a.subtype === 'FileAttachment') {
    const fs = res(lib, d.get(N('FS')));
    if (fs instanceof PDFDict) {
      attr('file', textOf(res(lib, fs.get(N('UF')))) || textOf(res(lib, fs.get(N('F')))) || 'attachment');
      const desc = textOf(res(lib, fs.get(N('Desc'))));
      if (desc) el.setAttributeNS(AW_NS, 'aw:description', desc);
      const ef = res(lib, fs.get(N('EF')));
      const file = ef instanceof PDFDict ? streamBytes(lib, ef.get(N('UF')) ?? ef.get(N('F'))) : null;
      if (file) {
        const data = doc.createElementNS(XFDF_NS, 'data');
        data.setAttribute('MODE', 'RAW');
        data.setAttribute('encoding', 'hex');
        data.setAttribute('length', String(file.bytes.length));
        const mime = nameOf(res(lib, file.dict.get(N('Subtype'))));
        if (mime) data.setAttribute('mimetype', mime);
        const params = res(lib, file.dict.get(N('Params')));
        if (params instanceof PDFDict) {
          const mod = textOf(res(lib, params.get(N('ModDate'))));
          const cr = textOf(res(lib, params.get(N('CreationDate'))));
          if (mod) data.setAttributeNS(AW_NS, 'aw:moddate', mod);
          if (cr) data.setAttributeNS(AW_NS, 'aw:creationdate', cr);
        }
        data.textContent = hexOf(file.bytes);
        el.appendChild(data);
      }
    }
  }
  const popupRef = d.get(N('Popup'));
  const popup = res(lib, popupRef);
  if (popup instanceof PDFDict) {
    const p = doc.createElementNS(XFDF_NS, 'popup');
    const pr = numsOf(lib, popup.get(N('Rect')));
    const pf = res(lib, popup.get(N('F')));
    if (pf instanceof PDFNumber) p.setAttribute('flags', flagsToString(pf.asNumber()));
    const po = res(lib, popup.get(N('Open')));
    p.setAttribute('open', po instanceof PDFBool && po.asBoolean() ? 'yes' : 'no');
    p.setAttribute('page', String(a.pageIndex));
    if (pr && pr.length >= 4) p.setAttribute('rect', list(pr));
    el.appendChild(p);
  }

  // private keys (e.g. the marked-up text) → aw:keys
  const extra: Record<string, J> = {};
  for (const [k, v] of d.entries()) {
    const key = k.decodeText();
    if (MAPPED.has(key)) continue;
    const j = toJson(lib, v);
    if (j !== undefined) extra[key] = j;
  }
  if (Object.keys(extra).length) el.setAttributeNS(AW_NS, 'aw:keys', JSON.stringify(extra));
  return el;
}

export async function exportXfdf(docId: DocId) {
  const doc = getDoc(docId);
  if (!doc) return;
  const ids = allComments(docId).map((o) => o.id);
  if (!ids.length) {
    actions.toast('There are no comments to export.');
    return;
  }
  try {
    const bytes = await engine.exportPdf(docId, { purpose: 'download', objectIds: ids, skipSecurity: true });
    const lib = await PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: true, throwOnInvalidObject: false });
    const xml = buildXfdf(lib, new Set(ids), doc.name);
    downloadBlob(new Blob([xml], { type: 'application/vnd.adobe.xfdf' }), `${baseName(doc.name)}.xfdf`);
    actions.toast(`Exported ${ids.length} comment${ids.length === 1 ? '' : 's'} to ${baseName(doc.name)}.xfdf`, { kind: 'success' });
  } catch (err) {
    console.warn('[comments] XFDF export failed', err);
    actions.toast(`Couldn’t export the comments: ${err instanceof Error ? err.message : String(err)}`, { kind: 'error' });
  }
}

// ── import ──────────────────────────────────────────────────────────────────

/** An expected import failure (bad file): reported to the user, not logged. */
class XfdfError extends Error {}

const numList = (s: string | null): number[] =>
  (s ?? '')
    .split(/[\s,;]+/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map(Number)
    .filter((v) => Number.isFinite(v));

function hexColor(s: string | null): number[] | undefined {
  if (!s) return undefined;
  const m = /^#?([0-9a-f]{6})$/i.exec(s.trim());
  if (!m) return undefined;
  const v = parseInt(m[1], 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255].map((x) => Math.round(x * 1000) / 1000);
}

function dateString(s: string | null): string | undefined {
  if (!s) return undefined;
  const t = s.trim();
  if (/^D:/.test(t) || /^\d{8,14}/.test(t)) return t.startsWith('D:') ? t : `D:${t}`;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? pdfDate(new Date(ms)) : undefined;
}

function dateMs(s: string | null): number | undefined {
  const d = dateString(s);
  const iso = d ? parsePdfDate(d) : undefined;
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : undefined;
}

const childEl = (el: Element, tag: string) => Array.from(el.children).find((c) => c.localName.toLowerCase() === tag) ?? null;
const childText = (el: Element, tag: string) => {
  const c = childEl(el, tag);
  return c ? (c.textContent ?? '').replace(/\r\n?/g, '\n') : undefined;
};

function hexToBytes(s: string): Uint8Array {
  const h = s.replace(/[^0-9a-f]/gi, '');
  const out = new Uint8Array(h.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}
function base64ToBytes(s: string): Uint8Array {
  const bin = atob(s.replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

interface Built {
  el: Element;
  dict: PDFDict;
  ref: PDFRef;
  page: number;
  nm: string;
  irt?: string;
}

function buildDict(lib: PDFDocument, el: Element, page: number): PDFDict | null {
  const tag = el.localName.toLowerCase();
  const subtype = SUBTYPE_OF[tag];
  if (!subtype || subtype === 'Sound') return null;
  const c = lib.context;
  const d = PDFDict.withContext(c);
  const set = (k: string, v: PDFObject | undefined) => {
    if (v !== undefined) d.set(N(k), v);
  };
  const arr = (a: number[]) => c.obj(a);
  const txt = (s: string | null | undefined) => (s != null && s !== '' ? PDFHexString.fromText(s) : undefined);
  const at = (k: string) => el.getAttribute(k);

  set('Type', N('Annot'));
  set('Subtype', N(subtype));
  const r = numList(at('rect'));
  if (r.length < 4) return null;
  set('Rect', arr([Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])]));
  set('NM', txt(at('name')));
  set('T', txt(at('title')));
  set('Subj', txt(at('subject')));
  const cd = dateString(at('creationdate'));
  if (cd) set('CreationDate', PDFString.of(cd));
  const md = dateString(at('date'));
  if (md) set('M', PDFString.of(md));
  set('F', PDFNumber.of(at('flags') != null ? flagsFromString(at('flags')!) : 4));
  const col = hexColor(at('color'));
  if (col) set('C', arr(col));
  const ic = hexColor(at('interior-color'));
  if (ic) set('IC', arr(ic));
  const op = at('opacity');
  if (op != null && Number.isFinite(Number(op))) set('CA', PDFNumber.of(Number(op)));
  if (at('intent')) set('IT', N(at('intent')!));
  if (at('rotation') != null && Number.isFinite(Number(at('rotation')))) set('Rotate', PDFNumber.of(Number(at('rotation'))));
  if (at('state')) {
    set('State', PDFString.of(at('state')!));
    set('StateModel', PDFString.of(at('statemodel') || 'Review'));
  }
  if (at('inreplyto')) set('RT', N(at('replyType')?.toLowerCase() === 'group' ? 'Group' : 'R'));
  const width = at('width');
  const style = at('style');
  if (width != null || style != null) {
    const bs: Record<string, unknown> = { Type: 'Border', W: Number(width ?? 1) || 0, S: STYLE_FROM[(style ?? 'solid').toLowerCase()] ?? 'S' };
    const dashes = numList(at('dashes'));
    if (dashes.length) bs.D = dashes;
    set('BS', c.obj(bs as never));
  }
  const coords = numList(at('coords'));
  if (coords.length >= 8) set('QuadPoints', arr(coords));
  const fringe = numList(at('fringe'));
  if (fringe.length >= 4) set('RD', arr(fringe.slice(0, 4)));
  const icon = at('icon');

  switch (subtype) {
    case 'Text':
      set('Name', N(icon || 'Note'));
      set('Open', at('open') === 'yes' ? PDFBool.True : PDFBool.False);
      break;
    case 'Stamp':
    case 'FileAttachment':
      if (icon) set('Name', N(icon));
      break;
    case 'Caret':
      set('Sy', N(at('symbol') === 'P' ? 'P' : 'None'));
      break;
    case 'FreeText': {
      const j = (at('justification') ?? '').toLowerCase();
      set('Q', PDFNumber.of(j === 'centered' || j === 'center' ? 1 : j === 'right' ? 2 : 0));
      const cl = numList(at('callout'));
      if (cl.length >= 4) set('CL', arr(cl));
      if (at('head')) set('LE', N(at('head')!));
      break;
    }
    case 'Line': {
      const s = numList(at('start'));
      const e = numList(at('end'));
      if (s.length >= 2 && e.length >= 2) set('L', arr([s[0], s[1], e[0], e[1]]));
      set('LE', c.obj([N(at('head') || 'None'), N(at('tail') || 'None')]));
      if (at('leaderLength')) set('LL', PDFNumber.of(Number(at('leaderLength')) || 0));
      if (at('leaderExtend')) set('LLE', PDFNumber.of(Number(at('leaderExtend')) || 0));
      if (at('caption')) set('Cap', at('caption') === 'yes' ? PDFBool.True : PDFBool.False);
      break;
    }
    case 'PolyLine':
      if (at('head') || at('tail')) set('LE', c.obj([N(at('head') || 'None'), N(at('tail') || 'None')]));
      break;
  }

  const contents = childText(el, 'contents');
  if (contents !== undefined) set('Contents', txt(contents) ?? PDFHexString.fromText(''));
  const rcEl = childEl(el, 'contents-richtext');
  const body = rcEl ? Array.from(rcEl.children)[0] : undefined;
  if (body) set('RC', PDFHexString.fromText(`<?xml version="1.0"?>${new XMLSerializer().serializeToString(body)}`));
  const da = childText(el, 'defaultappearance');
  if (da) set('DA', PDFString.of(da));
  const ds = childText(el, 'defaultstyle');
  if (ds) set('DS', PDFString.of(ds));

  const pairs = (s: string | undefined) =>
    (s ?? '')
      .split(';')
      .map((p) => numList(p))
      .filter((p) => p.length >= 2)
      .flatMap((p) => [p[0], p[1]]);
  if (subtype === 'Ink') {
    const il = childEl(el, 'inklist');
    const strokes = il ? Array.from(il.children).filter((g) => g.localName.toLowerCase() === 'gesture').map((g) => pairs(g.textContent ?? '')) : [];
    set('InkList', c.obj(strokes.filter((s) => s.length >= 2)));
  }
  if (subtype === 'Polygon' || subtype === 'PolyLine') set('Vertices', arr(pairs(childText(el, 'vertices'))));
  if (subtype === 'FileAttachment') {
    const data = childEl(el, 'data');
    const fileName = at('file') || 'attachment';
    if (data) {
      const enc = (data.getAttribute('encoding') ?? 'hex').toLowerCase();
      const raw = data.textContent ?? '';
      let bytes: Uint8Array;
      try {
        bytes = enc === 'base64' ? base64ToBytes(raw) : hexToBytes(raw);
      } catch {
        bytes = new Uint8Array();
      }
      const params: Record<string, unknown> = { Size: bytes.length };
      const mod = data.getAttributeNS(AW_NS, 'moddate');
      const cr = data.getAttributeNS(AW_NS, 'creationdate');
      if (mod) params.ModDate = PDFString.of(mod);
      if (cr) params.CreationDate = PDFString.of(cr);
      const streamDict: Record<string, unknown> = { Type: 'EmbeddedFile', Params: params };
      const mime = data.getAttribute('mimetype');
      if (mime) streamDict.Subtype = mime;
      const filtered = (data.getAttribute('MODE') ?? data.getAttribute('mode') ?? 'RAW').toUpperCase() === 'FILTERED';
      const filter = data.getAttribute('filter');
      if (filtered && filter) streamDict.Filter = filter;
      const stream = c.register(c.stream(bytes, streamDict as never));
      const fs: Record<string, unknown> = { Type: 'Filespec', F: PDFString.of(fileName.replace(/[^\x20-\x7e]/g, '_')), UF: PDFHexString.fromText(fileName), EF: { F: stream, UF: stream } };
      const desc = el.getAttributeNS(AW_NS, 'description');
      if (desc) fs.Desc = PDFHexString.fromText(desc);
      set('FS', c.register(c.obj(fs as never)));
    }
  }

  const keys = el.getAttributeNS(AW_NS, 'keys');
  if (keys) {
    try {
      const extra = JSON.parse(keys) as Record<string, J>;
      for (const [k, v] of Object.entries(extra)) if (!MAPPED.has(k)) d.set(N(k), fromJson(lib, v));
    } catch {
      /* ignore malformed private data */
    }
  }
  return d;
}

export interface XfdfImportResult {
  added: PdfObject[];
  replaced: PdfObject[];
  merged: number;
  skipped: number;
}

/** Parses an XFDF string into overlay objects for `docId` (does not modify the document). */
export async function parseXfdf(docId: DocId, xml: string): Promise<{ objects: PdfObject[]; orphans: Element[]; skipped: number }> {
  const doc = getDoc(docId);
  if (!doc) throw new Error('No document');
  const parsed = new DOMParser().parseFromString(xml, 'application/xml');
  if (parsed.querySelector('parsererror') || parsed.documentElement.localName.toLowerCase() !== 'xfdf') {
    throw new XfdfError('This file isn’t a valid XFDF comments file.');
  }
  const annots = Array.from(parsed.documentElement.children).find((c) => c.localName.toLowerCase() === 'annots');
  const els = annots ? Array.from(annots.children) : [];
  const lib = await PDFDocument.create({ updateMetadata: false });
  let skipped = 0;
  const pageOf = (el: Element) => {
    const p = Number(el.getAttribute('page') ?? '0');
    return Number.isInteger(p) ? p : -1;
  };
  const maxPage = Math.min(doc.pages.length - 1, Math.max(-1, ...els.map(pageOf)));
  for (let i = 0; i <= maxPage; i++) {
    const [x0, y0, x1, y1] = doc.pages[i].view;
    lib.addPage([Math.max(1, x1 - x0), Math.max(1, y1 - y0)]);
  }
  const libPages = lib.getPages();
  const built: Built[] = [];
  const names = new Set(els.map((e) => e.getAttribute('name')).filter((n): n is string => !!n));
  const orphans: Element[] = [];
  for (const el of els) {
    const page = pageOf(el);
    const irt = el.getAttribute('inreplyto') ?? undefined;
    if (irt && !names.has(irt)) {
      // A reply / state for a comment that is not in the file: merged into an existing comment.
      if (doc.objects[irt]) orphans.push(el);
      else skipped++;
      continue;
    }
    if (page < 0 || page > maxPage) {
      skipped++;
      continue;
    }
    const dict = buildDict(lib, el, page);
    if (!dict) {
      skipped++;
      continue;
    }
    const ref = lib.context.register(dict);
    const nm = el.getAttribute('name') || uid('xfdf');
    if (!el.getAttribute('name')) dict.set(N('NM'), PDFHexString.fromText(nm));
    built.push({ el, dict, ref, page, nm, irt });
    dict.set(N('P'), libPages[page].ref);
    libPages[page].node.addAnnot(ref);
  }
  const refByName = new Map(built.map((b) => [b.nm, b.ref]));
  for (const b of built) if (b.irt && refByName.has(b.irt)) b.dict.set(N('IRT'), refByName.get(b.irt)!);
  const objects = await importObjectsFromLib(lib, doc.pages.slice(0, maxPage + 1));
  const top = built.filter((b) => !b.irt).length;
  return { objects, orphans, skipped: skipped + Math.max(0, top - objects.length) };
}

const STATE_OF: Record<string, ReviewStatus> = { accepted: 'accepted', rejected: 'rejected', cancelled: 'cancelled', completed: 'completed', none: 'none' };

/** Adds the parsed objects to the document in one undo step. */
export function applyXfdfImport(docId: DocId, objects: PdfObject[], orphans: Element[] = []): XfdfImportResult {
  const doc = getDoc(docId)!;
  const added: PdfObject[] = [];
  const replaced: PdfObject[] = [];
  for (const o of objects) (doc.objects[o.id] ? replaced : added).push(o);
  // Replies / states for comments already in the document.
  const patches = new Map<string, { replies?: Reply[]; status?: ReviewStatus; at?: number }>();
  let merged = 0;
  for (const el of orphans) {
    const target = el.getAttribute('inreplyto')!;
    const base = replaced.find((o) => o.id === target) ?? doc.objects[target];
    if (!base) continue;
    const p = patches.get(target) ?? {};
    const state = el.getAttribute('state');
    if (state) {
      const model = el.getAttribute('statemodel') ?? 'Review';
      const s = STATE_OF[state.toLowerCase()];
      const at = dateMs(el.getAttribute('date')) ?? 0;
      if (model === 'Review' && s && (p.at === undefined || at >= p.at)) {
        p.status = s;
        p.at = at;
        merged++;
      }
    } else {
      const replies = p.replies ?? [...(base.replies ?? [])];
      const id = el.getAttribute('name') || uid('rp');
      const reply: Reply = {
        id,
        author: el.getAttribute('title') || 'Unknown',
        text: childText(el, 'contents') ?? '',
        createdAt: dateMs(el.getAttribute('creationdate')) ?? dateMs(el.getAttribute('date')) ?? Date.now(),
      };
      const i = replies.findIndex((r) => r.id === id);
      if (i >= 0) replies[i] = reply;
      else replies.push(reply);
      replies.sort((a, b) => a.createdAt - b.createdAt);
      p.replies = replies;
      merged++;
    }
    patches.set(target, p);
  }
  if (!added.length && !replaced.length && !patches.size) return { added, replaced, merged, skipped: 0 };
  actions.checkpoint(docId, 'Import comments');
  actions.updateDoc(docId, (d) => {
    const objs = { ...d.objects };
    for (const o of [...added, ...replaced]) objs[o.id] = o;
    for (const [id, p] of patches) {
      const o = objs[id];
      if (!o) continue;
      objs[id] = { ...o, ...(p.replies ? { replies: p.replies } : {}), ...(p.status ? { status: p.status === 'none' ? undefined : p.status } : {}) };
    }
    return { objects: objs, order: [...d.order, ...added.map((o) => o.id)], dirty: true };
  });
  return { added, replaced, merged, skipped: 0 };
}

export async function importXfdf(docId: DocId, file?: File) {
  if (!canAnnotate(docId)) return;
  const f = file ?? (await pickFiles({ accept: '.xfdf,.xml,application/vnd.adobe.xfdf' }))[0];
  if (!f) return;
  try {
    const xml = await f.text();
    const { objects, orphans, skipped } = await parseXfdf(docId, xml);
    if (!objects.length && !orphans.length) {
      actions.toast(skipped ? `No comments could be imported from ${f.name}.` : `${f.name} contains no comments.`, { kind: skipped ? 'warning' : 'info' });
      return;
    }
    const r = applyXfdfImport(docId, objects, orphans);
    commentsUi.setHidden(docId, false);
    actions.setRightPanel('comments');
    const parts = [
      r.added.length ? `${r.added.length} comment${r.added.length === 1 ? '' : 's'} imported` : '',
      r.replaced.length ? `${r.replaced.length} updated` : '',
      r.merged ? `${r.merged} repl${r.merged === 1 ? 'y' : 'ies'} merged` : '',
      skipped ? `${skipped} skipped` : '',
    ].filter(Boolean);
    actions.toast(`${parts.join(', ')}.`.replace(/^./, (c) => c.toUpperCase()), { kind: 'success' });
  } catch (err) {
    if (!(err instanceof XfdfError)) console.warn('[comments] XFDF import failed', err);
    actions.toast(err instanceof XfdfError ? err.message : `Couldn’t import ${f.name}.`, { kind: 'error' });
  }
}
