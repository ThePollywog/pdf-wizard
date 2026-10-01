/**
 * Page content analysis for the editor UI: one pdf-lib load per document version (the latest only),
 * analysed lazily per page (text blocks, images, links).
 */
import { useEffect, useState } from 'react';
import type { PDFDocument } from '@cantoo/pdf-lib';
import { loadLib } from '@/core/engine';
import { useDoc } from '@/core/store';
import type { DocId } from '@/core/types';
import { analysePage, type PageAnalysis } from './content/ops';
import { readLinks, type LinkInfo } from './content/links';

export interface PageModel extends PageAnalysis {
  links: LinkInfo[];
  /** Base bytes this model was computed from. */
  bytes: Uint8Array;
}

interface Entry {
  bytes: Uint8Array;
  lib: Promise<PDFDocument>;
  pages: Map<number, PageModel | Error>;
}

const cache = new Map<DocId, Entry>();

function entryFor(docId: DocId, bytes: Uint8Array): Entry {
  let e = cache.get(docId);
  if (!e || e.bytes !== bytes) {
    e = { bytes, lib: loadLib(bytes), pages: new Map() };
    e.lib.catch(() => undefined);
    cache.set(docId, e);
  }
  return e;
}

export function forgetDoc(docId: DocId): void {
  cache.delete(docId);
}

export async function pageModel(docId: DocId, bytes: Uint8Array, pageIndex: number): Promise<PageModel> {
  const e = entryFor(docId, bytes);
  const hit = e.pages.get(pageIndex);
  if (hit instanceof Error) throw hit;
  if (hit) return hit;
  const lib = await e.lib;
  const again = e.pages.get(pageIndex);
  if (again instanceof Error) throw again;
  if (again) return again;
  try {
    if (pageIndex < 0 || pageIndex >= lib.getPageCount()) throw new Error('The page no longer exists.');
    const an = analysePage(lib, pageIndex);
    const model: PageModel = { ...an, links: readLinks(lib, pageIndex), bytes };
    e.pages.set(pageIndex, model);
    return model;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    e.pages.set(pageIndex, error);
    throw error;
  }
}

/** Cached model when already computed for the current bytes. */
export function peekPageModel(docId: DocId, bytes: Uint8Array, pageIndex: number): PageModel | null {
  const e = cache.get(docId);
  if (!e || e.bytes !== bytes) return null;
  const hit = e.pages.get(pageIndex);
  return hit && !(hit instanceof Error) ? hit : null;
}

export interface PageModelState {
  model: PageModel | null;
  error: string | null;
  loading: boolean;
}

/** Page model for the document's current bytes (null while it is being computed). */
export function usePageModel(docId: DocId, pageIndex: number, enabled = true): PageModelState {
  const docBytes = useDoc(docId, (d) => d?.bytes ?? null);
  const bytes = enabled ? docBytes : null;
  const [state, setState] = useState<{ bytes: Uint8Array | null; pageIndex: number; model: PageModel | null; error: string | null }>(() => ({
    bytes,
    pageIndex,
    model: bytes ? peekPageModel(docId, bytes, pageIndex) : null,
    error: null,
  }));
  useEffect(() => {
    if (!bytes) return;
    let alive = true;
    const cached = peekPageModel(docId, bytes, pageIndex);
    if (cached) {
      setState({ bytes, pageIndex, model: cached, error: null });
      return;
    }
    // analyse after the page had a chance to paint
    const t = setTimeout(() => {
      pageModel(docId, bytes, pageIndex).then(
        (model) => alive && setState({ bytes, pageIndex, model, error: null }),
        (e: unknown) => {
          if (!alive) return;
          console.warn('[edit-pdf] page analysis failed', e);
          setState({ bytes, pageIndex, model: null, error: e instanceof Error ? e.message : String(e) });
        },
      );
    }, 0);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [docId, bytes, pageIndex]);
  const current = state.bytes === bytes && state.pageIndex === pageIndex;
  return { model: current ? state.model : null, error: current ? state.error : null, loading: !current || (!state.model && !state.error) };
}
