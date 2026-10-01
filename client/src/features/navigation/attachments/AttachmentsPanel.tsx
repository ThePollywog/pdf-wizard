/**
 * Attachments panel: document-level embedded files (catalog /EmbeddedFiles) and file attachment
 * comments on pages. Open, save, add, delete and edit descriptions.
 */
import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import {
  Download, ExternalLink, File, FileArchive, FileImage, FileText, FileVideo, MapPin, Paperclip, PencilLine, Plus, Trash2,
  FileAudio, FileSpreadsheet,
} from 'lucide-react';
import type { DocId, PdfObject } from '@/core/types';
import { actions, getDoc, pageIndexOf, useDoc } from '@/core/store';
import * as engine from '@/core/engine';
import { Button, EmptyState, IconButton, Spinner, confirmDialog, promptDialog, showContextMenu, type MenuEntry } from '@/core/ui';
import { downloadBlob, formatBytes, formatDate, pickFiles, readFileBytes } from '@/core/util';
import { scrollToObject } from '@/core/viewer';
import { canEdit, collator, errMsg } from '../util';
import { embedFiles, mimeFor, readEmbeddedFiles, removeFile, setFileDescription, type EmbeddedFile } from './model';

interface AttachmentData {
  fileName: string;
  mimeType: string;
  size: number;
  bytes: Uint8Array;
  description?: string;
  fileModified?: number;
}
type AttachmentObject = PdfObject<'file-attachment', AttachmentData>;

export const ATTACHMENT_KIND = 'file-attachment';
export const ATTACH_EXT = 'navigation.attachments';

interface Row {
  id: string;
  source: 'doc' | 'page';
  name: string;
  description: string;
  size: number | null;
  modified: string | number | null;
  mime: string | null;
  pageIndex: number | null;
  file?: EmbeddedFile;
  obj?: AttachmentObject;
}

const MAX_SIZE = 200 * 1024 * 1024;
/** Types a browser tab can show without running content from the file. */
const VIEWABLE = /^(image\/(png|jpe?g|gif|webp|bmp|avif)|text\/plain|audio\/[\w.+-]+|video\/(mp4|webm|ogg)|application\/json)$/i;

function iconFor(name: string, mime: string | null) {
  const m = mimeFor(name, mime);
  if (m.startsWith('image/')) return FileImage;
  if (m.startsWith('video/')) return FileVideo;
  if (m.startsWith('audio/')) return FileAudio;
  if (/zip|compressed|tar|gzip/.test(m)) return FileArchive;
  if (/sheet|excel|csv/.test(m)) return FileSpreadsheet;
  if (m.startsWith('text/') || /pdf|word|document|rtf|json|xml/.test(m)) return FileText;
  return File;
}

async function bytesOf(r: Row): Promise<Uint8Array> {
  if (r.obj) {
    const b = r.obj.data.bytes;
    return b instanceof Uint8Array ? b : new Uint8Array((b as ArrayLike<number> | undefined) ?? []);
  }
  if (!r.file) throw new Error('The attachment has no data.');
  return r.file.load();
}

async function openRow(r: Row) {
  try {
    const bytes = await bytesOf(r);
    const mime = mimeFor(r.name, r.mime);
    if (mime === 'application/pdf' || engine.hasPdfHeader(bytes)) {
      await engine.openBytes(r.name, bytes.slice(), { activate: true });
      return;
    }
    if (VIEWABLE.test(mime)) {
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
      const w = window.open(url, '_blank');
      if (w) {
        w.opener = null;
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
        return;
      }
      URL.revokeObjectURL(url);
    }
    const save = await confirmDialog({
      title: 'Open attachment',
      message: `“${r.name}” can’t be displayed here. Save it to your computer to open it with another application.`,
      confirmLabel: 'Save',
    });
    if (save) downloadBlob(bytes, r.name, mime);
  } catch (e) {
    actions.toast(`Couldn’t open “${r.name}”: ${errMsg(e)}`, { kind: 'error' });
  }
}

async function saveRow(r: Row) {
  try {
    const bytes = await bytesOf(r);
    downloadBlob(bytes, r.name, mimeFor(r.name, r.mime));
  } catch (e) {
    actions.toast(`Couldn’t save “${r.name}”: ${errMsg(e)}`, { kind: 'error' });
  }
}

/** Add files as document-level attachments (one undo step). */
export async function addAttachments(docId: DocId, files?: File[]) {
  if (!canEdit(docId)) {
    actions.toast('This document is open read-only, so attachments can’t be added.', { kind: 'warning' });
    return;
  }
  const list = files ?? (await pickFiles({ multiple: true }));
  if (!list.length) return;
  const tooBig = list.find((f) => f.size > MAX_SIZE);
  if (tooBig) {
    actions.toast(`“${tooBig.name}” is too large to attach (maximum ${formatBytes(MAX_SIZE)}).`, { kind: 'error' });
    return;
  }
  try {
    const payload = await Promise.all(list.map(async (f) => ({ name: f.name, bytes: await readFileBytes(f), mime: f.type || null, modified: f.lastModified || null })));
    let keys: string[] = [];
    await engine.withLib(docId, list.length === 1 ? 'Add attachment' : 'Add attachments', (lib) => {
      keys = embedFiles(lib, payload);
    });
    actions.toast(keys.length === 1 ? `Attached “${payload[0].name}”.` : `Attached ${keys.length} files.`, { kind: 'success' });
  } catch (e) {
    actions.toast(`Couldn’t add the attachment: ${errMsg(e)}`, { kind: 'error' });
  }
}

async function deleteRow(docId: DocId, r: Row) {
  if (r.source === 'page' && r.obj) {
    actions.deleteObjects(docId, [r.obj.id], { label: 'Delete attachment' });
  } else if (r.file) {
    if (!canEdit(docId)) return;
    try {
      await engine.withLib(docId, 'Delete attachment', (lib) => {
        if (!removeFile(lib, r.file!.key)) throw new Error('The attachment no longer exists.');
      });
    } catch (e) {
      actions.toast(`Couldn’t delete “${r.name}”: ${errMsg(e)}`, { kind: 'error' });
      return;
    }
  }
  actions.toast(`Deleted “${r.name}”.`, { kind: 'info', action: { label: 'Undo', run: () => actions.undo(docId) } });
}

async function editDescription(docId: DocId, r: Row) {
  const v = await promptDialog({
    title: 'Edit attachment description',
    label: 'Description',
    defaultValue: r.description,
    allowEmpty: true,
    confirmLabel: 'OK',
  });
  if (v === null || v === r.description) return;
  const desc = v.trim();
  if (r.obj) {
    actions.updateObject(docId, r.obj.id, { data: { ...r.obj.data, description: desc || undefined } } as Partial<PdfObject>, { label: 'Edit attachment description' });
    return;
  }
  if (!r.file) return;
  try {
    await engine.withLib(docId, 'Edit attachment description', (lib) => {
      if (!setFileDescription(lib, r.file!.key, desc)) throw new Error('The attachment no longer exists.');
    });
  } catch (e) {
    actions.toast(`Couldn’t change the description: ${errMsg(e)}`, { kind: 'error' });
  }
}

const EMPTY_OBJS: Record<string, PdfObject> = {};

export function AttachmentsPanel({ docId }: { docId: DocId }) {
  const bytes = useDoc(docId, (d) => d?.bytes);
  const objects = useDoc(docId, (d) => d?.objects ?? EMPTY_OBJS);
  const pages = useDoc(docId, (d) => d?.pages);
  useDoc(docId, (d) => d?.pdfVersion);
  const editable = canEdit(docId);
  const [docFiles, setDocFiles] = useState<{ bytes: Uint8Array | undefined; files: EmbeddedFile[]; error: string | null } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [dropping, setDropping] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    readEmbeddedFiles(docId).then(
      (files) => live && setDocFiles({ bytes, files, error: null }),
      (e) => live && setDocFiles({ bytes, files: [], error: errMsg(e) }),
    );
    return () => {
      live = false;
    };
  }, [docId, bytes]);

  const rows = useMemo<Row[]>(() => {
    const doc = getDoc(docId);
    const out: Row[] = (docFiles?.files ?? [])
      .map<Row>((f) => ({ id: `doc:${f.key}`, source: 'doc', name: f.name, description: f.description, size: f.size, modified: f.modified, mime: f.mime, pageIndex: null, file: f }))
      .sort((a, b) => collator.compare(a.name, b.name));
    const objs = Object.values(objects).filter((o): o is AttachmentObject => o.kind === ATTACHMENT_KIND && !!o.data);
    const pageRows = objs
      .map<Row>((o) => ({
        id: `obj:${o.id}`,
        source: 'page',
        name: o.data.fileName || 'attachment',
        description: o.data.description ?? '',
        size: o.data.size ?? o.data.bytes?.length ?? null,
        modified: o.data.fileModified ?? o.modifiedAt ?? null,
        mime: o.data.mimeType || null,
        pageIndex: doc ? pageIndexOf(doc, o.pageId) : null,
        obj: o,
      }))
      .sort((a, b) => (a.pageIndex ?? 0) - (b.pageIndex ?? 0) || collator.compare(a.name, b.name));
    return out.concat(pageRows);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docFiles, objects, pages, docId]);

  const sel = rows.find((r) => r.id === selected) ?? null;
  const loading = !docFiles || docFiles.bytes !== bytes;
  const canModify = (r: Row | null) => !!r && (r.source === 'page' ? !r.obj?.locked : editable);

  const menuFor = (r: Row): MenuEntry[] => [
    { id: 'navigation.att.open', label: 'Open attachment', icon: ExternalLink, run: () => void openRow(r) },
    { id: 'navigation.att.save', label: 'Save attachment…', icon: Download, run: () => void saveRow(r) },
    ...(r.source === 'page' && r.obj
      ? [{ id: 'navigation.att.goto', label: `Go to page ${(r.pageIndex ?? 0) + 1}`, icon: MapPin, run: () => void (r.obj && scrollToObject(docId, r.obj.id)) }]
      : []),
    'divider',
    { id: 'navigation.att.desc', label: 'Edit description…', icon: PencilLine, disabled: !canModify(r), run: () => void editDescription(docId, r) },
    { id: 'navigation.att.delete', label: 'Delete attachment', icon: Trash2, danger: true, disabled: !canModify(r), run: () => void deleteRow(docId, r) },
    'divider',
    { id: 'navigation.att.add', label: 'Add file…', icon: Plus, disabled: !editable, run: () => void addAttachments(docId) },
  ];

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = rows.findIndex((r) => r.id === selected);
    const focus = (id: string) => requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(id)}"]`)?.focus());
    const go = (j: number) => {
      const r = rows[Math.max(0, Math.min(rows.length - 1, j))];
      if (!r) return;
      setSelected(r.id);
      focus(r.id);
    };
    let handled = true;
    if (e.key === 'ArrowDown') go(i + 1);
    else if (e.key === 'ArrowUp') go(i <= 0 ? 0 : i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(rows.length - 1);
    else if (e.key === 'Enter' && sel) void openRow(sel);
    else if ((e.key === 'Delete' || e.key === 'Backspace') && sel && canModify(sel)) void deleteRow(docId, sel);
    else if (e.key === 'F2' && sel && canModify(sel)) void editDescription(docId, sel);
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const onDragOver = (e: DragEvent) => {
    if (!editable || !e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    if (!dropping) setDropping(true);
  };
  const onDrop = (e: DragEvent) => {
    if (!editable || !e.dataTransfer.files.length) return;
    e.preventDefault();
    e.stopPropagation();
    setDropping(false);
    void addAttachments(docId, [...e.dataTransfer.files]);
  };

  return (
    <div
      className={`navigation-attachments${dropping ? ' is-drop' : ''}`}
      data-testid="navigation-attachments-panel"
      onDragOver={onDragOver}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false);
      }}
      onDrop={onDrop}
    >
      <div className="navigation-toolbar" role="toolbar" aria-label="Attachment tools">
        <IconButton icon={ExternalLink} label="Open attachment" disabled={!sel} onClick={() => sel && void openRow(sel)} data-testid="navigation-attachment-open" />
        <IconButton icon={Download} label="Save attachment" disabled={!sel} onClick={() => sel && void saveRow(sel)} data-testid="navigation-attachment-save" />
        <span className="navigation-toolbar-sep" />
        <IconButton icon={Plus} label="Add attachment" disabled={!editable} onClick={() => void addAttachments(docId)} data-testid="navigation-attachment-add" />
        <IconButton icon={PencilLine} label="Edit description" disabled={!canModify(sel)} onClick={() => sel && void editDescription(docId, sel)} data-testid="navigation-attachment-desc" />
        <IconButton icon={Trash2} label="Delete attachment" disabled={!canModify(sel)} onClick={() => sel && void deleteRow(docId, sel)} data-testid="navigation-attachment-delete" />
        <span className="navigation-toolbar-spacer" />
        {loading && <Spinner size={14} label="Loading attachments" />}
      </div>
      {docFiles?.error && <div className="navigation-inline-error">Couldn’t read the document’s attachments: {docFiles.error}</div>}
      {!loading && rows.length === 0 ? (
        <EmptyState
          compact
          icon={Paperclip}
          title="No attachments"
          description={editable ? 'Attach files to this PDF so they travel with it. You can also drop files here.' : 'This document has no attached files.'}
          action={
            editable ? (
              <Button size="sm" icon={Plus} onClick={() => void addAttachments(docId)} data-testid="navigation-attachment-empty-add">
                Add file
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div ref={listRef} className="navigation-att-list" role="listbox" aria-label="Attachments" data-testid="navigation-attachment-list" onKeyDown={onKeyDown}>
          {rows.map((r, i) => {
            const Icon = iconFor(r.name, r.mime);
            const isSel = r.id === selected;
            const focusable = selected ? isSel : i === 0;
            return (
              <div
                key={r.id}
                role="option"
                aria-selected={isSel}
                tabIndex={focusable ? 0 : -1}
                className={`navigation-att-row${isSel ? ' is-selected' : ''}`}
                data-testid="navigation-attachment"
                data-row-id={r.id}
                data-name={r.name}
                data-source={r.source}
                onClick={() => {
                  setSelected(r.id);
                  if (r.obj) scrollToObject(docId, r.obj.id, { select: false });
                }}
                onDoubleClick={() => void openRow(r)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setSelected(r.id);
                  showContextMenu(e, menuFor(r));
                }}
              >
                <Icon className="navigation-att-icon" size={22} strokeWidth={1.5} aria-hidden="true" />
                <div className="navigation-att-body">
                  <div className="navigation-att-name" title={r.name}>
                    {r.name}
                  </div>
                  {r.description && (
                    <div className="navigation-att-desc" data-testid="navigation-attachment-description" title={r.description}>
                      {r.description}
                    </div>
                  )}
                  <div className="navigation-att-meta">
                    {r.size != null && <span data-testid="navigation-attachment-size">{formatBytes(r.size)}</span>}
                    {r.modified != null && <span>{formatDate(r.modified)}</span>}
                    <span className="navigation-att-loc">{r.pageIndex != null ? `Page ${r.pageIndex + 1}` : 'Document'}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
