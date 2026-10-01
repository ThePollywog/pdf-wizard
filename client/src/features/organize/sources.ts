/**
 * Loading source files for Insert / Replace / Combine: any registered file type is converted to
 * PDF, password-protected PDFs ask for their password (like opening them) and are decrypted in
 * memory so their pages can be copied.
 */
import { PDFDocument, type PDFObject } from '@cantoo/pdf-lib';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { useRegistry } from '@/core/registry';
import * as engine from '@/core/engine';
import { handlerFor } from '@/core/engine/open';
import { destroyProxy, isPasswordError, pdfjsLib } from '@/core/engine/pdfjs';
import { getPasswordProvider, withoutBusy } from '@/core/engine/state';
import { SAVE_OPTIONS, collectGarbage } from '@/core/engine/lib';
import { baseName, readFileBytes } from '@/core/util';
import { library } from '@/core/library';
import { errMsg } from './util';


/** `accept` for file pickers: PDFs plus every type a file handler converts. */
export function acceptString(): string {
  const parts = new Set(['.pdf', 'application/pdf']);
  for (const h of useRegistry.getState().fileHandlers) {
    for (const e of h.extensions) {
      const x = e.toLowerCase().replace(/^\./, '');
      parts.add(x.includes('/') ? x : `.${x}`);
    }
    for (const m of h.mimePrefixes ?? []) parts.add(m.endsWith('/') ? `${m}*` : m);
  }
  return [...parts].join(',');
}

/** "Images and Word documents are converted to PDF." from the registered file handlers ('' if none). */
export function convertedTypesSentence(labels: string[]): string {
  const names = [...new Set(labels.map((l) => l.trim()).filter(Boolean))];
  if (!names.length) return '';
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const text = list.charAt(0).toUpperCase() + list.slice(1);
  return `${text} ${names.length === 1 && !/s$/i.test(names[0]) ? 'is' : 'are'} converted to PDF.`;
}

const extOf = (name: string) => (/\.([^./\\]+)$/.exec(name)?.[1] ?? '').toLowerCase();

export function isPdfFile(file: File) {
  return extOf(file.name) === 'pdf' || file.type === 'application/pdf';
}

/** True when the file can be added (PDF or a type some file handler converts). */
export function isSupportedFile(file: File) {
  return isPdfFile(file) || !!handlerFor(file);
}

/** PDF bytes of a file (PDFs as-is, other types through the file handlers). */
export async function fileToPdfBytes(file: File): Promise<{ name: string; bytes: Uint8Array }> {
  if (isPdfFile(file)) return { name: file.name, bytes: await readFileBytes(file) };
  const handler = handlerFor(file);
  if (handler) {
    try {
      return { name: `${baseName(file.name)}.pdf`, bytes: await handler.convert(file) };
    } catch (e) {
      throw new Error(`Couldn't convert “${file.name}” to PDF: ${errMsg(e)}`);
    }
  }
  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  if (engine.hasPdfHeader(head)) return { name: file.name, bytes: await readFileBytes(file) };
  throw new Error(`“${file.name}” can't be added: this file type isn't supported.`);
}

export interface LoadedPdf {
  name: string;
  /** Unencrypted PDF bytes. */
  bytes: Uint8Array;
  pdf: PDFDocumentProxy;
}

async function decrypt(bytes: Uint8Array, password: string): Promise<Uint8Array> {
  const lib = await PDFDocument.load(bytes, { password, updateMetadata: false, throwOnInvalidObject: false });
  (lib.context.trailerInfo as { Encrypt?: PDFObject }).Encrypt = undefined;
  await lib.flush();
  collectGarbage(lib);
  return lib.save(SAVE_OPTIONS);
}

/**
 * Load PDF bytes for copying pages: asks for the open password when needed and decrypts.
 * Resolves null when the password prompt was cancelled.
 */
export async function loadPdfSource(name: string, input: Uint8Array): Promise<LoadedPdf | null> {
  if (!engine.hasPdfHeader(input)) throw new Error(`“${name}” is not a PDF file or is damaged.`);
  let password: string | undefined;
  let pdf: PDFDocumentProxy;
  for (;;) {
    try {
      pdf = await engine.loadPdfjs(input, password !== undefined ? { password } : {});
      break;
    } catch (e) {
      if (!isPasswordError(e)) throw new Error(`Couldn't read “${name}”: ${errMsg(e)}`);
      const retry = e.code === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD;
      const provider = getPasswordProvider() ?? engine.passwordPrompt;
      const pw = await withoutBusy(() => provider(name, retry));
      if (pw === null || pw === undefined) return null;
      password = pw;
    }
  }
  let info: Record<string, unknown> = {};
  try {
    info = ((await pdf.getMetadata()).info ?? {}) as Record<string, unknown>;
  } catch {
    info = {};
  }
  if (!info.EncryptFilterName) return { name, bytes: input, pdf };
  try {
    const plain = await decrypt(input, password ?? '');
    const work = await engine.loadPdfjs(plain);
    destroyProxy(pdf);
    return { name, bytes: plain, pdf: work };
  } catch (e) {
    destroyProxy(pdf);
    throw new Error(`“${name}” is protected with security that can't be removed here (${errMsg(e)}).`);
  }
}

/** Convert + unlock a file. Null when cancelled. */
export async function loadFileSource(file: File): Promise<LoadedPdf | null> {
  const { name, bytes } = await fileToPdfBytes(file);
  return loadPdfSource(name, bytes);
}

/** Load a library file. Null when cancelled. */
export async function loadLibrarySource(fileId: string, name: string): Promise<LoadedPdf | null> {
  const bytes = await library.getFileBytes(fileId);
  return loadPdfSource(name, bytes);
}

/**
 * Turn picked / dropped files into plain PDF files for engine.insertFiles (one undo step).
 * Protected PDFs are unlocked first. Returns the prepared files and the page count.
 */
export async function preparePdfFiles(files: File[]): Promise<{ files: File[]; pages: number; skipped: string[] }> {
  const out: File[] = [];
  const skipped: string[] = [];
  let pages = 0;
  for (const f of files) {
    const src = await loadFileSource(f);
    if (!src) {
      skipped.push(f.name);
      continue;
    }
    pages += src.pdf.numPages;
    destroyProxy(src.pdf);
    const name = /\.pdf$/i.test(src.name) ? src.name : `${baseName(src.name)}.pdf`;
    out.push(new File([src.bytes as BlobPart], name, { type: 'application/pdf' }));
  }
  return { files: out, pages, skipped };
}

export { destroyProxy };
