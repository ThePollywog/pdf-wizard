/** Task ids of the organize feature and the action each lightweight task focuses. */
import { actions, useApp } from '@/core/store';
import type { FocusAction } from './store';

export const TASK_ORGANIZE = 'organize-pages';
export const TASK_COMBINE = 'combine-files';
export const TASK_SPLIT = 'split-pdf';
export const TASK_EXTRACT = 'extract-pages';

/** Lightweight tasks: the organize view with one action focused. */
export const FOCUS_TASKS: Record<string, FocusAction> = {
  'insert-pages': 'insert',
  'rotate-pages': 'rotate',
  'delete-pages': 'delete',
  'reorder-pages': 'reorder',
  'reverse-pages': 'reverse',
  'page-labels': 'labels',
};

/** Tasks showing the organize grid. */
export const GRID_TASKS = new Set([TASK_ORGANIZE, ...Object.keys(FOCUS_TASKS)]);

/** Every task of this feature (closing any of them returns to the viewer). */
export const ORGANIZE_TASKS = new Set([...GRID_TASKS, TASK_COMBINE, TASK_SPLIT, TASK_EXTRACT]);

export function focusActionFor(taskId: string | null | undefined): FocusAction | null {
  return (taskId && FOCUS_TASKS[taskId]) || null;
}

export const FOCUS_HINTS: Record<FocusAction, { title: string; text: string }> = {
  insert: {
    title: 'Insert pages',
    text: 'Use Insert to add a blank page or pages from a file, or hover between two pages and click + to insert right there. You can also drop files onto the grid.',
  },
  rotate: { title: 'Rotate pages', text: 'Select pages, then rotate them with the buttons or the arrows that appear when you hover over a page.' },
  delete: { title: 'Delete pages', text: 'Select the pages to remove (Shift or Ctrl/⌘ to select several), then click Delete or press the Delete key.' },
  reorder: { title: 'Reorder pages', text: 'Drag pages to a new position. Select several pages first to move them together.' },
  reverse: { title: 'Reverse pages', text: 'Reverse puts the whole document in the opposite order, or only the selected pages when two or more are selected.' },
  labels: { title: 'Number pages', text: 'Select a range of pages and use Page labels to number them 1, 2, 3, i, ii, iii, A, B… with an optional prefix.' },
};

/** Close whichever organize task is open (back to the viewer). */
export function closeOrganizeTask() {
  if (ORGANIZE_TASKS.has(useApp.getState().activeTaskId ?? '')) actions.openTask(null);
}
