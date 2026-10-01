/**
 * Floating navigation UI (Find bar, Read Out Loud control) rendered over the active document
 * viewer. The shell has no viewer-overlay slot, so a small React root portals into the viewer's
 * root element (`.pdfwizard-viewer[data-doc-id]`), which is positioned and clips its children.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { createRoot } from 'react-dom/client';
import { useApp } from '@/core/store';
import { ErrorBoundaryLite } from './ErrorBoundaryLite';

type Slot = (props: { docId: string }) => ReactNode;
const slots: { id: string; Component: Slot }[] = [];

export function registerViewerOverlay(id: string, Component: Slot) {
  if (!slots.some((s) => s.id === id)) slots.push({ id, Component });
}

function findViewer(docId: string | null): HTMLElement | null {
  if (!docId) return null;
  return document.querySelector<HTMLElement>(`.pdfwizard-viewer[data-doc-id="${CSS.escape(docId)}"]`);
}

function OverlayHost() {
  const route = useApp((s) => s.route);
  const docId = useApp((s) => s.activeDocId);
  const [el, setEl] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (route !== 'document' || !docId) {
      setEl(null);
      return;
    }
    // The viewer element is (re)created by the workspace; track it cheaply.
    const check = () => {
      const v = findViewer(docId);
      setEl((prev) => (prev === v && v?.isConnected ? prev : v));
    };
    check();
    const id = window.setInterval(check, 250);
    return () => window.clearInterval(id);
  }, [route, docId]);

  if (!el || !docId) return null;
  return createPortal(
    <div className="navigation-overlay" data-testid="navigation-overlay">
      {slots.map(({ id, Component }) => (
        <ErrorBoundaryLite key={id} name={id}>
          <Component docId={docId} />
        </ErrorBoundaryLite>
      ))}
    </div>,
    el,
    `navigation-overlay-${docId}`,
  );
}

let mounted = false;
export function mountOverlay() {
  if (mounted || typeof document === 'undefined') return;
  mounted = true;
  const host = document.createElement('div');
  host.id = 'navigation-overlay-root';
  host.style.display = 'contents';
  document.body.appendChild(host);
  createRoot(host).render(<OverlayHost />);
}
