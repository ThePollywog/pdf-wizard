/** Route 'task': a task's MainView (or Panel) without a document, e.g. Combine files / Create PDF. */
import { ArrowLeft, PackageOpen } from 'lucide-react';
import { useRegistry } from '@/core/registry';
import { actions, useApp } from '@/core/store';
import { Button, EmptyState, IconButton } from '@/core/ui';
import { TaskIcon } from './AllTools';
import { ErrorBoundary } from './ErrorBoundary';

export function TaskRoute() {
  const taskId = useApp((s) => s.activeTaskId);
  const task = useRegistry((s) => (taskId ? s.tasks[taskId] : undefined));

  const back = () => {
    actions.openTask(null);
    actions.setRoute('tools');
  };

  if (!task) {
    return (
      <div className="page task-route">
        <EmptyState
          icon={PackageOpen}
          title="This tool isn't available"
          description="It may still be loading, or it failed to load."
          action={<Button onClick={back}>Go to All tools</Button>}
        />
      </div>
    );
  }

  const Main = task.MainView;
  const Panel = task.Panel;
  return (
    <div className="task-route" data-testid="task-route" data-task-id={task.id}>
      <header className="task-route-head">
        <IconButton icon={ArrowLeft} label="Back to All tools" onClick={back} data-testid="task-back" />
        <TaskIcon task={task} size={32} />
        <div className="task-route-titles">
          <h1 className="task-route-title">{task.label}</h1>
          <p className="task-route-desc">{task.description}</p>
        </div>
      </header>
      <div className="task-route-body">
        {Main ? (
          <ErrorBoundary name={task.label} resetKey={task.id}>
            <Main />
          </ErrorBoundary>
        ) : Panel ? (
          <div className="task-route-panel">
            <ErrorBoundary name={task.label} resetKey={task.id}>
              <Panel />
            </ErrorBoundary>
          </div>
        ) : (
          <EmptyState icon={task.icon} title={task.label} description="Open a document to use this tool." />
        )}
      </div>
    </div>
  );
}
