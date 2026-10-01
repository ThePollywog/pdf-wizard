/**
 * Fill & Sign feature state (not part of the document / undo history):
 *  - saved signatures and initials, persisted in localStorage per user name
 *  - the signature / initials currently chosen for placement
 *  - the "Highlight fields" preference
 */
import { create } from 'zustand';
import { useApp } from '@/core/store';
import { uid } from '@/core/util';
import type { SigRole, SigSource } from './model';

export interface SavedSig {
  id: string;
  role: SigRole;
  /** PNG data URL (transparent background). */
  src: string;
  source: SigSource;
  recolorable: boolean;
  /** Tint for recolorable signatures. */
  color: string;
  /** Width / height of the image. */
  aspect: number;
  createdAt: number;
  /** False for "use once" signatures (Save signature unchecked). */
  saved: boolean;
}

interface SavedSet {
  signature: SavedSig[];
  initials: SavedSig[];
}

interface FillSignState {
  saved: SavedSet;
  /** User the saved set belongs to. */
  owner: string;
  pending: Record<SigRole, SavedSig | null>;
  highlight: boolean;
}

const SIG_PREFIX = 'pdfwizard.fillSign.signatures:';
const HIGHLIGHT_KEY = 'pdfwizard.fillSign.highlightFields';
const MAX_SAVED = 5;
const EMPTY_SET: SavedSet = { signature: [], initials: [] };

const ownerName = () => useApp.getState().prefs.userName || 'Guest';

function loadSaved(owner: string): SavedSet {
  try {
    const raw = localStorage.getItem(SIG_PREFIX + owner);
    if (!raw) return EMPTY_SET;
    const v = JSON.parse(raw) as Partial<SavedSet>;
    const clean = (list: unknown, role: SigRole): SavedSig[] =>
      Array.isArray(list)
        ? list
            .filter((s): s is SavedSig => !!s && typeof s === 'object' && typeof (s as SavedSig).src === 'string' && (s as SavedSig).src.startsWith('data:image/'))
            .map((s) => ({ ...s, role, saved: true, aspect: Number(s.aspect) > 0 ? Number(s.aspect) : 3, color: s.color || '#000000' }))
        : [];
    return { signature: clean(v.signature, 'signature'), initials: clean(v.initials, 'initials') };
  } catch {
    return EMPTY_SET;
  }
}

function persist(owner: string, set: SavedSet): boolean {
  try {
    localStorage.setItem(SIG_PREFIX + owner, JSON.stringify(set));
    return true;
  } catch {
    return false;
  }
}

function loadHighlight(): boolean {
  try {
    return localStorage.getItem(HIGHLIGHT_KEY) !== 'off';
  } catch {
    return true;
  }
}

export const useFillSign = create<FillSignState>(() => {
  const owner = ownerName();
  return { saved: loadSaved(owner), owner, pending: { signature: null, initials: null }, highlight: loadHighlight() };
});

const get = useFillSign.getState;
const set = useFillSign.setState;

/** Re-read the saved set when the user name changes. */
export function watchOwner(): () => void {
  return useApp.subscribe((s) => {
    const owner = s.prefs.userName || 'Guest';
    if (owner !== get().owner) set({ owner, saved: loadSaved(owner), pending: { signature: null, initials: null } });
  });
}

export function newSig(fields: Omit<SavedSig, 'id' | 'createdAt'>): SavedSig {
  return { ...fields, id: uid('sig'), createdAt: Date.now() };
}

/** Store a signature in the saved list (newest first). Returns false if the storage is full. */
export function saveSig(sig: SavedSig): boolean {
  const s = get();
  const list = [sig, ...s.saved[sig.role].filter((x) => x.id !== sig.id)].slice(0, MAX_SAVED);
  const next: SavedSet = { ...s.saved, [sig.role]: list };
  const ok = persist(s.owner, next);
  set({ saved: next });
  return ok;
}

export function deleteSig(role: SigRole, id: string) {
  const s = get();
  const next: SavedSet = { ...s.saved, [role]: s.saved[role].filter((x) => x.id !== id) };
  persist(s.owner, next);
  set({ saved: next, pending: s.pending[role]?.id === id ? { ...s.pending, [role]: null } : s.pending });
}

export function setPending(role: SigRole, sig: SavedSig | null) {
  set((s) => ({ pending: { ...s.pending, [role]: sig } }));
}

export function setHighlight(on: boolean) {
  try {
    localStorage.setItem(HIGHLIGHT_KEY, on ? 'on' : 'off');
  } catch {
    /* ignore */
  }
  set({ highlight: on });
}

export const MAX_SAVED_SIGS = MAX_SAVED;
