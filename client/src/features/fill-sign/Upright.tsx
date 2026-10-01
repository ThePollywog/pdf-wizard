/**
 * Positions upright item content (W×H points at the rotation the item was created at) inside the
 * object wrapper box, rotated to match the current on-screen rotation.
 */
import type { CSSProperties, ReactNode } from 'react';
import type { Rotation, ViewBox } from '@/core/types';
import { viewRotation } from './model';

export function Upright({
  box,
  scale,
  rotation,
  rot,
  w,
  h,
  className,
  style,
  children,
}: {
  box: ViewBox;
  scale: number;
  rotation: Rotation;
  rot: Rotation;
  /** Upright size in points. */
  w: number;
  h: number;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  const vr = viewRotation(rotation, rot);
  const W = w * scale;
  const H = h * scale;
  return (
    <div
      className={`fill-sign-upright${className ? ` ${className}` : ''}`}
      style={{
        left: (box.width - W) / 2,
        top: (box.height - H) / 2,
        width: W,
        height: H,
        transform: vr ? `rotate(${vr}deg)` : undefined,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
