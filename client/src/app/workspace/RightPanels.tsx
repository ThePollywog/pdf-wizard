/** Right side: the open panel (Comments, Thumbnails, Bookmarks…) and the panel rail. */
import { useMemo } from 'react';
import { useRegistry } from '@/core/registry';
import { actions, useApp, useDoc } from '@/core/store';
import type { DocId, PanelDef } from '@/core/types';
import { IconButton, PanelHeader, Toolbar } from '@/core/ui';
import { ErrorBoundary } from '../ErrorBoundary';
import { shell, useShell } from '../uiStore';
import { Resizer } from './Resizer';

export const RIGHT_DEFAULT_WIDTH = 320;

export function useSortedPanels(): PanelDef[] {
  const panels = useRegistry((s) => s.panels);
  return useMemo(() => Object.values(panels).sort((a, b) => a.order - b.order || a.label.localeCompare(b.label)), [panels]);
}

function PanelButton({ panel, docId, active }: { panel: PanelDef; docId: DocId; active: boolean }) {
  // Primitive selector (number | undefined) so the badge never causes render loops.
  const badge = useDoc(docId, (d) => {
    if (!d || !panel.badge) return undefined;
    try {
      return panel.badge(d);
    } catch {
      return undefined;
    }
  });
  return (
    <IconButton
      icon={panel.icon}
      label={panel.label}
      active={active}
      badge={badge ?? null}
      tooltipSide="left"
      onClick={() => actions.toggleRightPanel(panel.id)}
      data-testid={`panel-btn-${panel.id}`}
    />
  );
}

export function RightRail({ docId }: { docId: DocId }) {
  const panels = useSortedPanels();
  const openId = useApp((s) => s.rightPanelId);
  if (!panels.length) return null;
  return (
    <Toolbar vertical label="Panels" className="ws-right-rail">
      {panels.map((p) => (
        <PanelButton key={p.id} panel={p} docId={docId} active={openId === p.id} />
      ))}
    </Toolbar>
  );
}

export function RightPanel({ docId }: { docId: DocId }) {
  const openId = useApp((s) => s.rightPanelId);
  const panel = useRegistry((s) => (openId ? s.panels[openId] : undefined));
  const width = useShell((s) => s.rightWidth);
  if (!panel) return null;
  const C = panel.Component;
  return (
    <aside className="ws-right" style={{ width }} aria-label={panel.label} data-testid="right-panel" data-panel-id={panel.id}>
      <Resizer edge="start" width={width} min={260} max={640} defaultWidth={RIGHT_DEFAULT_WIDTH} onResize={shell.setRightWidth} label={`Resize ${panel.label} panel`} />
      <PanelHeader title={panel.label} icon={panel.icon} onClose={() => actions.setRightPanel(null)} />
      <div className="ws-right-body">
        <ErrorBoundary name={`the ${panel.label} panel`} resetKey={`${panel.id}:${docId}`} compact>
          <C docId={docId} />
        </ErrorBoundary>
      </div>
    </aside>
  );
}
