/**
 * Opening documents: PDF bytes (with password handling and decryption for editing), other file
 * types through registered file handlers, and files from the server library.
 */
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { PDFDocument, PDFHexString, PDFName, PDFString, type PDFObject } from '@cantoo/pdf-lib';
import type {
  DocId, DocMeta, DocState, FileHandler, ImportContext, OutlineItem, PageInfo, PdfObject, SecuritySettings,
} from '../types';
import { actions, createDocState, getDoc, useApp } from '../store';
import { useRegistry } from '../registry';
import { library, LibraryError } from '../library';
import { baseName, readFileBytes, rgb01ToHex, uid } from '../util';
import { destroyProxy, isPasswordError, loadPdfjs, pdfjsLib } from './pdfjs';
import { SAVE_OPTIONS, collectGarbage, normalizeRotation, parsePdfDate } from './lib';
import { delayedBusy, getPasswordProvider, setOrigin, setReadOnly, withoutBusy } from './state';
import { passwordPrompt } from './PasswordPrompt';
import { identifyPassword, type KeptEncryption } from './pdfcrypt';

// ── helpers ──────────────────────────────────────────────────────────────────

/** True when a "%PDF-" header appears in the first KB (like desktop PDF editors, leading garbage is tolerated). */
export function hasPdfHeader(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length - 4, 1024);
  for (let i = 0; i < n; i++) {
    if (bytes[i] === 0x25 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x44 && bytes[i + 3] === 0x46 && bytes[i + 4] === 0x2d) return true;
  }
  return false;
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const extOf = (name: string) => (/\.([^./\\]+)$/.exec(name)?.[1] ?? '').toLowerCase();
const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

// ── reading ──────────────────────────────────────────────────────────────────

export async function readPages(pdf: PDFDocumentProxy): Promise<PageInfo[]> {
  const n = pdf.numPages;
  const labels = await pdf.getPageLabels().catch(() => null);
  const out: PageInfo[] = [];
  const CHUNK = 50;
  for (let s = 0; s < n; s += CHUNK) {
    const idx = Array.from({ length: Math.min(CHUNK, n - s) }, (_, k) => s + k);
    const pages = await Promise.all(idx.map((i) => pdf.getPage(i + 1)));
    pages.forEach((p, k) => {
      const v = p.view;
      const view: [number, number, number, number] = [v[0], v[1], v[2], v[3]];
      const info: PageInfo = {
        id: uid('page'),
        view,
        width: view[2] - view[0],
        height: view[3] - view[1],
        rotation: normalizeRotation(p.rotate),
      };
      const label = labels?.[idx[k]];
      if (label) info.label = label;
      out.push(info);
    });
  }
  return out;
}

export async function readMeta(pdf: PDFDocumentProxy, bytes: Uint8Array): Promise<DocMeta> {
  let info: Record<string, unknown> = {};
  let metadata: { get(name: string): unknown } | null = null;
  try {
    const m = await pdf.getMetadata();
    info = (m.info ?? {}) as Record<string, unknown>;
    metadata = (m.metadata as unknown as { get(name: string): unknown }) ?? null;
  } catch {
    /* damaged metadata: keep defaults */
  }
  const xmp = (key: string): string | undefined => {
    try {
      const v = metadata?.get(key);
      return str(Array.isArray(v) ? v.join(', ') : v);
    } catch {
      return undefined;
    }
  };
  const xmpDate = (key: string) => {
    const v = xmp(key);
    if (!v) return undefined;
    const t = Date.parse(v);
    return Number.isFinite(t) ? new Date(t).toISOString() : undefined;
  };
  const meta: DocMeta = {
    title: str(info.Title) ?? xmp('dc:title'),
    author: str(info.Author) ?? xmp('dc:creator'),
    subject: str(info.Subject) ?? xmp('dc:description'),
    keywords: str(info.Keywords) ?? xmp('pdf:keywords'),
    creator: str(info.Creator) ?? xmp('xmp:creatortool'),
    producer: str(info.Producer) ?? xmp('pdf:producer'),
    creationDate: parsePdfDate(str(info.CreationDate)) ?? xmpDate('xmp:createdate'),
    modificationDate: parsePdfDate(str(info.ModDate)) ?? xmpDate('xmp:modifydate'),
    pdfVersion: str(info.PDFFormatVersion),
    isEncrypted: !!info.EncryptFilterName,
    isLinearized: !!info.IsLinearized,
    hasForms: !!info.IsAcroFormPresent,
    hasXfa: !!info.IsXFAPresent,
    fileSize: bytes.length,
  };
  for (const k of Object.keys(meta) as (keyof DocMeta)[]) if (meta[k] === undefined) delete meta[k];
  return meta;
}

interface PdfjsOutlineNode {
  title: string;
  bold?: boolean;
  italic?: boolean;
  color?: Uint8ClampedArray | number[] | null;
  dest?: string | unknown[] | null;
  url?: string | null;
  unsafeUrl?: string;
  count?: number;
  items?: PdfjsOutlineNode[];
}

export async function readOutline(pdf: PDFDocumentProxy, pages: PageInfo[]): Promise<OutlineItem[]> {
  let nodes: PdfjsOutlineNode[] | null = null;
  try {
    nodes = (await pdf.getOutline()) as unknown as PdfjsOutlineNode[] | null;
  } catch {
    return [];
  }
  if (!nodes?.length) return [];
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const resolve = async (dest: PdfjsOutlineNode['dest']): Promise<{ pageIndex: number | null; top: number | null }> => {
    let d: unknown = dest;
    try {
      if (typeof d === 'string') d = await pdf.getDestination(d);
    } catch {
      d = null;
    }
    if (!Array.isArray(d) || d.length === 0) return { pageIndex: null, top: null };
    const [ref, mode, ...args] = d as [unknown, { name?: string } | undefined, ...unknown[]];
    let pageIndex: number | null = null;
    if (ref && typeof ref === 'object' && 'num' in (ref as object)) {
      pageIndex = await pdf.getPageIndex(ref as { num: number; gen: number }).catch(() => null);
    } else if (Number.isInteger(ref)) pageIndex = ref as number;
    const name = mode?.name;
    let top: number | null = null;
    if (name === 'XYZ') top = num(args[1]);
    else if (name === 'FitH' || name === 'FitBH') top = num(args[0]);
    else if (name === 'FitR') top = num(args[3]);
    return { pageIndex, top };
  };
  const convert = async (list: PdfjsOutlineNode[], depth: number): Promise<OutlineItem[]> =>
    Promise.all(
      list.map(async (n) => {
        const { pageIndex, top } = await resolve(n.dest);
        const c = n.color;
        const color = c && c.length >= 3 && (c[0] || c[1] || c[2]) ? rgb01ToHex(c[0] / 255, c[1] / 255, c[2] / 255) : null;
        const rawUrl = n.url ?? n.unsafeUrl ?? null;
        const url = rawUrl && !/^\s*javascript:/i.test(rawUrl) ? rawUrl : null;
        const item: OutlineItem = {
          id: uid('bm'),
          title: n.title ?? '',
          pageId: pageIndex !== null && pageIndex >= 0 && pageIndex < pages.length ? pages[pageIndex].id : null,
          top,
          url,
          bold: !!n.bold,
          italic: !!n.italic,
          color,
          open: (n.count ?? 0) > 0,
          children: depth < 64 && n.items?.length ? await convert(n.items, depth + 1) : [],
        };
        return item;
      }),
    );
  return convert(nodes, 0);
}

// ── passwords & decryption ───────────────────────────────────────────────────

async function loadWithPassword(name: string, bytes: Uint8Array): Promise<{ pdf: PDFDocumentProxy; password: string | null } | null> {
  let password: string | undefined;
  for (;;) {
    try {
      const pdf = await loadPdfjs(bytes, password !== undefined ? { password } : {});
      return { pdf, password: password ?? null };
    } catch (e) {
      if (!isPasswordError(e)) throw e;
      const retry = e.code === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD;
      const provider = getPasswordProvider() ?? passwordPrompt;
      const pw = await withoutBusy(() => provider(name, retry));
      if (pw === null || pw === undefined) return null;
      password = pw;
    }
  }
}

function mapPermissions(flags: Set<number> | null): SecuritySettings['permissions'] | undefined {
  if (!flags) return undefined;
  const F = pdfjsLib.PermissionFlag as Record<string, number>;
  const has = (f: number) => flags.has(f);
  const p: NonNullable<SecuritySettings['permissions']> = {
    printing: has(F.PRINT) ? (has(F.PRINT_HIGH_QUALITY) ? 'highResolution' : 'lowResolution') : false,
    modifying: has(F.MODIFY_CONTENTS),
    copying: has(F.COPY),
    annotating: has(F.MODIFY_ANNOTATIONS),
    fillingForms: has(F.FILL_INTERACTIVE_FORMS),
    contentAccessibility: has(F.COPY_FOR_ACCESSIBILITY),
    documentAssembly: has(F.ASSEMBLE),
  };
  const unrestricted =
    p.printing === 'highResolution' && p.modifying && p.copying && p.annotating && p.fillingForms && p.contentAccessibility && p.documentAssembly;
  return unrestricted ? undefined : p;
}

/** Rebuild the document information dictionary from the values pdf.js decrypted. */
function restoreInfo(lib: PDFDocument, info: Record<string, unknown>) {
  const ctx = lib.context;
  const d: Record<string, PDFObject> = {};
  for (const k of ['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer']) {
    const v = info[k];
    if (typeof v === 'string' && v) d[k] = PDFHexString.fromText(v);
  }
  for (const k of ['CreationDate', 'ModDate']) {
    const v = info[k];
    if (typeof v === 'string' && v) d[k] = PDFString.of(v);
  }
  const trapped = info.Trapped as { name?: string } | undefined;
  if (trapped?.name) d.Trapped = PDFName.of(trapped.name);
  const custom = info.Custom as Record<string, unknown> | undefined;
  if (custom && typeof custom === 'object') {
    for (const [k, v] of Object.entries(custom)) {
      if (d[k] !== undefined) continue;
      if (typeof v === 'string') d[k] = PDFHexString.fromText(v);
      else if (v && typeof v === 'object' && 'name' in v) d[k] = PDFName.of(String((v as { name: string }).name));
    }
  }
  const t = ctx.trailerInfo as { Info?: PDFObject };
  t.Info = Object.keys(d).length ? ctx.register(ctx.obj(d)) : undefined;
}

async function decryptForEditing(bytes: Uint8Array, password: string, info: Record<string, unknown>): Promise<Uint8Array> {
  const lib = await PDFDocument.load(bytes, { password, updateMetadata: false, throwOnInvalidObject: false });
  const t = lib.context.trailerInfo as { Encrypt?: PDFObject };
  t.Encrypt = undefined;
  restoreInfo(lib, info);
  await lib.flush();
  collectGarbage(lib);
  return lib.save(SAVE_OPTIONS);
}

async function pageSignature(pdf: PDFDocumentProxy, i: number): Promise<string> {
  const page = await pdf.getPage(i + 1);
  const [tc, annots] = await Promise.all([page.getTextContent(), page.getAnnotations()]);
  const text = tc.items.map((it) => ('str' in it ? it.str : '')).join('');
  return `${page.view.map((v) => Math.round(v)).join(',')}|${page.rotate}|${annots.length}|${text}`;
}

/** Check that the decrypted copy shows the same thing as the encrypted original. */
async function sameDocument(a: PDFDocumentProxy, b: PDFDocumentProxy): Promise<boolean> {
  if (a.numPages !== b.numPages) return false;
  const n = Math.min(3, a.numPages);
  for (let i = 0; i < n; i++) {
    const [x, y] = await Promise.all([pageSignature(a, i), pageSignature(b, i)]);
    if (x !== y) return false;
  }
  return true;
}

/**
 * The security to show and re-apply when the decrypted document is saved, plus the original
 * encryption (`kept`) when it can be reproduced: saving without changing the security then
 * re-encrypts with the original key, so both passwords keep working. For the settings themselves:
 * with the open (user) password the permissions password stays unknown; with the permissions
 * (owner) password the open password is recovered for RC4/AES-128 files, while for AES-256 files
 * it can't be, so (unless there is none) the permissions password stands in for it.
 */
async function securityToKeep(
  bytes: Uint8Array,
  password: string | null,
  permissions: SecuritySettings['permissions'] | undefined,
): Promise<{ security: SecuritySettings | null; kept?: KeptEncryption }> {
  const perms = permissions ? { permissions } : {};
  const role = await identifyPassword(bytes, password ?? '');
  const kept = role?.kept;
  if (!password) return { security: permissions ? perms : null, kept };
  if (!role?.owner) return { security: { userPassword: password, ...perms }, kept };
  const userPassword = role.userPassword ?? password;
  return { security: { ...(userPassword ? { userPassword } : {}), ownerPassword: password, ...perms }, kept };
}

// ── opening ──────────────────────────────────────────────────────────────────

function initialFit(pages: PageInfo[]): 'width' | 'page' {
  const pref = useApp.getState().prefs.defaultFit;
  if (pref === 'page' || pref === 'width') return pref;
  const p = pages[0];
  if (!p) return 'width';
  const swap = p.rotation === 90 || p.rotation === 270;
  const w = swap ? p.height : p.width;
  const h = swap ? p.width : p.height;
  return w > h ? 'page' : 'width';
}

async function runImportHooks(docId: DocId, name: string, state: { bytes: Uint8Array; pdf: PDFDocumentProxy; pages: PageInfo[] }) {
  const hooks = [...useRegistry.getState().importHooks].sort((a, b) => a.order - b.order);
  const objects: PdfObject[] = [];
  for (const hook of hooks) {
    let replaced: Uint8Array | null = null;
    const added: PdfObject[] = [];
    const ctx: ImportContext = {
      docId,
      pdf: state.pdf,
      pages: state.pages,
      bytes: state.bytes,
      setBytes(b: Uint8Array) {
        replaced = b;
        ctx.bytes = b;
      },
      addObjects(objs: PdfObject[]) {
        added.push(...objs);
      },
    };
    try {
      await hook.run(ctx);
    } catch (e) {
      console.error(`[engine] import hook "${hook.id}" failed`, e);
      actions.toast(`Some content of “${name}” couldn't be imported (${hook.id}): ${errMsg(e)}`, { kind: 'warning' });
      continue;
    }
    if (replaced) {
      const nextBytes: Uint8Array = replaced;
      try {
        const next = await loadPdfjs(nextBytes);
        const nextPages = await readPages(next);
        const pages = nextPages.map((p, i) => (state.pages[i] ? { ...p, id: state.pages[i].id } : p));
        destroyProxy(state.pdf);
        state.pdf = next;
        state.pages = pages;
        state.bytes = nextBytes;
      } catch (e) {
        console.error(`[engine] import hook "${hook.id}" produced unreadable bytes`, e);
        actions.toast(`Some content of “${name}” couldn't be imported (${hook.id}).`, { kind: 'warning' });
        continue;
      }
    }
    objects.push(...added);
  }
  return objects;
}

async function openBytesNow(name: string, input: Uint8Array, opts: { fileId?: string | null; activate?: boolean }): Promise<DocId | null> {
  const original = input.slice();
  if (!hasPdfHeader(original)) throw new Error(`“${name}” is not a PDF file or is damaged.`);
  const loaded = await loadWithPassword(name, original);
  if (!loaded) {
    actions.toast(`Opening “${name}” was cancelled.`);
    return null;
  }
  const orig = loaded.pdf;
  const password = loaded.password;
  let pdf = orig;
  let bytes: Uint8Array = original;
  let readOnlyReason: string | null = null;
  let security: SecuritySettings | null = null;
  let kept: KeptEncryption | undefined;
  let decrypted: Uint8Array | null = null;
  let info: Record<string, unknown> = {};
  try {
    info = ((await orig.getMetadata()).info ?? {}) as Record<string, unknown>;
  } catch {
    info = {};
  }
  const meta = await readMeta(orig, original);
  const encrypted = !!info.EncryptFilterName;

  if (encrypted) {
    const permissions = mapPermissions(await orig.getPermissions().catch(() => null));
    ({ security, kept } = await securityToKeep(original, password, permissions));
    try {
      const plain = await decryptForEditing(original, password ?? '', info);
      const work = await loadPdfjs(plain);
      if (!(await sameDocument(orig, work))) {
        destroyProxy(work);
        throw new Error('the decrypted copy did not match the original');
      }
      pdf = work;
      bytes = plain;
      decrypted = plain;
      destroyProxy(orig);
    } catch (e) {
      console.warn('[engine] could not decrypt for editing', e);
      readOnlyReason =
        info.EncryptFilterName && info.EncryptFilterName !== 'Standard'
          ? `its “${String(info.EncryptFilterName)}” security isn't supported for editing`
          : `it couldn't be decrypted for editing (${errMsg(e)})`;
    }
  }

  const docId = uid('doc');
  let pages = await readPages(pdf);
  let objects: PdfObject[] = [];
  if (!readOnlyReason) {
    const state = { bytes, pdf, pages };
    objects = await runImportHooks(docId, name, state);
    bytes = state.bytes;
    pdf = state.pdf;
    pages = state.pages;
  }
  const outline = await readOutline(pdf, pages);

  const doc: DocState = createDocState({
    id: docId,
    name,
    bytes,
    pages,
    fileId: opts.fileId ?? null,
    meta,
    outline,
    security,
    openPassword: password,
    pdf,
  });
  const pageIds = new Set(pages.map((p) => p.id));
  const valid = objects.filter((o) => o && o.id && pageIds.has(o.pageId));
  doc.objects = Object.fromEntries(valid.map((o) => [o.id, o]));
  doc.order = valid.map((o) => o.id);
  doc.view = { ...doc.view, fit: initialFit(pages) };
  if (readOnlyReason) {
    setReadOnly(docId, { reason: readOnlyReason, password: password ?? '', bytes: original });
    doc.ext = { ...doc.ext, engine: { readOnly: true, reason: readOnlyReason } };
  }
  setOrigin(docId, {
    outline: doc.outline,
    meta: doc.meta,
    version: doc.version,
    security: doc.security,
    // Re-export the original encrypted file untouched (keeps signatures) while nothing was changed.
    ...(encrypted && !readOnlyReason && bytes === decrypted ? { sourceBytes: original } : {}),
    ...(kept && !readOnlyReason ? { encryption: kept } : {}),
    ...(!readOnlyReason ? { file: { bytes: original, encrypted, objects: doc.objects, order: doc.order } } : {}),
  });
  actions.addDocument(doc, { activate: opts.activate });

  if (readOnlyReason) {
    actions.toast(`“${name}” opened read-only: ${readOnlyReason}.`, { kind: 'warning', duration: 7000 });
  } else if (encrypted && password) {
    actions.toast(`“${name}” is password-protected. Its security settings will be kept when you save.`, { kind: 'info', duration: 5000 });
  } else if (encrypted && security) {
    actions.toast(`“${name}” has security restrictions. They will be kept when you save.`, { kind: 'info', duration: 5000 });
  }
  return docId;
}

export async function openBytes(name: string, bytes: Uint8Array, opts: { fileId?: string | null; activate?: boolean } = {}): Promise<DocId | null> {
  try {
    return await delayedBusy(`Opening “${name}”…`, () => openBytesNow(name, bytes, opts));
  } catch (e) {
    const msg = errMsg(e);
    const invalid = (e as { name?: string })?.name === 'InvalidPDFException';
    // Expected failures (damaged / non-PDF files) are reported by the toast alone.
    if (invalid || msg.startsWith('“')) console.warn('[engine] open failed:', msg);
    else console.error('[engine] open failed', e);
    actions.toast(msg.startsWith('“') ? msg : `Couldn't open “${name}”: ${invalid ? 'the file is damaged or is not a PDF.' : msg}`, { kind: 'error' });
    return null;
  }
}

export function handlerFor(file: File): FileHandler | undefined {
  const handlers = useRegistry.getState().fileHandlers;
  const ext = extOf(file.name);
  const mime = (file.type || '').toLowerCase();
  const byExt = handlers.find((h) =>
    h.extensions.some((e) => {
      const x = e.toLowerCase().replace(/^\./, '');
      return x.includes('/') ? !!mime && mime.startsWith(x) : !!ext && x === ext;
    }),
  );
  if (byExt) return byExt;
  if (!mime) return undefined;
  return handlers.find((h) => h.mimePrefixes?.some((p) => mime.startsWith(p.toLowerCase())));
}

async function openFile(file: File): Promise<DocId | null> {
  const ext = extOf(file.name);
  const mime = (file.type || '').toLowerCase();
  if (ext === 'pdf' || mime === 'application/pdf') return openBytes(file.name, await readFileBytes(file));
  const handler = handlerFor(file);
  if (handler) {
    const bytes = await actions.withBusy(`Converting “${file.name}” to PDF…`, async () => {
      try {
        return await handler.convert(file);
      } catch (e) {
        throw new Error(`Couldn't convert “${file.name}” to PDF: ${errMsg(e)}`);
      }
    });
    if (!bytes) return null;
    return openBytes(`${baseName(file.name)}.pdf`, bytes);
  }
  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  if (hasPdfHeader(head)) return openBytes(file.name, await readFileBytes(file));
  actions.toast(`Can't open “${file.name}”: this file type isn't supported.`, { kind: 'error' });
  return null;
}

export async function openFiles(files: File[]): Promise<DocId[]> {
  const ids: DocId[] = [];
  for (const f of files) {
    try {
      const id = await openFile(f);
      if (id) ids.push(id);
    } catch (e) {
      console.error(e);
      actions.toast(`Couldn't open “${f.name}”: ${errMsg(e)}`, { kind: 'error' });
    }
  }
  return ids;
}

const pendingLibrary = new Map<string, Promise<DocId | null>>();

export function openFromLibrary(fileId: string): Promise<DocId | null> {
  const existing = Object.values(useApp.getState().docs).find((d) => d.fileId === fileId);
  if (existing) {
    actions.setActiveDoc(existing.id);
    return Promise.resolve(existing.id);
  }
  const pending = pendingLibrary.get(fileId);
  if (pending) return pending;
  const job = (async () => {
    let name = 'document.pdf';
    try {
      const [meta, bytes] = await delayedBusy('Opening…', () => Promise.all([library.getFile(fileId), library.getFileBytes(fileId)]));
      name = meta.name;
      return await openBytes(meta.name, bytes, { fileId });
    } catch (e) {
      const msg = e instanceof LibraryError && e.notFound ? 'it no longer exists in your library.' : errMsg(e);
      actions.toast(`Couldn't open ${name === 'document.pdf' ? 'the file' : `“${name}”`}: ${msg}`, { kind: 'error' });
      return null;
    } finally {
      pendingLibrary.delete(fileId);
    }
  })();
  pendingLibrary.set(fileId, job);
  return job;
}

export async function newDocumentFromBytes(name: string, bytes: Uint8Array): Promise<DocId | null> {
  const id = await openBytes(name, bytes);
  if (id && getDoc(id)) actions.updateDoc(id, { dirty: true });
  return id;
}
