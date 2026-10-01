/**
 * Format controls (font, size, color, bold / italic / underline, alignment, line and character
 * spacing). They apply to the open text editor, the selected text, or the defaults for new text.
 */
import { useEffect, useState, type MouseEvent as RMouseEvent } from 'react';
import { AlignCenter, AlignJustify, AlignLeft, AlignRight, Bold, Italic, Underline } from 'lucide-react';
import { useApp, useDoc, useToolOptions } from '@/core/store';
import { ColorSwatchButton, IconButton, NumberField, Select } from '@/core/ui';
import type { TextBlock, TextStyle } from '../content/blocks';
import { findBlock } from '../edits';
import { FAMILIES, KIND_TEXT, TEXT_DEFAULTS, TOOL_TEXT, lineSpacingOf, round2, styleFromDefaults, type ContentTextObject } from '../model';
import { applyFormat, type FormatScope } from '../sessions';
import { useEditPdf, type Target } from '../state';

const SIZES = [6, 7, 8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 32, 36, 48, 60, 72];

export interface FormatState {
  scope: FormatScope;
  style: TextStyle;
  /** Why formatting is unavailable (e.g. a font without character information). */
  disabled?: string;
}

function useTargetBlock(t: Target | null): TextBlock | null {
  const bytes = useDoc(t?.docId, (d) => d?.bytes ?? null);
  const key = t?.type === 'block' ? `${t.docId}:${t.pageIndex}:${t.id}:${t.text}` : null;
  const [state, setState] = useState<{ key: string | null; bytes: Uint8Array | null; block: TextBlock | null }>({ key: null, bytes: null, block: null });
  useEffect(() => {
    if (!t || t.type !== 'block' || !key) return;
    let alive = true;
    void findBlock(t).then((block) => alive && setState({ key, bytes, block }));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, bytes]);
  return state.key === key && state.bytes === bytes ? state.block : null;
}

/** What the format controls show and change right now (null: nothing text-like is active). */
export function useFormatState(): FormatState | null {
  const edit = useEditPdf((s) => (s.edit?.phase === 'editing' ? s.edit : null));
  const target = useEditPdf((s) => s.target);
  const toolId = useApp((s) => s.activeToolId);
  const defaults = useToolOptions(TOOL_TEXT, TEXT_DEFAULTS);
  const obj = useDoc(target?.docId, (d) => (target?.type === 'object' ? d?.objects[target.id] : undefined));
  const block = useTargetBlock(target);
  if (edit) return { scope: 'editor', style: edit.style };
  if (target?.type === 'object' && obj?.kind === KIND_TEXT) return { scope: 'object', style: (obj as ContentTextObject).data.style };
  if (target?.type === 'block') {
    if (!block) return null;
    return { scope: 'block', style: block.style, disabled: block.textReliable ? undefined : 'This text uses a font without character information, so it can’t be reformatted.' };
  }
  if (toolId === TOOL_TEXT) return { scope: 'defaults', style: styleFromDefaults(defaults) };
  return null;
}

/** Keeps the text editor focused when a format button is pressed. */
const keepFocus = (e: RMouseEvent) => {
  if ((e.target as Element).closest('button')) e.preventDefault();
};

const set = (style: Partial<TextStyle>) => void applyFormat({ style });

function sizeOptions(size: number) {
  const s = round2(size);
  const list = SIZES.includes(s) ? SIZES : [...SIZES, s].sort((a, b) => a - b);
  return list.map((v) => ({ value: v, label: `${v}` }));
}

function FamilySelect({ style, disabled, testid, size }: { style: TextStyle; disabled?: boolean; testid: string; size: 'sm' | 'md' }) {
  return (
    <Select
      size={size}
      aria-label="Font"
      value={style.family}
      width={size === 'sm' ? 150 : '100%'}
      options={FAMILIES.map((f) => ({ value: f.value, label: f.label }))}
      onChange={(family) => set({ family })}
      disabled={disabled}
      data-testid={testid}
    />
  );
}

function StyleButtons({ style, disabled, prefix }: { style: TextStyle; disabled?: boolean; prefix: string }) {
  return (
    <>
      <IconButton size="sm" icon={Bold} label="Bold" shortcut="mod+b" active={style.bold} disabled={disabled} onClick={() => set({ bold: !style.bold })} data-testid={`${prefix}-bold`} />
      <IconButton size="sm" icon={Italic} label="Italic" shortcut="mod+i" active={style.italic} disabled={disabled} onClick={() => set({ italic: !style.italic })} data-testid={`${prefix}-italic`} />
      <IconButton size="sm" icon={Underline} label="Underline" shortcut="mod+u" active={style.underline} disabled={disabled} onClick={() => set({ underline: !style.underline })} data-testid={`${prefix}-underline`} />
    </>
  );
}

const ALIGNS = [
  { value: 'left', label: 'Align left', icon: AlignLeft },
  { value: 'center', label: 'Center', icon: AlignCenter },
  { value: 'right', label: 'Align right', icon: AlignRight },
  { value: 'justify', label: 'Justify', icon: AlignJustify },
] as const;

/** Full format section of the task panel. */
export function FormatSection({ state }: { state: FormatState }) {
  const { style, disabled } = state;
  const off = !!disabled;
  return (
    <div className="edit-pdf-format" onMouseDown={keepFocus} data-testid="edit-pdf-format" data-scope={state.scope}>
      {state.scope === 'defaults' && <p className="edit-pdf-hint">Applies to the next text you add.</p>}
      {disabled && <p className="edit-pdf-hint is-warning">{disabled}</p>}
      <FamilySelect style={style} disabled={off} testid="edit-pdf-font-family" size="md" />
      <div className="edit-pdf-row">
        <span className="edit-pdf-grow" data-testid="edit-pdf-font-size">
          <NumberField value={round2(style.size)} min={1} max={400} step={1} precision={1} suffix="pt" onChange={(size) => set({ size })} disabled={off} aria-label="Font size" />
        </span>
        <span data-testid="edit-pdf-font-color">
          <ColorSwatchButton value={style.color} label="Text color" onChange={(c) => c && set({ color: c })} disabled={off} />
        </span>
      </div>
      <div className="edit-pdf-row" role="group" aria-label="Text style">
        <StyleButtons style={style} disabled={off} prefix="edit-pdf" />
        <span className="edit-pdf-sep" />
        {ALIGNS.map((a) => (
          <IconButton
            key={a.value}
            size="sm"
            icon={a.icon}
            label={a.label}
            active={style.align === a.value}
            disabled={off}
            onClick={() => set({ align: a.value })}
            data-testid={`edit-pdf-align-${a.value}`}
          />
        ))}
      </div>
      <div className="edit-pdf-row">
        <label className="edit-pdf-mini-field">
          <span className="field-label">Line spacing</span>
          <span data-testid="edit-pdf-line-spacing">
            <NumberField value={lineSpacingOf(style)} min={0.5} max={5} step={0.05} precision={2} onChange={(v) => void applyFormat({ lineSpacing: v })} disabled={off} aria-label="Line spacing" />
          </span>
        </label>
        <label className="edit-pdf-mini-field">
          <span className="field-label">Character spacing</span>
          <span data-testid="edit-pdf-char-spacing">
            <NumberField value={round2(style.charSpacing)} min={-5} max={50} step={0.1} precision={1} suffix="pt" onChange={(charSpacing) => set({ charSpacing })} disabled={off} aria-label="Character spacing" />
          </span>
        </label>
      </div>
    </div>
  );
}

/** Compact controls of the floating bar while typing. */
export function FormatBarControls({ style }: { style: TextStyle }) {
  return (
    <div className="edit-pdf-bar-group" onMouseDown={keepFocus}>
      <FamilySelect style={style} testid="edit-pdf-bar-font-family" size="sm" />
      <Select size="sm" aria-label="Font size" value={round2(style.size)} width={64} options={sizeOptions(style.size)} onChange={(size) => set({ size })} data-testid="edit-pdf-bar-font-size" />
      <span data-testid="edit-pdf-bar-font-color">
        <ColorSwatchButton value={style.color} label="Text color" size="sm" onChange={(c) => c && set({ color: c })} />
      </span>
      <StyleButtons style={style} prefix="edit-pdf-bar" />
    </div>
  );
}
