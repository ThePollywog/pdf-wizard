/**
 * Text editing sessions: starting the in-place editor on a base text block, an added text box or a
 * new box, committing it (one undo step) and formatting.
 */
import { actions, getDoc, getToolOptions, newObject, useApp } from '@/core/store';
import type { DocId, Point } from '@/core/types';
import type { Frame, TextBlock, TextStyle } from './content/blocks';
import { replaceBlock } from './content/ops';
import { findBlock, libFontLoader, readOnlyNotice, resolveBlockId, runEdit, unsupportedChars, warnMissingChars } from './edits';
import { ui, type EditSession, type Target } from './state';
import { pageCanvas } from './pagedom';
import { boxFrame, boxRect, firstBaselineOf, objectFrame } from './textbox';
import {
  KIND_TEXT, TEXT_DEFAULTS, TOOL_CONTENT, TOOL_TEXT, round2, styleFromDefaults,
  type ContentTextObject, type TextDefaults,
} from './model';
import type { Rotation } from '@/core/types';

type Caret = EditSession['caret'];

// ── starting ─────────────────────────────────────────────────────────────────

export function startBlockEdit(docId: DocId, pageIndex: number, block: TextBlock, caret: Caret, paper: string): boolean {
  const doc = getDoc(docId);
  if (!doc) return false;
  if (readOnlyNotice(docId)) return false;
  if (!block.textReliable) {
    actions.toast('This text uses a font without character information, so it can’t be edited. You can still move or delete it.', { kind: 'warning' });
    ui.setTarget({ type: 'block', docId, pageIndex, id: block.id, text: block.text, bounds: block.bounds });
    return false;
  }
  const autoWidth = block.lines.length === 1 && block.style.align === 'left';
  ui.setTarget({ type: 'block', docId, pageIndex, id: block.id, text: block.text, bounds: block.bounds });
  ui.startEdit({
    docId,
    pageIndex,
    source: { type: 'block', blockId: block.id, expectText: block.text },
    bytes: doc.bytes,
    text: block.text,
    style: block.style,
    frame: block.frame,
    firstBaseline: block.firstBaseline,
    autoWidth,
    original: { text: block.text, style: block.style, frame: block.frame },
    caret,
    paper,
  });
  return true;
}

export function startObjectEdit(docId: DocId, pageIndex: number, obj: ContentTextObject, caret: Caret): boolean {
  const doc = getDoc(docId);
  if (!doc) return false;
  if (readOnlyNotice(docId)) return false;
  const frame = objectFrame(obj);
  const style = obj.data.style;
  ui.setTarget({ type: 'object', docId, pageIndex, id: obj.id });
  ui.startEdit({
    docId,
    pageIndex,
    source: { type: 'object', objectId: obj.id },
    bytes: doc.bytes,
    text: obj.data.text,
    style,
    frame,
    firstBaseline: firstBaselineOf(style),
    autoWidth: !!obj.data.autoWidth,
    original: { text: obj.data.text, style, frame },
    caret,
    paper: 'transparent',
  });
  return true;
}

/** Defaults for new text (Format panel with nothing selected). */
export const textDefaults = (): TextDefaults => getToolOptions<TextDefaults>(TOOL_TEXT, TEXT_DEFAULTS);

/**
 * New text box at `p` (user space). `width` (points) makes a wrapping box; otherwise the box grows
 * with the text. The first line is centred vertically on the click point.
 */
export function startNewText(docId: DocId, pageIndex: number, p: Point, rotation: Rotation, width: number | null, top?: Point): boolean {
  const doc = getDoc(docId);
  if (!doc) return false;
  if (readOnlyNotice(docId)) return false;
  const style = styleFromDefaults(textDefaults());
  const f0 = boxFrame([0, 0], rotation, 1, 1);
  const origin: [number, number] = top
    ? [top.x, top.y]
    : [p.x - f0.d[0] * (style.lineHeight / 2), p.y - f0.d[1] * (style.lineHeight / 2)];
  const frame: Frame = boxFrame(origin, rotation, width ?? 8, style.lineHeight);
  ui.setTarget(null);
  ui.startEdit({
    docId,
    pageIndex,
    source: { type: 'new' },
    bytes: doc.bytes,
    text: '',
    style,
    frame,
    firstBaseline: firstBaselineOf(style),
    autoWidth: width === null,
    original: { text: '', style, frame },
    caret: 'end',
    paper: 'transparent',
  });
  return true;
}

// ── committing ───────────────────────────────────────────────────────────────

const sameStyle = (a: TextStyle, b: TextStyle) =>
  a.family === b.family && a.bold === b.bold && a.italic === b.italic && a.underline === b.underline && a.size === b.size &&
  a.color.toLowerCase() === b.color.toLowerCase() && Math.abs(a.lineHeight - b.lineHeight) < 0.01 && a.charSpacing === b.charSpacing && a.align === b.align;

const sameFrame = (a: Frame, b: Frame) =>
  Math.abs(a.origin[0] - b.origin[0]) < 0.01 && Math.abs(a.origin[1] - b.origin[1]) < 0.01 && Math.abs(a.width - b.width) < 0.01;

export const sessionChanged = (s: EditSession) =>
  s.text !== s.original.text || !sameStyle(s.style, s.original.style) || !sameFrame(s.frame, s.original.frame);

let committing: Promise<void> | null = null;

/** Commits the open text editor (if any). Safe to call repeatedly. */
export function commitEdit(): Promise<void> {
  if (committing) return committing;
  const s = ui.get().edit;
  if (!s || s.phase !== 'editing') return Promise.resolve();
  committing = doCommit(s).finally(() => {
    committing = null;
  });
  return committing;
}

async function doCommit(s: EditSession): Promise<void> {
  const doc = getDoc(s.docId);
  if (!doc) {
    ui.endEdit(s.nonce);
    return;
  }
  const page = doc.pages[s.pageIndex];
  const text = s.text.replace(/\r\n?/g, '\n');
  const empty = !text.trim();

  if (s.source.type === 'new') {
    ui.endEdit(s.nonce);
    if (empty || !page) return;
    const { rect } = boxRect(s.frame, text, s.style, s.autoWidth);
    const obj = newObject<ContentTextObject>({
      kind: KIND_TEXT,
      pageId: page.id,
      rect,
      color: s.style.color,
      data: { text, style: s.style, rotation: page.rotation, autoWidth: s.autoWidth },
    });
    actions.addObject(s.docId, obj, { label: 'Add text' });
    const app = useApp.getState();
    if (app.activeToolId === TOOL_TEXT && !app.toolLocked) actions.setTool(TOOL_CONTENT);
    ui.setTarget({ type: 'object', docId: s.docId, pageIndex: s.pageIndex, id: obj.id });
    void unsupportedChars(text, s.style).then(warnMissingChars);
    return;
  }

  if (s.source.type === 'object') {
    const id = s.source.objectId;
    ui.endEdit(s.nonce);
    const obj = doc.objects[id] as ContentTextObject | undefined;
    if (!obj || !sessionChanged(s)) return;
    if (empty) {
      actions.deleteObjects(s.docId, [id], { label: 'Delete text' });
      ui.setTarget(null);
      return;
    }
    const { rect } = boxRect(s.frame, text, s.style, s.autoWidth);
    actions.updateObject(s.docId, id, { rect, color: s.style.color, data: { ...obj.data, text, style: s.style, autoWidth: s.autoWidth } }, { label: 'Edit text' });
    if (text !== obj.data.text || !sameStyle(s.style, obj.data.style)) void unsupportedChars(text, s.style).then(warnMissingChars);
    return;
  }

  // base text block
  if (!sessionChanged(s) || doc.bytes !== s.bytes) {
    ui.endEdit(s.nonce);
    return;
  }
  const { blockId, expectText } = s.source;
  const bounds = ui.get().target?.type === 'block' ? (ui.get().target as Extract<Target, { type: 'block' }>).bounds : undefined;
  ui.patchEdit({ phase: 'committing' });
  const canvas = pageCanvas(s.pageIndex);
  let missing: string[] = [];
  const ok = await runEdit(s.docId, empty ? 'Delete text' : 'Edit text', async (lib) => {
    const id = resolveBlockId(lib, s.pageIndex, blockId, expectText, bounds);
    ({ missing } = await replaceBlock(
      lib, s.pageIndex, id, expectText,
      empty ? null : { text, style: s.style, frame: s.frame, firstBaseline: s.firstBaseline, wrap: !s.autoWidth },
      libFontLoader(lib),
    ));
  });
  if (ok) warnMissingChars(missing);
  const cur = ui.get().edit;
  if (cur?.nonce !== s.nonce) return;
  if (ok) {
    ui.patchEdit({ phase: 'settling', settleFrom: canvas, settleSince: performance.now() });
    const t = ui.get().target;
    if (t?.type === 'block' && t.id === blockId) ui.setTarget(null);
  } else ui.endEdit(s.nonce);
}

/** Drops the open editor without saving. */
export function cancelEdit(): void {
  const s = ui.get().edit;
  if (s && s.phase === 'editing') ui.endEdit(s.nonce);
}

// ── formatting ───────────────────────────────────────────────────────────────

export interface FormatPatch {
  style?: Partial<TextStyle>;
  /** Line spacing as a multiple of the font size. */
  lineSpacing?: number;
}

/** New style with `patch` applied; size changes keep the line-spacing multiple. */
export function mergeStyle(style: TextStyle, f: FormatPatch): TextStyle {
  const patch = f.style ?? {};
  const next = { ...style, ...patch };
  if (patch.size !== undefined && patch.lineHeight === undefined && style.size > 0) next.lineHeight = round2((style.lineHeight / style.size) * patch.size);
  if (f.lineSpacing !== undefined) next.lineHeight = round2(next.size * f.lineSpacing);
  return next;
}

/** What the Format controls currently apply to. */
export type FormatScope = 'editor' | 'block' | 'object' | 'defaults';

/** Applies formatting to the open editor, the selected text, or the defaults for new text. */
export async function applyFormat(f: FormatPatch): Promise<void> {
  const s = ui.get().edit;
  if (s && s.phase === 'editing') {
    const style = mergeStyle(s.style, f);
    const ratio = s.style.size > 0 ? style.size / s.style.size : 1;
    const firstBaseline = s.source.type === 'block' ? s.firstBaseline * ratio : firstBaselineOf(style);
    ui.patchEdit({ style, firstBaseline });
    ui.focusEditor();
    return;
  }
  const t = ui.get().target;
  if (t?.type === 'object') {
    const doc = getDoc(t.docId);
    const obj = doc?.objects[t.id] as ContentTextObject | undefined;
    if (obj?.kind === KIND_TEXT) {
      if (readOnlyNotice(t.docId)) return;
      const style = mergeStyle(obj.data.style, f);
      const { rect } = boxRect(objectFrame(obj), obj.data.text, style, !!obj.data.autoWidth);
      actions.updateObject(t.docId, obj.id, { rect, color: style.color, data: { ...obj.data, style } }, { label: 'Format text', coalesce: `edit-pdf-format:${obj.id}` });
      return;
    }
  }
  if (t?.type === 'block') {
    const block = await findBlock(t);
    if (!block) return;
    if (!block.textReliable) {
      actions.toast('This text uses a font without character information, so it can’t be reformatted.', { kind: 'warning' });
      return;
    }
    const style = mergeStyle(block.style, f);
    const ratio = block.style.size > 0 ? style.size / block.style.size : 1;
    const wrap = !(block.lines.length === 1 && block.style.align === 'left');
    const ok = await runEdit(t.docId, 'Format text', async (lib) => {
      const id = resolveBlockId(lib, t.pageIndex, block.id, block.text, block.bounds);
      await replaceBlock(lib, t.pageIndex, id, block.text, { text: block.text, style, frame: block.frame, firstBaseline: block.firstBaseline * ratio, wrap }, libFontLoader(lib));
    });
    if (ok) ui.setReselect({ type: 'block', docId: t.docId, pageIndex: t.pageIndex, text: block.text, bounds: block.bounds });
    return;
  }
  // defaults for new text
  const patch = f.style ?? {};
  for (const k of ['family', 'size', 'color', 'bold', 'italic', 'underline', 'align', 'charSpacing'] as const) {
    if (patch[k] !== undefined) actions.setToolOption(TOOL_TEXT, k, patch[k]);
  }
  if (f.lineSpacing !== undefined) actions.setToolOption(TOOL_TEXT, 'lineSpacing', f.lineSpacing);
}
