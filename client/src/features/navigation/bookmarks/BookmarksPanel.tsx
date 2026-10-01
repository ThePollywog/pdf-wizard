/**
 * Bookmarks panel: the document outline as an ARIA tree with the standard toolbar, inline rename,
 * drag & drop reordering / nesting, context menu and keyboard navigation.
 */
import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import {
  Bookmark, BookmarkPlus, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Crosshair, Ellipsis, Info, Link2,
  ListTree, PencilLine, Trash2, WrapText,
} from 'lucide-react';
import type { DocId } from '@/core/types';
import { useDoc } from '@/core/store';
import { Button, Dropdown, EmptyState, IconButton, showContextMenu, type MenuEntry } from '@/core/ui';
import { canEdit, shortcutOf } from '../util';
import { ancestorsOf, findItem, moveItem, visibleRows, type BmItem, type DropZone, type Row } from './model';
import { goToBookmark } from './dest';
import { bmUi, commitOutline, isExpandedIn, useBmUi } from './store';
import { deleteBookmark, newBookmark, outlineOf, renameBookmark, setDestinationToView } from './actions';
import { openBookmarkProperties } from './BookmarkProperties';
import { bookmarksFromStructure } from './structure';

const EMPTY: BmItem[] = [];
const DRAG_TYPE = 'application/x-navigation-bookmark';
const EMPTY_PER = { expanded: {}, selected: null, renaming: null };

/** The bookmark to highlight for the current page (the standard "highlight current bookmark"). */
function currentBookmarkId(rows: Row[], outline: BmItem[], all: BmItem[], pageIndexOf: (id: string) => number, current: number): string | null {
  let best: { id: string; page: number } | null = null;
  for (const it of all) {
    if (!it.pageId) continue;
    const p = pageIndexOf(it.pageId);
    if (p < 0 || p > current) continue;
    if (!best || p > best.page) best = { id: it.id, page: p };
  }
  if (!best) return null;
  const visible = new Set(rows.map((r) => r.item.id));
  if (visible.has(best.id)) return best.id;
  // Hidden inside a collapsed parent → highlight the nearest visible ancestor.
  const chain = ancestorsOf(outline, best.id) ?? [];
  for (let i = chain.length - 1; i >= 0; i--) if (visible.has(chain[i].id)) return chain[i].id;
  return null;
}

function flatten(items: BmItem[]): BmItem[] {
  const out: BmItem[] = [];
  const walk = (l: BmItem[]) => l.forEach((it) => (out.push(it), it.children?.length && walk(it.children as BmItem[])));
  walk(items);
  return out;
}

export function BookmarksPanel({ docId }: { docId: DocId }) {
  const outline = useDoc(docId, (d) => (d?.outline as BmItem[] | null) ?? EMPTY);
  const pages = useDoc(docId, (d) => d?.pages);
  const currentPage = useDoc(docId, (d) => d?.view.currentPage ?? 0);
  useDoc(docId, (d) => d?.pdfVersion); // re-evaluate read-only state after reloads
  const per = useBmUi((s) => s.docs[docId]) ?? EMPTY_PER;
  const wrap = useBmUi((s) => s.wrap);
  const editable = canEdit(docId);
  const treeRef = useRef<HTMLDivElement>(null);
  const [drop, setDrop] = useState<{ id: string | null; zone: DropZone } | null>(null);
  const dragId = useRef<string | null>(null);

  const rows = useMemo(() => visibleRows(outline, isExpandedIn(per)), [outline, per]);
  const all = useMemo(() => flatten(outline), [outline]);
  const pageIdx = useMemo(() => {
    const m = new Map((pages ?? []).map((p, i) => [p.id, i]));
    return (id: string) => m.get(id) ?? -1;
  }, [pages]);
  const currentId = useMemo(() => currentBookmarkId(rows, outline, all, pageIdx, currentPage), [rows, outline, all, pageIdx, currentPage]);
  const selected = per.selected && findItem(outline, per.selected) ? per.selected : null;
  const focusId = selected ?? currentId ?? rows[0]?.item.id ?? null;

  // Forget a selection whose item disappeared (undo, delete…).
  useEffect(() => {
    if (per.selected && !findItem(outline, per.selected)) bmUi.patch(docId, { selected: null, renaming: null });
  }, [outline, per.selected, docId]);

  // Keep the selected (or current) row in view.
  const scrollTarget = selected ?? currentId;
  useEffect(() => {
    if (!scrollTarget) return;
    const el = treeRef.current?.querySelector<HTMLElement>(`[data-bookmark-id="${CSS.escape(scrollTarget)}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [scrollTarget]);

  const focusRow = (id: string) => {
    const el = () => treeRef.current?.querySelector<HTMLElement>(`[data-bookmark-id="${CSS.escape(id)}"]`);
    // Move focus right away when the row is rendered (so the next key press acts on it).
    const now = el();
    if (now) now.focus();
    else requestAnimationFrame(() => el()?.focus());
  };

  const selectAndGo = (item: BmItem) => {
    bmUi.select(docId, item.id);
    goToBookmark(docId, item);
  };

  const toggle = (row: Row, open = !row.expanded) => {
    if (row.hasChildren) bmUi.setExpanded(docId, row.item.id, open);
  };

  const startRename = (id: string) => {
    if (!editable) return;
    bmUi.patch(docId, { selected: id, renaming: id });
  };

  const menuFor = (item: BmItem | null): MenuEntry[] => {
    const hasChildren = !!item?.children?.length;
    const entries: MenuEntry[] = [];
    if (item) {
      entries.push(
        { id: 'navigation.bm.goto', label: 'Go to bookmark', icon: Bookmark, run: () => goToBookmark(docId, item) },
        'divider',
      );
    }
    entries.push({ id: 'navigation.bm.new', label: 'New bookmark', icon: BookmarkPlus, shortcut: shortcutOf('navigation.newBookmark'), disabled: !editable, run: () => void newBookmark(docId) });
    if (item) {
      entries.push(
        { id: 'navigation.bm.rename', label: 'Rename', icon: PencilLine, shortcut: 'f2', disabled: !editable, run: () => startRename(item.id) },
        { id: 'navigation.bm.setdest', label: 'Set destination', icon: Crosshair, disabled: !editable, run: () => void setDestinationToView(docId, item.id) },
        { id: 'navigation.bm.delete', label: 'Delete', icon: Trash2, shortcut: 'delete', danger: true, disabled: !editable, run: () => void deleteBookmark(docId, item.id) },
      );
      if (hasChildren) {
        const expanded = isExpandedIn(per)(item);
        entries.push('divider', {
          id: 'navigation.bm.toggle',
          label: expanded ? 'Collapse' : 'Expand',
          icon: expanded ? ChevronsDownUp : ChevronsUpDown,
          run: () => bmUi.setExpanded(docId, item.id, !expanded),
        });
      }
    }
    entries.push(
      'divider',
      { id: 'navigation.bm.expandAll', label: 'Expand all bookmarks', icon: ChevronsUpDown, disabled: !outline.length, run: () => bmUi.setAll(docId, true) },
      { id: 'navigation.bm.collapseAll', label: 'Collapse all bookmarks', icon: ChevronsDownUp, disabled: !outline.length, run: () => bmUi.setAll(docId, false) },
      'divider',
      { id: 'navigation.bm.structure', label: 'New bookmarks from structure…', icon: ListTree, disabled: !editable, run: () => void bookmarksFromStructure(docId) },
      { id: 'navigation.bm.wrap', label: 'Wrap long bookmarks', icon: WrapText, checked: wrap, run: () => bmUi.setWrap(!wrap) },
    );
    if (item) entries.push('divider', { id: 'navigation.bm.props', label: 'Properties…', icon: Info, disabled: !editable, run: () => openBookmarkProperties(docId, item.id) });
    return entries;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('input')) return;
    // The focused row itself (focusId can lag behind fast key sequences).
    const targetId = (e.target as HTMLElement).closest<HTMLElement>('[data-bookmark-id]')?.dataset.bookmarkId;
    const idx = rows.findIndex((r) => r.item.id === (targetId ?? focusId));
    const row = idx >= 0 ? rows[idx] : null;
    const move = (i: number) => {
      const r = rows[Math.max(0, Math.min(rows.length - 1, i))];
      if (!r) return;
      bmUi.select(docId, r.item.id);
      focusRow(r.item.id);
    };
    const mod = e.metaKey || e.ctrlKey;
    let handled = true;
    switch (e.key) {
      case 'ArrowDown':
        move(idx + 1);
        break;
      case 'ArrowUp':
        move(idx <= 0 ? 0 : idx - 1);
        break;
      case 'Home':
        move(0);
        break;
      case 'End':
        move(rows.length - 1);
        break;
      case 'ArrowRight':
        if (!row) break;
        if (row.hasChildren && !row.expanded) toggle(row, true);
        else if (row.expanded) move(idx + 1);
        break;
      case 'ArrowLeft':
        if (!row) break;
        if (row.expanded) toggle(row, false);
        else if (row.parentId) {
          bmUi.select(docId, row.parentId);
          focusRow(row.parentId);
        }
        break;
      case 'Enter':
      case ' ':
        if (row) selectAndGo(row.item);
        break;
      case 'F2':
        if (row) startRename(row.item.id);
        break;
      case 'Delete':
      case 'Backspace':
        if (row && editable) void deleteBookmark(docId, row.item.id).then(() => treeRef.current?.querySelector<HTMLElement>('[role=treeitem][tabindex="0"]')?.focus());
        break;
      case '*':
        bmUi.setAll(docId, true);
        break;
      default:
        handled = false;
    }
    if (!handled && mod && e.key.toLowerCase() === 'b' && !e.shiftKey && !e.altKey) {
      handled = true;
      newBookmark(docId);
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  // ── drag & drop ──────────────────────────────────────────────────────────
  /** Where a drop over `row` lands. Below an expanded parent means "first child" (that's where the line is drawn). */
  const dropAt = (e: DragEvent<HTMLElement>, row: Row): { id: string; zone: DropZone } => {
    const r = e.currentTarget.getBoundingClientRect();
    const y = (e.clientY - r.top) / Math.max(1, r.height);
    if (y < 0.28) return { id: row.item.id, zone: 'before' };
    if (y > 0.72) {
      const first = row.expanded ? row.item.children?.[0] : undefined;
      return first ? { id: first.id, zone: 'before' } : { id: row.item.id, zone: 'after' };
    }
    return { id: row.item.id, zone: 'inside' };
  };
  const validDrop = (targetId: string | null) => {
    const src = dragId.current;
    if (!src || !editable) return false;
    if (!targetId) return true;
    if (src === targetId) return false;
    const item = findItem(outline, src);
    return !!item && !findItem([item], targetId);
  };
  const onDrop = (targetId: string | null, zone: DropZone) => {
    const src = dragId.current;
    dragId.current = null;
    setDrop(null);
    if (!src || !editable) return;
    const items = outlineOf(docId);
    let next: BmItem[] | null;
    if (!targetId) {
      const last = items[items.length - 1];
      next = last && last.id !== src ? moveItem(items, src, last.id, 'after') : null;
    } else next = moveItem(items, src, targetId, zone);
    if (!next) return;
    commitOutline(docId, next, 'Move bookmark');
    if (zone === 'inside' && targetId) bmUi.setExpanded(docId, targetId, true);
    bmUi.select(docId, src);
  };

  const empty = outline.length === 0;

  return (
    <div className={`navigation-bookmarks${wrap ? ' is-wrap' : ''}`} data-testid="navigation-bookmarks-panel">
      <div className="navigation-toolbar" role="toolbar" aria-label="Bookmark tools">
        <IconButton icon={BookmarkPlus} label="Add bookmark" shortcut={shortcutOf('navigation.newBookmark')} disabled={!editable} onClick={() => newBookmark(docId)} data-testid="navigation-bookmark-new" />
        <IconButton
          icon={Trash2}
          label="Delete bookmark"
          disabled={!editable || !selected}
          onClick={() => selected && void deleteBookmark(docId, selected)}
          data-testid="navigation-bookmark-delete"
        />
        <span className="navigation-toolbar-sep" />
        <IconButton icon={ChevronsUpDown} label="Expand all" disabled={empty} onClick={() => bmUi.setAll(docId, true)} data-testid="navigation-bookmark-expand-all" />
        <IconButton icon={ChevronsDownUp} label="Collapse all" disabled={empty} onClick={() => bmUi.setAll(docId, false)} data-testid="navigation-bookmark-collapse-all" />
        <span className="navigation-toolbar-spacer" />
        <Dropdown
          align="end"
          label="Bookmark options"
          items={() => menuFor(selected ? findItem(outlineOf(docId), selected) : null)}
          trigger={<IconButton icon={Ellipsis} label="Options" data-testid="navigation-bookmark-more" />}
        />
      </div>
      {empty ? (
        <div
          className={`navigation-bm-empty${drop ? ' is-drop' : ''}`}
          onContextMenu={(e) => {
            e.preventDefault();
            showContextMenu(e, menuFor(null));
          }}
        >
          <EmptyState
            compact
            icon={Bookmark}
            title="No bookmarks"
            description={editable ? 'Add bookmarks to mark pages and sections you want to return to.' : 'This document has no bookmarks.'}
            action={
              editable ? (
                <Button icon={BookmarkPlus} size="sm" onClick={() => newBookmark(docId)} data-testid="navigation-bookmark-empty-new">
                  Add bookmark
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : (
        <div
          ref={treeRef}
          className="navigation-bm-tree"
          role="tree"
          aria-label="Bookmarks"
          data-testid="navigation-bookmark-tree"
          onKeyDown={onKeyDown}
          onContextMenu={(e) => {
            if ((e.target as HTMLElement).closest('[role=treeitem]')) return;
            e.preventDefault();
            showContextMenu(e, menuFor(null));
          }}
        >
          {rows.map((row) => (
            <BookmarkRow
              key={row.item.id}
              docId={docId}
              row={row}
              selected={row.item.id === selected}
              current={row.item.id === currentId}
              focusable={row.item.id === focusId}
              renaming={per.renaming === row.item.id}
              dropZone={drop && drop.id === row.item.id ? drop.zone : null}
              editable={editable}
              onClick={(e) => {
                if ((e.target as HTMLElement).closest('.navigation-bm-twisty')) return;
                selectAndGo(row.item);
              }}
              onToggle={() => toggle(row)}
              onRename={() => startRename(row.item.id)}
              onRenameDone={(title) => {
                bmUi.patch(docId, { renaming: null });
                if (title !== null) renameBookmark(docId, row.item.id, title);
                focusRow(row.item.id);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                bmUi.select(docId, row.item.id);
                showContextMenu(e, menuFor(row.item));
              }}
              onDragStart={(e) => {
                if (!editable || per.renaming) {
                  e.preventDefault();
                  return;
                }
                dragId.current = row.item.id;
                e.dataTransfer.effectAllowed = 'move';
                e.dataTransfer.setData(DRAG_TYPE, row.item.id);
                e.dataTransfer.setData('text/plain', row.item.title);
              }}
              onDragOver={(e) => {
                if (!dragId.current) return;
                const at = dropAt(e, row);
                if (!validDrop(at.id)) {
                  if (drop) setDrop(null);
                  return;
                }
                e.preventDefault();
                e.dataTransfer.dropEffect = 'move';
                if (!drop || drop.id !== at.id || drop.zone !== at.zone) setDrop(at);
              }}
              onDrop={(e) => {
                e.preventDefault();
                const at = dropAt(e, row);
                if (validDrop(at.id)) onDrop(at.id, at.zone);
                else {
                  dragId.current = null;
                  setDrop(null);
                }
              }}
              onDragEnd={() => {
                dragId.current = null;
                setDrop(null);
              }}
            />
          ))}
          <div
            className={`navigation-bm-tail${drop && drop.id === null ? ' is-drop' : ''}`}
            onDragOver={(e) => {
              if (!dragId.current || !editable) return;
              e.preventDefault();
              if (!drop || drop.id !== null) setDrop({ id: null, zone: 'after' });
            }}
            onDragLeave={() => drop?.id === null && setDrop(null)}
            onDrop={(e) => {
              e.preventDefault();
              onDrop(null, 'after');
            }}
            onClick={() => bmUi.select(docId, null)}
          />
        </div>
      )}
    </div>
  );
}

interface RowProps {
  docId: DocId;
  row: Row;
  selected: boolean;
  current: boolean;
  focusable: boolean;
  renaming: boolean;
  dropZone: DropZone | null;
  editable: boolean;
  onClick(e: MouseEvent): void;
  onToggle(): void;
  onRename(): void;
  onRenameDone(title: string | null): void;
  onContextMenu(e: MouseEvent): void;
  onDragStart(e: DragEvent<HTMLDivElement>): void;
  onDragOver(e: DragEvent<HTMLDivElement>): void;
  onDrop(e: DragEvent<HTMLDivElement>): void;
  onDragEnd(): void;
}

function BookmarkRow(p: RowProps) {
  const { row, selected, current, focusable, renaming, dropZone } = p;
  const it = row.item;
  const cls = [
    'navigation-bm-row',
    selected && 'is-selected',
    current && 'is-current',
    dropZone && `is-drop-${dropZone}`,
  ]
    .filter(Boolean)
    .join(' ');
  const Icon = it.url ? Link2 : Bookmark;
  return (
    <div
      className={cls}
      role="treeitem"
      aria-level={row.depth + 1}
      aria-expanded={row.hasChildren ? row.expanded : undefined}
      aria-selected={selected}
      aria-current={current ? 'location' : undefined}
      tabIndex={focusable ? 0 : -1}
      data-testid="navigation-bookmark"
      data-bookmark-id={it.id}
      data-title={it.title}
      data-depth={row.depth}
      title={renaming ? undefined : it.title}
      style={{ paddingInlineStart: 4 + row.depth * 16 }}
      draggable={p.editable && !renaming}
      onClick={p.onClick}
      onDoubleClick={(e) => {
        if ((e.target as HTMLElement).closest('.navigation-bm-twisty')) return;
        p.onRename();
      }}
      onContextMenu={p.onContextMenu}
      onDragStart={p.onDragStart}
      onDragOver={p.onDragOver}
      onDrop={p.onDrop}
      onDragEnd={p.onDragEnd}
    >
      <span
        className={`navigation-bm-twisty${row.hasChildren ? '' : ' is-leaf'}`}
        data-testid="navigation-bookmark-toggle"
        aria-hidden="true"
        onClick={(e) => {
          e.stopPropagation();
          p.onToggle();
        }}
      >
        {row.hasChildren ? row.expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} /> : null}
      </span>
      <Icon className="navigation-bm-icon" size={14} strokeWidth={1.8} aria-hidden="true" />
      {renaming ? (
        <RenameInput initial={it.title} onDone={p.onRenameDone} />
      ) : (
        <span
          className="navigation-bm-title"
          style={{
            color: it.color && it.color.toLowerCase() !== '#000000' ? it.color : undefined,
            fontWeight: it.bold ? 700 : undefined,
            fontStyle: it.italic ? 'italic' : undefined,
          }}
        >
          {it.title || ' '}
        </span>
      )}
    </div>
  );
}

function RenameInput({ initial, onDone }: { initial: string; onDone(title: string | null): void }) {
  const ref = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);
  const finish = (v: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(v);
  };
  return (
    <input
      ref={ref}
      className="navigation-bm-rename"
      defaultValue={initial}
      aria-label="Bookmark name"
      data-testid="navigation-bookmark-rename-input"
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(e.currentTarget.value);
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish(null);
        }
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
    />
  );
}
