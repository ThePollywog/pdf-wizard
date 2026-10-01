/**
 * Previews that bridge the time between a committed edit and the page re-render (ghosts), and the
 * live previews of drags (moved snapshot, reflowed text).
 */
import { memo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import type { DocId, PageViewport, Rect, ViewBox } from '@/core/types';
import { rectToView } from '@/core/geometry';
import { useEditPdf, type Ghost, type TextPreviewSpec } from '../state';
import { quadPoints } from '../viewmath';
import { TextLines } from './TextLines';

/** Page-sized SVG painting user-space quads with the paper color. */
export function Covers({ quads, paper, vp }: { quads: number[][]; paper: string; vp: PageViewport }) {
  if (!quads.length || paper === 'transparent') return null;
  return (
    <svg className="edit-pdf-cover edit-pdf-paint" aria-hidden="true">
      {quads.map((q, i) => (
        <polygon key={i} points={quadPoints(vp, q)} fill={paper} />
      ))}
    </svg>
  );
}

/** Snapshot of page pixels drawn into a view box. */
export function Snap({ url, box }: { url: string; box: ViewBox }) {
  return (
    <img
      className="edit-pdf-snap edit-pdf-paint"
      src={url}
      alt=""
      draggable={false}
      style={{ left: box.left, top: box.top, width: box.width, height: box.height }}
    />
  );
}

export interface LivePreview {
  cover: number[][];
  paper: string;
  snap?: { url: string; to: Rect } | null;
  text?: TextPreviewSpec | null;
  /** Outline box (view px) drawn over the preview. */
  box?: ViewBox | null;
}

export function PreviewLayer({ preview, vp, zoom }: { preview: LivePreview; vp: PageViewport; zoom: number }) {
  return (
    <div className="edit-pdf-preview" aria-hidden="true">
      <Covers quads={preview.cover} paper={preview.paper} vp={vp} />
      {preview.snap && <Snap url={preview.snap.url} box={rectToView(vp, preview.snap.to)} />}
      {preview.text && <TextLines {...preview.text} vp={vp} zoom={zoom} className="edit-pdf-paint" />}
      {preview.box && <div className="edit-pdf-preview-box" style={{ left: preview.box.left, top: preview.box.top, width: preview.box.width, height: preview.box.height }} />}
    </div>
  );
}

const GhostView = memo(function GhostView({ g, vp, zoom }: { g: Ghost; vp: PageViewport; zoom: number }) {
  return (
    <div className="edit-pdf-ghost" data-testid="edit-pdf-ghost" aria-hidden="true">
      <Covers quads={g.cover} paper={g.paper} vp={vp} />
      {g.snap && <Snap url={g.snap.url} box={rectToView(vp, g.snap.to)} />}
      {g.text && <TextLines {...g.text} vp={vp} zoom={zoom} className="edit-pdf-paint" />}
    </div>
  );
});

export function Ghosts({ docId, pageIndex, vp, zoom }: { docId: DocId; pageIndex: number; vp: PageViewport; zoom: number }) {
  const ghosts = useEditPdf(useShallow((s) => s.ghosts.filter((g) => g.docId === docId && g.pageIndex === pageIndex)));
  if (!ghosts.length) return null;
  return (
    <>
      {ghosts.map((g) => (
        <GhostView key={g.id} g={g} vp={vp} zoom={zoom} />
      ))}
    </>
  );
}
