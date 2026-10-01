/**
 * Canvas helpers for signatures: typed signatures in script fonts, cropping to the inked area,
 * removing white paper backgrounds from uploaded images and tinting for export.
 */

export interface SigStyle {
  id: string;
  label: string;
  /** CSS font-family stack (system script fonts; the generic `cursive` is the last resort). */
  family: string;
  /** Relative size tweak so all styles look similarly large. */
  scale: number;
}

export const SIG_STYLES: SigStyle[] = [
  { id: 'snell', label: 'Snell Roundhand', family: '"Snell Roundhand", "Segoe Script", "Brush Script MT", cursive', scale: 1 },
  { id: 'brush', label: 'Brush Script', family: '"Brush Script MT", "Brush Script Std", "Segoe Script", cursive', scale: 1.1 },
  { id: 'chancery', label: 'Apple Chancery', family: '"Apple Chancery", "Lucida Handwriting", "URW Chancery L", cursive', scale: 0.9 },
  { id: 'segoe', label: 'Segoe Script', family: '"Segoe Script", "Bradley Hand", "Segoe Print", cursive', scale: 0.9 },
  { id: 'savoye', label: 'Savoye', family: '"Savoye LET", "Lucida Handwriting", "Segoe Script", cursive', scale: 1.25 },
];

export const INK_COLORS: { id: string; label: string; value: string }[] = [
  { id: 'black', label: 'Black', value: '#000000' },
  { id: 'blue', label: 'Blue', value: '#1a3fb3' },
  { id: 'red', label: 'Red', value: '#c8102e' },
];

export interface SigImage {
  src: string;
  aspect: number;
  width: number;
  height: number;
}

function canvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

/** Bounding box of pixels with alpha above `threshold`, or null when empty. */
export function inkBounds(c: HTMLCanvasElement, threshold = 10): { x: number; y: number; w: number; h: number } | null {
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  const { width, height } = c;
  const data = ctx.getImageData(0, 0, width, height).data;
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (data[row + x * 4 + 3] > threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return null;
  return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** Crop to the inked area with `pad` px of margin; optionally scale down so the long side ≤ maxSide. */
export function cropToInk(c: HTMLCanvasElement, pad = 4, maxSide = 1400): HTMLCanvasElement | null {
  const b = inkBounds(c);
  if (!b) return null;
  const sx = Math.max(0, b.x - pad);
  const sy = Math.max(0, b.y - pad);
  const sw = Math.min(c.width - sx, b.w + 2 * pad);
  const sh = Math.min(c.height - sy, b.h + 2 * pad);
  const k = Math.min(1, maxSide / Math.max(sw, sh));
  const out = canvas(sw * k, sh * k);
  const ctx = out.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(c, sx, sy, sw, sh, 0, 0, out.width, out.height);
  return out;
}

function toSigImage(c: HTMLCanvasElement): SigImage {
  return { src: c.toDataURL('image/png'), aspect: c.width / Math.max(1, c.height), width: c.width, height: c.height };
}

/** Typed signature → transparent PNG in black ink. */
export function renderTyped(text: string, style: SigStyle, color = '#000000'): SigImage | null {
  const t = text.trim();
  if (!t) return null;
  const size = 120 * style.scale;
  const font = `${size}px ${style.family}`;
  const probe = canvas(10, 10).getContext('2d')!;
  probe.font = font;
  const width = probe.measureText(t).width;
  // Script fonts have long swashes: leave generous room and crop afterwards.
  const c = canvas(width + size * 1.6, size * 2.4);
  const ctx = c.getContext('2d')!;
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(t, size * 0.8, size * 1.55);
  const cropped = cropToInk(c, Math.round(size * 0.06));
  return cropped ? toSigImage(cropped) : null;
}

/** Drawn signature (pad canvas, any ink color) → cropped transparent PNG in black ink. */
export function renderDrawn(pad: HTMLCanvasElement): SigImage | null {
  const cropped = cropToInk(pad, 6);
  if (!cropped) return null;
  const ctx = cropped.getContext('2d')!;
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, cropped.width, cropped.height);
  return toSigImage(cropped);
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('The image could not be read.'));
    img.src = src;
  });
}

export function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('The file could not be read.'));
    r.readAsDataURL(file);
  });
}

/**
 * Uploaded image → transparent PNG: near-white paper becomes transparent (with a soft edge), then
 * the result is cropped to the content and limited to 1200 px.
 */
export async function processImage(src: string, removeWhite: boolean): Promise<SigImage | null> {
  const img = await loadImage(src);
  const k = Math.min(1, 1200 / Math.max(img.naturalWidth, img.naturalHeight));
  const c = canvas(img.naturalWidth * k, img.naturalHeight * k);
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, c.width, c.height);
  if (removeWhite) {
    const id = ctx.getImageData(0, 0, c.width, c.height);
    const d = id.data;
    const hi = 238;
    const lo = 200;
    for (let i = 0; i < d.length; i += 4) {
      const m = Math.min(d[i], d[i + 1], d[i + 2]);
      if (m >= hi) d[i + 3] = 0;
      else if (m > lo) d[i + 3] = Math.round(d[i + 3] * ((hi - m) / (hi - lo)));
    }
    ctx.putImageData(id, 0, 0);
  }
  const cropped = cropToInk(c, 2, 1200);
  return cropped ? toSigImage(cropped) : null;
}

/** PNG bytes of `src`, tinted with `color` when given (alpha kept). */
export async function pngBytes(src: string, color?: string): Promise<Uint8Array> {
  if (!color && src.startsWith('data:image/png')) return dataUrlBytes(src);
  const img = await loadImage(src);
  const c = canvas(img.naturalWidth, img.naturalHeight);
  const ctx = c.getContext('2d')!;
  ctx.drawImage(img, 0, 0);
  if (color) {
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, c.width, c.height);
  }
  return dataUrlBytes(c.toDataURL('image/png'));
}

export function dataUrlBytes(url: string): Uint8Array {
  const i = url.indexOf(',');
  const bin = atob(url.slice(i + 1));
  const out = new Uint8Array(bin.length);
  for (let j = 0; j < bin.length; j++) out[j] = bin.charCodeAt(j);
  return out;
}

/** Text rendered to a transparent PNG (fallback for scripts the PDF fonts can't encode). */
export function renderTextImage(lines: string[], opts: { fontSize: number; letterSpacing: number; color: string; width: number; height: number; lineHeight: number; padX: number; padY: number; baseline: number; font: string }): Uint8Array {
  const k = 4;
  const c = canvas(opts.width * k, opts.height * k);
  const ctx = c.getContext('2d')!;
  ctx.scale(k, k);
  ctx.font = `${opts.fontSize}px ${opts.font}`;
  ctx.fillStyle = opts.color;
  ctx.textBaseline = 'alphabetic';
  if (opts.letterSpacing) (ctx as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${opts.letterSpacing}px`;
  lines.forEach((l, i) => ctx.fillText(l, opts.padX, opts.padY + i * opts.lineHeight + opts.baseline));
  return dataUrlBytes(c.toDataURL('image/png'));
}
