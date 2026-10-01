/** "All tools": the full page (grouped by category, searchable) and the compact list for the left panel. */
import { useMemo, useState } from 'react';
import { PackageOpen, Search, SearchX } from 'lucide-react';
import { useRegistry } from '@/core/registry';
import { useApp } from '@/core/store';
import type { TaskCategory, TaskDef } from '@/core/types';
import { EmptyState, TextField, Tooltip } from '@/core/ui';
import { fuzzyScore } from './CommandPalette';
import { openTaskFlow } from './docActions';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

export const CATEGORY_LABELS: Record<TaskCategory, string> = {
  popular: 'Popular tools',
  create: 'Create & convert',
  convert: 'Export & convert',
  edit: 'Edit',
  organize: 'Organize & optimize',
  comment: 'Comment',
  review: 'Review & compare',
  sign: 'Fill & sign',
  forms: 'Forms',
  protect: 'Protect & redact',
  scan: 'Scan & OCR',
  ai: 'AI Assistant',
  other: 'More tools',
};
export const CATEGORY_ORDER: TaskCategory[] = ['popular', 'create', 'edit', 'convert', 'organize', 'comment', 'review', 'sign', 'forms', 'protect', 'scan', 'ai', 'other'];

const DEFAULT_COLOR = '#5c5ce0';

export function taskMatches(t: TaskDef, q: string): number {
  if (!q) return 0;
  return Math.max(
    fuzzyScore(t.label, q),
    ...(t.keywords ?? []).map((k) => fuzzyScore(k, q) - 10),
    t.description.toLowerCase().includes(q) ? 25 : -1,
    CATEGORY_LABELS[t.category]?.toLowerCase().includes(q) ? 15 : -1,
  );
}

export function useSortedTasks(): TaskDef[] {
  const tasks = useRegistry((s) => s.tasks);
  return useMemo(() => Object.values(tasks).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.label.localeCompare(b.label)), [tasks]);
}

function groupTasks(tasks: TaskDef[]) {
  return CATEGORY_ORDER.map((c) => ({ category: c, tasks: tasks.filter((t) => (CATEGORY_ORDER.includes(t.category) ? t.category : 'other') === c) })).filter(
    (g) => g.tasks.length > 0,
  );
}

/** Colored icon tile used by task tiles, lists and the palette. */
export function TaskIcon({ task, size = 40 }: { task: Pick<TaskDef, 'icon' | 'color'>; size?: number }) {
  const Icon = task.icon;
  return (
    <span className="task-icon" style={{ width: size, height: size, background: task.color ?? DEFAULT_COLOR, borderRadius: Math.round(size * 0.25) }} aria-hidden>
      <Icon size={Math.round(size * 0.5)} strokeWidth={1.9} />
    </span>
  );
}

export function TaskTile({ task, compact }: { task: TaskDef; compact?: boolean }) {
  const needsFile = task.requiresDocument && !useApp.getState().activeDocId;
  return (
    <button
      type="button"
      className={cx('task-tile', compact && 'is-compact')}
      onClick={() => void openTaskFlow(task.id)}
      data-testid="task-tile"
      data-task-id={task.id}
      title={needsFile ? `${task.description} (you'll be asked to choose a file)` : task.description}
    >
      <TaskIcon task={task} size={compact ? 36 : 44} />
      <span className="task-tile-text">
        <span className="task-tile-label">{task.label}</span>
        <span className="task-tile-desc">{task.description}</span>
      </span>
    </button>
  );
}

function NoTools() {
  const failed = useRegistry((s) => s.failed);
  const ready = useRegistry((s) => s.ready);
  return (
    <EmptyState
      icon={PackageOpen}
      title={ready ? 'No tools available' : 'Loading tools…'}
      description={
        ready
          ? failed.length
            ? `${failed.length} feature${failed.length === 1 ? '' : 's'} failed to load (${failed.map((f) => f.id).join(', ')}). Check the console for details.`
            : 'Tools appear here as features are installed.'
          : undefined
      }
    />
  );
}

export function AllToolsPage() {
  const tasks = useSortedTasks();
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const results = useMemo(() => {
    if (!q) return null;
    return tasks
      .map((t) => ({ t, s: taskMatches(t, q) }))
      .filter((x) => x.s >= 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.t);
  }, [tasks, q]);
  const groups = useMemo(() => groupTasks(tasks), [tasks]);

  return (
    <div className="page all-tools" data-testid="all-tools">
      <div className="page-inner">
        <header className="page-head">
          <div>
            <h1 className="page-title">All tools</h1>
            <p className="page-subtitle">Everything you can do with your PDFs, in one place.</p>
          </div>
          <TextField
            icon={Search}
            value={query}
            onChange={setQuery}
            placeholder="Search tools"
            aria-label="Search tools"
            className="all-tools-search"
            type="search"
            autoFocus
            data-testid="tools-search"
          />
        </header>
        {tasks.length === 0 ? (
          <NoTools />
        ) : results ? (
          results.length ? (
            <section className="tools-section">
              <h2 className="tools-section-title">
                {results.length} result{results.length === 1 ? '' : 's'} for “{query.trim()}”
              </h2>
              <div className="tools-grid">
                {results.map((t) => (
                  <TaskTile key={t.id} task={t} />
                ))}
              </div>
            </section>
          ) : (
            <EmptyState icon={SearchX} title={`No tools match “${query.trim()}”`} description="Try another word, like “combine”, “sign” or “compress”." />
          )
        ) : (
          groups.map((g) => (
            <section key={g.category} className="tools-section" aria-labelledby={`cat-${g.category}`}>
              <h2 className="tools-section-title" id={`cat-${g.category}`}>
                {CATEGORY_LABELS[g.category]}
              </h2>
              <div className="tools-grid">
                {g.tasks.map((t) => (
                  <TaskTile key={t.id} task={t} />
                ))}
              </div>
            </section>
          ))
        )}
      </div>
    </div>
  );
}

/** Compact list of all tasks for the workspace left panel. */
export function AllToolsList() {
  const tasks = useSortedTasks();
  const activeTaskId = useApp((s) => s.activeTaskId);
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const list = useMemo(
    () =>
      q
        ? tasks
            .map((t) => ({ t, s: taskMatches(t, q) }))
            .filter((x) => x.s >= 0)
            .sort((a, b) => b.s - a.s)
            .map((x) => x.t)
        : null,
    [tasks, q],
  );
  const groups = useMemo(() => groupTasks(tasks), [tasks]);

  const row = (t: TaskDef) => (
    <li key={t.id}>
      <Tooltip label={t.description} side="right" delay={800}>
        <button
          type="button"
          className={cx('tools-list-item', activeTaskId === t.id && 'is-active')}
          onClick={() => void openTaskFlow(t.id)}
          data-testid="tools-list-item"
          data-task-id={t.id}
        >
          <TaskIcon task={t} size={28} />
          <span className="tools-list-label">{t.label}</span>
        </button>
      </Tooltip>
    </li>
  );

  return (
    <div className="tools-list" data-testid="tools-list">
      <div className="tools-list-search">
        <TextField size="sm" icon={Search} value={query} onChange={setQuery} placeholder="Find a tool" aria-label="Find a tool" type="search" />
      </div>
      <div className="tools-list-scroll">
        {tasks.length === 0 ? (
          <EmptyState compact icon={PackageOpen} title="No tools available" />
        ) : list ? (
          list.length ? (
            <ul className="tools-list-group">{list.map(row)}</ul>
          ) : (
            <EmptyState compact icon={SearchX} title="No matching tools" />
          )
        ) : (
          groups.map((g) => (
            <div key={g.category} className="tools-list-section">
              <div className="tools-list-heading">{CATEGORY_LABELS[g.category]}</div>
              <ul className="tools-list-group">{g.tasks.map(row)}</ul>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
