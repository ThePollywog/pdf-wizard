/**
 * Drawing feature data model: object kinds, their `data` payloads and shared constants.
 * All coordinates are PDF user space (pt, y up, unrotated, absolute) like every overlay object.
 */
import type { PdfObject, Point, Rotation } from '@/core/types';
import type { PreservedAppearance } from '@/core/annotations';

export const FEATURE = 'drawing';

export type LineEnding =
  | 'None' | 'OpenArrow' | 'ClosedArrow' | 'Circle' | 'Square' | 'Diamond' | 'Butt' | 'Slash' | 'ROpenArrow' | 'RClosedArrow';

export const LINE_ENDINGS: LineEnding[] = [
  'None', 'OpenArrow', 'ClosedArrow', 'Circle', 'Square', 'Diamond', 'Butt', 'Slash', 'ROpenArrow', 'RClosedArrow',
];

export const LINE_ENDING_LABELS: Record<LineEnding, string> = {
  None: 'None',
  OpenArrow: 'Open arrow',
  ClosedArrow: 'Closed arrow',
  Circle: 'Circle',
  Square: 'Square',
  Diamond: 'Diamond',
  Butt: 'Butt',
  Slash: 'Slash',
  ROpenArrow: 'Reverse open arrow',
  RClosedArrow: 'Reverse closed arrow',
};

export type StrokeStyle = 'solid' | 'dashed' | 'cloudy';

// ── ink ──────────────────────────────────────────────────────────────────────
export interface InkData {
  /** One entry per stroke. */
  paths: Point[][];
  /** Highlighter ink (multiply blend). */
  highlight?: boolean;
  /** Draw strokes as smoothed curves (default true); imported polyline ink keeps straight segments. */
  smooth?: boolean;
}
export type InkObject = PdfObject<'ink', InkData>;

// ── shapes ───────────────────────────────────────────────────────────────────
export type ShapeType = 'rect' | 'ellipse' | 'cloud-rect';
export interface ShapeData {
  type: ShapeType;
  style: StrokeStyle;
  /** Cloudy border intensity (PDF /BE /I), 1 or 2. */
  intensity: number;
}
export type ShapeObject = PdfObject<'shape', ShapeData>;

// ── lines ────────────────────────────────────────────────────────────────────
export interface LineData {
  start: Point;
  end: Point;
  endings: [LineEnding, LineEnding];
  style: 'solid' | 'dashed';
}
export type LineObject = PdfObject<'line', LineData>;

// ── polygons / polylines ─────────────────────────────────────────────────────
export interface PolyData {
  type: 'polyline' | 'polygon';
  vertices: Point[];
  style: StrokeStyle;
  intensity: number;
  /** Polyline endings (PDF /LE). */
  endings?: [LineEnding, LineEnding];
}
export type PolyObject = PdfObject<'poly', PolyData>;

// ── measurements ─────────────────────────────────────────────────────────────
export type DocUnit = 'pt' | 'in' | 'mm' | 'cm';
export type RealUnit = 'in' | 'ft' | 'mm' | 'cm' | 'm';
export const DOC_UNITS: DocUnit[] = ['pt', 'in', 'mm', 'cm'];
export const REAL_UNITS: RealUnit[] = ['in', 'ft', 'mm', 'cm', 'm'];

export interface MeasureScale {
  docValue: number;
  docUnit: DocUnit;
  realValue: number;
  realUnit: RealUnit;
}
export type MeasureType = 'distance' | 'perimeter' | 'area';
export interface MeasureData {
  type: MeasureType;
  points: Point[];
  scale: MeasureScale;
  /** Decimal places. */
  precision: number;
  /** Measured value in real units (area: square real units). */
  value: number;
}
export type MeasureObject = PdfObject<'measure', MeasureData>;

// ── stamps ───────────────────────────────────────────────────────────────────
export type StampSet = 'standard' | 'dynamic' | 'sign' | 'custom' | 'imported';
export type StampShape = 'box' | 'arrow' | 'check' | 'cross';
export interface StampData {
  set: StampSet;
  /** Id within the set (catalog id, or custom stamp id). */
  id: string;
  /** PDF /Name. */
  name: string;
  /** Main text (already upper-cased for text stamps). */
  label: string;
  /** Second line of dynamic stamps: "By <user> at <time>, <date>". */
  subline?: string;
  shape: StampShape;
  /** Raster image of image stamps (data URL) with its pixel size. */
  image?: { src: string; w: number; h: number };
  /** Base64 one-page PDF for vector custom stamps created from a PDF page. */
  pdf?: string;
  /** Page rotation when placed: the stamp is drawn upright in that display orientation. */
  rotation: Rotation;
  /** Original appearance of an imported stamp (exported unchanged, stretched onto rect). */
  preserved?: PreservedAppearance;
}
export type StampObject = PdfObject<'stamp', StampData>;

export type DrawingObject = InkObject | ShapeObject | LineObject | PolyObject | MeasureObject | StampObject;

// ── defaults ─────────────────────────────────────────────────────────────────
export const PEN_DEFAULTS = { color: '#e34850', width: 2, opacity: 1 };
export const HIGHLIGHTER_DEFAULTS = { color: '#ffd426', width: 12, opacity: 0.6 };
export const ERASER_DEFAULTS = { size: 12, mode: 'partial' as 'partial' | 'whole' };
export const SHAPE_DEFAULTS = { color: '#e34850', fill: null as string | null, width: 2, opacity: 1, style: 'solid' as StrokeStyle, intensity: 1 };
export const LINE_DEFAULTS = { color: '#e34850', width: 2, opacity: 1, style: 'solid' as 'solid' | 'dashed', start: 'None' as LineEnding, end: 'None' as LineEnding };
export const ARROW_DEFAULTS = { ...LINE_DEFAULTS, end: 'OpenArrow' as LineEnding };
export const MEASURE_DEFAULTS = {
  color: '#1473e6',
  width: 1,
  opacity: 1,
  docValue: 1,
  docUnit: 'in' as DocUnit,
  realValue: 1,
  realUnit: 'in' as RealUnit,
  precision: 2,
  snap: true,
};

export const STROKE_WIDTHS = [0.5, 1, 2, 3, 4, 6, 8, 12];
export const HIGHLIGHT_WIDTHS = [6, 8, 12, 16, 20, 24];
export const OPACITIES = [1, 0.75, 0.5, 0.25];
export const MEASURE_OPTS_KEY = 'drawing-measure';
