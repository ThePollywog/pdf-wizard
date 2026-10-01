/**
 * Combine files into a binder: pages of every source are copied with one import per source (so
 * links between its pages keep working, forms and comments come along), arranged in the chosen
 * order, and each file gets a top-level bookmark holding its own bookmarks.
 */
import { PDFDocument, PDFHexString, PDFNull, PDFRef, PDFString, type PDFObject } from '@cantoo/pdf-lib';
import type { LibDocument } from '@/core/types';
import {
  N, SAVE_OPTIONS, collectGarbage, dropDeadDestinations, importPages, loadLib, materializeInherited, pdfDate, rebuildPageTree,
} from '@/core/engine/lib';
import { useApp } from '@/core/store';
import { baseName } from '@/core/util';
import { explicitLinkDestinations, filterOutline, readLibOutline, toSpecs, writeOutlineSpecs, type OutlineSpec } from '../outline';
import { getSource } from '../pdfThumbs';
import { nextFrame } from '../util';

export interface BinderEntry {
  sourceId: string;
  page: number;
}

export interface BinderGroup {
  /** Bookmark title (file name without extension). */
  title: string;
  sourceId: string;
  entries: BinderEntry[];
}

const key = (sourceId: string, page: number) => `${sourceId}#${page}`;

/** "Binder1.pdf", "Binder2.pdf"… (first one not used by an open tab). */
export function nextBinderName(): string {
  const names = new Set(Object.values(useApp.getState().docs).map((d) => d.name.toLowerCase()));
  for (let n = 1; ; n++) {
    const name = `Binder${n}.pdf`;
    if (!names.has(name.toLowerCase())) return name;
  }
}

export async function buildBinder(groups: BinderGroup[], title: string, report?: (p: number) => void): Promise<Uint8Array> {
  const used = groups.filter((g) => g.entries.length);
  if (!used.length) throw new Error('Add files with at least one page to combine.');
  const out = await PDFDocument.create({ updateMetadata: false });
  // Every occurrence is imported: a page that appears twice becomes two page objects (a page
  // tree must not reference the same page twice). Links and bookmarks target the first copy.
  const bySource = new Map<string, number[]>();
  for (const g of used) {
    for (const e of g.entries) {
      const list = bySource.get(e.sourceId) ?? [];
      list.push(e.page);
      bySource.set(e.sourceId, list);
    }
  }
  const copies = new Map<string, PDFRef[]>();
  const refOf = new Map<string, PDFRef>();
  const outlines = new Map<string, ReturnType<typeof readLibOutline>>();
  let done = 0;
  for (const [sourceId, pages] of bySource) {
    const src = getSource(sourceId);
    if (!src) throw new Error('One of the files was removed while combining.');
    let lib: LibDocument;
    try {
      lib = await loadLib(src.bytes);
    } catch (e) {
      throw new Error(`Couldn't read “${src.name}”: ${e instanceof Error ? e.message : String(e)}`);
    }
    materializeInherited(lib);
    explicitLinkDestinations(lib);
    outlines.set(sourceId, readLibOutline(lib));
    const refs = importPages(out, lib, pages);
    pages.forEach((p, k) => {
      const kk = key(sourceId, p);
      const list = copies.get(kk) ?? [];
      list.push(refs[k]);
      copies.set(kk, list);
      if (!refOf.has(kk)) refOf.set(kk, refs[k]);
    });
    report?.(++done / (bySource.size + 1));
    await nextFrame();
  }
  const taken = new Map<string, number>();
  const order = used.flatMap((g) =>
    g.entries.map((e) => {
      const kk = key(e.sourceId, e.page);
      const n = taken.get(kk) ?? 0;
      taken.set(kk, n + 1);
      return copies.get(kk)![n];
    }),
  );
  rebuildPageTree(out, order);
  dropDeadDestinations(out);

  const items: OutlineSpec[] = used.map((g) => {
    const first = g.entries[0];
    const nodes = outlines.get(g.sourceId) ?? [];
    const kept = filterOutline(nodes, (p) => refOf.has(key(g.sourceId, p)), true);
    return {
      title: g.title,
      pageRef: refOf.get(key(first.sourceId, first.page)) ?? null,
      fit: [N('XYZ'), PDFNull, PDFNull, PDFNull],
      uri: null,
      open: false,
      color: null,
      flags: 0,
      children: toSpecs(kept, (p) => refOf.get(key(g.sourceId, p))),
    };
  });
  writeOutlineSpecs(out, items);
  out.catalog.set(N('PageMode'), N('UseOutlines'));

  const now = new Date();
  const info: Record<string, PDFObject> = {
    Title: PDFHexString.fromText(baseName(title)),
    Producer: PDFHexString.fromText('PDF Wizard'),
    Creator: PDFHexString.fromText('PDF Wizard'),
    CreationDate: PDFString.of(pdfDate(now)),
    ModDate: PDFString.of(pdfDate(now)),
  };
  (out.context.trailerInfo as { Info?: PDFObject }).Info = out.context.register(out.context.obj(info));
  await out.flush();
  collectGarbage(out);
  const bytes = await out.save(SAVE_OPTIONS);
  report?.(1);
  return bytes;
}
