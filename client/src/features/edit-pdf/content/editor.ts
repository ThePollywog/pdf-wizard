/**
 * Applies content edits to one page of a pdf-lib document:
 *  - byte splices on page content streams (written as new stream objects, so shared streams stay intact)
 *  - splices inside Form XObjects (the form is cloned for this one use and the parent's `Do` renamed)
 *  - new content appended on top of the page (wrapped in q/Q when the page leaves a dirty state)
 *  - private page resources for new fonts / images.
 */
import {
  PDFArray, PDFDict, PDFName, PDFRef, PDFStream, type PDFContext, type PDFObject, type PDFPage,
} from '@cantoo/pdf-lib';
import { fromLatin1, nameToken } from './parser';
import type { PageContent, Source } from './interpreter';
import type { Splice } from './rewrite';
import { almostEqual, IDENTITY } from './matrix';
import { dictOf, freshName, resolve } from './pdfobj';

const N = (n: string) => PDFName.of(n);

export class ContentEditor {
  private splices = new Map<number, Splice[]>();
  private appended: string[] = [];
  private prepended: string[] = [];
  private pageRes: PDFDict | null = null;

  constructor(
    readonly ctx: PDFContext,
    readonly page: PDFPage,
    readonly content: PageContent,
  ) {}

  splice(s: Splice | Splice[] | null): void {
    if (!s) return;
    for (const x of Array.isArray(s) ? s : [s]) {
      let arr = this.splices.get(x.source);
      if (!arr) this.splices.set(x.source, (arr = []));
      arr.push(x);
    }
  }

  /** Content drawn on top of the page, in default graphics state (user space). */
  append(ops: string): void {
    if (ops.trim()) this.appended.push(ops);
  }

  /** Content drawn below everything else on the page (user space). */
  prepend(ops: string): void {
    if (ops.trim()) this.prepended.push(ops);
  }

  /** The page's own (unshared) resources dict with private Font/XObject/ExtGState subdicts. */
  resources(): PDFDict {
    if (this.pageRes) return this.pageRes;
    const cur = this.content.resources;
    const copy = PDFDict.withContext(this.ctx);
    if (cur) for (const [k, v] of cur.entries()) copy.set(k, v);
    for (const key of ['Font', 'XObject', 'ExtGState', 'ColorSpace']) {
      const sub = dictOf(this.ctx, copy.get(N(key)));
      if (!sub) continue;
      const c = PDFDict.withContext(this.ctx);
      for (const [k, v] of sub.entries()) c.set(k, v);
      copy.set(N(key), c);
    }
    this.page.node.set(N('Resources'), copy);
    this.pageRes = copy;
    return copy;
  }

  private sub(kind: 'Font' | 'XObject' | 'ExtGState'): PDFDict {
    const res = this.resources();
    let d = res.get(N(kind));
    if (!(d instanceof PDFDict)) {
      d = PDFDict.withContext(this.ctx);
      res.set(N(kind), d);
    }
    return d as PDFDict;
  }

  /**
   * Name for `obj` in the page's resources of `kind`: reuses an existing entry pointing to the
   * same object, otherwise adds one with a fresh `prefix`N name.
   */
  resourceName(kind: 'Font' | 'XObject' | 'ExtGState', obj: PDFObject, prefix: string): string {
    const sub = this.sub(kind);
    for (const [k, v] of sub.entries()) if (v === obj || (v instanceof PDFRef && obj instanceof PDFRef && v.toString() === obj.toString())) return k.decodeText();
    const ref = obj instanceof PDFRef ? obj : this.ctx.register(obj);
    const name = freshName(sub, prefix);
    sub.set(N(name), ref);
    return name;
  }

  /** Page resource name of a font drawn from `source` under `name` (for re-emitting glyphs on the page). */
  fontForPage(sourceIndex: number, name: string, fontObj: PDFObject | undefined): string | null {
    const src = this.content.sources[sourceIndex];
    if (!fontObj) return null;
    if (src.kind === 'page') {
      const pageFonts = dictOf(this.ctx, this.content.resources?.get(N('Font')));
      if (pageFonts?.get(N(name)) === fontObj) return name;
    }
    return this.resourceName('Font', fontObj, 'EdF');
  }

  get hasChanges(): boolean {
    return this.splices.size > 0 || this.appended.length > 0 || this.prepended.length > 0;
  }

  commit(): void {
    const { ctx, content } = this;
    const newBytes = new Map<number, Uint8Array>();
    for (const [si, list] of this.splices) newBytes.set(si, applySplices(content.sources[si].bytes, list));

    // forms bottom-up: clone the changed form and rename the parent's Do
    const formIdx = [...newBytes.keys()].filter((i) => content.sources[i].kind === 'form').sort((a, b) => b - a);
    const pending = new Set(formIdx);
    while (pending.size) {
      const i = Math.max(...pending);
      pending.delete(i);
      const src = content.sources[i];
      const bytes = newBytes.get(i)!;
      const parent = content.sources[src.parent!];
      const cloneRef = this.cloneForm(src, bytes);
      const newName = this.addFormToParent(parent, cloneRef);
      const doOp = parent.ops[src.parentOp!];
      const nameArg = doOp.args[0];
      const list = [...(this.splices.get(parent.index) ?? []), { source: parent.index, start: nameArg.s, end: nameArg.e, text: nameToken(newName) }];
      this.splices.set(parent.index, list);
      newBytes.set(parent.index, applySplices(parent.bytes, list));
      if (parent.kind === 'form') pending.add(parent.index);
    }

    // page streams
    const contents = resolve(ctx, this.page.node.get(N('Contents')));
    const entries: PDFObject[] =
      contents instanceof PDFArray ? contents.asArray().slice() : contents instanceof PDFStream ? [this.page.node.get(N('Contents'))!] : [];
    for (const [si, bytes] of newBytes) {
      const src = content.sources[si];
      if (src.kind !== 'page') continue;
      const ref = ctx.register(ctx.flateStream(bytes));
      const at = src.contentIndex < 0 ? 0 : src.contentIndex;
      if (at < entries.length) entries[at] = ref;
    }
    if (this.appended.length) {
      const clean = content.endDepth === 0 && almostEqual(content.endCtm, IDENTITY);
      if (!clean) {
        entries.unshift(ctx.register(ctx.flateStream(fromLatin1('q\n'))));
        entries.push(ctx.register(ctx.flateStream(fromLatin1('\n' + 'Q\n'.repeat(Math.max(0, content.endDepth) + 1)))));
      }
      entries.push(ctx.register(ctx.flateStream(fromLatin1('\n' + this.appended.join('\n') + '\n'))));
    }
    if (this.prepended.length) entries.unshift(ctx.register(ctx.flateStream(fromLatin1('q\n' + this.prepended.join('\n') + '\nQ\n'))));
    if (newBytes.size || this.appended.length || this.prepended.length) {
      if (entries.length === 1 && !(contents instanceof PDFArray)) this.page.node.set(N('Contents'), entries[0]);
      else this.page.node.set(N('Contents'), ctx.obj(entries));
    }
  }

  private cloneForm(src: Source, bytes: Uint8Array): PDFRef {
    const { ctx } = this;
    const dict: Record<string, PDFObject> = {};
    for (const [k, v] of src.stream!.dict.entries()) {
      const key = k.decodeText();
      if (key === 'Length' || key === 'Filter' || key === 'DecodeParms') continue;
      dict[key] = v;
    }
    const stream = ctx.flateStream(bytes, dict);
    // private resources so later additions don't leak into other uses of the original form
    const res = dictOf(ctx, src.stream!.dict.get(N('Resources')));
    if (res) {
      const copy = PDFDict.withContext(ctx);
      for (const [k, v] of res.entries()) copy.set(k, v);
      const xo = dictOf(ctx, copy.get(N('XObject')));
      if (xo) {
        const c = PDFDict.withContext(ctx);
        for (const [k, v] of xo.entries()) c.set(k, v);
        copy.set(N('XObject'), c);
      }
      stream.dict.set(N('Resources'), copy);
    }
    return ctx.register(stream);
  }

  private addFormToParent(parent: Source, ref: PDFRef): string {
    if (parent.kind === 'page') return this.resourceName('XObject', ref, 'EdFm');
    // the parent form is (or will be) cloned: its clone's resources are private once cloned; until
    // then we add the name to a private copy that cloneForm picks up through the stream dict.
    const { ctx } = this;
    const res = dictOf(ctx, parent.stream!.dict.get(N('Resources'))) ?? parent.resources;
    const copy = PDFDict.withContext(ctx);
    if (res) for (const [k, v] of res.entries()) copy.set(k, v);
    const xo = PDFDict.withContext(ctx);
    const old = dictOf(ctx, copy.get(N('XObject')));
    if (old) for (const [k, v] of old.entries()) xo.set(k, v);
    const name = freshName(xo, 'EdFm');
    xo.set(N(name), ref);
    copy.set(N('XObject'), xo);
    // The parent form is cloned right after (cloneForm copies this Resources entry); the original
    // parent object only gains an unused entry.
    parent.stream!.dict.set(N('Resources'), copy);
    return name;
  }
}

export function applySplices(bytes: Uint8Array, list: Splice[]): Uint8Array {
  const sorted = [...list].sort((a, b) => a.start - b.start || a.end - b.end);
  const parts: Uint8Array[] = [];
  let pos = 0;
  for (const s of sorted) {
    if (s.start < pos) continue; // overlapping splice: first one wins
    parts.push(bytes.subarray(pos, s.start));
    parts.push(fromLatin1(s.text));
    pos = s.end;
  }
  parts.push(bytes.subarray(pos));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
