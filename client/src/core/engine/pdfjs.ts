/**
 * pdf.js setup: one shared worker for every document the engine loads, plus the standard
 * resource URLs (cMaps, standard fonts, wasm decoders, ICC profiles) served from /public/pdfjs.
 */
import * as pdfjsLib from 'pdfjs-dist';
import type { DocumentInitParameters } from 'pdfjs-dist/types/src/display/api';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { assetUrl } from '../util';

let configured = false;
let sharedWorker: pdfjsLib.PDFWorker | null = null;

/** Configure pdf.js globally (idempotent). Other code calling pdfjsLib.getDocument directly also gets a worker. */
export function configurePdfjs() {
  if (configured) return;
  configured = true;
  pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
}

/**
 * A single PDFWorker shared by all engine-loaded documents. Passing it explicitly to getDocument
 * means destroying one document never tears down the worker used by the others (which is what
 * happens with GlobalWorkerOptions.workerPort, and races with concurrent loads).
 */
function worker(): pdfjsLib.PDFWorker {
  configurePdfjs();
  if (!sharedWorker || sharedWorker.destroyed) sharedWorker = new pdfjsLib.PDFWorker({ name: 'pdfwizard-engine' as unknown as null });
  return sharedWorker;
}

/** getDocument parameters used everywhere in the app (no `isEvalSupported` in pdf.js v6). */
export function documentParams(extra: Partial<DocumentInitParameters> = {}): DocumentInitParameters {
  return {
    cMapUrl: assetUrl('pdfjs/cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: assetUrl('pdfjs/standard_fonts/'),
    wasmUrl: assetUrl('pdfjs/wasm/'),
    iccUrl: assetUrl('pdfjs/iccs/'),
    enableXfa: false,
    worker: worker(),
    ...extra,
  } as DocumentInitParameters;
}

export function loadingTaskFor(bytes: Uint8Array, opts: { password?: string } = {}) {
  // pdf.js transfers (detaches) the buffer it is given, so always hand it a private copy.
  const data = bytes.slice();
  return pdfjsLib.getDocument(documentParams({ data, ...(opts.password != null ? { password: opts.password } : {}) }));
}

/** Load a pdf.js document from a copy of `bytes`. Rejects with pdf.js errors (PasswordException etc). */
export async function loadPdfjs(bytes: Uint8Array, opts: { password?: string } = {}): Promise<PDFDocumentProxy> {
  const task = loadingTaskFor(bytes, opts);
  try {
    return await task.promise;
  } catch (e) {
    void task.destroy().catch(() => {});
    throw e;
  }
}

/** Destroy a proxy without throwing. */
export function destroyProxy(pdf: PDFDocumentProxy | null | undefined) {
  if (!pdf) return;
  try {
    void pdf.loadingTask.destroy().catch(() => {});
  } catch {
    /* already destroyed */
  }
}

export function isPasswordError(e: unknown): e is { name: string; code: number; message: string } {
  return !!e && typeof e === 'object' && (e as { name?: string }).name === 'PasswordException';
}

export { pdfjsLib };
