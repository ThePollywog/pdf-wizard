/**
 * File › Document Properties: Description, Security, Fonts, Initial View and Custom tabs.
 * Every edit is applied as a single undoable setMeta when the user clicks OK.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { FileText, Info, Lock, LockOpen, Plus, Trash2, Type } from 'lucide-react';
import type { DocId, DocMeta, DocState } from '@/core/types';
import * as engine from '@/core/engine';
import { reg } from '@/core/registry';
import { actions, getDoc, useApp } from '@/core/store';
import { Button, Checkbox, EmptyState, Modal, NumberField, ProgressBar, Select, Spinner, TextField } from '@/core/ui';
import { formatBytes, formatDate } from '@/core/util';
import { canEdit, collator, errMsg } from '../util';
import { customNameError, currentCustom, readCustom, sameCustom } from './custom';
import { listFonts, type FontInfo } from './fonts';
import {
  currentInitialView, readInitialView, sameView, type InitialView, type LayoutName, type Magnification, type NavMeta, type PageModeName,
} from './initialView';

export type PropsTab = 'description' | 'security' | 'fonts' | 'initial' | 'custom';

const TABS: { id: PropsTab; label: string }[] = [
  { id: 'description', label: 'Description' },
  { id: 'security', label: 'Security' },
  { id: 'fonts', label: 'Fonts' },
  { id: 'initial', label: 'Initial View' },
  { id: 'custom', label: 'Custom' },
];

type DescKey = 'title' | 'author' | 'subject' | 'keywords';
const DESC_KEYS: DescKey[] = ['title', 'author', 'subject', 'keywords'];

// ── small presentational helpers ────────────────────────────────────────────

function Row({ label, children, testid }: { label: string; children: ReactNode; testid?: string }) {
  return (
    <div className="navigation-props-row">
      <dt>{label}</dt>
      <dd data-testid={testid}>{children}</dd>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="navigation-props-section">
      <h3 className="navigation-props-section-title">{title}</h3>
      {children}
    </section>
  );
}

function Check({ label, checked, onChange, disabled, testid }: { label: string; checked: boolean; onChange(b: boolean): void; disabled?: boolean; testid: string }) {
  return (
    <div className="navigation-props-check" data-testid={testid}>
      <Checkbox label={label} checked={checked} onChange={onChange} disabled={disabled} />
    </div>
  );
}

const inches = (pt: number) => (pt / 72).toFixed(2);
const bytesLabel = (n: number) => `${formatBytes(n)} (${n.toLocaleString()} Bytes)`;
const dateLabel = (iso: string | undefined) => {
  if (!iso) return '—';
  const t = Date.parse(iso);
  return Number.isFinite(t) ? formatDate(t) : iso;
};

// ── Description ─────────────────────────────────────────────────────────────

function DescriptionTab({
  doc, draft, setDraft, editable, tagged,
}: {
  doc: DocState;
  draft: Record<DescKey, string>;
  setDraft(k: DescKey, v: string): void;
  editable: boolean;
  tagged: boolean | null;
}) {
  const m = doc.meta;
  const page = doc.pages[doc.view.currentPage] ?? doc.pages[0];
  const rotated = page ? (page.rotation + doc.view.rotation) % 180 !== 0 : false;
  const size = m.fileSize ?? doc.bytes.length;
  const ver = m.pdfVersion?.trim();
  return (
    <div className="navigation-props-pane" data-testid="navigation-props-description">
      <Section title="Description">
        <dl className="navigation-props-grid">
          <Row label="File" testid="navigation-props-filename">{doc.name}</Row>
        </dl>
        <div className="navigation-props-fields">
          <TextField label="Title" value={draft.title} onChange={(v) => setDraft('title', v)} disabled={!editable} maxLength={1000} data-testid="navigation-props-title" />
          <TextField label="Author" value={draft.author} onChange={(v) => setDraft('author', v)} disabled={!editable} maxLength={1000} data-testid="navigation-props-author" />
          <TextField label="Subject" value={draft.subject} onChange={(v) => setDraft('subject', v)} disabled={!editable} maxLength={1000} data-testid="navigation-props-subject" />
          <TextField
            label="Keywords"
            value={draft.keywords}
            onChange={(v) => setDraft('keywords', v)}
            disabled={!editable}
            maxLength={2000}
            help="Separate keywords with commas or semicolons."
            data-testid="navigation-props-keywords"
          />
        </div>
        <dl className="navigation-props-grid">
          <Row label="Created" testid="navigation-props-created">{dateLabel(m.creationDate)}</Row>
          <Row label="Modified" testid="navigation-props-modified">{dateLabel(m.modificationDate)}</Row>
          <Row label="Application" testid="navigation-props-creator">{m.creator?.trim() || '—'}</Row>
        </dl>
      </Section>
      <Section title="Advanced">
        <dl className="navigation-props-grid">
          <Row label="PDF Producer" testid="navigation-props-producer">{m.producer?.trim() || '—'}</Row>
          <Row label="PDF Version" testid="navigation-props-version">
            {ver || '—'}
          </Row>
          <Row label="Location" testid="navigation-props-location">{doc.fileId ? 'Saved to your files' : 'On this device'}</Row>
          <Row label="File Size" testid="navigation-props-size">{bytesLabel(size)}</Row>
          <Row label="Page Size" testid="navigation-props-pagesize">
            {page ? `${inches(rotated ? page.height : page.width)} × ${inches(rotated ? page.width : page.height)} in` : '—'}
          </Row>
          <Row label="Number of Pages" testid="navigation-props-pages">{doc.pages.length}</Row>
          <Row label="Tagged PDF" testid="navigation-props-tagged">{tagged == null ? '…' : tagged ? 'Yes' : 'No'}</Row>
          <Row label="Fast Web View" testid="navigation-props-fastweb">{m.isLinearized ? 'Yes' : 'No'}</Row>
        </dl>
      </Section>
    </div>
  );
}

// ── Security ────────────────────────────────────────────────────────────────

function allowed(v: boolean | undefined) {
  return v === false ? 'Not Allowed' : 'Allowed';
}

function SecurityTab({ doc, close }: { doc: DocState; close(): void }) {
  const sec = doc.security;
  const encrypted = engine.needsEncryption(sec);
  const p = encrypted ? (sec?.permissions ?? {}) : {};
  const printing = !encrypted || p.printing === undefined || p.printing === 'highResolution'
    ? 'High Resolution'
    : p.printing === 'lowResolution'
      ? 'Low Resolution (150 dpi)'
      : 'Not Allowed';
  const protectTask = useMemo(() => {
    const tasks = Object.values(reg.get().tasks);
    return tasks.find((t) => t.id === 'protect') ?? tasks.find((t) => /protect|security|encrypt/i.test(t.id) && !/redact/i.test(t.id));
  }, []);
  const rows: [string, string][] = [
    ['Printing', printing],
    ['Changing the Document', allowed(p.modifying)],
    ['Document Assembly', allowed(p.documentAssembly)],
    ['Content Copying', allowed(p.copying)],
    ['Content Copying for Accessibility', allowed(p.contentAccessibility)],
    ['Page Extraction', allowed(p.copying === false || p.documentAssembly === false ? false : undefined)],
    ['Commenting', allowed(p.annotating)],
    ['Filling of form fields', allowed(p.fillingForms === false && p.annotating === false ? false : undefined)],
    ['Signing', allowed(p.fillingForms === false && p.annotating === false ? false : undefined)],
    ['Creation of Template Pages', allowed(p.modifying)],
  ];
  return (
    <div className="navigation-props-pane" data-testid="navigation-props-security">
      <Section title="Document Security">
        <div className="navigation-props-security-head">
          {encrypted ? <Lock size={18} aria-hidden="true" /> : <LockOpen size={18} aria-hidden="true" />}
          <p>
            The document’s Security Method restricts what can be done to the document.
            {encrypted ? ' Restrictions apply when the file is saved or downloaded.' : ''}
          </p>
        </div>
        <dl className="navigation-props-grid">
          <Row label="Security Method" testid="navigation-props-security-method">{encrypted ? 'Password Security' : 'No Security'}</Row>
          <Row label="Document Open Password" testid="navigation-props-open-password">{sec?.userPassword ? 'Yes' : 'No'}</Row>
          <Row label="Permissions Password" testid="navigation-props-perm-password">{encrypted && (sec?.ownerPassword || engine.needsEncryption({ permissions: sec?.permissions })) ? 'Yes' : 'No'}</Row>
          <Row label="Encryption Level">{encrypted ? 'High (256-bit AES)' : 'None'}</Row>
        </dl>
        {protectTask ? (
          <Button
            size="sm"
            onClick={() => {
              close();
              actions.openTask(protectTask.id);
            }}
            data-testid="navigation-props-change-security"
          >
            Change Settings…
          </Button>
        ) : (
          <p className="navigation-props-note">Use the Protect tool to change security settings.</p>
        )}
      </Section>
      <Section title="Document Restrictions Summary">
        <dl className="navigation-props-grid" data-testid="navigation-props-restrictions">
          {rows.map(([k, v]) => (
            <Row key={k} label={k}>
              <span className={v === 'Not Allowed' ? 'navigation-props-denied' : undefined}>{v}</span>
            </Row>
          ))}
        </dl>
      </Section>
    </div>
  );
}

// ── Fonts ───────────────────────────────────────────────────────────────────

function FontsTab({ docId }: { docId: DocId }) {
  const [state, setState] = useState<{ fonts: FontInfo[] | null; error: string | null; progress: number }>({ fonts: null, error: null, progress: 0 });
  useEffect(() => {
    let live = true;
    listFonts(docId, (p) => live && setState((s) => ({ ...s, progress: p }))).then(
      (fonts) => live && setState({ fonts, error: null, progress: 1 }),
      (e) => live && setState({ fonts: null, error: errMsg(e), progress: 1 }),
    );
    return () => {
      live = false;
    };
  }, [docId]);
  const { fonts, error, progress } = state;
  return (
    <div className="navigation-props-pane" data-testid="navigation-props-fonts">
      <Section title="Fonts Used in this Document">
        {error ? (
          <div className="navigation-inline-error">Couldn’t read the fonts: {error}</div>
        ) : !fonts ? (
          <div className="navigation-props-loading">
            <Spinner size={16} label="Reading fonts" />
            <ProgressBar value={progress} label="Reading fonts…" size="sm" />
          </div>
        ) : fonts.length === 0 ? (
          <EmptyState compact icon={Type} title="No fonts" description="This document doesn’t use any fonts (it may contain only images)." />
        ) : (
          <ul className="navigation-props-fonts" data-testid="navigation-props-font-list" aria-label="Fonts">
            {fonts.map((f, i) => (
              <li key={`${f.name}-${i}`} className="navigation-props-font" data-testid="navigation-props-font" data-font={f.name} tabIndex={0}>
                <div className="navigation-props-font-name">
                  <Type size={14} aria-hidden="true" />
                  <span>
                    {f.name}
                    {f.embedded === 'subset' ? ' (Embedded Subset)' : f.embedded === 'embedded' ? ' (Embedded)' : ''}
                  </span>
                </div>
                <div className="navigation-props-font-meta">
                  <span>Type: {f.type}</span>
                  <span>Encoding: {f.encoding}</span>
                  {f.embedded === 'no' && <span>Actual Font: not embedded (substituted)</span>}
                  {f.pages.length > 0 && (
                    <span>
                      {f.pages.length === 1 ? 'Page' : 'Pages'}: {f.pages.length > 8 ? `${f.pages.slice(0, 8).join(', ')}, … (${f.pages.length})` : f.pages.join(', ')}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}

// ── Initial View ────────────────────────────────────────────────────────────

const NAV_OPTIONS: { value: PageModeName; label: string }[] = [
  { value: 'UseNone', label: 'Page Only' },
  { value: 'UseOutlines', label: 'Bookmarks Panel and Page' },
  { value: 'UseThumbs', label: 'Pages Panel and Page' },
  { value: 'UseAttachments', label: 'Attachments Panel and Page' },
  { value: 'UseOC', label: 'Layers Panel and Page' },
];
const LAYOUT_OPTIONS: { value: LayoutName; label: string }[] = [
  { value: 'default', label: 'Default' },
  { value: 'SinglePage', label: 'Single Page' },
  { value: 'OneColumn', label: 'Single Page Continuous' },
  { value: 'TwoPageLeft', label: 'Two-Up (Facing)' },
  { value: 'TwoColumnLeft', label: 'Two-Up Continuous (Facing)' },
  { value: 'TwoPageRight', label: 'Two-Up (Cover Page)' },
  { value: 'TwoColumnRight', label: 'Two-Up Continuous (Cover Page)' },
];
const ZOOMS = [25, 50, 75, 100, 125, 150, 200, 300, 400, 800];
const MAG_OPTIONS: { value: string; label: string }[] = [
  { value: 'default', label: 'Default' },
  { value: 'actual', label: 'Actual Size' },
  { value: 'fit', label: 'Fit Page' },
  { value: 'fitWidth', label: 'Fit Width' },
  { value: 'fitHeight', label: 'Fit Height' },
  { value: 'fitVisible', label: 'Fit Visible' },
  ...ZOOMS.map((z) => ({ value: String(z), label: `${z}%` })),
];
const magKey = (m: Magnification) => (typeof m === 'number' ? String(m) : m);
const magOf = (k: string): Magnification => (/^\d+$/.test(k) ? Number(k) : (k as Magnification));

function InitialViewTab({ view, set, pages, editable }: { view: InitialView | null; set(p: Partial<InitialView>): void; pages: number; editable: boolean }) {
  if (!view) {
    return (
      <div className="navigation-props-pane navigation-props-loading" data-testid="navigation-props-initial">
        <Spinner size={16} label="Loading" />
      </div>
    );
  }
  const mags = MAG_OPTIONS.some((o) => o.value === magKey(view.magnification))
    ? MAG_OPTIONS
    : [...MAG_OPTIONS, { value: magKey(view.magnification), label: `${view.magnification}%` }];
  const dis = !editable;
  return (
    <div className="navigation-props-pane" data-testid="navigation-props-initial">
      <Section title="Layout and Magnification">
        <div className="navigation-props-fields is-two">
          <Select label="Navigation tab" value={view.pageMode} options={NAV_OPTIONS} onChange={(v) => set({ pageMode: v })} disabled={dis} data-testid="navigation-props-pagemode" />
          <Select label="Page layout" value={view.layout} options={LAYOUT_OPTIONS} onChange={(v) => set({ layout: v })} disabled={dis} data-testid="navigation-props-layout" />
          <Select
            label="Magnification"
            value={magKey(view.magnification)}
            options={mags}
            onChange={(v) => set({ magnification: magOf(v) })}
            disabled={dis}
            data-testid="navigation-props-magnification"
          />
          <div className="navigation-props-openpage" data-testid="navigation-props-openpage">
            <NumberField label="Open to page" value={view.openPage} min={1} max={Math.max(1, pages)} onChange={(n) => set({ openPage: Math.round(n) })} disabled={dis} width={90} />
            <span className="navigation-props-of">of {pages}</span>
          </div>
        </div>
      </Section>
      <Section title="Window Options">
        <Check label="Resize window to initial page" checked={view.fitWindow} onChange={(b) => set({ fitWindow: b })} disabled={dis} testid="navigation-props-fitwindow" />
        <Check label="Center window on screen" checked={view.centerWindow} onChange={(b) => set({ centerWindow: b })} disabled={dis} testid="navigation-props-centerwindow" />
        <Check label="Open in Full Screen mode" checked={view.fullScreen} onChange={(b) => set({ fullScreen: b })} disabled={dis} testid="navigation-props-fullscreen" />
        <div className="navigation-props-fields">
          <Select
            label="Show"
            value={view.displayDocTitle ? 'title' : 'file'}
            options={[
              { value: 'file', label: 'File Name' },
              { value: 'title', label: 'Document Title' },
            ]}
            onChange={(v) => set({ displayDocTitle: v === 'title' })}
            disabled={dis}
            width={220}
            data-testid="navigation-props-show"
          />
        </div>
      </Section>
      <Section title="User Interface Options">
        <Check label="Hide menu bar" checked={view.hideMenubar} onChange={(b) => set({ hideMenubar: b })} disabled={dis} testid="navigation-props-hidemenubar" />
        <Check label="Hide toolbars" checked={view.hideToolbar} onChange={(b) => set({ hideToolbar: b })} disabled={dis} testid="navigation-props-hidetoolbar" />
        <Check label="Hide window controls" checked={view.hideWindowUI} onChange={(b) => set({ hideWindowUI: b })} disabled={dis} testid="navigation-props-hidewindowui" />
      </Section>
      <p className="navigation-props-note">These settings are saved in the PDF and take effect the next time the document is opened.</p>
    </div>
  );
}

// ── Custom ──────────────────────────────────────────────────────────────────

function CustomTab({ custom, setCustom, editable }: { custom: Record<string, string> | null; setCustom(c: Record<string, string>): void; editable: boolean }) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  if (!custom) {
    return (
      <div className="navigation-props-pane navigation-props-loading" data-testid="navigation-props-custom">
        <Spinner size={16} label="Loading" />
      </div>
    );
  }
  const keys = Object.keys(custom).sort((a, b) => collator.compare(a, b));
  const trimmed = name.trim();
  const addError = customNameError(trimmed, custom, null);
  const changeError = selected != null ? customNameError(trimmed, custom, selected) : 'Select a property.';
  const error = touched && trimmed ? (selected != null ? changeError : addError) : null;

  const pick = (k: string | null, from: Record<string, string> = custom) => {
    setSelected(k);
    setName(k ?? '');
    setValue(k != null ? (from[k] ?? '') : '');
    setTouched(false);
  };
  // Synchronously (the field is always mounted): a deferred focus could steal the caret from a field
  // the user has already moved to.
  const focusName = () => document.querySelector<HTMLInputElement>('[data-testid="navigation-props-custom-name"]')?.focus();
  const add = () => {
    setTouched(true);
    if (!trimmed || addError) return;
    setCustom({ ...custom, [trimmed]: value });
    // Ready for the next property, like the usual Custom tab.
    pick(null);
    focusName();
  };
  const change = () => {
    setTouched(true);
    if (selected == null || !trimmed || changeError) return;
    const next: Record<string, string> = {};
    for (const k of Object.keys(custom)) {
      if (k === selected) next[trimmed] = value;
      else next[k] = custom[k];
    }
    setCustom(next);
    pick(trimmed, next);
  };
  // Enter: update the selected property when its name is unchanged, otherwise add a new one.
  const submit = () => (selected != null && trimmed === selected ? change() : add());
  const remove = () => {
    if (selected == null) return;
    const next = { ...custom };
    delete next[selected];
    setCustom(next);
    pick(null);
    focusName();
  };
  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = selected ? keys.indexOf(selected) : -1;
    let j = i;
    if (e.key === 'ArrowDown') j = Math.min(keys.length - 1, i + 1);
    else if (e.key === 'ArrowUp') j = Math.max(0, i - 1);
    else if ((e.key === 'Delete' || e.key === 'Backspace') && editable) {
      e.preventDefault();
      remove();
      return;
    } else return;
    e.preventDefault();
    if (keys[j]) pick(keys[j]);
  };

  return (
    <div className="navigation-props-pane" data-testid="navigation-props-custom">
      <Section title="Custom Properties">
        <div className="navigation-props-fields is-two">
          <TextField
            label="Name"
            value={name}
            onChange={(v) => {
              setName(v);
              setTouched(true);
            }}
            error={error}
            disabled={!editable}
            maxLength={127}
            data-testid="navigation-props-custom-name"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                submit();
              }
            }}
          />
          <TextField
            label="Value"
            value={value}
            onChange={setValue}
            disabled={!editable}
            maxLength={4000}
            data-testid="navigation-props-custom-value"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                submit();
              }
            }}
          />
        </div>
        <div className="navigation-props-custom-actions">
          <Button size="sm" icon={Plus} onClick={add} disabled={!editable || !trimmed || !!addError} data-testid="navigation-props-custom-add">
            Add
          </Button>
          <Button size="sm" onClick={change} disabled={!editable || selected == null || !trimmed || !!changeError} data-testid="navigation-props-custom-change">
            Change
          </Button>
          <Button size="sm" icon={Trash2} onClick={remove} disabled={!editable || selected == null} data-testid="navigation-props-custom-delete">
            Delete
          </Button>
        </div>
        {keys.length === 0 ? (
          <p className="navigation-props-note" data-testid="navigation-props-custom-empty">No custom properties. Enter a name and value, then click Add.</p>
        ) : (
          <div className="navigation-props-table" role="listbox" aria-label="Custom properties" data-testid="navigation-props-custom-list" onKeyDown={onListKey}>
            <div className="navigation-props-table-head" aria-hidden="true">
              <span>Name</span>
              <span>Value</span>
            </div>
            {keys.map((k, i) => (
              <div
                key={k}
                role="option"
                aria-selected={k === selected}
                tabIndex={(selected ? k === selected : i === 0) ? 0 : -1}
                className={`navigation-props-table-row${k === selected ? ' is-selected' : ''}`}
                data-testid="navigation-props-custom-row"
                data-name={k}
                onClick={() => pick(k === selected ? null : k)}
              >
                <span title={k}>{k}</span>
                <span title={custom[k]}>{custom[k]}</span>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

// ── dialog ──────────────────────────────────────────────────────────────────

function DocPropertiesBody({ docId, close, initialTab }: { docId: DocId; close(): void; initialTab: PropsTab }) {
  const doc = useApp((s) => s.docs[docId]);
  const editable = canEdit(docId);
  const [tab, setTab] = useState<PropsTab>(initialTab);
  const meta = (doc?.meta ?? {}) as NavMeta;
  const [draft, setDraftState] = useState<Record<DescKey, string>>(() => ({
    title: meta.title ?? '',
    author: meta.author ?? '',
    subject: meta.subject ?? '',
    keywords: meta.keywords ?? '',
  }));
  const [view, setViewState] = useState<InitialView | null>(null);
  const [origView, setOrigView] = useState<InitialView | null>(null);
  const [custom, setCustom] = useState<Record<string, string> | null>(null);
  const [origCustom, setOrigCustom] = useState<Record<string, string> | null>(null);
  const [tagged, setTagged] = useState<boolean | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const tabsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    Promise.all([currentInitialView(docId), currentCustom(docId)]).then(
      ([v, c]) => {
        if (!live) return;
        setViewState({ ...v });
        setOrigView(v);
        setCustom({ ...c });
        setOrigCustom(c);
      },
      (e) => live && setLoadError(errMsg(e)),
    );
    engine
      .awaitPdf(docId)
      .then((pdf) => pdf.getMarkInfo())
      .then(
        (mi) => live && setTagged(!!(mi as { Marked?: boolean } | null)?.Marked),
        () => live && setTagged(false),
      );
    return () => {
      live = false;
    };
  }, [docId]);

  if (!doc) return null;

  const setDraft = (k: DescKey, v: string) => setDraftState((d) => ({ ...d, [k]: v }));
  const setView = (p: Partial<InitialView>) => setViewState((v) => (v ? { ...v, ...p } : v));

  const apply = () => {
    if (!editable) {
      close();
      return;
    }
    const cur = getDoc(docId)?.meta as NavMeta | undefined;
    if (!cur) {
      close();
      return;
    }
    const patch: Partial<NavMeta> = {};
    for (const k of DESC_KEYS) {
      const v = draft[k].trim();
      if (v !== (cur[k] ?? '').trim()) patch[k] = v || undefined;
    }
    if (view && origView && !sameView(view, origView)) patch.navInitialView = view;
    if (custom && origCustom && !sameCustom(custom, origCustom)) patch.navCustom = custom;
    if (Object.keys(patch).length) actions.setMeta(docId, patch as Partial<DocMeta>, 'Edit document properties');
    close();
  };

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const i = TABS.findIndex((t) => t.id === tab);
    const j = e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : (i + (e.key === 'ArrowLeft' ? -1 : 1) + TABS.length) % TABS.length;
    setTab(TABS[j].id);
    requestAnimationFrame(() => tabsRef.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus());
  };

  return (
    <Modal
      title="Document Properties"
      icon={FileText}
      width={640}
      onClose={close}
      className="navigation-props-dialog"
      bodyClassName="navigation-props-body"
      footerStart={
        !editable ? (
          <span className="navigation-props-note">
            <Info size={14} aria-hidden="true" /> This document is open read-only.
          </span>
        ) : undefined
      }
      footer={
        <>
          {editable && (
            <Button onClick={close} data-testid="navigation-props-cancel">
              Cancel
            </Button>
          )}
          <Button variant="primary" onClick={apply} data-testid="navigation-props-ok">
            OK
          </Button>
        </>
      }
    >
      <div data-testid="navigation-props-dialog" className="navigation-props">
        <div ref={tabsRef} className="tabs tabs-md navigation-props-tabs" role="tablist" aria-label="Document properties" onKeyDown={onTabKey}>
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`navigation-props-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls="navigation-props-panel"
              tabIndex={tab === t.id ? 0 : -1}
              className={`tab${tab === t.id ? ' is-selected' : ''}`}
              onClick={() => setTab(t.id)}
              data-testid={`navigation-props-tab-${t.id}`}
            >
              <span>{t.label}</span>
            </button>
          ))}
        </div>
        <form
          id="navigation-props-panel"
          role="tabpanel"
          aria-labelledby={`navigation-props-tab-${tab}`}
          className="navigation-props-panel"
          onSubmit={(e) => {
            e.preventDefault();
            apply();
          }}
        >
          {loadError && <div className="navigation-inline-error">{loadError}</div>}
          {tab === 'description' && <DescriptionTab doc={doc} draft={draft} setDraft={setDraft} editable={editable} tagged={tagged} />}
          {tab === 'security' && <SecurityTab doc={doc} close={close} />}
          {tab === 'fonts' && <FontsTab docId={docId} />}
          {tab === 'initial' && <InitialViewTab view={view} set={setView} pages={doc.pages.length} editable={editable} />}
          {tab === 'custom' && <CustomTab custom={custom} setCustom={setCustom} editable={editable} />}
          {/* Enter in a text field submits (applies) like the usual OK button. */}
          <button type="submit" hidden tabIndex={-1} aria-hidden="true" />
        </form>
      </div>
    </Modal>
  );
}

export function openDocProperties(docId?: DocId | null, tab: PropsTab = 'description') {
  const id = docId ?? useApp.getState().activeDocId;
  if (!id || !getDoc(id)) return Promise.resolve(undefined);
  // Warm the caches so the dialog fills in quickly.
  void readInitialView(id).catch(() => undefined);
  void readCustom(id).catch(() => undefined);
  return actions.openModal<void>((close) => <DocPropertiesBody docId={id} close={() => close()} initialTab={tab} />);
}
