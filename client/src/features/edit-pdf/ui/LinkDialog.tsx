/**
 * Create Link / Link Properties dialog (conventional layout): link appearance (visible / invisible
 * rectangle, highlight style, line thickness / style / color) and the link action (go to a page
 * view or open a web page).
 */
import { useState } from 'react';
import { Link2 } from 'lucide-react';
import { actions, getDoc } from '@/core/store';
import type { DocId } from '@/core/types';
import { Button, Checkbox, ColorSwatchButton, Modal, NumberField, Radio, Select, TextField } from '@/core/ui';
import { totalRotation } from '@/core/viewer/viewport';
import { DEFAULT_LINK_APPEARANCE, type LinkAppearance, type LinkHighlight, type LinkLineStyle } from '../content/links';
import type { LinkData } from '../model';
import { visibleTopOf } from '../pagedom';

/** A web address the link can open, or null when it isn't one. */
export function normalizeUrl(raw: string): string | null {
  const s = raw.trim();
  if (!s || /\s/.test(s)) return null;
  const valid = (u: string) => {
    try {
      const url = new URL(u);
      return (url.protocol === 'mailto:' ? /^[^@]+@[^@]+\.[^@]+$/.test(url.pathname) : !!url.hostname && url.hostname.includes('.')) || url.hostname === 'localhost';
    } catch {
      return false;
    }
  };
  if (/^(https?|ftp):\/\//i.test(s)) return valid(s) ? s : null;
  if (/^mailto:/i.test(s)) return valid(s) ? s : null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^:]+:\d/.test(s)) return null; // other schemes (javascript:, file: …)
  if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) return `mailto:${s}`;
  const withScheme = `https://${s}`;
  return valid(withScheme) ? withScheme : null;
}

interface Props {
  docId: DocId;
  pageIndex: number;
  initial: LinkData | null;
  mode: 'create' | 'edit';
  close(result?: LinkData | null): void;
}

const HIGHLIGHTS: { value: LinkHighlight; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'invert', label: 'Invert' },
  { value: 'outline', label: 'Outline' },
  { value: 'push', label: 'Inset' },
];
const THICKNESS = [
  { value: 1, label: 'Thin' },
  { value: 2, label: 'Medium' },
  { value: 3, label: 'Thick' },
];
const LINE_STYLES: { value: LinkLineStyle; label: string }[] = [
  { value: 'solid', label: 'Solid' },
  { value: 'dashed', label: 'Dashed' },
  { value: 'underline', label: 'Underline' },
];

function LinkDialogView({ docId, pageIndex, initial, mode, close }: Props) {
  const doc = getDoc(docId);
  const pageCount = doc?.pages.length ?? 1;
  const init = initial ?? { action: { type: 'page', pageId: doc?.pages[pageIndex]?.id ?? '', left: null, top: null, zoom: null }, appearance: DEFAULT_LINK_APPEARANCE };
  const [ap, setAp] = useState<LinkAppearance>(init.appearance);
  const [kind, setKind] = useState<'page' | 'url'>(init.action.type);
  const initIndex = init.action.type === 'page' ? Math.max(0, doc?.pages.findIndex((p) => p.id === (init.action as { pageId: string }).pageId) ?? 0) : pageIndex;
  const [pageNo, setPageNo] = useState(initIndex + 1);
  const [currentView, setCurrentView] = useState(false);
  const [url, setUrl] = useState(init.action.type === 'url' ? init.action.url : '');
  const [touched, setTouched] = useState(false);
  const urlOk = normalizeUrl(url);
  const urlError = kind === 'url' && touched && !urlOk ? (url.trim() ? 'Enter a valid web address, e.g. https://www.example.com' : 'Enter the web address to open.') : undefined;
  const patch = (p: Partial<LinkAppearance>) => setAp((a) => ({ ...a, ...p }));

  const submit = () => {
    if (!doc) return close(null);
    if (kind === 'url') {
      setTouched(true);
      if (!urlOk) return;
      return close({ appearance: ap, action: { type: 'url', url: urlOk } });
    }
    const idx = Math.max(0, Math.min(pageCount - 1, Math.round(pageNo) - 1));
    const page = doc.pages[idx];
    if (!page) return;
    const prev = init.action.type === 'page' ? init.action : null;
    let left: number | null = null;
    let top: number | null = page.view[3];
    let zoom: number | null = null;
    if (currentView) {
      const rot = totalRotation(page, doc.view.rotation);
      left = 0;
      top = visibleTopOf(idx, page.view[3], doc.view.zoom, rot) ?? page.view[3];
      zoom = Math.round(doc.view.zoom * 100) / 100;
    } else if (prev && prev.pageId === page.id && initial) {
      ({ left, top, zoom } = prev);
    }
    close({ appearance: ap, action: { type: 'page', pageId: page.id, left, top, zoom } });
  };

  return (
    <Modal
      title={mode === 'create' ? 'Create Link' : 'Link Properties'}
      icon={Link2}
      onClose={() => close(null)}
      width={460}
      footer={
        <>
          <Button variant="secondary" onClick={() => close(null)} data-testid="edit-pdf-link-cancel">
            Cancel
          </Button>
          <Button variant="primary" onClick={submit} data-testid="edit-pdf-link-ok">
            {mode === 'create' ? 'Create link' : 'Save'}
          </Button>
        </>
      }
    >
      <form
        className="edit-pdf-link-dialog"
        data-testid="edit-pdf-link-dialog"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <fieldset className="edit-pdf-fieldset">
          <legend>Link appearance</legend>
          <div className="edit-pdf-grid2">
            <Select
              label="Link type"
              value={ap.visible ? 'visible' : 'invisible'}
              options={[
                { value: 'invisible', label: 'Invisible rectangle' },
                { value: 'visible', label: 'Visible rectangle' },
              ]}
              onChange={(v) => patch({ visible: v === 'visible' })}
              data-testid="edit-pdf-link-type"
            />
            <Select
              label="Highlight style"
              value={ap.highlight}
              options={HIGHLIGHTS}
              onChange={(v) => patch({ highlight: v })}
              data-testid="edit-pdf-link-highlight"
            />
            <Select
              label="Line thickness"
              value={ap.width}
              options={THICKNESS.some((t) => t.value === ap.width) ? THICKNESS : [...THICKNESS, { value: ap.width, label: `${ap.width} pt` }]}
              onChange={(v) => patch({ width: v })}
              disabled={!ap.visible}
              data-testid="edit-pdf-link-thickness"
            />
            <Select
              label="Line style"
              value={ap.style}
              options={LINE_STYLES}
              onChange={(v) => patch({ style: v })}
              disabled={!ap.visible}
              data-testid="edit-pdf-link-style"
            />
          </div>
          <div className="edit-pdf-inline-field">
            <span className="field-label">Color</span>
            <span data-testid="edit-pdf-link-color">
              <ColorSwatchButton value={ap.color} onChange={(c) => c && patch({ color: c })} label="Link color" disabled={!ap.visible} />
            </span>
          </div>
        </fieldset>

        <fieldset className="edit-pdf-fieldset">
          <legend>Link action</legend>
          <div className="edit-pdf-radio-row" data-testid="edit-pdf-link-action-page">
            <Radio label="Go to a page view" name="edit-pdf-link-action" value="page" checked={kind === 'page'} onChange={() => setKind('page')} />
          </div>
          {kind === 'page' && (
            <div className="edit-pdf-indent">
              <div className="edit-pdf-inline-field">
                <span className="field-label">Page</span>
                <span data-testid="edit-pdf-link-page">
                  <NumberField value={pageNo} onChange={setPageNo} min={1} max={pageCount} step={1} width={90} aria-label="Target page" />
                </span>
                <span className="edit-pdf-muted">of {pageCount}</span>
              </div>
              <span data-testid="edit-pdf-link-current-view">
                <Checkbox
                  label="Use the current view"
                  description="Keep the zoom and scroll position shown now."
                  checked={currentView}
                  onChange={setCurrentView}
                />
              </span>
            </div>
          )}
          <div className="edit-pdf-radio-row" data-testid="edit-pdf-link-action-url">
            <Radio label="Open a web page" name="edit-pdf-link-action" value="url" checked={kind === 'url'} onChange={() => setKind('url')} />
          </div>
          {kind === 'url' && (
            <div className="edit-pdf-indent">
              <TextField
                label="Web address (URL)"
                value={url}
                onChange={(v) => setUrl(v)}
                onBlur={() => setTouched(true)}
                placeholder="https://www.example.com"
                error={urlError}
                autoFocus
                data-testid="edit-pdf-link-url"
              />
            </div>
          )}
        </fieldset>
        <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
      </form>
    </Modal>
  );
}

/** Opens the link dialog; resolves the new link data, or null when cancelled. */
export async function openLinkDialog(opts: { docId: DocId; pageIndex: number; initial?: LinkData | null; mode: 'create' | 'edit' }): Promise<LinkData | null> {
  const r = await actions.openModal<LinkData | null>((close) => (
    <LinkDialogView docId={opts.docId} pageIndex={opts.pageIndex} initial={opts.initial ?? null} mode={opts.mode} close={close} />
  ));
  return r ?? null;
}
