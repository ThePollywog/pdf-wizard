// External links, hand tool / space panning, extract-page download.
import { open, shot, report } from './pw.mjs';

const { browser, page, errors } = await open('sample.pdf');
await page.evaluate(() => __h.actions.goToPage(__h.docId(), 5));
await page.waitForFunction(() => document.querySelector('.pdfwizard-page[data-page-index="5"] .annotationLayer a'), null, { timeout: 10000 }).catch(() => {});
await page.waitForTimeout(400);
const links = await page.evaluate(() =>
  [...document.querySelectorAll('.pdfwizard-page .annotationLayer .linkAnnotation a')].map((a) => ({ href: a.getAttribute('href'), target: a.target, rel: a.rel, page: a.closest('.pdfwizard-page')?.dataset.pageIndex })),
);
console.log('links', JSON.stringify(links));
const ext = page.locator('.pdfwizard-page .annotationLayer .linkAnnotation a[href^="http"]').first();
if (await ext.count()) {
  const [popup] = await Promise.all([page.context().waitForEvent('page', { timeout: 4000 }).catch(() => null), ext.click()]);
  console.log('external click opened new page', !!popup, popup ? await popup.evaluate(() => window.opener === null).catch(() => 'n/a') : '');
  await popup?.close();
}

// Hand tool: drag scrolls.
await page.evaluate(() => __h.actions.goToPage(__h.docId(), 2));
await page.waitForTimeout(400);
await page.locator('[data-tool="hand"]').click();
const sc = page.locator('.pdfwizard-scroller');
const top0 = await sc.evaluate((e) => e.scrollTop);
const b = await sc.boundingBox();
await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
await page.mouse.down();
await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2 - 200, { steps: 8 });
const panning = await page.locator('.pdfwizard-viewer.is-panning').count();
await page.mouse.up();
const top1 = await sc.evaluate((e) => e.scrollTop);
console.log('hand drag scrolled', Math.round(top1 - top0), 'is-panning during drag', panning, 'text selection', await page.evaluate(() => String(getSelection())).then((s) => s.length));

// Space + drag in select mode.
await page.locator('[data-tool="select"]').click();
await sc.focus();
await page.keyboard.down('Space');
await page.waitForTimeout(50);
const spaceClass = await page.locator('.pdfwizard-viewer.is-space-pan').count();
await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
await page.mouse.down();
await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2 + 150, { steps: 8 });
await page.mouse.up();
await page.keyboard.up('Space');
const top2 = await sc.evaluate((e) => e.scrollTop);
console.log('space-pan class', spaceClass, 'scrolled', Math.round(top2 - top1), 'text selection', await page.evaluate(() => String(getSelection()).length));

// Extract page via the thumbnails context menu → download.
await page.locator('.thumbnails-item[data-page-index="1"]').click({ button: 'right' });
const [dl] = await Promise.all([
  page.waitForEvent('download', { timeout: 8000 }).catch(() => null),
  page.locator('[role="menu"] [role="menuitem"]', { hasText: 'Extract page' }).click(),
]);
if (dl) {
  const path = `/tmp/vshots/${dl.suggestedFilename()}`;
  await dl.saveAs(path);
  const { readFileSync } = await import('node:fs');
  const head = readFileSync(path).subarray(0, 5).toString();
  const pages = (readFileSync(path).toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
  console.log('extract download', dl.suggestedFilename(), head, 'pages≈', pages);
} else console.log('extract: no download', await page.locator('.toast-message').allInnerTexts());
await shot(page, 'misc-end');
report(errors);
await browser.close();
