/** Picker for PDFs stored in the server library ("Your files"). */
import { useEffect, useMemo, useState } from 'react';
import { Check, FileText, FolderOpen, Search } from 'lucide-react';
import clsx from 'clsx';
import { library, type FileMeta } from '@/core/library';
import { actions } from '@/core/store';
import { Button, EmptyState, Modal, Spinner, TextField } from '@/core/ui';
import { formatBytes, formatDate } from '@/core/util';
import { errMsg } from '../util';
import { plural } from '../ranges';

export interface LibraryPickerOptions {
  title: string;
  confirmLabel: string;
  multiple?: boolean;
}

function Thumb({ file }: { file: FileMeta }) {
  const [failed, setFailed] = useState(false);
  const src = file.thumbnailUrl;
  return (
    <span className="organize-lib-thumb" aria-hidden>
      {failed || !src ? <FileText size={20} strokeWidth={1.5} /> : <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} draggable={false} />}
    </span>
  );
}

function PickerBody({ opts, close }: { opts: LibraryPickerOptions; close(r: FileMeta[] | null): void }) {
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [files, setFiles] = useState<FileMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [picked, setPicked] = useState<string[]>([]);

  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 200);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    let live = true;
    setError(null);
    library
      .listFiles(query ? { q: query } : {})
      .then((list) => {
        if (!live) return;
        setFiles([...list].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)));
      })
      .catch((e) => {
        if (live) setError(errMsg(e));
      });
    return () => {
      live = false;
    };
  }, [query, reload]);

  const byId = useMemo(() => new Map((files ?? []).map((f) => [f.id, f])), [files]);
  const [known, setKnown] = useState(new Map<string, FileMeta>());
  useEffect(() => {
    if (files) setKnown((k) => new Map([...k, ...files.map((f) => [f.id, f] as [string, FileMeta])]));
  }, [files]);

  const toggle = (id: string) => {
    if (!opts.multiple) {
      setPicked([id]);
      return;
    }
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  };

  const result = picked.map((id) => byId.get(id) ?? known.get(id)).filter((f): f is FileMeta => !!f);
  const confirm = () => {
    if (result.length) close(result);
  };

  let body;
  if (error) {
    body = (
      <EmptyState
        compact
        icon={FolderOpen}
        title="Couldn't load your files"
        description={error}
        action={
          <Button onClick={() => setReload((n) => n + 1)} data-testid="organize-library-retry">
            Try again
          </Button>
        }
      />
    );
  } else if (!files) {
    body = (
      <div className="organize-lib-loading">
        <Spinner /> Loading your files…
      </div>
    );
  } else if (!files.length) {
    body = (
      <EmptyState
        compact
        icon={FolderOpen}
        title={query ? 'No matching files' : 'No files yet'}
        description={query ? `Nothing matches “${query}”.` : 'Files you save to your library appear here.'}
      />
    );
  } else {
    body = (
      <ul className="organize-lib-list" role="listbox" aria-multiselectable={opts.multiple || undefined} aria-label="Your files">
        {files.map((f) => {
          const on = picked.includes(f.id);
          const order = picked.indexOf(f.id);
          return (
            <li
              key={f.id}
              role="option"
              aria-selected={on}
              tabIndex={0}
              className={clsx('organize-lib-item', on && 'is-selected')}
              data-testid="organize-library-item"
              data-file-id={f.id}
              data-file-name={f.name}
              onClick={() => toggle(f.id)}
              onDoubleClick={() => close([...result.filter((r) => r.id !== f.id), f])}
              onKeyDown={(e) => {
                if (e.key === ' ' || e.key === 'Enter') {
                  e.preventDefault();
                  if (e.key === 'Enter' && on) confirm();
                  else toggle(f.id);
                }
              }}
            >
              <span className={clsx('organize-lib-check', on && 'is-on')} aria-hidden>
                {on ? opts.multiple && picked.length > 1 ? order + 1 : <Check size={12} strokeWidth={3} /> : null}
              </span>
              <Thumb file={f} />
              <span className="organize-lib-text">
                <span className="organize-lib-name" title={f.name}>
                  {f.name}
                </span>
                <span className="organize-lib-meta">
                  {plural(f.pages, 'page', 'pages')} · {formatBytes(f.size)} · {formatDate(f.modifiedAt)}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <Modal
      title={opts.title}
      icon={FolderOpen}
      width={560}
      onClose={() => close(null)}
      className="organize-dialog organize-lib-dialog"
      footerStart={
        opts.multiple && result.length ? <span className="organize-dialog-muted">{plural(result.length, 'file', 'files')} selected</span> : undefined
      }
      footer={
        <>
          <Button onClick={() => close(null)} data-testid="organize-library-cancel">
            Cancel
          </Button>
          <Button variant="primary" disabled={!result.length} onClick={confirm} data-testid="organize-library-ok">
            {opts.confirmLabel}
          </Button>
        </>
      }
    >
      <div className="organize-lib" data-testid="organize-library">
        <TextField
          icon={Search}
          value={q}
          onChange={setQ}
          placeholder="Search your files"
          aria-label="Search your files"
          autoFocus
          data-testid="organize-library-search"
        />
        <div className="organize-lib-body">{body}</div>
      </div>
    </Modal>
  );
}

/** Resolves with the chosen files (in the order picked), or null when cancelled. */
export function libraryPickerDialog(opts: LibraryPickerOptions): Promise<FileMeta[] | null> {
  return actions.openModal<FileMeta[] | null>((close) => <PickerBody opts={opts} close={close} />).then((r) => r ?? null);
}
