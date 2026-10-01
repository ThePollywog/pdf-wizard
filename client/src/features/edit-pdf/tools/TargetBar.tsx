/**
 * Floating bar above the selected page item (below it when there is no room): text formatting
 * while typing, image tools, crop Apply / Cancel, link actions. Same look as the core
 * properties bar.
 */
import { useLayoutEffect, useRef, useState, type SyntheticEvent } from 'react';
import { Check, MoreHorizontal, X } from 'lucide-react';
import type { ViewBox } from '@/core/types';
import { Button, Divider, Dropdown, IconButton } from '@/core/ui';
import { commitEdit } from '../sessions';
import type { Target } from '../state';
import { arrangeActions, deleteAction, imageActions, linkActions, textActions, type TargetAction } from '../menus';
import { applyCrop, cancelCrop, kindOfTarget } from '../targetActions';
import { FormatBarControls } from '../ui/FormatControls';
import type { TextStyle } from '../content/blocks';

const GAP = 10;
const stop = (e: SyntheticEvent) => e.stopPropagation();

export type BarMode =
  | { type: 'editing'; style: TextStyle }
  | { type: 'crop' }
  | { type: 'target'; target: Target };

function ActionButton({ a }: { a: TargetAction }) {
  return <IconButton size="sm" icon={a.icon} label={a.label} onClick={() => void a.run()} data-testid={`edit-pdf-bar-${a.id}`} className={a.danger ? 'edit-pdf-danger' : undefined} />;
}

function TargetButtons({ t }: { t: Target }) {
  const kind = kindOfTarget(t);
  const del = deleteAction(t);
  if (kind === 'image') {
    const arr = arrangeActions(t);
    return (
      <>
        {imageActions(t).map((a) => (
          <ActionButton key={a.id} a={a} />
        ))}
        <Divider vertical />
        <Dropdown
          label="More"
          items={arr.map((a) => ({ id: `edit-pdf-bar-${a.id}`, label: a.label, icon: a.icon, run: () => void a.run() }))}
          trigger={<IconButton size="sm" icon={MoreHorizontal} label="More options" data-testid="edit-pdf-bar-more" />}
        />
        <ActionButton a={del} />
      </>
    );
  }
  if (kind === 'text') {
    const [edit] = textActions(t);
    return (
      <>
        <button type="button" className="pdfwizard-props-chip" onClick={() => void edit.run()} data-testid="edit-pdf-bar-edit-text">
          <edit.icon size={15} strokeWidth={1.75} />
          Edit text
        </button>
        <Divider vertical />
        <ActionButton a={del} />
      </>
    );
  }
  if (kind === 'link') {
    return (
      <>
        {linkActions(t).map((a) => (
          <ActionButton key={a.id} a={a} />
        ))}
        <Divider vertical />
        <ActionButton a={del} />
      </>
    );
  }
  return null;
}

/** `box`: view box of the item on its page; `pageHeight` in CSS px. */
export function TargetBar({ mode, box }: { mode: BarMode; box: ViewBox }) {
  const ref = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 0, h: 36 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    if (w !== dims.w || h !== dims.h) setDims({ w, h });
  });
  const below = box.top - GAP - dims.h < -GAP * 2;
  const top = below ? box.top + box.height + GAP : box.top - GAP - dims.h;
  const left = box.left + box.width / 2 - dims.w / 2;
  return (
    <div
      ref={ref}
      className={`pdfwizard-props-bar edit-pdf-bar is-${below ? 'below' : 'above'}`}
      style={{ left: Math.max(4, left), top }}
      role="toolbar"
      aria-label="Edit properties"
      data-testid="edit-pdf-bar"
      data-edit-pdf-keep=""
      data-viewer-passthrough=""
      data-no-shortcuts=""
      onPointerDown={stop}
      onDoubleClick={stop}
      onContextMenu={stop}
    >
      {mode.type === 'editing' && (
        <>
          <FormatBarControls style={mode.style} />
          <Divider vertical />
          <Button size="sm" variant="primary" onMouseDown={(e) => e.preventDefault()} onClick={() => void commitEdit()} data-testid="edit-pdf-bar-done">
            Done
          </Button>
        </>
      )}
      {mode.type === 'crop' && (
        <>
          <span className="edit-pdf-bar-label">Drag the handles to crop</span>
          <Divider vertical />
          <Button size="sm" variant="primary" icon={Check} onClick={() => void applyCrop()} data-testid="edit-pdf-crop-apply">
            Apply
          </Button>
          <Button size="sm" variant="secondary" icon={X} onClick={() => cancelCrop()} data-testid="edit-pdf-crop-cancel">
            Cancel
          </Button>
        </>
      )}
      {mode.type === 'target' && <TargetButtons t={mode.target} />}
    </div>
  );
}
