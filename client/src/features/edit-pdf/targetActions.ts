/**
 * Actions on the selected page item shared by the floating bar, the task panel, the context menu
 * and the keyboard: flip / rotate / crop / replace / arrange images, delete, edit text, link
 * properties.
 */
import { actions, getDoc, useApp } from '@/core/store';
import type { DocId, Rect } from '@/core/types';
import { pickFiles } from '@/core/util';
import { makeViewport, totalRotation } from '@/core/viewer/viewport';
import { quadBounds, unitQuad, type Matrix } from './content/matrix';
import {
  arrangeTarget, baseLink, convertBaseLink, cropTarget, currentModel, deleteTarget, findImage, followLink,
  geomOfInfo, geomOfObject, linkDataOf, readOnlyNotice, replaceTargetImage, transformTarget, type ImageGeom,
} from './edits';
import { KIND_IMAGE, KIND_LINK, KIND_TEXT, TOOL_CONTENT, TOOL_LINK, type ContentImageObject, type ContentTextObject, type LinkData, type LinkObject } from './model';
import { openLinkDialog } from './ui/LinkDialog';
import { commitEdit, startBlockEdit, startObjectEdit } from './sessions';
import { paperColor } from './pagedom';
import { ui, type Target } from './state';
import { FLIP_H, FLIP_V, ROT_CCW, ROT_CW, boxOfQuad, viewTransformToUser } from './viewmath';
import { frameQuad } from './content/blocks';

export type TargetKind = 'text' | 'image' | 'link' | 'none';

/** What kind of thing a target is (text block / text box, image, link). */
export function kindOfTarget(t: Target | null): TargetKind {
  if (!t) return 'none';
  if (t.type === 'block') return 'text';
  if (t.type === 'image') return 'image';
  if (t.type === 'link') return 'link';
  const o = getDoc(t.docId)?.objects[t.id];
  if (!o) return 'none';
  return o.kind === KIND_TEXT ? 'text' : o.kind === KIND_IMAGE ? 'image' : o.kind === KIND_LINK ? 'link' : 'none';
}

/** Geometry of the selected image (base image or image object). */
export async function imageGeomOf(t: Target): Promise<ImageGeom | null> {
  if (t.type === 'image') {
    const im = await findImage(t);
    return im ? geomOfInfo(im) : null;
  }
  if (t.type === 'object') {
    const o = getDoc(t.docId)?.objects[t.id] as ContentImageObject | undefined;
    return o?.kind === KIND_IMAGE ? geomOfObject(o) : null;
  }
  return null;
}

/** User-space transform of an on-screen flip / quarter turn around the image center. */
function screenTransform(docId: DocId, pageIndex: number, bounds: Rect, screen: Matrix): Matrix | null {
  const doc = getDoc(docId);
  const page = doc?.pages[pageIndex];
  if (!doc || !page) return null;
  const vp = makeViewport(page, 1, totalRotation(page, doc.view.rotation));
  return viewTransformToUser(vp, bounds, screen);
}

async function screenOp(t: Target, screen: Matrix, label: string): Promise<boolean> {
  if (readOnlyNotice(t.docId)) return false;
  const g = await imageGeomOf(t);
  if (!g) return false;
  const m = screenTransform(t.docId, t.pageIndex, g.bounds, screen);
  return m ? transformTarget(t, m, label) : false;
}

export const flipTarget = (t: Target, axis: 'h' | 'v') => screenOp(t, axis === 'h' ? FLIP_H : FLIP_V, axis === 'h' ? 'Flip horizontal' : 'Flip vertical');
export const rotateTarget = (t: Target, dir: 'cw' | 'ccw') => screenOp(t, dir === 'cw' ? ROT_CW : ROT_CCW, dir === 'cw' ? 'Rotate clockwise' : 'Rotate counterclockwise');

// ── crop ─────────────────────────────────────────────────────────────────────

export async function startCrop(t: Target): Promise<void> {
  if (readOnlyNotice(t.docId)) return;
  await commitEdit();
  const g = await imageGeomOf(t);
  if (!g) return;
  const full = quadBounds(unitQuad(g.matrix));
  ui.setTarget(t);
  ui.setCrop({ docId: t.docId, pageIndex: t.pageIndex, target: t, rect: g.bounds, bounds: g.bounds, full });
}

export async function applyCrop(): Promise<boolean> {
  const c = ui.get().crop;
  if (!c) return false;
  ui.setCrop(null);
  const same = Math.abs(c.rect.x - c.bounds.x) < 0.01 && Math.abs(c.rect.y - c.bounds.y) < 0.01 && Math.abs(c.rect.width - c.bounds.width) < 0.01 && Math.abs(c.rect.height - c.bounds.height) < 0.01;
  if (same) return false;
  return cropTarget(c.target, c.rect);
}

export function cancelCrop(): void {
  if (ui.get().crop) ui.setCrop(null);
}

// ── replace / arrange / delete ───────────────────────────────────────────────

export async function replaceTarget(t: Target): Promise<boolean> {
  if (readOnlyNotice(t.docId)) return false;
  const [file] = await pickFiles({ accept: 'image/png,image/jpeg,image/gif,image/webp,image/bmp,.png,.jpg,.jpeg,.gif,.webp,.bmp' });
  if (!file) return false;
  return replaceTargetImage(t, file);
}

export const arrange = (t: Target, where: 'front' | 'back') => (readOnlyNotice(t.docId) ? Promise.resolve(false) : arrangeTarget(t, where));

export const removeTarget = (t: Target) => deleteTarget(t);

// ── text ─────────────────────────────────────────────────────────────────────

/** Opens the text editor on the selected text (caret at the end). */
export async function editTargetText(t: Target): Promise<boolean> {
  if (t.type === 'object') {
    const o = getDoc(t.docId)?.objects[t.id] as ContentTextObject | undefined;
    if (o?.kind !== KIND_TEXT) return false;
    return startObjectEdit(t.docId, t.pageIndex, o, 'end');
  }
  if (t.type !== 'block') return false;
  const model = await currentModel(t.docId, t.pageIndex);
  const b = model?.blocks.find((x) => x.id === t.id && x.text === t.text);
  if (!b) return false;
  const doc = getDoc(t.docId);
  const page = doc?.pages[t.pageIndex];
  if (!doc || !page) return false;
  const vp = makeViewport(page, doc.view.zoom, totalRotation(page, doc.view.rotation));
  return startBlockEdit(t.docId, t.pageIndex, b, 'end', paperColor(t.pageIndex, boxOfQuad(vp, frameQuad(b.frame))));
}

// ── links ────────────────────────────────────────────────────────────────────

/** Link data of the selected link (base annotation or link object). */
export async function linkDataOfTarget(t: Target): Promise<LinkData | null> {
  if (t.type === 'link') {
    const info = await baseLink(t);
    return info ? linkDataOf(t.docId, info) : null;
  }
  if (t.type === 'object') {
    const o = getDoc(t.docId)?.objects[t.id] as LinkObject | undefined;
    return o?.kind === KIND_LINK ? o.data : null;
  }
  return null;
}

/** Link Properties dialog for the selected link. */
export async function editLinkProperties(t: Target): Promise<void> {
  if (readOnlyNotice(t.docId)) return;
  const data = await linkDataOfTarget(t);
  if (!data) {
    if (t.type === 'link') actions.toast('This link runs an action that can’t be edited here.', { kind: 'warning' });
    return;
  }
  const next = await openLinkDialog({ docId: t.docId, pageIndex: t.pageIndex, initial: data, mode: 'edit' });
  if (!next) return;
  if (t.type === 'link') {
    await convertBaseLink(t, { data: next }, 'Edit link');
    return;
  }
  const o = getDoc(t.docId)?.objects[t.id] as LinkObject | undefined;
  if (o) actions.updateObject(t.docId, o.id, { data: next }, { label: 'Edit link' });
}

export async function openTargetLink(t: Target): Promise<void> {
  const data = await linkDataOfTarget(t);
  if (data) followLink(t.docId, data);
}

/** Activates the edit tool for `t` (text / image → Edit, links → Link) and selects it. */
export function focusTarget(t: Target): void {
  const want = kindOfTarget(t) === 'link' ? TOOL_LINK : TOOL_CONTENT;
  if (useApp.getState().activeToolId !== want) actions.setTool(want);
  ui.setTarget(t);
}
