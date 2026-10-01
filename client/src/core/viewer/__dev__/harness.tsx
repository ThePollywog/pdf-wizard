/**
 * Viewer dev harness — http://localhost:<web>/client/src/core/viewer/__dev__/harness.html?file=sample.pdf
 *
 * Mounts DocumentViewer + the thumbnails panel outside the shell, with a 'test-rect' object type,
 * a 'test-rect' drawing tool, a text-markup test tool and a text-selection action that draw the
 * returned PDF-space rects back as decorations (alignment check). Exposes `window.__h` for
 * Playwright scripts (see verify*.mjs next to this file).
 */
import '@/styles/index.css';
import { useState, type CSSProperties, type PointerEvent as RPointerEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { Highlighter, Square } from 'lucide-react';
import type { DocId, ObjectRenderProps, PageOverlayProps, PdfObject, Rect, TextSelectionInfo } from '@/core/types';
import { actions, getDoc, newObject, useApp } from '@/core/store';
import { reg, registerObjectType, registerTextSelectionAction, registerTool, useRegistry } from '@/core/registry';
import * as engine from '@/core/engine';
import { UIHosts } from '@/core/ui';
import { rectFromPoints } from '@/core/geometry';
import { DocumentViewer, getPageElement, scrollToObject, usePageViewport } from '@/core/viewer';
import '@/features/thumbnails';
import { useViewerUi, viewerUi } from '../viewerStore';

// ── test object type ──────────────────────────────────────────────────────────

type TestRect = PdfObject<'test-rect', { label?: string }>;

function TestRectRender({ obj, editing, box }: ObjectRenderProps<TestRect>) {
  return (
    <div
      data-testid="test-rect"
      style={{
        position: 'absolute',
        inset: 0,
        border: `${Math.max(1, (obj.strokeWidth ?? 2) * (box.width / Math.max(1, obj.rect.width)))}px solid ${obj.color ?? '#e34850'}`,
        background: obj.fillColor ?? 'transparent',
        opacity: obj.opacity ?? 1,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        font: '600 11px system-ui',
        color: '#333',
      }}
    >
      {editing ? 'editing…' : (obj.data.label ?? '')}
    </div>
  );
}

registerObjectType<TestRect>({
  kind: 'test-rect',
  label: 'Test rectangle',
  icon: Square,
  category: 'comment',
  Render: TestRectRender,
  editable: true,
  minSize: { width: 12, height: 12 },
  summary: (o) => o.data.label ?? 'Rectangle',
});

// ── test-rect tool ────────────────────────────────────────────────────────────

function RectOverlay({ docId, page, toPdf, rectToView }: PageOverlayProps) {
  const [drag, setDrag] = useState<{ a: { x: number; y: number }; b: { x: number; y: number } } | null>(null);
  const down = (e: RPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const p = toPdf(e.clientX, e.clientY);
    setDrag({ a: p, b: p });
  };
  const move = (e: RPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    setDrag({ a: drag.a, b: toPdf(e.clientX, e.clientY) });
  };
  const up = () => {
    if (!drag) return;
    const r = rectFromPoints(drag.a, drag.b);
    setDrag(null);
    if (r.width < 4 || r.height < 4) return;
    actions.addObject(
      docId,
      newObject<TestRect>({ kind: 'test-rect', pageId: page.id, rect: r, color: '#e34850', fillColor: null, strokeWidth: 2, opacity: 1, data: {} }),
      { select: true, label: 'Add rectangle' },
    );
    actions.toolDone();
  };
  const preview = drag ? rectToView(rectFromPoints(drag.a, drag.b)) : null;
  return (
    <div style={{ position: 'absolute', inset: 0, cursor: 'crosshair' }} onPointerDown={down} onPointerMove={move} onPointerUp={up} data-testid="rect-overlay">
      {preview && <div style={{ position: 'absolute', ...preview, border: '1px dashed #e34850' }} />}
    </div>
  );
}

registerTool({ id: 'test-rect', label: 'Rectangle', icon: Square, group: 'shape', shortcut: 'r', order: 50, PageOverlay: RectOverlay, oneShot: true });

// ── text selection checks: draw the returned rects as decorations ────────────

function showSelectionRects(selections: TextSelectionInfo[]) {
  const docId = selections[0]?.docId;
  if (!docId) return;
  actions.setDecorations(
    docId,
    'harness-textsel',
    selections.map((s) => ({ pageId: s.pageId, rects: s.rects, color: 'rgba(255, 0, 120, 0.35)', title: s.text })),
  );
  (window as unknown as { __lastSelections: TextSelectionInfo[] }).__lastSelections = selections;
}

registerTool({ id: 'test-markup', label: 'Markup (test)', icon: Highlighter, group: 'markup', shortcut: 'u', order: 51, textSelection: true, onTextSelected: showSelectionRects });
registerTextSelectionAction({ id: 'harness.mark', label: 'Mark (test)', icon: Highlighter, order: 1, run: showSelectionRects });

// ── loading ───────────────────────────────────────────────────────────────────

// The shell does the same at startup: configure pdf.js (worker, file handlers, export hooks) and keep
// the pdf.js proxy in sync with the bytes after every edit.
engine.initPdfjs();
engine.startEngineSync();

async function load(name: string): Promise<DocId> {
  const res = await fetch(`/fixtures/${name}`);
  if (!res.ok) throw new Error(`fixture ${name}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const id = await engine.openBytes(name, bytes, { activate: true });
  if (!id) throw new Error(`fixture ${name} could not be opened`);
  return id;
}

// ── UI ────────────────────────────────────────────────────────────────────────

const FIXTURES = ['sample.pdf', 'form.pdf', 'rotated.pdf', 'large.pdf', 'mixed-sizes.pdf', 'annotated.pdf', 'images.pdf', 'scanned.pdf'];

function Harness() {
  const docId = useApp((s) => s.activeDocId);
  const tabs = useApp((s) => s.tabs);
  const view = useApp((s) => (docId ? s.docs[docId]?.view : undefined));
  const toolId = useApp((s) => s.activeToolId);
  const tools = useRegistry((s) => s.tools);
  const panel = useRegistry((s) => s.panels.thumbnails);
  const visible = useViewerUi((s) => (docId ? s.visible[docId] : undefined));
  const [showPanel, setShowPanel] = useState(true);
  const Panel = panel?.Component;

  const bar: CSSProperties = { display: 'flex', gap: 6, alignItems: 'center', padding: '6px 10px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap', font: '12px system-ui', background: 'var(--panel)' };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <div style={bar} data-testid="harness-bar">
        <select data-testid="fixture" onChange={(e) => void load(e.target.value)} defaultValue="">
          <option value="" disabled>
            Open fixture…
          </option>
          {FIXTURES.map((f) => (
            <option key={f}>{f}</option>
          ))}
        </select>
        {tabs.map((t) => (
          <button key={t} onClick={() => actions.setActiveDoc(t)} style={{ fontWeight: t === docId ? 700 : 400 }}>
            {getDoc(t)?.name}
          </button>
        ))}
        {docId && view && (
          <>
            <span>|</span>
            <select value={view.layout} onChange={(e) => actions.setView(docId, { layout: e.target.value as typeof view.layout })} data-testid="layout">
              {['continuous', 'single', 'two-page', 'two-page-continuous'].map((l) => (
                <option key={l}>{l}</option>
              ))}
            </select>
            <button onClick={() => actions.zoomOut(docId)}>−</button>
            <span data-testid="zoom">{Math.round(view.zoom * 100)}%</span>
            <button onClick={() => actions.zoomIn(docId)}>+</button>
            <button onClick={() => actions.fit(docId, 'width')}>Fit W</button>
            <button onClick={() => actions.fit(docId, 'page')}>Fit P</button>
            <button onClick={() => actions.rotateView(docId, 90)}>⟳</button>
            <button onClick={() => actions.setView(docId, { darkPages: !view.darkPages })}>Dark</button>
            <span data-testid="page">
              p{view.currentPage + 1} rot{view.rotation} fit:{String(view.fit)}
            </span>
            <span data-testid="visible">vis[{visible?.join(',')}]</span>
            <span>|</span>
            {Object.values(tools)
              .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
              .map((t) => (
                <button key={t.id} data-tool={t.id} onClick={() => actions.setTool(t.id)} style={{ fontWeight: t.id === toolId ? 700 : 400 }}>
                  {t.label}
                </button>
              ))}
            <button onClick={() => setShowPanel((v) => !v)}>Thumbs</button>
          </>
        )}
      </div>
      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }} data-testid="stage">
          {docId ? <DocumentViewer key={docId} docId={docId} /> : <div style={{ padding: 24 }}>Pick a fixture</div>}
        </div>
        {docId && Panel && showPanel && (
          <aside style={{ width: 300, borderLeft: '1px solid var(--border)', background: 'var(--panel)', display: 'flex', flexDirection: 'column', minHeight: 0 }} data-testid="right-panel">
            <Panel docId={docId} />
          </aside>
        )}
      </div>
      <UIHosts />
    </div>
  );
}

const w = window as unknown as Record<string, unknown>;
w.__h = {
  load,
  actions,
  getDoc,
  useApp,
  reg,
  engine,
  viewerUi,
  getPageElement,
  scrollToObject,
  docId: () => useApp.getState().activeDocId,
  doc: () => getDoc(useApp.getState().activeDocId),
  engineMode: () => 'engine' as const,
  /** Add a test rect on page `pageIndex` (PDF rect). */
  addRect(pageIndex: number, rect: Rect, extra: Partial<TestRect> = {}) {
    const d = getDoc(useApp.getState().activeDocId);
    if (!d) throw new Error('no doc');
    const obj = newObject<TestRect>({ kind: 'test-rect', pageId: d.pages[pageIndex].id, rect, color: '#e34850', fillColor: null, strokeWidth: 2, opacity: 1, data: {}, ...extra });
    actions.addObject(d.id, obj, { label: 'Add rectangle' });
    return obj.id;
  },
};
void usePageViewport; // exported API smoke-import

createRoot(document.getElementById('root')!).render(<Harness />);

const initial = new URLSearchParams(location.search).get('file');
if (initial) void load(initial).catch((e) => console.error('[harness] load failed', e));
