/**
 * Floating properties bar shown above the current object selection (below it when there's no room).
 * Single selection of a type with its own `PropertiesBar` → that editor; otherwise generic color /
 * fill / stroke / opacity controls. Always: comment, delete and a "more" menu.
 * Lives inside the sizer so it scrolls with the page; hidden while dragging.
 */
import { Component, useEffect, useLayoutEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode, type SyntheticEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  ArrowDownToLine, ArrowUpToLine, Blend, Copy, CopyPlus, Lock, LockOpen, MessageSquare, MoreHorizontal, Trash2,
} from 'lucide-react';
import type { DocId, PdfObject, UpdateOptions } from '../types';
import { actions, useDoc } from '../store';
import { useRegistry } from '../registry';
import { rectToView } from '../geometry';
import { ColorSwatchButton, Divider, Dropdown, IconButton, type MenuEntry } from '../ui';
import type { ViewerController } from './controller';
import type { Layout } from './layout';
import { makeViewport } from './viewport';
import { useViewerUi, viewerUi } from './viewerStore';
import { copyObjects, duplicateObjects } from './clipboard';
import { deleteSelectedObjects, setLocked } from './contextMenus';

const EMPTY: PdfObject[] = [];
const GAP = 10;
const EDGE = 6;
const STROKES = [0.5, 1, 2, 3, 4, 6, 8, 12];
const OPACITIES = [1, 0.75, 0.5, 0.25];

const stop = (e: SyntheticEvent) => e.stopPropagation();

class BarBoundary extends Component<{ kind: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[viewer] PropertiesBar of "${this.props.kind}" failed`, error, info.componentStack);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

function selectionBox(layout: Layout, objs: PdfObject[]): Box | null {
  let box: Box | null = null;
  for (const o of objs) {
    const i = layout.pageIds.indexOf(o.pageId);
    const slot = i >= 0 ? layout.slots[i] : undefined;
    if (!slot) continue;
    const vp = makeViewport(layout.pages[i], layout.zoom, slot.rotation);
    const b = rectToView(vp, o.rect);
    const l = slot.left + b.left;
    const t = slot.top + b.top;
    const r = l + b.width;
    const btm = t + b.height;
    box = box ? { left: Math.min(box.left, l), top: Math.min(box.top, t), right: Math.max(box.right, r), bottom: Math.max(box.bottom, btm) } : { left: l, top: t, right: r, bottom: btm };
  }
  return box;
}

export function PropertiesBar({ ctrl, docId, layout }: { ctrl: ViewerController; docId: DocId; layout: Layout }) {
  const objs = useDoc(
    docId,
    useShallow((d) => {
      if (!d || d.selection.length === 0) return EMPTY;
      const out: PdfObject[] = [];
      for (const id of d.selection) if (d.objects[id]) out.push(d.objects[id]);
      return out.length ? out : EMPTY;
    }),
  );
  const interaction = useViewerUi((s) => s.interaction);
  const dragging = interaction === 'move' || interaction === 'resize' || interaction === 'marquee';
  const box = useMemo(() => selectionBox(layout, objs), [layout, objs]);
  const show = objs.length > 0 && !!box && !dragging;

  const ref = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 200, h: 40 });
  const [, setTick] = useState(0);

  // Re-position while scrolling (flip / keep inside the viewport).
  useEffect(() => {
    const s = ctrl.scroller;
    if (!s || !show) return;
    let raf = 0;
    const on = () => {
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          setTick((t) => t + 1);
        });
    };
    s.addEventListener('scroll', on, { passive: true });
    return () => {
      s.removeEventListener('scroll', on);
      cancelAnimationFrame(raf);
    };
  }, [ctrl, show]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    if (w !== dims.w || h !== dims.h) setDims({ w, h });
  });

  if (!show || !box) return null;

  const s = ctrl.scroller;
  const st = s?.scrollTop ?? 0;
  const sl = s?.scrollLeft ?? 0;
  const ch = s?.clientHeight ?? 0;
  const cw = s?.clientWidth ?? 0;
  const onScreen = box.bottom > st && box.top < st + ch;
  let top = box.top - GAP - dims.h;
  let placement: 'above' | 'below' = 'above';
  if (onScreen && top < st + EDGE) {
    if (box.bottom + GAP + dims.h <= st + ch - EDGE) {
      top = box.bottom + GAP;
      placement = 'below';
    } else {
      top = st + EDGE; // selection taller than the viewport: pin to the top edge
      placement = 'below';
    }
  }
  if (top < EDGE) {
    top = box.bottom + GAP;
    placement = 'below';
  }
  let left = (box.left + box.right) / 2 - dims.w / 2;
  if (onScreen && cw > dims.w + 2 * EDGE) left = Math.min(Math.max(left, sl + EDGE), sl + cw - dims.w - EDGE);
  left = Math.max(EDGE, Math.min(left, layout.width - dims.w - EDGE));

  return (
    <div
      ref={ref}
      className={`pdfwizard-props-bar is-${placement}`}
      style={{ left, top }}
      data-viewer-passthrough=""
      data-no-shortcuts=""
      role="toolbar"
      aria-label="Selection properties"
      onPointerDown={stop}
      onMouseDown={stop}
      onDoubleClick={stop}
      onContextMenu={stop}
    >
      <BarContents docId={docId} objs={objs} />
    </div>
  );
}

function BarContents({ docId, objs }: { docId: DocId; objs: PdfObject[] }) {
  const types = useRegistry((s) => s.objectTypes);
  const single = objs.length === 1 ? objs[0] : null;
  const type = single ? types[single.kind] : undefined;
  const TypeBar = type?.PropertiesBar;
  const allLocked = objs.every((o) => o.locked);
  const editable = objs.filter((o) => !o.locked);
  const ids = objs.map((o) => o.id);

  const apply = (patch: Partial<PdfObject>, opts?: UpdateOptions) => {
    if (editable.length === 0) return;
    const patches: Record<string, Partial<PdfObject>> = {};
    for (const o of editable) patches[o.id] = patch;
    actions.updateObjects(docId, patches, { label: 'Change properties', ...opts });
  };

  const hasColor = objs.some((o) => o.color !== undefined);
  const hasFill = objs.some((o) => o.fillColor !== undefined);
  const hasStroke = objs.some((o) => o.strokeWidth !== undefined);
  const first = editable[0] ?? objs[0];
  const opacity = first.opacity ?? 1;
  const stroke = objs.find((o) => o.strokeWidth !== undefined)?.strokeWidth ?? 1;

  const more: MenuEntry[] = [
    { id: 'viewer.bar.front', label: 'Bring to front', icon: ArrowUpToLine, run: () => actions.bringToFront(docId, ids) },
    { id: 'viewer.bar.back', label: 'Send to back', icon: ArrowDownToLine, run: () => actions.sendToBack(docId, ids) },
    'divider',
    { id: 'viewer.bar.copy', label: 'Copy', icon: Copy, shortcut: 'mod+c', run: () => void copyObjects(docId, ids) },
    { id: 'viewer.bar.duplicate', label: 'Duplicate', icon: CopyPlus, shortcut: 'mod+d', run: () => void duplicateObjects(docId, ids) },
    'divider',
    allLocked
      ? { id: 'viewer.bar.unlock', label: 'Unlock', icon: LockOpen, run: () => setLocked(docId, ids, false) }
      : { id: 'viewer.bar.lock', label: 'Lock', icon: Lock, run: () => setLocked(docId, ids, true) },
  ];

  const generic = !(single && TypeBar);

  return (
    <>
      {single && TypeBar && !single.locked && (
        <BarBoundary kind={single.kind}>
          <div className="pdfwizard-props-type">
            <TypeBar obj={single} docId={docId} update={(patch, opts) => actions.updateObject(docId, single.id, patch, opts)} />
          </div>
        </BarBoundary>
      )}
      {generic && !allLocked && (
        <div className="pdfwizard-props-generic">
          {hasColor && (
            <ColorSwatchButton size="sm" label="Color" value={first.color ?? null} onChange={(hex) => hex && apply({ color: hex })} />
          )}
          {hasFill && (
            <ColorSwatchButton size="sm" label="Fill" allowNone value={first.fillColor ?? null} onChange={(hex) => apply({ fillColor: hex })} />
          )}
          {hasStroke && (
            <Dropdown
              label="Line thickness"
              items={STROKES.map((w) => ({ id: `sw-${w}`, label: `${w} pt`, checked: Math.abs(w - stroke) < 1e-6, run: () => apply({ strokeWidth: w }) }))}
              trigger={
                <button type="button" className="pdfwizard-props-chip" aria-label="Line thickness" title="Line thickness">
                  <span className="pdfwizard-props-stroke" style={{ height: Math.max(1, Math.min(8, stroke)) }} />
                  <span>{stroke} pt</span>
                </button>
              }
            />
          )}
          <Dropdown
            label="Opacity"
            items={OPACITIES.map((v) => ({ id: `op-${v}`, label: `${Math.round(v * 100)}%`, checked: Math.abs(v - opacity) < 0.01, run: () => apply({ opacity: v }) }))}
            trigger={
              <button type="button" className="pdfwizard-props-chip" aria-label="Opacity" title="Opacity">
                <Blend size={16} strokeWidth={1.75} />
                <span>{Math.round(opacity * 100)}%</span>
              </button>
            }
          />
        </div>
      )}
      {allLocked && (
        <IconButton size="sm" icon={Lock} label="Locked — click to unlock" onClick={() => setLocked(docId, ids, false)} />
      )}
      <Divider vertical />
      {single && (
        <IconButton
          size="sm"
          icon={MessageSquare}
          label={single.contents ? 'Edit comment' : 'Add comment'}
          active={!!single.contents}
          onClick={() => viewerUi.set({ commentFor: { docId, objectId: single.id } })}
        />
      )}
      <IconButton size="sm" icon={Trash2} label="Delete" shortcut="delete" disabled={allLocked} onClick={() => deleteSelectedObjects(docId, ids)} />
      <Dropdown label="More options" align="end" items={more} trigger={<IconButton size="sm" icon={MoreHorizontal} label="More options" />} />
    </>
  );
}
