/**
 * Organize feature: "Organize pages" (virtualized page grid with selection, drag & drop,
 * insert / extract / replace / split / rotate / delete / duplicate / reverse and page labels),
 * "Combine files", "Split a PDF", "Extract PDF pages" and the lightweight page tasks that open the
 * organize view with one action highlighted. Also adds Replace / Extract / Page labels to the
 * Thumbnails panel's context menu.
 */
import { ArrowDownUp, Combine, FileOutput, FilePlus2, FileInput, GripHorizontal, LayoutGrid, ListOrdered, Replace, RotateCw, Scissors, Trash2 } from 'lucide-react';
import type { TaskDef } from '@/core/types';
import { registerCommands, registerTask } from '@/core/registry';
import { actions, getActiveDoc, useApp } from '@/core/store';
import * as engine from '@/core/engine';
import { OrganizeView } from './OrganizeView';
import { OrganizePanel } from './OrganizePanel';
import { CombineView } from './combine/CombineView';
import { CombinePanel } from './combine/CombinePanel';
import { combine, seedFromActiveDocument } from './combine/store';
import { SplitView } from './split/SplitView';
import { ExtractView } from './extract/ExtractView';
import { organize, currentSelectedIndices } from './store';
import * as ops from './ops';
import { FOCUS_TASKS, TASK_COMBINE, TASK_EXTRACT, TASK_ORGANIZE, TASK_SPLIT, GRID_TASKS } from './tasks';
import { registerThumbnailMenu } from './contextMenus';
import './styles.css';

const GREEN = '#1f9d6a';

/** Selected grid pages when the organize view is open, else the current page. */
function commandTargets(): number[] {
  const d = getActiveDoc();
  if (!d) return [];
  const taskId = useApp.getState().activeTaskId ?? '';
  const sel = GRID_TASKS.has(taskId) || taskId === TASK_EXTRACT ? currentSelectedIndices(d.id) : [];
  return sel.length ? sel : d.pages.length ? [Math.min(d.view.currentPage, d.pages.length - 1)] : [];
}

/** Opening the grid from the viewer starts with the current page focused. */
function seedGrid() {
  const d = getActiveDoc();
  if (!d || !d.pages.length) return;
  const sel = organize.selection(d.id);
  if (!sel.ids.length && !sel.focus) {
    const p = d.pages[Math.min(d.view.currentPage, d.pages.length - 1)];
    organize.setSelection(d.id, { focus: p.id });
    organize.reveal(d.id, p.id);
  }
}

// ── tasks ────────────────────────────────────────────────────────────────────

registerTask({
  id: TASK_ORGANIZE,
  label: 'Organize pages',
  description: 'Reorder, rotate, insert, extract, replace, split and delete pages.',
  icon: LayoutGrid,
  color: GREEN,
  category: 'organize',
  order: 1,
  featured: 7,
  keywords: ['organize', 'pages', 'reorder', 'move', 'rotate', 'delete', 'insert', 'extract', 'replace', 'duplicate', 'thumbnails', 'grid', 'arrange'],
  requiresDocument: true,
  Panel: OrganizePanel,
  MainView: OrganizeView,
  onOpen: () => {
    organize.setFocusAction(null);
    seedGrid();
  },
});

registerTask({
  id: TASK_COMBINE,
  label: 'Combine files',
  description: 'Merge PDFs and other files into one PDF, with a bookmark for each file.',
  icon: Combine,
  color: '#7a5af5',
  category: 'organize',
  order: 2,
  featured: 6,
  keywords: ['combine', 'merge', 'join', 'binder', 'files', 'append', 'concatenate'],
  requiresDocument: false,
  Panel: CombinePanel,
  MainView: CombineView,
  onOpen: seedFromActiveDocument,
  onClose: () => combine.reset(),
});

registerTask({
  id: TASK_SPLIT,
  label: 'Split a PDF',
  description: 'Divide a PDF into several files by page count, file size, bookmarks or page ranges.',
  icon: Scissors,
  color: '#0e9fb3',
  category: 'organize',
  order: 3,
  keywords: ['split', 'divide', 'separate', 'break', 'parts', 'chapters', 'bookmarks', 'size'],
  requiresDocument: true,
  MainView: SplitView,
});

registerTask({
  id: TASK_EXTRACT,
  label: 'Extract PDF pages',
  description: 'Copy selected pages into a new PDF or download them.',
  icon: FileOutput,
  color: '#e0712c',
  category: 'organize',
  order: 4,
  keywords: ['extract', 'pages', 'copy', 'save pages', 'new file', 'pull out'],
  requiresDocument: true,
  MainView: ExtractView,
  onOpen: seedGrid,
});

const LIGHT: { id: keyof typeof FOCUS_TASKS; label: string; description: string; icon: TaskDef['icon']; keywords: string[] }[] = [
  { id: 'insert-pages', label: 'Insert pages', description: 'Add blank pages or pages from other files.', icon: FilePlus2, keywords: ['insert', 'add', 'blank', 'page', 'append'] },
  { id: 'rotate-pages', label: 'Rotate pages', description: 'Turn pages clockwise or counterclockwise.', icon: RotateCw, keywords: ['rotate', 'turn', 'orientation', 'landscape'] },
  { id: 'delete-pages', label: 'Delete pages', description: 'Remove pages from the document.', icon: Trash2, keywords: ['delete', 'remove', 'pages'] },
  { id: 'reorder-pages', label: 'Reorder pages', description: 'Drag pages into a new order.', icon: GripHorizontal, keywords: ['reorder', 'move', 'arrange', 'order', 'drag'] },
  { id: 'reverse-pages', label: 'Reverse pages', description: 'Put the pages in the opposite order.', icon: ArrowDownUp, keywords: ['reverse', 'invert', 'backwards', 'order'] },
  {
    id: 'page-labels',
    label: 'Number pages (page labels)',
    description: 'Number pages with 1, 2, 3, i, ii, iii or A, B, C labels and a prefix.',
    icon: ListOrdered,
    keywords: ['number', 'page labels', 'numbering', 'roman', 'prefix', 'bates'],
  },
];

LIGHT.forEach((t, k) => {
  registerTask({
    ...t,
    color: GREEN,
    category: 'organize',
    order: 10 + k,
    requiresDocument: true,
    Panel: OrganizePanel,
    MainView: OrganizeView,
    onOpen: () => {
      organize.setFocusAction(FOCUS_TASKS[t.id]);
      seedGrid();
    },
  });
});

// ── commands (menus / command palette; no global shortcuts) ─────────────────

const docId = () => getActiveDoc()?.id ?? null;
const editable = () => {
  const id = docId();
  return !!id && !engine.isReadOnly(id);
};

registerCommands([
  { id: 'organize-open', label: 'Organize pages', icon: LayoutGrid, menu: 'document', group: '3-organize', order: 0, requiresDocument: true, run: () => actions.openTask(TASK_ORGANIZE) },
  {
    id: 'organize-insert-blank',
    label: 'Insert blank page…',
    icon: FilePlus2,
    menu: 'document',
    group: '3-organize',
    order: 1,
    requiresDocument: true,
    enabled: editable,
    run: () => {
      const id = docId();
      const t = commandTargets();
      if (id) void ops.insertBlank(id, t.length ? t[t.length - 1] + 1 : undefined);
    },
  },
  {
    id: 'organize-insert-file',
    label: 'Insert pages from file…',
    icon: FileInput,
    menu: 'document',
    group: '3-organize',
    order: 2,
    requiresDocument: true,
    enabled: editable,
    run: () => {
      const id = docId();
      const t = commandTargets();
      if (id) void ops.insertFromFile(id, t.length ? t[t.length - 1] + 1 : undefined);
    },
  },
  {
    id: 'organize-extract',
    label: 'Extract pages…',
    icon: FileOutput,
    menu: 'document',
    group: '3-organize',
    order: 3,
    requiresDocument: true,
    enabled: editable,
    run: () => {
      const id = docId();
      if (id) void ops.extract(id, commandTargets());
    },
  },
  {
    id: 'organize-replace',
    label: 'Replace pages…',
    icon: Replace,
    menu: 'document',
    group: '3-organize',
    order: 4,
    requiresDocument: true,
    enabled: editable,
    run: () => {
      const id = docId();
      if (id) void ops.replace(id, commandTargets());
    },
  },
  {
    id: 'organize-labels',
    label: 'Page labels…',
    icon: ListOrdered,
    menu: 'document',
    group: '3-organize',
    order: 5,
    requiresDocument: true,
    enabled: editable,
    run: () => {
      const id = docId();
      if (id) void ops.pageLabels(id, commandTargets());
    },
  },
  {
    id: 'organize-reverse',
    label: 'Reverse page order',
    icon: ArrowDownUp,
    menu: 'document',
    group: '3-organize',
    order: 6,
    requiresDocument: true,
    enabled: () => editable() && (getActiveDoc()?.pages.length ?? 0) > 1,
    run: () => {
      const id = docId();
      if (id) void ops.reverse(id, []);
    },
  },
  { id: 'organize-split', label: 'Split a PDF', icon: Scissors, menu: 'document', group: '3-organize', order: 7, requiresDocument: true, run: () => actions.openTask(TASK_SPLIT) },
  { id: 'organize-combine', label: 'Combine files', icon: Combine, menu: 'document', group: '3-organize', order: 8, run: () => actions.openTask(TASK_COMBINE) },
]);

registerThumbnailMenu();
