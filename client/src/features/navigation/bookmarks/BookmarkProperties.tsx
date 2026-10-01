/** Bookmark Properties dialog (Appearance + Actions). */
import { useState } from 'react';
import { Bookmark } from 'lucide-react';
import type { DocId } from '@/core/types';
import { actions, getDoc, pageIndexOf } from '@/core/store';
import { Button, ColorSwatchButton, Modal, NumberField, RadioGroup, Select, TextField } from '@/core/ui';
import { findItem, type BmItem, type NavDest } from './model';
import { destOf } from './dest';
import { outlineOf, patchBookmark } from './actions';

type Style = 'plain' | 'bold' | 'italic' | 'bold-italic';
type ZoomChoice = 'inherit' | 'fit' | 'fitb' | 'fith' | 'fitv' | 'fitr' | 'actual' | 'custom';

const ZOOM_OPTIONS: { value: ZoomChoice; label: string }[] = [
  { value: 'inherit', label: 'Inherit zoom' },
  { value: 'fit', label: 'Fit page' },
  { value: 'fitb', label: 'Fit visible' },
  { value: 'fith', label: 'Fit width' },
  { value: 'fitv', label: 'Fit height' },
  { value: 'actual', label: 'Actual size' },
  { value: 'custom', label: 'Custom zoom…' },
];
/** Only offered for bookmarks that already target a rectangle (there's no UI to draw one). */
const FITR_OPTION: { value: ZoomChoice; label: string } = { value: 'fitr', label: 'Fit rectangle' };

/** A web / mail / ftp address with the parts a link needs (a host, or an address for mailto:). */
export function isLinkUrl(raw: string): boolean {
  const s = raw.trim();
  if (/\s/.test(s)) return false;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  if (u.protocol === 'mailto:') return /^[^@]+@[^@]+$/.test(decodeURIComponent(u.pathname));
  return (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'ftp:') && !!u.hostname && /^[a-z]+:\/\//i.test(s);
}

function zoomChoiceOf(d: NavDest | null): { choice: ZoomChoice; pct: number } {
  if (!d || d.mode === 'XYZ') {
    if (!d?.zoom) return { choice: 'inherit', pct: 100 };
    if (Math.abs(d.zoom - 1) < 1e-3) return { choice: 'actual', pct: 100 };
    return { choice: 'custom', pct: Math.round(d.zoom * 100) };
  }
  if (d.mode === 'Fit') return { choice: 'fit', pct: 100 };
  if (d.mode === 'FitB') return { choice: 'fitb', pct: 100 };
  if (d.mode === 'FitH' || d.mode === 'FitBH') return { choice: 'fith', pct: 100 };
  if (d.mode === 'FitV' || d.mode === 'FitBV') return { choice: 'fitv', pct: 100 };
  if (d.mode === 'FitR') return { choice: 'fitr', pct: 100 };
  return { choice: 'inherit', pct: 100 };
}

function destFor(choice: ZoomChoice, pct: number, prev: NavDest | null): NavDest {
  const left = prev?.mode === 'XYZ' ? (prev.left ?? null) : null;
  switch (choice) {
    case 'fit':
      return { mode: 'Fit' };
    case 'fitb':
      return { mode: 'FitB' };
    case 'fith':
      return { mode: 'FitH' };
    case 'fitv':
      return { mode: 'FitV', left: null };
    case 'fitr':
      return prev?.mode === 'FitR' ? prev : { mode: 'Fit' };
    case 'actual':
      return { mode: 'XYZ', left, zoom: 1 };
    case 'custom':
      return { mode: 'XYZ', left, zoom: Math.max(0.1, Math.min(64, pct / 100)) };
    default:
      return { mode: 'XYZ', left, zoom: null };
  }
}

function PropertiesDialog({ docId, item, close }: { docId: DocId; item: BmItem; close: () => void }) {
  const doc = getDoc(docId);
  const pageCount = doc?.pages.length ?? 1;
  const pageIdx = item.pageId && doc ? pageIndexOf(doc, item.pageId) : -1;
  const [title, setTitle] = useState(item.title);
  const [style, setStyle] = useState<Style>(item.bold && item.italic ? 'bold-italic' : item.bold ? 'bold' : item.italic ? 'italic' : 'plain');
  const [color, setColor] = useState<string | null>(item.color ?? '#000000');
  const [action, setAction] = useState<'page' | 'url' | 'none'>(item.url ? 'url' : item.pageId ? 'page' : 'none');
  const [page, setPage] = useState(Math.max(1, pageIdx + 1));
  const [url, setUrl] = useState(item.url ?? 'https://');
  const initial = zoomChoiceOf(destOf(item));
  const [zoom, setZoom] = useState<ZoomChoice>(initial.choice);
  const [pct, setPct] = useState(initial.pct);

  const urlValid = action !== 'url' || isLinkUrl(url);
  const apply = () => {
    if (!doc) return close();
    const t = title.replace(/[\r\n]+/g, ' ').trim() || item.title || 'Untitled';
    const patch: Partial<BmItem> = {
      title: t,
      bold: style === 'bold' || style === 'bold-italic',
      italic: style === 'italic' || style === 'bold-italic',
      color: color && color.toLowerCase() !== '#000000' ? color : null,
    };
    if (action === 'url') {
      patch.url = url.trim();
      patch.pageId = null;
      patch.top = null;
      patch.navDest = null;
    } else if (action === 'page') {
      const idx = Math.min(Math.max(1, Math.round(page)), pageCount) - 1;
      const target = doc.pages[idx];
      const samePage = target.id === item.pageId;
      patch.url = null;
      patch.pageId = target.id;
      patch.top = samePage ? (item.top ?? null) : null;
      // Keep the stored destination (FitR rectangles, FitH tops…) unless the zoom was changed here.
      const zoomChanged = zoom !== initial.choice || (zoom === 'custom' && pct !== initial.pct);
      if (zoomChanged) patch.navDest = destFor(zoom, pct, destOf(item));
    } else {
      patch.url = null;
      patch.pageId = null;
      patch.top = null;
      patch.navDest = null;
    }
    patchBookmark(docId, item.id, patch, 'Bookmark properties');
    close();
  };

  return (
    <Modal
      title="Bookmark Properties"
      icon={Bookmark}
      onClose={close}
      width={460}
      footer={
        <>
          <Button variant="secondary" onClick={close} data-testid="navigation-bmprops-cancel">
            Cancel
          </Button>
          <Button variant="primary" onClick={apply} disabled={!urlValid} data-testid="navigation-bmprops-ok">
            OK
          </Button>
        </>
      }
    >
      <form
        className="navigation-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (urlValid) apply();
        }}
      >
        <TextField label="Title" value={title} onChange={setTitle} data-testid="navigation-bmprops-title" autoFocus />
        <div className="navigation-form-row">
          <Select<Style>
            label="Style"
            value={style}
            onChange={setStyle}
            data-testid="navigation-bmprops-style"
            options={[
              { value: 'plain', label: 'Plain' },
              { value: 'bold', label: 'Bold' },
              { value: 'italic', label: 'Italic' },
              { value: 'bold-italic', label: 'Bold & Italic' },
            ]}
          />
          <div className="navigation-form-field" data-testid="navigation-bmprops-color">
            <span className="navigation-form-label">Color</span>
            <ColorSwatchButton value={color} onChange={(c) => setColor(c ?? '#000000')} label="Bookmark color" />
          </div>
        </div>
        <RadioGroup<'page' | 'url' | 'none'>
          label="Action"
          value={action}
          onChange={setAction}
          name="navigation-bm-action"
          options={[
            { value: 'page', label: 'Go to a page view' },
            { value: 'url', label: 'Open a web link' },
            { value: 'none', label: 'None' },
          ]}
        />
        {action === 'page' && (
          <div className="navigation-form-row" data-testid="navigation-bmprops-dest">
            <div data-testid="navigation-bmprops-page">
              <NumberField label={`Page (of ${pageCount})`} value={page} onChange={setPage} min={1} max={pageCount} step={1} width={110} aria-label="Destination page" />
            </div>
            <Select<ZoomChoice> label="Zoom" value={zoom} onChange={setZoom} options={initial.choice === 'fitr' ? [...ZOOM_OPTIONS, FITR_OPTION] : ZOOM_OPTIONS} data-testid="navigation-bmprops-zoom" />
            {zoom === 'custom' && (
              <div data-testid="navigation-bmprops-zoom-pct">
                <NumberField label="Percent" value={pct} onChange={setPct} min={10} max={6400} step={1} suffix="%" width={100} aria-label="Zoom percent" />
              </div>
            )}
          </div>
        )}
        {action === 'url' && (
          <TextField
            label="Web link"
            value={url}
            onChange={setUrl}
            error={urlValid || /^(https?:\/\/)?$/i.test(url.trim()) ? undefined : 'Enter a web address starting with http:// or https://'}
            data-testid="navigation-bmprops-url"
          />
        )}
        <button type="submit" hidden aria-hidden tabIndex={-1} />
      </form>
    </Modal>
  );
}

export function openBookmarkProperties(docId: DocId, id: string) {
  const item = findItem(outlineOf(docId), id);
  if (!item) return;
  void actions.openModal((close) => <PropertiesDialog docId={docId} item={item} close={() => close()} />);
}
