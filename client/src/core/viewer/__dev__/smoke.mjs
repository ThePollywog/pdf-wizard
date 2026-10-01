import { open, shot, report } from './pw.mjs';
const { browser, page, errors } = await open(process.argv[2] || 'sample.pdf', { dpr: Number(process.argv[3] || 1) });
console.log(await page.evaluate(() => ({ mode: __h.engineMode(), pages: __h.doc().pages.length, view: __h.doc().view, painted: document.querySelectorAll('.pdfwizard-page.is-painted').length, mounted: document.querySelectorAll('.pdfwizard-page').length })));
await shot(page, 'smoke');
report(errors);
await browser.close();
