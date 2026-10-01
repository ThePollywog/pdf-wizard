/**
 * Keyboard shortcut strings: 'mod+s', 'mod+shift+z', 'shift+k', 'h', 'alt+w', 'f4', '?'.
 * 'mod' = Cmd on macOS, Ctrl elsewhere. Matching uses both KeyboardEvent.key and .code so that
 * Option/Alt combinations on macOS (which change e.key) and shifted symbols both work.
 */
import { isMac } from '../util';

export interface ParsedShortcut {
  key: string;
  mod: boolean;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
}

const KEY_ALIASES: Record<string, string> = {
  esc: 'escape',
  del: 'delete',
  up: 'arrowup',
  down: 'arrowdown',
  left: 'arrowleft',
  right: 'arrowright',
  return: 'enter',
  pgup: 'pageup',
  pgdn: 'pagedown',
  plus: '+',
  minus: '-',
  ' ': 'space',
  spacebar: 'space',
};

const cache = new Map<string, ParsedShortcut>();

export function parseShortcut(s: string): ParsedShortcut {
  const hit = cache.get(s);
  if (hit) return hit;
  const raw = s.trim().toLowerCase();
  let parts = raw.split('+');
  // 'mod++' → trailing '+' key
  if (raw.endsWith('++')) parts = [...raw.slice(0, -2).split('+').filter(Boolean), '+'];
  const p: ParsedShortcut = { key: '', mod: false, ctrl: false, meta: false, alt: false, shift: false };
  for (const part of parts) {
    const t = part.trim();
    if (t === 'mod') p.mod = true;
    else if (t === 'ctrl' || t === 'control') p.ctrl = true;
    else if (t === 'cmd' || t === 'command' || t === 'meta' || t === 'super') p.meta = true;
    else if (t === 'alt' || t === 'option' || t === 'opt') p.alt = true;
    else if (t === 'shift') p.shift = true;
    else if (t) p.key = KEY_ALIASES[t] ?? t;
  }
  cache.set(s, p);
  return p;
}

const CODE_KEYS: Record<string, string> = {
  Equal: '=',
  Minus: '-',
  NumpadAdd: '+',
  NumpadSubtract: '-',
  NumpadMultiply: '*',
  NumpadDivide: '/',
  NumpadEnter: 'enter',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Slash: '/',
  Comma: ',',
  Period: '.',
  Semicolon: ';',
  Quote: "'",
  Backquote: '`',
  Space: 'space',
};

function codeKey(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3).toLowerCase();
  if (/^Digit\d$/.test(code)) return code.slice(5);
  if (/^Numpad\d$/.test(code)) return code.slice(6);
  if (/^F\d{1,2}$/.test(code)) return code.toLowerCase();
  if (/^Arrow/.test(code)) return code.toLowerCase();
  return CODE_KEYS[code] ?? null;
}

export interface KeyLike { key: string; code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }

/** Does the keyboard event match the shortcut? Modifiers must match exactly. */
export function matchShortcut(e: KeyLike, s: string | ParsedShortcut): boolean {
  const p = typeof s === 'string' ? parseShortcut(s) : s;
  if (!p.key) return false;
  const wantCtrl = p.ctrl || (p.mod && !isMac);
  const wantMeta = p.meta || (p.mod && isMac);
  if (e.ctrlKey !== wantCtrl || e.metaKey !== wantMeta || e.altKey !== p.alt) return false;

  const evKey = (e.key === ' ' ? 'space' : e.key ?? '').toLowerCase();
  const evCode = codeKey(e.code ?? '');
  // The Mac "delete" key sends Backspace; a 'delete' shortcut should fire for it too.
  const keyMatches = (k: string) =>
    evKey === k || (k === '=' && evKey === '+') || (k === '+' && evKey === '=') || (k === 'delete' && isMac && evKey === 'backspace');
  const codeMatches = (k: string) => evCode === k || (k === '=' && evCode === '+') || (k === '+' && evCode === '=');
  const byCode = codeMatches(p.key);
  // With Alt (macOS) or non-latin layouts e.key changes; prefer code for letters/digits.
  const byKey = keyMatches(p.key) && (!e.altKey || !/^[a-z0-9]$/.test(p.key) || evCode === null || evCode === p.key);
  if (!byCode && !byKey) return false;

  if (p.shift) return e.shiftKey;
  if (!e.shiftKey) return true;
  // Unshifted shortcut but shift held: accept only for shifted symbols typed via e.key ('?', '+', '!').
  return byKey && !byCode && !/^[a-z0-9]$/.test(p.key);
}

const MAC_SYMBOLS: Record<string, string> = {
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  enter: '↩',
  escape: 'Esc',
  delete: '⌫', // labelled like the Mac keyboard's delete key (which also triggers 'delete' shortcuts)
  backspace: '⌫',
  tab: '⇥',
  space: 'Space',
  pageup: 'PgUp',
  pagedown: 'PgDn',
  home: 'Home',
  end: 'End',
};
const PC_NAMES: Record<string, string> = {
  arrowup: '↑',
  arrowdown: '↓',
  arrowleft: '←',
  arrowright: '→',
  enter: 'Enter',
  escape: 'Esc',
  delete: 'Del',
  backspace: 'Backspace',
  tab: 'Tab',
  space: 'Space',
  pageup: 'PgUp',
  pagedown: 'PgDn',
  home: 'Home',
  end: 'End',
};

function keyLabel(k: string): string {
  const table = isMac ? MAC_SYMBOLS : PC_NAMES;
  if (table[k]) return table[k];
  if (/^f\d{1,2}$/.test(k)) return k.toUpperCase();
  return k.length === 1 ? k.toUpperCase() : k.charAt(0).toUpperCase() + k.slice(1);
}

/** Individual key labels, e.g. ['⌘', '⇧', 'Z'] or ['Ctrl', 'Shift', 'Z']. */
export function shortcutParts(s: string): string[] {
  const p = parseShortcut(s);
  const out: string[] = [];
  if (isMac) {
    if (p.ctrl) out.push('⌃');
    if (p.alt) out.push('⌥');
    if (p.shift) out.push('⇧');
    if (p.mod || p.meta) out.push('⌘');
  } else {
    if (p.ctrl || p.mod) out.push('Ctrl');
    if (p.meta) out.push('Win');
    if (p.alt) out.push('Alt');
    if (p.shift) out.push('Shift');
  }
  out.push(keyLabel(p.key));
  return out;
}

/** Human readable shortcut: '⌘⇧Z' on macOS, 'Ctrl+Shift+Z' elsewhere. */
export function formatShortcut(s: string | undefined | null): string {
  if (!s) return '';
  const parts = shortcutParts(s);
  return isMac ? parts.join('') : parts.join('+');
}

/** Shortcuts without Ctrl/Cmd/Alt (single keys, shift+key) are ignored while typing. */
export function isPlainKeyShortcut(s: string | ParsedShortcut): boolean {
  const p = typeof s === 'string' ? parseShortcut(s) : s;
  return !p.mod && !p.ctrl && !p.meta && !p.alt;
}
