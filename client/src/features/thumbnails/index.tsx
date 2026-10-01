/**
 * Page thumbnails panel (right panel "Page thumbnails").
 *
 *  - lazily rendered thumbnails (viewer's PageThumbnail), page labels, S/M/L sizes (persisted)
 *  - current page highlighted and kept in view; click → go to page
 *  - multi-select: shift+click (range), cmd/ctrl+click (toggle), shift+arrows, mod+A
 *  - drag & drop reorder with an insertion indicator (engine.movePagesTo); dropping PDF/image files
 *    inserts them at the indicator (engine.insertFiles)
 *  - context menu: rotate, insert blank before/after, duplicate, extract (download), delete
 *  - Delete / Backspace deletes the selected pages (with confirmation)
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { CopyPlus, FileOutput, FilePlus2, GalleryVerticalEnd, RotateCcw, RotateCw, Trash2 } from 'lucide-react';
import type { DocId, PageId, PageInfo } from '@/core/types';
import { reg, registerPanel } from '@/core/registry';
import { actions, getDoc, useDoc } from '@/core/store';
import * as engine from '@/core/engine';
import { IconButton, SegmentedControl, matchShortcut, showContextMenu, type MenuEntry } from '@/core/ui';
import { baseName, downloadBlob, formatPageRanges, isMac } from '@/core/util';
import { PageThumbnail } from '@/core/viewer';
import { blankPageSizeFor, confirmDeletePages } from '@/core/viewer/contextMenus';
import './styles.css';

type SizeKey = 's' | 'm' | 'l';
const SIZES: Record<SizeKey, number> = { s: 84, m: 128, l: 196 };
const SIZE_KEY = 'pdfwizard.thumbnails.size';
const DRAG_MIME = 'application/x-pdfwizard-pages';

function loadSize(): SizeKey {
  try {
    const v = localStorage.getItem(SIZE_KEY);
    return v === 's' || v === 'm' || v === 'l' ? v : 'm';
  } catch {
    return 'm';
  }
}

async function guard(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    console.error(`[thumbnails] ${label} failed`, e);
    actions.toast(`${label} failed: ${e instanceof Error ? e.message : String(e)}`, { kind: 'error' });
  }
}

/** Thumbnail width so the page fits a size × 1.3·size box (landscape pages get the full width). */
function thumbWidth(page: PageInfo, size: number): number {
  const swap = page.rotation % 180 !== 0;
  const w = swap ? page.height : page.width;
  const h = swap ? page.width : page.height;
  return Math.max(24, Math.round(Math.min(size, (size * 1.3 * w) / h)));
}

/** Extract `indices` into a new PDF and download it. */
async function extractPages(docId: DocId, indices: number[]) {
  const d = getDoc(docId);
  if (!d || indices.length === 0) return;
  await guard('Extract pages', async () => {
    const bytes = await engine.extractPagesToBytes(docId, indices, { includeObjects: true });
    const suffix = indices.length === 1 ? `page ${indices[0] + 1}` : `pages ${formatPageRanges(indices).replace(/,\s*/g, '_')}`;
    downloadBlob(bytes, `${baseName(d.name)} (${suffix}).pdf`);
    actions.toast(indices.length === 1 ? 'Page extracted' : `${indices.length} pages extracted`, { kind: 'success' });
  });
}

interface DropTarget {
  /** Insertion gap in the current order (0..n): the dragged pages go before the page at `gap`. */
  gap: number;
  left: number;
  top: number;
  height: number;
}

/** New order (old indices) for moving `moving` into `gap`; null when nothing would change. */
export function reorderFor(count: number, moving: number[], gap: number): number[] | null {
  const set = new Set(moving);
  const sorted = [...set].sort((a, b) => a - b);
  const rest: number[] = [];
  for (let i = 0; i < count; i++) if (!set.has(i)) rest.push(i);
  const at = gap - sorted.filter((i) => i < gap).length;
  const order = [...rest.slice(0, at), ...sorted, ...rest.slice(at)];
  return order.every((v, i) => v === i) ? null : order;
}

function ThumbnailsPanel({ docId }: { docId: DocId }) {
  const pages = useDoc(docId, (d) => d?.pages);
  const currentPage = useDoc(docId, (d) => d?.view.currentPage ?? 0);
  const hasPdf = useDoc(docId, (d) => !!d?.pdf);
  const [sizeKey, setSizeKey] = useState<SizeKey>(loadSize);
  const size = SIZES[sizeKey];

  // Selection by page id so it survives reorder / rotation. Empty = "follow the current page".
  const [selected, setSelected] = useState<Set<PageId>>(() => new Set());
  const anchorRef = useRef<PageId | null>(null);
  const [focusIndex, setFocusIndex] = useState<number>(currentPage);
  const [drop, setDrop] = useState<DropTarget | null>(null);
  const dragRef = useRef<{ indices: number[] } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const lastNavRef = useRef<number>(-1);

  const count = pages?.length ?? 0;
  const indexOf = useMemo(() => {
    const m = new Map<PageId, number>();
    pages?.forEach((p, i) => m.set(p.id, i));
    return m;
  }, [pages]);

  // Drop ids of removed pages.
  useEffect(() => {
    setSelected((s) => {
      let changed = false;
      const next = new Set<PageId>();
      for (const id of s) {
        if (indexOf.has(id)) next.add(id);
        else changed = true;
      }
      return changed ? next : s;
    });
  }, [indexOf]);

  const selectedIndices = useMemo(() => {
    const out: number[] = [];
    for (const id of selected) {
      const i = indexOf.get(id);
      if (i !== undefined) out.push(i);
    }
    if (out.length === 0 && count > 0) out.push(Math.min(currentPage, count - 1));
    return out.sort((a, b) => a - b);
  }, [selected, indexOf, currentPage, count]);
  const selectedSet = useMemo(() => new Set(selectedIndices), [selectedIndices]);

  // Follow the current page: scrolling the document resets a single selection, and keeps the
  // current thumbnail in view.
  useEffect(() => {
    setSelected((s) => (s.size <= 1 ? (s.size === 0 ? s : new Set()) : s));
    setFocusIndex(currentPage);
    const list = listRef.current;
    const el = list?.querySelector<HTMLElement>(`.thumbnails-item[data-page-index="${currentPage}"]`);
    if (!list || !el) return;
    const top = el.offsetTop; // .thumbnails-list is the offsetParent
    const bottom = top + el.offsetHeight;
    const margin = 8;
    if (top < list.scrollTop + margin) list.scrollTo({ top: Math.max(0, top - margin), behavior: lastNavRef.current === currentPage ? 'smooth' : 'auto' });
    else if (bottom > list.scrollTop + list.clientHeight - margin) list.scrollTo({ top: bottom - list.clientHeight + margin, behavior: lastNavRef.current === currentPage ? 'smooth' : 'auto' });
  }, [currentPage]);

  // Initial position (panel opened on a later page).
  useLayoutEffect(() => {
    const list = listRef.current;
    const el = list?.querySelector<HTMLElement>(`.thumbnails-item[data-page-index="${currentPage}"]`);
    if (list && el) list.scrollTop = Math.max(0, el.offsetTop - 8);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const changeSize = (k: SizeKey) => {
    setSizeKey(k);
    try {
      localStorage.setItem(SIZE_KEY, k);
    } catch {
      /* ignore */
    }
  };

  const goTo = useCallback(
    (i: number) => {
      lastNavRef.current = i;
      actions.goToPage(docId, i);
    },
    [docId],
  );

  const selectOnly = (i: number) => {
    const p = pages?.[i];
    if (!p) return;
    anchorRef.current = p.id;
    setSelected(new Set([p.id]));
  };

  const selectRange = (from: number, to: number, additive: boolean) => {
    if (!pages) return;
    const [a, b] = from <= to ? [from, to] : [to, from];
    setSelected((s) => {
      const next = additive ? new Set(s) : new Set<PageId>();
      for (let k = a; k <= b; k++) next.add(pages[k].id);
      return next;
    });
  };

  const onItemClick = (e: MouseEvent, i: number) => {
    if (!pages) return;
    const p = pages[i];
    setFocusIndex(i);
    if (e.shiftKey) {
      const anchor = anchorRef.current ? indexOf.get(anchorRef.current) : undefined;
      selectRange(anchor ?? currentPage, i, e.metaKey || e.ctrlKey);
      return;
    }
    if (isMac ? e.metaKey : e.ctrlKey) {
      anchorRef.current = p.id;
      setSelected((s) => {
        const next = new Set(s.size ? s : [pages[Math.min(currentPage, pages.length - 1)].id]);
        if (next.has(p.id)) next.delete(p.id);
        else next.add(p.id);
        return next;
      });
      return;
    }
    selectOnly(i);
    goTo(i);
  };

  const targetsFor = (i: number) => (selectedSet.has(i) ? selectedIndices : [i]);

  const deleteIndices = (indices: number[]) => {
    void confirmDeletePages(docId, indices).then(() => listRef.current?.focus({ preventScroll: true }));
  };

  const menuFor = (i: number): MenuEntry[] => {
    const targets = targetsFor(i);
    const n = targets.length;
    const many = n > 1;
    const first = targets[0];
    const last = targets[targets.length - 1];
    return [
      { id: 'thumbnails.rotateCw', label: many ? `Rotate ${n} pages clockwise` : 'Rotate clockwise', icon: RotateCw, run: () => guard('Rotate pages', () => engine.rotatePages(docId, targets, 90)) },
      {
        id: 'thumbnails.rotateCcw',
        label: many ? `Rotate ${n} pages counterclockwise` : 'Rotate counterclockwise',
        icon: RotateCcw,
        run: () => guard('Rotate pages', () => engine.rotatePages(docId, targets, -90)),
      },
      'divider',
      { id: 'thumbnails.insertBefore', label: 'Insert blank page before', icon: FilePlus2, run: () => guard('Insert page', () => engine.insertBlankPages(docId, first, 1, blankPageSizeFor(docId, first))) },
      { id: 'thumbnails.insertAfter', label: 'Insert blank page after', icon: FilePlus2, run: () => guard('Insert page', () => engine.insertBlankPages(docId, last + 1, 1, blankPageSizeFor(docId, last))) },
      { id: 'thumbnails.duplicate', label: many ? `Duplicate ${n} pages` : 'Duplicate page', icon: CopyPlus, run: () => guard('Duplicate pages', () => engine.duplicatePages(docId, targets)) },
      { id: 'thumbnails.extract', label: many ? `Extract ${n} pages` : 'Extract page', icon: FileOutput, run: () => extractPages(docId, targets) },
      'divider',
      {
        id: 'thumbnails.delete',
        label: many ? `Delete ${n} pages` : 'Delete page',
        icon: Trash2,
        danger: true,
        shortcut: 'delete',
        disabled: n >= count,
        run: () => deleteIndices(targets),
      },
    ];
  };

  const onContextMenu = (e: MouseEvent, i: number) => {
    e.preventDefault();
    e.stopPropagation();
    if (!selectedSet.has(i)) selectOnly(i);
    setFocusIndex(i);
    // Feature contributions (target 'thumbnail') first, then the core page actions.
    const extra: MenuEntry[] = [];
    for (const c of reg.get().contextMenus) {
      if (c.target !== 'thumbnail') continue;
      try {
        const items = c.items({ docId, pageIndex: i });
        if (items.length) extra.push(...items, 'divider');
      } catch (err) {
        console.error(`[thumbnails] context menu contribution "${c.id}" failed`, err);
      }
    }
    // [organize] its "Extract to a new file…" (dialog with the extract options) replaces the quick "Extract page" download.
    const hasId = (id: string) => extra.some((x) => typeof x === 'object' && 'id' in x && x.id === id);
    const own = hasId('organize-thumb-extract') ? menuFor(i).filter((x) => !(typeof x === 'object' && 'id' in x && x.id === 'thumbnails.extract')) : menuFor(i);
    showContextMenu(e, [...extra, ...own]);
  };

  // ── keyboard ──
  const columns = () => {
    const list = listRef.current;
    const items = list?.querySelectorAll<HTMLElement>('.thumbnails-item');
    if (!items || items.length === 0) return 1;
    const top = items[0].offsetTop;
    let c = 0;
    for (const it of items) {
      if (Math.abs(it.offsetTop - top) > 2) break;
      c++;
    }
    return Math.max(1, c);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!pages || count === 0) return;
    const ne = e.nativeEvent;
    const consume = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (matchShortcut(ne, 'mod+a')) {
      consume();
      setSelected(new Set(pages.map((p) => p.id)));
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && !e.metaKey && !e.ctrlKey && !e.altKey) {
      consume();
      if (selectedIndices.length < count) deleteIndices(selectedIndices);
      else actions.toast('A document must keep at least one page.', { kind: 'warning' });
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      consume();
      selectOnly(focusIndex);
      goTo(focusIndex);
      return;
    }
    if (e.key === 'Escape' && selected.size > 1) {
      consume();
      setSelected(new Set());
      return;
    }
    const cols = columns();
    const step: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -cols, ArrowDown: cols, PageUp: -cols * 3, PageDown: cols * 3 };
    let next: number | null = null;
    if (e.key in step && !e.metaKey && !e.ctrlKey && !e.altKey) next = Math.min(count - 1, Math.max(0, focusIndex + step[e.key]));
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = count - 1;
    if (next === null) return;
    consume();
    setFocusIndex(next);
    if (e.shiftKey) {
      const anchor = anchorRef.current ? indexOf.get(anchorRef.current) : undefined;
      if (anchor === undefined) anchorRef.current = pages[focusIndex].id;
      selectRange(anchor ?? focusIndex, next, false);
      listRef.current?.querySelector<HTMLElement>(`.thumbnails-item[data-page-index="${next}"]`)?.scrollIntoView({ block: 'nearest' });
    } else {
      selectOnly(next);
      goTo(next);
    }
  };

  // ── drag & drop ──
  const computeDrop = (clientX: number, clientY: number): DropTarget | null => {
    const list = listRef.current;
    if (!list) return null;
    const items = [...list.querySelectorAll<HTMLElement>('.thumbnails-item')];
    if (items.length === 0) return null;
    const lr = list.getBoundingClientRect();
    const toLocal = (r: DOMRect) => ({ left: r.left - lr.left + list.scrollLeft, top: r.top - lr.top + list.scrollTop, width: r.width, height: r.height });
    // Group items into rows.
    const rects = items.map((el) => el.getBoundingClientRect());
    let rowStart = 0;
    for (let i = 0; i <= rects.length; i++) {
      const newRow = i === rects.length || (i > rowStart && Math.abs(rects[i].top - rects[rowStart].top) > 2);
      if (!newRow) continue;
      const rowEnd = i - 1;
      const top = Math.min(...rects.slice(rowStart, rowEnd + 1).map((r) => r.top));
      const bottom = Math.max(...rects.slice(rowStart, rowEnd + 1).map((r) => r.bottom));
      const isLast = i === rects.length;
      const gapBelow = isLast ? Infinity : (rects[i].top - bottom) / 2;
      if (clientY <= bottom + gapBelow || isLast) {
        let gap = rowEnd + 1;
        for (let k = rowStart; k <= rowEnd; k++) {
          if (clientX < rects[k].left + rects[k].width / 2) {
            gap = k;
            break;
          }
        }
        const ref = gap <= rowEnd ? toLocal(rects[gap]) : toLocal(rects[rowEnd]);
        const left = gap <= rowEnd ? ref.left - 4 : ref.left + ref.width + 4;
        const rowTop = top - lr.top + list.scrollTop;
        return { gap, left, top: rowTop, height: bottom - top };
      }
      rowStart = i;
    }
    return null;
  };

  const autoScroll = (clientY: number) => {
    const list = listRef.current;
    if (!list) return;
    const r = list.getBoundingClientRect();
    const edge = 40;
    if (clientY < r.top + edge) list.scrollTop -= Math.ceil((r.top + edge - clientY) / 3);
    else if (clientY > r.bottom - edge) list.scrollTop += Math.ceil((clientY - (r.bottom - edge)) / 3);
  };

  const onDragStart = (e: DragEvent<HTMLDivElement>, i: number) => {
    if (!pages) return;
    const indices = selectedSet.has(i) ? selectedIndices : [i];
    if (!selectedSet.has(i)) selectOnly(i);
    dragRef.current = { indices };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ docId, indices }));
    e.dataTransfer.setData('text/plain', `Pages ${formatPageRanges(indices)}`);
    if (indices.length > 1) {
      const ghost = document.createElement('div');
      ghost.className = 'thumbnails-drag-ghost';
      ghost.textContent = `${indices.length} pages`;
      document.body.appendChild(ghost);
      e.dataTransfer.setDragImage(ghost, 12, 12);
      setTimeout(() => ghost.remove(), 0);
    }
  };

  const isOurDrag = (e: DragEvent) => !!dragRef.current && e.dataTransfer.types.includes(DRAG_MIME);
  const isFileDrag = (e: DragEvent) => !dragRef.current && e.dataTransfer.types.includes('Files');

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    const ours = isOurDrag(e);
    if (!ours && !isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = ours ? 'move' : 'copy';
    autoScroll(e.clientY);
    const t = computeDrop(e.clientX, e.clientY);
    setDrop((prev) => (prev && t && prev.gap === t.gap && prev.left === t.left && prev.top === t.top ? prev : t));
  };

  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    const list = listRef.current;
    if (list && e.relatedTarget instanceof Node && list.contains(e.relatedTarget)) return;
    setDrop(null);
  };

  const endDrag = () => {
    dragRef.current = null;
    setDrop(null);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    const target = computeDrop(e.clientX, e.clientY) ?? drop;
    const drag = dragRef.current;
    if (drag && isOurDrag(e)) {
      e.preventDefault();
      e.stopPropagation();
      endDrag();
      if (!target) return;
      if (!reorderFor(count, drag.indices, target.gap)) return;
      void guard('Move pages', () => engine.movePagesTo(docId, drag.indices, target.gap));
      return;
    }
    if (isFileDrag(e) && e.dataTransfer.files.length) {
      e.preventDefault();
      e.stopPropagation();
      endDrag();
      const files = [...e.dataTransfer.files];
      void guard('Insert files', () => engine.insertFiles(docId, target?.gap ?? count, files));
      return;
    }
    endDrag();
  };

  if (!pages) return null;

  const many = selectedIndices.length > 1;
  const summary = many ? `${selectedIndices.length} of ${count} selected` : `${count} ${count === 1 ? 'page' : 'pages'}`;

  return (
    <div className="thumbnails" data-testid="thumbnails-panel" style={{ ['--thumb-size' as string]: `${size}px` }}>
      <div className="thumbnails-toolbar">
        <span className="thumbnails-summary" aria-live="polite" title={many ? `${selectedIndices.length} of ${count} pages selected` : undefined}>
          {summary}
        </span>
        <span className="thumbnails-tools">
          <IconButton size="sm" icon={RotateCcw} label="Rotate counterclockwise" onClick={() => guard('Rotate pages', () => engine.rotatePages(docId, selectedIndices, -90))} disabled={!hasPdf} />
          <IconButton size="sm" icon={RotateCw} label="Rotate clockwise" onClick={() => guard('Rotate pages', () => engine.rotatePages(docId, selectedIndices, 90))} disabled={!hasPdf} />
          <IconButton size="sm" icon={Trash2} label={many ? 'Delete selected pages' : 'Delete page'} onClick={() => deleteIndices(selectedIndices)} disabled={!hasPdf || selectedIndices.length >= count} />
        </span>
        <SegmentedControl
          size="sm"
          label="Thumbnail size"
          value={sizeKey}
          onChange={changeSize}
          options={[
            { value: 's', label: 'S', title: 'Small thumbnails' },
            { value: 'm', label: 'M', title: 'Medium thumbnails' },
            { value: 'l', label: 'L', title: 'Large thumbnails' },
          ]}
        />
      </div>
      <div
        ref={listRef}
        className={`thumbnails-list${drop ? ' is-dropping' : ''}`}
        role="listbox"
        aria-label="Pages"
        aria-multiselectable
        aria-activedescendant={`thumb-${docId}-${focusIndex}`}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        data-no-shortcuts
      >
        {pages.map((p, i) => {
          const isSel = selectedSet.has(i);
          const isCur = i === currentPage;
          const label = p.label && p.label !== String(i + 1) ? `${p.label} (${i + 1})` : String(i + 1);
          return (
            <div
              key={p.id}
              id={`thumb-${docId}-${i}`}
              className={`thumbnails-item${isSel ? ' is-selected' : ''}${isCur ? ' is-current' : ''}${i === focusIndex ? ' is-focused' : ''}`}
              role="option"
              aria-selected={isSel}
              aria-current={isCur ? 'page' : undefined}
              aria-label={`Page ${label}`}
              title={`Page ${label} of ${count}`}
              data-testid="thumbnail"
              data-page-index={i}
              data-page-id={p.id}
              draggable
              onClick={(e) => onItemClick(e, i)}
              onContextMenu={(e) => onContextMenu(e, i)}
              onDragStart={(e) => onDragStart(e, i)}
              onDragEnd={endDrag}
            >
              <div className="thumbnails-frame">
                <PageThumbnail docId={docId} pageIndex={i} width={thumbWidth(p, size)} />
              </div>
              <div className="thumbnails-label">{label}</div>
            </div>
          );
        })}
        {drop && <div className="thumbnails-drop-indicator" style={{ left: drop.left, top: drop.top, height: drop.height }} aria-hidden />}
      </div>
    </div>
  );
}

registerPanel({
  id: 'thumbnails',
  label: 'Page thumbnails',
  order: 10,
  icon: GalleryVerticalEnd,
  Component: ThumbnailsPanel,
});
