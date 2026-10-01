/**
 * The file library, stored in this browser (IndexedDB). Nothing leaves the machine.
 *
 *   files   id → StoredFile (FileMeta + version history)
 *   blobs   `${id}:${version}` → Blob (application/pdf), the last MAX_VERSIONS versions
 *   thumbs  id → { version, blob } first-page PNG of the current version (rendered with pdf.js)
 *
 * Every function throws LibraryError (`notFound` for a missing file/version). Mutations dispatch
 * LIBRARY_CHANGED so Home and pickers reload; thumbnails render in the background and dispatch it
 * again once ready.
 */
import { nanoid } from 'nanoid';

export interface FileMeta {
  id: string;
  name: string;
  size: number;
  pages: number;
  createdAt: string; // ISO
  modifiedAt: string; // ISO
  version: number;
  starred: boolean;
  /** Object URL of the first-page thumbnail, '' until it is rendered (or when it can't be, e.g. encrypted). */
  thumbnailUrl: string;
}

export interface FileVersion { version: number; size: number; savedAt: string }

export const LIBRARY_CHANGED = 'pdfwizard:library-changed';
export const MAX_VERSIONS = 10;
const THUMB_WIDTH = 320;

export class LibraryError extends Error {
  constructor(message: string, public notFound = false) {
    super(message);
    this.name = 'LibraryError';
  }
}

interface StoredFile {
  id: string;
  name: string;
  size: number;
  pages: number;
  createdAt: string;
  modifiedAt: string;
  version: number;
  starred: boolean;
  /** Ascending by version; only versions whose bytes are still stored. */
  versions: FileVersion[];
  /** Version whose thumbnail rendering failed (don't retry it). */
  thumbFailed?: number;
}

interface StoredThumb { version: number; blob: Blob }

// ── IndexedDB plumbing ───────────────────────────────────────────────────────

const DB_NAME = 'pdfwizard';
const DB_VERSION = 1;
type StoreName = 'files' | 'blobs' | 'thumbs';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new LibraryError('This browser has no local storage for files (IndexedDB is unavailable).'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        for (const s of ['files', 'blobs', 'thumbs'] as StoreName[]) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
      };
      req.onsuccess = () => {
        const db = req.result;
        // Another tab upgraded the schema: drop this connection so it can proceed.
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      req.onerror = () => reject(storageError(req.error));
      req.onblocked = () => reject(new LibraryError('Close other PDF Wizard tabs to finish updating local storage.'));
    }).catch((e) => {
      dbPromise = null;
      throw e;
    });
  }
  return dbPromise;
}

function storageError(e: unknown): LibraryError {
  if (e instanceof LibraryError) return e;
  const name = (e as DOMException | null)?.name;
  if (name === 'QuotaExceededError') {
    return new LibraryError('The browser is out of storage space for your files. Delete some files and try again.');
  }
  return new LibraryError(`Local storage error: ${(e as Error | null)?.message || name || 'unknown error'}`);
}

const reqPromise = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(storageError(r.error));
  });

/** Run `fn` in one transaction over `stores`; resolves with its result once the transaction commits. */
async function tx<T>(stores: StoreName[], mode: IDBTransactionMode, fn: (s: Record<StoreName, IDBObjectStore>) => Promise<T> | T): Promise<T> {
  const db = await openDb();
  const t = db.transaction(stores, mode);
  const s = Object.fromEntries(stores.map((n) => [n, t.objectStore(n)])) as Record<StoreName, IDBObjectStore>;
  const done = new Promise<void>((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(storageError(t.error));
    t.onabort = () => reject(storageError(t.error));
  });
  done.catch(() => {}); // awaited below; this only keeps an early abort from being reported as unhandled
  let result: T;
  try {
    result = await fn(s);
  } catch (e) {
    try {
      t.abort();
    } catch {
      /* already finished */
    }
    await done.catch(() => {});
    throw e;
  }
  await done;
  return result;
}

const blobKey = (id: string, version: number) => `${id}:${version}`;

/** Ask the browser not to evict the library under storage pressure (once per session). */
let persistAsked = false;
function askPersist() {
  if (persistAsked) return;
  persistAsked = true;
  void navigator.storage?.persist?.().catch(() => {});
}

const notify = () => window.dispatchEvent(new CustomEvent(LIBRARY_CHANGED));

// ── helpers ──────────────────────────────────────────────────────────────────

/** Sanitize a user-supplied file name (no path parts or control chars, ≤ 200 chars). */
export function cleanFileName(name: string | undefined | null, fallback = 'Untitled.pdf'): string {
  let n = String(name ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  if (n === '.' || n === '..') n = '';
  if (n.length > 200) {
    const ext = /\.[a-z0-9]{1,5}$/i.exec(n)?.[0] ?? '';
    n = n.slice(0, 200 - ext.length).trimEnd() + ext;
  }
  return n || fallback;
}

export function isPdf(bytes: Uint8Array): boolean {
  if (bytes.length < 8) return false;
  let head = '';
  for (let i = 0; i < Math.min(bytes.length, 1024); i++) head += String.fromCharCode(bytes[i]);
  return head.includes('%PDF-');
}

const toBytes = async (b: Uint8Array | Blob) => (b instanceof Blob ? new Uint8Array(await b.arrayBuffer()) : b);
const pdfBlob = (bytes: Uint8Array) => new Blob([bytes as BlobPart], { type: 'application/pdf' });

/** Page count with pdf.js (0 when it can't be read without a password). */
async function countPages(bytes: Uint8Array): Promise<number> {
  const { loadPdfjs } = await import('./engine/pdfjs');
  try {
    const pdf = await loadPdfjs(bytes);
    const n = pdf.numPages;
    void pdf.loadingTask.destroy();
    return n;
  } catch {
    return 0;
  }
}

// ── thumbnails ───────────────────────────────────────────────────────────────

const thumbUrls = new Map<string, { version: number; url: string }>();

function thumbUrlFor(id: string, t: StoredThumb | undefined): string {
  const cached = thumbUrls.get(id);
  if (cached && t && cached.version === t.version) return cached.url;
  if (cached) {
    URL.revokeObjectURL(cached.url);
    thumbUrls.delete(id);
  }
  if (!t) return '';
  const url = URL.createObjectURL(t.blob);
  thumbUrls.set(id, { version: t.version, url });
  return url;
}

let thumbQueue: Promise<void> = Promise.resolve();
const queued = new Set<string>();

/** Render the thumbnail of `id`'s current version in the background (serialized, one at a time). */
function scheduleThumbnail(id: string, version: number) {
  const key = blobKey(id, version);
  if (queued.has(key)) return;
  queued.add(key);
  thumbQueue = thumbQueue
    .then(() => renderThumbnail(id, version))
    .catch((e) => console.warn(`[library] thumbnail ${key} failed:`, e))
    .finally(() => queued.delete(key));
}

async function renderThumbnail(id: string, version: number): Promise<void> {
  const blob = (await tx(['blobs'], 'readonly', (s) => reqPromise(s.blobs.get(blobKey(id, version))))) as Blob | undefined;
  if (!blob) return;
  const { loadPdfjs } = await import('./engine/pdfjs');
  let png: Blob | null = null;
  try {
    const pdf = await loadPdfjs(new Uint8Array(await blob.arrayBuffer()));
    try {
      const page = await pdf.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: THUMB_WIDTH / base.width });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      await page.render({ canvas, viewport, background: 'rgb(255,255,255)' }).promise;
      png = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
      canvas.width = canvas.height = 0;
    } finally {
      void pdf.loadingTask.destroy();
    }
  } catch {
    png = null; // encrypted or damaged: keep the placeholder icon
  }
  await tx(['files', 'thumbs'], 'readwrite', async (s) => {
    const f = (await reqPromise(s.files.get(id))) as StoredFile | undefined;
    if (!f || f.version !== version) return; // deleted or saved again meanwhile
    if (png) s.thumbs.put({ version, blob: png } satisfies StoredThumb, id);
    else s.files.put({ ...f, thumbFailed: version } satisfies StoredFile, id);
  });
  if (png) notify();
}

function toMeta(f: StoredFile, t: StoredThumb | undefined): FileMeta {
  const thumb = t && t.version === f.version ? t : undefined;
  if (!thumb && f.thumbFailed !== f.version) scheduleThumbnail(f.id, f.version);
  return {
    id: f.id,
    name: f.name,
    size: f.size,
    pages: f.pages,
    createdAt: f.createdAt,
    modifiedAt: f.modifiedAt,
    version: f.version,
    starred: f.starred,
    thumbnailUrl: thumbUrlFor(f.id, thumb),
  };
}

async function requireFile(s: Record<StoreName, IDBObjectStore>, id: string): Promise<StoredFile> {
  const f = (await reqPromise(s.files.get(id))) as StoredFile | undefined;
  if (!f) throw new LibraryError(`The file no longer exists in your library.`, true);
  return f;
}

// ── public API ───────────────────────────────────────────────────────────────

export const library = {
  /** Newest (modifiedAt) first. `q` = case-insensitive substring of the name. */
  async listFiles(opts: { q?: string; starred?: boolean } = {}): Promise<FileMeta[]> {
    const q = opts.q?.trim().toLocaleLowerCase();
    const [files, thumbs] = await tx(['files', 'thumbs'], 'readonly', async (s) => {
      const keys = (await reqPromise(s.thumbs.getAllKeys())) as string[];
      const vals = (await reqPromise(s.thumbs.getAll())) as StoredThumb[];
      return [(await reqPromise(s.files.getAll())) as StoredFile[], new Map(keys.map((k, i) => [k, vals[i]]))] as const;
    });
    return files
      .filter((f) => (!q || f.name.toLocaleLowerCase().includes(q)) && (!opts.starred || f.starred))
      .sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt) || b.createdAt.localeCompare(a.createdAt))
      .map((f) => toMeta(f, thumbs.get(f.id)));
  },

  async getFile(id: string): Promise<FileMeta> {
    const [f, t] = await tx(['files', 'thumbs'], 'readonly', async (s) => [await requireFile(s, id), (await reqPromise(s.thumbs.get(id))) as StoredThumb | undefined] as const);
    return toMeta(f, t);
  },

  /** Add a PDF to the library as a new file. */
  async createFile(name: string, data: Uint8Array | Blob): Promise<FileMeta> {
    const bytes = await toBytes(data);
    if (!isPdf(bytes)) throw new LibraryError(`${name || 'The file'} is not a PDF.`);
    const pages = await countPages(bytes);
    const now = new Date().toISOString();
    const f: StoredFile = {
      id: nanoid(12),
      name: cleanFileName(name, 'document.pdf'),
      size: bytes.length,
      pages,
      createdAt: now,
      modifiedAt: now,
      version: 1,
      starred: false,
      versions: [{ version: 1, size: bytes.length, savedAt: now }],
    };
    await tx(['files', 'blobs'], 'readwrite', (s) => {
      s.blobs.put(pdfBlob(bytes), blobKey(f.id, 1));
      s.files.put(f, f.id);
    });
    askPersist();
    notify();
    return toMeta(f, undefined);
  },

  /** Kept for callers that upload a File/Blob. */
  uploadFile(file: Blob, name?: string): Promise<FileMeta> {
    return library.createFile(name ?? (file instanceof File ? file.name : 'document.pdf'), file);
  },

  async getFileBytes(id: string, version?: number): Promise<Uint8Array> {
    const blob = await tx(['files', 'blobs'], 'readonly', async (s) => {
      const f = await requireFile(s, id);
      const v = version ?? f.version;
      const b = (await reqPromise(s.blobs.get(blobKey(id, v)))) as Blob | undefined;
      if (!b) throw new LibraryError(`Version ${v} of “${f.name}” is no longer stored.`, true);
      return b;
    });
    return new Uint8Array(await blob.arrayBuffer());
  },

  /** Store bytes as a new version (version + 1). Keeps the last MAX_VERSIONS versions. */
  async saveFileBytes(id: string, bytes: Uint8Array, name?: string): Promise<FileMeta> {
    if (!isPdf(bytes)) throw new LibraryError('The document is not a PDF.');
    const pages = await countPages(bytes);
    const now = new Date().toISOString();
    const f = await tx(['files', 'blobs'], 'readwrite', async (s) => {
      const cur = await requireFile(s, id);
      const version = cur.version + 1;
      const versions = [...cur.versions, { version, size: bytes.length, savedAt: now }];
      const drop = versions.length > MAX_VERSIONS ? versions.splice(0, versions.length - MAX_VERSIONS) : [];
      const next: StoredFile = {
        ...cur,
        name: name ? cleanFileName(name) : cur.name,
        size: bytes.length,
        pages,
        modifiedAt: now,
        version,
        versions,
        thumbFailed: undefined,
      };
      s.blobs.put(pdfBlob(bytes), blobKey(id, version));
      for (const d of drop) s.blobs.delete(blobKey(id, d.version));
      s.files.put(next, id);
      return next;
    });
    askPersist();
    notify();
    return toMeta(f, undefined);
  },

  async patchFile(id: string, patch: { name?: string; starred?: boolean }): Promise<FileMeta> {
    if (patch.name !== undefined && !patch.name.trim()) throw new LibraryError('The name can’t be empty.');
    const [f, t] = await tx(['files', 'thumbs'], 'readwrite', async (s) => {
      const cur = await requireFile(s, id);
      const next: StoredFile = {
        ...cur,
        ...(patch.name !== undefined ? { name: cleanFileName(patch.name) } : {}),
        ...(patch.starred !== undefined ? { starred: patch.starred } : {}),
      };
      s.files.put(next, id);
      return [next, (await reqPromise(s.thumbs.get(id))) as StoredThumb | undefined] as const;
    });
    notify();
    return toMeta(f, t);
  },

  async deleteFile(id: string): Promise<void> {
    await tx(['files', 'blobs', 'thumbs'], 'readwrite', async (s) => {
      const f = (await reqPromise(s.files.get(id))) as StoredFile | undefined;
      if (!f) return;
      for (const v of f.versions) s.blobs.delete(blobKey(id, v.version));
      s.thumbs.delete(id);
      s.files.delete(id);
    });
    thumbUrlFor(id, undefined);
    notify();
  },

  /** Newest first. */
  async listVersions(id: string): Promise<FileVersion[]> {
    const f = await tx(['files'], 'readonly', (s) => requireFile(s, id));
    return f.versions.slice().reverse();
  },

  /** Make an older version current again (stored as a new version). */
  async restoreVersion(id: string, version: number): Promise<FileMeta> {
    const bytes = await library.getFileBytes(id, version);
    return library.saveFileBytes(id, bytes);
  },

  /** Bytes used / available for this site, when the browser reports it. */
  async usage(): Promise<{ used: number; quota: number; persisted: boolean } | null> {
    try {
      const est = await navigator.storage?.estimate?.();
      if (!est) return null;
      return { used: est.usage ?? 0, quota: est.quota ?? 0, persisted: !!(await navigator.storage.persisted?.()) };
    } catch {
      return null;
    }
  },
};

export type Library = typeof library;

// Dev convenience (the e2e suite reads the library through it).
if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__library = library;
