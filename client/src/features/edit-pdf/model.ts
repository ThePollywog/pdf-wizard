/**
 * Edit PDF — shared ids, object shapes and defaults.
 */
import type { PageId, PdfObject, Rotation } from '@/core/types';
import type { TextStyle } from './content/blocks';
import type { LinkAppearance } from './content/links';
import type { Matrix } from './content/matrix';

export const FEATURE = 'edit-pdf';

export const TOOL_CONTENT = 'edit-content';
export const TOOL_TEXT = 'edit-add-text';
export const TOOL_IMAGE = 'edit-add-image';
export const TOOL_LINK = 'edit-link';
export const EDIT_TOOLS = [TOOL_CONTENT, TOOL_TEXT, TOOL_IMAGE, TOOL_LINK] as const;
export type EditToolId = (typeof EDIT_TOOLS)[number];
export const isEditTool = (id: string): id is EditToolId => (EDIT_TOOLS as readonly string[]).includes(id);

export const KIND_TEXT = 'content-text';
export const KIND_IMAGE = 'content-image';
export const KIND_LINK = 'link';

export type { TextStyle, LinkAppearance, Matrix };

export interface ContentTextData {
  text: string;
  style: TextStyle;
  /** Page /Rotate when the text was created: the text reads upright for that rotation. */
  rotation: Rotation;
  /** Width follows the text (created by a click) instead of wrapping at the box width. */
  autoWidth?: boolean;
}
export type ContentTextObject = PdfObject<'content-text', ContentTextData>;

export interface ContentImageData {
  /** data: URL of the PNG / JPEG. */
  src: string;
  mime: 'image/png' | 'image/jpeg';
  pxWidth: number;
  pxHeight: number;
  /** Unit square → user space (whole image). */
  matrix: Matrix;
  /** Visible part in unit coordinates [x0, y0, x1, y1]. */
  clip: [number, number, number, number];
}
export type ContentImageObject = PdfObject<'content-image', ContentImageData>;

export type LinkAction =
  | { type: 'url'; url: string }
  | { type: 'page'; pageId: PageId; left: number | null; top: number | null; zoom: number | null };

export interface LinkData {
  action: LinkAction;
  appearance: LinkAppearance;
}
export type LinkObject = PdfObject<'link', LinkData>;

export const FAMILIES = [
  { value: 'sans', label: 'Helvetica (Arial)' },
  { value: 'serif', label: 'Times New Roman' },
  { value: 'mono', label: 'Courier New' },
] as const;

export const DEFAULT_TEXT_STYLE: TextStyle = {
  family: 'sans',
  bold: false,
  italic: false,
  underline: false,
  size: 12,
  color: '#000000',
  lineHeight: 14.4,
  charSpacing: 0,
  align: 'left',
};

/** Tool options of edit-add-text (defaults for new text). */
export interface TextDefaults extends Record<string, unknown> {
  family: TextStyle['family'];
  size: number;
  color: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  align: TextStyle['align'];
  lineSpacing: number;
  charSpacing: number;
}

export const TEXT_DEFAULTS: TextDefaults = {
  family: 'sans',
  size: 12,
  color: '#000000',
  bold: false,
  italic: false,
  underline: false,
  align: 'left',
  lineSpacing: 1.2,
  charSpacing: 0,
};

export function styleFromDefaults(d: TextDefaults): TextStyle {
  return {
    family: d.family,
    bold: d.bold,
    italic: d.italic,
    underline: d.underline,
    size: d.size,
    color: d.color,
    lineHeight: round2(d.size * d.lineSpacing),
    charSpacing: d.charSpacing,
    align: d.align,
  };
}

export const round2 = (v: number) => Math.round(v * 100) / 100;

/** Line spacing as a multiple of the font size. */
export const lineSpacingOf = (s: TextStyle) => (s.size > 0 ? round2(s.lineHeight / s.size) : 1.2);

/** Tool options of edit-content. */
export interface ContentOptions extends Record<string, unknown> {
  /** Outline every editable text block and image (not only the one under the pointer). */
  showBoxes: boolean;
}
export const CONTENT_DEFAULTS: ContentOptions = { showBoxes: true };
