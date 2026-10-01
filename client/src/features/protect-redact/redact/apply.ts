/**
 * Applying redactions: content under the marks is removed PERMANENTLY, in one undoable step.
 *
 * For every page with marks:
 *   1. the page content is rendered (without annotations) and the marked boxes are painted over it;
 *   2. the page content is replaced by that image, vector boxes in the fill color and the overlay
 *      text — nothing of the original content streams, fonts or images remains on the page;
 *   3. the text outside the boxes is written back as invisible text (Tr 3), so the page stays
 *      searchable and selectable — characters under a box are never written;
 *   4. annotations, links and form widgets intersecting the boxes are removed.
 * A whole-page mark makes the page blank (fill color + overlay), keeping its size.
 */
import { PDFDict, PDFRef, StandardFonts, type PDFFont, type PDFObject, type PDFPageLeaf } from '@cantoo/pdf-lib';
import { createElement } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { EyeOff, ShieldCheck } from 'lucide-react';
import * as engine from '@/core/engine';
import { N, annotRefsOf, lookupDict, nameOf, nullifyRefs, numbersOf, pruneAcroForm } from '@/core/engine/lib';
import { rectsIntersect } from '@/core/geometry';
import { actions, getDoc } from '@/core/store';
import type { DocId, LibDocument, PageInfo, Rect } from '@/core/types';
import { choiceDialog, confirmDialog } from '@/core/ui';
import { FEATURE, errorMessage, plural, readOnlyReason } from '../shared';
import { clipToPage, marksOf } from './marks';
import { canEncode, colorOps, fmt, layoutOverlay, overlayOps, rectOps } from './overlay';
import { dpiFor, rasterizeRedacted, type RedactBox } from './raster';
import { charRedacted, charsBox, getPageModel, type ModelItem, type PageModel } from './textModel';
import { hiddenTextClassifiers, type CharClass, type Classify } from './hiddenText';
import { openSanitizeDialog } from './SanitizeDialog';
import { INVISIBLE_TEXT_TAG, isRedaction, type OverlayFont, type OverlayProps, type RedactionObject } from './types';

interface PageBox extends RedactBox {
  overlay: OverlayProps;
}

interface PagePlan {
  index: number;
  info: PageInfo;
  boxes: PageBox[];
  full: boolean;
  markIds: string[];
}

function viewRect(v: [number, number, number, number]): Rect {
  return { x: v[0], y: v[1], width: v[2] - v[0], height: v[3] - v[1] };
}

function coversView(r: Rect, v: [number, number, number, number]): boolean {
  const tol = 0.5;
  return r.x <= v[0] + tol && r.y <= v[1] + tol && r.x + r.width >= v[2] - tol && r.y + r.height >= v[3] - tol;
}

/** Group marks by page, clip them to the visible box, detect whole-page redactions. */
export function planFor(pages: PageInfo[], marks: RedactionObject[]): PagePlan[] {
  const byPage = new Map<string, PagePlan>();
  pages.forEach((info, index) => byPage.set(info.id, { index, info, boxes: [], full: false, markIds: [] }));
  for (const m of marks) {
    const plan = byPage.get(m.pageId);
    if (!plan) continue;
    plan.markIds.push(m.id);
    const rects = m.data.mode === 'page' ? [viewRect(plan.info.view)] : m.data.rects.length ? m.data.rects : [m.rect];
    for (const r of rects) {
      const c = clipToPage(r, plan.info);
      if (!c) continue;
      plan.boxes.push({ rect: c, fill: m.fillColor ?? null, overlay: m.data.overlay, snap: m.data.mode === 'text' });
      if (m.data.mode === 'page' || coversView(c, plan.info.view)) plan.full = true;
    }
  }
  return [...byPage.values()].filter((p) => p.boxes.length).sort((a, b) => a.index - b.index);
}

// ── fonts ───────────────────────────────────────────────────────────────────

const STD: Record<OverlayFont, StandardFonts> = {
  Helvetica: StandardFonts.Helvetica,
  Times: StandardFonts.TimesRoman,
  Courier: StandardFonts.Courier,
};
const RES_NAME: Record<OverlayFont, string> = { Helvetica: 'RFHv', Times: 'RFTi', Courier: 'RFCo' };

class Fonts {
  private cache = new Map<OverlayFont, Promise<PDFFont>>();
  constructor(private lib: LibDocument) {}
  get(font: OverlayFont): Promise<PDFFont> {
    let p = this.cache.get(font);
    if (!p) {
      p = this.lib.embedFont(STD[font]);
      this.cache.set(font, p);
    }
    return p;
  }
}

// ── invisible text ──────────────────────────────────────────────────────────

function encodable(s: string): string {
  let out = '';
  for (const ch of s) {
    if (canEncode(ch)) out += ch;
    else if (/\s/.test(ch)) out += ' ';
    else for (const c of ch.normalize('NFKC')) if (canEncode(c)) out += c;
  }
  return out;
}

function inside(v: [number, number, number, number], item: ModelItem, i: number): boolean {
  const r = charsBox(item, i, i + 1);
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  return cx >= v[0] && cx <= v[2] && cy >= v[1] && cy <= v[3];
}

/**
 * Operators re-adding the text of `model` that is NOT under `boxes` as invisible text, positioned
 * where it was so search, selection and copy keep working. Returns '' when there is none.
 *
 * With `classify`, text of hidden layers is left out, and text that was invisible already (an OCR
 * layer...) is written outside the page's own searchable-text block, so "Remove hidden
 * information" still treats it as hidden text.
 */
export function invisibleTextOps(
  model: PageModel,
  boxes: Rect[],
  view: [number, number, number, number],
  font: PDFFont,
  fontName: string,
  classify?: Classify,
): string {
  const lists: Record<'visible' | 'invisible', { ops: string[]; size: number }> = {
    visible: { ops: [], size: -1 },
    invisible: { ops: [], size: -1 },
  };
  const space = (s: string) => /\s/.test(s);
  for (const item of model.items) {
    const n = item.str.length;
    if (item.vertical || n === 0 || item.len <= 0 || !item.str.trim()) continue;
    const whole = charsBox(item, 0, n);
    const touched = boxes.some((b) => rectsIntersect(whole, b));
    const cls: CharClass[] | null = classify ? Array.from({ length: n }, (_, k) => classify(item, k)) : null;
    const keep = (k: number) => inside(view, item, k) && (!touched || !charRedacted(item, k, boxes)) && cls?.[k] !== 'hiddenLayer';
    let i = 0;
    while (i < n) {
      if (!keep(i) || space(item.str[i])) {
        i++;
        continue;
      }
      const kind: 'visible' | 'invisible' = cls?.[i] === 'invisible' ? 'invisible' : 'visible';
      const same = (k: number) => space(item.str[k]) || (cls?.[k] === 'invisible' ? 'invisible' : 'visible') === kind;
      let j = i;
      while (j < n && keep(j) && same(j)) j++;
      const a = i;
      let b = j;
      while (b > a && space(item.str[b - 1])) b--;
      i = j;
      if (b <= a) continue;
      const text = encodable(item.str.slice(a, b));
      if (!text.trim()) continue;
      const a0 = item.offsets[a] * item.len;
      const L = (item.offsets[b] - item.offsets[a]) * item.len;
      if (L <= 0.01) continue;
      const fs = item.fontSize;
      let w: number;
      try {
        w = font.widthOfTextAtSize(text, fs);
      } catch {
        continue;
      }
      if (!(w > 0)) continue;
      const list = lists[kind];
      if (fs !== list.size) {
        list.ops.push(`/${fontName} ${fmt(fs)} Tf`);
        list.size = fs;
      }
      const tz = Math.min(1000, Math.max(1, (100 * L) / w));
      const x = item.ox + item.ux * a0;
      const y = item.oy + item.uy * a0;
      list.ops.push(`${fmt(tz)} Tz`, `${fmt(item.ux)} ${fmt(item.uy)} ${fmt(item.vx)} ${fmt(item.vy)} ${fmt(x)} ${fmt(y)} Tm`, `${font.encodeText(text).toString()} Tj`);
    }
  }
  const out: string[] = [];
  if (lists.visible.ops.length) out.push(`/${INVISIBLE_TEXT_TAG} BMC`, 'BT', '3 Tr', ...lists.visible.ops, 'ET', 'EMC');
  if (lists.invisible.ops.length) out.push('BT', '3 Tr', ...lists.invisible.ops, 'ET');
  return out.join('\n');
}

// ── annotations ─────────────────────────────────────────────────────────────

function annotRect(lib: LibDocument, d: PDFDict): Rect | null {
  const r = numbersOf(lib.context, d.get(N('Rect')));
  if (!r || r.length !== 4) return null;
  const x = Math.min(r[0], r[2]);
  const y = Math.min(r[1], r[3]);
  return { x, y, width: Math.abs(r[2] - r[0]), height: Math.abs(r[3] - r[1]) };
}

/** Remove the page's annotations intersecting `boxes` (all of them when `boxes` is null). */
function pruneAnnots(lib: LibDocument, leaf: PDFPageLeaf, boxes: Rect[] | null, removed: Set<PDFObject>): number {
  const ctx = lib.context;
  const refs = annotRefsOf(leaf);
  if (!refs.length) return 0;
  const gone = new Set<PDFObject>();
  for (const r of refs) {
    const d = lookupDict(ctx, r);
    if (!d) continue;
    if (!boxes) {
      gone.add(r);
      continue;
    }
    if (nameOf(ctx, d.get(N('Subtype'))) === 'Popup') continue;
    const rect = annotRect(lib, d);
    // Zero-size annotations (e.g. hidden widgets) still count when their point is inside a box.
    const probe = rect && (rect.width > 0 || rect.height > 0) ? rect : rect ? { ...rect, width: 0.01, height: 0.01 } : null;
    if (probe && boxes.some((b) => rectsIntersect(probe, b))) gone.add(r);
  }
  // Popups follow their parent.
  for (const r of refs) {
    const d = lookupDict(ctx, r);
    if (!d || gone.has(r)) continue;
    if (nameOf(ctx, d.get(N('Subtype'))) === 'Popup') {
      const parent = d.get(N('Parent'));
      if (parent && gone.has(parent)) gone.add(r);
    }
  }
  if (!gone.size) return 0;
  const keep = refs.filter((r) => !gone.has(r));
  if (keep.length) leaf.set(N('Annots'), ctx.obj(keep));
  else leaf.delete(N('Annots'));
  for (const g of gone) removed.add(g);
  return [...gone].filter((g) => {
    const d = lookupDict(ctx, g);
    return !d || nameOf(ctx, d.get(N('Subtype'))) !== 'Popup';
  }).length;
}

// ── page rebuild ────────────────────────────────────────────────────────────

const PAGE_KEYS_TO_DROP = ['Thumb', 'PieceInfo', 'Metadata', 'B', 'StructParents', 'Group', 'SeparationInfo', 'ID', 'PZ'];

async function rebuildPage(
  lib: LibDocument,
  leaf: PDFPageLeaf,
  plan: PagePlan,
  pdf: PDFDocumentProxy,
  model: PageModel | null,
  fonts: Fonts,
  dpi: number,
  classify?: Classify,
): Promise<void> {
  const ctx = lib.context;
  const view = plan.info.view;
  const content: string[] = [];
  const xobjects: Record<string, PDFRef> = {};
  const fontRes: Record<string, PDFRef> = {};

  if (!plan.full) {
    const page = await pdf.getPage(plan.index + 1);
    const img = await rasterizeRedacted(page, plan.boxes, dpi);
    // Use the boxes as painted from here on (fill, overlay, surviving text, annotations).
    img.rects.forEach((r, i) => {
      if (plan.boxes[i]) plan.boxes[i] = { ...plan.boxes[i], rect: r };
    });
    const [X0, Y0, X1, Y1] = page.view;
    const dict = { Type: 'XObject', Subtype: 'Image', Width: img.width, Height: img.height, Interpolate: true, ...img.dict };
    const stream = img.encoding === 'flate' ? ctx.flateStream(img.bytes, dict) : ctx.stream(img.bytes, dict);
    xobjects.RIm0 = ctx.register(stream);
    content.push('q', `${fmt(X1 - X0)} 0 0 ${fmt(Y1 - Y0)} ${fmt(X0)} ${fmt(Y0)} cm`, '/RIm0 Do', 'Q');
  }

  // Vector boxes (crisp edges) in the fill color.
  const filled = plan.full
    ? plan.boxes.filter((b) => b.fill).slice(-1).map((b) => ({ ...b, rect: viewRect(view) }))
    : plan.boxes.filter((b) => b.fill);
  if (filled.length) {
    content.push('q');
    for (const b of filled) content.push(colorOps(b.fill!), `${rectOps(b.rect)} f`);
    content.push('Q');
  }

  // Overlay text.
  for (const b of plan.boxes) {
    const lay = layoutOverlay(b.overlay, b.rect, plan.info.rotation);
    if (!lay) continue;
    const font = await fonts.get(lay.font);
    const name = RES_NAME[lay.font];
    fontRes[name] = font.ref;
    content.push(overlayOps(lay, name, (s) => font.encodeText(s).toString()));
  }

  // Text outside the boxes, as invisible text.
  if (!plan.full && model) {
    const font = await fonts.get('Helvetica');
    const ops = invisibleTextOps(model, plan.boxes.map((b) => b.rect), view, font, 'RFTx', classify);
    if (ops) {
      fontRes.RFTx = font.ref;
      content.push(ops);
    }
  }

  const resources: Record<string, Record<string, PDFRef>> = {};
  if (Object.keys(xobjects).length) resources.XObject = xobjects;
  if (Object.keys(fontRes).length) resources.Font = fontRes;
  leaf.set(N('Resources'), ctx.obj(resources));
  leaf.set(N('Contents'), ctx.register(ctx.flateStream(content.join('\n') + '\n')));
  for (const k of PAGE_KEYS_TO_DROP) leaf.delete(N(k));
}

// ── public API ──────────────────────────────────────────────────────────────

export interface ApplyResult {
  marks: number;
  pages: number;
  annotations: number;
}

/**
 * Apply marks without asking (the engine step). Marks are removed afterwards; undo restores
 * both the content and the marks.
 */
export async function applyMarksNow(docId: DocId, ids: string[]): Promise<ApplyResult> {
  const doc = getDoc(docId);
  if (!doc) throw new Error('The document is no longer open.');
  const wanted = new Set(ids);
  const result: ApplyResult = { marks: 0, pages: 0, annotations: 0 };
  let affectedIds: string[] = [];
  let affectedRects = new Map<string, Rect[]>();
  let fullPages = new Set<string>();
  actions.setBusy({ label: 'Applying redactions…', progress: 0 });
  try {
    await engine.withLib(docId, 'Apply redactions', async (lib, pages) => {
      const cur = getDoc(docId)!;
      const marks = marksOf(cur).filter((m) => wanted.has(m.id));
      const plans = planFor(pages, marks);
      if (!plans.length) throw new Error('There are no redaction marks to apply.');
      const pdf = await engine.awaitPdf(docId);
      const leaves = lib.getPages().map((p) => p.node);
      const fonts = new Fonts(lib);
      const dpi = dpiFor(plans.filter((p) => !p.full).length);
      const removed = new Set<PDFObject>();
      const models = new Map<number, PageModel>();
      for (const plan of plans) {
        if (plan.full) continue;
        try {
          models.set(plan.index, await getPageModel(docId, plan.index, pdf));
        } catch (e) {
          console.warn(`[${FEATURE}] no text for page ${plan.index + 1}`, e);
        }
      }
      // Text that wasn't visible (invisible text, hidden layers) must not become the page's visible-text layer.
      let classifiers = new Map<number, Classify>();
      const withText = [...models].filter(([, m]) => m.items.length).map(([i]) => i);
      if (withText.length) {
        try {
          classifiers = await hiddenTextClassifiers(cur.bytes, withText);
        } catch (e) {
          console.warn(`[${FEATURE}] couldn't check for hidden text`, e);
        }
      }
      let done = 0;
      for (const plan of plans) {
        const leaf = leaves[plan.index];
        if (!leaf) throw new Error(`Page ${plan.index + 1} is missing.`);
        await rebuildPage(lib, leaf, plan, pdf, models.get(plan.index) ?? null, fonts, dpi, classifiers.get(plan.index));
        result.annotations += pruneAnnots(lib, leaf, plan.full ? null : plan.boxes.map((b) => b.rect), removed);
        done += 1;
        actions.setBusy({ label: `Applying redactions… (page ${done} of ${plans.length})`, progress: done / plans.length });
      }
      if (removed.size) {
        pruneAcroForm(lib, (ref) => !removed.has(ref));
        const refs = new Set([...removed].filter((r): r is PDFRef => r instanceof PDFRef));
        if (refs.size) nullifyRefs(lib, refs);
      }
      // The structure tree may hold alternate text / ActualText of what was removed.
      lib.catalog.delete(N('StructTreeRoot'));
      lib.catalog.delete(N('MarkInfo'));
      actions.setBusy({ label: 'Saving changes…', progress: null });
      result.marks = marks.length;
      result.pages = plans.length;
      affectedIds = marks.map((m) => m.id);
      affectedRects = new Map(plans.map((p) => [p.info.id, p.boxes.map((b) => b.rect)]));
      fullPages = new Set(plans.filter((p) => p.full).map((p) => p.info.id));
    });
  } finally {
    actions.setBusy(null);
  }
  // Remove the applied marks and overlay objects (comments, added content...) over redacted areas,
  // as part of the same undo step.
  const after = getDoc(docId);
  if (after) {
    const drop = new Set(affectedIds);
    for (const id of after.order) {
      const o = after.objects[id];
      if (!o || drop.has(id) || isRedaction(o)) continue;
      const boxes = affectedRects.get(o.pageId);
      if (!boxes) continue;
      if (fullPages.has(o.pageId) || boxes.some((b) => rectsIntersect(o.rect, b))) drop.add(id);
    }
    const present = [...drop].filter((id) => after.objects[id]);
    if (present.length) actions.deleteObjects(docId, present, { checkpoint: false });
  }
  return result;
}

/**
 * "Apply" with the standard confirmation. `ids` limits it to some marks (default: all marks).
 * Resolves true when redactions were applied.
 */
export async function applyRedactions(docId: DocId, ids?: string[], opts: { confirm?: boolean; offerSanitize?: boolean } = {}): Promise<boolean> {
  // One "Apply" at a time per document (double clicks, the shortcut while the dialog is open...).
  if (applying.has(docId)) return false;
  applying.add(docId);
  try {
    return await applyOnce(docId, ids, opts);
  } finally {
    applying.delete(docId);
  }
}

const applying = new Set<DocId>();

async function applyOnce(docId: DocId, ids: string[] | undefined, opts: { confirm?: boolean; offerSanitize?: boolean }): Promise<boolean> {
  const doc = getDoc(docId);
  if (!doc) return false;
  const all = marksOf(doc);
  const marks = ids ? all.filter((m) => ids.includes(m.id)) : all;
  if (!marks.length) {
    actions.toast('There are no redaction marks to apply. Mark text, areas or pages first.', { kind: 'info' });
    return false;
  }
  const reason = readOnlyReason(docId);
  if (reason) {
    actions.toast(reason, { kind: 'error' });
    return false;
  }
  const pageCount = new Set(marks.map((m) => m.pageId)).size;
  if (opts.confirm !== false) {
    const ok = await confirmDialog({
      title: 'Apply redactions',
      icon: EyeOff,
      danger: true,
      width: 480,
      confirmLabel: 'Apply',
      message: createElement(
        'div',
        { className: 'protect-redact-apply-confirm', 'data-testid': 'protect-redact-apply-confirm' },
        createElement(
          'p',
          null,
          `You are about to permanently remove all content marked for redaction (${plural(marks.length, 'mark')} on ${plural(pageCount, 'page')}). `,
          createElement('b', null, 'Once you save the document, you will be unable to retrieve this content.'),
        ),
        createElement(
          'p',
          { className: 'protect-redact-muted' },
          'Pages with marks are rebuilt: their content becomes an image with a searchable text layer that leaves out the redacted text. Links, comments and form fields under the marks are removed as well.',
        ),
        createElement('p', null, 'Are you sure you want to continue?'),
      ),
    });
    if (!ok) return false;
  }
  let res: ApplyResult;
  try {
    res = await applyMarksNow(docId, marks.map((m) => m.id));
  } catch (e) {
    console.warn(`[${FEATURE}] apply redactions failed`, e);
    actions.toast(`Couldn't apply redactions: ${errorMessage(e)}`, { kind: 'error' });
    return false;
  }
  actions.toast(`Applied ${plural(res.marks, 'redaction')} on ${plural(res.pages, 'page')}.`, { kind: 'success' });
  if (opts.offerSanitize !== false) {
    const choice = await choiceDialog<'skip' | 'sanitize'>({
      title: 'Remove hidden information?',
      icon: ShieldCheck,
      message: createElement(
        'div',
        { 'data-testid': 'protect-redact-after-apply' },
        'Redactions were applied. Documents can also hold information you can’t see — metadata, comments, attachments, hidden text or layers. Do you want to review and remove it too?',
      ),
      choices: [
        { value: 'skip', label: 'Not now' },
        { value: 'sanitize', label: 'Remove hidden information…', variant: 'primary' },
      ],
    });
    if (choice === 'sanitize') await openSanitizeDialog(docId);
  }
  return true;
}
