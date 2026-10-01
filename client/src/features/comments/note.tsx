/**
 * Sticky note (PDF /Text annotation): an icon on the page with a pop-up note.
 */
import { MessageSquare } from 'lucide-react';
import type { DocId, ObjectRenderProps, ObjectTypeDef, PageInfo, Point } from '@/core/types';
import { getDoc, getToolOptions, newObject } from '@/core/store';
import { frameSize, NoteIconSvg } from './icons';
import { ChipDropdown, OpacityChip, Swatch } from './bars';
import { commentContextItems } from './menus';
import { addNewObject } from './ops';
import { exportNote } from './pdfExport';
import { canAnnotate, commentsUi, NOTE_DEFAULTS, NOTE_ICONS, NOTE_SIZE, TOOL, type NoteObject } from './model';

/** Clockwise rotation (deg) that shows an icon drawn upright in a frame rotated by `rotate` on a page shown at `rotation`. */
export function screenAngle(rotation: number, rotate: number | undefined): number {
  return (((rotation - (rotate ?? 0)) % 360) + 360) % 360;
}

/**
 * Sticky notes behave as NoRotate annotations (as in pdf.js, poppler and desktop viewers): the icon stays
 * upright on screen whatever the page / view rotation, inside the note's rectangle.
 */
function NoteRender({ obj, scale }: ObjectRenderProps<NoteObject>) {
  const d = obj.data;
  const { w, h } = frameSize(obj.rect, undefined);
  const color = obj.color ?? NOTE_DEFAULTS.color;
  const replies = obj.replies?.length ?? 0;
  const done = obj.status && obj.status !== 'none';
  return (
    <div className="comments-note" data-testid="comments-note" data-status={obj.status ?? 'none'}>
      <NoteIconSvg
        icon={d.icon}
        color={color}
        className="comments-note-icon"
        preserveAspectRatio="none"
        style={{
          width: w * scale,
          height: h * scale,
          transform: 'translate(-50%, -50%)',
          opacity: obj.opacity ?? 1,
        }}
      />
      {replies > 0 && <span className="comments-badge" aria-label={`${replies} replies`}>{replies}</span>}
      {done && <span className={`comments-status-dot is-${obj.status}`} aria-hidden="true" />}
    </div>
  );
}

function NoteBar({ obj, update }: { obj: NoteObject; update(p: Partial<NoteObject>, o?: { label?: string }): void }) {
  const d = obj.data;
  const color = obj.color ?? NOTE_DEFAULTS.color;
  return (
    <>
      <Swatch testid="comments-bar-color" label="Color" value={color} onChange={(c) => c && update({ color: c }, { label: 'Change color' })} />
      <ChipDropdown
        testid="comments-bar-icon"
        label="Icon"
        items={NOTE_ICONS.map((ic) => ({
          id: `comments-note-icon-${ic.value}`,
          label: ic.label,
          checked: d.icon === ic.value,
          icon: ({ size = 16 }) => <NoteIconSvg icon={ic.value} color={color} width={size} height={size} />,
          run: () => update({ data: { ...d, icon: ic.value } }, { label: 'Change icon' }),
        }))}
      >
        <NoteIconSvg icon={d.icon} color={color} width={18} height={18} />
      </ChipDropdown>
      <OpacityChip testid="comments-bar-opacity" value={obj.opacity ?? 1} onChange={(v) => update({ opacity: v }, { label: 'Change opacity' })} />
    </>
  );
}

export const noteType: ObjectTypeDef<NoteObject> = {
  kind: 'note',
  label: 'Sticky note',
  icon: MessageSquare,
  category: 'comment',
  Render: NoteRender,
  hit: 'box',
  resizable: false,
  editable: true,
  summary: (o) => o.contents ?? '',
  PropertiesBar: NoteBar,
  contextMenu: (o, docId) => commentContextItems(o, docId),
  exportToPdf: (o, ctx) => exportNote(o, ctx),
};

/** New sticky note centered on `at`; opens its pop-up note for typing. */
export function createNote(docId: DocId, page: PageInfo, at: Point, opts: { focus?: boolean; label?: string } = {}): NoteObject | null {
  if (!canAnnotate(docId) || !getDoc(docId)) return null;
  const o0 = getToolOptions(TOOL.note, NOTE_DEFAULTS);
  const [x0, y0, x1, y1] = page.view;
  const S = NOTE_SIZE;
  const rect = {
    x: Math.min(Math.max(x0, at.x - S / 2), x1 - S),
    y: Math.min(Math.max(y0, at.y - S / 2), y1 - S),
    width: S,
    height: S,
  };
  const o = newObject<NoteObject>({
    kind: 'note',
    pageId: page.id,
    rect,
    color: o0.color,
    opacity: o0.opacity,
    data: { icon: o0.icon },
  });
  addNewObject(docId, o, { select: true, label: opts.label ?? 'Add sticky note' });
  commentsUi.openPopup({ docId, objectId: o.id, focus: opts.focus ?? true, source: 'create' });
  return o;
}
