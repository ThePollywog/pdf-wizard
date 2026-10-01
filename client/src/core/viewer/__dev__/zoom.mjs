// Ctrl+wheel anchoring, keyboard zoom, fit on resize, paged-mode flipping, large-doc virtualization.
import { open, shot, report, waitPainted } from './pw.mjs';

const { browser, page, errors } = await open('sample.pdf');
const probe = (x, y) =>
  page.evaluate(
    ({ x, y }) => {
      const el = document.elementsFromPoint(x, y).find((e) => e.classList?.contains('pdfwizard-page'));
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { page: +el.dataset.pageIndex, fx: +((x - r.left) / r.width).toFixed(4), fy: +((y - r.top) / r.height).toFixed(4), zoom: __h.doc().view.zoom };
    },
    { x, y },
  );
const X = 700, Y = 500;
await page.evaluate(() => __h.actions.goToPage(__h.docId(), 1));
await page.waitForTimeout(600);
await page.mouse.move(X, Y);
const before = await probe(X, Y);
for (let i = 0; i < 4; i++) {
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -100);
  await page.keyboard.up('Control');
  await page.waitForTimeout(40);
}
const mid = await probe(X, Y);
await page.waitForTimeout(700);
const after = await probe(X, Y);
console.log('ctrl+wheel in ', { before, mid, after });
await shot(page, 'zoom-in-anchor');
for (let i = 0; i < 6; i++) {
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, 100);
  await page.keyboard.up('Control');
  await page.waitForTimeout(40);
}
await page.waitForTimeout(700);
console.log('ctrl+wheel out', await probe(X, Y));
await waitPainted(page);
await shot(page, 'zoom-out-anchor');

// Fit width recomputed on resize.
await page.evaluate(() => __h.actions.fit(__h.docId(), 'width'));
await page.waitForTimeout(400);
const z1 = await page.evaluate(() => __h.doc().view.zoom);
await page.setViewportSize({ width: 1000, height: 860 });
await page.waitForTimeout(600);
const z2 = await page.evaluate(() => __h.doc().view.zoom);
console.log('fit width on resize', z1, '→', z2, 'page', await page.evaluate(() => __h.doc().view.currentPage));
await page.setViewportSize({ width: 1280, height: 860 });
await page.waitForTimeout(400);

// Paged mode: PageDown / wheel flip.
await page.evaluate(() => { __h.actions.setView(__h.docId(), { layout: 'single' }); __h.actions.fit(__h.docId(), 'page'); __h.actions.goToPage(__h.docId(), 0); });
await page.waitForTimeout(600);
await page.click('.pdfwizard-scroller', { position: { x: 20, y: 300 } });
await page.keyboard.press('PageDown');
await page.waitForTimeout(300);
const p1 = await page.evaluate(() => __h.doc().view.currentPage);
await page.mouse.move(500, 400);
for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 300); await page.waitForTimeout(350); }
const p2 = await page.evaluate(() => __h.doc().view.currentPage);
await page.keyboard.press('PageUp');
await page.waitForTimeout(300);
console.log('single: PageDown →', p1, ' wheel →', p2, ' PageUp →', await page.evaluate(() => __h.doc().view.currentPage), 'mounted', await page.evaluate(() => document.querySelectorAll('.pdfwizard-page').length));
await shot(page, 'single-mode');
await page.evaluate(() => __h.actions.setView(__h.docId(), { layout: 'two-page-continuous' }));
await page.waitForTimeout(500);
await shot(page, 'two-page-continuous');

// Large document.
await page.evaluate(() => __h.load('large.pdf'));
await waitPainted(page);
const t0 = Date.now();
await page.evaluate(() => __h.actions.goToPage(__h.docId(), 199));
await page.waitForFunction(() => document.querySelector('.pdfwizard-page[data-page-index="199"].is-painted'), null, { timeout: 15000 });
console.log('large: jump to 200 painted in', Date.now() - t0, 'ms; mounted', await page.evaluate(() => [...document.querySelectorAll('.pdfwizard-page')].map((e) => +e.dataset.pageIndex)), 'current', await page.evaluate(() => __h.doc().view.currentPage));
// fast scroll through
for (let i = 0; i < 20; i++) { await page.mouse.wheel(0, 2500); await page.waitForTimeout(30); }
await page.waitForTimeout(800);
console.log('after fling mounted', await page.evaluate(() => [...document.querySelectorAll('.pdfwizard-page')].map((e) => +e.dataset.pageIndex + (e.classList.contains('is-painted') ? '*' : ''))), 'canvases', await page.evaluate(() => document.querySelectorAll('canvas').length), 'thumbs loaded', await page.evaluate(() => document.querySelectorAll('.pdfwizard-thumb.is-loaded').length));
await shot(page, 'large');
report(errors);
await browser.close();
