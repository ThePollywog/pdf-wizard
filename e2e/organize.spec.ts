/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * Organize: the "Organize pages" grid (selection, keyboard, marquee, select menu, rotate, delete,
 * insert, drag & drop, Alt+arrows, extract, replace, page labels, undo), "Combine files", "Split a PDF",
 * "Extract PDF pages", the lightweight page tasks and the Thumbnails panel context menu. Results are
 * checked in the store and in the exported bytes (pdf.js / pdf-lib).
 */
import fs from 'node:fs';
import type { Page } from '@playwright/test';
import JSZip from 'jszip';
import { PDFName } from '@cantoo/pdf-lib';
import {
  FIXTURES_DIR, listLibrary, uploadToLibrary as addToLibrary, captureDownload, expect, getAppState, getDoc, inspectPdf, loadLib, openFixture, openPdfjs, pageOrder, test, waitForDocReady,
} from './helpers';

// ── helpers ───────────────────────────────────────────────────────────────────

const grid = (page: Page) => page.getByTestId('organize-grid');
const cell = (page: Page, i: number) => grid(page).locator(`[data-testid=organize-page][data-page-index="${i}"]`);
const menuItem = (page: Page, id: string) => page.locator(`[data-menu-id="${id}"]`);
const thumb = (page: Page, i: number) => page.getByTestId('thumbnails-panel').locator(`[data-testid=thumbnail][data-page-index="${i}"]`);
const selectedIndices = (page: Page) =>
  grid(page)
    .locator('[data-testid=organize-page][aria-selected=true]')
    .evaluateAll((els) => els.map((e) => Number((e as HTMLElement).dataset.pageIndex)).sort((a, b) => a - b));

/** Which original sample.pdf page (0-based) a page text belongs to: pages 2-6 carry the footer "Page N of 6". */
const sampleIndexOf = (text: string) => {
  const m = /Page (\d) of 6/.exec(text);
  return m ? Number(m[1]) - 1 : 0;
};

/** Load the app (optionally restricted with E2E_FEATURES=organize,thumbnails,… while other features are in flux). */
async function gotoApp(page: Page) {
  const f = process.env.E2E_FEATURES;
  await page.goto(f ? `/?features=${f}` : '/');
  await expect(page.getByTestId('library')).toBeVisible();
}

async function open(page: Page, name: string) {
  if (!/^https?:/.test(page.url())) await gotoApp(page);
  return openFixture(page, name);
}

/** Waits until the active document's pdf.js proxy matches its bytes. */
const settle = (page: Page) => waitForDocReady(page);

async function openOrganize(page: Page) {
  await page.getByTestId('nav-tools').click();
  await page.locator('[data-testid=task-tile][data-task-id=organize-pages]').first().click();
  await expect(page.getByTestId('organize-view')).toBeVisible();
  await expect(cell(page, 0).locator('img')).toBeVisible();
}

async function exportActive(page: Page): Promise<Uint8Array> {
  await settle(page);
  const arr = await page.evaluate(async () => Array.from(await window.__engine.exportPdf(window.__app.getActiveDoc().id, {}) as Uint8Array));
  return new Uint8Array(arr);
}

/** Internal links as "fromOriginalPage->toOriginalPage" (sample.pdf pages identified by their text). */
async function sampleLinks(bytes: Uint8Array): Promise<string[]> {
  const { doc, close } = await openPdfjs(bytes);
  const orig: number[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    orig.push(sampleIndexOf(tc.items.map((t) => ('str' in t ? t.str : '')).join(' ')));
  }
  const out: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    for (const a of await (await doc.getPage(i)).getAnnotations()) {
      if (a.subtype !== 'Link') continue;
      if (a.url) {
        out.push(`${orig[i - 1]}->url`);
        continue;
      }
      let dest = a.dest;
      if (typeof dest === 'string') dest = await doc.getDestination(dest);
      if (Array.isArray(dest)) out.push(`${orig[i - 1]}->${orig[await doc.getPageIndex(dest[0])]}`);
    }
  }
  await close();
  return out.sort();
}

interface OutlineNode {
  title: string;
  page: number | null;
  items: OutlineNode[];
}

async function outlineTree(bytes: Uint8Array): Promise<OutlineNode[]> {
  const { doc, close } = await openPdfjs(bytes);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walk = async (items: any[]): Promise<OutlineNode[]> => {
    const out: OutlineNode[] = [];
    for (const o of items) {
      let dest = o.dest;
      if (typeof dest === 'string') dest = await doc.getDestination(dest);
      const page = Array.isArray(dest) ? await doc.getPageIndex(dest[0]) : null;
      out.push({ title: o.title, page, items: await walk(o.items ?? []) });
    }
    return out;
  };
  const tree = await walk((await doc.getOutline()) ?? []);
  await close();
  return tree;
}

async function pageLabelsOf(bytes: Uint8Array): Promise<string[] | null> {
  const { doc, close } = await openPdfjs(bytes);
  const labels = await doc.getPageLabels();
  await close();
  return labels;
}

const fixtureBytes = (name: string) => new Uint8Array(fs.readFileSync(FIXTURES_DIR + name));

// ── Organize pages: grid ──────────────────────────────────────────────────────

test('Organize pages opens from All tools with a thumbnail per page, labels, rotations and a zoom slider', async ({ page }) => {
  await open(page, 'rotated.pdf');
  await openOrganize(page);
  const d = await getDoc(page);
  await expect(grid(page).getByTestId('organize-page')).toHaveCount(7);
  const rotations = await grid(page).getByTestId('organize-page').evaluateAll((els) => els.map((e) => Number((e as HTMLElement).dataset.rotation)));
  expect(rotations).toEqual(d.rotations);
  expect(rotations).toEqual([0, 90, 180, 270, 0, 0, 90]);
  await expect(grid(page).getByTestId('organize-page-label')).toHaveText(['1', '2', '3', '4', '5', '6', '7']);
  await expect(page.getByTestId('organize-status')).toContainText('7 pages');

  // Thumbnail size: zoom in -> bigger thumbnails and fewer columns, zoom out -> smaller.
  const cols = async () => Number(await grid(page).getAttribute('data-cols'));
  const width = async () => (await cell(page, 0).boundingBox())!.width;
  const [c0, w0] = [await cols(), await width()];
  await page.getByTestId('organize-zoom-in').click();
  await page.getByTestId('organize-zoom-in').click();
  await expect.poll(width).toBeGreaterThan(w0);
  await expect.poll(cols).toBeLessThan(c0);
  await page.getByTestId('organize-zoom-out').click();
  await page.getByTestId('organize-zoom-out').click();
  await page.getByTestId('organize-zoom-out').click();
  await expect.poll(width).toBeLessThan(w0);
  expect(await cols()).toBeGreaterThanOrEqual(c0);

  // Dark theme keeps the grid readable (the view follows the theme tokens).
  await page.evaluate(() => window.__app.actions.setPrefs({ theme: 'dark' }));
  await expect.poll(() => getAppState(page).then((s) => s.theme)).toBe('dark');
  const bg = await page.getByTestId('organize-view').evaluate((el) => getComputedStyle(el.querySelector('.organize-grid')!).backgroundColor);
  expect(bg).not.toBe('rgb(255, 255, 255)');
  await page.evaluate(() => window.__app.actions.setPrefs({ theme: 'light' }));

  // Double-click opens the page in the viewer.
  await cell(page, 3).dblclick();
  await expect(page.getByTestId('organize-view')).toHaveCount(0);
  await expect(page.getByTestId('document-viewer')).toBeVisible();
  await expect.poll(() => getDoc(page).then((x) => x.view.currentPage)).toBe(3);
});

test('selection: click, Shift range, Cmd/Ctrl toggle, marquee, select all, Esc, arrow keys and the Select menu', async ({ page }) => {
  await open(page, 'sample.pdf');
  await openOrganize(page);

  await cell(page, 1).click();
  await cell(page, 3).click({ modifiers: ['Shift'] });
  expect(await selectedIndices(page)).toEqual([1, 2, 3]);
  await cell(page, 5).click({ modifiers: ['ControlOrMeta'] });
  expect(await selectedIndices(page)).toEqual([1, 2, 3, 5]);
  await cell(page, 2).click({ modifiers: ['ControlOrMeta'] });
  expect(await selectedIndices(page)).toEqual([1, 3, 5]);
  await expect(page.getByTestId('organize-status-count')).toContainText('3 of 6');

  await page.keyboard.press('Escape');
  expect(await selectedIndices(page)).toEqual([]);

  // Marquee drag from the empty grid margin over the first row.
  const g = (await grid(page).boundingBox())!;
  const c2 = (await cell(page, 2).boundingBox())!;
  await page.mouse.move(g.x + 8, g.y + 6);
  await page.mouse.down();
  await page.mouse.move(c2.x + c2.width / 2, c2.y + c2.height / 2, { steps: 8 });
  await page.mouse.up();
  expect(await selectedIndices(page)).toEqual([0, 1, 2]);

  // Keyboard: select all, clear, move the focus ring, Shift+Arrow extends.
  await grid(page).focus();
  await page.keyboard.press('ControlOrMeta+a');
  expect(await selectedIndices(page)).toEqual([0, 1, 2, 3, 4, 5]);
  await expect(page.getByTestId('organize-status-count')).toContainText('6 of 6');
  await page.keyboard.press('Escape');
  await cell(page, 0).click();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(grid(page).locator('.organize-cell.is-focused')).toHaveAttribute('data-page-index', '2');
  expect(await selectedIndices(page)).toEqual([2]); // the selection follows the focus
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('Shift+ArrowLeft');
  expect(await selectedIndices(page)).toEqual([0, 1, 2]);
  await page.keyboard.press('ControlOrMeta+ArrowRight'); // moves the focus ring only
  await expect(grid(page).locator('.organize-cell.is-focused')).toHaveAttribute('data-page-index', '1');
  expect(await selectedIndices(page)).toEqual([0, 1, 2]);

  // Select menu.
  const pick = async (id: string) => {
    await page.getByTestId('organize-select-menu').click();
    await menuItem(page, id).click();
  };
  await pick('organize-select-even');
  await expect.poll(() => selectedIndices(page)).toEqual([1, 3, 5]);
  await pick('organize-select-invert');
  await expect.poll(() => selectedIndices(page)).toEqual([0, 2, 4]);
  await pick('organize-select-landscape');
  await expect.poll(() => selectedIndices(page)).toEqual([0, 2, 4]); // none: selection kept, info toast
  await expect(page.getByTestId('toast').filter({ hasText: 'No landscape pages' })).toBeVisible();
  await pick('organize-select-range');
  await page.getByTestId('prompt-input').fill('2-4, 6');
  await page.getByTestId('dialog-confirm').click();
  await expect.poll(() => selectedIndices(page)).toEqual([1, 2, 3, 5]);
  await pick('organize-select-none');
  await expect.poll(() => selectedIndices(page)).toEqual([]);
});

test('rotate, delete with confirmation, undo/redo, and deleting every page is refused', async ({ page }) => {
  await open(page, 'sample.pdf');
  await openOrganize(page);
  const ids = (await getDoc(page)).pageIds;

  await cell(page, 1).click();
  await cell(page, 3).click({ modifiers: ['ControlOrMeta'] });
  await page.getByTestId('organize-rotate-cw').click();
  await expect.poll(() => getDoc(page).then((d) => d.rotations)).toEqual([0, 90, 0, 90, 0, 0]);
  await expect(cell(page, 1)).toHaveAttribute('data-rotation', '90');

  // Hover action on an unselected page acts on that page only.
  await cell(page, 5).hover();
  await cell(page, 5).getByTestId('organize-page-rotate-ccw').click();
  await expect.poll(() => getDoc(page).then((d) => d.rotations)).toEqual([0, 90, 0, 90, 0, 270]);

  let info = await inspectPdf(await exportActive(page));
  expect(info.pages.map((p) => p.rotation)).toEqual([0, 90, 0, 90, 0, 270]);

  // Delete two pages: confirmation first.
  await cell(page, 4).click();
  await cell(page, 5).click({ modifiers: ['Shift'] });
  await page.getByTestId('organize-delete').click();
  const modal = page.getByTestId('modal');
  await expect(modal).toContainText('Delete 2 pages?');
  await page.getByTestId('dialog-cancel').click();
  expect((await getDoc(page)).pageCount).toBe(6);
  await page.getByTestId('organize-delete').click();
  await page.getByTestId('dialog-confirm').click();
  await expect.poll(() => getDoc(page).then((d) => d.pageCount)).toBe(4);
  await expect(page.getByTestId('toast').filter({ hasText: '2 pages deleted' })).toBeVisible();
  expect(await pageOrder(page, ids)).toEqual([0, 1, 2, 3]);

  // Undo / redo with the shortcuts while the grid has focus, then the header button.
  await grid(page).focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => getDoc(page).then((d) => d.pageCount)).toBe(6);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(() => getDoc(page).then((d) => d.pageCount)).toBe(4);
  await page.getByTestId('undo').click();
  await expect.poll(() => getDoc(page).then((d) => d.pageCount)).toBe(6);

  // Delete key on one page, confirmed with Enter.
  await cell(page, 0).click();
  await page.keyboard.press('Delete');
  await expect(modal).toContainText('Delete page?');
  await page.getByTestId('dialog-confirm').click();
  await expect.poll(() => getDoc(page).then((d) => d.pageCount)).toBe(5);
  expect(await pageOrder(page, ids)).toEqual([1, 2, 3, 4, 5]);

  // All pages: the toolbar button is disabled and the Delete key only explains why.
  await grid(page).focus();
  await page.keyboard.press('ControlOrMeta+a');
  await expect(page.getByTestId('organize-delete')).toBeDisabled();
  await page.keyboard.press('Delete');
  await expect(page.getByTestId('toast').filter({ hasText: "all pages can't be deleted" })).toBeVisible();
  await expect(modal).toHaveCount(0);
  expect((await getDoc(page)).pageCount).toBe(5);

  info = await inspectPdf(await exportActive(page));
  expect(info.numPages).toBe(5);
  expect(info.pages.map((p) => sampleIndexOf(p.text))).toEqual([1, 2, 3, 4, 5]);
});

test('reorder by drag and drop (one and several pages) and Alt+Arrow keeps links and bookmarks', async ({ page }) => {
  await open(page, 'sample.pdf');
  await openOrganize(page);
  const ids = (await getDoc(page)).pageIds;
  const originalLinks = await sampleLinks(fixtureBytes('sample.pdf'));
  const originalOutline = await outlineTree(fixtureBytes('sample.pdf'));
  expect(originalLinks.filter((l) => l.startsWith('1->')).length).toBe(10);

  // Page 1 dropped on the right half of page 3 -> after page 3.
  const b2 = (await cell(page, 2).boundingBox())!;
  await cell(page, 0).dragTo(cell(page, 2), { targetPosition: { x: b2.width - 8, y: b2.height / 2 } });
  await expect.poll(() => pageOrder(page, ids)).toEqual([1, 2, 0, 3, 4, 5]);

  // Pages 5-6 dragged together to the left half of the first page, with an insertion indicator.
  await cell(page, 4).click();
  await cell(page, 5).click({ modifiers: ['Shift'] });
  const b0 = (await cell(page, 0).boundingBox())!;
  const b5 = (await cell(page, 5).boundingBox())!;
  await page.mouse.move(b5.x + b5.width / 2, b5.y + b5.height / 3);
  await page.mouse.down();
  await page.mouse.move(b0.x + 12, b0.y + b0.height / 2, { steps: 10 });
  await expect(page.getByTestId('organize-drop-indicator')).toHaveAttribute('data-gap', '0');
  await page.mouse.up();
  await expect.poll(() => pageOrder(page, ids)).toEqual([4, 5, 1, 2, 0, 3]);
  expect(await selectedIndices(page)).toEqual([0, 1]);

  // Alt+Right moves the selected pages one place later.
  await grid(page).focus();
  await page.keyboard.press('Alt+ArrowRight');
  await expect.poll(() => pageOrder(page, ids)).toEqual([1, 4, 5, 2, 0, 3]);

  // Links still point at the same pages, and bookmarks too.
  const bytes = await exportActive(page);
  expect(await sampleLinks(bytes)).toEqual(originalLinks);
  const order = await pageOrder(page, ids);
  const remap = (nodes: OutlineNode[]): OutlineNode[] => nodes.map((n) => ({ ...n, page: n.page === null ? null : order[n.page], items: remap(n.items) }));
  expect(remap(await outlineTree(bytes))).toEqual(originalOutline);
});

test('insert: blank page dialog, the "+" gap menu, pages from a PDF and a file dropped on the grid', async ({ page }) => {
  await open(page, 'sample.pdf');
  await openOrganize(page);
  const ids = (await getDoc(page)).pageIds;

  // Insert > Blank page… after page 2.
  await cell(page, 1).click();
  await page.getByTestId('organize-insert-menu').click();
  await menuItem(page, 'organize-insert-blank').click();
  await expect(page.getByTestId('organize-blank-dialog')).toBeVisible();
  await page.getByTestId('organize-blank-ok').click();
  await expect.poll(() => getDoc(page).then((d) => d.pageCount)).toBe(7);
  let order = await pageOrder(page, ids);
  expect(order).toEqual([0, 1, -1, 2, 3, 4, 5]);
  expect(await selectedIndices(page)).toEqual([2]);

  // "+" between pages 1 and 2 > Blank page.
  await cell(page, 0).hover();
  await grid(page).locator('[data-testid=organize-gap-add][data-gap="1"]').click({ force: true });
  await menuItem(page, 'organize-gap-blank').click();
  await expect.poll(() => getDoc(page).then((d) => d.pageCount)).toBe(8);
  order = await pageOrder(page, ids);
  expect(order).toEqual([0, -1, 1, -1, 2, 3, 4, 5]);

  // Insert > From file… (a PDF asks which pages and where).
  await page.getByTestId('organize-insert-menu').click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), menuItem(page, 'organize-insert-file').click()]);
  await chooser.setFiles(FIXTURES_DIR + 'rotated.pdf');
  await expect(page.getByTestId('organize-insert-dialog')).toBeVisible();
  await page.getByTestId('organize-insert-where').selectOption('last');
  await page.getByTestId('organize-insert-ok').click();
  await expect.poll(() => getDoc(page).then((d) => d.pageCount)).toBe(15);
  expect((await getDoc(page)).rotations.slice(8)).toEqual([0, 90, 180, 270, 0, 0, 90]);

  // An image dropped between pages 1 and 2 is converted and inserted there.
  const png = fs.readFileSync(FIXTURES_DIR + 'sample.png').toString('base64');
  const dt = await page.evaluateHandle((b64) => {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const t = new DataTransfer();
    t.items.add(new File([arr], 'sample.png', { type: 'image/png' }));
    return t;
  }, png);
  const c1 = (await cell(page, 1).boundingBox())!;
  const at = { clientX: c1.x + 6, clientY: c1.y + c1.height / 2 };
  await grid(page).dispatchEvent('dragenter', { dataTransfer: dt, ...at });
  await grid(page).dispatchEvent('dragover', { dataTransfer: dt, ...at });
  await expect(page.getByTestId('organize-drop-indicator')).toHaveAttribute('data-gap', '1');
  await grid(page).dispatchEvent('drop', { dataTransfer: dt, ...at });
  await expect.poll(() => getDoc(page).then((d) => d.pageCount)).toBe(16);
  order = await pageOrder(page, ids);
  expect(order.slice(0, 4)).toEqual([0, -1, -1, 1]);

  const info = await inspectPdf(await exportActive(page));
  expect(info.numPages).toBe(16);
  expect(info.pages[1].text).toBe(''); // the image page has no text
  expect(info.pages[2].text).toBe(''); // the blank page
  expect(info.pages.slice(8).map((p) => p.rotation)).toEqual([0, 0, 90, 180, 270, 0, 0, 90]);
});

test('extract dialog: download selected pages, separate files as a ZIP, and delete after extracting', async ({ page }) => {
  await open(page, 'sample.pdf');
  await openOrganize(page);
  const ids = (await getDoc(page)).pageIds;

  await cell(page, 1).click();
  await cell(page, 2).click({ modifiers: ['Shift'] });
  await page.getByTestId('organize-extract').click();
  const dialog = page.getByTestId('organize-extract-dialog');
  await expect(dialog.getByTestId('organize-extract-range')).toHaveValue('2-3');
  await dialog.getByTestId('organize-extract-output').getByText('Download the PDF').click();
  let { download, bytes } = await captureDownload(page, () => page.getByTestId('organize-extract-ok').click());
  expect(download.suggestedFilename()).toMatch(/\.pdf$/);
  let info = await inspectPdf(bytes);
  expect(info.pages.map((p) => sampleIndexOf(p.text))).toEqual([1, 2]);
  // Links between extracted pages survive; the rest are dropped.
  expect((await sampleLinks(bytes)).every((l) => /->(1|2|url)$/.test(l))).toBe(true);
  expect((await getDoc(page)).pageCount).toBe(6);

  // Separate files -> one-page PDFs in a ZIP.
  await page.getByTestId('organize-extract').click();
  await dialog.getByTestId('organize-extract-range').fill('1, 4-5');
  await dialog.getByTestId('organize-extract-separate').locator('label').click();
  await expect(dialog.getByTestId('organize-extract-output')).toContainText('Download as a ZIP archive');
  ({ download, bytes } = await captureDownload(page, () => page.getByTestId('organize-extract-ok').click()));
  expect(download.suggestedFilename()).toMatch(/\.zip$/);
  const zip = await JSZip.loadAsync(bytes);
  const names = Object.keys(zip.files).sort();
  expect(names).toHaveLength(3);
  for (const [k, n] of names.entries()) {
    info = await inspectPdf(await zip.files[n].async('uint8array'));
    expect(info.numPages).toBe(1);
    expect(sampleIndexOf(info.pages[0].text)).toBe([0, 3, 4][k]);
  }

  // Delete after extracting, opened in a new tab.
  await page.getByTestId('organize-extract').click();
  await dialog.getByTestId('organize-extract-range').fill('5-6');
  await dialog.getByTestId('organize-extract-separate').locator('label').click();
  await dialog.getByTestId('organize-extract-delete').locator('label').click();
  await dialog.getByTestId('organize-extract-output').getByText('Open in a new tab').click();
  await page.getByTestId('organize-extract-ok').click();
  await expect.poll(() => getAppState(page).then((s) => s.tabs.length)).toBe(2);
  await settle(page);
  const extracted = await getDoc(page);
  expect(extracted.pageCount).toBe(2);
  const sourceId = (await getAppState(page)).tabs.find((id) => id !== extracted.id)!;
  const source: string[] = await page.evaluate((id) => window.__app.useApp.getState().docs[id].pages.map((p: { id: string }) => p.id), sourceId);
  expect(source.map((id) => ids.indexOf(id))).toEqual([0, 1, 2, 3]);
  info = await inspectPdf(await exportActive(page));
  expect(info.pages.map((p) => sampleIndexOf(p.text))).toEqual([4, 5]);
});

test('replace pages with pages of another file', async ({ page }) => {
  await open(page, 'sample.pdf');
  await openOrganize(page);
  const ids = (await getDoc(page)).pageIds;
  const rotated = await inspectPdf(fixtureBytes('rotated.pdf'));

  await cell(page, 2).click();
  await cell(page, 3).click({ modifiers: ['Shift'] });
  await page.getByTestId('organize-replace').click();
  const dialog = page.getByTestId('organize-replace-dialog');
  await expect(dialog.getByTestId('organize-replace-range')).toHaveValue('3-4');
  await expect(page.getByTestId('organize-replace-ok')).toBeDisabled();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), dialog.getByTestId('organize-replace-file').click()]);
  await chooser.setFiles(FIXTURES_DIR + 'rotated.pdf');
  await expect(dialog.getByTestId('organize-replace-source')).toContainText('rotated.pdf');
  await expect(dialog.getByTestId('organize-replace-map')).toBeVisible();
  const startField = dialog.getByTestId('organize-replace-start').getByLabel('First replacement page');
  await startField.fill('2');
  await startField.press('Tab');
  await expect(dialog.getByTestId('organize-replace-start')).toContainText('Pages 2–3 of the file replace pages 3-4');
  await page.getByTestId('organize-replace-ok').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Replaced 2 pages' })).toBeVisible();
  await settle(page);

  const d = await getDoc(page);
  expect(d.pageCount).toBe(6);
  expect(d.pageIds).toEqual(ids); // replaced pages keep their place and id
  const info = await inspectPdf(await exportActive(page));
  expect(info.pages[2].text).toBe(rotated.pages[1].text);
  expect(info.pages[3].text).toBe(rotated.pages[2].text);
  expect(info.pages[2].rotation).toBe(90);
  expect(info.pages[3].rotation).toBe(180);
  expect(sampleIndexOf(info.pages[4].text)).toBe(4);
});

test('page labels from the Thumbnails context menu round-trip through /PageLabels', async ({ page }) => {
  await open(page, 'sample.pdf');
  if (!(await page.getByTestId('thumbnails-panel').isVisible())) await page.getByTestId('panel-btn-thumbnails').click();
  await expect(thumb(page, 0).locator('img')).toBeVisible();

  // Context menu entries for a multi-selection.
  await thumb(page, 0).click();
  await thumb(page, 1).click({ modifiers: ['Shift'] });
  await thumb(page, 1).click({ button: 'right' });
  await expect(menuItem(page, 'organize-thumb-replace')).toContainText('Replace 2 pages');
  await expect(menuItem(page, 'organize-thumb-extract')).toBeVisible();
  await expect(menuItem(page, 'organize-thumb-organize')).toBeVisible();
  await menuItem(page, 'organize-thumb-labels').click();

  const dialog = page.getByTestId('organize-labels-dialog');
  await expect(dialog).toBeVisible();
  await page.getByTestId('organize-labels-style').selectOption('r');
  await expect(page.getByTestId('organize-labels-sample')).toContainText('i');
  await page.getByTestId('organize-labels-ok').click();
  await expect.poll(() => getDoc(page).then((d) => d.labels.slice(0, 2))).toEqual(['i', 'ii']);

  await thumb(page, 2).click();
  await thumb(page, 5).click({ modifiers: ['Shift'] });
  await thumb(page, 3).click({ button: 'right' });
  await menuItem(page, 'organize-thumb-labels').click();
  await expect(dialog).toBeVisible();
  await page.getByTestId('organize-labels-prefix').fill('S-');
  await page.getByTestId('organize-labels-ok').click();
  await expect.poll(() => getDoc(page).then((d) => d.labels)).toEqual(['i', 'ii', 'S-1', 'S-2', 'S-3', 'S-4']);

  const bytes = await exportActive(page);
  expect(await pageLabelsOf(bytes)).toEqual(['i', 'ii', 'S-1', 'S-2', 'S-3', 'S-4']);
  // And the labels come back when the saved file is opened again.
  const lib = await loadLib(bytes);
  expect(lib.catalog.get(PDFName.of('PageLabels'))).toBeTruthy();

  // "Organize pages" in the context menu opens the grid with the pages selected and shows the labels.
  await thumb(page, 3).click({ button: 'right' });
  await menuItem(page, 'organize-thumb-organize').click();
  await expect(page.getByTestId('organize-view')).toBeVisible();
  await expect(cell(page, 2).getByTestId('organize-page-label')).toHaveText('S-1');
  await expect.poll(() => selectedIndices(page)).toEqual([2, 3, 4, 5]);
});

test('reverse, duplicate and cut/paste; the lightweight tasks open the grid with their action highlighted', async ({ page }) => {
  await open(page, 'sample.pdf');
  const ids = (await getDoc(page)).pageIds;

  const tasks: [string, string][] = [
    ['rotate-pages', 'organize-rotate-cw'],
    ['delete-pages', 'organize-delete'],
    ['insert-pages', 'organize-insert-menu'],
    ['page-labels', 'organize-labels'],
    ['reorder-pages', 'organize-reverse'],
    ['reverse-pages', 'organize-reverse'],
  ];
  for (const [task, testid] of tasks) {
    await page.evaluate((t) => window.__app.actions.openTask(t), task);
    await expect(page.getByTestId('organize-view')).toBeVisible();
    await expect(page.locator('.organize-toolbar-group.is-focus-action').getByTestId(testid)).toBeVisible();
  }
  const registered = await page.evaluate(() =>
    ['organize-pages', 'combine-files', 'split-pdf', 'extract-pages', 'insert-pages', 'rotate-pages', 'delete-pages', 'reorder-pages', 'reverse-pages', 'page-labels'].map(
      (id) => window.__app.reg.task(id)?.category,
    ),
  );
  expect(registered.every((c) => c === 'organize')).toBe(true);

  await page.getByTestId('organize-reverse').click();
  await expect.poll(() => pageOrder(page, ids)).toEqual([5, 4, 3, 2, 1, 0]);
  await page.getByTestId('undo').click();
  await expect.poll(() => pageOrder(page, ids)).toEqual([0, 1, 2, 3, 4, 5]);

  await cell(page, 0).click();
  await page.getByTestId('organize-duplicate').click();
  await expect.poll(() => pageOrder(page, ids)).toEqual([0, -1, 1, 2, 3, 4, 5]);
  await page.getByTestId('undo').click();
  await expect.poll(() => pageOrder(page, ids)).toEqual([0, 1, 2, 3, 4, 5]);

  // Cut page 1, paste it at the end.
  await cell(page, 0).click();
  await page.keyboard.press('ControlOrMeta+x');
  await cell(page, 5).click();
  await page.keyboard.press('ControlOrMeta+v');
  await expect.poll(() => pageOrder(page, ids)).toEqual([1, 2, 3, 4, 5, 0]); // within a document, cut + paste moves the page
  const info = await inspectPdf(await exportActive(page));
  expect(info.pages.map((p) => sampleIndexOf(p.text))).toEqual([1, 2, 3, 4, 5, 0]);

  await page.getByTestId('organize-close').click();
  await expect(page.getByTestId('organize-view')).toHaveCount(0);
  await expect(page.getByTestId('document-viewer')).toBeVisible();
});

test('large documents: the grid is virtualized and keyboard navigation reaches the end', async ({ page }) => {
  await open(page, 'large.pdf');
  await openOrganize(page);
  const mounted = await grid(page).getByTestId('organize-page').count();
  expect(mounted).toBeGreaterThan(5);
  expect(mounted).toBeLessThan(80);
  await grid(page).focus();
  await page.keyboard.press('End');
  await expect(grid(page).locator('[data-testid=organize-page][data-page-index="299"]')).toBeVisible();
  await expect(grid(page).locator('[data-testid=organize-page][data-page-index="299"]').getByTestId('organize-page-label')).toHaveText('300');
  await page.keyboard.press('ControlOrMeta+a');
  await expect(page.getByTestId('organize-status-count')).toContainText('300 of 300');
  expect(await grid(page).getByTestId('organize-page').count()).toBeLessThan(80);
});

// ── Extract PDF pages ─────────────────────────────────────────────────────────

test('Extract PDF pages: range input selects in the grid and downloads the pages', async ({ page }) => {
  await open(page, 'sample.pdf');
  await page.evaluate(() => window.__app.actions.openTask('extract-pages'));
  await expect(page.getByTestId('organize-extract-view')).toBeVisible();
  await page.getByTestId('organize-extract-range').fill('2-3, 5');
  await expect.poll(() => selectedIndices(page)).toEqual([1, 2, 4]);
  await expect(page.getByTestId('organize-status-count')).toContainText('3');
  await page.getByTestId('organize-extract-output').selectOption('download');
  const { bytes } = await captureDownload(page, () => page.getByTestId('organize-extract-run').click());
  const info = await inspectPdf(bytes);
  expect(info.pages.map((p) => sampleIndexOf(p.text))).toEqual([1, 2, 4]);

  // Grid selection drives the range field.
  await cell(page, 0).click();
  await cell(page, 5).click({ modifiers: ['ControlOrMeta'] });
  await expect(page.getByTestId('organize-extract-range')).toHaveValue('1, 6');
});

// ── Split a PDF ───────────────────────────────────────────────────────────────

test('Split a PDF: bookmarks, ranges with split points in the grid, ZIP and library output', async ({ page }) => {
  await open(page, 'large.pdf');
  await page.evaluate(() => window.__app.actions.openTask('split-pdf'));
  await expect(page.getByTestId('organize-split')).toBeVisible();

  await page.getByTestId('organize-split-method').selectOption('bookmarks');
  await expect(page.getByTestId('organize-split-summary')).toContainText('12');
  await expect(page.getByTestId('organize-split-part-name')).toHaveCount(12);

  await page.getByTestId('organize-split-method').selectOption('ranges');
  const ranges = page.getByTestId('organize-split-ranges');
  await ranges.fill('1-3, 4-6, 7-');
  await ranges.press('Enter');
  await expect(page.getByTestId('organize-split-part-name')).toHaveCount(3);
  await expect(page.getByTestId('organize-split-part-name').first()).toHaveText('large_Part1.pdf');
  await expect(grid(page).getByTestId('organize-part-badge').first()).toHaveText('Part 1');
  // Toggling a split point in the grid updates the ranges.
  await grid(page).locator('[data-testid=organize-split-gap][data-gap="1"]').click();
  await expect(ranges).toHaveValue('1, 2-3, 4-6, 7-');
  await grid(page).locator('[data-testid=organize-split-gap][data-gap="1"]').click();
  await expect(ranges).toHaveValue('1-3, 4-6, 7-');

  await page.getByTestId('organize-split-output').selectOption('zip');
  const { download, bytes } = await captureDownload(page, () => page.getByTestId('organize-split-run').click());
  expect(download.suggestedFilename()).toBe('large_Split.zip');
  const zip = await JSZip.loadAsync(bytes);
  expect(Object.keys(zip.files).sort()).toEqual(['large_Part1.pdf', 'large_Part2.pdf', 'large_Part3.pdf']);
  const counts = [];
  for (const n of ['large_Part1.pdf', 'large_Part2.pdf', 'large_Part3.pdf']) counts.push((await loadLib(await zip.files[n].async('uint8array'))).getPageCount());
  expect(counts).toEqual([3, 3, 294]);

  // Every 100 pages, saved to the library.
  await page.getByTestId('organize-split-method').selectOption('pages');
  const n = page.getByTestId('organize-split-pages').locator('input');
  await n.fill('100');
  await n.press('Tab');
  await expect(page.getByTestId('organize-split-part-name')).toHaveCount(3);
  await page.getByTestId('organize-split-output').selectOption('library');
  await page.getByTestId('organize-split-run').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'into 3 files, saved to your files' })).toBeVisible({ timeout: 60_000 });
  const files = await listLibrary(page);
  const parts = files.filter((f) => /^large_Part\d\.pdf$/.test(f.name)).map((f) => f.name).sort();
  expect(parts).toEqual(['large_Part1.pdf', 'large_Part2.pdf', 'large_Part3.pdf']);
});

// ── Combine files ─────────────────────────────────────────────────────────────

test('Combine files: add, reorder, expand and remove a page, then Binder1.pdf with a bookmark per file', async ({ page }) => {
  await gotoApp(page);
  await page.locator('[data-testid=featured-task][data-task-id=combine-files]').click();
  await expect(page.getByTestId('organize-combine')).toBeVisible();
  expect((await getAppState(page)).route).toBe('task');
  await expect(page.getByTestId('organize-combine-run')).toBeDisabled();

  await page.getByTestId('organize-combine-add').click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), menuItem(page, 'organize-combine-add-device').click()]);
  await chooser.setFiles([FIXTURES_DIR + 'sample.pdf', FIXTURES_DIR + 'rotated.pdf', FIXTURES_DIR + 'form.pdf']);
  const cards = page.getByTestId('organize-combine-file');
  await expect(cards).toHaveCount(3);
  const names = () => cards.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.name));
  expect(await names()).toEqual(['sample.pdf', 'rotated.pdf', 'form.pdf']);
  const formPages = Number(await cards.nth(2).getAttribute('data-pages'));

  // form.pdf dragged before sample.pdf.
  await cards.nth(2).dragTo(cards.nth(0), { targetPosition: { x: 10, y: 60 } });
  await expect.poll(names).toEqual(['form.pdf', 'sample.pdf', 'rotated.pdf']);

  // Expand rotated.pdf and remove its first page.
  await cards.nth(2).hover();
  await cards.nth(2).getByTestId('organize-combine-expand').click();
  const pages = page.getByTestId('organize-combine-page');
  await expect(pages).toHaveCount(7);
  await pages.nth(0).hover();
  await pages.nth(0).getByTestId('organize-combine-page-remove').click();
  await expect(pages).toHaveCount(6);
  const total = formPages + 6 + 6;
  await expect(page.getByTestId('organize-combine-summary')).toContainText(`${total} pages`);

  await page.getByTestId('organize-combine-run').click();
  await page.waitForFunction(() => /^Binder\d+\.pdf$/.test(window.__app.getActiveDoc()?.name ?? ''), null, { timeout: 60_000 });
  await settle(page);
  const d = await getDoc(page);
  expect(d.name).toBe('Binder1.pdf');
  expect(d.pageCount).toBe(total);
  expect(d.outlineCount).toBe(3);

  const bytes = await exportActive(page);
  const tree = await outlineTree(bytes);
  expect(tree.map((n) => [n.title, n.page])).toEqual([
    ['form', 0],
    ['sample', formPages],
    ['rotated', formPages + 6],
  ]);
  // The original sample.pdf outline is nested under its file bookmark.
  expect(tree[1].items.length).toBe((await outlineTree(fixtureBytes('sample.pdf'))).length);
  const info = await inspectPdf(bytes);
  expect(info.pages.slice(formPages + 6).map((p) => p.rotation)).toEqual([90, 180, 270, 0, 0, 90]);
  // Links and form fields survive.
  const lib = await loadLib(bytes);
  expect(lib.getForm().getFields().length).toBe((await loadLib(fixtureBytes('form.pdf'))).getForm().getFields().length);
  const { doc, close } = await openPdfjs(bytes);
  const tocLinks = (await (await doc.getPage(formPages + 2)).getAnnotations()).filter((a) => a.subtype === 'Link' && !a.url);
  expect(tocLinks.length).toBe(10);
  for (const a of tocLinks) {
    const dest = typeof a.dest === 'string' ? await doc.getDestination(a.dest) : a.dest;
    const target = await doc.getPageIndex(dest[0]);
    expect(target).toBeGreaterThanOrEqual(formPages);
    expect(target).toBeLessThan(formPages + 6);
  }
  await close();
});

test('Combine files started from an open document puts it first; the next binder is Binder2.pdf', async ({ page }) => {
  await open(page, 'sample.pdf');
  await page.evaluate(() => window.__app.actions.openTask('combine-files'));
  const cards = page.getByTestId('organize-combine-file');
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toHaveAttribute('data-name', 'sample.pdf');
  await expect(page.getByTestId('organize-combine-run')).toBeDisabled();

  // Files dropped on the view are added (images are converted).
  const png = fs.readFileSync(FIXTURES_DIR + 'sample.png').toString('base64');
  const dt = await page.evaluateHandle((b64) => {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const t = new DataTransfer();
    t.items.add(new File([arr], 'sample.png', { type: 'image/png' }));
    return t;
  }, png);
  const body = page.getByTestId('organize-combine-body');
  await body.dispatchEvent('dragenter', { dataTransfer: dt });
  await body.dispatchEvent('dragover', { dataTransfer: dt });
  await body.dispatchEvent('drop', { dataTransfer: dt });
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(1)).toHaveAttribute('data-name', 'sample.png');

  // Sort by name.
  await page.getByTestId('organize-combine-sort').click();
  await menuItem(page, 'organize-combine-sort-desc').click();
  await expect.poll(() => cards.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.name))).toEqual(['sample.png', 'sample.pdf']);

  await page.getByTestId('organize-combine-run').click();
  await page.waitForFunction(() => /^Binder\d+\.pdf$/.test(window.__app.getActiveDoc()?.name ?? ''), null, { timeout: 60_000 });
  await settle(page);
  const d = await getDoc(page);
  expect(d.name).toBe('Binder1.pdf');
  expect(d.pageCount).toBe(7);
  expect((await getAppState(page)).tabs.length).toBe(2);

  await page.evaluate(() => window.__app.actions.openTask('combine-files'));
  await expect(cards.first()).toHaveAttribute('data-name', 'Binder1.pdf');
  await page.getByTestId('organize-combine-add').click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), menuItem(page, 'organize-combine-add-device').click()]);
  await chooser.setFiles(FIXTURES_DIR + 'rotated.pdf');
  await expect(cards).toHaveCount(2);
  await page.getByTestId('organize-combine-run').click();
  await page.waitForFunction(() => window.__app.getActiveDoc()?.name === 'Binder2.pdf', null, { timeout: 60_000 });
  await settle(page);
  expect((await getDoc(page)).pageCount).toBe(14);
});

// ── library sources and protected files ───────────────────────────────────────

async function uploadToLibrary(page: Page, name: string, fixture: string): Promise<string> {
  return (await addToLibrary(page, name, fixtureBytes(fixture))).id;
}

test('Insert from your files and Combine from your files use the library picker', async ({ page }) => {
  await open(page, 'sample.pdf');
  await uploadToLibrary(page, 'organize-lib-rotated.pdf', 'rotated.pdf');
  await uploadToLibrary(page, 'organize-lib-form.pdf', 'form.pdf');
  await openOrganize(page);

  // Insert > From your files… at the end (a PDF asks which pages / where).
  await page.getByTestId('organize-insert-menu').click();
  await menuItem(page, 'organize-insert-library').click();
  await expect(page.getByTestId('organize-library')).toBeVisible();
  await page.getByTestId('organize-library-search').fill('organize-lib-rot');
  await page.locator('[data-testid=organize-library-item][data-file-name="organize-lib-rotated.pdf"]').click();
  await page.getByTestId('organize-library-ok').click();
  await expect(page.getByTestId('organize-insert-dialog')).toBeVisible();
  await page.getByTestId('organize-insert-where').selectOption('last');
  await page.getByTestId('organize-insert-ok').click();
  await expect.poll(() => getDoc(page).then((d) => d.pageCount)).toBe(13);
  expect((await getDoc(page)).rotations.slice(6)).toEqual([0, 90, 180, 270, 0, 0, 90]);

  // Combine: the open document first, then two library files in the order they were picked.
  await page.evaluate(() => window.__app.actions.openTask('combine-files'));
  const cards = page.getByTestId('organize-combine-file');
  await expect(cards).toHaveCount(1);
  await page.getByTestId('organize-combine-add').click();
  await menuItem(page, 'organize-combine-add-library').click();
  await page.getByTestId('organize-library-search').fill('organize-lib-');
  await page.locator('[data-testid=organize-library-item][data-file-name="organize-lib-form.pdf"]').click();
  await page.locator('[data-testid=organize-library-item][data-file-name="organize-lib-rotated.pdf"]').click();
  await page.getByTestId('organize-library-ok').click();
  await expect(cards).toHaveCount(3);
  expect(await cards.evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.name))).toEqual(['sample.pdf', 'organize-lib-form.pdf', 'organize-lib-rotated.pdf']);
});

test('Combine files asks for the password of a protected PDF', async ({ page }) => {
  await gotoApp(page);
  await page.locator('[data-testid=featured-task][data-task-id=combine-files]').click();
  await page.getByTestId('organize-combine-add').click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), menuItem(page, 'organize-combine-add-device').click()]);
  await chooser.setFiles([FIXTURES_DIR + 'encrypted.pdf', FIXTURES_DIR + 'sample.pdf']);
  await page.getByTestId('password-input').fill('wrong');
  await page.getByTestId('password-submit').click();
  await expect(page.getByTestId('modal')).toContainText('Incorrect password');
  await page.getByTestId('password-input').fill('secret');
  await page.getByTestId('password-submit').click();
  const cards = page.getByTestId('organize-combine-file');
  await expect(cards).toHaveCount(2);
  const encryptedPages = Number(await cards.nth(0).getAttribute('data-pages'));
  await page.getByTestId('organize-combine-run').click();
  await page.waitForFunction(() => /^Binder\d+\.pdf$/.test(window.__app.getActiveDoc()?.name ?? ''), null, { timeout: 60_000 });
  await settle(page);
  const bytes = await exportActive(page);
  const info = await inspectPdf(bytes); // the binder itself is not protected
  expect(info.numPages).toBe(encryptedPages + 6);
  expect((await outlineTree(bytes)).map((n) => n.title)).toEqual(['encrypted', 'sample']);
});

// ── regressions ───────────────────────────────────────────────────────────────

/** Every element is fully inside the bar (nothing clipped or pushed out by a narrow window). */
async function expectInside(page: Page, barTestId: string, ids: string[]) {
  const bar = page.getByTestId(barTestId);
  const b = (await bar.boundingBox())!;
  for (const id of ids) {
    const el = bar.getByTestId(id);
    await expect(el, id).toBeVisible();
    const r = (await el.boundingBox())!;
    expect(r.x, `${id} left`).toBeGreaterThanOrEqual(b.x - 0.5);
    expect(r.x + r.width, `${id} right`).toBeLessThanOrEqual(b.x + b.width + 0.5);
    expect(r.y + r.height, `${id} bottom`).toBeLessThanOrEqual(b.y + b.height + 0.5);
  }
}

test('narrow windows: toolbars compact or wrap without hiding actions; an invalid extract range explains itself and Enter does nothing', async ({ page }) => {
  await page.setViewportSize({ width: 1150, height: 860 });
  await open(page, 'sample.pdf');
  await openOrganize(page);
  await expectInside(page, 'organize-toolbar', [
    'organize-select-menu', 'organize-rotate-ccw', 'organize-rotate-cw', 'organize-delete', 'organize-insert-menu', 'organize-extract',
    'organize-replace', 'organize-split', 'organize-reverse', 'organize-duplicate', 'organize-labels',
    'organize-zoom-out', 'organize-zoom-slider', 'organize-zoom-in', 'organize-close',
  ]);
  // Undo/Redo give way first; the quick tools bar next to the view keeps them.
  await expect(page.getByTestId('organize-undo')).toBeHidden();
  await expect(page.getByTestId('undo')).toBeVisible();
  // Icon-only buttons still have an accessible name.
  await expect(page.getByTestId('organize-extract')).toHaveAccessibleName('Extract');
  await expect(page.getByTestId('organize-insert-menu')).toHaveAccessibleName('Insert');

  await page.getByTestId('organize-split').click();
  await expect(page.getByTestId('organize-split-bar')).toBeVisible();
  await expectInside(page, 'organize-split-bar', ['organize-split-method', 'organize-split-output', 'organize-split-cancel', 'organize-split-run']);

  await page.evaluate(() => window.__app.actions.openTask('extract-pages'));
  await expect(page.getByTestId('organize-extract-bar')).toBeVisible();
  await expectInside(page, 'organize-extract-bar', ['organize-select-menu', 'organize-extract-range', 'organize-extract-output', 'organize-extract-cancel', 'organize-extract-run']);

  const range = page.getByTestId('organize-extract-range');
  const tabs = (await getAppState(page)).tabs.length;
  await range.fill('2-9');
  const error = page.getByTestId('organize-extract-error');
  await expect(error).toBeVisible();
  await expect(error).toContainText(/\S/);
  await expect(range).toHaveAttribute('aria-invalid', 'true');
  await expect(range).toHaveAccessibleDescription(((await error.textContent()) ?? '').trim());
  await expect(page.getByTestId('organize-extract-run')).toBeDisabled();
  await range.press('Enter');
  await page.waitForTimeout(400);
  expect((await getAppState(page)).tabs.length).toBe(tabs);
  await expect(page.getByTestId('organize-extract-view')).toBeVisible();

  await range.fill('2-3');
  await expect(error).toHaveCount(0);
  await expect(range).not.toHaveAttribute('aria-invalid', 'true');
  await expect.poll(() => selectedIndices(page)).toEqual([1, 2]);
  await expect(page.getByTestId('organize-extract-run')).toBeEnabled();
});

test('Combine files: "Restore pages" after moving a page between files keeps every page exactly once', async ({ page }) => {
  await gotoApp(page);
  await page.evaluate(() => window.__app.actions.openTask('combine-files'));
  await expect(page.getByTestId('organize-combine')).toBeVisible();
  // The hint lists the conversions that are actually available (image handlers are registered, Office is not).
  const drop = page.getByTestId('organize-combine-drop');
  await expect(drop).toContainText('Images are converted to PDF.');
  await expect(drop).not.toContainText('Office');

  await page.getByTestId('organize-combine-add').click();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), menuItem(page, 'organize-combine-add-device').click()]);
  await chooser.setFiles([FIXTURES_DIR + 'rotated.pdf', FIXTURES_DIR + 'sample.pdf']);
  const files = page.getByTestId('organize-combine-file');
  await expect(files).toHaveCount(2);
  await page.getByTestId('organize-combine-expand-all').click();
  const pagesOf = (k: number) => files.nth(k).getByTestId('organize-combine-page');
  const sourcePages = (k: number) => pagesOf(k).evaluateAll((els) => els.map((e) => Number((e as HTMLElement).dataset.sourcePage)));
  await expect(pagesOf(0)).toHaveCount(7);
  await expect(pagesOf(1)).toHaveCount(6);

  const moveSamplePage2 = async () => {
    const box = (await pagesOf(0).nth(0).boundingBox())!;
    await pagesOf(1).nth(1).dragTo(pagesOf(0).nth(0), { targetPosition: { x: 4, y: box.height / 2 } });
    await expect(pagesOf(0)).toHaveCount(8);
    await expect(pagesOf(1)).toHaveCount(5);
    await expect(files.nth(0).getByTestId('organize-combine-restore')).toBeVisible();
  };

  // Restoring the file that received the page sends the page back where it came from.
  await moveSamplePage2();
  await files.nth(0).getByTestId('organize-combine-restore').click();
  await expect.poll(() => sourcePages(0)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  await expect.poll(() => sourcePages(1)).toEqual([1, 2, 3, 4, 5, 6]);
  await expect(page.getByTestId('organize-combine-restore')).toHaveCount(0);

  // Restoring the file the page came from takes it back from the other file.
  await moveSamplePage2();
  await files.nth(1).getByTestId('organize-combine-restore').click();
  await expect.poll(() => sourcePages(0)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  await expect.poll(() => sourcePages(1)).toEqual([1, 2, 3, 4, 5, 6]);
  await expect(page.getByTestId('organize-combine-summary')).toContainText('13 pages');

  // A page moved across files lands in the binder where it was dropped.
  await moveSamplePage2();
  await page.getByTestId('organize-combine-run').click();
  await page.waitForFunction(() => /^Binder\d+\.pdf$/.test(window.__app.getActiveDoc()?.name ?? ''), null, { timeout: 60_000 });
  await settle(page);
  const d = await getDoc(page);
  expect(d.pageCount).toBe(13);
  expect(new Set(d.pageIds).size).toBe(13);
  const bytes = await exportActive(page);
  const lib = await loadLib(bytes);
  expect(new Set(lib.getPages().map((p) => p.ref.toString())).size).toBe(13);
  const info = await inspectPdf(bytes);
  const rotated = await inspectPdf(fixtureBytes('rotated.pdf'));
  expect(sampleIndexOf(info.pages[0].text)).toBe(1);
  expect(info.pages.slice(1, 8).map((p) => p.text)).toEqual(rotated.pages.map((p) => p.text));
  expect(info.pages.slice(1, 8).map((p) => p.rotation)).toEqual([0, 90, 180, 270, 0, 0, 90]);
  expect(info.pages.slice(8).map((p) => sampleIndexOf(p.text))).toEqual([0, 2, 3, 4, 5]);
  expect((await outlineTree(bytes)).map((n) => [n.title, n.page])).toEqual([
    ['rotated', 0],
    ['sample', 8],
  ]);
});

test('page labels with accents and non-Latin prefixes survive Download', async ({ page }) => {
  await open(page, 'sample.pdf');
  await openOrganize(page);
  const dialog = page.getByTestId('organize-labels-dialog');

  await cell(page, 0).click();
  await cell(page, 1).click({ modifiers: ['Shift'] });
  await page.getByTestId('organize-labels').click();
  await expect(dialog).toBeVisible();
  await page.getByTestId('organize-labels-style').selectOption('r');
  await page.getByTestId('organize-labels-ok').click();
  await expect(dialog).toHaveCount(0);

  const prefix = 'Zoë — 日本語 Ελληνικά-';
  await cell(page, 2).click();
  await cell(page, 4).click({ modifiers: ['Shift'] });
  await page.getByTestId('organize-labels').click();
  await expect(dialog).toBeVisible();
  await page.getByTestId('organize-labels-prefix').fill(prefix);
  const start = page.getByTestId('organize-labels-start').locator('input');
  await start.fill('8');
  await start.press('Tab');
  await expect(page.getByTestId('organize-labels-sample')).toContainText(`${prefix}8, ${prefix}9`);
  // Enter right after typing applies the typed number.
  await start.fill('7');
  await start.press('Enter');
  await expect(dialog).toHaveCount(0);

  await expect.poll(() => getDoc(page).then((d) => d.labels.slice(0, 5))).toEqual(['i', 'ii', `${prefix}7`, `${prefix}8`, `${prefix}9`]);
  await expect(cell(page, 3).getByTestId('organize-page-label')).toHaveText(`${prefix}8`);
  const labels = (await getDoc(page)).labels;

  await settle(page);
  const { download, bytes } = await captureDownload(page, () => page.getByTestId('download').click());
  expect(download.suggestedFilename()).toBe('sample.pdf');
  expect(await pageLabelsOf(bytes)).toEqual(labels);
});

test('a read-only document can be browsed in the grid but its pages cannot be changed, copied or extracted', async ({ page }) => {
  await open(page, 'sample.pdf');
  const ids = (await getDoc(page)).pageIds;
  // Same state as a PDF whose encryption can't be removed (there is no such fixture): mark the open document read-only.
  await page.evaluate(async () => {
    const url = performance.getEntriesByType('resource').map((e) => e.name).filter((n) => n.includes('/core/engine/state.ts')).pop();
    if (!url) throw new Error('engine state module not found');
    const st = await import(/* @vite-ignore */ url);
    const d = window.__app.getActiveDoc();
    st.setReadOnly(d.id, { reason: 'its encryption is not supported', password: '', bytes: d.bytes });
  });
  expect(await page.evaluate(() => window.__engine.isReadOnly(window.__app.getActiveDoc().id))).toBe(true);

  await openOrganize(page);
  await expect(page.getByTestId('organize-readonly')).toContainText('read-only');
  await cell(page, 1).click();
  await expect.poll(() => selectedIndices(page)).toEqual([1]);
  for (const id of ['organize-rotate-ccw', 'organize-rotate-cw', 'organize-delete', 'organize-insert-menu', 'organize-extract', 'organize-replace', 'organize-reverse', 'organize-duplicate', 'organize-labels']) {
    await expect(page.getByTestId(id), id).toBeDisabled();
  }
  await expect(page.getByTestId('organize-zoom-in')).toBeEnabled();
  await expect(page.getByTestId('organize-close')).toBeEnabled();

  // Keyboard shortcuts explain instead of acting.
  await page.keyboard.press('Delete');
  await expect(page.getByTestId('toast').filter({ hasText: 'read-only' }).first()).toBeVisible();
  await page.keyboard.press('ControlOrMeta+c');
  await expect(page.getByTestId('toast').filter({ hasText: "can't be copied" })).toBeVisible();

  // Context menu: everything that changes, copies or extracts pages is disabled.
  await cell(page, 1).click({ button: 'right' });
  for (const id of ['organize-menu-rotate-cw', 'organize-menu-insert', 'organize-menu-cut', 'organize-menu-copy', 'organize-menu-duplicate', 'organize-menu-extract', 'organize-menu-replace', 'organize-menu-labels', 'organize-menu-delete']) {
    await expect(menuItem(page, id), id).toHaveAttribute('aria-disabled', 'true');
  }
  await expect(menuItem(page, 'organize-menu-open')).not.toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');

  // Pages can't be dragged to a new place.
  const box = (await cell(page, 0).boundingBox())!;
  await cell(page, 3).dragTo(cell(page, 0), { targetPosition: { x: 4, y: box.height / 2 } });
  await page.waitForTimeout(300);
  expect(await pageOrder(page, ids)).toEqual([0, 1, 2, 3, 4, 5]);
  expect((await getDoc(page)).rotations).toEqual([0, 0, 0, 0, 0, 0]);

  // Split explains why it can't run.
  await page.evaluate(() => window.__app.actions.openTask('split-pdf'));
  await expect(page.getByTestId('organize-split-run')).toBeDisabled();
});
