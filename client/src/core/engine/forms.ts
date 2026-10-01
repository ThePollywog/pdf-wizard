/**
 * AcroForm values live in the pdf.js annotationStorage of `doc.pdf` while the user edits them.
 * They are baked into the base bytes with `pdf.saveDocument()` before any byte change and on export.
 *
 * pdf.js writes some values into the storage while merely *rendering* widgets (e.g. radio groups),
 * so "the storage was touched" is not the same as "the user changed a value": we compare the storage
 * against the field values stored in the file.
 */
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { DocId } from '../types';
import { actions, getDoc } from '../store';
import { enqueue, isReadOnly } from './state';

interface FieldObject {
  id?: string;
  type?: string;
  value?: unknown;
  exportValues?: unknown;
}

const fieldCache = new WeakMap<PDFDocumentProxy, Promise<Map<string, FieldObject>>>();

function fieldsById(pdf: PDFDocumentProxy): Promise<Map<string, FieldObject>> {
  let p = fieldCache.get(pdf);
  if (!p) {
    p = pdf
      .getFieldObjects()
      .then((objs) => {
        const map = new Map<string, FieldObject>();
        if (objs) for (const list of objs.values()) for (const f of list as FieldObject[]) if (f?.id) map.set(f.id, f);
        return map;
      })
      .catch(() => new Map<string, FieldObject>());
    fieldCache.set(pdf, p);
  }
  return p;
}

const asList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x)) : v === null || v === undefined || v === '' ? [] : [String(v)];

function sameAsFile(f: FieldObject, v: unknown): boolean {
  switch (f.type) {
    case 'checkbox':
    case 'radiobutton': {
      const original = f.value !== undefined && f.value !== 'Off' && f.value === f.exportValues;
      const now = typeof v === 'string' ? v !== 'Off' && (f.type === 'checkbox' || v === f.exportValues) : !!v;
      return original === now;
    }
    case 'text':
      return String(v ?? '') === String(f.value ?? '');
    case 'combobox':
    case 'listbox': {
      const a = asList(v);
      const b = asList(f.value);
      return a.length === b.length && a.every((x, i) => x === b[i]);
    }
    case 'button':
    case 'signature':
      return true;
    default:
      return JSON.stringify(v ?? null) === JSON.stringify(f.value ?? null);
  }
}

/** True when the annotation storage holds form values that differ from the ones in the file. */
export async function formsModified(pdf: PDFDocumentProxy): Promise<boolean> {
  const storage = pdf.annotationStorage;
  if (storage.size === 0) return false;
  const fields = await fieldsById(pdf);
  for (const [id, val] of storage as Iterable<[string, unknown]>) {
    if (!val || typeof val !== 'object') continue;
    // pdf.js annotation editors (not form values) are serialized objects with methods.
    if (typeof (val as { serialize?: unknown }).serialize === 'function') continue;
    if (!('value' in (val as object))) continue;
    const f = fields.get(id);
    if (!f) return true;
    if (!sameAsFile(f, (val as { value: unknown }).value)) return true;
  }
  return false;
}

/**
 * Bake modified form values into the base bytes (one undoable "Fill form" step).
 * Must run inside the document queue (see `enqueue`).
 */
export async function commitFormsNow(docId: DocId): Promise<void> {
  const d = getDoc(docId);
  if (!d || !d.pdf || d.pdfVersion !== d.version || isReadOnly(docId)) return;
  const pdf = d.pdf;
  if (!(await formsModified(pdf))) return;
  const bytes = await pdf.saveDocument();
  const cur = getDoc(docId);
  if (!cur || cur.version !== d.version) return;
  pdf.annotationStorage.resetModified();
  actions.commitBytes(docId, {
    bytes: new Uint8Array(bytes),
    pages: cur.pages,
    objects: cur.objects,
    order: cur.order,
    label: 'Fill form',
  });
}

export function commitFormValues(docId: DocId): Promise<void> {
  return enqueue(docId, () => commitFormsNow(docId));
}
