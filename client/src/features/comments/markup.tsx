/**
 * Text markups: highlight (incl. area highlight), underline, strikethrough, squiggly.
 * One object per page selection, one quad per line (PDF /QuadPoints).
 */
import { useMemo } from 'react';
import { Highlighter, Strikethrough, Underline } from 'lucide-react';
import type { DocId, ObjectRenderProps, ObjectTypeDef, PageId, Rect, TextSelectionInfo } from '@/core/types';
import { actions, getDoc, getToolOptions, newObject } from '@/core/store';
import { mapQuads, quadFromRect, quadList, quadsBBox, quadsForSelection, translateQuads } from './quads';
import { markupShapes } from './geometry';
import { exportMarkup } from './pdfExport';
import { ChipDropdown, OpacityChip, Swatch } from './bars';
import { commentContextItems } from './menus';
import { PageUnderlay, svgPoints, svgPolyline, viewPt } from './render';
import { SquigglyIcon } from './icons';
import {
  canAnnotate, MARKUP_COLORS, MARKUP_DEFAULTS, MARKUP_LABEL, MARKUP_TOOL, normRotation, type MarkupObject, type MarkupType,
  type TextDir,
} from './model';

export const MARKUP_ICONS = { highlight: Highlighter, underline: Underline, strikeout: Strikethrough, squiggly: SquigglyIcon } as const;

export function cleanSelectedText(t: string): string {
  return t.replace(/\s*\n\s*/g, ' ').replace(/[ \t]+/g, ' ').trim();
}

function MarkupRender({ obj, viewport, toLocal, scale }: ObjectRenderProps<MarkupObject>) {
  const d = obj.data;
  const color = obj.color ?? MARKUP_COLORS[d.type] ?? MARKUP_COLORS.highlight;
  const opacity = obj.opacity ?? 1;
  const shapes = useMemo(() => markupShapes(d.type, d.quads), [d.type, d.quads]);
  const quads = useMemo(() => quadList(d.quads), [d.quads]);
  return (
    <>
      <svg className="comments-markup" width="100%" height="100%" data-testid="comments-markup" data-type={d.type}>
        {quads.map(([tl, tr, bl, br], i) => (
          <polygon key={i} className="comments-hit" points={svgPoints([tl, tr, br, bl].map(toLocal))} />
        ))}
        {d.type !== 'highlight' &&
          shapes.lines.map((l, i) => (
            <path
              key={i}
              d={svgPolyline(l.pts.map(toLocal))}
              stroke={color}
              strokeWidth={Math.max(0.75, l.width * scale)}
              strokeLinejoin="round"
              fill="none"
              opacity={opacity}
              pointerEvents="none"
            />
          ))}
      </svg>
      {d.type === 'highlight' && (
        <PageUnderlay objId={obj.id} className="comments-hl">
          <svg width="100%" height="100%" style={{ opacity }}>
            <path d={shapes.polys.map((p) => svgPolyline(p.map((pt) => viewPt(viewport, pt)), true)).join(' ')} fill={color} />
          </svg>
        </PageUnderlay>
      )}
    </>
  );
}

function MarkupBar({ obj, update }: { obj: MarkupObject; update(p: Partial<MarkupObject>, o?: { label?: string }): void }) {
  const d = obj.data;
  const color = obj.color ?? MARKUP_COLORS[d.type];
  const Icon = MARKUP_ICONS[d.type] ?? Highlighter;
  return (
    <>
      {d.text && (
        <ChipDropdown
          testid="comments-bar-markup-type"
          label="Markup type"
          icon={Icon}
          items={(Object.keys(MARKUP_LABEL) as MarkupType[]).map((t) => ({
            id: `comments-markup-type-${t}`,
            label: MARKUP_LABEL[t],
            icon: MARKUP_ICONS[t],
            checked: d.type === t,
            run: () => update({ data: { ...d, type: t }, color: obj.color === MARKUP_COLORS[d.type] ? MARKUP_COLORS[t] : obj.color }, { label: `Change to ${MARKUP_LABEL[t].toLowerCase()}` }),
          }))}
        />
      )}
      <Swatch testid="comments-bar-color" label="Color" value={color} onChange={(c) => c && update({ color: c }, { label: 'Change color' })} />
      <OpacityChip testid="comments-bar-opacity" value={obj.opacity ?? 1} onChange={(v) => update({ opacity: v }, { label: 'Change opacity' })} />
    </>
  );
}

export const markupType: ObjectTypeDef<MarkupObject> = {
  kind: 'text-markup',
  label: 'Text markup',
  icon: Highlighter,
  category: 'comment',
  Render: MarkupRender,
  hit: 'shape',
  resizable: false,
  translate: (o, dx, dy) => ({
    rect: { ...o.rect, x: o.rect.x + dx, y: o.rect.y + dy },
    data: { ...o.data, quads: translateQuads(o.data.quads, dx, dy) },
  }),
  resize: (o, rect) => ({ rect, data: { ...o.data, quads: mapQuads(o.data.quads, o.rect, rect) } }),
  editable: true,
  summary: (o) => o.data.text ?? '',
  PropertiesBar: MarkupBar,
  contextMenu: (o, docId) => commentContextItems(o, docId),
  exportToPdf: (o, ctx) => exportMarkup(o, ctx),
};

// ── creation ────────────────────────────────────────────────────────────────

export function markupOptions(type: MarkupType): { color: string; opacity: number } {
  return getToolOptions(MARKUP_TOOL[type], MARKUP_DEFAULTS[type]);
}

/** One markup per page selection. Returns the created objects. */
export async function createMarkups(type: MarkupType, selections: TextSelectionInfo[], opts: { select?: boolean; label?: string } = {}): Promise<MarkupObject[]> {
  const docId = selections[0]?.docId;
  if (!docId || !canAnnotate(docId)) return [];
  const { color, opacity } = markupOptions(type);
  const objs: MarkupObject[] = [];
  for (const sel of selections) {
    const { quads } = await quadsForSelection(sel);
    if (!quads.length) continue;
    objs.push(
      newObject<MarkupObject>({
        kind: 'text-markup',
        pageId: sel.pageId,
        rect: quadsBBox(quads),
        color,
        opacity,
        data: { type, quads, text: cleanSelectedText(sel.text) },
      }),
    );
  }
  if (!objs.length || !getDoc(docId)) return [];
  actions.addObjects(docId, objs, { select: opts.select ?? true, label: opts.label ?? MARKUP_LABEL[type] });
  return objs;
}

/** Area highlight over a rectangle (no text under it). */
export function createAreaHighlight(docId: DocId, pageId: PageId, rect: Rect): MarkupObject | null {
  const d = getDoc(docId);
  const page = d?.pages.find((p) => p.id === pageId);
  if (!d || !page || !canAnnotate(docId)) return null;
  const { color, opacity } = markupOptions('highlight');
  const dir = normRotation(page.rotation) as TextDir;
  const quads = quadFromRect(rect, dir);
  const o = newObject<MarkupObject>({ kind: 'text-markup', pageId, rect: quadsBBox(quads), color, opacity, data: { type: 'highlight', quads, text: '' } });
  actions.addObject(docId, o, { select: true, label: 'Area highlight' });
  return o;
}
