/**
 * Vector icons for note (Text) and file-attachment annotations. Each icon is described once in a
 * 20×20 box (SVG coordinates, y down) and rendered both as SVG on screen and as PDF content-stream
 * operators for the annotation appearance, so the page and the exported file look the same.
 */
import type { SVGProps } from 'react';
import type { IconType, Rect, Rotation } from '@/core/types';
import { hexToRgb01 } from '@/core/util';
import type { AttachIcon, NoteIcon } from './model';

type Seg = ['M', number, number] | ['L', number, number] | ['C', number, number, number, number, number, number] | ['Z'];
type Paint = 'main' | 'dark' | 'white' | 'none';
interface Part {
  d: Seg[];
  fill?: Paint;
  stroke?: Paint;
  width?: number;
}

const K = 0.5523;
function circle(cx: number, cy: number, r: number): Seg[] {
  const k = r * K;
  return [
    ['M', cx + r, cy],
    ['C', cx + r, cy + k, cx + k, cy + r, cx, cy + r],
    ['C', cx - k, cy + r, cx - r, cy + k, cx - r, cy],
    ['C', cx - r, cy - k, cx - k, cy - r, cx, cy - r],
    ['C', cx + k, cy - r, cx + r, cy - k, cx + r, cy],
    ['Z'],
  ];
}
function rect(x: number, y: number, w: number, h: number): Seg[] {
  return [['M', x, y], ['L', x + w, y], ['L', x + w, y + h], ['L', x, y + h], ['Z']];
}
function line(x1: number, y1: number, x2: number, y2: number): Seg[] {
  return [['M', x1, y1], ['L', x2, y2]];
}

const NOTE_PARTS: Record<NoteIcon, Part[]> = {
  Comment: [
    {
      d: [
        ['M', 4, 2], ['L', 16, 2], ['C', 17.4, 2, 18.5, 3.1, 18.5, 4.5], ['L', 18.5, 12], ['C', 18.5, 13.4, 17.4, 14.5, 16, 14.5],
        ['L', 10, 14.5], ['L', 5, 18.5], ['L', 5.6, 14.5], ['L', 4, 14.5], ['C', 2.6, 14.5, 1.5, 13.4, 1.5, 12], ['L', 1.5, 4.5],
        ['C', 1.5, 3.1, 2.6, 2, 4, 2], ['Z'],
      ],
      fill: 'main', stroke: 'dark', width: 0.9,
    },
    { d: [...line(4.6, 5.6, 15.4, 5.6), ...line(4.6, 8.3, 15.4, 8.3), ...line(4.6, 11, 12, 11)], stroke: 'dark', width: 1 },
  ],
  Note: [
    { d: [['M', 3.5, 1.5], ['L', 12.8, 1.5], ['L', 16.5, 5.2], ['L', 16.5, 18.5], ['L', 3.5, 18.5], ['Z']], fill: 'main', stroke: 'dark', width: 0.9 },
    { d: [['M', 12.8, 1.5], ['L', 12.8, 5.2], ['L', 16.5, 5.2]], stroke: 'dark', width: 0.9 },
    { d: [...line(6, 8.2, 14, 8.2), ...line(6, 10.8, 14, 10.8), ...line(6, 13.4, 14, 13.4), ...line(6, 16, 11.5, 16)], stroke: 'dark', width: 0.9 },
  ],
  Key: [
    { d: circle(6.2, 10, 4.4), fill: 'main', stroke: 'dark', width: 0.9 },
    { d: circle(5.2, 10, 1.3), fill: 'dark' },
    {
      d: [
        ['M', 10.4, 8.8], ['L', 18.5, 8.8], ['L', 18.5, 11.2], ['L', 17.6, 11.2], ['L', 17.6, 13.6], ['L', 15.8, 13.6], ['L', 15.8, 11.2],
        ['L', 14.6, 11.2], ['L', 14.6, 12.8], ['L', 12.8, 12.8], ['L', 12.8, 11.2], ['L', 10.4, 11.2], ['Z'],
      ],
      fill: 'main', stroke: 'dark', width: 0.9,
    },
  ],
  Help: [
    { d: circle(10, 10, 8.5), fill: 'main', stroke: 'dark', width: 0.9 },
    { d: [['M', 7.3, 7.6], ['C', 7.3, 5.9, 8.5, 4.9, 10, 4.9], ['C', 11.6, 4.9, 12.8, 6, 12.8, 7.5], ['C', 12.8, 9.4, 10.1, 9.6, 10.1, 12.1]], stroke: 'dark', width: 1.8 },
    { d: circle(10.1, 14.9, 1.15), fill: 'dark' },
  ],
  Paragraph: [
    { d: circle(10, 10, 8.5), fill: 'main', stroke: 'dark', width: 0.9 },
    { d: [['M', 10, 4.6], ['L', 8.6, 4.6], ['C', 6.8, 4.6, 5.6, 5.9, 5.6, 7.5], ['C', 5.6, 9.1, 6.8, 10.4, 8.6, 10.4], ['L', 10, 10.4], ['Z']], fill: 'dark' },
    { d: [...line(10, 4.6, 10, 15.6), ...line(12.6, 4.6, 12.6, 15.6), ...line(9.4, 4.6, 14.2, 4.6)], stroke: 'dark', width: 1.3 },
  ],
  NewParagraph: [
    { d: [['M', 10, 1.8], ['L', 17.5, 10], ['L', 2.5, 10], ['Z']], fill: 'main', stroke: 'dark', width: 0.9 },
    {
      d: [
        ['M', 4.2, 18.4], ['L', 4.2, 12.4], ['L', 8.4, 18.4], ['L', 8.4, 12.4],
        ['M', 11.4, 18.4], ['L', 11.4, 12.4], ['L', 14, 12.4], ['C', 15.4, 12.4, 16.1, 13.3, 16.1, 14.2], ['C', 16.1, 15.1, 15.4, 16, 14, 16], ['L', 11.4, 16],
      ],
      stroke: 'dark', width: 1.25,
    },
  ],
  Insert: [{ d: [['M', 1.8, 17.5], ['L', 10, 2.5], ['L', 18.2, 17.5], ['L', 14.6, 17.5], ['L', 10, 9.2], ['L', 5.4, 17.5], ['Z']], fill: 'main', stroke: 'dark', width: 0.9 }],
};

const ATTACH_PARTS: Record<AttachIcon, Part[]> = {
  PushPin: [
    { d: [['M', 6, 1.8], ['L', 14, 1.8], ['L', 12.8, 3.6], ['L', 12.8, 8], ['L', 15.8, 11.2], ['L', 4.2, 11.2], ['L', 7.2, 8], ['L', 7.2, 3.6], ['Z']], fill: 'main', stroke: 'dark', width: 0.9 },
    { d: line(10, 11.2, 10, 18.6), stroke: 'dark', width: 1.4 },
  ],
  Paperclip: [
    {
      d: [
        ['M', 13.6, 6], ['L', 13.6, 14], ['C', 13.6, 16.2, 12, 17.9, 10, 17.9], ['C', 8, 17.9, 6.4, 16.2, 6.4, 14], ['L', 6.4, 5],
        ['C', 6.4, 3.3, 7.6, 2.1, 9.2, 2.1], ['C', 10.8, 2.1, 12, 3.3, 12, 5], ['L', 12, 13.5], ['C', 12, 14.5, 11.2, 15.3, 10.2, 15.3],
        ['C', 9.2, 15.3, 8.5, 14.5, 8.5, 13.5], ['L', 8.5, 6.5],
      ],
      stroke: 'dark', width: 2.6,
    },
    {
      d: [
        ['M', 13.6, 6], ['L', 13.6, 14], ['C', 13.6, 16.2, 12, 17.9, 10, 17.9], ['C', 8, 17.9, 6.4, 16.2, 6.4, 14], ['L', 6.4, 5],
        ['C', 6.4, 3.3, 7.6, 2.1, 9.2, 2.1], ['C', 10.8, 2.1, 12, 3.3, 12, 5], ['L', 12, 13.5], ['C', 12, 14.5, 11.2, 15.3, 10.2, 15.3],
        ['C', 9.2, 15.3, 8.5, 14.5, 8.5, 13.5], ['L', 8.5, 6.5],
      ],
      stroke: 'main', width: 1.3,
    },
  ],
  Graph: [
    { d: rect(1.8, 1.8, 16.4, 16.4), fill: 'white', stroke: 'dark', width: 0.9 },
    { d: [...rect(4.2, 10.5, 3, 5.6), ...rect(8.5, 5, 3, 11.1), ...rect(12.8, 8, 3, 8.1)], fill: 'main', stroke: 'dark', width: 0.6 },
  ],
  Tag: [
    { d: [['M', 2, 3], ['L', 10.6, 3], ['L', 18, 10.4], ['L', 10.6, 17.8], ['L', 2, 9.4], ['Z']], fill: 'main', stroke: 'dark', width: 0.9 },
    { d: circle(6, 7, 1.5), fill: 'white', stroke: 'dark', width: 0.8 },
  ],
};

// ── SVG ─────────────────────────────────────────────────────────────────────

function svgPath(d: Seg[]): string {
  return d
    .map((s) => (s[0] === 'Z' ? 'Z' : `${s[0]}${s.slice(1).map((n) => +(n as number).toFixed(2)).join(' ')}`))
    .join(' ');
}

function paintColor(p: Paint | undefined, main: string): string {
  if (!p || p === 'none') return 'none';
  if (p === 'main') return main;
  if (p === 'white') return '#ffffff';
  return '#1b1b1b';
}

export function IconSvg({ parts, color, ...rest }: { parts: Part[]; color: string } & SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 20 20" {...rest}>
      {parts.map((p, i) => (
        <path
          key={i}
          d={svgPath(p.d)}
          fill={paintColor(p.fill, color)}
          stroke={paintColor(p.stroke, color)}
          strokeWidth={p.width ?? 1}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      ))}
    </svg>
  );
}

export function NoteIconSvg({ icon, color, ...rest }: { icon: NoteIcon; color: string } & SVGProps<SVGSVGElement>) {
  return <IconSvg parts={NOTE_PARTS[icon] ?? NOTE_PARTS.Comment} color={color} {...rest} />;
}
export function AttachIconSvg({ icon, color, ...rest }: { icon: AttachIcon; color: string } & SVGProps<SVGSVGElement>) {
  return <IconSvg parts={ATTACH_PARTS[icon] ?? ATTACH_PARTS.PushPin} color={color} {...rest} />;
}

// ── PDF ─────────────────────────────────────────────────────────────────────

export const n = (v: number) => (Math.abs(v) < 1e-6 ? '0' : Number(v.toFixed(3)).toString());

export function rgbOps(hex: string, stroke = false): string {
  const [r, g, b] = hexToRgb01(hex);
  return `${n(r)} ${n(g)} ${n(b)} ${stroke ? 'RG' : 'rg'}`;
}

/** Matrix mapping an upright frame (origin bottom-left, size fw×fh) into `r` rotated CCW by `rot`. */
export function frameMatrix(r: Rect, rot: Rotation | undefined): [number, number, number, number, number, number] {
  switch (rot) {
    case 90:
      return [0, 1, -1, 0, r.x + r.width, r.y];
    case 180:
      return [-1, 0, 0, -1, r.x + r.width, r.y + r.height];
    case 270:
      return [0, -1, 1, 0, r.x, r.y + r.height];
    default:
      return [1, 0, 0, 1, r.x, r.y];
  }
}
export function frameSize(r: Rect, rot: Rotation | undefined): { w: number; h: number } {
  return rot === 90 || rot === 270 ? { w: r.height, h: r.width } : { w: r.width, h: r.height };
}
export const cm = (m: number[]) => `${m.map(n).join(' ')} cm`;

function pdfPath(d: Seg[]): string {
  const out: string[] = [];
  for (const s of d) {
    if (s[0] === 'M') out.push(`${n(s[1])} ${n(s[2])} m`);
    else if (s[0] === 'L') out.push(`${n(s[1])} ${n(s[2])} l`);
    else if (s[0] === 'C') out.push(`${n(s[1])} ${n(s[2])} ${n(s[3])} ${n(s[4])} ${n(s[5])} ${n(s[6])} c`);
    else out.push('h');
  }
  return out.join(' ');
}

function iconOps(parts: Part[], r: Rect, color: string, rot: Rotation | undefined): string {
  const { w, h } = frameSize(r, rot);
  const kx = w / 20;
  const ky = h / 20;
  const ops: string[] = ['q', cm(frameMatrix(r, rot)), cm([kx, 0, 0, -ky, 0, 20 * ky]), '1 j 1 J'];
  const hex = (p: Paint) => paintColor(p, color);
  for (const p of parts) {
    const fill = p.fill && p.fill !== 'none' ? hex(p.fill) : null;
    const stroke = p.stroke && p.stroke !== 'none' ? hex(p.stroke) : null;
    if (!fill && !stroke) continue;
    if (fill) ops.push(rgbOps(fill));
    if (stroke) ops.push(rgbOps(stroke, true), `${n(p.width ?? 1)} w`);
    ops.push(`${pdfPath(p.d)} ${fill && stroke ? 'B' : fill ? 'f' : 'S'}`);
  }
  ops.push('Q');
  return ops.join('\n');
}

export function noteIconOps(icon: NoteIcon, r: Rect, color: string, rot?: Rotation): string {
  return iconOps(NOTE_PARTS[icon] ?? NOTE_PARTS.Comment, r, color, rot);
}
export function attachIconOps(icon: AttachIcon, r: Rect, color: string, rot?: Rotation): string {
  return iconOps(ATTACH_PARTS[icon] ?? ATTACH_PARTS.PushPin, r, color, rot);
}

// ── small lucide-compatible icons that lucide lacks ──────────────────────────

export const CaretIcon: IconType = ({ size = 24, className, strokeWidth = 2, color = 'currentColor' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M4 7h16" opacity="0.45" />
    <path d="M7 20l5-9 5 9" />
  </svg>
);

export const SquigglyIcon: IconType = ({ size = 24, className, strokeWidth = 2, color = 'currentColor' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
    <path d="M7 4v6a5 5 0 0 0 10 0V4" />
    <path d="M3 20l2.25-2 2.25 2 2.25-2 2.25 2 2.25-2 2.25 2 2.25-2 2.25 2" />
  </svg>
);

export const CalloutIcon: IconType = ({ size = 24, className, strokeWidth = 2, color = 'currentColor' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
    <rect x="9" y="3" width="12" height="9" rx="1.5" />
    <path d="M12 6.5h6M12 9h4" />
    <path d="M9 10l-4 4H3M3 21l2-7" />
  </svg>
);

export const TextBoxIcon: IconType = ({ size = 24, className, strokeWidth = 2, color = 'currentColor' }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className}>
    <rect x="3" y="4" width="18" height="16" rx="2" />
    <path d="M8 9h8M12 9v7" />
  </svg>
);
