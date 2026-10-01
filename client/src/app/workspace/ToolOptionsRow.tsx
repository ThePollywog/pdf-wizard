/**
 * Secondary toolbar under the document header: the active task's tool chips (task.toolbar)
 * and the active tool's OptionsBar, plus a "keep tool selected" lock for one-shot tools.
 */
import { Lock, LockOpen } from 'lucide-react';
import { useRegistry } from '@/core/registry';
import { actions, useApp } from '@/core/store';
import type { ToolDef } from '@/core/types';
import { Divider, formatShortcut, IconButton, Tooltip } from '@/core/ui';
import { ErrorBoundary } from '../ErrorBoundary';

const EMPTY: string[] = [];

function ToolChip({ tool, active }: { tool: ToolDef; active: boolean }) {
  const Icon = tool.icon;
  return (
    <Tooltip label={tool.label} shortcut={tool.shortcut} side="bottom">
      <button
        type="button"
        className={`tool-chip${active ? ' is-active' : ''}`}
        aria-pressed={active}
        aria-label={tool.shortcut ? `${tool.label} (${formatShortcut(tool.shortcut)})` : tool.label}
        onClick={() => actions.setTool(active ? 'select' : tool.id)}
        data-testid={`tool-chip-${tool.id}`}
      >
        <Icon size={16} strokeWidth={1.8} />
        <span className="tool-chip-label">{tool.label}</span>
      </button>
    </Tooltip>
  );
}

export function ToolOptionsRow() {
  const taskId = useApp((s) => s.activeTaskId);
  const toolbar = useRegistry((s) => (taskId ? (s.tasks[taskId]?.toolbar ?? EMPTY) : EMPTY));
  const tools = useRegistry((s) => s.tools);
  const toolId = useApp((s) => s.activeToolId);
  const locked = useApp((s) => s.toolLocked);
  const tool = tools[toolId] as ToolDef | undefined;
  const chips = toolbar.map((id) => tools[id]).filter((t): t is ToolDef => !!t);
  const Options = tool?.OptionsBar;
  const showLock = !!tool?.oneShot;

  if (!chips.length && !Options && !showLock) return null;

  return (
    <div className="tool-options" role="toolbar" aria-label="Tool options" data-testid="tool-options">
      {chips.length > 0 && (
        <div className="tool-options-chips">
          {chips.map((t) => (
            <ToolChip key={t.id} tool={t} active={t.id === toolId} />
          ))}
        </div>
      )}
      {chips.length > 0 && (Options || showLock) && <Divider vertical className="tool-options-divider" />}
      {tool && (Options || showLock) && (
        <div className="tool-options-bar" data-tool-id={tool.id}>
          <span className="tool-options-name">{tool.label}</span>
          {Options && (
            <ErrorBoundary name={`${tool.label} options`} resetKey={tool.id} silent>
              <Options />
            </ErrorBoundary>
          )}
          {showLock && (
            <IconButton
              icon={locked ? Lock : LockOpen}
              size="sm"
              label={locked ? 'Keep tool selected: on' : 'Keep tool selected: off'}
              active={locked}
              onClick={() => actions.setToolLocked(!locked)}
              data-testid="tool-lock"
            />
          )}
        </div>
      )}
    </div>
  );
}
