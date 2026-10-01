/** Top bar of the Organize pages view (the standard organize toolbar). */
import clsx from 'clsx';
import {
  ArrowDownUp, ChevronDown, ClipboardPaste, CopyPlus, FileInput, FileOutput, FilePlus2, FolderOpen, ListOrdered, MousePointerSquareDashed, Redo2, Replace,
  RotateCcw, RotateCw, Scissors, Trash2, Undo2, X, ZoomIn, ZoomOut,
} from 'lucide-react';
import type { DocId } from '@/core/types';
import { actions, useDoc } from '@/core/store';
import { Button, Divider, Dropdown, IconButton, Slider, type MenuEntry } from '@/core/ui';
import { MAX_THUMB, MIN_THUMB, organize, useOrganize, type FocusAction } from './store';
import * as ops from './ops';
import { TASK_SPLIT } from './tasks';
import { readOnlyReason } from './util';

function Group({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={clsx('organize-toolbar-group', className)}>{children}</div>;
}

export function selectMenu(docId: DocId): MenuEntry[] {
  return [
    { id: 'organize-select-all', label: 'All pages', shortcut: 'mod+a', run: () => ops.selectBy(docId, 'all') },
    { id: 'organize-select-even', label: 'Even pages', run: () => ops.selectBy(docId, 'even') },
    { id: 'organize-select-odd', label: 'Odd pages', run: () => ops.selectBy(docId, 'odd') },
    { id: 'organize-select-portrait', label: 'Portrait pages', run: () => ops.selectBy(docId, 'portrait') },
    { id: 'organize-select-landscape', label: 'Landscape pages', run: () => ops.selectBy(docId, 'landscape') },
    'divider',
    { id: 'organize-select-range', label: 'Page range…', run: () => ops.selectRange(docId) },
    { id: 'organize-select-invert', label: 'Invert selection', run: () => ops.selectBy(docId, 'invert') },
    { id: 'organize-select-none', label: 'Clear selection', shortcut: 'escape', run: () => ops.selectBy(docId, 'none') },
  ];
}

export function insertMenu(docId: DocId): MenuEntry[] {
  const clip = ops.clipIndices();
  return [
    { id: 'organize-insert-blank', label: 'Blank page…', icon: FilePlus2, run: () => ops.insertBlank(docId) },
    { id: 'organize-insert-file', label: 'From file…', icon: FileInput, run: () => ops.insertFromFile(docId) },
    { id: 'organize-insert-library', label: 'From your files…', icon: FolderOpen, run: () => ops.insertFromLibrary(docId) },
    ...(clip
      ? ([
          'divider',
          { id: 'organize-insert-paste', label: 'Paste pages', icon: ClipboardPaste, shortcut: 'mod+v', run: () => ops.pastePages(docId, ops.defaultInsertAt(docId)) },
        ] as MenuEntry[])
      : []),
  ];
}

export function OrganizeToolbar({ docId, targets, focusAction }: { docId: DocId; targets: number[]; focusAction: FocusAction | null }) {
  const count = useDoc(docId, (d) => d?.pages.length ?? 0);
  const undoLabel = useDoc(docId, (d) => d?.history.past[d.history.past.length - 1]?.label ?? null);
  const redoLabel = useDoc(docId, (d) => d?.history.future[0]?.label ?? null);
  const size = useOrganize((s) => s.thumbSize);
  const ro = !!readOnlyReason(docId);
  const n = targets.length;
  const none = n === 0;
  const hl = (a: FocusAction) => focusAction === a && 'is-focus-action';

  return (
    <div className="organize-toolbar" role="toolbar" aria-label="Organize pages" data-testid="organize-toolbar">
      <Group>
        <Dropdown
          label="Select pages"
          items={() => selectMenu(docId)}
          trigger={
            <Button variant="ghost" size="sm" icon={MousePointerSquareDashed} iconEnd={ChevronDown} aria-label="Select pages" tooltip="Select pages" data-testid="organize-select-menu">
              <span className="organize-tb-label">Select</span>
            </Button>
          }
        />
      </Group>
      <Divider vertical className="organize-toolbar-divider" />
      <Group className={clsx(hl('rotate'))}>
        <IconButton icon={RotateCcw} label={n > 1 ? `Rotate ${n} pages counterclockwise` : 'Rotate counterclockwise'} disabled={ro || none} onClick={() => ops.rotate(docId, targets, -90)} data-testid="organize-rotate-ccw" />
        <IconButton icon={RotateCw} label={n > 1 ? `Rotate ${n} pages clockwise` : 'Rotate clockwise'} disabled={ro || none} onClick={() => ops.rotate(docId, targets, 90)} data-testid="organize-rotate-cw" />
      </Group>
      <Group className={clsx(hl('delete'))}>
        <IconButton
          icon={Trash2}
          label={n > 1 ? `Delete ${n} pages` : 'Delete pages'}
          shortcut="delete"
          disabled={ro || none || n >= count}
          onClick={() => ops.deletePages(docId, targets)}
          data-testid="organize-delete"
        />
      </Group>
      <Divider vertical className="organize-toolbar-divider" />
      <Group className={clsx(hl('insert'))}>
        <Dropdown
          label="Insert pages"
          items={() => insertMenu(docId)}
          trigger={
            <Button variant="ghost" size="sm" icon={FilePlus2} iconEnd={ChevronDown} disabled={ro} aria-label="Insert" tooltip="Insert pages" data-testid="organize-insert-menu">
              <span className="organize-tb-label">Insert</span>
            </Button>
          }
        />
      </Group>
      <Group>
        <Button variant="ghost" size="sm" icon={FileOutput} disabled={ro} onClick={() => ops.extract(docId, targets)} aria-label="Extract" tooltip={n > 1 ? `Extract ${n} pages to a new file` : 'Extract pages to a new file'} data-testid="organize-extract">
          <span className="organize-tb-label is-keep">Extract</span>
        </Button>
        <Button variant="ghost" size="sm" icon={Replace} disabled={ro} onClick={() => ops.replace(docId, targets)} aria-label="Replace" tooltip="Replace pages with pages from another file" data-testid="organize-replace">
          <span className="organize-tb-label is-keep">Replace</span>
        </Button>
        <Button variant="ghost" size="sm" icon={Scissors} onClick={() => actions.openTask(TASK_SPLIT)} aria-label="Split" tooltip="Split the document into several files" data-testid="organize-split">
          <span className="organize-tb-label is-keep">Split</span>
        </Button>
      </Group>
      <Divider vertical className="organize-toolbar-divider" />
      <Group className={clsx(hl('reverse'), hl('reorder'))}>
        <IconButton
          icon={ArrowDownUp}
          label={n >= 2 ? `Reverse the ${n} selected pages` : 'Reverse page order'}
          disabled={ro || count < 2}
          onClick={() => ops.reverse(docId, targets)}
          data-testid="organize-reverse"
        />
        <IconButton icon={CopyPlus} label={n > 1 ? `Duplicate ${n} pages` : 'Duplicate'} shortcut="mod+d" disabled={ro || none} onClick={() => ops.duplicate(docId, targets)} data-testid="organize-duplicate" />
      </Group>
      <Group className={clsx(hl('labels'))}>
        <IconButton icon={ListOrdered} label="Page labels (number pages)" disabled={ro} onClick={() => ops.pageLabels(docId, targets)} data-testid="organize-labels" />
      </Group>
      <Divider vertical className="organize-toolbar-divider organize-tb-history" />
      <Group className="organize-tb-history">
        <IconButton icon={Undo2} label={undoLabel ? `Undo ${undoLabel}` : 'Undo'} shortcut="mod+z" disabled={!undoLabel} onClick={() => actions.undo(docId)} data-testid="organize-undo" />
        <IconButton icon={Redo2} label={redoLabel ? `Redo ${redoLabel}` : 'Redo'} shortcut="mod+shift+z" disabled={!redoLabel} onClick={() => actions.redo(docId)} data-testid="organize-redo" />
      </Group>
      <div className="organize-toolbar-spacer" />
      <div className="organize-toolbar-end">
      <Group className="organize-zoom">
        <IconButton icon={ZoomOut} size="sm" label="Smaller thumbnails" shortcut="mod+-" disabled={size <= MIN_THUMB} onClick={() => organize.setThumbSize(size / 1.2)} data-testid="organize-zoom-out" />
        <div className="organize-zoom-slider" data-testid="organize-zoom-slider">
          <Slider value={size} min={MIN_THUMB} max={MAX_THUMB} step={2} onChange={(v) => organize.setThumbSize(v)} showValue={false} aria-label="Thumbnail size" />
        </div>
        <IconButton icon={ZoomIn} size="sm" label="Larger thumbnails" shortcut="mod+=" disabled={size >= MAX_THUMB} onClick={() => organize.setThumbSize(size * 1.2)} data-testid="organize-zoom-in" />
      </Group>
      <Divider vertical className="organize-toolbar-divider" />
      <Button variant="secondary" size="sm" icon={X} onClick={() => ops.closeOrganize()} data-testid="organize-close">
        Close
      </Button>
      </div>
    </div>
  );
}
