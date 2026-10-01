/**
 * Digital signatures (features/digital-sign) with the development test certificate standing in for
 * a CAC: sign an existing empty field, fill the form, add a second signature, and check that both
 * signatures stay valid in the downloaded file (our verifier, and poppler's pdfsig when installed).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Page } from '@playwright/test';
import { captureDownload, expect, getDoc, loadLib, openFixture, test, waitForPagesRendered } from './helpers';
import { trimDer, verifyCms } from '../client/src/features/digital-sign/cms';
import { readSignatures } from '../client/src/features/digital-sign/pdf';

const pageEl = (page: Page, index: number) => page.getByTestId('document-viewer').locator(`[data-testid=page][data-page-index="${index}"]`);

async function verifyAll(bytes: Uint8Array) {
  const out: { name: string; intact: boolean; signer?: string; wholeFile: boolean }[] = [];
  for (const s of await readSignatures(bytes)) {
    const [, b, c, d] = s.byteRange;
    const content = new Uint8Array(b + d);
    content.set(bytes.subarray(0, b), 0);
    content.set(bytes.subarray(c, c + d), b);
    const v = await verifyCms(trimDer(s.contents), content);
    out.push({ name: s.fieldName, intact: v.intact, signer: v.signer?.subjectCN, wholeFile: c + d === bytes.length });
  }
  return out;
}

function pdfsigValid(bytes: Uint8Array): number | null {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pdfwizard-sig-')), 'signed.pdf');
  fs.writeFileSync(file, bytes);
  try {
    return (execFileSync('pdfsig', [file], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).match(/Signature is Valid/g) ?? []).length;
  } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') return null;
    throw e;
  }
}

async function openSignTask(page: Page, signer: string) {
  await page.evaluate((cn) => (window as unknown as { __digitalSign: { enableTestSigner(cn: string): Promise<unknown> } }).__digitalSign.enableTestSigner(cn), signer);
  await page.evaluate(() => window.__app.actions.openTask('digital-sign'));
  await expect(page.getByTestId('digital-sign-panel')).toBeVisible();
}

async function confirmSign(page: Page, signer: string) {
  await expect(page.getByTestId('digital-sign-cert')).toBeVisible();
  await expect(page.getByTestId('digital-sign-cert-details')).toContainText('PDF Wizard Test CA');
  await page.getByTestId('digital-sign-reason').selectOption('I approve this document');
  await page.getByTestId('digital-sign-confirm').click();
  await expect(page.getByTestId('toast').filter({ hasText: `as ${signer}` })).toBeVisible({ timeout: 30_000 });
}

test('sign an empty form field, fill the form, add a second signature: both stay valid', async ({ page }) => {
  await openFixture(page, 'form.pdf');
  await waitForPagesRendered(page);
  await openSignTask(page, 'DOE.JANE.Q.1234567890');

  // The form's own empty signature field is offered on the page and in the panel.
  const here = pageEl(page, 0).getByTestId('digital-sign-here');
  await expect(here).toHaveCount(1);
  await expect(page.getByTestId('digital-sign-empty-field')).toHaveCount(1);
  await here.click();
  await confirmSign(page, 'DOE.JANE.Q.1234567890');

  // The panel lists the signature as valid; the field is no longer empty.
  const sig = page.getByTestId('digital-sign-signature');
  await expect(sig).toHaveCount(1);
  await expect(sig).toHaveAttribute('data-status', 'valid');
  await expect(sig).toContainText('DOE.JANE.Q.1234567890');
  // A self-signed test certificate must never pass as DoD PKI.
  await expect(sig).toHaveAttribute('data-trusted', 'false');
  await expect(sig).toContainText('identity not verified');
  await expect(page.getByTestId('digital-sign-empty-field')).toHaveCount(0);

  // A second person fills in a field and signs a new field they draw.
  const name = pageEl(page, 0).locator('.annotationLayer input[name=full_name]');
  await name.fill('Jane Doe');
  await name.press('Tab');
  await openSignTask(page, 'ROE.RICHARD.A.9876543210');
  await page.getByTestId('digital-sign-place').click();
  await expect(pageEl(page, 0).getByTestId('digital-sign-place-overlay')).toBeVisible();
  // Drag in the visible middle of the viewer (typing into a field may have scrolled the page).
  const view = (await page.getByTestId('document-viewer').boundingBox())!;
  const cx = view.x + view.width / 2;
  const cy = view.y + view.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx + 220, cy + 60, { steps: 5 });
  await page.mouse.up();
  await confirmSign(page, 'ROE.RICHARD.A.9876543210');
  await expect(page.getByTestId('digital-sign-signature')).toHaveCount(2);
  await expect(page.getByTestId('digital-sign-signature').nth(0)).toHaveAttribute('data-status', 'valid');
  await expect(page.getByTestId('digital-sign-signature').nth(1)).toHaveAttribute('data-status', 'valid');

  // The downloaded file is exactly what was signed.
  const { bytes } = await captureDownload(page, () => page.getByTestId('download').click());
  const results = await verifyAll(bytes);
  expect(results.map((r) => [r.signer, r.intact])).toEqual([
    ['DOE.JANE.Q.1234567890', true],
    ['ROE.RICHARD.A.9876543210', true],
  ]);
  expect(results[1].wholeFile).toBe(true);
  expect((await loadLib(bytes)).getForm().getTextField('full_name').getText()).toBe('Jane Doe');
  const pdfsig = pdfsigValid(bytes);
  if (pdfsig !== null) expect(pdfsig).toBe(2);
  expect((await getDoc(page)).loadError).toBeNull();
});

test('changes that break an earlier signature are flagged before signing again', async ({ page }) => {
  await openFixture(page, 'form.pdf');
  await waitForPagesRendered(page);
  await openSignTask(page, 'DOE.JANE.Q.1234567890');
  await pageEl(page, 0).getByTestId('digital-sign-here').click();
  await confirmSign(page, 'DOE.JANE.Q.1234567890');

  // Rotating a page rewrites the file: the first signature would no longer verify.
  await page.evaluate(() => window.__engine.rotatePages(window.__app.getActiveDoc().id, [0], 90));
  await page.getByTestId('digital-sign-place').click();
  await expect(pageEl(page, 0).getByTestId('digital-sign-place-overlay')).toBeVisible();
  const view = (await page.getByTestId('document-viewer').boundingBox())!;
  await page.mouse.click(view.x + view.width / 2, view.y + view.height / 2);
  await page.getByTestId('digital-sign-confirm').click();
  await expect(page.getByTestId('dialog-confirm')).toBeVisible();
  await expect(page.getByTestId('modal').filter({ hasText: 'Existing signatures will be invalid' })).toBeVisible();
  await page.getByTestId('dialog-cancel').click();
  await expect(page.getByTestId('digital-sign-signature')).toHaveCount(1);
});

test('without the CAC extension the dialog explains what to install', async ({ page }) => {
  await openFixture(page, 'form.pdf');
  await waitForPagesRendered(page);
  await page.evaluate(() => window.__app.actions.openTask('digital-sign'));
  await pageEl(page, 0).getByTestId('digital-sign-here').click();
  await expect(page.getByTestId('modal').getByTestId('digital-sign-no-bridge')).toContainText('extension isn’t installed');
  await expect(page.getByTestId('digital-sign-confirm')).toBeDisabled();
});
