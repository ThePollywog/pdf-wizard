/** SVG renderer for paint lists (see paint.ts). */
import type { CSSProperties, ReactNode } from 'react';
import type { Mat, Seg } from './geom';
import type { Paint, PathPaint } from './paint';
import { FONT_STACK } from './fonts';

const n = (v: number) => (Math.abs(v) < 1e-9 ? '0' : Number(v.toFixed(4)).toString());

export function segsToD(segs: Seg[]): string {
  let d = '';
  for (const s of segs) {
    if (s[0] === 'Z') d += 'Z';
    else if (s[0] === 'C') d += `C${n(s[1])} ${n(s[2])} ${n(s[3])} ${n(s[4])} ${n(s[5])} ${n(s[6])}`;
    else d += `${s[0]}${n(s[1])} ${n(s[2])}`;
  }
  return d;
}

export const matrixAttr = (m: Mat) => `matrix(${m.map(n).join(' ')})`;

function renderItem(p: Paint, key: number | string, opacity: number): ReactNode {
  switch (p.t) {
    case 'group':
      return (
        <g key={key} transform={matrixAttr(p.m)}>
          {p.items.map((c, i) => renderItem(c, i, opacity))}
        </g>
      );
    case 'path':
      return (
        <path
          key={key}
          d={segsToD(p.segs)}
          fill={p.fill ?? 'none'}
          fillOpacity={p.fill ? (p.fillOpacity ?? 1) * opacity : undefined}
          stroke={p.stroke ?? 'none'}
          strokeOpacity={p.stroke ? (p.strokeOpacity ?? 1) * opacity : undefined}
          strokeWidth={p.stroke ? Math.max(0.01, p.width ?? 1) : undefined}
          strokeLinecap={p.cap ?? 'butt'}
          strokeLinejoin={p.join ?? 'miter'}
          strokeMiterlimit={10}
          strokeDasharray={p.dash && p.dash.length ? p.dash.join(' ') : undefined}
        />
      );
    case 'text':
      return (
        <text
          key={key}
          x={p.x}
          y={-p.y}
          transform="scale(1 -1)"
          fontFamily={FONT_STACK}
          fontWeight={p.bold ? 700 : 400}
          fontSize={p.size}
          fill={p.color}
          fillOpacity={opacity}
          textLength={p.width > 0 ? p.width : undefined}
          lengthAdjust="spacingAndGlyphs"
          style={{ whiteSpace: 'pre' }}
        >
          {p.text}
        </text>
      );
    case 'image':
    case 'pdfpage':
      return (
        <image
          key={key}
          href={p.src}
          x={p.x}
          y={-(p.y + p.h)}
          width={Math.max(0.01, p.w)}
          height={Math.max(0.01, p.h)}
          transform="scale(1 -1)"
          preserveAspectRatio="none"
          opacity={opacity}
        />
      );
  }
}

/** Transparent, wider copies of the paths that receive pointer events (hit: 'shape'). */
function renderHit(p: Paint, key: number | string, hitWidth: number): ReactNode {
  if (p.t === 'group') {
    return (
      <g key={key} transform={matrixAttr(p.m)}>
        {p.items.map((c, i) => renderHit(c, i, hitWidth))}
      </g>
    );
  }
  if (p.t === 'text') {
    return (
      <rect key={key} x={p.x - 2} y={-(p.y + p.size)} width={p.width + 4} height={p.size * 1.3} transform="scale(1 -1)" fill="transparent" pointerEvents="all" />
    );
  }
  if (p.t !== 'path' || p.noHit) return null;
  const pp = p as PathPaint;
  return (
    <path
      key={key}
      d={segsToD(pp.segs)}
      fill={pp.fill ? 'transparent' : 'none'}
      stroke="transparent"
      strokeWidth={Math.max(hitWidth, (pp.width ?? 1) + hitWidth / 2)}
      strokeLinecap="round"
      strokeLinejoin="round"
      pointerEvents={pp.fill ? 'all' : 'stroke'}
    />
  );
}

export interface PaintSvgProps {
  paints: Paint[];
  /** PDF space → local CSS px. */
  m: Mat;
  opacity?: number;
  /** Add hit paths of this width (PDF units). */
  hitWidth?: number;
  /** Render only the (transparent) hit paths, e.g. when the visuals live in the blend layer. */
  hitOnly?: boolean;
  className?: string;
  style?: CSSProperties;
  'data-testid'?: string;
  children?: ReactNode;
}

export function PaintSvg({ paints, m, opacity = 1, hitWidth, hitOnly, className, style, children, ...rest }: PaintSvgProps) {
  return (
    <svg
      className={className ? `drawing-svg ${className}` : 'drawing-svg'}
      style={style}
      aria-hidden="true"
      focusable="false"
      data-testid={rest['data-testid']}
    >
      <g transform={matrixAttr(m)}>
        {!hitOnly && paints.map((p, i) => renderItem(p, i, opacity))}
        {hitWidth !== undefined && <g className="drawing-hit">{paints.map((p, i) => renderHit(p, i, hitWidth))}</g>}
      </g>
      {children}
    </svg>
  );
}
