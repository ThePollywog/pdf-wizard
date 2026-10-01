/** Root component: top bar, routes, the (always mounted) document workspace and global hosts. */
import { useEffect, useRef, useState } from 'react';
import { FileUp } from 'lucide-react';
import { useRegistry } from '@/core/registry';
import { actions, getDoc, useApp } from '@/core/store';
import { UIHosts } from '@/core/ui';
import { AllToolsPage } from './AllTools';
import { CommandPalette } from './CommandPalette';
import { ErrorBoundary } from './ErrorBoundary';
import { Home } from './Home';
import { TaskRoute } from './TaskRoute';
import { TopBar } from './TopBar';
import { Workspace } from './workspace/Workspace';
import { openAccept, openFiles } from './docActions';
import { shell, useShell } from './uiStore';

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

/** Hidden multi-file input (used by tests and by anything that wants a plain <input> to target). */
function OpenFileInput() {
  useRegistry((s) => s.fileHandlers); // re-render when handlers change the accept list
  return (
    <input
      type="file"
      className="sr-only"
      tabIndex={-1}
      aria-hidden
      multiple
      accept={openAccept()}
      data-testid="open-file-input"
      onChange={(e) => {
        const files = Array.from(e.currentTarget.files ?? []);
        e.currentTarget.value = '';
        if (files.length) void openFiles(files);
      }}
    />
  );
}

/** Full-window drop target for opening files dragged from the desktop. */
function GlobalDrop() {
  const [over, setOver] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const hide = () => {
      window.clearTimeout(timer.current);
      setOver(false);
    };
    const onOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      // A nested drop zone (Home drop area, page insert targets…) handles this one itself.
      if (e.defaultPrevented || (e.target as Element | null)?.closest?.('[data-dropzone]')) {
        hide();
        return;
      }
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
      setOver(true);
      // dragleave is unreliable across child elements; hide if dragover stops arriving.
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setOver(false), 250);
    };
    const onLeave = (e: DragEvent) => {
      if (!e.relatedTarget) hide();
    };
    const onDrop = (e: DragEvent) => {
      hide();
      if (!hasFiles(e) || e.defaultPrevented) return;
      if ((e.target as Element | null)?.closest?.('[data-dropzone]')) return;
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) void openFiles(files);
    };
    window.addEventListener('dragover', onOver);
    window.addEventListener('dragleave', onLeave);
    window.addEventListener('drop', onDrop);
    window.addEventListener('dragend', hide);
    return () => {
      window.removeEventListener('dragover', onOver);
      window.removeEventListener('dragleave', onLeave);
      window.removeEventListener('drop', onDrop);
      window.removeEventListener('dragend', hide);
      window.clearTimeout(timer.current);
    };
  }, []);

  if (!over) return null;
  return (
    <div className="global-drop" aria-hidden data-testid="global-drop">
      <div className="global-drop-card">
        <FileUp size={40} strokeWidth={1.5} />
        <div className="global-drop-title">Drop to open</div>
        <div className="global-drop-hint">PDFs open in a new tab</div>
      </div>
    </div>
  );
}

/** Side effects tied to app state: title, unsaved-changes guard, per-document defaults. */
function useAppEffects() {
  const route = useApp((s) => s.route);
  const docName = useApp((s) => (s.activeDocId ? (s.docs[s.activeDocId]?.name ?? null) : null));
  const hasActive = useApp((s) => !!(s.activeDocId && s.docs[s.activeDocId]));
  const readMode = useShell((s) => s.readMode);

  useEffect(() => {
    document.title = route === 'document' && docName ? `${docName} - PDF Wizard` : route === 'tools' ? 'All tools - PDF Wizard' : 'PDF Wizard';
  }, [route, docName]);

  // A 'document' route without a document falls back to Home.
  useEffect(() => {
    if (route === 'document' && !hasActive) actions.setRoute('home');
  }, [route, hasActive]);

  // Read mode only applies to the workspace.
  useEffect(() => {
    if (readMode && (route !== 'document' || !hasActive)) shell.setReadMode(false);
  }, [readMode, route, hasActive]);

  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const s = useApp.getState();
      if (s.tabs.some((id) => s.docs[id]?.dirty)) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, []);

  // Apply preferences to newly opened documents.
  useEffect(() => {
    const seen = new Set(useApp.getState().tabs);
    return useApp.subscribe(
      (s) => s.tabs,
      (tabs) => {
        for (const id of tabs) {
          if (seen.has(id)) continue;
          seen.add(id);
          const s = useApp.getState();
          const d = getDoc(id);
          if (!d) continue;
          if (s.prefs.defaultFit === 'page') actions.fit(id, 'page');
          else if (s.prefs.defaultFit === 'width') actions.fit(id, 'width');
          if (s.activeDocId === id && !s.activeTaskId) actions.setLeftPanelOpen(s.prefs.showToolsPanel);
        }
        for (const id of Array.from(seen)) if (!tabs.includes(id)) seen.delete(id);
      },
    );
  }, []);
}

export function App() {
  const route = useApp((s) => s.route);
  const readMode = useShell((s) => s.readMode);
  useAppEffects();

  return (
    <div className={`app route-${route}${readMode ? ' is-read-mode' : ''}`} data-route={route}>
      {!(readMode && route === 'document') && (
        <ErrorBoundary name="the top bar" compact>
          <TopBar />
        </ErrorBoundary>
      )}
      <main className="app-main" id="main">
        {route === 'home' && (
          <ErrorBoundary name="Home" resetKey={route}>
            <Home />
          </ErrorBoundary>
        )}
        {route === 'tools' && (
          <ErrorBoundary name="All tools" resetKey={route}>
            <AllToolsPage />
          </ErrorBoundary>
        )}
        {route === 'task' && (
          <ErrorBoundary name="this tool" resetKey={route}>
            <TaskRoute />
          </ErrorBoundary>
        )}
        <ErrorBoundary name="the document workspace">
          <Workspace />
        </ErrorBoundary>
      </main>
      <OpenFileInput />
      <GlobalDrop />
      <CommandPalette />
      <UIHosts />
    </div>
  );
}
