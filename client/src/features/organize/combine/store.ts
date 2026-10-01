/**
 * State of the Combine files tool: the file cards (each a standalone source PDF), their page
 * lists (pages can be removed and moved within and across files) and the combine action.
 */
import { create } from 'zustand';
import type { DocId } from '@/core/types';
import * as engine from '@/core/engine';
import { actions, getDoc, useApp } from '@/core/store';
import { pickFiles } from '@/core/util';
import type { FileMeta } from '@/core/library';
import { acceptString, isSupportedFile, loadFileSource, loadLibrarySource, loadPdfSource, type LoadedPdf } from '../sources';
import { closeSource, registerSource } from '../pdfThumbs';
import { libraryPickerDialog } from '../dialogs/LibraryPicker';
import { buildBinder, nextBinderName, type BinderEntry } from './binder';
import { plural } from '../ranges';
import { errMsg, runBusy, stem } from '../util';
import { uid } from '@/core/util';

export interface CombineFile {
  key: string;
  sourceId: string;
  name: string;
  /** Size of the original file in bytes. */
  size: number;
  pageCount: number;
  /** Pages that go into the binder, in order (may include pages moved in from other files). */
  entries: BinderEntry[];
  expanded: boolean;
  origin: 'device' | 'library' | 'document';
}

interface CombineState {
  files: CombineFile[];
  /** Files currently loading. */
  loading: number;
  /** Document the tool was opened from (added first). */
  fromDoc: DocId | null;
}

export const useCombine = create<CombineState>(() => ({ files: [], loading: 0, fromDoc: null }));
const set = useCombine.setState;
const get = useCombine.getState;

/** Bumped by reset() so loads that finish afterwards are discarded. */
let generation = 0;

async function adopt(loaded: LoadedPdf, size: number, origin: CombineFile['origin'], at?: number): Promise<void> {
  const gen = generation;
  const src = await registerSource(loaded);
  if (gen !== generation) {
    closeSource(src.id);
    return;
  }
  const file: CombineFile = {
    key: uid('cf'),
    sourceId: src.id,
    name: loaded.name,
    size,
    pageCount: src.pages.length,
    entries: src.pages.map((_, page) => ({ sourceId: src.id, page })),
    expanded: false,
    origin,
  };
  set((s) => {
    const files = [...s.files];
    files.splice(at === undefined ? files.length : Math.max(0, Math.min(at, files.length)), 0, file);
    return { files };
  });
}

async function withLoading(fn: () => Promise<void>) {
  set((s) => ({ loading: s.loading + 1 }));
  try {
    await fn();
  } finally {
    set((s) => ({ loading: Math.max(0, s.loading - 1) }));
  }
}

export const combine = {
  /** Add picked / dropped files (PDFs and every convertible type), optionally at a card index. */
  async addFiles(files: File[], at?: number) {
    const ok = files.filter(isSupportedFile);
    const bad = files.filter((f) => !isSupportedFile(f));
    if (bad.length) {
      actions.toast(`${bad.map((f) => `“${f.name}”`).join(', ')} can't be combined: this file type isn't supported.`, { kind: 'error' });
    }
    let pos = at;
    for (const f of ok) {
      await withLoading(async () => {
        try {
          const loaded = await loadFileSource(f);
          if (!loaded) return;
          // Converted files (images, Office…) keep their original name on the card.
          await adopt({ ...loaded, name: f.name }, f.size, 'device', pos);
          if (pos !== undefined) pos++;
        } catch (e) {
          actions.toast(errMsg(e), { kind: 'error' });
        }
      });
    }
  },

  async pickFromDevice() {
    const files = await pickFiles({ accept: acceptString(), multiple: true });
    if (files.length) await combine.addFiles(files);
  },

  async addLibraryFiles(list: FileMeta[]) {
    for (const f of list) {
      await withLoading(async () => {
        try {
          const loaded = await loadLibrarySource(f.id, f.name);
          if (loaded) await adopt(loaded, f.size, 'library');
        } catch (e) {
          actions.toast(`Couldn't add “${f.name}”: ${errMsg(e)}`, { kind: 'error' });
        }
      });
    }
  },

  async pickFromLibrary() {
    const picked = await libraryPickerDialog({ title: 'Add from your files', confirmLabel: 'Add files', multiple: true });
    if (picked?.length) await combine.addLibraryFiles(picked);
  },

  /** Add an open document in its current state (unsaved changes included). */
  async addDocument(docId: DocId, at?: number) {
    const d = getDoc(docId);
    if (!d) return;
    await withLoading(async () => {
      try {
        let bytes: Uint8Array;
        try {
          bytes = engine.isReadOnly(docId) ? d.bytes : await engine.exportPdf(docId, { purpose: 'download', skipSecurity: true });
        } catch {
          bytes = d.bytes;
        }
        const loaded = await loadPdfSource(d.name, bytes);
        if (loaded) await adopt(loaded, bytes.length, 'document', at);
      } catch (e) {
        actions.toast(`Couldn't add “${d.name}”: ${errMsg(e)}`, { kind: 'error' });
      }
    });
  },

  remove(key: string) {
    const f = get().files.find((x) => x.key === key);
    if (!f) return;
    set((s) => ({
      files: s.files
        .filter((x) => x.key !== key)
        // Pages of the removed file that were moved into other files go too.
        .map((x) => ({ ...x, entries: x.entries.filter((e) => e.sourceId !== f.sourceId) })),
    }));
    closeSource(f.sourceId);
  },

  /** Move the card at `from` so it ends up before the card currently at `to` (to = length → end). */
  moveFile(from: number, to: number) {
    set((s) => {
      const files = [...s.files];
      if (from < 0 || from >= files.length) return s;
      const [f] = files.splice(from, 1);
      const at = to > from ? to - 1 : to;
      files.splice(Math.max(0, Math.min(files.length, at)), 0, f);
      return { files };
    });
  },

  sortByName(dir: 'asc' | 'desc') {
    const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    set((s) => ({ files: [...s.files].sort((a, b) => (dir === 'asc' ? 1 : -1) * collator.compare(a.name, b.name)) }));
  },

  setExpanded(key: string, expanded: boolean) {
    set((s) => ({ files: s.files.map((f) => (f.key === key ? { ...f, expanded } : f)) }));
  },

  expandAll(expanded: boolean) {
    set((s) => ({ files: s.files.map((f) => ({ ...f, expanded })) }));
  },

  removePage(key: string, index: number) {
    set((s) => ({ files: s.files.map((f) => (f.key === key ? { ...f, entries: f.entries.filter((_, i) => i !== index) } : f)) }));
  },

  /**
   * Restore the file to its original pages in their original order: its pages that were moved
   * into other files come back, and pages of other files that were moved into it go back to
   * their own file (near their original position).
   */
  resetPages(key: string) {
    set((s) => {
      const target = s.files.find((f) => f.key === key);
      if (!target) return s;
      const own = target.sourceId;
      const foreign = target.entries.filter((e) => e.sourceId !== own);
      const files = s.files.map((f) => {
        if (f.key === key) return { ...f, entries: Array.from({ length: f.pageCount }, (_, page) => ({ sourceId: own, page })) };
        let entries = f.entries.filter((e) => e.sourceId !== own);
        for (const e of foreign) {
          if (e.sourceId !== f.sourceId) continue;
          if (entries.some((x) => x.sourceId === e.sourceId && x.page === e.page)) continue;
          const at = entries.findIndex((x) => x.sourceId === f.sourceId && x.page > e.page);
          entries = at < 0 ? [...entries, e] : [...entries.slice(0, at), e, ...entries.slice(at)];
        }
        return entries === f.entries ? f : { ...f, entries };
      });
      return { files };
    });
  },

  /** Move a page entry to another position (possibly in another file). `toIndex` is before that entry. */
  movePage(fromKey: string, fromIndex: number, toKey: string, toIndex: number) {
    set((s) => {
      const files = s.files.map((f) => ({ ...f, entries: [...f.entries] }));
      const src = files.find((f) => f.key === fromKey);
      const dst = files.find((f) => f.key === toKey);
      if (!src || !dst || fromIndex < 0 || fromIndex >= src.entries.length) return s;
      const [entry] = src.entries.splice(fromIndex, 1);
      let at = toIndex;
      if (src === dst && toIndex > fromIndex) at--;
      dst.entries.splice(Math.max(0, Math.min(dst.entries.length, at)), 0, entry);
      return { files };
    });
  },

  totalPages(): number {
    return get().files.reduce((n, f) => n + f.entries.length, 0);
  },

  reset() {
    generation++;
    for (const f of get().files) closeSource(f.sourceId);
    set({ files: [], loading: 0, fromDoc: null });
  },

  /** Build the binder and open it in a new tab. */
  async run(onDone?: () => void): Promise<boolean> {
    const files = get().files.filter((f) => f.entries.length);
    if (!files.length) {
      actions.toast('Add files with at least one page to combine.', { kind: 'info' });
      return false;
    }
    const name = nextBinderName();
    const groups = files.map((f) => ({ title: stem(f.name), sourceId: f.sourceId, entries: f.entries }));
    const pages = groups.reduce((n, g) => n + g.entries.length, 0);
    const bytes = await runBusy(`Combining ${plural(files.length, 'file', 'files')}…`, (report) => buildBinder(groups, name, (p) => report(p)));
    if (!bytes) return false;
    onDone?.();
    const id = await engine.newDocumentFromBytes(name, bytes);
    if (!id) return false;
    actions.toast(`Combined ${plural(files.length, 'file', 'files')} (${plural(pages, 'page', 'pages')}) into ${name}`, { kind: 'success' });
    return true;
  },
};

/** Called when the tool opens: start with the active document. */
export function seedFromActiveDocument() {
  const docId = useApp.getState().activeDocId;
  const s = get();
  if (!docId || s.files.length || s.loading || !getDoc(docId)) return;
  set({ fromDoc: docId });
  void combine.addDocument(docId, 0);
}
