/**
 * Editable items of a page for the current tool (text blocks, images, links, added objects) and
 * hit testing against them (topmost first).
 */
import type { DocState, PageInfo, PdfObject, Point } from '@/core/types';
import { frameQuad } from './content/blocks';
import type { TextBlock } from './content/blocks';
import type { ImageInfo } from './content/ops';
import type { LinkInfo } from './content/links';
import type { PageModel } from './analysis';
import type { Target } from './state';
import { geomOfObject } from './edits';
import { KIND_IMAGE, KIND_LINK, KIND_TEXT, TOOL_CONTENT, TOOL_LINK, TOOL_TEXT, type ContentImageObject } from './model';

/** Rect corners as a polygon (counter-clockwise). */
export const rectPoly = (r: { x: number; y: number; width: number; height: number }): number[] => [r.x, r.y, r.x + r.width, r.y, r.x + r.width, r.y + r.height, r.x, r.y + r.height];

export type ItemKind = 'block' | 'image' | 'link' | 'text-object' | 'image-object' | 'link-object';

export interface Item {
  key: string;
  kind: ItemKind;
  target: Target;
  /** Outline in user space (4 corners). */
  quad: number[];
  block?: TextBlock;
  image?: ImageInfo;
  link?: LinkInfo;
  obj?: PdfObject;
}

export const isTextItem = (it: Item) => it.kind === 'block' || it.kind === 'text-object';
export const isImageItem = (it: Item) => it.kind === 'image' || it.kind === 'image-object';
export const isLinkItem = (it: Item) => it.kind === 'link' || it.kind === 'link-object';

/** Items of a page in drawing order (bottom first). */
export function pageItems(doc: DocState, page: PageInfo, pageIndex: number, model: PageModel | null, toolId: string): Item[] {
  const docId = doc.id;
  const out: Item[] = [];
  const objs = doc.order.map((id) => doc.objects[id]).filter((o): o is PdfObject => !!o && o.pageId === page.id);
  if (toolId === TOOL_CONTENT) {
    if (model) {
      for (const im of model.images) {
        out.push({ key: `image:${pageIndex}:${im.id}`, kind: 'image', quad: im.quad, image: im, target: { type: 'image', docId, pageIndex, id: im.id, name: im.name, bounds: im.bounds } });
      }
      for (const b of model.blocks) {
        out.push({ key: `block:${pageIndex}:${b.id}`, kind: 'block', quad: frameQuad(b.frame), block: b, target: { type: 'block', docId, pageIndex, id: b.id, text: b.text, bounds: b.bounds } });
      }
    }
    for (const o of objs) {
      if (o.kind === KIND_IMAGE) out.push({ key: `object:${pageIndex}:${o.id}`, kind: 'image-object', quad: geomOfObject(o as ContentImageObject).quad, obj: o, target: { type: 'object', docId, pageIndex, id: o.id } });
      else if (o.kind === KIND_TEXT) out.push({ key: `object:${pageIndex}:${o.id}`, kind: 'text-object', quad: rectPoly(o.rect), obj: o, target: { type: 'object', docId, pageIndex, id: o.id } });
    }
  } else if (toolId === TOOL_LINK) {
    if (model) {
      for (const l of model.links) {
        out.push({ key: `link:${pageIndex}:${l.id}`, kind: 'link', quad: rectPoly(l.rect), link: l, target: { type: 'link', docId, pageIndex, id: l.id } });
      }
    }
    for (const o of objs) {
      if (o.kind === KIND_LINK) out.push({ key: `object:${pageIndex}:${o.id}`, kind: 'link-object', quad: rectPoly(o.rect), obj: o, target: { type: 'object', docId, pageIndex, id: o.id } });
    }
  } else if (toolId === TOOL_TEXT) {
    for (const o of objs) {
      if (o.kind === KIND_TEXT) out.push({ key: `object:${pageIndex}:${o.id}`, kind: 'text-object', quad: rectPoly(o.rect), obj: o, target: { type: 'object', docId, pageIndex, id: o.id } });
    }
  }
  return out;
}

/** Point inside a convex quad (either winding), with `pad` points of slack. */
export function inQuad(q: number[], p: Point, pad = 0): boolean {
  let sign = 0;
  const n = q.length / 2;
  // signed area → orientation
  let area = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += q[2 * i] * q[2 * j + 1] - q[2 * j] * q[2 * i + 1];
  }
  sign = area >= 0 ? 1 : -1;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ex = q[2 * j] - q[2 * i];
    const ey = q[2 * j + 1] - q[2 * i + 1];
    const len = Math.hypot(ex, ey) || 1;
    // distance of p to the edge line, positive inside
    const d = (sign * (ex * (p.y - q[2 * i + 1]) - ey * (p.x - q[2 * i]))) / len;
    if (d < -pad) return false;
  }
  return true;
}

/** Distance (points) from p to the quad's outline, negative outside. */
export function edgeDistance(q: number[], p: Point): number {
  const n = q.length / 2;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += q[2 * i] * q[2 * j + 1] - q[2 * j] * q[2 * i + 1];
  }
  const sign = area >= 0 ? 1 : -1;
  let min = Infinity;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ex = q[2 * j] - q[2 * i];
    const ey = q[2 * j + 1] - q[2 * i + 1];
    const len = Math.hypot(ex, ey) || 1;
    const d = (sign * (ex * (p.y - q[2 * i + 1]) - ey * (p.x - q[2 * i]))) / len;
    min = Math.min(min, d);
  }
  return min;
}

/** Topmost item at `p` (text wins over images underneath it). */
export function hitItem(items: Item[], p: Point, pad: number): Item | null {
  let best: Item | null = null;
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (!inQuad(it.quad, p, pad)) continue;
    // exact hits beat padded ones
    if (!best) best = it;
    if (inQuad(it.quad, p, 0)) return it;
  }
  return best;
}
