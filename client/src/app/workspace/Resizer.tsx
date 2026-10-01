import { useRef, type KeyboardEvent, type PointerEvent } from 'react';

/**
 * Vertical drag handle for resizable side panels.
 * `edge="end"` sits on the right edge of a left panel (dragging right grows it);
 * `edge="start"` sits on the left edge of a right panel (dragging left grows it).
 */
export function Resizer({
  edge,
  width,
  onResize,
  min,
  max,
  defaultWidth,
  label,
}: {
  edge: 'start' | 'end';
  width: number;
  onResize(w: number): void;
  min: number;
  max: number;
  defaultWidth: number;
  label: string;
}) {
  const start = useRef<{ x: number; w: number } | null>(null);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, w: width };
    document.body.classList.add('is-resizing');
  };
  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    const s = start.current;
    if (!s) return;
    const dx = e.clientX - s.x;
    onResize(s.w + (edge === 'end' ? dx : -dx));
  };
  const end = (e: PointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    start.current = null;
    document.body.classList.remove('is-resizing');
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const grow = edge === 'end' ? 'ArrowRight' : 'ArrowLeft';
    const shrink = edge === 'end' ? 'ArrowLeft' : 'ArrowRight';
    const step = e.shiftKey ? 64 : 16;
    if (e.key === grow) onResize(width + step);
    else if (e.key === shrink) onResize(width - step);
    else if (e.key === 'Home') onResize(min);
    else if (e.key === 'End') onResize(max);
    else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div
      className={`resizer resizer-${edge}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={Math.round(width)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => onResize(defaultWidth)}
      onKeyDown={onKeyDown}
      data-no-shortcuts=""
    />
  );
}
