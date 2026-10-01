/**
 * Page operations behind the organize toolbar, panel, grid and context menus. Everything goes
 * through the engine page ops (one undo step each, page ids and overlay objects preserved);
 * failures become toasts.
 */
import type { DocId, PageId } from '@/core/types';
import * as engine from '@/core/engine';
import { actions, getDoc } from '@/core/store';
import { confirmDialog, promptDialog } from '@/core/ui';
import { pickFiles } from '@/core/util';
import { currentSelectedIndices, organize, useOrganize } from './store';
import { formatRanges, parseRanges, plural } from './ranges';
import { acceptString, destroyProxy, isSupportedFile, loadFileSource, loadLibrarySource, preparePdfFiles, type LoadedPdf } from './sources';
import { attempt, errMsg, readOnlyReason, toastError } from './util';
import { insertBlankDialog } from './dialogs/InsertBlankDialog';
import { insertPositionDialog } from './dialogs/InsertPagesDialog';
import { libraryPickerDialog } from './dialogs/LibraryPicker';
import { extractDialog } from './dialogs/ExtractDialog';
import { replaceDialog } from './dialogs/ReplaceDialog';
import { pageLabelsDialog } from './dialogs/PageLabelsDialog';
import { runExtract } from './extract/run';
import { closeOrganizeTask } from './tasks';

/** Same MIME type as the thumbnails panel, so pages can be dragged between the two. */
export const DRAG_MIME = 'application/x-pdfwizard-pages';

export const pageCount = (docId: DocId) => getDoc(docId)?.pages.length ?? 0;

/** Selected pages, or the focused page when nothing is selected. */
export function targetsOf(docId: DocId): number[] {
  const sel = currentSelectedIndices(docId);
  if (sel.length) return sel;
  const d = getDoc(docId);
  const f = organize.selection(docId).focus;
  const i = d && f ? d.pages.findIndex((p) => p.id === f) : -1;
  return i >= 0 ? [i] : [];
}

/** False (with a toast) when the document can't be edited. */
export function ensureEditable(docId: DocId): boolean {
  const ro = readOnlyReason(docId);
  if (!ro) return true;
  actions.toast(`This document is read-only because ${ro}. Pages can't be changed.`, { kind: 'warning' });
  return false;
}

function needPages(indices: number[], what: string): boolean {
  if (indices.length) return true;
  actions.toast(`Select the pages to ${what} first.`, { kind: 'info' });
  return false;
}

/** Select the pages that `op` added (by id) and scroll to the first one. */
async function selectingNew(docId: DocId, op: () => Promise<unknown>): Promise<boolean> {
  const before = new Set(getDoc(docId)?.pages.map((p) => p.id) ?? []);
  const ok = await attempt(op);
  if (!ok) return false;
  const d = getDoc(docId);
  if (!d) return true;
  const added = d.pages.map((p, i) => (before.has(p.id) ? -1 : i)).filter((i) => i >= 0);
  if (added.length) {
    organize.selectIndices(docId, added, added[0]);
    organize.reveal(docId, d.pages[added[0]].id);
  }
  return true;
}

// ── rotate / delete / duplicate / reverse ────────────────────────────────────

export async function rotate(docId: DocId, indices: number[], delta: 90 | -90) {
  if (!needPages(indices, 'rotate') || !ensureEditable(docId)) return;
  await attempt(() => engine.rotatePages(docId, indices, delta));
}

export async function deletePages(docId: DocId, indices: number[]) {
  if (!needPages(indices, 'delete') || !ensureEditable(docId)) return;
  const d = getDoc(docId);
  if (!d) return;
  if (indices.length >= d.pages.length) {
    actions.toast("A document must keep at least one page, so all pages can't be deleted.", { kind: 'warning' });
    return;
  }
  const n = indices.length;
  const ok = await confirmDialog({
    title: n === 1 ? 'Delete page?' : `Delete ${n} pages?`,
    message:
      n === 1
        ? `Page ${indices[0] + 1} will be removed from “${d.name}”. You can undo this action.`
        : `Pages ${formatRanges(indices)} will be removed from “${d.name}”. You can undo this action.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  const first = Math.min(...indices);
  if (!(await attempt(() => engine.deletePages(docId, indices)))) return;
  const after = getDoc(docId);
  if (after?.pages.length) {
    const i = Math.min(first, after.pages.length - 1);
    organize.selectIndices(docId, [i], i);
  }
  actions.toast(n === 1 ? 'Page deleted' : `${n} pages deleted`, {
    kind: 'success',
    action: { label: 'Undo', run: () => actions.undo(docId) },
  });
}

export async function duplicate(docId: DocId, indices: number[]) {
  if (!needPages(indices, 'duplicate') || !ensureEditable(docId)) return;
  await selectingNew(docId, () => engine.duplicatePages(docId, indices));
}

/** New order that reverses `indices` in place (the whole document when fewer than 2 are given). */
export function reversedOrder(count: number, indices: number[]): number[] {
  const order = Array.from({ length: count }, (_, i) => i);
  const pos = indices.length >= 2 ? [...indices].sort((a, b) => a - b) : order.slice();
  pos.forEach((p, k) => {
    order[p] = pos[pos.length - 1 - k];
  });
  return order;
}

export async function reverse(docId: DocId, indices: number[]) {
  if (!ensureEditable(docId)) return;
  const n = pageCount(docId);
  if (n < 2) return;
  const scope = indices.length >= 2 ? indices : [];
  if (await attempt(() => engine.movePages(docId, reversedOrder(n, scope)))) {
    actions.toast(scope.length ? `Reversed the order of ${scope.length} selected pages` : 'Reversed the page order', { kind: 'success' });
  }
}

export async function movePagesTo(docId: DocId, indices: number[], gap: number) {
  if (!ensureEditable(docId)) return;
  await attempt(() => engine.movePagesTo(docId, indices, gap));
}

// ── insert ───────────────────────────────────────────────────────────────────

/** Default insertion point: after the last selected page, else at the end. */
export function defaultInsertAt(docId: DocId): number {
  const t = currentSelectedIndices(docId);
  return t.length ? t[t.length - 1] + 1 : pageCount(docId);
}

export async function insertBlank(docId: DocId, at?: number) {
  if (!ensureEditable(docId)) return;
  const r = await insertBlankDialog(docId, at ?? defaultInsertAt(docId));
  if (!r) return;
  await selectingNew(docId, () => engine.insertBlankPages(docId, r.at, r.count, r.size));
}

/** Insert one blank page right away (the "+" gap). Same size as the neighbouring page. */
export async function insertBlankNow(docId: DocId, at: number) {
  if (!ensureEditable(docId)) return;
  const d = getDoc(docId);
  if (!d) return;
  const near = d.pages[Math.min(Math.max(0, at - 1), d.pages.length - 1)];
  const swap = near ? near.rotation % 180 !== 0 : false;
  const size = near ? (swap ? { width: near.height, height: near.width } : { width: near.width, height: near.height }) : undefined;
  await selectingNew(docId, () => engine.insertBlankPages(docId, at, 1, size));
}

function toFile(src: LoadedPdf): File {
  const name = /\.pdf$/i.test(src.name) ? src.name : `${src.name.replace(/\.[^.]+$/, '')}.pdf`;
  return new File([src.bytes as BlobPart], name, { type: 'application/pdf' });
}

/**
 * Insert loaded sources. A single source can be limited to a page range. With `at` given the
 * pages go there directly, otherwise the position dialog asks.
 */
async function insertSources(docId: DocId, sources: LoadedPdf[], at?: number) {
  if (!sources.length) return;
  try {
    let pos = at;
    let pages: number[] | undefined;
    if (pos === undefined) {
      const r = await insertPositionDialog({
        docId,
        sourceName: sources.length === 1 ? sources[0].name : `${sources.length} files`,
        pageCount: sources.length === 1 ? sources[0].pdf.numPages : null,
        totalPages: sources.reduce((n, s) => n + s.pdf.numPages, 0),
        defaultAt: defaultInsertAt(docId),
      });
      if (!r) return;
      pos = r.at;
      pages = r.pages;
    }
    const where = pos;
    const count = pages?.length ?? sources.reduce((n, s) => n + s.pdf.numPages, 0);
    const ok =
      sources.length === 1
        ? await selectingNew(docId, () => engine.insertPdfBytes(docId, where, sources[0].bytes, pages))
        : await selectingNew(docId, () => engine.insertFiles(docId, where, sources.map(toFile)));
    if (ok) actions.toast(`Inserted ${plural(count, 'page', 'pages')}`, { kind: 'success' });
  } finally {
    for (const s of sources) destroyProxy(s.pdf);
  }
}

async function loadFiles(files: File[]): Promise<LoadedPdf[]> {
  const out: LoadedPdf[] = [];
  for (const f of files) {
    try {
      const src = await loadFileSource(f);
      if (src) out.push(src);
    } catch (e) {
      toastError(e);
    }
  }
  return out;
}

export async function insertFromFile(docId: DocId, at?: number) {
  if (!ensureEditable(docId)) return;
  const files = await pickFiles({ accept: acceptString(), multiple: true });
  if (!files.length) return;
  await insertFileList(docId, files, at);
}

/** Insert picked or dropped files (any supported type; protected PDFs ask for the password). */
export async function insertFileList(docId: DocId, files: File[], at?: number) {
  if (!ensureEditable(docId)) return;
  const ok = files.filter(isSupportedFile);
  const bad = files.filter((f) => !isSupportedFile(f));
  if (bad.length) {
    actions.toast(`${bad.map((f) => `“${f.name}”`).join(', ')} can't be inserted: this file type isn't supported.`, { kind: 'error' });
  }
  if (!ok.length) return;
  if (at !== undefined && ok.every((f) => !/\.pdf$/i.test(f.name) && f.type !== 'application/pdf')) {
    // Converted files (images, Office…) go straight in: nothing to choose.
    const prepared = await preparePdfFiles(ok).catch((e) => {
      toastError(e);
      return null;
    });
    if (!prepared?.files.length) return;
    if (await selectingNew(docId, () => engine.insertFiles(docId, at, prepared.files))) {
      actions.toast(`Inserted ${plural(prepared.pages, 'page', 'pages')}`, { kind: 'success' });
    }
    return;
  }
  const sources = await loadFiles(ok);
  await insertSources(docId, sources, at);
}

export async function insertFromLibrary(docId: DocId, at?: number) {
  if (!ensureEditable(docId)) return;
  const picked = await libraryPickerDialog({ title: 'Insert from your files', confirmLabel: 'Insert', multiple: true });
  if (!picked?.length) return;
  const sources: LoadedPdf[] = [];
  for (const f of picked) {
    try {
      const src = await loadLibrarySource(f.id, f.name);
      if (src) sources.push(src);
    } catch (e) {
      actions.toast(`Couldn't load “${f.name}”: ${errMsg(e)}`, { kind: 'error' });
    }
  }
  await insertSources(docId, sources, at);
}

/** Copy pages of another open document (dragged from its thumbnails) into this one. */
export async function insertFromDoc(docId: DocId, sourceDocId: DocId, indices: number[], at: number) {
  if (!ensureEditable(docId)) return;
  await selectingNew(docId, async () => {
    const bytes = await engine.extractPagesToBytes(sourceDocId, indices, { includeObjects: true });
    await engine.insertPdfBytes(docId, at, bytes);
  });
}

// ── clipboard (cut / copy / paste pages) ─────────────────────────────────────

export function copyPages(docId: DocId, indices: number[], mode: 'copy' | 'cut') {
  const d = getDoc(docId);
  if (!d || !needPages(indices, mode)) return;
  if (mode === 'cut' && !ensureEditable(docId)) return;
  const ro = readOnlyReason(docId);
  if (ro) {
    actions.toast(`This document is read-only because ${ro}. Its pages can't be copied.`, { kind: 'warning' });
    return;
  }
  organize.setClip({ docId, ids: indices.map((i) => d.pages[i].id), mode });
  actions.toast(`${plural(indices.length, 'page', 'pages')} ${mode === 'cut' ? 'cut' : 'copied'}. Paste them where you want them.`, { kind: 'info' });
}

export function clipIndices(): { docId: DocId; indices: number[]; mode: 'cut' | 'copy' } | null {
  const c = useOrganize.getState().clip;
  if (!c) return null;
  const d = getDoc(c.docId);
  if (!d) return null;
  const idx = new Map(d.pages.map((p, i) => [p.id, i] as [PageId, number]));
  const indices = c.ids.map((id) => idx.get(id)).filter((i): i is number => i !== undefined).sort((a, b) => a - b);
  return indices.length ? { docId: c.docId, indices, mode: c.mode } : null;
}

export async function pastePages(docId: DocId, at: number) {
  const c = clipIndices();
  if (!c) {
    actions.toast('There are no copied pages to paste.', { kind: 'info' });
    return;
  }
  if (!ensureEditable(docId)) return;
  if (c.docId === docId && c.mode === 'cut') {
    if (await attempt(() => engine.movePagesTo(docId, c.indices, at))) organize.setClip(null);
    return;
  }
  const ok = await selectingNew(docId, async () => {
    const bytes = await engine.extractPagesToBytes(c.docId, c.indices, { includeObjects: true });
    await engine.insertPdfBytes(docId, at, bytes);
  });
  if (ok && c.mode === 'cut') {
    organize.setClip(null);
    const src = getDoc(c.docId);
    if (src && c.indices.length < src.pages.length) await attempt(() => engine.deletePages(c.docId, c.indices));
    else if (src) actions.toast(`The pages were copied but stay in “${src.name}”: a document must keep at least one page.`, { kind: 'info' });
  }
}

// ── dialogs: extract / replace / labels ──────────────────────────────────────

export async function extract(docId: DocId, indices: number[]) {
  const ro = readOnlyReason(docId);
  if (ro) {
    actions.toast(`This document is read-only because ${ro}. Its pages can't be extracted.`, { kind: 'warning' });
    return;
  }
  const req = await extractDialog(docId, indices);
  if (!req) return;
  await runExtract(docId, req);
}

export async function replace(docId: DocId, indices: number[]) {
  if (!ensureEditable(docId)) return;
  await replaceDialog(docId, indices);
}

export async function pageLabels(docId: DocId, indices: number[]) {
  if (!ensureEditable(docId)) return;
  await pageLabelsDialog(docId, indices);
}

// ── selection helpers ────────────────────────────────────────────────────────

export type SelectKind = 'all' | 'even' | 'odd' | 'portrait' | 'landscape' | 'none' | 'invert';

export function selectBy(docId: DocId, kind: SelectKind) {
  const d = getDoc(docId);
  if (!d) return;
  const all = d.pages.map((_, i) => i);
  const sel = new Set(currentSelectedIndices(docId));
  const shown = (i: number) => {
    const p = d.pages[i];
    const swap = p.rotation % 180 !== 0;
    return swap ? { w: p.height, h: p.width } : { w: p.width, h: p.height };
  };
  let out: number[];
  switch (kind) {
    case 'all': out = all; break;
    case 'even': out = all.filter((i) => (i + 1) % 2 === 0); break;
    case 'odd': out = all.filter((i) => (i + 1) % 2 === 1); break;
    case 'portrait': out = all.filter((i) => shown(i).h >= shown(i).w); break;
    case 'landscape': out = all.filter((i) => shown(i).w > shown(i).h); break;
    case 'invert': out = all.filter((i) => !sel.has(i)); break;
    default: out = [];
  }
  if (kind === 'none') {
    organize.clear(docId);
    return;
  }
  organize.selectIndices(docId, out, out[0]);
  if (out.length) organize.reveal(docId, d.pages[out[0]].id);
  else actions.toast(`No ${kind} pages in this document.`, { kind: 'info' });
}

export async function selectRange(docId: DocId) {
  const n = pageCount(docId);
  const cur = formatRanges(currentSelectedIndices(docId));
  const v = await promptDialog({
    title: 'Select pages',
    label: 'Page range',
    defaultValue: cur,
    placeholder: `e.g. 1-3, 5, 8-${Math.min(n, 12)}`,
    confirmLabel: 'Select',
    help: `Pages 1 to ${n}. Use commas and hyphens, for example 1-3, 5, 8-.`,
    validate: (s) => (s.trim() ? parseRanges(s, n).error : null),
  });
  if (v === null) return;
  const r = parseRanges(v, n);
  if (r.error) return;
  const d = getDoc(docId);
  organize.selectIndices(docId, r.indices, r.indices[0]);
  if (d && r.indices.length) organize.reveal(docId, d.pages[r.indices[0]].id);
}

// ── navigation ───────────────────────────────────────────────────────────────

/** Leave the organize view and show page `index` in the viewer. */
export function openInViewer(docId: DocId, index: number) {
  closeOrganizeTask();
  requestAnimationFrame(() => actions.goToPage(docId, index));
}

export const closeOrganize = closeOrganizeTask;
