/** Export helpers: paint list → appearance → annotation (or flattened page content). */
import type { AnnotationSpec, ExportContext, PdfObject, Rect } from '@/core/types';
import type { Paint } from './paint';
import { buildAppearance } from './pdfops';
import { pdfText } from './common';

export interface ExportAnnotOptions {
  subtype: string;
  /** /Subj (defaults to the type label). */
  subject?: string;
  extra?: Record<string, unknown>;
  /** /Rect override (defaults to obj.rect). */
  rect?: Rect;
  /** Appearance bbox (defaults to the paint bounds). */
  bbox?: Rect;
  multiply?: boolean;
  noContents?: boolean;
}

export async function exportPaints(obj: PdfObject, ctx: ExportContext, paints: Paint[], o: ExportAnnotOptions): Promise<void> {
  const appearance = await buildAppearance(ctx, paints, { multiply: o.multiply, bbox: o.bbox, opacity: obj.opacity });
  const extra: Record<string, unknown> = { ...(o.extra ?? {}) };
  if (o.subject) extra.Subj = pdfText(o.subject);
  const spec: AnnotationSpec = { subtype: o.subtype, extra, appearance, rect: o.rect, noContents: o.noContents };
  ctx.annots.add(ctx.page(obj.pageId), obj, spec);
}

/** /BS for a stroke style. */
export function borderStyle(width: number, style: 'solid' | 'dashed' | 'cloudy', dash?: number[]): Record<string, unknown> {
  const W = Math.round(Math.max(0, width) * 1000) / 1000;
  if (style === 'dashed') return { Type: 'Border', W, S: 'D', D: (dash ?? [3, 3]).map((v) => Math.round(v * 1000) / 1000) };
  return { Type: 'Border', W, S: 'S' };
}

/** /BE for cloudy borders. */
export const cloudyEffect = (intensity: number) => ({ S: 'C', I: Math.max(0, Math.min(2, Math.round(intensity))) });
