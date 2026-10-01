/**
 * Pop-up note: the floating editor next to a comment on the page (author, date, text with
 * Post / Cancel, replies, status). Rendered in its own React root on <body> so it can float over
 * the viewer; positioned next to the object's element and re-positioned every frame (scroll, zoom,
 * moves). Hidden while the object is being moved / resized.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MoreHorizontal, X } from 'lucide-react';
import type { DocId, PdfObject } from '@/core/types';
import { useApp, useDoc } from '@/core/store';
import { useViewerUi } from '@/core/viewer/viewerStore';
import { Dropdown, IconButton, computePosition, useEscapeLayer } from '@/core/ui';
import { LAYER_ATTR, nextLayerOrder, useOutsidePointerDown } from '@/core/ui/layers';
import { canAnnotate, commentsUi, kindLabel, typeOf, useCommentsUi, type CaretData, type PopupTarget } from './model';
import { commentMoreItems } from './menus';
import { discardNew, setContents } from './ops';
import { Avatar, CommentEditor, ReplyThread, StatusBadge, TimeAgo } from './thread';

function anchorOf(docId: DocId, id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`.pdfwizard-viewer[data-doc-id="${CSS.escape(docId)}"] .pdfwizard-obj[data-obj-id="${CSS.escape(id)}"]`);
}

/** Visible part of the object: for callouts the text box, otherwise the object's element. */
function anchorRect(el: HTMLElement): DOMRect {
  const frame = el.querySelector<HTMLElement>('.comments-ft-frame');
  return (frame ?? el).getBoundingClientRect();
}

/** Quoted text shown above the note (highlighted / struck-out text). */
function quoteOf(o: PdfObject): string {
  if (o.kind === 'text-markup') return (o.data as { text?: string }).text ?? '';
  if (o.kind === 'caret') return (o.data as CaretData).strike?.text ?? '';
  return '';
}

function isDisposable(o: PdfObject): boolean {
  if (o.contents?.trim() || o.replies?.length) return false;
  if (o.kind === 'note') return true;
  if (o.kind === 'caret') return !(o.data as CaretData).strike;
  return false;
}

function Popup({ target }: { target: PopupTarget }) {
  const { docId, objectId } = target;
  const obj = useDoc(docId, (d) => d?.objects[objectId]);
  const selection = useDoc(docId, (d) => d?.selection);
  const activeDocId = useApp((s) => s.activeDocId);
  const moving = useViewerUi((s) => s.interaction === 'move' || s.interaction === 'resize');
  const hidden = useCommentsUi((s) => !!s.hidden[docId]);
  const ref = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [order] = useState(() => nextLayerOrder());
  // Read-only documents (can't be saved with changes) show the note without any editing controls.
  const [readOnly] = useState(() => !canAnnotate(docId, true));
  const [editing, setEditing] = useState(
    () => !readOnly && (target.source === 'create' || target.source === 'edit' || (!target.reply && target.focus) || !obj?.contents),
  );
  const draftRef = useRef<string | null>(null);
  // Focus can only move into the pop-up once it is visible (it is laid out hidden first).
  const [ready, setReady] = useState(false);
  /** Editing started by the user in the pop-up ("Edit", double click): the editor takes the focus. */
  const [userEdit, setUserEdit] = useState(false);
  const startEdit = () => {
    if (readOnly || obj?.locked) return;
    setUserEdit(true);
    setEditing(true);
  };

  // Close when the object goes away, the document changes, or a "select" pop-up loses its selection.
  const close = () => commentsUi.closePopup();
  useEffect(() => {
    if (!obj || hidden || (activeDocId && activeDocId !== docId)) close();
  }, [obj, hidden, activeDocId, docId]);
  useEffect(() => {
    if (target.source !== 'select' || !selection) return;
    if (selection.length !== 1 || selection[0] !== objectId) close();
  }, [selection, target.source, objectId]);

  // Track the anchor element and keep the pop-up next to it.
  useLayoutEffect(() => {
    let raf = 0;
    let last = '';
    const tick = () => {
      const el = anchorOf(docId, objectId);
      setAnchor((prev) => (prev === el ? prev : el));
      const me = ref.current;
      if (el && me) {
        const r = anchorRect(el);
        const size = { width: me.offsetWidth, height: me.offsetHeight };
        const key = `${r.left}|${r.top}|${r.width}|${r.height}|${size.width}|${size.height}|${window.innerWidth}|${window.innerHeight}`;
        if (key !== last) {
          last = key;
          const p = computePosition({ left: r.left, top: r.top, width: r.width, height: r.height }, size, 'right-start', 12);
          setPos((prev) => (prev && prev.left === p.left && prev.top === p.top ? prev : { left: p.left, top: p.top }));
        }
      }
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [docId, objectId]);

  const saveDraft = () => {
    const d = draftRef.current;
    if (d !== null && obj && d.replace(/\s+$/, '') !== (obj.contents ?? '')) setContents(docId, objectId, d.replace(/\s+$/, ''));
    draftRef.current = null;
  };
  const cancel = () => {
    draftRef.current = null;
    if (obj && target.source === 'create' && isDisposable(obj)) {
      close();
      discardNew(docId, objectId);
      return;
    }
    if (target.source === 'create' || target.source === 'edit' || !obj?.contents) close();
    else setEditing(false);
  };

  // Only while the pop-up has focus: an escape layer also blocks the viewer's keys (Delete, arrows).
  const [hasFocus, setHasFocus] = useState(false);
  useEscapeLayer(hasFocus, cancel);
  useOutsidePointerDown(
    true,
    () => [ref.current, anchor],
    (e) => {
      const t = e.target as Element | null;
      // Menus / dialogs / toasts opened from the pop-up are separate layers.
      if (t?.closest?.('[role="menu"], [role="dialog"], .toast')) return;
      saveDraft();
      close();
    },
    order,
  );

  const visible = !!anchor && !moving && !!pos;
  useLayoutEffect(() => {
    if (visible) setReady(true);
  }, [visible]);

  if (!obj) return null;
  const type = typeOf(obj);
  const Icon = type?.icon;
  const quote = quoteOf(obj);
  const show = visible;
  const isText = obj.kind === 'freetext';

  return (
    <div
      ref={ref}
      className="comments-popup"
      role="dialog"
      aria-label={`${kindLabel(obj)} by ${obj.author}`}
      data-testid="comments-popup"
      data-obj-id={obj.id}
      data-viewer-passthrough
      data-no-shortcuts
      {...{ [LAYER_ATTR]: order }}
      style={{ position: 'fixed', left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: show ? 'visible' : 'hidden' }}
      onKeyDown={(e) => e.stopPropagation()}
      onFocus={() => setHasFocus(true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHasFocus(false);
      }}
    >
      <div className="comments-popup-head">
        <Avatar name={obj.author} size={28} />
        <div className="comments-popup-who">
          <span className="comments-author" data-testid="comments-popup-author">
            {obj.author}
          </span>
          <span className="comments-popup-meta">
            {Icon && <Icon size={12} strokeWidth={2} />}
            <span>{kindLabel(obj)}</span>
            <span aria-hidden="true">·</span>
            <TimeAgo t={obj.modifiedAt || obj.createdAt} testid="comments-popup-time" />
          </span>
        </div>
        <StatusBadge status={obj.status} testid="comments-popup-status" />
        <Dropdown
          label="More options"
          align="end"
          items={() =>
            commentMoreItems(obj, docId, {
              onEdit: readOnly ? undefined : startEdit,
              onReply: readOnly
                ? undefined
                : () => commentsUi.openPopup({ ...target, reply: true, focus: true, source: target.source === 'select' ? 'explicit' : target.source }),
            })
          }
          trigger={<IconButton icon={MoreHorizontal} size="sm" label="More options" data-testid="comments-popup-more" />}
        />
        <IconButton
          icon={X}
          size="sm"
          label="Close"
          onClick={() => {
            saveDraft();
            close();
          }}
          data-testid="comments-popup-close"
        />
      </div>
      {quote && (
        <blockquote className="comments-popup-quote" data-testid="comments-popup-quote">
          {quote}
        </blockquote>
      )}
      <div className="comments-popup-body">
        {editing && !obj.locked && !readOnly ? (
          <CommentEditor
            testid="comments-popup-editor"
            initial={obj.contents ?? ''}
            autoFocus={ready && ((target.focus && !target.reply) || userEdit)}
            placeholder={isText ? 'Text' : 'Add a comment…'}
            allowEmpty={!!obj.contents}
            onDraftChange={(t) => (draftRef.current = t)}
            onCancel={cancel}
            onPost={(t) => {
              draftRef.current = null;
              setContents(docId, objectId, t);
              if (target.source === 'create' || target.source === 'edit') close();
              else setEditing(false);
            }}
          />
        ) : (
          <div
            className={`comments-popup-contents${obj.contents ? '' : ' is-empty'}`}
            data-testid="comments-popup-contents"
            onDoubleClick={startEdit}
          >
            {obj.contents || 'No comment text'}
          </div>
        )}
        <ReplyThread docId={docId} obj={obj} testid="comments-popup" focusReply={target.reply} showBox={!editing} ready={ready} readOnly={readOnly} />
      </div>
    </div>
  );
}

function PopupRoot() {
  const popup = useCommentsUi((s) => s.popup);
  if (!popup) return null;
  return <Popup key={`${popup.docId}:${popup.objectId}:${popup.reply ? 'r' : ''}`} target={popup} />;
}

let root: Root | null = null;
export function mountPopupRoot() {
  if (root || typeof document === 'undefined') return;
  const host = document.createElement('div');
  host.className = 'comments-popup-host';
  document.body.appendChild(host);
  root = createRoot(host);
  root.render(<PopupRoot />);
}
