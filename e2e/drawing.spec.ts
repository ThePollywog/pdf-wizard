/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * Drawing markup, shapes, stamps and measuring: the Draw & shapes / Stamp / Measure tasks, freehand
 * ink (merge window, highlighter, eraser), rectangles/ovals/lines/arrows/polygons/clouds with their
 * properties and vertex handles, stamps (standard, dynamic, sign here, custom, context menu),
 * measurements with a drawing scale, importing existing annotations, rotated pages / zoom / dark
 * theme and the exported annotations (/Ink /Square /Circle /Line /PolyLine /Polygon /Stamp with
 * appearance streams), including a download → reopen round trip.
 */
import type { Page } from '@playwright/test';
import {
  decodePDFRawStream, PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, PDFString, type PDFObject,
} from '@cantoo/pdf-lib';
import { FIXTURES_DIR, captureDownload, expect, getDoc, inspectPdf, loadLib, openFixture, test, waitForDocReady, waitForPagesRendered } from './helpers';

const DRAWING_KINDS = ['ink', 'shape', 'line', 'poly', 'stamp', 'measure'];
const TASK_TOOLS = ['draw-pen', 'draw-highlighter', 'draw-eraser', 'shape-rect', 'shape-ellipse', 'shape-line', 'shape-arrow', 'shape-polyline', 'shape-polygon', 'shape-cloud'];

interface Pt {
  x: number;
  y: number;
}
interface DrawObj {
  id: string;
  kind: string;
  pageIndex: number;
  rect: { x: number; y: number; width: number; height: number };
  color?: string | null;
  fillColor?: string | null;
  opacity?: number;
  strokeWidth?: number;
  data: any;
}

// ── app state ────────────────────────────────────────────────────────────────

const viewer = (page: Page) => page.getByTestId('document-viewer');
const pageEl = (page: Page, index: number) => viewer(page).locator(`[data-testid=page][data-page-index="${index}"]`);
const activeTool = (page: Page): Promise<string> => page.evaluate(() => window.__app.useApp.getState().activeToolId);
const selection = (page: Page): Promise<string[]> => page.evaluate(() => [...window.__app.getActiveDoc().selection]);

/** Drawing objects of the active document in stacking order (image payloads stripped). */
function drawings(page: Page): Promise<DrawObj[]> {
  return page.evaluate((kinds) => {
    const d = window.__app.getActiveDoc();
    return d.order
      .map((id: string) => d.objects[id])
      .filter((o: any) => o && kinds.includes(o.kind))
      .map((o: any) => ({
        id: o.id,
        kind: o.kind,
        pageIndex: d.pages.findIndex((p: any) => p.id === o.pageId),
        rect: { ...o.rect },
        color: o.color,
        fillColor: o.fillColor,
        opacity: o.opacity,
        strokeWidth: o.strokeWidth,
        data: JSON.parse(
          JSON.stringify({
            ...o.data,
            image: o.data.image ? { w: o.data.image.w, h: o.data.image.h } : undefined,
            pdf: o.data.pdf ? 'pdf' : undefined,
            preserved: o.data.preserved ? 'preserved' : undefined,
          }),
        ),
      }));
  }, DRAWING_KINDS);
}
const ofKind = async (page: Page, kind: string) => (await drawings(page)).filter((o) => o.kind === kind);
const countKind = async (page: Page, kind: string) => (await ofKind(page, kind)).length;

/** Opens a task from the All tools list (or through the store when the list is not showing). */
async function openTask(page: Page, id: string, panel: string) {
  const item = page.locator(`[data-testid=tools-list-item][data-task-id=${id}]`).first();
  if (await item.isVisible()) await item.click();
  else await page.evaluate((t) => window.__app.actions.openTask(t), id);
  await expect(page.getByTestId(panel)).toBeVisible();
}

/** Plain-key shortcuts are ignored while focus is in a toolbar or field: move focus back to the page. */
async function blur(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
}
async function pressShortcut(page: Page, key: string, tool: string) {
  await blur(page);
  await page.keyboard.press(key);
  await expect.poll(() => activeTool(page)).toBe(tool);
}
async function chooseTool(page: Page, id: string) {
  await page.getByTestId(`tool-chip-${id}`).click();
  await expect.poll(() => activeTool(page)).toBe(id);
}
async function pickMenu(page: Page, trigger: string, item: string) {
  await page.getByTestId(trigger).click();
  await page.locator(`[data-menu-id="${item}"]`).click();
}
async function pickColor(page: Page, control: string, hex: string) {
  await page.getByTestId(control).locator('button').first().click();
  const popover = page.locator('.color-popover');
  await popover.locator(`[aria-label="${hex}"]`).click();
  await expect(popover).toHaveCount(0);
}

/** The merge window of freehand strokes uses Date.now(): shift the page clock instead of sleeping. */
async function shiftClock(page: Page, ms: number) {
  await page.evaluate((offset) => {
    const w = window as unknown as { __realNow?: () => number };
    const real = (w.__realNow ??= Date.now.bind(Date));
    Date.now = () => real() + offset;
  }, ms);
}

// ── coordinates ──────────────────────────────────────────────────────────────

/** Client position of PDF user-space points on a page (honours page + view rotation). */
function rawClient(page: Page, index: number, pts: Pt[]): Promise<Pt[]> {
  return page.evaluate(
    ({ index, pts }) => {
      const d = window.__app.getActiveDoc();
      const pg = d.pages[index];
      const el = document.querySelector(`[data-testid=document-viewer] [data-testid=page][data-page-index="${index}"]`)!;
      const b = el.getBoundingClientRect();
      const rot = ((((pg.rotation || 0) + (d.view.rotation || 0)) % 360) + 360) % 360;
      const [x0, y0, x1, y1] = pg.view;
      return pts.map(({ x, y }) => {
        const u = (x - x0) / (x1 - x0);
        const v = (y1 - y) / (y1 - y0);
        const [fx, fy] = rot === 0 ? [u, v] : rot === 90 ? [1 - v, u] : rot === 180 ? [1 - u, 1 - v] : [v, 1 - u];
        return { x: b.left + fx * b.width, y: b.top + fy * b.height };
      });
    },
    { index, pts },
  );
}

/** Scrolls the page so that all points are inside the viewer (clear of the floating controls). */
async function clientPoints(page: Page, index: number, pts: Pt[]): Promise<Pt[]> {
  const el = pageEl(page, index);
  if (!(await el.count())) await page.evaluate((i) => window.__app.actions.goToPage(window.__app.getActiveDoc().id, i), index);
  await expect(el).toHaveClass(/is-painted/);
  const scroller = viewer(page).locator('.pdfwizard-scroller').first();
  for (let i = 0; i < 6; i++) {
    const c = await rawClient(page, index, pts);
    const s = (await scroller.boundingBox())!;
    const ys = c.map((p) => p.y);
    const lo = Math.min(...ys), hi = Math.max(...ys);
    const top = s.y + 80, bottom = s.y + s.height - 120;
    if (lo >= top && hi <= bottom) return c;
    const dy = (lo + hi) / 2 - (top + bottom) / 2;
    await scroller.evaluate((n, d) => n.scrollBy(0, d), dy);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))));
  }
  return rawClient(page, index, pts);
}
const clientPoint = async (page: Page, index: number, p: Pt) => (await clientPoints(page, index, [p]))[0];

async function drag(page: Page, pts: Pt[], opts: { shift?: boolean; steps?: number } = {}) {
  if (opts.shift) await page.keyboard.down('Shift');
  await page.mouse.move(pts[0].x, pts[0].y);
  await page.mouse.down();
  for (const p of pts.slice(1)) await page.mouse.move(p.x, p.y, { steps: opts.steps ?? 5 });
  await page.mouse.up();
  if (opts.shift) await page.keyboard.up('Shift');
}
/** Drag through PDF points of one page. */
async function dragPdf(page: Page, index: number, pts: Pt[], opts: { shift?: boolean; steps?: number } = {}) {
  await drag(page, await clientPoints(page, index, pts), opts);
}
/** Click PDF points one after the other (polygon vertices). */
async function clickPdf(page: Page, index: number, pts: Pt[]) {
  for (const c of await clientPoints(page, index, pts)) await page.mouse.click(c.x, c.y);
}

const near = (a: number, b: number, tol = 2) => Math.abs(a - b) <= tol;
const expectNear = (a: number, b: number, tol = 2) => expect(Math.abs(a - b), `${a} ≈ ${b}`).toBeLessThanOrEqual(tol);

// ── PDF inspection ──────────────────────────────────────────────────────────

interface Annot {
  page: number;
  subtype: string;
  rect: number[];
  get(key: string): PDFObject | undefined;
  nums(key: string, from?: PDFDict): number[] | undefined;
  name(key: string, from?: PDFDict): string | undefined;
  text(key: string, from?: PDFDict): string | undefined;
  dict(key: string, from?: PDFDict): PDFDict | undefined;
  names(key: string): string[];
  /** Decoded normal appearance stream content. */
  ap: string;
  /** Names of the appearance's XObjects mapped to their /Subtype. */
  xobjects: Record<string, string>;
  /** Object references of the appearance's XObjects ("12 0 R"). */
  xobjectRefs: string[];
  /** /BM entries of the appearance's ExtGStates. */
  blendModes: string[];
}

async function annotations(bytes: Uint8Array, opts: { password?: string } = {}): Promise<Annot[]> {
  const doc = await loadLib(bytes, opts);
  const deref = (o: PDFObject | undefined) => (o instanceof PDFRef ? doc.context.lookup(o) : o);
  const out: Annot[] = [];
  doc.getPages().forEach((p, pageIndex) => {
    const arr = p.node.Annots();
    if (!arr) return;
    for (let k = 0; k < arr.size(); k++) {
      const a = deref(arr.get(k));
      if (!(a instanceof PDFDict)) continue;
      const get = (key: string, from: PDFDict = a) => deref(from.get(PDFName.of(key)));
      const nums = (key: string, from: PDFDict = a) => {
        const v = get(key, from);
        if (!(v instanceof PDFArray)) return undefined;
        return v.asArray().map((x) => deref(x)).filter((x): x is PDFNumber => x instanceof PDFNumber).map((x) => x.asNumber());
      };
      const name = (key: string, from: PDFDict = a) => {
        const v = get(key, from);
        return v instanceof PDFName ? v.decodeText() : undefined;
      };
      const text = (key: string, from: PDFDict = a) => {
        const v = get(key, from);
        return v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : undefined;
      };
      const dict = (key: string, from: PDFDict = a) => {
        const v = get(key, from);
        if (v instanceof PDFArray) {
          const f = deref(v.get(0));
          return f instanceof PDFDict ? f : undefined;
        }
        return v instanceof PDFDict ? v : undefined;
      };
      const names = (key: string) => {
        const v = get(key);
        return v instanceof PDFArray ? v.asArray().map((x) => (deref(x) instanceof PDFName ? (deref(x) as PDFName).decodeText() : '')) : [];
      };
      let ap = '';
      const xobjects: Record<string, string> = {};
      const xobjectRefs: string[] = [];
      const blendModes: string[] = [];
      const apDict = get('AP');
      const n = apDict instanceof PDFDict ? get('N', apDict) : undefined;
      if (n instanceof PDFStream) {
        if (n instanceof PDFRawStream) ap = Buffer.from(decodePDFRawStream(n).decode()).toString('latin1');
        const res = get('Resources', n.dict);
        if (res instanceof PDFDict) {
          const xo = get('XObject', res);
          if (xo instanceof PDFDict) for (const [kname, v] of xo.entries()) {
            if (v instanceof PDFRef) xobjectRefs.push(v.toString());
            const s = deref(v);
            xobjects[kname.decodeText()] = s instanceof PDFStream ? (name('Subtype', s.dict) ?? '') : '';
          }
          const gs = get('ExtGState', res);
          if (gs instanceof PDFDict) for (const [, v] of gs.entries()) {
            const g = deref(v);
            const bm = g instanceof PDFDict ? name('BM', g) : undefined;
            if (bm) blendModes.push(bm);
          }
        }
      }
      out.push({ page: pageIndex, subtype: name('Subtype') ?? '', rect: nums('Rect') ?? [], get: (key) => get(key), nums, name, text, dict, names, ap, xobjects, xobjectRefs, blendModes });
    }
  });
  return out;
}
const rgb255 = (c: number[] | undefined) => (c ?? []).map((v) => Math.round(v * 255));

async function download(page: Page) {
  const { bytes } = await captureDownload(page, () => page.getByTestId('download').click());
  return bytes;
}

/** Opens downloaded bytes as a new document through the real file input. */
async function reopen(page: Page, bytes: Uint8Array, name: string) {
  await page.getByTestId('open-file-input').setInputFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
  await waitForDocReady(page, name);
  await waitForPagesRendered(page);
}

async function flattenedBytes(page: Page): Promise<Uint8Array> {
  const arr = await page.evaluate(async () => {
    const b: Uint8Array = await window.__engine.exportPdf(window.__app.getActiveDoc().id, { purpose: 'download', flatten: true });
    return Array.from(b);
  });
  return new Uint8Array(arr);
}

const undo = (page: Page) => page.getByTestId('undo').click();
const redo = (page: Page) => page.getByTestId('redo').click();

// ── tests ────────────────────────────────────────────────────────────────────

test.describe('drawing', () => {
  test('Draw & shapes task: toolbar, shortcuts, pen strokes merge, undo/redo and /Ink export', async ({ page }) => {
    await openFixture(page, 'sample.pdf');
    await expect(page.getByTestId('quick-tool-draw-pen')).toBeVisible();
    await openTask(page, 'drawing', 'drawing-draw-panel');
    for (const id of TASK_TOOLS) {
      await expect(page.getByTestId(`tool-chip-${id}`)).toBeVisible();
      await expect(page.getByTestId(`drawing-panel-tool-${id}`)).toBeVisible();
    }
    await expect(page.getByTestId('drawing-panel-summary')).toContainText('No drawing markups');

    for (const [key, tool] of [['r', 'shape-rect'], ['o', 'shape-ellipse'], ['l', 'shape-line'], ['a', 'shape-arrow'], ['m', 'measure-distance'], ['d', 'draw-pen']]) {
      await pressShortcut(page, key, tool);
    }
    await expect(page.getByTestId('drawing-options-pen')).toBeVisible();
    await expect(pageEl(page, 0).getByTestId('drawing-overlay-pen')).toBeVisible();

    // Two quick strokes become one ink annotation with two paths.
    await dragPdf(page, 0, [{ x: 100, y: 420 }, { x: 160, y: 440 }, { x: 250, y: 420 }]);
    await expect.poll(() => countKind(page, 'ink')).toBe(1);
    await dragPdf(page, 0, [{ x: 100, y: 400 }, { x: 170, y: 380 }, { x: 250, y: 400 }]);
    await expect.poll(async () => (await ofKind(page, 'ink'))[0]?.data.paths.length).toBe(2);
    // A stroke elsewhere inside the merge window (~1.5 s) joins as well.
    await dragPdf(page, 0, [{ x: 400, y: 200 }, { x: 450, y: 230 }, { x: 500, y: 200 }]);
    await expect.poll(async () => (await ofKind(page, 'ink'))[0]?.data.paths.length).toBe(3);
    const [ink] = await ofKind(page, 'ink');
    expect(ink.pageIndex).toBe(0);
    expect(ink.color).toBe('#e34850');
    expect(ink.strokeWidth).toBe(2);
    const p0 = ink.data.paths[0];
    expect(near(p0[0].x, 100) && near(p0[0].y, 420), JSON.stringify(p0[0])).toBe(true);
    expect(near(p0.at(-1).x, 250) && near(p0.at(-1).y, 420), JSON.stringify(p0.at(-1))).toBe(true);

    // After the merge window a stroke that doesn't touch the drawing starts a new annotation…
    await shiftClock(page, 5000);
    await dragPdf(page, 0, [{ x: 100, y: 150 }, { x: 150, y: 120 }, { x: 200, y: 150 }]);
    await expect.poll(() => countKind(page, 'ink')).toBe(2);
    // …while one overlapping it still merges.
    await shiftClock(page, 10_000);
    await dragPdf(page, 0, [{ x: 120, y: 140 }, { x: 180, y: 140 }]);
    await expect.poll(async () => (await ofKind(page, 'ink'))[1]?.data.paths.length).toBe(2);
    await expect(pageEl(page, 0).getByTestId('drawing-obj-ink')).toHaveCount(2);
    await expect(page.getByTestId('drawing-panel-summary')).toHaveText('2 drawings');

    // Undo/redo walk through the merged strokes.
    await undo(page);
    await expect.poll(async () => (await ofKind(page, 'ink'))[1]?.data.paths.length).toBe(1);
    await undo(page);
    await expect.poll(() => countKind(page, 'ink')).toBe(1);
    await undo(page);
    await expect.poll(async () => (await ofKind(page, 'ink'))[0]?.data.paths.length).toBe(2);
    await redo(page);
    await redo(page);
    await expect.poll(() => countKind(page, 'ink')).toBe(2);
    await redo(page);
    await expect.poll(async () => (await ofKind(page, 'ink'))[1]?.data.paths.length).toBe(2);

    // Switching tools ends the merge window too.
    await pressShortcut(page, 'v', 'select');
    await pressShortcut(page, 'd', 'draw-pen');
    await dragPdf(page, 0, [{ x: 400, y: 120 }, { x: 450, y: 100 }, { x: 500, y: 120 }]);
    await expect.poll(() => countKind(page, 'ink')).toBe(3);

    const inks = (await annotations(await download(page))).filter((a) => a.subtype === 'Ink');
    expect(inks).toHaveLength(3);
    const big = inks.find((a) => (a.get('InkList') as PDFArray).size() === 3)!;
    expect(big, 'ink with three strokes').toBeTruthy();
    expect(rgb255(big.nums('C'))).toEqual([227, 72, 80]);
    // Smoothed curves with round caps and joins.
    expect(big.ap).toMatch(/ c\b/);
    expect(big.ap).toMatch(/\b1 J\b/);
    expect(big.ap).toMatch(/\b1 j\b/);
    expect(big.rect[0]).toBeLessThanOrEqual(100);
    expect(big.rect[2]).toBeGreaterThanOrEqual(500);
  });

  test('highlighter multiplies, the eraser splits strokes or removes whole ones', async ({ page }) => {
    await openFixture(page, 'sample.pdf');
    await openTask(page, 'drawing', 'drawing-draw-panel');

    await chooseTool(page, 'draw-highlighter');
    await expect(page.getByTestId('drawing-options-highlighter')).toBeVisible();
    await dragPdf(page, 0, [{ x: 100, y: 560 }, { x: 300, y: 560 }]);
    await expect.poll(() => countKind(page, 'ink')).toBe(1);
    const [hl] = await ofKind(page, 'ink');
    expect(hl.data.highlight).toBe(true);
    expect(hl.opacity).toBe(0.6);
    expect(hl.strokeWidth).toBe(12);
    await expect(pageEl(page, 0).getByTestId('drawing-obj-ink-blend')).toHaveCount(1);
    const blend = await pageEl(page, 0).locator('.drawing-blend-layer').evaluate((el) => getComputedStyle(el).mixBlendMode);
    expect(blend).toBe('multiply');

    await chooseTool(page, 'draw-pen');
    await dragPdf(page, 0, [{ x: 100, y: 480 }, { x: 200, y: 480 }, { x: 300, y: 480 }]);
    await expect.poll(() => countKind(page, 'ink')).toBe(2);

    // Partial erase splits the pen stroke in two.
    await chooseTool(page, 'draw-eraser');
    await expect(page.getByTestId('drawing-options-eraser')).toBeVisible();
    await dragPdf(page, 0, [{ x: 200, y: 500 }, { x: 200, y: 460 }], { steps: 8 });
    await expect.poll(async () => (await ofKind(page, 'ink')).find((o) => !o.data.highlight)?.data.paths.length).toBe(2);
    const pen = (await ofKind(page, 'ink')).find((o) => !o.data.highlight)!;
    const [left, right] = pen.data.paths as Pt[][];
    expect(Math.max(...left.map((p) => p.x))).toBeLessThan(200);
    expect(Math.min(...right.map((p) => p.x))).toBeGreaterThan(200);

    // Whole-stroke mode removes the highlighter annotation entirely.
    await page.getByTestId('drawing-opt-eraser-mode').getByRole('radio', { name: 'Whole stroke' }).click();
    await dragPdf(page, 0, [{ x: 250, y: 580 }, { x: 250, y: 540 }], { steps: 8 });
    await expect.poll(async () => (await ofKind(page, 'ink')).filter((o) => o.data.highlight).length).toBe(0);
    await undo(page);
    await expect.poll(async () => (await ofKind(page, 'ink')).filter((o) => o.data.highlight).length).toBe(1);

    const inks = (await annotations(await download(page))).filter((a) => a.subtype === 'Ink');
    expect(inks).toHaveLength(2);
    const hla = inks.find((a) => a.blendModes.includes('Multiply'))!;
    expect(hla, 'highlighter ink uses a Multiply ExtGState').toBeTruthy();
    expect(hla.nums('CA')?.[0] ?? (hla.get('CA') as PDFNumber).asNumber()).toBeCloseTo(0.6, 2);
    const pena = inks.find((a) => a !== hla)!;
    expect((pena.get('InkList') as PDFArray).size()).toBe(2);
  });

  test('rectangles and ovals: Shift constrains, properties bar edits, resize, /Square /Circle export', async ({ page }) => {
    await openFixture(page, 'sample.pdf');
    await pressShortcut(page, 'r', 'shape-rect');
    await expect(page.getByTestId('drawing-options-shape')).toBeVisible();
    await dragPdf(page, 0, [{ x: 100, y: 300 }, { x: 250, y: 200 }]);
    await expect.poll(() => countKind(page, 'shape')).toBe(1);
    const [rect] = await ofKind(page, 'shape');
    expect(rect.data.type).toBe('rect');
    expectNear(rect.rect.x, 100);
    expectNear(rect.rect.y, 200);
    expectNear(rect.rect.width, 150);
    expectNear(rect.rect.height, 100);
    // One-shot tool: back to Select with the new shape selected and its properties bar showing.
    await expect.poll(() => activeTool(page)).toBe('select');
    expect(await selection(page)).toEqual([rect.id]);
    await expect(page.getByTestId('drawing-props-shape')).toBeVisible();
    await pickMenu(page, 'drawing-prop-style', 'drawing-style-cloudy');
    await expect.poll(async () => (await ofKind(page, 'shape'))[0].data.style).toBe('cloudy');
    await pickMenu(page, 'drawing-prop-width', 'drawing-w-3');
    await expect.poll(async () => (await ofKind(page, 'shape'))[0].strokeWidth).toBe(3);

    // Shift + drag draws a circle.
    await pressShortcut(page, 'o', 'shape-ellipse');
    await dragPdf(page, 0, [{ x: 320, y: 300 }, { x: 470, y: 240 }], { shift: true });
    await expect.poll(() => countKind(page, 'shape')).toBe(2);
    let ell = (await ofKind(page, 'shape'))[1];
    expect(ell.data.type).toBe('ellipse');
    expectNear(ell.rect.width, ell.rect.height, 0.5);
    await expect(page.getByTestId('drawing-props-shape')).toBeVisible();
    await pickColor(page, 'drawing-prop-fill', '#1473e6');
    await expect.poll(async () => (await ofKind(page, 'shape'))[1].fillColor).toBe('#1473e6');
    await pickMenu(page, 'drawing-prop-style', 'drawing-style-dashed');
    await pickMenu(page, 'drawing-prop-opacity', 'drawing-op-75');
    await expect.poll(async () => (await ofKind(page, 'shape'))[1].opacity).toBe(0.75);
    ell = (await ofKind(page, 'shape'))[1];
    expect(ell.data.style).toBe('dashed');

    // Resizing through the selection handle scales the shape.
    const before = ell.rect;
    const handle = page.locator(`.pdfwizard-handle-se[data-obj-id="${ell.id}"]`);
    await expect(handle).toBeVisible();
    const hb = (await handle.boundingBox())!;
    await drag(page, [{ x: hb.x + hb.width / 2, y: hb.y + hb.height / 2 }, { x: hb.x + hb.width / 2 + 40, y: hb.y + hb.height / 2 + 20 }]);
    await expect.poll(async () => (await ofKind(page, 'shape'))[1].rect.width).toBeGreaterThan(before.width + 20);

    // Undo the resize, redo it.
    const resized = (await ofKind(page, 'shape'))[1].rect;
    await undo(page);
    await expect.poll(async () => (await ofKind(page, 'shape'))[1].rect.width).toBeCloseTo(before.width, 1);
    await redo(page);
    await expect.poll(async () => (await ofKind(page, 'shape'))[1].rect.width).toBeCloseTo(resized.width, 1);

    const ann = await annotations(await download(page));
    const sq = ann.find((a) => a.subtype === 'Square')!;
    const ci = ann.find((a) => a.subtype === 'Circle')!;
    expect(sq && ci).toBeTruthy();
    // Cloudy border effect with a /RD inset; no fill.
    expect(sq.name('S', sq.dict('BE'))).toBe('C');
    expect(sq.nums('RD')).toHaveLength(4);
    expect(sq.get('IC')).toBeUndefined();
    expect(sq.nums('W', sq.dict('BS'))?.[0] ?? (sq.dict('BS')?.get(PDFName.of('W')) as PDFNumber).asNumber()).toBe(3);
    // Filled, dashed, translucent oval.
    expect(rgb255(ci.nums('IC'))).toEqual([20, 115, 230]);
    expect(ci.name('S', ci.dict('BS'))).toBe('D');
    expect((ci.get('CA') as PDFNumber).asNumber()).toBeCloseTo(0.75, 2);
    expect(ci.ap).toMatch(/ c\b/);
    expectNear(ci.rect[2] - ci.rect[0], resized.width, 8);
  });

  test('lines and arrows: 45° constraint, line endings, vertex handles and /Line export', async ({ page }) => {
    await openFixture(page, 'sample.pdf');
    await pressShortcut(page, 'a', 'shape-arrow');
    await expect(page.getByTestId('drawing-options-line')).toBeVisible();
    await dragPdf(page, 0, [{ x: 100, y: 500 }, { x: 300, y: 560 }]);
    await expect.poll(() => countKind(page, 'line')).toBe(1);
    let [arrow] = await ofKind(page, 'line');
    expect(arrow.data.endings).toEqual(['None', 'OpenArrow']);
    expectNear(arrow.data.start.x, 100);
    expectNear(arrow.data.end.y, 560);

    await expect(page.getByTestId('drawing-props-line')).toBeVisible();
    await pickMenu(page, 'drawing-prop-start', 'drawing-start-Circle');
    await pickMenu(page, 'drawing-prop-end', 'drawing-end-ClosedArrow');
    await expect.poll(async () => (await ofKind(page, 'line'))[0].data.endings).toEqual(['Circle', 'ClosedArrow']);
    // Closed endings can be filled.
    await pickColor(page, 'drawing-prop-fill', '#1473e6');
    await expect.poll(async () => (await ofKind(page, 'line'))[0].fillColor).toBe('#1473e6');

    // Vertex handles move one end only.
    await expect(page.getByTestId('drawing-vertex-0')).toBeVisible();
    await expect(page.getByTestId('drawing-vertex-1')).toBeVisible();
    const vb = (await page.getByTestId('drawing-vertex-1').boundingBox())!;
    const target = await clientPoint(page, 0, { x: 320, y: 520 });
    const vb2 = (await page.getByTestId('drawing-vertex-1').boundingBox())!;
    expect(vb2.width).toBe(vb.width);
    await drag(page, [{ x: vb2.x + vb2.width / 2, y: vb2.y + vb2.height / 2 }, target]);
    await expect.poll(async () => near((await ofKind(page, 'line'))[0].data.end.x, 320, 2.5)).toBe(true);
    arrow = (await ofKind(page, 'line'))[0];
    expectNear(arrow.data.end.y, 520, 2.5);
    expectNear(arrow.data.start.x, 100);

    // Shift constrains a plain line to 45° steps (here: horizontal).
    await pressShortcut(page, 'l', 'shape-line');
    await dragPdf(page, 0, [{ x: 100, y: 440 }, { x: 260, y: 432 }], { shift: true });
    await expect.poll(() => countKind(page, 'line')).toBe(2);
    const flat = (await ofKind(page, 'line'))[1];
    expect(flat.data.endings).toEqual(['None', 'None']);
    expect(flat.data.end.y).toBeCloseTo(flat.data.start.y, 3);

    const lines = (await annotations(await download(page))).filter((a) => a.subtype === 'Line');
    expect(lines).toHaveLength(2);
    const la = lines.find((a) => a.names('LE')[0] === 'Circle')!;
    expect(la.names('LE')).toEqual(['Circle', 'ClosedArrow']);
    const L = la.nums('L')!;
    expectNear(L[0], 100);
    expectNear(L[2], 320, 2.5);
    expect(la.ap.length).toBeGreaterThan(40);
    // The closed arrow and circle endings are filled with the interior color.
    expect(rgb255(la.nums('IC'))).toEqual([20, 115, 230]);
    expect(la.ap).toMatch(/\b(f|B|b)\n/);
  });

  test('polygon, polyline and cloud: click vertices, Backspace, Enter, double-click, Esc', async ({ page }) => {
    await openFixture(page, 'sample.pdf');
    await openTask(page, 'drawing', 'drawing-draw-panel');

    // Polygon: 4 clicks, Backspace removes the last, Enter finishes.
    await chooseTool(page, 'shape-polygon');
    await clickPdf(page, 0, [{ x: 100, y: 300 }, { x: 200, y: 300 }, { x: 200, y: 200 }, { x: 120, y: 180 }]);
    await expect(pageEl(page, 0).getByTestId('drawing-session-vertex-3')).toBeVisible();
    await expect(page.getByTestId('drawing-poly-hint')).toBeVisible();
    await page.keyboard.press('Backspace');
    await expect(pageEl(page, 0).getByTestId('drawing-session-vertex-3')).toHaveCount(0);
    await page.keyboard.press('Enter');
    await expect.poll(() => countKind(page, 'poly')).toBe(1);
    const [pg] = await ofKind(page, 'poly');
    expect(pg.data.type).toBe('polygon');
    expect(pg.data.vertices).toHaveLength(3);
    expectNear(pg.data.vertices[2].y, 200);

    // Selected polygons show a handle per vertex; dragging one reshapes it.
    await expect(page.getByTestId('drawing-vertex-2')).toBeVisible();
    const vb = (await page.getByTestId('drawing-vertex-0').boundingBox())!;
    await drag(page, [{ x: vb.x + vb.width / 2, y: vb.y + vb.height / 2 }, { x: vb.x + vb.width / 2 - 30, y: vb.y + vb.height / 2 }]);
    await expect.poll(async () => (await ofKind(page, 'poly'))[0].data.vertices[0].x).toBeLessThan(90);
    await undo(page);
    await expect.poll(async () => (await ofKind(page, 'poly'))[0].data.vertices[0].x).toBeCloseTo(pg.data.vertices[0].x, 1);

    // Polyline: double-click finishes.
    await chooseTool(page, 'shape-polyline');
    const pts = await clientPoints(page, 0, [{ x: 300, y: 300 }, { x: 380, y: 260 }, { x: 460, y: 300 }]);
    await page.mouse.click(pts[0].x, pts[0].y);
    await page.mouse.click(pts[1].x, pts[1].y);
    await page.mouse.dblclick(pts[2].x, pts[2].y);
    await expect.poll(() => countKind(page, 'poly')).toBe(2);
    const pl = (await ofKind(page, 'poly'))[1];
    expect(pl.data.type).toBe('polyline');
    expect(pl.data.vertices).toHaveLength(3);
    expect(pl.fillColor ?? null).toBeNull();

    // Esc cancels an unfinished cloud.
    await chooseTool(page, 'shape-cloud');
    await clickPdf(page, 0, [{ x: 100, y: 600 }, { x: 250, y: 600 }]);
    await expect(pageEl(page, 0).getByTestId('drawing-session-vertex-1')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(pageEl(page, 0).getByTestId('drawing-session-vertex-0')).toHaveCount(0);
    expect(await countKind(page, 'poly')).toBe(2);
    // Cloud: clicking the first vertex again closes it.
    if ((await activeTool(page)) !== 'shape-cloud') await chooseTool(page, 'shape-cloud');
    await clickPdf(page, 0, [{ x: 100, y: 640 }, { x: 250, y: 640 }, { x: 250, y: 560 }, { x: 100, y: 560 }, { x: 100, y: 640 }]);
    await expect.poll(() => countKind(page, 'poly')).toBe(3);
    const cl = (await ofKind(page, 'poly'))[2];
    expect(cl.data.style).toBe('cloudy');
    expect(cl.data.vertices).toHaveLength(4);
    await expect(page.getByTestId('drawing-panel-summary')).toHaveText('3 polygons');

    const ann = await annotations(await download(page));
    const polys = ann.filter((a) => a.subtype === 'Polygon');
    const polylines = ann.filter((a) => a.subtype === 'PolyLine');
    expect(polys).toHaveLength(2);
    expect(polylines).toHaveLength(1);
    expect(polylines[0].nums('Vertices')).toHaveLength(6);
    const cloud = polys.find((a) => a.name('S', a.dict('BE')) === 'C')!;
    expect(cloud, 'cloud polygon has /BE /S /C').toBeTruthy();
    expect(cloud.nums('Vertices')).toHaveLength(8);
    expect(cloud.ap).toMatch(/ c\b/);
  });

  test('measure: scale, distance / perimeter / area with live readout, snapping, /Measure export and re-import', async ({ page }) => {
    await openFixture(page, 'sample.pdf');
    await openTask(page, 'measure', 'drawing-measure-panel');
    await expect.poll(() => activeTool(page)).toBe('measure-distance');
    for (const id of ['measure-distance', 'measure-perimeter', 'measure-area']) await expect(page.getByTestId(`tool-chip-${id}`)).toBeVisible();

    // 1 in = 10 ft
    const real = page.getByTestId('drawing-scale-real-value').locator('input');
    await real.fill('10');
    await real.press('Enter');
    await page.getByTestId('drawing-scale-real-unit').selectOption('ft');
    await expect(page.getByTestId('drawing-opt-scale')).toContainText('1 in = 10 ft');

    // Distance: 144 pt = 2 in = 20 ft, value shown while dragging.
    const [a, b] = await clientPoints(page, 0, [{ x: 100, y: 600 }, { x: 244, y: 600 }]);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 6 });
    await expect(page.getByTestId('drawing-measure-readout')).toHaveText(/^\s*(19\.\d\d|20\.\d\d) ft\s*$/);
    await page.mouse.up();
    await expect.poll(() => countKind(page, 'measure')).toBe(1);
    const [dist] = await ofKind(page, 'measure');
    expect(dist.data.type).toBe('distance');
    expect(dist.data.scale).toEqual({ docValue: 1, docUnit: 'in', realValue: 10, realUnit: 'ft' });
    expectNear(dist.data.value, 20, 0.3);

    // Snapping: a new distance started next to the first one's end point starts exactly on it.
    const [s0, s1] = await clientPoints(page, 0, [{ x: 245.5, y: 601.5 }, { x: 245.5, y: 672 }]);
    await drag(page, [s0, s1]);
    await expect.poll(() => countKind(page, 'measure')).toBe(2);
    const snapped = (await ofKind(page, 'measure'))[1];
    expect(snapped.data.points[0]).toEqual(dist.data.points[1]);
    await undo(page);
    await expect.poll(() => countKind(page, 'measure')).toBe(1);

    // Perimeter: 72 + 72 pt = 20 ft.
    await page.getByTestId('drawing-measure-tool-perimeter').click();
    await expect.poll(() => activeTool(page)).toBe('measure-perimeter');
    await clickPdf(page, 0, [{ x: 100, y: 500 }, { x: 172, y: 500 }, { x: 172, y: 428 }]);
    await page.keyboard.press('Enter');
    await expect.poll(() => countKind(page, 'measure')).toBe(2);
    expectNear((await ofKind(page, 'measure'))[1].data.value, 20, 0.4);

    // Area: 1 in × 1 in = 100 sq ft.
    await page.getByTestId('drawing-measure-tool-area').click();
    await expect.poll(() => activeTool(page)).toBe('measure-area');
    await clickPdf(page, 0, [{ x: 300, y: 500 }, { x: 372, y: 500 }, { x: 372, y: 428 }, { x: 300, y: 428 }]);
    await page.keyboard.press('Enter');
    await expect.poll(() => countKind(page, 'measure')).toBe(3);
    const area = (await ofKind(page, 'measure'))[2];
    expect(area.data.type).toBe('area');
    expectNear(area.data.value, 100, 3);

    const list = page.getByTestId('drawing-measure-list');
    await expect(list.locator('li')).toHaveCount(3);
    await expect(list).toContainText('sq ft');

    const bytes = await download(page);
    const ann = await annotations(bytes);
    const line = ann.find((a) => a.subtype === 'Line')!;
    const peri = ann.find((a) => a.subtype === 'PolyLine')!;
    const poly = ann.find((a) => a.subtype === 'Polygon')!;
    expect(line.name('IT')).toBe('LineDimension');
    expect(peri.name('IT')).toBe('PolyLineDimension');
    expect(poly.name('IT')).toBe('PolygonDimension');
    const m = line.dict('Measure')!;
    expect(line.name('Type', m)).toBe('Measure');
    expect(line.name('Subtype', m)).toBe('RL');
    expect(line.text('R', m)).toBe('1 in = 10 ft');
    for (const k of ['X', 'D', 'A']) expect(line.dict(k, m), `/Measure /${k}`).toBeTruthy();
    expect(line.text('U', line.dict('D', m))).toBe('ft');
    expect(line.text('Contents')).toMatch(/^(19\.\d\d|20\.\d\d) ft/);
    expect(poly.text('Contents')).toMatch(/sq ft/);
    expect(poly.get('IC') ?? poly.ap).toBeTruthy();

    // Reopen the download: the annotations come back as measurements with their scale.
    await reopen(page, bytes, 'measured.pdf');
    const back = await ofKind(page, 'measure');
    expect(back.map((o) => o.data.type).sort()).toEqual(['area', 'distance', 'perimeter']);
    for (const o of back) expect(o.data.scale).toEqual({ docValue: 1, docUnit: 'in', realValue: 10, realUnit: 'ft' });
    expectNear(back.find((o) => o.data.type === 'area')!.data.value, 100, 3);
  });

  test('stamps: palette, Stamp shortcut, dynamic and sign-here stamps, context menu, /Stamp export and flattening', async ({ page }) => {
    await openFixture(page, 'sample.pdf');
    // No stamp chosen yet: the shortcut opens the palette.
    await blur(page);
    await page.keyboard.press('k');
    await expect(page.getByTestId('drawing-stamps-panel')).toBeVisible();
    await expect(page.getByTestId('drawing-stamp-grid-standard').locator('button')).toHaveCount(12);

    await page.getByTestId('drawing-stamp-standard-approved').click();
    await expect.poll(() => activeTool(page)).toBe('stamp');
    await expect(page.getByTestId('drawing-options-stamp')).toBeVisible();
    const c = await clientPoint(page, 0, { x: 300, y: 450 });
    await page.mouse.move(c.x, c.y);
    await expect(pageEl(page, 0).getByTestId('drawing-stamp-ghost')).toBeVisible();
    await page.mouse.click(c.x, c.y);
    await expect.poll(() => countKind(page, 'stamp')).toBe(1);
    const [st] = await ofKind(page, 'stamp');
    expect(st.data).toMatchObject({ set: 'standard', name: 'Approved', label: 'APPROVED' });
    expectNear(st.rect.x + st.rect.width / 2, 300);
    expectNear(st.rect.y + st.rect.height / 2, 450);
    await expect.poll(() => activeTool(page)).toBe('select');
    await expect(page.getByTestId('drawing-props-stamp')).toBeVisible();

    // Dynamic stamps carry the user, time and date.
    await page.getByTestId('drawing-stamp-tabs').getByRole('tab', { name: 'Dynamic' }).click();
    await expect(page.getByTestId('drawing-stamp-grid-dynamic').locator('button')).toHaveCount(5);
    await page.getByTestId('drawing-stamp-grid-dynamic').locator('button').first().click();
    const d = await clientPoint(page, 0, { x: 300, y: 300 });
    await page.mouse.click(d.x, d.y);
    await expect.poll(() => countKind(page, 'stamp')).toBe(2);
    const dyn = (await ofKind(page, 'stamp'))[1];
    expect(dyn.data.set).toBe('dynamic');
    expect(dyn.data.subline).toMatch(/^By .+ at \d{1,2}:\d\d/);

    // Sign here, placed with the page context menu.
    await page.getByTestId('drawing-stamp-tabs').getByRole('tab', { name: 'Sign here' }).click();
    await expect(page.getByTestId('drawing-stamp-grid-sign').locator('button')).toHaveCount(5);
    await page.getByTestId('drawing-stamp-grid-sign').locator('button').first().click();
    await expect.poll(() => activeTool(page)).toBe('stamp');
    await pressShortcut(page, 'v', 'select');
    const r = await clientPoint(page, 0, { x: 420, y: 200 });
    await page.mouse.click(r.x, r.y, { button: 'right' });
    const item = page.locator('[data-menu-id=drawing-ctx-stamp]');
    await expect(item).toContainText('Add stamp here');
    await item.click();
    await expect.poll(() => countKind(page, 'stamp')).toBe(3);
    const sign = (await ofKind(page, 'stamp'))[2];
    expect(sign.data.set).toBe('sign');
    expectNear(sign.rect.x + sign.rect.width / 2, 420, 3);
    expectNear(sign.rect.y + sign.rect.height / 2, 200, 3);

    // The shortcut now arms the stamp tool directly.
    await pressShortcut(page, 'k', 'stamp');
    await pressShortcut(page, 'v', 'select');

    const ann = (await annotations(await download(page))).filter((a) => a.subtype === 'Stamp');
    expect(ann).toHaveLength(3);
    const approved = ann.find((a) => a.name('Name') === 'Approved')!;
    expect(approved.ap).toMatch(/\bTj\b|\bTJ\b/);
    expect(approved.ap).toMatch(/ re\b| c\b/);
    expect(ann.find((a) => a.name('Name') === dyn.data.name)).toBeTruthy();
    expect(ann.find((a) => a.name('Name') === sign.data.name)).toBeTruthy();

    // Flattened: no stamp annotations left, the text is part of the page.
    const flat = await flattenedBytes(page);
    expect((await annotations(flat)).filter((a) => a.subtype === 'Stamp')).toHaveLength(0);
    const info = await inspectPdf(flat);
    expect(info.pages[0].text).toContain('APPROVED');
  });

  test('custom stamps: create from image and PDF page, place, rename, delete, persist', async ({ page }) => {
    await openFixture(page, 'sample.pdf');
    await openTask(page, 'stamp', 'drawing-stamps-panel');
    await page.getByTestId('drawing-stamp-tabs').getByRole('tab', { name: 'Custom' }).click();
    await expect(page.getByTestId('drawing-stamps-panel')).toContainText('No custom stamps yet');

    let chooser = page.waitForEvent('filechooser');
    await page.getByTestId('drawing-stamp-from-image').click();
    await (await chooser).setFiles(FIXTURES_DIR + 'sample.png');
    const grid = page.getByTestId('drawing-stamp-grid-custom');
    await expect(grid.locator('.drawing-stamp-tile')).toHaveCount(1);
    await expect.poll(() => activeTool(page)).toBe('stamp');
    const c = await clientPoint(page, 0, { x: 300, y: 400 });
    await page.mouse.click(c.x, c.y);
    await expect.poll(() => countKind(page, 'stamp')).toBe(1);
    const [img] = await ofKind(page, 'stamp');
    expect(img.data.set).toBe('custom');
    expect(img.data.image).toEqual({ w: expect.any(Number), h: expect.any(Number) });
    // 1200×800 image fitted into the default stamp box, aspect kept.
    expectNear(img.rect.width / img.rect.height, 1.5, 0.02);

    // From a PDF page (the page number is asked for multi-page files).
    chooser = page.waitForEvent('filechooser');
    await page.getByTestId('drawing-stamp-from-pdf').click();
    await (await chooser).setFiles(FIXTURES_DIR + 'sample.pdf');
    await page.getByTestId('prompt-input').fill('2');
    await page.getByTestId('dialog-confirm').click();
    await expect(grid.locator('.drawing-stamp-tile')).toHaveCount(2);
    await expect(grid).toContainText('sample p2');
    const e = await clientPoint(page, 0, { x: 450, y: 250 });
    await page.mouse.click(e.x, e.y);
    await expect.poll(() => countKind(page, 'stamp')).toBe(2);
    expect((await ofKind(page, 'stamp'))[1].data.pdf).toBe('pdf');
    // The same page stamp a second time (the shortcut re-arms the last stamp).
    await pressShortcut(page, 'k', 'stamp');
    const e2 = await clientPoint(page, 0, { x: 450, y: 120 });
    await page.mouse.click(e2.x, e2.y);
    await expect.poll(() => countKind(page, 'stamp')).toBe(3);

    // Rename and delete through the tile menu.
    const firstId = (await grid.locator('.drawing-stamp-tile-btn').first().getAttribute('data-testid'))!.replace('drawing-stamp-custom-', '');
    await grid.locator('.drawing-stamp-tile').first().hover();
    await page.getByTestId(`drawing-stamp-more-${firstId}`).click();
    await page.locator('[data-menu-id=drawing-stamp-rename]').click();
    await page.getByTestId('prompt-input').fill('Company logo');
    await page.getByTestId('dialog-confirm').click();
    await expect(grid).toContainText('Company logo');
    await expect(page.getByTestId('drawing-stamp-usage')).toContainText('used');

    const ann = (await annotations(await download(page))).filter((a) => a.subtype === 'Stamp');
    expect(ann).toHaveLength(3);
    expect(Object.values(ann[0].xobjects)).toContain('Image');
    expect(Object.values(ann[1].xobjects)).toContain('Form');
    // The source page is embedded once and shared by both appearances.
    expect(ann[1].xobjectRefs).toHaveLength(1);
    expect(ann[2].xobjectRefs).toEqual(ann[1].xobjectRefs);

    await grid.locator('.drawing-stamp-tile').first().hover();
    await page.getByTestId(`drawing-stamp-more-${firstId}`).click();
    await page.locator('[data-menu-id=drawing-stamp-delete]').click();
    await page.getByTestId('dialog-confirm').click();
    await expect(grid.locator('.drawing-stamp-tile')).toHaveCount(1);
    // Placed stamps are not affected.
    expect(await countKind(page, 'stamp')).toBe(3);

    // Custom stamps live in this browser's storage.
    await page.reload();
    await openFixture(page, 'sample.pdf');
    await openTask(page, 'stamp', 'drawing-stamps-panel');
    await page.getByTestId('drawing-stamp-tabs').getByRole('tab', { name: 'Custom' }).click();
    await expect(page.getByTestId('drawing-stamp-grid-custom').locator('.drawing-stamp-tile')).toHaveCount(1);
    await expect(page.getByTestId('drawing-stamp-grid-custom')).toContainText('sample p2');
  });

  test('annotated.pdf: existing drawing annotations import as editable objects and export back', async ({ page }) => {
    await openFixture(page, 'annotated.pdf');
    const objs = await drawings(page);
    expect(objs.every((o) => o.pageIndex === 1)).toBe(true);
    const kinds = objs.map((o) => o.kind).sort();
    expect(kinds).toEqual(['ink', 'line', 'shape', 'shape', 'stamp']);
    const sq = objs.find((o) => o.kind === 'shape' && o.data.type === 'rect')!;
    const ci = objs.find((o) => o.kind === 'shape' && o.data.type === 'ellipse')!;
    const ln = objs.find((o) => o.kind === 'line')!;
    const ink = objs.find((o) => o.kind === 'ink')!;
    const st = objs.find((o) => o.kind === 'stamp')!;
    expect(sq.color).toBe('#d92d20');
    expect(sq.strokeWidth).toBe(2);
    expectNear(sq.rect.x, 362, 3);
    expectNear(sq.rect.y + sq.rect.height, 600, 3);
    expect(ci.color).toBe('#1a9e3f');
    expect(ln.data.endings).toEqual(['None', 'OpenArrow']);
    expect(ln.data.start).toEqual({ x: 120, y: 640 });
    expect(ln.data.end).toEqual({ x: 160, y: 598 });
    expect(ink.data.paths).toHaveLength(2);
    expect(ink.color).toBe('#1473e6');
    expect(st.data.name).toBe('Approved');
    expect(st.data.preserved).toBe('preserved');
    await expect(pageEl(page, 1).getByTestId('drawing-obj-shape')).toHaveCount(2);

    // Select the square by its border, recolor it and move it with the keyboard-free drag.
    const edge = await clientPoint(page, 1, { x: 362.5, y: 555 });
    await page.mouse.click(edge.x, edge.y);
    await expect.poll(() => selection(page)).toEqual([sq.id]);
    await expect(page.getByTestId('drawing-props-shape')).toBeVisible();
    await pickColor(page, 'drawing-prop-color', '#1473e6');
    await expect.poll(async () => (await drawings(page)).find((o) => o.id === sq.id)!.color).toBe('#1473e6');
    const edge2 = await clientPoint(page, 1, { x: 362.5, y: 555 });
    await drag(page, [edge2, { x: edge2.x - 40, y: edge2.y + 30 }]);
    await expect.poll(async () => (await drawings(page)).find((o) => o.id === sq.id)!.rect.x).toBeLessThan(345);
    const moved = (await drawings(page)).find((o) => o.id === sq.id)!;

    const ann = await annotations(await download(page));
    const p2 = ann.filter((a) => a.page === 1);
    for (const t of ['Square', 'Circle', 'Line', 'Ink', 'Stamp']) expect(p2.filter((a) => a.subtype === t), t).toHaveLength(1);
    const sqa = p2.find((a) => a.subtype === 'Square')!;
    expect(rgb255(sqa.nums('C'))).toEqual([20, 115, 230]);
    expect(sqa.rect[0]).toBeLessThan(moved.rect.x + 1);
    expect(sqa.rect[0]).toBeGreaterThan(moved.rect.x - 4);
    const sta = p2.find((a) => a.subtype === 'Stamp')!;
    expect(sta.name('Name')).toBe('Approved');
    // The imported stamp keeps its own appearance, subject and note.
    expect(sta.text('Subj')).toBe('Approved');
    expect(sta.text('Contents')).toBe('Approved');
    expect(sta.text('T')).toBe('Jordan Lee');
    expect(p2.find((a) => a.subtype === 'Line')!.names('LE')).toEqual(['None', 'OpenArrow']);
  });

  test('rotated pages, zoom and dark theme: shapes land under the pointer and stamps stay upright', async ({ page }) => {
    await openFixture(page, 'rotated.pdf');
    const docId = await page.evaluate(() => window.__app.getActiveDoc().id);

    // Page 2 has /Rotate 90.
    await pressShortcut(page, 'r', 'shape-rect');
    await dragPdf(page, 1, [{ x: 150, y: 250 }, { x: 350, y: 450 }]);
    await expect.poll(() => countKind(page, 'shape')).toBe(1);
    const [r1] = await ofKind(page, 'shape');
    expect(r1.pageIndex).toBe(1);
    expectNear(r1.rect.x, 150);
    expectNear(r1.rect.y, 250);
    expectNear(r1.rect.width, 200);
    expectNear(r1.rect.height, 200);

    // A stamp on the 270° page is drawn upright for the reader.
    await openTask(page, 'stamp', 'drawing-stamps-panel');
    await page.getByTestId('drawing-stamp-standard-draft').click();
    const c = await clientPoint(page, 3, { x: 300, y: 400 });
    await page.mouse.click(c.x, c.y);
    await expect.poll(() => countKind(page, 'stamp')).toBe(1);
    const [st] = await ofKind(page, 'stamp');
    expect(st.pageIndex).toBe(3);
    expect(st.data.rotation).toBe(270);
    // Landscape page: the upright stamp is taller than wide in PDF space.
    expect(st.rect.height).toBeGreaterThan(st.rect.width);

    // 200% zoom and the dark theme.
    await page.evaluate((id) => window.__app.actions.setZoom(id, 2), docId);
    await page.evaluate(() => window.__app.actions.setPrefs({ theme: 'dark' }));
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await waitForPagesRendered(page);
    await pressShortcut(page, 'o', 'shape-ellipse');
    await dragPdf(page, 0, [{ x: 200, y: 500 }, { x: 300, y: 450 }]);
    await expect.poll(() => countKind(page, 'shape')).toBe(2);
    const ell = (await ofKind(page, 'shape'))[1];
    expect(ell.pageIndex).toBe(0);
    expectNear(ell.rect.x, 200, 1);
    expectNear(ell.rect.width, 100, 1);
    expectNear(ell.rect.height, 50, 1);

    const ann = await annotations(await download(page));
    const sq = ann.find((a) => a.subtype === 'Square')!;
    expect(sq.page).toBe(1);
    expectNear(sq.rect[0], 150, 3);
    expectNear(sq.rect[3], 450, 3);
    const sa = ann.find((a) => a.subtype === 'Stamp')!;
    expect(sa.page).toBe(3);
    expect(sa.name('Name')).toBe('Draft');
    // The appearance is rotated with the page (non-trivial matrix in the stream or /Matrix).
    expect(sa.ap).toMatch(/\b0 -?1 -?1 0 \S+ \S+ cm/);
    const circle = ann.find((a) => a.subtype === 'Circle')!;
    expect(circle.page).toBe(0);
  });

  test('round trip: drawings survive download → reopen with the same kinds and styles', async ({ page }) => {
    await openFixture(page, 'sample.pdf');
    await openTask(page, 'drawing', 'drawing-draw-panel');
    await chooseTool(page, 'draw-highlighter');
    await dragPdf(page, 0, [{ x: 100, y: 560 }, { x: 300, y: 560 }]);
    await expect.poll(() => countKind(page, 'ink')).toBe(1);
    await chooseTool(page, 'shape-cloud');
    await clickPdf(page, 0, [{ x: 100, y: 300 }, { x: 250, y: 300 }, { x: 250, y: 200 }]);
    await page.keyboard.press('Enter');
    await expect.poll(() => countKind(page, 'poly')).toBe(1);
    await chooseTool(page, 'shape-rect');
    await page.getByTestId('drawing-options-shape').waitFor();
    await pickMenu(page, 'drawing-opt-style', 'drawing-style-dashed');
    await dragPdf(page, 0, [{ x: 320, y: 300 }, { x: 470, y: 220 }]);
    await expect.poll(() => countKind(page, 'shape')).toBe(1);
    await chooseTool(page, 'shape-arrow');
    await dragPdf(page, 0, [{ x: 320, y: 420 }, { x: 470, y: 380 }]);
    await expect.poll(() => countKind(page, 'line')).toBe(1);
    const before = await drawings(page);

    const bytes = await download(page);
    await reopen(page, bytes, 'roundtrip.pdf');
    const after = await drawings(page);
    expect(after.map((o) => o.kind).sort()).toEqual(before.map((o) => o.kind).sort());
    const hl = after.find((o) => o.kind === 'ink')!;
    expect(hl.data.highlight).toBe(true);
    expect(hl.opacity).toBeCloseTo(0.6, 2);
    expect(hl.color).toBe('#ffd426');
    const cloud = after.find((o) => o.kind === 'poly')!;
    expect(cloud.data).toMatchObject({ type: 'polygon', style: 'cloudy' });
    expect(cloud.data.vertices).toHaveLength(3);
    const rect = after.find((o) => o.kind === 'shape')!;
    expect(rect.data.style).toBe('dashed');
    const b = before.find((o) => o.kind === 'shape')!;
    for (const k of ['x', 'y', 'width', 'height'] as const) expectNear(rect.rect[k], b.rect[k], 0.5);
    const arrow = after.find((o) => o.kind === 'line')!;
    expect(arrow.data.endings).toEqual(['None', 'OpenArrow']);
    await expect(pageEl(page, 0).getByTestId('drawing-obj-ink-blend')).toHaveCount(1);

    await expect(page.getByTestId('drawing-panel-summary')).toHaveText('1 drawing · 1 shape · 1 line · 1 polygon');

    // Re-imported drawings stay editable.
    await pressShortcut(page, 'v', 'select');
    const edge = await clientPoint(page, 0, { x: rect.rect.x + 1, y: rect.rect.y + rect.rect.height / 2 });
    await page.mouse.click(edge.x, edge.y);
    await expect.poll(() => selection(page)).toEqual([rect.id]);
    await pickMenu(page, 'drawing-prop-width', 'drawing-w-4');
    await expect.poll(async () => (await drawings(page)).find((o) => o.id === rect.id)!.strokeWidth).toBe(4);
    await undo(page);
    await expect.poll(async () => (await drawings(page)).find((o) => o.id === rect.id)!.strokeWidth).toBe(2);
  });
  test('dynamic stamps with non-Latin names: the text is kept, drawn and searchable in the PDF', async ({ page }) => {
    await openFixture(page, 'sample.pdf');
    await openTask(page, 'stamp', 'drawing-stamps-panel');
    const names = ['Zoë Müller', 'Zoë — 日本語 Ελληνικά'];
    const at = [{ x: 300, y: 600 }, { x: 300, y: 400 }];
    for (let i = 0; i < names.length; i++) {
      await page.evaluate((u) => window.__app.actions.setPrefs({ userName: u }), names[i]);
      await page.getByTestId('drawing-stamp-tabs').getByRole('tab', { name: 'Dynamic' }).click();
      await page.getByTestId('drawing-stamp-grid-dynamic').locator('button').first().click();
      await expect.poll(() => activeTool(page)).toBe('stamp');
      const c = await clientPoint(page, 0, at[i]);
      await page.mouse.click(c.x, c.y);
      await expect.poll(() => countKind(page, 'stamp')).toBe(i + 1);
    }
    const placed = await ofKind(page, 'stamp');
    for (let i = 0; i < names.length; i++) expect(placed[i].data.subline).toContain(`By ${names[i]} at `);
    // On screen the name is shown as typed (no replacement characters).
    const shown = pageEl(page, 0).getByTestId('drawing-obj-stamp');
    await expect(shown.nth(1)).toContainText('日本語 Ελληνικά');
    await expect(shown.nth(0)).toContainText('Zoë Müller');

    const bytes = await download(page);
    const ann = (await annotations(bytes)).filter((a) => a.subtype === 'Stamp');
    expect(ann).toHaveLength(2);
    for (const a of ann) expect(a.ap).toMatch(/\bTj\b/);
    // Latin text is set in a font; characters without a font (CJK) get an image of the line plus
    // invisible text on top.
    expect(Object.values(ann[0].xobjects)).not.toContain('Image');
    expect(Object.values(ann[1].xobjects)).toContain('Image');
    expect(ann[1].ap).toMatch(/\b3 Tr\b/);

    const text = (await inspectPdf(await flattenedBytes(page))).pages[0].text;
    for (const s of ['Zoë Müller', 'Zoë', '日本語', 'Ελληνικά']) expect(text).toContain(s);
    expect(text).not.toContain('?');

    // Reopened, the stamps come back with their own appearance.
    await reopen(page, bytes, 'unicode-stamps.pdf');
    const back = await ofKind(page, 'stamp');
    expect(back).toHaveLength(2);
    for (const o of back) expect(o.data.preserved).toBe('preserved');
  });

  test('stamp placement: drag sizes with the aspect ratio and stamps stay on the page', async ({ page }) => {
    await openFixture(page, 'sample.pdf');
    const [x0, y0, x1, y1] = await page.evaluate(() => [...window.__app.getActiveDoc().pages[0].view]);
    await openTask(page, 'stamp', 'drawing-stamps-panel');
    await page.getByTestId('drawing-stamp-standard-approved').click();
    const c = await clientPoint(page, 0, { x: 300, y: 650 });
    await page.mouse.click(c.x, c.y);
    await expect.poll(() => countKind(page, 'stamp')).toBe(1);
    const natural = (await ofKind(page, 'stamp'))[0].rect;
    const ratio = natural.width / natural.height;

    // A wide, shallow drag: the stamp is as wide as the drag, its height follows the design.
    await pressShortcut(page, 'k', 'stamp');
    await dragPdf(page, 0, [{ x: 100, y: 450 }, { x: 300, y: 430 }]);
    await expect.poll(() => countKind(page, 'stamp')).toBe(2);
    const wide = (await ofKind(page, 'stamp'))[1].rect;
    expectNear(wide.x, 100, 1);
    expectNear(wide.width, 200, 1.5);
    expectNear(wide.y + wide.height, 450, 1);
    expectNear(wide.width / wide.height, ratio, 0.05);

    // Next to the right edge the stamp is limited by the page.
    await pressShortcut(page, 'k', 'stamp');
    await dragPdf(page, 0, [{ x: x1 - 60, y: 350 }, { x: x1 - 20, y: 250 }]);
    await expect.poll(() => countKind(page, 'stamp')).toBe(3);
    const edge = (await ofKind(page, 'stamp'))[2].rect;
    expectNear(edge.x, x1 - 60, 1);
    expect(edge.x + edge.width).toBeLessThanOrEqual(x1 + 0.5);
    expectNear(edge.width / edge.height, ratio, 0.05);

    // Clicked in the corner: the ghost and the stamp are moved onto the page.
    await pressShortcut(page, 'k', 'stamp');
    const corner = await clientPoint(page, 0, { x: x1 - 3, y: y0 + 3 });
    await page.mouse.move(corner.x, corner.y);
    const ghost = pageEl(page, 0).getByTestId('drawing-stamp-ghost');
    await expect(ghost).toBeVisible();
    const gb = (await ghost.boundingBox())!;
    const pb = (await pageEl(page, 0).boundingBox())!;
    expect(gb.x + gb.width).toBeLessThanOrEqual(pb.x + pb.width + 1);
    expect(gb.y + gb.height).toBeLessThanOrEqual(pb.y + pb.height + 1);
    await page.mouse.click(corner.x, corner.y);
    await expect.poll(() => countKind(page, 'stamp')).toBe(4);
    const cr = (await ofKind(page, 'stamp'))[3].rect;
    expect(cr.x).toBeGreaterThanOrEqual(x0 - 0.5);
    expect(cr.y).toBeGreaterThanOrEqual(y0 - 0.5);
    expect(cr.x + cr.width).toBeLessThanOrEqual(x1 + 0.5);
    expect(cr.y + cr.height).toBeLessThanOrEqual(y1 + 0.5);
    expectNear(cr.width, natural.width, 0.5);
  });

  test('click-to-add sessions: another page finishes, tool switches and page deletion cancel', async ({ page }) => {
    await openFixture(page, 'sample.pdf');
    const docId = await page.evaluate(() => window.__app.getActiveDoc().id);
    await openTask(page, 'drawing', 'drawing-draw-panel');

    // Two points on page 1, then a click on page 2 ends the polyline on page 1.
    await chooseTool(page, 'shape-polyline');
    await clickPdf(page, 0, [{ x: 300, y: 200 }, { x: 350, y: 150 }]);
    await expect(pageEl(page, 0).getByTestId('drawing-overlay-polyline')).toHaveAttribute('data-session', '2');
    await expect(page.getByTestId('drawing-poly-hint')).toContainText('2 points');
    await clickPdf(page, 1, [{ x: 300, y: 700 }]);
    await expect.poll(() => countKind(page, 'poly')).toBe(1);
    const [pl] = await ofKind(page, 'poly');
    expect(pl.pageIndex).toBe(0);
    expect(pl.data.vertices).toHaveLength(2);

    // Switching tools drops an unfinished polygon.
    await chooseTool(page, 'shape-polygon');
    await clickPdf(page, 1, [{ x: 100, y: 700 }, { x: 200, y: 700 }]);
    await expect(pageEl(page, 1).locator('[data-testid^=drawing-session-vertex-]')).toHaveCount(2);
    await pressShortcut(page, 'r', 'shape-rect');
    await expect(pageEl(page, 1).locator('[data-testid^=drawing-session-vertex-]')).toHaveCount(0);
    await chooseTool(page, 'shape-polygon');
    await expect(page.getByTestId('drawing-poly-hint')).toContainText('first point');

    // Deleting the page of an open session cancels it; nothing is added to a missing page.
    await clickPdf(page, 2, [{ x: 100, y: 700 }, { x: 200, y: 700 }, { x: 200, y: 600 }]);
    await expect(page.getByTestId('drawing-poly-hint')).toContainText('3 points');
    await page.evaluate((id) => window.__engine.deletePages(id, [2]), docId);
    await expect.poll(async () => (await getDoc(page)).pageCount).toBe(5);
    await expect(page.getByTestId('drawing-poly-hint')).toContainText('first point');
    await blur(page);
    await page.keyboard.press('Enter');
    expect(await countKind(page, 'poly')).toBe(1);
  });
});
