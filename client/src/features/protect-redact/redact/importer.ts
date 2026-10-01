/** Import /Redact annotations (unapplied marks, e.g. saved by us or by another editor) as editable marks. */
import { importedObject, type AnnotationImporter, type AnnotationSource } from '@/core/annotations';
import { quadToRect, unionRects } from '@/core/geometry';
import type { Rect } from '@/core/types';
import {
  DEFAULT_OUTLINE, DEFAULT_OVERLAY, KIND, type OverlayAlign, type OverlayFont, type OverlayProps, type RedactMode, type RedactionData,
  type RedactionObject,
} from './types';

const FONT_OF: Record<string, OverlayFont> = { helv: 'Helvetica', helvetica: 'Helvetica', tiro: 'Times', times: 'Times', cour: 'Courier', courier: 'Courier' };
const ALIGN_OF: OverlayAlign[] = ['left', 'center', 'right'];

function parseDA(da: string | undefined): { font?: OverlayFont; size?: number; color?: string } {
  if (!da) return {};
  const out: { font?: OverlayFont; size?: number; color?: string } = {};
  const tf = /\/([^\s/]+)\s+([\d.]+)\s+Tf/.exec(da);
  if (tf) {
    const key = tf[1].toLowerCase().replace(/[^a-z]/g, '');
    out.font = FONT_OF[key] ?? (key.startsWith('tim') ? 'Times' : key.startsWith('cou') ? 'Courier' : 'Helvetica');
    const n = Number(tf[2]);
    if (Number.isFinite(n) && n > 0) out.size = n;
  }
  const hex = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  const rg = /([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/.exec(da);
  const g = /([\d.]+)\s+g(?![a-z])/.exec(da);
  if (rg) out.color = `#${hex(+rg[1])}${hex(+rg[2])}${hex(+rg[3])}`;
  else if (g) out.color = `#${hex(+g[1]).repeat(3)}`;
  return out;
}

function sanitizeOverlay(raw: unknown): OverlayProps | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<OverlayProps>;
  return {
    useText: !!r.useText,
    text: typeof r.text === 'string' ? r.text : '',
    code: typeof r.code === 'string' ? r.code : '',
    font: r.font === 'Times' || r.font === 'Courier' ? r.font : 'Helvetica',
    fontSize: typeof r.fontSize === 'number' && r.fontSize > 0 ? r.fontSize : DEFAULT_OVERLAY.fontSize,
    autoSize: r.autoSize !== false,
    textColor: typeof r.textColor === 'string' && /^#[0-9a-f]{6}$/i.test(r.textColor) ? r.textColor : DEFAULT_OVERLAY.textColor,
    repeat: !!r.repeat,
    align: r.align === 'left' || r.align === 'right' ? r.align : 'center',
  };
}

function rectsOf(src: AnnotationSource): Rect[] {
  const q = src.nums('QuadPoints');
  const out: Rect[] = [];
  if (q && q.length >= 8) {
    for (let i = 0; i + 8 <= q.length; i += 8) {
      const r = quadToRect(q.slice(i, i + 8));
      if (r.width > 0.1 && r.height > 0.1) out.push(r);
    }
  }
  return out.length ? out : [src.common.rect];
}

export const redactImporter: AnnotationImporter = {
  id: 'protect-redact-redact',
  subtypes: ['Redact'],
  priority: 10,
  import(src) {
    const rects = rectsOf(src);
    let saved: { mode?: RedactMode; text?: string; overlay?: unknown } = {};
    const raw = src.text('AWRedactData');
    if (raw) {
      try {
        saved = JSON.parse(raw) ?? {};
      } catch {
        saved = {};
      }
    }
    const da = parseDA(src.text('DA'));
    const overlayText = src.text('OverlayText') ?? '';
    const q = src.num('Q');
    const overlay: OverlayProps = sanitizeOverlay(saved.overlay) ?? {
      ...DEFAULT_OVERLAY,
      useText: !!overlayText.trim(),
      text: overlayText,
      font: da.font ?? DEFAULT_OVERLAY.font,
      fontSize: da.size ?? DEFAULT_OVERLAY.fontSize,
      autoSize: !da.size,
      textColor: da.color ?? DEFAULT_OVERLAY.textColor,
      repeat: src.get('Repeat')?.toString() === 'true',
      align: ALIGN_OF[q ?? 1] ?? 'center',
    };
    const mode: RedactMode =
      saved.mode === 'page' || saved.mode === 'area' || saved.mode === 'text' ? saved.mode : src.nums('QuadPoints') ? 'text' : 'area';
    const data: RedactionData = { mode, rects, text: typeof saved.text === 'string' && saved.text ? saved.text : undefined, overlay };
    const outline = src.color('OC') ?? src.common.color ?? DEFAULT_OUTLINE;
    return importedObject<RedactionObject>(src, {
      kind: KIND,
      data,
      rect: unionRects(rects),
      color: outline,
      fillColor: src.common.fillColor ?? null,
    });
  },
};
