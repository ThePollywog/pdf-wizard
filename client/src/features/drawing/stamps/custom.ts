/**
 * Custom stamps (from an image or a PDF page), persisted in localStorage with a size cap,
 * plus the "current stamp" used by the Stamp tool.
 */
import { create } from 'zustand';
import { PDFDocument } from '@cantoo/pdf-lib';
import { actions, getToolOptions, useApp } from '@/core/store';
import { loadPdfjs } from '@/core/engine';
import { uid } from '@/core/util';
import type { Rotation } from '@/core/types';
import type { StampData } from '../model';
import { CATALOG, dynamicLine, findCatalog } from './catalog';

export interface CustomStamp {
  id: string;
  name: string;
  /** Raster (PNG/JPEG data URL) used on screen and for image stamps in the PDF. */
  src: string;
  w: number;
  h: number;
  /** Base64 one-page PDF for vector stamps made from a PDF page. */
  pdf?: string;
  createdAt: number;
}

const KEY = 'pdfwizard.drawing.customStamps';
/** Total budget for custom stamps in localStorage (characters ≈ bytes). */
export const CUSTOM_CAP = 3_000_000;
const MAX_PX = 800;
const MAX_PDF_B64 = 700_000;

function load(): CustomStamp[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as CustomStamp[]) : [];
    return Array.isArray(list) ? list.filter((s) => s && typeof s.id === 'string' && typeof s.src === 'string') : [];
  } catch {
    return [];
  }
}

export const useCustomStamps = create<{ list: CustomStamp[] }>(() => ({ list: load() }));

const sizeOf = (list: CustomStamp[]) => JSON.stringify(list).length;

function persist(list: CustomStamp[]): boolean {
  const json = JSON.stringify(list);
  if (json.length > CUSTOM_CAP) return false;
  try {
    localStorage.setItem(KEY, json);
  } catch {
    return false;
  }
  useCustomStamps.setState({ list });
  return true;
}

export function customUsage(): { used: number; cap: number } {
  return { used: sizeOf(useCustomStamps.getState().list), cap: CUSTOM_CAP };
}

export function addCustomStamp(s: Omit<CustomStamp, 'id' | 'createdAt'>): CustomStamp | null {
  const base = useCustomStamps.getState().list;
  const stamp: CustomStamp = { ...s, id: uid('cst'), createdAt: Date.now() };
  if (persist([...base, stamp])) return stamp;
  if (stamp.pdf) {
    // Too big as a vector stamp: keep the raster only.
    const raster: CustomStamp = { ...stamp, pdf: undefined };
    if (persist([...base, raster])) return raster;
  }
  actions.toast('Not enough room for this custom stamp. Delete some custom stamps or use a smaller image.', { kind: 'warning' });
  return null;
}

export function renameCustomStamp(id: string, name: string) {
  persist(useCustomStamps.getState().list.map((s) => (s.id === id ? { ...s, name } : s)));
}

export function deleteCustomStamp(id: string) {
  persist(useCustomStamps.getState().list.filter((s) => s.id !== id));
  const cur = getCurrentStamp();
  if (cur?.set === 'custom' && cur.id === id) setCurrentStamp(null);
}

// ── image / PDF → stamp ──────────────────────────────────────────────────────

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('This image could not be read.'));
    img.src = src;
  });
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('The file could not be read.'));
    r.readAsDataURL(file);
  });
}

/** Downscale to MAX_PX and re-encode (PNG keeps transparency; JPEG stays JPEG). */
async function normalizeImage(src: string, jpeg: boolean): Promise<{ src: string; w: number; h: number }> {
  const img = await loadImage(src);
  const k = Math.min(1, MAX_PX / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * k));
  const h = Math.max(1, Math.round(img.naturalHeight * k));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  g.drawImage(img, 0, 0, w, h);
  return { src: jpeg ? c.toDataURL('image/jpeg', 0.9) : c.toDataURL('image/png'), w, h };
}

export async function stampFromImage(file: File): Promise<Omit<CustomStamp, 'id' | 'createdAt'>> {
  const jpeg = /jpe?g$/i.test(file.type) || /\.jpe?g$/i.test(file.name);
  const png = /png$/i.test(file.type) || /\.png$/i.test(file.name);
  if (!jpeg && !png) throw new Error('Choose a PNG or JPG image.');
  const img = await normalizeImage(await readAsDataUrl(file), jpeg);
  return { name: baseName(file.name), ...img };
}

const b64 = (bytes: Uint8Array) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

export async function pdfPageCount(bytes: Uint8Array): Promise<number> {
  const pdf = await loadPdfjs(bytes.slice());
  try {
    return pdf.numPages;
  } finally {
    void pdf.loadingTask.destroy();
  }
}

/** Rasterize page `index` (transparent background) and keep a one-page vector copy when small enough. */
export async function stampFromPdf(bytes: Uint8Array, index: number, name: string): Promise<Omit<CustomStamp, 'id' | 'createdAt'>> {
  const pdf = await loadPdfjs(bytes.slice());
  let raster: { src: string; w: number; h: number };
  try {
    const page = await pdf.getPage(index + 1);
    const vp1 = page.getViewport({ scale: 1 });
    const scale = Math.min(3, MAX_PX / Math.max(vp1.width, vp1.height));
    const vp = page.getViewport({ scale });
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(vp.width));
    c.height = Math.max(1, Math.round(vp.height));
    // pdf.js creates an opaque (alpha: false) context unless it is given one: keep the background transparent.
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('Canvas is not available.');
    await page.render({ canvas: c, canvasContext: ctx, viewport: vp, background: 'rgba(0,0,0,0)' }).promise;
    raster = { src: c.toDataURL('image/png'), w: c.width, h: c.height };
  } finally {
    void pdf.loadingTask.destroy();
  }
  let pdfB64: string | undefined;
  try {
    const src = await PDFDocument.load(bytes, { ignoreEncryption: false, updateMetadata: false });
    const out = await PDFDocument.create();
    const [p] = await out.copyPages(src, [index]);
    out.addPage(p);
    const one = await out.save({ useObjectStreams: true });
    const enc = b64(one);
    if (enc.length <= MAX_PDF_B64) pdfB64 = enc;
  } catch {
    pdfB64 = undefined; // encrypted or damaged: raster only
  }
  return { name, ...raster, pdf: pdfB64 };
}

function baseName(n: string) {
  return n.replace(/\.[^.]+$/, '').slice(0, 60) || 'Custom stamp';
}

// ── current stamp ────────────────────────────────────────────────────────────

export interface StampRef {
  set: StampData['set'];
  id: string;
}
export const STAMP_TOOL = 'stamp';
const CURRENT_KEY = 'current';

export function getCurrentStamp(): StampRef | null {
  const v = getToolOptions(STAMP_TOOL, { [CURRENT_KEY]: null as StampRef | null })[CURRENT_KEY];
  return v && typeof v === 'object' && typeof v.id === 'string' ? v : null;
}
export function useCurrentStamp(): StampRef | null {
  const v = useApp((s) => s.toolOptions[STAMP_TOOL]?.[CURRENT_KEY]) as StampRef | null | undefined;
  return v && typeof v === 'object' && typeof v.id === 'string' ? v : null;
}
export function setCurrentStamp(ref: StampRef | null) {
  actions.setToolOption(STAMP_TOOL, CURRENT_KEY, ref);
}

/** Build the StampData for a stamp reference (null when it no longer exists). */
export function stampDataFor(ref: StampRef, rotation: Rotation, user: string, when = new Date()): StampData | null {
  if (ref.set === 'custom') {
    const c = useCustomStamps.getState().list.find((s) => s.id === ref.id);
    if (!c) return null;
    return { set: 'custom', id: c.id, name: customPdfName(c.name), label: c.name, shape: 'box', image: { src: c.src, w: c.w, h: c.h }, pdf: c.pdf, rotation };
  }
  const s = findCatalog(ref.set, ref.id);
  if (!s) return null;
  return { set: s.set, id: s.id, name: s.name, label: s.label, shape: s.shape, subline: s.set === 'dynamic' ? dynamicLine(user, when) : undefined, rotation };
}

export const customPdfName = (name: string) => `Custom${name.replace(/[^A-Za-z0-9]/g, '').slice(0, 24) || 'Stamp'}`;

export function stampLabelFor(ref: StampRef | null): string {
  if (!ref) return 'No stamp selected';
  if (ref.set === 'custom') return useCustomStamps.getState().list.find((s) => s.id === ref.id)?.name ?? 'Custom stamp';
  const s = CATALOG.find((c) => c.set === ref.set && c.id === ref.id);
  return s ? titleCase(s.label) : 'Stamp';
}
export const titleCase = (s: string) => s.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
