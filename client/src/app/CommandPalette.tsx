/**
 * Cmd/Ctrl+K palette over tasks ("All tools"), commands, annotation tools, open documents and
 * recent library files.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CornerDownLeft, FileText, History, Search } from 'lucide-react';
import { useRegistry } from '@/core/registry';
import { actions, useApp } from '@/core/store';
import type { IconType } from '@/core/types';
import { Kbd, useEscapeLayer } from '@/core/ui';
import { executeCommand, hasDocContext, isCommandEnabled, SHORTCUT_HINTS } from './commands';
import { openLibraryFile, openTaskFlow } from './docActions';
import { shell, useShell } from './uiStore';

type Group = 'Open documents' | 'Tools' | 'Commands' | 'Annotation tools' | 'Recent files';
const GROUP_ORDER: Group[] = ['Open documents', 'Tools', 'Commands', 'Annotation tools', 'Recent files'];

interface Item {
  id: string;
  group: Group;
  label: string;
  hint?: string;
  icon?: IconType;
  color?: string;
  shortcut?: string;
  keywords?: string[];
  /** Rank bonus for suggestions when the query is empty. */
  suggest?: number;
  run(): void | Promise<void>;
}

/** Fuzzy score of `text` for query `q` (lower-case); -1 when it does not match. */
export function fuzzyScore(text: string, q: string): number {
  const t = text.toLowerCase();
  if (!q) return 0;
  if (t === q) return 120;
  if (t.startsWith(q)) return 100;
  const words = t.split(/[\s\-_/.,()]+/);
  if (words.some((w) => w.startsWith(q))) return 85;
  const i = t.indexOf(q);
  if (i >= 0) return 70 - Math.min(i, 20);
  // all query words appear somewhere
  const qw = q.split(/\s+/).filter(Boolean);
  if (qw.length > 1 && qw.every((w) => t.includes(w))) return 60;
  // initials: "sa" → "save as"
  const initials = words.map((w) => w[0] ?? '').join('');
  if (initials.startsWith(q)) return 55;
  // subsequence
  let j = 0;
  for (let k = 0; k < t.length && j < q.length; k++) if (t[k] === q[j]) j++;
  return j === q.length ? 20 - Math.min(10, t.length - q.length) / 2 : -1;
}

function buildItems(): Item[] {
  const r = useRegistry.getState();
  const s = useApp.getState();
  const inDoc = hasDocContext();
  const items: Item[] = [];

  for (const id of s.tabs) {
    const d = s.docs[id];
    if (!d) continue;
    items.push({
      id: `doc:${id}`,
      group: 'Open documents',
      label: d.name,
      hint: `${d.pages.length} page${d.pages.length === 1 ? '' : 's'}${d.dirty ? ' · Unsaved changes' : ''}`,
      icon: FileText,
      color: 'var(--brand)',
      suggest: id === s.activeDocId ? 0 : 3,
      run: () => actions.setActiveDoc(id),
    });
  }

  const tasks = Object.values(r.tasks).sort((a, b) => (a.featured ?? 999) - (b.featured ?? 999) || (a.order ?? 0) - (b.order ?? 0));
  tasks.forEach((t, i) => {
    items.push({
      id: `task:${t.id}`,
      group: 'Tools',
      label: t.label,
      hint: t.description,
      icon: t.icon,
      color: t.color,
      keywords: t.keywords,
      suggest: t.featured != null ? 10 - i * 0.1 : i < 6 ? 2 : undefined,
      run: () => openTaskFlow(t.id),
    });
  });

  for (const c of Object.values(r.commands)) {
    if (c.id === 'core.palette' || !isCommandEnabled(c)) continue;
    items.push({
      id: `cmd:${c.id}`,
      group: 'Commands',
      label: c.label.replace(/…$/, ''),
      icon: c.icon,
      shortcut: c.shortcut ?? SHORTCUT_HINTS[c.id],
      suggest: ['core.open', 'core.save', 'core.download', 'core.print', 'core.shortcuts', 'core.preferences'].includes(c.id) ? 4 : undefined,
      run: () => executeCommand(c),
    });
  }

  if (inDoc) {
    for (const t of Object.values(r.tools)) {
      if (t.id === 'select' || t.id === 'hand') continue;
      items.push({
        id: `tool:${t.id}`,
        group: 'Annotation tools',
        label: t.label,
        icon: t.icon,
        shortcut: t.shortcut,
        run: () => actions.setTool(t.id),
      });
    }
  }

  const openFileIds = new Set(s.tabs.map((id) => s.docs[id]?.fileId).filter(Boolean));
  for (const f of useShell.getState().recentFiles.slice(0, 20)) {
    if (openFileIds.has(f.id)) continue;
    items.push({
      id: `file:${f.id}`,
      group: 'Recent files',
      label: f.name,
      hint: `${f.pages} page${f.pages === 1 ? '' : 's'}`,
      icon: History,
      suggest: 1,
      run: () => void openLibraryFile(f.id),
    });
  }
  return items;
}

const LIMITS: Record<Group, number> = { 'Open documents': 6, Tools: 8, Commands: 8, 'Annotation tools': 6, 'Recent files': 5 };
const EMPTY_LIMITS: Record<Group, number> = { 'Open documents': 5, Tools: 6, Commands: 5, 'Annotation tools': 0, 'Recent files': 4 };

function search(items: Item[], raw: string): { group: Group; items: Item[] }[] {
  const q = raw.trim().toLowerCase();
  const scored = items
    .map((it) => {
      if (!q) return { it, score: it.suggest ?? -1 };
      const best = Math.max(
        fuzzyScore(it.label, q),
        ...(it.keywords ?? []).map((k) => fuzzyScore(k, q) - 15),
        it.hint && it.group === 'Tools' ? (it.hint.toLowerCase().includes(q) ? 30 : -1) : -1,
      );
      return { it, score: best };
    })
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score);
  const limits = q ? LIMITS : EMPTY_LIMITS;
  return GROUP_ORDER.map((g) => ({ group: g, items: scored.filter((x) => x.it.group === g).slice(0, limits[g]).map((x) => x.it) })).filter(
    (g) => g.items.length > 0,
  );
}

function highlight(label: string, q: string): ReactNode {
  const t = q.trim().toLowerCase();
  if (!t) return label;
  const i = label.toLowerCase().indexOf(t);
  if (i < 0) return label;
  return (
    <>
      {label.slice(0, i)}
      <mark>{label.slice(i, i + t.length)}</mark>
      {label.slice(i + t.length)}
    </>
  );
}

function Palette() {
  const initial = useShell.getState().paletteQuery;
  const [query, setQuery] = useState(initial);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(document.activeElement instanceof HTMLElement ? document.activeElement : null);
  // Rebuild when the registry / docs change while open.
  const regVersion = useRegistry((s) => s.commands);
  const tasks = useRegistry((s) => s.tasks);
  const tabs = useApp((s) => s.tabs);
  const recent = useShell((s) => s.recentFiles);
  const all = useMemo(() => buildItems(), [regVersion, tasks, tabs, recent]);
  const groups = useMemo(() => search(all, query), [all, query]);
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  const close = (restore = true) => {
    shell.closePalette();
    if (restore) requestAnimationFrame(() => restoreRef.current?.focus?.({ preventScroll: true }));
  };
  useEscapeLayer(true, () => close());

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);
  useEffect(() => setActive(0), [query]);
  useLayoutEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const runItem = (it: Item | undefined) => {
    if (!it) return;
    close(false);
    // Let the palette unmount before the item opens dialogs / moves focus.
    setTimeout(() => void it.run(), 0);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => (flat.length ? (a + 1) % flat.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (flat.length ? (a - 1 + flat.length) % flat.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      runItem(flat[active]);
    } else if (e.key === 'Tab') {
      e.preventDefault();
    } else if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      close();
    }
  };

  let index = -1;
  const activeId = flat[active] ? `palette-opt-${flat[active].id}` : undefined;
  return (
    <div className="palette-layer" data-layer="" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Search tools and commands" data-testid="command-palette" onKeyDown={onKeyDown}>
        <div className="palette-input-row">
          <Search size={18} strokeWidth={2} className="palette-input-icon" />
          <input
            ref={inputRef}
            className="palette-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search tools, commands and files"
            aria-label="Search"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={activeId}
            autoComplete="off"
            spellCheck={false}
            data-testid="palette-input"
          />
          <Kbd className="palette-esc">Esc</Kbd>
        </div>
        <div className="palette-list" id="palette-list" role="listbox" ref={listRef} aria-label="Results">
          {groups.length === 0 && (
            <div className="palette-empty">
              No results for “{query.trim()}”
            </div>
          )}
          {groups.map((g) => (
            <div key={g.group} className="palette-group" role="group" aria-label={g.group}>
              <div className="palette-group-title">{query.trim() ? g.group : g.group === 'Tools' ? 'Suggested tools' : g.group}</div>
              {g.items.map((it) => {
                index++;
                const i = index;
                const Icon = it.icon;
                const selected = i === active;
                return (
                  <div
                    key={it.id}
                    id={`palette-opt-${it.id}`}
                    role="option"
                    aria-selected={selected}
                    className={selected ? 'palette-item is-active' : 'palette-item'}
                    data-testid="palette-item"
                    onMouseMove={() => i !== active && setActive(i)}
                    onClick={() => runItem(it)}
                  >
                    <span
                      className={it.group === 'Tools' ? 'palette-item-icon is-tile' : 'palette-item-icon'}
                      style={it.group === 'Tools' && it.color ? { background: it.color } : it.color ? { color: it.color } : undefined}
                    >
                      {Icon && <Icon size={it.group === 'Tools' ? 16 : 18} strokeWidth={1.75} />}
                    </span>
                    <span className="palette-item-text">
                      <span className="palette-item-label">{highlight(it.label, query)}</span>
                      {it.hint && <span className="palette-item-hint">{it.hint}</span>}
                    </span>
                    {it.shortcut && <Kbd shortcut={it.shortcut} className="palette-item-kbd" />}
                    {selected && <CornerDownLeft size={14} className="palette-item-enter" aria-hidden />}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <div className="palette-footer" aria-hidden>
          <span>
            <Kbd>↑</Kbd>
            <Kbd>↓</Kbd> to navigate
          </span>
          <span>
            <Kbd>↵</Kbd> to open
          </span>
          <span>
            <Kbd>Esc</Kbd> to close
          </span>
        </div>
      </div>
    </div>
  );
}

export function CommandPalette() {
  const open = useShell((s) => s.paletteOpen);
  if (!open) return null;
  return createPortal(<Palette />, document.body);
}
