// Objects: draw with tool, select, move (drag threshold + single undo), resize, keys, clipboard,
// marquee, properties bar, context menus, comment popover, lock, double-click edit.
import { open, shot, report } from './pw.mjs';

const { browser, page, errors } = await open('sample.pdf');
const state = () => page.evaluate(() => { const d = __h.doc(); return { n: d.order.length, sel: d.selection.length, editing: d.editingId, past: d.history.past.length, rects: d.order.map((id) => { const r = d.objects[id].rect; return [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; }) }; });
const box = (sel) => page.evaluate((sel) => { const b = document.querySelector(sel)?.getBoundingClientRect(); return b && { x: b.left, y: b.top, w: b.width, h: b.height, cx: b.left + b.width / 2, cy: b.top + b.height / 2 }; }, sel);

// Draw with the rect tool.
await page.evaluate(() => __h.actions.setTool('test-rect'));
await page.mouse.move(300, 300);
await page.mouse.down();
await page.mouse.move(420, 380, { steps: 6 });
await page.mouse.move(460, 400, { steps: 3 });
await page.mouse.up();
await page.waitForTimeout(300);
console.log('drawn', await state(), 'tool', await page.evaluate(() => __h.useApp.getState().activeToolId));
await shot(page, 'obj-drawn');

// Click elsewhere deselects; click on object selects.
await page.mouse.click(700, 600);
await page.waitForTimeout(100);
const o = await box('.pdfwizard-obj');
await page.mouse.click(o.cx, o.cy);
await page.waitForTimeout(200);
console.log('selected', (await state()).sel, 'handles', await page.locator('.pdfwizard-handle').count(), 'bar', await page.locator('.pdfwizard-props-bar').count());
await shot(page, 'obj-selected');

// Tiny movement below threshold: no change.
const s0 = await state();
await page.mouse.move(o.cx, o.cy);
await page.mouse.down();
await page.mouse.move(o.cx + 2, o.cy + 1);
await page.mouse.up();
console.log('sub-threshold unchanged', JSON.stringify((await state()).rects) === JSON.stringify(s0.rects), 'past', (await state()).past, s0.past);

// Drag move.
await page.mouse.move(o.cx, o.cy);
await page.mouse.down();
for (let i = 1; i <= 10; i++) await page.mouse.move(o.cx + i * 10, o.cy + i * 5);
await shot(page, 'obj-moving');
await page.mouse.up();
const s1 = await state();
console.log('moved', s1.rects, 'past', s0.past, '→', s1.past);

// Resize by SE handle.
const h = await box('.pdfwizard-handle-se');
await page.mouse.move(h.cx, h.cy);
await page.mouse.down();
for (let i = 1; i <= 6; i++) await page.mouse.move(h.cx + i * 10, h.cy + i * 8);
await page.mouse.up();
console.log('resized', (await state()).rects);
// Resize below minSize from NW handle.
const hn = await box('.pdfwizard-handle-nw');
await page.mouse.move(hn.cx, hn.cy);
await page.mouse.down();
await page.mouse.move(hn.cx + 600, hn.cy + 600, { steps: 8 });
await page.mouse.up();
console.log('min-size clamp', (await state()).rects);
await page.evaluate(() => __h.actions.undo()); // undo is a shell shortcut (not installed in the harness)
await page.waitForTimeout(100);
console.log('undo resize', (await state()).rects);

// Arrow nudges.
await page.keyboard.press('ArrowRight');
await page.keyboard.press('Shift+ArrowUp');
console.log('nudged', (await state()).rects);

// Copy/paste/duplicate/select all.
await page.keyboard.press('Meta+c');
await page.keyboard.press('Meta+v');
await page.waitForTimeout(150);
console.log('pasted', await state());
await page.keyboard.press('Meta+d');
await page.waitForTimeout(150);
await page.keyboard.press('Meta+a');
await page.waitForTimeout(150);
console.log('dup + select all', (await state()).n, (await state()).sel);
await shot(page, 'obj-multi');

// Properties bar generic controls: open stroke dropdown on multi-selection.
const chips = await page.locator('.pdfwizard-props-bar button').evaluateAll((bs) => bs.map((b) => b.getAttribute('aria-label') || b.textContent?.trim()));
console.log('bar buttons', chips);

// Escape clears; marquee selects two.
await page.keyboard.press('Escape');
console.log('after esc sel', (await state()).sel);
const all = await page.evaluate(() => [...document.querySelectorAll('.pdfwizard-obj')].map((e) => { const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, r: b.right, b: b.bottom }; }));
const minX = Math.min(...all.map((a) => a.x)), minY = Math.min(...all.map((a) => a.y));
// Start in the blank left margin (starting on a text span selects text instead, like desktop PDF editors).
const pageLeft = await page.evaluate(() => document.querySelector('.pdfwizard-page').getBoundingClientRect().left);
await page.mouse.move(pageLeft + 12, minY - 12);
await page.mouse.down();
await page.mouse.move(minX + 60, minY + 60, { steps: 5 });
await page.mouse.move(Math.max(...all.map((a) => a.r)) + 10, Math.max(...all.map((a) => a.b)) + 10, { steps: 5 });
await shot(page, 'obj-marquee');
await page.mouse.up();
console.log('marquee sel', (await state()).sel, 'text selection empty', await page.evaluate(() => String(getSelection())) === '');

// Delete, undo.
await page.keyboard.press('Delete');
console.log('deleted', (await state()).n);
await page.evaluate(() => __h.actions.undo()); // undo is a shell shortcut (not installed in the harness)
console.log('undo delete', (await state()).n);

// Context menus.
await page.keyboard.press('Escape');
const first = await box('.pdfwizard-obj');
await page.mouse.click(first.cx, first.cy, { button: 'right' });
await page.waitForTimeout(200);
console.log('object menu', await page.locator('[role="menu"] [role="menuitem"]').allInnerTexts());
await shot(page, 'ctx-object');
await page.keyboard.press('Escape');
await page.mouse.click(250, 700, { button: 'right' });
await page.waitForTimeout(200);
console.log('page menu', await page.locator('[role="menu"] [role="menuitem"]').allInnerTexts());
await shot(page, 'ctx-page');
await page.keyboard.press('Escape');

// Comment popover via properties bar.
await page.mouse.click(first.cx, first.cy);
await page.waitForTimeout(150);
const commentBtn = page.locator('.pdfwizard-props-bar button[aria-label*="omment"]').first();
await commentBtn.click();
await page.waitForTimeout(250);
await page.keyboard.type('Looks good to me');
await shot(page, 'comment-popover');
await page.keyboard.press('Meta+Enter');
await page.waitForTimeout(150);
console.log('comment saved', await page.evaluate(() => { const d = __h.doc(); return d.objects[d.selection[0]]?.contents; }));

// Lock via More menu, then Delete must not delete, move must not move.
await page.locator('.pdfwizard-props-bar button[aria-label="More options"]').click();
await page.waitForTimeout(150);
console.log('more menu', await page.locator('[role="menu"] [role="menuitem"]').allInnerTexts());
await page.locator('[role="menu"] [role="menuitem"]', { hasText: 'Lock' }).first().click();
await page.waitForTimeout(150);
const before = await state();
await page.keyboard.press('Delete');
const lb = await box('.pdfwizard-obj.is-selected');
await page.mouse.move(lb.cx, lb.cy);
await page.mouse.down();
await page.mouse.move(lb.cx + 80, lb.cy + 40, { steps: 5 });
await page.mouse.up();
const after = await state();
console.log('locked: count', before.n, '→', after.n, 'rect unchanged', JSON.stringify(before.rects) === JSON.stringify(after.rects), 'handles', await page.locator('.pdfwizard-handle').count());
await shot(page, 'obj-locked');

// Double-click edits (unlocked object; deselect first so the locked object's hit frame is gone).
await page.keyboard.press('Escape');
// Pick a point of an unlocked object that is not covered by the (topmost) locked one.
await page.waitForTimeout(100);
const other = await page.evaluate(() => {
  const tried = [];
  for (const el of document.querySelectorAll('.pdfwizard-obj:not(.is-locked)')) {
    const b = el.getBoundingClientRect();
    for (const [fx, fy] of [[0.9, 0.05], [0.05, 0.9], [0.5, 0.05], [0.05, 0.5], [0.5, 0.5]]) {
      const x = b.left + b.width * fx, y = b.top + b.height * fy;
      const top = document.elementFromPoint(x, y);
      if (top?.closest('.pdfwizard-obj') === el) return { x, y };
      tried.push([Math.round(x), Math.round(y), top?.className]);
    }
  }
  return { tried };
});
if (other.tried) throw new Error('no uncovered point ' + JSON.stringify(other.tried));
await page.mouse.dblclick(other.x, other.y);
await page.waitForTimeout(150);
console.log('editing', (await state()).editing != null, await page.locator('.pdfwizard-obj.is-editing').count());
await shot(page, 'obj-editing');
await page.keyboard.press('Escape');
console.log('esc leaves editing', (await state()).editing == null, 'sel', (await state()).sel);
report(errors);
await browser.close();
