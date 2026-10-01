/**
 * AcroForm helpers for Fill & Sign: field inventory (count + tab stops in reading order across pages),
 * keyboard / Next-Previous navigation that scrolls fields into view (pages are virtualized, so the
 * browser's own Tab order cannot leave the mounted pages), "Highlight fields" and "Clear form".
 *
 * Form values live in pdf.js' annotationStorage (see core/engine/forms.ts); clearing resets the storage
 * to the field defaults (exactly like a PDF ResetForm action), resets the mounted widgets and then
 * commits the values into the base bytes as one undoable step.
 */
import { useEffect, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { DocId, PageInfo, Rect } from '@/core/types';
import { actions, getDoc, useApp, useDoc } from '@/core/store';
import { PDFName, PDFRadioGroup } from '@cantoo/pdf-lib';
import * as engine from '@/core/engine';
import { SAVE_OPTIONS } from '@/core/engine/lib';
import { enqueue } from '@/core/engine/state';
import { confirmDialog } from '@/core/ui';
import { rectToView } from '@/core/geometry';
import { getPageElement } from '@/core/viewer';
import { makeViewport, totalRotation } from '@/core/viewer/viewport';
import { useFillSign } from './store';

export type WidgetType = 'text' | 'checkbox' | 'radiobutton' | 'combobox' | 'listbox';
const FILLABLE: ReadonlySet<string> = new Set(['text', 'checkbox', 'radiobutton', 'combobox', 'listbox']);

export interface FormWidget {
  id: string;
  name: string;
  type: WidgetType;
  pageIndex: number;
  /** User-space rect. */
  rect: Rect;
  /** Current value in the file (pdf.js field object `value`). */
  value: unknown;
  defaultValue: unknown;
  exportValues: unknown;
  multiple: boolean;
}

/** One keyboard stop: a field widget, or a whole radio group on one page. */
export interface FormStop {
  name: string;
  pageIndex: number;
  rect: Rect;
  /** Widget ids (radio groups have several; the checked one gets focus). */
  ids: string[];
}

export interface FormInfo {
  /** Number of fillable fields (by field name). */
  count: number;
  widgets: FormWidget[];
  stops: FormStop[];
}

interface RawField {
  id?: string;
  type?: string;
  page?: number;
  rect?: number[];
  editable?: boolean;
  hidden?: boolean;
  value?: unknown;
  defaultValue?: unknown;
  exportValues?: unknown;
  multipleSelection?: boolean;
}

const EMPTY_INFO: FormInfo = { count: 0, widgets: [], stops: [] };
const cache = new WeakMap<PDFDocumentProxy, Promise<FormInfo>>();

/** Field inventory of a loaded document (cached per pdf.js proxy). */
export function loadForm(pdf: PDFDocumentProxy): Promise<FormInfo> {
  let p = cache.get(pdf);
  if (!p) {
    p = readForm(pdf).catch((e) => {
      console.warn('[fill-sign] could not read form fields', e);
      return EMPTY_INFO;
    });
    cache.set(pdf, p);
  }
  return p;
}

/** Reactive field inventory of a document (null while loading / no pdf). */
export function useFormInfo(docId: DocId | null | undefined): FormInfo | null {
  const pdf = useDoc(docId, (d) => (d && d.pdf && d.pdfVersion === d.version ? d.pdf : null));
  const [info, setInfo] = useState<{ pdf: PDFDocumentProxy; info: FormInfo } | null>(null);
  useEffect(() => {
    if (!pdf) return;
    let alive = true;
    void loadForm(pdf).then((i) => alive && setInfo({ pdf, info: i }));
    return () => {
      alive = false;
    };
  }, [pdf]);
  if (!pdf) return info?.info ?? null;
  return info && info.pdf === pdf ? info.info : (info?.info ?? null);
}

async function readForm(pdf: PDFDocumentProxy): Promise<FormInfo> {
  const objs = (await pdf.getFieldObjects()) as Map<string, RawField[]> | Record<string, RawField[]> | null;
  if (!objs) return EMPTY_INFO;
  const entries: [string, RawField[]][] = objs instanceof Map ? [...objs.entries()] : Object.entries(objs);
  const widgets: FormWidget[] = [];
  const names = new Set<string>();
  for (const [name, list] of entries) {
    for (const f of list ?? []) {
      if (!f?.id || !f.type || !FILLABLE.has(f.type)) continue;
      if (f.editable === false || f.hidden || typeof f.page !== 'number' || f.page < 0 || f.page >= pdf.numPages) continue;
      if (!Array.isArray(f.rect) || f.rect.length !== 4) continue;
      const [x1, y1, x2, y2] = f.rect;
      const rect = { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
      if (rect.width <= 0 || rect.height <= 0) continue;
      widgets.push({
        id: f.id,
        name,
        type: f.type as WidgetType,
        pageIndex: f.page,
        rect,
        value: f.value,
        defaultValue: f.defaultValue,
        exportValues: f.exportValues,
        multiple: !!f.multipleSelection,
      });
      names.add(name);
    }
  }
  // Radio buttons of one group on one page form a single stop.
  const stops: FormStop[] = [];
  const radio = new Map<string, FormStop>();
  for (const w of widgets) {
    if (w.type === 'radiobutton') {
      const key = `${w.name}\u0000${w.pageIndex}`;
      const s = radio.get(key);
      if (s) {
        s.ids.push(w.id);
        continue;
      }
      const stop = { name: w.name, pageIndex: w.pageIndex, rect: w.rect, ids: [w.id] };
      radio.set(key, stop);
      stops.push(stop);
    } else {
      stops.push({ name: w.name, pageIndex: w.pageIndex, rect: w.rect, ids: [w.id] });
    }
  }
  return { count: names.size, widgets, stops };
}

/** Stops in reading order (page, then rows top → bottom, then left → right) for the current rotation. */
export function orderedStops(info: FormInfo, pages: PageInfo[], viewRotation: number): FormStop[] {
  const keyed = info.stops.map((s) => {
    const page = pages[s.pageIndex];
    if (!page) return { s, top: 0, left: 0 };
    const vp = makeViewport(page, 1, totalRotation(page, viewRotation));
    const b = rectToView(vp, s.rect);
    return { s, top: b.top, left: b.left };
  });
  const byPage = new Map<number, typeof keyed>();
  for (const k of keyed) {
    const list = byPage.get(k.s.pageIndex) ?? [];
    list.push(k);
    byPage.set(k.s.pageIndex, list);
  }
  const out: FormStop[] = [];
  for (const pi of [...byPage.keys()].sort((a, b) => a - b)) {
    const list = byPage.get(pi)!.sort((a, b) => a.top - b.top || a.left - b.left);
    let row: typeof list = [];
    let rowTop = -Infinity;
    const flush = () => {
      row.sort((a, b) => a.left - b.left).forEach((k) => out.push(k.s));
      row = [];
    };
    for (const k of list) {
      if (k.top - rowTop > 4) {
        flush();
        rowTop = k.top;
      }
      row.push(k);
    }
    flush();
  }
  return out;
}

// ── focus tracking & navigation ──────────────────────────────────────────────

/** Last focused widget id per document (for Next / Previous from the panel). */
const lastFocused = new Map<DocId, string>();

const WIDGET_SELECTOR = '.annotationLayer [data-element-id]';

function docIdOfElement(el: Element): DocId | null {
  return el.closest<HTMLElement>('.pdfwizard-viewer[data-doc-id]')?.dataset.docId ?? null;
}

function widgetElement(docId: DocId, stop: FormStop): HTMLElement | null {
  const pageEl = getPageElement(docId, stop.pageIndex);
  if (!pageEl) return null;
  const els = stop.ids
    .map((id) => pageEl.querySelector<HTMLElement>(`.annotationLayer [data-element-id="${CSS.escape(id)}"]`))
    .filter((e): e is HTMLElement => !!e);
  if (els.length === 0) return null;
  return els.find((e) => (e as HTMLInputElement).checked) ?? els[0];
}

const sleepFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/** Scroll a field into view and focus it (waits for the page's annotation layer to be built). */
export async function focusStop(docId: DocId, stop: FormStop): Promise<boolean> {
  actions.goToPage(docId, stop.pageIndex, { rect: stop.rect });
  const t0 = performance.now();
  for (;;) {
    const el = widgetElement(docId, stop);
    if (el && el.isConnected) {
      el.focus({ preventScroll: true });
      if (document.activeElement === el) {
        lastFocused.set(docId, el.dataset.elementId ?? stop.ids[0]);
        return true;
      }
    }
    if (performance.now() - t0 > 3000) return false;
    await sleepFrame();
  }
}

async function stopsFor(docId: DocId): Promise<FormStop[]> {
  const d = getDoc(docId);
  if (!d?.pdf || d.pdfVersion !== d.version) return [];
  const info = await loadForm(d.pdf);
  const cur = getDoc(docId);
  if (!cur) return [];
  return orderedStops(info, cur.pages, cur.view.rotation);
}

/** Move to the next (dir 1) / previous (dir -1) field relative to `fromId` (or the last focused field). */
export async function moveField(docId: DocId, dir: 1 | -1, fromId?: string | null): Promise<boolean> {
  const stops = await stopsFor(docId);
  if (stops.length === 0) return false;
  const from = fromId ?? lastFocused.get(docId) ?? null;
  const cur = from ? stops.findIndex((s) => s.ids.includes(from)) : -1;
  const next = cur < 0 ? (dir > 0 ? 0 : stops.length - 1) : (cur + dir + stops.length) % stops.length;
  return focusStop(docId, stops[next]);
}

/** Tab / Shift+Tab inside a form widget → next / previous field in reading order, across pages. */
function onKeyDown(e: KeyboardEvent) {
  if (e.key !== 'Tab' || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.isComposing) return;
  const t = e.target;
  if (!(t instanceof HTMLElement) || !t.matches(WIDGET_SELECTOR) || !t.closest('.pdfwizard-page')) return;
  const docId = docIdOfElement(t);
  if (!docId || !getDoc(docId)) return;
  if (useApp.getState().modals.length) return;
  e.preventDefault();
  void moveField(docId, e.shiftKey ? -1 : 1, t.dataset.elementId ?? null);
}

function onFocusIn(e: FocusEvent) {
  const t = e.target;
  if (!(t instanceof HTMLElement) || !t.matches(WIDGET_SELECTOR)) return;
  const docId = docIdOfElement(t);
  if (docId && t.dataset.elementId) lastFocused.set(docId, t.dataset.elementId);
}

export function installFormNavigation(): () => void {
  window.addEventListener('keydown', onKeyDown);
  document.addEventListener('focusin', onFocusIn);
  return () => {
    window.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('focusin', onFocusIn);
  };
}

// ── highlight ────────────────────────────────────────────────────────────────

const PLAIN_CLASS = 'fill-sign-fields-plain';

/** Reflect the "Highlight fields" preference on the document element (CSS in styles.css). */
export function installHighlightClass(): () => void {
  const apply = (on: boolean) => document.documentElement.classList.toggle(PLAIN_CLASS, !on);
  apply(useFillSign.getState().highlight);
  const unsub = useFillSign.subscribe((s, prev) => {
    if (s.highlight !== prev.highlight) apply(s.highlight);
  });
  return () => {
    unsub();
    document.documentElement.classList.remove(PLAIN_CLASS);
  };
}

// ── clear form ───────────────────────────────────────────────────────────────

function defaultStorageValue(w: FormWidget): { value: unknown } {
  switch (w.type) {
    case 'checkbox':
    case 'radiobutton':
      return { value: w.defaultValue === w.exportValues };
    case 'combobox':
    case 'listbox':
      return { value: (w.defaultValue as string | string[] | null | undefined) || '' };
    default:
      return { value: (w.defaultValue as string | null | undefined) || '' };
  }
}

/** Comparable form of a field value ('' = empty / Off). */
function valueKey(w: FormWidget, v: unknown): string {
  if (Array.isArray(v)) return v.map(String).join('\u0000');
  if (v === null || v === undefined || v === '') return '';
  if ((w.type === 'checkbox' || w.type === 'radiobutton') && v === 'Off') return '';
  return String(v);
}

const atDefaults = (info: FormInfo) => info.widgets.every((w) => valueKey(w, w.value) === valueKey(w, w.defaultValue));

/**
 * pdf.js' saveDocument() can switch radio widgets off but never clears the group's /V, so a
 * reset group would come back checked. Set each group's value (and its widgets' /AS) to the default.
 */
async function resetRadioGroups(bytes: Uint8Array, groups: Map<string, string | null>): Promise<Uint8Array> {
  const lib = await engine.loadLib(bytes);
  let changed = false;
  for (const field of lib.getForm().getFields()) {
    if (!(field instanceof PDFRadioGroup) || !groups.has(field.getName())) continue;
    const dv = groups.get(field.getName());
    const target = PDFName.of(dv && dv !== 'Off' ? dv : 'Off');
    try {
      field.acroField.setValue(field.acroField.getOnValues().includes(target) ? target : PDFName.of('Off'));
      changed = true;
    } catch (e) {
      console.warn('[fill-sign] could not reset radio group', field.getName(), e);
    }
  }
  if (!changed) return bytes;
  const out = await lib.save(SAVE_OPTIONS);
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

/** Reset every fillable field to its default value (with confirmation). One undoable "Clear form" step. */
export async function clearForm(docId: DocId): Promise<void> {
  const d = getDoc(docId);
  if (!d) return;
  const ok = await confirmDialog({
    title: 'Clear form',
    message: 'Clear all the values entered in the form fields of this document? You can undo this.',
    confirmLabel: 'Clear form',
    danger: true,
  });
  if (!ok || !getDoc(docId)) return;
  try {
    const readOnly = engine.isReadOnly(docId);
    // Bake pending values first so undo returns to exactly what was entered.
    if (!readOnly) await engine.commitFormValues(docId);
    const first = await loadForm(await engine.awaitPdf(docId));
    if (first.widgets.length === 0) {
      actions.toast('This document has no form fields to clear.', { kind: 'info' });
      return;
    }
    if (!readOnly && atDefaults(first)) {
      actions.toast('The form fields are already empty.', { kind: 'info' });
      return;
    }
    const cleared = await enqueue(docId, async () => {
      const cur = getDoc(docId);
      if (!cur?.pdf || cur.pdfVersion !== cur.version) throw new Error('The document is still loading. Try again.');
      const pdf = cur.pdf;
      const info = await loadForm(pdf);
      const storage = pdf.annotationStorage;
      for (const w of info.widgets) storage.setValue(w.id, defaultStorageValue(w));
      // Reset the widgets that are currently mounted (pdf.js listens for "resetform").
      const ids = new Set(info.widgets.map((w) => w.id));
      const root = document.querySelector(`.pdfwizard-viewer[data-doc-id="${CSS.escape(docId)}"]`);
      root?.querySelectorAll<HTMLElement>(WIDGET_SELECTOR).forEach((el) => {
        if (el.dataset.elementId && ids.has(el.dataset.elementId)) el.dispatchEvent(new Event('resetform'));
      });
      if (readOnly) return true;
      const radios = new Map<string, string | null>();
      for (const w of info.widgets) if (w.type === 'radiobutton') radios.set(w.name, typeof w.defaultValue === 'string' ? w.defaultValue : null);
      const saved = new Uint8Array(await pdf.saveDocument());
      const bytes = radios.size ? await resetRadioGroups(saved, radios) : saved;
      const now = getDoc(docId);
      if (!now || now.version !== cur.version) throw new Error('The document changed while clearing the form. Try again.');
      storage.resetModified();
      actions.commitBytes(docId, { bytes, pages: now.pages, objects: now.objects, order: now.order, label: 'Clear form' });
      return true;
    });
    if (cleared) actions.toast('Form cleared', { kind: 'success' });
  } catch (e) {
    console.error('[fill-sign] clear form failed', e);
    actions.toast(`Clear form failed: ${e instanceof Error ? e.message : String(e)}`, { kind: 'error' });
  }
}
