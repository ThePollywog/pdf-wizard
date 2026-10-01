/**
 * Small floating toolbar shown after selecting text with the Select tool: registry
 * textSelectionActions (highlight, underline, …) + Copy. Positioned by ViewerInteraction
 * (viewerUi.textPopup, relative to the viewer root); hidden on scroll / outside click / collapse.
 */
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { DocId } from '../types';
import { actions } from '../store';
import { IconButton, type MenuActionItem, type MenuEntry } from '../ui';
import { useViewerUi, viewerUi } from './viewerStore';
import { textSelectionEntries } from './interaction';

const isAction = (e: MenuEntry): e is MenuActionItem => typeof e === 'object' && 'run' in e;

async function runEntry(item: MenuActionItem) {
  try {
    await item.run();
    if (item.id === 'viewer.text.copy') actions.toast('Copied to clipboard');
  } catch (err) {
    console.error(`[viewer] text action "${item.id}" failed`, err);
    actions.toast(err instanceof Error ? err.message : String(err), { kind: 'error' });
  } finally {
    viewerUi.set({ textPopup: null });
  }
}

export function TextSelectionPopup({ docId }: { docId: DocId }) {
  const pop = useViewerUi((s) => (s.textPopup && s.textPopup.docId === docId ? s.textPopup : null));
  const ref = useRef<HTMLDivElement>(null);
  const [shift, setShift] = useState(0);

  const items = useMemo(() => {
    if (!pop) return [];
    const all = textSelectionEntries(pop.selections).filter(isAction);
    // Feature actions first (conventional order), Copy last.
    const copy = all.filter((a) => a.id === 'viewer.text.copy');
    return [...all.filter((a) => a.id !== 'viewer.text.copy'), ...copy];
  }, [pop]);

  // Keep the popup inside the viewer horizontally.
  useLayoutEffect(() => {
    const el = ref.current;
    const root = el?.parentElement;
    if (!el || !root || !pop) return;
    const w = el.offsetWidth;
    const rw = root.clientWidth;
    const min = w / 2 + 8;
    const max = rw - w / 2 - 8;
    const target = max < min ? rw / 2 : Math.min(Math.max(pop.left, min), max);
    setShift(target - pop.left);
  }, [pop, items.length]);

  if (!pop || items.length === 0) return null;

  return (
    <div
      ref={ref}
      className={`pdfwizard-text-popup is-${pop.placement}`}
      style={{ left: pop.left + shift, top: pop.top }}
      role="toolbar"
      aria-label="Text selection actions"
      data-testid="text-selection-popup"
      // Keep the text selection while clicking the buttons.
      onMouseDown={(e) => e.preventDefault()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {items.map((it) =>
        it.icon ? (
          <IconButton key={it.id} size="sm" icon={it.icon} label={it.label} shortcut={it.shortcut} tooltipSide={pop.placement === 'above' ? 'top' : 'bottom'} data-action-id={it.id} onClick={() => void runEntry(it)} />
        ) : (
          <button key={it.id} type="button" className="pdfwizard-text-popup-btn" data-action-id={it.id} onClick={() => void runEntry(it)}>
            {it.label}
          </button>
        ),
      )}
    </div>
  );
}
