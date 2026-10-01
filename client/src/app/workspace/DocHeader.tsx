/**
 * Document header above the viewer: editable file name + save status on the left,
 * undo/redo, print, download, more, save and Share on the right.
 */
import { useEffect, useRef, useState } from 'react';
import {
  BookOpenText, CloudCheck, Download, Ellipsis, Eye, HardDrive, Pencil, Printer, Redo2, Save, Send, Undo2,
} from 'lucide-react';
import { actions, useDoc } from '@/core/store';
import type { DocId } from '@/core/types';
import { Button, Divider, Dropdown, IconButton, Spinner, useEscapeLayer, type MenuEntry } from '@/core/ui';
import { menuEntries } from '../menus';
import { downloadDocument, printDocument, renameDocument, saveDocument, saveDocumentAs, shareDocument } from '../docActions';
import { executeCommand } from '../commands';
import { reg } from '@/core/registry';
import { useShell } from '../uiStore';

function DocName({ docId }: { docId: DocId }) {
  const name = useDoc(docId, (d) => d?.name ?? '');
  const readOnly = useDoc(docId, (d) => !!d?.ext.readOnly);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name);
  const input = useRef<HTMLInputElement>(null);
  const cancelled = useRef(false);

  useEffect(() => {
    if (!editing) return;
    const el = input.current;
    if (!el) return;
    el.focus();
    const dot = name.toLowerCase().endsWith('.pdf') ? name.length - 4 : name.length;
    el.setSelectionRange(0, dot);
  }, [editing, name]);

  useEscapeLayer(editing, () => {
    cancelled.current = true;
    setEditing(false);
  });

  const commit = () => {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    setEditing(false);
    const v = value.trim();
    if (v && v !== name) void renameDocument(docId, v);
  };

  if (editing) {
    return (
      <input
        ref={input}
        className="doc-name-input"
        value={value}
        aria-label="File name"
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            input.current?.blur();
          }
        }}
        spellCheck={false}
        data-testid="doc-name-input"
      />
    );
  }
  return (
    <button
      type="button"
      className="doc-name"
      title={readOnly ? name : `${name} — click to rename`}
      disabled={readOnly}
      onClick={() => {
        cancelled.current = false;
        setValue(name);
        setEditing(true);
      }}
      data-testid="doc-name"
    >
      <span className="doc-name-text">{name}</span>
      {!readOnly && <Pencil size={13} className="doc-name-pencil" aria-hidden />}
    </button>
  );
}

function SaveStatus({ docId }: { docId: DocId }) {
  const saving = useShell((s) => !!s.saving[docId]);
  const dirty = useDoc(docId, (d) => !!d?.dirty);
  const inLibrary = useDoc(docId, (d) => !!d?.fileId);
  const readOnly = useDoc(docId, (d) => !!d?.ext.readOnly);
  let content;
  if (saving)
    content = (
      <>
        <Spinner size={12} label="Saving" /> Saving…
      </>
    );
  else if (dirty) content = <>Unsaved changes</>;
  else if (inLibrary)
    content = (
      <>
        <CloudCheck size={14} aria-hidden /> Saved to your files
      </>
    );
  else
    content = (
      <>
        <HardDrive size={14} aria-hidden /> On this device
      </>
    );
  return (
    <span className="doc-status" data-testid="doc-status" data-state={saving ? 'saving' : dirty ? 'dirty' : inLibrary ? 'saved' : 'local'}>
      {readOnly && (
        <span className="doc-badge" data-testid="doc-readonly">
          <Eye size={12} aria-hidden /> Shared, view only
        </span>
      )}
      <span className={`doc-status-text${dirty && !saving ? ' is-dirty' : ''}`}>{content}</span>
    </span>
  );
}

function moreMenu(docId: DocId, readOnly: boolean): MenuEntry[] {
  const cmd = (id: string) => reg.command(id);
  const view = menuEntries('view');
  const doc = menuEntries('document');
  const out: MenuEntry[] = [
    { id: 'more.saveAs', label: 'Save as…', icon: Save, run: () => void saveDocumentAs(docId) },
    ...(cmd('core.rename') && !readOnly ? [{ id: 'more.rename', label: 'Rename…', icon: Pencil, run: () => void executeCommand('core.rename') }] : []),
    { id: 'more.readMode', label: 'Read mode', icon: BookOpenText, shortcut: 'mod+alt+r', run: () => void executeCommand('core.readMode') },
  ];
  if (view.length) out.push('divider', { id: 'more.view', label: 'View', submenu: view });
  if (doc.length) out.push({ id: 'more.document', label: 'Document', submenu: doc });
  return out;
}

export function DocHeader({ docId }: { docId: DocId }) {
  const readOnly = useDoc(docId, (d) => !!d?.ext.readOnly);
  const saving = useShell((s) => !!s.saving[docId]);
  const canSave = useDoc(docId, (d) => !!d && (d.dirty || !d.fileId));
  const ready = useDoc(docId, (d) => !!d && !d.loading && !d.loadError);
  const undoLabel = useDoc(docId, (d) => d?.history.past[d.history.past.length - 1]?.label ?? null);
  const redoLabel = useDoc(docId, (d) => d?.history.future[0]?.label ?? null);

  return (
    <header className="doc-header" data-testid="doc-header">
      <div className="doc-header-start">
        <DocName docId={docId} />
        <SaveStatus docId={docId} />
      </div>
      <div className="doc-header-end">
        <IconButton icon={Undo2} label={undoLabel ? `Undo ${undoLabel.toLowerCase()}` : 'Undo'} shortcut="mod+z" disabled={!undoLabel} onClick={() => actions.undo(docId)} data-testid="undo" />
        <IconButton icon={Redo2} label={redoLabel ? `Redo ${redoLabel.toLowerCase()}` : 'Redo'} shortcut="mod+shift+z" disabled={!redoLabel} onClick={() => actions.redo(docId)} data-testid="redo" />
        <Divider vertical className="doc-header-divider" />
        <IconButton icon={Printer} label="Print" shortcut="mod+p" disabled={!ready} onClick={() => void printDocument(docId)} data-testid="print" />
        <IconButton icon={Download} label="Download" disabled={!ready} onClick={() => void downloadDocument(docId)} data-testid="download" />
        <Dropdown
          align="end"
          label="More options"
          items={() => moreMenu(docId, readOnly)}
          trigger={<IconButton icon={Ellipsis} label="More options" data-testid="doc-more" />}
        />
        <Divider vertical className="doc-header-divider" />
        {readOnly ? (
          <Button size="sm" icon={Save} disabled={!ready} loading={saving} onClick={() => void saveDocument(docId)} data-testid="save">
            Save a copy
          </Button>
        ) : (
          <Button size="sm" icon={Save} disabled={!ready || !canSave} loading={saving} onClick={() => void saveDocument(docId)} tooltip="Save to your files" data-testid="save">
            Save
          </Button>
        )}
        {!readOnly && (
          <Button size="sm" variant="primary" icon={Send} disabled={!ready || saving} onClick={() => void shareDocument(docId)} tooltip="Send a copy by email, Teams or a shared drive" data-testid="share">
            Send a copy
          </Button>
        )}
      </div>
    </header>
  );
}
