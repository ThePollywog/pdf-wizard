/**
 * "New bookmarks from structure": builds bookmarks from the heading elements (H, H1…H6, Title)
 * of a tagged PDF's structure tree (via pdf.js getStructTree + marked-content text).
 */
import type { DocId } from '@/core/types';
import { actions, getDoc } from '@/core/store';
import * as engine from '@/core/engine';
import { canEdit, ellipsize, errMsg } from '../util';
import { newItem, type BmItem } from './model';
import { outlineOf } from './actions';
import { bmUi, commitOutline } from './store';

interface StructNode {
  role?: string;
  type?: string;
  id?: string;
  children?: StructNode[];
}
interface Heading {
  level: number;
  role: string;
  text: string;
  pageIndex: number;
  top: number | null;
}

const HEADING = /^(H([1-6])?|Title)$/;

async function collectHeadings(docId: DocId, report: (p: number) => void): Promise<Heading[]> {
  const pdf = await engine.awaitPdf(docId);
  const doc = getDoc(docId)!;
  const out: Heading[] = [];
  for (let i = 0; i < pdf.numPages; i++) {
    report(i / pdf.numPages);
    const page = await pdf.getPage(i + 1);
    const tree = (await page.getStructTree().catch(() => null)) as StructNode | null;
    if (!tree?.children?.length) continue;
    const content = await page.getTextContent({ includeMarkedContent: true });
    // Marked-content id → text and top-most baseline.
    const texts = new Map<string, { text: string; top: number | null }>();
    const stack: string[] = [];
    for (const raw of content.items as unknown as { type?: string; id?: string; str?: string; transform?: number[] }[]) {
      if (raw.type === 'beginMarkedContentProps' || raw.type === 'beginMarkedContent') {
        stack.push(raw.id ?? '');
        continue;
      }
      if (raw.type === 'endMarkedContent') {
        stack.pop();
        continue;
      }
      const id = stack.findLast((x) => !!x);
      if (!id || typeof raw.str !== 'string') continue;
      const t = raw.transform ?? [1, 0, 0, 1, 0, 0];
      const top = t[5] + Math.hypot(t[2], t[3]);
      const e = texts.get(id) ?? { text: '', top: null };
      e.text += raw.str;
      e.top = e.top === null ? top : Math.max(e.top, top);
      texts.set(id, e);
    }
    const walk = (n: StructNode) => {
      const m = n.role ? HEADING.exec(n.role) : null;
      if (m) {
        let text = '';
        let top: number | null = null;
        const gather = (c: StructNode) => {
          if (c.type === 'content' && c.id) {
            const t = texts.get(c.id);
            if (t) {
              text += t.text;
              if (t.top !== null) top = top === null ? t.top : Math.max(top, t.top);
            }
          }
          c.children?.forEach(gather);
        };
        n.children?.forEach(gather);
        text = text.replace(/\s+/g, ' ').trim();
        if (text) out.push({ level: m[1] === 'Title' ? 0 : Number(m[2] ?? 1), role: n.role!, text, pageIndex: i, top: top === null ? null : Math.min(top + 2, doc.pages[i]?.view[3] ?? top) });
        return;
      }
      n.children?.forEach(walk);
    };
    walk(tree);
  }
  return out;
}

export async function bookmarksFromStructure(docId: DocId) {
  if (!canEdit(docId)) return;
  const pdf = await engine.awaitPdf(docId).catch(() => null);
  if (!pdf) return;
  const mark = await pdf.getMarkInfo().catch(() => null);
  const headings = await actions.withBusy('Reading document structure…', async (report) => {
    try {
      return await collectHeadings(docId, report);
    } catch (e) {
      throw new Error(`Couldn't read the document structure: ${errMsg(e)}`);
    }
  });
  if (!headings) return;
  if (!headings.length) {
    actions.toast(mark?.Marked ? 'No headings were found in the document structure.' : 'This document is not tagged, so there is no structure to create bookmarks from.', { kind: 'info' });
    return;
  }
  const doc = getDoc(docId);
  if (!doc) return;
  // Nest by heading level under a new "Untitled" parent, like desktop PDF editors.
  const parent = newItem({ title: 'Untitled', open: true, pageId: doc.pages[headings[0].pageIndex]?.id ?? null });
  const stack: { level: number; item: BmItem }[] = [{ level: -1, item: parent }];
  for (const h of headings) {
    const item = newItem({ title: ellipsize(h.text, 128), pageId: doc.pages[h.pageIndex]?.id ?? null, top: h.top, open: false });
    while (stack.length > 1 && stack[stack.length - 1].level >= h.level) stack.pop();
    const p = stack[stack.length - 1].item;
    p.children = [...p.children, item];
    if (p !== parent) p.open = false;
    stack.push({ level: h.level, item });
  }
  commitOutline(docId, [...outlineOf(docId), parent], 'New bookmarks from structure');
  bmUi.patch(docId, { selected: parent.id, renaming: null });
  actions.toast(`Created ${headings.length} bookmark${headings.length === 1 ? '' : 's'} from the document structure.`, { kind: 'success' });
}
