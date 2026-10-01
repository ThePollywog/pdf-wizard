/**
 * VIEWER public API. See docs/ARCHITECTURE.md → Viewer.
 *
 *   <DocumentViewer docId/>        the page canvas (virtualized pages, layers, selection, tools)
 *   <PageThumbnail …/>             lazily rendered thumbnail image
 *   usePageViewport(docId, i)      pdf.js viewport at the current zoom / rotation
 *   getPageElement(docId, i)       `.pdfwizard-page` element (null when virtualized away)
 *   scrollToObject(docId, id)      scroll an object into view and select it
 *   useVisiblePages(docId)         indices of the pages intersecting the viewport
 *
 * Importing this module registers the built-in 'select' and 'hand' tools.
 */
import 'pdfjs-dist/web/pdf_viewer.css';
import './viewer.css';
import { useApp } from '../store';
import type { DocId } from '../types';
import { registerViewerTools } from './tools';
import { forgetViewerState } from './scrolling';
import { purgeDocCanvases } from './canvasCache';
import { useViewerUi } from './viewerStore';

export { DocumentViewer } from './DocumentViewer';
export { PageThumbnail, type PageThumbnailProps } from './PageThumbnail';
export { usePageViewport, getPageElement, scrollToObject } from './hooks';
export { useVisiblePages } from './viewerStore';

registerViewerTools();

// Drop per-document viewer state (saved scroll anchor, cached canvases…) when a document closes.
useApp.subscribe(
  (s) => s.docs,
  (docs, prev) => {
    for (const id of Object.keys(prev) as DocId[]) {
      if (docs[id]) continue;
      forgetViewerState(id);
      purgeDocCanvases(id);
      const ui = useViewerUi.getState();
      if (ui.visible[id]) {
        const visible = { ...ui.visible };
        delete visible[id];
        useViewerUi.setState({ visible });
      }
      if (ui.commentFor?.docId === id) useViewerUi.setState({ commentFor: null });
      if (ui.textPopup?.docId === id) useViewerUi.setState({ textPopup: null });
    }
  },
);
