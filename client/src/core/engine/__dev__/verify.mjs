// Engine verification: node client/src/core/engine/__dev__/verify.mjs [section...]
// Needs `scripts/dev-instance.sh engine 5211 4211` and `node client/src/core/engine/__dev__/make-fixtures.mjs`.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../../../..');
const FIX = path.join(ROOT, 'fixtures');
const EXTRA = '/tmp/engine-fixtures';
const SHOTS = '/tmp/engine-shots';
const BASE = 'http://localhost:5211/client/src/core/engine/__dev__/harness.html';
fs.mkdirSync(SHOTS, { recursive: true });

const only = process.argv.slice(2);
const results = [];
const assert = (c, msg) => {
  if (!c) throw new Error(msg);
};

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1500, height: 1000 }, acceptDownloads: true });
const page = await context.newPage();
const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push(`pageerror: ${e.message}`));
await page.goto(BASE);
await page.waitForFunction(() => !!window.__harness);

// In-page helpers.
await page.evaluate(() => {
  const H = window.__harness;
  const { engine, getDoc, pdfLib } = H;
  window.__t = {
    async bytesOf(url) {
      return new Uint8Array(await (await fetch(url)).arrayBuffer());
    },
    summary(id) {
      const d = getDoc(id);
      if (!d) return null;
      return {
        name: d.name, version: d.version, pdfVersion: d.pdfVersion, dirty: d.dirty, fileId: d.fileId,
        pages: d.pages.map((p) => ({ id: p.id, rotation: p.rotation, view: p.view.map((v) => Math.round(v * 100) / 100), label: p.label })),
        objects: Object.keys(d.objects).length, order: d.order.slice(), meta: d.meta, security: d.security,
        past: d.history.past.map((s) => s.label), future: d.history.future.map((s) => s.label), loadError: d.loadError,
        readOnly: engine.isReadOnly(id),
      };
    },
    async synced(id) {
      await engine.awaitPdf(id);
      return window.__t.summary(id);
    },
    lib(bytes, password) {
      return pdfLib.PDFDocument.load(bytes, { updateMetadata: false, ignoreEncryption: !password, ...(password ? { password } : {}) });
    },
    pdf(bytes, password) {
      return engine.loadPdfjs(bytes.slice(), password ? { password } : {});
    },
    async texts(pdf) {
      const out = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const tc = await (await pdf.getPage(i)).getTextContent();
        out.push(tc.items.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim());
      }
      return out;
    },
    /** RGBA at PDF user-space point (x, y) on page i (1-based) rendered at `scale`. */
    async pixel(pdf, i, x, y, scale = 1, mode = 1) {
      const p = await pdf.getPage(i);
      const vp = p.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      await p.render({ canvas, viewport: vp, annotationMode: mode, background: '#ffffff' }).promise;
      const [vx, vy] = vp.convertToViewportPoint(x, y);
      const d = canvas.getContext('2d').getImageData(Math.floor(vx), Math.floor(vy), 1, 1).data;
      return [d[0], d[1], d[2], d[3]];
    },
    async annots(pdf, i) {
      const a = await (await pdf.getPage(i)).getAnnotations();
      return a.map((x) => ({
        subtype: x.subtype, id: x.id, contents: x.contentsObj?.str, title: x.titleObj?.str, color: x.color ? Array.from(x.color) : null,
        rect: x.rect.map((v) => Math.round(v * 10) / 10), inReplyTo: x.inReplyTo, popupRef: x.popupRef, hasAppearance: x.hasAppearance,
        fieldName: x.fieldName, fieldValue: x.fieldValue, opacity: x.opacity, name: x.name, url: x.url, dest: x.dest, state: x.state, stateModel: x.stateModel,
      }));
    },
  };
});

async function test(name, fn) {
  const section = name.split(':')[0];
  if (only.length && !only.includes(section)) return;
  const t0 = Date.now();
  try {
    const info = await fn();
    results.push({ name, ok: true });
    console.log(`PASS ${name} (${Date.now() - t0} ms)${info !== undefined ? ` ${JSON.stringify(info).slice(0, 400)}` : ''}`);
  } catch (e) {
    results.push({ name, ok: false, error: String(e?.message ?? e) });
    console.log(`FAIL ${name}: ${e?.stack ?? e}`);
  }
}

const b64 = (file) => fs.readFileSync(file).toString('base64');
async function open(file, name = path.basename(file)) {
  const id = await page.evaluate(
    async ({ data, name }) => {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      return window.__harness.engine.openBytes(name, bytes);
    },
    { data: b64(file), name },
  );
  assert(id, `open ${name} returned ${id}`);
  await page.evaluate((id) => window.__t.synced(id), id);
  return id;
}
const ev = (fn, arg) => page.evaluate(fn, arg);
const summary = (id) => ev((id) => window.__t.synced(id), id);
async function shot(name) {
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: false });
}
async function closeAll() {
  await ev(() => {
    const { useApp, actions } = window.__harness;
    for (const id of [...useApp.getState().tabs]) actions.closeDocument(id);
  });
}

// ─────────────────────────────────────────────────────────────────────────────

await test('open: sample.pdf metadata, pages, outline, text', async () => {
  const id = await open(`${FIX}/sample.pdf`);
  const s = await summary(id);
  assert(s.pages.length === 6, `pages ${s.pages.length}`);
  assert(s.meta.title === 'PDF Wizard: Document Workflows in the Browser', `title ${s.meta.title}`);
  assert(s.meta.author === 'Document Platform Team', 'author');
  const outline = await ev((id) => window.__harness.getDoc(id).outline, id);
  const titles = outline.map((o) => o.title);
  assert(titles.join('|') === 'Title Page|Contents|1 Introduction|2 Document Workflows|3 Performance|4 Conclusion', titles.join('|'));
  assert(outline[1].bold && outline[4].children[0].children[0].italic && outline[5].color && outline[5].color !== '#000000', 'styles');
  assert(outline[2].open && !outline[4].open, 'open state');
  const pageIdx = outline.map((o) => s.pages.findIndex((p) => p.id === o.pageId));
  assert(pageIdx.join() === '0,1,2,3,4,5', `outline pages ${pageIdx}`);
  const t = await ev(async (id) => {
    const { engine } = window.__harness;
    const all = [];
    for (let i = 0; i < 6; i++) all.push((await engine.getPageText(id, i)).text);
    return all;
  }, id);
  const counts = t.map((x) => (x.match(/Wizard/g) ?? []).length);
  assert(counts.join() === '2,1,2,2,1,1', `Wizard counts ${counts}`);
  await shot('open-sample');
  return { pages: s.pages.length, counts };
});

await test('text: text-rect overlay and rangeRects', async () => {
  const id = await ev(() => window.__harness.useApp.getState().activeDocId);
  await ev(() => window.__harness.setShowText(true));
  await page.waitForSelector('[data-testid=text-rect]');
  await page.waitForTimeout(800);
  const n = await page.locator('[data-page-index="0"] [data-testid=text-rect]').count();
  assert(n > 5, `rects ${n}`);
  // "Wizard" occurrences → rects lie within the word's item
  const r = await ev(async (id) => {
    const { engine } = window.__harness;
    const t = await engine.getPageText(id, 0);
    const i = t.text.indexOf('Wizard');
    const rects = engine.rangeRects(t, i, i + 7);
    const item = t.items.find((it) => i >= it.start && i < it.start + it.str.length);
    const cloned = engine.rangeRects(structuredClone(t), i, i + 7);
    const multi = engine.rangeRects(t, 0, t.text.length).length;
    return { rects, itemRect: item.rect, cloned, multi, lines: t.text.split('\n').length, sample: t.text.slice(0, 200) };
  }, id);
  assert(r.rects.length === 1, 'one rect');
  const a = r.rects[0];
  const b = r.itemRect;
  assert(a.x >= b.x - 0.01 && a.x + a.width <= b.x + b.width + 0.01 && a.width < b.width + 0.01 && a.width > 5, 'within item');
  assert(Math.abs(r.cloned[0].x - a.x) < 3 && Math.abs(r.cloned[0].width - a.width) < 3, 'clone fallback');
  await page.locator('[data-page-index="0"]').screenshot({ path: `${SHOTS}/text-rects-p1.png` });
  await ev(() => window.__harness.setShowText(false));
  return { rects: n, first: a, multi: r.multi, lines: r.lines, sample: r.sample };
});

await test('text: rotated page text rects', async () => {
  await closeAll();
  const id = await open(`${FIX}/rotated.pdf`);
  await ev(() => window.__harness.setShowText(true));
  await page.waitForSelector('[data-page-index="1"] [data-testid=text-rect]');
  await page.waitForTimeout(800);
  await shot('rotated-text-rects');
  const s = await summary(id);
  const rot = s.pages.map((p) => p.rotation).join();
  assert(rot === '0,90,180,270,0,0,90', `rotations ${rot}`);
  assert(s.pages[4].view.join() === '100,100,712,892', `view5 ${s.pages[4].view}`);
  assert(s.pages[5].view.join() === '72,108,540,684', `view6 ${s.pages[5].view}`);
  await ev(() => window.__harness.setShowText(false));
  return { rot };
});

await test('pageops: crop with visual margins on rotated / offset pages', async () => {
  const id = await ev(() => window.__harness.useApp.getState().activeDocId);
  const m = { top: 10, right: 20, bottom: 30, left: 40 };
  await ev(({ id, m }) => window.__harness.engine.cropPages(id, [0, 1, 2, 3, 4, 5, 6], m), { id, m });
  const s = await summary(id);
  const views = s.pages.map((p) => p.view.join(','));
  const expected = [
    '40,30,592,782', // 0°: x0+=left, y0+=bottom, x1-=right, y1-=top
    '10,40,582,772', // 90°
    '20,10,572,762', // 180°: y0+=top x0+=right y1-=bottom x1-=left → [20,10,572,762]
    '30,20,602,752', // 270°: x1-=top y0+=right x0+=bottom y1-=left → [30,20,602,752]
    '140,130,692,882',
    '112,138,520,674',
    '110,140,682,872',
  ];
  assert(views.join('|') === expected.join('|'), `views ${views.join('|')}`);
  // Visual check through pdf.js: the displayed size shrank by left+right / top+bottom on every page.
  const sizes = await ev(async (id) => {
    const pdf = await window.__harness.engine.awaitPdf(id);
    const out = [];
    for (let i = 1; i <= pdf.numPages; i++) {
      const vp = (await pdf.getPage(i)).getViewport({ scale: 1 });
      out.push([Math.round(vp.width), Math.round(vp.height)]);
    }
    return out;
  }, id);
  const expSizes = [[552, 752], [732, 572], [552, 752], [732, 572], [552, 752], [408, 536], [732, 572]];
  assert(JSON.stringify(sizes) === JSON.stringify(expSizes), `sizes ${JSON.stringify(sizes)}`);
  await shot('rotated-cropped');
  // Absolute rect, clamped to the MediaBox
  await ev((id) => window.__harness.engine.cropPages(id, [0], { x: -50, y: 100, width: 300, height: 5000 }), id);
  const s2 = await summary(id);
  assert(s2.pages[0].view.join() === '0,100,250,792', `abs ${s2.pages[0].view}`);
  const err = await ev((id) => window.__harness.engine.cropPages(id, [0], { x: 5000, y: 5000, width: 10, height: 10 }).then(() => 'ok', (e) => e.message), id);
  assert(/too small/.test(err), err);
  await ev((id) => { window.__harness.actions.undo(id); window.__harness.actions.undo(id); }, id);
  const s3 = await summary(id);
  assert(s3.pages[4].view.join() === '100,100,712,892' && s3.pages[1].view.join() === '0,0,612,792', 'undo crop');
  return { views };
});

await test('pageops: non-zero origin + rotation, blank page sizes', async () => {
  const id = await ev(() => window.__harness.useApp.getState().activeDocId);
  await ev((id) => window.__harness.engine.insertBlankPages(id, 2, 1), id); // after page 2 (90°, displayed 792x612)
  const s = await summary(id);
  assert(s.pages.length === 8, 'count');
  const p = s.pages[2];
  assert(p.rotation === 0 && p.view.join() === '0,0,792,612', `blank ${p.view} ${p.rotation}`);
  await ev((id) => window.__harness.actions.undo(id), id);
  const s2 = await summary(id);
  assert(s2.pages.length === 7, 'undo blank');
  return { blank: p.view };
});

await closeAll();

await test('pageops: every op + undo/redo on sample.pdf', async () => {
  const id = await open(`${FIX}/sample.pdf`);
  const s0 = await summary(id);
  const ids0 = s0.pages.map((p) => p.id);
  const log = [];
  const step = async (label, fn, check) => {
    await ev(fn, { id, src: b64(`${EXTRA}/source.pdf`), png: b64(`${FIX}/sample.png`) });
    const s = await summary(id);
    check(s);
    log.push(`${label}:${s.pages.length}`);
    return s;
  };
  // rotate
  await step('rotate', ({ id }) => window.__harness.engine.rotatePages(id, [0, 2], 90), (s) => {
    assert(s.pages[0].rotation === 90 && s.pages[2].rotation === 90 && s.pages[1].rotation === 0, 'rotate');
    assert(s.pages.map((p) => p.id).join() === ids0.join(), 'ids stable after rotate');
  });
  await step('rotate-180', ({ id }) => window.__harness.engine.rotatePages(id, [0], 180), (s) => assert(s.pages[0].rotation === 270, 'rotate 270'));
  // delete page 2 ("Contents", has 10 links to later pages)
  await step('delete', ({ id }) => window.__harness.engine.deletePages(id, [1]), (s) => {
    assert(s.pages.length === 5 && s.pages[1].id === ids0[2], 'delete ids');
  });
  // links on page 6 still OK; outline dest for deleted page → nulled in the bytes
  const outl = await ev(async (id) => {
    const pdf = await window.__harness.engine.awaitPdf(id);
    const o = await pdf.getOutline();
    return o.map((x) => ({ t: x.title, d: !!x.dest }));
  }, id);
  assert(outl.find((x) => x.t === 'Contents') && outl.length === 6, 'outline kept');
  // move: reverse
  await step('move', ({ id }) => window.__harness.engine.movePages(id, [4, 3, 2, 1, 0]), (s) => {
    assert(s.pages[0].id === ids0[5] && s.pages[4].id === ids0[0], 'reverse');
  });
  await step('moveTo', ({ id }) => window.__harness.engine.movePagesTo(id, [0], 5), (s) => {
    assert(s.pages[4].id === ids0[5] && s.pages[0].id === ids0[4], `moveTo ${s.pages.map((p) => ids0.indexOf(p.id))}`);
  });
  const orderNow = (await summary(id)).pages.map((p) => ids0.indexOf(p.id));
  // insert blank
  await step('blank', ({ id }) => window.__harness.engine.insertBlankPages(id, 1, 2), (s) => {
    assert(s.pages.length === 7 && ids0.indexOf(s.pages[1].id) === -1 && ids0.indexOf(s.pages[2].id) === -1, 'blank ids');
    assert(s.pages[1].view.join() === '0,0,612,792', 'blank size');
  });
  // insert PDF bytes (2 pages) at 0
  await step('insertPdf', async ({ id, src }) => {
    const bytes = Uint8Array.from(atob(src), (c) => c.charCodeAt(0));
    await window.__harness.engine.insertPdfBytes(id, 0, bytes);
  }, (s) => assert(s.pages.length === 9 && s.pages[0].view.join() === '0,0,420,595', 'insert pdf'));
  // insert files (png → page) at end
  await step('insertFiles', async ({ id, png }) => {
    const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
    const s = window.__harness.getDoc(id);
    await window.__harness.engine.insertFiles(id, s.pages.length, [new File([bytes], 'sample.png', { type: 'image/png' })]);
  }, (s) => assert(s.pages.length === 10, 'insert files'));
  // duplicate first two (contiguous run) + page 5
  const before = (await summary(id)).pages.map((p) => p.id);
  await step('duplicate', ({ id }) => window.__harness.engine.duplicatePages(id, [0, 1, 5]), (s) => {
    assert(s.pages.length === 13, 'dup count');
    assert(s.pages[0].id === before[0] && s.pages[1].id === before[1] && !before.includes(s.pages[2].id) && !before.includes(s.pages[3].id), 'dup run placement');
    assert(s.pages[4].id === before[2], 'dup keeps others');
    assert(!before.includes(s.pages[8].id) && s.pages[7].id === before[5], 'dup single');
  });
  // replace page 3 (index 4 = first original sample page after the inserts) with source page 2
  await step('replace', async ({ id, src }) => {
    const bytes = Uint8Array.from(atob(src), (c) => c.charCodeAt(0));
    await window.__harness.engine.replacePages(id, [4], bytes, [1]);
  }, (s) => assert(s.pages[4].id === before[2] && s.pages[4].view.join() === '0,0,420,595', 'replace keeps id'));
  const txt = await ev(async (id) => (await window.__harness.engine.getPageText(id, 4)).text, id);
  assert(/Source page 2/.test(txt), `replaced text ${txt}`);
  const texts = await ev(async (id) => {
    const pdf = await window.__harness.engine.awaitPdf(id);
    return window.__t.texts(pdf);
  }, id);
  // crop
  await step('crop', ({ id }) => window.__harness.engine.cropPages(id, [0], { top: 50, right: 0, bottom: 0, left: 0 }), (s) => {
    assert(s.pages[0].view.join() === '0,0,420,545', `crop ${s.pages[0].view}`);
  });
  // extract
  const ex = await ev(async (id) => {
    const bytes = await window.__harness.engine.extractPagesToBytes(id, [4, 0]);
    const pdf = await window.__t.pdf(bytes);
    const t = await window.__t.texts(pdf);
    const info = await pdf.getMetadata();
    return { n: pdf.numPages, t, title: info.info.Title, producer: info.info.Producer };
  }, id);
  assert(ex.n === 2 && /Source page 1/.test(ex.t[0]) && /Source page 2/.test(ex.t[1]), `extract ${JSON.stringify(ex)}`);
  await shot('pageops-after');
  // errors
  const errs = await ev(async (id) => {
    const e = window.__harness.engine;
    const n = window.__harness.getDoc(id).pages.length;
    const catchMsg = (p) => p.then(() => 'ok', (x) => x.message);
    return {
      all: await catchMsg(e.deletePages(id, [...Array(n).keys()])),
      bad: await catchMsg(e.rotatePages(id, [99], 90)),
      order: await catchMsg(e.movePages(id, [0, 0, 1])),
      none: await catchMsg(e.duplicatePages(id, [])),
      notpdf: await catchMsg(e.insertPdfBytes(id, 0, new TextEncoder().encode('hello'))),
      replaceShort: await catchMsg(e.replacePages(id, [0, 1, 2], window.__harness.getDoc(id).bytes.slice(0, 10))),
    };
  }, id);
  assert(/can't delete all pages/.test(errs.all) && /doesn't exist/.test(errs.bad) && /invalid/.test(errs.order) && /No pages/.test(errs.none), JSON.stringify(errs));
  assert(/not a PDF/.test(errs.notpdf), errs.notpdf);
  // undo everything
  const sEnd = await summary(id);
  const steps = sEnd.past.length;
  for (let i = 0; i < steps; i++) await ev((id) => window.__harness.actions.undo(id), id);
  const sU = await summary(id);
  assert(sU.pages.map((p) => p.id).join() === ids0.join() && sU.pages.every((p) => p.rotation === 0), 'undo all');
  const utexts = await ev(async (id) => window.__t.texts(await window.__harness.engine.awaitPdf(id)), id);
  assert(utexts.length === 6 && /Contents/.test(utexts[1]), 'undo text');
  for (let i = 0; i < steps; i++) await ev((id) => window.__harness.actions.redo(id), id);
  const sR = await summary(id);
  assert(sR.pages.map((p) => p.id).join() === sEnd.pages.map((p) => p.id).join(), 'redo all');
  const rtexts = await ev(async (id) => window.__t.texts(await window.__harness.engine.awaitPdf(id)), id);
  assert(rtexts.slice(1).join('|') === texts.slice(1).join('|'), 'redo text');
  await shot('pageops-redo');
  return { log, steps, orderNow, errs, pastLabels: sEnd.past };
});

await closeAll();

await test('pageops: inherited attributes, shared contents, labels', async () => {
  const id = await open(`${EXTRA}/inherited.pdf`);
  const s = await summary(id);
  assert(s.pages.length === 4 && s.pages.every((p) => p.rotation === 90 && p.view.join() === '0,0,500,600'), 'inherited read');
  assert(s.pages.map((p) => p.label).join() === 'i,ii,A-1,A-2', `labels ${s.pages.map((p) => p.label)}`);
  await ev((id) => window.__harness.engine.deletePages(id, [0]), id);
  let s2 = await summary(id);
  assert(s2.pages.every((p) => p.rotation === 90 && p.view.join() === '0,0,500,600'), 'inherited after delete');
  assert(s2.pages.map((p) => p.label).join() === 'i,A-1,A-2', `labels after delete ${s2.pages.map((p) => p.label)}`);
  await ev((id) => window.__harness.engine.movePages(id, [2, 0, 1]), id);
  s2 = await summary(id);
  assert(s2.pages.map((p) => p.label).join() === 'A-1,i,A-2', `labels after move ${s2.pages.map((p) => p.label)}`);
  await ev((id) => window.__harness.engine.duplicatePages(id, [0]), id);
  s2 = await summary(id);
  assert(s2.pages.length === 4, 'dup');
  // export with an object on a page sharing the Contents array: other pages must not get it
  await ev((id) => {
    const H = window.__harness;
    const d = H.getDoc(id);
    H.actions.addObject(id, { id: H.uid('obj'), kind: 'test-rect', pageId: d.pages[1].id, rect: { x: 100, y: 100, width: 100, height: 100 }, author: 'T', createdAt: Date.now(), modifiedAt: Date.now(), color: '#00aa00', strokeWidth: 3, data: {} });
  }, id);
  const r = await ev(async (id) => {
    const bytes = await window.__harness.engine.exportPdf(id, { purpose: 'download', flatten: true });
    const pdf = await window.__t.pdf(bytes);
    const px = [];
    for (let i = 1; i <= pdf.numPages; i++) px.push(await window.__t.pixel(pdf, i, 101.5, 150));
    const t = await window.__t.texts(pdf);
    return { px, t };
  }, id);
  const green = r.px.map((p) => p[1] > 120 && p[0] < 100);
  assert(green.join() === 'false,true,false,false', `only page 2 has the rect: ${JSON.stringify(r.px)}`);
  assert(['Inherited 4', 'Inherited 4', 'Inherited 2', 'Inherited 3'].every((x, i) => r.t[i].includes(x)), JSON.stringify(r.t));
  await shot('inherited');
  return { labels: s2.pages.map((p) => p.label), px: r.px };
});

await closeAll();

await test('export: test-rect Square annotation (AP, popup, replies, status, opacity)', async () => {
  const id = await open(`${FIX}/sample.pdf`);
  const oid = await ev((id) => {
    const H = window.__harness;
    const d = H.getDoc(id);
    const oid = H.uid('obj');
    H.actions.addObject(id, {
      id: oid, kind: 'test-rect', pageId: d.pages[0].id, rect: { x: 100, y: 450, width: 200, height: 100 }, author: 'Tester',
      createdAt: Date.now(), modifiedAt: Date.now(), color: '#ff0000', strokeWidth: 6, opacity: 0.5, contents: 'Rect note ✓',
      replies: [{ id: 'r1', author: 'Rev', text: 'Reply one', createdAt: Date.now() }], status: 'accepted', data: {},
    });
    H.actions.addObject(id, { id: H.uid('obj'), kind: 'test-text', pageId: d.pages[1].id, rect: { x: 72, y: 60, width: 200, height: 20 }, author: 'Tester', createdAt: Date.now(), modifiedAt: Date.now(), data: { text: 'Stamped text', size: 16 } });
    return oid;
  }, id);
  const r = await ev(async ({ id, oid }) => {
    const bytes = await window.__harness.engine.exportPdf(id, { purpose: 'download' });
    window.__lastExport = bytes;
    const pdf = await window.__t.pdf(bytes);
    const a = await window.__t.annots(pdf, 1);
    const stroke = await window.__t.pixel(pdf, 1, 103, 470);
    const inside = await window.__t.pixel(pdf, 1, 200, 470);
    const t2 = (await window.__t.texts(pdf))[1];
    const lib = await window.__t.lib(bytes);
    const leaf = lib.getPage(0).node;
    const annots = leaf.lookup(window.__harness.pdfLib.PDFName.of('Annots'));
    const sq = annots.asArray().map((r) => lib.context.lookup(r)).find((d) => String(d.get(window.__harness.pdfLib.PDFName.of('Subtype'))) === '/Square');
    const nm = sq.get(window.__harness.pdfLib.PDFName.of('NM')).decodeText();
    return { a, stroke, inside, t2, nm, oid, size: bytes.length };
  }, { id, oid });
  const sq = r.a.find((x) => x.subtype === 'Square');
  assert(sq && sq.contents === 'Rect note ✓' && sq.title === 'Tester' && sq.hasAppearance, `square ${JSON.stringify(sq)}`);
  assert(sq.color.join() === '255,0,0', 'color');
  assert(r.nm === oid, 'NM = object id');
  const popup = r.a.find((x) => x.subtype === 'Popup');
  assert(popup, 'popup');
  const reply = r.a.find((x) => x.subtype === 'Text' && x.contents === 'Reply one');
  assert(reply && reply.inReplyTo === sq.id, `reply ${JSON.stringify(reply)}`);
  const status = r.a.find((x) => x.subtype === 'Text' && x.state === 'Accepted');
  assert(status && status.stateModel === 'Review', `status ${JSON.stringify(r.a.filter((x) => x.subtype === 'Text'))}`);
  assert(r.stroke[0] > 240 && r.stroke[1] > 100 && r.stroke[1] < 160, `stroke half-transparent red ${r.stroke}`);
  assert(r.inside.join() === '255,255,255,255', `inside ${r.inside}`);
  assert(/Stamped text/.test(r.t2), 'page-content text');
  // Flatten
  const f = await ev(async (id) => {
    const bytes = await window.__harness.engine.exportPdf(id, { purpose: 'download', flatten: true });
    const pdf = await window.__t.pdf(bytes);
    return { a: await window.__t.annots(pdf, 1), stroke: await window.__t.pixel(pdf, 1, 103, 470), a2: await window.__t.annots(pdf, 2) };
  }, id);
  assert(!f.a.some((x) => x.subtype === 'Square' || x.subtype === 'Popup' || x.subtype === 'Text'), `flattened annots ${JSON.stringify(f.a)}`);
  assert(f.stroke[0] > 240 && f.stroke[1] > 100 && f.stroke[1] < 160, `flattened stroke ${f.stroke}`);
  assert(f.a2.filter((x) => x.subtype === 'Link').length === 10, 'links kept when flattening');
  // Load the exported bytes back into the engine view
  await ev(async () => {
    await window.__harness.engine.openBytes('exported.pdf', window.__lastExport);
  });
  await page.waitForTimeout(800);
  await shot('export-square');
  await ev(() => { const H = window.__harness; H.actions.closeDocument(H.useApp.getState().activeDocId); });
  return { square: sq, stroke: r.stroke, flattened: f.stroke };
});

await test('export: bakeObjects + undo', async () => {
  const id = await ev(() => window.__harness.useApp.getState().activeDocId);
  const s0 = await summary(id);
  const oid = s0.order[0];
  await ev(({ id, oid }) => window.__harness.engine.bakeObjects(id, [oid], 'Flatten rectangle'), { id, oid });
  const s1 = await summary(id);
  assert(s1.objects === s0.objects - 1 && s1.past[s1.past.length - 1] === 'Flatten rectangle', 'baked');
  const px = await ev(async (id) => window.__t.pixel(await window.__harness.engine.awaitPdf(id), 1, 103, 470), id);
  assert(px[0] > 240 && px[1] < 160, `baked pixel ${px}`);
  const a = await ev(async (id) => window.__t.annots(await window.__harness.engine.awaitPdf(id), 1), id);
  assert(!a.some((x) => x.subtype === 'Square'), 'bake = flattened');
  await ev((id) => window.__harness.actions.undo(id), id);
  const s2 = await summary(id);
  assert(s2.objects === s0.objects, 'undo bake');
  return { px };
});

await closeAll();

await test('export: flatten existing annotations (annotated.pdf)', async () => {
  const id = await open(`${FIX}/annotated.pdf`);
  const r = await ev(async (id) => {
    const pdf0 = await window.__harness.engine.awaitPdf(id);
    const before = [(await window.__t.annots(pdf0, 1)).length, (await window.__t.annots(pdf0, 2)).length];
    const bytes = await window.__harness.engine.exportPdf(id, { purpose: 'download', flatten: true });
    const pdf = await window.__t.pdf(bytes);
    const after = [(await window.__t.annots(pdf, 1)).length, (await window.__t.annots(pdf, 2)).length];
    // highlight at [71, 609, 143.3, 622.7] (yellow #ffe14d, multiply) and square border [362,510,532,600] red 2pt
    const hl = await window.__t.pixel(pdf, 1, 75, 612, 1, 0);
    const sq = await window.__t.pixel(pdf, 2, 363, 555, 2, 0);
    const lib = await window.__t.lib(bytes);
    const acro = lib.catalog.get(window.__harness.pdfLib.PDFName.of('AcroForm'));
    window.__flat = bytes;
    return { before, after, hl, sq, acro: !!acro };
  }, id);
  assert(r.after.join() === '0,0', `after ${r.after}`);
  assert(r.hl[2] < 150 && r.hl[0] > 200, `highlight pixel ${r.hl}`);
  assert(r.sq[0] > 180 && r.sq[1] < 100, `square pixel ${r.sq}`);
  await ev(async () => window.__harness.engine.openBytes('flattened.pdf', window.__flat));
  await page.waitForTimeout(800);
  await shot('flatten-annotated');
  return r;
});

await closeAll();

await test('forms: commit values + page ops keep fields (form.pdf)', async () => {
  const id = await open(`${FIX}/form.pdf`);
  const v0 = (await summary(id)).version;
  await ev(async (id) => {
    const pdf = await window.__harness.engine.awaitPdf(id);
    const fields = await pdf.getFieldObjects();
    const set = (name, value) => fields.get(name).filter((f) => f.id).forEach((f) => pdf.annotationStorage.setValue(f.id, { value }));
    set('full_name', 'Ada Lovelace');
    set('newsletter', true);
    set('country', 'Canada');
    const radio = fields.get('contact_method').find((f) => f.exportValues === 'phone');
    pdf.annotationStorage.setValue(radio.id, { value: true });
  }, id);
  await ev((id) => window.__harness.engine.commitFormValues(id), id);
  const s1 = await summary(id);
  assert(s1.version > v0, 'committed as new version');
  const f = await ev(async (id) => {
    const lib = await window.__t.lib(window.__harness.getDoc(id).bytes);
    const form = lib.getForm();
    return {
      name: form.getTextField('full_name').getText(), news: form.getCheckBox('newsletter').isChecked(), country: form.getDropdown('country').getSelected(),
      contact: form.getRadioGroup('contact_method').getSelected(), fields: form.getFields().length,
    };
  }, id);
  assert(f.name === 'Ada Lovelace' && f.news && f.country[0] === 'Canada' && f.contact === 'phone', JSON.stringify(f));
  // Uncommitted value + page op: committed first
  await ev(async (id) => {
    const pdf = await window.__harness.engine.awaitPdf(id);
    const fields = await pdf.getFieldObjects();
    fields.get('email').filter((x) => x.id).forEach((x) => pdf.annotationStorage.setValue(x.id, { value: 'ada@example.com' }));
  }, id);
  await ev((id) => window.__harness.engine.duplicatePages(id, [0]), id);
  const d = await ev(async (id) => {
    const lib = await window.__t.lib(window.__harness.getDoc(id).bytes);
    const form = lib.getForm();
    const w = form.getTextField('full_name').acroField.getWidgets().length;
    const pdf = await window.__harness.engine.awaitPdf(id);
    const a2 = await window.__t.annots(pdf, 2);
    return { email: form.getTextField('email').getText(), widgets: w, fields: form.getFields().length, p2: a2.filter((x) => x.subtype === 'Widget').length, v2: a2.find((x) => x.fieldName === 'full_name')?.fieldValue };
  }, id);
  assert(d.email === 'ada@example.com' && d.widgets === 2 && d.fields === f.fields && d.v2 === 'Ada Lovelace', JSON.stringify(d));
  await ev((id) => window.__harness.engine.deletePages(id, [0]), id);
  const d2 = await ev(async (id) => {
    const lib = await window.__t.lib(window.__harness.getDoc(id).bytes);
    const form = lib.getForm();
    return { widgets: form.getTextField('full_name').acroField.getWidgets().length, fields: form.getFields().length };
  }, id);
  assert(d2.widgets === 1 && d2.fields === f.fields, JSON.stringify(d2));
  // Download flow → exported bytes contain the value
  const dl = page.waitForEvent('download');
  await ev((id) => window.__harness.engine.downloadDoc(id), id);
  const file = await dl;
  const p = `${SHOTS}/${file.suggestedFilename()}`;
  await file.saveAs(p);
  const sd = await summary(id);
  assert(!sd.dirty, 'download marks saved');
  await page.waitForTimeout(600);
  await shot('form-duplicated');
  return { f, d, d2, download: file.suggestedFilename(), size: fs.statSync(p).size };
});

await test('forms: merged field duplicate/delete', async () => {
  const id = await open(`${EXTRA}/merged-form.pdf`);
  await ev((id) => window.__harness.engine.duplicatePages(id, [0]), id);
  const r = await ev(async (id) => {
    const lib = await window.__t.lib(window.__harness.getDoc(id).bytes);
    const form = lib.getForm();
    const tf = form.getTextField('merged_text');
    const pdf = await window.__harness.engine.awaitPdf(id);
    return { widgets: tf.acroField.getWidgets().length, text: tf.getText(), fields: form.getFields().map((f) => f.getName()), p2: (await window.__t.annots(pdf, 2)).map((a) => a.fieldName) };
  }, id);
  assert(r.widgets === 2 && r.text === 'hello' && r.fields.join() === 'merged_text' && r.p2[0] === 'merged_text', JSON.stringify(r));
  await ev((id) => window.__harness.engine.deletePages(id, [1]), id);
  const r2 = await ev(async (id) => {
    const lib = await window.__t.lib(window.__harness.getDoc(id).bytes);
    return lib.getForm().getTextField('merged_text').acroField.getWidgets().length;
  }, id);
  assert(r2 === 1, `widgets after delete ${r2}`);
  return r;
});

await closeAll();

await test('security: encrypted.pdf password loop, decrypt, unchanged export = original', async () => {
  const pending = ev(async (data) => {
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
    return window.__harness.engine.openBytes('encrypted.pdf', bytes);
  }, b64(`${FIX}/encrypted.pdf`));
  await page.waitForSelector('[data-testid=password-input]');
  await shot('password-prompt');
  await page.fill('[data-testid=password-input]', 'wrong');
  await page.click('[data-testid=password-ok]');
  await page.waitForSelector('text=Incorrect password');
  await shot('password-retry');
  await page.fill('[data-testid=password-input]', 'secret');
  await page.click('[data-testid=password-ok]');
  const id = await pending;
  const s = await summary(id);
  assert(s.pages.length === 2 && !s.readOnly, `pages/readOnly ${s.pages.length} ${s.readOnly}`);
  assert(s.meta.title === 'Confidential Budget Summary', `title ${s.meta.title}`);
  assert(s.security && s.security.userPassword === 'secret', `security ${JSON.stringify(s.security)}`);
  const r = await ev(async (id) => {
    const H = window.__harness;
    const bytes = await H.engine.exportPdf(id, { purpose: 'download' });
    let noPw = 'opened';
    try {
      await window.__t.pdf(bytes);
    } catch (e) {
      noPw = e.name;
    }
    const pdf = await window.__t.pdf(bytes, 'secret');
    return { size: bytes.length, noPw, pages: pdf.numPages };
  }, id);
  assert(r.noPw === 'PasswordException' && r.pages === 2 && r.size === fs.statSync(`${FIX}/encrypted.pdf`).size, JSON.stringify(r));
  // Change → re-encrypted AES-256 with the same password
  await ev((id) => window.__harness.engine.rotatePages(id, [1], 90), id);
  const r2 = await ev(async (id) => {
    const bytes = await window.__harness.engine.exportPdf(id, { purpose: 'save' });
    let noPw = 'opened';
    try {
      await window.__t.pdf(bytes);
    } catch (e) {
      noPw = e.name;
    }
    const pdf = await window.__t.pdf(bytes, 'secret');
    const p2 = await pdf.getPage(2);
    const meta = await pdf.getMetadata();
    const raw = new TextDecoder('latin1').decode(bytes);
    const t = await window.__t.texts(pdf);
    return { noPw, rotate: p2.rotate, title: meta.info.Title, V: /\/V\s+5\b/.test(raw) && /\/AESV3/.test(raw) ? 5 : 0, t };
  }, id);
  assert(r2.noPw === 'PasswordException' && r2.rotate === 90 && r2.title === 'Confidential Budget Summary' && r2.V === 5, JSON.stringify(r2));
  // Remove security → plain file
  await ev((id) => window.__harness.actions.setSecurity(id, null), id);
  const r3 = await ev(async (id) => {
    const bytes = await window.__harness.engine.exportPdf(id, { purpose: 'save' });
    const pdf = await window.__t.pdf(bytes);
    return { pages: pdf.numPages, title: (await pdf.getMetadata()).info.Title };
  }, id);
  assert(r3.pages === 2 && r3.title === 'Confidential Budget Summary', JSON.stringify(r3));
  return { r, r2, r3 };
});

await test('security: set password + restrictions round-trip, reopen', async () => {
  const id = await open(`${FIX}/sample.pdf`);
  await ev((id) => window.__harness.actions.setSecurity(id, { userPassword: 'pw1', ownerPassword: 'own1', permissions: { printing: 'lowResolution', copying: false, modifying: false } }), id);
  const r = await ev(async (id) => {
    const bytes = await window.__harness.engine.exportPdf(id, { purpose: 'save' });
    window.__secured = bytes;
    let noPw = 'opened';
    try {
      await window.__t.pdf(bytes);
    } catch (e) {
      noPw = e.name;
    }
    const pdf = await window.__t.pdf(bytes, 'pw1');
    const perms = await pdf.getPermissions();
    const o = await pdf.getOutline();
    return { noPw, perms: perms ? [...perms] : null, outline: o.length, n: pdf.numPages };
  }, id);
  assert(r.noPw === 'PasswordException' && r.n === 6 && r.outline === 6, JSON.stringify(r));
  const F = { PRINT: 4, MODIFY_CONTENTS: 8, COPY: 16, PRINT_HIGH_QUALITY: 2048 };
  assert(r.perms.includes(F.PRINT) && !r.perms.includes(F.PRINT_HIGH_QUALITY) && !r.perms.includes(F.COPY) && !r.perms.includes(F.MODIFY_CONTENTS), `perms ${r.perms}`);
  const pending = ev(() => window.__harness.engine.openBytes('secured.pdf', window.__secured));
  await page.waitForSelector('[data-testid=password-input]');
  await page.fill('[data-testid=password-input]', 'pw1');
  await page.click('[data-testid=password-ok]');
  const id2 = await pending;
  const s2 = await summary(id2);
  assert(s2.pages.length === 6 && s2.security?.userPassword === 'pw1' && s2.security?.permissions?.copying === false, JSON.stringify(s2.security));
  const toasts = await ev(() => window.__harness.toasts.map((t) => `${t.kind}: ${t.message}`));
  return { perms: r.perms, security: s2.security, readOnly: s2.readOnly, toasts: toasts.slice(-3) };
});

await test('security: PDF/A is stripped when encrypting (warning toast)', async () => {
  const id = await open(`${EXTRA}/pdfa.pdf`);
  await ev((id) => window.__harness.actions.setSecurity(id, { userPassword: 'a' }), id);
  const r = await ev(async (id) => {
    const bytes = await window.__harness.engine.exportPdf(id, { purpose: 'save' });
    const pdf = await window.__t.pdf(bytes, 'a');
    const m = await pdf.getMetadata();
    return { xmp: m.metadata ? [...m.metadata.getAll ? Object.keys(m.metadata.getAll()) : []] : null, raw: m.metadata?.getRaw?.() ?? '', title: m.info.Title };
  }, id);
  const toasts = await ev(() => window.__harness.toasts.map((t) => `${t.kind}: ${t.message}`));
  assert(!/pdfaid:(part|conformance)/.test(r.raw) && /Archive/.test(r.raw) && toasts.some((t) => /PDF\/A/.test(t) && t.startsWith('warning')), JSON.stringify({ r, toasts }));
  return { title: r.title, toast: toasts.find((t) => /PDF\/A/.test(t)) };
});

await closeAll();

await test('security: AES-128 / RC4 / owner-only restrictions open, edit and re-save', async () => {
  const out = {};
  for (const f of ['aes128.pdf', 'rc4.pdf', 'restricted.pdf']) {
    const needsPw = f !== 'restricted.pdf';
    const pending = ev(async (data) => {
      const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      return window.__harness.engine.openBytes(data.length ? 'x' : 'x', bytes);
    }, b64(`${EXTRA}/${f}`));
    pending.catch(() => {});
    if (needsPw) {
      await page.waitForSelector('[data-testid=password-input]');
      await page.fill('[data-testid=password-input]', 'pw');
      await page.click('[data-testid=password-ok]');
    }
    const id = await pending;
    const s = await summary(id);
    await ev((id) => window.__harness.engine.rotatePages(id, [0], 90), id);
    const r = await ev(async ({ id, pw }) => {
      const bytes = await window.__harness.engine.exportPdf(id, { purpose: 'save' });
      const pdf = await window.__t.pdf(bytes, pw);
      const perms = await pdf.getPermissions();
      return { n: pdf.numPages, rot: (await pdf.getPage(1)).rotate, title: (await pdf.getMetadata()).info.Title, perms: perms ? [...perms] : null, text: (await window.__t.texts(pdf))[1] };
    }, { id, pw: needsPw ? 'pw' : undefined });
    out[f] = { readOnly: s.readOnly, security: s.security, title: s.meta.title, ...r };
    assert(!s.readOnly && s.pages.length === 2 && r.n === 2 && r.rot === 90 && r.title === `Cipher ${f}` && r.text.includes(`${f} page 2`), JSON.stringify(out[f]));
    if (f === 'restricted.pdf') assert(s.security?.permissions?.printing === false && r.perms && !r.perms.includes(4) && !r.perms.includes(16), JSON.stringify(out[f]));
  }
  return out;
});

await test('outline+meta: edit and round-trip', async () => {
  const id = await open(`${FIX}/sample.pdf`);
  await ev((id) => {
    const H = window.__harness;
    const d = H.getDoc(id);
    const o = structuredClone(d.outline);
    o[0].title = 'Cover ✓ Überblick';
    o[0].children = [{ id: 'n1', title: 'External', url: 'https://example.com/ä', children: [], open: false }, { id: 'n2', title: 'Deep', pageId: d.pages[3].id, top: 400, italic: true, bold: true, color: '#1473e6', children: [], open: false }];
    o[0].open = true;
    o.splice(1, 1);
    H.actions.setOutline(id, o);
    H.actions.setMeta(id, { title: 'New Title ✓', author: 'Ann Author', keywords: 'a, b; c', subject: 'Subj' });
  }, id);
  const r = await ev(async (id) => {
    const bytes = await window.__harness.engine.exportPdf(id, { purpose: 'save' });
    window.__outlined = bytes;
    const pdf = await window.__t.pdf(bytes);
    const o = await pdf.getOutline();
    const m = await pdf.getMetadata();
    const pageOf = async (dest) => (dest ? pdf.getPageIndex(dest[0]) : null);
    const kids = o[0].items;
    return {
      titles: o.map((x) => x.title), kid0: { t: kids[0].title, url: kids[0].url }, kid1: { t: kids[1].title, bold: kids[1].bold, italic: kids[1].italic, color: Array.from(kids[1].color), page: await pageOf(kids[1].dest), top: kids[1].dest[3] },
      count0: o[0].count, info: m.info, xmp: m.metadata?.get('dc:title'), xmpCreator: m.metadata?.get('dc:creator'),
    };
  }, id);
  assert(r.titles.join('|') === 'Cover ✓ Überblick|1 Introduction|2 Document Workflows|3 Performance|4 Conclusion', r.titles.join('|'));
  assert(r.kid0.t === 'External' && /^https:\/\/example.com\/%C3%A4$/.test(r.kid0.url), JSON.stringify(r.kid0));
  assert(r.kid1.bold && r.kid1.italic && r.kid1.page === 3 && r.kid1.top === 400 && r.kid1.color.join() === '20,115,230', JSON.stringify(r.kid1));
  assert(r.count0 === 2, `count ${r.count0}`);
  assert(r.info.Title === 'New Title ✓' && r.info.Author === 'Ann Author' && r.info.Keywords === 'a, b; c' && r.info.Producer, JSON.stringify(r.info));
  // Reopen in the engine → same outline read back
  const id2 = await ev(async () => window.__harness.engine.openBytes('outlined.pdf', window.__outlined));
  const o2 = await ev((id) => window.__harness.getDoc(id).outline.map((x) => [x.title, x.children.length, x.open]), id2);
  assert(o2[0][0] === 'Cover ✓ Überblick' && o2[0][1] === 2 && o2[0][2] === true, JSON.stringify(o2));
  // Remove all bookmarks
  await ev((id) => window.__harness.actions.setOutline(id, []), id2);
  const empty = await ev(async (id) => (await (await window.__t.pdf(await window.__harness.engine.exportPdf(id, { purpose: 'save' }))).getOutline()), id2);
  assert(empty === null || empty.length === 0, 'outline removed');
  return r;
});

await closeAll();

await test('library: saveDoc / saveDocAs / openFromLibrary', async () => {
  const id = await open(`${FIX}/sample.pdf`);
  await ev((id) => window.__harness.engine.rotatePages(id, [0], 90), id);
  await ev((id) => window.__harness.engine.saveDoc(id), id);
  const s = await summary(id);
  assert(s.fileId && !s.dirty, `saved ${JSON.stringify({ f: s.fileId, d: s.dirty })}`);
  await ev((id) => window.__harness.engine.rotatePages(id, [1], 90), id);
  await ev((id) => window.__harness.engine.saveDoc(id), id);
  const files = await ev(async () => (await fetch('/api/files')).json());
  const f = files.find((x) => x.id === s.fileId);
  assert(f && f.version >= 2, JSON.stringify(f));
  await ev((id) => window.__harness.engine.saveDocAs(id, 'Copy of sample'), id);
  const s2 = await summary(id);
  assert(s2.name === 'Copy of sample.pdf' && s2.fileId !== s.fileId && !s2.dirty, JSON.stringify({ n: s2.name, f: s2.fileId }));
  await closeAll();
  const id2 = await ev((fid) => window.__harness.engine.openFromLibrary(fid), s.fileId);
  const s3 = await summary(id2);
  assert(s3.pages[0].rotation === 90 && s3.pages[1].rotation === 90 && s3.fileId === s.fileId && !s3.dirty, JSON.stringify(s3.pages.map((p) => p.rotation)));
  const toasts = await ev(() => window.__harness.toasts.filter((t) => t.kind === 'success').map((t) => t.message));
  return { files: files.length, toasts: toasts.slice(-3) };
});

await test('render: thumbnails cache/dedupe, renderPageToCanvas', async () => {
  const id = await ev(() => window.__harness.useApp.getState().activeDocId);
  const r = await ev(async (id) => {
    const e = window.__harness.engine;
    const t0 = performance.now();
    const [a, b] = await Promise.all([e.getThumbnail(id, 0, 150), e.getThumbnail(id, 0, 150)]);
    const t1 = performance.now();
    const c = await e.getThumbnail(id, 0, 150);
    const t2 = performance.now();
    const all = await Promise.all([...Array(6).keys()].map((i) => e.getThumbnail(id, i, 120)));
    const img = new Image();
    img.src = a;
    await img.decode();
    const canvas = await e.renderPageToCanvas(id, 0, { width: 300 });
    const cp = await e.renderPageToCanvas(id, 0, { scale: 2, forPrint: true });
    await e.rotatePages(id, [0], 90);
    await e.awaitPdf(id);
    const d = await e.getThumbnail(id, 0, 150);
    const img2 = new Image();
    img2.src = d;
    await img2.decode();
    return { same: a === b && b === c, first: t1 - t0, cached: t2 - t1, distinct: new Set(all).size, w: img.naturalWidth, h: img.naturalHeight, cw: canvas.width, ch: canvas.height, pw: cp.width, changed: d !== a, w2: img2.naturalWidth, h2: img2.naturalHeight, prefix: a.slice(0, 22) };
  }, id);
  assert(r.same && r.distinct === 6 && r.w === 150 && r.changed && r.w2 === 150 && Math.abs(r.h2 * r.h - 22500) < 400, JSON.stringify(r));
  assert(r.cw === 300, 'width option');
  return r;
});

await test('print: printDoc builds the print frame', async () => {
  const id = await ev(() => window.__harness.useApp.getState().activeDocId);
  const r = await ev(async (id) => {
    let captured = null;
    const obs = new MutationObserver(() => {
      const f = document.querySelector('iframe[data-engine-print]');
      if (f && !captured) {
        captured = f;
        f.addEventListener('load', () => {});
      }
    });
    obs.observe(document.body, { childList: true, subtree: true });
    const origPrint = Window.prototype.print;
    let printed = 0;
    // Chromium's headless print is a no-op; count calls on the frame's window.
    const patch = setInterval(() => {
      const f = document.querySelector('iframe[data-engine-print]');
      if (f?.contentWindow && !f.contentWindow.__patched) {
        f.contentWindow.__patched = true;
        f.contentWindow.print = () => {
          printed++;
        };
      }
    }, 5);
    await window.__harness.engine.printDoc(id);
    clearInterval(patch);
    obs.disconnect();
    const f = captured;
    const doc = f?.contentDocument;
    const imgs = doc ? [...doc.querySelectorAll('img')] : [];
    return { frame: !!f, sheets: doc?.querySelectorAll('.sheet').length, imgs: imgs.length, decoded: imgs.every((i) => i.complete && i.naturalWidth > 0), css: doc?.querySelector('style')?.textContent.slice(0, 200), printed, origPrint: typeof origPrint };
  }, id);
  assert(r.frame && r.sheets === 6 && r.imgs === 6 && r.decoded, JSON.stringify(r));
  return r;
});

await closeAll();

await test('open: images → PDF via file handler, non-PDF rejection', async () => {
  await page.setInputFiles('[data-testid=open-file-input]', [`${FIX}/sample.png`, `${FIX}/sample.jpg`]);
  await page.waitForFunction(() => window.__harness.useApp.getState().tabs.length === 2);
  const r = await ev(async () => {
    const H = window.__harness;
    const ids = H.useApp.getState().tabs;
    const out = [];
    for (const id of ids) {
      await H.engine.awaitPdf(id);
      const d = H.getDoc(id);
      out.push({ name: d.name, pages: d.pages.length, w: Math.round(d.pages[0].width), h: Math.round(d.pages[0].height) });
    }
    const bad = await H.engine.openFiles([new File(['hello'], 'notes.xyz')]).then((x) => x, (e) => e.message);
    const fakePdf = await H.engine.openBytes('broken.pdf', new TextEncoder().encode('not a pdf at all')).then((x) => x, (e) => e.message);
    return { out, bad, fakePdf, toasts: H.toasts.slice(-2).map((t) => `${t.kind}: ${t.message}`) };
  });
  await page.waitForTimeout(500);
  await shot('images-opened');
  assert(r.out.length === 2 && r.out.every((x) => x.pages === 1 && x.name.endsWith('.pdf')), JSON.stringify(r));
  return r;
});

await closeAll();

await test('sync: latest load wins, load errors surface, undo recovers', async () => {
  const id = await open(`${FIX}/sample.pdf`);
  const r = await ev(async (id) => {
    const H = window.__harness;
    const d0 = H.getDoc(id);
    const pages = d0.pages;
    const base = d0.bytes;
    const lib = await H.pdfLib.PDFDocument.load(base);
    const variants = [];
    for (const rot of [90, 180, 270]) {
      lib.getPage(0).setRotation(H.pdfLib.degrees(rot));
      variants.push(await lib.save());
    }
    // Three commits in the same tick: only the last one may be applied.
    for (const [i, bytes] of variants.entries()) H.actions.commitBytes(id, { bytes, pages: pages.map((p, k) => (k === 0 ? { ...p, rotation: [90, 180, 270][i] } : p)), label: `r${i}` });
    const pdf = await H.engine.awaitPdf(id);
    const d1 = H.getDoc(id);
    const rot = (await pdf.getPage(1)).rotate;
    // The committed bytes must stay untouched (pdf.js gets a copy).
    const intact = d1.bytes.length > 0 && d1.bytes[0] === 0x25;
    // Broken bytes: loadError + toast; awaitPdf rejects; undo brings the previous version back.
    H.actions.commitBytes(id, { bytes: new TextEncoder().encode('%PDF-1.7\ngarbage'), pages, label: 'broken' });
    const err = await H.engine.awaitPdf(id).then(() => 'resolved', (e) => e.message);
    const d2 = H.getDoc(id);
    H.actions.undo(id);
    const back = await H.engine.awaitPdf(id);
    const d3 = H.getDoc(id);
    return { rot, pdfVersion: d1.pdfVersion, version: d1.version, intact, err, loadError: d2.loadError, toast: H.toasts.at(-1)?.message, recovered: (await back.getPage(1)).rotate, loadError3: d3.loadError };
  }, id);
  assert(r.rot === 270 && r.pdfVersion === r.version && r.intact, JSON.stringify(r));
  assert(r.err !== 'resolved' && r.loadError && /Couldn't display/.test(r.toast) && r.recovered === 270 && !r.loadError3, JSON.stringify(r));
  const i = consoleErrors.findIndex((e) => e.includes('failed to load document'));
  if (i >= 0) consoleErrors.splice(i, 1); // expected for the deliberately broken version
  return r;
});

await test('sync: closing a document destroys its proxies', async () => {
  const id = await ev(() => window.__harness.useApp.getState().activeDocId);
  const r = await ev(async (id) => {
    const H = window.__harness;
    const pdf = await H.engine.awaitPdf(id);
    H.actions.closeDocument(id);
    await new Promise((res) => setTimeout(res, 2500));
    let destroyed;
    try {
      destroyed = await pdf.getPage(1).then(() => false, () => true);
    } catch {
      destroyed = true;
    }
    const thumb = await H.engine.getThumbnail(id, 0, 100).then(() => 'resolved', (e) => e.message);
    return { destroyed, thumb, engine: !!window.__engine && typeof window.__engine.exportPdf === 'function' };
  }, id);
  assert(r.destroyed && /no longer open/.test(r.thumb) && r.engine, JSON.stringify(r));
  return r;
});

await test('fixtures: mixed sizes, images, scanned, large (300 pages)', async () => {
  const out = {};
  for (const f of ['mixed-sizes.pdf', 'images.pdf', 'scanned.pdf', 'large.pdf']) {
    const t0 = Date.now();
    const id = await open(`${FIX}/${f}`);
    const s = await summary(id);
    const thumbs = await ev(async (id) => {
      const H = window.__harness;
      const n = Math.min(6, H.getDoc(id).pages.length);
      const urls = await Promise.all([...Array(n).keys()].map((i) => H.engine.getThumbnail(id, i, 120)));
      return urls.every((u) => u.startsWith('data:image/png') && u.length > 500);
    }, id);
    out[f] = { pages: s.pages.length, ms: Date.now() - t0, sizes: [...new Set(s.pages.map((p) => `${Math.round(p.view[2] - p.view[0])}x${Math.round(p.view[3] - p.view[1])}`))].slice(0, 5), thumbs };
    assert(thumbs, `thumbnails for ${f}`);
  }
  await page.waitForTimeout(1500);
  await shot('scanned-large');
  assert(out['large.pdf'].pages === 300 && out['mixed-sizes.pdf'].pages === 5 && out['mixed-sizes.pdf'].sizes.length > 1, JSON.stringify(out));
  // An op on the 300-page file
  const id = await ev(() => window.__harness.useApp.getState().activeDocId);
  const t0 = Date.now();
  await ev((id) => window.__harness.engine.deletePages(id, [0, 1, 2]), id);
  const s = await summary(id);
  assert(s.pages.length === 297, 'large delete');
  out.largeDeleteMs = Date.now() - t0;
  return out;
});

await test('network: pdf.js assets load (worker, fonts, cmaps, wasm) without 4xx', async () => {
  const cfg = await ev(() => ({
    worker: window.__harness.engine && typeof window.pdfjsWorker === 'undefined',
    failed: performance.getEntriesByType('resource').filter((e) => e.responseStatus >= 400).map((e) => `${e.responseStatus} ${e.name}`),
    assets: performance.getEntriesByType('resource').map((e) => e.name).filter((n) => /pdfjs\/|pdf\.worker/.test(n)).map((n) => n.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '')),
  }));
  assert(!cfg.failed.length, JSON.stringify(cfg.failed));
  assert(cfg.assets.some((a) => /pdf\.worker/.test(a)), JSON.stringify(cfg.assets));
  return { assets: [...new Set(cfg.assets)].slice(0, 12) };
});

await closeAll();
console.log('\nconsole errors:', consoleErrors.length ? consoleErrors : 'none');
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) console.log(failed.map((f) => `- ${f.name}: ${f.error}`).join('\n'));
await browser.close();
process.exit(failed.length ? 1 : 0);
