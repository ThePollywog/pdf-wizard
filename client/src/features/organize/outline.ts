/**
 * Bookmarks and destinations across documents: read a pdf-lib document's outline (resolving named
 * destinations), write a filtered / remapped outline into another document, and turn named link
 * destinations into explicit ones before pages are copied (named destinations don't survive a copy
 * because the new document has no /Dests).
 */
import {
  PDFArray, PDFDict, PDFHexString, PDFName, PDFNull, PDFNumber, PDFRef, PDFString, type PDFObject,
} from '@cantoo/pdf-lib';
import type { LibDocument } from '@/core/types';
import { N, leavesOf, lookup, lookupArray, lookupDict, nameOf, numberOf, textOf } from '@/core/engine/lib';

export interface LibOutlineNode {
  title: string;
  /** Source page index, or null (URI / unresolved). */
  page: number | null;
  /** Destination parameters after the page (e.g. /XYZ left top zoom). */
  fit: PDFObject[];
  uri: string | null;
  open: boolean;
  color: number[] | null;
  flags: number;
  children: LibOutlineNode[];
}

/** Name-tree / dictionary lookup of a named destination. */
function namedDest(lib: LibDocument, name: string): PDFArray | undefined {
  const ctx = lib.context;
  const fromValue = (v: PDFObject | undefined): PDFArray | undefined => {
    const a = lookupArray(ctx, v);
    if (a) return a;
    const d = lookupDict(ctx, v);
    return d ? lookupArray(ctx, d.get(N('D'))) : undefined;
  };
  const dests = lookupDict(ctx, lib.catalog.get(N('Dests')));
  if (dests) {
    const hit = fromValue(dests.get(N(name)));
    if (hit) return hit;
  }
  const names = lookupDict(ctx, lib.catalog.get(N('Names')));
  const tree = names && lookupDict(ctx, names.get(N('Dests')));
  const search = (node: PDFDict | undefined, depth: number): PDFArray | undefined => {
    if (!node || depth > 32) return undefined;
    const arr = lookupArray(ctx, node.get(N('Names')));
    if (arr) {
      for (let i = 0; i + 1 < arr.size(); i += 2) {
        if (textOf(ctx, arr.get(i)) === name) return fromValue(arr.get(i + 1));
      }
    }
    const kids = lookupArray(ctx, node.get(N('Kids')));
    if (kids) {
      for (let i = 0; i < kids.size(); i++) {
        const hit = search(lookupDict(ctx, kids.get(i)), depth + 1);
        if (hit) return hit;
      }
    }
    return undefined;
  };
  return search(tree, 0);
}

/** Explicit destination array for a /Dest or GoTo /D value (named ones resolved). */
export function resolveDest(lib: LibDocument, v: PDFObject | undefined): PDFArray | undefined {
  const ctx = lib.context;
  const o = lookup(ctx, v);
  if (!o) return undefined;
  if (o instanceof PDFArray) return o;
  if (o instanceof PDFName) return namedDest(lib, o.decodeText());
  if (o instanceof PDFString || o instanceof PDFHexString) return namedDest(lib, o.decodeText());
  return undefined;
}

function targetOf(lib: LibDocument, d: PDFDict): { dest?: PDFArray; uri?: string } {
  const ctx = lib.context;
  const dest = d.get(N('Dest'));
  if (dest !== undefined) return { dest: resolveDest(lib, dest) };
  const a = lookupDict(ctx, d.get(N('A')));
  if (!a) return {};
  const s = nameOf(ctx, a.get(N('S')));
  if (s === 'GoTo') return { dest: resolveDest(lib, a.get(N('D'))) };
  if (s === 'URI') {
    const u = textOf(ctx, a.get(N('URI')));
    return u ? { uri: u } : {};
  }
  return {};
}

/** Outline of a pdf-lib document with page indices. */
export function readLibOutline(lib: LibDocument): LibOutlineNode[] {
  const ctx = lib.context;
  const indexOf = new Map<PDFRef, number>();
  leavesOf(lib).forEach(({ ref }, i) => indexOf.set(ref, i));
  const root = lookupDict(ctx, lib.catalog.get(N('Outlines')));
  if (!root) return [];
  const seen = new Set<PDFDict>();
  const walk = (first: PDFObject | undefined, depth: number): LibOutlineNode[] => {
    const out: LibOutlineNode[] = [];
    let cur = lookupDict(ctx, first);
    let guard = 0;
    while (cur && !seen.has(cur) && depth < 32 && guard++ < 100000) {
      seen.add(cur);
      const { dest, uri } = targetOf(lib, cur);
      let page: number | null = null;
      let fit: PDFObject[] = [];
      if (dest && dest.size()) {
        const t = dest.get(0);
        if (t instanceof PDFRef && indexOf.has(t)) page = indexOf.get(t)!;
        fit = dest.asArray().slice(1).map((x) => lookup(ctx, x) ?? PDFNull);
      }
      const count = numberOf(ctx, cur.get(N('Count')));
      const c = lookupArray(ctx, cur.get(N('C')));
      const color = c && c.size() === 3 ? [0, 1, 2].map((k) => numberOf(ctx, c.get(k)) ?? 0) : null;
      out.push({
        title: textOf(ctx, cur.get(N('Title'))) ?? '',
        page,
        fit,
        uri: uri ?? null,
        open: count !== undefined && count > 0,
        color,
        flags: numberOf(ctx, cur.get(N('F'))) ?? 0,
        children: walk(cur.get(N('First')), depth + 1),
      });
      cur = lookupDict(ctx, cur.get(N('Next')));
    }
    return out;
  };
  return walk(root.get(N('First')), 0);
}

/**
 * Keep only nodes whose page maps (children of dropped nodes move up). URI bookmarks are kept
 * when `keepUri`.
 */
export function filterOutline(nodes: LibOutlineNode[], has: (page: number) => boolean, keepUri: boolean): LibOutlineNode[] {
  const out: LibOutlineNode[] = [];
  for (const n of nodes) {
    const children = filterOutline(n.children, has, keepUri);
    const keep = (n.page !== null && has(n.page)) || (keepUri && !!n.uri);
    if (keep) out.push({ ...n, children });
    else out.push(...children);
  }
  return out;
}

export interface OutlineSpec {
  title: string;
  /** Destination page ref in the target document. */
  pageRef: PDFRef | null;
  fit: PDFObject[];
  uri: string | null;
  open: boolean;
  color: number[] | null;
  flags: number;
  children: OutlineSpec[];
}

export function toSpecs(nodes: LibOutlineNode[], refOf: (page: number) => PDFRef | null | undefined): OutlineSpec[] {
  return nodes.map((n) => ({
    title: n.title,
    pageRef: n.page !== null ? (refOf(n.page) ?? null) : null,
    fit: n.fit,
    uri: n.uri,
    open: n.open,
    color: n.color,
    flags: n.flags,
    children: toSpecs(n.children, refOf),
  }));
}

function visible(n: OutlineSpec): number {
  let c = 0;
  for (const k of n.children) c += 1 + (k.open ? visible(k) : 0);
  return c;
}

const FITS = new Set(['XYZ', 'Fit', 'FitH', 'FitV', 'FitR', 'FitB', 'FitBH', 'FitBV']);

/** Write `/Outlines` from specs (removed when empty). */
export function writeOutlineSpecs(lib: LibDocument, items: OutlineSpec[]) {
  const ctx = lib.context;
  if (!items.length) {
    lib.catalog.delete(N('Outlines'));
    return;
  }
  const rootRef = ctx.nextRef();
  const build = (list: OutlineSpec[], parentRef: PDFRef): [PDFRef, PDFRef] => {
    const refs = list.map(() => ctx.nextRef());
    list.forEach((it, i) => {
      const d = ctx.obj({}) as PDFDict;
      d.set(N('Title'), PDFHexString.fromText(it.title));
      d.set(N('Parent'), parentRef);
      if (i > 0) d.set(N('Prev'), refs[i - 1]);
      if (i < list.length - 1) d.set(N('Next'), refs[i + 1]);
      if (it.children.length) {
        const [first, last] = build(it.children, refs[i]);
        d.set(N('First'), first);
        d.set(N('Last'), last);
        const n = visible(it);
        d.set(N('Count'), PDFNumber.of(it.open ? n : -n));
      }
      if (it.pageRef) {
        const kind = it.fit[0] instanceof PDFName ? it.fit[0].decodeText() : '';
        const tail = FITS.has(kind) ? it.fit : [N('XYZ'), PDFNull, PDFNull, PDFNull];
        d.set(N('Dest'), ctx.obj([it.pageRef, ...tail]));
      } else if (it.uri) {
        d.set(N('A'), ctx.obj({ Type: 'Action', S: 'URI', URI: PDFString.of(it.uri) }));
      }
      if (it.color && it.color.some((v) => v !== 0)) d.set(N('C'), ctx.obj(it.color));
      if (it.flags) d.set(N('F'), PDFNumber.of(it.flags));
      ctx.assign(refs[i], d);
    });
    return [refs[0], refs[refs.length - 1]];
  };
  const [first, last] = build(items, rootRef);
  let total = 0;
  for (const it of items) total += 1 + (it.open ? visible(it) : 0);
  ctx.assign(rootRef, ctx.obj({ Type: 'Outlines', First: first, Last: last, Count: total }));
  lib.catalog.set(N('Outlines'), rootRef);
}

/**
 * Replace named destinations of link annotations (and GoTo actions) with explicit arrays so they
 * survive being copied to another document. Unresolvable ones are left alone (dropped later).
 */
export function explicitLinkDestinations(lib: LibDocument) {
  const ctx = lib.context;
  for (const { leaf } of leavesOf(lib)) {
    const annots = lookupArray(ctx, leaf.get(N('Annots')));
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const d = lookupDict(ctx, annots.get(i));
      if (!d || nameOf(ctx, d.get(N('Subtype'))) !== 'Link') continue;
      const dest = d.get(N('Dest'));
      if (dest !== undefined && !(lookup(ctx, dest) instanceof PDFArray)) {
        const arr = resolveDest(lib, dest);
        if (arr) d.set(N('Dest'), ctx.obj(arr.asArray()));
      }
      const a = lookupDict(ctx, d.get(N('A')));
      if (a && nameOf(ctx, a.get(N('S'))) === 'GoTo') {
        const dv = a.get(N('D'));
        if (dv !== undefined && !(lookup(ctx, dv) instanceof PDFArray)) {
          const arr = resolveDest(lib, dv);
          if (arr) a.set(N('D'), ctx.obj(arr.asArray()));
        }
      }
    }
  }
}
