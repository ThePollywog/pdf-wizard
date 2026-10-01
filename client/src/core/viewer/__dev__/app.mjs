// Viewer + thumbnails inside the real app shell (index.html).
import { chromium } from 'playwright';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push('[pageerror] ' + e.message));
await page.goto('http://localhost:5212/');
await page.waitForTimeout(1500);
const input = page.locator('input[type=file]').first();
if (await input.count()) {
  await input.setInputFiles(new URL('../../../../../fixtures/sample.pdf', import.meta.url).pathname).catch((e) => console.log('setInputFiles', e.message));
  await page.waitForFunction(() => document.querySelectorAll('.pdfwizard-page.is-painted').length >= 1, null, { timeout: 15000 }).catch(() => console.log('no painted page'));
}
await page.waitForTimeout(800);
const btn = page.locator('button[aria-label="Page thumbnails"], button[title="Page thumbnails"]').first();
if (await btn.count()) { await btn.click(); await page.waitForTimeout(1200); } else console.log('no thumbnails rail button');
await page.screenshot({ path: '/tmp/vshots/app.png' });
console.log('pages', await page.locator('.pdfwizard-page').count(), 'thumbs', await page.locator('.thumbnails-item').count());
console.log(errors.length ? errors.join('\n') : 'CONSOLE: clean');
await browser.close();
