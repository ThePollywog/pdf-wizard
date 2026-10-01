// Thumbnails panel: click → goToPage, multi-select, context menu, delete confirm, DnD reorder, sizes.
import { open, shot, report, waitPainted } from './pw.mjs';

const { browser, page, errors } = await open('sample.pdf');
await page.waitForFunction(() => document.querySelectorAll('.thumbnails-item .pdfwizard-thumb.is-loaded').length >= 3, null, { timeout: 20000 });

const item = (i) => page.locator(`.thumbnails-item[data-page-index="${i}"]`);
const st = () =>
  page.evaluate(() => {
    const d = __h.doc();
    return {
      n: d.pages.length,
      cur: d.view.currentPage,
      ids: d.pages.map((p) => p.id),
      rot: d.pages.map((p) => p.rotation),
      sel: [...document.querySelectorAll('.thumbnails-item.is-selected')].map((e) => +e.dataset.pageIndex),
      current: [...document.querySelectorAll('.thumbnails-item.is-current')].map((e) => +e.dataset.pageIndex),
      summary: document.querySelector('.thumbnails-summary')?.textContent,
    };
  });
const toasts = () => page.locator('.toast-message').allInnerTexts();

console.log('engine mode', await page.evaluate(() => __h.engineMode()));
await shot(page, 'thumbs-initial');

// Click → goToPage.
await item(3).click();
await page.waitForTimeout(500);
let s = await st();
console.log('click p4 → cur', s.cur, 'current', s.current, 'sel', s.sel);

// Viewer scroll → current highlighted.
await page.evaluate(() => __h.actions.goToPage(__h.docId(), 1));
await page.waitForTimeout(500);
s = await st();
console.log('goToPage(1) → current', s.current, 'sel', s.sel);

// Shift / mod multi-select.
await item(1).click();
await item(3).click({ modifiers: ['Shift'] });
s = await st();
console.log('shift-range 2..4 sel', s.sel, s.summary);
await item(5).click({ modifiers: ['Meta'] });
s = await st();
console.log('meta-toggle +6 sel', s.sel, s.summary);
await item(2).click({ modifiers: ['Meta'] });
s = await st();
console.log('meta-toggle -3 sel', s.sel);
await shot(page, 'thumbs-multi');

// Context menu on a selected item → acts on the selection.
await item(1).click({ button: 'right' });
await page.waitForTimeout(150);
console.log('ctx', await page.locator('[role="menu"] [role="menuitem"]').allInnerTexts());
await shot(page, 'thumbs-ctx');
const rotBefore = (await st()).rot;
await page.locator('[role="menu"] [role="menuitem"]', { hasText: 'clockwise' }).first().click();
await page.waitForTimeout(800);
s = await st();
console.log('rotate cw', JSON.stringify(rotBefore), '→', JSON.stringify(s.rot), 'toasts', await toasts());
await page.evaluate(() => __h.actions.undo());
await page.waitForTimeout(800);
console.log('undo rotate', JSON.stringify((await st()).rot));

// Delete key → confirm dialog → cancel, then confirm.
await item(4).click();
await page.locator('.thumbnails-list').focus();
const before = await st();
await page.keyboard.press('Delete');
await page.waitForSelector('[role="alertdialog"]', { timeout: 3000 });
console.log('dialog', (await page.locator('[role="alertdialog"]').innerText()).replace(/\s+/g, ' '));
await shot(page, 'thumbs-delete-confirm');
await page.locator('[data-testid="dialog-cancel"]').click();
await page.waitForTimeout(200);
console.log('cancel keeps pages', (await st()).n === before.n);
await page.locator('.thumbnails-list').focus();
await page.keyboard.press('Delete');
await page.locator('[data-testid="dialog-confirm"]').click();
await page.waitForTimeout(1000);
s = await st();
console.log('deleted p5:', before.n, '→', s.n, 'removed id gone', !s.ids.includes(before.ids[4]));
await page.evaluate(() => __h.actions.undo());
await page.waitForTimeout(1000);
console.log('undo delete', (await st()).n);

// Insert blank after / duplicate via context menu.
await item(0).click({ button: 'right' });
await page.locator('[role="menu"] [role="menuitem"]', { hasText: 'Insert blank page after' }).click();
await page.waitForTimeout(1000);
s = await st();
console.log('insert after p1 → n', s.n, 'new id at 1', !before.ids.includes(s.ids[1]));
await page.evaluate(() => __h.actions.undo());
await page.waitForTimeout(800);

// Keyboard: arrows move focus/selection, shift extends.
await item(0).click();
await page.locator('.thumbnails-list').focus();
await page.keyboard.press('ArrowDown');
await page.keyboard.press('Shift+ArrowDown');
s = await st();
console.log('keys sel', s.sel, 'cur', s.cur);
await page.keyboard.press('Escape');

// DnD: drag page 1 to between pages 3 and 4 (gap 3).
await page.evaluate(() => __h.actions.goToPage(__h.docId(), 0));
await page.waitForTimeout(400);
await item(0).click();
const ids0 = (await st()).ids;
const a = await item(0).boundingBox();
const t3 = await item(3).boundingBox();
await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
await page.mouse.down();
await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2 + 20, { steps: 3 });
// Scroll the page 4 thumb into view if needed (auto-scroll on edges also exercises).
await page.mouse.move(t3.x + t3.width / 2, Math.min(t3.y + 12, 840), { steps: 12 });
await page.waitForTimeout(300);
console.log('indicator visible', await page.locator('.thumbnails-drop-indicator').count());
await shot(page, 'thumbs-drag');
await page.mouse.up();
await page.waitForTimeout(1200);
s = await st();
const expected = [ids0[1], ids0[2], ids0[0], ids0[3], ids0[4], ids0[5]];
console.log('after drop order ok', JSON.stringify(s.ids) === JSON.stringify(expected), 'toasts', await toasts());
if (JSON.stringify(s.ids) !== JSON.stringify(expected)) console.log(' got', s.ids.map((id) => ids0.indexOf(id)));
await page.evaluate(() => __h.actions.undo());
await page.waitForTimeout(1000);
console.log('undo move', JSON.stringify((await st()).ids) === JSON.stringify(ids0));

// Sizes.
for (const sz of ['S', 'L', 'M']) {
  await page.locator('.thumbnails-toolbar button', { hasText: new RegExp(`^${sz}$`) }).click();
  await page.waitForTimeout(400);
  const w = await page.evaluate(() => document.querySelector('.thumbnails-item .pdfwizard-thumb')?.getBoundingClientRect().width);
  console.log('size', sz, Math.round(w));
  if (sz !== 'M') await shot(page, `thumbs-size-${sz}`);
}

// Thumbnails refresh after a page rotation (pdfVersion bump).
const src0 = await page.locator('.thumbnails-item[data-page-index="0"] img').getAttribute('src');
await page.evaluate(() => __h.engine.rotatePages(__h.docId(), [0], 90));
await page.waitForTimeout(1500);
const src1 = await page.locator('.thumbnails-item[data-page-index="0"] img').getAttribute('src');
console.log('thumb re-rendered after rotate', src0 !== src1);
await shot(page, 'thumbs-rotated');
await waitPainted(page);

report(errors);
await browser.close();
