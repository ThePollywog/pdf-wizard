/**
 * Building new PDFs from page groups of the open document (Split, Extract as separate files):
 * the document is exported once (comments, form values, bookmarks and metadata included), then
 * each part copies its pages, keeps internal links between its own pages, the bookmarks that
 * point into it and its page labels.
 */
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFRef, PDFStream, PDFString, type PDFObject } from '@cantoo/pdf-lib';
import type { DocId, DocState, LibDocument } from '@/core/types';
import * as engine from '@/core/engine';
import { getDoc } from '@/core/store';
import {
  N, SAVE_OPTIONS, collectGarbage, dropDeadDestinations, importPages, leavesOf, loadLib, lookup, materializeInherited,
  pdfDate, rebuildPageTree,
} from '@/core/engine/lib';
import { baseName } from '@/core/util';
import { explicitLinkDestinations, filterOutline, readLibOutline, toSpecs, writeOutlineSpecs, type LibOutlineNode } from './outline';
import { hasLabels, readLabelSpecs, writeLabelSpecs, type PageLabelSpec } from './labels';
import { nextFrame, readOnlyReason } from './util';

export interface PreparedSource {
  lib: LibDocument;
  outline: LibOutlineNode[];
  labels: PageLabelSpec[] | null;
  outlineMode: boolean;
  doc: DocState;
}

/** Export the document once and load it for copying pages. */
export async function prepareSource(docId: DocId): Promise<PreparedSource> {
  const d0 = getDoc(docId);
  if (!d0) throw new Error('The document is no longer open.');
  const ro = readOnlyReason(docId);
  if (ro) throw new Error(`“${d0.name}” is open read-only because ${ro}, so pages can't be copied from it.`);
  const bytes = await engine.exportPdf(docId, { purpose: 'download', skipSecurity: true });
  const doc = getDoc(docId) ?? d0;
  const lib = await loadLib(bytes);
  materializeInherited(lib);
  explicitLinkDestinations(lib);
  const pm = lookup(lib.context, lib.catalog.get(N('PageMode')));
  return {
    lib,
    outline: readLibOutline(lib),
    labels: hasLabels(lib) ? readLabelSpecs(lib) : null,
    outlineMode: pm instanceof PDFName && pm.decodeText() === 'UseOutlines',
    doc,
  };
}

function setInfo(out: LibDocument, title: string, doc: DocState | null) {
  const now = new Date();
  const info: Record<string, PDFObject> = {
    Producer: PDFHexString.fromText('PDF Wizard'),
    Creator: PDFHexString.fromText(doc?.meta.creator || 'PDF Wizard'),
    CreationDate: PDFString.of(pdfDate(now)),
    ModDate: PDFString.of(pdfDate(now)),
  };
  if (title) info.Title = PDFHexString.fromText(title);
  if (doc?.meta.author) info.Author = PDFHexString.fromText(doc.meta.author);
  (out.context.trailerInfo as { Info?: PDFObject }).Info = out.context.register(out.context.obj(info));
}

/** One PDF made of `indices` (in the given order) of a prepared source. */
export async function buildPart(src: PreparedSource, indices: number[], title: string): Promise<Uint8Array> {
  const out = await PDFDocument.create({ updateMetadata: false });
  const refs = importPages(out, src.lib, indices);
  rebuildPageTree(out, refs);
  dropDeadDestinations(out);
  const refOf = new Map<number, PDFRef>();
  indices.forEach((i, k) => {
    if (!refOf.has(i)) refOf.set(i, refs[k]);
  });
  if (src.outline.length) {
    const kept = filterOutline(src.outline, (p) => refOf.has(p), false);
    writeOutlineSpecs(out, toSpecs(kept, (p) => refOf.get(p)));
    if (kept.length && src.outlineMode) out.catalog.set(N('PageMode'), N('UseOutlines'));
  }
  if (src.labels) writeLabelSpecs(out, indices.map((i) => src.labels![i]));
  setInfo(out, title, src.doc);
  await out.flush();
  collectGarbage(out);
  return out.save(SAVE_OPTIONS);
}

export interface BuiltPart {
  name: string;
  bytes: Uint8Array;
  pages: number;
}

/**
 * Build every group as its own PDF named `<stem>_PartN.pdf` (or with `names`).
 * `report(done, total)` is called after each part.
 */
export async function buildParts(
  docId: DocId,
  groups: number[][],
  opts: { names?: string[]; report?: (done: number, total: number) => void } = {},
): Promise<BuiltPart[]> {
  const src = await prepareSource(docId);
  const stemName = baseName(src.doc.name) || 'Document';
  const out: BuiltPart[] = [];
  for (let k = 0; k < groups.length; k++) {
    const name = opts.names?.[k] ?? `${stemName}_Part${k + 1}.pdf`;
    const bytes = await buildPart(src, groups[k], baseName(name));
    out.push({ name, bytes, pages: groups[k].length });
    opts.report?.(k + 1, groups.length);
    await nextFrame();
  }
  return out;
}

// ── size-based splitting ─────────────────────────────────────────────────────

function sizeOf(o: PDFObject | undefined): number {
  if (!o) return 0;
  try {
    if (o instanceof PDFRawStream) return o.contents.length + o.dict.sizeInBytes() + 20;
    if (o instanceof PDFStream) return o.getContentsSize() + o.dict.sizeInBytes() + 20;
    return o.sizeInBytes() + 20;
  } catch {
    return 64;
  }
}

/** Indirect objects a page needs (content, resources, annotations), not other pages. */
function pageObjects(lib: LibDocument, leafRef: PDFRef, pageRefs: Set<PDFRef>): Map<PDFRef, number> {
  const ctx = lib.context;
  const seen = new Map<PDFRef, number>();
  const stack: PDFObject[] = [];
  const leaf = ctx.lookup(leafRef);
  if (leaf instanceof PDFDict) {
    for (const [k, v] of leaf.entries()) if (k.decodeText() !== 'Parent') stack.push(v);
  }
  seen.set(leafRef, sizeOf(leaf));
  while (stack.length) {
    const o = stack.pop()!;
    if (o instanceof PDFRef) {
      if (seen.has(o) || pageRefs.has(o)) continue;
      const v = ctx.lookup(o);
      if (v instanceof PDFDict && v.get(N('Type')) === N('Pages')) continue;
      seen.set(o, sizeOf(v));
      if (v) stack.push(v);
    } else if (o instanceof PDFDict) {
      for (const [k, v] of o.entries()) if (k.decodeText() !== 'Parent' && k.decodeText() !== 'P') stack.push(v);
    } else if (o instanceof PDFArray) {
      for (let i = 0; i < o.size(); i++) stack.push(o.get(i));
    } else if (o instanceof PDFStream) {
      for (const v of o.dict.values()) stack.push(v);
    }
  }
  return seen;
}

/**
 * Greedy groups whose estimated size stays under `maxBytes` (a page larger than the limit gets
 * its own part). Shared resources (fonts, images) count once per part.
 */
export async function groupsBySize(docId: DocId, maxBytes: number): Promise<number[][]> {
  const d = getDoc(docId);
  if (!d) throw new Error('The document is no longer open.');
  const ro = readOnlyReason(docId);
  if (ro) throw new Error(`“${d.name}” is open read-only because ${ro}.`);
  const lib = await loadLib(d.bytes);
  const leaves = leavesOf(lib);
  const pageRefs = new Set(leaves.map((l) => l.ref));
  const OVERHEAD = 1500;
  const groups: number[][] = [];
  let cur: number[] = [];
  let used = new Set<PDFRef>();
  let size = OVERHEAD;
  for (let i = 0; i < leaves.length; i++) {
    const objs = pageObjects(lib, leaves[i].ref, pageRefs);
    let add = 0;
    for (const [ref, s] of objs) if (!used.has(ref)) add += s;
    if (cur.length && size + add > maxBytes) {
      groups.push(cur);
      cur = [];
      used = new Set();
      size = OVERHEAD;
      add = 0;
      for (const [, s] of objs) add += s;
    }
    cur.push(i);
    for (const ref of objs.keys()) used.add(ref);
    size += add;
    if (i % 25 === 24) await nextFrame();
  }
  if (cur.length) groups.push(cur);
  return groups;
}

/** Start page index of every top-level bookmark of the document (sorted, unique). */
export function bookmarkStarts(doc: Pick<DocState, 'pages' | 'outline'>): { starts: number[]; titles: Map<number, string> } {
  const index = new Map(doc.pages.map((p, i) => [p.id, i]));
  const titles = new Map<number, string>();
  for (const it of doc.outline ?? []) {
    const i = it.pageId ? index.get(it.pageId) : undefined;
    if (i !== undefined && !titles.has(i)) titles.set(i, it.title);
  }
  return { starts: [...titles.keys()].sort((a, b) => a - b), titles };
}
