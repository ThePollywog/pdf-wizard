/**
 * link — a link created or edited with Edit PDF → Link. Drawn with its border (when visible) and
 * followed on click with the Select / Hand tools; exported as a /Link annotation with /A /URI or
 * /Dest [page /XYZ left top zoom], /Border, /BS, /C and /H.
 */
import type { CSSProperties, MouseEvent as RMouseEvent } from 'react';
import { ExternalLink, Link2, Pencil, Trash2 } from 'lucide-react';
import { actions, getDoc, useApp } from '@/core/store';
import type { ObjectRenderProps, ObjectTypeDef } from '@/core/types';
import { showContextMenu } from '@/core/ui';
import { linkExtra } from '../content/links';
import { followLink } from '../edits';
import { KIND_LINK, TOOL_LINK, type LinkData, type LinkObject } from '../model';
import { ui } from '../state';

export function linkTitle(docId: string, data: LinkData): string {
  const a = data.action;
  if (a.type === 'url') return a.url || 'Link';
  const doc = getDoc(docId);
  const i = doc ? doc.pages.findIndex((p) => p.id === a.pageId) : -1;
  return i >= 0 ? `Go to page ${doc?.pages[i].label ?? i + 1}` : 'Go to a page that no longer exists';
}

/** Border CSS of a link appearance at `scale`. */
export function linkBorderCss(data: LinkData, scale: number): CSSProperties {
  const ap = data.appearance;
  if (!ap.visible || ap.width <= 0) return {};
  const w = `${Math.max(1, ap.width * scale)}px`;
  if (ap.style === 'underline') return { borderBottom: `${w} solid ${ap.color}` };
  return { border: `${w} ${ap.style === 'dashed' ? 'dashed' : 'solid'} ${ap.color}` };
}

function LinkRender({ obj, docId, pageIndex, scale }: ObjectRenderProps<LinkObject>) {
  const toolId = useApp((s) => s.activeToolId);
  const live = toolId === 'select' || toolId === 'hand';
  const open = (e: RMouseEvent) => {
    if (!live || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    followLink(docId, obj.data);
  };
  const menu = (e: RMouseEvent) => {
    if (!live) return;
    e.preventDefault();
    e.stopPropagation();
    showContextMenu(e, [
      { id: 'edit-pdf-link-open', label: 'Open link', icon: ExternalLink, run: () => followLink(docId, obj.data) },
      {
        id: 'edit-pdf-link-edit',
        label: 'Edit link',
        icon: Pencil,
        run: () => {
          actions.setTool(TOOL_LINK);
          ui.setTarget({ type: 'object', docId, pageIndex, id: obj.id });
        },
      },
      'divider',
      { id: 'edit-pdf-link-delete', label: 'Delete link', icon: Trash2, danger: true, run: () => actions.deleteObjects(docId, [obj.id], { label: 'Delete link' }) },
    ]);
  };
  return (
    <div
      className={`edit-pdf-obj-link is-hl-${obj.data.appearance.highlight}${live ? ' is-live' : ''}`}
      style={linkBorderCss(obj.data, scale)}
      title={live ? linkTitle(docId, obj.data) : undefined}
      role={live ? 'link' : undefined}
      aria-label={linkTitle(docId, obj.data)}
      data-testid="edit-pdf-link-object"
      data-viewer-passthrough={live ? '' : undefined}
      onClick={open}
      onContextMenu={menu}
    />
  );
}

export const linkType: ObjectTypeDef<LinkObject> = {
  kind: KIND_LINK,
  label: 'Link',
  icon: Link2,
  category: 'link',
  Render: LinkRender,
  minSize: { width: 4, height: 4 },
  summary: (obj) => (obj.data.action.type === 'url' ? obj.data.action.url : 'Page link'),
  exportToPdf(obj, ctx) {
    const a = obj.data.action;
    const page = ctx.page(obj.pageId);
    const ap = obj.data.appearance;
    if (a.type === 'url') {
      if (!a.url) return;
      ctx.annots.add(page, obj, { subtype: 'Link', noContents: true, extra: linkExtra(ctx.pdfDoc.context, ap, { url: a.url }) });
      return;
    }
    if (!ctx.doc.pages.some((p) => p.id === a.pageId)) {
      console.warn('[edit-pdf] link target page no longer exists; link skipped');
      return;
    }
    const target = ctx.page(a.pageId);
    ctx.annots.add(page, obj, {
      subtype: 'Link',
      noContents: true,
      extra: linkExtra(ctx.pdfDoc.context, ap, { pageRef: target.ref, left: a.left, top: a.top, zoom: a.zoom }),
    });
  },
};
