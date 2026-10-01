/**
 * Document workspace: quick-tools rail, left panel (All tools / task), document header,
 * tool options, the viewer (or the task's MainView), right panels and the page/zoom pill.
 * Always mounted; hidden (and inert) when another route is shown so returning is instant.
 */
import { FileWarning, Minimize2, X } from 'lucide-react';
import { useRegistry } from '@/core/registry';
import { actions, useApp, useDoc } from '@/core/store';
import type { DocId } from '@/core/types';
import { DocumentViewer } from '@/core/viewer';
import { Button, EmptyState, Spinner } from '@/core/ui';
import { ErrorBoundary } from '../ErrorBoundary';
import { requestCloseDoc } from '../docActions';
import { shell, useShell } from '../uiStore';
import { DocHeader } from './DocHeader';
import { LeftPanel } from './LeftPanel';
import { PageNav } from './PageNav';
import { QuickRail } from './QuickRail';
import { RightPanel, RightRail } from './RightPanels';
import { ToolOptionsRow } from './ToolOptionsRow';

/** Keep in sync with the overlay breakpoints in styles/shell.css. */
const RIGHT_OVERLAY_QUERY = '(max-width: 1099px)';
const LEFT_OVERLAY_QUERY = '(max-width: 799px)';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

function Stage({ docId }: { docId: DocId }) {
  const loadError = useDoc(docId, (d) => d?.loadError ?? null);
  const loading = useDoc(docId, (d) => !!d?.loading);
  const hasPages = useDoc(docId, (d) => (d?.pages.length ?? 0) > 0);
  const name = useDoc(docId, (d) => d?.name ?? '');
  const taskId = useApp((s) => s.activeTaskId);
  const task = useRegistry((s) => (taskId ? s.tasks[taskId] : undefined));
  const Main = task?.MainView;

  if (loadError) {
    return (
      <div className="ws-stage" data-testid="viewer-stage">
        <EmptyState
          icon={FileWarning}
          title={`Couldn't open ${name}`}
          description={loadError}
          action={
            <Button icon={X} onClick={() => void requestCloseDoc(docId)}>
              Close this tab
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className={cx('ws-stage', Main && 'has-main-view')} data-testid="viewer-stage">
      {Main && task ? (
        <div className="ws-main-view" data-testid="task-main-view" data-task-id={task.id}>
          <ErrorBoundary name={task.label} resetKey={`${task.id}:${docId}`}>
            <Main />
          </ErrorBoundary>
        </div>
      ) : (
        <>
          <ErrorBoundary name="the document viewer" resetKey={docId}>
            <DocumentViewer key={docId} docId={docId} />
          </ErrorBoundary>
          {hasPages && <PageNav docId={docId} />}
        </>
      )}
      {loading && !hasPages && (
        <div className="ws-loading" role="status" data-testid="doc-loading">
          <Spinner size={28} label="Opening" />
          <span>Opening {name}…</span>
        </div>
      )}
    </div>
  );
}

function DocWorkspace({ docId }: { docId: DocId }) {
  const readMode = useShell((s) => s.readMode);
  const leftOpen = useApp((s) => s.leftPanelOpen);
  const rightId = useApp((s) => s.rightPanelId);
  const rightOpen = useRegistry((s) => !!rightId && !!s.panels[rightId]);
  const toolId = useApp((s) => s.activeToolId);

  return (
    <div className={cx('ws-body', readMode && 'is-read-mode', leftOpen && 'has-left', rightOpen && 'has-right')} data-tool={toolId}>
      {!readMode && <QuickRail docId={docId} />}
      {!readMode && leftOpen && <LeftPanel />}
      <div className="ws-center">
        {!readMode && <DocHeader docId={docId} />}
        {!readMode && <ToolOptionsRow />}
        <Stage docId={docId} />
      </div>
      {!readMode && <RightPanel docId={docId} />}
      {!readMode && <RightRail docId={docId} />}
      {!readMode && (leftOpen || rightOpen) && (
        <div
          className="ws-scrim"
          aria-hidden
          onClick={() => {
            // Only panels that currently float over the document (see shell.css breakpoints) close.
            if (rightOpen && window.matchMedia(RIGHT_OVERLAY_QUERY).matches) actions.setRightPanel(null);
            if (leftOpen && window.matchMedia(LEFT_OVERLAY_QUERY).matches) actions.setLeftPanelOpen(false);
          }}
        />
      )}
      {readMode && (
        <Button className="ws-exit-read" size="sm" icon={Minimize2} onClick={() => shell.setReadMode(false)} data-testid="exit-read-mode">
          Exit read mode
        </Button>
      )}
    </div>
  );
}

export function Workspace() {
  const route = useApp((s) => s.route);
  const docId = useApp((s) => s.activeDocId);
  const exists = useApp((s) => !!(s.activeDocId && s.docs[s.activeDocId]));
  const hidden = route !== 'document' || !docId || !exists;
  return (
    <div className={cx('workspace', hidden && 'is-hidden')} inert={hidden} aria-hidden={hidden || undefined} data-testid="workspace">
      {docId && exists && <DocWorkspace docId={docId} />}
    </div>
  );
}
