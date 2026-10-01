/**
 * Menu entries shared by every comment kind (object context menu, card "…" menus, pop-ups).
 */
import { Check, Copy, MessageSquareText, Reply as ReplyIcon, Trash2 } from 'lucide-react';
import type { DocId, MenuItem, PdfObject } from '@/core/types';
import type { MenuEntry } from '@/core/ui';
import { canAnnotate, commentsUi, STATUS_LABEL, STATUSES } from './model';
import { commentText, copyText, deleteComment, setStatus } from './ops';

export function statusSubmenu(docId: DocId, o: PdfObject): MenuEntry {
  return {
    id: 'comments-set-status',
    label: 'Set status',
    icon: Check,
    disabled: !canAnnotate(docId, true),
    submenu: () =>
      STATUSES.map((s) => ({
        id: `comments-status-${s}`,
        label: STATUS_LABEL[s],
        checked: (o.status ?? 'none') === s,
        run: () => setStatus(docId, o.id, s),
      })),
  };
}

/** Items added to the object context menu of every comment kind (core adds Edit/Delete/…). */
export function commentContextItems(o: PdfObject, docId: DocId): MenuItem[] {
  const text = commentText(o);
  const editable = canAnnotate(docId, true);
  const items: MenuEntry[] = [
    {
      id: 'comments-open-popup',
      label: 'Open pop-up note',
      icon: MessageSquareText,
      run: () => commentsUi.openPopup({ docId, objectId: o.id, focus: true, source: 'explicit' }),
    },
    {
      id: 'comments-reply',
      label: 'Reply',
      icon: ReplyIcon,
      disabled: !editable,
      run: () => commentsUi.openPopup({ docId, objectId: o.id, focus: true, source: 'explicit', reply: true }),
    },
    statusSubmenu(docId, o),
    { id: 'comments-copy-text', label: 'Copy text', icon: Copy, disabled: !text, run: () => copyText(text) },
  ];
  // The object context menu accepts submenus at runtime (entries are rendered by the core Menu).
  return items as unknown as MenuItem[];
}

/** "…" menu of a comment card / pop-up. */
export function commentMoreItems(o: PdfObject, docId: DocId, opts: { onEdit?(): void; onReply?(): void }): MenuEntry[] {
  const text = commentText(o);
  const editable = canAnnotate(docId, true);
  const out: MenuEntry[] = [];
  if (opts.onEdit) out.push({ id: 'comments-edit', label: 'Edit', run: opts.onEdit, disabled: !!o.locked });
  if (opts.onReply) out.push({ id: 'comments-reply', label: 'Reply', icon: ReplyIcon, run: opts.onReply });
  out.push(statusSubmenu(docId, o));
  out.push({ id: 'comments-copy-text', label: 'Copy text', icon: Copy, disabled: !text, run: () => copyText(text) });
  out.push('divider');
  out.push({ id: 'comments-delete', label: 'Delete', icon: Trash2, danger: true, disabled: !!o.locked || !editable, run: () => deleteComment(docId, o.id) });
  return out;
}
