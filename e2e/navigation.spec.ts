/**
 * Navigation feature: Find bar and advanced search, Bookmarks, Attachments, Document Properties
 * (incl. Initial View and Custom metadata), Read Out Loud and Layers (optional content).
 * Every editing flow is checked end to end: UI → store → undo/redo → downloaded PDF.
 */
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFString, StandardFonts } from '@cantoo/pdf-lib';
import { FIXTURES_DIR, captureDownload, expect, getDoc, gotoHome, loadLib, openFixture, openPdfjs, test, waitForDocReady, waitForPagesRendered } from './helpers';

// ── helpers ────────────────────────────────────────────────────────────────────

const viewer = (page: Page) => page.getByTestId('document-viewer');
const findCount = (page: Page) => page.getByTestId('navigation-find-count');
/** The clickable label of an Advanced Search option checkbox. */
const searchOpt = (page: Page, key: 'whole' | 'case' | 'bookmarks' | 'comments') => page.getByTestId(`navigation-search-opt-${key}`).locator('label');
const bookmark = (page: Page, title: string) => page.locator(`[data-testid=navigation-bookmark][data-title="${title}"]`);

async function focusViewer(page: Page) {
  await viewer(page).locator('.pdfwizard-scroller').focus();
}

/**
 * Shows a right-rail panel. The rail buttons toggle, and a file's /PageMode may open its panel just after
 * the document is ready, so retry until the panel is actually showing.
 */
async function openPanel(page: Page, id: string, testid: string) {
  await expect(async () => {
    if (!(await page.getByTestId(testid).isVisible())) await page.getByTestId(`panel-btn-${id}`).click();
    await expect(page.getByTestId(testid)).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 15_000 });
}

/** Titles of the active document's outline, indented by depth, with bold/italic markers. */
function outlineOf(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    type Item = { title: string; bold?: boolean; italic?: boolean; children?: Item[] };
    const walk = (l: Item[], d = 0): string[] =>
      l.flatMap((i) => [`${'  '.repeat(d)}${i.title}${i.bold ? ' [b]' : ''}${i.italic ? ' [i]' : ''}`, ...walk(i.children ?? [], d + 1)]);
    return walk(window.__app.getActiveDoc().outline ?? []);
  });
}

/** Outline of a PDF file read with pdf.js in Node: "title @page [b]" lines, indented by depth. */
async function fileOutline(bytes: Uint8Array): Promise<string[]> {
  const { doc, close } = await openPdfjs(bytes);
  type Node = { title: string; bold: boolean; italic: boolean; dest: unknown; items: Node[] };
  const out: string[] = [];
  const walk = async (items: Node[], depth: number) => {
    for (const it of items) {
      let where = '';
      const dest = typeof it.dest === 'string' ? await doc.getDestination(it.dest) : (it.dest as unknown[] | null);
      if (Array.isArray(dest) && dest[0] && typeof dest[0] === 'object') where = ` @${(await doc.getPageIndex(dest[0] as { num: number; gen: number })) + 1}`;
      out.push(`${'  '.repeat(depth)}${it.title}${where}${it.bold ? ' [b]' : ''}${it.italic ? ' [i]' : ''}`);
      await walk(it.items ?? [], depth + 1);
    }
  };
  await walk(((await doc.getOutline()) ?? []) as Node[], 0);
  await close();
  return out;
}

const decodeText = (o: unknown) => (o instanceof PDFString || o instanceof PDFHexString ? o.decodeText() : o == null ? undefined : String(o));

/** Doc-level embedded files of a PDF read with pdf.js (catalog /Names /EmbeddedFiles): name → { description, size }. */
async function embeddedFiles(bytes: Uint8Array): Promise<Record<string, { description: string; size: number }>> {
  const { doc, close } = await openPdfjs(bytes);
  type Att = { filename?: string; content?: Uint8Array; description?: string };
  const att = ((await doc.getAttachments()) ?? {}) as unknown;
  const entries: [string, Att][] = att instanceof Map ? [...(att as Map<string, Att>).entries()] : Object.entries(att as Record<string, Att>);
  const out: Record<string, { description: string; size: number }> = {};
  for (const [key, v] of entries) {
    // pdf.js v6 loads the file data on demand.
    const content = v.content ?? (await doc.getAttachmentContent(key));
    out[v.filename || key] = { description: v.description ?? '', size: content?.length ?? -1 };
  }
  await close();
  return out;
}

/** Opens the app menu's View submenu and clicks one of its items. */
async function viewMenuItem(page: Page, id: string) {
  await page.getByTestId('app-menu').click();
  const target = page.locator(`[data-menu-id="${id}"]`);
  await expect(async () => {
    await page.locator('[data-menu-id="menu.view"]').hover();
    await expect(target).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await target.click();
}

async function download(page: Page) {
  return (await captureDownload(page, () => page.getByTestId('download').click())).bytes;
}

/** Opens in-memory PDF bytes through the real file input. */
async function openBytes(page: Page, name: string, bytes: Uint8Array) {
  if (!/^https?:/.test(page.url())) await gotoHome(page);
  await page.getByTestId('open-file-input').setInputFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
  await waitForDocReady(page, name);
  await waitForPagesRendered(page);
}

/** Two pages with three optional content groups (one initially hidden), built with low-level pdf-lib objects. */
async function layeredPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const ctx = doc.context;
  const ocg = (name: string) => ctx.register(ctx.obj({ Type: 'OCG', Name: PDFString.of(name) }));
  const red = ocg('Red box');
  const blue = ocg('Blue box');
  const draft = ocg('Draft watermark');
  for (let p = 0; p < 2; p++) {
    const page = doc.addPage([612, 792]);
    page.drawText(`Layers test page ${p + 1}`, { x: 72, y: 720, size: 24, font });
    const res = page.node.Resources()!;
    res.set(PDFName.of('Properties'), ctx.obj({ OC1: red, OC2: blue, OC3: draft }));
    const fontKey = (res.lookup(PDFName.of('Font'), PDFDict).keys()[0] as PDFName).asString();
    const ops =
      '/OC /OC1 BDC 1 0 0 rg 72 400 200 200 re f EMC\n' +
      '/OC /OC2 BDC 0 0 1 rg 320 400 200 200 re f EMC\n' +
      `/OC /OC3 BDC 0.5 g BT ${fontKey} 72 Tf 150 200 Td (DRAFT) Tj ET EMC\n`;
    const ref = ctx.register(ctx.flateStream(ops));
    const contents = page.node.get(PDFName.of('Contents'));
    const arr = page.node.Contents() instanceof PDFArray ? (page.node.Contents() as PDFArray) : ctx.obj([contents!]);
    arr.push(ref);
    page.node.set(PDFName.of('Contents'), arr);
  }
  doc.catalog.set(
    PDFName.of('OCProperties'),
    ctx.obj({ OCGs: [red, blue, draft], D: { Name: PDFString.of('Default'), Order: [red, blue, [PDFString.of('Extras'), draft]], OFF: [draft] } }),
  );
  return doc.save();
}

/** Four pages whose bookmarks use Fit, FitH top, XYZ with zoom and a named destination. */
async function destinationsPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pages = [0, 1, 2, 3].map((i) => {
    const p = doc.addPage([612, 792]);
    p.drawText(`Destinations page ${i + 1}`, { x: 72, y: 700, size: 24, font });
    return p;
  });
  const ctx = doc.context;
  const root = ctx.nextRef();
  const specs: [string, unknown[] | string][] = [
    ['Fit page', [pages[0].ref, PDFName.of('Fit')]],
    ['Fit width', [pages[1].ref, PDFName.of('FitH'), 400]],
    ['Zoom 200', [pages[2].ref, PDFName.of('XYZ'), 300, 250, 2]],
    ['Named', 'chap4'],
  ];
  const refs = specs.map(() => ctx.nextRef());
  specs.forEach(([title, dest], i) => {
    const o = ctx.obj({ Title: PDFHexString.fromText(title), Parent: root }) as PDFDict;
    if (i > 0) o.set(PDFName.of('Prev'), refs[i - 1]);
    if (i < specs.length - 1) o.set(PDFName.of('Next'), refs[i + 1]);
    o.set(PDFName.of('Dest'), typeof dest === 'string' ? PDFString.of(dest) : ctx.obj(dest as never));
    ctx.assign(refs[i], o);
  });
  ctx.assign(root, ctx.obj({ Type: 'Outlines', First: refs[0], Last: refs[refs.length - 1], Count: specs.length }));
  doc.catalog.set(PDFName.of('Outlines'), root);
  doc.catalog.set(PDFName.of('Names'), ctx.obj({ Dests: ctx.obj({ Names: [PDFString.of('chap4'), ctx.obj([pages[3].ref, PDFName.of('FitH'), 500])] }) }));
  return doc.save();
}

/** "title: mode args…" for each top-level bookmark of a file (named destinations resolved). */
async function fileDests(bytes: Uint8Array): Promise<Record<string, string>> {
  const { doc, close } = await openPdfjs(bytes);
  const out: Record<string, string> = {};
  for (const it of ((await doc.getOutline()) ?? []) as { title: string; dest: unknown }[]) {
    const d = (typeof it.dest === 'string' ? await doc.getDestination(it.dest) : it.dest) as unknown[] | null;
    if (!Array.isArray(d)) continue;
    const pageNo = (await doc.getPageIndex(d[0] as { num: number; gen: number })) + 1;
    const args = d.slice(2).map((v) => (v == null ? 'null' : String(Math.round(Number(v) * 1000) / 1000)));
    out[it.title] = [`@${pageNo}`, (d[1] as { name: string }).name, ...args].join(' ');
  }
  await close();
  return out;
}

/** RGB of the first rendered page canvas at a fraction of its size. */
function pagePixel(page: Page, fx: number, fy: number) {
  return page.evaluate(
    ({ fx, fy }) => {
      const c = document.querySelector<HTMLCanvasElement>('[data-testid=document-viewer] [data-testid=page][data-page-index="0"] canvas');
      if (!c) return null;
      const d = c.getContext('2d')!.getImageData(Math.round(fx * c.width), Math.round(fy * c.height), 1, 1).data;
      return [d[0], d[1], d[2]];
    },
    { fx, fy },
  );
}

/** A fake speechSynthesis: each utterance "speaks" for 300 ms; records the spoken texts on window.__spoken. */
function installSpeechStub() {
  const w = window as unknown as Record<string, unknown>;
  const spoken: string[] = [];
  w.__spoken = spoken;
  type U = { text: string; onstart?: (e: unknown) => void; onend?: (e: unknown) => void; onerror?: (e: unknown) => void };
  let cur: U | null = null;
  let timer: number | undefined;
  const synth = {
    speaking: false,
    pending: false,
    paused: false,
    getVoices: () => [],
    addEventListener() {},
    removeEventListener() {},
    speak(u: U) {
      spoken.push(u.text);
      cur = u;
      this.speaking = true;
      window.setTimeout(() => u.onstart?.({}), 5);
      timer = window.setTimeout(() => {
        this.speaking = false;
        cur = null;
        u.onend?.({});
      }, 300);
    },
    cancel() {
      window.clearTimeout(timer);
      const u = cur;
      cur = null;
      this.speaking = false;
      u?.onerror?.({ error: 'interrupted' });
    },
    pause() {
      this.paused = true;
      window.clearTimeout(timer);
    },
    resume() {
      if (!this.paused) return;
      this.paused = false;
      const u = cur;
      if (u)
        timer = window.setTimeout(() => {
          this.speaking = false;
          cur = null;
          u.onend?.({});
        }, 300);
    },
  };
  class Utterance {
    text: string;
    rate = 1;
    lang = '';
    constructor(t: string) {
      this.text = t;
    }
  }
  Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
  Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: Utterance, configurable: true });
}

// ── Find ───────────────────────────────────────────────────────────────────────

test('find bar: counts, stepping, match case, whole words, no results, escape', async ({ page }) => {
  await openFixture(page, 'sample.pdf');
  await focusViewer(page);
  await page.keyboard.press('ControlOrMeta+f');
  const input = page.getByTestId('navigation-find-input');
  await expect(page.getByTestId('navigation-findbar')).toBeVisible();
  await expect(input).toBeFocused();

  await input.fill('workflow');
  await expect(findCount(page)).toHaveText('1 of 11');
  await expect(viewer(page).locator('.navigation-find-hit').first()).toBeVisible();
  await expect(viewer(page).locator('.navigation-find-hit.is-active')).toHaveCount(1);

  await page.keyboard.press('Enter');
  await expect(findCount(page)).toHaveText('2 of 11');
  await page.keyboard.press('Shift+Enter');
  await expect(findCount(page)).toHaveText('1 of 11');
  await page.keyboard.press('Shift+Enter');
  await expect(findCount(page)).toHaveText('11 of 11'); // wraps around
  await page.getByTestId('navigation-find-next').click();
  await expect(findCount(page)).toHaveText('1 of 11');

  // Ctrl/Cmd+G from the document steps too.
  await focusViewer(page);
  await page.keyboard.press('ControlOrMeta+g');
  await expect(findCount(page)).toHaveText('2 of 11');
  await page.keyboard.press('ControlOrMeta+Shift+g');
  await expect(findCount(page)).toHaveText('1 of 11');

  // Whole words: "workflows" no longer counts.
  await page.getByTestId('navigation-find-options').click();
  await page.locator('[data-menu-id="navigation.find.wholeWords"]').click();
  await expect(findCount(page)).toHaveText('1 of 1');
  await page.getByTestId('navigation-find-options').click();
  await page.locator('[data-menu-id="navigation.find.wholeWords"]').click();

  // Match case: fixture ground truth, then a case mismatch shows "No results".
  await page.getByTestId('navigation-find-options').click();
  await page.locator('[data-menu-id="navigation.find.matchCase"]').click();
  await input.fill('Wizard'); // like desktop PDF editors, the first hit is the next one from the current view
  await expect(findCount(page)).toHaveText(/^\d of 9$/);
  await input.fill('wizard');
  await expect(findCount(page)).toHaveText(/no results/i);
  await expect(viewer(page).locator('.navigation-find-hit')).toHaveCount(0);

  // Whitespace normalisation: runs of spaces in the query match single spaces / line breaks.
  await page.getByTestId('navigation-find-options').click();
  await page.locator('[data-menu-id="navigation.find.matchCase"]').click();
  await input.fill('document   workflows');
  await expect(findCount(page)).toHaveText(/^\d of 8$/); // page-1 title, 5 running headers, the TOC entry and the heading

  await input.fill('Wizard');
  await expect(findCount(page)).toHaveText(/^\d of 9$/);
  await input.press('Escape');
  await expect(page.getByTestId('navigation-findbar')).toHaveCount(0);
  await expect(viewer(page).locator('.navigation-find-hit')).toHaveCount(0);
  await expect(viewer(page).locator('.pdfwizard-scroller')).toBeFocused(); // focus returns to the document
});

test('find normalises hyphenated line breaks, typographic quotes and ligatures', async ({ page }) => {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([612, 792]);
  p.drawText('Every review work-', { x: 72, y: 700, size: 14, font });
  p.drawText('flow ends with the author\u2019s approval.', { x: 72, y: 680, size: 14, font });
  await openBytes(page, 'hyphenation.pdf', await doc.save());
  await focusViewer(page);
  await page.keyboard.press('ControlOrMeta+f');
  const input = page.getByTestId('navigation-find-input');
  await input.fill('workflow');
  await expect(findCount(page)).toHaveText('1 of 1');
  // The hit spans both lines: two highlight rectangles.
  await expect(viewer(page).locator('.navigation-find-hit')).toHaveCount(2);
  await input.fill("author's approval");
  await expect(findCount(page)).toHaveText('1 of 1');
  await input.fill('review workflow ends');
  await expect(findCount(page)).toHaveText('1 of 1');
  // Ligature glyphs (not encodable with the standard 14 fonts) are expanded by the same normaliser.
  const norm = await page.evaluate(async () => {
    const url = '/client/src/features/navigation/find/text.ts';
    const m = await import(/* @vite-ignore */ url);
    return m.normalize('The O\uFB03ce \uFB02ow', false).text as string;
  });
  expect(norm).toBe('the office flow');
});

test('advanced search groups results by page and jumps to a result', async ({ page }) => {
  await openFixture(page, 'sample.pdf');
  await focusViewer(page);
  await page.keyboard.press('ControlOrMeta+Shift+f');
  await expect(page.getByTestId('navigation-search-panel')).toBeVisible();
  await searchOpt(page, 'case').click();
  await page.getByTestId('navigation-search-input').fill('Wizard');
  await page.getByTestId('navigation-search-input').press('Enter');
  await expect(page.getByTestId('navigation-search-summary')).toHaveText(/9 instances in 6 pages/);
  const groups = page.getByTestId('navigation-search-group');
  await expect(groups).toHaveCount(6);
  const perPage: number[] = [];
  for (let i = 1; i <= 6; i++) perPage.push(await page.locator(`[data-testid=navigation-search-result][data-page="${i}"]`).count());
  expect(perPage).toEqual([2, 1, 2, 2, 1, 1]);
  await expect(page.locator('[data-testid=navigation-search-result] mark').first()).toHaveText('Wizard');

  await page.locator('[data-testid=navigation-search-result][data-page="4"]').first().click();
  await expect.poll(async () => (await getDoc(page)).view.currentPage).toBe(3);
  await expect(viewer(page).locator('.navigation-search-hit').first()).toBeVisible();

  // Case-insensitive, including bookmarks.
  await searchOpt(page, 'case').click();
  await searchOpt(page, 'bookmarks').click();
  await page.getByTestId('navigation-search-input').fill('workflow');
  await page.getByTestId('navigation-search-go').click();
  await expect(page.getByTestId('navigation-search-summary')).toHaveText(/11 instances/);
  await expect(page.getByTestId('navigation-search-bookmark-result').first()).toBeVisible();
});

// ── Bookmarks ──────────────────────────────────────────────────────────────────

test('bookmarks: navigate, create, rename, style, drag, delete, undo/redo and round trip', async ({ page }) => {
  await openFixture(page, 'sample.pdf');
  await openPanel(page, 'bookmarks', 'navigation-bookmarks-panel');
  const original = await outlineOf(page);
  expect(original).toContain('    Table 1: Timings [i]');
  // The panel opens by itself (/PageMode /UseOutlines); closed items (/Count < 0) start collapsed.
  await expect(page.getByTestId('navigation-bookmark')).toHaveCount(10);
  await expect(bookmark(page, 'Table 1: Timings')).toHaveCount(0);
  await page.getByTestId('navigation-bookmark-expand-all').click();
  await expect(page.getByTestId('navigation-bookmark')).toHaveCount(original.length);

  // Click navigates to the destination; the current section is highlighted.
  await bookmark(page, '1.2 Goals').click();
  await expect.poll(async () => (await getDoc(page)).view.currentPage).toBe(2);
  await bookmark(page, '4 Conclusion').click();
  await expect.poll(async () => (await getDoc(page)).view.currentPage).toBe(5);

  // Collapse / expand all.
  await page.getByTestId('navigation-bookmark-collapse-all').click();
  await expect(page.getByTestId('navigation-bookmark')).toHaveCount(6);
  await page.getByTestId('navigation-bookmark-expand-all').click();
  await expect(page.getByTestId('navigation-bookmark')).toHaveCount(original.length);

  // Keyboard: arrows move the focus, Left collapses, Right expands.
  await bookmark(page, '1 Introduction').click();
  await expect(bookmark(page, '1 Introduction')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(bookmark(page, '1.1 Background')).toHaveCount(0);
  await page.keyboard.press('ArrowRight');
  await expect(bookmark(page, '1.1 Background')).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(bookmark(page, '1.1 Background')).toBeFocused();

  // New bookmark at the current view (page 3): inline rename.
  await expect.poll(async () => (await getDoc(page)).view.currentPage).toBe(2);
  await page.getByTestId('navigation-bookmark-new').click();
  const rename = page.getByTestId('navigation-bookmark-rename-input');
  await expect(rename).toBeFocused();
  await rename.fill('My mark');
  await rename.press('Enter');
  await expect(bookmark(page, 'My mark')).toBeVisible();
  expect(await outlineOf(page)).toHaveLength(original.length + 1);
  // Each bookmark command is its own undo step, even in quick succession (no waits needed).

  // F2 renames the selected bookmark.
  await bookmark(page, 'My mark').focus();
  await page.keyboard.press('F2');
  await rename.fill('Renamed mark');
  await rename.press('Enter');
  await expect(bookmark(page, 'Renamed mark')).toBeVisible();

  // Undo / redo the rename.
  await focusViewer(page);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(bookmark(page, 'My mark')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(bookmark(page, 'Renamed mark')).toBeVisible();

  // Properties: bold + italic.
  await bookmark(page, 'Renamed mark').click({ button: 'right' });
  await page.locator('[data-menu-id="navigation.bm.props"]').click();
  await expect(page.getByTestId('navigation-bmprops-title')).toHaveValue('Renamed mark');
  await page.getByTestId('navigation-bmprops-style').selectOption('bold-italic');
  await page.getByTestId('navigation-bmprops-ok').click();
  await expect.poll(() => outlineOf(page)).toContain('  Renamed mark [b] [i]');

  // Drag onto the middle of "3 Performance" → becomes its last child.
  await bookmark(page, 'Renamed mark').dragTo(bookmark(page, '3 Performance'));
  await expect
    .poll(async () => {
      const o = await outlineOf(page);
      return o.slice(o.indexOf('3 Performance'), o.indexOf('4 Conclusion'));
    })
    .toEqual(['3 Performance', '  3.1 Benchmarks', '    Table 1: Timings [i]', '  Renamed mark [b] [i]']);
  expect((await outlineOf(page)).filter((l) => l.includes('Renamed mark'))).toHaveLength(1);

  // Deleting a bookmark with children asks first; cancel keeps it.
  await bookmark(page, '2 Document Workflows').click();
  await page.getByTestId('navigation-bookmark-delete').click();
  await expect(page.getByTestId('dialog-confirm')).toBeVisible();
  await page.getByTestId('dialog-cancel').click();
  await expect(bookmark(page, '2 Document Workflows')).toBeVisible();
  await page.getByTestId('navigation-bookmark-delete').click();
  await page.getByTestId('dialog-confirm').click();
  await expect(bookmark(page, '2 Document Workflows')).toHaveCount(0);
  await expect(bookmark(page, '2.1 Reviewing and Commenting')).toHaveCount(0);
  await focusViewer(page);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(bookmark(page, '2.1 Reviewing and Commenting')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(bookmark(page, '2 Document Workflows')).toHaveCount(0);

  // Round trip: the downloaded file carries the edited outline with real destinations.
  const bytes = await download(page);
  const out = await fileOutline(bytes);
  expect(out).toContain('3 Performance @5');
  expect(out.find((l) => l.includes('Renamed mark'))).toBe('  Renamed mark @3 [b] [i]');
  expect(out.some((l) => l.includes('Document Workflows'))).toBe(false);
  expect(out).toContain('1 Introduction @3');

  // …and reopening it shows the same tree.
  await openBytes(page, 'bookmarks-roundtrip.pdf', bytes);
  await openPanel(page, 'bookmarks', 'navigation-bookmarks-panel');
  await expect(bookmark(page, 'Renamed mark')).toBeVisible();
});

test('bookmarks: empty state and new bookmark from the page context menu', async ({ page }) => {
  await openFixture(page, 'mixed-sizes.pdf');
  await openPanel(page, 'bookmarks', 'navigation-bookmarks-panel');
  await expect(page.getByTestId('navigation-bookmark-empty-new')).toBeVisible();
  await viewer(page).locator('[data-testid=page][data-page-index="0"]').click({ button: 'right', position: { x: 60, y: 60 } });
  await page.locator('[data-menu-id="navigation.ctx.bookmark"]').click();
  await page.getByTestId('navigation-bookmark-rename-input').fill('First page');
  await page.getByTestId('navigation-bookmark-rename-input').press('Enter');
  await expect(bookmark(page, 'First page')).toBeVisible();
  const out = await fileOutline(await download(page));
  expect(out).toEqual(['First page @1']);
});

test('bookmarks: imported Fit / FitH / XYZ-zoom / named destinations navigate and survive edits', async ({ page }) => {
  await openBytes(page, 'destinations.pdf', await destinationsPdf());
  await openPanel(page, 'bookmarks', 'navigation-bookmarks-panel');
  await expect(page.getByTestId('navigation-bookmark')).toHaveCount(4);

  await bookmark(page, 'Zoom 200').click();
  await expect.poll(async () => (await getDoc(page)).view.zoom).toBeCloseTo(2, 2);
  await expect.poll(async () => (await getDoc(page)).view.currentPage).toBe(2);
  await bookmark(page, 'Fit page').click();
  await expect.poll(async () => (await getDoc(page)).view.fit).toBe('page');
  await expect.poll(async () => (await getDoc(page)).view.currentPage).toBe(0);
  await bookmark(page, 'Fit width').click();
  await expect.poll(async () => (await getDoc(page)).view.fit).toBe('width');
  await expect.poll(async () => (await getDoc(page)).view.currentPage).toBe(1);

  // Properties shows the stored zoom; OK without changes is not an edit (no undo step, not dirty).
  await bookmark(page, 'Zoom 200').click({ button: 'right' });
  await page.locator('[data-menu-id="navigation.bm.props"]').click();
  await expect(page.getByTestId('navigation-bmprops-zoom')).toHaveValue('custom');
  await page.getByTestId('navigation-bmprops-ok').click();
  await bookmark(page, 'Fit width').click({ button: 'right' });
  await page.locator('[data-menu-id="navigation.bm.props"]').click();
  await expect(page.getByTestId('navigation-bmprops-zoom')).toHaveValue('fith');
  await page.getByTestId('navigation-bmprops-ok').click();
  await expect(page.getByTestId('navigation-bmprops-ok')).toHaveCount(0);
  expect((await getDoc(page)).past).toBe(0);
  expect((await getDoc(page)).dirty).toBe(false);

  // Two quick renames are two undo steps.
  await bookmark(page, 'Named').click();
  await page.keyboard.press('F2');
  await page.getByTestId('navigation-bookmark-rename-input').fill('Chapter four');
  await page.getByTestId('navigation-bookmark-rename-input').press('Enter');
  await bookmark(page, 'Fit page').click();
  await page.keyboard.press('F2');
  await page.getByTestId('navigation-bookmark-rename-input').fill('Start');
  await page.getByTestId('navigation-bookmark-rename-input').press('Enter');
  await expect(bookmark(page, 'Start')).toBeVisible();
  expect((await getDoc(page)).past).toBe(2);
  await focusViewer(page);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(bookmark(page, 'Fit page')).toBeVisible();
  await expect(bookmark(page, 'Chapter four')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(bookmark(page, 'Start')).toBeVisible();

  // The rewritten outline keeps every destination (not just the page).
  expect(await fileDests(await download(page))).toEqual({
    Start: '@1 Fit',
    'Fit width': '@2 FitH 400',
    'Zoom 200': '@3 XYZ 300 250 2',
    'Chapter four': '@4 FitH 500',
  });
});

test('bookmarks: dropping on the lower part of an expanded parent makes it the first child', async ({ page }) => {
  await openFixture(page, 'sample.pdf');
  await openPanel(page, 'bookmarks', 'navigation-bookmarks-panel');
  await page.getByTestId('navigation-bookmark-expand-all').click();
  const target = bookmark(page, '1 Introduction');
  const box = (await target.boundingBox())!;
  await bookmark(page, '4 Conclusion').dragTo(target, { targetPosition: { x: 40, y: box.height - 3 } });
  await expect
    .poll(async () => {
      const o = await outlineOf(page);
      return o.slice(o.indexOf('1 Introduction'), o.indexOf('2 Document Workflows'));
    })
    .toEqual(['1 Introduction', '  4 Conclusion', '    4.1 Further Reading', '  1.1 Background', '  1.2 Goals']);
  // Upper part → before, as a sibling.
  const top = bookmark(page, '2 Document Workflows');
  await bookmark(page, '1.2 Goals').dragTo(top, { targetPosition: { x: 40, y: 2 } });
  await expect
    .poll(async () => {
      const o = await outlineOf(page);
      const i = o.indexOf('1.2 Goals');
      return i < 0 ? o : o.slice(i - 1, i + 2);
    })
    .toEqual(['  1.1 Background', '1.2 Goals', '2 Document Workflows']);
  expect((await getDoc(page)).past).toBe(2);
});

// ── Attachments ────────────────────────────────────────────────────────────────

test('attachments: add, describe, save, delete, undo and round trip', async ({ page }) => {
  await openFixture(page, 'sample.pdf');
  await openPanel(page, 'attachments', 'navigation-attachments-panel');
  await expect(page.getByTestId('panel-btn-attachments').locator('.icon-btn-badge')).toHaveCount(0);
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('navigation-attachment-empty-add').click()]);
  await chooser.setFiles([FIXTURES_DIR + 'sample.txt', FIXTURES_DIR + 'sample.png']);
  await expect(page.getByTestId('navigation-attachment')).toHaveCount(2);
  await expect(page.getByTestId('panel-btn-attachments').locator('.icon-btn-badge')).toHaveText('2');

  // Edit the description of sample.txt.
  await page.locator('[data-testid=navigation-attachment][data-name="sample.txt"]').click();
  await page.getByTestId('navigation-attachment-desc').click();
  await page.getByTestId('prompt-input').fill('Plain text notes');
  await page.getByTestId('dialog-confirm').click();
  await expect(page.locator('[data-testid=navigation-attachment][data-name="sample.txt"] [data-testid=navigation-attachment-description]')).toHaveText('Plain text notes');

  // Save the attachment itself.
  const { download: saved, bytes: txt } = await captureDownload(page, () => page.getByTestId('navigation-attachment-save').click());
  expect(saved.suggestedFilename()).toBe('sample.txt');
  expect(Buffer.from(txt).equals(fs.readFileSync(FIXTURES_DIR + 'sample.txt'))).toBe(true);

  // Delete sample.png, undo, redo.
  await page.locator('[data-testid=navigation-attachment][data-name="sample.png"]').click();
  await page.getByTestId('navigation-attachment-delete').click();
  await expect(page.getByTestId('navigation-attachment')).toHaveCount(1);
  await focusViewer(page);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.getByTestId('navigation-attachment')).toHaveCount(2);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(page.getByTestId('navigation-attachment')).toHaveCount(1);
  await page.keyboard.press('ControlOrMeta+z');
  await expect(page.getByTestId('navigation-attachment')).toHaveCount(2);

  // Round trip: standard /EmbeddedFiles name tree with the description and size.
  const bytes = await download(page);
  const files = await embeddedFiles(bytes);
  expect(Object.keys(files).sort()).toEqual(['sample.png', 'sample.txt']);
  expect(files['sample.txt'].description).toBe('Plain text notes');
  expect(files['sample.png'].size).toBe(fs.statSync(FIXTURES_DIR + 'sample.png').size);
  expect(files['sample.txt'].size).toBe(fs.statSync(FIXTURES_DIR + 'sample.txt').size);
  const lib = await loadLib(bytes);
  expect(lib.catalog.lookup(PDFName.of('Names'), PDFDict).has(PDFName.of('EmbeddedFiles'))).toBe(true);

  // Reopened: listed again with the badge. (sample.pdf asks for PageMode /UseOutlines, which is
  // honoured right after opening — wait for it before switching panels.)
  await openBytes(page, 'attachments-roundtrip.pdf', bytes);
  await expect(page.getByTestId('navigation-bookmarks-panel')).toBeVisible();
  await expect(page.getByTestId('panel-btn-attachments').locator('.icon-btn-badge')).toHaveText('2');
  await openPanel(page, 'attachments', 'navigation-attachments-panel');
  await expect(page.locator('[data-testid=navigation-attachment][data-name="sample.txt"] [data-testid=navigation-attachment-description]')).toHaveText('Plain text notes');
});

// ── Document properties ────────────────────────────────────────────────────────

test('document properties: description, fonts, custom metadata, initial view — round trip and honoured on open', async ({ page }) => {
  await openFixture(page, 'sample.pdf');
  await focusViewer(page);
  await page.keyboard.press('ControlOrMeta+Alt+p');
  const dialog = page.getByTestId('navigation-props-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('navigation-props-title')).toHaveValue('PDF Wizard: Document Workflows in the Browser');
  await expect(page.getByTestId('navigation-props-pages')).toHaveText('6');
  await expect(page.getByTestId('navigation-props-version')).toHaveText('1.7');
  await expect(page.getByTestId('navigation-props-pagesize')).toHaveText('8.50 × 11.00 in');
  await page.getByTestId('navigation-props-title').fill('Edited title');
  await page.getByTestId('navigation-props-keywords').fill('alpha; beta');

  await page.getByTestId('navigation-props-tab-security').click();
  await expect(page.getByTestId('navigation-props-security-method')).toHaveText('No Security');

  await page.getByTestId('navigation-props-tab-fonts').click();
  await expect(page.getByTestId('navigation-props-font')).toHaveCount(5);
  await expect(page.getByTestId('navigation-props-font-list')).toContainText('Times-Italic');

  await page.getByTestId('navigation-props-tab-initial').click();
  await page.getByTestId('navigation-props-pagemode').selectOption('UseOutlines');
  await page.getByTestId('navigation-props-layout').selectOption('TwoColumnLeft');
  await page.getByTestId('navigation-props-magnification').selectOption('fitWidth');
  await page.getByTestId('navigation-props-openpage').locator('input').fill('3');
  await page.getByTestId('navigation-props-show').selectOption('title');

  await page.getByTestId('navigation-props-tab-custom').click();
  await page.getByTestId('navigation-props-custom-name').fill('Department');
  await page.getByTestId('navigation-props-custom-value').fill('Research');
  await page.getByTestId('navigation-props-custom-add').click();
  await page.getByTestId('navigation-props-custom-name').fill('Reviewer');
  await page.getByTestId('navigation-props-custom-value').fill('Ada');
  await page.getByTestId('navigation-props-custom-value').press('Enter');
  await expect(page.getByTestId('navigation-props-custom-row')).toHaveCount(2);
  // Select → change the value.
  await page.locator('[data-testid=navigation-props-custom-row][data-name="Reviewer"]').click();
  await page.getByTestId('navigation-props-custom-value').fill('Grace');
  await page.getByTestId('navigation-props-custom-change').click();
  await expect(page.locator('[data-testid=navigation-props-custom-row][data-name="Reviewer"]')).toContainText('Grace');
  await page.getByTestId('navigation-props-ok').click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await getDoc(page)).dirty).toBe(true);

  // Undo restores the title, redo re-applies it.
  await focusViewer(page);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => page.evaluate(() => window.__app.getActiveDoc().meta.title)).toBe('PDF Wizard: Document Workflows in the Browser');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(() => page.evaluate(() => window.__app.getActiveDoc().meta.title)).toBe('Edited title');

  const bytes = await download(page);
  const lib = await loadLib(bytes);
  expect(lib.getTitle()).toBe('Edited title');
  expect(lib.getKeywords()).toBe('alpha; beta');
  const info = lib.context.lookup(lib.context.trailerInfo.Info, PDFDict);
  expect(decodeText(info.lookup(PDFName.of('Department')))).toBe('Research');
  expect(decodeText(info.lookup(PDFName.of('Reviewer')))).toBe('Grace');
  const cat = lib.catalog;
  expect(String(cat.lookup(PDFName.of('PageMode')))).toBe('/UseOutlines');
  expect(String(cat.lookup(PDFName.of('PageLayout')))).toBe('/TwoColumnLeft');
  const open = cat.lookup(PDFName.of('OpenAction'), PDFArray);
  expect(lib.getPages().findIndex((p) => p.ref === open.get(0))).toBe(2);
  expect(String(open.get(1))).toBe('/FitH');
  const prefs = cat.lookup(PDFName.of('ViewerPreferences'), PDFDict);
  expect(String(prefs.get(PDFName.of('DisplayDocTitle')))).toBe('true');

  // Reopening honours the initial view: bookmarks panel, page 3, two-up continuous, title bar.
  await openBytes(page, 'initial-view.pdf', bytes);
  await expect(page.getByTestId('navigation-bookmarks-panel')).toBeVisible();
  await expect.poll(async () => (await getDoc(page)).view.currentPage).toBe(2);
  await expect.poll(async () => (await getDoc(page)).view.layout).toMatch(/two/i);
  await expect(page).toHaveTitle(/Edited title/);

  // The dialog reads the settings back.
  await focusViewer(page);
  await page.keyboard.press('ControlOrMeta+Alt+p');
  await page.getByTestId('navigation-props-tab-initial').click();
  await expect(page.getByTestId('navigation-props-pagemode')).toHaveValue('UseOutlines');
  await expect(page.getByTestId('navigation-props-openpage').locator('input')).toHaveValue('3');
  await page.getByTestId('navigation-props-tab-custom').click();
  await expect(page.getByTestId('navigation-props-custom-row')).toHaveCount(2);
  await page.getByTestId('navigation-props-cancel').click();
});

test('initial view: the panel a file asks for is in place before the first paint (no re-zoom)', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __navFirstPaintZoom?: number; __app?: { getActiveDoc(): { view: { zoom: number } } | null } };
    new MutationObserver(() => {
      if (w.__navFirstPaintZoom !== undefined) return;
      const el = document.querySelector('[data-testid=document-viewer] [data-testid=page][data-page-index="0"].is-painted');
      if (el) w.__navFirstPaintZoom = w.__app?.getActiveDoc()?.view.zoom;
    }).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
  });
  // sample.pdf has /PageMode /UseOutlines and opens fitted to width.
  await openFixture(page, 'sample.pdf');
  await expect(page.getByTestId('navigation-bookmarks-panel')).toBeVisible();
  await page.waitForTimeout(300);
  const first = await page.evaluate(() => (window as unknown as { __navFirstPaintZoom?: number }).__navFirstPaintZoom);
  const d = await getDoc(page);
  expect(d.view.fit).toBe('width');
  expect(first).toBeCloseTo(d.view.zoom, 3);
});

test('document properties: File menu entry and an encrypted document', async ({ page }) => {
  await openFixture(page, 'encrypted.pdf', { password: 'secret' });
  await page.getByTestId('app-menu').click();
  await page.locator('[data-menu-id="navigation.docProperties"]').click();
  await expect(page.getByTestId('navigation-props-title')).toHaveValue('Confidential Budget Summary');
  await page.getByTestId('navigation-props-tab-security').click();
  await expect(page.getByTestId('navigation-props-security-method')).toHaveText('Password Security');
  await expect(page.getByTestId('navigation-props-open-password')).toHaveText('Yes');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('navigation-props-dialog')).toHaveCount(0);
});

test('advanced search: changing an option refreshes the results on screen', async ({ page }) => {
  await openFixture(page, 'sample.pdf');
  await focusViewer(page);
  await page.keyboard.press('ControlOrMeta+Shift+f');
  // "workflow": 11 matches ignoring case, 3 lowercase ones.
  await page.getByTestId('navigation-search-input').fill('workflow');
  await page.getByTestId('navigation-search-input').press('Enter');
  await expect(page.getByTestId('navigation-search-summary')).toHaveText(/(^|\D)11 instances/);
  // The whole option row is clickable, and toggling re-runs the search without pressing Search.
  await page.getByTestId('navigation-search-opt-case').click();
  await expect(page.getByTestId('navigation-search-summary')).toHaveText(/(^|\D)3 instances/);
  await page.getByTestId('navigation-search-opt-case').click();
  await expect(page.getByTestId('navigation-search-summary')).toHaveText(/(^|\D)11 instances/);
});

test('document properties: non-ASCII custom property names are written as UTF-8 names', async ({ page }) => {
  await openFixture(page, 'sample.pdf');
  await focusViewer(page);
  await page.keyboard.press('ControlOrMeta+Alt+p');
  await page.getByTestId('navigation-props-tab-custom').click();
  await page.getByTestId('navigation-props-custom-name').fill('Ünïcode名');
  await page.getByTestId('navigation-props-custom-value').fill('Wert ✓');
  await page.getByTestId('navigation-props-custom-add').click();
  await page.getByTestId('navigation-props-custom-name').fill('Bad/Name');
  await expect(page.getByTestId('navigation-props-custom-add')).toBeDisabled();
  await page.getByTestId('navigation-props-ok').click();
  await expect(page.getByTestId('navigation-props-dialog')).toHaveCount(0);

  const bytes = await download(page);
  const lib = await loadLib(bytes);
  const info = lib.context.lookup(lib.context.trailerInfo.Info, PDFDict);
  const standard = new Set(['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer', 'CreationDate', 'ModDate', 'Trapped']);
  const key = info.keys().find((k) => !standard.has(k.asString().slice(1)));
  expect(key?.asString()).toBe('/' + [...Buffer.from('Ünïcode名', 'utf8')].map((b) => (b < 0x80 ? String.fromCharCode(b) : `#${b.toString(16).toUpperCase()}`)).join(''));
  expect(decodeText(info.lookup(key!))).toBe('Wert ✓');

  await openBytes(page, 'custom-names.pdf', bytes);
  await focusViewer(page);
  await page.keyboard.press('ControlOrMeta+Alt+p');
  await page.getByTestId('navigation-props-tab-custom').click();
  await expect(page.locator('[data-testid=navigation-props-custom-row][data-name="Ünïcode名"]')).toContainText('Wert ✓');
  await page.getByTestId('navigation-props-cancel').click();
});

// ── Read Out Loud ──────────────────────────────────────────────────────────────

test('read out loud: activate, read page with sentence highlight, pause/resume, stop, deactivate', async ({ page }) => {
  await page.addInitScript(installSpeechStub);
  await openFixture(page, 'sample.pdf');
  await viewMenuItem(page, 'navigation.readAloud.activate');
  const control = page.getByTestId('navigation-readaloud-control');
  await expect(control).toBeVisible();
  await expect(page.getByTestId('navigation-readaloud-page')).toBeFocused();

  await page.getByTestId('navigation-readaloud-page').click();
  await expect(control).toHaveAttribute('data-status', 'speaking');
  await expect(viewer(page).locator('.navigation-readaloud-hit').first()).toBeVisible();
  // Headings end a sentence even without a period (the title page isn't read as one run-on sentence).
  await expect.poll(() => page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken[0] ?? '')).toBe('PDF Wizard');

  await page.getByTestId('navigation-readaloud-pause').click();
  await expect(control).toHaveAttribute('data-status', 'paused');
  await page.getByTestId('navigation-readaloud-pause').click();
  await expect(control).toHaveAttribute('data-status', 'speaking');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __spoken: string[] }).__spoken.length)).toBeGreaterThan(1);

  await page.getByTestId('navigation-readaloud-stop').click();
  await expect(control).toHaveAttribute('data-status', 'idle');
  await expect(viewer(page).locator('.navigation-readaloud-hit')).toHaveCount(0);

  // Reading a page to its end returns to idle on its own ("Read this page only").
  await focusViewer(page);
  await page.keyboard.press('ControlOrMeta+Shift+v');
  await expect(control).toHaveAttribute('data-status', 'speaking');
  await expect(control).toHaveAttribute('data-status', 'idle', { timeout: 30_000 });

  // Shortcut toggles Read Out Loud off.
  await focusViewer(page);
  await page.keyboard.press('ControlOrMeta+Shift+y');
  await expect(control).toHaveCount(0);
});

test('read out loud degrades gracefully without speech synthesis', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'speechSynthesis', { value: undefined, configurable: true });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: undefined, configurable: true });
  });
  await openFixture(page, 'sample.pdf');
  await focusViewer(page);
  await page.keyboard.press('ControlOrMeta+Shift+y');
  await expect(page.getByTestId('toast').filter({ hasText: /Read Out Loud isn’t available/ })).toBeVisible();
  await expect(page.getByTestId('navigation-readaloud-control')).toHaveCount(0);
});

// ── Layers ─────────────────────────────────────────────────────────────────────

test('layers: panel only for documents with optional content; toggles re-render the page', async ({ page }) => {
  await openFixture(page, 'sample.pdf');
  await expect(page.getByTestId('panel-btn-bookmarks')).toBeVisible();
  await expect(page.getByTestId('panel-btn-layers')).toHaveCount(0);

  const file = path.join(os.tmpdir(), `navigation-layers-${process.pid}.pdf`);
  fs.writeFileSync(file, await layeredPdf());
  await page.getByTestId('open-file-input').setInputFiles(file);
  await waitForDocReady(page, path.basename(file));
  await waitForPagesRendered(page);
  await page.getByTestId('panel-btn-layers').click();
  const rows = page.getByTestId('navigation-layer');
  await expect(rows).toHaveCount(4);
  expect(await rows.evaluateAll((els) => els.map((e) => `${e.getAttribute('data-layer')}:${e.getAttribute('data-visible')}:${e.getAttribute('aria-level')}`))).toEqual([
    'Red box:true:1',
    'Blue box:true:1',
    'Extras:false:1',
    'Draft watermark:false:2',
  ]);
  expect(await pagePixel(page, 0.28, 0.37)).toEqual([255, 0, 0]);

  // Hide the red box: the page re-renders without it.
  await page.locator('[data-testid=navigation-layer][data-layer="Red box"] [data-testid=navigation-layer-toggle]').click();
  await expect(page.locator('[data-testid=navigation-layer][data-layer="Red box"]')).toHaveAttribute('data-visible', 'false');
  await expect.poll(() => pagePixel(page, 0.28, 0.37), { timeout: 15_000 }).toEqual([255, 255, 255]);
  expect(await pagePixel(page, 0.68, 0.37)).toEqual([0, 0, 255]);

  // Keyboard: End → Draft watermark, Space shows it.
  await rows.first().focus();
  await page.keyboard.press('End');
  await expect(page.locator('[data-testid=navigation-layer][data-layer="Draft watermark"]')).toBeFocused();
  await page.keyboard.press('Space');
  await expect(page.locator('[data-testid=navigation-layer][data-layer="Draft watermark"]')).toHaveAttribute('data-visible', 'true');
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowLeft');
  await expect(rows).toHaveCount(3);
  await page.keyboard.press('ArrowRight');
  await expect(rows).toHaveCount(4);

  // Reset restores the document's initial visibility.
  await page.getByTestId('navigation-layers-reset').click();
  await expect(page.locator('[data-testid=navigation-layer][data-layer="Red box"]')).toHaveAttribute('data-visible', 'true');
  await expect(page.locator('[data-testid=navigation-layer][data-layer="Draft watermark"]')).toHaveAttribute('data-visible', 'false');
  await expect.poll(() => pagePixel(page, 0.28, 0.37), { timeout: 15_000 }).toEqual([255, 0, 0]);
  fs.rmSync(file, { force: true });
});
