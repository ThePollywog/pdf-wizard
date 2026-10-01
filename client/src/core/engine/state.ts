/**
 * Engine-private bookkeeping that must not live in the (serializable, undoable) store:
 * the password provider, the outline/meta as originally read (to detect edits), read-only
 * documents and a per-document job queue so byte edits never interleave.
 */
import type { DocId, DocMeta, DocState, OutlineItem, SecuritySettings } from '../types';
import { actions, getDoc, useApp } from '../store';
import type { KeptEncryption } from './pdfcrypt';

export type PasswordProvider = (fileName: string, retry: boolean) => Promise<string | null>;

let passwordProvider: PasswordProvider | null = null;
export function setPasswordProvider(fn: PasswordProvider): void {
  passwordProvider = fn;
}
export function getPasswordProvider(): PasswordProvider | null {
  return passwordProvider;
}

export interface DocOrigin {
  /** Outline array as read when the document was opened (identity compared to doc.outline). */
  outline: OutlineItem[] | null;
  meta: DocMeta;
  /** doc.version / doc.security right after opening (an unchanged document is exported as-is). */
  version: number;
  security: SecuritySettings | null;
  /** The encrypted file as opened (set only when its decrypted copy is what `doc.bytes` holds unchanged). */
  sourceBytes?: Uint8Array;
  /** The file exactly as opened, with doc.objects / doc.order right after the import hooks ran. */
  file?: { bytes: Uint8Array; encrypted: boolean; objects: DocState['objects']; order: DocState['order'] };
  /** The file's original encryption; the encryption hook re-applies it while doc.security === security. */
  encryption?: KeptEncryption;
}
const origins = new Map<DocId, DocOrigin>();
export const setOrigin = (id: DocId, o: DocOrigin) => origins.set(id, o);
/**
 * Treat the document's current state as "the file as opened", with `fileBytes` as the file
 * (e.g. right after a feature wrote a digital signature into the base bytes): exporting it
 * without further changes then returns `fileBytes` verbatim.
 */
export function markPristine(id: DocId, fileBytes: Uint8Array, opts: { encrypted?: boolean } = {}): void {
  const doc = getDoc(id);
  if (!doc) return;
  const prev = origins.get(id);
  origins.set(id, {
    outline: doc.outline,
    meta: doc.meta,
    version: doc.version,
    security: doc.security,
    file: { bytes: fileBytes, encrypted: !!opts.encrypted, objects: doc.objects, order: doc.order },
    ...(prev?.encryption && prev.security === doc.security ? { encryption: prev.encryption } : {}),
  });
}
export const getOrigin = (id: DocId) => origins.get(id);
/** The file exactly as opened (or as last marked pristine, e.g. just signed); null for read-only / decrypted documents. */
export const getFileBytes = (id: DocId): Uint8Array | null => origins.get(id)?.file?.bytes ?? null;

export interface ReadOnlyInfo {
  reason: string;
  /** Password needed to load `doc.bytes` (which stay encrypted). */
  password: string;
  /** The untouched original bytes. */
  bytes: Uint8Array;
}
const readOnly = new Map<DocId, ReadOnlyInfo>();
export const setReadOnly = (id: DocId, info: ReadOnlyInfo) => readOnly.set(id, info);
export const getReadOnly = (id: DocId) => readOnly.get(id);
/** True when the document could not be decrypted for editing (page operations / export of changes are unavailable). */
export function isReadOnly(docId: DocId): boolean {
  return readOnly.has(docId);
}

const forgetListeners = new Set<(id: DocId) => void>();
/** Register cleanup for engine caches when a document is closed. */
export function onForgetDoc(fn: (id: DocId) => void): () => void {
  forgetListeners.add(fn);
  return () => forgetListeners.delete(fn);
}

export function forgetDoc(id: DocId) {
  origins.delete(id);
  readOnly.delete(id);
  queues.delete(id);
  for (const fn of forgetListeners) {
    try {
      fn(id);
    } catch (e) {
      console.error(e);
    }
  }
}

// ── per-document serial queue ──────────────────────────────────────────────
const queues = new Map<DocId, Promise<unknown>>();
/** Run `fn` after every previously queued job for the document has settled. */
export function enqueue<T>(docId: DocId, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(docId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  const tail = run.catch(() => undefined);
  queues.set(docId, tail);
  void tail.then(() => {
    if (queues.get(docId) === tail) queues.delete(docId);
  });
  return run;
}

/** Throw a friendly error when a document is missing. */
export function requireDoc(docId: DocId) {
  const d = getDoc(docId);
  if (!d) throw new Error('The document is no longer open.');
  return d;
}

/**
 * Show a busy overlay only if `fn` takes longer than `delay` ms and nothing else is busy.
 * Errors propagate to the caller (no toast here).
 */
export async function delayedBusy<T>(label: string, fn: () => Promise<T>, delay = 250): Promise<T> {
  let shown = false;
  let t: ReturnType<typeof setTimeout>;
  const arm = (ms: number) => {
    t = setTimeout(() => {
      // Never cover a modal the operation is waiting on (password prompt): try again later.
      if (busySuspended > 0) arm(100);
      else if (!useApp.getState().busy) {
        shown = true;
        actions.setBusy({ label, progress: null });
      }
    }, ms);
  };
  arm(delay);
  try {
    return await fn();
  } finally {
    clearTimeout(t!);
    if (shown) actions.setBusy(null);
  }
}

let busySuspended = 0;
/** Hide the busy overlay (and keep delayed ones from appearing) while a modal such as the password prompt is on screen. */
export async function withoutBusy<T>(fn: () => Promise<T>): Promise<T> {
  const prev = useApp.getState().busy;
  busySuspended++;
  if (prev) actions.setBusy(null);
  try {
    return await fn();
  } finally {
    busySuspended--;
    if (prev && !useApp.getState().busy) actions.setBusy(prev);
  }
}
