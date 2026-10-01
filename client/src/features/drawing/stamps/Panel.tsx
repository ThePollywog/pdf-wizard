/**
 * Left panel of the "Stamp" task: the stamp palette (Standard business, Dynamic, Sign here,
 * Custom). Clicking a stamp makes it current and arms the Stamp tool; custom stamps are created
 * from PNG/JPG images or PDF pages and can be renamed and deleted.
 */
import { useMemo, useState } from 'react';
import { FileImage, FileText, MoreHorizontal, Pencil, Stamp as StampIcon, Trash2 } from 'lucide-react';
import { actions, useApp } from '@/core/store';
import { pickFiles } from '@/core/util';
import { Button, confirmDialog, Dropdown, EmptyState, FileDropZone, promptDialog, Tabs } from '@/core/ui';
import type { StampData } from '../model';
import { CATALOG, SET_LABELS, type CatalogStamp } from './catalog';
import {
  addCustomStamp, CUSTOM_CAP, deleteCustomStamp, pdfPageCount, renameCustomStamp, setCurrentStamp, stampDataFor, stampFromImage, stampFromPdf,
  STAMP_TOOL, titleCase, useCurrentStamp, useCustomStamps, type CustomStamp, type StampRef,
} from './custom';
import { StampThumb } from './Thumb';
import { ReadOnlyNotice } from '../Notice';

type Tab = 'standard' | 'dynamic' | 'sign' | 'custom';
const TABS: { id: Tab; label: string }[] = [
  { id: 'standard', label: 'Standard' },
  { id: 'dynamic', label: 'Dynamic' },
  { id: 'sign', label: 'Sign here' },
  { id: 'custom', label: 'Custom' },
];

const IMAGE_ACCEPT = 'image/png,image/jpeg,.png,.jpg,.jpeg';
const PDF_ACCEPT = 'application/pdf,.pdf';

function choose(ref: StampRef) {
  setCurrentStamp(ref);
  const s = useApp.getState();
  if (s.activeToolId !== STAMP_TOOL) actions.setTool(STAMP_TOOL);
}

function Tile({ refr, data, title, current, children }: { refr: StampRef; data: StampData; title: string; current: boolean; children?: React.ReactNode }) {
  return (
    <div className={`drawing-stamp-tile${current ? ' is-current' : ''}`}>
      <button
        type="button"
        className="drawing-stamp-tile-btn"
        aria-pressed={current}
        title={`${title} — click, then click the page`}
        aria-label={title}
        data-testid={`drawing-stamp-${refr.set}-${refr.id}`}
        onClick={() => choose(refr)}
      >
        <StampThumb data={data} maxW={96} maxH={38} />
        {refr.set === 'custom' && <span className="drawing-stamp-tile-name">{title}</span>}
      </button>
      {children}
    </div>
  );
}

function CatalogGrid({ set, current }: { set: CatalogStamp['set']; current: StampRef | null }) {
  const user = useApp((s) => s.prefs.userName) || 'Guest';
  // Dynamic stamps show the name/time they would get now.
  const [now] = useState(() => new Date());
  const items = useMemo(
    () =>
      CATALOG.filter((s) => s.set === set).map((s) => {
        const ref = { set: s.set, id: s.id };
        return { s, ref, data: stampDataFor(ref, 0, user, now)! };
      }),
    [set, user, now],
  );
  return (
    <div className="drawing-stamp-grid" data-testid={`drawing-stamp-grid-${set}`}>
      {items.map(({ s, ref, data }) => (
        <Tile key={s.id} refr={ref} data={data} title={titleCase(s.label)} current={current?.set === s.set && current.id === s.id} />
      ))}
    </div>
  );
}

// ── custom stamps ────────────────────────────────────────────────────────────

/** A readable message for a PDF that pdf.js refused to open. */
function pdfOpenError(e: unknown): Error {
  const name = (e as { name?: string } | null)?.name;
  if (name === 'PasswordException') return new Error('This PDF is password-protected. Remove the password, then try again.');
  return new Error('This PDF could not be read. It may be damaged or not a PDF.');
}

async function createFromFile(file: File) {
  const isPdf = /pdf$/i.test(file.type) || /\.pdf$/i.test(file.name);
  try {
    if (isPdf) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const n = await pdfPageCount(bytes).catch((e: unknown) => {
        throw pdfOpenError(e);
      });
      let index = 0;
      if (n > 1) {
        const v = await promptDialog({
          title: 'Create stamp from PDF page',
          label: `Page (1–${n})`,
          defaultValue: '1',
          confirmLabel: 'Create stamp',
          validate: (s) => {
            const k = Number(s);
            return Number.isInteger(k) && k >= 1 && k <= n ? null : `Enter a page number from 1 to ${n}.`;
          },
        });
        if (v === null) return;
        index = Number(v) - 1;
      }
      const base = file.name.replace(/\.pdf$/i, '').slice(0, 50) || 'Custom stamp';
      const made = addCustomStamp(await stampFromPdf(bytes, index, n > 1 ? `${base} p${index + 1}` : base));
      if (made) created(made);
    } else {
      const made = addCustomStamp(await stampFromImage(file));
      if (made) created(made);
    }
  } catch (e) {
    actions.toast(e instanceof Error ? e.message : 'The stamp could not be created.', { kind: 'error' });
  }
}

function created(s: CustomStamp) {
  actions.toast(`Custom stamp “${s.name}” created`, { kind: 'success' });
  choose({ set: 'custom', id: s.id });
}

async function rename(s: CustomStamp) {
  const name = await promptDialog({
    title: 'Rename stamp',
    label: 'Name',
    defaultValue: s.name,
    confirmLabel: 'Rename',
    validate: (v) => (v.trim().length > 60 ? 'Use at most 60 characters.' : null),
  });
  if (name === null || !name.trim() || name.trim() === s.name) return;
  renameCustomStamp(s.id, name.trim());
}

async function remove(s: CustomStamp) {
  const ok = await confirmDialog({
    title: 'Delete custom stamp',
    message: `Delete “${s.name}”? Stamps already placed in documents are not affected.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  deleteCustomStamp(s.id);
  actions.toast('Custom stamp deleted', { kind: 'success' });
}

const fmtKB = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

function CustomSection({ current }: { current: StampRef | null }) {
  const list = useCustomStamps((s) => s.list);
  const used = useMemo(() => JSON.stringify(list).length, [list]);
  const pick = async (accept: string) => {
    const [f] = await pickFiles({ accept });
    if (f) await createFromFile(f);
  };
  return (
    <div className="drawing-stamp-custom">
      <div className="drawing-stamp-actions">
        <Button size="sm" icon={FileImage} onClick={() => void pick(IMAGE_ACCEPT)} data-testid="drawing-stamp-from-image">
          From image…
        </Button>
        <Button size="sm" icon={FileText} onClick={() => void pick(PDF_ACCEPT)} data-testid="drawing-stamp-from-pdf">
          From PDF…
        </Button>
      </div>
      {list.length === 0 ? (
        <FileDropZone
          accept={`${IMAGE_ACCEPT},${PDF_ACCEPT}`}
          onFiles={(fs) => fs[0] && void createFromFile(fs[0])}
          onReject={() => actions.toast('Custom stamps can be made from PNG or JPG images and PDF files.', { kind: 'warning' })}
          className="drawing-stamp-drop"
          title="Drop a PNG, JPG or PDF here"
          hint="or click to choose a file"
        >
          <EmptyState compact icon={StampIcon} title="No custom stamps yet" description="Drop a PNG, JPG or PDF here, or click to choose a file." />
        </FileDropZone>
      ) : (
        <FileDropZone
          accept={`${IMAGE_ACCEPT},${PDF_ACCEPT}`}
          clickable={false}
          onFiles={(fs) => fs[0] && void createFromFile(fs[0])}
          onReject={() => actions.toast('Custom stamps can be made from PNG or JPG images and PDF files.', { kind: 'warning' })}
          className="drawing-stamp-drop is-list"
        >
          <div className="drawing-stamp-grid" data-testid="drawing-stamp-grid-custom">
            {list.map((s) => {
              const ref = { set: 'custom' as const, id: s.id };
              const data = stampDataFor(ref, 0, '')!;
              return (
                <Tile key={s.id} refr={ref} data={data} title={s.name} current={current?.set === 'custom' && current.id === s.id}>
                  <Dropdown
                    label={`${s.name} options`}
                    items={[
                      { id: 'drawing-stamp-rename', label: 'Rename…', icon: Pencil, run: () => void rename(s) },
                      { id: 'drawing-stamp-delete', label: 'Delete', icon: Trash2, danger: true, run: () => void remove(s) },
                    ]}
                    trigger={
                      <button type="button" className="drawing-stamp-more" aria-label={`${s.name} options`} title="More options" data-testid={`drawing-stamp-more-${s.id}`}>
                        <MoreHorizontal size={14} strokeWidth={2} />
                      </button>
                    }
                  />
                </Tile>
              );
            })}
          </div>
        </FileDropZone>
      )}
      <div className="drawing-stamp-usage" data-testid="drawing-stamp-usage" title="Custom stamps are stored in this browser">
        <div className="drawing-meter" aria-hidden="true">
          <span style={{ width: `${Math.min(100, (used / CUSTOM_CAP) * 100)}%` }} />
        </div>
        <span>
          {list.length ? fmtKB(used) : '0 KB'} of {fmtKB(CUSTOM_CAP)} used
        </span>
      </div>
    </div>
  );
}

export function StampsPanel() {
  const current = useCurrentStamp();
  const [tab, setTab] = useState<Tab>(() => (current && current.set !== 'imported' ? (current.set as Tab) : 'standard'));
  const tool = useApp((s) => s.activeToolId);
  return (
    <div className="drawing-panel drawing-stamps-panel" data-testid="drawing-stamps-panel">
      <ReadOnlyNotice />
      <p className="drawing-panel-intro">
        {tool === STAMP_TOOL && current ? 'Click the page to place the stamp, or drag to size it.' : 'Choose a stamp, then click the page to place it.'}
      </p>
      <div data-testid="drawing-stamp-tabs">
        <Tabs size="sm" tabs={TABS} value={tab} onChange={(id) => setTab(id as Tab)} className="drawing-stamp-tabs" />
      </div>
      <div className="drawing-stamp-set-label">{SET_LABELS[tab]}</div>
      {tab === 'custom' ? <CustomSection current={current} /> : <CatalogGrid set={tab} current={current} />}
    </div>
  );
}
