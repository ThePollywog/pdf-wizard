/**
 * Image → PDF conversion (the built-in 'core-images' file handler).
 * One page per image, sized from the image's resolution (JFIF / EXIF / PNG pHYs), 1 px = 1 pt when
 * unknown, capped at the PDF maximum page size. JPEG and PNG are embedded losslessly (EXIF orientation
 * is honoured with a transformation matrix); other formats are decoded by the browser.
 */
import {
  PDFDocument, concatTransformationMatrix, drawObject, popGraphicsState, pushGraphicsState, type PDFImage,
} from '@cantoo/pdf-lib';
import type { FileHandler } from '../types';
import { baseName, readFileBytes } from '../util';

const MAX_PT = 14400;
const MIN_PT = 3;

type Kind = 'png' | 'jpeg' | 'other';

interface ImageInfo {
  kind: Kind;
  dpiX?: number;
  dpiY?: number;
  /** EXIF orientation 1..8 (JPEG only). */
  orientation: number;
}

function sniff(b: Uint8Array): Kind {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  return 'other';
}

const validDpi = (v: number | undefined) => (v !== undefined && Number.isFinite(v) && v >= 72 && v <= 2400 ? v : undefined);

function readExif(b: Uint8Array, start: number, len: number, info: ImageInfo) {
  // start points at "Exif\0\0"
  const tiff = start + 6;
  if (tiff + 8 > b.length) return;
  const le = b[tiff] === 0x49 && b[tiff + 1] === 0x49;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const u16 = (o: number) => dv.getUint16(o, le);
  const u32 = (o: number) => dv.getUint32(o, le);
  const end = Math.min(b.length, start + len);
  const ifd = tiff + u32(tiff + 4);
  if (ifd + 2 > end) return;
  const count = u16(ifd);
  let xres: number | undefined;
  let yres: number | undefined;
  let unit = 2;
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12;
    if (e + 12 > end) break;
    const tag = u16(e);
    const type = u16(e + 2);
    const rational = () => {
      const off = tiff + u32(e + 8);
      if (off + 8 > end) return undefined;
      const d = u32(off + 4);
      return d ? u32(off) / d : undefined;
    };
    if (tag === 0x0112 && type === 3) info.orientation = u16(e + 8);
    else if (tag === 0x011a && type === 5) xres = rational();
    else if (tag === 0x011b && type === 5) yres = rational();
    else if (tag === 0x0128 && type === 3) unit = u16(e + 8);
  }
  if (xres && yres && (unit === 2 || unit === 3)) {
    const f = unit === 3 ? 2.54 : 1;
    info.dpiX ??= validDpi(xres * f);
    info.dpiY ??= validDpi(yres * f);
  }
}

function jpegInfo(b: Uint8Array): ImageInfo {
  const info: ImageInfo = { kind: 'jpeg', orientation: 1 };
  let jfif: { x?: number; y?: number } | null = null;
  let exifSeen = false;
  let i = 2;
  while (i + 4 < b.length) {
    if (b[i] !== 0xff) break;
    const marker = b[i + 1];
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    if (marker === 0xda || marker === 0xd9) break;
    const len = (b[i + 2] << 8) | b[i + 3];
    const seg = i + 4;
    if (marker === 0xe0 && b[seg] === 0x4a && b[seg + 1] === 0x46 && b[seg + 2] === 0x49 && b[seg + 3] === 0x46 && b[seg + 4] === 0) {
      const units = b[seg + 7];
      const x = (b[seg + 8] << 8) | b[seg + 9];
      const y = (b[seg + 10] << 8) | b[seg + 11];
      if (units === 1) jfif = { x, y };
      else if (units === 2) jfif = { x: x * 2.54, y: y * 2.54 };
    } else if (!exifSeen && marker === 0xe1 && b[seg] === 0x45 && b[seg + 1] === 0x78 && b[seg + 2] === 0x69 && b[seg + 3] === 0x66) {
      exifSeen = true;
      try {
        readExif(b, seg, len - 2, info);
      } catch {
        /* malformed EXIF */
      }
    }
    i += 2 + len;
  }
  if (jfif) {
    // JFIF density wins when present (EXIF values are often camera defaults).
    const x = validDpi(jfif.x);
    const y = validDpi(jfif.y);
    if (x && y) {
      info.dpiX = x;
      info.dpiY = y;
    }
  }
  if (info.orientation < 1 || info.orientation > 8) info.orientation = 1;
  return info;
}

function pngInfo(b: Uint8Array): ImageInfo {
  const info: ImageInfo = { kind: 'png', orientation: 1 };
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let i = 8;
  while (i + 12 <= b.length) {
    const len = dv.getUint32(i);
    const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
    if (type === 'pHYs' && len >= 9) {
      const x = dv.getUint32(i + 8);
      const y = dv.getUint32(i + 12);
      if (b[i + 16] === 1) {
        info.dpiX = validDpi(x * 0.0254);
        info.dpiY = validDpi(y * 0.0254);
      }
      break;
    }
    if (type === 'IDAT' || type === 'IEND') break;
    i += 12 + len;
  }
  return info;
}

async function decodeToPng(file: Blob): Promise<{ png: Uint8Array; width: number; height: number }> {
  let source: CanvasImageSource;
  let width = 0;
  let height = 0;
  let cleanup = () => {};
  const isSvg = file.type === 'image/svg+xml' || (file instanceof File && /\.svg$/i.test(file.name));
  if (!isSvg && typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file);
      source = bmp;
      width = bmp.width;
      height = bmp.height;
      cleanup = () => bmp.close();
    } catch {
      source = undefined as unknown as CanvasImageSource;
    }
  }
  if (!width) {
    const url = URL.createObjectURL(isSvg && !file.type ? new Blob([file], { type: 'image/svg+xml' }) : file);
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    try {
      await img.decode();
    } catch {
      URL.revokeObjectURL(url);
      throw new Error('The image could not be decoded.');
    }
    width = img.naturalWidth || (isSvg ? 816 : 0);
    height = img.naturalHeight || (isSvg ? 1056 : 0);
    source = img;
    cleanup = () => URL.revokeObjectURL(url);
  }
  if (!width || !height) {
    cleanup();
    throw new Error('The image is empty.');
  }
  try {
    // Vector images are rasterized with some headroom so they stay sharp when zoomed.
    const scale = isSvg ? Math.min(4, Math.max(1, 2400 / Math.max(width, height))) : 1;
    const cw = Math.max(1, Math.round(width * scale));
    const ch = Math.max(1, Math.round(height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const g = canvas.getContext('2d');
    if (!g) throw new Error('Canvas is not available.');
    g.drawImage(source!, 0, 0, cw, ch);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
    if (!blob) throw new Error('The image could not be converted.');
    return { png: new Uint8Array(await blob.arrayBuffer()), width, height };
  } finally {
    cleanup();
  }
}

/** Placement matrix of the unit-square image for an EXIF orientation (w, h = stored image size in pt). */
function orientationMatrix(o: number, w: number, h: number): [number, number, number, number, number, number] {
  switch (o) {
    case 2: return [-w, 0, 0, h, w, 0];
    case 3: return [-w, 0, 0, -h, w, h];
    case 4: return [w, 0, 0, -h, 0, h];
    case 5: return [0, -w, -h, 0, h, w];
    case 6: return [0, -w, h, 0, 0, w];
    case 7: return [0, w, h, 0, 0, 0];
    case 8: return [0, w, -h, 0, h, 0];
    default: return [w, 0, 0, h, 0, 0];
  }
}

async function addImagePage(lib: PDFDocument, file: Blob) {
  const bytes = await readFileBytes(file);
  const kind = sniff(bytes);
  let info: ImageInfo = { kind: 'other', orientation: 1 };
  let image: PDFImage | null = null;
  let pxW = 0;
  let pxH = 0;
  try {
    if (kind === 'jpeg') {
      info = jpegInfo(bytes);
      image = await lib.embedJpg(bytes);
    } else if (kind === 'png') {
      info = pngInfo(bytes);
      image = await lib.embedPng(bytes);
    }
  } catch {
    image = null;
  }
  if (image) {
    pxW = image.width;
    pxH = image.height;
  } else {
    const dec = await decodeToPng(file);
    const keepDpi = info.dpiX && info.dpiY ? { dpiX: info.dpiX, dpiY: info.dpiY } : {};
    info = { kind: 'other', orientation: 1, ...keepDpi };
    image = await lib.embedPng(dec.png);
    pxW = dec.width;
    pxH = dec.height;
  }
  let w = (pxW * 72) / (info.dpiX ?? 72);
  let h = (pxH * 72) / (info.dpiY ?? 72);
  const big = Math.max(w, h);
  if (big > MAX_PT) {
    w *= MAX_PT / big;
    h *= MAX_PT / big;
  }
  const small = Math.min(w, h);
  if (small < MIN_PT) {
    const f = Math.min(MIN_PT / small, MAX_PT / Math.max(w, h));
    w *= f;
    h *= f;
  }
  const swap = info.orientation >= 5;
  const page = lib.addPage(swap ? [h, w] : [w, h]);
  const name = page.node.newXObject('Im', image.ref);
  page.pushOperators(
    pushGraphicsState(),
    concatTransformationMatrix(...orientationMatrix(info.orientation, w, h)),
    drawObject(name),
    popGraphicsState(),
  );
}

/** Convert one or more images into a single PDF (one page per image). */
export async function imagesToPdf(files: (File | Blob)[], title?: string): Promise<Uint8Array> {
  if (!files.length) throw new Error('No images to convert.');
  const lib = await PDFDocument.create({ updateMetadata: false });
  for (const f of files) {
    try {
      await addImagePage(lib, f);
    } catch (e) {
      const name = f instanceof File ? `“${f.name}”` : 'the image';
      throw new Error(`Couldn't convert ${name}: ${(e as Error).message || e}`);
    }
  }
  const now = new Date();
  const first = files[0];
  lib.setTitle(title ?? (first instanceof File ? baseName(first.name) : 'Image'));
  lib.setCreator('PDF Wizard');
  lib.setProducer('PDF Wizard');
  lib.setCreationDate(now);
  lib.setModificationDate(now);
  return lib.save({ useObjectStreams: true, addDefaultPage: false, updateFieldAppearances: false });
}

export const imageFileHandler: FileHandler = {
  id: 'core-images',
  label: 'Images',
  extensions: ['png', 'jpg', 'jpeg', 'jpe', 'jfif', 'gif', 'webp', 'bmp', 'avif', 'svg'],
  mimePrefixes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/avif', 'image/svg+xml'],
  convert: (file: File) => imagesToPdf([file]),
};
