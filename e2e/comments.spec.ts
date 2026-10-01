/// <reference lib="dom" />
/// <reference lib="dom.iterable" />
/**
 * Comments: the Comment task and its tools, sticky notes with pop-ups / replies / review status,
 * text markups (highlight / underline / strikethrough / squiggly) from the selection pop-up and the
 * tools, insert / replace text (Caret), text boxes and callouts (FreeText), file attachments, the
 * Comments panel (search, filter, sort, XFDF export / import, delete all, hide, summary), existing
 * annotations importing as comments, rotated pages / zoom / dark theme, read-only documents and the
 * exported standard annotations (checked with pdf-lib and pdf.js), including download → reopen.
 */
import fs from 'node:fs';
import type { Locator, Page } from '@playwright/test';
import { decodePDFRawStream, PDFArray, PDFDict, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFStream, PDFString, type PDFObject } from '@cantoo/pdf-lib';
import { FIXTURES_DIR, captureDownload, expect, inspectPdf, loadLib, openFixture, openPdfjs, test, waitForDocReady, waitForPagesRendered } from './helpers';

const OWN_TOOLS = [
  'comment-note', 'comment-highlight', 'comment-underline', 'comment-strikeout', 'comment-squiggly',
  'comment-insert-text', 'comment-replace-text', 'comment-textbox', 'comment-callout', 'comment-attach',
];
const OWN_KINDS = ['note', 'text-markup', 'caret', 'freetext', 'file-attachment'];

interface Pt {
  x: number;
  y: number;
}
interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface CObj {
  id: string;
  kind: string;
  pageIndex: number;
  rect: Rect;
  contents?: string;
  author?: string;
  status?: string;
  color?: string | null;
  replies: { author: string; text: string }[];
  data: any; // eslint-disable-line @typescript-eslint/no-explicit-any
}

// ── app state ────────────────────────────────────────────────────────────────

const viewer = (page: Page) => page.getByTestId('document-viewer');
const pageEl = (page: Page, index: number) => viewer(page).locator(`[data-testid=page][data-page-index="${index}"]`);
const activeTool = (page: Page): Promise<string> => page.evaluate(() => window.__app.useApp.getState().activeToolId);
const cards = (page: Page) => page.getByTestId('comments-card');

/** Comment objects (our kinds) of the active document in stacking order, attachment bytes as a length. */
function comments(page: Page): Promise<CObj[]> {
  return page.evaluate((kinds) => {
    const d = window.__app.getActiveDoc();
    return d.order
      .map((id: string) => d.objects[id])
      .filter((o: any) => o && kinds.includes(o.kind)) // eslint-disable-line @typescript-eslint/no-explicit-any
      .map((o: any) => ({ // eslint-disable-line @typescript-eslint/no-explicit-any
        id: o.id,
        kind: o.kind,
        pageIndex: d.pages.findIndex((p: { id: string }) => p.id === o.pageId),
        rect: { ...o.rect },
        contents: o.contents,
        author: o.author,
        status: o.status,
        color: o.color,
        replies: (o.replies ?? []).map((r: { author: string; text: string }) => ({ author: r.author, text: r.text })),
        data: JSON.parse(JSON.stringify({ ...o.data, bytes: o.data.bytes ? o.data.bytes.length : undefined })),
      }));
  }, OWN_KINDS);
}
const ofKind = async (page: Page, kind: string) => (await comments(page)).filter((o) => o.kind === kind);
const countKind = async (page: Page, kind: string) => (await ofKind(page, kind)).length;

async function blur(page: Page) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
}
async function pressShortcut(page: Page, key: string, tool: string) {
  await blur(page);
  await page.keyboard.press(key);
  await expect.poll(() => activeTool(page)).toBe(tool);
}
async function chooseTool(page: Page, id: string) {
  await page.getByTestId(`tool-chip-${id}`).click();
  await expect.poll(() => activeTool(page)).toBe(id);
}
/** Opens the Comment task, from the All tools list (`fromList`) or through the store. */
async function openCommentTask(page: Page, fromList = false) {
  if (fromList) await page.locator('[data-testid=tools-list-item][data-task-id=comment]').first().click();
  else await page.evaluate(() => window.__app.actions.openTask('comment'));
  await expect(page.getByTestId('comments-task-panel')).toBeVisible();
  await expect(page.getByTestId('comments-panel')).toBeVisible();
}
/** Shows the Comments panel in the right rail (if it isn't showing). */
async function showPanel(page: Page) {
  if (!(await page.getByTestId('comments-panel').isVisible())) await page.getByTestId('panel-btn-comments').click();
  await expect(page.getByTestId('comments-panel')).toBeVisible();
}
async function pickMenu(page: Page, trigger: Locator, item: string) {
  await trigger.click();
  await page.locator(`[data-menu-id="${item}"]`).click();
}
async function pickSubmenu(page: Page, trigger: Locator, sub: string, item: string) {
  await trigger.click();
  await page.locator(`[data-menu-id="${sub}"]`).hover();
  await page.locator(`[data-menu-id="${item}"]`).click();
}
/** Page text items (PDF user space) of a page of the active document. */
function pageText(page: Page, index: number): Promise<{ str: string; rect: Rect }[]> {
  return page.evaluate(async (i) => {
    const t = await window.__engine.getPageText(window.__app.getActiveDoc().id, i);
    return t.items.filter((x: { str: string }) => x.str.trim()).map((x: { str: string; rect: Rect }) => ({ str: x.str, rect: { ...x.rect } }));
  }, index);
}
async function textItem(page: Page, index: number, str: string) {
  const it = (await pageText(page, index)).find((x) => x.str.includes(str));
  if (!it) throw new Error(`no text "${str}" on page ${index + 1}`);
  return it;
}

// ── coordinates ──────────────────────────────────────────────────────────────

/** Client position of PDF user-space points on a page (honours page + view rotation). */
function rawClient(page: Page, index: number, pts: Pt[]): Promise<Pt[]> {
  return page.evaluate(
    ({ index, pts }) => {
      const d = window.__app.getActiveDoc();
      const pg = d.pages[index];
      const el = document.querySelector(`[data-testid=document-viewer] [data-testid=page][data-page-index="${index}"]`)!;
      const b = el.getBoundingClientRect();
      const rot = ((((pg.rotation || 0) + (d.view.rotation || 0)) % 360) + 360) % 360;
      const [x0, y0, x1, y1] = pg.view;
      return pts.map(({ x, y }) => {
        const u = (x - x0) / (x1 - x0);
        const v = (y1 - y) / (y1 - y0);
        const [fx, fy] = rot === 0 ? [u, v] : rot === 90 ? [1 - v, u] : rot === 180 ? [1 - u, 1 - v] : [v, 1 - u];
        return { x: b.left + fx * b.width, y: b.top + fy * b.height };
      });
    },
    { index, pts },
  );
}
const frame = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null)))));

/**
 * Scrolls the page so that all points are inside the viewer (clear of the floating controls) and
 * returns their client positions. Measured right before use: tool options / properties bars shift
 * the pages when they appear.
 */
async function clientPoints(page: Page, index: number, pts: Pt[]): Promise<Pt[]> {
  const el = pageEl(page, index);
  if (!(await el.count())) await page.evaluate((i) => window.__app.actions.goToPage(window.__app.getActiveDoc().id, i), index);
  await expect(el).toHaveClass(/is-painted/);
  const scroller = viewer(page).locator('.pdfwizard-scroller').first();
  for (let i = 0; i < 6; i++) {
    await frame(page);
    const c = await rawClient(page, index, pts);
    const s = (await scroller.boundingBox())!;
    const ys = c.map((p) => p.y);
    const xs = c.map((p) => p.x);
    const lo = Math.min(...ys), hi = Math.max(...ys);
    const top = s.y + 80, bottom = s.y + s.height - 120;
    const left = s.x + 20, right = s.x + s.width - 20;
    const dy = lo >= top && hi <= bottom ? 0 : (lo + hi) / 2 - (top + bottom) / 2;
    const lx = Math.min(...xs), hx = Math.max(...xs);
    const dx = lx >= left && hx <= right ? 0 : (lx + hx) / 2 - (left + right) / 2;
    if (!dx && !dy) return c;
    await scroller.evaluate((n, [ddx, ddy]) => n.scrollBy(ddx, ddy), [dx, dy]);
  }
  await frame(page);
  return rawClient(page, index, pts);
}
const clientPoint = async (page: Page, index: number, p: Pt) => (await clientPoints(page, index, [p]))[0];

async function drag(page: Page, a: Pt, b: Pt, steps = 8) {
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps });
  await page.mouse.up();
}
async function clickPdf(page: Page, index: number, p: Pt, opts: { button?: 'left' | 'right' } = {}) {
  const c = await clientPoint(page, index, p);
  await page.mouse.click(c.x, c.y, opts);
}
/** Selects the text of a (horizontal) item by dragging across it, from `from` to `to` (0..1 of its width). */
async function selectText(page: Page, index: number, it: { rect: Rect }, from = 0, to = 1) {
  const r = it.rect;
  const y = r.y + r.height / 2;
  const [a, b] = await clientPoints(page, index, [{ x: r.x + r.width * from + 0.5, y }, { x: r.x + r.width * to - 0.5, y }]);
  await drag(page, a, b, 12);
}

const expectNear = (a: number, b: number, tol = 2) => expect(Math.abs(a - b), `${a} ≈ ${b}`).toBeLessThanOrEqual(tol);
function quadBounds(q: number[]) {
  const xs = q.filter((_, i) => i % 2 === 0);
  const ys = q.filter((_, i) => i % 2 === 1);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
}
function expectInside(p: Pt, r: Rect, tol = 2) {
  expect(p.x, `x ${p.x} in ${r.x}..${r.x + r.width}`).toBeGreaterThanOrEqual(r.x - tol);
  expect(p.x, `x ${p.x} in ${r.x}..${r.x + r.width}`).toBeLessThanOrEqual(r.x + r.width + tol);
  expect(p.y, `y ${p.y} in ${r.y}..${r.y + r.height}`).toBeGreaterThanOrEqual(r.y - tol);
  expect(p.y, `y ${p.y} in ${r.y}..${r.y + r.height}`).toBeLessThanOrEqual(r.y + r.height + tol);
}

// ── PDF inspection ──────────────────────────────────────────────────────────

interface Annot {
  page: number;
  subtype: string;
  rect: number[];
  ref: PDFRef | null;
  get(key: string): PDFObject | undefined;
  nums(key: string, from?: PDFDict): number[] | undefined;
  num(key: string, from?: PDFDict): number | undefined;
  name(key: string, from?: PDFDict): string | undefined;
  text(key: string, from?: PDFDict): string | undefined;
  dict(key: string, from?: PDFDict): PDFDict | undefined;
  /** Target of an indirect reference entry (e.g. /IRT, /Popup). */
  refOf(key: string): PDFRef | undefined;
  /** Decoded normal appearance stream content. */
  ap: string;
  blendModes: string[];
  streamBytes(s: PDFObject | undefined): Uint8Array | undefined;
}

async function annotations(bytes: Uint8Array): Promise<Annot[]> {
  const doc = await loadLib(bytes);
  const deref = (o: PDFObject | undefined) => (o instanceof PDFRef ? doc.context.lookup(o) : o);
  const out: Annot[] = [];
  doc.getPages().forEach((p, pageIndex) => {
    const arr = p.node.Annots();
    if (!arr) return;
    for (let k = 0; k < arr.size(); k++) {
      const raw = arr.get(k);
      const a = deref(raw);
      if (!(a instanceof PDFDict)) continue;
      const get = (key: string, from: PDFDict = a) => deref(from.get(PDFName.of(key)));
      const nums = (key: string, from: PDFDict = a) => {
        const v = get(key, from);
        if (!(v instanceof PDFArray)) return undefined;
        return v.asArray().map((x) => deref(x)).filter((x): x is PDFNumber => x instanceof PDFNumber).map((x) => x.asNumber());
      };
      const num = (key: string, from: PDFDict = a) => {
        const v = get(key, from);
        return v instanceof PDFNumber ? v.asNumber() : undefined;
      };
      const name = (key: string, from: PDFDict = a) => {
        const v = get(key, from);
        return v instanceof PDFName ? v.decodeText() : undefined;
      };
      const text = (key: string, from: PDFDict = a) => {
        const v = get(key, from);
        return v instanceof PDFString || v instanceof PDFHexString ? v.decodeText() : undefined;
      };
      const dict = (key: string, from: PDFDict = a) => {
        const v = get(key, from);
        return v instanceof PDFDict ? v : undefined;
      };
      const refOf = (key: string) => {
        const v = a.get(PDFName.of(key));
        return v instanceof PDFRef ? v : undefined;
      };
      const streamBytes = (s: PDFObject | undefined) => {
        const v = deref(s);
        return v instanceof PDFRawStream ? decodePDFRawStream(v).decode() : undefined;
      };
      let ap = '';
      const blendModes: string[] = [];
      const apDict = get('AP');
      const n = apDict instanceof PDFDict ? get('N', apDict) : undefined;
      if (n instanceof PDFStream) {
        if (n instanceof PDFRawStream) ap = Buffer.from(decodePDFRawStream(n).decode()).toString('latin1');
        const res = get('Resources', n.dict);
        const gs = res instanceof PDFDict ? get('ExtGState', res) : undefined;
        if (gs instanceof PDFDict) {
          for (const [, v] of gs.entries()) {
            const g = deref(v);
            const bm = g instanceof PDFDict ? name('BM', g) : undefined;
            if (bm) blendModes.push(bm);
          }
        }
      }
      out.push({
        page: pageIndex, subtype: name('Subtype') ?? '', rect: nums('Rect') ?? [], ref: raw instanceof PDFRef ? raw : null,
        get: (key) => get(key), nums, num, name, text, dict, refOf, ap, blendModes, streamBytes,
      });
    }
  });
  return out;
}
const sameRef = (a: PDFRef | null | undefined, b: PDFRef | null | undefined) => !!a && !!b && a.objectNumber === b.objectNumber && a.generationNumber === b.generationNumber;

/** Annotations as pdf.js reads them (subtype, contents, title, quadPoints, file…) per page. */
async function pdfjsAnnotations(bytes: Uint8Array) {
  const { doc, close } = await openPdfjs(bytes);
  const out: any[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  for (let i = 1; i <= doc.numPages; i++) {
    const p = await doc.getPage(i);
    for (const a of await p.getAnnotations()) {
      // pdf.js 6 loads embedded files on demand.
      const content = a.subtype === 'FileAttachment' && a.fileId ? await doc.getAttachmentContent(a.fileId) : undefined;
      out.push({ ...a, page: i - 1, content });
    }
  }
  await close();
  return out;
}

async function download(page: Page) {
  const { bytes } = await captureDownload(page, () => page.getByTestId('download').click());
  return bytes;
}
/** Opens downloaded bytes as a new document through the real file input. */
async function reopen(page: Page, bytes: Uint8Array, name: string) {
  await page.getByTestId('open-file-input').setInputFiles({ name, mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
  await waitForDocReady(page, name);
  await waitForPagesRendered(page);
}
async function flattenedBytes(page: Page): Promise<Uint8Array> {
  const arr = await page.evaluate(async () => {
    const b: Uint8Array = await window.__engine.exportPdf(window.__app.getActiveDoc().id, { purpose: 'download', flatten: true });
    return Array.from(b);
  });
  return new Uint8Array(arr);
}

/**
 * Types into the pop-up note's editor (open and focused after creating a comment) and posts: like
 * desktop editors, posting the text of a new comment closes its pop-up.
 */
async function postInPopup(page: Page, text: string) {
  const input = page.getByTestId('comments-popup-editor-input');
  await expect(input).toBeVisible();
  await expect(input).toBeFocused();
  await page.keyboard.type(text);
  await page.getByTestId('comments-popup-editor-post').click();
  await expect(page.getByTestId('comments-popup')).toHaveCount(0);
}

// ── tests ────────────────────────────────────────────────────────────────────

test.describe('comments', () => {
  test('Comment task: toolbar, Comments panel, shortcuts and the Comment menu', async ({ page }) => {
    await openFixture(page, 'sample.pdf');
    await expect(page.getByTestId('quick-tool-comment-note')).toBeVisible();
    await expect(page.getByTestId('quick-tool-comment-highlight')).toBeVisible();

    await openCommentTask(page, true);
    for (const id of OWN_TOOLS) {
      await expect(page.getByTestId(`tool-chip-${id}`)).toBeVisible();
      await expect(page.getByTestId(`comments-task-tool-${id}`)).toBeVisible();
    }
    // Empty state of the panel, with a shortcut to add a note.
    await expect(page.getByTestId('comments-list')).toContainText('No comments yet');
    await page.getByTestId('comments-empty-add').click();
    await expect.poll(() => activeTool(page)).toBe('comment-note');
    await expect(page.getByTestId('comments-task-options').getByTestId('comments-options-note')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect.poll(() => activeTool(page)).toBe('select');

    // Plain-key shortcuts; Esc goes back to the selection tool.
    for (const [key, tool] of [['s', 'comment-note'], ['u', 'comment-highlight'], ['x', 'comment-textbox']]) {
      await pressShortcut(page, key, tool);
      await page.keyboard.press('Escape');
      await expect.poll(() => activeTool(page)).toBe('select');
    }

    // Hamburger menu → Comment.
    await page.getByTestId('app-menu').click();
    await page.locator('[data-menu-id="menu.comment"]').hover();
    const ids = ['comments-add-note', 'comments-highlight-selection', 'comments-show-panel', 'comments-export-xfdf', 'comments-import-xfdf', 'comments-summarize', 'comments-toggle-hidden'];
    for (const id of ids) await expect(page.locator(`[data-menu-id="${id}"]`)).toBeVisible();
    // Nothing to export, summarize or hide yet.
    for (const id of ['comments-export-xfdf', 'comments-summarize', 'comments-toggle-hidden']) {
      await expect(page.locator(`[data-menu-id="${id}"]`)).toHaveAttribute('aria-disabled', 'true');
    }
    await page.locator('[data-menu-id="comments-add-note"]').click();
    await expect.poll(() => activeTool(page)).toBe('comment-note');

    // Page context menu: "Add sticky note here" creates the note under the pointer.
    await page.keyboard.press('Escape');
    const at = { x: 200, y: 300 };
    await clickPdf(page, 0, at, { button: 'right' });
    await page.locator('[data-menu-id="comments-ctx-add-note"]').click();
    await expect(page.getByTestId('comments-popup-editor-input')).toBeFocused();
    await page.keyboard.type('From the context menu');
    await page.keyboard.press('Control+Enter');
    await expect.poll(async () => (await ofKind(page, 'note'))[0]?.contents).toBe('From the context menu');
    const [n] = await ofKind(page, 'note');
    expectInside(at, n.rect);
    await expect(cards(page)).toHaveCount(1);
    await expect(page.getByTestId('panel-btn-comments')).toContainText('1');
  });

  test('sticky notes: pop-up with replies and status, /Text /Popup /IRT /StateModel export and round trip', async ({ page }) => {
    await openFixture(page, 'sample.pdf');
    await pressShortcut(page, 's', 'comment-note');
    const at = { x: 420, y: 660 };
    await clickPdf(page, 0, at);
    const text = 'Please check these figures – “ünïcode” ✓';
    await postInPopup(page, text);
    // One note at the click point; the tool goes back to Select after placing it.
    await expect.poll(() => countKind(page, 'note')).toBe(1);
    await expect.poll(() => activeTool(page)).toBe('select');
    let [note] = await ofKind(page, 'note');
    expectInside(at, note.rect);
    expect(note.author).toBeTruthy();
    await expect(pageEl(page, 0).getByTestId('comments-note')).toHaveCount(1);
    expect(note.contents).toBe(text);

    // Selecting the note shows its pop-up: reply and set the review status there.
    await pageEl(page, 0).getByTestId('comments-note').click();
    await expect(page.getByTestId('comments-popup-contents')).toHaveText(text);
    await page.getByTestId('comments-popup-reply').click();
    await expect(page.getByTestId('comments-popup-replybox-input')).toBeFocused();
    await page.keyboard.type('Looks right to me.');
    await page.getByTestId('comments-popup-replybox-post').click();
    await expect(page.getByTestId('comments-popup-reply-0-text')).toHaveText('Looks right to me.');
    await pickSubmenu(page, page.getByTestId('comments-popup-more'), 'comments-set-status', 'comments-status-accepted');
    await expect(page.getByTestId('comments-popup-status')).toContainText('Accepted');
    [note] = await ofKind(page, 'note');
    expect(note.replies).toEqual([{ author: note.author, text: 'Looks right to me.' }]);
    expect(note.status).toBe('accepted');

    // Edit the note text from the pop-up's "…" menu.
    await pickMenu(page, page.getByTestId('comments-popup-more'), 'comments-edit');
    await expect(page.getByTestId('comments-popup-editor-input')).toBeFocused();
    await page.keyboard.press('End');
    await page.keyboard.type(' Thanks!');
    await page.getByTestId('comments-popup-editor-post').click();
    const edited = `${text} Thanks!`;
    await expect.poll(async () => (await ofKind(page, 'note'))[0].contents).toBe(edited);
    await page.getByTestId('comments-popup-close').click();
    await expect(page.getByTestId('comments-popup')).toHaveCount(0);

    // The panel card mirrors the note.
    await showPanel(page);
    const card = cards(page).first();
    await expect(card.getByTestId('comments-card-contents')).toHaveText(edited);
    await expect(card.getByTestId('comments-card-status')).toContainText('Accepted');
    await expect(card.getByTestId('comments-card-type')).toHaveText('Sticky note');

    // Export: /Text with /Name, /Popup, a reply (/IRT /RT R) and a review state (/StateModel).
    const bytes = await download(page);
    const ann = await annotations(bytes);
    const top = ann.filter((a) => a.subtype === 'Text' && !a.get('IRT'));
    expect(top).toHaveLength(1);
    const t = top[0];
    expect(t.text('Contents')).toBe(edited);
    expect(t.text('T')).toBe(note.author);
    expect(t.text('NM')).toBe(note.id);
    expect(t.text('Subj')).toBeTruthy();
    expect(t.text('M')).toMatch(/^D:\d{14}/);
    expect(t.text('CreationDate')).toMatch(/^D:\d{14}/);
    expect(t.name('Name')).toBe('Comment');
    // NoZoom | NoRotate | Print, like the usual sticky notes.
    expect(t.num('F')).toBe(28);
    expect(t.ap).toMatch(/\bf\b|\bB\b/);
    const popup = ann.find((a) => a.subtype === 'Popup')!;
    expect(sameRef(t.refOf('Popup'), popup.ref)).toBe(true);
    const reply = ann.find((a) => a.subtype === 'Text' && sameRef(a.refOf('IRT'), t.ref) && !a.get('StateModel'))!;
    expect(reply.text('Contents')).toBe('Looks right to me.');
    expect(reply.name('RT')).toBe('R');
    const state = ann.find((a) => a.subtype === 'Text' && sameRef(a.refOf('IRT'), t.ref) && a.get('StateModel'))!;
    expect(state.text('StateModel')).toBe('Review');
    expect(state.text('State')).toBe('Accepted');
    // pdf.js reads the same.
    const js = await pdfjsAnnotations(bytes);
    const jn = js.find((a) => a.subtype === 'Text' && !a.inReplyTo);
    expect(jn.contentsObj.str).toBe(edited);
    expect(jn.titleObj.str).toBe(note.author);
    // pdf.js draws our appearance stream (its own icon is only used without one), kept upright.
    expect(jn.hasAppearance).toBe(true);
    expect(jn.noRotate).toBe(true);

    // Download → reopen: the note with its reply and status comes back as an editable comment.
    await reopen(page, bytes, 'notes-roundtrip.pdf');
    const [back] = await ofKind(page, 'note');
    expect(back.contents).toBe(edited);
    expect(back.author).toBe(note.author);
    expect(back.status).toBe('accepted');
    expect(back.replies).toEqual([{ author: note.author, text: 'Looks right to me.' }]);
    for (const k of ['x', 'y', 'width', 'height'] as const) expectNear(back.rect[k], note.rect[k], 0.01);
    expect(back.data.icon).toBe('Comment');
    // A second export is identical where it matters (exact round trip).
    const again = (await annotations(await download(page))).filter((a) => a.subtype === 'Text');
    expect(again.map((a) => [a.text('Contents'), a.text('T'), a.text('State') ?? '']).sort()).toEqual(
      ann.filter((a) => a.subtype === 'Text').map((a) => [a.text('Contents'), a.text('T'), a.text('State') ?? '']).sort(),
    );
    expect(again.find((a) => !a.get('IRT'))!.nums('Rect')).toEqual(t.nums('Rect'));

    // Delete from the card's "…" menu; undo restores it.
    await showPanel(page);
    await pickMenu(page, cards(page).first().getByTestId('comments-card-more'), 'comments-delete');
    await expect.poll(() => countKind(page, 'note')).toBe(0);
    await page.getByTestId('undo').click();
    await expect.poll(() => countKind(page, 'note')).toBe(1);
  });

  test('text markups: selection pop-up and markup tools, /QuadPoints export, pdf.js and round trip', async ({ page }) => {
    await openFixture(page, 'sample.pdf');
    await openCommentTask(page);
    // Select tool: the text selection pop-up offers Highlight / Underline / Strikethrough / Add comment.
    const title = await textItem(page, 0, 'Technical Overview and Product Report');
    await selectText(page, 0, title);
    await expect(page.getByTestId('text-selection-popup')).toBeVisible();
    for (const id of ['comments-tsa-highlight', 'comments-tsa-underline', 'comments-tsa-strikeout', 'comments-tsa-comment']) {
      await expect(page.locator(`[data-action-id=${id}]`)).toBeVisible();
    }
    await page.locator('[data-action-id=comments-tsa-highlight]').click();
    await expect.poll(() => countKind(page, 'text-markup')).toBe(1);
    const [hl] = await ofKind(page, 'text-markup');
    expect(hl.data.type).toBe('highlight');
    expect(hl.data.text).toBe('Technical Overview and Product Report');
    expect(hl.data.quads).toHaveLength(8);
    const qb = quadBounds(hl.data.quads);
    expectNear(qb.x0, title.rect.x, 3);
    expectNear(qb.x1, title.rect.x + title.rect.width, 3);
    expect(qb.y0).toBeLessThanOrEqual(title.rect.y + 1);
    expect(qb.y1).toBeGreaterThanOrEqual(title.rect.y + title.rect.height - 1);

    // "Add comment" highlights and opens the pop-up for typing.
    const prepared = await textItem(page, 0, 'Prepared by the Document Platform Team');
    await selectText(page, 0, prepared);
    await page.locator('[data-action-id=comments-tsa-comment]').click();
    await postInPopup(page, 'Which team exactly?');
    await expect.poll(() => countKind(page, 'text-markup')).toBe(2);

    // Markup tools: select text while the tool is active.
    const date = await textItem(page, 0, 'January 2026 | Version 1.0');
    await chooseTool(page, 'comment-underline');
    await expect(page.getByTestId('comments-task-options').getByTestId('comments-options-underline')).toBeVisible();
    await selectText(page, 0, date, 0, 0.45);
    await expect.poll(() => countKind(page, 'text-markup')).toBe(3);
    await chooseTool(page, 'comment-strikeout');
    await selectText(page, 0, date, 0.55, 1);
    await expect.poll(() => countKind(page, 'text-markup')).toBe(4);
    const abstract = await textItem(page, 0, 'Abstract');
    await chooseTool(page, 'comment-squiggly');
    await selectText(page, 0, abstract);
    await expect.poll(() => countKind(page, 'text-markup')).toBe(5);
    // The markup tools stay active for the next selection (like desktop PDF editors).
    expect(await activeTool(page)).toBe('comment-squiggly');
    await page.keyboard.press('Escape');

    const marks = await ofKind(page, 'text-markup');
    expect(marks.map((m) => m.data.type)).toEqual(['highlight', 'highlight', 'underline', 'strikeout', 'squiggly']);
    expect(marks[1].contents).toBe('Which team exactly?');
    expect(marks[2].data.text).toMatch(/^January/);
    expect(marks[3].data.text).toMatch(/1\.0$/);
    expect(marks[4].data.text).toBe('Abstract');
    await pageEl(page, 0).getByTestId('comments-markup').first().waitFor();
    await expect(pageEl(page, 0).getByTestId('comments-markup')).toHaveCount(5);

    // Panel cards show the marked-up text.
    await expect(cards(page)).toHaveCount(5);
    await expect(page.getByTestId('comments-card-quote').first()).toContainText('Technical Overview and Product Report');

    // Change a markup's type from the properties bar.
    await cards(page).nth(4).click();
    await expect.poll(() => page.evaluate(() => window.__app.getActiveDoc().selection)).toEqual([marks[4].id]);
    await pickMenu(page, page.getByTestId('comments-bar-markup-type'), 'comments-markup-type-underline');
    await expect.poll(async () => (await ofKind(page, 'text-markup'))[4].data.type).toBe('underline');
    await page.getByTestId('undo').click();
    await expect.poll(async () => (await ofKind(page, 'text-markup'))[4].data.type).toBe('squiggly');

    const bytes = await download(page);
    const ann = (await annotations(bytes)).filter((a) => ['Highlight', 'Underline', 'StrikeOut', 'Squiggly'].includes(a.subtype));
    expect(ann.map((a) => a.subtype)).toEqual(['Highlight', 'Highlight', 'Underline', 'StrikeOut', 'Squiggly']);
    for (const [i, a] of ann.entries()) {
      expect(a.nums('QuadPoints')).toHaveLength(8);
      a.nums('QuadPoints')!.forEach((v, k) => expectNear(v, marks[i].data.quads[k], 0.01));
      expect(a.text('NM')).toBe(marks[i].id);
      expect(a.nums('C')).toHaveLength(3);
      expect(a.ap.length).toBeGreaterThan(10);
    }
    expect(ann[0].blendModes).toContain('Multiply');
    expect(ann[1].text('Contents')).toBe('Which team exactly?');
    expect(ann[1].get('Popup')).toBeTruthy();
    const js = (await pdfjsAnnotations(bytes)).filter((a) => ['Highlight', 'Underline', 'StrikeOut', 'Squiggly'].includes(a.subtype));
    expect(js).toHaveLength(5);
    expect(js[0].quadPoints.length).toBe(8);

    // Flattened: the highlights are drawn into the page, no annotations left.
    const flat = await flattenedBytes(page);
    expect((await annotations(flat)).filter((a) => a.subtype !== 'Link')).toHaveLength(0);
    expect((await inspectPdf(flat)).pages[0].text).toContain('Technical Overview and Product Report');

    await reopen(page, bytes, 'markups-roundtrip.pdf');
    const back = await ofKind(page, 'text-markup');
    expect(back.map((m) => [m.data.type, m.data.text, m.contents ?? ''])).toEqual(marks.map((m) => [m.data.type, m.data.text, m.contents ?? '']));
  });

  test('text boxes and callouts: typed in place, FreeText /DA /DS /RC /IT /CL export and re-import', async ({ page }) => {
    await openFixture(page, 'sample.pdf');
    await pressShortcut(page, 'x', 'comment-textbox');
    await expect(page.getByTestId('tool-options').getByTestId('comments-options-textbox')).toBeVisible();
    const at = { x: 330, y: 300 };
    await clickPdf(page, 0, at);
    await expect(page.getByTestId('comments-textbox-input')).toBeFocused();
    const text = 'Draft – do not distribute. Größe €5';
    await page.keyboard.type(text);
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await ofKind(page, 'freetext'))[0]?.data.text).toBe(text);
    const [box] = await ofKind(page, 'freetext');
    // The click is the box's top-left corner.
    expectNear(box.rect.x, at.x, 3);
    expectNear(box.rect.y + box.rect.height, at.y, 3);
    expect(box.data.intent).toBe('FreeText');
    await expect(pageEl(page, 0).getByTestId('comments-textbox')).toContainText('Draft');

    // An empty text box is discarded when editing ends.
    await pressShortcut(page, 'x', 'comment-textbox');
    await clickPdf(page, 0, { x: 330, y: 200 });
    await expect(page.getByTestId('comments-textbox-input')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect.poll(() => countKind(page, 'freetext')).toBe(1);

    // Callout: press at the point commented on, release where the text goes.
    await openCommentTask(page);
    await chooseTool(page, 'comment-callout');
    const [a, b] = await clientPoints(page, 0, [{ x: 150, y: 420 }, { x: 260, y: 520 }]);
    await drag(page, a, b);
    await expect(page.getByTestId('comments-textbox-input')).toBeFocused();
    await page.keyboard.type('Callout text');
    await page.keyboard.press('Escape');
    await expect.poll(() => countKind(page, 'freetext')).toBe(2);
    const callout = (await ofKind(page, 'freetext'))[1];
    expect(callout.data.intent).toBe('FreeTextCallout');
    expect(callout.data.text).toBe('Callout text');
    expectNear(callout.data.callout.points[0].x, 150, 2);
    expectNear(callout.data.callout.points[0].y, 420, 2);
    await expect(pageEl(page, 0).getByTestId('comments-callout')).toHaveCount(1);

    // Double-click edits in place; undo reverts the edit.
    await pressShortcut(page, 'v', 'select');
    const boxEl = pageEl(page, 0).getByTestId('comments-textbox');
    await boxEl.dblclick();
    await expect(page.getByTestId('comments-textbox-input')).toBeFocused();
    await page.keyboard.press('ControlOrMeta+End');
    await page.keyboard.type(' (v2)');
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await ofKind(page, 'freetext'))[0].data.text).toBe(`${text} (v2)`);
    await blur(page);
    await page.getByTestId('undo').click();
    await expect.poll(async () => (await ofKind(page, 'freetext'))[0].data.text).toBe(text);

    const boxes = await ofKind(page, 'freetext');
    const bytes = await download(page);
    const ann = (await annotations(bytes)).filter((x) => x.subtype === 'FreeText');
    expect(ann).toHaveLength(2);
    const [f1, f2] = ann;
    expect(f1.text('Contents')).toBe(text);
    expect(f1.text('DA')).toMatch(/\/\S+ \d+(\.\d+)? Tf/);
    expect(f1.text('DS')).toMatch(/font:/);
    expect(f1.text('RC')).toContain('Größe €5');
    expect(f1.text('RC')).toMatch(/^<\?xml|<body/);
    expect(f1.name('IT')).toBe('FreeText');
    expect(f1.dict('BS')).toBeTruthy();
    expect(f1.ap).toMatch(/Tj|TJ/);
    expect(f2.name('IT')).toBe('FreeTextCallout');
    const cl = f2.nums('CL')!;
    expect([4, 6]).toContain(cl.length);
    expectNear(cl[0], 150, 2);
    expectNear(cl[1], 420, 2);
    expect(f2.text('Contents')).toBe('Callout text');
    const js = (await pdfjsAnnotations(bytes)).filter((x) => x.subtype === 'FreeText');
    expect(js.map((x) => x.contentsObj.str)).toEqual([text, 'Callout text']);

    await reopen(page, bytes, 'textbox-roundtrip.pdf');
    const back = await ofKind(page, 'freetext');
    expect(back.map((o) => [o.data.text, o.data.intent, o.data.font, o.data.fontSize, o.data.textColor])).toEqual(
      boxes.map((o) => [o.data.text, o.data.intent, o.data.font, o.data.fontSize, o.data.textColor]),
    );
    for (const [i, o] of back.entries()) for (const k of ['x', 'y', 'width', 'height'] as const) expectNear(o.rect[k], boxes[i].rect[k], 0.5);
    expectNear(back[1].data.callout.points[0].x, 150, 2);
    expectNear(back[1].data.callout.points[0].y, 420, 2);
  });

  test('insert / replace text (Caret + grouped StrikeOut) and file attachments (/FS /EF)', async ({ page }) => {
    await openFixture(page, 'sample.pdf');
    await openCommentTask(page);
    const title = await textItem(page, 0, 'Technical Overview and Product Report');

    // Insert text: a click in the text drops a caret; the pop-up takes the text to insert.
    await chooseTool(page, 'comment-insert-text');
    await clickPdf(page, 0, { x: title.rect.x + title.rect.width * 0.5, y: title.rect.y + title.rect.height / 2 });
    await postInPopup(page, 'and Roadmap');
    await expect.poll(() => countKind(page, 'caret')).toBe(1);
    const [ins] = await ofKind(page, 'caret');
    expect(ins.data.strike).toBeUndefined();
    expectInside({ x: ins.data.caret.x + ins.data.caret.width / 2, y: title.rect.y + title.rect.height / 2 }, title.rect, 3);

    // Replace text: select the text to replace, type the replacement.
    const prepared = await textItem(page, 0, 'Prepared by the Document Platform Team');
    await chooseTool(page, 'comment-replace-text');
    await selectText(page, 0, prepared, 0.62, 1);
    await postInPopup(page, 'Docs Team');
    await expect.poll(() => countKind(page, 'caret')).toBe(2);
    const rep = (await ofKind(page, 'caret'))[1];
    expect(rep.data.strike.text).toMatch(/Team$/);
    expect(rep.contents).toBe('Docs Team');
    await expect(pageEl(page, 0).getByTestId('comments-caret')).toHaveCount(2);

    // Attach file: click, pick the file.
    await chooseTool(page, 'comment-attach');
    const c = await clientPoint(page, 0, { x: 500, y: 150 });
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.mouse.click(c.x, c.y)]);
    await chooser.setFiles(FIXTURES_DIR + 'sample.txt');
    await expect.poll(() => countKind(page, 'file-attachment')).toBe(1);
    const fileBytes = fs.readFileSync(FIXTURES_DIR + 'sample.txt');
    const [att] = await ofKind(page, 'file-attachment');
    expect(att.data.fileName).toBe('sample.txt');
    expect(att.data.size).toBe(fileBytes.length);
    expect(att.data.bytes).toBe(fileBytes.length);
    expectInside({ x: 500, y: 150 }, att.rect, 2);
    await expect(pageEl(page, 0).getByTestId('comments-attachment')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(cards(page)).toHaveCount(3);
    await expect(cards(page).nth(2).getByTestId('comments-card-type')).toHaveText('File attachment');

    // Double-click opens a previewable attachment in a new tab (not a download, no pop-up warning).
    await pressShortcut(page, 'v', 'select');
    const [tab] = await Promise.all([page.context().waitForEvent('page'), pageEl(page, 0).getByTestId('comments-attachment').dblclick()]);
    expect(tab.url()).toMatch(/^blob:/);
    await expect(tab.locator('body')).toContainText('PDF Wizard - Sample Text File');
    await tab.close();
    await expect(page.getByTestId('toast')).toHaveCount(0);

    const bytes = await download(page);
    const ann = await annotations(bytes);
    const carets = ann.filter((x) => x.subtype === 'Caret');
    expect(carets).toHaveLength(2);
    expect(carets[0].text('Contents')).toBe('and Roadmap');
    expect(carets[0].name('IT')).toBeUndefined();
    expect(carets[1].name('IT')).toBe('Replace');
    expect(carets[1].text('Contents')).toBe('Docs Team');
    const strike = ann.find((x) => x.subtype === 'StrikeOut')!;
    expect(sameRef(strike.refOf('IRT'), carets[1].ref)).toBe(true);
    expect(strike.name('RT')).toBe('Group');
    expect(strike.name('IT')).toBe('StrikeOutTextEdit');
    expect(strike.nums('QuadPoints')).toHaveLength(8);
    const fa = ann.find((x) => x.subtype === 'FileAttachment')!;
    const fsDict = fa.dict('FS')!;
    expect(fa.name('Type', fsDict)).toBe('Filespec');
    expect(fa.text('F', fsDict)).toBe('sample.txt');
    expect(fa.text('UF', fsDict)).toBe('sample.txt');
    const ef = fa.dict('EF', fsDict)!;
    const embedded = fa.streamBytes(ef.get(PDFName.of('F')));
    expect(Buffer.from(embedded!).equals(fileBytes)).toBe(true);
    expect(fa.name('Name')).toBeTruthy();
    const js = await pdfjsAnnotations(bytes);
    const jfa = js.find((x) => x.subtype === 'FileAttachment');
    expect(jfa.file.filename).toBe('sample.txt');
    expect(Buffer.from(jfa.content).equals(fileBytes)).toBe(true);
    expect(js.filter((x) => x.subtype === 'Caret')).toHaveLength(2);

    await reopen(page, bytes, 'caret-roundtrip.pdf');
    const back = await comments(page);
    expect(back.map((o) => o.kind)).toEqual(['caret', 'caret', 'file-attachment']);
    expect(back[1].data.strike.text).toBe(rep.data.strike.text);
    expect(back[1].contents).toBe('Docs Team');
    expect(back[2].data.fileName).toBe('sample.txt');
    expect(back[2].data.bytes).toBe(fileBytes.length);
    // The grouped StrikeOut is part of the replace comment, not a card of its own.
    await showPanel(page);
    await expect(cards(page)).toHaveCount(3);
  });

  test('annotated.pdf: imported comments; panel search, filter, sort, XFDF export → delete all → import, hide, summary', async ({ page }) => {
    await openFixture(page, 'annotated.pdf');
    await showPanel(page);
    await expect(page.getByTestId('comments-panel')).toBeVisible();
    // Markups, sticky note (with a reply), text box, shapes, pencil and stamp: 12 comments.
    await expect(cards(page)).toHaveCount(12);
    await expect(page.getByTestId('comments-count')).toContainText('12');
    const own = await comments(page);
    expect(own.map((o) => o.kind).sort()).toEqual(['freetext', 'note', 'text-markup', 'text-markup', 'text-markup', 'text-markup', 'text-markup']);
    // Quotes come from the page text under the quads.
    await expect.poll(async () => (await ofKind(page, 'text-markup')).map((m) => m.data.text)).toEqual([
      'launch window', 'customer onboarding', 'three weeks', 'recieve', expect.stringContaining('engineering time, including automated checks that every'),
    ]);
    const quotes = await page.getByTestId('comments-card-quote').allTextContents();
    expect(quotes.join('|')).toContain('three weeks');
    const note = (await ofKind(page, 'note'))[0];
    expect(note.replies).toEqual([{ author: 'Jordan Lee', text: expect.stringContaining('Thanks') }]);
    const box = (await ofKind(page, 'freetext'))[0];
    expect(box.data.text).toContain('Draft - not for distribution.');
    expect(box.data.textColor).toBe('#d92d20');
    await expect(page.locator('[data-testid=comments-group]')).toHaveCount(2);

    // Search.
    await page.getByTestId('comments-search').fill('regression');
    await expect(cards(page)).toHaveCount(1);
    await page.getByTestId('comments-search').fill('zzz no match');
    await expect(page.getByTestId('comments-list')).toContainText('No comments match');
    await page.getByTestId('comments-clear-filters').click();
    await expect(cards(page)).toHaveCount(12);

    // Filter by author.
    await page.getByTestId('comments-filter').click();
    await page.getByTestId('comments-filter-author-sam-rivera').click();
    await page.getByTestId('comments-filter-done').click();
    const authors = await cards(page).getByTestId('comments-card-author').allTextContents();
    expect(authors.length).toBeGreaterThan(0);
    expect(new Set(authors)).toEqual(new Set(['Sam Rivera']));
    await page.getByTestId('comments-filter').click();
    await page.getByTestId('comments-filter-clear').click();
    await page.getByTestId('comments-filter-done').click();
    await expect(cards(page)).toHaveCount(12);

    // Sort by author: groups per author.
    await pickMenu(page, page.getByTestId('comments-sort'), 'comments-sort-author');
    await expect(page.getByTestId('comments-group-a-jordan-lee')).toBeVisible();
    await expect(page.getByTestId('comments-group-a-sam-rivera')).toBeVisible();
    await pickMenu(page, page.getByTestId('comments-sort'), 'comments-sort-page');

    // A card click selects the comment; replying and checking from the card.
    const card = cards(page).nth(1);
    await card.click();
    await expect.poll(async () => (await page.evaluate(() => window.__app.getActiveDoc().selection)).length).toBe(1);
    await card.getByTestId('comments-card-reply').click();
    await page.keyboard.type('Reply from the panel');
    await card.getByTestId('comments-card-replybox-post').click();
    await card.getByTestId('comments-card-check').click();
    const selId = (await page.evaluate(() => window.__app.getActiveDoc().selection))[0];
    const sel = (await page.evaluate((id) => {
      const o = window.__app.getActiveDoc().objects[id];
      return { status: o.status, replies: o.replies.map((r: { text: string }) => r.text) };
    }, selId));
    expect(sel.status).toBe('completed');
    expect(sel.replies).toContain('Reply from the panel');

    // XFDF export.
    const { download: dl } = await captureDownload(page, () => pickMenu(page, page.getByTestId('comments-panel-more'), 'comments-export-xfdf'));
    expect(dl.suggestedFilename()).toBe('annotated.xfdf');
    const xfdfPath = test.info().outputPath('annotated.xfdf');
    await dl.saveAs(xfdfPath);
    const xml = fs.readFileSync(xfdfPath, 'utf8');
    expect(xml).toContain('<xfdf');
    expect(xml).toMatch(/<highlight\b/);
    expect(xml).toMatch(/<freetext\b/);
    expect(xml).toContain('Reply from the panel');

    // Delete all (confirmation) → empty state.
    await pickMenu(page, page.getByTestId('comments-panel-more'), 'comments-delete-all');
    await expect(page.getByRole('alertdialog')).toContainText('12');
    await page.getByTestId('dialog-confirm').click();
    await expect(page.getByTestId('comments-list')).toContainText('No comments yet');
    expect(await comments(page)).toHaveLength(0);

    // XFDF import brings everything back, replies and status included.
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), pickMenu(page, page.getByTestId('comments-panel-more'), 'comments-import-xfdf')]);
    await chooser.setFiles(xfdfPath);
    await expect(cards(page)).toHaveCount(12);
    const re = await comments(page);
    expect(re.map((o) => o.kind).sort()).toEqual(own.map((o) => o.kind).sort());
    expect(re.find((o) => o.kind === 'note')!.replies.map((r) => r.author)).toEqual(['Jordan Lee']);
    const restored = await page.evaluate(() => {
      const d = window.__app.getActiveDoc();
      return Object.values(d.objects).filter((o: any) => (o.replies ?? []).some((r: any) => r.text === 'Reply from the panel')).map((o: any) => o.status); // eslint-disable-line @typescript-eslint/no-explicit-any
    });
    expect(restored).toEqual(['completed']);

    // Hide all comments / show them again.
    await pickMenu(page, page.getByTestId('comments-panel-more'), 'comments-toggle-hidden');
    await expect(page.getByTestId('comments-hidden-banner')).toBeVisible();
    await expect(pageEl(page, 0).getByTestId('comments-note')).toBeHidden();
    await page.getByTestId('comments-show-hidden').click();
    await expect(pageEl(page, 0).getByTestId('comments-note')).toBeVisible();

    // Comment summary: a new document with the pages and the list of comments.
    const before = await page.evaluate(() => window.__app.getActiveDoc().id);
    await pickMenu(page, page.getByTestId('comments-panel-more'), 'comments-summarize');
    await page.waitForFunction((id) => { const d = window.__app.getActiveDoc(); return d && d.id !== id && /summary/.test(d.name); }, before, { timeout: 30_000 });
    await waitForPagesRendered(page);
    const summary = await page.evaluate(async () => Array.from(await window.__engine.exportPdf(window.__app.getActiveDoc().id, { purpose: 'download' })) as number[]);
    const info = await inspectPdf(new Uint8Array(summary));
    expect(info.numPages).toBeGreaterThanOrEqual(2);
    expect(info.pages[0].text).toContain('Summary of comments on annotated.pdf');
    expect(info.pages[0].text).toContain('Confirm the launch window with marketing.');
    expect(info.pages.map((p) => p.text).join(' ')).toContain('Reply from the panel');
  });

  test('rotated pages, zoom and dark theme: comments land under the pointer and export correctly', async ({ page }) => {
    await openFixture(page, 'rotated.pdf');
    await page.evaluate(() => window.__app.actions.setZoom(window.__app.getActiveDoc().id, 0.75));
    const placed: { pi: number; note: Pt; box: Pt }[] = [];
    for (const pi of [1, 2, 3]) {
      // A sticky note where the user clicks.
      await pressShortcut(page, 's', 'comment-note');
      const note = { x: 180, y: 260 };
      await clickPdf(page, pi, note);
      await postInPopup(page, `Note on page ${pi + 1}`);
      // A text box: the click is its visual top-left corner, the text reads upright on screen.
      await pressShortcut(page, 'x', 'comment-textbox');
      const box = { x: 300, y: 420 };
      await clickPdf(page, pi, box);
      await expect(page.getByTestId('comments-textbox-input')).toBeFocused();
      await page.keyboard.type(`Box ${pi + 1}`);
      await page.keyboard.press('Escape');
      await expect.poll(async () => (await ofKind(page, 'freetext')).filter((o) => o.pageIndex === pi).length).toBe(1);
      placed.push({ pi, note, box });
    }
    const objs = await comments(page);
    for (const { pi, note, box } of placed) {
      const rot = [0, 90, 180, 270][pi];
      const n = objs.find((o) => o.kind === 'note' && o.pageIndex === pi)!;
      expectInside(note, n.rect);
      const t = objs.find((o) => o.kind === 'freetext' && o.pageIndex === pi)!;
      expect(t.data.rotate ?? 0).toBe(rot);
      expectInside(box, t.rect, 3);
      // Visual top-left corner of the box, in user space, for each page rotation.
      const r = t.rect;
      const corner = rot === 90 ? { x: r.x, y: r.y } : rot === 180 ? { x: r.x + r.width, y: r.y } : { x: r.x + r.width, y: r.y + r.height };
      expectNear(corner.x, box.x, 3);
      expectNear(corner.y, box.y, 3);
      // On screen the text box's text runs left to right.
      const el = pageEl(page, pi).locator(`.pdfwizard-obj[data-obj-id="${t.id}"]`);
      await el.scrollIntoViewIfNeeded();
      const bb = (await el.boundingBox())!;
      expect(bb.width).toBeGreaterThan(bb.height);
    }

    // Area highlight at 200 %: drag over a non-text area of the 90° page.
    await page.evaluate(() => window.__app.actions.setZoom(window.__app.getActiveDoc().id, 2));
    await pressShortcut(page, 'u', 'comment-highlight');
    const [h0, h1] = await clientPoints(page, 1, [{ x: 300, y: 600 }, { x: 360, y: 700 }]);
    await drag(page, h0, h1);
    await expect.poll(() => countKind(page, 'text-markup')).toBe(1);
    const [area] = await ofKind(page, 'text-markup');
    expect(area.pageIndex).toBe(1);
    const ab = quadBounds(area.data.quads);
    expectNear(ab.x0, 300, 2);
    expectNear(ab.x1, 360, 2);
    expectNear(ab.y0, 600, 2);
    expectNear(ab.y1, 700, 2);
    await page.keyboard.press('Escape');

    // Dark theme: the pop-up and the panel use the theme colors.
    await page.evaluate(() => window.__app.actions.setPrefs({ theme: 'dark' }));
    await page.evaluate(() => window.__app.actions.setZoom(window.__app.getActiveDoc().id, 1));
    await showPanel(page);
    await cards(page).first().click();
    await expect(page.getByTestId('comments-popup')).toBeVisible();
    const lum = (css: string) => {
      const [r, g, b] = css.match(/\d+(\.\d+)?/g)!.map(Number);
      return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    };
    const popupBg = await page.getByTestId('comments-popup').evaluate((e) => getComputedStyle(e).backgroundColor);
    expect(lum(popupBg)).toBeLessThan(0.35);
    const cardColor = await cards(page).first().evaluate((e) => getComputedStyle(e).color);
    expect(lum(cardColor)).toBeGreaterThan(0.6);

    // Export: the text box keeps the page's rotation, notes stay upright (NoRotate).
    const bytes = await download(page);
    const ann = await annotations(bytes);
    for (const { pi } of placed) {
      const f = ann.find((a) => a.subtype === 'FreeText' && a.page === pi)!;
      expect(f.text('Contents')).toBe(`Box ${pi + 1}`);
      expect(f.num('Rotate') ?? 0).toBe([0, 90, 180, 270][pi]);
      const t = ann.find((a) => a.subtype === 'Text' && a.page === pi && !a.get('IRT'))!;
      expect(t.num('F')! & 16).toBe(16);
    }
    await reopen(page, bytes, 'rotated-roundtrip.pdf');
    const back = await comments(page);
    for (const o of objs) {
      const b = back.find((x) => x.kind === o.kind && x.pageIndex === o.pageIndex && (x.data.text ?? x.contents) === (o.data.text ?? o.contents))!;
      expect(b, `${o.kind} on page ${o.pageIndex + 1}`).toBeTruthy();
      for (const k of ['x', 'y', 'width', 'height'] as const) expectNear(b.rect[k], o.rect[k], 0.5);
      if (o.kind === 'freetext') expect(b.data.rotate ?? 0).toBe(o.data.rotate ?? 0);
    }
  });

  test('read-only documents: comments can be read but not added or changed', async ({ page }) => {
    await openFixture(page, 'annotated.pdf');
    // Read-only happens when a protected file can't be decrypted for editing: simulate it.
    const ro = await page.evaluate(async () => {
      const url = performance.getEntriesByType('resource').map((e) => e.name).find((n) => /\/core\/engine\/state\.ts/.test(n));
      if (!url) return false;
      const m = await import(/* @vite-ignore */ url);
      const id = window.__app.getActiveDoc().id;
      m.setReadOnly(id, { reason: 'test', password: '', bytes: new Uint8Array() });
      window.__app.actions.updateDoc(id, (d: any) => ({ ext: { ...d.ext, engine: { readOnly: true, reason: 'test' } } })); // eslint-disable-line @typescript-eslint/no-explicit-any
      return window.__engine.isReadOnly(id);
    });
    expect(ro).toBe(true);
    await openCommentTask(page);
    await expect(page.getByTestId('comments-task-readonly')).toBeVisible();
    await expect(cards(page)).toHaveCount(12);

    const before = (await comments(page)).length;
    await page.evaluate(() => window.__app.actions.setTool('comment-note'));
    await clickPdf(page, 0, { x: 150, y: 150 });
    await page.waitForTimeout(300);
    expect(await comments(page)).toHaveLength(before);

    const card = cards(page).first();
    await expect(card.getByTestId('comments-card-check')).toBeDisabled();
    await expect(card.getByTestId('comments-card-reply')).toHaveCount(0);
    await page.evaluate(() => window.__app.actions.setTool('select'));
    await card.click();
    await expect(page.getByTestId('comments-popup')).toBeVisible();
    await expect(page.getByTestId('comments-popup-replybox')).toHaveCount(0);
    await expect(page.getByTestId('comments-popup-editor-input')).toHaveCount(0);
    await page.getByTestId('comments-popup-close').click();
    // Replies are shown but can't be added, edited or deleted (pop-up and card).
    const noteCard = cards(page).filter({ has: page.locator('[data-testid=comments-card-type]', { hasText: /^Sticky note$/ }) });
    await expect(noteCard).toHaveCount(1);
    await noteCard.click();
    await expect(page.getByTestId('comments-popup-reply-0-text')).toContainText('Thanks');
    await expect(page.getByTestId('comments-popup-reply-0-more')).toHaveCount(0);
    await expect(page.getByTestId('comments-popup-reply')).toHaveCount(0);
    await expect(noteCard.getByTestId('comments-card-reply-0-text')).toContainText('Thanks');
    await expect(noteCard.getByTestId('comments-card-reply-0-more')).toHaveCount(0);
    await expect(noteCard.getByTestId('comments-card-reply')).toHaveCount(0);
    await expect(noteCard.getByTestId('comments-card-replybox')).toHaveCount(0);
    await page.getByTestId('comments-popup-close').click();
    // No "add" entries in the page context menu; export still works.
    await clickPdf(page, 0, { x: 300, y: 100 }, { button: 'right' });
    await expect(page.locator('[data-menu-id="comments-ctx-toggle-hidden"]')).toBeVisible();
    await expect(page.locator('[data-menu-id="comments-ctx-add-note"]')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await page.getByTestId('comments-panel-more').click();
    await expect(page.locator('[data-menu-id="comments-delete-all"]')).toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator('[data-menu-id="comments-import-xfdf"]')).toHaveAttribute('aria-disabled', 'true');
    await expect(page.locator('[data-menu-id="comments-export-xfdf"]')).not.toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('Escape');
  });

  test('undo steps, cancelled notes, reply box, dates, non-Latin text boxes and a broken XFDF file', async ({ page }) => {
    await openFixture(page, 'sample.pdf');
    const hist = () =>
      page.evaluate(() => {
        const d = window.__app.getActiveDoc();
        return { dirty: !!d.dirty, past: d.history.past.length, future: d.history.future.length };
      });
    const noteTimes = () =>
      page.evaluate(() => {
        const o = Object.values(window.__app.getActiveDoc().objects).find((x: any) => x.kind === 'note') as any; // eslint-disable-line @typescript-eslint/no-explicit-any
        return { createdAt: o.createdAt, modifiedAt: o.modifiedAt };
      });

    // A new note that is cancelled leaves the document as it was: not modified, nothing to undo.
    for (const how of ['button', 'Escape']) {
      await pressShortcut(page, 's', 'comment-note');
      await clickPdf(page, 0, { x: 200, y: 600 });
      await expect(page.getByTestId('comments-popup-editor-input')).toBeFocused();
      await page.keyboard.type('never mind');
      if (how === 'button') await page.getByTestId('comments-popup-editor-cancel').click();
      else await page.keyboard.press('Escape');
      await expect(page.getByTestId('comments-popup')).toHaveCount(0);
      await expect.poll(() => countKind(page, 'note')).toBe(0);
      expect(await hist(), how).toEqual({ dirty: false, past: 0, future: 0 });
    }
    // An empty text box too.
    await pressShortcut(page, 'x', 'comment-textbox');
    await clickPdf(page, 0, { x: 300, y: 300 });
    await expect(page.getByTestId('comments-textbox-input')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect.poll(() => countKind(page, 'freetext')).toBe(0);
    expect(await hist()).toEqual({ dirty: false, past: 0, future: 0 });

    // Placing a note and posting its text is a single undo step.
    await pressShortcut(page, 's', 'comment-note');
    await clickPdf(page, 0, { x: 420, y: 660 });
    await postInPopup(page, 'One step');
    expect(await hist()).toEqual({ dirty: true, past: 1, future: 0 });
    await page.getByTestId('undo').click();
    await expect.poll(() => countKind(page, 'note')).toBe(0);
    await page.getByTestId('redo').click();
    await expect.poll(async () => (await ofKind(page, 'note'))[0]?.contents).toBe('One step');
    const t0 = await noteTimes();

    // Posting a reply closes the reply box, so ⌘Z / Ctrl+Z right after undoes the reply.
    await pageEl(page, 0).getByTestId('comments-note').click();
    await page.getByTestId('comments-popup-reply').click();
    await expect(page.getByTestId('comments-popup-replybox-input')).toBeFocused();
    await page.keyboard.type('A reply');
    await page.getByTestId('comments-popup-replybox-post').click();
    await expect(page.getByTestId('comments-popup-reply-0-text')).toHaveText('A reply');
    await expect(page.getByTestId('comments-popup-replybox')).toHaveCount(0);
    await expect(page.getByTestId('comments-popup-reply')).toBeVisible();
    await page.keyboard.press('ControlOrMeta+z');
    await expect(page.getByTestId('comments-popup-reply-0-text')).toHaveCount(0);
    expect((await ofKind(page, 'note'))[0].replies).toEqual([]);
    await page.keyboard.press('ControlOrMeta+Shift+z');
    await expect(page.getByTestId('comments-popup-reply-0-text')).toHaveText('A reply');
    // Replies and review status don't change the comment's own date.
    await pickSubmenu(page, page.getByTestId('comments-popup-more'), 'comments-set-status', 'comments-status-rejected');
    await expect(page.getByTestId('comments-popup-status')).toContainText('Rejected');
    expect(await noteTimes()).toEqual(t0);
    await page.getByTestId('comments-popup-close').click();

    // A text box in several scripts: exported with an appearance that shows all of it (the bundled
    // font has no CJK glyphs, so that line is an image with invisible text on top) and stays
    // extractable; it keeps growing with its text after a round trip.
    const intl = 'Zoë — 日本語 Ελληνικά';
    await pressShortcut(page, 'x', 'comment-textbox');
    await clickPdf(page, 0, { x: 100, y: 250 });
    await expect(page.getByTestId('comments-textbox-input')).toBeFocused();
    await page.keyboard.type(intl);
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await ofKind(page, 'freetext'))[0]?.data.text).toBe(intl);
    const [tb] = await ofKind(page, 'freetext');
    expect(tb.data.autoWidth).toBe(true);
    // Creating and typing the text box was one step too.
    await page.getByTestId('undo').click();
    await expect.poll(() => countKind(page, 'freetext')).toBe(0);
    await page.getByTestId('redo').click();
    await expect.poll(async () => (await ofKind(page, 'freetext'))[0]?.data.text).toBe(intl);

    const bytes = await download(page);
    const ft = (await annotations(bytes)).find((a) => a.subtype === 'FreeText')!;
    expect(ft.text('Contents')).toBe(intl);
    expect(ft.text('RC')).toContain('日本語');
    expect(ft.ap).toMatch(/\/Im\d+ Do/);
    expect(ft.ap).toMatch(/\b3 Tr\b/);
    const flat = await flattenedBytes(page);
    const flatText = (await inspectPdf(flat)).pages[0].text;
    for (const s of ['Zoë', '日本語', 'Ελληνικά']) expect(flatText).toContain(s);
    await reopen(page, bytes, 'intl-roundtrip.pdf');
    const [back] = await ofKind(page, 'freetext');
    expect(back.data.text).toBe(intl);
    expect(back.data.autoWidth).toBe(true);
    for (const k of ['x', 'y', 'width', 'height'] as const) expectNear(back.rect[k], tb.rect[k], 0.5);

    // A file that isn't XFDF: an error message, nothing imported.
    await showPanel(page);
    const count = (await comments(page)).length;
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), pickMenu(page, page.getByTestId('comments-panel-more'), 'comments-import-xfdf')]);
    await chooser.setFiles({ name: 'broken.xfdf', mimeType: 'application/vnd.adobe.xfdf', buffer: Buffer.from('this is not <xfdf') });
    await expect(page.locator('[data-testid=toast][data-kind=error]')).toBeVisible();
    expect(await comments(page)).toHaveLength(count);
  });

  test('large documents: comments across hundreds of pages, grouped by page, card click navigates', async ({ page }) => {
    await openFixture(page, 'large.pdf');
    const n = await page.evaluate(() => window.__app.getActiveDoc().pages.length);
    expect(n).toBeGreaterThan(100);
    const targets = [0, Math.floor(n / 2), n - 1];
    for (const pi of targets) {
      await page.evaluate((i) => window.__app.actions.goToPage(window.__app.getActiveDoc().id, i), pi);
      await pressShortcut(page, 's', 'comment-note');
      await clickPdf(page, pi, { x: 300, y: 400 });
      await postInPopup(page, `Note on page ${pi + 1}`);
    }
    await showPanel(page);
    await expect(cards(page)).toHaveCount(3);
    await expect(page.getByTestId('comments-group')).toHaveCount(3);
    await page.evaluate((i) => window.__app.actions.goToPage(window.__app.getActiveDoc().id, i), n - 1);
    await cards(page).first().click();
    await expect.poll(() => page.evaluate(() => window.__app.getActiveDoc().view.currentPage)).toBe(0);
    const t0 = Date.now();
    const ann = (await annotations(await download(page))).filter((a) => a.subtype === 'Text');
    expect(Date.now() - t0).toBeLessThan(20_000);
    expect(ann.map((a) => a.page)).toEqual(targets);
  });
});
