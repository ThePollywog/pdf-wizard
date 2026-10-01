/**
 * Keeps every open document's pdf.js proxy in sync with its base bytes:
 * when `doc.version !== doc.pdfVersion` the bytes are (re)loaded and applied only if they are still
 * the latest. A few recent proxies per document are kept so undo/redo is instant; the rest are destroyed.
 */
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import type { DocId, DocState } from '../types';
import { actions, getDoc, useApp } from '../store';
import { destroyProxy, loadingTaskFor } from './pdfjs';
import { forgetDoc, getReadOnly } from './state';
import { formsModified } from './forms';

interface CacheEntry {
  version: number;
  pdf: PDFDocumentProxy;
}
interface DocEntry {
  cache: CacheEntry[];
  loading: { version: number; task: PDFDocumentLoadingTask } | null;
  /** Version whose load failed (not retried until the version changes). */
  failed: number;
}

const CACHE_SIZE = 3;
const entries = new Map<DocId, DocEntry>();
const tracked = new WeakSet<PDFDocumentProxy>();

function entryOf(id: DocId): DocEntry {
  let e = entries.get(id);
  if (!e) {
    e = { cache: [], loading: null, failed: -1 };
    entries.set(id, e);
  }
  return e;
}

function isCurrentPdf(pdf: PDFDocumentProxy): boolean {
  const docs = useApp.getState().docs;
  for (const id in docs) if (docs[id].pdf === pdf) return true;
  return false;
}

function destroyLater(pdf: PDFDocumentProxy) {
  // Give in-flight renders of the previous version a moment to finish.
  setTimeout(() => {
    if (!isCurrentPdf(pdf)) destroyProxy(pdf);
  }, 2000);
}

function remember(e: DocEntry, version: number, pdf: PDFDocumentProxy) {
  for (const c of e.cache) if (c.version === version && c.pdf !== pdf) destroyLater(c.pdf);
  e.cache = [{ version, pdf }, ...e.cache.filter((c) => c.pdf !== pdf && c.version !== version)];
  while (e.cache.length > CACHE_SIZE) {
    const victim = e.cache.pop()!;
    destroyLater(victim.pdf);
  }
}

/** Throw away form values typed into a cached proxy (used when undo/redo brings it back). */
function clearStorage(pdf: PDFDocumentProxy) {
  const storage = pdf.annotationStorage;
  const keys = [...(storage as Iterable<[string, unknown]>)].map(([k]) => k);
  for (const k of keys) storage.remove(k);
  storage.resetModified();
}

/** Mark the document dirty when the user actually changes a form value. */
function installFormTracking(docId: DocId, pdf: PDFDocumentProxy) {
  if (tracked.has(pdf)) return;
  tracked.add(pdf);
  const storage = pdf.annotationStorage as unknown as { onSetModified: (() => void) | null; resetModified(): void };
  const prev = storage.onSetModified;
  storage.onSetModified = () => {
    prev?.();
    void formsModified(pdf)
      .then((modified) => {
        const d = getDoc(docId);
        if (!d || d.pdf !== pdf) return;
        if (modified) {
          if (!d.dirty) actions.updateDoc(docId, { dirty: true });
        } else {
          storage.resetModified();
        }
      })
      .catch(() => {});
  };
}

function disposeDoc(id: DocId) {
  const e = entries.get(id);
  entries.delete(id);
  if (e) {
    if (e.loading) void e.loading.task.destroy().catch(() => {});
    for (const c of e.cache) destroyProxy(c.pdf);
  }
  forgetDoc(id);
}

function errorMessage(err: unknown): string {
  const e = err as { name?: string; message?: string };
  if (e?.name === 'PasswordException') return 'The document is password-protected.';
  if (e?.name === 'InvalidPDFException') return 'The file is not a valid PDF or is damaged.';
  return e?.message || String(err);
}

function ensure(d: DocState) {
  const e = entryOf(d.id);
  if (d.pdf && !e.cache.some((c) => c.pdf === d.pdf)) {
    // Proxy provided from outside (openBytes): adopt it.
    remember(e, d.pdfVersion, d.pdf);
  }
  if (d.pdf) installFormTracking(d.id, d.pdf);
  if (d.pdf && d.pdfVersion === d.version) {
    if (e.loading) {
      void e.loading.task.destroy().catch(() => {});
      e.loading = null;
    }
    // e.g. undo back to the displayed version after a version that failed to load
    if (d.loadError || d.loading) actions.updateDoc(d.id, { loading: false, loadError: null });
    return;
  }
  if (e.loading?.version === d.version) return;
  if (e.failed === d.version) return;

  const hit = e.cache.find((c) => c.version === d.version);
  if (hit) {
    if (e.loading) {
      void e.loading.task.destroy().catch(() => {});
      e.loading = null;
    }
    clearStorage(hit.pdf);
    remember(e, hit.version, hit.pdf);
    installFormTracking(d.id, hit.pdf);
    actions.updateDoc(d.id, { pdf: hit.pdf, pdfVersion: hit.version, loading: false, loadError: null });
    return;
  }

  if (e.loading) void e.loading.task.destroy().catch(() => {});
  const version = d.version;
  const ro = getReadOnly(d.id);
  const task = loadingTaskFor(d.bytes, ro ? { password: ro.password } : {});
  e.loading = { version, task };
  if (!d.loading || d.loadError) actions.updateDoc(d.id, { loading: true, loadError: null });

  task.promise.then(
    (pdf) => {
      const cur = getDoc(d.id);
      const e2 = entries.get(d.id);
      if (!cur || !e2 || e2.loading?.task !== task) {
        void task.destroy().catch(() => {});
        return;
      }
      e2.loading = null;
      if (cur.version !== version) {
        void task.destroy().catch(() => {});
        reconcileSoon();
        return;
      }
      remember(e2, version, pdf);
      installFormTracking(d.id, pdf);
      actions.updateDoc(d.id, { pdf, pdfVersion: version, loading: false, loadError: null });
    },
    (err) => {
      const cur = getDoc(d.id);
      const e2 = entries.get(d.id);
      if (!cur || !e2 || e2.loading?.task !== task) return;
      e2.loading = null;
      if (cur.version !== version) {
        reconcileSoon();
        return;
      }
      e2.failed = version;
      const msg = errorMessage(err);
      console.error('[engine] failed to load document', err);
      actions.updateDoc(d.id, { loading: false, loadError: msg });
      actions.toast(`Couldn't display “${cur.name}”: ${msg}`, { kind: 'error' });
    },
  );
}

function reconcile() {
  scheduled = false;
  const { docs } = useApp.getState();
  for (const id of [...entries.keys()]) if (!docs[id]) disposeDoc(id);
  for (const id in docs) {
    try {
      ensure(docs[id]);
    } catch (err) {
      console.error('[engine] sync failed', err);
    }
  }
}

let scheduled = false;
export function reconcileSoon() {
  if (scheduled) return;
  scheduled = true;
  queueMicrotask(reconcile);
}

let unsubscribe: (() => void) | null = null;

export function startEngineSync(): () => void {
  if (!unsubscribe) {
    unsubscribe = useApp.subscribe(
      (s) => s.docs,
      () => reconcileSoon(),
    );
  }
  reconcileSoon();
  return () => {
    unsubscribe?.();
    unsubscribe = null;
  };
}

/**
 * Resolves with the pdf.js proxy for the document's *current* bytes (waiting for a reload if needed).
 * Rejects when the document is closed or its bytes fail to load.
 */
export function awaitPdf(docId: DocId): Promise<PDFDocumentProxy> {
  const ready = (d: DocState | undefined) => !!d && !!d.pdf && d.pdfVersion === d.version;
  const d = getDoc(docId);
  if (!d) return Promise.reject(new Error('The document is no longer open.'));
  if (ready(d)) return Promise.resolve(d.pdf!);
  if (d.loadError && !d.loading && entries.get(docId)?.failed === d.version) return Promise.reject(new Error(d.loadError));
  return new Promise<PDFDocumentProxy>((resolve, reject) => {
    const check = (cur: DocState | undefined) => {
      if (!cur) {
        stop();
        reject(new Error('The document is no longer open.'));
      } else if (ready(cur)) {
        stop();
        resolve(cur.pdf!);
      } else if (cur.loadError && !cur.loading && entries.get(docId)?.failed === cur.version) {
        stop();
        reject(new Error(cur.loadError));
      }
    };
    const stop = useApp.subscribe((s) => s.docs[docId], check);
    reconcileSoon();
  });
}
