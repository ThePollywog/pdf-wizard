/**
 * Document-level file attachments: the catalog /Names /EmbeddedFiles name tree (read, add,
 * delete, edit description) with pdf-lib, plus a pdf.js fallback for documents pdf-lib can't
 * parse (encrypted / read-only).
 */
import {
  PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, PDFString, decodePDFRawStream,
  type PDFContext, type PDFObject,
} from '@cantoo/pdf-lib';
import type { DocId, LibDocument } from '@/core/types';
import * as engine from '@/core/engine';
import { N, lookup, lookupArray, lookupDict, nameOf, numberOf, parsePdfDate, pdfDate, textOf } from '@/core/engine/lib';
import { getDoc } from '@/core/store';

export interface EmbeddedFile {
  /** Name-tree key. */
  key: string;
  name: string;
  description: string;
  size: number | null;
  mime: string | null;
  created: string | null;
  modified: string | null;
  /** Decoded file bytes. */
  load(): Promise<Uint8Array>;
}

export interface NewFile {
  name: string;
  bytes: Uint8Array;
  mime?: string | null;
  modified?: number | null;
  description?: string;
}

// ── name tree helpers ───────────────────────────────────────────────────────

type Pair = { key: PDFString | PDFHexString; value: PDFObject };

function keyText(k: PDFString | PDFHexString): string {
  try {
    return k.decodeText();
  } catch {
    return k.asString();
  }
}

/** All (key, value) pairs of a name tree, in tree order. */
export function namePairs(ctx: PDFContext, root: PDFDict | undefined): Pair[] {
  const out: Pair[] = [];
  const seen = new Set<PDFDict>();
  const walk = (node: PDFDict | undefined, depth: number) => {
    if (!node || seen.has(node) || depth > 32) return;
    seen.add(node);
    const names = lookupArray(ctx, node.get(N('Names')));
    if (names) {
      for (let i = 0; i + 1 < names.size(); i += 2) {
        const k = lookup(ctx, names.get(i));
        if (k instanceof PDFString || k instanceof PDFHexString) out.push({ key: k, value: names.get(i + 1) });
      }
    }
    const kids = lookupArray(ctx, node.get(N('Kids')));
    if (kids) for (let i = 0; i < kids.size(); i++) walk(lookupDict(ctx, kids.get(i)), depth + 1);
  };
  walk(root, 0);
  return out;
}

function embeddedRoot(lib: LibDocument): PDFDict | undefined {
  const names = lookupDict(lib.context, lib.catalog.get(N('Names')));
  return names ? lookupDict(lib.context, names.get(N('EmbeddedFiles'))) : undefined;
}

/** Replace the EmbeddedFiles tree with a single sorted leaf (or remove it when empty). */
function writeTree(lib: LibDocument, pairs: Pair[]) {
  const ctx = lib.context;
  let names = lookupDict(ctx, lib.catalog.get(N('Names')));
  if (!pairs.length) {
    if (names) {
      names.delete(N('EmbeddedFiles'));
      if (!names.keys().length) lib.catalog.delete(N('Names'));
    }
    return;
  }
  const sorted = [...pairs].sort((a, b) => (keyText(a.key) < keyText(b.key) ? -1 : keyText(a.key) > keyText(b.key) ? 1 : 0));
  const arr = ctx.obj([]) as PDFArray;
  for (const p of sorted) {
    arr.push(p.key);
    arr.push(p.value);
  }
  const leaf = ctx.obj({}) as PDFDict;
  leaf.set(N('Names'), arr);
  if (!names) {
    names = ctx.obj({}) as PDFDict;
    lib.catalog.set(N('Names'), ctx.register(names));
  }
  names.set(N('EmbeddedFiles'), ctx.register(leaf));
}

function efStream(ctx: PDFContext, fs: PDFDict): PDFStream | undefined {
  const ef = lookupDict(ctx, fs.get(N('EF')));
  if (!ef) return undefined;
  for (const k of ['UF', 'F', 'DOS', 'Mac', 'Unix']) {
    const s = lookup(ctx, ef.get(N(k)));
    if (s instanceof PDFStream) return s;
  }
  return undefined;
}

function streamBytes(s: PDFStream): Uint8Array {
  if (s instanceof PDFRawStream) return decodePDFRawStream(s).decode();
  return s.getContents();
}

function safeLength(s: PDFStream): number | null {
  try {
    return streamBytes(s).length;
  } catch {
    return null;
  }
}

function fileOf(ctx: PDFContext, key: string, fsObj: PDFObject | undefined): EmbeddedFile | null {
  const fs = lookupDict(ctx, fsObj);
  if (!fs) return null;
  const name = textOf(ctx, fs.get(N('UF'))) || textOf(ctx, fs.get(N('F'))) || key || 'attachment';
  const s = efStream(ctx, fs);
  const params = s ? lookupDict(ctx, s.dict.get(N('Params'))) : undefined;
  const size = params ? (numberOf(ctx, params.get(N('Size'))) ?? null) : null;
  return {
    key,
    name: name.replace(/^.*[\\/]/, '') || name,
    description: textOf(ctx, fs.get(N('Desc'))) ?? '',
    size: size ?? (s ? safeLength(s) : null),
    mime: s ? (nameOf(ctx, s.dict.get(N('Subtype'))) ?? null) : null,
    created: params ? (parsePdfDate(textOf(ctx, params.get(N('CreationDate')))) ?? null) : null,
    modified: params ? (parsePdfDate(textOf(ctx, params.get(N('ModDate')))) ?? null) : null,
    load: async () => {
      if (!s) throw new Error('The attachment has no embedded data.');
      return streamBytes(s);
    },
  };
}

// ── reading ─────────────────────────────────────────────────────────────────

const cache = new WeakMap<Uint8Array, Promise<EmbeddedFile[]>>();

async function readViaPdfjs(docId: DocId): Promise<EmbeddedFile[]> {
  const pdf = await engine.awaitPdf(docId);
  const map = (await pdf.getAttachments()) as unknown;
  const out: EmbeddedFile[] = [];
  const entries: [string, { filename?: string; rawFilename?: string; description?: string; content?: Uint8Array }][] =
    map instanceof Map ? [...map.entries()] : map && typeof map === 'object' ? Object.entries(map as Record<string, never>) : [];
  for (const [key, a] of entries) {
    out.push({
      key,
      name: a.filename || key,
      description: a.description ?? '',
      size: a.content?.length ?? null,
      mime: null,
      created: null,
      modified: null,
      load: async () => {
        if (a.content) return a.content;
        // pdf.js v6 loads the data on demand (resolves to the bytes, or null).
        const c = (await (pdf as unknown as { getAttachmentContent(id: string): Promise<Uint8Array | { content?: Uint8Array } | null> }).getAttachmentContent(key)) ?? null;
        const data = c instanceof Uint8Array ? c : c?.content;
        if (!data) throw new Error('The attachment has no embedded data.');
        return data;
      },
    });
  }
  return out;
}

/** Embedded (document-level) files of the document's current base bytes. */
export function readEmbeddedFiles(docId: DocId): Promise<EmbeddedFile[]> {
  const doc = getDoc(docId);
  if (!doc) return Promise.resolve([]);
  const bytes = doc.bytes;
  let job = cache.get(bytes);
  if (!job) {
    job = (async () => {
      if (engine.isReadOnly(docId)) return readViaPdfjs(docId);
      let lib: LibDocument;
      try {
        lib = await engine.loadLib(bytes);
      } catch {
        return readViaPdfjs(docId);
      }
      const ctx = lib.context;
      return namePairs(ctx, embeddedRoot(lib))
        .map((p) => fileOf(ctx, keyText(p.key), p.value))
        .filter((f): f is EmbeddedFile => !!f);
    })();
    cache.set(bytes, job);
    job.catch(() => cache.delete(bytes));
  }
  return job;
}

/** Cheap count (pdf.js) for the panel badge. */
export async function countEmbeddedFiles(docId: DocId): Promise<number> {
  const pdf = await engine.awaitPdf(docId);
  const map = (await pdf.getAttachments()) as unknown;
  if (map instanceof Map) return map.size;
  return map && typeof map === 'object' ? Object.keys(map).length : 0;
}

// ── editing (inside engine.withLib) ─────────────────────────────────────────

const hex = (s: string) => PDFHexString.fromText(s);
const ascii = (s: string) => s.replace(/[^\x20-\x7e]/g, '_') || 'attachment';

export function mimeFor(name: string, fallback?: string | null): string {
  if (fallback) return fallback;
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const map: Record<string, string> = {
    pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', json: 'application/json', xml: 'application/xml', html: 'text/html', htm: 'text/html',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff',
    mp3: 'audio/mpeg', wav: 'audio/wav', mp4: 'video/mp4', mov: 'video/quicktime', zip: 'application/zip',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    rtf: 'application/rtf', md: 'text/markdown',
  };
  return map[ext] ?? 'application/octet-stream';
}

function uniqueKey(existing: Set<string>, name: string): string {
  if (!existing.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; ; i++) {
    const k = `${stem} (${i})${ext}`;
    if (!existing.has(k)) return k;
  }
}

/** Add files to the EmbeddedFiles name tree (and the catalog /AF array). Returns the keys used. */
export function embedFiles(lib: LibDocument, files: NewFile[]): string[] {
  const ctx = lib.context;
  const pairs = namePairs(ctx, embeddedRoot(lib));
  const keys = new Set(pairs.map((p) => keyText(p.key)));
  const used: string[] = [];
  let af = lookupArray(ctx, lib.catalog.get(N('AF')));
  for (const f of files) {
    const now = new Date();
    const params = ctx.obj({}) as PDFDict;
    params.set(N('Size'), PDFNumber.of(f.bytes.length));
    params.set(N('CreationDate'), PDFString.of(pdfDate(now)));
    params.set(N('ModDate'), PDFString.of(pdfDate(f.modified ? new Date(f.modified) : now)));
    const stream = ctx.flateStream(f.bytes, { Type: 'EmbeddedFile' });
    stream.dict.set(N('Subtype'), PDFName.of(mimeFor(f.name, f.mime)));
    stream.dict.set(N('Params'), params);
    const ef = ctx.register(stream);
    const fs = ctx.obj({}) as PDFDict;
    fs.set(N('Type'), N('Filespec'));
    fs.set(N('F'), PDFString.of(ascii(f.name)));
    fs.set(N('UF'), hex(f.name));
    const efd = ctx.obj({}) as PDFDict;
    efd.set(N('F'), ef);
    efd.set(N('UF'), ef);
    fs.set(N('EF'), efd);
    if (f.description) fs.set(N('Desc'), hex(f.description));
    fs.set(N('AFRelationship'), N('Unspecified'));
    const fsRef = ctx.register(fs);
    const key = uniqueKey(keys, f.name);
    keys.add(key);
    used.push(key);
    pairs.push({ key: hex(key), value: fsRef });
    if (!af) {
      af = ctx.obj([]) as PDFArray;
      lib.catalog.set(N('AF'), af);
    }
    af.push(fsRef);
  }
  writeTree(lib, pairs);
  return used;
}

/** Remove the attachment with name-tree key `key`. */
export function removeFile(lib: LibDocument, key: string): boolean {
  const ctx = lib.context;
  const pairs = namePairs(ctx, embeddedRoot(lib));
  const i = pairs.findIndex((p) => keyText(p.key) === key);
  if (i < 0) return false;
  const [gone] = pairs.splice(i, 1);
  writeTree(lib, pairs);
  // Drop it from /AF too.
  const af = lookupArray(ctx, lib.catalog.get(N('AF')));
  if (af) {
    const target = gone.value instanceof PDFRef ? gone.value : null;
    const dict = lookupDict(ctx, gone.value);
    for (let k = af.size() - 1; k >= 0; k--) {
      const v = af.get(k);
      if ((target && v === target) || (dict && lookupDict(ctx, v) === dict)) af.remove(k);
    }
    if (!af.size()) lib.catalog.delete(N('AF'));
  }
  return true;
}

export function setFileDescription(lib: LibDocument, key: string, description: string): boolean {
  const ctx = lib.context;
  const pair = namePairs(ctx, embeddedRoot(lib)).find((p) => keyText(p.key) === key);
  const fs = pair ? lookupDict(ctx, pair.value) : undefined;
  if (!fs) return false;
  if (description) fs.set(N('Desc'), hex(description));
  else fs.delete(N('Desc'));
  return true;
}
