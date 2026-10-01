/**
 * Virtualized page grid of the organize tools. Only the visible rows (plus overscan) mount, so a
 * 300-page document scrolls smoothly; geometry is purely arithmetic (see layout.ts).
 *
 * Selection: click, Shift-click range, Cmd/Ctrl-click toggle, marquee drag on the background,
 * Cmd/Ctrl+A, Esc. Keyboard: arrows / Home / End / PageUp / PageDown move the focus ring
 * (Shift extends, Cmd/Ctrl moves the focus only, Space toggles), Enter opens the page, Alt+arrows
 * move the selected pages. Editing grids also support drag & drop reordering (and dropping files
 * or pages of other documents), hover actions, "+" insert gaps and the page context menu.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import clsx from 'clsx';
import {
  ClipboardPaste, Copy, CopyPlus, Eye, FileInput, FilePlus2, FileOutput, FolderOpen, ListOrdered, MoreHorizontal, Plus, Replace, RotateCcw, RotateCw,
  Scissors, Trash2,
} from 'lucide-react';
import type { DocId, PageId, PageInfo } from '@/core/types';
import { useDoc } from '@/core/store';
import { useRegistry } from '@/core/registry';
import { IconButton, Spinner, matchShortcut, showContextMenu, type MenuEntry } from '@/core/ui';
import { PageThumbnail } from '@/core/viewer';
import { fitWidth } from '../SourceThumb';
import { organize, useOrganize, useSelection } from '../store';
import * as ops from '../ops';
import { isMod, readOnlyReason } from '../util';
import { OWN_MENU_IDS } from '../menuIds';
import { cellBox, cellsInRect, frameBox, gapAt, gapX, gridMetrics, scrollToReveal, visibleRows, GAP_X, type GapHit, type GridMetrics } from './layout';

export interface SplitDecoration {
  /** Part index of every page. */
  partOf: number[];
  /** Gaps (page indices) where a new part starts. */
  starts: Set<number>;
  /** Click on the gap before page `gap` toggles a split point there. */
  onToggle?(gap: number): void;
}

export interface PageGridProps {
  docId: DocId;
  /** Drag & drop, hover actions, insert gaps and editing keys (default true). */
  editable?: boolean;
  split?: SplitDecoration;
  ariaLabel?: string;
}

interface DropState {
  gap: number;
  x: number;
  y: number;
  h: number;
}

interface Marquee {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  base: PageId[];
  moved: boolean;
  additive: boolean;
  clientY: number;
}

const PART_COLORS = 6;

export function pageLabel(p: PageInfo, i: number): { main: string; sub: string | null } {
  if (p.label && p.label !== String(i + 1)) return { main: p.label, sub: String(i + 1) };
  return { main: String(i + 1), sub: null };
}

function shown(p: PageInfo) {
  return p.rotation % 180 !== 0 ? { w: p.height, h: p.width } : { w: p.width, h: p.height };
}

/** Drag image: up to three stacked page images and a count badge. */
function dragGhost(cell: HTMLElement | null, count: number): HTMLElement {
  const el = document.createElement('div');
  el.className = 'organize-drag-ghost';
  const img = cell?.querySelector('img');
  const w = 72;
  for (let k = Math.min(3, count) - 1; k >= 0; k--) {
    const sheet = document.createElement('div');
    sheet.className = 'organize-drag-sheet';
    sheet.style.transform = `translate(${k * 5}px, ${k * 5}px)`;
    if (img && k === 0) {
      const c = img.cloneNode() as HTMLImageElement;
      c.style.width = `${w}px`;
      sheet.appendChild(c);
    } else {
      sheet.style.width = `${w}px`;
      sheet.style.height = `${Math.round(w * 1.3)}px`;
    }
    el.appendChild(sheet);
  }
  if (count > 1) {
    const b = document.createElement('span');
    b.className = 'organize-drag-count';
    b.textContent = String(count);
    el.appendChild(b);
  }
  document.body.appendChild(el);
  return el;
}

export function PageGrid({ docId, editable = true, split, ariaLabel = 'Pages' }: PageGridProps) {
  const pages = useDoc(docId, (d) => d?.pages);
  const loading = useDoc(docId, (d) => !!d?.loading && !d?.pages.length);
  const docName = useDoc(docId, (d) => d?.name ?? '');
  const size = useOrganize((s) => s.thumbSize);
  const reveal = useOrganize((s) => s.reveal);
  const sel = useSelection(docId);
  const readOnly = !!readOnlyReason(docId);
  const canEdit = editable && !readOnly;
  /** The scroller is mounted (not the loading placeholder). */
  const ready = !loading && !!pages;

  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ w: 0, h: 0 });
  const [scrollTop, setScrollTop] = useState(0);
  const [drop, setDrop] = useState<DropState | null>(null);
  const [marquee, setMarquee] = useState<Marquee | null>(null);
  const [kbd, setKbd] = useState(false);
  const [dragging, setDragging] = useState<Set<PageId> | null>(null);
  const drag = useRef<{ docId: DocId; indices: number[] } | null>(null);
  const marqueeRef = useRef<Marquee | null>(null);
  const autoScroll = useRef<number | null>(null);

  const count = pages?.length ?? 0;
  const m = useMemo(() => gridMetrics(view.w, count, size), [view.w, count, size]);
  const mRef = useRef(m);
  mRef.current = m;

  const indexOf = useMemo(() => new Map((pages ?? []).map((p, i) => [p.id, i] as [PageId, number])), [pages]);
  const selSet = useMemo(() => new Set(sel.ids), [sel.ids]);
  const selIdx = useMemo(() => {
    const out: number[] = [];
    for (const id of sel.ids) {
      const i = indexOf.get(id);
      if (i !== undefined) out.push(i);
    }
    return out.sort((a, b) => a - b);
  }, [indexOf, sel.ids]);
  const focusIndex = sel.focus ? (indexOf.get(sel.focus) ?? -1) : -1;

  // ── measuring & scrolling ──────────────────────────────────────────────────

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const measure = () => setView({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ready]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        setScrollTop(el.scrollTop);
      });
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      el.removeEventListener('scroll', onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [ready]);

  // Keep the top-left visible page in place when the thumbnail size or the column count changes.
  const prevM = useRef<GridMetrics | null>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    const old = prevM.current;
    prevM.current = m;
    if (!el || !old || !old.count || (old.cols === m.cols && old.cellH === m.cellH)) return;
    const pitch = old.cellH + 18;
    const row = Math.max(0, Math.floor((el.scrollTop - 20) / pitch));
    const anchor = Math.min(m.count - 1, row * old.cols);
    if (anchor < 0) return;
    const offset = cellBox(old, anchor).y - el.scrollTop;
    el.scrollTop = Math.max(0, cellBox(m, anchor).y - offset);
    setScrollTop(el.scrollTop);
  }, [m]);

  const revealIndex = useCallback((i: number) => {
    const el = scroller.current;
    if (!el || i < 0) return;
    const top = scrollToReveal(mRef.current, i, el.scrollTop, el.clientHeight);
    if (top !== null) {
      el.scrollTop = top;
      setScrollTop(top);
    }
  }, []);

  useEffect(() => {
    if (!reveal || reveal.docId !== docId) return;
    const i = indexOf.get(reveal.id);
    if (i !== undefined) requestAnimationFrame(() => revealIndex(i));
    // Only react to new requests.
  }, [reveal?.nonce, ready]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cmd/Ctrl + wheel changes the thumbnail size (non-passive: the page must not zoom).
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!isMod(e)) return;
      e.preventDefault();
      const cur = useOrganize.getState().thumbSize;
      organize.setThumbSize(cur * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [ready]);

  useEffect(() => () => {
    if (autoScroll.current) cancelAnimationFrame(autoScroll.current);
  }, []);

  // Safety net: a drag that ends outside the window may not deliver dragend to the source.
  useEffect(() => {
    if (!dragging) return;
    const end = () => {
      drag.current = null;
      setDragging(null);
      setDrop(null);
    };
    window.addEventListener('mousemove', end);
    window.addEventListener('drop', end, true);
    return () => {
      window.removeEventListener('mousemove', end);
      window.removeEventListener('drop', end, true);
    };
  }, [dragging]);

  // ── selection helpers ──────────────────────────────────────────────────────

  const idsOf = (indices: number[]) => indices.map((i) => pages![i].id);
  const selectOnly = (i: number) => organize.setSelection(docId, { ids: [pages![i].id], anchor: pages![i].id, focus: pages![i].id });
  const selectRange = (from: number, to: number, additive: boolean, focus: number) => {
    const [a, b] = from <= to ? [from, to] : [to, from];
    const range = idsOf(Array.from({ length: b - a + 1 }, (_, k) => a + k));
    const ids = additive ? [...new Set([...sel.ids, ...range])] : range;
    organize.setSelection(docId, { ids, focus: pages![focus].id, anchor: sel.anchor ?? pages![from].id });
  };
  const toggle = (i: number) => {
    const id = pages![i].id;
    const ids = selSet.has(id) ? sel.ids.filter((x) => x !== id) : [...sel.ids, id];
    organize.setSelection(docId, { ids, anchor: id, focus: id });
  };
  const targetsFor = (i: number) => (pages && selSet.has(pages[i].id) ? selIdx : [i]);

  // ── mouse on cells ─────────────────────────────────────────────────────────

  const onCellMouseDown = (e: MouseEvent, i: number) => {
    setKbd(false);
    scroller.current?.focus({ preventScroll: true });
    if (e.button !== 0 || e.shiftKey || isMod(e)) return;
    if (!selSet.has(pages![i].id)) selectOnly(i);
  };

  const onCellClick = (e: MouseEvent, i: number) => {
    if (!pages) return;
    if (e.shiftKey) {
      const a = sel.anchor ? indexOf.get(sel.anchor) : undefined;
      selectRange(a ?? i, i, isMod(e), i);
      return;
    }
    if (isMod(e)) {
      toggle(i);
      return;
    }
    selectOnly(i);
  };

  // ── context menu ───────────────────────────────────────────────────────────

  const menuFor = (i: number): MenuEntry[] => {
    const t = targetsFor(i);
    const n = t.length;
    const many = n > 1;
    const first = t[0];
    const last = t[t.length - 1];
    const clip = ops.clipIndices();
    const ro = !canEdit;
    if (!editable) {
      return [{ id: 'organize-menu-open', label: 'Open in viewer', icon: Eye, shortcut: 'enter', run: () => ops.openInViewer(docId, i) }];
    }
    const extra: MenuEntry[] = [];
    for (const c of useRegistry.getState().contextMenus) {
      if (c.target !== 'thumbnail' || OWN_MENU_IDS.has(c.id)) continue;
      try {
        const items = c.items({ docId, pageIndex: i });
        if (items.length) extra.push(...items, 'divider');
      } catch (err) {
        console.warn(`[organize] context menu contribution "${c.id}" failed`, err);
      }
    }
    return [
      { id: 'organize-menu-rotate-ccw', label: many ? `Rotate ${n} pages counterclockwise` : 'Rotate counterclockwise', icon: RotateCcw, disabled: ro, run: () => ops.rotate(docId, t, -90) },
      { id: 'organize-menu-rotate-cw', label: many ? `Rotate ${n} pages clockwise` : 'Rotate clockwise', icon: RotateCw, disabled: ro, run: () => ops.rotate(docId, t, 90) },
      'divider',
      {
        id: 'organize-menu-insert',
        label: 'Insert',
        icon: FilePlus2,
        disabled: ro,
        submenu: [
          { id: 'organize-menu-blank-before', label: 'Blank page before', icon: FilePlus2, run: () => ops.insertBlankNow(docId, first) },
          { id: 'organize-menu-blank-after', label: 'Blank page after', icon: FilePlus2, run: () => ops.insertBlankNow(docId, last + 1) },
          'divider',
          { id: 'organize-menu-file-after', label: 'From file…', icon: FileInput, run: () => ops.insertFromFile(docId, last + 1) },
          { id: 'organize-menu-library-after', label: 'From your files…', icon: FolderOpen, run: () => ops.insertFromLibrary(docId, last + 1) },
        ],
      },
      { id: 'organize-menu-cut', label: 'Cut', icon: Scissors, shortcut: 'mod+x', disabled: ro, run: () => ops.copyPages(docId, t, 'cut') },
      { id: 'organize-menu-copy', label: 'Copy', icon: Copy, shortcut: 'mod+c', disabled: ro, run: () => ops.copyPages(docId, t, 'copy') },
      { id: 'organize-menu-paste-before', label: 'Paste before', icon: ClipboardPaste, disabled: ro || !clip, run: () => ops.pastePages(docId, first) },
      { id: 'organize-menu-paste-after', label: 'Paste after', icon: ClipboardPaste, shortcut: 'mod+v', disabled: ro || !clip, run: () => ops.pastePages(docId, last + 1) },
      { id: 'organize-menu-duplicate', label: many ? `Duplicate ${n} pages` : 'Duplicate', icon: CopyPlus, shortcut: 'mod+d', disabled: ro, run: () => ops.duplicate(docId, t) },
      'divider',
      { id: 'organize-menu-extract', label: 'Extract pages…', icon: FileOutput, disabled: ro, run: () => ops.extract(docId, t) },
      { id: 'organize-menu-replace', label: 'Replace pages…', icon: Replace, disabled: ro, run: () => ops.replace(docId, t) },
      { id: 'organize-menu-labels', label: 'Number pages…', icon: ListOrdered, disabled: ro, run: () => ops.pageLabels(docId, t) },
      'divider',
      ...extra,
      { id: 'organize-menu-open', label: 'Open in viewer', icon: Eye, shortcut: 'enter', run: () => ops.openInViewer(docId, i) },
      'divider',
      {
        id: 'organize-menu-delete',
        label: many ? `Delete ${n} pages` : 'Delete',
        icon: Trash2,
        danger: true,
        shortcut: 'delete',
        disabled: ro || n >= count,
        run: () => ops.deletePages(docId, t),
      },
    ];
  };

  const onCellContextMenu = (e: MouseEvent, i: number) => {
    e.preventDefault();
    if (!selSet.has(pages![i].id)) selectOnly(i);
    else organize.setSelection(docId, { focus: pages![i].id });
    showContextMenu(e, menuFor(i));
  };

  // ── marquee selection on the background ────────────────────────────────────

  const contentPoint = (clientX: number, clientY: number) => {
    const el = scroller.current!;
    const r = el.getBoundingClientRect();
    return { x: clientX - r.left + el.scrollLeft, y: clientY - r.top + el.scrollTop };
  };

  const applyMarquee = (mq: Marquee) => {
    if (!pages) return;
    const hit = cellsInRect(mRef.current, mq.ax, mq.ay, mq.bx, mq.by);
    const ids = mq.additive ? [...new Set([...mq.base, ...idsOf(hit)])] : idsOf(hit);
    organize.setSelection(docId, { ids, anchor: ids[0] ?? null, focus: hit.length ? pages[hit[hit.length - 1]].id : sel.focus });
  };

  const stopAutoScroll = () => {
    if (autoScroll.current) cancelAnimationFrame(autoScroll.current);
    autoScroll.current = null;
  };

  const runAutoScroll = () => {
    const el = scroller.current;
    const mq = marqueeRef.current;
    if (!el || !mq) return stopAutoScroll();
    const r = el.getBoundingClientRect();
    const edge = 40;
    let dy = 0;
    if (mq.clientY < r.top + edge) dy = -Math.ceil((r.top + edge - mq.clientY) / 3);
    else if (mq.clientY > r.bottom - edge) dy = Math.ceil((mq.clientY - (r.bottom - edge)) / 3);
    if (dy) {
      const before = el.scrollTop;
      el.scrollTop = Math.max(0, before + dy);
      const moved = el.scrollTop - before;
      if (moved) {
        const next = { ...mq, by: mq.by + moved };
        marqueeRef.current = next;
        setMarquee(next);
        applyMarquee(next);
      }
    }
    autoScroll.current = requestAnimationFrame(runAutoScroll);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    const el = scroller.current;
    if (!el || e.button !== 0 || !pages) return;
    const t = e.target as HTMLElement;
    if (t !== el && !t.hasAttribute('data-organize-bg')) return;
    const r = el.getBoundingClientRect();
    if (e.clientX - r.left >= el.clientWidth || e.clientY - r.top >= el.clientHeight) return; // scrollbar
    e.preventDefault();
    el.focus({ preventScroll: true });
    setKbd(false);
    const p = contentPoint(e.clientX, e.clientY);
    const additive = isMod(e) || e.shiftKey;
    const mq: Marquee = { ax: p.x, ay: p.y, bx: p.x, by: p.y, base: additive ? sel.ids : [], moved: false, additive, clientY: e.clientY };
    marqueeRef.current = mq;
    el.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const mq = marqueeRef.current;
    if (!mq) return;
    const p = contentPoint(e.clientX, e.clientY);
    const moved = mq.moved || Math.abs(p.x - mq.ax) > 4 || Math.abs(p.y - mq.ay) > 4;
    const next = { ...mq, bx: p.x, by: p.y, moved, clientY: e.clientY };
    marqueeRef.current = next;
    if (!moved) return;
    setMarquee(next);
    applyMarquee(next);
    if (!autoScroll.current) autoScroll.current = requestAnimationFrame(runAutoScroll);
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    const mq = marqueeRef.current;
    if (!mq) return;
    marqueeRef.current = null;
    stopAutoScroll();
    setMarquee(null);
    scroller.current?.releasePointerCapture?.(e.pointerId);
    if (!mq.moved && !mq.additive) organize.clear(docId);
  };

  // ── drag & drop ────────────────────────────────────────────────────────────

  const onDragStart = (e: DragEvent, i: number) => {
    if (!canEdit || !pages) {
      e.preventDefault();
      return;
    }
    const indices = targetsFor(i);
    drag.current = { docId, indices };
    e.dataTransfer.effectAllowed = 'copyMove';
    e.dataTransfer.setData(ops.DRAG_MIME, JSON.stringify({ docId, indices }));
    const ghost = dragGhost(e.currentTarget as HTMLElement, indices.length);
    e.dataTransfer.setDragImage(ghost, 30, 30);
    setTimeout(() => ghost.remove(), 0);
    setDragging(new Set(idsOf(indices)));
  };

  const endDrag = () => {
    drag.current = null;
    setDragging(null);
    setDrop(null);
  };

  const accepts = (e: DragEvent) => {
    const types = Array.from(e.dataTransfer.types);
    return canEdit && (types.includes(ops.DRAG_MIME) || types.includes('Files'));
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!accepts(e)) return;
    e.preventDefault();
    const internal = drag.current?.docId === docId;
    e.dataTransfer.dropEffect = internal && !isMod(e) ? 'move' : 'copy';
    const p = contentPoint(e.clientX, e.clientY);
    const hit = gapAt(mRef.current, p.x, p.y) as GapHit;
    if (!drop || drop.gap !== hit.gap || drop.y !== hit.y || drop.x !== hit.x) setDrop({ gap: hit.gap, x: hit.x, y: hit.y, h: hit.h });
    const el = scroller.current!;
    const r = el.getBoundingClientRect();
    if (e.clientY < r.top + 48) el.scrollTop -= 18;
    else if (e.clientY > r.bottom - 48) el.scrollTop += 18;
  };

  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    const next = e.relatedTarget as Node | null;
    if (!next || !scroller.current?.contains(next)) setDrop(null);
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!accepts(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const p = contentPoint(e.clientX, e.clientY);
    const gap = (gapAt(mRef.current, p.x, p.y) as GapHit).gap;
    const raw = e.dataTransfer.getData(ops.DRAG_MIME);
    const files = Array.from(e.dataTransfer.files ?? []);
    const copy = isMod(e);
    endDrag();
    if (raw) {
      let data: { docId?: DocId; indices?: number[] } = {};
      try {
        data = JSON.parse(raw);
      } catch {
        return;
      }
      const indices = (data.indices ?? []).filter((n) => Number.isInteger(n));
      if (!data.docId || !indices.length) return;
      if (data.docId === docId && !copy) void ops.movePagesTo(docId, indices, gap);
      else void ops.insertFromDoc(docId, data.docId, indices, gap);
      return;
    }
    if (files.length) void ops.insertFileList(docId, files, gap);
  };

  // ── keyboard ───────────────────────────────────────────────────────────────

  const moveFocus = (to: number, e: KeyboardEvent) => {
    if (!pages || !count) return;
    const i = Math.max(0, Math.min(count - 1, to));
    if (e.shiftKey) {
      const a = sel.anchor ? indexOf.get(sel.anchor) : undefined;
      selectRange(a ?? (focusIndex >= 0 ? focusIndex : i), i, isMod(e), i);
    } else if (isMod(e)) organize.setSelection(docId, { focus: pages[i].id });
    else selectOnly(i);
    revealIndex(i);
  };

  const moveSelected = (delta: number) => {
    if (!canEdit || !selIdx.length) return;
    const firstSel = selIdx[0];
    const lastSel = selIdx[selIdx.length - 1];
    // Gap semantics: before the page currently at `gap`.
    const gap = delta < 0 ? Math.max(0, firstSel + delta) : Math.min(count, lastSel + 1 + delta);
    const focusId = sel.focus ?? pages?.[firstSel]?.id ?? null;
    void ops.movePagesTo(docId, selIdx, gap).then(() => {
      // Reveal the moved page by id (its new index isn't known here).
      if (focusId) organize.reveal(docId, focusId);
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!pages || !count) return;
    if (e.target !== e.currentTarget) return;
    const cur = focusIndex >= 0 ? focusIndex : selIdx[0] ?? -1;
    const n = e.nativeEvent;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
      setKbd(true);
    };
    const rowsPerPage = Math.max(1, Math.floor(e.currentTarget.clientHeight / (m.cellH + 18)));

    if (e.altKey && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
      handled();
      const d = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' ? -m.cols : m.cols;
      moveSelected(d);
      return;
    }
    switch (e.key) {
      case 'ArrowRight': handled(); return moveFocus(cur < 0 ? 0 : cur + 1, e);
      case 'ArrowLeft': handled(); return moveFocus(cur < 0 ? 0 : cur - 1, e);
      case 'ArrowDown': handled(); return moveFocus(cur < 0 ? 0 : cur + m.cols, e);
      case 'ArrowUp': handled(); return moveFocus(cur < 0 ? 0 : cur - m.cols, e);
      case 'Home': handled(); return moveFocus(0, e);
      case 'End': handled(); return moveFocus(count - 1, e);
      case 'PageDown': handled(); return moveFocus(cur < 0 ? 0 : cur + m.cols * rowsPerPage, e);
      case 'PageUp': handled(); return moveFocus(cur < 0 ? 0 : cur - m.cols * rowsPerPage, e);
      default:
    }
    if (e.key === ' ' && !isMod(e)) {
      handled();
      if (cur >= 0) {
        if (e.shiftKey) moveFocus(cur, e);
        else toggle(cur);
      }
      return;
    }
    if (e.key === 'Enter' && !isMod(e) && !e.shiftKey) {
      if (cur >= 0) {
        handled();
        ops.openInViewer(docId, cur);
      }
      return;
    }
    if (e.key === 'Escape') {
      if (sel.ids.length) {
        handled();
        organize.clear(docId);
      }
      return;
    }
    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
      if (cur < 0) return;
      handled();
      const el = scroller.current!;
      const r = el.getBoundingClientRect();
      const b = frameBox(m, cur);
      showContextMenu({ clientX: r.left + b.x + b.w / 2, clientY: r.top + b.y - el.scrollTop + b.h / 2 }, menuFor(cur));
      return;
    }
    if (matchShortcut(n, 'mod+a')) {
      handled();
      organize.selectIndices(docId, pages.map((_, i) => i), cur >= 0 ? cur : 0);
      return;
    }
    if (matchShortcut(n, 'mod+=')) {
      handled();
      organize.setThumbSize(size * 1.2);
      return;
    }
    if (matchShortcut(n, 'mod+-')) {
      handled();
      organize.setThumbSize(size / 1.2);
      return;
    }
    if (!editable) return;
    const targets = selIdx.length ? selIdx : cur >= 0 ? [cur] : [];
    if (e.key === 'Delete' || e.key === 'Backspace') {
      handled();
      void ops.deletePages(docId, targets);
      return;
    }
    if (matchShortcut(n, 'mod+shift+=') || matchShortcut(n, 'mod+shift+-')) {
      handled();
      void ops.rotate(docId, targets, matchShortcut(n, 'mod+shift+=') ? 90 : -90);
      return;
    }
    if (matchShortcut(n, 'mod+c')) {
      handled();
      ops.copyPages(docId, targets, 'copy');
      return;
    }
    if (matchShortcut(n, 'mod+x')) {
      handled();
      ops.copyPages(docId, targets, 'cut');
      return;
    }
    if (matchShortcut(n, 'mod+v')) {
      handled();
      void ops.pastePages(docId, targets.length ? targets[targets.length - 1] + 1 : count);
      return;
    }
    if (matchShortcut(n, 'mod+d')) {
      handled();
      void ops.duplicate(docId, targets);
    }
  };

  // ── render ─────────────────────────────────────────────────────────────────

  if (loading || !pages) {
    return (
      <div className="organize-grid organize-grid-loading" data-testid="organize-grid">
        <Spinner /> Loading pages…
      </div>
    );
  }

  const [r0, r1] = visibleRows(m, scrollTop, view.h || 800);
  const firstCell = r0 * m.cols;
  const lastCell = Math.min(count - 1, (r1 + 1) * m.cols - 1);
  const cells: number[] = [];
  for (let i = firstCell; i <= lastCell; i++) cells.push(i);
  // Dragged cells stay mounted while scrolled away, so the browser still delivers dragend.
  if (dragging) {
    for (const id of dragging) {
      const i = indexOf.get(id);
      if (i !== undefined && (i < firstCell || i > lastCell)) cells.push(i);
    }
  }

  const gaps: { gap: number; x: number; y: number; key: string }[] = [];
  if ((canEdit || split?.onToggle) && view.w) {
    for (let r = r0; r <= r1; r++) {
      const inRow = Math.min(m.cols, count - r * m.cols);
      for (let c = 0; c <= inRow; c++) {
        const gap = r * m.cols + c;
        if (split && (gap === 0 || gap >= count)) continue;
        if (split && c === 0 && r > 0) continue; // same gap as the end of the previous row
        const y = frameBox(m, r * m.cols).y;
        gaps.push({ gap, x: gapX(m, c), y, key: `${r}:${c}` });
      }
    }
  }
  const activeId = focusIndex >= 0 ? `organize-cell-${pages[focusIndex].id}` : undefined;

  return (
    <div
      ref={scroller}
      className={clsx('organize-grid', kbd && 'is-kbd', marquee && 'is-marquee', drop && 'is-dropping', !canEdit && 'is-readonly')}
      role="listbox"
      aria-multiselectable
      aria-label={`${ariaLabel} of ${docName}`}
      aria-activedescendant={activeId}
      tabIndex={0}
      data-testid="organize-grid"
      data-cols={m.cols}
      data-dropzone={canEdit ? '' : undefined}
      onKeyDown={onKeyDown}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onFocus={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.currentTarget.matches(':focus-visible')) setKbd(true);
        if (focusIndex < 0 && count) organize.setSelection(docId, { focus: (selIdx.length ? pages[selIdx[0]] : pages[0]).id });
      }}
    >
      <div className="organize-grid-canvas" style={{ height: m.height }} data-organize-bg="">
        {cells.map((i) => {
          const p = pages[i];
          const box = cellBox(m, i);
          const s = shown(p);
          const tw = fitWidth(m.boxW, s.w, s.h);
          const isSel = selSet.has(p.id);
          const lab = pageLabel(p, i);
          const part = split ? split.partOf[i] : -1;
          const partStart = split ? i === 0 || split.starts.has(i) : false;
          return (
            <div
              key={p.id}
              id={`organize-cell-${p.id}`}
              role="option"
              aria-selected={isSel}
              aria-label={`Page ${lab.main}${lab.sub ? ` (${lab.sub})` : ''}${p.rotation ? `, rotated ${p.rotation}°` : ''}`}
              className={clsx(
                'organize-cell',
                isSel && 'is-selected',
                i === focusIndex && 'is-focused',
                dragging?.has(p.id) && 'is-dragging',
                part >= 0 && `organize-part-${part % PART_COLORS}`,
              )}
              style={{ left: box.x, top: box.y, width: box.w, height: box.h }}
              data-testid="organize-page"
              data-page-index={i}
              data-page-id={p.id}
              data-rotation={p.rotation}
              draggable={canEdit}
              onMouseDown={(e) => onCellMouseDown(e, i)}
              onClick={(e) => onCellClick(e, i)}
              onDoubleClick={() => ops.openInViewer(docId, i)}
              onContextMenu={(e) => onCellContextMenu(e, i)}
              onDragStart={(e) => onDragStart(e, i)}
              onDragEnd={endDrag}
            >
              <div className="organize-frame" style={{ width: m.boxW, height: m.boxH }}>
                <PageThumbnail docId={docId} pageIndex={i} width={tw} className="organize-thumb" />
                {canEdit && (
                  <div
                    className="organize-hover-actions"
                    onMouseDown={(e) => e.stopPropagation()}
                    onClick={(e) => e.stopPropagation()}
                    onDoubleClick={(e) => e.stopPropagation()}
                  >
                    <IconButton size="sm" icon={RotateCcw} label="Rotate counterclockwise" tabIndex={-1} onClick={() => ops.rotate(docId, targetsFor(i), -90)} data-testid="organize-page-rotate-ccw" />
                    <IconButton size="sm" icon={RotateCw} label="Rotate clockwise" tabIndex={-1} onClick={() => ops.rotate(docId, targetsFor(i), 90)} data-testid="organize-page-rotate-cw" />
                    <IconButton
                      size="sm"
                      icon={Trash2}
                      label="Delete"
                      tabIndex={-1}
                      disabled={targetsFor(i).length >= count}
                      onClick={() => ops.deletePages(docId, targetsFor(i))}
                      data-testid="organize-page-delete"
                    />
                    <IconButton
                      size="sm"
                      icon={MoreHorizontal}
                      label="More"
                      tabIndex={-1}
                      onClick={(e) => {
                        if (!selSet.has(p.id)) selectOnly(i);
                        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                        showContextMenu({ clientX: r.left, clientY: r.bottom + 4 }, menuFor(i));
                      }}
                      data-testid="organize-page-more"
                    />
                  </div>
                )}
                {split && partStart && (
                  <span className="organize-part-badge" data-testid="organize-part-badge">
                    Part {part + 1}
                  </span>
                )}
              </div>
              <div className="organize-label" title={`Page ${lab.main}${lab.sub ? ` (page ${lab.sub} of ${count})` : ` of ${count}`}`}>
                <span className="organize-label-main" data-testid="organize-page-label">
                  {lab.main}
                </span>
                {lab.sub && <span className="organize-label-sub">({lab.sub})</span>}
              </div>
            </div>
          );
        })}

        {gaps.map((g) =>
          split ? (
            <button
              type="button"
              key={g.key}
              className={clsx('organize-split-gap', split.starts.has(g.gap) && 'is-active')}
              style={{ left: g.x - GAP_X / 2, top: g.y, width: GAP_X, height: m.boxH }}
              onClick={() => split.onToggle?.(g.gap)}
              disabled={!split.onToggle}
              aria-label={split.starts.has(g.gap) ? `Remove the split before page ${g.gap + 1}` : `Split before page ${g.gap + 1}`}
              title={split.starts.has(g.gap) ? `Remove the split before page ${g.gap + 1}` : `Split before page ${g.gap + 1}`}
              data-testid="organize-split-gap"
              data-gap={g.gap}
            >
              <span className="organize-split-line" aria-hidden />
              <Scissors size={14} className="organize-split-icon" aria-hidden />
            </button>
          ) : (
            <div key={g.key} className="organize-gap" style={{ left: g.x - GAP_X / 2, top: g.y, width: GAP_X, height: m.boxH }} data-gap={g.gap}>
              <span className="organize-gap-line" aria-hidden />
              <button
                type="button"
                className="organize-gap-add"
                tabIndex={-1}
                aria-label={g.gap >= count ? 'Insert pages at the end' : `Insert pages before page ${g.gap + 1}`}
                title="Insert pages here"
                data-testid="organize-gap-add"
                data-gap={g.gap}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  const at = g.gap;
                  const clip = ops.clipIndices();
                  showContextMenu({ clientX: r.left + r.width / 2, clientY: r.bottom + 4 }, [
                    { header: at >= count ? 'Insert at the end' : at === 0 ? 'Insert before page 1' : `Insert between pages ${at} and ${at + 1}` },
                    { id: 'organize-gap-blank', label: 'Blank page', icon: FilePlus2, run: () => ops.insertBlankNow(docId, at) },
                    { id: 'organize-gap-file', label: 'From file…', icon: FileInput, run: () => ops.insertFromFile(docId, at) },
                    { id: 'organize-gap-library', label: 'From your files…', icon: FolderOpen, run: () => ops.insertFromLibrary(docId, at) },
                    ...(clip ? ['divider' as const, { id: 'organize-gap-paste', label: 'Paste pages', icon: ClipboardPaste, run: () => ops.pastePages(docId, at) }] : []),
                  ]);
                }}
              >
                <Plus size={14} strokeWidth={2.5} />
              </button>
            </div>
          ),
        )}

        {drop && (
          <div className="organize-drop-indicator" style={{ left: drop.x - 2, top: drop.y, height: drop.h }} data-testid="organize-drop-indicator" data-gap={drop.gap} aria-hidden />
        )}
        {marquee?.moved && (
          <div
            className="organize-marquee"
            style={{
              left: Math.min(marquee.ax, marquee.bx),
              top: Math.min(marquee.ay, marquee.by),
              width: Math.abs(marquee.bx - marquee.ax),
              height: Math.abs(marquee.by - marquee.ay),
            }}
            aria-hidden
          />
        )}
      </div>
    </div>
  );
}
