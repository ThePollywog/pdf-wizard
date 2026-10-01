/**
 * Engine dev harness: http://localhost:<web>/client/src/core/engine/__dev__/harness.html
 * Renders the active document's pages with the engine, overlays test objects and (optionally) the
 * page text rects, and exposes `window.__harness` for Playwright.
 */
import '../../../styles/tokens.css';
import '../../../styles/base.css';
import '../../../styles/components.css';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as pdfLib from '@cantoo/pdf-lib';
import type { PageViewport } from 'pdfjs-dist';
import * as engine from '../index';
import { actions, getDoc, useApp, useDoc } from '../../store';
import { registerObjectType } from '../../registry';
import { UIHosts } from '../../ui';
import type { DocId, PdfObject, Rect } from '../../types';
import { hexToRgb01, uid } from '../../util';
import { rectToView } from '../../geometry';

const f3 = (v: number) => Math.round(v * 1000) / 1000;

registerObjectType({
  kind: 'test-rect',
  label: 'Test Rectangle',
  category: 'comment',
  Render: () => null,
  exportToPdf(obj, ctx) {
    const page = ctx.page(obj.pageId);
    const r = obj.rect;
    const sw = obj.strokeWidth ?? 2;
    const stroke = hexToRgb01(obj.color ?? '#ff0000').map(f3).join(' ');
    const fill = obj.fillColor ? hexToRgb01(obj.fillColor).map(f3).join(' ') : null;
    const ops = [
      `${sw} w`,
      `${stroke} RG`,
      fill ? `${fill} rg` : '',
      `${f3(r.x + sw / 2)} ${f3(r.y + sw / 2)} ${f3(r.width - sw)} ${f3(r.height - sw)} re`,
      fill ? 'B' : 'S',
    ]
      .filter(Boolean)
      .join('\n');
    ctx.annots.add(page, obj, { subtype: 'Square', appearance: { ops, bbox: r } });
  },
});

registerObjectType<PdfObject<'test-text', { text: string; size?: number }>>({
  kind: 'test-text',
  label: 'Test Text',
  category: 'content',
  Render: () => null,
  async exportToPdf(obj, ctx) {
    const page = ctx.page(obj.pageId);
    const font = await ctx.standardFont('Helvetica-Bold');
    page.drawText(obj.data.text, { x: obj.rect.x, y: obj.rect.y + 4, size: obj.data.size ?? 14, font, color: pdfLib.rgb(0, 0, 0.6) });
  },
});

const toastLog: { message: string; kind: string; at: number }[] = [];
useApp.subscribe(
  (s) => s.toasts,
  (list, prev) => {
    for (const t of list) if (!prev.includes(t)) toastLog.push({ message: t.message, kind: t.kind, at: Date.now() });
  },
);

let setShowTextExternal: (v: boolean) => void = () => {};

function PageView({ docId, index, scale, showText }: { docId: DocId; index: number; scale: number; showText: boolean }) {
  const pdfVersion = useDoc(docId, (d) => d?.pdfVersion ?? -1);
  const page = useDoc(docId, (d) => d?.pages[index]);
  const objects = useDoc(docId, (d) => d?.objects);
  const order = useDoc(docId, (d) => d?.order);
  const host = useRef<HTMLDivElement>(null);
  const [vp, setVp] = useState<PageViewport | null>(null);
  const [rects, setRects] = useState<Rect[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const canvas = await engine.renderPageToCanvas(docId, index, { scale });
      const pdf = await engine.awaitPdf(docId);
      const p = await pdf.getPage(index + 1);
      const v = p.getViewport({ scale });
      if (cancelled) return;
      canvas.style.width = `${v.width}px`;
      canvas.style.height = `${v.height}px`;
      canvas.style.display = 'block';
      host.current?.replaceChildren(canvas);
      setVp(v);
      setError(null);
      if (showText) {
        const t = await engine.getPageText(docId, index);
        if (!cancelled) setRects(t.items.flatMap((it) => engine.rangeRects(t, it.start, it.start + it.str.length)));
      } else setRects([]);
    })().catch((e) => {
      if (!cancelled) setError(String((e as Error)?.message ?? e));
    });
    return () => {
      cancelled = true;
    };
  }, [docId, index, scale, pdfVersion, showText]);

  const own = useMemo(
    () => (order ?? []).map((id) => objects?.[id]).filter((o): o is PdfObject => !!o && o.pageId === page?.id),
    [objects, order, page?.id],
  );
  const box = (r: Rect) => rectToView(vp!, r);

  return (
    <div className="hp-page" data-page-index={index} data-page-id={page?.id} style={{ width: vp?.width ?? 200, height: vp?.height ?? 260 }}>
      <div ref={host} />
      {error && <div className="hp-error">{error}</div>}
      {vp &&
        own.map((o) => (
          <div
            key={o.id}
            className="hp-object"
            data-object-id={o.id}
            style={{ ...box(o.rect), borderColor: o.color ?? '#ff0000', borderWidth: (o.strokeWidth ?? 2) * scale }}
            title={o.kind}
          />
        ))}
      {vp && showText && rects.map((r, i) => <div key={i} className="hp-text-rect" data-testid="text-rect" style={box(r)} />)}
      <div className="hp-page-label">
        {index + 1}
        {page?.label ? ` (${page.label})` : ''} · {page?.rotation}° · {page ? `${f3(page.width)}×${f3(page.height)}` : ''}
      </div>
    </div>
  );
}

function Harness() {
  const tabs = useApp((s) => s.tabs);
  const activeId = useApp((s) => s.activeDocId);
  const doc = useDoc(activeId, (d) => d);
  const [scale, setScale] = useState(0.75);
  const [showText, setShowText] = useState(false);
  setShowTextExternal = setShowText;
  const run = (fn: () => Promise<unknown>) => void fn().catch((e) => actions.toast(String((e as Error)?.message ?? e), { kind: 'error' }));

  return (
    <div className="hp-root">
      <div className="hp-bar">
        <input
          type="file"
          multiple
          data-testid="open-file-input"
          onChange={(e) => {
            const files = [...(e.currentTarget.files ?? [])];
            e.currentTarget.value = '';
            run(() => engine.openFiles(files));
          }}
        />
        <select value={activeId ?? ''} onChange={(e) => actions.setActiveDoc(e.target.value)} data-testid="doc-select">
          {tabs.map((id) => (
            <option key={id} value={id}>
              {getDoc(id)?.name}
            </option>
          ))}
        </select>
        {doc && (
          <>
            <button onClick={() => actions.undo(doc.id)} disabled={!doc.history.past.length}>
              Undo {doc.history.past[doc.history.past.length - 1]?.label ?? ''}
            </button>
            <button onClick={() => actions.redo(doc.id)} disabled={!doc.history.future.length}>
              Redo
            </button>
            <button onClick={() => run(() => engine.rotatePages(doc.id, [0], 90))}>Rotate p1</button>
            <button onClick={() => run(() => engine.saveDoc(doc.id))}>Save</button>
            <button onClick={() => run(() => engine.downloadDoc(doc.id))}>Download</button>
            <button onClick={() => run(() => engine.printDoc(doc.id))}>Print</button>
            <button onClick={() => actions.closeDocument(doc.id)}>Close</button>
          </>
        )}
        <label>
          <input type="checkbox" checked={showText} onChange={(e) => setShowText(e.target.checked)} /> Text rects
        </label>
        <label>
          Zoom{' '}
          <select value={scale} onChange={(e) => setScale(Number(e.target.value))}>
            {[0.5, 0.75, 1, 1.5].map((s) => (
              <option key={s} value={s}>
                {s * 100}%
              </option>
            ))}
          </select>
        </label>
        {doc && (
          <span className="hp-status" data-testid="doc-status">
            {doc.name} · v{doc.version} · {doc.pages.length} pages{doc.dirty ? ' · modified' : ''}
            {doc.security ? ' · secured' : ''}
            {engine.isReadOnly(doc.id) ? ' · read-only' : ''}
            {doc.loadError ? ` · ${doc.loadError}` : ''}
          </span>
        )}
      </div>
      <div className="hp-pages">
        {doc?.pages.map((p, i) => <PageView key={p.id} docId={doc.id} index={i} scale={scale} showText={showText} />)}
        {!doc && <div className="hp-empty">Open a PDF to start.</div>}
      </div>
      <UIHosts />
    </div>
  );
}

const style = document.createElement('style');
style.textContent = `
  body { margin: 0; background: var(--color-bg-subtle, #f0f0f0); font: 13px/1.4 system-ui, sans-serif; }
  .hp-bar { position: sticky; top: 0; z-index: 5; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 8px 12px; background: #fff; border-bottom: 1px solid #ddd; }
  .hp-status { color: #555; }
  .hp-pages { display: flex; flex-wrap: wrap; gap: 16px; padding: 16px; align-items: flex-start; }
  .hp-page { position: relative; background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.25); }
  .hp-object { position: absolute; border-style: dashed; box-sizing: border-box; pointer-events: none; }
  .hp-text-rect { position: absolute; background: rgba(20, 115, 230, .22); outline: 1px solid rgba(20, 115, 230, .6); pointer-events: none; }
  .hp-page-label { position: absolute; left: 0; right: 0; bottom: -18px; text-align: center; font-size: 11px; color: #666; }
  .hp-error { position: absolute; inset: 0; display: grid; place-items: center; color: #b00; padding: 12px; text-align: center; }
  .hp-empty { color: #777; padding: 40px; }
`;
document.head.appendChild(style);

engine.initPdfjs();
engine.startEngineSync();

(window as unknown as Record<string, unknown>).__harness = {
  engine,
  actions,
  useApp,
  getDoc,
  pdfLib,
  uid,
  toasts: toastLog,
  setShowText: (v: boolean) => setShowTextExternal(v),
};

createRoot(document.getElementById('root')!).render(<Harness />);
