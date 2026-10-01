/**
 * Importers for existing Ink / Square / Circle / Line / Polygon / PolyLine / Stamp annotations.
 * Measurement annotations (/IT …Dimension or a /Measure dictionary) become measure objects.
 */
import { decodePDFRawStream, PDFArray, PDFDict, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, PDFString, PDFHexString, type PDFObject } from '@cantoo/pdf-lib';
import { importedObject, registerAnnotationImporter, type AnnotationSource } from '@/core/annotations';
import type { Point, Rect } from '@/core/types';
import {
  LINE_ENDINGS, REAL_UNITS,
  type InkObject, type LineEnding, type LineObject, type MeasureData, type MeasureObject, type MeasureScale, type MeasureType, type PolyObject,
  type RealUnit, type ShapeObject, type StampData, type StampObject,
} from './model';
import { inkRect, lineRect, measureRect, polyRect } from './looks';
import { pairs } from './common';
import { DEFAULT_SCALE, measureValue, parseRatio } from './measure/scale';
import { findByName } from './stamps/catalog';
import { titleCase } from './stamps/custom';

// ── low-level helpers ────────────────────────────────────────────────────────

const N = (n: string) => PDFName.of(n);
const deref = (src: AnnotationSource, o: PDFObject | undefined) => (o instanceof PDFRef ? src.lib.context.lookup(o) : o);

function numArray(src: AnnotationSource, o: PDFObject | undefined): number[] | null {
  const a = deref(src, o);
  if (!(a instanceof PDFArray)) return null;
  const out: number[] = [];
  for (let i = 0; i < a.size(); i++) {
    const v = deref(src, a.get(i));
    if (v instanceof PDFNumber) out.push(v.asNumber());
  }
  return out;
}

const nameOf = (v: PDFObject | undefined) => (v instanceof PDFName ? v.decodeText() : undefined);
const textOf = (v: PDFObject | undefined) => (v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : undefined);

function endings(src: AnnotationSource): [LineEnding, LineEnding] {
  const a = deref(src, src.get('LE'));
  const one = (v: PDFObject | undefined): LineEnding => {
    const n = nameOf(deref(src, v));
    return n && (LINE_ENDINGS as string[]).includes(n) ? (n as LineEnding) : 'None';
  };
  if (a instanceof PDFArray) return [one(a.get(0)), one(a.get(1))];
  return ['None', 'None'];
}

/** Cloudy border effect (/BE << /S /C /I n >>). */
function cloudy(src: AnnotationSource): { on: boolean; intensity: number } {
  const be = deref(src, src.get('BE'));
  if (!(be instanceof PDFDict)) return { on: false, intensity: 1 };
  const on = nameOf(deref(src, be.get(N('S')))) === 'C';
  const i = deref(src, be.get(N('I')));
  const intensity = i instanceof PDFNumber ? Math.max(1, Math.min(2, Math.round(i.asNumber()) || 1)) : 1;
  return { on, intensity };
}

/** Normal appearance stream (if any). */
function apStream(src: AnnotationSource): PDFStream | undefined {
  const ap = deref(src, src.get('AP'));
  if (!(ap instanceof PDFDict)) return undefined;
  let n = deref(src, ap.get(N('N')));
  if (n instanceof PDFDict && !(n instanceof PDFStream)) {
    const as = src.name('AS');
    n = as ? deref(src, n.get(N(as))) : undefined;
  }
  return n instanceof PDFStream ? n : undefined;
}

function apContent(src: AnnotationSource, max = 200_000): string {
  const s = apStream(src);
  if (!(s instanceof PDFRawStream)) return '';
  try {
    const bytes = decodePDFRawStream(s).decode();
    let out = '';
    const n = Math.min(bytes.length, max);
    for (let i = 0; i < n; i++) out += String.fromCharCode(bytes[i]);
    return out;
  } catch {
    return '';
  }
}

/** Appearance uses a multiply blend mode (highlighter ink). */
function apMultiply(src: AnnotationSource): boolean {
  const s = apStream(src);
  const res = s ? deref(src, s.dict.get(N('Resources'))) : undefined;
  const gs = res instanceof PDFDict ? deref(src, res.get(N('ExtGState'))) : undefined;
  if (!(gs instanceof PDFDict)) return false;
  for (const [, v] of gs.entries()) {
    const d = deref(src, v);
    if (d instanceof PDFDict && nameOf(deref(src, d.get(N('BM')))) === 'Multiply') return true;
  }
  return false;
}

const isDashed = (src: AnnotationSource) => !!src.common.dash;
/** No /C means "no border" for shapes. */
const hasStroke = (src: AnnotationSource) => !!src.common.color;

// ── measurements ─────────────────────────────────────────────────────────────

interface MeasureInfo {
  scale: MeasureScale;
  precision: number;
}

function numberFormat(src: AnnotationSource, m: PDFDict, key: string): PDFDict | undefined {
  const a = deref(src, m.get(N(key)));
  const f = a instanceof PDFArray ? deref(src, a.get(0)) : undefined;
  return f instanceof PDFDict ? f : undefined;
}

function measureInfo(src: AnnotationSource, type: MeasureType): MeasureInfo | null {
  const m = deref(src, src.get('Measure'));
  const it = src.name('IT');
  const isDim = it === 'LineDimension' || it === 'PolyLineDimension' || it === 'PolygonDimension';
  if (!(m instanceof PDFDict) && !isDim) return null;
  let scale: MeasureScale | null = null;
  let precision = 2;
  if (m instanceof PDFDict) {
    scale = parseRatio(textOf(deref(src, m.get(N('R')))));
    const x = numberFormat(src, m, 'X');
    const fmt = numberFormat(src, m, type === 'area' ? 'A' : 'D') ?? numberFormat(src, m, 'D');
    if (!scale && x) {
      const c = deref(src, x.get(N('C')));
      const u = textOf(deref(src, x.get(N('U'))))?.trim().toLowerCase();
      if (c instanceof PDFNumber && c.asNumber() > 0 && u && (REAL_UNITS as string[]).includes(u))
        scale = { docValue: 1, docUnit: 'pt', realValue: c.asNumber(), realUnit: u as RealUnit };
    }
    const d = fmt ? deref(src, fmt.get(N('D'))) : undefined;
    if (d instanceof PDFNumber && d.asNumber() >= 1) precision = Math.max(0, Math.min(4, Math.round(Math.log10(d.asNumber()))));
  }
  return { scale: scale ?? DEFAULT_SCALE, precision };
}

/** /Contents of a measurement starts with the value line; keep only the user's comment. */
function stripValue(contents: string | undefined): string | undefined {
  if (!contents) return undefined;
  const lines = contents.split(/\r\n|\r|\n/);
  if (/^\s*[-\d.,]+\s*(sq\s+)?[a-z]{1,3}\s*$/i.test(lines[0] ?? '')) lines.shift();
  const rest = lines.join('\n').trim();
  return rest || undefined;
}

function measureObject(src: AnnotationSource, type: MeasureType, points: Point[], info: MeasureInfo): MeasureObject {
  const data: MeasureData = { type, points, scale: info.scale, precision: info.precision, value: measureValue(type, points, info.scale) };
  const w = src.common.strokeWidth || 1;
  return importedObject<MeasureObject>(src, {
    kind: 'measure',
    data,
    rect: measureRect(data, w),
    strokeWidth: w,
    color: src.common.color ?? '#1473e6',
    fillColor: null,
    contents: stripValue(src.common.contents),
  });
}

// ── importers ────────────────────────────────────────────────────────────────

function importInk(src: AnnotationSource): InkObject | null {
  const list = deref(src, src.get('InkList'));
  if (!(list instanceof PDFArray)) return null;
  const paths: Point[][] = [];
  for (let i = 0; i < list.size(); i++) {
    const pts = pairs(numArray(src, list.get(i)) ?? undefined);
    if (pts.length) paths.push(pts.length === 1 ? [pts[0], { x: pts[0].x + 0.01, y: pts[0].y }] : pts);
  }
  if (!paths.length) return null;
  const ap = apContent(src);
  const smooth = !ap || /\sc\s/.test(ap) || /\s[vy]\s/.test(ap);
  const highlight = apMultiply(src) || /highlighter/i.test(src.common.subject ?? '');
  const w = src.common.strokeWidth || 1;
  return importedObject<InkObject>(src, {
    kind: 'ink',
    data: { paths, highlight: highlight || undefined, smooth: smooth ? undefined : false },
    rect: inkRect(paths, w),
    strokeWidth: w,
    color: src.common.color ?? '#000000',
    fillColor: null,
  });
}

function importShape(src: AnnotationSource): ShapeObject | null {
  const r = src.common.rect;
  if (r.width <= 0 || r.height <= 0) return null;
  const c = cloudy(src);
  const ellipse = src.subtype === 'Circle';
  const rd = src.nums('RD');
  let rect: Rect = r;
  if (!c.on && rd && rd.length === 4) {
    const inner = { x: r.x + rd[0], y: r.y + rd[1], width: r.width - rd[0] - rd[2], height: r.height - rd[1] - rd[3] };
    if (inner.width > 0 && inner.height > 0) rect = inner;
  }
  const stroke = hasStroke(src);
  return importedObject<ShapeObject>(src, {
    kind: 'shape',
    data: {
      type: ellipse ? 'ellipse' : c.on ? 'cloud-rect' : 'rect',
      style: c.on ? 'cloudy' : isDashed(src) ? 'dashed' : 'solid',
      intensity: c.intensity,
    },
    rect,
    color: src.common.color ?? '#000000',
    strokeWidth: stroke ? src.common.strokeWidth : 0,
    fillColor: src.common.fillColor ?? null,
  });
}

function importLine(src: AnnotationSource): LineObject | MeasureObject | null {
  const l = src.nums('L');
  if (!l || l.length < 4) return null;
  const start = { x: l[0], y: l[1] }, end = { x: l[2], y: l[3] };
  const info = measureInfo(src, 'distance');
  if (info) return measureObject(src, 'distance', [start, end], info);
  const w = src.common.strokeWidth || 1;
  const data = { start, end, endings: endings(src), style: isDashed(src) ? ('dashed' as const) : ('solid' as const) };
  return importedObject<LineObject>(src, {
    kind: 'line',
    data,
    rect: lineRect(data, w),
    strokeWidth: w,
    color: src.common.color ?? '#000000',
    fillColor: src.common.fillColor ?? null,
  });
}

function importPoly(src: AnnotationSource): PolyObject | MeasureObject | null {
  const vertices = pairs(src.nums('Vertices'));
  const polygon = src.subtype === 'Polygon';
  if (vertices.length < (polygon ? 3 : 2)) return null;
  const info = measureInfo(src, polygon ? 'area' : 'perimeter');
  if (info) return measureObject(src, polygon ? 'area' : 'perimeter', vertices, info);
  const c = cloudy(src);
  const w = src.common.strokeWidth || 1;
  const data = polygon
    ? { type: 'polygon' as const, vertices, style: c.on ? ('cloudy' as const) : isDashed(src) ? ('dashed' as const) : ('solid' as const), intensity: c.intensity }
    : { type: 'polyline' as const, vertices, style: isDashed(src) ? ('dashed' as const) : ('solid' as const), intensity: 1, endings: endings(src) };
  return importedObject<PolyObject>(src, {
    kind: 'poly',
    data,
    rect: polyRect(data, w),
    strokeWidth: w,
    color: src.common.color ?? '#000000',
    fillColor: polygon ? (src.common.fillColor ?? null) : null,
  });
}

async function importStamp(src: AnnotationSource): Promise<StampObject | null> {
  const r = src.common.rect;
  if (r.width <= 0 || r.height <= 0) return null;
  const name = src.name('Name') ?? 'Draft';
  const cat = findByName(name);
  const preserved = (await src.preserveAppearance()) ?? undefined;
  const subject = src.common.subject && !/^stamp$/i.test(src.common.subject.trim()) ? src.common.subject.trim() : undefined;
  const derived = name.replace(/^SB|^SH|^D(?=[A-Z])/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
  // Preserved stamps only use the label as their title (kept as the original /Subj); drawn ones print it.
  const label = preserved ? (subject ?? (cat ? titleCase(cat.label) : derived)) : cat ? cat.label : (subject ?? derived).toUpperCase();
  const data: StampData = preserved
    ? { set: 'imported', id: name, name, label, shape: cat?.shape ?? 'box', rotation: 0, preserved }
    : cat
      ? { set: cat.set, id: cat.id, name: cat.name, label: cat.label, shape: cat.shape, rotation: 0 }
      : { set: 'imported', id: name, name, label, shape: 'box', rotation: 0 };
  return importedObject<StampObject>(src, {
    kind: 'stamp',
    data,
    rect: r,
    fillColor: null,
    strokeWidth: undefined,
  });
}

export function registerImporters() {
  const guard =
    <T>(fn: (src: AnnotationSource) => T) =>
    (src: AnnotationSource) =>
      src.common.hidden ? null : fn(src);
  registerAnnotationImporter({ id: 'drawing-ink', subtypes: ['Ink'], import: guard(importInk) });
  registerAnnotationImporter({ id: 'drawing-shape', subtypes: ['Square', 'Circle'], import: guard(importShape) });
  registerAnnotationImporter({ id: 'drawing-line', subtypes: ['Line'], import: guard(importLine) });
  registerAnnotationImporter({ id: 'drawing-poly', subtypes: ['Polygon', 'PolyLine'], import: guard(importPoly) });
  registerAnnotationImporter({ id: 'drawing-stamp', subtypes: ['Stamp'], import: guard(importStamp) });
}
