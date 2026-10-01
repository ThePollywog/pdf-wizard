/**
 * Document Properties → Custom: non-standard keys of the document Info dictionary. Edited values
 * live in doc.meta.navCustom (undoable) and are written by an export hook after core-metadata.
 */
import { PDFHexString, PDFName, PDFString, type PDFDict, type PDFObject } from '@cantoo/pdf-lib';
import type { DocId, ExportHook } from '@/core/types';
import * as engine from '@/core/engine';
import { lookup, lookupDict } from '@/core/engine/lib';
import { getDoc } from '@/core/store';
import type { NavMeta } from './initialView';

export const STANDARD_INFO_KEYS = new Set(['Title', 'Author', 'Subject', 'Keywords', 'Creator', 'Producer', 'CreationDate', 'ModDate', 'Trapped']);

const cache = new WeakMap<object, Promise<Record<string, string>>>();

/**
 * PDF names are byte sequences; by convention non-ASCII names are UTF-8. pdf.js and pdf-lib both hand
 * names over as "binary" strings (one char per byte), so convert at the boundary.
 */
export function nameKeyToText(binary: string): string {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7f]*$/.test(binary)) return binary;
  const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0) & 0xff);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return binary; // not UTF-8: treat as Latin-1 (what the chars already are)
  }
}

/** A PDF name for `text`, UTF-8 encoded (pdf-lib escapes every non-regular byte as #xx). */
export function nameOf(text: string): PDFName {
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7f]*$/.test(text)) return PDFName.of(text);
  let binary = '';
  for (const b of new TextEncoder().encode(text)) binary += String.fromCharCode(b);
  return PDFName.of(binary);
}

function stringify(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (typeof v === 'object' && 'name' in (v as object)) return String((v as { name: unknown }).name);
  return '';
}

/** Custom properties stored in the file (pdf.js getMetadata().info.Custom). */
export function readCustom(docId: DocId): Promise<Record<string, string>> {
  return engine.awaitPdf(docId).then((pdf) => {
    let job = cache.get(pdf);
    if (!job) {
      job = pdf
        .getMetadata()
        .then((m) => {
          // pdf.js v6 returns a Map here (older versions a plain object).
          const custom = ((m.info ?? {}) as { Custom?: Map<string, unknown> | Record<string, unknown> }).Custom ?? {};
          const entries = custom instanceof Map ? [...custom.entries()] : Object.entries(custom);
          const out: Record<string, string> = {};
          for (const [raw, v] of entries) {
            const k = nameKeyToText(raw);
            if (!STANDARD_INFO_KEYS.has(k)) out[k] = stringify(v);
          }
          return out;
        })
        .catch(() => ({}));
      cache.set(pdf, job);
    }
    return job;
  });
}

export async function currentCustom(docId: DocId): Promise<Record<string, string>> {
  const edited = (getDoc(docId)?.meta as NavMeta | undefined)?.navCustom;
  return edited ?? readCustom(docId);
}

export function sameCustom(a: Record<string, string>, b: Record<string, string>): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => b[k] === a[k]);
}

/** Why `name` can't be used as a custom property name (or null when it can). */
export function customNameError(name: string, existing: Record<string, string>, editing: string | null): string | null {
  const n = name.trim();
  if (!n) return 'Enter a name.';
  if (STANDARD_INFO_KEYS.has(n)) return `“${n}” is a standard property. Edit it on the Description tab.`;
  if (new TextEncoder().encode(n).length > 127) return 'The name is too long.';
  if (/[()<>[\]{}/%]/.test(n)) return 'Names can’t contain ( ) < > [ ] { } / or %.';
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(n)) return 'Names can’t contain control characters.';
  if (n !== editing && Object.prototype.hasOwnProperty.call(existing, n)) return `A property named “${n}” already exists.`;
  return null;
}

export const customInfoHook: ExportHook = {
  id: 'navigation-custom-info',
  order: 210,
  // [lead] only writes what doc.meta / doc.outline hold, which are then unchanged.
  noopWhenUnchanged: true,
  run(ctx) {
    const { purpose } = ctx.options;
    if (purpose === 'print' || purpose === 'bake') return;
    const custom = (ctx.doc.meta as NavMeta).navCustom;
    if (!custom) return;
    const c = ctx.pdfDoc.context;
    const t = c.trailerInfo as { Info?: PDFObject };
    let info = lookupDict(c, t.Info) as PDFDict | undefined;
    if (!info) {
      info = c.obj({}) as PDFDict;
      t.Info = c.register(info);
    }
    // Existing keys keep their original encoding (a Latin-1 name stays Latin-1).
    const existing = new Map<string, PDFName>();
    for (const key of info.keys()) {
      const k = nameKeyToText(key.decodeText());
      if (STANDARD_INFO_KEYS.has(k)) continue;
      if (Object.prototype.hasOwnProperty.call(custom, k)) existing.set(k, key);
      else info.delete(key);
    }
    for (const [k, v] of Object.entries(custom)) {
      const name = existing.get(k) ?? nameOf(k);
      const prev = lookup(c, info.get(name));
      const same = (prev instanceof PDFString || prev instanceof PDFHexString) && prev.decodeText() === v;
      if (!same) info.set(name, PDFHexString.fromText(v));
    }
  },
};
