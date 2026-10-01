/**
 * "fill-mark" object: the Fill & Sign symbols — cross, check, dot, line and circle.
 * One geometry description drives both the SVG rendering and the exported vector paths.
 */
import { Check, Circle, Dot, Minus, X, Shapes } from 'lucide-react';
import type { DocId, ExportContext, ObjectRenderProps, ObjectTypeDef, PageInfo, Point, Rotation, UpdateOptions, IconType } from '@/core/types';
import { actions, getDoc, newObject } from '@/core/store';
import { ColorSwatchButton, Divider, Dropdown, IconButton } from '@/core/ui';
import {
  DEFAULT_MARK_COLOR, DEFAULT_MARK_STROKE, FILL_MARK, MARK_KINDS, MARK_LABELS, anchorRect, clampRectToPage, markDefaultSize,
  markHasStroke, markKeepsAspect, rectAround, uprightSize, type FillMarkObject, type MarkKind,
} from './model';
import { Upright } from './Upright';
import { drawLocal, f, rgb } from './exportUtil';

export const MARK_ICONS: Record<MarkKind, IconType> = { check: Check, cross: X, dot: Dot, line: Minus, circle: Circle };

type Prim =
  | { t: 'poly'; pts: [number, number][]; sw: number; cap: 'round' | 'butt' }
  | { t: 'ellipse'; cx: number; cy: number; rx: number; ry: number; fill: boolean; sw: number };

/** Glyph primitives in upright local coordinates (points, y down) for a W×H box. */
export function markGeometry(mark: MarkKind, W: number, H: number, strokeWidth: number): Prim[] {
  const m = Math.min(W, H);
  switch (mark) {
    case 'check': {
      const sw = Math.max(0.5, m * 0.12);
      return [{ t: 'poly', pts: [[0.1 * W, 0.55 * H], [0.4 * W, 0.85 * H], [0.9 * W, 0.15 * H]], sw, cap: 'round' }];
    }
    case 'cross': {
      const sw = Math.max(0.5, m * 0.12);
      return [
        { t: 'poly', pts: [[0.15 * W, 0.15 * H], [0.85 * W, 0.85 * H]], sw, cap: 'round' },
        { t: 'poly', pts: [[0.85 * W, 0.15 * H], [0.15 * W, 0.85 * H]], sw, cap: 'round' },
      ];
    }
    case 'dot':
      return [{ t: 'ellipse', cx: W / 2, cy: H / 2, rx: W / 2, ry: H / 2, fill: true, sw: 0 }];
    case 'line': {
      const sw = Math.min(strokeWidth, H);
      return [{ t: 'poly', pts: [[0, H / 2], [W, H / 2]], sw, cap: 'butt' }];
    }
    case 'circle': {
      const sw = Math.min(strokeWidth, m / 2);
      return [{ t: 'ellipse', cx: W / 2, cy: H / 2, rx: Math.max(0.1, W / 2 - sw / 2), ry: Math.max(0.1, H / 2 - sw / 2), fill: false, sw }];
    }
  }
}

function MarkSvg({ mark, w, h, strokeWidth, color, scale }: { mark: MarkKind; w: number; h: number; strokeWidth: number; color: string; scale: number }) {
  const prims = markGeometry(mark, w, h, strokeWidth);
  return (
    <svg className="fill-sign-mark-svg" width={w * scale} height={h * scale} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      {prims.map((p, i) =>
        p.t === 'poly' ? (
          <polyline
            key={i}
            points={p.pts.map(([x, y]) => `${x},${y}`).join(' ')}
            fill="none"
            stroke={color}
            strokeWidth={p.sw}
            strokeLinecap={p.cap}
            strokeLinejoin="round"
          />
        ) : (
          <ellipse
            key={i}
            cx={p.cx}
            cy={p.cy}
            rx={p.rx}
            ry={p.ry}
            fill={p.fill ? color : 'none'}
            stroke={p.fill ? 'none' : color}
            strokeWidth={p.fill ? 0 : p.sw}
          />
        ),
      )}
    </svg>
  );
}

function FillMarkRender({ obj, scale, rotation, box }: ObjectRenderProps<FillMarkObject>) {
  const { mark, rot } = obj.data;
  const { w, h } = uprightSize(obj.rect, rot);
  return (
    <Upright box={box} scale={scale} rotation={rotation} rot={rot} w={w} h={h} className="fill-sign-mark" style={{ opacity: obj.opacity ?? 1 }}>
      <MarkSvg mark={mark} w={w} h={h} strokeWidth={obj.strokeWidth ?? DEFAULT_MARK_STROKE} color={obj.color ?? DEFAULT_MARK_COLOR} scale={scale} />
    </Upright>
  );
}

/** Ghost preview used by the placement overlay. */
export function MarkGhost({ mark, w, h, scale, color }: { mark: MarkKind; w: number; h: number; scale: number; color: string }) {
  return <MarkSvg mark={mark} w={w} h={h} strokeWidth={DEFAULT_MARK_STROKE} color={color} scale={scale} />;
}

// ── creation / edits ─────────────────────────────────────────────────────────

export function createMark(docId: DocId, page: PageInfo, center: Point, mark: MarkKind, rot: Rotation, color = DEFAULT_MARK_COLOR): FillMarkObject {
  const { w, h } = markDefaultSize(mark, page);
  const rect = clampRectToPage(rectAround(center, w, h, rot), page);
  const obj = newObject<FillMarkObject>({
    kind: 'fill-mark',
    pageId: page.id,
    rect,
    color,
    ...(markHasStroke(mark) ? { strokeWidth: DEFAULT_MARK_STROKE } : {}),
    data: { mark, rot },
  });
  actions.addObject(docId, obj, { select: true, label: `Add ${MARK_LABELS[mark].toLowerCase()}` });
  return obj;
}

/** Patch changing the symbol of a mark, keeping its centre and relative size. */
export function changeMarkPatch(obj: FillMarkObject, page: Pick<PageInfo, 'width' | 'height'>, mark: MarkKind): Partial<FillMarkObject> {
  const { rot } = obj.data;
  const cur = uprightSize(obj.rect, rot);
  const d0 = markDefaultSize(obj.data.mark, page);
  const d1 = markDefaultSize(mark, page);
  const k = obj.data.mark === 'line' ? cur.w / d0.w : cur.h / d0.h;
  const c = { x: obj.rect.x + obj.rect.width / 2, y: obj.rect.y + obj.rect.height / 2 };
  const rect = rectAround(c, d1.w * k, d1.h * k, rot);
  return {
    rect,
    data: { ...obj.data, mark },
    strokeWidth: markHasStroke(mark) ? (obj.strokeWidth ?? DEFAULT_MARK_STROKE) : undefined,
  };
}

const STROKES = [0.5, 1, 1.5, 2, 3, 4, 6];

function FillMarkBar({ obj, docId, update }: { obj: FillMarkObject; docId: DocId; update(patch: Partial<FillMarkObject>, opts?: UpdateOptions): void }) {
  const { mark } = obj.data;
  const Icon = MARK_ICONS[mark];
  const page = pageOf(docId, obj);
  return (
    <div className="fill-sign-bar">
      <Dropdown
        label="Symbol"
        trigger={<IconButton icon={Icon} label="Change symbol" size="sm" data-testid="fill-sign-mark-type" />}
        items={MARK_KINDS.map((m) => ({
          id: `fill-sign.mark.${m}`,
          label: MARK_LABELS[m],
          icon: MARK_ICONS[m],
          checked: m === mark,
          run: () => {
            if (m !== mark && page) update(changeMarkPatch(obj, page, m), { label: 'Change symbol' });
          },
        }))}
      />
      <Divider vertical />
      <span className="fill-sign-swatch" data-testid="fill-sign-mark-color">
        <ColorSwatchButton value={obj.color ?? DEFAULT_MARK_COLOR} label="Color" size="sm" onChange={(c) => c && update({ color: c }, { label: 'Change color' })} />
      </span>
      {markHasStroke(mark) && (
        <Dropdown
          label="Line thickness"
          trigger={
            <button type="button" className="fill-sign-bar-value" data-testid="fill-sign-mark-stroke" aria-label="Line thickness" title="Line thickness">
              {obj.strokeWidth ?? DEFAULT_MARK_STROKE} pt
            </button>
          }
          items={STROKES.map((s) => ({
            id: `fill-sign.stroke.${s}`,
            label: `${s} pt`,
            checked: Math.abs((obj.strokeWidth ?? DEFAULT_MARK_STROKE) - s) < 0.01,
            run: () => update({ strokeWidth: s }, { label: 'Change line thickness' }),
          }))}
        />
      )}
    </div>
  );
}

function pageOf(docId: DocId, obj: FillMarkObject): PageInfo | undefined {
  return getDoc(docId)?.pages.find((p) => p.id === obj.pageId);
}

// ── export ───────────────────────────────────────────────────────────────────

const K = 0.5522847498;

function ellipseOps(cx: number, cy: number, rx: number, ry: number): string {
  const ox = rx * K;
  const oy = ry * K;
  return [
    `${f(cx + rx)} ${f(cy)} m`,
    `${f(cx + rx)} ${f(cy + oy)} ${f(cx + ox)} ${f(cy + ry)} ${f(cx)} ${f(cy + ry)} c`,
    `${f(cx - ox)} ${f(cy + ry)} ${f(cx - rx)} ${f(cy + oy)} ${f(cx - rx)} ${f(cy)} c`,
    `${f(cx - rx)} ${f(cy - oy)} ${f(cx - ox)} ${f(cy - ry)} ${f(cx)} ${f(cy - ry)} c`,
    `${f(cx + ox)} ${f(cy - ry)} ${f(cx + rx)} ${f(cy - oy)} ${f(cx + rx)} ${f(cy)} c`,
    'h',
  ].join('\n');
}

export function markOps(obj: FillMarkObject): string {
  const { mark, rot } = obj.data;
  const { w, h } = uprightSize(obj.rect, rot);
  const color = rgb(obj.color, DEFAULT_MARK_COLOR);
  const out: string[] = [`${color} RG`, `${color} rg`, '1 j'];
  for (const p of markGeometry(mark, w, h, obj.strokeWidth ?? DEFAULT_MARK_STROKE)) {
    if (p.t === 'poly') {
      out.push(`${f(p.sw)} w`, `${p.cap === 'round' ? 1 : 0} J`);
      p.pts.forEach(([x, y], i) => out.push(`${f(x)} ${f(h - y)} ${i === 0 ? 'm' : 'l'}`));
      out.push('S');
    } else {
      out.push(ellipseOps(p.cx, h - p.cy, p.rx, p.ry));
      if (p.fill) out.push('f');
      else out.push(`${f(p.sw)} w`, 'S');
    }
  }
  return out.join('\n');
}

function exportMark(obj: FillMarkObject, ctx: ExportContext) {
  drawLocal(ctx, obj, obj.data.rot, markOps(obj));
}

// ── type ─────────────────────────────────────────────────────────────────────

export const fillMarkType: ObjectTypeDef<FillMarkObject> = {
  kind: FILL_MARK,
  label: 'Symbol',
  icon: Shapes,
  category: 'fill-sign',
  Render: FillMarkRender,
  minSize: { width: 3, height: 3 },
  resize(obj, rect) {
    const { mark, rot } = obj.data;
    const b = uprightSize(obj.rect, rot);
    const p = uprightSize(rect, rot);
    let w = p.w;
    let h = p.h;
    if (markKeepsAspect(mark)) {
      const sameW = Math.abs(p.w - b.w) < 0.05;
      const sameH = Math.abs(p.h - b.h) < 0.05;
      const k = Math.max(3 / Math.min(b.w, b.h), sameH ? p.w / b.w : sameW ? p.h / b.h : Math.max(p.w / b.w, p.h / b.h));
      w = b.w * k;
      h = b.h * k;
    } else if (mark === 'line') {
      h = b.h;
    }
    const swap = rot % 180 !== 0;
    return { rect: anchorRect(obj.rect, rect, swap ? h : w, swap ? w : h) };
  },
  PropertiesBar: FillMarkBar,
  summary: (o) => MARK_LABELS[o.data.mark],
  contextMenu(obj, docId) {
    const page = pageOf(docId, obj);
    return MARK_KINDS.filter((m) => m !== obj.data.mark).map((m) => ({
      id: `fill-sign.mark.to-${m}`,
      label: `Change to ${MARK_LABELS[m].toLowerCase()}`,
      icon: MARK_ICONS[m],
      disabled: !page,
      run: () => {
        if (page) actions.updateObject(docId, obj.id, changeMarkPatch(obj, page, m), { label: 'Change symbol' });
      },
    }));
  },
  exportToPdf: exportMark,
};
