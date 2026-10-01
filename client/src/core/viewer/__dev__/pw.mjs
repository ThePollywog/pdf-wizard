// Shared Playwright helpers for the viewer harness checks.
//   node client/src/core/viewer/__dev__/<script>.mjs   (dev instance on $WEB, default 5212)
import { chromium } from 'playwright';

export const WEB = process.env.WEB || 'http://localhost:5212';
export const SHOTS = process.env.SHOTS || '/tmp/vshots';

export async function open(file, { width = 1280, height = 860, dpr = 1 } = {}) {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr, acceptDownloads: true });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: WEB });
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') errors.push(`[${m.type()}] ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  await page.goto(`${WEB}/client/src/core/viewer/__dev__/harness.html${file ? `?file=${file}` : ''}`);
  if (file) await waitPainted(page);
  return { browser, context, page, errors };
}

export async function waitPainted(page, min = 1) {
  await page.waitForFunction((n) => document.querySelectorAll('.pdfwizard-page.is-painted').length >= n, min, { timeout: 20000 });
  await page.waitForTimeout(300);
}

export async function shot(page, name, opts = {}) {
  const path = `${SHOTS}/${name}.png`;
  await page.screenshot({ path, ...opts });
  return path;
}

export function report(errors) {
  const real = errors.filter((e) => !/Download the React DevTools|\[vite\]/.test(e));
  console.log(real.length ? `CONSOLE:\n  ${real.join('\n  ')}` : 'CONSOLE: clean');
}
