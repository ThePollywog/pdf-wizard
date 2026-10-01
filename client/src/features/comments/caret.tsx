/**
 * Insert text (PDF /Caret) and Replace text (Caret + grouped /StrikeOut; the note holds the
 * replacement text).
 */
import { useMemo } from 'react';
import type { DocId, ObjectRenderProps, ObjectTypeDef, PageId, Point, Rect, TextSelectionInfo } from '@/core/types';
import { actions, getDoc, getToolOptions, newObject } from '@/core/store';
import { unionRects } from '@/core/geometry';
import { caretPath, markupShapes } from './geometry';
import { caretRectAt, endOfQuads, quadList, quadsBBox, quadsForSelection, translateQuads } from './quads';
import { exportCaret } from './pdfExport';
import { OpacityChip, Swatch } from './bars';
import { commentContextItems } from './menus';
import { addNewObject } from './ops';
import { fmt, svgPoints, svgPolyline } from './render';
import { CaretIcon } from './icons';
import { canAnnotate, CARET_DEFAULTS, commentsUi, TOOL, type CaretData, type CaretObject, type TextDir } from './model';
import { cleanSelectedText } from './markup';

function CaretRender({ obj, toLocal, scale }: ObjectRenderProps<CaretObject>) {
  const d = obj.data;
  const color = obj.color ?? CARET_DEFAULTS.color;
  const opacity = obj.opacity ?? 1;
  const caretD = useMemo(() => {
    const p = caretPath(d.caret, d.dir);
    const pt = (q: Point) => {
      const v = toLocal(q);
      return `${fmt(v.x)} ${fmt(v.y)}`;
    };
    return `M${pt(p.start)} ${p.curves.map((c) => `C${c.map(pt).join(' ')}`).join(' ')} Z`;
  }, [d.caret, d.dir, toLocal]);
  const strike = useMemo(() => (d.strike ? markupShapes('strikeout', d.strike.quads) : null), [d.strike]);
  const quads = useMemo(() => (d.strike ? quadList(d.strike.quads) : []), [d.strike]);
  const c0 = toLocal({ x: d.caret.x, y: d.caret.y + d.caret.height });
  const c1 = toLocal({ x: d.caret.x + d.caret.width, y: d.caret.y });
  const hit = { x: Math.min(c0.x, c1.x), y: Math.min(c0.y, c1.y), w: Math.abs(c1.x - c0.x), h: Math.abs(c1.y - c0.y) };
  return (
    <svg className="comments-caret" width="100%" height="100%" data-testid="comments-caret" data-replace={d.strike ? 'true' : undefined}>
      {quads.map(([tl, tr, bl, br], i) => (
        <polygon key={i} className="comments-hit" points={svgPoints([tl, tr, br, bl].map(toLocal))} />
      ))}
      {strike?.lines.map((l, i) => (
        <path key={i} d={svgPolyline(l.pts.map(toLocal))} stroke={color} strokeWidth={Math.max(0.75, l.width * scale)} fill="none" opacity={opacity} pointerEvents="none" />
      ))}
      <rect className="comments-hit" x={hit.x - 3} y={hit.y - 3} width={hit.w + 6} height={hit.h + 6} />
      <path d={caretD} fill={color} opacity={opacity} pointerEvents="none" />
    </svg>
  );
}

function CaretBar({ obj, update }: { obj: CaretObject; update(p: Partial<CaretObject>, o?: { label?: string }): void }) {
  return (
    <>
      <Swatch testid="comments-bar-color" label="Color" value={obj.color ?? CARET_DEFAULTS.color} onChange={(c) => c && update({ color: c }, { label: 'Change color' })} />
      <OpacityChip testid="comments-bar-opacity" value={obj.opacity ?? 1} onChange={(v) => update({ opacity: v }, { label: 'Change opacity' })} />
    </>
  );
}

export function caretBounds(d: CaretData): Rect {
  return d.strike && d.strike.quads.length ? unionRects([d.caret, quadsBBox(d.strike.quads)]) : d.caret;
}

export const caretType: ObjectTypeDef<CaretObject> = {
  kind: 'caret',
  label: 'Text edit',
  icon: CaretIcon,
  category: 'comment',
  Render: CaretRender,
  hit: 'shape',
  resizable: false,
  translate: (o, dx, dy) => {
    const d = o.data;
    const data: CaretData = {
      ...d,
      caret: { ...d.caret, x: d.caret.x + dx, y: d.caret.y + dy },
      strike: d.strike ? { ...d.strike, quads: translateQuads(d.strike.quads, dx, dy) } : undefined,
    };
    return { data, rect: { ...o.rect, x: o.rect.x + dx, y: o.rect.y + dy } };
  },
  editable: true,
  summary: (o) => (o.data.strike ? o.data.strike.text : ''),
  PropertiesBar: CaretBar,
  contextMenu: (o, docId) => commentContextItems(o, docId),
  exportToPdf: (o, ctx) => exportCaret(o, ctx),
};

// ── creation ────────────────────────────────────────────────────────────────

function caretOptions(toolId: string) {
  return getToolOptions(toolId, CARET_DEFAULTS);
}

/** Insert-text caret at a baseline point. Opens the note editor. */
export function createCaret(docId: DocId, pageId: PageId, at: Point, lineHeight: number, dir: TextDir): CaretObject | null {
  if (!canAnnotate(docId) || !getDoc(docId)) return null;
  const { color, opacity } = caretOptions(TOOL.insert);
  const caret = caretRectAt(at, lineHeight, dir);
  const o = newObject<CaretObject>({ kind: 'caret', pageId, rect: caret, color, opacity, data: { caret, dir: dir || undefined, symbol: 'None' } });
  addNewObject(docId, o, { select: true, label: 'Insert text' });
  commentsUi.openPopup({ docId, objectId: o.id, focus: true, source: 'create' });
  return o;
}

/** Caret at the end of a text selection (Insert text with selected text). */
export async function createCaretAfterSelection(sel: TextSelectionInfo): Promise<CaretObject | null> {
  const { quads } = await quadsForSelection(sel);
  const end = endOfQuads(quads);
  if (!end) return null;
  return createCaret(sel.docId, sel.pageId, end.at, end.height, end.dir);
}

/** Replace text: strike the selection and put a caret after it; the note holds the new text. */
export async function createReplace(selections: TextSelectionInfo[]): Promise<CaretObject | null> {
  const sel = selections[0];
  if (!sel || !canAnnotate(sel.docId)) return null;
  const { quads } = await quadsForSelection(sel);
  const end = endOfQuads(quads);
  if (!end || !getDoc(sel.docId)) return null;
  const { color, opacity } = caretOptions(TOOL.replace);
  const caret = caretRectAt(end.at, end.height, end.dir);
  const data: CaretData = { caret, dir: end.dir || undefined, symbol: 'None', strike: { quads, text: cleanSelectedText(sel.text) } };
  const o = newObject<CaretObject>({ kind: 'caret', pageId: sel.pageId, rect: caretBounds(data), color, opacity, data });
  actions.addObject(sel.docId, o, { select: true, label: 'Replace text' });
  commentsUi.openPopup({ docId: sel.docId, objectId: o.id, focus: true, source: 'create' });
  return o;
}
