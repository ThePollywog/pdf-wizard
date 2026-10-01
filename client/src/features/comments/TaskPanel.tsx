/**
 * Left panel of the "Comment" task: the commenting / markup tools with a short description and
 * the active tool's options, the author name, and shortcuts to the Comments panel, export,
 * import, summary and show / hide.
 */
import { Eye, EyeOff, FileDown, FileText, FileUp, MessageSquare, Pencil } from 'lucide-react';
import { useRegistry } from '@/core/registry';
import { actions, useApp, useDoc } from '@/core/store';
import type { DocId, ToolDef } from '@/core/types';
import { Button, Kbd, Switch, formatShortcut, promptDialog } from '@/core/ui';
import { canAnnotate, isCommentKind, TOOL, useCommentsUi } from './model';
import { toggleCommentsHidden } from './Panel';
import { exportXfdf, importXfdf } from './xfdf';
import { summarizeComments } from './summarize';

const SECTIONS: { title: string; ids: string[] }[] = [
  { title: 'Add comments', ids: [TOOL.note, TOOL.textbox, TOOL.callout, TOOL.attach] },
  { title: 'Mark up text', ids: [TOOL.highlight, TOOL.underline, TOOL.strikeout, TOOL.squiggly, TOOL.insert, TOOL.replace] },
  { title: 'Draw', ids: ['draw-pen', 'shape-rect', 'stamp'] },
];

const DESCRIPTION: Record<string, string> = {
  [TOOL.note]: 'Sticky note with a pop-up comment',
  [TOOL.textbox]: 'Text typed directly on the page',
  [TOOL.callout]: 'Text box with a leader line',
  [TOOL.attach]: 'Embed a file as a comment',
  [TOOL.highlight]: 'Highlight text or an area',
  [TOOL.underline]: 'Underline selected text',
  [TOOL.strikeout]: 'Cross out selected text',
  [TOOL.squiggly]: 'Wavy underline under text',
  [TOOL.insert]: 'Mark where text should be added',
  [TOOL.replace]: 'Strike out text and suggest new text',
};

function ToolRow({ tool, active }: { tool: ToolDef; active: boolean }) {
  const Icon = tool.icon;
  const Options = active ? tool.OptionsBar : undefined;
  return (
    <li className={`comments-task-item${active ? ' is-active' : ''}`}>
      <button
        type="button"
        className="comments-task-tool"
        aria-pressed={active}
        onClick={() => actions.setTool(active ? 'select' : tool.id)}
        data-testid={`comments-task-tool-${tool.id}`}
      >
        <span className="comments-task-tool-icon">
          <Icon size={18} strokeWidth={1.8} />
        </span>
        <span className="comments-task-tool-text">
          <span className="comments-task-tool-label">{tool.label}</span>
          {DESCRIPTION[tool.id] && <span className="comments-task-tool-desc">{DESCRIPTION[tool.id]}</span>}
        </span>
        {tool.shortcut && <Kbd>{formatShortcut(tool.shortcut)}</Kbd>}
      </button>
      {Options && (
        <div className="comments-task-options" data-testid="comments-task-options">
          <Options />
        </div>
      )}
    </li>
  );
}

async function changeName() {
  const current = useApp.getState().prefs.userName;
  const name = await promptDialog({
    title: 'Your name',
    label: 'Name',
    defaultValue: current,
    confirmLabel: 'Save',
    help: 'Shown as the author of your comments and markups.',
    validate: (v) => (v.trim().length > 60 ? 'Use 60 characters or fewer' : null),
  });
  if (name != null) actions.setPrefs({ userName: name.trim() });
}

function DocSection({ docId }: { docId: DocId }) {
  const count = useDoc(docId, (d) => (d ? d.order.reduce((n, id) => (d.objects[id] && isCommentKind(d.objects[id].kind) ? n + 1 : n), 0) : 0));
  const hidden = useCommentsUi((s) => !!s.hidden[docId]);
  const panelOpen = useApp((s) => s.rightPanelId === 'comments');
  return (
    <section className="comments-task-section">
      <h3 className="comments-task-title">Comments</h3>
      <p className="comments-task-count" data-testid="comments-task-count">
        {count ? `${count} comment${count === 1 ? '' : 's'} in this document` : 'No comments in this document yet.'}
      </p>
      <div className="comments-task-actions">
        <Button size="sm" icon={MessageSquare} onClick={() => actions.setRightPanel(panelOpen ? null : 'comments')} data-testid="comments-task-show-panel">
          {panelOpen ? 'Hide comments panel' : 'Show comments panel'}
        </Button>
        <Button size="sm" icon={hidden ? Eye : EyeOff} onClick={() => toggleCommentsHidden(docId)} disabled={!count && !hidden} data-testid="comments-task-toggle-hidden">
          {hidden ? 'Show all comments' : 'Hide all comments'}
        </Button>
        <Button size="sm" icon={FileDown} onClick={() => void exportXfdf(docId)} disabled={!count} data-testid="comments-task-export">
          Export comments…
        </Button>
        <Button size="sm" icon={FileUp} onClick={() => void importXfdf(docId)} data-testid="comments-task-import">
          Import comments…
        </Button>
        <Button size="sm" icon={FileText} onClick={() => void summarizeComments(docId)} disabled={!count} data-testid="comments-task-summarize">
          Summarize comments
        </Button>
      </div>
    </section>
  );
}

export function CommentTaskPanel() {
  const docId = useApp((s) => s.activeDocId);
  const tools = useRegistry((s) => s.tools);
  const active = useApp((s) => s.activeToolId);
  const locked = useApp((s) => s.toolLocked);
  const userName = useApp((s) => s.prefs.userName) || 'Guest';
  const readOnly = docId ? !canAnnotate(docId, true) : false;
  return (
    <div className="comments-task" data-testid="comments-task-panel">
      {readOnly && (
        <p className="comments-task-readonly" data-testid="comments-task-readonly">
          This document is read-only. Comments can be viewed but not added or changed.
        </p>
      )}
      {SECTIONS.map((s) => {
        const list = s.ids.map((id) => tools[id]).filter((t): t is ToolDef => !!t);
        if (!list.length) return null;
        return (
          <section key={s.title} className="comments-task-section">
            <h3 className="comments-task-title">{s.title}</h3>
            <ul className="comments-task-tools" role="group" aria-label={s.title}>
              {list.map((t) => (
                <ToolRow key={t.id} tool={t} active={active === t.id} />
              ))}
            </ul>
          </section>
        );
      })}
      <section className="comments-task-section comments-task-prefs">
        <Switch label="Keep tool selected" checked={locked} onChange={(b) => actions.setToolLocked(b)} description="Add several comments without re-selecting the tool." />
        <div className="comments-task-author">
          <span>
            Commenting as <strong data-testid="comments-task-author">{userName}</strong>
          </span>
          <Button size="sm" variant="ghost" icon={Pencil} onClick={() => void changeName()} data-testid="comments-task-change-name">
            Change
          </Button>
        </div>
      </section>
      {docId && <DocSection docId={docId} />}
    </div>
  );
}
