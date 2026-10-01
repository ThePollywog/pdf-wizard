/** Left panel of the organize tasks: selection summary, page actions and keyboard tips. */
import clsx from 'clsx';
import type { ComponentType } from 'react';
import {
  ArrowDownUp, Combine, CopyPlus, FileInput, FileOutput, FilePlus2, FolderOpen, ListOrdered, Replace, RotateCcw, RotateCw, Scissors, Trash2,
} from 'lucide-react';
import type { DocId } from '@/core/types';
import { actions, useApp, useDoc } from '@/core/store';
import { Kbd } from '@/core/ui';
import { selectedIndices, useSelection, type FocusAction } from './store';
import * as ops from './ops';
import { TASK_COMBINE, TASK_SPLIT, focusActionFor } from './tasks';
import { readOnlyReason } from './util';
import { formatRanges } from './ranges';

interface PanelAction {
  id: string;
  label: string;
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  run(): void | Promise<unknown>;
  disabled?: boolean;
  focus?: FocusAction;
  danger?: boolean;
}

function ActionList({ items, focus }: { items: PanelAction[]; focus: FocusAction | null }) {
  return (
    <ul className="organize-panel-actions">
      {items.map((a) => {
        const Icon = a.icon;
        return (
          <li key={a.id}>
            <button
              type="button"
              className={clsx('organize-panel-action', a.focus && a.focus === focus && 'is-focus-action', a.danger && 'is-danger')}
              disabled={a.disabled}
              onClick={() => void a.run()}
              data-testid={`organize-panel-${a.id}`}
            >
              <Icon size={18} strokeWidth={1.75} />
              <span>{a.label}</span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

function PanelBody({ docId }: { docId: DocId }) {
  const doc = useDoc(docId, (d) => d);
  const sel = useSelection(docId);
  const taskId = useApp((s) => s.activeTaskId);
  const focus = focusActionFor(taskId);
  if (!doc) return null;
  const t = selectedIndices(doc, sel);
  const n = t.length;
  const count = doc.pages.length;
  const ro = !!readOnlyReason(docId);
  const none = n === 0;

  const insert: PanelAction[] = [
    { id: 'insert-blank', label: 'Insert blank page', icon: FilePlus2, run: () => ops.insertBlank(docId), disabled: ro, focus: 'insert' },
    { id: 'insert-file', label: 'Insert from file', icon: FileInput, run: () => ops.insertFromFile(docId), disabled: ro, focus: 'insert' },
    { id: 'insert-library', label: 'Insert from your files', icon: FolderOpen, run: () => ops.insertFromLibrary(docId), disabled: ro, focus: 'insert' },
  ];
  const page: PanelAction[] = [
    { id: 'rotate-ccw', label: 'Rotate counterclockwise', icon: RotateCcw, run: () => ops.rotate(docId, t, -90), disabled: ro || none, focus: 'rotate' },
    { id: 'rotate-cw', label: 'Rotate clockwise', icon: RotateCw, run: () => ops.rotate(docId, t, 90), disabled: ro || none, focus: 'rotate' },
    { id: 'duplicate', label: 'Duplicate', icon: CopyPlus, run: () => ops.duplicate(docId, t), disabled: ro || none },
    { id: 'reverse', label: n >= 2 ? 'Reverse selected pages' : 'Reverse page order', icon: ArrowDownUp, run: () => ops.reverse(docId, t), disabled: ro || count < 2, focus: 'reverse' },
    { id: 'labels', label: 'Number pages (page labels)', icon: ListOrdered, run: () => ops.pageLabels(docId, t), disabled: ro, focus: 'labels' },
    { id: 'delete', label: n > 1 ? `Delete ${n} pages` : 'Delete', icon: Trash2, run: () => ops.deletePages(docId, t), disabled: ro || none || n >= count, focus: 'delete', danger: true },
  ];
  const docActions: PanelAction[] = [
    { id: 'extract', label: 'Extract pages', icon: FileOutput, run: () => ops.extract(docId, t), disabled: ro },
    { id: 'replace', label: 'Replace pages', icon: Replace, run: () => ops.replace(docId, t), disabled: ro },
    { id: 'split', label: 'Split a PDF', icon: Scissors, run: () => actions.openTask(TASK_SPLIT) },
    { id: 'combine', label: 'Combine files', icon: Combine, run: () => actions.openTask(TASK_COMBINE) },
  ];

  return (
    <div className="organize-panel" data-testid="organize-panel">
      <div className="organize-panel-summary">
        <div className="organize-panel-count" data-testid="organize-panel-count">
          {n ? `${n} of ${count} selected` : `${count} ${count === 1 ? 'page' : 'pages'}`}
        </div>
        <div className="organize-panel-sub">{n ? `Pages ${formatRanges(t)}` : 'Click a page to select it'}</div>
      </div>
      <section className="organize-panel-section">
        <h3>Insert</h3>
        <ActionList items={insert} focus={focus} />
      </section>
      <section className="organize-panel-section">
        <h3>Selected pages</h3>
        <ActionList items={page} focus={focus} />
      </section>
      <section className="organize-panel-section">
        <h3>Document</h3>
        <ActionList items={docActions} focus={focus} />
      </section>
      <section className="organize-panel-section organize-panel-tips">
        <h3>Keyboard</h3>
        <dl>
          <dt>
            <Kbd shortcut="mod+a" />
          </dt>
          <dd>Select all pages</dd>
          <dt>
            <Kbd>Shift</Kbd> + <Kbd>←</Kbd>
          </dt>
          <dd>Extend the selection</dd>
          <dt>
            <Kbd>Alt</Kbd> + <Kbd>←</Kbd>
          </dt>
          <dd>Move selected pages</dd>
          <dt>
            <Kbd shortcut="mod+x" /> <Kbd shortcut="mod+v" />
          </dt>
          <dd>Cut and paste pages</dd>
          <dt>
            <Kbd>Delete</Kbd>
          </dt>
          <dd>Delete selected pages</dd>
          <dt>
            <Kbd>Enter</Kbd>
          </dt>
          <dd>Open the page</dd>
        </dl>
      </section>
    </div>
  );
}

export function OrganizePanel() {
  const docId = useApp((s) => s.activeDocId);
  return docId ? <PanelBody docId={docId} /> : null;
}
