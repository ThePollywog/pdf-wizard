import { useMemo } from 'react';
import { ArrowRight, FileText, FolderOpen, X } from 'lucide-react';
import { useRegistry } from '@/core/registry';
import { actions, useApp, useDoc } from '@/core/store';
import type { DocId } from '@/core/types';
import { PageThumbnail } from '@/core/viewer';
import { Button, FileDropZone, IconButton } from '@/core/ui';
import { ErrorBoundary } from './ErrorBoundary';
import { Library } from './Library';
import { TaskIcon, useSortedTasks } from './AllTools';
import { openAccept, openFilePicker, openFiles, openTaskFlow, requestCloseDoc } from './docActions';

export function greeting(d = new Date()): string {
  const h = d.getHours();
  if (h < 5) return 'Good evening';
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

function DropArt() {
  return (
    <svg width="64" height="64" viewBox="0 0 64 64" aria-hidden className="home-drop-art">
      <rect x="14" y="8" width="36" height="46" rx="4" fill="var(--bg-elevated)" stroke="var(--border-strong)" strokeWidth="1.5" />
      <path d="M40 8v8a3 3 0 0 0 3 3h7" fill="none" stroke="var(--border-strong)" strokeWidth="1.5" />
      <rect x="20" y="40" width="20" height="8" rx="2" fill="var(--brand)" />
      <text x="30" y="46.5" textAnchor="middle" fontSize="6.5" fontWeight="800" fill="#fff" fontFamily="var(--font)">
        PDF
      </text>
      <path d="M22 26h20M22 31h14" stroke="var(--border-strong)" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx="48" cy="48" r="10" fill="var(--accent)" />
      <path d="M48 53v-9m-4 4 4-4 4 4" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function OpenDocCard({ id }: { id: DocId }) {
  const name = useDoc(id, (d) => d?.name ?? '');
  const pages = useDoc(id, (d) => d?.pages.length ?? 0);
  const dirty = useDoc(id, (d) => !!d?.dirty);
  const hasPdf = useDoc(id, (d) => !!d?.pdf);
  return (
    <li className="open-doc" data-testid="open-doc">
      <button type="button" className="open-doc-main" onClick={() => actions.setActiveDoc(id)} title={name}>
        <span className="open-doc-thumb">
          {hasPdf && pages > 0 ? (
            <ErrorBoundary name="thumbnail" silent>
              <PageThumbnail docId={id} pageIndex={0} width={56} className="open-doc-thumb-img" />
            </ErrorBoundary>
          ) : (
            <FileText size={22} strokeWidth={1.5} />
          )}
        </span>
        <span className="open-doc-text">
          <span className="open-doc-name">{name}</span>
          <span className="open-doc-meta">
            {pages ? `${pages} page${pages === 1 ? '' : 's'}` : 'Opening…'}
            {dirty && <span className="open-doc-dirty"> · Unsaved changes</span>}
          </span>
        </span>
      </button>
      <IconButton icon={X} size="sm" label={`Close ${name}`} className="open-doc-close" onClick={() => void requestCloseDoc(id)} />
    </li>
  );
}

export function Home() {
  const userName = useApp((s) => s.prefs.userName);
  const tabs = useApp((s) => s.tabs);
  const sections = useRegistry((s) => s.homeSections);
  const tasks = useSortedTasks();
  const featured = useMemo(() => {
    const f = tasks.filter((t) => t.featured != null).sort((a, b) => (a.featured ?? 0) - (b.featured ?? 0));
    return (f.length ? f : tasks).slice(0, 8);
  }, [tasks]);
  const first = (userName || '').trim().split(/\s+/)[0];
  const showName = first && first.toLowerCase() !== 'guest';

  return (
    <div className="page home" data-testid="home">
      <div className="page-inner">
        <section className="home-hero">
          <div className="home-hero-text">
            <h1 className="home-title">
              {greeting()}
              {showName ? `, ${first}` : ''}
            </h1>
            <p className="home-subtitle">View, edit, comment on, sign and share PDFs, right in your browser.</p>
          </div>
          <div className="home-hero-actions">
            <Button variant="primary" size="lg" icon={FolderOpen} onClick={() => void openFilePicker()} data-testid="home-open">
              Open a file
            </Button>
          </div>
        </section>

        <div className={featured.length > 0 ? 'home-top' : 'home-top is-single'}>
          <FileDropZone className="home-drop" accept={openAccept()} multiple onFiles={(f) => void openFiles(f)} onReject={(bad) => actions.toast(`Can't open ${bad.map((b) => b.name).join(', ')}: unsupported file type`, { kind: 'warning' })}>
            <div className="home-drop-inner">
              <DropArt />
              <div className="home-drop-title">Drop a PDF here to open it</div>
              <div className="home-drop-hint">
                or <span className="link">choose a file</span> from your device
              </div>
            </div>
          </FileDropZone>

          {featured.length > 0 && (
            <section className="home-featured" aria-labelledby="featured-title">
              <div className="home-section-head">
                <h2 id="featured-title" className="home-section-title">
                  Recommended tools
                </h2>
                <button type="button" className="link-btn" onClick={() => actions.setRoute('tools')} data-testid="see-all-tools">
                  See all tools <ArrowRight size={14} />
                </button>
              </div>
              <div className="featured-grid">
                {featured.map((t) => (
                  <button key={t.id} type="button" className="featured-card" onClick={() => void openTaskFlow(t.id)} data-testid="featured-task" data-task-id={t.id}>
                    <TaskIcon task={t} size={40} />
                    <span className="featured-card-label">{t.label}</span>
                    <span className="featured-card-desc">{t.description}</span>
                  </button>
                ))}
              </div>
            </section>
          )}
        </div>

        {tabs.length > 0 && (
          <section className="home-section" aria-labelledby="open-docs-title">
            <div className="home-section-head">
              <h2 id="open-docs-title" className="home-section-title">
                Open documents
              </h2>
            </div>
            <ul className="open-docs">
              {tabs.map((id) => (
                <OpenDocCard key={id} id={id} />
              ))}
            </ul>
          </section>
        )}

        {sections.map((s) => (
          <ErrorBoundary key={s.id} name={`the “${s.id}” section`} compact>
            <s.Component />
          </ErrorBoundary>
        ))}

        <Library />
      </div>
    </div>
  );
}
