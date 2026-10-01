/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * Fill & Sign: the task panel and toolbar, Add text / Date / symbols, the signature and initials
 * manager (type, draw, saved per user), AcroForm filling helpers (count, Next/Previous, Tab, highlight,
 * clear) and the flattened export (real text, vector paths, images).
 */
import fs from 'node:fs';
import type { Page } from '@playwright/test';
import {
  FIXTURES_DIR, captureDownload, engineOp, expect, expectNewVersion, fetchLibraryBytes, getDoc, inspectPdf, loadLib, loadPdfjsNode, openFixture, openPdfjs, test,
  waitForPagesRendered,
} from './helpers';

const TOOLBAR = ['fill-text', 'fill-cross', 'fill-check', 'fill-dot', 'fill-line', 'fill-circle', 'fill-date', 'fill-signature', 'fill-initials'];
const NO_FIELDS = 'This document has no fillable form fields — click anywhere to add text';

const viewer = (page: Page) => page.getByTestId('document-viewer');
const pageEl = (page: Page, index: number) => viewer(page).locator(`[data-testid=page][data-page-index="${index}"]`);
const layer = (page: Page, index = 0) => pageEl(page, index).locator('.annotationLayer');

interface FillObj {
  id: string;
  kind: string;
  pageIndex: number;
  rect: { x: number; y: number; width: number; height: number };
  color?: string;
  data: Record<string, unknown>;
}

/** Fill & Sign items of the active document, in stacking order. */
function fillObjects(page: Page): Promise<FillObj[]> {
  return page.evaluate(() => {
    const d = window.__app.getActiveDoc();
    return d.order
      .map((id: string) => d.objects[id])
      .filter((o: any) => o && ['fill-text', 'fill-mark', 'signature'].includes(o.kind))
      .map((o: any) => ({
        id: o.id,
        kind: o.kind,
        pageIndex: d.pages.findIndex((p: any) => p.id === o.pageId),
        rect: { ...o.rect },
        color: o.color,
        data: { ...o.data, src: o.data.src ? 'image' : undefined },
      }));
  });
}

const historyLabels = (page: Page): Promise<string[]> =>
  page.evaluate(() => window.__app.getActiveDoc().history.past.map((p: any) => p.label));
const activeTool = (page: Page): Promise<string> => page.evaluate(() => window.__app.useApp.getState().activeToolId);
const selection = (page: Page): Promise<string[]> => page.evaluate(() => [...window.__app.getActiveDoc().selection]);

/** Opens the task from the All tools list (falls back to the store action when the list is not showing). */
async function openFillSign(page: Page) {
  const tile = page.locator('[data-testid=task-tile][data-task-id=fill-sign]').first();
  if (await tile.isVisible()) await tile.click();
  else await page.evaluate(() => window.__app.actions.openTask('fill-sign'));
  await expect(page.getByTestId('fill-sign-panel')).toBeVisible();
}

/**
 * Client coordinates of the point at fractions (fx, fy) of a page's displayed box, after scrolling it
 * near the vertical middle of the viewer (away from the floating page controls and toasts).
 */
async function pagePoint(page: Page, index: number, fx: number, fy: number) {
  const el = pageEl(page, index);
  // Pages far from the viewport are not mounted: navigate there first.
  if (!(await el.count())) await page.evaluate((i) => window.__app.actions.goToPage(window.__app.getActiveDoc().id, i), index);
  await el.scrollIntoViewIfNeeded();
  const scroller = viewer(page).locator('.pdfwizard-scroller').first();
  for (let i = 0; i < 4; i++) {
    const b = (await el.boundingBox())!;
    const s = (await scroller.boundingBox())!;
    const x = b.x + b.width * fx;
    const y = b.y + b.height * fy;
    const mid = s.y + s.height * 0.45;
    if (Math.abs(y - mid) < s.height * 0.2) return { x, y };
    await scroller.evaluate((node, d) => node.scrollBy(0, d), y - mid);
    await page.waitForTimeout(150);
  }
  const b = (await el.boundingBox())!;
  return { x: b.x + b.width * fx, y: b.y + b.height * fy };
}

/** Client point of a PDF user-space point on an unrotated page. */
async function pdfPoint(page: Page, index: number, x: number, y: number) {
  const size = await page.evaluate((i) => {
    const p = window.__app.getActiveDoc().pages[i];
    return { w: p.width, h: p.height };
  }, index);
  return pagePoint(page, index, x / size.w, 1 - y / size.h);
}

/** Makes `id` the active tool (the toolbar chips toggle, so only click when it is not active yet). */
async function useTool(page: Page, id: string) {
  if ((await activeTool(page)) !== id) await page.getByTestId(`tool-chip-${id}`).click();
  await expect.poll(() => activeTool(page)).toBe(id);
}

async function clickAt(page: Page, p: { x: number; y: number }) {
  await page.mouse.move(p.x - 4, p.y - 4);
  await page.mouse.move(p.x, p.y);
  await page.mouse.click(p.x, p.y);
}

async function drag(page: Page, from: { x: number; y: number }, dx: number, dy: number) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx / 2, from.y + dy / 2, { steps: 4 });
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 4 });
  await page.mouse.up();
}

async function center(page: Page, testId: string) {
  const b = (await page.getByTestId(testId).boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

/** Path / image / text drawing operations of a page (pdf.js operator list, form XObjects included). */
async function pageOps(bytes: Uint8Array, pageNo: number) {
  const pdfjs = await loadPdfjsNode();
  const { doc, close } = await openPdfjs(bytes);
  const ol = await (await doc.getPage(pageNo)).getOperatorList();
  const count = (...ops: number[]) => ol.fnArray.filter((f) => ops.includes(f)).length;
  const res = {
    paths: count(pdfjs.OPS.constructPath),
    images: count(pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject, pdfjs.OPS.paintImageMaskXObject),
  };
  await close();
  return res;
}

const fixtureBytes = (name: string) => new Uint8Array(fs.readFileSync(FIXTURES_DIR + name));

async function typeSignature(page: Page, name: string, style = 'brush') {
  await expect(page.getByTestId('modal')).toBeVisible();
  await page.getByTestId('fill-sign-sig-tab-type').click();
  await page.getByTestId('fill-sign-sig-name').fill(name);
  await page.getByTestId(`fill-sign-sig-style-${style}`).click();
  await expect(page.getByTestId('fill-sign-sig-preview')).toContainText(name);
  await page.getByTestId('fill-sign-sig-done').click();
  await expect(page.getByTestId('modal')).toHaveCount(0);
}

// ── task, toolbar, no-fields hint ─────────────────────────────────────────────

test('Fill & Sign opens with its toolbar; a document without fields says so and starts Add text', async ({ page }) => {
  await openFixture(page, 'sample.pdf');
  await openFillSign(page);
  await expect(page.getByTestId('toast').filter({ hasText: NO_FIELDS })).toBeVisible();
  await expect.poll(() => activeTool(page)).toBe('fill-text');
  for (const id of TOOLBAR) await expect(page.getByTestId(`tool-chip-${id}`)).toBeAttached();
  await expect(page.getByTestId('quick-tool-fill-text')).toBeAttached();
  await expect(page.getByTestId('quick-tool-fill-signature')).toBeAttached();
  await expect(page.getByTestId('fill-sign-forms')).toHaveCount(0);
  await expect(page.getByTestId('fill-sign-add-signature')).toBeVisible();
  await expect(page.getByTestId('fill-sign-add-initials')).toBeVisible();
  // Panel tool buttons toggle the tools.
  await page.getByTestId('fill-sign-add-fill-check').click();
  await expect.poll(() => activeTool(page)).toBe('fill-check');
  await expect(page.getByTestId('fill-sign-add-fill-check')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('fill-sign-add-fill-check').click();
  await expect.poll(() => activeTool(page)).toBe('select');
});

// ── Add text ──────────────────────────────────────────────────────────────────

test('Add text: type in place with new lines, change the size, undo / redo, exported as real text', async ({ page }) => {
  await openFixture(page, 'sample.pdf');
  await openFillSign(page);
  await expect.poll(() => activeTool(page)).toBe('fill-text');

  await clickAt(page, await pdfPoint(page, 0, 90, 150));
  const input = page.getByTestId('fill-sign-text-input');
  await expect(input).toBeFocused();
  await page.keyboard.type('Hello Fill');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Second line');
  await page.getByTestId('fill-sign-text-larger').click();
  await expect(page.getByTestId('fill-sign-text-size')).toHaveText(/14/);
  await expect(input).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(input).toHaveCount(0);

  let objs = await fillObjects(page);
  expect(objs).toHaveLength(1);
  expect(objs[0]).toMatchObject({ kind: 'fill-text', pageIndex: 0, data: { text: 'Hello Fill\nSecond line', fontSize: 14 } });
  // The text starts at the click point (left edge) and grows downwards.
  expect(Math.abs(objs[0].rect.x - 90)).toBeLessThan(6);
  expect(objs[0].rect.y + objs[0].rect.height).toBeGreaterThan(150);
  expect(await historyLabels(page)).toEqual(['Add text', 'Change font size']);

  await page.getByTestId('undo').click();
  await expect.poll(async () => (await fillObjects(page))[0]?.data.fontSize).toBe(12);
  await page.getByTestId('undo').click();
  await expect.poll(async () => (await fillObjects(page)).length).toBe(0);
  await page.getByTestId('redo').click();
  await page.getByTestId('redo').click();
  await expect.poll(async () => (await fillObjects(page))[0]?.data.fontSize).toBe(14);

  // Clicking the text with the Add text tool edits it again; an empty new text leaves no trace.
  objs = await fillObjects(page);
  await clickAt(page, await pdfPoint(page, 0, 300, 120));
  await expect(input).toBeFocused();
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await fillObjects(page)).length).toBe(1);
  expect(await historyLabels(page)).toEqual(['Add text', 'Change font size']);

  const { bytes } = await captureDownload(page, () => page.getByTestId('download').click());
  const text = (await inspectPdf(bytes)).pages[0].text;
  expect(text).toContain('Hello Fill');
  expect(text).toContain('Second line');
  // Flattened into the page: no annotations were added.
  const lib = await loadLib(bytes);
  expect(lib.getPage(0).node.Annots()?.size() ?? 0).toBe(0);
});

test('Add text mini toolbar: color, letter spacing (comb), delete', async ({ page }) => {
  await openFixture(page, 'sample.pdf');
  await openFillSign(page);
  await clickAt(page, await pdfPoint(page, 0, 90, 150));
  await page.keyboard.type('12345');
  await page.getByTestId('fill-sign-text-color').locator('button').first().click();
  await page.locator('.color-popover [aria-label="#1473e6"]').first().click();
  await expect.poll(async () => (await fillObjects(page))[0]?.color).toBe('#1473e6');
  await page.getByTestId('fill-sign-text-spacing').click();
  await page.getByRole('menuitemcheckbox', { name: '10 pt' }).click();
  await expect.poll(async () => (await fillObjects(page))[0]?.data.letterSpacing).toBe(10);
  // The comb spacing widens the box; typing continues in place.
  await expect(page.getByTestId('fill-sign-text-input')).toBeFocused();
  await page.keyboard.type('6');
  const [t] = await fillObjects(page);
  expect(t.data.text).toBe('123456');
  expect(t.rect.width).toBeGreaterThan(6 * 10);
  expect(await historyLabels(page)).toEqual(['Add text', 'Change text color', 'Change letter spacing', 'Edit text']);

  const { bytes } = await captureDownload(page, () => page.getByTestId('download').click());
  const { doc, close } = await openPdfjs(bytes);
  try {
    const p1 = await doc.getPage(1);
    const items = (await p1.getTextContent()).items as { str: string; transform: number[] }[];
    const digits = items.filter((it) => /^[1-6]+$/.test(it.str.trim())).map((it) => it.str.trim()).join('');
    expect(digits).toBe('123456');
    // Blue fill color in the content stream.
    const pdfjs = await loadPdfjsNode();
    const ol = await p1.getOperatorList();
    const fills = ol.fnArray.flatMap((f, i) => (f === pdfjs.OPS.setFillRGBColor ? [ol.argsArray[i]] : []));
    expect(fills.map((a) => String(a[0]).toLowerCase())).toContain('#1473e6');
  } finally {
    await close();
  }

  // The Delete button of the selection bar removes the text (it stays selected after editing ends).
  await page.locator('[aria-label="Selection properties"]').getByRole('button', { name: 'Delete', exact: true }).click();
  await expect.poll(async () => (await fillObjects(page)).length).toBe(0);
});

test('Date inserts today in the chosen format', async ({ page }) => {
  await openFixture(page, 'sample.pdf');
  await openFillSign(page);
  await useTool(page, 'fill-date');
  await page.getByTestId('fill-sign-date-format').selectOption('ymd');
  await clickAt(page, await pdfPoint(page, 0, 90, 140));
  const today = await page.evaluate(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  await expect.poll(async () => (await fillObjects(page))[0]?.data.text).toBe(today);
  await page.getByTestId('fill-sign-date-format').selectOption('long');
  await clickAt(page, await pdfPoint(page, 0, 300, 140));
  await expect.poll(async () => (await fillObjects(page))[1]?.data.text).toMatch(/^[A-Z][a-z]+ \d{1,2}, \d{4}$/);
  expect(await historyLabels(page)).toEqual(['Add date', 'Add date']);
});

// ── symbols ───────────────────────────────────────────────────────────────────

test('Symbols: placed at the click point, resize rules, move, context menu, exported as vector paths', async ({ page }) => {
  await openFixture(page, 'sample.pdf');
  await openFillSign(page);

  // Check mark: centered on the click, resizing keeps the aspect ratio.
  await useTool(page, 'fill-check');
  await clickAt(page, await pdfPoint(page, 0, 120, 150));
  let [check] = await fillObjects(page);
  expect(check).toMatchObject({ kind: 'fill-mark', data: { mark: 'check' } });
  expect(Math.abs(check.rect.x + check.rect.width / 2 - 120)).toBeLessThan(2);
  expect(Math.abs(check.rect.y + check.rect.height / 2 - 150)).toBeLessThan(2);
  const w0 = check.rect.width;
  await drag(page, await center(page, 'fill-sign-handle-se'), 40, 8);
  [check] = await fillObjects(page);
  expect(check.rect.width).toBeGreaterThan(w0 * 1.5);
  expect(Math.abs(check.rect.width / check.rect.height - 1)).toBeLessThan(0.02);

  // Line: only horizontal handles, height never changes.
  await useTool(page, 'fill-line');
  await clickAt(page, await pdfPoint(page, 0, 250, 150));
  await expect(page.getByTestId('fill-sign-handle-e')).toBeVisible();
  await expect(page.getByTestId('fill-sign-handle-n')).toHaveCount(0);
  await expect(page.getByTestId('fill-sign-handle-se')).toHaveCount(0);
  let line = (await fillObjects(page))[1];
  const lw = line.rect.width;
  const lh = line.rect.height;
  await drag(page, await center(page, 'fill-sign-handle-e'), 60, 30);
  line = (await fillObjects(page))[1];
  expect(line.rect.width).toBeGreaterThan(lw + 20);
  expect(line.rect.height).toBeCloseTo(lh, 3);

  // Circle: free resize.
  await useTool(page, 'fill-circle');
  await clickAt(page, await pdfPoint(page, 0, 400, 150));
  await drag(page, await center(page, 'fill-sign-handle-se'), 60, 0);
  const circle = (await fillObjects(page))[2];
  expect(circle.data.mark).toBe('circle');
  expect(circle.rect.width / circle.rect.height).toBeGreaterThan(1.5);

  await useTool(page, 'fill-cross');
  await clickAt(page, await pdfPoint(page, 0, 480, 150));
  await useTool(page, 'fill-dot');
  await clickAt(page, await pdfPoint(page, 0, 530, 150));
  expect((await fillObjects(page)).map((o) => o.data.mark)).toEqual(['check', 'line', 'circle', 'cross', 'dot']);

  // Drag an item to move it (while a fill tool is active); undo puts it back.
  check = (await fillObjects(page))[0];
  const from = await pdfPoint(page, 0, check.rect.x + check.rect.width / 2, check.rect.y + check.rect.height / 2);
  await drag(page, from, 0, 60);
  const moved = (await fillObjects(page))[0];
  expect(moved.rect.y).toBeLessThan(check.rect.y - 10);
  expect(moved.rect.x).toBeCloseTo(check.rect.x, 3);
  expect((await historyLabels(page)).at(-1)).toBe('Move');
  await page.getByTestId('undo').click();
  await expect.poll(async () => (await fillObjects(page))[0].rect.y).toBeCloseTo(check.rect.y, 3);

  // Context menu on the page (task open) adds a check mark; on an item it offers the symbol changes.
  const cm = await pdfPoint(page, 0, 300, 110);
  await page.mouse.click(cm.x, cm.y, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Add check mark here' }).click();
  await expect.poll(async () => (await fillObjects(page)).length).toBe(6);
  const added = (await fillObjects(page))[5];
  expect(Math.abs(added.rect.x + added.rect.width / 2 - 300)).toBeLessThan(2);
  const onDot = await pdfPoint(page, 0, 530, 150);
  await page.mouse.click(onDot.x, onDot.y, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Change to check mark' }).click();
  await expect.poll(async () => (await fillObjects(page))[4].data.mark).toBe('check');

  // Delete with the keyboard.
  await page.keyboard.press('Delete');
  await expect.poll(async () => (await fillObjects(page)).length).toBe(5);

  const before = await pageOps(fixtureBytes('sample.pdf'), 1);
  const { bytes } = await captureDownload(page, () => page.getByTestId('download').click());
  const after = await pageOps(bytes, 1);
  expect(after.paths).toBeGreaterThanOrEqual(before.paths + 5);
  expect(after.images).toBe(before.images);
});

// ── signatures ────────────────────────────────────────────────────────────────

test('Signatures and initials: type and draw, placed with a ghost, recolored, saved per user, exported as images', async ({ page }) => {
  await openFixture(page, 'sample.pdf');
  await openFillSign(page);

  await page.getByTestId('fill-sign-add-signature').click();
  await typeSignature(page, 'Jane Doe');
  await expect.poll(() => activeTool(page)).toBe('fill-signature');
  await expect(page.getByTestId('fill-sign-saved-signature-0')).toBeVisible();

  const p = await pdfPoint(page, 0, 300, 150);
  await page.mouse.move(p.x - 10, p.y - 10);
  await page.mouse.move(p.x, p.y);
  await expect(viewer(page).locator('.fill-sign-ghost-sig')).toBeVisible();
  await page.mouse.click(p.x, p.y);
  await expect.poll(async () => (await fillObjects(page)).length).toBe(1);
  const [sig] = await fillObjects(page);
  expect(sig).toMatchObject({ kind: 'signature', data: { role: 'signature', source: 'type', recolorable: true } });
  expect(Math.abs(sig.rect.x + sig.rect.width / 2 - 300)).toBeLessThan(2);
  // One-shot: back to the select tool with the signature selected.
  await expect.poll(() => activeTool(page)).toBe('select');
  expect(await selection(page)).toEqual([sig.id]);

  // Recolor through the properties bar.
  await page.getByTestId('fill-sign-sig-color').locator('button').first().click();
  await page.locator('.color-popover [aria-label="#1a3fb3"]').first().click();
  await expect.poll(async () => (await fillObjects(page))[0].color).toBe('#1a3fb3');

  // Resize keeps the aspect ratio (core handles with the select tool).
  const ratio = sig.rect.width / sig.rect.height;
  const handle = viewer(page).locator('.pdfwizard-handle[data-handle=se]').first();
  const hb = (await handle.boundingBox())!;
  await drag(page, { x: hb.x + hb.width / 2, y: hb.y + hb.height / 2 }, 60, 0);
  const resized = (await fillObjects(page))[0];
  expect(resized.rect.width).toBeGreaterThan(sig.rect.width + 10);
  expect(Math.abs(resized.rect.width / resized.rect.height - ratio)).toBeLessThan(0.05);

  // Initials, drawn in red.
  await page.getByTestId('fill-sign-add-initials').click();
  await expect(page.getByTestId('modal')).toBeVisible();
  await page.getByTestId('fill-sign-sig-tab-draw').click();
  await expect(page.getByTestId('fill-sign-sig-done')).toBeDisabled();
  const pad = (await page.getByTestId('fill-sign-sig-pad').boundingBox())!;
  await page.mouse.move(pad.x + 60, pad.y + 120);
  await page.mouse.down();
  for (let i = 1; i <= 24; i++) await page.mouse.move(pad.x + 60 + i * 10, pad.y + 120 - Math.sin(i / 3) * 40, { steps: 2 });
  await page.mouse.up();
  await page.getByTestId('fill-sign-sig-color-red').click();
  await expect(page.getByTestId('fill-sign-sig-done')).toBeEnabled();
  await page.getByTestId('fill-sign-sig-done').click();
  await expect.poll(() => activeTool(page)).toBe('fill-initials');
  await clickAt(page, await pdfPoint(page, 0, 450, 110));
  await expect.poll(async () => (await fillObjects(page)).length).toBe(2);
  const initials = (await fillObjects(page))[1];
  expect(initials).toMatchObject({ kind: 'signature', color: '#c8102e', data: { role: 'initials', source: 'draw' } });
  expect(await historyLabels(page)).toEqual(expect.arrayContaining(['Add signature', 'Add initials']));

  const stored = await page.evaluate(() => {
    const key = Object.keys(localStorage).find((k) => k.startsWith('pdfwizard.fillSign.signatures:'));
    return key ? JSON.parse(localStorage.getItem(key)!) : null;
  });
  expect(stored?.signature).toHaveLength(1);
  expect(stored?.initials).toHaveLength(1);

  const before = await pageOps(fixtureBytes('sample.pdf'), 1);
  const { bytes } = await captureDownload(page, () => page.getByTestId('download').click());
  const after = await pageOps(bytes, 1);
  expect(after.images).toBe(before.images + 2);
  expect((await inspectPdf(bytes)).pages[0].text).not.toContain('Jane Doe');

  // Saved signatures survive a reload and can be placed again or deleted.
  await page.reload();
  await openFixture(page, 'sample.pdf');
  await openFillSign(page);
  await page.getByTestId('fill-sign-saved-signature-0').click();
  await expect.poll(() => activeTool(page)).toBe('fill-signature');
  await clickAt(page, await pdfPoint(page, 0, 300, 150));
  await expect.poll(async () => (await fillObjects(page)).length).toBe(1);
  await page.getByTestId('fill-sign-delete-signature-0').click();
  await page.getByTestId('dialog-confirm').click();
  await expect(page.getByTestId('fill-sign-saved-signature-0')).toHaveCount(0);
  await expect(page.getByTestId('fill-sign-saved-initials-0')).toBeVisible();
  // Placed items are not affected.
  expect(await fillObjects(page)).toHaveLength(1);
});

test('Signature placement can be cancelled and read from the Image tab errors', async ({ page }) => {
  await openFixture(page, 'sample.pdf');
  await openFillSign(page);
  // No saved signature: the tool opens the manager; cancelling returns to the select tool.
  await useTool(page, 'fill-signature');
  await expect(page.getByTestId('modal')).toBeVisible();
  await page.getByTestId('fill-sign-sig-tab-image').click();
  await page.getByTestId('fill-sign-sig-image-input').setInputFiles(FIXTURES_DIR + 'sample.txt');
  await expect(page.getByTestId('fill-sign-sig-image-error')).toBeVisible();
  await page.getByTestId('fill-sign-sig-image-input').setInputFiles(FIXTURES_DIR + 'sample.png');
  await expect(page.getByTestId('fill-sign-sig-image-preview').locator('img')).toBeVisible();
  await expect(page.getByTestId('fill-sign-sig-done')).toBeEnabled();
  await page.getByTestId('fill-sign-sig-cancel').click();
  await expect(page.getByTestId('modal')).toHaveCount(0);
  await expect.poll(() => activeTool(page)).toBe('select');
  expect(await fillObjects(page)).toHaveLength(0);
});

// ── forms ─────────────────────────────────────────────────────────────────────

test('form.pdf: field count, Next / Previous and Tab through fields, highlight, values persist, clear form', async ({ page }) => {
  await openFixture(page, 'form.pdf');
  await openFillSign(page);
  await expect(page.getByTestId('fill-sign-field-count')).toHaveText('11 form fields');
  await expect(page.getByTestId('toast').filter({ hasText: NO_FIELDS })).toHaveCount(0);
  expect(await activeTool(page)).toBe('select');

  const focusedName = () => page.evaluate(() => (document.activeElement as HTMLInputElement | null)?.name ?? null);
  await page.getByTestId('fill-sign-field-next').click();
  await expect.poll(focusedName).toBe('full_name');
  await page.keyboard.type('Jane Doe');
  await page.keyboard.press('Tab');
  await expect.poll(focusedName).toBe('email');
  await page.keyboard.type('jane@example.com');
  await page.keyboard.press('Shift+Tab');
  await expect.poll(focusedName).toBe('full_name');
  // Previous from the first field wraps to the last one.
  await page.getByTestId('fill-sign-field-prev').click();
  await expect.poll(focusedName).toBe('date');
  await page.getByTestId('fill-sign-field-next').click();
  await expect.poll(focusedName).toBe('full_name');

  // Highlight fields (on by default): turning it off removes the field backgrounds.
  const plain = () => page.evaluate(() => document.documentElement.classList.contains('fill-sign-fields-plain'));
  expect(await plain()).toBe(false);
  await page.getByTestId('fill-sign-highlight').locator('label').click();
  await expect.poll(plain).toBe(true);
  await page.getByTestId('fill-sign-highlight').locator('label').click();
  await expect.poll(plain).toBe(false);

  await expect.poll(async () => (await getDoc(page)).dirty).toBe(true);
  let { bytes } = await captureDownload(page, () => page.getByTestId('download').click());
  let form = (await loadLib(bytes)).getForm();
  expect(form.getTextField('full_name').getText()).toBe('Jane Doe');
  expect(form.getTextField('email').getText()).toBe('jane@example.com');

  await page.getByTestId('fill-sign-clear-form').click();
  await page.getByTestId('dialog-confirm').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Form cleared' })).toBeVisible();
  await waitForPagesRendered(page);
  await expect(layer(page).locator('input[name=full_name]')).toHaveValue('');
  await expect(layer(page).locator('input[name=email]')).toHaveValue('');
  expect((await historyLabels(page)).at(-1)).toBe('Clear form');
  ({ bytes } = await captureDownload(page, () => page.getByTestId('download').click()));
  form = (await loadLib(bytes)).getForm();
  expect(form.getTextField('full_name').getText() ?? '').toBe('');
  expect(form.getTextField('email').getText() ?? '').toBe('');

  // Undo brings the entered values back.
  await page.getByTestId('undo').click();
  await waitForPagesRendered(page);
  await expect(layer(page).locator('input[name=full_name]')).toHaveValue('Jane Doe');
  await expect(layer(page).locator('input[name=email]')).toHaveValue('jane@example.com');
});

test('form.pdf: with Add text active, clicks on fields fill them and clicks elsewhere add text', async ({ page }) => {
  await openFixture(page, 'form.pdf');
  await openFillSign(page);
  await useTool(page, 'fill-text');
  const email = layer(page).locator('input[name=email]');
  await email.scrollIntoViewIfNeeded();
  const eb = (await email.boundingBox())!;
  await clickAt(page, { x: eb.x + 20, y: eb.y + eb.height / 2 });
  await expect(email).toBeFocused();
  await page.keyboard.type('typed@example.com');
  await expect(email).toHaveValue('typed@example.com');
  expect(await fillObjects(page)).toHaveLength(0);

  // Blank area above the email label.
  await clickAt(page, { x: eb.x + 20, y: eb.y - 45 });
  await expect(page.getByTestId('fill-sign-text-input')).toBeFocused();
  await page.keyboard.type('Extra note');
  await page.keyboard.press('Escape');
  expect((await fillObjects(page)).map((o) => o.data.text)).toEqual(['Extra note']);

  const { bytes } = await captureDownload(page, () => page.getByTestId('download').click());
  expect((await loadLib(bytes)).getForm().getTextField('email').getText()).toBe('typed@example.com');
  expect((await inspectPdf(bytes)).pages[0].text).toContain('Extra note');
});

test('read-only documents: the panel says so and nothing can be placed', async ({ page }) => {
  await openFixture(page, 'sample.pdf');
  // Documents that cannot be decrypted for editing are flagged by the engine when opened; flag this one
  // through the engine's own module (same instance as the app's, found among the loaded dev modules).
  const flagged = await page.evaluate(async () => {
    const url = performance.getEntriesByType('resource').map((e) => e.name).find((n) => n.includes('/core/engine/state.ts'));
    if (!url) return false;
    const m = await import(/* @vite-ignore */ url);
    const id = window.__app.getActiveDoc().id;
    m.setReadOnly(id, { reason: 'test', password: '', bytes: new Uint8Array() });
    return window.__engine.isReadOnly(id) as boolean;
  });
  expect(flagged).toBe(true);
  await openFillSign(page);
  await expect(page.getByTestId('fill-sign-readonly')).toBeVisible();
  await expect(page.getByTestId('fill-sign-add-fill-text')).toBeDisabled();
  await expect(page.getByTestId('fill-sign-add-signature')).toBeDisabled();
  // No "click anywhere" hint and no automatic Add text.
  await expect(page.getByTestId('toast').filter({ hasText: NO_FIELDS })).toHaveCount(0);
  expect(await activeTool(page)).toBe('select');

  await useTool(page, 'fill-check');
  await clickAt(page, await pdfPoint(page, 0, 200, 150));
  await expect(page.getByTestId('toast').filter({ hasText: 'read-only' })).toBeVisible();
  expect(await fillObjects(page)).toHaveLength(0);
  const p = await pdfPoint(page, 0, 200, 150);
  await page.mouse.click(p.x, p.y, { button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Add text here' })).toHaveCount(0);
  await page.keyboard.press('Escape');
});

// ── rotation, zoom, dark theme, large documents ───────────────────────────────

test('rotated pages: items are placed upright and exported upright', async ({ page }) => {
  await openFixture(page, 'rotated.pdf');
  await openFillSign(page);
  await useTool(page, 'fill-text');
  for (const [index, label] of [[1, 'Upright ninety'], [2, 'Upright oneeighty'], [3, 'Upright twoseventy']] as const) {
    await clickAt(page, await pagePoint(page, index, 0.2, 0.3));
    await expect(page.getByTestId('fill-sign-text-input')).toBeFocused();
    await page.keyboard.type(label);
    await page.keyboard.press('Escape');
  }
  await useTool(page, 'fill-line');
  await clickAt(page, await pagePoint(page, 1, 0.5, 0.5));
  // On a /Rotate 90 page the line is horizontal on screen: east / west handles.
  await expect(page.getByTestId('fill-sign-handle-e')).toBeVisible();
  const objs = await fillObjects(page);
  expect(objs.map((o) => [o.pageIndex, o.data.rot])).toEqual([[1, 90], [2, 180], [3, 270], [1, 90]]);
  // In user space a line on a 90° page is vertical.
  expect(objs[3].rect.height).toBeGreaterThan(objs[3].rect.width);

  const { bytes } = await captureDownload(page, () => page.getByTestId('download').click());
  const { doc, close } = await openPdfjs(bytes);
  try {
    for (const [pageNo, label, fixtureLabel] of [[2, 'Upright ninety', 'Page 2'], [3, 'Upright oneeighty', 'Page 3'], [4, 'Upright twoseventy', 'Page 4']] as const) {
      const items = (await (await doc.getPage(pageNo)).getTextContent()).items as { str: string; transform: number[] }[];
      const mine = items.find((it) => it.str.includes(label));
      const ref = items.find((it) => it.str.trim() === fixtureLabel);
      expect(mine, label).toBeTruthy();
      expect(ref, fixtureLabel).toBeTruthy();
      // Same orientation as the fixture's upright label.
      expect(mine!.transform.slice(0, 4).map(Math.sign)).toEqual(ref!.transform.slice(0, 4).map(Math.sign));
    }
  } finally {
    await close();
  }
});

test('zoom and dark theme: placed sizes do not depend on the zoom level', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => window.__app.actions.setPrefs({ theme: 'dark' }));
  await openFixture(page, 'sample.pdf');
  await openFillSign(page);
  const sizes: number[] = [];
  for (const [zoom, x] of [[0.5, 100], [1, 250], [2, 400]] as const) {
    await page.evaluate((z) => window.__app.actions.setZoom(window.__app.getActiveDoc().id, z), zoom);
    await waitForPagesRendered(page);
    await useTool(page, 'fill-check');
    await clickAt(page, await pdfPoint(page, 0, x, 150));
    await expect.poll(async () => (await fillObjects(page)).length).toBe(sizes.length + 1);
    const o = (await fillObjects(page)).at(-1)!;
    expect(Math.abs(o.rect.x + o.rect.width / 2 - x)).toBeLessThan(2);
    sizes.push(o.rect.width);
  }
  expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThan(0.01);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});

test('large.pdf: add text on a far page and download', async ({ page }) => {
  await openFixture(page, 'large.pdf');
  await openFillSign(page);
  await page.evaluate(() => window.__app.actions.goToPage(window.__app.getActiveDoc().id, 199));
  await expect(pageEl(page, 199)).toBeVisible();
  await useTool(page, 'fill-text');
  await clickAt(page, await pagePoint(page, 199, 0.15, 0.2));
  await expect(page.getByTestId('fill-sign-text-input')).toBeFocused();
  await page.keyboard.type('Reviewed on page 200');
  await page.keyboard.press('Escape');
  expect((await fillObjects(page)).map((o) => [o.pageIndex, o.data.text])).toEqual([[199, 'Reviewed on page 200']]);
  const { bytes } = await captureDownload(page, () => page.getByTestId('download').click());
  const pdf = await inspectPdf(bytes);
  expect(pdf.numPages).toBe(300);
  expect(pdf.pages[199].text).toContain('Reviewed on page 200');
  expect(pdf.pages[198].text).not.toContain('Reviewed on page 200');
});

// ── regressions ───────────────────────────────────────────────────────────────

test('non-Latin text: Greek embeds a font subset, CJK stays extractable over an image', async ({ page }) => {
  await openFixture(page, 'sample.pdf');
  await openFillSign(page);
  const input = page.getByTestId('fill-sign-text-input');
  await clickAt(page, await pdfPoint(page, 0, 90, 150));
  await expect(input).toBeFocused();
  await page.keyboard.type('Zoë Ελληνικά');
  await page.keyboard.press('Escape');
  await clickAt(page, await pdfPoint(page, 0, 90, 110));
  await expect(input).toBeFocused();
  await page.keyboard.type('Zoë — 日本語 Ελληνικά');
  await page.keyboard.press('Escape');
  expect((await fillObjects(page)).map((o) => o.data.text)).toEqual(['Zoë Ελληνικά', 'Zoë — 日本語 Ελληνικά']);

  const before = await pageOps(fixtureBytes('sample.pdf'), 1);
  const { bytes } = await captureDownload(page, () => page.getByTestId('download').click());
  const text = (await inspectPdf(bytes)).pages[0].text;
  expect(text).toContain('Zoë Ελληνικά');
  expect(text).toContain('日本語');
  // Only the CJK line needed an image; the Greek one is real text in an embedded TrueType subset.
  expect((await pageOps(bytes, 1)).images).toBe(before.images + 1);
  const lib = await loadLib(bytes);
  const embedded = lib.context.enumerateIndirectObjects().filter(([, o]) => String(o).includes('/FontFile2'));
  expect(embedded.length).toBeGreaterThanOrEqual(1);
});

test('long text stays on the page while typing and when enlarged', async ({ page }) => {
  await openFixture(page, 'sample.pdf');
  await openFillSign(page);
  await clickAt(page, await pdfPoint(page, 0, 520, 150));
  await expect(page.getByTestId('fill-sign-text-input')).toBeFocused();
  await page.keyboard.type('A rather long line of text typed near the right edge of the page');
  let [t] = await fillObjects(page);
  expect(t.rect.x).toBeGreaterThanOrEqual(0);
  expect(t.rect.x + t.rect.width).toBeLessThanOrEqual(612 + 0.01);
  for (let i = 0; i < 4; i++) await page.getByTestId('fill-sign-text-larger').click();
  [t] = await fillObjects(page);
  expect(t.data.fontSize).toBeGreaterThan(12);
  expect(t.rect.x + t.rect.width).toBeLessThanOrEqual(612 + 0.01);
  await page.keyboard.press('Escape');
  const { bytes } = await captureDownload(page, () => page.getByTestId('download').click());
  expect((await inspectPdf(bytes)).pages[0].text).toContain('right edge of the page');
});

test('the task toolbar and the options of the active tool fit without scrolling', async ({ page }) => {
  await openFixture(page, 'sample.pdf');
  await openFillSign(page);
  for (const width of [1440, 1100]) {
    await page.setViewportSize({ width, height: 900 });
    await useTool(page, 'fill-date');
    const format = page.getByTestId('fill-sign-date-format');
    await expect(format).toBeVisible();
    const fits = await page.locator('.tool-options').first().evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
    expect(fits, `tool options fit at ${width}px`).toBe(true);
    const b = (await format.boundingBox())!;
    expect(b.x + b.width).toBeLessThanOrEqual(width);
    for (const id of TOOLBAR) await expect(page.getByTestId(`tool-chip-${id}`)).toBeInViewport();
  }
});

test('Clear form also resets check boxes, radio buttons and choices, in one undoable step', async ({ page }) => {
  await openFixture(page, 'form.pdf');
  await openFillSign(page);
  const l = layer(page);
  await l.locator('input[name=full_name]').fill('Jane Doe');
  await l.locator('input[type=checkbox][name=newsletter]').check();
  await l.locator('input[type=radio][name=contact_method]').nth(1).check();
  await l.locator('select[name=country]').selectOption('Canada');

  await page.getByTestId('fill-sign-clear-form').click();
  await page.getByTestId('dialog-confirm').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Form cleared' })).toBeVisible();
  await waitForPagesRendered(page);
  await expect(l.locator('input[name=full_name]')).toHaveValue('');
  await expect(l.locator('input[type=checkbox][name=newsletter]')).not.toBeChecked();
  for (const r of await l.locator('input[type=radio][name=contact_method]').all()) await expect(r).not.toBeChecked();
  await expect(l.locator('select[name=country]')).not.toHaveValue('Canada');
  const labels = await historyLabels(page);
  expect(labels.at(-1)).toBe('Clear form');
  expect(labels.filter((x) => x === 'Clear form')).toHaveLength(1);

  const { bytes } = await captureDownload(page, () => page.getByTestId('download').click());
  const form = (await loadLib(bytes)).getForm();
  expect(form.getTextField('full_name').getText() ?? '').toBe('');
  expect(form.getCheckBox('newsletter').isChecked()).toBe(false);
  expect(form.getRadioGroup('contact_method').getSelected()).toBeUndefined();
  expect(form.getDropdown('country').getSelected()).not.toContain('Canada');

  // A second Clear form on an empty form only says so.
  await page.getByTestId('fill-sign-clear-form').click();
  await page.getByTestId('dialog-confirm').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'already empty' })).toBeVisible();

  await page.getByTestId('undo').click();
  await waitForPagesRendered(page);
  await expect(l.locator('input[name=full_name]')).toHaveValue('Jane Doe');
  await expect(l.locator('input[type=checkbox][name=newsletter]')).toBeChecked();
  await expect(l.locator('input[type=radio][name=contact_method]').nth(1)).toBeChecked();
  await expect(l.locator('select[name=country]')).toHaveValue('Canada');
});

test('dark theme: form fields keep dark text on the white page', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => window.__app.actions.setPrefs({ theme: 'dark' }));
  await openFixture(page, 'form.pdf');
  await openFillSign(page);
  const l = layer(page);
  await expect(l.locator('select[multiple]')).toBeVisible();
  // The list box has no /DA colour of its own: it used to inherit the app's light text colour.
  for (const sel of ['select[multiple]', 'select[name=country]', 'input[name=full_name]', 'textarea[name=comments]']) {
    const rgb = await l.locator(sel).first().evaluate((el) => getComputedStyle(el).color.match(/\d+/g)!.slice(0, 3).map(Number));
    expect(Math.max(...rgb), `${sel} text is dark`).toBeLessThan(80);
  }
  const scheme = await l.locator('select[multiple]').evaluate((el) => getComputedStyle(el).colorScheme);
  expect(scheme).toBe('light');
});

test('typed signatures: the context menu recolors the ink, undoable', async ({ page }) => {
  await openFixture(page, 'sample.pdf');
  await openFillSign(page);
  await page.getByTestId('fill-sign-add-signature').click();
  await typeSignature(page, 'Zoë Ελληνικά', 'snell');
  await clickAt(page, await pdfPoint(page, 0, 300, 150));
  await expect.poll(async () => (await fillObjects(page)).length).toBe(1);
  const [sig] = await fillObjects(page);
  expect(sig.color).toBe('#000000');
  const obj = viewer(page).locator(`.pdfwizard-obj[data-obj-id="${sig.id}"]`);
  await obj.scrollIntoViewIfNeeded();
  const b = (await obj.boundingBox())!;
  await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2, { button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Black ink' })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Blue ink' }).click();
  await expect.poll(async () => (await fillObjects(page))[0].color).toBe('#1a3fb3');
  expect((await historyLabels(page)).at(-1)).toBe('Change signature color');
  await page.getByTestId('undo').click();
  await expect.poll(async () => (await fillObjects(page))[0].color).toBe('#000000');
});

test('page operations carry the items along; undo restores them', async ({ page }) => {
  await openFixture(page, 'sample.pdf');
  await openFillSign(page);
  for (const [i, label] of [[0, 'On first'], [1, 'On second']] as const) {
    await useTool(page, 'fill-text');
    await clickAt(page, await pagePoint(page, i, 0.2, 0.2));
    await expect(page.getByTestId('fill-sign-text-input')).toBeFocused();
    await page.keyboard.type(label);
    await page.keyboard.press('Escape');
  }
  await useTool(page, 'fill-check');
  await clickAt(page, await pagePoint(page, 1, 0.8, 0.2));
  const where = async () =>
    (await fillObjects(page)).map((o) => `${o.pageIndex}:${o.kind === 'fill-text' ? o.data.text : o.data.mark}`).sort();
  expect(await where()).toEqual(['0:On first', '1:On second', '1:check']);

  await engineOp(page, 'movePagesTo', [1], 0);
  expect(await where()).toEqual(['0:On second', '0:check', '1:On first']);
  await engineOp(page, 'rotatePages', [0], 90);
  await engineOp(page, 'deletePages', [1]);
  expect(await where()).toEqual(['0:On second', '0:check']);

  const { bytes } = await captureDownload(page, () => page.getByTestId('download').click());
  const pdf = await inspectPdf(bytes);
  expect(pdf.numPages).toBe(5);
  expect(pdf.pages[0].rotation).toBe(90);
  expect(pdf.pages[0].text).toContain('On second');
  expect(pdf.pages.map((p) => p.text).join(' ')).not.toContain('On first');

  await expectNewVersion(page, () => page.getByTestId('undo').click());
  expect(await where()).toEqual(['0:On second', '0:check', '1:On first']);
});

test('Save to the library: items are flattened into the saved file, form values kept, still editable here', async ({ page }) => {
  await openFixture(page, 'form.pdf');
  await openFillSign(page);
  await layer(page).locator('input[name=full_name]').fill('Zoë Ελληνικά');
  await useTool(page, 'fill-text');
  await clickAt(page, await pagePoint(page, 0, 0.6, 0.12));
  await expect(page.getByTestId('fill-sign-text-input')).toBeFocused();
  await page.keyboard.type('Saved note');
  await page.keyboard.press('Escape');
  await page.getByTestId('save').click();
  await expect(page.getByTestId('doc-status')).toHaveAttribute('data-state', 'saved');
  const d = await getDoc(page);
  const bytes = await fetchLibraryBytes(page, d.fileId!);
  expect((await inspectPdf(bytes)).pages[0].text).toContain('Saved note');
  expect((await loadLib(bytes)).getForm().getTextField('full_name').getText()).toBe('Zoë Ελληνικά');
  // The open document keeps the item as an editable object.
  expect((await fillObjects(page)).map((o) => o.data.text)).toEqual(['Saved note']);
});
