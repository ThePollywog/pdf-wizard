/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * Protect & Redact.
 *
 *  - Protect: password + permissions (AES-256 R6, /P bits, owner password unlocks the file key),
 *    Restrict editing only, undo/redo of security changes, Remove security, encrypted.pdf summary.
 *  - Redact: text marks (selection popup, double-click with the mark tool), area marks, page marks,
 *    Find text & redact (single / multiple / patterns, match case, whole words), properties
 *    (overlay text), apply (text really gone, the rest stays searchable, images redacted in the
 *    pixel data, rotated pages hit at the right spot, links/annotations under marks removed),
 *    /Redact export + import, Remove hidden information (hidden text and layers stay hidden through
 *    Apply), overlay characters the standard fonts can't show, marks following page edits.
 */
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import type { Page } from '@playwright/test';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFOperator,
  PDFOperatorNames,
  PDFRawStream,
  PDFString,
  StandardFonts,
  TextRenderingMode,
  beginText,
  endText,
  moveText,
  popGraphicsState,
  pushGraphicsState,
  setFontAndSize,
  setTextRenderingMode,
  showText,
  type PDFPage,
} from '@cantoo/pdf-lib';
import sharp from 'sharp';
import { FIXTURES_DIR, captureDownload, engineOp, expect, expectNewVersion, getDoc, gotoHome, inspectPdf, loadLib, needsPassword, openFixture, openPdfjs, test, waitForDocReady, waitForPagesRendered } from './helpers';

const USER_PW = 'Open-Sesame-42';
const OWNER_PW = 'Owner-Key-99';

// ── UI helpers ─────────────────────────────────────────────────────────────────

const viewer = (page: Page) => page.getByTestId('document-viewer');
const pageEl = (page: Page, index: number) => viewer(page).locator(`[data-testid=page][data-page-index="${index}"]`);

/** Opens a task from the All tools list (or through the store when the list is not showing). */
async function openTask(page: Page, id: 'protect' | 'redact') {
  const item = page.locator(`[data-testid=tools-list-item][data-task-id=${id}]`).first();
  if (await item.isVisible()) await item.click();
  else await page.evaluate((t) => window.__app.actions.openTask(t), id);
  await expect(page.getByTestId(id === 'protect' ? 'protect-redact-protect-panel' : 'protect-redact-redact-panel')).toBeVisible();
}

/** Scrolls page `index` into view and waits until it painted. */
async function showPage(page: Page, index: number) {
  await page.evaluate((i) => window.__app.actions.goToPage(window.__app.getActiveDoc().id, i), index);
  const el = pageEl(page, index);
  await expect(el).toHaveClass(/is-painted/);
  await el.scrollIntoViewIfNeeded();
  return el;
}

/** Client point of user-space (x, y) on an unrotated page with view [0, 0, w, h]. */
async function clientPoint(page: Page, index: number, x: number, y: number, w = 612, h = 792): Promise<[number, number]> {
  const b = (await pageEl(page, index).boundingBox())!;
  return [b.x + (x / w) * b.width, b.y + ((h - y) / h) * b.height];
}

async function drag(page: Page, from: [number, number], to: [number, number]) {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  await page.mouse.move(to[0], to[1], { steps: 8 });
  await page.mouse.up();
}

interface Mark {
  id: string;
  pageIndex: number;
  mode: string;
  text?: string;
  rect: { x: number; y: number; width: number; height: number };
  overlay?: { useText?: boolean; text?: string };
}

/** Unapplied redaction marks of the active document, in stacking order. */
function marks(page: Page): Promise<Mark[]> {
  return page.evaluate(() => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const d = window.__app.getActiveDoc();
    return d.order
      .map((id: string) => d.objects[id])
      .filter((o: any) => o && o.kind === 'redaction')
      .map((o: any) => ({
        id: o.id,
        pageIndex: d.pages.findIndex((p: any) => p.id === o.pageId),
        mode: o.data.mode,
        text: o.data.text,
        rect: { ...o.rect },
        overlay: o.data.overlay,
      }));
    /* eslint-enable @typescript-eslint/no-explicit-any */
  });
}

const download = async (page: Page) => (await captureDownload(page, () => page.getByTestId('download').click())).bytes;

/** Apply all marks through the panel (confirm the warning), then answer the "hidden information" prompt. */
async function applyAll(page: Page, next: 'skip' | 'sanitize' = 'skip') {
  const before = (await getDoc(page)).version;
  await page.getByTestId('protect-redact-apply').click();
  await expect(page.getByTestId('protect-redact-apply-confirm')).toContainText('permanently remove');
  await page.getByTestId('dialog-confirm').click();
  await expect(page.getByTestId('protect-redact-after-apply')).toBeVisible({ timeout: 90_000 });
  expect((await getDoc(page)).version).not.toBe(before);
  await page.getByTestId(`dialog-choice-${next}`).click();
  if (next === 'skip') {
    await waitForDocReady(page);
    await waitForPagesRendered(page);
  }
}

async function openBytes(page: Page, name: string, bytes: Uint8Array) {
  if (!/^https?:/.test(page.url())) await gotoHome(page);
  await page.getByTestId('open-file-input').setInputFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
  await waitForDocReady(page, name);
  await waitForPagesRendered(page);
}

// ── PDF helpers ────────────────────────────────────────────────────────────────

const PERM = { print: 1 << 2, modify: 1 << 3, copy: 1 << 4, annotate: 1 << 5, fill: 1 << 8, accessibility: 1 << 9, assemble: 1 << 10, printHigh: 1 << 11 };

interface EncryptInfo {
  V: number;
  R: number;
  P: number;
  O: Buffer;
  U: Buffer;
  OE: Buffer;
  UE: Buffer;
  Perms: Buffer;
}

async function encryptInfo(bytes: Uint8Array): Promise<EncryptInfo | null> {
  const lib = await loadLib(bytes, { ignoreEncryption: true });
  const t = lib.context.trailerInfo as { Encrypt?: unknown };
  if (!t.Encrypt) return null;
  const enc = lib.context.lookup(t.Encrypt as never) as PDFDict;
  const num = (k: string) => (enc.get(PDFName.of(k)) as PDFNumber).asNumber();
  const str = (k: string) => {
    const v = enc.get(PDFName.of(k));
    if (v instanceof PDFString || v instanceof PDFHexString) return Buffer.from(v.asBytes());
    throw new Error(`/Encrypt /${k} missing`);
  };
  return { V: num('V'), R: num('R'), P: num('P'), O: str('O'), U: str('U'), OE: str('OE'), UE: str('UE'), Perms: str('Perms') };
}

/** ISO 32000-2 Algorithm 2.B (the R6 password hash). */
function hash2B(pw: Buffer, salt: Buffer, udata: Buffer): Buffer {
  let K = crypto.createHash('sha256').update(Buffer.concat([pw, salt, udata])).digest();
  for (let i = 0; ; i++) {
    const K1 = Buffer.concat(Array(64).fill(Buffer.concat([pw, K, udata])));
    const c = crypto.createCipheriv('aes-128-cbc', K.subarray(0, 16), K.subarray(16, 32));
    c.setAutoPadding(false);
    const E = Buffer.concat([c.update(K1), c.final()]);
    let sum = 0;
    for (let j = 0; j < 16; j++) sum += E[j];
    K = crypto.createHash(['sha256', 'sha384', 'sha512'][sum % 3]).update(E).digest();
    if (i >= 63 && E[E.length - 1] <= i + 1 - 32) break;
  }
  return K.subarray(0, 32);
}

const isOwnerPassword = (e: EncryptInfo, pw: string) => hash2B(Buffer.from(pw, 'utf8'), e.O.subarray(32, 40), e.U.subarray(0, 48)).equals(e.O.subarray(0, 32));
const isUserPassword = (e: EncryptInfo, pw: string) => hash2B(Buffer.from(pw, 'utf8'), e.U.subarray(32, 40), Buffer.alloc(0)).equals(e.U.subarray(0, 32));

/** The file encryption key unlocked by a password (owner: from /OE, user: from /UE). */
function fileKey(e: EncryptInfo, pw: string, owner: boolean): Buffer {
  const p = Buffer.from(pw, 'utf8');
  const k = owner ? hash2B(p, e.O.subarray(40, 48), e.U.subarray(0, 48)) : hash2B(p, e.U.subarray(40, 48), Buffer.alloc(0));
  const d = crypto.createDecipheriv('aes-256-cbc', k, Buffer.alloc(16));
  d.setAutoPadding(false);
  return Buffer.concat([d.update(owner ? e.OE : e.UE), d.final()]);
}

/** /Perms decrypted with the file key: the permissions (little endian) followed by "adb". */
function decryptPerms(e: EncryptInfo, key: Buffer): { P: number; tag: string } {
  const d = crypto.createDecipheriv('aes-256-ecb', key, null);
  d.setAutoPadding(false);
  const b = Buffer.concat([d.update(e.Perms), d.final()]);
  return { P: b.readInt32LE(0), tag: b.subarray(9, 12).toString('latin1') };
}

interface PageImage {
  name: string;
  width: number;
  height: number;
  stream: PDFRawStream;
}

function pageImages(lib: PDFDocument, index: number): PageImage[] {
  const res = lib.getPage(index).node.Resources();
  const xo = res?.lookup(PDFName.of('XObject'));
  const out: PageImage[] = [];
  if (!(xo instanceof PDFDict)) return out;
  for (const [name, ref] of xo.entries()) {
    const s = lib.context.lookup(ref);
    if (!(s instanceof PDFRawStream) || s.dict.get(PDFName.of('Subtype'))?.toString() !== '/Image') continue;
    const n = (k: string) => (s.dict.get(PDFName.of(k)) as PDFNumber).asNumber();
    out.push({ name: name.decodeText(), width: n('Width'), height: n('Height'), stream: s });
  }
  return out;
}

/** All image XObjects in the file (referenced or not) as "WxH". */
function allImageSizes(lib: PDFDocument): string[] {
  const out: string[] = [];
  for (const [, o] of lib.context.enumerateIndirectObjects()) {
    if (o instanceof PDFRawStream && o.dict.get(PDFName.of('Subtype'))?.toString() === '/Image') {
      out.push(`${(o.dict.get(PDFName.of('Width')) as PDFNumber).asNumber()}x${(o.dict.get(PDFName.of('Height')) as PDFNumber).asNumber()}`);
    }
  }
  return out;
}

/** Decodes a DCT or Flate (optionally PNG-predicted) 8-bit image to raw samples. */
async function decodeImage(img: PageImage): Promise<{ width: number; height: number; channels: number; data: Buffer }> {
  const s = img.stream;
  const filter = s.dict.get(PDFName.of('Filter'))?.toString();
  if (filter === '/DCTDecode') {
    const { data, info } = await sharp(Buffer.from(s.contents)).raw().toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height, channels: info.channels, data };
  }
  expect(filter).toBe('/FlateDecode');
  const raw = zlib.inflateSync(Buffer.from(s.contents));
  const channels = s.dict.get(PDFName.of('ColorSpace'))?.toString() === '/DeviceGray' ? 1 : 3;
  const parms = s.dict.lookup(PDFName.of('DecodeParms'));
  const predictor = parms instanceof PDFDict ? (parms.get(PDFName.of('Predictor')) as PDFNumber | undefined)?.asNumber() ?? 1 : 1;
  if (predictor < 10) return { width: img.width, height: img.height, channels, data: raw };
  const row = img.width * channels;
  const data = Buffer.alloc(row * img.height);
  for (let y = 0; y < img.height; y++) {
    const type = raw[y * (row + 1)];
    const src = raw.subarray(y * (row + 1) + 1, (y + 1) * (row + 1));
    const cur = data.subarray(y * row, (y + 1) * row);
    const up = y ? data.subarray((y - 1) * row, y * row) : Buffer.alloc(row);
    for (let i = 0; i < row; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = up[i];
      const c = i >= channels ? up[i - channels] : 0;
      let v = src[i];
      if (type === 1) v += a;
      else if (type === 2) v += b;
      else if (type === 3) v += (a + b) >> 1;
      else if (type === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 0xff;
    }
  }
  return { width: img.width, height: img.height, channels, data };
}

function pixelAt(img: { width: number; height: number; channels: number; data: Buffer }, fx: number, fy: number): number[] {
  const x = Math.min(img.width - 1, Math.floor(fx * img.width));
  const y = Math.min(img.height - 1, Math.floor(fy * img.height));
  const i = (y * img.width + x) * img.channels;
  return [...img.data.subarray(i, i + Math.min(3, img.channels))];
}

function annotSubtypes(lib: PDFDocument, index: number): string[] {
  const annots = lib.getPage(index).node.lookup(PDFName.of('Annots'));
  if (!(annots instanceof PDFArray)) return [];
  return annots.asArray().map((r) => {
    const a = lib.context.lookup(r);
    return a instanceof PDFDict ? a.get(PDFName.of('Subtype'))?.toString() ?? '' : '';
  });
}

/**
 * Page 1: two visible lines, an invisible (render mode 3, OCR-like) line and a line on a layer that
 * is turned off. Page 2: cropped (content outside the crop box) with hidden-layer text as well.
 * Plus an attachment, document JavaScript and metadata.
 */
async function hiddenInfoPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  doc.setTitle('Hidden information');
  doc.setAuthor('Jane Secret');
  const ocg = doc.context.register(doc.context.obj({ Type: 'OCG', Name: PDFString.of('Secret layer') }));
  doc.catalog.set(PDFName.of('OCProperties'), doc.context.obj({ OCGs: [ocg], D: { Order: [ocg], OFF: [ocg], ON: [] } }));
  const raw = (p: PDFPage, text: string, x: number, y: number, how: 'invisible' | 'layer') => {
    const font = p.node.newFontDictionary('HvRaw', helv.ref);
    const ops = [pushGraphicsState(), beginText(), setFontAndSize(font, 12)];
    if (how === 'invisible') ops.push(setTextRenderingMode(TextRenderingMode.Invisible));
    ops.push(moveText(x, y), showText(helv.encodeText(text)), endText(), popGraphicsState());
    if (how === 'invisible') return p.pushOperators(...ops);
    p.node.Resources()!.set(PDFName.of('Properties'), doc.context.obj({ OC1: ocg }));
    p.pushOperators(PDFOperator.of(PDFOperatorNames.BeginMarkedContentSequence, [PDFName.of('OC'), PDFName.of('OC1')]), ...ops, PDFOperator.of(PDFOperatorNames.EndMarkedContent));
  };
  const p1 = doc.addPage([612, 792]);
  p1.drawText('Visible line with SECRETWORD inside.', { x: 72, y: 700, size: 14, font: helv });
  p1.drawText('Another visible line stays.', { x: 72, y: 660, size: 14, font: helv });
  raw(p1, 'OCRLAYER invisible words', 72, 600, 'invisible');
  raw(p1, 'LAYERSECRET words', 72, 560, 'layer');
  const p2 = doc.addPage([612, 792]);
  p2.drawText('CROPPEDOUT text outside the crop box', { x: 20, y: 20, size: 10, font: helv });
  p2.drawText('Inside the crop box', { x: 200, y: 400, size: 14, font: helv });
  raw(p2, 'LAYERTWO words', 200, 300, 'layer');
  p2.setCropBox(100, 100, 312, 492);
  await doc.attach(Buffer.from('attached secret data'), 'secret.txt', { mimeType: 'text/plain', description: 'A secret file' });
  doc.addJavaScript('hello', 'app.alert("hi");');
  return doc.save();
}

/** Text of page `index` with its crop box (and media box) opened up to the whole sheet. */
async function uncroppedText(bytes: Uint8Array, index: number): Promise<string> {
  const lib = await loadLib(bytes);
  const p = lib.getPage(index);
  p.node.delete(PDFName.of('CropBox'));
  p.setMediaBox(0, 0, 612, 792);
  return (await inspectPdf(await lib.save())).pages[index].text;
}

/** The Names tree entries of the catalog (EmbeddedFiles, JavaScript...). */
function nameTrees(lib: PDFDocument): string[] {
  const names = lib.catalog.lookup(PDFName.of('Names'));
  return names instanceof PDFDict ? names.keys().map((k) => k.decodeText()) : [];
}

// ── Protect ────────────────────────────────────────────────────────────────────

test.describe('Protect a PDF', () => {
  test('password + permissions: AES-256 download, /P bits, owner password unlocks everything, undo/redo', async ({ page }) => {
    await openFixture(page, 'sample.pdf');
    const tasks = await page.evaluate(() => {
      const r = window.__app.reg.get();
      return ['protect', 'redact'].map((id) => ({ id, label: r.tasks[id]?.label, category: r.tasks[id]?.category, featured: r.tasks[id]?.featured }));
    });
    expect(tasks).toEqual([
      { id: 'protect', label: 'Protect a PDF', category: 'protect', featured: 10 },
      { id: 'redact', label: 'Redact a PDF', category: 'protect', featured: 11 },
    ]);
    await openTask(page, 'protect');
    const summary = page.getByTestId('protect-redact-summary');
    await expect(summary).toHaveAttribute('data-secured', 'false');
    await expect(page.getByTestId('protect-redact-summary-method')).toHaveText('No security');
    await expect(page.getByTestId('protect-redact-remove-security')).toHaveCount(0);

    await page.getByTestId('protect-redact-protect-password').click();
    const dialog = page.getByTestId('protect-redact-password-dialog');
    await expect(dialog).toBeVisible();
    // Strength meter.
    await page.getByTestId('protect-redact-open-password').fill('abc');
    await expect(page.getByTestId('protect-redact-strength')).toHaveAttribute('data-score', '1');
    await expect(page.getByTestId('protect-redact-strength')).toContainText('Weak');
    await page.getByTestId('protect-redact-open-password').fill(USER_PW);
    await expect(page.getByTestId('protect-redact-strength')).toHaveAttribute('data-score', /[34]/);
    // Mismatched confirmation is rejected.
    await page.getByTestId('protect-redact-open-confirm').fill('Open-Sesame-43');
    await page.getByTestId('protect-redact-protect-apply').click();
    await expect(dialog).toContainText('don’t match');
    await page.getByTestId('protect-redact-open-confirm').fill(USER_PW);

    await page.getByTestId('protect-redact-advanced').click();
    await expect(page.getByTestId('protect-redact-encryption-level')).toContainText('256-bit AES');
    await page.getByTestId('protect-redact-restrict-toggle').click();
    await page.getByTestId('protect-redact-perm-password').fill(OWNER_PW);
    await page.getByTestId('protect-redact-perm-confirm').fill(OWNER_PW);
    await page.getByTestId('protect-redact-printing').selectOption('low');
    await page.getByTestId('protect-redact-changes').selectOption('comments');
    await expect(page.getByTestId('protect-redact-copying').locator('input')).not.toBeChecked();
    await expect(page.getByTestId('protect-redact-screen-reader').locator('input')).toBeChecked();
    await page.getByTestId('protect-redact-protect-apply').click();
    await expect(dialog).toBeHidden();

    await expect(summary).toHaveAttribute('data-secured', 'true');
    await expect(page.getByTestId('protect-redact-summary-method')).toHaveText('Password security');
    await expect(page.getByTestId('protect-redact-summary-encryption')).toHaveText('256-bit AES');
    await expect(page.getByTestId('protect-redact-summary-open')).toHaveText('Yes');
    await expect(page.getByTestId('protect-redact-summary-perms')).toHaveText('Yes');
    const rows = page.getByTestId('protect-redact-restrictions');
    await expect(rows.locator('[data-row="Printing"]')).toContainText('Low resolution');
    await expect(rows.locator('[data-row="Commenting"]')).toHaveClass(/is-allowed/);
    await expect(rows.locator('[data-row="Content copying"]')).toHaveClass(/is-denied/);
    await expect(rows.locator('[data-row="Changing the document"]')).toHaveClass(/is-denied/);
    await expect(page.getByTestId('protect-redact-remove-security')).toBeVisible();
    const security = await page.evaluate(() => window.__app.getActiveDoc().security);
    expect(security).toMatchObject({ userPassword: USER_PW, ownerPassword: OWNER_PW, permissions: { printing: 'lowResolution', annotating: true, fillingForms: true, modifying: false, copying: false } });

    // The download needs the open password.
    const bytes = await download(page);
    expect(await needsPassword(bytes)).toBe(true);
    await expect(openPdfjs(bytes, 'wrong-password')).rejects.toThrow();
    const info = await inspectPdf(bytes, USER_PW);
    expect(info.numPages).toBe(6);
    expect(info.pages[0].text).toContain('PDF Wizard');
    expect((await inspectPdf(bytes, OWNER_PW)).pages[2].text).toContain('Portable Document Format');

    // AES-256 (V5 / R6) with the chosen permission bits.
    const enc = (await encryptInfo(bytes))!;
    expect(enc).not.toBeNull();
    expect([enc.V, enc.R]).toEqual([5, 6]);
    const P = enc.P;
    expect(P & PERM.print).toBeTruthy();
    expect(P & PERM.printHigh).toBe(0);
    expect(P & PERM.modify).toBe(0);
    expect(P & PERM.copy).toBe(0);
    expect(P & PERM.annotate).toBeTruthy();
    expect(P & PERM.fill).toBeTruthy();
    expect(P & PERM.accessibility).toBeTruthy();
    expect(P & PERM.assemble).toBe(0);

    // Passwords: the owner password is the permissions password (full access); the user password isn't.
    expect(isOwnerPassword(enc, OWNER_PW)).toBe(true);
    expect(isOwnerPassword(enc, USER_PW)).toBe(false);
    expect(isUserPassword(enc, USER_PW)).toBe(true);
    expect(isUserPassword(enc, OWNER_PW)).toBe(false);
    const ownerKey = fileKey(enc, OWNER_PW, true);
    expect(ownerKey.equals(fileKey(enc, USER_PW, false))).toBe(true);
    expect(decryptPerms(enc, ownerKey)).toEqual({ P, tag: 'adb' });
    const lib = await loadLib(bytes, { password: OWNER_PW });
    expect(lib.getPageCount()).toBe(6);

    // Undo / redo the security change.
    await page.getByTestId('undo').click();
    await expect(summary).toHaveAttribute('data-secured', 'false');
    expect(await page.evaluate(() => window.__app.getActiveDoc().security)).toBeFalsy();
    await page.getByTestId('redo').click();
    await expect(summary).toHaveAttribute('data-secured', 'true');
    expect(await page.evaluate(() => window.__app.getActiveDoc().security)).toMatchObject({ userPassword: USER_PW, ownerPassword: OWNER_PW });
  });

  test('restrict editing only: opens without a password, permissions need the owner password', async ({ page }) => {
    await openFixture(page, 'sample.pdf');
    await openTask(page, 'protect');
    await page.getByTestId('protect-redact-restrict-editing').click();
    const dialog = page.getByTestId('protect-redact-restrict-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('protect-redact-open-password')).toHaveCount(0);
    await page.getByTestId('protect-redact-perm-password').fill(OWNER_PW);
    await expect(page.getByTestId('protect-redact-perm-strength')).toHaveAttribute('data-score', /[34]/);
    await page.getByTestId('protect-redact-perm-confirm').fill(OWNER_PW);
    await page.getByTestId('protect-redact-printing').selectOption('none');
    await page.getByTestId('protect-redact-changes').selectOption('pages');
    await page.getByTestId('protect-redact-copying').click();
    await page.getByTestId('protect-redact-protect-apply').click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('protect-redact-summary-open')).toHaveText('No');
    await expect(page.getByTestId('protect-redact-summary-perms')).toHaveText('Yes');
    await expect(page.getByTestId('protect-redact-restrictions').locator('[data-row="Printing"]')).toHaveClass(/is-denied/);

    const bytes = await download(page);
    expect(await needsPassword(bytes)).toBe(false);
    expect((await inspectPdf(bytes)).pages[0].text).toContain('PDF Wizard');
    const enc = (await encryptInfo(bytes))!;
    expect(enc).not.toBeNull();
    expect(enc.R).toBe(6);
    expect(enc.P & PERM.print).toBe(0);
    expect(enc.P & PERM.printHigh).toBe(0);
    expect(enc.P & PERM.modify).toBe(0);
    expect(enc.P & PERM.annotate).toBe(0);
    expect(enc.P & PERM.fill).toBe(0);
    expect(enc.P & PERM.copy).toBeTruthy();
    expect(enc.P & PERM.accessibility).toBeTruthy();
    expect(enc.P & PERM.assemble).toBeTruthy();
    expect(isUserPassword(enc, '')).toBe(true);
    expect(isOwnerPassword(enc, OWNER_PW)).toBe(true);
    expect(isOwnerPassword(enc, '')).toBe(false);
    expect(decryptPerms(enc, fileKey(enc, OWNER_PW, true))).toEqual({ P: enc.P, tag: 'adb' });
  });

  test('remove security gives an unencrypted file', async ({ page }) => {
    await openFixture(page, 'sample.pdf');
    await openTask(page, 'protect');
    await page.getByTestId('protect-redact-protect-password').click();
    await page.getByTestId('protect-redact-open-password').fill(USER_PW);
    await page.getByTestId('protect-redact-open-confirm').fill(USER_PW);
    await page.getByTestId('protect-redact-open-confirm').press('Enter');
    await expect(page.getByTestId('protect-redact-password-dialog')).toBeHidden();
    await expect(page.getByTestId('protect-redact-summary-perms')).toHaveText('No');
    expect(await needsPassword(await download(page))).toBe(true);

    // Cancel keeps the security.
    await page.getByTestId('protect-redact-remove-security').click();
    await page.getByTestId('dialog-cancel').click();
    await expect(page.getByTestId('protect-redact-summary')).toHaveAttribute('data-secured', 'true');

    await page.getByTestId('protect-redact-remove-security').click();
    await page.getByTestId('dialog-confirm').click();
    await expect(page.getByTestId('protect-redact-summary')).toHaveAttribute('data-secured', 'false');
    await expect(page.getByTestId('protect-redact-remove-security')).toHaveCount(0);
    const bytes = await download(page);
    expect(await needsPassword(bytes)).toBe(false);
    expect(await encryptInfo(bytes)).toBeNull();
    expect((await inspectPdf(bytes)).pages[0].text).toContain('PDF Wizard');
  });

  test('encrypted.pdf asks for the password and shows its security; removing it decrypts the file', async ({ page }) => {
    await openFixture(page, 'sample.pdf');
    await page.getByTestId('open-file-input').setInputFiles(`${FIXTURES_DIR}encrypted.pdf`);
    await expect(page.getByTestId('password-input')).toBeVisible();
    await page.getByTestId('password-input').fill('secret');
    await page.getByTestId('password-submit').click();
    await waitForDocReady(page, 'encrypted.pdf');
    await waitForPagesRendered(page);

    await openTask(page, 'protect');
    await expect(page.getByTestId('protect-redact-summary')).toHaveAttribute('data-secured', 'true');
    await expect(page.getByTestId('protect-redact-summary-method')).toHaveText('Password security');
    await expect(page.getByTestId('protect-redact-summary-encryption')).toHaveText('256-bit AES');
    await expect(page.getByTestId('protect-redact-summary-open')).toHaveText('Yes');
    // All permissions granted in the fixture.
    await expect(page.getByTestId('protect-redact-restrictions').locator('.is-denied')).toHaveCount(0);
    await expect(page.getByTestId('protect-redact-restrictions').locator('[data-row="Printing"]')).toContainText('High resolution');

    const kept = await download(page);
    expect(await needsPassword(kept)).toBe(true);
    expect((await inspectPdf(kept, 'secret')).pages[0].text).toContain('Confidential Budget Summary');

    await page.getByTestId('protect-redact-remove-security').click();
    await page.getByTestId('dialog-confirm').click();
    await expect(page.getByTestId('protect-redact-summary')).toHaveAttribute('data-secured', 'false');
    const open = await download(page);
    expect(await needsPassword(open)).toBe(false);
    expect((await inspectPdf(open)).pages[1].text).toContain('Allocation by Department');
  });
});

// ── Redact ─────────────────────────────────────────────────────────────────────

test.describe('Redact a PDF', () => {
  test('find text & redact: grouped results, checkboxes, apply removes every hit, undo restores', async ({ page }) => {
    await openFixture(page, 'sample.pdf');
    await openTask(page, 'redact');
    await expect(page.getByTestId('tool-chip-redact-mark')).toBeVisible();
    await expect(page.getByTestId('tool-chip-redact-pages')).toBeVisible();
    await expect(page.getByTestId('protect-redact-apply')).toBeDisabled();

    await page.getByTestId('protect-redact-open-find').click();
    await expect(page.getByTestId('protect-redact-find-panel')).toBeVisible();
    await page.getByTestId('protect-redact-find-input').fill('Wiza');
    await page.getByTestId('protect-redact-find-whole-words').click();
    await page.getByTestId('protect-redact-find-run').click();
    await expect(page.getByTestId('protect-redact-find-panel')).toContainText('No matches found');
    await page.getByTestId('protect-redact-find-whole-words').click();

    await page.getByTestId('protect-redact-find-input').fill('wizard');
    await page.getByTestId('protect-redact-find-match-case').click();
    await page.getByTestId('protect-redact-find-run').click();
    await expect(page.getByTestId('protect-redact-find-panel')).toContainText('No matches found');
    await page.getByTestId('protect-redact-find-input').fill('Wizard');
    await page.getByTestId('protect-redact-find-run').click();
    await expect(page.getByTestId('protect-redact-find-summary')).toHaveText('9 results on 6 pages');
    await expect(page.getByTestId('protect-redact-find-result')).toHaveCount(9);
    const perPage = [2, 1, 2, 2, 1, 1];
    for (let i = 0; i < 6; i++) await expect(page.getByTestId(`protect-redact-find-page-${i}`).getByTestId('protect-redact-find-result')).toHaveCount(perPage[i]);
    await expect(page.getByTestId('protect-redact-find-result').first()).toContainText('Wizard');

    // Leave one hit out, then mark it separately.
    await page.getByTestId('protect-redact-find-page-2').getByTestId('protect-redact-find-result-check').first().click();
    await expect(page.getByTestId('protect-redact-find-mark')).toContainText('8');
    await page.getByTestId('protect-redact-find-page-4').getByTestId('protect-redact-find-result-open').click();
    await expect.poll(async () => (await getDoc(page)).view.currentPage).toBe(4);
    await page.getByTestId('protect-redact-find-mark').click();
    expect(await marks(page)).toHaveLength(8);
    await expect(page.getByTestId('protect-redact-find-result')).toHaveCount(1);
    await page.getByTestId('protect-redact-find-result-check').click();
    await page.getByTestId('protect-redact-find-mark').click();
    // Everything is marked: back to the marks list.
    await expect(page.getByTestId('protect-redact-marks')).toBeVisible();
    await expect(page.getByTestId('protect-redact-mark-count')).toHaveText('9');
    await expect(page.getByTestId('protect-redact-mark-item')).toHaveCount(9);
    const found = await marks(page);
    expect(found.every((m) => m.mode === 'text' && m.text === 'Wizard')).toBe(true);
    expect(found.map((m) => m.pageIndex).sort()).toEqual([0, 0, 1, 2, 2, 3, 3, 4, 5]);
    await showPage(page, 0);
    await expect(pageEl(page, 0).getByTestId('protect-redact-mark')).toHaveCount(2);

    await applyAll(page);
    expect(await marks(page)).toHaveLength(0);
    await expect(page.getByTestId('protect-redact-marks-empty')).toBeVisible();
    // The viewer's text layer no longer has the word either.
    await showPage(page, 0);
    await expect(pageEl(page, 0).locator('.textLayer')).not.toContainText('Wizard');
    await expect(pageEl(page, 0).locator('.textLayer')).toContainText('Document Workflows');

    const bytes = await download(page);
    const out = await inspectPdf(bytes);
    expect(out.numPages).toBe(6);
    for (const p of out.pages) expect(p.text).not.toContain('Wizard');
    expect(out.pages[0].text).toContain('Document Workflows');
    expect(out.pages[0].text).toContain('Document Workflows in the Browser');
    expect(out.pages[2].text).toContain('Portable Document Format');
    expect(out.pages[4].text).toContain('Page 5 of 6');
    // Pages are rebuilt: page image + invisible text (Tr 3).
    const lib = await loadLib(bytes);
    expect(pageImages(lib, 0).map((i) => i.name)).toEqual(['RIm0']);
    const content = new TextDecoder('latin1').decode(zlib.inflateSync(Buffer.from((lib.context.lookup(lib.getPage(0).node.get(PDFName.of('Contents')) as never) as PDFRawStream).contents)));
    expect(content).toContain('3 Tr');

    // One undo step restores the text and the marks.
    await expectNewVersion(page, () => page.getByTestId('undo').click());
    await expect.poll(async () => (await marks(page)).length).toBe(9);
    await showPage(page, 0);
    await expect(pageEl(page, 0).locator('.textLayer')).toContainText('Wizard');
  });

  test('multiple words and patterns (e-mail) on a form keep the fields', async ({ page }) => {
    await openFixture(page, 'form.pdf');
    const fieldsBefore = (await loadLib(await download(page))).getForm().getFields().length;
    await openTask(page, 'redact');
    await page.getByTestId('protect-redact-open-find').click();

    await page.getByTestId('protect-redact-find-mode-multiple').click();
    await page.getByTestId('protect-redact-find-add-input').fill('Customer; Registration');
    await page.getByTestId('protect-redact-find-add-input').press('Enter');
    await expect(page.getByTestId('protect-redact-find-terms').locator('li')).toHaveCount(2);
    await page.getByTestId('protect-redact-find-run').click();
    await expect(page.getByTestId('protect-redact-find-results')).toBeVisible();
    expect(await page.getByTestId('protect-redact-find-result').count()).toBeGreaterThanOrEqual(2);
    await page.getByTestId('protect-redact-find-clear').click();

    await page.getByTestId('protect-redact-find-mode-patterns').click();
    await page.getByTestId('protect-redact-find-pattern-email').click();
    await page.getByTestId('protect-redact-find-run').click();
    await expect(page.getByTestId('protect-redact-find-summary')).toHaveText('1 result on 1 page');
    await expect(page.getByTestId('protect-redact-find-result')).toContainText('registrations@example.com');
    await page.getByTestId('protect-redact-find-mark').click();
    await expect(page.getByTestId('protect-redact-mark-count')).toHaveText('1');
    await applyAll(page);

    const bytes = await download(page);
    const text = (await inspectPdf(bytes)).pages[0].text;
    expect(text).not.toContain('registrations@example.com');
    expect(text).not.toContain('@');
    expect(text).toContain('Please return the completed form to');
    expect(text).toContain('Customer Registration Form');
    // Widgets away from the mark survive.
    expect((await loadLib(bytes)).getForm().getFields().length).toBe(fieldsBefore);
  });

  test('text marks from the selection popup and the mark tool; hover preview, properties bar, move', async ({ page }) => {
    await openFixture(page, 'sample.pdf');
    await openTask(page, 'redact');
    const layer = pageEl(page, 0).locator('.textLayer');

    // 1. Select a line with the select tool, then "Redact" in the selection popup.
    const line = layer.locator('span').filter({ hasText: 'Technical Overview and Product Report' }).first();
    const lb = (await line.boundingBox())!;
    await drag(page, [lb.x + 1, lb.y + lb.height / 2], [lb.x + lb.width - 1, lb.y + lb.height / 2]);
    await expect(page.getByTestId('text-selection-popup')).toBeVisible();
    await page.getByTestId('text-selection-popup').locator('[data-action-id=protect-redact-redact]').click();
    await expect.poll(async () => (await marks(page)).length).toBe(1);
    expect((await marks(page))[0]).toMatchObject({ mode: 'text', pageIndex: 0 });
    expect((await marks(page))[0].text).toContain('Technical Overview');

    // 2. The mark tool (shortcut y): double-click marks a word.
    const shortcut = await page.evaluate(() => window.__app.reg.tool('redact-mark')?.shortcut);
    if (shortcut === 'y') {
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
      await page.keyboard.press('y');
    } else {
      await page.getByTestId('protect-redact-tool-mark').click();
    }
    await expect.poll(() => page.evaluate(() => window.__app.useApp.getState().activeToolId)).toBe('redact-mark');
    await expect(page.getByTestId('tool-chip-redact-mark')).toHaveAttribute('aria-pressed', 'true');
    const prepared = layer.locator('span').filter({ hasText: 'Prepared by the Document Platform Team' }).first();
    const pb = (await prepared.boundingBox())!;
    await page.mouse.dblclick(pb.x + 12, pb.y + pb.height / 2);
    await expect.poll(async () => (await marks(page)).length).toBe(2);
    expect((await marks(page))[1].text).toBe('Prepared');

    // 3. Dragging where there is no text marks an area.
    await drag(page, await clientPoint(page, 0, 380, 540), await clientPoint(page, 0, 520, 470));
    await expect.poll(async () => (await marks(page)).length).toBe(3);
    const area = (await marks(page))[2];
    expect(area.mode).toBe('area');
    expect(Math.abs(area.rect.x - 380)).toBeLessThan(6);
    expect(Math.abs(area.rect.y - 470)).toBeLessThan(6);
    expect(Math.abs(area.rect.width - 140)).toBeLessThan(8);
    expect(Math.abs(area.rect.height - 70)).toBeLessThan(8);
    await expect(page.getByTestId('protect-redact-mark-count')).toHaveText('3');

    // Hover shows the redacted look (fill), otherwise only the red outline.
    await page.evaluate(() => window.__app.actions.setTool('select'));
    const areaEl = pageEl(page, 0).locator(`[data-testid=protect-redact-mark][data-mark-id="${area.id}"]`);
    const preview = areaEl.getByTestId('protect-redact-mark-preview');
    await expect(preview).toBeHidden();
    const outline = await areaEl.locator('.protect-redact-mark-outline rect').first().getAttribute('stroke');
    expect(outline?.toLowerCase()).toMatch(/^#(ff0000|e0301e|f00)|red|rgb\(255, 0, 0\)/);
    const ab = (await areaEl.boundingBox())!;
    await page.mouse.move(ab.x + ab.width / 2, ab.y + ab.height / 2);
    await expect(preview).toBeVisible();
    await page.mouse.move(ab.x - 60, ab.y - 60);
    await expect(preview).toBeHidden();
    // Hovering the list row previews too.
    const areaRow = page.locator(`[data-testid=protect-redact-mark-item][data-mark-id="${area.id}"]`);
    await expect(areaRow).toContainText('Area');
    await areaRow.hover();
    await expect(areaEl).toHaveClass(/is-hover/);
    await expect(preview).toBeVisible();

    // Select → properties bar; drag moves the mark.
    await page.mouse.click(ab.x + ab.width / 2, ab.y + ab.height / 2);
    await expect.poll(() => page.evaluate(() => [...window.__app.getActiveDoc().selection])).toEqual([area.id]);
    await expect(page.getByTestId('protect-redact-bar')).toBeVisible();
    await drag(page, [ab.x + ab.width / 2, ab.y + ab.height / 2], [ab.x + ab.width / 2 - 60, ab.y + ab.height / 2]);
    await expect.poll(async () => (await marks(page)).find((m) => m.id === area.id)!.rect.x).toBeLessThan(area.rect.x - 20);

    // Remove one from the list, apply the rest.
    await areaRow.getByTestId('protect-redact-mark-item-remove').click();
    await expect(page.getByTestId('protect-redact-mark-count')).toHaveText('2');
    await applyAll(page);
    const text = (await inspectPdf(await download(page))).pages[0].text;
    expect(text).not.toContain('Technical Overview');
    expect(text).not.toContain('Prepared');
    expect(text).toContain('by the Document Platform Team');
    expect(text).toContain('PDF Wizard');
    expect(text).toContain('January 2026');
  });

  test('marks stay on their text at 50% and 200% zoom, in the dark theme too', async ({ page }) => {
    await openFixture(page, 'sample.pdf');
    await page.evaluate(() => window.__app.actions.setPrefs({ theme: 'dark' }));
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await openTask(page, 'redact');
    await page.getByTestId('protect-redact-open-find').click();
    await page.getByTestId('protect-redact-find-input').fill('Abstract');
    await page.getByTestId('protect-redact-find-match-case').click();
    await page.getByTestId('protect-redact-find-run').click();
    await expect(page.getByTestId('protect-redact-find-summary')).toHaveText('1 result on 1 page');
    await page.getByTestId('protect-redact-find-mark').click();
    await expect(page.getByTestId('protect-redact-mark-count')).toHaveText('1');
    for (const zoom of [0.5, 2, 1]) {
      await page.evaluate((z) => window.__app.actions.setZoom(window.__app.getActiveDoc().id, z), zoom);
      await expect.poll(async () => (await getDoc(page)).view.zoom).toBe(zoom);
      await waitForPagesRendered(page);
      await showPage(page, 0);
      const span = pageEl(page, 0).locator('.textLayer span').filter({ hasText: /^Abstract$/ }).first();
      const mark = pageEl(page, 0).getByTestId('protect-redact-mark').first();
      await expect(mark).toBeVisible();
      const sb = (await span.boundingBox())!;
      const mb = (await mark.boundingBox())!;
      const tol = 4 * zoom + 1;
      expect(Math.abs(mb.x - sb.x), `left @${zoom}`).toBeLessThan(tol);
      expect(Math.abs(mb.x + mb.width - (sb.x + sb.width)), `right @${zoom}`).toBeLessThan(tol);
      expect(Math.abs(mb.y + mb.height / 2 - (sb.y + sb.height / 2)), `middle @${zoom}`).toBeLessThan(tol);
    }
  });

  test('area over an image: the pixels are gone from the saved image data', async ({ page }) => {
    await openFixture(page, 'images.pdf');
    const original = await loadLib(await download(page));
    expect(allImageSizes(original).filter((s) => s === '3000x2000')).toHaveLength(2);
    await openTask(page, 'redact');
    await page.getByTestId('protect-redact-tool-mark').click();
    await showPage(page, 0);
    await drag(page, await clientPoint(page, 0, 350, 580), await clientPoint(page, 0, 440, 500));
    await expect.poll(async () => (await marks(page)).length).toBe(1);
    expect((await marks(page))[0].mode).toBe('area');
    await applyAll(page);

    const bytes = await download(page);
    const lib = await loadLib(bytes);
    // Page 1's photo was replaced by the redacted raster; page 2 still has its original.
    const imgs = pageImages(lib, 0);
    expect(imgs.map((i) => i.name)).toEqual(['RIm0']);
    expect(pageImages(lib, 1).map((i) => `${i.width}x${i.height}`)).toEqual(['3000x2000']);
    expect(allImageSizes(lib).filter((s) => s === '3000x2000')).toHaveLength(1);
    const img = await decodeImage(imgs[0]);
    const inside = pixelAt(img, 395 / 612, (792 - 540) / 792);
    expect(Math.max(...inside)).toBeLessThan(40);
    // A point of the photo outside the mark is still painted (not black, not blank).
    const outside = pixelAt(img, 200 / 612, (792 - 540) / 792);
    expect(Math.max(...outside)).toBeGreaterThan(40);
    expect((await inspectPdf(bytes)).pages[0].text).toContain('Evening landscape');
  });

  test('rotated page: the visual top-left corner is redacted, the other corners stay', async ({ page }) => {
    await openFixture(page, 'rotated.pdf');
    await openTask(page, 'redact');
    await page.getByTestId('protect-redact-tool-mark').click();
    const el = await showPage(page, 1);
    const b = (await el.boundingBox())!;
    expect(b.width).toBeGreaterThan(b.height); // /Rotate 90: landscape on screen
    await drag(page, [b.x + 4, b.y + 4], [b.x + b.width * 0.25, b.y + b.height * 0.2]);
    await expect.poll(async () => (await marks(page)).length).toBe(1);
    const m = (await marks(page))[0];
    // Visual top-left of a /Rotate 90 page is user-space (0, 0).
    expect(m.pageIndex).toBe(1);
    expect(m.rect.x).toBeLessThan(10);
    expect(m.rect.y).toBeLessThan(10);
    expect(m.rect.width).toBeGreaterThan(100); // user-space x runs down the screen
    await applyAll(page);

    const out = await inspectPdf(await download(page));
    expect(out.pages[1].rotation).toBe(90);
    const words = out.pages[1].text.split(/\s+/);
    expect(words).not.toContain('TL');
    for (const w of ['TR', 'BL', 'BR', 'TOP']) expect(words).toContain(w);
    // Other pages untouched.
    expect(out.pages[0].text.split(/\s+/)).toContain('TL');
  });

  test('page marks with overlay text: pages become blank + overlay, links under marks removed', async ({ page }) => {
    await openFixture(page, 'sample.pdf');
    await openTask(page, 'redact');
    // Properties: overlay text for new marks.
    await page.getByTestId('protect-redact-open-properties').click();
    await expect(page.getByTestId('protect-redact-props-dialog')).toBeVisible();
    await page.getByTestId('protect-redact-props-use-text').click();
    await page.getByTestId('protect-redact-props-text').fill('CONFIDENTIAL');
    await page.getByTestId('protect-redact-props-ok').click();
    await expect(page.getByTestId('protect-redact-props-dialog')).toBeHidden();

    await page.getByTestId('tool-chip-redact-pages').click();
    await expect(page.getByTestId('protect-redact-pages-dialog')).toBeVisible();
    await page.getByTestId('protect-redact-pages-range').click();
    await page.getByTestId('protect-redact-pages-range-input').fill('4-6');
    await page.getByTestId('protect-redact-pages-subset').selectOption('even');
    await expect(page.getByTestId('protect-redact-pages-summary')).toContainText('2');
    await page.getByTestId('protect-redact-pages-ok').click();
    await expect(page.getByTestId('protect-redact-pages-dialog')).toBeHidden();
    const pm = await marks(page);
    expect(pm.map((m) => [m.mode, m.pageIndex])).toEqual([['page', 3], ['page', 5]]);
    expect(pm[0].overlay).toMatchObject({ useText: true, text: 'CONFIDENTIAL' });

    // An area over the first TOC link on page 2.
    await page.getByTestId('protect-redact-tool-mark').click();
    await showPage(page, 1);
    await drag(page, await clientPoint(page, 1, 75, 642), await clientPoint(page, 1, 200, 630));
    await expect.poll(async () => (await marks(page)).length).toBe(3);

    await applyAll(page);
    const bytes = await download(page);
    const out = await inspectPdf(bytes);
    expect(out.numPages).toBe(6);
    expect(out.pages[3].text).toBe('CONFIDENTIAL');
    expect(out.pages[5].text).toBe('CONFIDENTIAL');
    expect(out.pages[4].text).toContain('Page 5 of 6');
    expect(out.pages[4].text).toContain('Table 1');
    expect(out.pages[1].text).not.toContain('Introduction');
    expect(out.pages[1].text).toContain('Background');
    const lib = await loadLib(bytes);
    expect(annotSubtypes(lib, 1).filter((s) => s === '/Link')).toHaveLength(9);
    expect(pageImages(lib, 3)).toHaveLength(0); // a whole-page mark leaves no raster behind
  });

  test('unapplied marks export as /Redact annotations and import back', async ({ page }) => {
    await openFixture(page, 'sample.pdf');
    await openTask(page, 'redact');
    await page.getByTestId('protect-redact-open-properties').click();
    await page.getByTestId('protect-redact-props-use-text').click();
    await page.getByTestId('protect-redact-props-text').fill('EXEMPT');
    await page.getByTestId('protect-redact-props-ok').click();
    await page.getByTestId('protect-redact-open-find').click();
    await page.getByTestId('protect-redact-find-input').fill('Portable Document Format');
    await page.getByTestId('protect-redact-find-run').click();
    await expect(page.getByTestId('protect-redact-find-summary')).toHaveText('1 result on 1 page');
    await page.getByTestId('protect-redact-find-mark').click();
    await expect(page.getByTestId('protect-redact-mark-count')).toHaveText('1');
    const [mark] = await marks(page);

    const bytes = await download(page);
    const lib = await loadLib(bytes);
    expect(annotSubtypes(lib, 2)).toContain('/Redact');
    // Not applied: the text is still in the file.
    expect((await inspectPdf(bytes)).pages[2].text).toContain('Portable Document Format');

    await openBytes(page, 'redact-roundtrip.pdf', bytes);
    await openTask(page, 'redact');
    await expect(page.getByTestId('protect-redact-mark-count')).toHaveText('1');
    const [back] = await marks(page);
    expect(back).toMatchObject({ mode: 'text', pageIndex: 2, text: 'Portable Document Format', overlay: { useText: true, text: 'EXEMPT' } });
    for (const k of ['x', 'y', 'width', 'height'] as const) expect(Math.abs(back.rect[k] - mark.rect[k])).toBeLessThan(1);

    await applyAll(page);
    const out = await inspectPdf(await download(page));
    expect(out.pages[2].text).not.toContain('Portable Document Format');
    expect(out.pages[2].text).toContain('EXEMPT');
    expect(annotSubtypes(await loadLib(await download(page)), 2)).not.toContain('/Redact');
  });

  test('remove hidden information: metadata, bookmarks and links', async ({ page }) => {
    await openFixture(page, 'sample.pdf');
    expect((await getDoc(page)).outlineCount).toBeGreaterThan(0);
    await openTask(page, 'redact');
    await page.getByTestId('protect-redact-sanitize').click();
    await expect(page.getByTestId('protect-redact-sanitize-dialog')).toBeVisible();
    await expect(page.getByTestId('protect-redact-sanitize-loading')).toHaveCount(0, { timeout: 30_000 });
    for (const k of ['metadata', 'bookmarks', 'links']) await expect(page.getByTestId(`protect-redact-sanitize-${k}`).locator('input')).toBeChecked();
    await expect(page.getByTestId('protect-redact-sanitize-attachments').locator('input')).not.toBeChecked();
    await expectNewVersion(page, () => page.getByTestId('protect-redact-sanitize-apply').click());
    await expect(page.getByTestId('protect-redact-sanitize-dialog')).toBeHidden();
    await expect.poll(async () => (await getDoc(page)).outlineCount).toBe(0);

    const bytes = await download(page);
    const lib = await loadLib(bytes);
    expect(lib.getTitle() ?? '').toBe('');
    expect(lib.getAuthor() ?? '').toBe('');
    expect(annotSubtypes(lib, 1)).toHaveLength(0);
    expect(annotSubtypes(lib, 5)).toHaveLength(0);
    const out = await inspectPdf(bytes);
    expect(out.outlineCount).toBe(0);
    expect(out.pages[0].text).toContain('PDF Wizard');

    // One undo step brings everything back.
    await expectNewVersion(page, () => page.getByTestId('undo').click());
    await expect.poll(async () => (await getDoc(page)).outlineCount).toBeGreaterThan(0);
  });

  test('hidden text and layers stay hidden through Apply; Remove hidden information clears them and the rest', async ({ page }) => {
    const src = await hiddenInfoPdf();
    const before = await inspectPdf(src);
    // pdf.js reports invisible and hidden-layer text: that's what must not leak into the redacted page.
    expect(before.pages[0].text).toContain('OCRLAYER');
    expect(before.pages[0].text).toContain('LAYERSECRET');
    expect(before.pages[1].text).not.toContain('CROPPEDOUT');
    expect(await uncroppedText(src, 1)).toContain('CROPPEDOUT');
    await openBytes(page, 'hidden-info.pdf', src);
    await openTask(page, 'redact');
    await page.getByTestId('protect-redact-open-find').click();
    await page.getByTestId('protect-redact-find-input').fill('SECRETWORD');
    await page.getByTestId('protect-redact-find-run').click();
    await expect(page.getByTestId('protect-redact-find-summary')).toHaveText('1 result on 1 page');
    await page.getByTestId('protect-redact-find-mark').click();
    await expect(page.getByTestId('protect-redact-mark-count')).toHaveText('1');

    await applyAll(page, 'sanitize');
    await expect(page.getByTestId('protect-redact-sanitize-dialog')).toBeVisible();
    const applied = new Uint8Array(await page.evaluate(() => Array.from(window.__app.getActiveDoc().bytes as Uint8Array)));
    const mid = await inspectPdf(applied);
    expect(mid.pages[0].text).not.toContain('SECRETWORD');
    expect(mid.pages[0].text).toContain('Visible line with');
    expect(mid.pages[0].text).toContain('Another visible line stays');
    // The layer that was off is not turned into searchable text of the rebuilt page...
    expect(mid.pages[0].text).not.toContain('LAYERSECRET');
    // ...and the invisible text is still hidden text, so the next step can still find and remove it.
    expect(mid.pages[0].text).toContain('OCRLAYER');

    await expect(page.getByTestId('protect-redact-sanitize-loading')).toHaveCount(0, { timeout: 30_000 });
    for (const k of ['hiddenText', 'layers', 'attachments', 'links', 'cropped', 'metadata']) {
      expect(Number(await page.getByTestId(`protect-redact-sanitize-${k}`).getAttribute('data-count')), k).toBeGreaterThan(0);
    }
    await page.getByTestId('protect-redact-sanitize-all').locator('label').click();
    await expect(page.getByTestId('protect-redact-sanitize-all').locator('input')).toBeChecked();
    await expectNewVersion(page, () => page.getByTestId('protect-redact-sanitize-apply').click());
    await expect(page.getByTestId('protect-redact-sanitize-dialog')).toBeHidden();

    const bytes = await download(page);
    const out = await inspectPdf(bytes);
    expect(out.pages[0].text).not.toContain('OCRLAYER');
    expect(out.pages[0].text).not.toContain('SECRETWORD');
    // The searchable text of the redacted page is not "hidden text".
    expect(out.pages[0].text).toContain('Another visible line stays');
    expect(out.pages[1].text).not.toContain('LAYERTWO');
    expect(out.pages[1].text).toContain('Inside the crop box');
    const lib = await loadLib(bytes);
    expect(lib.catalog.get(PDFName.of('OCProperties'))).toBeUndefined();
    expect(nameTrees(lib)).not.toContain('EmbeddedFiles');
    expect(nameTrees(lib)).not.toContain('JavaScript');
    expect(lib.getAuthor() ?? '').toBe('');
    expect(lib.getPage(1).getMediaBox()).toEqual({ x: 100, y: 100, width: 312, height: 492 });
    // What was outside the crop box is gone from the page, not just cut off.
    const uncropped = await uncroppedText(bytes, 1);
    expect(uncropped).not.toContain('CROPPEDOUT');
    expect(uncropped).toContain('Inside the crop box');

    // One undo step brings the attachment and the layer back (the redaction stays).
    await expectNewVersion(page, () => page.getByTestId('undo').click());
    const undone = await loadLib(await download(page));
    expect(nameTrees(undone)).toContain('EmbeddedFiles');
    expect(undone.catalog.get(PDFName.of('OCProperties'))).toBeDefined();
    expect((await inspectPdf(await download(page))).pages[0].text).not.toContain('SECRETWORD');
  });

  test('overlay text warns about characters the fonts lack; Apply runs once; marks follow deleted and moved pages', async ({ page }) => {
    await openFixture(page, 'sample.pdf');
    await openTask(page, 'redact');
    await page.getByTestId('protect-redact-open-properties').click();
    await page.getByTestId('protect-redact-props-use-text').click();
    await page.getByTestId('protect-redact-props-text').fill('Zoë 日本');
    const warning = page.getByTestId('protect-redact-props-text-warning');
    await expect(warning).toContainText('日 本');
    await expect(warning.locator('b')).not.toContainText('ë');
    await page.getByTestId('protect-redact-props-text').fill('WITHHELD');
    await expect(warning).toHaveCount(0);
    await page.getByTestId('protect-redact-props-ok').click();
    await expect(page.getByTestId('protect-redact-props-dialog')).toBeHidden();

    await page.getByTestId('tool-chip-redact-pages').click();
    await page.getByTestId('protect-redact-pages-range').click();
    await page.getByTestId('protect-redact-pages-range-input').fill('2-4');
    await page.getByTestId('protect-redact-pages-ok').click();
    await expect(page.getByTestId('protect-redact-mark-count')).toHaveText('3');

    // Page 3 goes away with its mark; page 2 moves to the end and its mark goes along.
    await engineOp(page, 'deletePages', [2]);
    await expect(page.getByTestId('protect-redact-mark-count')).toHaveText('2');
    await engineOp(page, 'movePagesTo', [1], 5);
    expect((await marks(page)).map((m) => m.pageIndex).sort()).toEqual([1, 4]);

    // Running the command twice (double click, shortcut + button...) asks and applies once.
    await page.evaluate(() => {
      const c = window.__app.reg.command('protect-redact.apply');
      void c.run();
      void c.run();
    });
    await expect(page.getByTestId('protect-redact-apply-confirm')).toHaveCount(1);
    await page.getByTestId('dialog-confirm').click();
    await expect(page.getByTestId('protect-redact-after-apply')).toHaveCount(1, { timeout: 90_000 });
    await expect(page.getByTestId('protect-redact-apply-confirm')).toHaveCount(0);
    await page.getByTestId('dialog-choice-skip').click();
    await waitForDocReady(page);
    const labels = await page.evaluate(() => window.__app.getActiveDoc().history.past.map((s: { label: string }) => s.label));
    expect(labels.filter((l: string) => l === 'Apply redactions')).toHaveLength(1);
    expect(await marks(page)).toHaveLength(0);

    const out = await inspectPdf(await download(page));
    expect(out.numPages).toBe(5);
    expect(out.pages[1].text).toBe('WITHHELD');
    expect(out.pages[4].text).toBe('WITHHELD');
    expect(out.pages[0].text).toContain('PDF Wizard');
    expect(out.pages[2].text).toContain('Page 5 of 6');
    expect(out.pages[3].text).toContain('Page 6 of 6');

    await expectNewVersion(page, () => page.getByTestId('undo').click());
    expect((await marks(page)).map((m) => m.pageIndex).sort()).toEqual([1, 4]);
  });
});
