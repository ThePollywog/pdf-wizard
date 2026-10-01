// Form fields: highlight, typing persists in annotationStorage + dirty, survives virtualization & zoom.
import { open, shot, report, waitPainted } from './pw.mjs';

const { browser, page, errors } = await open('form.pdf', { dpr: 2 });
const fields = await page.evaluate(() => [...document.querySelectorAll('.annotationLayer :is(input, textarea, select)')].map((e) => ({ tag: e.tagName, type: e.type, name: e.name, id: e.getAttribute('data-element-id') })));
console.log('fields', fields.length, fields.slice(0, 8));
await shot(page, 'form-initial');
const text = page.locator('.annotationLayer input[type="text"], .annotationLayer textarea').first();
await text.click();
await page.keyboard.type('Jane Q. Tester');
const cb = page.locator('.annotationLayer input[type="checkbox"]').first();
if (await cb.count()) await cb.click();
await page.keyboard.press('Tab');
await page.waitForTimeout(300);
const st = await page.evaluate(() => {
  const d = __h.doc();
  const s = d.pdf.annotationStorage;
  return { dirty: d.dirty, size: s.size, values: Object.fromEntries([...s.serializable.map ?? []].slice(0, 5)) , all: s.getAll ? s.getAll() : null };
});
console.log('storage', JSON.stringify(st).slice(0, 600));
await shot(page, 'form-filled');
// Arrow keys inside the input must not scroll / change page.
await text.click();
const scrollBefore = await page.evaluate(() => document.querySelector('.pdfwizard-scroller').scrollTop);
await page.keyboard.press('ArrowLeft');
await page.keyboard.press('End');
await page.keyboard.press('Space');
const scrollAfter = await page.evaluate(() => document.querySelector('.pdfwizard-scroller').scrollTop);
console.log('keys in input kept scroll', scrollBefore === scrollAfter, 'value', await text.inputValue());
// Re-render at another zoom (layer rebuilt) → value persists.
await page.evaluate(() => __h.actions.setZoom(__h.docId(), 0.8));
await page.waitForTimeout(900);
await waitPainted(page);
console.log('after zoom value', await page.locator('.annotationLayer input[type="text"], .annotationLayer textarea').first().inputValue());
await shot(page, 'form-zoomed');
report(errors);
await browser.close();
