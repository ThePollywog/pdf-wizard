/**
 * "Recent files" — the server library on Home: list / grid, search, starred filter, sort, and per-file
 * open / rename / download / share / delete / star. Reloads on the 'pdfwizard:library-changed' event.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as RMouseEvent } from 'react';
import {
  CloudOff, CloudUpload, Download, EllipsisVertical, ExternalLink, FilePen, FileText, LayoutGrid, List, RotateCcw, Search, Send,
  SearchX, Star, Trash2,
} from 'lucide-react';
import { library, LIBRARY_CHANGED, type FileMeta } from '@/core/library';
import { actions, useApp } from '@/core/store';
import { formatBytes, formatDate, pickFiles } from '@/core/util';
import {
  Button, confirmDialog, Dropdown, EmptyState, IconButton, promptDialog, SegmentedControl, Select, showContextMenu, TextField,
  type MenuEntry,
} from '@/core/ui';
import {
  downloadLibraryFile, ensurePdfName, errorMessage, notifyLibraryChanged, openLibraryFile, shareLibraryFile, toastError,
} from './docActions';
import { shell, useShell } from './uiStore';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

/** "Just now", "12 min ago", "Today, 3:04 PM", "Yesterday, 9:12 AM", "Mar 4", "Mar 4, 2023". */
export function relativeTime(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '';
  const diff = now - t;
  if (diff < 45_000) return 'Just now';
  if (diff < 60 * 60_000) return `${Math.max(1, Math.round(diff / 60_000))} min ago`;
  const d = new Date(t);
  const today = new Date(now);
  const time = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const sameDay = (a: Date, b: Date) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(d, today)) return `Today, ${time}`;
  const y = new Date(now - 86_400_000);
  if (sameDay(d, y)) return `Yesterday, ${time}`;
  return d.toLocaleDateString(undefined, d.getFullYear() === today.getFullYear() ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

/** True for clicks on the row itself (not its buttons, nor portal content such as an open menu). */
const isOwnClick = (e: RMouseEvent) => {
  const t = e.target as HTMLElement;
  return (e.currentTarget as Node).contains(t) && !t.closest('button, a, input');
};

type Filter = 'all' | 'starred';
type Sort = 'modified' | 'name' | 'size';

function sortFiles(files: FileMeta[], sort: Sort): FileMeta[] {
  const out = [...files];
  if (sort === 'name') out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  else if (sort === 'size') out.sort((a, b) => b.size - a.size);
  else out.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
  return out;
}

function Thumb({ file, size }: { file: FileMeta; size: 'sm' | 'lg' }) {
  const [failed, setFailed] = useState(false);
  const src = file.thumbnailUrl;
  return (
    <span className={cx('lib-thumb', `lib-thumb-${size}`)} aria-hidden>
      {failed || !src ? (
        <FileText size={size === 'sm' ? 18 : 36} strokeWidth={1.5} className="lib-thumb-fallback" />
      ) : (
        <img src={src} alt="" loading="lazy" draggable={false} onError={() => setFailed(true)} />
      )}
    </span>
  );
}

export function Library() {
  const [files, setFiles] = useState<FileMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const view = useShell((s) => s.libraryView);
  const sort = useShell((s) => s.librarySort);
  const [uploading, setUploading] = useState(false);
  const reqId = useRef(0);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 220);
    return () => clearTimeout(t);
  }, [query]);

  const load = useCallback(async () => {
    const id = ++reqId.current;
    setLoading(true);
    try {
      const list = await library.listFiles({ q: debounced || undefined, starred: filter === 'starred' || undefined });
      if (id !== reqId.current) return;
      setFiles(list);
      setError(null);
      if (!debounced && filter === 'all') shell.setRecentFiles(sortFiles(list, 'modified'));
    } catch (e) {
      if (id !== reqId.current) return;
      setError(errorMessage(e));
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [debounced, filter]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onChange = () => void load();
    const onVisible = () => document.visibilityState === 'visible' && void load();
    window.addEventListener(LIBRARY_CHANGED, onChange);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener(LIBRARY_CHANGED, onChange);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  const sorted = useMemo(() => (files ? sortFiles(files, sort) : null), [files, sort]);

  const replace = (meta: FileMeta) => setFiles((fs) => fs?.map((f) => (f.id === meta.id ? meta : f)) ?? fs);

  const toggleStar = async (f: FileMeta) => {
    const starred = !f.starred;
    replace({ ...f, starred });
    try {
      const meta = await library.patchFile(f.id, { starred });
      if (filter === 'starred' && !meta.starred) setFiles((fs) => fs?.filter((x) => x.id !== f.id) ?? fs);
      else replace(meta);
    } catch (e) {
      replace(f);
      toastError(e, starred ? "Couldn't star the file" : "Couldn't unstar the file");
    }
  };

  const rename = async (f: FileMeta) => {
    const name = await promptDialog({
      title: 'Rename file',
      label: 'File name',
      defaultValue: f.name,
      confirmLabel: 'Rename',
      selectBaseName: true,
      validate: (v) => (v.trim() === '' ? 'Enter a file name' : /[\\/:*?"<>|]/.test(v) ? 'A file name can\'t contain \\ / : * ? " < > |' : null),
    });
    if (!name) return;
    const next = ensurePdfName(name);
    if (next === f.name) return;
    try {
      const meta = await library.patchFile(f.id, { name: next });
      replace(meta);
      // Keep open tabs of this file in sync.
      const s = useApp.getState();
      for (const id of s.tabs) if (s.docs[id]?.fileId === f.id && !s.docs[id]?.ext.shareToken) actions.rename(id, meta.name);
      actions.toast(`Renamed to ${meta.name}`, { kind: 'success' });
    } catch (e) {
      toastError(e, "Couldn't rename the file");
    }
  };

  const remove = async (f: FileMeta) => {
    const ok = await confirmDialog({
      title: 'Delete file?',
      message: (
        <>
          <b>{f.name}</b> will be permanently deleted from your files. Tabs where it is open stay open until you close them.
        </>
      ),
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    try {
      await library.deleteFile(f.id);
      setFiles((fs) => fs?.filter((x) => x.id !== f.id) ?? fs);
      const s = useApp.getState();
      // Open copies become local documents (saving creates a new library file).
      for (const id of s.tabs) if (s.docs[id]?.fileId === f.id) actions.updateDoc(id, { fileId: null });
      shell.setRecentFiles(useShell.getState().recentFiles.filter((x) => x.id !== f.id));
      actions.toast(`Deleted ${f.name}`, { kind: 'success' });
    } catch (e) {
      toastError(e, "Couldn't delete the file");
    }
  };

  const upload = async () => {
    const picked = await pickFiles({ accept: '.pdf,application/pdf', multiple: true });
    if (!picked.length) return;
    setUploading(true);
    let ok = 0;
    try {
      for (const file of picked) {
        try {
          await library.uploadFile(file, file.name);
          ok++;
        } catch (e) {
          toastError(e, `Couldn't upload ${file.name}`);
        }
      }
    } finally {
      setUploading(false);
    }
    if (ok) {
      actions.toast(ok === 1 ? `Uploaded ${picked[0].name}` : `Uploaded ${ok} files`, { kind: 'success' });
      notifyLibraryChanged();
    }
  };

  const menuFor = (f: FileMeta): MenuEntry[] => [
    { id: 'lib.open', label: 'Open', icon: ExternalLink, run: () => void openLibraryFile(f.id) },
    { id: 'lib.star', label: f.starred ? 'Remove from starred' : 'Add to starred', icon: Star, run: () => toggleStar(f) },
    'divider',
    { id: 'lib.rename', label: 'Rename…', icon: FilePen, run: () => rename(f) },
    { id: 'lib.download', label: 'Download', icon: Download, run: () => downloadLibraryFile(f) },
    { id: 'lib.share', label: 'Send a copy…', icon: Send, run: () => shareLibraryFile(f) },
    'divider',
    { id: 'lib.delete', label: 'Delete', icon: Trash2, danger: true, run: () => remove(f) },
  ];

  const open = (f: FileMeta) => void openLibraryFile(f.id);
  const onContext = (e: RMouseEvent, f: FileMeta) => showContextMenu(e, menuFor(f));

  const star = (f: FileMeta, size: 'sm' | 'md' = 'sm') => (
    <IconButton
      icon={Star}
      size={size}
      label={f.starred ? 'Remove from starred' : 'Add to starred'}
      className={cx('lib-star', f.starred && 'is-starred')}
      aria-pressed={f.starred}
      data-testid="library-star"
      onClick={(e) => {
        e.stopPropagation();
        void toggleStar(f);
      }}
    />
  );
  const more = (f: FileMeta) => (
    <Dropdown
      trigger={<IconButton icon={EllipsisVertical} size="sm" label="More actions" data-testid="library-more" onClick={(e) => e.stopPropagation()} />}
      items={() => menuFor(f)}
      align="end"
      minWidth={200}
    />
  );

  const count = sorted?.length ?? 0;
  let body;
  if (error && !files) {
    body = (
      <EmptyState
        icon={CloudOff}
        title="Couldn't load your files"
        description={error}
        action={
          <Button icon={RotateCcw} onClick={() => void load()}>
            Try again
          </Button>
        }
      />
    );
  } else if (!sorted) {
    body = (
      <div className={cx('lib-skeleton', view === 'grid' && 'is-grid')} aria-busy="true" aria-label="Loading files">
        {Array.from({ length: view === 'grid' ? 8 : 5 }, (_, i) => (
          <div key={i} className="lib-skeleton-item">
            <span className="skeleton lib-skeleton-thumb" />
            <span className="skeleton lib-skeleton-line" />
            <span className="skeleton lib-skeleton-line is-short" />
          </div>
        ))}
      </div>
    );
  } else if (!count) {
    body = debounced ? (
      <EmptyState icon={SearchX} title={`No files match “${debounced}”`} description="Check the spelling or try a different name." action={<Button onClick={() => setQuery('')}>Clear search</Button>} />
    ) : filter === 'starred' ? (
      <EmptyState icon={Star} title="No starred files" description="Star files to find them here quickly." action={<Button onClick={() => setFilter('all')}>Show all files</Button>} />
    ) : (
      <EmptyState
        icon={CloudUpload}
        title="No files yet"
        description="Files you save or upload are kept here, in this browser on this computer."
        action={
          <Button variant="accent" icon={CloudUpload} onClick={() => void upload()} loading={uploading}>
            Upload files
          </Button>
        }
      />
    );
  } else if (view === 'grid') {
    body = (
      <ul className="lib-grid" data-testid="library-grid">
        {sorted.map((f) => (
          <li
            key={f.id}
            className="lib-card"
            data-testid="library-item"
            data-file-id={f.id}
            onClick={(e) => isOwnClick(e) && open(f)}
            onContextMenu={(e) => isOwnClick(e) && onContext(e, f)}
          >
            <div className="lib-card-thumb">
              <Thumb file={f} size="lg" />
              <div className="lib-card-star">{star(f)}</div>
            </div>
            <div className="lib-card-body">
              <button type="button" className="lib-name-btn" onClick={() => open(f)} title={f.name}>
                {f.name}
              </button>
              <div className="lib-card-meta">
                <span title={formatDate(f.modifiedAt)}>{relativeTime(f.modifiedAt)}</span>
                <span aria-hidden>·</span>
                <span>{formatBytes(f.size)}</span>
              </div>
            </div>
            <div className="lib-card-more">{more(f)}</div>
          </li>
        ))}
      </ul>
    );
  } else {
    body = (
      <table className="lib-table" data-testid="library-list">
        <thead>
          <tr>
            <th className="lib-col-name">Name</th>
            <th className="lib-col-mod">Modified</th>
            <th className="lib-col-size">Size</th>
            <th className="lib-col-pages">Pages</th>
            <th className="lib-col-actions">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((f) => (
            <tr
              key={f.id}
              className="lib-row"
              data-testid="library-item"
              data-file-id={f.id}
              onClick={(e) => isOwnClick(e) && open(f)}
              onContextMenu={(e) => isOwnClick(e) && onContext(e, f)}
            >
              <td className="lib-col-name">
                <div className="lib-name-cell">
                  <Thumb file={f} size="sm" />
                  <button type="button" className="lib-name-btn" onClick={() => open(f)} title={f.name}>
                    {f.name}
                  </button>
                  {star(f)}
                </div>
              </td>
              <td className="lib-col-mod" title={formatDate(f.modifiedAt)}>
                {relativeTime(f.modifiedAt)}
              </td>
              <td className="lib-col-size">{formatBytes(f.size)}</td>
              <td className="lib-col-pages">{f.pages || '—'}</td>
              <td className="lib-col-actions">{more(f)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }

  return (
    <section className="home-section lib" aria-labelledby="lib-title" data-testid="library">
      <div className="lib-head">
        <div className="lib-title-wrap">
          <h2 id="lib-title" className="home-section-title">
            Recent files
          </h2>
          {files && <span className="lib-count">{count}</span>}
          {loading && files && <span className="lib-refreshing" aria-live="polite">Updating…</span>}
        </div>
        <div className="lib-controls">
          <TextField
            size="sm"
            icon={Search}
            value={query}
            onChange={setQuery}
            placeholder="Search your files"
            aria-label="Search your files"
            className="lib-search"
            data-testid="library-search"
            type="search"
          />
          <SegmentedControl<Filter>
            size="sm"
            value={filter}
            onChange={setFilter}
            label="Filter"
            options={[
              { value: 'all', label: 'All' },
              { value: 'starred', label: 'Starred', icon: Star },
            ]}
          />
          <Select<Sort>
            size="sm"
            value={sort}
            onChange={(v) => shell.setLibrarySort(v)}
            aria-label="Sort by"
            options={[
              { value: 'modified', label: 'Last modified' },
              { value: 'name', label: 'Name' },
              { value: 'size', label: 'Size' },
            ]}
          />
          <SegmentedControl<'list' | 'grid'>
            size="sm"
            value={view}
            onChange={(v) => shell.setLibraryView(v)}
            label="View"
            options={[
              { value: 'list', icon: List, title: 'List view' },
              { value: 'grid', icon: LayoutGrid, title: 'Grid view' },
            ]}
          />
          <Button size="sm" icon={CloudUpload} onClick={() => void upload()} loading={uploading} data-testid="library-upload">
            Upload
          </Button>
        </div>
      </div>
      {error && files && (
        <div className="lib-inline-error" role="alert">
          <CloudOff size={16} /> {error}
          <Button size="sm" variant="ghost" onClick={() => void load()}>
            Retry
          </Button>
        </div>
      )}
      {body}
    </section>
  );
}
