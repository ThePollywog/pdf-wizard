/**
 * PDF content-stream generation for paint lists (appearance streams + flattening).
 * Mirrors svg.tsx: same segments, widths, caps/joins, dashes, opacities and fonts.
 */
import type { PDFDict, PDFDocument, PDFRef } from '@cantoo/pdf-lib';
import type { AppearanceSpec, ExportContext, Rect } from '@/core/types';
import { hexToRgb01 } from '@/core/util';
import type { Seg } from './geom';
import { inflate } from './geom';
import { paintBounds, type Paint } from './paint';
import { textOps, type TextResources } from './textops';

const f = (v: number) => {
  if (!Number.isFinite(v) || Math.abs(v) < 1e-9) return '0';
  return Number(v.toFixed(3)).toString();
};

function rgb(hex: string): string {
  const [r, g, b] = hexToRgb01(hex);
  return `${f(r)} ${f(g)} ${f(b)}`;
}

export function segOps(segs: Seg[]): string {
  const out: string[] = [];
  for (const s of segs) {
    if (s[0] === 'M') out.push(`${f(s[1])} ${f(s[2])} m`);
    else if (s[0] === 'L') out.push(`${f(s[1])} ${f(s[2])} l`);
    else if (s[0] === 'C') out.push(`${f(s[1])} ${f(s[2])} ${f(s[3])} ${f(s[4])} ${f(s[5])} ${f(s[6])} c`);
    else out.push('h');
  }
  return out.join('\n');
}

const CAP = { butt: 0, round: 1, square: 2 } as const;
const JOIN = { miter: 0, round: 1, bevel: 2 } as const;

// Embedded images / pages are cached per output document.
const imageCache = new WeakMap<PDFDocument, Map<string, PDFRef>>();

export function dataUrlBytes(src: string): Uint8Array {
  const i = src.indexOf(',');
  const b64 = i >= 0 ? src.slice(i + 1) : src;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) out[k] = bin.charCodeAt(k);
  return out;
}

async function embedImage(doc: PDFDocument, src: string): Promise<PDFRef> {
  let cache = imageCache.get(doc);
  if (!cache) imageCache.set(doc, (cache = new Map()));
  const hit = cache.get(src);
  if (hit) return hit;
  const bytes = dataUrlBytes(src);
  const isPng = src.startsWith('data:image/png') || (bytes[0] === 0x89 && bytes[1] === 0x50);
  const img = isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  cache.set(src, img.ref);
  return img.ref;
}

const pageCache = new WeakMap<PDFDocument, Map<string, Promise<{ ref: PDFRef; width: number; height: number }>>>();

/** Embed page 1 of a base64 PDF as a form XObject, once per output document. */
function embedPdfPage(doc: PDFDocument, b64: string): Promise<{ ref: PDFRef; width: number; height: number }> {
  const key = `pdf:${b64.length}:${b64.slice(0, 64)}:${b64.slice(-64)}`;
  let cache = pageCache.get(doc);
  if (!cache) pageCache.set(doc, (cache = new Map()));
  let hit = cache.get(key);
  if (!hit) {
    hit = doc.embedPdf(dataUrlBytes(b64), [0]).then(([page]) => ({ ref: page.ref, width: page.width, height: page.height }));
    hit.catch(() => cache!.delete(key));
    cache.set(key, hit);
  }
  return hit;
}

export interface BuildOptions {
  /** Multiply blend mode for the whole appearance (highlighter). */
  multiply?: boolean;
  /** Appearance bbox; defaults to the paint bounds. */
  bbox?: Rect;
  /**
   * Object opacity. The export writer already prefixes the form with a CA/ca state for it; paths with
   * their own stroke/fill opacity set an absolute alpha, so theirs is multiplied by this.
   */
  opacity?: number;
}

/** Build an AppearanceSpec (ops + resources + bbox) for the paints. */
export async function buildAppearance(ctx: ExportContext, paints: Paint[], opts: BuildOptions = {}): Promise<AppearanceSpec> {
  const pdf = ctx.pdfDoc;
  const gs = new Map<string, { name: string; dict: Record<string, unknown> }>();
  const fonts = new Map<string, PDFRef>();
  const xobjects = new Map<string, PDFRef>();
  const gsName = (dict: Record<string, unknown>) => {
    const k = JSON.stringify(dict);
    let e = gs.get(k);
    if (!e) gs.set(k, (e = { name: `GSd${gs.size}`, dict: { Type: 'ExtGState', ...dict } }));
    return e.name;
  };
  const textRes: TextResources = {
    font(key, ref) {
      let name = key;
      for (let i = 1; fonts.has(name) && fonts.get(name) !== ref; i++) name = `${key}${i}`;
      fonts.set(name, ref);
      return name;
    },
    xobject(prefix, ref) {
      const name = `${prefix}${xobjects.size}`;
      xobjects.set(name, ref);
      return name;
    },
  };

  const out: string[] = [];
  if (opts.multiply) out.push(`/${gsName({ BM: 'Multiply' })} gs`);

  const walk = async (list: Paint[]) => {
    for (const p of list) {
      if (p.t === 'group') {
        out.push('q', `${p.m.map(f).join(' ')} cm`);
        await walk(p.items);
        out.push('Q');
      } else if (p.t === 'path') {
        if (!p.segs.length || (!p.stroke && !p.fill)) continue;
        out.push('q');
        if (p.strokeOpacity !== undefined || p.fillOpacity !== undefined) {
          const op = Math.max(0, Math.min(1, opts.opacity ?? 1));
          const alpha = {
            CA: Number(((p.strokeOpacity ?? 1) * op).toFixed(3)),
            ca: Number(((p.fillOpacity ?? 1) * op).toFixed(3)),
          };
          out.push(`/${gsName(alpha)} gs`);
        }
        if (p.stroke) {
          out.push(`${rgb(p.stroke)} RG`, `${f(Math.max(0.01, p.width ?? 1))} w`, `${CAP[p.cap ?? 'butt']} J`, `${JOIN[p.join ?? 'miter']} j`);
          if (p.dash && p.dash.length) out.push(`[${p.dash.map(f).join(' ')}] 0 d`);
        }
        if (p.fill) out.push(`${rgb(p.fill)} rg`);
        out.push(segOps(p.segs));
        out.push(p.stroke && p.fill ? 'B' : p.fill ? 'f' : 'S');
        out.push('Q');
      } else if (p.t === 'text') {
        out.push(...(await textOps(ctx, p, textRes)));
      } else if (p.t === 'image') {
        const ref = await embedImage(pdf, p.src);
        const name = `Im${xobjects.size}`;
        xobjects.set(name, ref);
        out.push('q', `${f(p.w)} 0 0 ${f(p.h)} ${f(p.x)} ${f(p.y)} cm`, `/${name} Do`, 'Q');
      } else if (p.t === 'pdfpage') {
        const pg = await embedPdfPage(pdf, p.pdf);
        const name = `Pg${xobjects.size}`;
        xobjects.set(name, pg.ref);
        const sx = pg.width > 0 ? p.w / pg.width : 1;
        const sy = pg.height > 0 ? p.h / pg.height : 1;
        out.push('q', `${f(sx)} 0 0 ${f(sy)} ${f(p.x)} ${f(p.y)} cm`, `/${name} Do`, 'Q');
      }
    }
  };
  await walk(paints);

  const res: Record<string, unknown> = {};
  if (gs.size) res.ExtGState = Object.fromEntries([...gs.values()].map((e) => [e.name, pdf.context.obj(e.dict as never)]));
  if (fonts.size) res.Font = Object.fromEntries(fonts);
  if (xobjects.size) res.XObject = Object.fromEntries(xobjects);
  const resources = Object.keys(res).length ? (pdf.context.obj(res as never) as unknown as PDFDict) : undefined;
  const bounds = opts.bbox ?? paintBounds(paints);
  return { ops: out.join('\n'), resources, bbox: bounds ? inflate(bounds, 0.5) : undefined };
}
