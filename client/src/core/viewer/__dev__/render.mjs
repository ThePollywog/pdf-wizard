// Crispness (DPR 2), rotations, CropBox, view rotation, layouts, dark pages.
import { open, shot, report, waitPainted } from './pw.mjs';

const { browser, page, errors } = await open('rotated.pdf', { dpr: 2 });
const info = () =>
  page.evaluate(() =>
    [...document.querySelectorAll('.pdfwizard-page')].map((el) => {
      const c = el.querySelector('canvas.pdfwizard-canvas');
      const r = el.getBoundingClientRect();
      return { i: +el.dataset.pageIndex, css: [Math.round(r.width), Math.round(r.height)], canvas: c ? [c.width, c.height, c.style.width, c.style.height, c.style.transform] : null };
    }),
  );
console.log('pages', await page.evaluate(() => __h.doc().pages.map((p) => ({ r: p.rotation, w: p.width, h: p.height, view: p.view }))));
console.log('dpr2', await info());
await page.evaluate(() => __h.actions.fit(__h.docId(), 'page'));
await page.waitForTimeout(600);
for (let i = 0; i < 6; i++) {
  await page.evaluate((i) => __h.actions.goToPage(__h.docId(), i), i);
  await page.waitForTimeout(500);
  await waitPainted(page);
  await shot(page, `rot-page${i + 1}`);
}
console.log('fitpage', await info());
// View rotation 90 on page 1.
await page.evaluate(() => { __h.actions.goToPage(__h.docId(), 0); __h.actions.rotateView(__h.docId(), 90); });
await page.waitForTimeout(800);
await shot(page, 'rot-view90');
console.log('view90', await info());
await page.evaluate(() => __h.actions.rotateView(__h.docId(), -90));
// Layouts
for (const layout of ['two-page', 'two-page-continuous', 'single']) {
  await page.evaluate((layout) => __h.actions.setView(__h.docId(), { layout }), layout);
  await page.waitForTimeout(700);
  await shot(page, `layout-${layout}`);
}
await page.evaluate(() => __h.actions.setView(__h.docId(), { layout: 'continuous', darkPages: true }));
await page.waitForTimeout(700);
await shot(page, 'dark');
report(errors);
await browser.close();
