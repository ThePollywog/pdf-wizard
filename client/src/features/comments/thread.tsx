/**
 * Pieces shared by the pop-up note and the Comments panel cards: avatars, the comment editor
 * (Post / Cancel), the reply thread and the reply box.
 */
import { useLayoutEffect, useRef, useState, type KeyboardEvent as RKeyboardEvent, type Ref, type RefObject, type TextareaHTMLAttributes } from 'react';
import { CheckCircle2, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import type { DocId, PdfObject, Reply, ReviewStatus } from '@/core/types';
import { Button, Dropdown, IconButton } from '@/core/ui';
import { authorColor, fullTime, initials, relativeTime, STATUS_LABEL } from './model';
import { addReply, deleteReply, editReply } from './ops';

export function Avatar({ name, size = 24 }: { name: string; size?: number }) {
  return (
    <span className="comments-avatar" style={{ width: size, height: size, background: authorColor(name), fontSize: Math.round(size * 0.42) }} aria-hidden="true">
      {initials(name)}
    </span>
  );
}

export function TimeAgo({ t, testid }: { t: number; testid?: string }) {
  return (
    <time className="comments-time" dateTime={new Date(t).toISOString()} title={fullTime(t)} data-testid={testid}>
      {relativeTime(t)}
    </time>
  );
}

export function StatusBadge({ status, testid }: { status: ReviewStatus | undefined; testid?: string }) {
  if (!status || status === 'none') return null;
  return (
    <span className={`comments-status is-${status}`} data-testid={testid} title={`Status: ${STATUS_LABEL[status]}`}>
      <CheckCircle2 size={12} strokeWidth={2} />
      {STATUS_LABEL[status]}
    </span>
  );
}

/** Textarea that grows with its content. */
export function AutoTextarea({
  value,
  onChange,
  maxHeight = 220,
  className,
  ref: outer,
  ...props
}: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange'> & { value: string; onChange(v: string): void; maxHeight?: number; ref?: Ref<HTMLTextAreaElement> }) {
  const inner = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    const el = inner.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(maxHeight, el.scrollHeight + 2)}px`;
  }, [value, maxHeight]);
  return (
    <textarea
      {...props}
      ref={(el) => {
        inner.current = el;
        if (typeof outer === 'function') outer(el);
        else if (outer && typeof outer === 'object') (outer as RefObject<HTMLTextAreaElement | null>).current = el;
      }}
      className={`input textarea comments-textarea ${className ?? ''}`}
      value={value}
      onChange={(e) => onChange(e.currentTarget.value)}
    />
  );
}

/** Text editor with Post / Cancel (⌘/Ctrl+Enter posts, Esc cancels). */
export function CommentEditor({
  initial,
  onPost,
  onCancel,
  placeholder = 'Add a comment…',
  autoFocus,
  testid,
  postLabel = 'Post',
  allowEmpty,
  onDraftChange,
}: {
  initial: string;
  onPost(text: string): void;
  onCancel(): void;
  placeholder?: string;
  autoFocus?: boolean;
  testid: string;
  postLabel?: string;
  allowEmpty?: boolean;
  onDraftChange?(text: string): void;
}) {
  const [draft, setDraft] = useState(initial);
  const ta = useRef<HTMLTextAreaElement | null>(null);
  useLayoutEffect(() => {
    if (!autoFocus) return;
    const el = ta.current;
    if (!el) return;
    const focus = () => {
      el.focus({ preventScroll: true });
      el.setSelectionRange(el.value.length, el.value.length);
    };
    focus();
    // A menu that started the edit gives the focus back to its trigger when it closes: take it again.
    const raf = requestAnimationFrame(() => el.isConnected && document.activeElement !== el && focus());
    return () => cancelAnimationFrame(raf);
  }, [autoFocus]);
  const canPost = allowEmpty ? draft !== initial || !!draft.trim() : !!draft.trim();
  const post = () => {
    if (!canPost) return;
    onPost(draft.replace(/\s+$/, ''));
  };
  const onKeyDown = (e: RKeyboardEvent<HTMLTextAreaElement>) => {
    e.stopPropagation();
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      post();
    }
  };
  return (
    <div className="comments-editor" data-testid={testid}>
      <AutoTextarea
        ref={ta}
        value={draft}
        onChange={(v) => {
          setDraft(v);
          onDraftChange?.(v);
        }}
        placeholder={placeholder}
        aria-label={placeholder}
        rows={2}
        onKeyDown={onKeyDown}
        data-testid={`${testid}-input`}
      />
      <div className="comments-editor-actions">
        <Button size="sm" variant="ghost" onClick={onCancel} data-testid={`${testid}-cancel`}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" onClick={post} disabled={!canPost} data-testid={`${testid}-post`}>
          {postLabel}
        </Button>
      </div>
    </div>
  );
}

function ReplyItem({
  docId,
  obj,
  reply,
  index,
  testid,
  readOnly,
}: {
  docId: DocId;
  obj: PdfObject;
  reply: Reply;
  index: number;
  testid: string;
  readOnly?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const id = `${testid}-reply-${index}`;
  return (
    <li className="comments-reply" data-testid={id} data-reply-id={reply.id}>
      <div className="comments-reply-head">
        <Avatar name={reply.author} size={20} />
        <span className="comments-author">{reply.author}</span>
        <TimeAgo t={reply.createdAt} />
        <span className="comments-spacer" />
        {!obj.locked && !readOnly && (
          <Dropdown
            label="Reply options"
            align="end"
            items={[
              { id: 'comments-reply-edit', label: 'Edit', icon: Pencil, run: () => setEditing(true) },
              { id: 'comments-reply-delete', label: 'Delete', icon: Trash2, danger: true, run: () => deleteReply(docId, obj.id, reply.id) },
            ]}
            trigger={<IconButton icon={MoreHorizontal} size="sm" label="Reply options" data-testid={`${id}-more`} />}
          />
        )}
      </div>
      {editing && !readOnly ? (
        <CommentEditor
          testid={`${id}-editor`}
          initial={reply.text}
          autoFocus
          postLabel="Save"
          onCancel={() => setEditing(false)}
          onPost={(t) => {
            editReply(docId, obj.id, reply.id, t);
            setEditing(false);
          }}
        />
      ) : (
        <div className="comments-reply-text" data-testid={`${id}-text`}>
          {reply.text}
        </div>
      )}
    </li>
  );
}

/** Replies of a comment + the reply box. */
export function ReplyThread({
  docId,
  obj,
  testid,
  focusReply,
  showBox = true,
  ready = true,
  readOnly,
}: {
  docId: DocId;
  obj: PdfObject;
  testid: string;
  focusReply?: boolean;
  showBox?: boolean;
  /** False while the container is not visible yet (focus is deferred until it is). */
  ready?: boolean;
  /** The document can't be changed: no reply box, no edit / delete of replies. */
  readOnly?: boolean;
}) {
  const replies = obj.replies ?? [];
  // The box closes after posting (like desktop PDF editors), so ⌘Z right after a reply undoes it instead of
  // going to an empty text field.
  const [boxOpen, setBoxOpen] = useState(!!focusReply);
  return (
    <div className="comments-thread">
      {replies.length > 0 && (
        <ul className="comments-replies" data-testid={`${testid}-replies`}>
          {replies.map((r, i) => (
            <ReplyItem key={r.id} docId={docId} obj={obj} reply={r} index={i} testid={testid} readOnly={readOnly} />
          ))}
        </ul>
      )}
      {showBox &&
        !readOnly &&
        (boxOpen ? (
          <CommentEditor
            testid={`${testid}-replybox`}
            initial=""
            placeholder="Add a reply…"
            postLabel="Reply"
            autoFocus={ready}
            onCancel={() => setBoxOpen(false)}
            onPost={(t) => {
              if (addReply(docId, obj.id, t)) setBoxOpen(false);
            }}
          />
        ) : (
          <button type="button" className="comments-reply-open" onClick={() => setBoxOpen(true)} data-testid={`${testid}-reply`}>
            Reply
          </button>
        ))}
    </div>
  );
}
