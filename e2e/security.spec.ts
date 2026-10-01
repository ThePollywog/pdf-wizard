/**
 * Saving password-protected documents: without a security change the saved file keeps the
 * ORIGINAL encryption (same /O /U /OE /UE /Perms /P and /ID), so both passwords keep working —
 * whichever password (or none) the document was opened with.
 */
import { PDFDict, PDFDocument, PDFName, StandardFonts, type PDFObject } from '@cantoo/pdf-lib';
import type { Page } from '@playwright/test';
import { FIXTURES_DIR, captureDownload, engineOp, expect, getDoc, gotoHome, inspectPdf, loadLib, needsPassword, test, waitForDocReady, waitForPagesRendered } from './helpers';

const download = async (page: Page) => (await captureDownload(page, () => page.getByTestId('download').click())).bytes;

/** The /Encrypt entries and /ID that decide which passwords open the file. */
async function encryptEntries(bytes: Uint8Array): Promise<Record<string, string> | null> {
  const lib = await loadLib(bytes, { ignoreEncryption: true });
  const trailer = lib.context.trailerInfo as { Encrypt?: PDFObject; ID?: PDFObject };
  const enc = trailer.Encrypt && lib.context.lookup(trailer.Encrypt);
  if (!(enc instanceof PDFDict)) return null;
  const out: Record<string, string> = {};
  for (const k of ['V', 'R', 'P', 'Length', 'O', 'U', 'OE', 'UE', 'Perms']) {
    const v = enc.lookup(PDFName.of(k));
    if (v) out[k] = v.toString();
  }
  out.ID0 = String(trailer.ID && lib.context.lookup(trailer.ID)).split(' ')[1] ?? '';
  return out;
}

async function openWithPassword(page: Page, file: string | { name: string; mimeType: string; buffer: Buffer }, password?: string) {
  await gotoHome(page);
  await page.getByTestId('open-file-input').setInputFiles(file);
  if (password !== undefined) {
    await expect(page.getByTestId('password-input')).toBeVisible();
    await page.getByTestId('password-input').fill(password);
    await page.getByTestId('password-submit').click();
  }
  await waitForDocReady(page);
  await waitForPagesRendered(page);
}

const rotateFirstPage = (page: Page) => engineOp(page, 'rotatePages', [0], 90);

test.describe('Saving protected documents', () => {
  for (const pw of ['owner', 'secret']) {
    test(`encrypted.pdf opened with the ${pw === 'owner' ? 'permissions' : 'open'} password keeps both passwords after an edit`, async ({ page }) => {
      const original = await encryptEntries(new Uint8Array(await (await import('node:fs/promises')).readFile(`${FIXTURES_DIR}encrypted.pdf`)));
      await openWithPassword(page, `${FIXTURES_DIR}encrypted.pdf`, pw);
      const doc = await getDoc(page);
      expect(doc.name).toBe('encrypted.pdf');
      const security = await page.evaluate(() => window.__app.getActiveDoc().security);
      expect(security).toMatchObject(pw === 'owner' ? { ownerPassword: 'owner' } : { userPassword: 'secret' });

      await rotateFirstPage(page);
      const saved = await download(page);
      expect(await needsPassword(saved)).toBe(true);
      expect(await encryptEntries(saved)).toEqual(original);
      for (const p of ['secret', 'owner']) {
        const info = await inspectPdf(saved, p);
        expect(info.pages[0].rotation).toBe(90);
        expect(info.pages[0].text).toContain('Confidential Budget Summary');
      }
      // pdf-lib with the permissions password too (owner key from /OE).
      const lib = await PDFDocument.load(saved, { password: 'owner', updateMetadata: false });
      expect(lib.getPageCount()).toBe(2);
    });
  }

  test('changing the passwords replaces the original encryption', async ({ page }) => {
    await openWithPassword(page, `${FIXTURES_DIR}encrypted.pdf`, 'owner');
    await page.evaluate(() => window.__app.actions.setSecurity(window.__app.getActiveDoc().id, { userPassword: 'new-open', ownerPassword: 'new-perms' }));
    const saved = await download(page);
    await expect(inspectPdf(saved, 'secret')).rejects.toThrow();
    await expect(inspectPdf(saved, 'owner')).rejects.toThrow();
    expect((await inspectPdf(saved, 'new-open')).pages[0].text).toContain('Confidential Budget Summary');
    expect((await inspectPdf(saved, 'new-perms')).pages.length).toBe(2);
  });

  test('an RC4 file with restrictions and no open password keeps its permissions password and /P', async ({ page }) => {
    const src = await PDFDocument.create();
    const pg = src.addPage([300, 200]);
    pg.drawText('restricted rc4 document', { x: 20, y: 150, size: 12, font: await src.embedFont(StandardFonts.Helvetica) });
    src.encrypt({ userPassword: '', ownerPassword: 'owner', algorithm: 'RC4-128', allowWeakCryptography: true, permissions: { printing: 'lowResolution', modifying: false, copying: false } });
    const bytes = await src.save();
    const original = await encryptEntries(bytes);
    expect(original?.V).toBe('2');

    await openWithPassword(page, { name: 'rc4.pdf', mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
    const security = await page.evaluate(() => window.__app.getActiveDoc().security);
    expect(security?.userPassword ?? '').toBe('');
    expect(security?.permissions).toMatchObject({ modifying: false, copying: false, printing: 'lowResolution' });

    await rotateFirstPage(page);
    const saved = await download(page);
    expect(await needsPassword(saved)).toBe(false);
    expect(await encryptEntries(saved)).toEqual(original);
    const info = await inspectPdf(saved);
    expect(info.pages[0].rotation).toBe(90);
    expect(info.pages[0].text).toContain('restricted rc4 document');
    expect((await PDFDocument.load(saved, { password: 'owner', updateMetadata: false })).getPageCount()).toBe(1);
  });
});
