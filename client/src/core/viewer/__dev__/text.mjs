// Text selection alignment (markup tool → decorations), select-tool popup, copy, links.
import { open, shot, report, waitPainted } from './pw.mjs';

const { browser, page, errors } = await open('sample.pdf', { dpr: 2 });
async function spanBox(re, pageIndex = 0) {
  return page.evaluate(
    ({ src, pageIndex }) => {
      const r = new RegExp(src);
      const spans = [...document.querySelectorAll(`.pdfwizard-page[data-page-index="${pageIndex}"] .textLayer span`)];
      const s = spans.find((el) => r.test(el.textContent || ''));
      if (!s) return null;
      const b = s.getBoundingClientRect();
      return { x: b.left, y: b.top, w: b.width, h: b.height, text: s.textContent };
    },
    { src: re.source, pageIndex },
  );
}
async function dragSelect(a, b) {
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 5 });
  await page.mouse.move(b.x, b.y, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(400);
}

// 1) Markup tool at a few zoom levels → returned rects drawn as decorations over the text.
for (const zoom of [1, 1.75]) {
  await page.evaluate((z) => { __h.actions.setZoom(__h.docId(), z); __h.actions.setDecorations(__h.docId(), 'harness-textsel', null); }, zoom);
  await page.waitForTimeout(700);
  await waitPainted(page);
  await page.evaluate(() => __h.actions.setTool('test-markup'));
  const s = await spanBox(/PDF Wizard brings/);
  if (!s) throw new Error('span not found');
  await dragSelect({ x: s.x + 2, y: s.y + s.h / 2 }, { x: s.x + s.w - 2, y: s.y + s.h / 2 + s.h * 1.3 });
  const res = await page.evaluate(() => ({ sel: (window.__lastSelections || []).map((s) => ({ text: s.text.slice(0, 80), n: s.rects.length })), decos: document.querySelectorAll('.pdfwizard-deco').length }));
  console.log('markup zoom', zoom, JSON.stringify(res));
  const deco = await page.evaluate(() => { const d = document.querySelector('.pdfwizard-deco'); const b = d?.getBoundingClientRect(); return b && { x: b.left, y: b.top, w: b.width, h: b.height }; });
  console.log('  first deco', deco, 'span', s);
  await shot(page, `textsel-z${zoom}`, { clip: { x: Math.max(0, s.x - 40), y: Math.max(0, s.y - 40), width: Math.min(900, s.w + 80), height: 160 } });
}
// Rotated view: select, decorations must follow.
await page.evaluate(() => { __h.actions.setDecorations(__h.docId(), 'harness-textsel', null); __h.actions.setZoom(__h.docId(), 1); __h.actions.rotateView(__h.docId(), 90); });
await page.waitForTimeout(900);
await waitPainted(page);
{
  const s = await spanBox(/PDF Wizard brings/);
  // rotated 90: text runs top→bottom; drag along the span's long axis
  await dragSelect({ x: s.x + s.w / 2, y: s.y + 2 }, { x: s.x + s.w / 2, y: s.y + s.h - 2 });
  console.log('rot90 selection', await page.evaluate(() => (window.__lastSelections || []).map((s) => s.text.slice(0, 60))));
  await shot(page, 'textsel-rot90');
}
await page.evaluate(() => { __h.actions.rotateView(__h.docId(), -90); __h.actions.setDecorations(__h.docId(), 'harness-textsel', null); __h.actions.setTool('select'); });
await page.waitForTimeout(800);
await waitPainted(page);

// 2) Select tool → popup with registry action + Copy.
{
  const s = await spanBox(/PDF Wizard brings/);
  await dragSelect({ x: s.x + 2, y: s.y + s.h / 2 }, { x: s.x + s.w * 0.6, y: s.y + s.h / 2 });
  const popup = await page.evaluate(() => [...document.querySelectorAll('[data-testid="text-selection-popup"] [data-action-id]')].map((b) => b.getAttribute('data-action-id')));
  console.log('popup actions', popup);
  await shot(page, 'text-popup');
  await page.click('[data-action-id="viewer.text.copy"]');
  await page.waitForTimeout(300);
  console.log('clipboard', JSON.stringify(await page.evaluate(() => navigator.clipboard.readText())));
  console.log('popup after copy', await page.locator('[data-testid="text-selection-popup"]').count());
}

// 3) Links: page 2 (contents) internal links; external links anywhere.
await page.evaluate(() => __h.actions.goToPage(__h.docId(), 1));
await page.waitForTimeout(800);
await waitPainted(page);
const links = await page.evaluate(() => [...document.querySelectorAll('.annotationLayer .linkAnnotation a')].map((a) => ({ href: a.getAttribute('href'), target: a.target, rel: a.rel, page: a.closest('.pdfwizard-page')?.dataset.pageIndex })));
console.log('links', links.slice(0, 12), 'total', links.length);
const internal = page.locator('.pdfwizard-page[data-page-index="1"] .annotationLayer .linkAnnotation a[href^="#"]').first();
if (await internal.count()) {
  await internal.click();
  await page.waitForTimeout(900);
  console.log('after internal click currentPage', await page.evaluate(() => __h.doc().view.currentPage));
}
const ext = await page.evaluate(() => [...document.querySelectorAll('.annotationLayer .linkAnnotation a')].find((a) => /^https?:/.test(a.getAttribute('href') || ''))?.getAttribute('href'));
console.log('external link seen', ext);
report(errors);
await browser.close();
