/** Vertical quick-tools rail at the left edge of the workspace (tools with `quick`, plus the All tools toggle). */
import { useMemo } from 'react';
import { LayoutGrid, Redo2, Undo2 } from 'lucide-react';
import { useRegistry } from '@/core/registry';
import { actions, useApp, useDoc } from '@/core/store';
import type { DocId } from '@/core/types';
import { Divider, IconButton, Toolbar } from '@/core/ui';

export function QuickRail({ docId }: { docId: DocId }) {
  const tools = useRegistry((s) => s.tools);
  const activeToolId = useApp((s) => s.activeToolId);
  const leftOpen = useApp((s) => s.leftPanelOpen);
  const undoLabel = useDoc(docId, (d) => d?.history.past[d.history.past.length - 1]?.label ?? null);
  const redoLabel = useDoc(docId, (d) => d?.history.future[0]?.label ?? null);
  const quick = useMemo(
    () =>
      Object.values(tools)
        .filter((t) => t.quick != null)
        .sort((a, b) => (a.quick ?? 0) - (b.quick ?? 0) || (a.order ?? 0) - (b.order ?? 0)),
    [tools],
  );

  return (
    <Toolbar vertical label="Quick tools" className="ws-rail">
      <IconButton
        icon={LayoutGrid}
        label={leftOpen ? 'Hide tools panel' : 'Show tools panel'}
        shortcut="f4"
        active={leftOpen}
        tooltipSide="right"
        onClick={() => actions.setLeftPanelOpen(!leftOpen)}
        data-testid="toggle-left-panel"
      />
      <Divider className="ws-rail-divider" />
      {quick.map((t) => (
        <IconButton
          key={t.id}
          icon={t.icon}
          label={t.label}
          shortcut={t.shortcut}
          active={activeToolId === t.id}
          tooltipSide="right"
          onClick={() => actions.setTool(activeToolId === t.id && t.id !== 'select' ? 'select' : t.id)}
          data-testid={`quick-tool-${t.id}`}
        />
      ))}
      <div className="ws-rail-spacer" />
      <IconButton
        icon={Undo2}
        label={undoLabel ? `Undo ${undoLabel.toLowerCase()}` : 'Undo'}
        shortcut="mod+z"
        tooltipSide="right"
        disabled={!undoLabel}
        onClick={() => actions.undo(docId)}
        data-testid="rail-undo"
      />
      <IconButton
        icon={Redo2}
        label={redoLabel ? `Redo ${redoLabel.toLowerCase()}` : 'Redo'}
        shortcut="mod+shift+z"
        tooltipSide="right"
        disabled={!redoLabel}
        onClick={() => actions.redo(docId)}
        data-testid="rail-redo"
      />
    </Toolbar>
  );
}
