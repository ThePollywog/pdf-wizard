/** Left workspace panel: the active task's Panel, or the compact "All tools" list. */
import { LayoutGrid } from 'lucide-react';
import { useRegistry } from '@/core/registry';
import { actions, useApp } from '@/core/store';
import { Button, PanelHeader } from '@/core/ui';
import { AllToolsList } from '../AllTools';
import { ErrorBoundary } from '../ErrorBoundary';
import { shell, useShell } from '../uiStore';
import { Resizer } from './Resizer';

export const LEFT_DEFAULT_WIDTH = 280;

export function LeftPanel() {
  const taskId = useApp((s) => s.activeTaskId);
  const task = useRegistry((s) => (taskId ? s.tasks[taskId] : undefined));
  const width = useShell((s) => s.leftWidth);
  const close = () => actions.setLeftPanelOpen(false);
  const Panel = task?.Panel;

  return (
    <aside className="ws-left" style={{ width }} aria-label={task ? task.label : 'All tools'} data-testid="left-panel" data-task-id={task?.id}>
      {task ? (
        <>
          <PanelHeader title={task.label} icon={task.icon} iconColor={task.color ?? '#5c5ce0'} onBack={() => actions.openTask(null)} onClose={close} />
          <div className="ws-left-body">
            {Panel ? (
              <ErrorBoundary name={task.label} resetKey={task.id} compact>
                <Panel />
              </ErrorBoundary>
            ) : (
              <div className="ws-left-info">
                <p>{task.description}</p>
                <Button size="sm" onClick={() => actions.openTask(null)}>
                  Close tool
                </Button>
              </div>
            )}
          </div>
        </>
      ) : (
        <>
          <PanelHeader title="All tools" icon={LayoutGrid} onClose={close} />
          <div className="ws-left-body ws-left-body-flush">
            <AllToolsList />
          </div>
        </>
      )}
      <Resizer edge="end" width={width} min={220} max={480} defaultWidth={LEFT_DEFAULT_WIDTH} onResize={shell.setLeftWidth} label="Resize tools panel" />
    </aside>
  );
}
