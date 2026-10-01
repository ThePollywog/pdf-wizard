/**
 * Edit a PDF — edit the page content itself, like the usual "Edit a PDF" tool.
 *
 *  - task "edit-pdf" (left panel: add content, format, objects, page design)
 *  - tools: edit-content (E: edit text & images of the page), edit-add-text, edit-add-image,
 *    edit-link — one shared page overlay (tools/EditOverlay.tsx)
 *  - base content edits are single undoable byte edits (engine.withLib): text blocks are rewritten
 *    in place (glyphs removed, new text drawn with wrap / alignment / spacing), images get a new
 *    placement matrix / clip, links are converted to editable link objects on demand
 *  - object kinds: content-text (real page text on export), content-image, link (/Link annotation)
 */
import { FilePen, ImagePlus, Link2, SquareDashedMousePointer, Type } from 'lucide-react';
import { registerCommands, registerContextMenu, registerObjectType, registerTask, registerTool } from '@/core/registry';
import { actions, getActiveDoc, getDoc, useApp } from '@/core/store';
import type { MenuItem } from '@/core/types';
import { installKeys } from './keys';
import { FEATURE, TOOL_CONTENT, TOOL_IMAGE, TOOL_LINK, TOOL_TEXT, isEditTool } from './model';
import { setDomDoc } from './pagedom';
import { commitEdit, startNewText } from './sessions';
import { ui } from './state';
import { cancelCrop, kindOfTarget } from './targetActions';
import { contentImageType } from './objects/ContentImage';
import { contentTextType } from './objects/ContentText';
import { linkType } from './objects/Link';
import { EditOverlay } from './tools/EditOverlay';
import { naturalSize, placeImage, placeRect } from './tools/gestures';
import { flushNudge } from './tools/nudge';
import { ContentOptionsBar, ImageOptionsBar, LinkOptionsBar, TextOptionsBar, chooseImage } from './ui/OptionsBars';
import { EditPdfPanel } from './ui/Panel';
import './settle';
import './pageSync';
import './styles.css';

const TASK_ID = FEATURE;

// ── object types ─────────────────────────────────────────────────────────────

registerObjectType(contentTextType);
registerObjectType(contentImageType);
registerObjectType(linkType);

// ── tools ────────────────────────────────────────────────────────────────────

/** Tool picked (shortcut, command) while the task was closed: opened once the task is. */
let requested: string | null = null;

/** Opens the Edit a PDF task around the tool; false while it is being opened. */
function ensureTask(toolId: string): boolean {
  const app = useApp.getState();
  if (app.activeTaskId === TASK_ID) return true;
  if (!app.activeDocId) return true;
  requested = toolId;
  queueMicrotask(() => {
    if (useApp.getState().activeToolId !== toolId || useApp.getState().activeTaskId === TASK_ID) {
      requested = null;
      return;
    }
    actions.openTask(TASK_ID);
  });
  return false;
}

function activateImage() {
  if (!ensureTask(TOOL_IMAGE)) return;
  if (ui.get().pendingImage) return;
  queueMicrotask(() => {
    if (useApp.getState().activeToolId !== TOOL_IMAGE || useApp.getState().modals.length) return;
    void chooseImage().then((ok) => {
      if (!ok && useApp.getState().activeToolId === TOOL_IMAGE && !ui.get().pendingImage) actions.setTool(TOOL_CONTENT);
    });
  });
}

registerTool({
  id: TOOL_CONTENT,
  label: 'Edit text & images',
  icon: SquareDashedMousePointer,
  group: 'edit',
  shortcut: 'e',
  order: 1,
  cursor: 'default',
  PageOverlay: EditOverlay,
  OptionsBar: ContentOptionsBar,
  onActivate: () => void ensureTask(TOOL_CONTENT),
});
registerTool({
  id: TOOL_TEXT,
  label: 'Add text',
  icon: Type,
  group: 'edit',
  order: 2,
  cursor: 'text',
  oneShot: true,
  PageOverlay: EditOverlay,
  OptionsBar: TextOptionsBar,
  onActivate: () => void ensureTask(TOOL_TEXT),
});
registerTool({
  id: TOOL_IMAGE,
  label: 'Add image',
  icon: ImagePlus,
  group: 'edit',
  order: 3,
  cursor: 'copy',
  oneShot: true,
  PageOverlay: EditOverlay,
  OptionsBar: ImageOptionsBar,
  onActivate: activateImage,
});
registerTool({
  id: TOOL_LINK,
  label: 'Add or edit link',
  icon: Link2,
  group: 'edit',
  order: 4,
  cursor: 'crosshair',
  PageOverlay: EditOverlay,
  OptionsBar: LinkOptionsBar,
  onActivate: () => void ensureTask(TOOL_LINK),
});

// ── task ─────────────────────────────────────────────────────────────────────

registerTask({
  id: TASK_ID,
  label: 'Edit a PDF',
  description: 'Edit text and images, fix a typo, add text, images and links, or move content around.',
  icon: FilePen,
  color: '#e8603c',
  category: 'edit',
  order: 1,
  featured: 3,
  keywords: ['edit', 'edit pdf', 'text', 'images', 'image', 'change', 'modify', 'typo', 'fix', 'link', 'url', 'font', 'move', 'replace', 'crop'],
  requiresDocument: true,
  Panel: EditPdfPanel,
  toolbar: [TOOL_CONTENT, TOOL_TEXT, TOOL_IMAGE, TOOL_LINK],
  onOpen() {
    const want = requested;
    requested = null;
    if (!getActiveDoc()) return;
    if (!isEditTool(useApp.getState().activeToolId)) actions.setTool(want ?? TOOL_CONTENT);
  },
  onClose() {
    flushNudge();
    void commitEdit();
    cancelCrop();
    ui.reset();
  },
});

// ── commands ─────────────────────────────────────────────────────────────────

const hasDoc = () => !!getActiveDoc();

registerCommands([
  { id: 'edit-pdf.open', label: 'Edit a PDF', icon: FilePen, group: 'edit-pdf', requiresDocument: true, run: () => actions.openTask(TASK_ID) },
  {
    id: 'edit-pdf.edit-content',
    label: 'Edit PDF: Edit text & images',
    icon: SquareDashedMousePointer,
    group: 'edit-pdf',
    requiresDocument: true,
    enabled: hasDoc,
    run: () => actions.setTool(TOOL_CONTENT),
  },
  { id: 'edit-pdf.add-text', label: 'Edit PDF: Add text', icon: Type, group: 'edit-pdf', requiresDocument: true, enabled: hasDoc, run: () => actions.setTool(TOOL_TEXT) },
  { id: 'edit-pdf.add-image', label: 'Edit PDF: Add image', icon: ImagePlus, group: 'edit-pdf', requiresDocument: true, enabled: hasDoc, run: () => actions.setTool(TOOL_IMAGE) },
  { id: 'edit-pdf.add-link', label: 'Edit PDF: Add or edit link', icon: Link2, group: 'edit-pdf', requiresDocument: true, enabled: hasDoc, run: () => actions.setTool(TOOL_LINK) },
]);

// ── page context menu (while editing) ────────────────────────────────────────

registerContextMenu({
  id: 'edit-pdf.page',
  target: 'page',
  order: 5,
  items(ctx): MenuItem[] {
    const app = useApp.getState();
    if (app.activeTaskId !== TASK_ID || !isEditTool(app.activeToolId) || ctx.pageIndex === undefined || !ctx.point) return [];
    const { docId, pageIndex, point } = ctx;
    const page = getDoc(docId)?.pages[pageIndex];
    if (!page) return [];
    return [
      {
        id: 'edit-pdf-ctx-add-text',
        label: 'Add text here',
        icon: Type,
        run: () => {
          actions.setTool(TOOL_TEXT);
          startNewText(docId, pageIndex, point, page.rotation, null);
        },
      },
      {
        id: 'edit-pdf-ctx-add-image',
        label: 'Add image here…',
        icon: ImagePlus,
        run: async () => {
          if (!(await chooseImage())) return;
          const img = ui.get().pendingImage;
          const pg = getDoc(docId)?.pages[pageIndex];
          if (!img || !pg) return;
          const { w, h } = naturalSize(img, pg);
          placeImage(docId, pageIndex, img, placeRect(pg, pg.rotation, point, w, h));
          ui.setPendingImage(null);
          if (useApp.getState().activeToolId !== TOOL_CONTENT) actions.setTool(TOOL_CONTENT);
        },
      },
      { id: 'edit-pdf-ctx-link-mode', label: 'Add or edit links', icon: Link2, run: () => actions.setTool(TOOL_LINK) },
    ];
  },
});

// ── tool / document changes ──────────────────────────────────────────────────

let prevTool = useApp.getState().activeToolId;
let prevDoc = useApp.getState().activeDocId;

useApp.subscribe((s) => {
  if (s.activeToolId === prevTool && s.activeDocId === prevDoc) return;
  const toolChanged = s.activeToolId !== prevTool;
  const docChanged = s.activeDocId !== prevDoc;
  prevTool = s.activeToolId;
  prevDoc = s.activeDocId;
  flushNudge();
  void commitEdit();
  if (docChanged) {
    cancelCrop();
    ui.reset();
    setDomDoc(s.activeDocId);
  }
  if (!toolChanged) return;
  if (!isEditTool(s.activeToolId)) {
    cancelCrop();
    ui.reset();
    ui.setPendingImage(null);
    return;
  }
  cancelCrop();
  const t = ui.get().target;
  const linkTool = s.activeToolId === TOOL_LINK;
  if (t && (kindOfTarget(t) === 'link') !== linkTool) ui.setTarget(null);
  if (s.activeToolId !== TOOL_IMAGE && ui.get().pendingImage) ui.setPendingImage(null);
});

installKeys();
