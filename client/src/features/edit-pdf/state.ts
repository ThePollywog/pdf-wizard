/**
 * Edit PDF UI state (not part of the document / undo history): the selected page item, the open
 * text editor session, drag ghosts that stay on screen until the page re-renders, crop mode and the
 * image waiting to be placed.
 */
import { create } from 'zustand';
import type { DocId, ObjectId, Rect } from '@/core/types';
import type { Frame, TextStyle } from './content/blocks';
import type { LoadedImage } from './images';

export type Target =
  /** Text block of the base PDF content. */
  | { type: 'block'; docId: DocId; pageIndex: number; id: string; text: string; bounds?: Rect }
  /** Image of the base PDF content (`name` / `bounds` identify it again after edits). */
  | { type: 'image'; docId: DocId; pageIndex: number; id: string; name?: string; bounds?: Rect }
  /** Link annotation of the base PDF. */
  | { type: 'link'; docId: DocId; pageIndex: number; id: string }
  /** Overlay object (content-text, content-image, link). */
  | { type: 'object'; docId: DocId; pageIndex: number; id: ObjectId };

export type EditSource =
  | { type: 'block'; blockId: string; expectText: string }
  | { type: 'object'; objectId: ObjectId }
  | { type: 'new' };

export interface EditSession {
  docId: DocId;
  pageIndex: number;
  source: EditSource;
  /** Base bytes the session started from (block sessions end when they change underneath). */
  bytes: Uint8Array;
  text: string;
  style: TextStyle;
  frame: Frame;
  /** Frame top → first baseline (points). */
  firstBaseline: number;
  /** Grow the frame with the text instead of wrapping (click-created text, single-line blocks). */
  autoWidth: boolean;
  original: { text: string; style: TextStyle; frame: Frame };
  phase: 'editing' | 'committing' | 'settling';
  /** Initial caret: a user-space point, 'end' or 'all'. */
  caret: { x: number; y: number } | 'end' | 'all';
  /** Paper color behind the original text (covers it while editing). */
  paper: string;
  /** Page canvas at commit time — the session disappears once the page shows the new content. */
  settleFrom?: Element | null;
  settleSince?: number;
  nonce: number;
}

/** Text drawn by a preview (same layout as the PDF writer). */
export interface TextPreviewSpec {
  text: string;
  style: TextStyle;
  frame: Frame;
  firstBaseline: number;
  autoWidth: boolean;
}

export interface Ghost {
  id: string;
  docId: DocId;
  pageIndex: number;
  /** User-space quads painted with the paper color (hide the original content). */
  cover: number[][];
  /** Snapshot of page pixels drawn into `to` (user-space rect). */
  snap?: { url: string; to: Rect };
  /** Text drawn on top (the new content until the page shows it). */
  text?: TextPreviewSpec;
  paper: string;
  /** Set once committed: removed when the page canvas changes. */
  settleFrom?: Element | null;
  since: number;
}

export interface CropState {
  docId: DocId;
  pageIndex: number;
  target: Target;
  /** Current crop rect (user space). */
  rect: Rect;
  /** Visible bounds when crop mode started (user space). */
  bounds: Rect;
  /** Bounds of the whole (uncropped) image — the crop can't grow past them. */
  full: Rect;
}

/** Re-select an item once the page model for the new bytes is available. */
export type Reselect =
  | { type: 'block'; docId: DocId; pageIndex: number; text: string; bounds: Rect }
  | { type: 'image'; docId: DocId; pageIndex: number; name: string; bounds: Rect };

interface EditPdfState {
  target: Target | null;
  hover: string | null;
  edit: EditSession | null;
  ghosts: Ghost[];
  crop: CropState | null;
  reselect: Reselect | null;
  /** Image chosen for the Add image tool. */
  pendingImage: LoadedImage | null;
  /** A byte edit started from this feature is running. */
  working: boolean;
  /** Bumped to move the keyboard focus back into the text editor. */
  focusNonce: number;
}

export const useEditPdf = create<EditPdfState>(() => ({
  target: null,
  hover: null,
  edit: null,
  ghosts: [],
  crop: null,
  reselect: null,
  pendingImage: null,
  working: false,
  focusNonce: 0,
}));

const set = useEditPdf.setState;
const get = useEditPdf.getState;
let nonce = 0;

export const ui = {
  get,
  setTarget(target: Target | null) {
    const cur = get().target;
    if (cur === target) return;
    if (cur && target && sameTarget(cur, target) && JSON.stringify(cur) === JSON.stringify(target)) return;
    set({ target, crop: null, reselect: null });
  },
  setHover(hover: string | null) {
    if (get().hover !== hover) set({ hover });
  },
  startEdit(s: Omit<EditSession, 'phase' | 'nonce'>) {
    const prev = get().edit;
    // a committed edit that is still waiting for the page to repaint stays visible as a ghost
    const ghosts = prev?.phase === 'settling' ? [...get().ghosts, ghostOfSession(prev)] : get().ghosts;
    set({ edit: { ...s, phase: 'editing', nonce: ++nonce }, crop: null, ghosts });
  },
  patchEdit(patch: Partial<EditSession>) {
    const e = get().edit;
    if (e) set({ edit: { ...e, ...patch } });
  },
  endEdit(nonceOf?: number) {
    const e = get().edit;
    if (e && (nonceOf === undefined || e.nonce === nonceOf)) set({ edit: null });
  },
  focusEditor() {
    set({ focusNonce: get().focusNonce + 1 });
  },
  addGhost(g: Omit<Ghost, 'id' | 'since'>): string {
    const id = `g${++nonce}`;
    set({ ghosts: [...get().ghosts, { ...g, id, since: performance.now() }] });
    return id;
  },
  patchGhost(id: string, patch: Partial<Ghost>) {
    set({ ghosts: get().ghosts.map((g) => (g.id === id ? { ...g, ...patch, since: patch.settleFrom !== undefined ? performance.now() : g.since } : g)) });
  },
  removeGhost(id: string) {
    if (get().ghosts.some((g) => g.id === id)) set({ ghosts: get().ghosts.filter((g) => g.id !== id) });
  },
  setCrop(crop: CropState | null) {
    set({ crop });
  },
  setReselect(reselect: Reselect | null) {
    set({ reselect });
  },
  setPendingImage(pendingImage: LoadedImage | null) {
    set({ pendingImage });
  },
  setWorking(working: boolean) {
    if (get().working !== working) set({ working });
  },
  /** Raw state patch (no side effects, unlike setTarget which also clears crop / reselect). */
  patch(p: Partial<EditPdfState>) {
    set(p);
  },
  reset() {
    set({ target: null, hover: null, edit: null, crop: null, reselect: null });
  },
};

/** Padded cover quad of a frame (hides the original glyphs incl. accents / descenders). */
export function coverQuad(f: Frame, pad: number): number[] {
  const p = (x: number, y: number) => [f.origin[0] + x * f.u[0] + y * f.d[0], f.origin[1] + x * f.u[1] + y * f.d[1]];
  return [...p(-pad, -pad), ...p(f.width + pad, -pad), ...p(f.width + pad, f.height + pad), ...p(-pad, f.height + pad)];
}

function ghostOfSession(e: EditSession): Ghost {
  const pad = Math.max(0.5, e.original.style.size * 0.12);
  return {
    id: `g${++nonce}`,
    docId: e.docId,
    pageIndex: e.pageIndex,
    cover: e.paper === 'transparent' ? [] : [coverQuad(e.original.frame, pad)],
    text: { text: e.text, style: e.style, frame: e.frame, firstBaseline: e.firstBaseline, autoWidth: e.autoWidth },
    paper: e.paper,
    settleFrom: e.settleFrom ?? null,
    since: e.settleSince ?? performance.now(),
  };
}

export function sameTarget(a: Target | null, b: Target | null): boolean {
  if (!a || !b) return a === b;
  return a.type === b.type && a.docId === b.docId && a.pageIndex === b.pageIndex && a.id === b.id;
}

export const targetKey = (t: Pick<Target, 'type' | 'pageIndex' | 'id'>) => `${t.type}:${t.pageIndex}:${t.id}`;
