/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * Shared helpers for the end-to-end suite. Tests drive the real UI and read application state
 * through the development globals `window.__app` (store, actions, registry) and `window.__engine`.
 */
import { test as base, expect, type Download, type Page } from '@playwright/test';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PDFDocument } from '@cantoo/pdf-lib';

export const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/', import.meta.url));
const STANDARD_FONTS = fileURLToPath(new URL('../node_modules/pdfjs-dist/standard_fonts/', import.meta.url));

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    __app: { useApp: any; actions: any; getActiveDoc: () => any; reg: any };
    __engine: any;
    __library: any;
  }
}

// ── test fixture: fail on console errors / uncaught exceptions ─────────────────

export const test = base.extend<{ consoleErrors: string[] }>({
  consoleErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(`console.error: ${m.text()}`);
      });
      page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
      await use(errors);
      expect(errors, 'the page logged errors').toEqual([]);
    },
    { auto: true },
  ],
});
export { expect };

// ── state ──────────────────────────────────────────────────────────────────────

export interface DocSummary {
  id: string;
  name: string;
  pageCount: number;
  pageIds: string[];
  rotations: number[];
  labels: (string | undefined)[];
  view: { zoom: number; fit: 'width' | 'page' | null; layout: string; rotation: number; currentPage: number; darkPages?: boolean };
  dirty: boolean;
  version: number;
  pdfVersion: number;
  fileId: string | null;
  outlineCount: number;
  past: number;
  future: number;
  ext: Record<string, unknown>;
  loadError: string | null;
}

export interface AppStateSummary {
  route: string;
  activeDocId: string | null;
  tabs: string[];
  activeToolId: string;
  theme: string | undefined;
  doc: DocSummary | null;
}

/** Summary of the whole app state (route, tabs, active document). */
export function getAppState(page: Page): Promise<AppStateSummary> {
  return page.evaluate(() => {
    const s = window.__app.useApp.getState();
    const d = window.__app.getActiveDoc();
    return {
      route: s.route,
      activeDocId: s.activeDocId,
      tabs: [...s.tabs],
      activeToolId: s.activeToolId,
      theme: document.documentElement.dataset.theme,
      doc: d
        ? {
            id: d.id,
            name: d.name,
            pageCount: d.pages.length,
            pageIds: d.pages.map((p: any) => p.id),
            rotations: d.pages.map((p: any) => p.rotation),
            labels: d.pages.map((p: any) => p.label),
            view: { zoom: d.view.zoom, fit: d.view.fit, layout: d.view.layout, rotation: d.view.rotation, currentPage: d.view.currentPage, darkPages: d.view.darkPages },
            dirty: d.dirty,
            version: d.version,
            pdfVersion: d.pdfVersion,
            fileId: d.fileId ?? null,
            outlineCount: d.outline?.length ?? 0,
            past: d.history.past.length,
            future: d.history.future.length,
            ext: { ...d.ext },
            loadError: d.loadError ?? null,
          }
        : null,
    };
  });
}

/** Summary of the active document (throws when none is open). */
export async function getDoc(page: Page): Promise<DocSummary> {
  const s = await getAppState(page);
  if (!s.doc) throw new Error('No active document');
  return s.doc;
}

// ── opening ────────────────────────────────────────────────────────────────────

export async function gotoHome(page: Page) {
  await page.goto('/');
  await expect(page.getByTestId('library')).toBeVisible();
}

/** Waits until the active document is loaded and pdf.js matches the current bytes. */
export async function waitForDocReady(page: Page, name?: string) {
  await page.waitForFunction(
    (n) => {
      const d = window.__app?.getActiveDoc();
      return !!d && (!n || d.name === n) && !d.loading && !!d.pdf && d.pdfVersion === d.version;
    },
    name ?? null,
    { timeout: 30_000 },
  );
}

/**
 * Opens a fixture through the real file input (`[data-testid=open-file-input]`) and waits for it to
 * render. Pass `password` for protected files. Returns the new document id.
 */
export async function openFixture(page: Page, name: string, opts: { password?: string } = {}): Promise<string> {
  if (!/^https?:/.test(page.url())) await gotoHome(page);
  await page.getByTestId('open-file-input').setInputFiles(FIXTURES_DIR + name);
  if (opts.password !== undefined) {
    await page.getByTestId('password-input').fill(opts.password);
    await page.getByTestId('password-submit').click();
  }
  await waitForDocReady(page, name);
  await waitForPagesRendered(page);
  return (await getDoc(page)).id;
}

/** Waits until every mounted page of the active document has painted (at least `min` pages). */
export async function waitForPagesRendered(page: Page, min = 1) {
  await waitForDocReady(page);
  await page.waitForFunction(
    (m) => {
      const pages = [...document.querySelectorAll<HTMLElement>('[data-testid=document-viewer] [data-testid=page]')];
      return pages.length >= m && pages.every((p) => p.classList.contains('is-painted'));
    },
    min,
    { timeout: 30_000 },
  );
}

/** Runs `op` (UI action or engine call) and waits until it produced a new document version. */
export async function expectNewVersion(page: Page, op: () => Promise<unknown>) {
  const before = (await getDoc(page)).version;
  await op();
  await page.waitForFunction(
    (v) => {
      const d = window.__app.getActiveDoc();
      return !!d && d.version !== v && !!d.pdf && d.pdfVersion === d.version;
    },
    before,
    { timeout: 30_000 },
  );
}

/** Calls an engine page operation on the active document, e.g. engineOp(page, 'rotatePages', [1], 90). */
export async function engineOp(page: Page, op: string, ...args: unknown[]) {
  await expectNewVersion(page, () =>
    page.evaluate(
      ({ op, args }) => window.__engine[op](window.__app.getActiveDoc().id, ...args),
      { op, args },
    ),
  );
}

/** Current page order expressed as indices into `originalIds`. */
export async function pageOrder(page: Page, originalIds: string[]): Promise<number[]> {
  const d = await getDoc(page);
  return d.pageIds.map((id) => originalIds.indexOf(id));
}

// ── downloads & PDF inspection ────────────────────────────────────────────────

export async function captureDownload(page: Page, trigger: () => Promise<unknown>): Promise<{ download: Download; bytes: Uint8Array }> {
  const [download] = await Promise.all([page.waitForEvent('download'), trigger()]);
  const p = await download.path();
  if (!p) throw new Error('Download failed');
  return { download, bytes: new Uint8Array(fs.readFileSync(p)) };
}

/** Current bytes of a library file (the library lives in the page's IndexedDB). */
export async function fetchLibraryBytes(page: Page, fileId: string): Promise<Uint8Array> {
  const b64 = await page.evaluate(async (id) => {
    const bytes: Uint8Array = await window.__library.getFileBytes(id);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }, fileId);
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

/** Library listing as the page sees it. */
export function listLibrary(page: Page): Promise<{ id: string; name: string; version: number; pages: number; size: number }[]> {
  return page.evaluate(() => window.__library.listFiles());
}

/** Add a file to the page's library. */
export function uploadToLibrary(page: Page, name: string, bytes: Uint8Array): Promise<{ id: string; name: string }> {
  return page.evaluate(([n, b64]) => {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return window.__library.createFile(n, u8);
  }, [name, Buffer.from(bytes).toString('base64')] as const);
}

export async function loadPdfjsNode() {
  return import('pdfjs-dist/legacy/build/pdf.mjs');
}

/** Opens bytes with pdf.js in Node. pdf.js v6 documents are released through their loading task. */
export async function openPdfjs(bytes: Uint8Array, password?: string) {
  const pdfjs = await loadPdfjsNode();
  const task = pdfjs.getDocument({ data: bytes.slice(), password, standardFontDataUrl: STANDARD_FONTS, verbosity: 0 });
  try {
    const doc = await task.promise;
    return { doc, close: () => task.destroy() };
  } catch (e) {
    await task.destroy();
    throw e;
  }
}

/** Opens bytes with pdf.js in Node: page count, rotations and page texts. */
export async function inspectPdf(bytes: Uint8Array, password?: string) {
  const { doc, close } = await openPdfjs(bytes, password);
  const pages: { rotation: number; text: string; view: number[] }[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i);
    const tc = await p.getTextContent();
    const text = tc.items.map((it) => ('str' in it ? it.str : '')).join(' ').replace(/\s+/g, ' ').trim();
    pages.push({ rotation: p.rotate, text, view: [...p.view] });
  }
  const outline = (await doc.getOutline()) ?? [];
  await close();
  return { numPages: pages.length, pages, outlineCount: outline.length };
}

/** True when pdf.js refuses to open the bytes without a password. */
export async function needsPassword(bytes: Uint8Array): Promise<boolean> {
  try {
    const { close } = await openPdfjs(bytes);
    await close();
    return false;
  } catch (e) {
    return (e as Error).name === 'PasswordException';
  }
}

export function loadLib(bytes: Uint8Array, opts: { password?: string; ignoreEncryption?: boolean } = {}) {
  return PDFDocument.load(bytes, { ignoreEncryption: opts.ignoreEncryption ?? false, password: opts.password, updateMetadata: false });
}
