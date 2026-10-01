/**
 * "fill-text" object: borderless typed text (Fill & Sign → Add text / Date).
 * Rendered as plain text, edited in place with a transparent textarea using the same metrics.
 * Exported as real PDF text (Helvetica, or an embedded Liberation Sans subset for characters outside
 * WinAnsi). Scripts no bundled font covers (CJK…) are drawn as an image under invisible, extractable text.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type SyntheticEvent } from 'react';
import { AArrowDown, AArrowUp, PenLine, Space, Type } from 'lucide-react';
import type { PDFFont } from '@cantoo/pdf-lib';
import type { DocId, ExportContext, ObjectRenderProps, ObjectTypeDef, PageInfo, Point, UpdateOptions } from '@/core/types';
import { actions, getDoc, newObject, useApp } from '@/core/store';
import { ColorSwatchButton, Divider, Dropdown, IconButton } from '@/core/ui';
import {
  DEFAULT_FONT_SIZE, DEFAULT_TEXT_COLOR, FILL_TEXT, FONT_SIZES, FONT_STACK, LETTER_SPACINGS, MAX_FONT, MIN_FONT, PAD_X, PAD_Y,
  anchorRect, caretIndexAt, clampFont, frameDirs, keepOnPage, lineWidth, nextFontSize, normalizeText, rectFromOrigin, textLayout, textRect, uprightOrigin,
  uprightSize, type FillTextData, type FillTextObject,
} from './model';
import { Upright } from './Upright';
import { drawLocal, embedPngCached, f, hashKey, invisibleTextFont, rgb } from './exportUtil';
import { renderTextImage } from './sigrender';
import { assetUrl } from '@/core/util';

export const TEXT_COALESCE = (id: string) => `fill-text:${id}`;

// ── caret hand-off (overlay click position → editor) ─────────────────────────

const pendingCaret = new Map<string, number>();
export function setPendingCaret(id: string, index: number) {
  pendingCaret.set(id, index);
}

/** Caret index for a page-space click point inside a text object. */
export function caretAt(obj: FillTextObject, p: Point): number {
  const o = uprightOrigin(obj.rect, obj.data.rot);
  const { du, dv } = frameDirs(obj.data.rot);
  const dx = p.x - o.x;
  const dy = p.y - o.y;
  return caretIndexAt(obj.data, dx * du.x + dy * du.y, dx * dv.x + dy * dv.y);
}

export function focusTextEditor(id: string) {
  requestAnimationFrame(() => {
    const ta = document.querySelector<HTMLTextAreaElement>(`.pdfwizard-obj[data-obj-id="${CSS.escape(id)}"] textarea`);
    if (ta && document.activeElement !== ta) ta.focus({ preventScroll: true });
  });
}

function focusViewer() {
  const s = document.querySelector<HTMLElement>('.pdfwizard-scroller');
  s?.focus({ preventScroll: true });
}

// ── creation ─────────────────────────────────────────────────────────────────

/**
 * Create a text object whose first line is vertically centred on `p` (text starts at `p.x`).
 * Pushes an undo checkpoint that later typing coalesces into.
 */
export function createFillText(
  docId: DocId,
  page: PageInfo,
  p: Point,
  data: Pick<FillTextData, 'fontSize' | 'letterSpacing' | 'rot'> & { text?: string },
  opts: { color?: string; select?: boolean; label?: string } = {},
): FillTextObject {
  const d: FillTextData = { text: data.text ?? '', fontSize: data.fontSize, letterSpacing: data.letterSpacing, rot: data.rot };
  const lay = textLayout(d);
  const { du, dv } = frameDirs(d.rot);
  const u = PAD_X;
  const v = PAD_Y + lay.lh / 2;
  const origin = { x: p.x - du.x * u - dv.x * v, y: p.y - du.y * u - dv.y * v };
  // Keep the box on the page.
  const rect = keepOnPage(rectFromOrigin(origin, lay.w, lay.h, d.rot), page);
  const obj = newObject<FillTextObject>({
    kind: 'fill-text',
    pageId: page.id,
    rect,
    color: opts.color ?? DEFAULT_TEXT_COLOR,
    data: d,
  });
  actions.checkpoint(docId, opts.label ?? 'Add text', TEXT_COALESCE(obj.id));
  actions.addObject(docId, obj, { checkpoint: false, select: opts.select ?? true });
  return obj;
}

/**
 * When editing of a text object ends and it is empty, remove it. If the object was created in the
 * same (coalesced) undo step, drop that step too so no empty history entry is left behind.
 */
export function removeIfEmpty(docId: DocId, id: string) {
  const d = getDoc(docId);
  const o = d?.objects[id] as FillTextObject | undefined;
  if (!d || !o || o.kind !== FILL_TEXT || o.data.text.trim() !== '' || d.editingId === id) return;
  const top = d.history.past[d.history.past.length - 1];
  if (top && top.coalesce === TEXT_COALESCE(id)) {
    if (!top.objects[id]) {
      actions.updateDoc(docId, (cur) => {
        const objects = { ...cur.objects };
        delete objects[id];
        return {
          objects,
          order: cur.order.filter((x) => x !== id),
          selection: cur.selection.filter((x) => x !== id),
          history: { past: cur.history.past.slice(0, -1), future: cur.history.future },
        };
      });
      return;
    }
    actions.deleteObjects(docId, [id], { checkpoint: false });
    return;
  }
  actions.deleteObjects(docId, [id], { label: 'Delete text' });
}

/** Watch for text objects that stop being edited while empty. */
export function watchEmptyText(): () => void {
  return useApp.subscribe((s, prev) => {
    if (s.docs === prev.docs) return;
    for (const [docId, pd] of Object.entries(prev.docs)) {
      const id = pd.editingId;
      if (!id) continue;
      const cd = s.docs[docId];
      if (!cd || cd.editingId === id) continue;
      const o = cd.objects[id] as FillTextObject | undefined;
      if (o && o.kind === FILL_TEXT && o.data.text.trim() === '') queueMicrotask(() => removeIfEmpty(docId, id));
    }
  });
}

// ── rendering ────────────────────────────────────────────────────────────────

function typography(d: FillTextData, scale: number, color: string | undefined) {
  const lay = textLayout(d);
  return {
    lay,
    style: {
      fontFamily: FONT_STACK,
      fontSize: `${d.fontSize * scale}px`,
      lineHeight: `${lay.lh * scale}px`,
      letterSpacing: d.letterSpacing ? `${d.letterSpacing * scale}px` : undefined,
      padding: `${PAD_Y * scale}px ${PAD_X * scale}px`,
      color: color ?? DEFAULT_TEXT_COLOR,
    },
  };
}

function FillTextRender({ obj, docId, scale, rotation, box, editing, update }: ObjectRenderProps<FillTextObject>) {
  const d = obj.data;
  const { w, h } = uprightSize(obj.rect, d.rot);
  const { style } = typography(d, scale, obj.color);
  return (
    <Upright box={box} scale={scale} rotation={rotation} rot={d.rot} w={w} h={h} className="fill-sign-text-box">
      {editing ? (
        <TextEditor obj={obj} docId={docId} scale={scale} update={update} />
      ) : (
        <div className="fill-sign-text" data-testid="fill-sign-text" style={{ ...style, opacity: obj.opacity ?? 1 }}>
          {d.text}
        </div>
      )}
    </Upright>
  );
}

function TextEditor({
  obj,
  docId,
  scale,
  update,
}: {
  obj: FillTextObject;
  docId: DocId;
  scale: number;
  update(patch: Partial<FillTextObject>, opts?: UpdateOptions): void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const d = obj.data;
  const [value, setValue] = useState(d.text);
  const { lay, style } = typography({ ...d, text: value }, scale, obj.color);

  // External changes (e.g. undo while editing) win.
  useEffect(() => {
    if (d.text !== value) setValue(d.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.text]);

  useLayoutEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    ta.focus({ preventScroll: true });
    const c = pendingCaret.get(obj.id);
    pendingCaret.delete(obj.id);
    const i = c ?? ta.value.length;
    ta.setSelectionRange(i, i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onChange = (raw: string) => {
    const text = normalizeText(raw);
    setValue(text);
    const cur = getDoc(docId)?.objects[obj.id] as FillTextObject | undefined;
    if (!cur) return;
    update(setTextData(cur, { text }, pageOf(docId, cur.pageId)), { coalesce: TEXT_COALESCE(obj.id), label: 'Edit text' });
    const ta = ref.current;
    if (ta) ta.scrollLeft = 0;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      actions.setEditing(docId, null);
      focusViewer();
    }
  };

  const onBlur = () => {
    setTimeout(() => {
      if (!document.hasFocus()) return;
      const a = document.activeElement;
      if (a === ref.current) return;
      if (a instanceof Element && a.closest('.pdfwizard-props-bar, [data-layer], .modal-layer')) return;
      if (getDoc(docId)?.editingId === obj.id) actions.setEditing(docId, null);
    }, 0);
  };

  return (
    <textarea
      ref={ref}
      className="fill-sign-text-input"
      data-testid="fill-sign-text-input"
      aria-label="Text"
      value={value}
      wrap="off"
      spellCheck={false}
      autoComplete="off"
      rows={1}
      style={{ ...style, width: (lay.w + d.fontSize) * scale, height: lay.h * scale }}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
    />
  );
}

// ── properties bar ───────────────────────────────────────────────────────────

const keepFocus = (e: SyntheticEvent) => e.preventDefault();
const fmtPt = (v: number) => `${Number(v.toFixed(1))}`;

const pageOf = (docId: DocId, pageId: string) => getDoc(docId)?.pages.find((p) => p.id === pageId);

/**
 * Patch for new text data: the box keeps its upright top-left corner and grows from there; when it
 * would stick out of `page` (typing past the right edge, lines past the bottom) it shifts back onto it.
 */
export function setTextData(obj: FillTextObject, patch: Partial<FillTextData>, page?: Pick<PageInfo, 'view'>): Pick<FillTextObject, 'data' | 'rect'> {
  const data = { ...obj.data, ...patch };
  const rect = textRect(uprightOrigin(obj.rect, obj.data.rot), data);
  return { data, rect: page ? keepOnPage(rect, page) : rect };
}

function FillTextBar({
  obj,
  docId,
  update,
}: {
  obj: FillTextObject;
  docId: DocId;
  update(patch: Partial<FillTextObject>, opts?: UpdateOptions): void;
}) {
  const d = obj.data;
  const editing = useApp((s) => s.docs[docId]?.editingId === obj.id);
  const refocus = () => {
    if (editing) focusTextEditor(obj.id);
  };
  const setSize = (fs: number) => {
    update(setTextData(obj, { fontSize: clampFont(fs) }, pageOf(docId, obj.pageId)), { label: 'Change font size' });
    refocus();
  };
  const setSpacing = (ls: number) => {
    update(setTextData(obj, { letterSpacing: ls }, pageOf(docId, obj.pageId)), { label: 'Change letter spacing' });
    refocus();
  };
  return (
    <div className="fill-sign-bar" onMouseDown={keepFocus}>
      <IconButton
        icon={AArrowDown}
        label="Decrease font size"
        size="sm"
        data-testid="fill-sign-text-smaller"
        disabled={d.fontSize <= MIN_FONT}
        onClick={() => setSize(nextFontSize(d.fontSize, -1))}
      />
      <Dropdown
        label="Font size"
        trigger={
          <button type="button" className="fill-sign-bar-value" data-testid="fill-sign-text-size" aria-label="Font size" title="Font size">
            {fmtPt(d.fontSize)}
          </button>
        }
        items={FONT_SIZES.map((s) => ({ id: `fill-sign.size.${s}`, label: `${s} pt`, checked: Math.abs(d.fontSize - s) < 0.01, run: () => setSize(s) }))}
      />
      <IconButton
        icon={AArrowUp}
        label="Increase font size"
        size="sm"
        data-testid="fill-sign-text-larger"
        disabled={d.fontSize >= MAX_FONT}
        onClick={() => setSize(nextFontSize(d.fontSize, 1))}
      />
      <Divider vertical />
      <span className="fill-sign-swatch" data-testid="fill-sign-text-color">
        <ColorSwatchButton
          value={obj.color ?? DEFAULT_TEXT_COLOR}
          label="Text color"
          size="sm"
          onChange={(c) => {
            if (c) update({ color: c }, { label: 'Change text color' });
            refocus();
          }}
        />
      </span>
      <Dropdown
        label="Letter spacing"
        trigger={<IconButton icon={Space} label="Letter spacing (comb)" size="sm" data-testid="fill-sign-text-spacing" active={d.letterSpacing > 0} />}
        items={[
          { header: 'Letter spacing' },
          ...LETTER_SPACINGS.map((v) => ({
            id: `fill-sign.spacing.${v}`,
            label: v === 0 ? 'None' : `${v} pt`,
            checked: Math.abs(d.letterSpacing - v) < 0.01,
            run: () => setSpacing(v),
          })),
        ]}
      />
    </div>
  );
}

// ── export ───────────────────────────────────────────────────────────────────

const LIBERATION_URL = assetUrl('pdfjs/standard_fonts/LiberationSans-Regular.ttf');

function supports(font: PDFFont | null, chars: number[]): boolean {
  if (!font) return false;
  const set = new Set(font.getCharacterSet());
  return chars.every((c) => set.has(c));
}

async function exportText(obj: FillTextObject, ctx: ExportContext) {
  const d = obj.data;
  if (!d.text.trim()) return;
  const lay = textLayout(d);
  const { w, h } = uprightSize(obj.rect, d.rot);
  const chars = [...new Set([...d.text.replace(/\n/g, '')].map((c) => c.codePointAt(0)!))];
  const lineY = (i: number) => h - PAD_Y - i * lay.lh - lay.baseline;
  let font: PDFFont | null = await ctx.standardFont('Helvetica');
  if (!supports(font, chars)) {
    // Beyond WinAnsi (Greek, Cyrillic, extended Latin…): embed a subset of Liberation Sans.
    try {
      // ctx.customFont patches the fontkit subset; the URL key shares one embedded subset with the other features.
      font = await ctx.customFont(LIBERATION_URL, async () => {
        const r = await fetch(LIBERATION_URL);
        if (!r.ok) throw new Error(`font ${r.status}`);
        return r.arrayBuffer();
      });
    } catch (e) {
      console.warn('[fill-sign] custom font unavailable', e);
      font = null;
    }
    if (!supports(font, chars)) font = null;
  }

  if (!font) {
    // No embeddable font covers the script (e.g. CJK): draw the text as an image and put invisible
    // text over it (like OCR output) so it can still be searched, selected and extracted.
    const png = renderTextImage(lay.lines, {
      fontSize: d.fontSize,
      letterSpacing: d.letterSpacing,
      color: obj.color ?? DEFAULT_TEXT_COLOR,
      width: w,
      height: h,
      lineHeight: lay.lh,
      padX: PAD_X,
      padY: PAD_Y,
      baseline: lay.baseline,
      font: FONT_STACK,
    });
    const key = `txt:${hashKey(d.text)}:${obj.id}:${obj.modifiedAt}`;
    const ref = await embedPngCached(ctx.pdfDoc, key, async () => png);
    const inv = invisibleTextFont(ctx.pdfDoc, d.text, (ch) => lineWidth(ch, 1000, 0));
    const ops = [`q ${f(w)} 0 0 ${f(h)} 0 0 cm /Im0 Do Q`, 'BT', '3 Tr', `/F0 ${f(d.fontSize)} Tf`];
    if (d.letterSpacing) ops.push(`${f(d.letterSpacing)} Tc`);
    lay.lines.forEach((line, i) => {
      if (line) ops.push(`1 0 0 1 ${f(PAD_X)} ${f(lineY(i))} Tm`, `${inv.encode(line)} Tj`);
    });
    ops.push('ET');
    const res = ctx.pdfDoc.context.obj({ XObject: { Im0: ref }, Font: { F0: inv.ref } });
    drawLocal(ctx, obj, d.rot, ops.join('\n'), res);
    return;
  }

  const ops: string[] = ['BT', `/F0 ${f(d.fontSize)} Tf`, `${rgb(obj.color, DEFAULT_TEXT_COLOR)} rg`];
  if (d.letterSpacing) ops.push(`${f(d.letterSpacing)} Tc`);
  lay.lines.forEach((line, i) => {
    if (line) ops.push(`1 0 0 1 ${f(PAD_X)} ${f(lineY(i))} Tm`, `${font.encodeText(line).toString()} Tj`);
  });
  ops.push('ET');
  const res = ctx.pdfDoc.context.obj({ Font: { F0: font.ref } });
  drawLocal(ctx, obj, d.rot, ops.join('\n'), res, Math.max(2, d.fontSize * 0.3));
}

// ── type ─────────────────────────────────────────────────────────────────────

export const fillTextType: ObjectTypeDef<FillTextObject> = {
  kind: FILL_TEXT,
  label: 'Text',
  icon: Type,
  category: 'fill-sign',
  Render: FillTextRender,
  editable: true,
  keepAspectRatio: true,
  minSize: { width: 3, height: 3 },
  resize(obj, rect) {
    const d = obj.data;
    const b = uprightSize(obj.rect, d.rot);
    const p = uprightSize(rect, d.rot);
    const k = b.h > 0 ? p.h / b.h : 1;
    const fontSize = Math.min(MAX_FONT, Math.max(MIN_FONT, Math.round(d.fontSize * k * 10) / 10));
    const ratio = fontSize / d.fontSize;
    const data: FillTextData = { ...d, fontSize, letterSpacing: Math.round(d.letterSpacing * ratio * 10) / 10 };
    const lay = textLayout(data);
    const swap = d.rot % 180 !== 0;
    return { data, rect: anchorRect(obj.rect, rect, swap ? lay.h : lay.w, swap ? lay.w : lay.h) };
  },
  PropertiesBar: FillTextBar,
  summary: (o) => o.data.text,
  contextMenu(obj, docId) {
    return [
      { id: 'fill-sign.text.edit', label: 'Edit text', icon: PenLine, run: () => actions.setEditing(docId, obj.id) },
      {
        id: 'fill-sign.text.larger',
        label: 'Increase font size',
        icon: AArrowUp,
        disabled: obj.data.fontSize >= MAX_FONT,
        run: () => actions.updateObject(docId, obj.id, setTextData(obj, { fontSize: clampFont(nextFontSize(obj.data.fontSize, 1)) }, pageOf(docId, obj.pageId)), { label: 'Change font size' }),
      },
      {
        id: 'fill-sign.text.smaller',
        label: 'Decrease font size',
        icon: AArrowDown,
        disabled: obj.data.fontSize <= MIN_FONT,
        run: () => actions.updateObject(docId, obj.id, setTextData(obj, { fontSize: clampFont(nextFontSize(obj.data.fontSize, -1)) }, pageOf(docId, obj.pageId)), { label: 'Change font size' }),
      },
    ];
  },
  exportToPdf: exportText,
};

export const DEFAULT_TEXT_OPTIONS = { fontSize: DEFAULT_FONT_SIZE, letterSpacing: 0 };
