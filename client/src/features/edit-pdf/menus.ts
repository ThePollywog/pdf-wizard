/**
 * Action lists for the selected page item — shared by the floating bar, the task panel and the
 * context menu so they always offer the same things.
 */
import {
  ArrowDownToLine, ArrowUpToLine, Crop, ExternalLink, FlipHorizontal2, FlipVertical2, ImageUp, Pencil, RotateCcw, RotateCw, Settings2, Trash2,
} from 'lucide-react';
import type { IconType } from '@/core/types';
import type { MenuEntry } from '@/core/ui';
import type { Target } from './state';
import {
  arrange, editLinkProperties, editTargetText, flipTarget, kindOfTarget, openTargetLink, removeTarget, replaceTarget, rotateTarget, startCrop,
} from './targetActions';

export interface TargetAction {
  id: string;
  label: string;
  icon: IconType;
  danger?: boolean;
  shortcut?: string;
  run(): void | Promise<unknown>;
}

export function imageActions(t: Target): TargetAction[] {
  return [
    { id: 'flip-h', label: 'Flip horizontal', icon: FlipHorizontal2, run: () => flipTarget(t, 'h') },
    { id: 'flip-v', label: 'Flip vertical', icon: FlipVertical2, run: () => flipTarget(t, 'v') },
    { id: 'rotate-ccw', label: 'Rotate counterclockwise', icon: RotateCcw, run: () => rotateTarget(t, 'ccw') },
    { id: 'rotate-cw', label: 'Rotate clockwise', icon: RotateCw, run: () => rotateTarget(t, 'cw') },
    { id: 'crop', label: 'Crop image', icon: Crop, run: () => startCrop(t) },
    { id: 'replace', label: 'Replace image', icon: ImageUp, run: () => replaceTarget(t) },
  ];
}

export function arrangeActions(t: Target): TargetAction[] {
  return [
    { id: 'front', label: 'Bring to front', icon: ArrowUpToLine, run: () => arrange(t, 'front') },
    { id: 'back', label: 'Send to back', icon: ArrowDownToLine, run: () => arrange(t, 'back') },
  ];
}

export const deleteAction = (t: Target): TargetAction => ({ id: 'delete', label: 'Delete', icon: Trash2, danger: true, shortcut: 'delete', run: () => removeTarget(t) });

export function textActions(t: Target): TargetAction[] {
  return [{ id: 'edit-text', label: 'Edit text', icon: Pencil, shortcut: 'enter', run: () => editTargetText(t) }];
}

export function linkActions(t: Target): TargetAction[] {
  return [
    { id: 'link-properties', label: 'Link properties…', icon: Settings2, shortcut: 'enter', run: () => editLinkProperties(t) },
    { id: 'link-open', label: 'Open link', icon: ExternalLink, run: () => openTargetLink(t) },
  ];
}

const entry = (a: TargetAction): MenuEntry => ({ id: `edit-pdf-ctx-${a.id}`, label: a.label, icon: a.icon, danger: a.danger, shortcut: a.shortcut, run: () => void a.run() });

/** Context menu of a page item in edit mode. */
export function targetMenu(t: Target): MenuEntry[] {
  const kind = kindOfTarget(t);
  const out: MenuEntry[] = [];
  if (kind === 'text') out.push(...textActions(t).map(entry));
  if (kind === 'image') out.push(...imageActions(t).map(entry), 'divider', ...arrangeActions(t).map(entry));
  if (kind === 'link') out.push(...linkActions(t).map(entry));
  if (kind === 'text' && t.type === 'object') out.push('divider', ...arrangeActions(t).map(entry));
  out.push('divider', entry(deleteAction(t)));
  return out;
}
