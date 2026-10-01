/** The 'redaction' overlay object: a mark that is removed permanently when redactions are applied. */
import { useId, useMemo } from 'react';
import { PDFBool, PDFHexString, PDFString } from '@cantoo/pdf-lib';
import { CheckCheck, Copy, EyeOff, Settings2, SquareDashed, Trash2, Type } from 'lucide-react';
import { mapPoint, rectToQuad, rectToView, translateRect, unionRects } from '@/core/geometry';
import type { ExportContext, MenuItem, ObjectRenderProps, ObjectTypeDef, Rect } from '@/core/types';
import { ColorSwatchButton, Dropdown, IconButton, type MenuEntry } from '@/core/ui';
import { hexToRgb01 } from '@/core/util';
import { applyRedactions } from './apply';
import { clearAllMarks } from './marks';
import { colorOps, encodeStd, fmt, layoutOverlay, overlayOps, rectOps, stdFontName } from './overlay';
import { openRepeatDialog } from './pagesDialog';
import { openPropertiesDialog } from './PropertiesDialog';
import {
  CODE_SETS, CSS_FONT, DEFAULT_OUTLINE, KIND, overlayText, type OverlayFont, type OverlayProps, type RedactionObject,
} from './types';
import { useRedactUi } from './uiStore';

// ── on-screen rendering ─────────────────────────────────────────────────────

type Mat = [number, number, number, number, number, number];

function RedactionRender({ obj, viewport, box, toLocal, selected, page }: ObjectRenderProps<RedactionObject>) {
  const hovered = useRedactUi((s) => s.hoverId === obj.id);
  const clipBase = useId().replace(/:/g, '');
  const outline = obj.color || DEFAULT_OUTLINE;
  const fill = obj.fillColor ?? null;
  const rects = obj.data.rects.length ? obj.data.rects : [obj.rect];
  const local = useMemo(
    () =>
      rects.map((r) => {
        const b = rectToView(viewport, r);
        return { x: b.left - box.left, y: b.top - box.top, w: b.width, h: b.height };
      }),
    [rects, viewport, box],
  );
  const texts = useMemo(() => {
    const out: { key: string; clip: number; font: OverlayFont; color: string; size: number; text: string; m: Mat }[] = [];
    rects.forEach((r, i) => {
      const lay = layoutOverlay(obj.data.overlay, r, page.rotation);
      if (!lay) return;
      lay.runs.forEach((run, j) => {
        const [a, b, c, d, e, f] = run.matrix;
        const o = toLocal({ x: e, y: f });
        const X = toLocal({ x: e + a, y: f + b });
        const Y = toLocal({ x: e + c, y: f + d });
        out.push({
          key: `${i}-${j}`,
          clip: i,
          font: lay.font,
          color: lay.color,
          size: run.size,
          text: run.text,
          m: [X.x - o.x, X.y - o.y, -(Y.x - o.x), -(Y.y - o.y), o.x, o.y],
        });
      });
    });
    return out;
  }, [rects, obj.data.overlay, page.rotation, toLocal]);

  return (
    <svg
      className={`protect-redact-mark${hovered ? ' is-hover' : ''}${selected ? ' is-selected' : ''}${obj.data.mode === 'page' ? ' is-page' : ''}`}
      width={Math.max(1, box.width)}
      height={Math.max(1, box.height)}
      data-testid="protect-redact-mark"
      data-mark-id={obj.id}
      data-mode={obj.data.mode}
      aria-label={`Redaction mark${obj.data.text ? `: ${obj.data.text}` : ''}`}
    >
      <defs>
        {local.map((b, i) => (
          <clipPath key={i} id={`${clipBase}-${i}`}>
            <rect x={b.x} y={b.y} width={b.w} height={b.h} />
          </clipPath>
        ))}
      </defs>
      <g className="protect-redact-mark-preview" data-testid="protect-redact-mark-preview">
        {local.map((b, i) => (
          <rect key={i} x={b.x} y={b.y} width={b.w} height={b.h} fill={fill ?? '#ffffff'} className={fill ? undefined : 'is-nofill'} />
        ))}
        {texts.map((t) => (
          <g key={t.key} clipPath={`url(#${clipBase}-${t.clip})`}>
            <text
              transform={`matrix(${t.m.map((n) => Number(n.toFixed(4))).join(' ')})`}
              x={0}
              y={0}
              fontSize={t.size}
              fontFamily={CSS_FONT[t.font]}
              fill={t.color}
              style={{ whiteSpace: 'pre' }}
            >
              {t.text}
            </text>
          </g>
        ))}
      </g>
      <g className="protect-redact-mark-outline">
        {local.map((b, i) => (
          <rect key={i} x={b.x + 0.75} y={b.y + 0.75} width={Math.max(0, b.w - 1.5)} height={Math.max(0, b.h - 1.5)} stroke={outline} />
        ))}
      </g>
    </svg>
  );
}

// ── floating properties bar ─────────────────────────────────────────────────

export function codeMenu(current: string, onPick: (code: string) => void): MenuEntry[] {
  const entries: MenuEntry[] = [
    { id: 'protect-redact-code-none', label: 'No code', checked: !current, run: () => onPick('') },
    'divider',
  ];
  for (const set of CODE_SETS) {
    entries.push({
      id: `protect-redact-codeset-${set.id}`,
      label: set.label,
      submenu: set.codes.map((c) => ({
        id: `protect-redact-code-${set.id}-${c.code}`,
        label: c.code,
        description: c.description,
        checked: current === c.code,
        run: () => onPick(c.code),
      })),
    });
  }
  return entries;
}

function RedactionBar({ obj, docId, update }: { obj: RedactionObject; docId: string; update(patch: Partial<RedactionObject>, opts?: { label?: string; coalesce?: string }): void }) {
  const o = obj.data.overlay;
  const setOverlay = (patch: Partial<OverlayProps>, label: string) =>
    update({ data: { ...obj.data, overlay: { ...o, ...patch } } }, { label });
  return (
    <div className="protect-redact-bar" data-testid="protect-redact-bar">
      <span className="protect-redact-bar-swatch" data-testid="protect-redact-bar-fill">
        <ColorSwatchButton size="sm" label="Redacted area fill color" allowNone value={obj.fillColor ?? null} onChange={(hex) => update({ fillColor: hex }, { label: 'Change fill color' })} />
      </span>
      <span className="protect-redact-bar-swatch" data-testid="protect-redact-bar-outline">
        <ColorSwatchButton size="sm" label="Mark outline color" value={obj.color ?? DEFAULT_OUTLINE} onChange={(hex) => hex && update({ color: hex }, { label: 'Change outline color' })} />
      </span>
      <IconButton
        size="sm"
        icon={Type}
        label={o.useText ? 'Overlay text: on' : 'Overlay text: off'}
        active={o.useText}
        onClick={() => setOverlay({ useText: !o.useText }, 'Toggle overlay text')}
        data-testid="protect-redact-bar-overlay"
      />
      <Dropdown
        label="Redaction code"
        items={() => codeMenu(o.code, (code) => setOverlay({ code, useText: code ? true : o.useText }, 'Set redaction code'))}
        trigger={
          <button type="button" className="pdfwizard-props-chip protect-redact-bar-code" title="Redaction code" aria-label="Redaction code" data-testid="protect-redact-bar-code">
            <span>{o.code || 'Code'}</span>
          </button>
        }
      />
      <IconButton size="sm" icon={Settings2} label="Redaction properties…" onClick={() => void openPropertiesDialog(docId, [obj.id])} data-testid="protect-redact-bar-properties" />
      <IconButton size="sm" icon={CheckCheck} label="Apply this redaction" onClick={() => void applyRedactions(docId, [obj.id])} data-testid="protect-redact-bar-apply" />
    </div>
  );
}

// ── PDF export (/Redact annotation, when not yet applied) ─────────────────────

const DA_FONT: Record<OverlayFont, string> = { Helvetica: 'Helv', Times: 'TiRo', Courier: 'Cour' };
const Q_OF: Record<OverlayProps['align'], number> = { left: 0, center: 1, right: 2 };

async function exportRedaction(obj: RedactionObject, ctx: ExportContext) {
  const { options } = ctx;
  // Unapplied marks never print and are not baked into page content.
  if (options.purpose === 'print' || options.purpose === 'bake' || options.flatten) return;
  const page = ctx.page(obj.pageId);
  const info = ctx.pageInfo(obj.pageId);
  const pdf = ctx.pdfDoc.context;
  const rects = obj.data.rects.length ? obj.data.rects : [obj.rect];
  const outline = obj.color || DEFAULT_OUTLINE;
  const o = obj.data.overlay;
  const text = overlayText(o);
  const extra: Record<string, unknown> = {
    QuadPoints: rects.flatMap((r) => rectToQuad(r).map((n) => Number(n.toFixed(3)))),
    OC: hexToRgb01(outline).map((n) => Number(n.toFixed(4))),
    Q: Q_OF[o.align] ?? 1,
    DA: PDFString.of(`/${DA_FONT[o.font] ?? 'Helv'} ${fmt(o.autoSize ? 0 : o.fontSize)} Tf ${colorOps(o.textColor || '#ff0000')}`),
    AWRedactData: PDFHexString.fromText(JSON.stringify({ v: 1, mode: obj.data.mode, text: obj.data.text ?? '', overlay: o })),
  };
  if (text) {
    extra.OverlayText = PDFHexString.fromText(text);
    extra.Repeat = o.repeat ? PDFBool.True : PDFBool.False;
  }
  // Overlay appearance (what the area looks like once applied), shown by viewers that support /RO.
  const font = await ctx.standardFont(stdFontName(o.font));
  const roOps: string[] = [];
  if (obj.fillColor) roOps.push(colorOps(obj.fillColor), ...rects.map((r) => `${rectOps(r)} f`));
  for (const r of rects) {
    const lay = layoutOverlay(o, r, info.rotation);
    if (lay) roOps.push(overlayOps(lay, 'F0', (s) => encodeStd(o.font, s)));
  }
  const bbox = unionRects(rects);
  const roRes = pdf.obj({ Font: { F0: font.ref } });
  const ro = pdf.register(
    pdf.flateStream(roOps.join('\n'), {
      Type: 'XObject',
      Subtype: 'Form',
      BBox: [bbox.x, bbox.y, bbox.x + bbox.width, bbox.y + bbox.height].map((n) => Number(n.toFixed(3))),
      Resources: roRes,
    }),
  );
  extra.RO = ro;
  ctx.annots.add(page, obj, {
    subtype: 'Redact',
    extra,
    rect: bbox,
    appearance: {
      ops: ['q', colorOps(outline, false), '1 w', ...rects.map((r) => `${rectOps({ x: r.x + 0.5, y: r.y + 0.5, width: Math.max(0, r.width - 1), height: Math.max(0, r.height - 1) })} S`), 'Q'].join('\n'),
      bbox,
    },
  });
}

// ── type definition ─────────────────────────────────────────────────────────

function scaleRects(rects: Rect[], from: Rect, to: Rect): Rect[] {
  return rects.map((r) => {
    const a = mapPoint({ x: r.x, y: r.y }, from, to);
    const b = mapPoint({ x: r.x + r.width, y: r.y + r.height }, from, to);
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
  });
}

function contextMenu(obj: RedactionObject, docId: string): MenuItem[] {
  const items: MenuItem[] = [
    { id: 'protect-redact-ctx-apply', label: 'Apply redaction', icon: EyeOff, run: () => void applyRedactions(docId, [obj.id]) },
    { id: 'protect-redact-ctx-apply-all', label: 'Apply all redactions', icon: CheckCheck, run: () => void applyRedactions(docId) },
    { id: 'protect-redact-ctx-properties', label: 'Properties…', icon: Settings2, run: () => void openPropertiesDialog(docId, [obj.id]) },
  ];
  if (obj.data.mode !== 'text') {
    items.push({ id: 'protect-redact-ctx-repeat', label: 'Repeat mark across pages…', icon: Copy, run: () => void openRepeatDialog(docId, obj.id) });
  }
  items.push({ id: 'protect-redact-ctx-clear', label: 'Clear all marks', icon: Trash2, danger: true, run: () => void clearAllMarks(docId) });
  return items;
}

export const redactionType: ObjectTypeDef<RedactionObject> = {
  kind: KIND,
  label: 'Redaction',
  icon: SquareDashed,
  category: 'redaction',
  Render: RedactionRender,
  hit: 'shape',
  movable: true,
  resizable: true,
  minSize: { width: 2, height: 2 },
  translate(obj, dx, dy) {
    if (obj.data.mode === 'page') return {};
    return { rect: translateRect(obj.rect, dx, dy), data: { ...obj.data, rects: obj.data.rects.map((r) => translateRect(r, dx, dy)) } };
  },
  resize(obj, rect) {
    if (obj.data.mode === 'page') return {};
    return { rect, data: { ...obj.data, rects: scaleRects(obj.data.rects, obj.rect, rect) } };
  },
  PropertiesBar: RedactionBar,
  summary(obj) {
    if (obj.data.mode === 'page') return 'Whole page';
    if (obj.data.text) return obj.data.text;
    return 'Area';
  },
  contextMenu,
  exportToPdf: exportRedaction,
};
