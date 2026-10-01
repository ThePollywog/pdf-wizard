/**
 * "Replace pages" dialog: pick the replacement file (device or library), choose which of its
 * pages replace the chosen pages, preview the mapping, then replace (one undo step; the replaced
 * pages keep their position, id, comments and form fields).
 */
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, FolderOpen, Replace, Upload } from 'lucide-react';
import type { DocId } from '@/core/types';
import * as engine from '@/core/engine';
import { actions, getDoc } from '@/core/store';
import { Button, Modal, NumberField, Spinner, TextField } from '@/core/ui';
import { PageThumbnail } from '@/core/viewer';
import { pickFiles } from '@/core/util';
import { formatRanges, parseRanges, plural } from '../ranges';
import { acceptString, loadFileSource, loadLibrarySource, destroyProxy, type LoadedPdf } from '../sources';
import { closeSource, getSource, registerSource } from '../pdfThumbs';
import { SourceThumb, fitWidth } from '../SourceThumb';
import { attempt, errMsg } from '../util';
import { libraryPickerDialog } from './LibraryPicker';

interface ReplaceResult {
  indices: number[];
  sourceIndices: number[];
  bytes: Uint8Array;
  sourceName: string;
}

const PREVIEW_ROWS = 6;

function ReplaceBody({ docId, indices, close }: { docId: DocId; indices: number[]; close(r: ReplaceResult | null): void }) {
  const doc = getDoc(docId);
  const count = doc?.pages.length ?? 0;
  const [range, setRange] = useState(() => formatRanges(indices.length ? indices : count ? [0] : []));
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [start, setStart] = useState(1);
  const alive = useRef(true);
  const current = useRef<string | null>(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (current.current) closeSource(current.current);
      current.current = null;
    };
  }, []);

  const src = sourceId ? getSource(sourceId) : undefined;
  const n = src?.pages.length ?? 0;
  const parsed = parseRanges(range, count);
  const rangeError = range.trim() ? parsed.error : 'Enter the pages to replace';
  const targets = parsed.error ? [] : parsed.indices;
  const first = Math.max(1, Math.min(start, n || 1));
  const available = n ? n - first + 1 : 0;
  const mapError =
    src && targets.length > available
      ? `Starting at page ${first}, “${src.name}” has only ${plural(available, 'page', 'pages')} for the ${targets.length} pages being replaced.`
      : null;
  const ready = !!src && !rangeError && !mapError && targets.length > 0;

  const adopt = async (loader: () => Promise<LoadedPdf | null>) => {
    setLoading(true);
    setLoadError(null);
    try {
      const loaded = await loader();
      if (!loaded) return;
      if (!alive.current) {
        destroyProxy(loaded.pdf);
        return;
      }
      const reg = await registerSource(loaded);
      if (!alive.current) {
        closeSource(reg.id);
        return;
      }
      if (current.current) closeSource(current.current);
      current.current = reg.id;
      setSourceId(reg.id);
      setStart(1);
    } catch (e) {
      if (alive.current) setLoadError(errMsg(e));
    } finally {
      if (alive.current) setLoading(false);
    }
  };

  const fromDevice = async () => {
    const [file] = await pickFiles({ accept: acceptString(), multiple: false });
    if (file) await adopt(() => loadFileSource(file));
  };
  const fromLibrary = async () => {
    const picked = await libraryPickerDialog({ title: 'Choose the replacement file', confirmLabel: 'Choose', multiple: false });
    const f = picked?.[0];
    if (f) await adopt(() => loadLibrarySource(f.id, f.name));
  };

  const submit = () => {
    if (!ready || !src) return;
    close({ indices: targets, sourceIndices: targets.map((_, k) => first - 1 + k), bytes: src.bytes, sourceName: src.name });
  };

  const rows = ready ? targets.slice(0, PREVIEW_ROWS) : [];
  const origW = (i: number) => {
    const p = doc?.pages[i];
    if (!p) return 40;
    const swap = p.rotation % 180 !== 0;
    return fitWidth(40, swap ? p.height : p.width, swap ? p.width : p.height);
  };
  const srcW = (i: number) => {
    const p = src?.pages[i];
    return p ? fitWidth(40, p.width, p.height) : 40;
  };

  return (
    <Modal
      title="Replace pages"
      icon={Replace}
      width={560}
      onClose={() => close(null)}
      className="organize-dialog"
      footer={
        <>
          <Button onClick={() => close(null)} data-testid="organize-replace-cancel">
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} disabled={!ready} data-testid="organize-replace-ok">
            Replace
          </Button>
        </>
      }
    >
      <form
        className="organize-dialog-form"
        data-testid="organize-replace-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <TextField
          label={`Replace pages of “${doc?.name ?? 'the document'}”`}
          value={range}
          onChange={setRange}
          placeholder={`e.g. 2-3 (of ${count})`}
          error={range.trim() ? (rangeError ?? undefined) : undefined}
          help={rangeError ? `Pages 1 to ${count}` : plural(targets.length, 'page', 'pages')}
          data-testid="organize-replace-range"
        />
        <div className="organize-dialog-block">
          <div className="field-label">With pages from</div>
          <div className="organize-replace-source">
            {src ? (
              <span className="organize-dialog-source" data-testid="organize-replace-source">
                <span className="organize-dialog-source-name" title={src.name}>
                  {src.name}
                </span>
                <span className="organize-dialog-muted">{plural(n, 'page', 'pages')}</span>
              </span>
            ) : (
              <span className="organize-dialog-muted">{loading ? 'Loading…' : 'No file chosen'}</span>
            )}
            {loading && <Spinner size={16} />}
            <span className="organize-replace-pick">
              <Button size="sm" icon={Upload} onClick={() => void fromDevice()} disabled={loading} data-testid="organize-replace-file">
                {src ? 'Change file…' : 'Choose file…'}
              </Button>
              <Button size="sm" icon={FolderOpen} onClick={() => void fromLibrary()} disabled={loading} data-testid="organize-replace-library">
                Your files…
              </Button>
            </span>
          </div>
          {loadError && (
            <div className="organize-dialog-error" role="alert">
              {loadError}
            </div>
          )}
        </div>
        {src && (
          <div className="organize-dialog-row" data-testid="organize-replace-start">
            <NumberField
              label="Starting at page"
              value={first}
              onChange={(v) => setStart(Math.round(v))}
              min={1}
              max={n}
              width={124}
              suffix={`of ${n}`}
              aria-label="First replacement page"
            />
            {!mapError && targets.length > 0 && (
              <span className="organize-dialog-muted organize-replace-summary">
                Pages {first}–{first + targets.length - 1} of the file replace {targets.length === 1 ? 'page' : 'pages'} {formatRanges(targets)}
              </span>
            )}
          </div>
        )}
        {mapError && (
          <div className="organize-dialog-error" role="alert" data-testid="organize-replace-error">
            {mapError}
          </div>
        )}
        {rows.length > 0 && src && (
          <div className="organize-replace-map" data-testid="organize-replace-map" aria-label="Page mapping">
            {rows.map((t, k) => (
              <div className="organize-replace-row" key={t}>
                <span className="organize-replace-thumb">
                  <PageThumbnail docId={docId} pageIndex={t} width={origW(t)} />
                </span>
                <span className="organize-replace-label">Page {t + 1}</span>
                <ArrowRight size={16} className="organize-replace-arrow" aria-hidden />
                <span className="organize-replace-thumb">
                  <SourceThumb sourceId={src.id} index={first - 1 + k} width={srcW(first - 1 + k)} />
                </span>
                <span className="organize-replace-label">
                  Page {first + k} of the file
                </span>
              </div>
            ))}
            {targets.length > rows.length && (
              <div className="organize-dialog-muted organize-replace-more">…and {plural(targets.length - rows.length, 'more page', 'more pages')}</div>
            )}
          </div>
        )}
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  );
}

/** Ask for the replacement and replace the pages. Resolves true when pages were replaced. */
export async function replaceDialog(docId: DocId, indices: number[]): Promise<boolean> {
  const r = await actions.openModal<ReplaceResult | null>((close) => <ReplaceBody docId={docId} indices={indices} close={close} />);
  if (!r) return false;
  const ok = await attempt(() => engine.replacePages(docId, r.indices, r.bytes, r.sourceIndices));
  if (ok) {
    actions.toast(`Replaced ${plural(r.indices.length, 'page', 'pages')} with pages from “${r.sourceName}”`, {
      kind: 'success',
      action: { label: 'Undo', run: () => actions.undo(docId) },
    });
  }
  return ok;
}
