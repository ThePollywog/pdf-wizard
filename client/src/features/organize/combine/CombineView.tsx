/**
 * MainView of "Combine files": add PDFs (and every convertible file type) from the device, the
 * library or open tabs, reorder them by drag & drop, expand a file to remove / reorder its pages
 * (also across files), then combine them into a new "BinderN.pdf" tab with one bookmark per file.
 */
import { useEffect, useRef, useState, type DragEvent } from 'react';
import clsx from 'clsx';
import {
  ArrowDownAZ, ArrowUpAZ, ChevronDown, ChevronsDownUp, ChevronsUpDown, Combine, FileStack, FolderOpen, Layers, Plus, RotateCcw, Upload, X,
} from 'lucide-react';
import { actions, useApp } from '@/core/store';
import { Button, Divider, Dropdown, FileDropZone, IconButton, Spinner, type MenuEntry } from '@/core/ui';
import { formatBytes } from '@/core/util';
import { SourceThumb, fitWidth } from '../SourceThumb';
import { getSource } from '../pdfThumbs';
import { acceptString, convertedTypesSentence } from '../sources';
import { useRegistry } from '@/core/registry';
import { plural } from '../ranges';
import { combine, useCombine, type CombineFile } from './store';
import { TASK_COMBINE } from '../tasks';

type DragItem = { type: 'file'; key: string } | { type: 'page'; key: string; index: number };
type DropTarget = { kind: 'file'; key: string; side: 'before' | 'after' } | { kind: 'page'; key: string; index: number; side: 'before' | 'after' } | { kind: 'end' };

const FILE_MIME = 'application/x-organize-combine';

function thumbWidth(sourceId: string, page: number, box: number) {
  const p = getSource(sourceId)?.pages[page];
  return p ? fitWidth(box, p.width, p.height) : box;
}

function addMenu(): MenuEntry[] {
  const docs = Object.values(useApp.getState().docs).filter((d) => d.pages.length && !d.loadError);
  return [
    { id: 'organize-combine-add-device', label: 'From this device…', icon: Upload, run: () => combine.pickFromDevice() },
    { id: 'organize-combine-add-library', label: 'From your files…', icon: FolderOpen, run: () => combine.pickFromLibrary() },
    ...(docs.length
      ? ([
          'divider',
          {
            id: 'organize-combine-add-open',
            label: 'Open documents',
            icon: FileStack,
            submenu: docs.map((d) => ({ id: `organize-combine-add-doc-${d.id}`, label: d.name, run: () => combine.addDocument(d.id) })),
          },
        ] as MenuEntry[])
      : []),
  ];
}

export function CombineView() {
  const files = useCombine((s) => s.files);
  const loading = useCombine((s) => s.loading);
  const docOpen = useApp((s) => !!s.activeDocId && s.route === 'document');
  const [drag, setDrag] = useState<DragItem | null>(null);
  const [target, setTarget] = useState<DropTarget | null>(null);
  const [external, setExternal] = useState(false);
  const dragRef = useRef<DragItem | null>(null);
  const total = files.reduce((n, f) => n + f.entries.length, 0);
  const withPages = files.filter((f) => f.entries.length).length;
  const converted = useRegistry((s) => convertedTypesSentence(s.fileHandlers.map((h) => h.label)));
  const allExpanded = files.length > 0 && files.every((f) => f.expanded);
  const canCombine = withPages >= 2 && loading === 0;

  useEffect(() => {
    const end = () => {
      dragRef.current = null;
      setDrag(null);
      setTarget(null);
      setExternal(false);
    };
    window.addEventListener('dragend', end, true);
    return () => window.removeEventListener('dragend', end, true);
  }, []);

  const startDrag = (e: DragEvent, item: DragItem) => {
    e.stopPropagation();
    dragRef.current = item;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData(FILE_MIME, JSON.stringify(item));
    setDrag(item);
  };

  const side = (e: DragEvent, vertical = false): 'before' | 'after' => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    return vertical ? (e.clientY < r.top + r.height / 2 ? 'before' : 'after') : e.clientX < r.left + r.width / 2 ? 'before' : 'after';
  };
  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files');

  const overFile = (e: DragEvent, f: CombineFile, vertical: boolean) => {
    const d = dragRef.current;
    if (!d && !hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = d ? 'move' : 'copy';
    if (d?.type === 'page' && !f.expanded) {
      setTarget({ kind: 'file', key: f.key, side: 'after' });
      return;
    }
    if (d?.type === 'page') return;
    const s = side(e, vertical);
    setTarget((t) => (t?.kind === 'file' && t.key === f.key && t.side === s ? t : { kind: 'file', key: f.key, side: s }));
  };

  const dropOnFile = (e: DragEvent, f: CombineFile) => {
    e.preventDefault();
    e.stopPropagation();
    const d = dragRef.current;
    const t = target;
    finish();
    const idx = files.findIndex((x) => x.key === f.key);
    if (!d) {
      const list = Array.from(e.dataTransfer.files ?? []);
      if (list.length) void combine.addFiles(list, t?.kind === 'file' && t.side === 'after' ? idx + 1 : idx);
      return;
    }
    if (d.type === 'file') {
      const from = files.findIndex((x) => x.key === d.key);
      const to = t?.kind === 'file' && t.side === 'after' ? idx + 1 : idx;
      combine.moveFile(from, to);
    } else {
      combine.movePage(d.key, d.index, f.key, f.entries.length);
    }
  };

  const overPage = (e: DragEvent, f: CombineFile, index: number) => {
    const d = dragRef.current;
    if (d?.type !== 'page') return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    const s = side(e);
    setTarget((t) => (t?.kind === 'page' && t.key === f.key && t.index === index && t.side === s ? t : { kind: 'page', key: f.key, index, side: s }));
  };

  const dropOnPage = (e: DragEvent, f: CombineFile, index: number) => {
    const d = dragRef.current;
    if (d?.type !== 'page') return;
    e.preventDefault();
    e.stopPropagation();
    const t = target;
    finish();
    const at = t?.kind === 'page' && t.side === 'after' ? index + 1 : index;
    combine.movePage(d.key, d.index, f.key, at);
  };

  const finish = () => {
    dragRef.current = null;
    setDrag(null);
    setTarget(null);
    setExternal(false);
  };

  const onBodyOver = (e: DragEvent) => {
    const d = dragRef.current;
    if (!d && !hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = d ? 'move' : 'copy';
    if (!d) setExternal(true);
    if (d?.type === 'file') setTarget((t) => (t?.kind === 'end' ? t : { kind: 'end' }));
  };
  const onBodyDrop = (e: DragEvent) => {
    const d = dragRef.current;
    if (!d && !hasFiles(e)) return;
    e.preventDefault();
    finish();
    if (!d) {
      const list = Array.from(e.dataTransfer.files ?? []);
      if (list.length) void combine.addFiles(list);
      return;
    }
    if (d.type === 'file') combine.moveFile(files.findIndex((x) => x.key === d.key), files.length);
  };

  const onCombine = () =>
    void combine.run(() => {
      // Show the new binder in the viewer, not this tool.
      if (useApp.getState().activeTaskId === TASK_COMBINE) actions.openTask(null);
    });

  const empty = files.length === 0 && loading === 0;

  return (
    <div className="organize-combine" data-testid="organize-combine">
      <div className="organize-toolbar" role="toolbar" aria-label="Combine files">
        <Dropdown
          label="Add files"
          items={addMenu}
          trigger={
            <Button variant="ghost" size="sm" icon={Plus} iconEnd={ChevronDown} data-testid="organize-combine-add">
              Add files
            </Button>
          }
        />
        <Divider vertical className="organize-toolbar-divider" />
        <Dropdown
          label="Sort"
          items={[
            { id: 'organize-combine-sort-asc', label: 'Name (A to Z)', icon: ArrowDownAZ, run: () => combine.sortByName('asc') },
            { id: 'organize-combine-sort-desc', label: 'Name (Z to A)', icon: ArrowUpAZ, run: () => combine.sortByName('desc') },
          ]}
          trigger={
            <Button variant="ghost" size="sm" icon={ArrowDownAZ} iconEnd={ChevronDown} disabled={files.length < 2} data-testid="organize-combine-sort">
              Sort
            </Button>
          }
        />
        <IconButton
          icon={allExpanded ? ChevronsDownUp : ChevronsUpDown}
          label={allExpanded ? 'Collapse all files' : 'Expand all files'}
          disabled={!files.length}
          onClick={() => combine.expandAll(!allExpanded)}
          data-testid="organize-combine-expand-all"
        />
        <div className="organize-toolbar-spacer" />
        <span className="organize-combine-summary" data-testid="organize-combine-summary" aria-live="polite">
          {files.length ? `${plural(withPages, 'file', 'files')} · ${plural(total, 'page', 'pages')}` : 'No files added'}
          {withPages < files.length && ` (${plural(files.length - withPages, 'empty file', 'empty files')} skipped)`}
          {loading > 0 && (
            <>
              {' '}
              · <Spinner size={14} label="Adding files" /> adding…
            </>
          )}
        </span>
        {files.length > 0 && (
          <Button variant="ghost" size="sm" onClick={() => combine.reset()} data-testid="organize-combine-clear">
            Clear
          </Button>
        )}
        {docOpen && (
          <Button variant="secondary" size="sm" onClick={() => actions.openTask(null)} data-testid="organize-combine-cancel">
            Cancel
          </Button>
        )}
        <Button
          variant="primary"
          size="sm"
          icon={Combine}
          disabled={!canCombine}
          tooltip={canCombine ? undefined : 'Add at least two files to combine'}
          onClick={onCombine}
          data-testid="organize-combine-run"
        >
          Combine
        </Button>
      </div>

      <div
        className={clsx('organize-combine-body', external && 'is-external-over')}
        data-dropzone=""
        onDragOver={onBodyOver}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
            setExternal(false);
            if (target?.kind === 'end') setTarget(null);
          }
        }}
        onDrop={onBodyDrop}
        data-testid="organize-combine-body"
      >
        {empty ? (
          <div className="organize-combine-empty">
            <div className="organize-combine-drop" data-testid="organize-combine-drop">
              <FileDropZone
                accept={acceptString()}
                multiple
                onFiles={(list) => void combine.addFiles(list)}
                onReject={(bad) => actions.toast(`${bad.map((f) => `“${f.name}”`).join(', ')} can't be combined: this file type isn't supported.`, { kind: 'error' })}
                title="Drag and drop PDFs and other files here"
                hint={`or click to choose files.${converted ? ` ${converted}` : ''}`}
                className="organize-combine-drop-zone"
              />
            </div>
            <div className="organize-combine-or">
              <Button icon={FolderOpen} onClick={() => void combine.pickFromLibrary()} data-testid="organize-combine-library">
                Add from your files
              </Button>
            </div>
          </div>
        ) : (
          <div className="organize-combine-list" data-testid="organize-combine-list">
            {files.map((f, i) =>
              f.expanded ? (
                <FileStrip
                  key={f.key}
                  file={f}
                  index={i}
                  drag={drag}
                  target={target}
                  onDragStart={startDrag}
                  onOverFile={(e) => overFile(e, f, true)}
                  onDropFile={(e) => dropOnFile(e, f)}
                  onOverPage={overPage}
                  onDropPage={dropOnPage}
                />
              ) : (
                <FileCard key={f.key} file={f} index={i} drag={drag} target={target} onDragStart={startDrag} onOver={(e) => overFile(e, f, false)} onDrop={(e) => dropOnFile(e, f)} />
              ),
            )}
            {Array.from({ length: loading }, (_, k) => (
              <div key={`loading-${k}`} className="organize-cf-card is-loading" aria-busy>
                <div className="organize-cf-thumb">
                  <Spinner size={24} label="Adding file" />
                </div>
                <div className="organize-cf-name">Adding…</div>
              </div>
            ))}
            <button type="button" className={clsx('organize-cf-add', target?.kind === 'end' && 'is-drop-before')} onClick={() => void combine.pickFromDevice()} data-testid="organize-combine-add-card">
              <Plus size={28} strokeWidth={1.5} />
              <span>Add files</span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

interface CardProps {
  file: CombineFile;
  index: number;
  drag: DragItem | null;
  target: DropTarget | null;
  onDragStart(e: DragEvent, item: DragItem): void;
}

function FileMeta({ file }: { file: CombineFile }) {
  const n = file.entries.length;
  return (
    <span className="organize-cf-meta" data-testid="organize-combine-file-meta">
      {n === file.pageCount ? plural(n, 'page', 'pages') : `${n} of ${plural(file.pageCount, 'page', 'pages')}`} · {formatBytes(file.size)}
    </span>
  );
}

function FileCard({ file, index, drag, target, onDragStart, onOver, onDrop }: CardProps & { onOver(e: DragEvent): void; onDrop(e: DragEvent): void }) {
  const first = file.entries[0];
  const drop = target?.kind === 'file' && target.key === file.key ? target.side : null;
  return (
    <div
      className={clsx('organize-cf-card', drag?.type === 'file' && drag.key === file.key && 'is-dragging', drop && `is-drop-${drop}`)}
      draggable
      onDragStart={(e) => onDragStart(e, { type: 'file', key: file.key })}
      onDragOver={onOver}
      onDrop={onDrop}
      data-testid="organize-combine-file"
      data-name={file.name}
      data-pages={file.entries.length}
      title={file.name}
    >
      <span className="organize-cf-order" aria-hidden>
        {index + 1}
      </span>
      <div className={clsx('organize-cf-thumb', file.entries.length > 1 && 'is-stack')}>
        {first ? <SourceThumb sourceId={first.sourceId} index={first.page} width={thumbWidth(first.sourceId, first.page, 120)} /> : <span className="organize-dialog-muted">No pages</span>}
      </div>
      <div className="organize-cf-name">{file.name}</div>
      <FileMeta file={file} />
      <div className="organize-cf-actions">
        <IconButton size="sm" icon={Layers} label="Expand pages" onClick={() => combine.setExpanded(file.key, true)} data-testid="organize-combine-expand" />
        <IconButton size="sm" icon={X} label={`Remove ${file.name}`} onClick={() => combine.remove(file.key)} data-testid="organize-combine-remove" />
      </div>
    </div>
  );
}

function FileStrip({
  file,
  index,
  drag,
  target,
  onDragStart,
  onOverFile,
  onDropFile,
  onOverPage,
  onDropPage,
}: CardProps & {
  onOverFile(e: DragEvent): void;
  onDropFile(e: DragEvent): void;
  onOverPage(e: DragEvent, f: CombineFile, index: number): void;
  onDropPage(e: DragEvent, f: CombineFile, index: number): void;
}) {
  const drop = target?.kind === 'file' && target.key === file.key ? target.side : null;
  const changed = file.entries.length !== file.pageCount || file.entries.some((e, i) => e.sourceId !== file.sourceId || e.page !== i);
  return (
    <section
      className={clsx('organize-cf-strip', drag?.type === 'file' && drag.key === file.key && 'is-dragging', drop && `is-drop-${drop}`)}
      onDragOver={onOverFile}
      onDrop={onDropFile}
      data-testid="organize-combine-file"
      data-name={file.name}
      data-pages={file.entries.length}
      data-expanded=""
    >
      <header className="organize-cf-strip-head" draggable onDragStart={(e) => onDragStart(e, { type: 'file', key: file.key })}>
        <span className="organize-cf-order" aria-hidden>
          {index + 1}
        </span>
        <span className="organize-cf-name">{file.name}</span>
        <FileMeta file={file} />
        <span className="organize-toolbar-spacer" />
        {changed && (
          <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => combine.resetPages(file.key)} data-testid="organize-combine-restore">
            Restore pages
          </Button>
        )}
        <IconButton size="sm" icon={ChevronsDownUp} label="Collapse" onClick={() => combine.setExpanded(file.key, false)} data-testid="organize-combine-collapse" />
        <IconButton size="sm" icon={X} label={`Remove ${file.name}`} onClick={() => combine.remove(file.key)} data-testid="organize-combine-remove" />
      </header>
      <div className="organize-cf-pages">
        {file.entries.map((e, i) => {
          const src = getSource(e.sourceId);
          const pd = target?.kind === 'page' && target.key === file.key && target.index === i ? target.side : null;
          return (
            <div
              key={`${e.sourceId}:${e.page}`}
              className={clsx('organize-cf-page', drag?.type === 'page' && drag.key === file.key && drag.index === i && 'is-dragging', pd && `is-drop-${pd}`)}
              draggable
              onDragStart={(ev) => onDragStart(ev, { type: 'page', key: file.key, index: i })}
              onDragOver={(ev) => onOverPage(ev, file, i)}
              onDrop={(ev) => onDropPage(ev, file, i)}
              data-testid="organize-combine-page"
              data-source-page={e.page + 1}
              title={src && e.sourceId !== file.sourceId ? `Page ${e.page + 1} of ${src.name}` : `Page ${e.page + 1}`}
            >
              <div className="organize-cf-page-thumb">
                <SourceThumb sourceId={e.sourceId} index={e.page} width={thumbWidth(e.sourceId, e.page, 84)} />
                <IconButton
                  size="sm"
                  icon={X}
                  label="Remove page"
                  className="organize-cf-page-remove"
                  onClick={() => combine.removePage(file.key, i)}
                  data-testid="organize-combine-page-remove"
                />
              </div>
              <span className="organize-cf-page-label">
                {e.sourceId !== file.sourceId && src ? `${src.name.replace(/\.pdf$/i, '')} · ` : ''}
                {e.page + 1}
              </span>
            </div>
          );
        })}
        {!file.entries.length && <div className="organize-dialog-muted organize-cf-no-pages">All pages removed. Drop pages here or restore them.</div>}
      </div>
    </section>
  );
}
