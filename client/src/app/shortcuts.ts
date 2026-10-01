/**
 * Global keyboard shortcut manager for registry commands (`CommandDef.shortcut`) and tools
 * (`ToolDef.shortcut`). Runs on window keydown in the bubble phase, so components that handle a key
 * themselves (and call preventDefault) win.
 *
 * - 'mod' = Cmd on macOS, Ctrl elsewhere (see core/ui/shortcut.ts).
 * - While typing in a field only a few app-level combos work (save, open, print, palette).
 * - Plain keys (no Ctrl/Cmd/Alt) are ignored inside composite widgets that use them (menus, lists,
 *   grids, tabs, sliders…) and inside any element marked `data-no-shortcuts`.
 * - Commands respect `requiresDocument` / `enabled()`; tool shortcuts call actions.setTool and
 *   cycle between tools sharing the same key.
 */
import { useRegistry } from '@/core/registry';
import { actions, useApp } from '@/core/store';
import type { CommandDef, ToolDef } from '@/core/types';
import { hasEscapeLayer, isEditableTarget, isPlainKeyShortcut, matchShortcut, parseShortcut } from '@/core/ui';
import { executeCommand, hasDocContext, isCommandEnabled, SHORTCUT_ALIASES } from './commands';
import { shell, useShell } from './uiStore';

/** Combos that still work while focus is in a text field. */
const WHILE_TYPING = ['mod+s', 'mod+shift+s', 'mod+o', 'mod+p', 'mod+k'];
/** Combos whose browser default (save page, open, print) is never wanted inside the app. */
const ALWAYS_PREVENT = ['mod+s', 'mod+shift+s', 'mod+o', 'mod+p'];

const REPEATABLE = new Set([
  'core.zoomIn', 'core.zoomOut', 'core.nextPage', 'core.prevPage', 'core.undo', 'core.redo', 'core.rotateCw', 'core.rotateCcw',
]);

const PLAIN_KEY_WIDGETS =
  '[role="menu"], [role="menubar"], [role="listbox"], [role="grid"], [role="tablist"], [role="radiogroup"], [role="slider"], [role="tree"], [role="treegrid"], [role="spinbutton"], [role="combobox"], [data-no-shortcuts]';
const ARROW_KEYS = new Set(['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'home', 'end', 'pageup', 'pagedown']);

function commandCombos(c: CommandDef): string[] {
  const out: string[] = [];
  if (c.shortcut) out.push(c.shortcut);
  const aliases = SHORTCUT_ALIASES[c.id];
  if (aliases) out.push(...aliases);
  return out;
}

function plainKeyBlocked(target: EventTarget | null, combo: string): boolean {
  const el = target instanceof Element ? target : null;
  if (!el) return false;
  if (el.closest(PLAIN_KEY_WIDGETS)) return true;
  // Toolbars use arrow keys for roving focus.
  if (ARROW_KEYS.has(parseShortcut(combo).key) && el.closest('[role="toolbar"]')) return true;
  // Space / Enter on a focused button activates it.
  const key = parseShortcut(combo).key;
  if ((key === 'space' || key === 'enter') && el.closest('button, a[href], [role="button"]')) return true;
  return false;
}

function onKeyDown(e: KeyboardEvent) {
  if (e.defaultPrevented || e.isComposing) return;
  const app = useApp.getState();
  // Modal dialogs own the keyboard. The command palette handles its own keys.
  if (app.modals.length > 0) return;
  if (useShell.getState().paletteOpen) return;
  if (app.busy) return;

  const typing = isEditableTarget(e.target);
  const layers = hasEscapeLayer(); // a menu / popover is open

  // ── commands ──
  const commands = Object.values(useRegistry.getState().commands);
  for (const cmd of commands) {
    for (const combo of commandCombos(cmd)) {
      if (!matchShortcut(e, combo)) continue;
      const plain = isPlainKeyShortcut(combo);
      if (typing && !WHILE_TYPING.includes(combo)) continue;
      if (plain && (layers || plainKeyBlocked(e.target, combo))) continue;
      if (!isCommandEnabled(cmd)) {
        if (ALWAYS_PREVENT.includes(combo)) e.preventDefault();
        continue;
      }
      e.preventDefault();
      e.stopPropagation();
      // Holding a key repeats only "stepping" commands (zoom, page navigation, undo/redo).
      if (e.repeat && !REPEATABLE.has(cmd.id)) return;
      void executeCommand(cmd);
      return;
    }
  }

  // ── tools ──
  if (typing || layers || !hasDocContext()) return;
  const tools = Object.values(useRegistry.getState().tools)
    .filter((t): t is ToolDef & { shortcut: string } => !!t.shortcut)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const matching = tools.filter((t) => matchShortcut(e, t.shortcut) && !(isPlainKeyShortcut(t.shortcut) && plainKeyBlocked(e.target, t.shortcut)));
  if (matching.length) {
    e.preventDefault();
    const cur = matching.findIndex((t) => t.id === app.activeToolId);
    const next = matching[(cur + 1) % matching.length];
    actions.setTool(next.id);
    return;
  }

  // ── Escape fallbacks (only when nothing else handled it) ──
  if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey) {
    if (useShell.getState().readMode) {
      shell.setReadMode(false);
      e.preventDefault();
      return;
    }
    if (app.activeToolId !== 'select' && app.activeToolId !== 'hand') {
      actions.setTool('select');
      e.preventDefault();
    }
  }
}

let installed = false;
/** Installs the global handler once. Returns an uninstall function. */
export function installShortcuts(): () => void {
  if (installed) return () => {};
  installed = true;
  window.addEventListener('keydown', onKeyDown);
  return () => {
    installed = false;
    window.removeEventListener('keydown', onKeyDown);
  };
}
