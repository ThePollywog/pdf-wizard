/** Small floating Read Out Loud control shown over the viewer while Read Out Loud is active. */
import { useEffect, useRef } from 'react';
import { FileAudio, ListEnd, Pause, Play, Square, X } from 'lucide-react';
import { IconButton, Spinner } from '@/core/ui';
import { shortcutOf } from '../util';
import { readAloud, takeFocusRequest, useReadAloud } from './controller';

const RATES = [0.75, 1, 1.25, 1.5, 2];

export function ReadAloudControl({ docId }: { docId: string }) {
  const active = useReadAloud((s) => s.active);
  const status = useReadAloud((s) => s.status);
  const reading = useReadAloud((s) => s.docId);
  const page = useReadAloud((s) => s.pageIndex);
  const mode = useReadAloud((s) => s.mode);
  const rate = useReadAloud((s) => s.rate);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!active || !takeFocusRequest()) return;
    // Menus restore focus to their trigger when they close: focus after that.
    const t = window.setTimeout(() => ref.current?.querySelector<HTMLElement>('button:not(:disabled)')?.focus({ preventScroll: true }), 30);
    return () => window.clearTimeout(t);
  }, [active]);
  if (!active) return null;
  const here = reading === docId || status === 'idle';
  const busy = status !== 'idle' && here;
  const label =
    !busy ? 'Read Out Loud' : status === 'loading' ? `Reading page ${page + 1}…` : status === 'paused' ? `Paused · page ${page + 1}` : `Reading page ${page + 1}${mode === 'end' ? ' to end' : ''}`;
  const nextRate = RATES[(RATES.indexOf(rate) + 1) % RATES.length] ?? 1;
  return (
    <div
      ref={ref}
      className="navigation-readaloud"
      role="toolbar"
      aria-label="Read Out Loud"
      data-testid="navigation-readaloud-control"
      data-status={busy ? status : 'idle'}
      data-viewer-passthrough=""
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <span className="navigation-readaloud-label" aria-live="polite" data-testid="navigation-readaloud-status">
        {status === 'loading' && busy ? <Spinner size={12} /> : <FileAudio size={14} aria-hidden="true" />}
        {label}
      </span>
      {!busy ? (
        <>
          <IconButton icon={Play} size="sm" label="Read this page only" shortcut={shortcutOf('navigation.readAloud.readPage')} onClick={() => readAloud.readPage(docId)} data-testid="navigation-readaloud-page" />
          <IconButton icon={ListEnd} size="sm" label="Read to end" shortcut={shortcutOf('navigation.readAloud.readToEnd')} onClick={() => readAloud.readToEnd(docId)} data-testid="navigation-readaloud-end" />
        </>
      ) : (
        <>
          <IconButton
            icon={status === 'paused' ? Play : Pause}
            size="sm"
            label={status === 'paused' ? 'Resume' : 'Pause'}
            shortcut={shortcutOf('navigation.readAloud.pause')}
            disabled={status === 'loading'}
            onClick={() => readAloud.togglePause()}
            data-testid="navigation-readaloud-pause"
          />
          <IconButton icon={Square} size="sm" label="Stop" shortcut={shortcutOf('navigation.readAloud.stop')} onClick={() => readAloud.stop()} data-testid="navigation-readaloud-stop" />
        </>
      )}
      <button
        type="button"
        className="navigation-readaloud-rate"
        onClick={() => readAloud.setRate(nextRate)}
        title="Reading speed (applies to the next sentence)"
        aria-label={`Reading speed ${rate}×`}
        data-testid="navigation-readaloud-rate"
      >
        {rate}×
      </button>
      <IconButton icon={X} size="sm" label="Deactivate Read Out Loud" shortcut={shortcutOf('navigation.readAloud.deactivate')} onClick={() => readAloud.deactivate()} data-testid="navigation-readaloud-close" />
    </div>
  );
}
