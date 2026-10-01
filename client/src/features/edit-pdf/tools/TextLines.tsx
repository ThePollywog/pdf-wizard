/**
 * Read-only text drawn exactly like the PDF writer lays it out (same line breaks, alignment,
 * line spacing and baseline): used by added text boxes, resize previews and ghosts.
 */
import { memo, useMemo } from 'react';
import type { PageViewport } from '@/core/types';
import type { TextPreviewSpec } from '../state';
import { cssBaselineInLine, cssTextStyle } from '../fontMap';
import { layoutTextBox } from '../textbox';
import { frameCss } from '../viewmath';

export interface TextLinesProps extends TextPreviewSpec {
  vp: PageViewport;
  zoom: number;
  className?: string;
}

export const TextLines = memo(function TextLines({ text, style, frame, firstBaseline, autoWidth, vp, zoom, className }: TextLinesProps) {
  const lay = useMemo(() => layoutTextBox(text, style, frame.width, autoWidth), [text, style, frame.width, autoWidth]);
  const shift = firstBaseline - cssBaselineInLine(style);
  const base = cssTextStyle(style, zoom);
  const W = lay.width * zoom;
  return (
    <div className={`edit-pdf-textlines${className ? ` ${className}` : ''}`} style={{ ...frameCss(frame, vp, zoom), width: W, height: Math.max(lay.height, frame.height) * zoom }} aria-hidden="true">
      {lay.lines.map((l, i) => {
        const justify = style.align === 'justify' && !l.last;
        return (
          <div
            key={i}
            className="edit-pdf-textline"
            style={{
              ...base,
              top: (shift + i * style.lineHeight) * zoom,
              width: W,
              textAlign: justify ? 'justify' : style.align === 'justify' ? 'left' : style.align,
              textAlignLast: justify ? 'justify' : undefined,
              whiteSpace: justify ? 'nowrap' : 'pre',
            }}
          >
            {l.text || '\u200b'}
          </div>
        );
      })}
    </div>
  );
});
