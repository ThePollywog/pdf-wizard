/**
 * Shell-level document flows (open / close / save / share / rename …) with UI around the engine.
 * Every function here is safe to call from commands, buttons and menus: failures become toasts.
 */
import * as engine from '@/core/engine';
import { library, LibraryError, LIBRARY_CHANGED, type FileMeta } from '@/core/library';
import { reg, useRegistry } from '@/core/registry';
import { actions, getDoc, useApp } from '@/core/store';
import type { DocId } from '@/core/types';
import { downloadBlob, pickFiles } from '@/core/util';
import { choiceDialog, promptDialog } from '@/core/ui';
import { TriangleAlert } from 'lucide-react';
import { shell, useShell } from './uiStore';
import { openSendCopyDialog } from './dialogs/ShareDialog';

export { LIBRARY_CHANGED };
export const notifyLibraryChanged = () => window.dispatchEvent(new CustomEvent(LIBRARY_CHANGED));

export function errorMessage(e: unknown): string {
  if (e instanceof LibraryError) return e.message;
  if (e instanceof Error) return e.message;
  return String(e);
}

export function toastError(e: unknown, prefix?: string) {
  console.error(e);
  const msg = errorMessage(e);
  actions.toast(prefix ? `${prefix}: ${msg}` : msg, { kind: 'error' });
}

/** `accept` string for the open-file picker: PDFs plus everything a registered FileHandler converts. */
export function openAccept(): string {
  const parts = new Set(['.pdf', 'application/pdf']);
  for (const h of useRegistry.getState().fileHandlers) {
    h.extensions.forEach((e) => parts.add(`.${e.replace(/^\./, '').toLowerCase()}`));
    h.mimePrefixes?.forEach((m) => parts.add(m.endsWith('/') ? `${m}*` : m));
  }
  return Array.from(parts).join(',');
}

// ── opening ────────────────────────────────────────────────────────────────

export async function openFiles(files: File[]): Promise<DocId[]> {
  if (!files.length) return [];
  try {
    return await engine.openFiles(files);
  } catch (e) {
    toastError(e, files.length === 1 ? `Couldn't open ${files[0].name}` : "Couldn't open files");
    return [];
  }
}

export async function openFilePicker(): Promise<DocId[]> {
  const files = await pickFiles({ accept: openAccept(), multiple: true });
  return openFiles(files);
}

/** Opens a library file, re-using an open tab if the file is already open. */
export async function openLibraryFile(fileId: string): Promise<DocId | null> {
  const s = useApp.getState();
  const existing = s.tabs.map((id) => s.docs[id]).find((d) => d && d.fileId === fileId);
  if (existing) {
    actions.setActiveDoc(existing.id);
    return existing.id;
  }
  try {
    return await engine.openFromLibrary(fileId);
  } catch (e) {
    toastError(e, "Couldn't open the file");
    return null;
  }
}

/** Opens a task from All tools / Home, asking for a file first when it needs one. */
export async function openTaskFlow(taskId: string): Promise<void> {
  const task = reg.task(taskId);
  if (!task) return;
  if (task.requiresDocument && !useApp.getState().activeDocId) {
    const files = await pickFiles({ accept: openAccept(), multiple: false });
    if (!files.length) return;
    const ids = await openFiles(files);
    if (!ids.length) return;
  }
  const s = useApp.getState();
  if (s.activeTaskId === taskId) {
    // Already open: just show it.
    if (s.activeDocId) actions.setRoute('document');
    else if (!task.requiresDocument) actions.setRoute('task');
    actions.setLeftPanelOpen(true);
    return;
  }
  actions.openTask(taskId);
  if (useApp.getState().activeDocId && useApp.getState().route !== 'document') actions.setRoute('document');
}

// ── saving ─────────────────────────────────────────────────────────────────

/** Saves to the library (create or new version). Resolves true on success. */
export async function saveDocument(docId: DocId | null = useApp.getState().activeDocId): Promise<boolean> {
  if (!docId || !getDoc(docId)) return false;
  if (useShell.getState().saving[docId]) return false;
  shell.setSaving(docId, true);
  try {
    await engine.saveDoc(docId);
    return true;
  } catch (e) {
    toastError(e, "Couldn't save");
    return false;
  } finally {
    shell.setSaving(docId, false);
  }
}

export function ensurePdfName(name: string): string {
  const n = name.trim().replace(/[\\/:*?"<>|]+/g, '-');
  return /\.pdf$/i.test(n) ? n : `${n}.pdf`;
}

const validateName = (v: string) => (v.trim() === '' ? 'Enter a file name' : /[\\/:*?"<>|]/.test(v) ? 'A file name can\'t contain \\ / : * ? " < > |' : null);

export async function saveDocumentAs(docId: DocId | null = useApp.getState().activeDocId): Promise<boolean> {
  const d = getDoc(docId);
  if (!d) return false;
  const name = await promptDialog({
    title: 'Save as',
    label: 'File name',
    defaultValue: d.name,
    confirmLabel: 'Save',
    selectBaseName: true,
    validate: validateName,
    help: 'A copy is saved to your files.',
  });
  if (!name) return false;
  shell.setSaving(d.id, true);
  try {
    await engine.saveDocAs(d.id, ensurePdfName(name));
    return true;
  } catch (e) {
    toastError(e, "Couldn't save");
    return false;
  } finally {
    shell.setSaving(d.id, false);
  }
}

export async function downloadDocument(docId: DocId | null = useApp.getState().activeDocId) {
  const d = getDoc(docId);
  if (!d) return;
  try {
    await engine.downloadDoc(d.id);
  } catch (e) {
    toastError(e, "Couldn't download");
  }
}

export async function printDocument(docId: DocId | null = useApp.getState().activeDocId) {
  const d = getDoc(docId);
  if (!d) return;
  try {
    await engine.printDoc(d.id);
  } catch (e) {
    toastError(e, "Couldn't print");
  }
}

// ── closing ────────────────────────────────────────────────────────────────

/** Closes a tab, asking to save first when it has unsaved changes. Resolves true if closed. */
export async function requestCloseDoc(docId: DocId | null = useApp.getState().activeDocId): Promise<boolean> {
  const d = getDoc(docId);
  if (!d) return true;
  if (d.dirty) {
    if (useApp.getState().activeDocId !== d.id) actions.setActiveDoc(d.id);
    const choice = await choiceDialog<'save' | 'discard' | 'cancel'>({
      title: 'Save changes?',
      icon: TriangleAlert,
      iconColor: 'var(--warning)',
      message: (
        <>
          Do you want to save the changes to <b>{d.name}</b> before closing? Your changes will be lost if you don't save them.
        </>
      ),
      choices: [
        { value: 'discard', label: "Don't save", start: true },
        { value: 'cancel', label: 'Cancel' },
        { value: 'save', label: 'Save', variant: 'primary' },
      ],
    });
    if (choice === null || choice === 'cancel') return false;
    if (choice === 'save' && !(await saveDocument(d.id))) return false;
  }
  actions.closeDocument(d.id);
  return true;
}

export async function closeAllDocs(): Promise<boolean> {
  for (const id of [...useApp.getState().tabs]) {
    if (!(await requestCloseDoc(id))) return false;
  }
  return true;
}

export async function closeOtherDocs(keep: DocId): Promise<boolean> {
  for (const id of useApp.getState().tabs.filter((t) => t !== keep)) {
    if (!(await requestCloseDoc(id))) return false;
  }
  actions.setActiveDoc(keep);
  return true;
}

// ── rename / share ─────────────────────────────────────────────────────────

export async function renameDocument(docId: DocId, rawName: string): Promise<void> {
  const d = getDoc(docId);
  if (!d) return;
  const name = ensurePdfName(rawName);
  if (!rawName.trim() || name === d.name) return;
  actions.rename(docId, name);
  if (d.fileId && !d.ext.readOnly) {
    try {
      await library.patchFile(d.fileId, { name });
      notifyLibraryChanged();
    } catch (e) {
      toastError(e, "Couldn't rename the file in your library");
    }
  }
}

export async function promptRenameDocument(docId: DocId | null = useApp.getState().activeDocId) {
  const d = getDoc(docId);
  if (!d) return;
  const name = await promptDialog({ title: 'Rename', label: 'File name', defaultValue: d.name, confirmLabel: 'Rename', selectBaseName: true, validate: validateName });
  if (name) await renameDocument(d.id, name);
}

/** Sends a copy of the document (as it is now, with every change) through the system share sheet or a download. */
export async function shareDocument(docId: DocId | null = useApp.getState().activeDocId): Promise<void> {
  const d = getDoc(docId);
  if (!d) return;
  const bytes = await actions.withBusy('Preparing a copy…', () => engine.exportPdf(d.id, { purpose: 'share' }));
  if (bytes) openSendCopyDialog({ name: ensurePdfName(d.name), bytes });
}

export async function shareLibraryFile(file: Pick<FileMeta, 'id' | 'name'>): Promise<void> {
  try {
    openSendCopyDialog({ name: file.name, bytes: await library.getFileBytes(file.id) });
  } catch (e) {
    toastError(e, "Couldn't prepare a copy");
  }
}

export async function downloadLibraryFile(file: Pick<FileMeta, 'id' | 'name'>): Promise<void> {
  try {
    const bytes = await library.getFileBytes(file.id);
    downloadBlob(bytes, file.name);
  } catch (e) {
    toastError(e, "Couldn't download");
  }
}
