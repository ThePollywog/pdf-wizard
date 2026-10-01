/**
 * Redaction marks ('redaction' overlay objects) and their overlay properties.
 *
 *   obj.color      mark outline color (default red)
 *   obj.fillColor  redacted-area fill color (default black; null = no fill, content is still removed)
 *   data.rects     areas to remove, PDF user space (one per text line for text marks)
 */
import type { PdfObject, Rect } from '@/core/types';

export type RedactMode = 'text' | 'area' | 'page';
export type OverlayFont = 'Helvetica' | 'Times' | 'Courier';
export type OverlayAlign = 'left' | 'center' | 'right';

export interface OverlayProps {
  /** Draw overlay text on the redacted area. */
  useText: boolean;
  /** Custom overlay text (used when `code` is empty). */
  text: string;
  /** Redaction code, e.g. "(b)(6)"; takes precedence over `text`. */
  code: string;
  font: OverlayFont;
  fontSize: number;
  autoSize: boolean;
  textColor: string;
  repeat: boolean;
  align: OverlayAlign;
}

export interface RedactionData {
  mode: RedactMode;
  rects: Rect[];
  /** Text under a text mark (for the marks list). */
  text?: string;
  overlay: OverlayProps;
}

export type RedactionObject = PdfObject<'redaction', RedactionData>;

export const KIND = 'redaction';
/** Marked-content tag around the invisible (searchable) text written on redacted pages. */
export const INVISIBLE_TEXT_TAG = 'AcroWebText';
export const MARK_TOOL = 'redact-mark';
export const PAGES_TOOL = 'redact-pages';

export const DEFAULT_OUTLINE = '#e0301e';
export const DEFAULT_FILL = '#000000';

export const DEFAULT_OVERLAY: OverlayProps = {
  useText: false,
  text: '',
  code: '',
  font: 'Helvetica',
  fontSize: 10,
  autoSize: true,
  textColor: '#ff0000',
  repeat: false,
  align: 'center',
};

/** Defaults for new marks (stored as the redact-mark tool options, so they persist). */
export interface MarkDefaults extends Record<string, unknown> {
  fillColor: string | null;
  outlineColor: string;
  overlay: OverlayProps;
}

export const MARK_DEFAULTS: MarkDefaults = {
  fillColor: DEFAULT_FILL,
  outlineColor: DEFAULT_OUTLINE,
  overlay: DEFAULT_OVERLAY,
};

export function overlayText(o: OverlayProps): string {
  if (!o.useText) return '';
  return (o.code || o.text || '').trim();
}

export interface CodeSet {
  id: string;
  label: string;
  codes: { code: string; description: string }[];
}

export const CODE_SETS: CodeSet[] = [
  {
    id: 'foia',
    label: 'U.S. FOIA',
    codes: [
      { code: '(b)(1)(A)', description: 'Classified national defense or foreign policy information' },
      { code: '(b)(1)(B)', description: 'Classified information properly classified under an executive order' },
      { code: '(b)(2)', description: 'Internal personnel rules and practices' },
      { code: '(b)(3)(A)', description: 'Exempted by statute (withholding required)' },
      { code: '(b)(3)(B)', description: 'Exempted by statute (criteria for withholding)' },
      { code: '(b)(4)', description: 'Trade secrets and confidential commercial information' },
      { code: '(b)(5)', description: 'Privileged inter- or intra-agency memoranda' },
      { code: '(b)(6)', description: 'Personal privacy' },
      { code: '(b)(7)(A)', description: 'Law enforcement: interference with proceedings' },
      { code: '(b)(7)(B)', description: 'Law enforcement: right to a fair trial' },
      { code: '(b)(7)(C)', description: 'Law enforcement: personal privacy' },
      { code: '(b)(7)(D)', description: 'Law enforcement: confidential source' },
      { code: '(b)(7)(E)', description: 'Law enforcement: techniques and procedures' },
      { code: '(b)(7)(F)', description: 'Law enforcement: life or physical safety' },
      { code: '(b)(8)', description: 'Financial institution examination reports' },
      { code: '(b)(9)', description: 'Geological information on wells' },
    ],
  },
  {
    id: 'privacy',
    label: 'U.S. Privacy Act',
    codes: [
      { code: '(d)(5)', description: 'Information compiled in anticipation of a civil action' },
      { code: '(j)(1)', description: 'Central Intelligence Agency records' },
      { code: '(j)(2)', description: 'Criminal law enforcement records' },
      { code: '(k)(1)', description: 'Classified material' },
      { code: '(k)(2)', description: 'Investigatory material for law enforcement' },
      { code: '(k)(3)', description: 'Protective services records' },
      { code: '(k)(4)', description: 'Statistical records' },
      { code: '(k)(5)', description: 'Investigatory material for employment suitability' },
      { code: '(k)(6)', description: 'Testing or examination material' },
      { code: '(k)(7)', description: 'Armed services promotion evaluation material' },
    ],
  },
];

export const FONT_OPTIONS: { value: OverlayFont; label: string }[] = [
  { value: 'Helvetica', label: 'Helvetica' },
  { value: 'Times', label: 'Times' },
  { value: 'Courier', label: 'Courier' },
];

export const CSS_FONT: Record<OverlayFont, string> = {
  Helvetica: 'Helvetica, Arial, sans-serif',
  Times: '"Times New Roman", Times, serif',
  Courier: '"Courier New", Courier, monospace',
};

export function isRedaction(o: PdfObject | undefined | null): o is RedactionObject {
  return !!o && o.kind === KIND;
}
