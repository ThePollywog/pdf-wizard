/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * Edit a PDF: the task and its tools (E = edit text & images, add text, add image, add or edit link).
 * Base page content is rewritten in place — edited text blocks, moved / flipped / rotated / cropped /
 * deleted images — and added text, images and links are exported as real page content and /Link
 * annotations. Every edit is one undo step that restores the previous bytes.
 */
import type { Locator, Page } from '@playwright/test';
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFString, type PDFObject } from '@cantoo/pdf-lib';
import {
  FIXTURES_DIR, captureDownload, expect, expectNewVersion, getDoc, inspectPdf, loadLib, loadPdfjsNode, openFixture, openPdfjs, test,
  waitForDocReady, waitForPagesRendered,
} from './helpers';

// ── helpers ──────────────────────────────────────────────────────────────────

const overlay = (page: Page, pageIndex: number) => page.locator(`[data-testid=edit-pdf-overlay][data-page-index="${pageIndex}"]`);
const items = (page: Page, pageIndex: number, kind?: string) =>
  overlay(page, pageIndex).locator(kind ? `[data-testid=edit-pdf-item][data-item-kind="${kind}"]` : '[data-testid=edit-pdf-item]');
const block = (page: Page, pageIndex: number, labelStart: string) => overlay(page, pageIndex).locator(`[data-testid=edit-pdf-item][data-label^="${labelStart}"]`).first();

const appState = (page: Page) =>
  page.evaluate(() => {
    const s = window.__app.useApp.getState();
    return { task: s.activeTaskId as string | null, tool: s.activeToolId as string };
  });

interface Obj {
  id: string;
  kind: string;
  pageIndex: number;
  rect: { x: number; y: number; width: number; height: number };
  data: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}
const objects = (page: Page, kind?: string): Promise<Obj[]> =>
  page.evaluate((k) => {
    const d = window.__app.getActiveDoc();
    return d.order
      .map((id: string) => d.objects[id])
      .filter((o: any) => o && (!k || o.kind === k)) // eslint-disable-line @typescript-eslint/no-explicit-any
      .map((o: any) => ({ // eslint-disable-line @typescript-eslint/no-explicit-any
        id: o.id,
        kind: o.kind,
        pageIndex: d.pages.findIndex((p: any) => p.id === o.pageId), // eslint-disable-line @typescript-eslint/no-explicit-any
        rect: { ...o.rect },
        data: o.kind === 'content-image' ? { ...o.data, src: '' } : o.data,
      }));
  }, kind ?? null);

/** SHA-256 of the current document bytes. */
const bytesHash = (page: Page): Promise<string> =>
  page.evaluate(async () => {
    const h = await crypto.subtle.digest('SHA-256', window.__app.getActiveDoc().bytes);
    return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
  });

async function setZoom(page: Page, zoom: number) {
  await page.evaluate((z) => window.__app.actions.setZoom(window.__app.getActiveDoc().id, z), zoom);
  await waitForPagesRendered(page);
}

/** Opens the task with the E shortcut and waits for the page content model of `pageIndex`. */
async function openEditMode(page: Page, pageIndex = 0) {
  await page.keyboard.press('e');
  await expect.poll(() => appState(page)).toEqual({ task: 'edit-pdf', tool: 'edit-content' });
  await expect(page.getByTestId('edit-pdf-panel')).toBeVisible();
  await expect(overlay(page, pageIndex)).toHaveAttribute('data-model', 'ready');
}

/** Scrolls the element to the middle of the viewer and returns its box. */
async function centerBox(loc: Locator) {
  await loc.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'center' }));
  await expect(loc).toBeVisible();
  await loc.page().waitForTimeout(150);
  const b = await loc.boundingBox();
  if (!b) throw new Error('element has no box');
  return b;
}

async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}

async function download(page: Page) {
  const { bytes } = await captureDownload(page, () => page.getByTestId('download').click());
  return bytes;
}

async function reopen(page: Page, bytes: Uint8Array, name: string) {
  await page.getByTestId('open-file-input').setInputFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
  await waitForDocReady(page, name);
  await waitForPagesRendered(page);
}

/** Number of images painted on a page (pdf.js operator list). */
async function imageDraws(bytes: Uint8Array, pageNo: number) {
  const pdfjs = await loadPdfjsNode();
  const { doc, close } = await openPdfjs(bytes);
  try {
    const ops = await (await doc.getPage(pageNo)).getOperatorList();
    const paint = new Set([pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject, pdfjs.OPS.paintImageXObjectRepeat]);
    return ops.fnArray.filter((f) => paint.has(f)).length;
  } finally {
    await close();
  }
}

interface LinkAnnot {
  page: number;
  rect: number[];
  uri?: string;
  destPage?: number;
  border?: number[];
  color?: number[];
  highlight?: string;
  dash?: string;
}
async function linkAnnots(bytes: Uint8Array): Promise<LinkAnnot[]> {
  const doc = await loadLib(bytes);
  const deref = (o: PDFObject | undefined) => (o instanceof PDFRef ? doc.context.lookup(o) : o);
  const nums = (v: PDFObject | undefined) => {
    const a = deref(v);
    return a instanceof PDFArray ? a.asArray().map((x) => deref(x)).filter((x): x is PDFNumber => x instanceof PDFNumber).map((x) => x.asNumber()) : undefined;
  };
  const pageRefs = doc.getPages().map((p) => p.ref.toString());
  const out: LinkAnnot[] = [];
  doc.getPages().forEach((p, page) => {
    const arr = p.node.Annots();
    if (!arr) return;
    for (let k = 0; k < arr.size(); k++) {
      const a = deref(arr.get(k));
      if (!(a instanceof PDFDict) || deref(a.get(PDFName.of('Subtype')))?.toString() !== '/Link') continue;
      const link: LinkAnnot = { page, rect: nums(a.get(PDFName.of('Rect'))) ?? [] };
      const act = deref(a.get(PDFName.of('A')));
      if (act instanceof PDFDict) {
        const uri = deref(act.get(PDFName.of('URI')));
        if (uri instanceof PDFString) link.uri = uri.decodeText();
      }
      const dest = deref(a.get(PDFName.of('Dest')));
      if (dest instanceof PDFArray) link.destPage = pageRefs.indexOf(String(dest.get(0)));
      link.border = nums(a.get(PDFName.of('Border')));
      link.color = nums(a.get(PDFName.of('C')));
      link.highlight = deref(a.get(PDFName.of('H')))?.toString();
      const bs = deref(a.get(PDFName.of('BS')));
      if (bs instanceof PDFDict) link.dash = deref(bs.get(PDFName.of('S')))?.toString();
      out.push(link);
    }
  });
  return out;
}

const near = (a: number, b: number, tol = 2) => Math.abs(a - b) <= tol;

/** BaseFont names in the /Font resources of a page (subset prefixes stripped). */
async function pageFonts(bytes: Uint8Array, pageIndex: number): Promise<string[]> {
  const doc = await loadLib(bytes);
  const deref = (o: PDFObject | undefined) => (o instanceof PDFRef ? doc.context.lookup(o) : o);
  const res = deref(doc.getPages()[pageIndex].node.get(PDFName.of('Resources')));
  const fonts = res instanceof PDFDict ? deref(res.get(PDFName.of('Font'))) : undefined;
  if (!(fonts instanceof PDFDict)) return [];
  return fonts.values().map((f) => {
    const d = deref(f);
    return d instanceof PDFDict ? String(deref(d.get(PDFName.of('BaseFont'))) ?? '').replace(/^\/([A-Z]{6}\+)?/, '') : '';
  });
}

/** Value of a core Select (the test id may sit on the <select> or on its wrapper). */
const selectValue = (loc: Locator) => loc.evaluate((el) => ((el.querySelector('select') ?? el) as HTMLSelectElement).value);

// ── tests ────────────────────────────────────────────────────────────────────

test.describe('edit-pdf', () => {
  test('E opens the Edit a PDF task: tools, panel, outlined text blocks and images', async ({ page }) => {
    await openFixture(page, 'sample.pdf');
    await openEditMode(page);
    for (const id of ['edit-content', 'edit-add-text', 'edit-add-image', 'edit-link']) await expect(page.getByTestId(`tool-chip-${id}`)).toBeVisible();
    for (const id of ['edit-pdf-mode-edit', 'edit-pdf-add-text', 'edit-pdf-add-image', 'edit-pdf-add-link']) await expect(page.getByTestId(id)).toBeEnabled();
    await expect(page.getByTestId('edit-pdf-format-section')).toBeVisible();
    await expect(page.getByTestId('edit-pdf-design')).toBeVisible();
    expect(await items(page, 0, 'block').count()).toBeGreaterThan(4);
    await expect(block(page, 0, 'PDF Wizard brings the core')).toBeAttached();

    // The tool chips switch tools inside the task; leaving the task goes back to Select.
    await page.getByTestId('tool-chip-edit-link').click();
    await expect.poll(() => appState(page)).toEqual({ task: 'edit-pdf', tool: 'edit-link' });
    await page.getByTestId('edit-pdf-mode-edit').click();
    await expect.poll(async () => (await appState(page)).tool).toBe('edit-content');
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await appState(page)).tool).toBe('select');
  });

  test('edits a text block in place: export has the new text, undo restores the bytes', async ({ page }) => {
    await openFixture(page, 'sample.pdf');
    await setZoom(page, 1);
    await openEditMode(page);
    const original = await bytesHash(page);

    const b = await centerBox(block(page, 0, 'PDF Wizard brings the core'));
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    const ta = page.getByTestId('edit-pdf-textarea');
    await expect(ta).toBeFocused();
    await expect(ta).toHaveValue(/^PDF Wizard brings the core capabilities/);
    await expect(page.getByTestId('edit-pdf-format')).toBeVisible();

    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('Edited paragraph from the suite');
    // Home / End move the caret inside the editor (they must not scroll the document)
    await page.keyboard.press('Home');
    await page.keyboard.type('>> ');
    await page.keyboard.press('End');
    await page.keyboard.type('.');
    await expect(ta).toHaveValue('>> Edited paragraph from the suite.');
    await expectNewVersion(page, () => page.keyboard.press('Escape'));
    await expect(ta).toHaveCount(0);
    await expect(page.getByTestId('edit-pdf-selection')).toBeVisible();
    expect((await getDoc(page)).past).toBe(1);

    const info = await inspectPdf(await download(page));
    expect(info.pages[0].text).toContain('>> Edited paragraph from the suite.');
    expect(info.pages[0].text).not.toContain('brings the core capabilities');
    expect(info.pages[0].text).toContain('Abstract');
    expect(info.numPages).toBe(6);

    await expectNewVersion(page, () => page.keyboard.press('ControlOrMeta+z'));
    expect(await bytesHash(page)).toBe(original);
    await expect(block(page, 0, 'PDF Wizard brings the core')).toBeAttached();
  });

  test('moves, reflows and deletes a text block (one undo step each)', async ({ page }) => {
    await openFixture(page, 'sample.pdf');
    await setZoom(page, 1);
    await openEditMode(page);
    const original = await bytesHash(page);

    // select the block (click to edit, Esc keeps it selected)
    let b = await centerBox(block(page, 0, 'PDF Wizard brings the core'));
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    await expect(page.getByTestId('edit-pdf-textarea')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('edit-pdf-selection')).toBeVisible();

    // arrow keys nudge: one byte edit once the keys rest
    await expectNewVersion(page, async () => {
      for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowDown');
    });
    expect((await getDoc(page)).past).toBe(1);
    await expect(block(page, 0, 'PDF Wizard brings the core')).toBeAttached();
    const moved = await block(page, 0, 'PDF Wizard brings the core').boundingBox();
    expect(moved && moved.y - b.y).toBeGreaterThan(2);

    // dragging the right handle narrows the box: the paragraph reflows into more lines
    b = await centerBox(block(page, 0, 'PDF Wizard brings the core'));
    const handle = await page.getByTestId('edit-pdf-handle-e').boundingBox();
    if (!handle) throw new Error('no width handle');
    await expectNewVersion(page, () => drag(page, { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 }, { x: handle.x - 180, y: handle.y + handle.height / 2 }));
    const narrowed = await block(page, 0, 'PDF Wizard brings the core').boundingBox();
    expect(narrowed!.width).toBeLessThan(b.width - 100);
    expect(narrowed!.height).toBeGreaterThan(b.height + 10);
    expect((await inspectPdf(await download(page))).pages[0].text).toContain('summarize performance measurements');

    // Delete removes the text from the page content
    await expectNewVersion(page, () => page.keyboard.press('Delete'));
    await expect(page.getByTestId('edit-pdf-selection')).toHaveCount(0);
    const text = (await inspectPdf(await download(page))).pages[0].text;
    expect(text).not.toContain('brings the core');
    expect(text).toContain('Abstract');

    for (let i = 0; i < 3; i++) await expectNewVersion(page, () => page.keyboard.press('ControlOrMeta+z'));
    expect(await bytesHash(page)).toBe(original);
  });

  test('edits text on a rotated page', async ({ page }) => {
    await openFixture(page, 'rotated.pdf');
    await openEditMode(page);
    await page.evaluate(() => window.__app.actions.goToPage(window.__app.getActiveDoc().id, 1));
    await expect(overlay(page, 1)).toHaveAttribute('data-model', 'ready');
    const b = await centerBox(block(page, 1, 'TOP'));
    expect(b.width).toBeGreaterThan(b.height); // reads upright on the /Rotate 90 page
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    await expect(page.getByTestId('edit-pdf-textarea')).toHaveValue('TOP');
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('UPRIGHT');
    await expectNewVersion(page, () => page.keyboard.press('Escape'));
    const info = await inspectPdf(await download(page));
    expect(info.pages[1].rotation).toBe(90);
    expect(info.pages[1].text).toContain('UPRIGHT');
    expect(info.pages[1].text).not.toMatch(/\bTOP\b/);
  });

  test('images: select, flip, rotate, nudge, crop and delete, all undoable', async ({ page }) => {
    await openFixture(page, 'images.pdf');
    await setZoom(page, 0.6);
    await openEditMode(page);
    const original = await bytesHash(page);
    const img = items(page, 0, 'image').first();
    await expect(items(page, 0, 'image')).toHaveCount(1);
    const b = await centerBox(img);
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    await expect(page.getByTestId('edit-pdf-selection')).toBeVisible();
    await expect(page.getByTestId('edit-pdf-objects')).toBeVisible();
    for (const h of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) await expect(page.getByTestId(`edit-pdf-handle-${h}`)).toBeVisible();

    await expectNewVersion(page, () => page.getByTestId('edit-pdf-obj-flip-h').click());
    await expectNewVersion(page, () => page.getByTestId('edit-pdf-obj-rotate-cw').click());
    await expect(page.getByTestId('edit-pdf-selection')).toBeVisible();
    // rotated 90°: the outline is now taller than wide
    await expect.poll(async () => {
      const r = await items(page, 0, 'image').first().boundingBox();
      return r ? r.height > r.width : false;
    }).toBe(true);
    await expectNewVersion(page, async () => {
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Shift+ArrowRight');
    });

    // crop: drag the top-left crop handle inwards, Enter applies (clipping path)
    await page.getByTestId('edit-pdf-obj-crop').click();
    await expect(page.getByTestId('edit-pdf-crop')).toBeVisible();
    const ch = await page.getByTestId('edit-pdf-crop-handle-nw').boundingBox();
    if (!ch) throw new Error('no crop handle');
    await drag(page, { x: ch.x + ch.width / 2, y: ch.y + ch.height / 2 }, { x: ch.x + 40, y: ch.y + 30 });
    await expectNewVersion(page, () => page.keyboard.press('Enter'));
    await expect(page.getByTestId('edit-pdf-crop')).toHaveCount(0);

    let bytes = await download(page);
    expect(await imageDraws(bytes, 1)).toBe(1);

    await expectNewVersion(page, () => page.keyboard.press('Delete'));
    await expect(items(page, 0, 'image')).toHaveCount(0);
    bytes = await download(page);
    expect(await imageDraws(bytes, 1)).toBe(0);
    expect(await imageDraws(bytes, 2)).toBe(1);
    expect((await inspectPdf(bytes)).pages[0].text).toContain('Figure 1');

    for (let i = 0; i < 5; i++) await expectNewVersion(page, () => page.keyboard.press('ControlOrMeta+z'));
    expect(await bytesHash(page)).toBe(original);
  });

  test('Add text: click or drag a width, format, export as page text and edit it again after reopening', async ({ page }) => {
    await openFixture(page, 'sample.pdf');
    await setZoom(page, 1);
    await openEditMode(page);
    const footer = await centerBox(block(page, 0, 'For internal distribution'));

    await page.getByTestId('edit-pdf-add-text').click();
    await expect.poll(async () => (await appState(page)).tool).toBe('edit-add-text');
    await page.mouse.click(footer.x + 10, footer.y - 100);
    const ta = page.getByTestId('edit-pdf-textarea');
    await expect(ta).toBeFocused();
    await page.keyboard.type('Hello from Edit PDF');
    await page.getByTestId('edit-pdf-bold').first().click();
    await expect(ta).toBeFocused();
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await objects(page, 'content-text')).length).toBe(1);
    const [first] = await objects(page, 'content-text');
    expect(first.data.text).toBe('Hello from Edit PDF');
    expect(first.data.style.bold).toBe(true);
    expect(first.pageIndex).toBe(0);

    // drag a width → wrapping box; text outside WinAnsi embeds a font subset
    await page.getByTestId('edit-pdf-add-text').click();
    await drag(page, { x: footer.x + 10, y: footer.y - 55 }, { x: footer.x + 330, y: footer.y - 55 });
    await expect(ta).toBeFocused();
    await page.keyboard.type('Zażółć gęślą jaźń Ωmega');
    await page.getByTestId('edit-pdf-align-center').first().click();
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await objects(page, 'content-text')).length).toBe(2);
    const second = (await objects(page, 'content-text'))[1];
    expect(second.data.style.align).toBe('center');
    expect(second.data.autoWidth ?? false).toBe(false);
    expect(near(second.rect.width, 320, 6)).toBe(true);

    const bytes = await download(page);
    const text = (await inspectPdf(bytes)).pages[0].text;
    expect(text).toContain('Hello from Edit PDF');
    expect(text).toContain('Zażółć gęślą jaźń Ωmega');
    // real page content, not annotations
    const lib = await loadLib(bytes);
    expect(lib.getPages()[0].node.Annots()?.size() ?? 0).toBe(0);

    await reopen(page, bytes, 'edited-text.pdf');
    await openEditMode(page);
    await expect(block(page, 0, 'Hello from Edit PDF')).toBeAttached();
    const again = await centerBox(block(page, 0, 'Zażółć'));
    await page.mouse.click(again.x + again.width / 2, again.y + again.height / 2);
    await expect(ta).toHaveValue('Zażółć gęślą jaźń Ωmega');
    await page.keyboard.press('End');
    await page.keyboard.type(' again');
    await expectNewVersion(page, () => page.keyboard.press('Escape'));
    await expect(ta).toHaveCount(0);
    expect((await inspectPdf(await download(page))).pages[0].text).toContain('Zażółć gęślą jaźń Ωmega again');
  });

  test('Add image: click to place at natural size (fit to the page), drag a rect, undo', async ({ page }) => {
    await openFixture(page, 'sample.pdf');
    await setZoom(page, 1);
    await openEditMode(page);
    const before = await imageDraws(await download(page), 1);
    const footer = await centerBox(block(page, 0, 'For internal distribution'));

    let [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('edit-pdf-add-image').click()]);
    await chooser.setFiles(FIXTURES_DIR + 'sample.png');
    await expect(page.getByTestId('edit-pdf-opt-file')).toContainText('1200×800');
    await page.mouse.click(footer.x + 40, footer.y - 80);
    await expect.poll(async () => (await objects(page, 'content-image')).length).toBe(1);
    const [placed] = await objects(page, 'content-image');
    expect(placed.rect.width).toBeLessThanOrEqual(612);
    expect(near(placed.rect.width / placed.rect.height, 1.5, 0.02)).toBe(true);
    expect(placed.data.mime).toBe('image/png');
    await expect.poll(async () => (await appState(page)).tool).toBe('edit-content');

    // choose → cancel returns to editing
    [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('edit-pdf-add-image').click()]);
    await chooser.setFiles([]);
    await expect.poll(async () => (await appState(page)).tool).toBe('edit-content');

    // JPEG dragged into a rect keeps its aspect ratio
    [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('edit-pdf-add-image').click()]);
    await chooser.setFiles(FIXTURES_DIR + 'sample.jpg');
    await expect(page.getByTestId('edit-pdf-opt-file')).toBeVisible();
    await drag(page, { x: footer.x + 20, y: footer.y - 120 }, { x: footer.x + 220, y: footer.y - 20 });
    await expect.poll(async () => (await objects(page, 'content-image')).length).toBe(2);
    const jpg = (await objects(page, 'content-image'))[1];
    expect(jpg.data.mime).toBe('image/jpeg');
    expect(near(jpg.rect.width / jpg.rect.height, 1600 / 1067, 0.03)).toBe(true);

    expect(await imageDraws(await download(page), 1)).toBe(before + 2);
    await page.keyboard.press('ControlOrMeta+z');
    await expect.poll(async () => (await objects(page, 'content-image')).length).toBe(1);
  });

  test('links: create web / page links, edit, move; export /Link, follow and round trip', async ({ page }) => {
    await openFixture(page, 'sample.pdf');
    await setZoom(page, 1);
    await openEditMode(page);
    const footer = await centerBox(block(page, 0, 'For internal distribution'));
    await page.getByTestId('edit-pdf-add-link').click();
    await expect.poll(async () => (await appState(page)).tool).toBe('edit-link');

    // web link: invalid address is refused, a bare host gets https://
    await drag(page, { x: footer.x, y: footer.y - 110 }, { x: footer.x + 220, y: footer.y - 85 });
    const dialog = page.getByTestId('edit-pdf-link-dialog');
    await expect(dialog).toBeVisible();
    await page.getByTestId('edit-pdf-link-type').selectOption('visible');
    await page.getByTestId('edit-pdf-link-style').selectOption('dashed');
    await page.getByTestId('edit-pdf-link-highlight').selectOption('outline');
    await page.getByTestId('edit-pdf-link-action-url').locator('label').first().click();
    await page.getByTestId('edit-pdf-link-url').fill('not a url');
    await page.getByTestId('edit-pdf-link-ok').click();
    await expect(dialog).toBeVisible();
    await page.getByTestId('edit-pdf-link-url').fill('example.com/docs');
    await page.getByTestId('edit-pdf-link-ok').click();
    await expect(dialog).toHaveCount(0);

    // page link to page 3
    await drag(page, { x: footer.x, y: footer.y - 60 }, { x: footer.x + 180, y: footer.y - 40 });
    await expect(dialog).toBeVisible();
    await page.getByTestId('edit-pdf-link-action-page').locator('label').first().click();
    await page.getByTestId('edit-pdf-link-page').locator('input').fill('3');
    await page.getByTestId('edit-pdf-link-ok').click();
    await expect(dialog).toHaveCount(0);

    await expect.poll(async () => (await objects(page, 'link')).length).toBe(2);
    const [web, toPage] = await objects(page, 'link');
    expect(web.data.action).toEqual({ type: 'url', url: 'https://example.com/docs' });
    expect(toPage.data.action.type).toBe('page');

    // double-click edits the properties (click an empty spot first: the new link's floating bar covers the other one)
    await page.mouse.click(footer.x + 120, footer.y - 20);
    await expect(page.getByTestId('edit-pdf-selection')).toHaveCount(0);
    const webBox = await items(page, 0, 'link-object').first().boundingBox();
    await page.mouse.dblclick(webBox!.x + webBox!.width / 2, webBox!.y + webBox!.height / 2);
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('edit-pdf-link-url')).toHaveValue('https://example.com/docs');
    await page.getByTestId('edit-pdf-link-url').fill('https://pdfwizard.example.org/');
    await page.getByTestId('edit-pdf-link-ok').click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await objects(page, 'link'))[0].data.action.url).toBe('https://pdfwizard.example.org/');

    // drag the middle of the (thin) page link: moves it, keeps its size
    const pageBox = await items(page, 0, 'link-object').nth(1).boundingBox();
    const r0 = (await objects(page, 'link'))[1].rect;
    await page.mouse.click(pageBox!.x + pageBox!.width / 2, pageBox!.y + pageBox!.height / 2);
    await drag(page, { x: pageBox!.x + pageBox!.width / 2, y: pageBox!.y + pageBox!.height / 2 }, { x: pageBox!.x + pageBox!.width / 2 + 30, y: pageBox!.y + pageBox!.height / 2 - 20 });
    await expect.poll(async () => (await objects(page, 'link'))[1].rect.x).not.toBe(r0.x);
    const r1 = (await objects(page, 'link'))[1].rect;
    expect(near(r1.width, r0.width, 0.5) && near(r1.height, r0.height, 0.5)).toBe(true);
    expect(near(r1.x - r0.x, 30, 2) && near(r1.y - r0.y, 20, 2)).toBe(true);

    const bytes = await download(page);
    const links = (await linkAnnots(bytes)).filter((l) => l.page === 0);
    expect(links).toHaveLength(2);
    const w = links.find((l) => l.uri)!;
    expect(w.uri).toBe('https://pdfwizard.example.org/');
    expect(w.dash).toBe('/D');
    expect(w.highlight).toBe('/O');
    expect(w.border?.[2]).toBeGreaterThan(0);
    const p = links.find((l) => !l.uri)!;
    expect(p.destPage).toBe(2);
    expect(p.border).toEqual([0, 0, 0]);

    // links keep working with the Select tool
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.__app.actions.openTask(null));
    await page.evaluate(() => window.__app.actions.setTool('select'));
    await expect(page.locator('.edit-pdf-obj-link.is-live')).toHaveCount(2);
    const pl = await page.locator('.edit-pdf-obj-link.is-live').nth(1).boundingBox();
    await page.mouse.click(pl!.x + pl!.width / 2, pl!.y + pl!.height / 2);
    await expect.poll(async () => (await getDoc(page)).view.currentPage).toBe(2);

    // round trip: the reopened file has editable link objects again
    await reopen(page, bytes, 'links.pdf');
    await openEditMode(page);
    await page.getByTestId('edit-pdf-add-link').click();
    await expect(items(page, 0, 'link')).toHaveCount(2);
  });

  test('existing links: outlined in link mode, moved and deleted as /Link annotations', async ({ page }) => {
    await openFixture(page, 'sample.pdf');
    await setZoom(page, 1);
    await openEditMode(page);
    await page.getByTestId('edit-pdf-add-link').click();
    await page.evaluate(() => window.__app.actions.goToPage(window.__app.getActiveDoc().id, 1));
    await expect(overlay(page, 1)).toHaveAttribute('data-model', 'ready');
    await expect(items(page, 1, 'link')).toHaveCount(10);

    // "1.2 Goals" [90, 586, 542, 605] → drag its middle 40 px down
    const goals = items(page, 1, 'link').nth(2);
    const g = await centerBox(goals);
    await page.mouse.click(g.x + g.width / 2, g.y + g.height / 2);
    await expect(page.getByTestId('edit-pdf-link-section')).toBeVisible();
    await expectNewVersion(page, () => drag(page, { x: g.x + g.width / 2, y: g.y + g.height / 2 }, { x: g.x + g.width / 2, y: g.y + g.height / 2 + 40 }));
    // then delete "1 Introduction"
    const intro = await centerBox(items(page, 1, 'link').first());
    await page.mouse.click(intro.x + intro.width / 2, intro.y + intro.height / 2);
    await expect(page.getByTestId('edit-pdf-selection')).toBeVisible();
    await expectNewVersion(page, () => page.keyboard.press('Delete'));

    const links = (await linkAnnots(await download(page))).filter((l) => l.page === 1);
    expect(links).toHaveLength(9);
    expect(links.some((l) => near(l.rect[1], 626) && near(l.rect[3], 646))).toBe(false);
    const movedGoals = links.find((l) => near(l.rect[1], 546) && near(l.rect[3], 565));
    expect(movedGoals, JSON.stringify(links.map((l) => l.rect))).toBeTruthy();
    expect(movedGoals!.destPage).toBe(2);
  });

  test('non-Latin text in a standard-font block: the font is kept, characters no font has are left out with a notice', async ({ page }) => {
    await openFixture(page, 'sample.pdf');
    await setZoom(page, 1);
    await openEditMode(page);
    const original = await bytesHash(page);
    const fontsBefore = await pageFonts(await download(page), 0);
    expect(fontsBefore).toContain('Times-Roman');

    const b = await centerBox(block(page, 0, 'PDF Wizard brings the core'));
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    const ta = page.getByTestId('edit-pdf-textarea');
    await expect(ta).toBeFocused();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('Zoë — 日本語 Ελληνικά in a serif paragraph');
    await expectNewVersion(page, () => page.keyboard.press('Escape'));
    await expect(ta).toHaveCount(0);
    // CJK: no available font has the glyphs → left out, and the user is told so (no tofu)
    await expect(page.getByTestId('toast').filter({ hasText: 'left out' })).toContainText('日');

    const bytes = await download(page);
    const text = (await inspectPdf(bytes)).pages[0].text;
    expect(text).toContain('Zoë — Ελληνικά in a serif paragraph');
    expect(text).not.toContain('日');
    expect(text).toContain('Abstract');
    // Latin text stays in Times; only the Greek falls back to the embedded Unicode font
    const fonts = await pageFonts(bytes, 0);
    expect(fonts).toContain('Times-Roman');
    expect(fonts.some((f) => /LiberationSans/.test(f))).toBe(true);

    // the block can be edited again and is still recognised as serif text
    const again = await centerBox(block(page, 0, 'Zoë'));
    await page.mouse.click(again.x + again.width / 2, again.y + again.height / 2);
    await expect(ta).toHaveValue(/^Zoë — +Ελληνικά in a serif paragraph$/);
    expect(await selectValue(page.getByTestId('edit-pdf-font-family').first())).toBe('serif');
    await page.keyboard.press('Escape');
    await expect(ta).toHaveCount(0);

    await expectNewVersion(page, () => page.keyboard.press('ControlOrMeta+z'));
    expect(await bytesHash(page)).toBe(original);
  });

  test('replacing an image keeps it selected; undo restores the original', async ({ page }) => {
    await openFixture(page, 'images.pdf');
    await setZoom(page, 0.5);
    await openEditMode(page);
    const original = await bytesHash(page);
    const b = await centerBox(items(page, 0, 'image').first());
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    await expect(page.getByTestId('edit-pdf-selection')).toBeVisible();

    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('edit-pdf-obj-replace').click()]);
    await expectNewVersion(page, () => chooser.setFiles(FIXTURES_DIR + 'sample.png'));
    await expect(items(page, 0, 'image')).toHaveCount(1);
    await expect(page.getByTestId('edit-pdf-selection')).toBeVisible();
    await expect(page.getByTestId('edit-pdf-objects')).toBeVisible();
    // the replacement fits the old box and keeps its own aspect ratio (1200×800)
    const r = await items(page, 0, 'image').first().boundingBox();
    expect(near(r!.width / r!.height, 1.5, 0.05)).toBe(true);
    expect(await imageDraws(await download(page), 1)).toBe(1);

    // still selected: the next operation applies to the new image
    await expectNewVersion(page, () => page.getByTestId('edit-pdf-obj-flip-h').click());
    for (let i = 0; i < 2; i++) await expectNewVersion(page, () => page.keyboard.press('ControlOrMeta+z'));
    expect(await bytesHash(page)).toBe(original);
  });

  test('pages deleted or moved while the text editor is open: the edit follows its page', async ({ page }) => {
    await openFixture(page, 'sample.pdf');
    await setZoom(page, 0.75);
    await openEditMode(page);
    await page.evaluate(() => window.__app.actions.goToPage(window.__app.getActiveDoc().id, 2));
    await expect(overlay(page, 2)).toHaveAttribute('data-model', 'ready');

    const b = await centerBox(block(page, 2, 'PDF Wizard takes a different'));
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    const ta = page.getByTestId('edit-pdf-textarea');
    await expect(ta).toBeFocused();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('Typed while page one was deleted');

    // page 1 is deleted underneath the open editor (thumbnails / Organize pages do the same)
    await page.evaluate(async () => window.__engine.deletePages(window.__app.getActiveDoc().id, [0]));
    await expect.poll(async () => (await getDoc(page)).pageIds.length).toBe(5);
    await expect(overlay(page, 1).getByTestId('edit-pdf-textarea')).toBeVisible();
    await expect(ta).toHaveValue('Typed while page one was deleted');
    await expectNewVersion(page, () => page.keyboard.press('Escape'));
    await expect(ta).toHaveCount(0);

    const info = await inspectPdf(await download(page));
    expect(info.numPages).toBe(5);
    expect(info.pages[1].text).toContain('Typed while page one was deleted');
    expect(info.pages[1].text).not.toContain('takes a different approach');

    // pages reversed while editing: the editor moves along to the new index (1 → 3)
    let c = await centerBox(block(page, 1, 'Typed while page one'));
    await page.mouse.click(c.x + c.width / 2, c.y + c.height / 2);
    await expect(ta).toBeFocused();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('Typed while the pages were reversed');
    await page.evaluate(async () => window.__engine.movePages(window.__app.getActiveDoc().id, [4, 3, 2, 1, 0]));
    await expect(overlay(page, 3).getByTestId('edit-pdf-textarea')).toBeAttached();
    await expectNewVersion(page, () => page.keyboard.press('Escape'));
    await expect(ta).toHaveCount(0);
    const reversed = await inspectPdf(await download(page));
    expect(reversed.pages[3].text).toContain('Typed while the pages were reversed');
    expect(reversed.pages[3].text).not.toContain('page one was deleted');

    // the page being edited is removed: the editor closes with a notice
    c = await centerBox(block(page, 3, 'Typed while the pages'));
    await page.mouse.click(c.x + c.width / 2, c.y + c.height / 2);
    await expect(ta).toBeFocused();
    await page.keyboard.type(' more');
    await page.evaluate(async () => window.__engine.deletePages(window.__app.getActiveDoc().id, [3]));
    await expect(ta).toHaveCount(0);
    await expect(page.getByTestId('toast').filter({ hasText: 'page you were editing was removed' })).toBeVisible();
    const after = await inspectPdf(await download(page));
    expect(after.numPages).toBe(4);
    expect(after.pages.map((p) => p.text).join(' ')).not.toContain('Typed while the pages');
  });

  test('link dialog: cancel, Esc and an empty address create nothing', async ({ page }) => {
    await openFixture(page, 'sample.pdf');
    await setZoom(page, 1);
    await openEditMode(page);
    const footer = await centerBox(block(page, 0, 'For internal distribution'));
    await page.getByTestId('edit-pdf-add-link').click();
    const dialog = page.getByTestId('edit-pdf-link-dialog');

    await drag(page, { x: footer.x, y: footer.y - 110 }, { x: footer.x + 200, y: footer.y - 85 });
    await expect(dialog).toBeVisible();
    await page.getByTestId('edit-pdf-link-cancel').click();
    await expect(dialog).toHaveCount(0);

    await drag(page, { x: footer.x, y: footer.y - 110 }, { x: footer.x + 200, y: footer.y - 85 });
    await expect(dialog).toBeVisible();
    await page.getByTestId('edit-pdf-link-action-url').locator('label').first().click();
    await page.getByTestId('edit-pdf-link-url').fill('   ');
    await page.getByTestId('edit-pdf-link-ok').click();
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    // Esc closed only the dialog, not the tool
    expect((await appState(page)).tool).toBe('edit-link');

    // a click without a drag doesn't open the dialog
    await page.mouse.click(footer.x + 50, footer.y - 100);
    await expect(dialog).toHaveCount(0);
    expect(await objects(page, 'link')).toHaveLength(0);
    expect((await getDoc(page)).version).toBe(1);
  });

  test('read-only documents show a notice and cannot be edited', async ({ page }) => {
    await openFixture(page, 'sample.pdf');
    await page.evaluate(async () => {
      const url = performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.includes('/core/engine/state.ts'));
      if (!url) throw new Error('engine state module not found');
      const st = await import(/* @vite-ignore */ url);
      const d = window.__app.getActiveDoc();
      st.setReadOnly(d.id, { reason: 'test', password: '', bytes: d.bytes });
    });
    await openEditMode(page);
    await expect(page.getByTestId('edit-pdf-readonly')).toBeVisible();
    await expect(page.getByTestId('edit-pdf-add-text')).toBeDisabled();
    const b = await centerBox(block(page, 0, 'PDF Wizard brings the core'));
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    await expect(page.getByTestId('edit-pdf-textarea')).toHaveCount(0);
    expect((await getDoc(page)).version).toBe(1);
  });
});
