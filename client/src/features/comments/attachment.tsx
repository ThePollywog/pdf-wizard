/**
 * Attached files (PDF /FileAttachment with an embedded file). Double-click (or the context menu)
 * opens previewable files in a new tab and saves the others.
 */
import { Download, ExternalLink, Paperclip } from 'lucide-react';
import type { DocId, MenuItem, ObjectRenderProps, ObjectTypeDef, PageInfo, Point } from '@/core/types';
import { actions, getDoc, getToolOptions, newObject } from '@/core/store';
import { downloadBlob, formatBytes } from '@/core/util';
import { AttachIconSvg, frameSize } from './icons';
import { ChipDropdown, Swatch } from './bars';
import { commentContextItems } from './menus';
import { exportAttachment } from './pdfExport';
import { screenAngle } from './note';
import { ATTACH_DEFAULTS, ATTACH_ICONS, ATTACH_SIZE, canAnnotate, commentsUi, normRotation, TOOL, type AttachmentObject } from './model';

/**
 * Types opened in a browser tab. Nothing that can run script (HTML, SVG…): a blob: URL has the
 * app's origin, and attachments come from untrusted documents. Everything else is saved.
 */
const PREVIEWABLE = /^(application\/pdf|image\/(png|jpe?g|gif|webp|bmp)|text\/plain|audio\/|video\/)/i;

export function mimeFromName(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const map: Record<string, string> = {
    pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
    bmp: 'image/bmp', txt: 'text/plain', csv: 'text/csv', json: 'application/json', xml: 'application/xml', html: 'text/html', zip: 'application/zip',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    mp3: 'audio/mpeg', wav: 'audio/wav', mp4: 'video/mp4', mov: 'video/quicktime',
  };
  return map[ext] ?? 'application/octet-stream';
}

export function saveAttachment(o: AttachmentObject) {
  const d = o.data;
  downloadBlob(new Blob([d.bytes as BlobPart], { type: d.mimeType || 'application/octet-stream' }), d.fileName || 'attachment', d.mimeType || 'application/octet-stream');
}

export function openAttachment(o: AttachmentObject) {
  const d = o.data;
  const mime = d.mimeType || mimeFromName(d.fileName);
  if (!PREVIEWABLE.test(mime)) {
    saveAttachment(o);
    actions.toast(`Saved “${d.fileName}”. This file type can’t be previewed in the browser.`);
    return;
  }
  // Text without a declared charset would be shown as Latin-1 by the browser.
  const type = /^text\//.test(mime) && !/charset=/i.test(mime) ? `${mime};charset=utf-8` : mime;
  const url = URL.createObjectURL(new Blob([d.bytes as BlobPart], { type }));
  // No 'noopener' feature: with it window.open() always returns null, which looks like a blocked
  // pop-up. The blob: URL has no script access to us anyway; drop the opener by hand.
  const w = window.open(url, '_blank');
  if (w) {
    try {
      w.opener = null;
    } catch {
      /* cross-origin window — nothing to clear */
    }
  } else {
    saveAttachment(o);
    actions.toast('Pop-ups are blocked, so the file was saved instead.', { kind: 'info' });
  }
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function AttachmentRender({ obj, rotation, scale }: ObjectRenderProps<AttachmentObject>) {
  const d = obj.data;
  const { w, h } = frameSize(obj.rect, d.rotate);
  return (
    <div
      className="comments-attach"
      data-testid="comments-attachment"
      title={`${d.fileName} (${formatBytes(d.size)})`}
      onDoubleClick={(e) => {
        e.stopPropagation();
        openAttachment(obj);
      }}
    >
      <AttachIconSvg
        icon={d.icon ?? 'PushPin'}
        color={obj.color ?? ATTACH_DEFAULTS.color}
        className="comments-note-icon"
        preserveAspectRatio="none"
        style={{ width: w * scale, height: h * scale, transform: `translate(-50%, -50%) rotate(${screenAngle(rotation, d.rotate)}deg)`, opacity: obj.opacity ?? 1 }}
      />
    </div>
  );
}

function AttachmentBar({ obj, update }: { obj: AttachmentObject; update(p: Partial<AttachmentObject>, o?: { label?: string }): void }) {
  const d = obj.data;
  const color = obj.color ?? ATTACH_DEFAULTS.color;
  return (
    <>
      <span className="comments-bar-file" title={d.fileName}>
        {d.fileName}
      </span>
      <ChipDropdown
        testid="comments-bar-attach-icon"
        label="Icon"
        items={ATTACH_ICONS.map((ic) => ({
          id: `comments-attach-icon-${ic.value}`,
          label: ic.label,
          checked: (d.icon ?? 'PushPin') === ic.value,
          icon: ({ size = 16 }) => <AttachIconSvg icon={ic.value} color={color} width={size} height={size} />,
          run: () => update({ data: { ...d, icon: ic.value } }, { label: 'Change icon' }),
        }))}
      >
        <AttachIconSvg icon={d.icon ?? 'PushPin'} color={color} width={18} height={18} />
      </ChipDropdown>
      <Swatch testid="comments-bar-color" label="Color" value={color} onChange={(c) => c && update({ color: c }, { label: 'Change color' })} />
      <button type="button" className="pdfwizard-props-chip comments-chip" data-testid="comments-bar-attach-open" title="Open file" aria-label="Open file" onClick={() => openAttachment(obj)}>
        <ExternalLink size={16} strokeWidth={1.75} />
      </button>
      <button type="button" className="pdfwizard-props-chip comments-chip" data-testid="comments-bar-attach-save" title="Save file" aria-label="Save file" onClick={() => saveAttachment(obj)}>
        <Download size={16} strokeWidth={1.75} />
      </button>
    </>
  );
}

export const attachmentType: ObjectTypeDef<AttachmentObject> = {
  kind: 'file-attachment',
  label: 'File attachment',
  icon: Paperclip,
  category: 'comment',
  Render: AttachmentRender,
  hit: 'box',
  resizable: false,
  editable: true,
  summary: (o) => `${o.data.fileName} (${formatBytes(o.data.size)})`,
  PropertiesBar: AttachmentBar,
  contextMenu: (o, docId) =>
    [
      { id: 'comments-attach-open', label: 'Open file', icon: ExternalLink, run: () => openAttachment(o) },
      { id: 'comments-attach-save', label: 'Save file…', icon: Download, run: () => saveAttachment(o) },
      ...commentContextItems(o, docId),
    ] as MenuItem[],
  exportToPdf: (o, ctx) => exportAttachment(o, ctx),
};

/** Attach `file` at the point `at` (icon centered on it). */
export async function createAttachment(docId: DocId, page: PageInfo, at: Point, file: File): Promise<AttachmentObject | null> {
  if (!canAnnotate(docId)) return null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!getDoc(docId)) return null;
  const opts = getToolOptions(TOOL.attach, ATTACH_DEFAULTS);
  const rot = normRotation(page.rotation);
  // The icon is centered on the click (square, so the page rotation doesn't matter).
  const [x0, y0, x1, y1] = page.view;
  const S = ATTACH_SIZE;
  const rect = {
    x: Math.min(Math.max(x0, at.x - S / 2), x1 - S),
    y: Math.min(Math.max(y0, at.y - S / 2), y1 - S),
    width: S,
    height: S,
  };
  const o = newObject<AttachmentObject>({
    kind: 'file-attachment',
    pageId: page.id,
    rect,
    color: opts.color,
    data: {
      fileName: file.name,
      mimeType: file.type || mimeFromName(file.name),
      size: bytes.length,
      bytes,
      icon: opts.icon,
      rotate: rot || undefined,
      fileModified: file.lastModified || undefined,
    },
  });
  actions.addObject(docId, o, { select: true, label: 'Attach file' });
  commentsUi.openPopup({ docId, objectId: o.id, focus: true, source: 'create' });
  return o;
}
