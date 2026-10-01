/**
 * Arrow-key nudging of the selected item. Added objects move live (coalesced into one undo step);
 * base text blocks and images accumulate the moves under a pixel preview and are rewritten once
 * the keys rest (one undoable byte edit per burst).
 */
import { actions, getDoc } from '@/core/store';
import { reg } from '@/core/registry';
import type { Rect } from '@/core/types';
import { translateRect, viewToRect } from '@/core/geometry';
import { makeViewport, totalRotation, viewDeltaToPdf } from '@/core/viewer/viewport';
import { frameQuad } from '../content/blocks';
import { translate } from '../content/matrix';
import { baseLink, convertBaseLink, currentModel, moveTextBlock, readOnlyNotice, transformTarget } from '../edits';
import { KIND_IMAGE, KIND_LINK } from '../model';
import { pageCanvas, paperColor, snapshot } from '../pagedom';
import { coverQuad, sameTarget, ui, type Target } from '../state';
import { boxOfQuad } from '../viewmath';

/** Quiet time after the last arrow key before a base item is rewritten (ms). */
const DELAY = 450;

interface Pending {
  target: Extract<Target, { type: 'block' | 'image' }>;
  dx: number;
  dy: number;
  timer: ReturnType<typeof setTimeout> | null;
  ghost: string | null;
  /** Snapshot rect (user space) before moving. */
  from: Rect | null;
  url: string | null;
  ready: Promise<void>;
}

let pending: Pending | null = null;
let flushing: Promise<unknown> | null = null;

function viewportOf(docId: string, pageIndex: number, zoom?: number) {
  const doc = getDoc(docId);
  const page = doc?.pages[pageIndex];
  if (!doc || !page) return null;
  return makeViewport(page, zoom ?? doc.view.zoom, totalRotation(page, doc.view.rotation));
}

/** Arrow key → screen direction. */
export function arrowDelta(key: string, step: number): { x: number; y: number } | null {
  if (key === 'ArrowLeft') return { x: -step, y: 0 };
  if (key === 'ArrowRight') return { x: step, y: 0 };
  if (key === 'ArrowUp') return { x: 0, y: -step };
  if (key === 'ArrowDown') return { x: 0, y: step };
  return null;
}

async function prepare(p: Pending): Promise<void> {
  const t = p.target;
  const model = await currentModel(t.docId, t.pageIndex);
  const vp = viewportOf(t.docId, t.pageIndex);
  if (!model || !vp) return;
  let quad: number[] | null = null;
  let cover: number[][] = [];
  if (t.type === 'block') {
    const b = model.blocks.find((x) => x.id === t.id && x.text === t.text);
    if (!b) return;
    quad = frameQuad(b.frame);
    cover = [coverQuad(b.frame, Math.max(0.5, b.style.size * 0.12))];
  } else {
    const im = model.images.find((x) => x.id === t.id);
    if (!im) return;
    quad = im.quad;
    cover = [im.quad];
  }
  const b0 = boxOfQuad(vp, quad);
  const box = { left: b0.left - 2, top: b0.top - 2, width: b0.width + 4, height: b0.height + 4 };
  p.url = snapshot(t.pageIndex, box);
  p.from = viewToRect(vp, box);
  const paper = paperColor(t.pageIndex, box);
  p.ghost = ui.addGhost({
    docId: t.docId,
    pageIndex: t.pageIndex,
    cover,
    snap: p.url ? { url: p.url, to: translateRect(p.from, p.dx, p.dy) } : undefined,
    paper,
  });
}

function showMoved(p: Pending) {
  if (p.ghost && p.from && p.url) ui.patchGhost(p.ghost, { snap: { url: p.url, to: translateRect(p.from, p.dx, p.dy) } });
}

/** Moves the selected item by (vx, vy) screen points. */
export function nudgeTarget(t: Target, vx: number, vy: number): void {
  const doc = getDoc(t.docId);
  const unit = viewportOf(t.docId, t.pageIndex, 1);
  if (!doc || !unit || readOnlyNotice(t.docId)) return;
  const d = viewDeltaToPdf(unit, vx, vy);

  if (t.type === 'object') {
    const o = doc.objects[t.id];
    if (!o || o.locked) return;
    const type = reg.objectType(o.kind);
    const patch = type?.translate ? type.translate(o, d.x, d.y) : { rect: translateRect(o.rect, d.x, d.y) };
    const what = o.kind === KIND_IMAGE ? 'image' : o.kind === KIND_LINK ? 'link' : 'text';
    actions.updateObject(t.docId, o.id, patch, { coalesce: `edit-pdf-nudge:${o.id}`, label: `Move ${what}` });
    return;
  }
  if (ui.get().working || ui.get().edit) return; // a byte edit is running: wait for it
  if (t.type === 'link') {
    void (async () => {
      const info = await baseLink(t);
      if (info) await convertBaseLink(t, { rect: translateRect(info.rect, d.x, d.y) }, 'Move link');
    })();
    return;
  }
  if (pending && !sameTarget(pending.target, t)) flushNudge();
  if (!pending) {
    const p: Pending = { target: t, dx: 0, dy: 0, timer: null, ghost: null, from: null, url: null, ready: Promise.resolve() };
    pending = p;
    p.ready = prepare(p);
  }
  const p = pending;
  p.dx += d.x;
  p.dy += d.y;
  showMoved(p);
  if (p.timer) clearTimeout(p.timer);
  p.timer = setTimeout(flushNudge, DELAY);
}

/** Writes the accumulated nudge of a base item now (no-op when nothing is pending). */
export function flushNudge(): void {
  const p = pending;
  if (!p) return;
  pending = null;
  if (p.timer) clearTimeout(p.timer);
  p.timer = null;
  const run = (async () => {
    await p.ready;
    const t = p.target;
    const canvas = pageCanvas(t.pageIndex);
    const ok = t.type === 'block' ? await moveTextBlock(t, p.dx, p.dy) : await transformTarget(t, translate(p.dx, p.dy), 'Move image');
    if (p.ghost) {
      if (ok) ui.patchGhost(p.ghost, { settleFrom: canvas });
      else ui.removeGhost(p.ghost);
    }
  })();
  const f = run.finally(() => {
    if (flushing === f) flushing = null;
  });
  flushing = f;
}

/** True while arrow-key moves wait to be written. */
export const nudgePending = () => !!pending || !!flushing;

/** Flushes and waits for the pending nudge. */
export async function settleNudge(): Promise<void> {
  flushNudge();
  if (flushing) await flushing;
}
