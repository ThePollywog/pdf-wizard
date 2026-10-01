/**
 * Reading image files for Add image / Replace image: PNG and JPEG are used as they are, other
 * formats the browser can decode (GIF, WebP, BMP, SVG…) are converted to PNG.
 */
import { actions } from '@/core/store';
import { pickFiles } from '@/core/util';

export interface LoadedImage {
  bytes: Uint8Array;
  mime: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
  dataUrl: string;
  name: string;
}

function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('The image couldn’t be read.'));
    r.readAsDataURL(b);
  });
}

function decode(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('This file isn’t an image the browser can open.'));
    img.src = url;
  });
}

/** Reads an image file as PNG / JPEG bytes (other formats are converted to PNG). */
export async function loadImageFile(file: File): Promise<LoadedImage> {
  const head = new Uint8Array(await file.slice(0, 8).arrayBuffer());
  const isPng = head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47;
  const isJpg = head[0] === 0xff && head[1] === 0xd8;
  const url = await blobToDataUrl(file);
  const img = await decode(url);
  if (!img.naturalWidth || !img.naturalHeight) throw new Error('The image is empty.');
  if (isPng || isJpg) {
    return {
      bytes: new Uint8Array(await file.arrayBuffer()), mime: isPng ? 'image/png' : 'image/jpeg',
      width: img.naturalWidth, height: img.naturalHeight, dataUrl: url, name: file.name,
    };
  }
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext('2d')?.drawImage(img, 0, 0);
  const png: Blob = await new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The image couldn’t be converted.'))), 'image/png'));
  return {
    bytes: new Uint8Array(await png.arrayBuffer()), mime: 'image/png', width: img.naturalWidth, height: img.naturalHeight,
    dataUrl: await blobToDataUrl(png), name: file.name,
  };
}

export function dataUrlBytes(url: string): Uint8Array {
  const comma = url.indexOf(',');
  const bin = atob(url.slice(comma + 1));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const MAX_PIXELS = 60_000_000;

/** Lets the user choose an image file. Resolves null when cancelled or unreadable (a toast explains why). */
export async function pickImage(): Promise<LoadedImage | null> {
  const [file] = await pickFiles({ accept: 'image/png,image/jpeg,image/gif,image/webp,image/bmp,image/svg+xml,.png,.jpg,.jpeg,.gif,.webp,.bmp,.svg' });
  if (!file) return null;
  try {
    const img = await loadImageFile(file);
    if (img.width * img.height > MAX_PIXELS) throw new Error('This image is too large to place (over 60 megapixels).');
    return img;
  } catch (e) {
    actions.toast(e instanceof Error ? e.message : String(e), { kind: 'error' });
    return null;
  }
}
