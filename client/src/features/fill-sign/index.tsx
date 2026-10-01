/**
 * Fill & Sign — fill in forms, add text / dates / symbols anywhere, and sign documents yourself.
 *
 *  - task "fill-sign" (left panel: form fields, text & symbols, signatures and initials)
 *  - tools: fill-text, fill-cross, fill-check, fill-dot, fill-line, fill-circle, fill-date,
 *    fill-signature, fill-initials (one shared page overlay, see overlay.tsx)
 *  - object kinds: fill-text (real PDF text on export), fill-mark (vector paths), signature (PNG image)
 *  - AcroForm UX: field count, Tab / Next / Previous across pages, Highlight fields, Clear form
 *  - signature manager: Type (script fonts) / Draw (variable-width pen) / Image (white removal, crop),
 *    saved per user in localStorage
 */
import { CalendarDays, Check, ChevronDown, ChevronUp, Circle, Dot, Eraser, Highlighter, Minus, PenLine, Signature, Type, X } from 'lucide-react';
import type { ToolDef } from '@/core/types';
import { registerCommands, registerContextMenu, registerObjectType, registerTask, registerTool } from '@/core/registry';
import { actions, getActiveDoc, getDoc, getToolOptions, useApp } from '@/core/store';
import * as engine from '@/core/engine';
import { totalRotation } from '@/core/viewer/viewport';
import { DateOptionsBar, InitialsOptionsBar, MarkOptionsBar, SignatureOptionsBar, TextOptionsBar } from './bars';
import { clearForm, installFormNavigation, installHighlightClass, moveField } from './forms';
import { createMark, fillMarkType } from './marks';
import { TASK_ID, type SigRole } from './model';
import { MARK_TOOLS, TEXT_DEFAULTS, TEXT_OPTIONS_KEY, TOOL_INITIALS, TOOL_SIGNATURE, TOOL_TEXT } from './options';
import { FillOverlay } from './overlay';
import { FillSignPanel, resetHints } from './Panel';
import { createSignature, signatureType } from './signature';
import { openSignatureManager } from './SignatureManager';
import { setHighlight, setPending, useFillSign, watchOwner } from './store';
import { createFillText, fillTextType, watchEmptyText } from './text';
import './styles.css';

// ── object types ─────────────────────────────────────────────────────────────

registerObjectType(fillTextType);
registerObjectType(fillMarkType);
registerObjectType(signatureType);

// ── tools ────────────────────────────────────────────────────────────────────

/** Signature tools: make sure there is something to place (latest saved, else ask for one). */
function activateSignature(role: SigRole, toolId: string) {
  const st = useFillSign.getState();
  if (st.pending[role]) return;
  const latest = st.saved[role][0];
  if (latest) {
    setPending(role, latest);
    return;
  }
  queueMicrotask(() => {
    if (useApp.getState().activeToolId !== toolId || useApp.getState().modals.length) return;
    void openSignatureManager(role).then((s) => {
      if (!s && useApp.getState().activeToolId === toolId) actions.setTool('select');
    });
  });
}

const MARK_TOOL_DEFS: { id: string; label: string; icon: ToolDef['icon'] }[] = [
  { id: 'fill-cross', label: 'Cross mark', icon: X },
  { id: 'fill-check', label: 'Check mark', icon: Check },
  { id: 'fill-dot', label: 'Dot', icon: Dot },
  { id: 'fill-line', label: 'Line', icon: Minus },
  { id: 'fill-circle', label: 'Circle', icon: Circle },
];

registerTool({
  id: TOOL_TEXT,
  label: 'Add text',
  icon: Type,
  group: 'fill-sign',
  order: 1,
  quick: 14,
  cursor: 'text',
  PageOverlay: FillOverlay,
  OptionsBar: TextOptionsBar,
});
MARK_TOOL_DEFS.forEach((t, i) =>
  registerTool({
    id: t.id,
    label: t.label,
    icon: t.icon,
    group: 'fill-sign',
    order: 2 + i,
    cursor: 'crosshair',
    PageOverlay: FillOverlay,
    OptionsBar: MarkOptionsBar,
  }),
);
registerTool({
  id: 'fill-date',
  label: 'Date',
  icon: CalendarDays,
  group: 'fill-sign',
  order: 7,
  cursor: 'copy',
  PageOverlay: FillOverlay,
  OptionsBar: DateOptionsBar,
});
registerTool({
  id: TOOL_SIGNATURE,
  label: 'Add signature',
  icon: Signature,
  group: 'fill-sign',
  order: 8,
  quick: 15,
  cursor: 'crosshair',
  oneShot: true,
  PageOverlay: FillOverlay,
  OptionsBar: SignatureOptionsBar,
  onActivate: () => activateSignature('signature', TOOL_SIGNATURE),
});
registerTool({
  id: TOOL_INITIALS,
  label: 'Add initials',
  icon: PenLine,
  group: 'fill-sign',
  order: 9,
  cursor: 'crosshair',
  oneShot: true,
  PageOverlay: FillOverlay,
  OptionsBar: InitialsOptionsBar,
  onActivate: () => activateSignature('initials', TOOL_INITIALS),
});

// ── task ─────────────────────────────────────────────────────────────────────

registerTask({
  id: TASK_ID,
  label: 'Fill & Sign',
  description: 'Fill in forms, add text and symbols, and sign documents yourself.',
  icon: Signature,
  color: '#b83fe0',
  category: 'sign',
  order: 1,
  featured: 5,
  keywords: ['fill', 'sign', 'signature', 'initials', 'form', 'fields', 'type', 'text', 'date', 'check', 'checkmark', 'cross', 'e-sign'],
  requiresDocument: true,
  Panel: FillSignPanel,
  toolbar: ['fill-text', 'fill-cross', 'fill-check', 'fill-dot', 'fill-line', 'fill-circle', 'fill-date', 'fill-signature', 'fill-initials'],
  onOpen: resetHints,
});

// ── commands ─────────────────────────────────────────────────────────────────

const hasDoc = () => !!getActiveDoc();

registerCommands([
  { id: 'fill-sign.open', label: 'Fill & Sign', icon: Signature, group: 'fill-sign', requiresDocument: true, run: () => actions.openTask(TASK_ID) },
  {
    id: 'fill-sign.add-text',
    label: 'Fill & Sign: Add text',
    icon: Type,
    group: 'fill-sign',
    requiresDocument: true,
    enabled: hasDoc,
    run: () => actions.setTool(TOOL_TEXT),
  },
  {
    id: 'fill-sign.add-signature',
    label: 'Fill & Sign: Add signature',
    icon: Signature,
    group: 'fill-sign',
    requiresDocument: true,
    enabled: hasDoc,
    run: () => actions.setTool(TOOL_SIGNATURE),
  },
  {
    id: 'fill-sign.add-initials',
    label: 'Fill & Sign: Add initials',
    icon: PenLine,
    group: 'fill-sign',
    requiresDocument: true,
    enabled: hasDoc,
    run: () => actions.setTool(TOOL_INITIALS),
  },
  {
    id: 'fill-sign.next-field',
    label: 'Fill & Sign: Next form field',
    icon: ChevronDown,
    group: 'fill-sign',
    requiresDocument: true,
    enabled: hasDoc,
    run: async () => {
      const d = getActiveDoc();
      if (d && !(await moveField(d.id, 1))) actions.toast('This document has no fillable form fields.', { kind: 'info' });
    },
  },
  {
    id: 'fill-sign.prev-field',
    label: 'Fill & Sign: Previous form field',
    icon: ChevronUp,
    group: 'fill-sign',
    requiresDocument: true,
    enabled: hasDoc,
    run: async () => {
      const d = getActiveDoc();
      if (d && !(await moveField(d.id, -1))) actions.toast('This document has no fillable form fields.', { kind: 'info' });
    },
  },
  {
    id: 'fill-sign.clear-form',
    label: 'Fill & Sign: Clear form',
    icon: Eraser,
    group: 'fill-sign',
    requiresDocument: true,
    enabled: hasDoc,
    run: () => {
      const d = getActiveDoc();
      if (d) return clearForm(d.id);
    },
  },
  {
    id: 'fill-sign.toggle-highlight',
    label: 'Fill & Sign: Highlight form fields',
    icon: Highlighter,
    group: 'fill-sign',
    run: () => setHighlight(!useFillSign.getState().highlight),
  },
]);

// ── page context menu (while the task is open) ───────────────────────────────

registerContextMenu({
  id: 'fill-sign.page',
  target: 'page',
  order: 40,
  items({ docId, pageIndex, point }) {
    const s = useApp.getState();
    if (s.activeTaskId !== TASK_ID || pageIndex == null || !point) return [];
    const d = getDoc(docId);
    const page = d?.pages[pageIndex];
    if (!d || !page || engine.isReadOnly(docId)) return [];
    const rot = totalRotation(page, d.view.rotation);
    const items = [
      {
        id: 'fill-sign.ctx.text',
        label: 'Add text here',
        icon: Type,
        run: () => {
          const o = getToolOptions(TEXT_OPTIONS_KEY, TEXT_DEFAULTS);
          const obj = createFillText(docId, page, point, { fontSize: o.fontSize, letterSpacing: 0, rot }, { color: o.color, select: true });
          requestAnimationFrame(() => actions.setEditing(docId, obj.id));
        },
      },
      {
        id: 'fill-sign.ctx.check',
        label: 'Add check mark here',
        icon: Check,
        run: () => void createMark(docId, page, point, MARK_TOOLS['fill-check'], rot, (getToolOptions('fill-sign-marks', { color: '#000000' }).color as string) ?? '#000000'),
      },
    ];
    const sig = useFillSign.getState().pending.signature ?? useFillSign.getState().saved.signature[0];
    if (sig) {
      items.push({
        id: 'fill-sign.ctx.sign',
        label: 'Place signature here',
        icon: Signature,
        run: () => void createSignature(docId, page, point, sig, rot),
      });
    }
    return items;
  },
});

// ── global behaviour ─────────────────────────────────────────────────────────

const cleanups = [watchEmptyText(), watchOwner(), installHighlightClass(), installFormNavigation()];
if (import.meta.hot) import.meta.hot.dispose(() => cleanups.forEach((c) => c()));
