/**
 * Transient viewer UI state (not part of documents / undo): current pointer interaction,
 * marquee, text-selection popup, temporary space-bar panning and visible pages per document.
 */
import { create } from 'zustand';
import type { DocId, TextSelectionInfo, ViewBox } from '../types';

export type Interaction = 'move' | 'resize' | 'marquee' | 'pan' | 'text' | null;

export interface TextPopupState {
  docId: DocId;
  /** Position relative to the viewer root (CSS px). */
  left: number;
  top: number;
  placement: 'above' | 'below';
  selections: TextSelectionInfo[];
}

export interface MarqueeState {
  docId: DocId;
  pageIndex: number;
  box: ViewBox;
}

export interface CommentTarget {
  docId: DocId;
  objectId: string;
}

interface ViewerUiState {
  interaction: Interaction;
  /** Object whose comment popover is open (from the properties bar or the context menu). */
  commentFor: CommentTarget | null;
  marquee: MarqueeState | null;
  textPopup: TextPopupState | null;
  spacePan: boolean;
  visible: Record<DocId, number[]>;
}

export const useViewerUi = create<ViewerUiState>(() => ({
  interaction: null,
  commentFor: null,
  marquee: null,
  textPopup: null,
  spacePan: false,
  visible: {},
}));

export const viewerUi = {
  get: () => useViewerUi.getState(),
  set: (patch: Partial<ViewerUiState>) => useViewerUi.setState(patch),
  setVisible(docId: DocId, pages: number[]) {
    const prev = useViewerUi.getState().visible[docId];
    if (prev && prev.length === pages.length && prev.every((v, i) => v === pages[i])) return;
    useViewerUi.setState((s) => ({ visible: { ...s.visible, [docId]: pages } }));
  },
};

const EMPTY: number[] = [];
/** Indices of the pages currently intersecting the viewport of the document's viewer. */
export function useVisiblePages(docId: DocId): number[] {
  return useViewerUi((s) => s.visible[docId] ?? EMPTY);
}
