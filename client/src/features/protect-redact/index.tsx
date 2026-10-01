/**
 * Protect & Redact.
 *
 *  - task "protect" (Protect a PDF): open password, permissions password + restrictions
 *    (printing / changes / copying / screen readers, 256-bit AES), remove security, security summary.
 *    Changes go through actions.setSecurity (made undoable, see protect/securityHistory.ts); the core
 *    encryption hook encrypts on Save / Download.
 *  - task "redact" (Redact a PDF): mark text & images (tool redact-mark), mark pages (redact-pages),
 *    find text & patterns and mark results, redaction properties / codes, apply (permanent removal),
 *    remove hidden information (sanitize).
 *  - object kind "redaction" (category 'redaction'): unapplied marks, exported as /Redact
 *    annotations and imported back.
 */
import { CheckCheck, EyeOff, FileX2, LockKeyhole, ScanSearch, ShieldCheck, ShieldOff, TextCursorInput } from 'lucide-react';
import { registerAnnotationImporter } from '@/core/annotations';
import {
  registerCommands, registerContextMenu, registerObjectType, registerTask, registerTextSelectionAction, registerTool, useRegistry,
} from '@/core/registry';
import { actions, getActiveDoc, getDoc, useApp } from '@/core/store';
import type { MenuItem } from '@/core/types';
import { openProtectDialog } from './protect/PasswordDialog';
import { hasSecurity } from './protect/permissions';
import { ProtectPanel, removeSecurity } from './protect/ProtectPanel';
import { install as installSecurityHistory } from './protect/securityHistory';
import { readOnlyReason } from './shared';
import { applyRedactions } from './redact/apply';
import { redactImporter } from './redact/importer';
import { markPages, marksOf } from './redact/marks';
import { MarkOverlay, onTextSelected } from './redact/markTool';
import { redactionType } from './redact/objectType';
import { openPagesDialog } from './redact/pagesDialog';
import { MarkOptionsBar, RedactPanel } from './redact/RedactPanel';
import { openSanitizeDialog } from './redact/SanitizeDialog';
import { clearFind } from './redact/search';
import { MARK_TOOL, PAGES_TOOL } from './redact/types';
import { redactUi } from './redact/uiStore';
import './styles.css';

const PROTECT_TASK = 'protect';
const REDACT_TASK = 'redact';

installSecurityHistory();

// ── object type & PDF import ────────────────────────────────────────────────

registerObjectType(redactionType);
registerAnnotationImporter(redactImporter);

// ── tools ───────────────────────────────────────────────────────────────────

/** A shortcut nobody else registered yet (features load in isolation; never steal a key). */
function freeShortcut(key: string): string | undefined {
  const r = useRegistry.getState();
  const taken = [...Object.values(r.tools).map((t) => t.shortcut), ...Object.values(r.commands).map((c) => c.shortcut)];
  return taken.includes(key) ? undefined : key;
}

registerTool({
  id: MARK_TOOL,
  label: 'Redact text & images',
  icon: TextCursorInput,
  group: 'redact',
  order: 1,
  shortcut: freeShortcut('y'),
  cursor: 'crosshair',
  textSelection: true,
  onTextSelected,
  PageOverlay: MarkOverlay,
  OptionsBar: MarkOptionsBar,
  // Documents that can't be changed can't be marked either (the shortcut would still pick the tool).
  onActivate: () => {
    const d = getActiveDoc();
    const reason = d ? readOnlyReason(d.id) : null;
    if (!reason) return;
    setTimeout(() => {
      if (useApp.getState().activeToolId === MARK_TOOL) actions.setTool('select');
    }, 0);
    actions.toast(reason, { kind: 'error' });
  },
  onDeactivate: () => redactUi.setHover(null),
});

registerTool({
  id: PAGES_TOOL,
  label: 'Redact pages',
  icon: FileX2,
  group: 'redact',
  order: 2,
  // A dialog, not a mode: go back to the previous tool and ask which pages to mark.
  onActivate: () => {
    setTimeout(() => {
      if (useApp.getState().activeToolId === PAGES_TOOL) actions.setTool('select');
      const d = getActiveDoc();
      if (d) void openPagesDialog(d.id);
    }, 0);
  },
});

registerTextSelectionAction({
  id: 'protect-redact-redact',
  label: 'Redact',
  icon: EyeOff,
  order: 60,
  run: (selections) => {
    const docId = selections[0]?.docId;
    const reason = docId ? readOnlyReason(docId) : 'No document is open.';
    if (reason) {
      actions.toast(reason, { kind: 'error' });
      return;
    }
    onTextSelected(selections);
    actions.toast('Marked for redaction. Apply redactions to remove the text permanently.', {
      kind: 'info',
      action: { label: 'Apply', run: () => void (docId && applyRedactions(docId)) },
    });
  },
});

// ── tasks ───────────────────────────────────────────────────────────────────

registerTask({
  id: PROTECT_TASK,
  label: 'Protect a PDF',
  description: 'Add a password and restrict printing, editing and copying.',
  icon: LockKeyhole,
  color: '#8f4bd9',
  category: 'protect',
  order: 1,
  featured: 10,
  keywords: ['protect', 'password', 'encrypt', 'encryption', 'security', 'secure', 'lock', 'permissions', 'restrict', 'aes', 'decrypt', 'unlock', 'remove security'],
  requiresDocument: true,
  Panel: ProtectPanel,
});

registerTask({
  id: REDACT_TASK,
  label: 'Redact a PDF',
  description: 'Permanently remove sensitive text, images and pages.',
  icon: EyeOff,
  color: '#e0301e',
  category: 'protect',
  order: 2,
  featured: 11,
  keywords: ['redact', 'redaction', 'black out', 'blackout', 'remove', 'hide', 'censor', 'sanitize', 'hidden information', 'metadata', 'foia', 'privacy', 'pii'],
  requiresDocument: true,
  Panel: RedactPanel,
  toolbar: [MARK_TOOL, PAGES_TOOL],
  onOpen: () => redactUi.setView('main'),
  onClose: () => {
    clearFind(getActiveDoc()?.id ?? null);
    redactUi.setView('main');
    redactUi.setHover(null);
  },
});

// ── commands ────────────────────────────────────────────────────────────────

const activeId = () => getActiveDoc()?.id ?? null;
const canChange = () => {
  const id = activeId();
  return !!id && !readOnlyReason(id);
};
const withDoc = (fn: (docId: string) => unknown) => () => {
  const id = activeId();
  if (!id) return;
  const reason = readOnlyReason(id);
  if (reason) {
    actions.toast(reason, { kind: 'error' });
    return;
  }
  void fn(id);
};
const openRedact = () => {
  if (useApp.getState().activeTaskId !== REDACT_TASK) actions.openTask(REDACT_TASK);
};

registerCommands([
  { id: 'protect-redact.open-protect', label: 'Protect a PDF', icon: LockKeyhole, menu: 'tools', group: 'protect', order: 10, requiresDocument: true, run: () => actions.openTask(PROTECT_TASK) },
  {
    id: 'protect-redact.password',
    label: 'Protect using password…',
    icon: LockKeyhole,
    menu: 'document',
    group: 'protect',
    order: 10,
    requiresDocument: true,
    enabled: canChange,
    run: withDoc((id) => openProtectDialog(id, 'password')),
  },
  {
    id: 'protect-redact.restrict',
    label: 'Restrict editing…',
    icon: ShieldCheck,
    menu: 'document',
    group: 'protect',
    order: 11,
    requiresDocument: true,
    enabled: canChange,
    run: withDoc((id) => openProtectDialog(id, 'restrict')),
  },
  {
    id: 'protect-redact.remove-security',
    label: 'Remove security…',
    icon: ShieldOff,
    menu: 'document',
    group: 'protect',
    order: 12,
    requiresDocument: true,
    enabled: () => canChange() && hasSecurity(getActiveDoc()?.security),
    run: withDoc((id) => removeSecurity(id)),
  },
  { id: 'protect-redact.open-redact', label: 'Redact a PDF', icon: EyeOff, menu: 'tools', group: 'protect', order: 11, requiresDocument: true, run: () => actions.openTask(REDACT_TASK) },
  {
    id: 'protect-redact.mark',
    label: 'Redact text & images',
    icon: TextCursorInput,
    group: 'protect',
    requiresDocument: true,
    enabled: canChange,
    run: withDoc(() => {
      openRedact();
      actions.setTool(MARK_TOOL);
    }),
  },
  {
    id: 'protect-redact.pages',
    label: 'Redact pages…',
    icon: FileX2,
    group: 'protect',
    requiresDocument: true,
    enabled: canChange,
    run: withDoc((id) => {
      openRedact();
      return openPagesDialog(id);
    }),
  },
  {
    id: 'protect-redact.find',
    label: 'Find text & redact',
    icon: ScanSearch,
    group: 'protect',
    requiresDocument: true,
    enabled: canChange,
    run: withDoc(() => {
      openRedact();
      redactUi.setView('find');
    }),
  },
  {
    id: 'protect-redact.apply',
    label: 'Apply redactions',
    icon: CheckCheck,
    group: 'protect',
    requiresDocument: true,
    enabled: () => canChange() && marksOf(getActiveDoc()).length > 0,
    run: withDoc((id) => applyRedactions(id)),
  },
  {
    id: 'protect-redact.sanitize',
    label: 'Remove hidden information…',
    icon: ShieldCheck,
    menu: 'document',
    group: 'protect',
    order: 20,
    requiresDocument: true,
    enabled: canChange,
    run: withDoc((id) => openSanitizeDialog(id)),
  },
]);

// ── page context menu ───────────────────────────────────────────────────────

registerContextMenu({
  id: 'protect-redact.page',
  target: 'page',
  order: 70, // after Navigation (60); distinct orders keep the menu stable whatever order features load in
  items({ docId, pageIndex }) {
    const s = useApp.getState();
    const doc = getDoc(docId);
    if (!doc || pageIndex == null || readOnlyReason(docId)) return [];
    const redacting = s.activeTaskId === REDACT_TASK;
    const n = marksOf(doc).length;
    const items: MenuItem[] = [];
    if (redacting) {
      items.push({
        id: 'protect-redact-ctx-mark-page',
        label: 'Mark page for redaction',
        icon: FileX2,
        run: () => {
          const added = markPages(docId, [pageIndex]);
          if (!added) actions.toast('This page is already marked for redaction.', { kind: 'info' });
        },
      });
    }
    if (n > 0) {
      items.push({ id: 'protect-redact-ctx-apply-page', label: `Apply redactions (${n})`, icon: CheckCheck, run: () => void applyRedactions(docId) });
    }
    return items;
  },
});
