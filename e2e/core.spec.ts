/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * Core flows: home & library, rendering, navigation, thumbnails/page organisation, view controls,
 * download/save/share round trips, the special fixtures and the shell UI.
 */
import type { Page } from '@playwright/test';
import {
  captureDownload, engineOp, expect, expectNewVersion, fetchLibraryBytes, getAppState, getDoc, gotoHome,
  inspectPdf, loadLib, needsPassword, openPdfjs, openFixture, pageOrder, test, waitForDocReady, waitForPagesRendered,
} from './helpers';

/** Which original sample.pdf page (0-based) a page text belongs to: pages 2-6 carry the footer "Page N of 6". */
const sampleIndexOf = (text: string) => {
  const m = /Page (\d) of 6/.exec(text);
  return m ? Number(m[1]) - 1 : 0;
};

const viewer = (page: Page) => page.getByTestId('document-viewer');
const pageEl = (page: Page, index: number) => viewer(page).locator(`[data-testid=page][data-page-index="${index}"]`);
const thumb = (page: Page, index: number) => page.getByTestId('thumbnails-panel').locator(`[data-testid=thumbnail][data-page-index="${index}"]`);

async function openThumbnails(page: Page, visibleIndex = 0) {
  if (!(await page.getByTestId('thumbnails-panel').isVisible())) await page.getByTestId('panel-btn-thumbnails').click();
  await expect(page.getByTestId('thumbnails-panel')).toBeVisible();
  await expect(thumb(page, visibleIndex).locator('img')).toBeVisible();
}

/**
 * A menu entry by its label. Accessible names include the shortcut hint ("Fit page ⌥⌘1") and checkable
 * entries use role=menuitemcheckbox, so match the text prefix, rejecting longer labels ("Two pages scrolling").
 */
function menuItem(page: Page, label: string) {
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return page
    .locator('[role=menuitem], [role=menuitemcheckbox], [role=menuitemradio]')
    .filter({ hasText: new RegExp(`^\\s*${esc}(?!\\s*[a-z])`) })
    .first();
}

async function thumbMenu(page: Page, index: number, item: string) {
  await thumb(page, index).click({ button: 'right' });
  await menuItem(page, item).click();
}

/** App menu > View > item. The submenu opens on hover; re-hover until it is showing. */
async function viewMenu(page: Page, item: string) {
  await page.getByTestId('app-menu').click();
  const target = menuItem(page, item);
  await expect(async () => {
    await menuItem(page, 'View').hover();
    await expect(target).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  await target.click();
}

async function zoomMenu(page: Page, item: string) {
  await page.getByTestId('zoom-menu').click();
  await menuItem(page, item).click();
}

async function mountedPages(page: Page) {
  return viewer(page).locator('[data-testid=page]').count();
}

// ── home & rendering ──────────────────────────────────────────────────────────

test('home renders the library and opens a PDF from the file input', async ({ page }) => {
  await gotoHome(page);
  await expect(page.getByTestId('nav-home')).toBeVisible();
  await expect(page.getByText('Drop a PDF here to open it')).toBeVisible();

  await openFixture(page, 'sample.pdf');
  const d = await getDoc(page);
  expect(d.pageCount).toBe(6);
  expect(d.outlineCount).toBe(6);
  expect(d.view.fit).toBe('width');
  expect(d.dirty).toBe(false);
  await expect(page.getByTestId('doc-tab')).toHaveCount(1);
  await expect(page.getByTestId('doc-header')).toContainText('sample.pdf');
  await expect(page.getByTestId('page-total')).toContainText('6');
  expect(page.url()).toContain('#/doc/');
});

test.describe('on a high-density screen', () => {
  test.use({ deviceScaleFactor: 2 });

  test('pages render crisply and the text layer lines up with the canvas', async ({ page }) => {
    await openFixture(page, 'sample.pdf');
    const first = pageEl(page, 0);
    const m = await first.evaluate((el) => {
      const canvas = el.querySelector('canvas')!;
      const cr = canvas.getBoundingClientRect();
      const tr = el.querySelector('.textLayer')!.getBoundingClientRect();
      const pr = el.getBoundingClientRect();
      return { cw: canvas.width, ch: canvas.height, cssW: cr.width, cssH: cr.height, tr: tr.toJSON(), pr: pr.toJSON(), cr: cr.toJSON() };
    });
    // Backing store at device resolution (within rounding).
    expect(Math.abs(m.cw - m.cssW * 2)).toBeLessThanOrEqual(2);
    expect(Math.abs(m.ch - m.cssH * 2)).toBeLessThanOrEqual(2);
    // Text layer covers exactly the painted canvas.
    for (const k of ['left', 'top', 'width', 'height'] as const) expect(Math.abs(m.tr[k] - m.cr[k])).toBeLessThanOrEqual(1.5);

    // Drag-select one line of body text on page 5 and compare with the span under the pointer.
    await page.getByTestId('page-input').fill('5');
    await page.getByTestId('page-input').press('Enter');
    await waitForPagesRendered(page);
    const target = await pageEl(page, 4).evaluate((el) => {
      const spans = [...el.querySelectorAll<HTMLElement>('.textLayer span')].filter((s) => {
        const r = s.getBoundingClientRect();
        return r.width > 200 && r.top > 250 && r.bottom < 750 && (s.textContent ?? '').trim().length > 20;
      });
      const s = spans[0];
      const r = s.getBoundingClientRect();
      return { text: s.textContent!.trim(), x0: r.left + 2, x1: r.right - 2, y: r.top + r.height / 2 };
    });
    await page.mouse.move(target.x0, target.y);
    await page.mouse.down();
    await page.mouse.move(target.x1, target.y, { steps: 10 });
    await page.mouse.up();
    const selected = await page.evaluate(() => getSelection()?.toString().trim() ?? '');
    const words = target.text.split(/\s+/);
    // The whole line is selected apart from (at most) a partially covered first/last character.
    expect(selected.length).toBeGreaterThan(target.text.length - 4);
    expect(selected).toContain(words.slice(1, -1).join(' '));
    await expect(page.getByTestId('text-selection-popup')).toBeVisible();
  });
});

test('the outline is loaded and table-of-contents links navigate', async ({ page }) => {
  await openFixture(page, 'sample.pdf');
  expect((await getDoc(page)).outlineCount).toBe(6);
  await page.getByTestId('next-page').click();
  await expect.poll(async () => (await getDoc(page)).view.currentPage).toBe(1);
  await waitForPagesRendered(page);
  const toc = pageEl(page, 1);
  await expect(toc.locator('.annotationLayer a')).toHaveCount(10);

  const point = await toc.evaluate((el) => {
    const span = [...el.querySelectorAll<HTMLElement>('.textLayer span')].find((s) => /Performance/.test(s.textContent ?? ''))!;
    const sr = span.getBoundingClientRect();
    const cy = sr.top + sr.height / 2;
    const link = [...el.querySelectorAll<HTMLElement>('.annotationLayer a')].find((a) => {
      const r = a.getBoundingClientRect();
      return r.top <= cy && r.bottom >= cy;
    })!;
    const r = link.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.click(point.x, point.y);
  await expect.poll(async () => (await getDoc(page)).view.currentPage).toBe(4);
  await expect(page.getByTestId('page-input')).toHaveValue('5');

  // External link on the last page opens in a new tab.
  await page.getByTestId('page-input').fill('6');
  await page.getByTestId('page-input').press('Enter');
  await waitForPagesRendered(page);
  const ext = pageEl(page, 5).locator('.annotationLayer a[href^="https://example.com"]');
  await expect(ext).toHaveCount(1);
  await expect(ext).toHaveAttribute('target', '_blank');
});

// ── page organisation ─────────────────────────────────────────────────────────

test('thumbnails navigate, drag to reorder, and undo/redo page moves', async ({ page }) => {
  await openFixture(page, 'sample.pdf');
  const ids = (await getDoc(page)).pageIds;
  await openThumbnails(page);
  await expect(page.getByTestId('thumbnails-panel').getByTestId('thumbnail')).toHaveCount(6);

  await thumb(page, 3).click();
  await expect.poll(async () => (await getDoc(page)).view.currentPage).toBe(3);
  await expect(thumb(page, 3)).toHaveAttribute('aria-current', 'page');

  // Drag page 1 onto the right half of page 3 → it lands after page 3.
  const box = (await thumb(page, 2).boundingBox())!;
  await expectNewVersion(page, () => thumb(page, 0).dragTo(thumb(page, 2), { targetPosition: { x: box.width - 10, y: box.height / 2 } }));
  expect(await pageOrder(page, ids)).toEqual([1, 2, 0, 3, 4, 5]);
  expect((await getDoc(page)).dirty).toBe(true);

  await page.getByTestId('undo').click();
  await expect.poll(() => pageOrder(page, ids)).toEqual([0, 1, 2, 3, 4, 5]);
  await waitForDocReady(page);
  await page.getByTestId('redo').click();
  await expect.poll(() => pageOrder(page, ids)).toEqual([1, 2, 0, 3, 4, 5]);
  await waitForDocReady(page);

  // Keyboard undo/redo.
  await viewer(page).locator('.pdfwizard-scroller').focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => pageOrder(page, ids)).toEqual([0, 1, 2, 3, 4, 5]);
  await waitForDocReady(page);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(() => pageOrder(page, ids)).toEqual([1, 2, 0, 3, 4, 5]);
});

test('thumbnail context menu rotates, inserts, duplicates and deletes pages', async ({ page }) => {
  await openFixture(page, 'sample.pdf');
  const ids = (await getDoc(page)).pageIds;
  await openThumbnails(page);

  await expectNewVersion(page, () => thumbMenu(page, 1, 'Rotate clockwise'));
  expect((await getDoc(page)).rotations).toEqual([0, 90, 0, 0, 0, 0]);
  await expect(thumb(page, 1).locator('img')).toBeVisible();
  // The rotated thumbnail is landscape.
  const tb = (await thumb(page, 1).locator('img').boundingBox())!;
  expect(tb.width).toBeGreaterThan(tb.height);

  await expectNewVersion(page, () => thumbMenu(page, 1, 'Rotate counterclockwise'));
  expect((await getDoc(page)).rotations).toEqual([0, 0, 0, 0, 0, 0]);

  await expectNewVersion(page, () => thumbMenu(page, 0, 'Insert blank page after'));
  let d = await getDoc(page);
  expect(d.pageCount).toBe(7);
  expect(ids.indexOf(d.pageIds[1])).toBe(-1);

  await expectNewVersion(page, () => thumbMenu(page, 2, 'Duplicate page'));
  d = await getDoc(page);
  expect(d.pageCount).toBe(8);
  expect(d.pageIds[2]).toBe(ids[1]);

  await thumbMenu(page, 0, 'Delete page');
  await expect(page.getByTestId('modal')).toBeVisible();
  await expectNewVersion(page, () => page.getByTestId('dialog-confirm').click());
  d = await getDoc(page);
  expect(d.pageCount).toBe(7);
  expect(d.pageIds).not.toContain(ids[0]);
  await expect(page.getByTestId('thumbnails-panel').getByTestId('thumbnail')).toHaveCount(7);

  // Undo everything back to the original document.
  for (let i = 0; i < 5; i++) {
    await expectNewVersion(page, () => page.getByTestId('undo').click());
  }
  d = await getDoc(page);
  expect(d.pageIds).toEqual(ids);
  expect(d.rotations).toEqual([0, 0, 0, 0, 0, 0]);
  expect(d.past).toBe(0);
  expect(d.future).toBe(5);
});

// ── view controls ─────────────────────────────────────────────────────────────

test('zoom with the floating control, the zoom menu and ctrl+wheel', async ({ page }) => {
  await openFixture(page, 'sample.pdf');
  const fitWidth = (await getDoc(page)).view.zoom;
  const pageWidth = async () => (await pageEl(page, 0).boundingBox())!.width;
  const w0 = await pageWidth();

  await page.getByTestId('zoom-in').click();
  const v = (await getDoc(page)).view;
  expect(v.fit).toBeNull();
  expect(v.zoom).toBeGreaterThan(fitWidth);
  await expect.poll(pageWidth).toBeGreaterThan(w0);

  await page.getByTestId('zoom-out').click();
  await page.getByTestId('zoom-out').click();
  expect((await getDoc(page)).view.zoom).toBeLessThan(fitWidth);

  await zoomMenu(page, 'Fit page');
  await expect.poll(async () => (await getDoc(page)).view.fit).toBe('page');
  await waitForPagesRendered(page);
  // The whole first page fits vertically in the scroller.
  const sc = (await viewer(page).locator('.pdfwizard-scroller').boundingBox())!;
  expect((await pageEl(page, 0).boundingBox())!.height).toBeLessThanOrEqual(sc.height);

  await zoomMenu(page, 'Actual size');
  await expect.poll(async () => (await getDoc(page)).view.zoom).toBeCloseTo(1, 3);
  await expect(page.getByTestId('zoom-menu')).toHaveText('100%');

  await zoomMenu(page, '200%');
  await expect.poll(async () => (await getDoc(page)).view.zoom).toBeCloseTo(2, 3);

  await zoomMenu(page, 'Fit width');
  await expect.poll(async () => (await getDoc(page)).view.fit).toBe('width');
  expect((await getDoc(page)).view.zoom).toBeCloseTo(fitWidth, 2);

  // ctrl + wheel (pinch) zooms around the pointer.
  await page.mouse.move(sc.x + sc.width / 2, sc.y + sc.height / 2);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -400);
  await page.keyboard.up('Control');
  await expect.poll(async () => (await getDoc(page)).view.zoom).toBeGreaterThan(fitWidth * 1.05);
  expect((await getDoc(page)).view.fit).toBeNull();
  // Each wheel event is capped at 3 notches (x1.15 each): two zoom-out events go below the starting zoom.
  const zoomedIn = (await getDoc(page)).view.zoom;
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, 300);
  await page.mouse.wheel(0, 300);
  await page.keyboard.up('Control');
  await expect.poll(async () => (await getDoc(page)).view.zoom).toBeLessThan(fitWidth);
  expect((await getDoc(page)).view.zoom).toBeCloseTo(zoomedIn / Math.pow(1.15, 6), 2);
  await waitForPagesRendered(page);
});

test('page navigation with the page box, buttons and keyboard', async ({ page }) => {
  await openFixture(page, 'sample.pdf');
  const current = async () => (await getDoc(page)).view.currentPage;
  await page.getByTestId('page-input').fill('5');
  await page.getByTestId('page-input').press('Enter');
  await expect.poll(current).toBe(4);
  await expect(pageEl(page, 4)).toBeInViewport();
  await page.getByTestId('next-page').click();
  await expect.poll(current).toBe(5);
  await expect(page.getByTestId('next-page')).toBeDisabled();
  await page.getByTestId('prev-page').click();
  await expect.poll(current).toBe(4);
  // Out-of-range input is rejected and reset.
  await page.getByTestId('page-input').fill('99');
  await page.getByTestId('page-input').press('Enter');
  await expect.poll(current).toBe(4);
  await expect(page.getByTestId('page-input')).toHaveValue('5');

  await viewer(page).locator('.pdfwizard-scroller').focus();
  await page.keyboard.press('Home');
  await expect.poll(current).toBe(0);
  await page.keyboard.press('End');
  await expect.poll(current).toBe(5);
  await page.keyboard.press('ArrowLeft');
  await expect.poll(current).toBe(4);
});

test('view rotation and page layouts', async ({ page }) => {
  await openFixture(page, 'sample.pdf');
  const w = (await pageEl(page, 0).boundingBox())!;
  await viewMenu(page, 'Rotate view clockwise');
  await expect.poll(async () => (await getDoc(page)).view.rotation).toBe(90);
  await expect(pageEl(page, 0)).toHaveAttribute('data-rotation', '90');
  await waitForPagesRendered(page);
  const r = (await pageEl(page, 0).boundingBox())!;
  expect(r.width).toBeGreaterThan(r.height);
  // View rotation doesn't change the document.
  expect((await getDoc(page)).dirty).toBe(false);
  expect((await getDoc(page)).rotations).toEqual([0, 0, 0, 0, 0, 0]);
  await viewer(page).locator('.pdfwizard-scroller').focus();
  await page.keyboard.press('ControlOrMeta+Shift+Minus');
  await expect.poll(async () => (await getDoc(page)).view.rotation).toBe(0);
  await expect.poll(async () => Math.round((await pageEl(page, 0).boundingBox())!.width)).toBe(Math.round(w.width));

  await viewMenu(page, 'Fit page');
  await viewMenu(page, 'Single page');
  await expect.poll(async () => (await getDoc(page)).view.layout).toBe('single');
  await expect.poll(() => mountedPages(page)).toBe(1);
  await page.getByTestId('next-page').click();
  await expect(pageEl(page, 1)).toBeVisible();
  await expect.poll(() => mountedPages(page)).toBe(1);

  await viewMenu(page, 'Two pages');
  await expect.poll(async () => (await getDoc(page)).view.layout).toBe('two-page');
  await expect.poll(() => mountedPages(page)).toBe(2);
  const [a, b] = [(await viewer(page).locator('[data-testid=page]').nth(0).boundingBox())!, (await viewer(page).locator('[data-testid=page]').nth(1).boundingBox())!];
  expect(Math.abs(a.y - b.y)).toBeLessThan(2);

  await viewMenu(page, 'Two pages scrolling');
  await expect.poll(async () => (await getDoc(page)).view.layout).toBe('two-page-continuous');
  await expect.poll(() => mountedPages(page)).toBeGreaterThanOrEqual(4);

  await viewMenu(page, 'Continuous scrolling');
  await expect.poll(async () => (await getDoc(page)).view.layout).toBe('continuous');
  await waitForPagesRendered(page);
});

// ── download / library / share ────────────────────────────────────────────────

test('download produces a valid PDF with the edited order and rotation', async ({ page }) => {
  await openFixture(page, 'sample.pdf');
  await engineOp(page, 'rotatePages', [1], 90); // "Contents" page
  await engineOp(page, 'deletePages', [3]); // drop "2 Document Workflows"
  await engineOp(page, 'movePagesTo', [4], 0); // "4 Conclusion" first
  expect((await getDoc(page)).dirty).toBe(true);

  const { download, bytes } = await captureDownload(page, () => page.getByTestId('download').click());
  expect(download.suggestedFilename()).toBe('sample.pdf');
  const info = await inspectPdf(bytes);
  expect(info.numPages).toBe(5);
  expect(info.pages.map((p) => sampleIndexOf(p.text))).toEqual([5, 0, 1, 2, 4]);
  expect(info.pages.map((p) => p.rotation)).toEqual([0, 0, 90, 0, 0]);
  expect(info.outlineCount).toBe(6);

  // No link may point at the deleted page.
  const lib = await loadLib(bytes);
  expect(lib.getPageCount()).toBe(5);
  expect(lib.getPages().map((p) => p.getRotation().angle)).toEqual([0, 0, 90, 0, 0]);
  // The TOC (now page 3) had 10 links; the 3 that targeted the deleted page are gone, the rest still resolve.
  const pdfjsDeadLinks = await (async () => {
    const { doc, close } = await openPdfjs(bytes);
    const annots = await (await doc.getPage(3)).getAnnotations();
    const links = annots.filter((a: { subtype: string }) => a.subtype === 'Link');
    let dead = 0;
    for (const l of links as { dest?: unknown; url?: string }[]) {
      if (l.url) continue;
      const dest = typeof l.dest === 'string' ? await doc.getDestination(l.dest) : (l.dest as unknown[] | undefined);
      if (!dest || dest[0] == null) dead++;
    }
    await close();
    return { dead, count: links.length };
  })();
  expect(pdfjsDeadLinks).toEqual({ dead: 0, count: 7 });

  // Downloading marks the document as saved on this device.
  await expect.poll(async () => (await getDoc(page)).dirty).toBe(false);
});

test('engine.replaceBytes swaps the whole file as one undo step and keeps page ids and objects', async ({ page }) => {
  await openFixture(page, 'sample.pdf');
  const before = await getDoc(page);
  await page.evaluate((ids) => {
    const { actions, getActiveDoc } = window.__app;
    const mk = (id: string, pageId: string) => ({ id, kind: 'note', pageId, rect: { x: 50, y: 50, width: 20, height: 20 }, author: 'e2e', createdAt: 0, modifiedAt: 0, data: { icon: 'Comment' } });
    actions.addObjects(getActiveDoc().id, [mk('rb-first', ids[0]), mk('rb-last', ids[5])]);
  }, before.pageIds);

  // A transform that doesn't produce a PDF is rejected and nothing changes.
  const bad = await page.evaluate(() =>
    window.__engine.replaceBytes(window.__app.getActiveDoc().id, 'Broken', () => new TextEncoder().encode('not a pdf')).then(() => 'ok', (e: Error) => e.message),
  );
  expect(bad).toContain("didn't produce a PDF");
  expect((await getDoc(page)).pageIds).toEqual(before.pageIds);

  // Drop the last page in the "server" transform: ids are kept by index, the last page's object goes.
  let returned = 0;
  await expectNewVersion(page, async () => {
    returned = await page.evaluate(async () => {
      const e = window.__engine;
      const out: Uint8Array = await e.replaceBytes(window.__app.getActiveDoc().id, 'Optimize', async (bytes: Uint8Array) => {
        const lib = await e.loadLib(bytes);
        lib.removePage(5);
        return lib.save();
      });
      return out.length;
    });
  });
  expect(returned).toBeGreaterThan(0);
  const after = await getDoc(page);
  expect(after.pageIds).toEqual(before.pageIds.slice(0, 5));
  const objectIds = () => page.evaluate(() => Object.keys(window.__app.getActiveDoc().objects).sort());
  expect(await objectIds()).toEqual(['rb-first']);
  expect(await page.evaluate(() => window.__app.getActiveDoc().history.past.at(-1)?.label)).toBe('Optimize');

  await expectNewVersion(page, () => page.evaluate(() => window.__app.actions.undo(window.__app.getActiveDoc().id)));
  expect((await getDoc(page)).pageIds).toEqual(before.pageIds);
  expect(await objectIds()).toEqual(['rb-first', 'rb-last']);

  // dropObjects: the transform's output already contains the objects (e.g. a signed export).
  await expectNewVersion(page, () =>
    page.evaluate(() => window.__engine.replaceBytes(window.__app.getActiveDoc().id, 'Sign', (b: Uint8Array) => b, { dropObjects: true })),
  );
  expect((await getDoc(page)).pageIds).toEqual(before.pageIds);
  expect(await objectIds()).toEqual([]);
});

test('save to the library, see it on Home with a thumbnail, and reopen it', async ({ page }) => {
  await openFixture(page, 'sample.pdf');
  await engineOp(page, 'rotatePages', [0], 90);
  await page.getByTestId('save').click();
  await expect(page.getByTestId('toast').filter({ hasText: 'Saved' })).toBeVisible();
  await expect.poll(async () => (await getDoc(page)).fileId).not.toBeNull();
  const d = await getDoc(page);
  expect(d.dirty).toBe(false);
  await expect(page.getByTestId('doc-status')).toHaveAttribute('data-state', 'saved');

  const meta = await page.evaluate((id) => window.__library.getFile(id), d.fileId);
  expect(meta.pages).toBe(6);
  const saved = await inspectPdf(await fetchLibraryBytes(page, d.fileId!));
  expect(saved.pages[0].rotation).toBe(90);

  await page.getByTestId('nav-home').click();
  const item = page.getByTestId('library-item').filter({ hasText: 'sample.pdf' }).first();
  await expect(item).toBeVisible();
  const img = item.locator('img');
  await expect(img).toHaveAttribute('src', /^blob:/);
  await expect.poll(() => img.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth)).toBeGreaterThan(0);

  // Reopening an already-open library file switches to its tab.
  await item.click();
  await waitForDocReady(page);
  expect((await getAppState(page)).tabs).toHaveLength(1);
  expect(page.url()).toContain(`#/file/${d.fileId}`);

  // Deep link in a fresh page.
  const other = await page.context().newPage();
  const errors: string[] = [];
  other.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await other.goto(`/#/file/${d.fileId}`);
  await waitForDocReady(other, 'sample.pdf');
  await waitForPagesRendered(other);
  const reopened = await getDoc(other);
  expect(reopened.fileId).toBe(d.fileId);
  expect(reopened.pageCount).toBe(6);
  expect(reopened.rotations[0]).toBe(90);
  expect(reopened.dirty).toBe(false);
  expect(errors).toEqual([]);
  await other.close();
});

test('Send a copy downloads the document with its current changes', async ({ page }) => {
  await openFixture(page, 'sample.pdf');
  await engineOp(page, 'rotatePages', [0], 90);
  await page.getByTestId('share').click();
  await expect(page.getByTestId('share-download')).toBeVisible();
  const { download, bytes } = await captureDownload(page, () => page.getByTestId('share-download').click());
  expect(download.suggestedFilename()).toBe('sample.pdf');
  const info = await inspectPdf(bytes);
  expect(info.pages).toHaveLength(6);
  expect(info.pages[0].rotation).toBe(90);
  // Nothing was saved to the library by sending.
  expect((await getDoc(page)).fileId).toBeNull();
});

// ── fixtures ──────────────────────────────────────────────────────────────────

test('encrypted.pdf opens with its password and stays encrypted when saved', async ({ page }) => {
  await gotoHome(page);
  await page.getByTestId('open-file-input').setInputFiles('fixtures/encrypted.pdf');
  await page.getByTestId('password-input').fill('wrong');
  await page.getByTestId('password-submit').click();
  await expect(page.getByTestId('modal')).toContainText('Incorrect password');
  await page.getByTestId('password-input').fill('secret');
  await page.getByTestId('password-submit').click();
  await waitForDocReady(page, 'encrypted.pdf');
  await waitForPagesRendered(page);
  await expect(pageEl(page, 0).locator('.textLayer')).toContainText('Confidential Budget Summary');
  expect((await getDoc(page)).pageCount).toBe(2);

  await engineOp(page, 'rotatePages', [0], 90);
  const { bytes } = await captureDownload(page, () => page.getByTestId('download').click());
  expect(await needsPassword(bytes)).toBe(true);
  const info = await inspectPdf(bytes, 'secret');
  expect(info.numPages).toBe(2);
  expect(info.pages[0].rotation).toBe(90);
  expect(info.pages[0].text).toContain('Confidential Budget Summary');
  expect((await loadLib(bytes, { ignoreEncryption: true })).isEncrypted).toBe(true);

  await page.getByTestId('save').click();
  await expect.poll(async () => (await getDoc(page)).fileId).not.toBeNull();
  const lib = await fetchLibraryBytes(page, (await getDoc(page)).fileId!);
  expect(await needsPassword(lib)).toBe(true);
  expect((await inspectPdf(lib, 'secret')).pages[0].rotation).toBe(90);
});

test('form.pdf: filled values persist in the downloaded file', async ({ page }) => {
  await openFixture(page, 'form.pdf');
  const layer = pageEl(page, 0).locator('.annotationLayer');
  await layer.locator('input[name=full_name]').fill('Jane Doe');
  await layer.locator('input[name=email]').fill('jane@example.com');
  await layer.locator('select[name=country]').selectOption({ index: 2 });
  const country = await layer.locator('select[name=country]').inputValue();
  await layer.locator('input[name=newsletter]').check();
  await layer.locator('input[name=contact_method]').nth(1).check();
  await layer.locator('textarea[name=comments]').fill('Line one\nLine two');
  await layer.locator('input[name=full_name]').press('Tab');
  await expect.poll(async () => (await getDoc(page)).dirty).toBe(true);

  const { bytes } = await captureDownload(page, () => page.getByTestId('download').click());
  const form = (await loadLib(bytes)).getForm();
  expect(form.getTextField('full_name').getText()).toBe('Jane Doe');
  expect(form.getTextField('email').getText()).toBe('jane@example.com');
  expect(form.getDropdown('country').getSelected()).toEqual([country]);
  expect(form.getCheckBox('newsletter').isChecked()).toBe(true);
  expect(form.getCheckBox('agree_terms').isChecked()).toBe(false);
  expect(form.getRadioGroup('contact_method').getSelected()).toBe('phone');
  expect(form.getTextField('comments').getText()).toBe('Line one\nLine two');
  expect(form.getTextField('phone').getText() ?? '').toBe('');
});

test('annotated.pdf shows its annotations', async ({ page }) => {
  // pdf.js rendering of existing annotations; feature importers (comments, drawing…) would turn them into objects.
  await page.goto('/?features=thumbnails');
  await openFixture(page, 'annotated.pdf');
  const p1 = pageEl(page, 0).locator('.annotationLayer');
  for (const kind of ['textAnnotation', 'highlightAnnotation', 'underlineAnnotation', 'strikeoutAnnotation', 'squigglyAnnotation']) {
    await expect(p1.locator(`section.${kind}`).first(), kind).toBeAttached();
  }
  // Markup appearances are painted on the canvas: sample the first highlight (#ffe14d) for yellow pixels.
  const color = await pageEl(page, 0).evaluate((el) => {
    const canvas = el.querySelector('canvas')!;
    const cr = canvas.getBoundingClientRect();
    const hr = el.querySelector<HTMLElement>('.annotationLayer section.highlightAnnotation')!.getBoundingClientRect();
    const s = canvas.width / cr.width;
    const px = canvas.getContext('2d')!.getImageData(Math.round((hr.left - cr.left + 2) * s), Math.round((hr.top - cr.top + 2) * s), 1, 1).data;
    return [px[0], px[1], px[2]];
  });
  expect(color[0]).toBeGreaterThan(200);
  expect(color[1]).toBeGreaterThan(180);
  expect(color[2]).toBeLessThan(160);

  await page.getByTestId('next-page').click();
  await waitForPagesRendered(page);
  const p2 = pageEl(page, 1).locator('.annotationLayer');
  for (const kind of ['squareAnnotation', 'circleAnnotation', 'lineAnnotation', 'inkAnnotation', 'freeTextAnnotation', 'stampAnnotation']) {
    await expect(p2.locator(`section.${kind}`).first(), kind).toBeAttached();
  }
});

test('rotated.pdf pages are oriented correctly', async ({ page }) => {
  await openFixture(page, 'rotated.pdf');
  const d = await getDoc(page);
  expect(d.rotations).toEqual([0, 90, 180, 270, 0, 0, 90]);
  await page.evaluate(() => window.__app.actions.setZoom(window.__app.getActiveDoc().id, 0.3));
  for (let i = 0; i < 7; i++) {
    await page.evaluate((i) => window.__app.actions.goToPage(null, i), i);
    await expect(pageEl(page, i)).toHaveClass(/is-painted/);
    const m = await pageEl(page, i).evaluate((el) => {
      const pr = el.getBoundingClientRect();
      const top = [...el.querySelectorAll<HTMLElement>('.textLayer span')].find((s) => s.textContent?.trim() === 'TOP')!;
      const tr = top.getBoundingClientRect();
      return { w: pr.width, h: pr.height, cx: (tr.left + tr.width / 2 - pr.left) / pr.width, cy: (tr.top + tr.height / 2 - pr.top) / pr.height };
    });
    const landscape = d.rotations[i] % 180 !== 0;
    expect(m.w > m.h, `page ${i + 1} landscape`).toBe(landscape);
    // "TOP" is printed upright at the top centre of every page once rotation is applied.
    expect(m.cy, `page ${i + 1} TOP near top`).toBeLessThan(0.2);
    expect(Math.abs(m.cx - 0.5), `page ${i + 1} TOP centred`).toBeLessThan(0.1);
  }
  // Non-zero-origin MediaBox (page 5) and CropBox page (page 6) keep their proportions.
  const p5 = (await pageEl(page, 4).boundingBox())!;
  expect(p5.width / p5.height).toBeCloseTo(612 / 792, 2);
  const p6 = (await pageEl(page, 5).boundingBox())!;
  expect(p6.width / p6.height).toBeCloseTo(468 / 576, 2);
});

test('large.pdf opens fast, virtualizes pages and scrolls smoothly', async ({ page }) => {
  await gotoHome(page);
  const t0 = Date.now();
  await page.getByTestId('open-file-input').setInputFiles('fixtures/large.pdf');
  await expect(viewer(page).locator('[data-testid=page].is-painted').first()).toBeVisible();
  expect(Date.now() - t0).toBeLessThan(5000);
  const d = await getDoc(page);
  expect(d.pageCount).toBe(300);
  expect(d.outlineCount).toBe(12);

  let maxCanvases = 0;
  let maxMounted = 0;
  const sc = (await viewer(page).locator('.pdfwizard-scroller').boundingBox())!;
  await page.mouse.move(sc.x + sc.width / 2, sc.y + sc.height / 2);
  for (let i = 0; i < 30; i++) {
    await page.mouse.wheel(0, 2500);
    await page.waitForTimeout(40);
    const c = await page.evaluate(() => ({
      canvases: document.querySelectorAll('[data-testid=document-viewer] canvas').length,
      mounted: document.querySelectorAll('[data-testid=document-viewer] [data-testid=page]').length,
    }));
    maxCanvases = Math.max(maxCanvases, c.canvases);
    maxMounted = Math.max(maxMounted, c.mounted);
  }
  expect(maxMounted).toBeLessThanOrEqual(8);
  expect(maxCanvases).toBeLessThanOrEqual(8);
  expect((await getDoc(page)).view.currentPage).toBeGreaterThan(20);

  await page.getByTestId('page-input').fill('250');
  await page.getByTestId('page-input').press('Enter');
  await expect.poll(async () => (await getDoc(page)).view.currentPage).toBe(249);
  await waitForPagesRendered(page);
  await expect(pageEl(page, 249).locator('.textLayer')).toContainText('R-0250');

  // Frame pacing while scrolling programmatically.
  const frames = await page.evaluate(async () => {
    const el = document.querySelector<HTMLElement>('[data-testid=document-viewer] .pdfwizard-scroller')!;
    let n = 0;
    let worst = 0;
    let last = performance.now();
    const start = last;
    await new Promise<void>((done) => {
      const step = () => {
        const now = performance.now();
        worst = Math.max(worst, now - last);
        last = now;
        n++;
        el.scrollTop -= 150;
        if (now - start < 1500) requestAnimationFrame(step);
        else done();
      };
      requestAnimationFrame(step);
    });
    return { n, worst };
  });
  expect(frames.n).toBeGreaterThan(40);

  // Thumbnails are lazy too: the panel scrolls to the current page and only renders what is near it.
  await openThumbnails(page, (await getDoc(page)).view.currentPage);
  await expect(page.getByTestId('thumbnails-panel').getByTestId('thumbnail')).toHaveCount(300);
  expect(await page.getByTestId('thumbnails-panel').locator('img').count()).toBeLessThan(40);
});

// ── shell UI ──────────────────────────────────────────────────────────────────

test('command palette, menus and keyboard shortcuts', async ({ page }) => {
  await openFixture(page, 'sample.pdf');

  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByTestId('command-palette')).toBeVisible();
  await page.getByTestId('palette-input').fill('fit page');
  await expect(page.getByTestId('palette-item').first()).toContainText('Fit page');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('command-palette')).toHaveCount(0);
  await expect.poll(async () => (await getDoc(page)).view.fit).toBe('page');

  await page.getByTestId('palette-trigger').click();
  await page.getByTestId('palette-input').fill('night');
  await page.getByTestId('palette-item').filter({ hasText: 'Night mode' }).click();
  await expect(viewer(page)).toHaveClass(/is-dark-pages/);
  await viewMenu(page, 'Night mode');
  await expect(viewer(page)).not.toHaveClass(/is-dark-pages/);

  await page.getByTestId('app-menu').click();
  for (const label of ['Open…', 'Save', 'Save as…', 'Download', 'Send a copy…', 'Print…', 'Close']) await expect(menuItem(page, label)).toBeVisible();
  await page.keyboard.press('Escape');

  await viewer(page).locator('.pdfwizard-scroller').focus();
  await page.keyboard.press('ControlOrMeta+0');
  await expect.poll(async () => (await getDoc(page)).view.zoom).toBeCloseTo(1, 3);
  await page.keyboard.press('ControlOrMeta+Equal');
  await expect.poll(async () => (await getDoc(page)).view.zoom).toBeCloseTo(1.1, 3);
  await page.keyboard.press('ControlOrMeta+Minus');
  await expect.poll(async () => (await getDoc(page)).view.zoom).toBeCloseTo(1, 3);
  await page.keyboard.press('ControlOrMeta+Alt+2');
  await expect.poll(async () => (await getDoc(page)).view.fit).toBe('width');
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await getDoc(page)).view.currentPage).toBe(1);

  await page.keyboard.press('h');
  await expect.poll(async () => (await getAppState(page)).activeToolId).toBe('hand');
  await page.keyboard.press('v');
  await expect.poll(async () => (await getAppState(page)).activeToolId).toBe('select');

  await page.keyboard.press('Shift+?');
  await expect(page.getByTestId('shortcuts-list')).toBeVisible();
  await expect(page.getByTestId('shortcuts-list')).toContainText('Zoom in');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('shortcuts-list')).toHaveCount(0);

  const leftOpen = await page.getByTestId('left-panel').count();
  await page.keyboard.press('F4');
  await expect(page.getByTestId('left-panel')).toHaveCount(leftOpen ? 0 : 1);
  await page.keyboard.press('F4');
  await expect(page.getByTestId('left-panel')).toHaveCount(leftOpen);
});

test('preferences: dark theme and name persist across reloads', async ({ page }) => {
  await gotoHome(page);
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByTestId('palette-input').fill('Preferences');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('modal')).toBeVisible();
  await page.getByRole('radio', { name: 'Dark' }).click();
  await page.getByTestId('prefs-name').fill('E2E Tester');
  await page.getByTestId('prefs-save').click();
  await expect(page.getByTestId('modal')).toHaveCount(0);
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByTestId('account-menu')).toHaveText('ET');
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const [r, g, b] = bg.match(/\d+/g)!.map(Number);
  expect(r + g + b).toBeLessThan(200);

  await page.reload();
  await expect(page.getByTestId('library')).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.evaluate(() => window.__app.useApp.getState().prefs.userName)).toBe('E2E Tester');
  await expect(page.getByText('E2E', { exact: false }).first()).toBeVisible();
});
