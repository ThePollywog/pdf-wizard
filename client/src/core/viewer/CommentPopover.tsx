/**
 * Popover editing an object's comment (`obj.contents`), opened from the properties bar or the
 * object context menu via viewerUi.commentFor. Closing (outside click / Esc / Post) keeps the text;
 * Cancel discards it.
 */
import { useEffect, useState } from 'react';
import { MessageSquare } from 'lucide-react';
import type { DocId, PdfObject } from '../types';
import { actions, useApp, useDoc } from '../store';
import { useRegistry } from '../registry';
import { Button, Popover, TextArea, matchShortcut } from '../ui';
import type { ViewerController } from './controller';
import { useViewerUi, viewerUi } from './viewerStore';

function fmtTime(ms: number) {
  try {
    return new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return '';
  }
}

export function CommentPopover({ ctrl, docId }: { ctrl: ViewerController; docId: DocId }) {
  const target = useViewerUi((s) => (s.commentFor && s.commentFor.docId === docId ? s.commentFor.objectId : null));
  const obj = useDoc(docId, (d) => (target ? d?.objects[target] : undefined));
  // The popover needs the object's element; it exists once the page is mounted.
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!target) {
      setAnchor(null);
      return;
    }
    let raf = 0;
    let tries = 0;
    const find = () => {
      const el = ctrl.sizer?.querySelector<HTMLElement>(`.pdfwizard-obj[data-obj-id="${CSS.escape(target)}"]`) ?? null;
      if (el) setAnchor(el);
      else if (tries++ < 30) raf = requestAnimationFrame(find);
      else viewerUi.set({ commentFor: null });
    };
    find();
    return () => cancelAnimationFrame(raf);
  }, [ctrl, target]);

  useEffect(() => {
    // Closed if the object disappears (deleted / undo).
    if (target && !obj) viewerUi.set({ commentFor: null });
  }, [target, obj]);

  if (!target || !obj || !anchor || !anchor.isConnected) return null;
  return <CommentEditor key={obj.id} docId={docId} obj={obj} anchor={anchor} />;
}

function CommentEditor({ docId, obj, anchor }: { docId: DocId; obj: PdfObject; anchor: HTMLElement }) {
  const [draft, setDraft] = useState(obj.contents ?? '');
  const userName = useApp((s) => s.prefs.userName);
  const typeLabel = useRegistry((s) => s.objectTypes[obj.kind]?.label ?? 'Comment');

  const close = (save: boolean) => {
    if (save && draft !== (obj.contents ?? '')) actions.updateObject(docId, obj.id, { contents: draft }, { label: 'Edit comment' });
    viewerUi.set({ commentFor: null });
  };

  return (
    <Popover
      open
      anchor={anchor}
      onClose={() => close(true)}
      placement="bottom-start"
      offset={8}
      className="pdfwizard-comment-popover"
      aria-label="Comment"
    >
      <div className="pdfwizard-comment" data-testid="comment-popover">
        <div className="pdfwizard-comment-head">
          <span className="pdfwizard-comment-icon">
            <MessageSquare size={16} strokeWidth={1.75} />
          </span>
          <span className="pdfwizard-comment-who">
            <strong>{obj.author || userName || 'Guest'}</strong>
            <small>
              {typeLabel} · {fmtTime(obj.modifiedAt)}
            </small>
          </span>
        </div>
        <TextArea
          value={draft}
          onChange={setDraft}
          autoGrow
          rows={3}
          aria-label="Comment text"
          placeholder="Add a comment…"
          data-autofocus
          onKeyDown={(e) => {
            if (matchShortcut(e.nativeEvent, 'mod+enter')) {
              e.preventDefault();
              close(true);
            }
          }}
        />
        <div className="pdfwizard-comment-actions">
          <Button size="sm" variant="ghost" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" onClick={() => close(true)}>
            Post
          </Button>
        </div>
      </div>
    </Popover>
  );
}
