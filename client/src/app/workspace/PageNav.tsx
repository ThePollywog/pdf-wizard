/** Floating page navigation + zoom pill at the bottom of the viewer (like desktop PDF viewers). */
import { useEffect, useState } from 'react';
import { ChevronDown, ChevronUp, Minus, Plus } from 'lucide-react';
import { actions, getDoc, MAX_ZOOM, MIN_ZOOM, useDoc } from '@/core/store';
import type { DocId } from '@/core/types';
import { Divider, Dropdown, IconButton, type MenuEntry } from '@/core/ui';
import { resolvePageInput } from '../commands';

const ZOOM_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

function zoomMenu(docId: DocId): MenuEntry[] {
  const d = getDoc(docId);
  const zoom = d?.view.zoom ?? 1;
  const fit = d?.view.fit ?? null;
  return [
    { id: 'zoom.fitWidth', label: 'Fit width', shortcut: 'mod+alt+2', checked: fit === 'width', run: () => actions.fit(docId, 'width') },
    { id: 'zoom.fitPage', label: 'Fit page', shortcut: 'mod+alt+1', checked: fit === 'page', run: () => actions.fit(docId, 'page') },
    { id: 'zoom.actual', label: 'Actual size', shortcut: 'mod+0', checked: !fit && Math.abs(zoom - 1) < 1e-3, run: () => actions.setZoom(docId, 1) },
    'divider',
    ...ZOOM_PRESETS.map(
      (z): MenuEntry => ({
        id: `zoom.${z}`,
        label: `${Math.round(z * 100)}%`,
        checked: !fit && Math.abs(zoom - z) < 1e-3,
        run: () => actions.setZoom(docId, z),
      }),
    ),
  ];
}

function PageInput({ docId }: { docId: DocId }) {
  const current = useDoc(docId, (d) => d?.view.currentPage ?? 0);
  const count = useDoc(docId, (d) => d?.pages.length ?? 0);
  const label = useDoc(docId, (d) => d?.pages[d.view.currentPage]?.label ?? null);
  const hasLabels = useDoc(docId, (d) => !!d?.pages.some((p, i) => p.label && p.label !== String(i + 1)));
  const shown = hasLabels && label ? label : String(current + 1);
  const [value, setValue] = useState(shown);
  const [focused, setFocused] = useState(false);

  useEffect(() => {
    if (!focused) setValue(shown);
  }, [shown, focused]);

  const commit = () => {
    const d = getDoc(docId);
    if (!d) return;
    const idx = resolvePageInput(d, value);
    if (idx == null) {
      setValue(shown);
      return;
    }
    actions.goToPage(docId, idx);
  };

  return (
    <label className="page-nav-input-wrap" title={hasLabels ? `Page ${current + 1} of ${count}` : undefined}>
      <input
        className="page-nav-input"
        value={value}
        inputMode={hasLabels ? 'text' : 'numeric'}
        aria-label={`Page number, 1 to ${count}`}
        size={Math.max(2, String(count).length, value.length)}
        onChange={(e) => setValue(e.target.value)}
        onFocus={(e) => {
          setFocused(true);
          e.currentTarget.select();
        }}
        onBlur={() => {
          setFocused(false);
          setValue(shown);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
            e.currentTarget.select();
          } else if (e.key === 'Escape') {
            setValue(shown);
            e.currentTarget.blur();
          }
        }}
        data-testid="page-input"
      />
      <span className="page-nav-total" data-testid="page-total">
        / {count}
      </span>
    </label>
  );
}

export function PageNav({ docId }: { docId: DocId }) {
  const current = useDoc(docId, (d) => d?.view.currentPage ?? 0);
  const count = useDoc(docId, (d) => d?.pages.length ?? 0);
  const zoom = useDoc(docId, (d) => d?.view.zoom ?? 1);
  if (!count) return null;
  return (
    <div className="page-nav" role="toolbar" aria-label="Page navigation and zoom" data-testid="page-nav" data-no-shortcuts="">
      <IconButton icon={ChevronUp} size="sm" label="Previous page" shortcut="arrowleft" tooltipSide="top" disabled={current <= 0} onClick={() => actions.goToPage(docId, current - 1)} data-testid="prev-page" />
      <PageInput docId={docId} />
      <IconButton icon={ChevronDown} size="sm" label="Next page" shortcut="arrowright" tooltipSide="top" disabled={current >= count - 1} onClick={() => actions.goToPage(docId, current + 1)} data-testid="next-page" />
      <Divider vertical className="page-nav-divider" />
      <IconButton icon={Minus} size="sm" label="Zoom out" shortcut="mod+-" tooltipSide="top" disabled={zoom <= MIN_ZOOM + 1e-3} onClick={() => actions.zoomOut(docId)} data-testid="zoom-out" />
      <Dropdown
        placement="top"
        label="Zoom"
        items={() => zoomMenu(docId)}
        trigger={
          <button type="button" className="page-nav-zoom" aria-label={`Zoom ${Math.round(zoom * 100)}%`} data-testid="zoom-menu">
            {Math.round(zoom * 100)}%
          </button>
        }
      />
      <IconButton icon={Plus} size="sm" label="Zoom in" shortcut="mod+=" tooltipSide="top" disabled={zoom >= MAX_ZOOM - 1e-3} onClick={() => actions.zoomIn(docId)} data-testid="zoom-in" />
    </div>
  );
}
