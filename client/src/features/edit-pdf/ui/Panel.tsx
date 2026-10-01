/**
 * Left panel of the "Edit a PDF" task: add content (text, image, link), format the active text,
 * image and link actions for the selection, and the page design tools (not available yet).
 */
import { FilePen, FileText, Frame, ImagePlus, Info, Layers, Link2, PaintBucket, SquareDashedMousePointer, Stamp, Type, type LucideIcon } from 'lucide-react';
import { actions, useApp, useDoc } from '@/core/store';
import * as engine from '@/core/engine';
import { Button, EmptyState, IconButton } from '@/core/ui';
import { TOOL_CONTENT, TOOL_IMAGE, TOOL_LINK, TOOL_TEXT } from '../model';
import { arrangeActions, deleteAction, imageActions, linkActions, textActions, type TargetAction } from '../menus';
import { useEditPdf, type Target } from '../state';
import { kindOfTarget } from '../targetActions';
import { FormatSection, useFormatState } from './FormatControls';

interface AddButton {
  id: string;
  tool: string;
  label: string;
  icon: LucideIcon;
  testid: string;
}

const ADD: AddButton[] = [
  { id: 'edit', tool: TOOL_CONTENT, label: 'Edit', icon: SquareDashedMousePointer, testid: 'edit-pdf-mode-edit' },
  { id: 'text', tool: TOOL_TEXT, label: 'Text', icon: Type, testid: 'edit-pdf-add-text' },
  { id: 'image', tool: TOOL_IMAGE, label: 'Image', icon: ImagePlus, testid: 'edit-pdf-add-image' },
  { id: 'link', tool: TOOL_LINK, label: 'Link', icon: Link2, testid: 'edit-pdf-add-link' },
];

const DESIGN: { id: string; label: string; icon: LucideIcon }[] = [
  { id: 'header-footer', label: 'Header & footer', icon: FileText },
  { id: 'watermark', label: 'Watermark', icon: Stamp },
  { id: 'background', label: 'Background', icon: PaintBucket },
  { id: 'crop-pages', label: 'Crop pages', icon: Frame },
];

function AddContent({ toolId, disabled }: { toolId: string; disabled: boolean }) {
  return (
    <section className="panel-section edit-pdf-section">
      <div className="panel-section-title">Add content</div>
      <div className="edit-pdf-tools" role="group" aria-label="Add content">
        {ADD.map((b) => {
          const active = toolId === b.tool;
          const Icon = b.icon;
          return (
            <button
              key={b.id}
              type="button"
              className={`edit-pdf-tool${active ? ' is-active' : ''}`}
              aria-pressed={active}
              data-testid={b.testid}
              title={b.id === 'edit' ? 'Edit text & images (E)' : `Add ${b.label.toLowerCase()}`}
              disabled={disabled && b.id !== 'edit'}
              onClick={() => actions.setTool(b.tool)}
            >
              <Icon size={18} strokeWidth={1.8} />
              <span>{b.label}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function ActionRow({ list, prefix = 'edit-pdf-obj' }: { list: TargetAction[]; prefix?: string }) {
  return (
    <div className="edit-pdf-row" role="group">
      {list.map((a) => (
        <IconButton key={a.id} size="sm" icon={a.icon} label={a.label} onClick={() => void a.run()} data-testid={`${prefix}-${a.id}`} className={a.danger ? 'edit-pdf-danger' : undefined} />
      ))}
    </div>
  );
}

function ObjectsSection({ target }: { target: Target }) {
  const kind = kindOfTarget(target);
  if (kind === 'image') {
    const [flipH, flipV, rotCcw, rotCw, crop, replace] = imageActions(target);
    const del = deleteAction(target);
    return (
      <section className="panel-section edit-pdf-section" data-testid="edit-pdf-objects">
        <div className="panel-section-title">Objects</div>
        <ActionRow list={[flipH, flipV, rotCcw, rotCw]} />
        <div className="edit-pdf-row">
          <Button size="sm" variant="secondary" icon={crop.icon} onClick={() => void crop.run()} data-testid="edit-pdf-obj-crop">
            Crop
          </Button>
          <Button size="sm" variant="secondary" icon={replace.icon} onClick={() => void replace.run()} data-testid="edit-pdf-obj-replace">
            Replace
          </Button>
        </div>
        <div className="edit-pdf-subtitle">Arrange</div>
        <ActionRow list={arrangeActions(target)} />
        <Button size="sm" variant="ghost" icon={del.icon} className="edit-pdf-danger" onClick={() => void del.run()} data-testid="edit-pdf-obj-delete">
          Delete image
        </Button>
      </section>
    );
  }
  if (kind === 'link') {
    const [props, open] = linkActions(target);
    const del = deleteAction(target);
    return (
      <section className="panel-section edit-pdf-section" data-testid="edit-pdf-link-section">
        <div className="panel-section-title">Link</div>
        <div className="edit-pdf-row">
          <Button size="sm" variant="secondary" icon={props.icon} onClick={() => void props.run()} data-testid="edit-pdf-obj-link-properties">
            Properties…
          </Button>
          <Button size="sm" variant="secondary" icon={open.icon} onClick={() => void open.run()} data-testid="edit-pdf-obj-link-open">
            Open
          </Button>
        </div>
        <Button size="sm" variant="ghost" icon={del.icon} className="edit-pdf-danger" onClick={() => void del.run()} data-testid="edit-pdf-obj-delete">
          Delete link
        </Button>
      </section>
    );
  }
  if (kind === 'text') {
    const [edit] = textActions(target);
    const del = deleteAction(target);
    return (
      <section className="panel-section edit-pdf-section" data-testid="edit-pdf-text-section">
        <div className="edit-pdf-row">
          <Button size="sm" variant="secondary" icon={edit.icon} onClick={() => void edit.run()} data-testid="edit-pdf-obj-edit-text">
            Edit text
          </Button>
          <Button size="sm" variant="ghost" icon={del.icon} className="edit-pdf-danger" onClick={() => void del.run()} data-testid="edit-pdf-obj-delete">
            Delete
          </Button>
        </div>
        {target.type === 'object' && (
          <>
            <div className="edit-pdf-subtitle">Arrange</div>
            <ActionRow list={arrangeActions(target)} />
          </>
        )}
      </section>
    );
  }
  return null;
}

function Hint({ toolId, readOnly }: { toolId: string; readOnly: boolean }) {
  const text = readOnly
    ? 'Text blocks, images and links are outlined on the page. Editing is turned off for this document.'
    : toolId === TOOL_LINK
      ? 'Drag a rectangle to create a link. Click a link to select it, double-click to change it.'
      : toolId === TOOL_IMAGE
        ? 'Click the page to place the image at its size, or drag to set the size.'
        : toolId === TOOL_TEXT
          ? 'Click to type, or drag to set the width of the text box.'
          : 'Click text to edit it. Drag the border of a text box or an image to move it; select it to resize, format or delete it.';
  return <p className="edit-pdf-hint">{text}</p>;
}

export function EditPdfPanel() {
  const docId = useApp((s) => s.activeDocId);
  const toolId = useApp((s) => s.activeToolId);
  const loadError = useDoc(docId, (d) => d?.loadError ?? null);
  const target = useEditPdf((s) => (s.target && s.target.docId === docId ? s.target : null));
  const editing = useEditPdf((s) => s.edit?.phase === 'editing');
  // re-render when the selected object changes kind / goes away
  useDoc(docId, (d) => (target?.type === 'object' ? (d?.objects[target.id]?.kind ?? null) : null));
  const format = useFormatState();
  const readOnly = !!docId && engine.isReadOnly(docId);

  if (!docId) {
    return (
      <div className="edit-pdf-panel">
        <EmptyState icon={FilePen} title="No document open" description="Open a PDF to edit its text, images and links." compact />
      </div>
    );
  }
  if (loadError) {
    return (
      <div className="edit-pdf-panel">
        <EmptyState icon={FilePen} title="The document could not be loaded" description={loadError} compact />
      </div>
    );
  }
  const kind = kindOfTarget(target);
  return (
    <div className="edit-pdf-panel" data-testid="edit-pdf-panel" data-edit-pdf-keep="">
      {readOnly && (
        <div className="edit-pdf-notice" role="status" data-testid="edit-pdf-readonly">
          <Info size={16} aria-hidden />
          <span>This document is read-only. You can look at its content, but it can’t be edited.</span>
        </div>
      )}
      <AddContent toolId={toolId} disabled={readOnly} />
      <section className="panel-section edit-pdf-section" data-testid="edit-pdf-format-section">
        <div className="panel-section-title">Format</div>
        {format && (editing || kind === 'text' || format.scope === 'defaults') ? (
          <FormatSection state={format} />
        ) : (
          <Hint toolId={toolId} readOnly={readOnly} />
        )}
      </section>
      {target && !editing && <ObjectsSection target={target} />}
      <section className="panel-section edit-pdf-section" data-testid="edit-pdf-design">
        <div className="panel-section-title">
          <Layers size={14} aria-hidden /> Page design
        </div>
        <div className="edit-pdf-design" role="group" aria-label="Page design">
          {DESIGN.map((d) => {
            const Icon = d.icon;
            return (
              <button key={d.id} type="button" className="edit-pdf-design-item" disabled title={`${d.label} — not available yet`} data-testid={`edit-pdf-design-${d.id}`}>
                <Icon size={16} strokeWidth={1.8} aria-hidden />
                <span>{d.label}</span>
                <span className="edit-pdf-soon">Soon</span>
              </button>
            );
          })}
        </div>
      </section>
    </div>
  );
}
