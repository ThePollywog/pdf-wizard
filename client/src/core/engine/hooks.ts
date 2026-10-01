/**
 * Built-in export hooks:
 *   core-outline    (100)  writes /Outlines from doc.outline when the bookmarks were edited
 *   core-metadata   (200)  writes the Info dictionary (and updates XMP) from doc.meta
 *   core-encryption (1000) encrypts with doc.security (AES-256), or with the file's original
 *                          encryption while the security is unchanged since opening
 */
import {
  PDFDict, PDFHexString, PDFName, PDFNumber, PDFRawStream, PDFRef, PDFString, decodePDFRawStream,
  type PDFObject,
} from '@cantoo/pdf-lib';
import type { DocMeta, DocState, ExportHook, LibDocument, OutlineItem, SecuritySettings } from '../types';
import { actions } from '../store';
import { hexToRgb01 } from '../util';
import { N, lookup, lookupDict, pdfDate } from './lib';
import { getOrigin } from './state';
import { keptEncryptionOptions, restoreKeptEncryption, type KeptEncryption } from './pdfcrypt';

export const OUTLINE_HOOK_ID = 'core-outline';
export const METADATA_HOOK_ID = 'core-metadata';
export const ENCRYPTION_HOOK_ID = 'core-encryption';
export const BUILTIN_HOOK_IDS = new Set([OUTLINE_HOOK_ID, METADATA_HOOK_ID, ENCRYPTION_HOOK_ID]);

const r3 = (v: number) => Math.round(v * 1000) / 1000;

// ── outline ──────────────────────────────────────────────────────────────────

/** True when the bookmarks differ from the ones read from the file. */
export function outlineEdited(doc: DocState): boolean {
  const o = getOrigin(doc.id);
  return !o || o.outline !== doc.outline;
}

function asciiUrl(url: string): string {
  // URI actions are 7-bit ASCII strings.
  // eslint-disable-next-line no-control-regex
  return /^[\x00-\x7f]*$/.test(url) ? url : encodeURI(decodeURI(url));
}

/** Number of descendants shown when `it` is expanded. */
function visibleCount(it: OutlineItem): number {
  let n = 0;
  for (const c of it.children ?? []) n += 1 + (c.open ? visibleCount(c) : 0);
  return n;
}

export function writeOutline(lib: LibDocument, doc: DocState) {
  const ctx = lib.context;
  const items = doc.outline ?? [];
  if (!items.length) {
    lib.catalog.delete(N('Outlines'));
    if (lookup(ctx, lib.catalog.get(N('PageMode'))) === PDFName.of('UseOutlines')) lib.catalog.delete(N('PageMode'));
    return;
  }
  const pages = lib.getPages();
  const pageRef = new Map<string, PDFRef>(doc.pages.map((p, i) => [p.id, pages[i]?.ref]).filter((e): e is [string, PDFRef] => !!e[1]));
  const rootRef = ctx.nextRef();

  const build = (list: OutlineItem[], parentRef: PDFRef): [PDFRef, PDFRef] => {
    const refs = list.map(() => ctx.nextRef());
    list.forEach((it, i) => {
      const d = ctx.obj({}) as PDFDict;
      d.set(N('Title'), PDFHexString.fromText(it.title ?? ''));
      d.set(N('Parent'), parentRef);
      if (i > 0) d.set(N('Prev'), refs[i - 1]);
      if (i < list.length - 1) d.set(N('Next'), refs[i + 1]);
      const kids = it.children ?? [];
      if (kids.length) {
        const [first, last] = build(kids, refs[i]);
        d.set(N('First'), first);
        d.set(N('Last'), last);
        const n = visibleCount(it);
        d.set(N('Count'), PDFNumber.of(it.open ? n : -n));
      }
      const target = it.pageId ? pageRef.get(it.pageId) : undefined;
      if (it.url) {
        d.set(N('A'), ctx.obj({ Type: 'Action', S: 'URI', URI: PDFString.of(asciiUrl(it.url)) }));
      } else if (target) {
        const top = typeof it.top === 'number' && Number.isFinite(it.top) ? r3(it.top) : null;
        d.set(N('Dest'), ctx.obj([target, 'XYZ', null, top, null]));
      }
      if (it.color && it.color.toLowerCase() !== '#000000') d.set(N('C'), ctx.obj(hexToRgb01(it.color).map(r3)));
      const flags = (it.italic ? 1 : 0) | (it.bold ? 2 : 0);
      if (flags) d.set(N('F'), PDFNumber.of(flags));
      ctx.assign(refs[i], d);
    });
    return [refs[0], refs[refs.length - 1]];
  };

  const [first, last] = build(items, rootRef);
  let total = 0;
  for (const it of items) total += 1 + (it.open ? visibleCount(it) : 0);
  ctx.assign(rootRef, ctx.obj({ Type: 'Outlines', First: first, Last: last, Count: total }));
  lib.catalog.set(N('Outlines'), rootRef);
}

export const outlineHook: ExportHook = {
  id: OUTLINE_HOOK_ID,
  order: 100,
  run(ctx) {
    const { purpose } = ctx.options;
    if (purpose === 'print' || purpose === 'bake') return;
    if (!outlineEdited(ctx.doc)) return;
    writeOutline(ctx.pdfDoc, ctx.doc);
  },
};

// ── metadata ─────────────────────────────────────────────────────────────────

export function metaEdited(doc: DocState): boolean {
  const o = getOrigin(doc.id);
  return !o || o.meta !== doc.meta;
}

const INFO_TEXT: [keyof DocMeta, string][] = [
  ['title', 'Title'],
  ['author', 'Author'],
  ['subject', 'Subject'],
  ['keywords', 'Keywords'],
  ['creator', 'Creator'],
  ['producer', 'Producer'],
];

function isoToPdfDate(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? pdfDate(new Date(t)) : undefined;
}

export function writeInfo(lib: LibDocument, meta: DocMeta, now: Date) {
  const ctx = lib.context;
  const t = ctx.trailerInfo as { Info?: PDFObject };
  const existing = lookupDict(ctx, t.Info);
  const info = existing ?? (ctx.obj({}) as PDFDict);
  for (const [k, key] of INFO_TEXT) {
    const v = meta[k];
    if (typeof v === 'string' && v.trim()) info.set(N(key), PDFHexString.fromText(v));
    else info.delete(N(key));
  }
  if (!info.get(N('Producer'))) info.set(N('Producer'), PDFHexString.fromText('PDF Wizard'));
  const created = isoToPdfDate(meta.creationDate);
  if (created) info.set(N('CreationDate'), PDFString.of(created));
  else if (!info.get(N('CreationDate'))) info.set(N('CreationDate'), PDFString.of(pdfDate(now)));
  info.set(N('ModDate'), PDFString.of(pdfDate(now)));
  if (!existing || !(t.Info instanceof PDFRef)) t.Info = ctx.register(info);
}

const NS = {
  x: 'adobe:ns:meta/',
  rdf: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  dc: 'http://purl.org/dc/elements/1.1/',
  pdf: 'http://ns.adobe.com/pdf/1.3/',
  xmp: 'http://ns.adobe.com/xap/1.0/',
  pdfaid: 'http://www.aiim.org/pdfa/ns/id/',
  xmlns: 'http://www.w3.org/2000/xmlns/',
};

const MANAGED: [keyof typeof NS, string][] = [
  ['dc', 'title'],
  ['dc', 'creator'],
  ['dc', 'description'],
  ['dc', 'subject'],
  ['pdf', 'Keywords'],
  ['pdf', 'Producer'],
  ['xmp', 'CreatorTool'],
  ['xmp', 'CreateDate'],
  ['xmp', 'ModifyDate'],
  ['xmp', 'MetadataDate'],
];

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function isoOrNow(iso: string | undefined, fallback: Date): string {
  const t = iso ? Date.parse(iso) : NaN;
  return (Number.isFinite(t) ? new Date(t) : fallback).toISOString();
}

interface XmpValues {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  producer: string;
  creator?: string;
  created: string;
  modified: string;
}

function xmpValues(meta: DocMeta, now: Date): XmpValues {
  const s = (v?: string) => (v && v.trim() ? v : undefined);
  return {
    title: s(meta.title),
    author: s(meta.author),
    subject: s(meta.subject),
    keywords: s(meta.keywords),
    producer: s(meta.producer) ?? 'PDF Wizard',
    creator: s(meta.creator),
    created: isoOrNow(meta.creationDate, now),
    modified: now.toISOString(),
  };
}

function keywordList(k: string): string[] {
  return k.split(/[;,]/).map((x) => x.trim()).filter(Boolean);
}

/** A description left without properties (only rdf:about and namespace declarations). */
function isEmptyDescription(desc: Element): boolean {
  if (desc.children.length || (desc.textContent ?? '').trim()) return false;
  return [...desc.attributes].every((a) => a.name === 'rdf:about' || a.name.startsWith('xmlns'));
}

const EMPTY_DESCRIPTION = /<rdf:Description\b(?:\s+(?:xmlns(?::[\w.-]+)?|rdf:about)\s*=\s*(?:"[^"]*"|'[^']*'))*\s*(?:\/>|>\s*<\/rdf:Description>)/g;

/** Update the managed properties of an existing packet in place (keeps everything else). */
function patchXmp(xml: string, v: XmpValues): string | null {
  if (typeof DOMParser === 'undefined' || !xml.trim()) return null;
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) return null;
  const rdf = doc.getElementsByTagNameNS(NS.rdf, 'RDF')[0];
  if (!rdf) return null;
  for (const desc of [...doc.getElementsByTagNameNS(NS.rdf, 'Description')]) {
    for (const [p, local] of MANAGED) {
      desc.removeAttributeNS(NS[p], local);
      for (const el of [...desc.getElementsByTagNameNS(NS[p], local)]) if (el.parentNode === desc) desc.removeChild(el);
    }
    if (isEmptyDescription(desc)) desc.parentNode?.removeChild(desc);
  }
  const desc = doc.createElementNS(NS.rdf, 'rdf:Description');
  desc.setAttributeNS(NS.rdf, 'rdf:about', '');
  for (const p of ['dc', 'pdf', 'xmp'] as const) desc.setAttributeNS(NS.xmlns, `xmlns:${p}`, NS[p]);
  const el = (p: keyof typeof NS, local: string) => doc.createElementNS(NS[p], `${p}:${local}`);
  const simple = (p: keyof typeof NS, local: string, text: string) => {
    const e = el(p, local);
    e.textContent = text;
    desc.appendChild(e);
  };
  const container = (p: keyof typeof NS, local: string, kind: 'Alt' | 'Seq' | 'Bag', values: string[]) => {
    const e = el(p, local);
    const c = doc.createElementNS(NS.rdf, `rdf:${kind}`);
    for (const val of values) {
      const li = doc.createElementNS(NS.rdf, 'rdf:li');
      if (kind === 'Alt') li.setAttributeNS('http://www.w3.org/XML/1998/namespace', 'xml:lang', 'x-default');
      li.textContent = val;
      c.appendChild(li);
    }
    e.appendChild(c);
    desc.appendChild(e);
  };
  if (v.title) container('dc', 'title', 'Alt', [v.title]);
  if (v.author) container('dc', 'creator', 'Seq', [v.author]);
  if (v.subject) container('dc', 'description', 'Alt', [v.subject]);
  if (v.keywords) {
    container('dc', 'subject', 'Bag', keywordList(v.keywords));
    simple('pdf', 'Keywords', v.keywords);
  }
  simple('pdf', 'Producer', v.producer);
  if (v.creator) simple('xmp', 'CreatorTool', v.creator);
  simple('xmp', 'CreateDate', v.created);
  simple('xmp', 'ModifyDate', v.modified);
  simple('xmp', 'MetadataDate', v.modified);
  rdf.appendChild(desc);
  return new XMLSerializer().serializeToString(doc);
}

function freshXmp(v: XmpValues, pdfa: { part: string; conformance?: string } | null): string {
  const alt = (s: string) => `<rdf:Alt><rdf:li xml:lang="x-default">${esc(s)}</rdf:li></rdf:Alt>`;
  const parts: string[] = [];
  if (v.title) parts.push(`<dc:title>${alt(v.title)}</dc:title>`);
  if (v.author) parts.push(`<dc:creator><rdf:Seq><rdf:li>${esc(v.author)}</rdf:li></rdf:Seq></dc:creator>`);
  if (v.subject) parts.push(`<dc:description>${alt(v.subject)}</dc:description>`);
  if (v.keywords) {
    parts.push(`<dc:subject><rdf:Bag>${keywordList(v.keywords).map((k) => `<rdf:li>${esc(k)}</rdf:li>`).join('')}</rdf:Bag></dc:subject>`);
    parts.push(`<pdf:Keywords>${esc(v.keywords)}</pdf:Keywords>`);
  }
  parts.push(`<pdf:Producer>${esc(v.producer)}</pdf:Producer>`);
  if (v.creator) parts.push(`<xmp:CreatorTool>${esc(v.creator)}</xmp:CreatorTool>`);
  parts.push(`<xmp:CreateDate>${v.created}</xmp:CreateDate>`, `<xmp:ModifyDate>${v.modified}</xmp:ModifyDate>`, `<xmp:MetadataDate>${v.modified}</xmp:MetadataDate>`);
  if (pdfa) {
    parts.push(`<pdfaid:part>${esc(pdfa.part)}</pdfaid:part>`);
    if (pdfa.conformance) parts.push(`<pdfaid:conformance>${esc(pdfa.conformance)}</pdfaid:conformance>`);
  }
  return (
    `<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n` +
    `<x:xmpmeta xmlns:x="${NS.x}"><rdf:RDF xmlns:rdf="${NS.rdf}">` +
    `<rdf:Description rdf:about="" xmlns:dc="${NS.dc}" xmlns:pdf="${NS.pdf}" xmlns:xmp="${NS.xmp}"${pdfa ? ` xmlns:pdfaid="${NS.pdfaid}"` : ''}>` +
    parts.join('') +
    `</rdf:Description></rdf:RDF></x:xmpmeta>\n` +
    `${' '.repeat(2000)}\n<?xpacket end="w"?>`
  );
}

function readXmp(lib: LibDocument): { stream: PDFRawStream; xml: string } | null {
  const s = lookup(lib.context, lib.catalog.get(N('Metadata')));
  if (!(s instanceof PDFRawStream)) return null;
  try {
    return { stream: s, xml: new TextDecoder('utf-8').decode(decodePDFRawStream(s).decode()) };
  } catch {
    return { stream: s, xml: '' };
  }
}

function writeXmp(lib: LibDocument, xml: string) {
  const ctx = lib.context;
  // Unfiltered, so PDF/A validators and non-PDF tools can read it.
  const stream = ctx.stream(new TextEncoder().encode(xml), { Type: 'Metadata', Subtype: 'XML' });
  lib.catalog.set(N('Metadata'), ctx.register(stream));
}

function pdfaOf(xml: string): { part: string; conformance?: string } | null {
  const part = /pdfaid:part(?:="([^"]*)"|>([^<]*)<)/.exec(xml);
  if (!part) return null;
  const conf = /pdfaid:conformance(?:="([^"]*)"|>([^<]*)<)/.exec(xml);
  return { part: (part[1] ?? part[2]).trim(), conformance: conf ? (conf[1] ?? conf[2]).trim() : undefined };
}

/** Update an existing XMP packet so it agrees with the Info dictionary. */
export function updateXmp(lib: LibDocument, meta: DocMeta, now: Date) {
  const cur = readXmp(lib);
  if (!cur) return;
  const v = xmpValues(meta, now);
  let xml: string | null = null;
  try {
    xml = patchXmp(cur.xml, v);
  } catch {
    xml = null;
  }
  writeXmp(lib, xml ?? freshXmp(v, pdfaOf(cur.xml)));
}

export const metadataHook: ExportHook = {
  id: METADATA_HOOK_ID,
  order: 200,
  run(ctx) {
    const { purpose } = ctx.options;
    if (purpose === 'print' || purpose === 'bake') return;
    const saving = (purpose === 'save' || purpose === 'download' || purpose === 'share') && ctx.doc.dirty;
    if (!metaEdited(ctx.doc) && !saving) return;
    const now = new Date();
    writeInfo(ctx.pdfDoc, ctx.doc.meta, now);
    updateXmp(ctx.pdfDoc, ctx.doc.meta, now);
  },
};

// ── encryption ───────────────────────────────────────────────────────────────

type Permissions = NonNullable<SecuritySettings['permissions']>;

export function isRestrictive(p: Permissions | undefined): boolean {
  if (!p) return false;
  return (
    p.printing === false || p.printing === 'lowResolution' || p.modifying === false || p.copying === false ||
    p.annotating === false || p.fillingForms === false || p.contentAccessibility === false || p.documentAssembly === false
  );
}

/** True when `security` asks for an encrypted file. */
export function needsEncryption(security: SecuritySettings | null | undefined): boolean {
  if (!security) return false;
  return !!security.userPassword || !!security.ownerPassword || isRestrictive(security.permissions);
}

function randomPassword(): string {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** Remove PDF/A identification (an encrypted file can't be PDF/A). Returns true when something was removed. */
function stripPdfA(lib: LibDocument): boolean {
  const cur = readXmp(lib);
  if (!cur || !/pdfaid:/.test(cur.xml)) return false;
  const xml = cur.xml
    .replace(/\s+pdfaid:\w+="[^"]*"/g, '')
    .replace(/<pdfaid:(\w+)\b[^>]*>[\s\S]*?<\/pdfaid:\1>/g, '')
    .replace(/<pdfaid:\w+\b[^>]*\/>/g, '')
    .replace(EMPTY_DESCRIPTION, '');
  writeXmp(lib, xml);
  return true;
}

/**
 * Encrypt `lib` for saving: with the file's original key and /Encrypt entries when `kept` is given
 * (the security wasn't changed since opening), else with fresh AES-256 encryption from `security`.
 */
export function encryptDocument(lib: LibDocument, security: SecuritySettings, docName: string, kept?: KeptEncryption) {
  const p = security.permissions ?? {};
  const restricted = isRestrictive(p);
  const options = kept ? keptEncryptionOptions(kept) : {
    userPassword: security.userPassword ?? '',
    ownerPassword: security.ownerPassword || (restricted || !security.userPassword ? randomPassword() : security.userPassword),
    permissions: {
      printing: p.printing === undefined ? ('highResolution' as const) : p.printing,
      modifying: p.modifying ?? true,
      copying: p.copying ?? true,
      annotating: p.annotating ?? true,
      fillingForms: p.fillingForms ?? true,
      contentAccessibility: p.contentAccessibility ?? true,
      documentAssembly: p.documentAssembly ?? true,
    },
    algorithm: 'AES-256' as const,
  };
  try {
    lib.encrypt(options);
  } catch (e) {
    if (!(/PDF\/A/i.test((e as Error)?.message ?? '') && stripPdfA(lib))) throw e;
    lib.encrypt(options);
    actions.toast(`“${docName}” is no longer PDF/A compliant because it is protected with a password or restrictions.`, { kind: 'warning' });
  }
  if (kept) restoreKeptEncryption(lib, kept);
}

export const encryptionHook: ExportHook = {
  id: ENCRYPTION_HOOK_ID,
  order: 1000,
  run(ctx) {
    const { purpose, skipSecurity } = ctx.options;
    if (skipSecurity || purpose === 'print' || purpose === 'bake') return;
    const security = ctx.doc.security;
    // Unchanged security: keep the original encryption (even one that restricts nothing).
    const origin = getOrigin(ctx.doc.id);
    const kept = origin?.encryption && origin.security === security ? origin.encryption : undefined;
    if (!kept && (!security || !needsEncryption(security))) return;
    encryptDocument(ctx.pdfDoc, security ?? {}, ctx.doc.name, kept);
  },
};

export const builtinExportHooks: ExportHook[] = [outlineHook, metadataHook, encryptionHook];
