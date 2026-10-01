/**
 * Comments feature — data model, defaults and small shared helpers.
 *
 * All coordinates are PDF user space (see core/types.ts). Object kinds owned here:
 *   note            sticky note (PDF Text annotation)
 *   text-markup     highlight / underline / strikeout / squiggly (+ area highlight)
 *   caret           insert text (Caret) and replace text (Caret + grouped StrikeOut)
 *   freetext        text box and callout (FreeText)
 *   file-attachment attached file (FileAttachment with an embedded file)
 */
import { create } from 'zustand';
import type { DocId, ObjectTypeDef, PdfObject, Point, Rect, ReviewStatus, Rotation } from '@/core/types';
import { reg } from '@/core/registry';
import { actions, getDoc } from '@/core/store';
import * as engine from '@/core/engine';
import type { PreservedAppearance } from '@/core/annotations';
import { assetUrl } from '@/core/util';

// ── kinds ────────────────────────────────────────────────────────────────────

export type NoteIcon = 'Comment' | 'Key' | 'Note' | 'Help' | 'NewParagraph' | 'Paragraph' | 'Insert';
export const NOTE_ICONS: { value: NoteIcon; label: string }[] = [
  { value: 'Comment', label: 'Comment' },
  { value: 'Key', label: 'Key' },
  { value: 'Note', label: 'Note' },
  { value: 'Help', label: 'Help' },
  { value: 'NewParagraph', label: 'New paragraph' },
  { value: 'Paragraph', label: 'Paragraph' },
  { value: 'Insert', label: 'Insert' },
];
export interface NoteData {
  icon: NoteIcon;
  /** Unused: sticky notes are NoRotate (always upright). Kept for objects created by older builds. */
  rotate?: Rotation;
}
export type NoteObject = PdfObject<'note', NoteData>;

export type MarkupType = 'highlight' | 'underline' | 'strikeout' | 'squiggly';
export interface MarkupData {
  type: MarkupType;
  /** PDF QuadPoints: 8 numbers per quad, TL TR BL BR (relative to the text direction). */
  quads: number[];
  /** Marked-up text ('' for an area highlight). */
  text: string;
  /** Imported without the text: filled in from the page text once the page is loaded. */
  textPending?: boolean;
}
export type MarkupObject = PdfObject<'text-markup', MarkupData>;

export type TextDir = 0 | 90 | 180 | 270;
export interface CaretData {
  /** Rect of the caret symbol. */
  caret: Rect;
  /** Direction of the text the caret points into (0 = normal horizontal text). */
  dir?: TextDir;
  /** Replace text: the struck-out text (exported as a StrikeOut grouped with the Caret). */
  strike?: { quads: number[]; text: string; textPending?: boolean };
  /** /Sy P (new paragraph) or none. */
  symbol?: 'P' | 'None';
}
export type CaretObject = PdfObject<'caret', CaretData>;

export type FontFamily = 'Helvetica' | 'Times' | 'Courier';
export type TextAlign = 'left' | 'center' | 'right';
export type FreeTextIntent = 'FreeText' | 'FreeTextCallout' | 'FreeTextTypeWriter';
export interface Callout {
  /** Box holding the text. */
  box: Rect;
  /** Leader line: [anchor (arrow end), knee, attach point on the box]. */
  points: Point[];
}
export interface FreeTextData {
  text: string;
  font: FontFamily;
  fontSize: number;
  textColor: string;
  align: TextAlign;
  intent: FreeTextIntent;
  /** Counter-clockwise rotation of the text in user space (the page /Rotate at creation). */
  rotate?: Rotation;
  /** Width follows the text (click-created boxes) until the user resizes it. */
  autoWidth?: boolean;
  /** Frame height set by the user (drag / resize); the box never gets shorter than this. */
  minHeight?: number;
  callout?: Callout;
  /** Line ending at the callout anchor. */
  lineEnding?: 'OpenArrow' | 'ClosedArrow' | 'Circle' | 'Square' | 'None';
  /** Original appearance of an imported annotation, reused while `sig` still matches. */
  preserved?: { ap: PreservedAppearance; sig: string };
}
export type FreeTextObject = PdfObject<'freetext', FreeTextData>;

export type AttachIcon = 'PushPin' | 'Paperclip' | 'Graph' | 'Tag';
export const ATTACH_ICONS: { value: AttachIcon; label: string }[] = [
  { value: 'PushPin', label: 'Push pin' },
  { value: 'Paperclip', label: 'Paperclip' },
  { value: 'Graph', label: 'Graph' },
  { value: 'Tag', label: 'Tag' },
];
export interface AttachmentData {
  fileName: string;
  mimeType: string;
  size: number;
  bytes: Uint8Array;
  description?: string;
  icon?: AttachIcon;
  rotate?: Rotation;
  /** File modification date (epoch ms). */
  fileModified?: number;
}
export type AttachmentObject = PdfObject<'file-attachment', AttachmentData>;

export const KINDS = ['note', 'text-markup', 'caret', 'freetext', 'file-attachment'] as const;

// ── tools / defaults ─────────────────────────────────────────────────────────

export const TOOL = {
  note: 'comment-note',
  highlight: 'comment-highlight',
  underline: 'comment-underline',
  strikeout: 'comment-strikeout',
  squiggly: 'comment-squiggly',
  insert: 'comment-insert-text',
  replace: 'comment-replace-text',
  textbox: 'comment-textbox',
  callout: 'comment-callout',
  attach: 'comment-attach',
} as const;

export const MARKUP_TOOL: Record<MarkupType, string> = {
  highlight: TOOL.highlight,
  underline: TOOL.underline,
  strikeout: TOOL.strikeout,
  squiggly: TOOL.squiggly,
};

export const MARKUP_LABEL: Record<MarkupType, string> = {
  highlight: 'Highlight',
  underline: 'Underline',
  strikeout: 'Strikethrough',
  squiggly: 'Squiggly underline',
};
export const MARKUP_SUBTYPE: Record<MarkupType, string> = {
  highlight: 'Highlight',
  underline: 'Underline',
  strikeout: 'StrikeOut',
  squiggly: 'Squiggly',
};

export const MARKUP_COLORS: Record<MarkupType, string> = {
  highlight: '#ffe14d',
  underline: '#1a9e3f',
  strikeout: '#d92d20',
  squiggly: '#7a3ff2',
};

export const NOTE_DEFAULTS = { color: '#ffd400', icon: 'Comment' as NoteIcon, opacity: 1 };
export const MARKUP_DEFAULTS: Record<MarkupType, { color: string; opacity: number }> = {
  highlight: { color: MARKUP_COLORS.highlight, opacity: 1 },
  underline: { color: MARKUP_COLORS.underline, opacity: 1 },
  strikeout: { color: MARKUP_COLORS.strikeout, opacity: 1 },
  squiggly: { color: MARKUP_COLORS.squiggly, opacity: 1 },
};
export const CARET_DEFAULTS = { color: '#1473e6', opacity: 1 };
export const TEXTBOX_DEFAULTS = {
  font: 'Helvetica' as FontFamily,
  fontSize: 12,
  textColor: '#d92d20',
  align: 'left' as TextAlign,
  borderColor: '#d92d20' as string | null,
  borderWidth: 1,
  fillColor: null as string | null,
  opacity: 1,
};
export const CALLOUT_DEFAULTS = { ...TEXTBOX_DEFAULTS, fillColor: '#ffffff' as string | null };
export const ATTACH_DEFAULTS = { icon: 'PushPin' as AttachIcon, color: '#1473e6' };

export const NOTE_SIZE = 20;
export const ATTACH_SIZE = 20;

export const STATUS_LABEL: Record<ReviewStatus, string> = {
  none: 'None',
  accepted: 'Accepted',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  completed: 'Completed',
};
export const STATUSES: ReviewStatus[] = ['none', 'accepted', 'rejected', 'cancelled', 'completed'];

export const PALETTE = ['#ffe14d', '#ffd400', '#f7a21b', '#d92d20', '#e8488b', '#7a3ff2', '#1473e6', '#12a3c7', '#1a9e3f', '#8fce00', '#000000', '#6e6e6e'];

// ── feature UI state (not part of documents / undo) ─────────────────────────

export interface PopupTarget {
  docId: DocId;
  objectId: string;
  /** Move keyboard focus into the note editor. */
  focus: boolean;
  /** 'select' popups close again when the selection moves away. */
  source: 'select' | 'edit' | 'create' | 'explicit';
  /** Start with the reply box focused. */
  reply?: boolean;
}

interface CommentsUi {
  popup: PopupTarget | null;
  /** Documents whose comments are hidden on the page. */
  hidden: Record<DocId, true>;
  /** Object whose card should scroll into view in the panel (nonce bumps). */
  reveal: { docId: DocId; objectId: string; nonce: number } | null;
  /** Card being edited inline in the panel. */
  cardEdit: { docId: DocId; objectId: string } | null;
}

export const useCommentsUi = create<CommentsUi>(() => ({ popup: null, hidden: {}, reveal: null, cardEdit: null }));
export const commentsUi = {
  get: () => useCommentsUi.getState(),
  set: (patch: Partial<CommentsUi>) => useCommentsUi.setState(patch),
  openPopup(t: PopupTarget) {
    useCommentsUi.setState({ popup: t });
  },
  closePopup() {
    if (useCommentsUi.getState().popup) useCommentsUi.setState({ popup: null });
  },
  isHidden: (docId: DocId | null | undefined) => !!docId && !!useCommentsUi.getState().hidden[docId],
  setHidden(docId: DocId, hidden: boolean) {
    useCommentsUi.setState((s) => {
      const next = { ...s.hidden };
      if (hidden) next[docId] = true;
      else delete next[docId];
      return { hidden: next };
    });
  },
};

export function useCommentsHidden(docId: DocId): boolean {
  return useCommentsUi((s) => !!s.hidden[docId]);
}

// ── helpers ─────────────────────────────────────────────────────────────────

export function isCommentKind(kind: string): boolean {
  return reg.objectType(kind)?.category === 'comment';
}
/** Selecting (or clicking) these shows their pop-up: sticky notes, and markups that have a comment. */
export function showsPopupOnSelect(o: PdfObject | undefined): o is PdfObject {
  return !!o && (o.kind === 'note' || ((o.kind === 'text-markup' || o.kind === 'caret' || o.kind === 'file-attachment') && (!!o.contents || !!o.replies?.length)));
}
export function isComment(o: PdfObject | undefined | null): o is PdfObject {
  return !!o && isCommentKind(o.kind);
}

export function commentObjects(docId: DocId): PdfObject[] {
  const d = getDoc(docId);
  if (!d) return [];
  return d.order.map((id) => d.objects[id]).filter((o) => isComment(o));
}

export function typeOf(o: PdfObject): ObjectTypeDef | undefined {
  return reg.objectType(o.kind);
}

/** Label used in lists: "Highlight", "Sticky note", … */
export function kindLabel(o: PdfObject): string {
  if (o.kind === 'text-markup') {
    const d = o.data as MarkupData;
    if (d.type === 'highlight' && !d.text && !d.textPending) return 'Area highlight'; // imported text is filled in shortly after opening
    return MARKUP_LABEL[d.type] ?? 'Markup';
  }
  if (o.kind === 'caret') return (o.data as CaretData).strike ? 'Replace text' : 'Inserted text';
  if (o.kind === 'freetext') return (o.data as FreeTextData).callout ? 'Callout' : 'Text box';
  return typeOf(o)?.label ?? o.kind;
}

/** Blocks editing of documents whose bytes can't be written (e.g. undecryptable). */
export function canAnnotate(docId: DocId | null | undefined, quiet = false): boolean {
  if (!docId || !getDoc(docId)) return false;
  if (engine.isReadOnly(docId)) {
    if (!quiet) actions.toast('This document is open read-only, so comments can’t be added.', { kind: 'warning' });
    return false;
  }
  return true;
}

export function relativeTime(t: number, now = Date.now()): string {
  const s = Math.round((now - t) / 1000);
  if (!Number.isFinite(s)) return '';
  if (s < 45) return 'Just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.round(h / 24);
  if (d === 1) return 'Yesterday';
  if (d < 7) return `${d} days ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: new Date(t).getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric' });
}

export function fullTime(t: number): string {
  try {
    return new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return '';
  }
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

/** Stable pastel color per author for avatars. */
export function authorColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const hues = [210, 262, 330, 20, 150, 190, 45, 0];
  return `hsl(${hues[h % hues.length]} 55% 45%)`;
}

export function normRotation(r: number | undefined): Rotation {
  const v = ((Math.round((r ?? 0) / 90) * 90) % 360 + 360) % 360;
  return v as Rotation;
}

/** WinAnsi-encodable (so the standard 14 fonts can draw it). */
const WIN_ANSI_EXTRA = new Set(
  [0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178],
);
export function isWinAnsi(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c === 10 || c === 13 || c === 9) continue;
    if ((c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WIN_ANSI_EXTRA.has(c)) continue;
    return false;
  }
  return true;
}

export const LIBERATION_URL = {
  regular: assetUrl('pdfjs/standard_fonts/LiberationSans-Regular.ttf'),
  bold: assetUrl('pdfjs/standard_fonts/LiberationSans-Bold.ttf'),
  italic: assetUrl('pdfjs/standard_fonts/LiberationSans-Italic.ttf'),
};

export async function fetchFont(url: string): Promise<ArrayBuffer> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Couldn't load the font for Unicode text (${r.status}).`);
  return r.arrayBuffer();
}
