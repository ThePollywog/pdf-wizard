/**
 * Which characters of a page were NOT visible before redactions are applied: text drawn invisibly
 * (render mode 3/7, e.g. an OCR layer) or on a layer that is turned off.
 *
 * pdf.js text content doesn't say how text was drawn, so the pages are extracted again from a copy
 * of the document with that content removed (by the "Remove hidden information" content filter)
 * and characters are matched by position. Applying redactions uses it so that:
 *   - text of hidden layers is not turned into searchable text of the rebuilt page (the layer's
 *     graphics are gone from the page image as well);
 *   - text that was invisible stays "hidden text" that "Remove hidden information" still finds,
 *     instead of becoming part of the page's own searchable text layer.
 */
import { PDFDocument } from '@cantoo/pdf-lib';
import * as engine from '@/core/engine';
import { N } from '@/core/engine/lib';
import type { LibDocument } from '@/core/types';
import { filterPagesContent } from './sanitize';
import { charsBox, pageModelOf, type ModelItem, type PageModel } from './textModel';

export type CharClass = 'visible' | 'invisible' | 'hiddenLayer';
export type Classify = (item: ModelItem, i: number) => CharClass;

const CELL = 24;

function center(item: ModelItem, i: number): [number, number] {
  const r = charsBox(item, i, i + 1);
  return [r.x + r.width / 2, r.y + r.height / 2];
}

/** Characters of a page model, bucketed by position for "is this char still there?" lookups. */
class CharIndex {
  private cells = new Map<string, [number, number][]>();

  constructor(model: PageModel) {
    for (const item of model.items) {
      for (let i = 0; i < item.str.length; i++) {
        const ch = item.str[i];
        if (/\s/.test(ch)) continue;
        const [cx, cy] = center(item, i);
        const key = `${ch}|${Math.floor(cx / CELL)}|${Math.floor(cy / CELL)}`;
        const list = this.cells.get(key);
        if (list) list.push([cx, cy]);
        else this.cells.set(key, [[cx, cy]]);
      }
    }
  }

  has(ch: string, cx: number, cy: number, tol: number): boolean {
    const gx = Math.floor(cx / CELL);
    const gy = Math.floor(cy / CELL);
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const list = this.cells.get(`${ch}|${gx + dx}|${gy + dy}`);
        if (list?.some(([x, y]) => Math.abs(x - cx) <= tol && Math.abs(y - cy) <= tol)) return true;
      }
    }
    return false;
  }
}

/** The pages `indices` of `lib` as a small standalone document (only what text extraction needs). */
async function extract(lib: LibDocument, indices: number[]): Promise<Uint8Array> {
  for (const i of indices) {
    const leaf = lib.getPage(i).node;
    // Annotations (and beads, thumbnails...) can reference other pages and drag the whole document along.
    for (const k of ['Annots', 'B', 'Thumb', 'PieceInfo', 'Metadata', 'StructParents']) leaf.delete(N(k));
  }
  const out = await PDFDocument.create({ updateMetadata: false });
  const pages = await out.copyPages(lib, indices);
  for (const p of pages) out.addPage(p);
  return out.save({ useObjectStreams: false, addDefaultPage: false });
}

async function modelsOf(bytes: Uint8Array, count: number): Promise<PageModel[]> {
  const pdf = await engine.loadPdfjs(bytes);
  try {
    const out: PageModel[] = [];
    for (let k = 0; k < count; k++) out.push(await pageModelOf(pdf, k));
    return out;
  } finally {
    void pdf.loadingTask.destroy().catch(() => {});
  }
}

/**
 * Classifiers for the pages `indices` of the document `bytes` (page index → classify). Pages
 * without hidden content get no classifier: all their text is visible.
 */
export async function hiddenTextClassifiers(bytes: Uint8Array, indices: number[]): Promise<Map<number, Classify>> {
  const result = new Map<number, Classify>();
  if (!indices.length) return result;
  const lib = await engine.loadLib(bytes);
  const layers = filterPagesContent(lib, indices, { hiddenText: false, layers: true });
  const layerBytes = layers.hiddenLayers > 0 ? await extract(lib, indices) : null;
  const text = filterPagesContent(lib, indices, { hiddenText: true, layers: false });
  const textBytes = text.hiddenText > 0 ? await extract(lib, indices) : null;
  if (!layerBytes && !textBytes) return result;
  const withoutLayers = layerBytes ? await modelsOf(layerBytes, indices.length) : null;
  const visibleOnly = textBytes ? await modelsOf(textBytes, indices.length) : null;
  indices.forEach((pageIndex, k) => {
    const L = withoutLayers ? new CharIndex(withoutLayers[k]) : null;
    const T = visibleOnly ? new CharIndex(visibleOnly[k]) : null;
    result.set(pageIndex, (item, i) => {
      const ch = item.str[i];
      if (ch === undefined || /\s/.test(ch)) return 'visible';
      const [cx, cy] = center(item, i);
      const tol = Math.min(CELL, Math.max(1.5, item.fontSize * 0.4));
      if (L && !L.has(ch, cx, cy, tol)) return 'hiddenLayer';
      if (T && !T.has(ch, cx, cy, tol)) return 'invisible';
      return 'visible';
    });
  });
  return result;
}
