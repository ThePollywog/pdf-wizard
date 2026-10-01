/**
 * Shell-only UI state (not part of the contract store): command palette, read mode, saving
 * status, panel widths, library view preferences.
 */
import { create } from 'zustand';
import type { DocId } from '@/core/types';
import type { FileMeta } from '@/core/library';

const LAYOUT_KEY = 'pdfwizard.layout';

interface Persisted {
  leftWidth: number;
  rightWidth: number;
  libraryView: 'list' | 'grid';
  librarySort: 'modified' | 'name' | 'size';
}

function loadPersisted(): Persisted {
  const def: Persisted = { leftWidth: 280, rightWidth: 320, libraryView: 'list', librarySort: 'modified' };
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    return raw ? { ...def, ...JSON.parse(raw) } : def;
  } catch {
    return def;
  }
}

export interface ShellState extends Persisted {
  paletteOpen: boolean;
  /** Initial query for the palette (e.g. '>' for commands only). */
  paletteQuery: string;
  /** Hides the chrome around the document ("Read mode"). */
  readMode: boolean;
  /** Documents currently being saved to the library. */
  saving: Record<DocId, boolean>;
  /** Shown while files are dragged over the window. */
  dragOver: boolean;
  /** Last successful library listing (used by the File ▸ Open recent menu). */
  recentFiles: FileMeta[];
}

export const useShell = create<ShellState>(() => ({
  ...loadPersisted(),
  paletteOpen: false,
  paletteQuery: '',
  readMode: false,
  saving: {},
  dragOver: false,
  recentFiles: [],
}));

useShell.subscribe((s, prev) => {
  if (s.leftWidth === prev.leftWidth && s.rightWidth === prev.rightWidth && s.libraryView === prev.libraryView && s.librarySort === prev.librarySort) return;
  try {
    const p: Persisted = { leftWidth: s.leftWidth, rightWidth: s.rightWidth, libraryView: s.libraryView, librarySort: s.librarySort };
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
});

export const shell = {
  openPalette(query = '') {
    useShell.setState({ paletteOpen: true, paletteQuery: query });
  },
  closePalette() {
    useShell.setState({ paletteOpen: false });
  },
  setReadMode(readMode: boolean) {
    useShell.setState({ readMode });
  },
  setSaving(docId: DocId, saving: boolean) {
    useShell.setState((s) => {
      const next = { ...s.saving };
      if (saving) next[docId] = true;
      else delete next[docId];
      return { saving: next };
    });
  },
  setLeftWidth(w: number) {
    useShell.setState({ leftWidth: Math.round(Math.min(480, Math.max(220, w))) });
  },
  setRightWidth(w: number) {
    useShell.setState({ rightWidth: Math.round(Math.min(640, Math.max(260, w))) });
  },
  setLibraryView(libraryView: 'list' | 'grid') {
    useShell.setState({ libraryView });
  },
  setLibrarySort(librarySort: Persisted['librarySort']) {
    useShell.setState({ librarySort });
  },
  setRecentFiles(recentFiles: FileMeta[]) {
    useShell.setState({ recentFiles });
  },
};
