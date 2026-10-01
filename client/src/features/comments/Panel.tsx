/**
 * Comments panel (right rail): every object whose kind is in the 'comment' category — ours and
 * other features' (drawings, stamps…) — grouped by page, with search, filters, sorting, inline
 * editing, replies, status and the panel "…" menu (XFDF import / export, summary, hide, delete all).
 * Generic over the registry: labels, icons and summaries come from the object types.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as RKeyboardEvent, type MouseEvent as RMouseEvent } from 'react';
import { create } from 'zustand';
import clsx from 'clsx';
import {
  ArrowUpDown, Check, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Eye, EyeOff, FileDown, FileText, FileUp,
  ListFilter, Lock, MessageSquare, MessageSquarePlus, MoreHorizontal, Search, Trash2, X,
} from 'lucide-react';
import type { DocId, PdfObject, ReviewStatus } from '@/core/types';
import { useRegistry } from '@/core/registry';
import { actions, getDoc, useApp, useDoc } from '@/core/store';
import { Button, Checkbox, Dropdown, EmptyState, IconButton, Popover, confirmDialog, type MenuEntry } from '@/core/ui';
import { canAnnotate, commentsUi, isCommentKind, showsPopupOnSelect, STATUS_LABEL, STATUSES, TOOL, typeOf, useCommentsUi } from './model';
import { byPosition, commentItems, type Item } from './list';
import { commentMoreItems } from './menus';
import { deleteComment, revealComment, setContents, setStatus } from './ops';
import { Avatar, CommentEditor, ReplyThread, StatusBadge, TimeAgo } from './thread';
import { exportXfdf, importXfdf } from './xfdf';
import { summarizeComments } from './summarize';

// ── panel UI state (per document, not undoable) ─────────────────────────────

export type SortKey = 'page' | 'author' | 'date' | 'type' | 'color';
export interface Filters {
  types: string[];
  authors: string[];
  statuses: ReviewStatus[];
  colors: string[];
  pages: number[];
}
interface PanelDocState {
  query: string;
  filters: Filters;
  sort: SortKey;
  /** Collapsed group keys. */
  collapsed: Record<string, true>;
  /** Cards whose replies are shown. */
  expanded: Record<string, true>;
  allExpanded: boolean;
}
const NO_FILTERS: Filters = { types: [], authors: [], statuses: [], colors: [], pages: [] };
const DEFAULT_STATE: PanelDocState = { query: '', filters: NO_FILTERS, sort: 'page', collapsed: {}, expanded: {}, allExpanded: false };

const usePanelUi = create<{ docs: Record<DocId, PanelDocState> }>(() => ({ docs: {} }));
function panelState(docId: DocId): PanelDocState {
  return usePanelUi.getState().docs[docId] ?? DEFAULT_STATE;
}
function patchPanel(docId: DocId, patch: Partial<PanelDocState> | ((s: PanelDocState) => Partial<PanelDocState>)) {
  usePanelUi.setState((s) => {
    const cur = s.docs[docId] ?? DEFAULT_STATE;
    const p = typeof patch === 'function' ? patch(cur) : patch;
    return { docs: { ...s.docs, [docId]: { ...cur, ...p } } };
  });
}

export const SORT_LABEL: Record<SortKey, string> = { page: 'Page', author: 'Author', date: 'Date', type: 'Type', color: 'Color' };

// ── view model ──────────────────────────────────────────────────────────────

const timeOf = (o: PdfObject) => o.modifiedAt || o.createdAt;

function matches(it: Item, q: string, f: Filters): boolean {
  if (f.types.length && !f.types.includes(it.label)) return false;
  if (f.authors.length && !f.authors.includes(it.o.author)) return false;
  if (f.statuses.length && !f.statuses.includes(it.o.status ?? 'none')) return false;
  if (f.colors.length && !f.colors.includes(it.color)) return false;
  if (f.pages.length && !f.pages.includes(it.pageIndex)) return false;
  if (!q) return true;
  const hay = [it.o.contents ?? '', it.summary, it.o.author, it.label, ...(it.o.replies ?? []).flatMap((r) => [r.text, r.author])].join('\n').toLowerCase();
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((w) => hay.includes(w));
}

interface Group {
  key: string;
  title: string;
  color?: string;
  items: Item[];
}

function groupItems(items: Item[], sort: SortKey): Group[] {
  if (sort === 'date') return [{ key: 'all', title: '', items: [...items].sort((a, b) => timeOf(b.o) - timeOf(a.o)) }];
  const map = new Map<string, Group>();
  const keyOf = (it: Item): [string, string, string?] => {
    switch (sort) {
      case 'author':
        return [`a:${it.o.author}`, it.o.author || 'Unknown'];
      case 'type':
        return [`t:${it.label}`, it.label];
      case 'color':
        return [`c:${it.color}`, it.color === 'none' ? 'No color' : it.color.toUpperCase(), it.color === 'none' ? undefined : it.color];
      default:
        return [`p:${it.pageIndex}`, `Page ${it.pageLabel}`];
    }
  };
  for (const it of [...items].sort(byPosition)) {
    const [key, title, color] = keyOf(it);
    let g = map.get(key);
    if (!g) map.set(key, (g = { key, title, color, items: [] }));
    g.items.push(it);
  }
  const groups = [...map.values()];
  if (sort !== 'page') groups.sort((a, b) => a.title.localeCompare(b.title));
  return groups;
}

const filterCount = (f: Filters) => f.types.length + f.authors.length + f.statuses.length + f.colors.length + f.pages.length;
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'x';

// ── actions ─────────────────────────────────────────────────────────────────

export async function deleteAllComments(docId: DocId) {
  const doc = getDoc(docId);
  if (!doc || !canAnnotate(docId)) return;
  const all = commentItems(doc).map((i) => i.o);
  const deletable = all.filter((o) => !o.locked);
  if (!all.length) {
    actions.toast('There are no comments to delete.');
    return;
  }
  if (!deletable.length) {
    actions.toast('All comments are locked.', { kind: 'info' });
    return;
  }
  const replies = deletable.reduce((n, o) => n + (o.replies?.length ?? 0), 0);
  const ok = await confirmDialog({
    title: 'Delete all comments?',
    message: `${deletable.length} comment${deletable.length === 1 ? '' : 's'}${replies ? ` and ${replies} repl${replies === 1 ? 'y' : 'ies'}` : ''} will be removed from this document.${all.length > deletable.length ? ` ${all.length - deletable.length} locked comment${all.length - deletable.length === 1 ? ' stays' : 's stay'}.` : ''}`,
    confirmLabel: 'Delete all',
    danger: true,
    icon: Trash2,
  });
  if (!ok) return;
  commentsUi.closePopup();
  actions.deleteObjects(
    docId,
    deletable.map((o) => o.id),
    { label: 'Delete all comments' },
  );
  actions.toast(`Deleted ${deletable.length} comment${deletable.length === 1 ? '' : 's'}.`, { kind: 'success' });
}

export function toggleCommentsHidden(docId: DocId) {
  const hidden = !commentsUi.isHidden(docId);
  commentsUi.setHidden(docId, hidden);
  if (hidden) {
    commentsUi.closePopup();
    const d = getDoc(docId);
    if (d?.selection.some((id) => isCommentKind(d.objects[id]?.kind ?? ''))) actions.setSelection(docId, []);
  }
  actions.toast(hidden ? 'Comments are hidden.' : 'Comments are shown.');
}

export function panelMenuItems(docId: DocId, count: number): MenuEntry[] {
  const hidden = commentsUi.isHidden(docId);
  const editable = canAnnotate(docId, true);
  return [
    { id: 'comments-export-xfdf', label: 'Export comments to data file…', icon: FileDown, disabled: !count, description: 'XFDF', run: () => void exportXfdf(docId) },
    { id: 'comments-import-xfdf', label: 'Import comments data file…', icon: FileUp, disabled: !editable, run: () => void importXfdf(docId) },
    { id: 'comments-summarize', label: 'Create comment summary', icon: FileText, disabled: !count, run: () => void summarizeComments(docId) },
    'divider',
    { id: 'comments-toggle-hidden', label: hidden ? 'Show all comments' : 'Hide all comments', icon: hidden ? Eye : EyeOff, run: () => toggleCommentsHidden(docId) },
    'divider',
    { id: 'comments-delete-all', label: 'Delete all comments…', icon: Trash2, danger: true, disabled: !count || !editable, run: () => void deleteAllComments(docId) },
  ];
}

function startNote(docId: DocId) {
  if (!canAnnotate(docId)) return;
  if (commentsUi.isHidden(docId)) commentsUi.setHidden(docId, false);
  actions.setTool(TOOL.note);
  actions.toast('Click on the page to add a sticky note.');
}

// ── filter popover ──────────────────────────────────────────────────────────

function FilterSection<T extends string | number>({
  title,
  testid,
  options,
  selected,
  onChange,
}: {
  title: string;
  testid: string;
  options: { value: T; label: string; count: number; swatch?: string }[];
  selected: T[];
  onChange(next: T[]): void;
}) {
  if (options.length === 0) return null;
  return (
    <fieldset className="comments-filter-section">
      <legend className="comments-filter-title">{title}</legend>
      {options.map((o) => (
        <span key={String(o.value)} className="comments-filter-option" data-testid={`comments-filter-${testid}-${slug(String(o.value))}`}>
          <Checkbox
            checked={selected.includes(o.value)}
            onChange={(on) => onChange(on ? [...selected, o.value] : selected.filter((v) => v !== o.value))}
            label={
              <span className="comments-filter-label">
                {o.swatch && <span className="comments-swatch-dot" style={{ background: o.swatch }} />}
                <span>{o.label}</span>
                <span className="comments-filter-count">{o.count}</span>
              </span>
            }
          />
        </span>
      ))}
    </fieldset>
  );
}

function FilterPopover({ docId, items, anchor, onClose }: { docId: DocId; items: Item[]; anchor: HTMLElement | null; onClose(): void }) {
  const f = usePanelUi((s) => s.docs[docId]?.filters ?? NO_FILTERS);
  const set = (patch: Partial<Filters>) => patchPanel(docId, (s) => ({ filters: { ...s.filters, ...patch } }));
  const count = <K,>(key: (i: Item) => K) => {
    const m = new Map<K, number>();
    for (const i of items) m.set(key(i), (m.get(key(i)) ?? 0) + 1);
    return m;
  };
  const types = [...count((i) => i.label)].sort((a, b) => a[0].localeCompare(b[0]));
  const authors = [...count((i) => i.o.author)].sort((a, b) => a[0].localeCompare(b[0]));
  const statuses = count((i) => i.o.status ?? 'none');
  const colors = [...count((i) => i.color)];
  const pages = [...count((i) => i.pageIndex)].sort((a, b) => a[0] - b[0]);
  const pageLabel = new Map(items.map((i) => [i.pageIndex, i.pageLabel]));
  return (
    <Popover open anchor={anchor} onClose={onClose} placement="bottom-end" className="comments-filter-popover" aria-label="Filter comments">
      <div className="comments-filter" data-testid="comments-filter-popover">
        <div className="comments-filter-head">
          <span className="comments-filter-heading">Filter comments</span>
          <Button size="sm" variant="ghost" disabled={!filterCount(f)} onClick={() => set(NO_FILTERS)} data-testid="comments-filter-clear">
            Clear all
          </Button>
        </div>
        <div className="comments-filter-body">
          <FilterSection title="Type" testid="type" options={types.map(([v, c]) => ({ value: v, label: v, count: c }))} selected={f.types} onChange={(types) => set({ types })} />
          <FilterSection title="Author" testid="author" options={authors.map(([v, c]) => ({ value: v, label: v || 'Unknown', count: c }))} selected={f.authors} onChange={(authors) => set({ authors })} />
          <FilterSection
            title="Status"
            testid="status"
            options={STATUSES.filter((s) => statuses.has(s)).map((s) => ({ value: s, label: STATUS_LABEL[s], count: statuses.get(s)! }))}
            selected={f.statuses}
            onChange={(statuses) => set({ statuses })}
          />
          <FilterSection
            title="Color"
            testid="color"
            options={colors.map(([v, c]) => ({ value: v, label: v === 'none' ? 'No color' : v.toUpperCase(), count: c, swatch: v === 'none' ? undefined : v }))}
            selected={f.colors}
            onChange={(colors) => set({ colors })}
          />
          <FilterSection
            title="Page"
            testid="page"
            options={pages.map(([v, c]) => ({ value: v, label: `Page ${pageLabel.get(v) ?? v + 1}`, count: c }))}
            selected={f.pages}
            onChange={(pages) => set({ pages })}
          />
        </div>
        <div className="comments-filter-foot">
          <Button size="sm" variant="primary" onClick={onClose} data-testid="comments-filter-done">
            Done
          </Button>
        </div>
      </div>
    </Popover>
  );
}

// ── card ────────────────────────────────────────────────────────────────────

const INTERACTIVE = 'button, a, input, textarea, select, [role="menu"], [role="menuitem"], .comments-editor, .comments-replies';

function Card({
  docId,
  item,
  selected,
  expanded,
  editing,
  editable,
}: {
  docId: DocId;
  item: Item;
  selected: boolean;
  expanded: boolean;
  editing: boolean;
  editable: boolean;
}) {
  const o = item.o;
  const type = typeOf(o);
  const Icon = type?.icon ?? MessageSquare;
  const quote = item.summary && item.summary !== o.contents ? item.summary : '';
  const replies = o.replies ?? [];
  const canEdit = editable && !o.locked;
  const done = o.status === 'completed';
  const showThread = selected || expanded;
  const stopEdit = () => commentsUi.set({ cardEdit: null });
  const startEdit = () => canEdit && commentsUi.set({ cardEdit: { docId, objectId: o.id } });

  const onClick = (e: RMouseEvent) => {
    if ((e.target as Element).closest(INTERACTIVE)) return;
    revealComment(docId, o.id);
    // Already selected: the selection doesn't change, so show its pop-up again (like a click on
    // the comment on the page).
    const p = commentsUi.get().popup;
    if (selected && showsPopupOnSelect(o) && !commentsUi.isHidden(docId) && !(p && p.docId === docId && p.objectId === o.id)) {
      commentsUi.openPopup({ docId, objectId: o.id, focus: false, source: 'select' });
    }
  };
  const onKeyDown = (e: RKeyboardEvent<HTMLLIElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      revealComment(docId, o.id, { popup: true, focus: true });
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && canEdit) {
      e.preventDefault();
      e.stopPropagation();
      const next = (e.currentTarget.nextElementSibling ?? e.currentTarget.previousElementSibling) as HTMLElement | null;
      deleteComment(docId, o.id);
      next?.focus();
    }
  };

  return (
    <li
      className={clsx('comments-card', selected && 'is-selected', done && 'is-done', o.locked && 'is-locked')}
      data-testid="comments-card"
      data-obj-id={o.id}
      data-kind={o.kind}
      tabIndex={0}
      aria-label={`${item.label} by ${o.author}${o.contents ? `: ${o.contents}` : ''}`}
      aria-current={selected || undefined}
      onClick={onClick}
      onKeyDown={onKeyDown}
    >
      <div className="comments-card-head">
        <span className="comments-card-kind" style={{ color: item.color !== 'none' ? item.color : undefined }} title={item.label}>
          <Icon size={14} strokeWidth={2} />
        </span>
        <Avatar name={o.author} size={24} />
        <div className="comments-card-who">
          <span className="comments-card-authorline">
            <span className="comments-author" data-testid="comments-card-author">
              {o.author}
            </span>
            <StatusBadge status={o.status} testid="comments-card-status" />
          </span>
          <span className="comments-card-meta">
            <span data-testid="comments-card-type">{item.label}</span>
            <span aria-hidden="true">·</span>
            <TimeAgo t={timeOf(o)} testid="comments-card-time" />
          </span>
        </div>
        {o.locked && <Lock size={12} className="comments-card-lock" aria-label="Locked" />}
        <button
          type="button"
          className={clsx('comments-card-check', done && 'is-checked')}
          aria-pressed={done}
          aria-label={done ? 'Mark as not completed' : 'Mark as completed'}
          title={done ? 'Completed' : 'Mark as completed'}
          disabled={!editable}
          onClick={() => setStatus(docId, o.id, done ? 'none' : 'completed')}
          data-testid="comments-card-check"
        >
          <Check size={12} strokeWidth={3} />
        </button>
        <Dropdown
          label="Comment options"
          align="end"
          items={() =>
            commentMoreItems(o, docId, {
              onEdit: canEdit ? startEdit : undefined,
              onReply: editable
                ? () => {
                    revealComment(docId, o.id);
                    patchPanel(docId, (s) => ({ expanded: { ...s.expanded, [o.id]: true } }));
                  }
                : undefined,
            })
          }
          trigger={<IconButton icon={MoreHorizontal} size="sm" label="Comment options" data-testid="comments-card-more" />}
        />
      </div>
      {quote && (
        <blockquote className="comments-card-quote" data-testid="comments-card-quote">
          {quote}
        </blockquote>
      )}
      {editing ? (
        <CommentEditor
          testid="comments-card-editor"
          initial={o.contents ?? ''}
          autoFocus
          allowEmpty={!!o.contents}
          postLabel="Save"
          onCancel={stopEdit}
          onPost={(t) => {
            setContents(docId, o.id, t);
            stopEdit();
          }}
        />
      ) : o.contents ? (
        <div className="comments-card-contents" data-testid="comments-card-contents" onDoubleClick={startEdit}>
          {o.contents}
        </div>
      ) : (
        selected &&
        canEdit && (
          <button type="button" className="comments-card-add-text" onClick={startEdit} data-testid="comments-card-add-text">
            Add a comment…
          </button>
        )
      )}
      {showThread ? (
        <ReplyThread docId={docId} obj={o} testid="comments-card" showBox={selected && !editing} readOnly={!editable} />
      ) : (
        replies.length > 0 && (
          <button
            type="button"
            className="comments-card-replies-toggle"
            onClick={() => patchPanel(docId, (s) => ({ expanded: { ...s.expanded, [o.id]: true } }))}
            data-testid="comments-card-replies-toggle"
          >
            {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
          </button>
        )
      )}
      {expanded && !selected && replies.length > 0 && (
        <button
          type="button"
          className="comments-card-replies-toggle"
          onClick={() =>
            patchPanel(docId, (s) => {
              const next = { ...s.expanded };
              delete next[o.id];
              return { expanded: next, allExpanded: false };
            })
          }
          data-testid="comments-card-replies-hide"
        >
          Hide replies
        </button>
      )}
    </li>
  );
}

// ── panel ───────────────────────────────────────────────────────────────────

function useMinuteTick() {
  const [, set] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => set((n) => n + 1), 60_000);
    return () => window.clearInterval(t);
  }, []);
}

export function CommentsPanel({ docId }: { docId: DocId }) {
  const objects = useDoc(docId, (d) => d?.objects);
  const order = useDoc(docId, (d) => d?.order);
  const pages = useDoc(docId, (d) => d?.pages);
  const viewRotation = useDoc(docId, (d) => d?.view.rotation ?? 0);
  const selection = useDoc(docId, (d) => d?.selection);
  useDoc(docId, (d) => d?.pdfVersion);
  const objectTypes = useRegistry((s) => s.objectTypes);
  const st = usePanelUi((s) => s.docs[docId]) ?? DEFAULT_STATE;
  const hidden = useCommentsUi((s) => !!s.hidden[docId]);
  const cardEdit = useCommentsUi((s) => (s.cardEdit?.docId === docId ? s.cardEdit.objectId : null));
  const reveal = useCommentsUi((s) => (s.reveal?.docId === docId ? s.reveal : null));
  const userName = useApp((s) => s.prefs.userName);
  useMinuteTick();
  const editable = canAnnotate(docId, true);
  const listRef = useRef<HTMLDivElement>(null);
  const [filterEl, setFilterEl] = useState<HTMLElement | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);

  const items = useMemo(() => {
    const d = getDoc(docId);
    return d ? commentItems(d) : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, objects, order, pages, viewRotation, objectTypes, userName]);
  const visible = useMemo(() => items.filter((i) => matches(i, st.query.trim(), st.filters)), [items, st.query, st.filters]);
  const groups = useMemo(() => groupItems(visible, st.sort), [visible, st.sort]);
  const fc = filterCount(st.filters);
  const filtered = fc > 0 || !!st.query.trim();

  // Selecting a comment on the page highlights its card and scrolls it into view.
  const selectedId = selection && selection.length === 1 ? selection[0] : null;
  const selectedSet = useMemo(() => new Set(selection ?? []), [selection]);
  const scrollKey = selectedId ? `${selectedId}:${reveal?.objectId === selectedId ? reveal.nonce : ''}` : reveal ? `${reveal.objectId}:${reveal.nonce}` : '';
  useEffect(() => {
    const id = selectedId ?? reveal?.objectId;
    if (!id) return;
    const it = items.find((i) => i.o.id === id);
    if (!it) return;
    // Uncollapse its group so the card exists.
    const g = groups.find((x) => x.items.some((i) => i.o.id === id));
    if (g && st.collapsed[g.key]) {
      patchPanel(docId, (s) => {
        const collapsed = { ...s.collapsed };
        delete collapsed[g.key];
        return { collapsed };
      });
    }
    const raf = requestAnimationFrame(() => {
      const el = listRef.current?.querySelector<HTMLElement>(`.comments-card[data-obj-id="${CSS.escape(id)}"]`);
      el?.scrollIntoView({ block: 'nearest' });
    });
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollKey]);

  // Forget an inline edit whose object is gone.
  useEffect(() => {
    if (cardEdit && !objects?.[cardEdit]) commentsUi.set({ cardEdit: null });
  }, [cardEdit, objects]);

  const onListKeyDown = (e: RKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const t = e.target as HTMLElement;
    if (!t.classList.contains('comments-card')) return;
    e.preventDefault();
    const cards = Array.from(listRef.current?.querySelectorAll<HTMLElement>('.comments-card') ?? []);
    const i = cards.indexOf(t);
    const next = cards[i + (e.key === 'ArrowDown' ? 1 : -1)];
    if (!next) return;
    next.focus();
    const id = next.dataset.objId;
    if (id) revealComment(docId, id);
  };

  const toggleGroup = (key: string) =>
    patchPanel(docId, (s) => {
      const collapsed = { ...s.collapsed };
      if (collapsed[key]) delete collapsed[key];
      else collapsed[key] = true;
      return { collapsed };
    });

  const expandAll = () => {
    if (st.allExpanded) patchPanel(docId, { allExpanded: false, expanded: {} });
    else patchPanel(docId, { allExpanded: true, collapsed: {} });
  };

  const sortItems: MenuEntry[] = [
    { header: 'Sort by' },
    ...(Object.keys(SORT_LABEL) as SortKey[]).map((k) => ({
      id: `comments-sort-${k}`,
      label: SORT_LABEL[k],
      checked: st.sort === k,
      run: () => patchPanel(docId, { sort: k }),
    })),
  ];

  return (
    <div className="comments-panel" data-testid="comments-panel">
      <div className="comments-panel-toolbar">
        <div className="comments-search">
          <Search size={14} className="comments-search-icon" aria-hidden="true" />
          <input
            type="search"
            className="comments-search-input"
            placeholder="Search comments"
            aria-label="Search comments"
            value={st.query}
            onChange={(e) => patchPanel(docId, { query: e.currentTarget.value })}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && st.query) {
                e.stopPropagation();
                patchPanel(docId, { query: '' });
              }
            }}
            data-testid="comments-search"
          />
          {st.query && (
            <button type="button" className="comments-search-clear" aria-label="Clear search" onClick={() => patchPanel(docId, { query: '' })} data-testid="comments-search-clear">
              <X size={12} />
            </button>
          )}
        </div>
        <span ref={setFilterEl} className="comments-toolbar-anchor">
          <IconButton
            icon={ListFilter}
            size="sm"
            label={fc ? `Filter comments (${fc} active)` : 'Filter comments'}
            active={fc > 0 || filterOpen}
            badge={fc || null}
            onClick={() => setFilterOpen((v) => !v)}
            disabled={!items.length}
            data-testid="comments-filter"
          />
        </span>
        <Dropdown
          label="Sort comments"
          align="end"
          items={sortItems}
          trigger={<IconButton icon={ArrowUpDown} size="sm" label={`Sort by ${SORT_LABEL[st.sort].toLowerCase()}`} disabled={!items.length} data-testid="comments-sort" />}
        />
        <Dropdown
          label="Comments options"
          align="end"
          items={() => panelMenuItems(docId, items.length)}
          trigger={<IconButton icon={MoreHorizontal} size="sm" label="More options" data-testid="comments-panel-more" />}
        />
      </div>
      <div className="comments-panel-subbar">
        <Button size="sm" variant="secondary" icon={MessageSquarePlus} disabled={!editable} onClick={() => startNote(docId)} data-testid="comments-panel-add">
          Add comment
        </Button>
        <span className="comments-count" data-testid="comments-count">
          {filtered ? `${visible.length} of ${items.length}` : `${items.length} comment${items.length === 1 ? '' : 's'}`}
        </span>
        <span className="comments-spacer" />
        <IconButton
          icon={st.allExpanded ? ChevronsDownUp : ChevronsUpDown}
          size="sm"
          label={st.allExpanded ? 'Collapse all' : 'Expand all'}
          onClick={expandAll}
          disabled={!items.length}
          data-testid="comments-expand-all"
        />
      </div>
      {hidden && (
        <div className="comments-hidden-banner" data-testid="comments-hidden-banner">
          <EyeOff size={14} aria-hidden="true" />
          <span>Comments are hidden on the page.</span>
          <Button size="sm" variant="ghost" onClick={() => toggleCommentsHidden(docId)} data-testid="comments-show-hidden">
            Show
          </Button>
        </div>
      )}
      {filterOpen && items.length > 0 && <FilterPopover docId={docId} items={items} anchor={filterEl} onClose={() => setFilterOpen(false)} />}
      <div className="comments-list" ref={listRef} onKeyDown={onListKeyDown} data-testid="comments-list">
        {items.length === 0 ? (
          <EmptyState
            icon={MessageSquare}
            className="comments-empty"
            title="No comments yet"
            description={
              editable
                ? 'Add a sticky note, highlight text or draw on the page. Comments from you and other reviewers appear here.'
                : 'This document has no comments.'
            }
            action={
              editable ? (
                <Button size="sm" variant="primary" icon={MessageSquarePlus} onClick={() => startNote(docId)} data-testid="comments-empty-add">
                  Add comment
                </Button>
              ) : undefined
            }
          />
        ) : visible.length === 0 ? (
          <EmptyState
            compact
            icon={ListFilter}
            className="comments-empty"
            title="No comments match"
            description="Try a different search or clear the filters."
            action={
              <Button size="sm" variant="secondary" onClick={() => patchPanel(docId, { query: '', filters: NO_FILTERS })} data-testid="comments-clear-filters">
                Clear filters
              </Button>
            }
          />
        ) : (
          groups.map((g) => {
            const collapsed = !!st.collapsed[g.key];
            return (
              <section key={g.key} className="comments-group" data-testid="comments-group" data-group={g.key}>
                {g.title && (
                  <button
                    type="button"
                    className="comments-group-head"
                    aria-expanded={!collapsed}
                    onClick={() => toggleGroup(g.key)}
                    data-testid={`comments-group-${slug(g.key)}`}
                  >
                    {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                    {g.color && <span className="comments-swatch-dot" style={{ background: g.color }} />}
                    <span className="comments-group-title">{g.title}</span>
                    <span className="comments-group-count">{g.items.length}</span>
                  </button>
                )}
                {!collapsed && (
                  <ul className="comments-cards">
                    {g.items.map((it) => (
                      <Card
                        key={it.o.id}
                        docId={docId}
                        item={it}
                        selected={selectedSet.has(it.o.id)}
                        expanded={st.allExpanded || !!st.expanded[it.o.id]}
                        editing={cardEdit === it.o.id}
                        editable={editable}
                      />
                    ))}
                  </ul>
                )}
              </section>
            );
          })
        )}
      </div>
    </div>
  );
}

/** Keeps the panel state consistent when documents close. */
export function forgetPanelState(docId: DocId) {
  if (!usePanelUi.getState().docs[docId]) return;
  usePanelUi.setState((s) => {
    const docs = { ...s.docs };
    delete docs[docId];
    return { docs };
  });
}

export function setPanelSort(docId: DocId, sort: SortKey) {
  patchPanel(docId, { sort });
}

export function getPanelState(docId: DocId) {
  return panelState(docId);
}
