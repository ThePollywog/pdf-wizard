import { useMemo, useState } from 'react';
import { Keyboard, Search } from 'lucide-react';
import { actions } from '@/core/store';
import { useRegistry } from '@/core/registry';
import type { MenuId } from '@/core/types';
import { Button, EmptyState, Modal, TextField, shortcutParts } from '@/core/ui';
import { MENU_LABELS, MENU_ORDER, SHORTCUT_ALIASES, SHORTCUT_HINTS } from '../commands';

interface Row {
  label: string;
  keys: string[];
}
interface Section {
  title: string;
  rows: Row[];
}

const VIEWER_ROWS: Row[] = [
  { label: 'Delete selected objects', keys: ['delete'] },
  { label: 'Nudge selected objects', keys: ['arrowleft'] },
  { label: 'Nudge by 10 points', keys: ['shift+arrowleft'] },
  { label: 'Clear selection', keys: ['escape'] },
  { label: 'Copy / cut / paste objects', keys: ['mod+c', 'mod+x', 'mod+v'] },
  { label: 'Duplicate objects', keys: ['mod+d'] },
  { label: 'Zoom with the mouse wheel', keys: ['mod+wheel'] },
];

function Keys({ s }: { s: string }) {
  const parts = s === 'mod+wheel' ? [...shortcutParts('mod+a').slice(0, -1), 'Scroll'] : shortcutParts(s);
  return (
    <span className="shortcut-keys">
      {parts.map((p, i) => (
        <kbd key={i} className="kbd">
          {p}
        </kbd>
      ))}
    </span>
  );
}

function ShortcutsBody({ close }: { close(): void }) {
  const commands = useRegistry((s) => s.commands);
  const tools = useRegistry((s) => s.tools);
  const [q, setQ] = useState('');

  const sections = useMemo<Section[]>(() => {
    const out: Section[] = [];
    const byMenu = new Map<string, Row[]>();
    const cmds = Object.values(commands).sort((a, b) => (a.group ?? '').localeCompare(b.group ?? '') || (a.order ?? 0) - (b.order ?? 0));
    for (const c of cmds) {
      const keys = [c.shortcut ?? SHORTCUT_HINTS[c.id], ...(SHORTCUT_ALIASES[c.id] ?? [])].filter((k): k is string => !!k);
      if (!keys.length) continue;
      const menu = c.menu ?? 'other';
      if (!byMenu.has(menu)) byMenu.set(menu, []);
      byMenu.get(menu)!.push({ label: c.label, keys });
    }
    for (const m of [...MENU_ORDER, 'other'] as (MenuId | 'other')[]) {
      const rows = byMenu.get(m);
      if (rows?.length) out.push({ title: m === 'other' ? 'Other' : MENU_LABELS[m], rows });
    }
    const toolRows = Object.values(tools)
      .filter((t) => t.shortcut)
      .sort((a, b) => (a.quick ?? 999) - (b.quick ?? 999) || (a.order ?? 0) - (b.order ?? 0) || a.label.localeCompare(b.label))
      .map((t) => ({ label: t.label, keys: [t.shortcut!] }));
    if (toolRows.length) {
      // Commands in the 'tools' menu and the tool shortcuts share one section.
      const existing = out.find((s) => s.title === MENU_LABELS.tools);
      if (existing) {
        // Tool-switch commands (e.g. "Select tool") duplicate the tool's own shortcut row.
        const toolKeys = new Set(toolRows.flatMap((r) => r.keys));
        existing.rows = [...toolRows, ...existing.rows.filter((r) => !r.keys.every((k) => toolKeys.has(k)))];
      }
      else out.push({ title: MENU_LABELS.tools, rows: toolRows });
    }
    out.push({ title: 'Selected objects', rows: VIEWER_ROWS });
    const needle = q.trim().toLowerCase();
    if (!needle) return out;
    return out
      .map((s) => ({ ...s, rows: s.rows.filter((r) => r.label.toLowerCase().includes(needle) || s.title.toLowerCase().includes(needle)) }))
      .filter((s) => s.rows.length);
  }, [commands, tools, q]);

  return (
    <Modal
      title="Keyboard shortcuts"
      icon={Keyboard}
      width={760}
      onClose={close}
      className="shortcuts-dialog"
      bodyClassName="shortcuts-body"
      footer={
        <Button variant="primary" onClick={close}>
          Close
        </Button>
      }
    >
      <TextField value={q} onChange={setQ} icon={Search} placeholder="Search shortcuts" aria-label="Search shortcuts" data-autofocus="" fieldClassName="shortcuts-search" />
      {sections.length === 0 ? (
        <EmptyState icon={Search} title="No shortcuts found" description="Try a different search." compact />
      ) : (
        <div className="shortcuts-grid" data-testid="shortcuts-list">
          {sections.map((s) => (
            <section key={s.title} className="shortcuts-section">
              <h3 className="shortcuts-section-title">{s.title}</h3>
              {s.rows.map((r, i) => (
                <div key={`${r.label}-${i}`} className="shortcuts-row">
                  <span className="shortcuts-label">{r.label}</span>
                  <span className="shortcuts-combos">
                    {r.keys.map((k, j) => (
                      <span key={k} className="shortcuts-combo">
                        {j > 0 && <span className="shortcuts-or">or</span>}
                        <Keys s={k} />
                      </span>
                    ))}
                  </span>
                </div>
              ))}
            </section>
          ))}
        </div>
      )}
    </Modal>
  );
}

export function openShortcuts() {
  if (document.querySelector('.shortcuts-dialog')) return;
  return actions.openModal<void>((close) => <ShortcutsBody close={() => close()} />);
}
