/**
 * Layers panel: the document's optional content groups (OCGs) in the /Order tree of the default
 * configuration, with visibility toggles. Visibility lives in doc.ext.optionalContent (view state,
 * like desktop viewers — it doesn't modify the file) and the viewer re-renders pages with it.
 * The panel is registered only while the active document has layers.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronDown, ChevronRight, Ellipsis, Eye, EyeOff, Layers, RotateCcw } from 'lucide-react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { DocId, PanelDef } from '@/core/types';
import * as engine from '@/core/engine';
import { registerPanel, useRegistry } from '@/core/registry';
import { actions, getDoc, useApp, useDoc } from '@/core/store';
import { Dropdown, EmptyState, IconButton, Spinner } from '@/core/ui';
import { errMsg } from '../util';

export const LAYERS_PANEL_ID = 'layers';
export const OC_EXT = 'optionalContent';

export interface LayerNode {
  key: string;
  /** Group id (pdf.js ref string) — null for a label-only heading. */
  id: string | null;
  name: string;
  children: LayerNode[];
}

export interface LayerInfo {
  tree: LayerNode[];
  /** Initial (document) visibility of every group. */
  initial: Record<string, boolean>;
  /** Radio-button groups: turning one on turns the others off. */
  rb: Record<string, string[][]>;
  count: number;
}

type OcConfig = Awaited<ReturnType<PDFDocumentProxy['getOptionalContentConfig']>>;
type OrderEntry = string | { name: string | null; order: OrderEntry[] };

const cache = new WeakMap<PDFDocumentProxy, Promise<LayerInfo | null>>();

function build(cfg: OcConfig): LayerInfo | null {
  const order = cfg.getOrder() as OrderEntry[] | null;
  if (!order) return null;
  const initial: Record<string, boolean> = {};
  const rb: Record<string, string[][]> = {};
  for (const [id, g] of cfg as unknown as Iterable<[string, { visible: boolean; rbGroups?: string[][] }]>) {
    initial[id] = !!g.visible;
    if (g.rbGroups?.length) rb[id] = g.rbGroups;
  }
  let seq = 0;
  const walk = (entries: OrderEntry[], depth: number): LayerNode[] => {
    const out: LayerNode[] = [];
    if (depth > 16) return out;
    for (const e of entries) {
      if (typeof e === 'string') {
        const g = cfg.getGroup(e) as { name?: string } | null;
        if (!g) continue;
        out.push({ key: `g${seq++}:${e}`, id: e, name: g.name?.trim() || 'Untitled layer', children: [] });
      } else if (e && typeof e === 'object') {
        const kids = walk(e.order ?? [], depth + 1);
        // pdf.js reports groups it couldn't place in /Order (e.g. nested under another group) as an
        // unnamed trailing list: show them at this level so every layer stays reachable.
        if (e.name == null) out.push(...kids);
        else out.push({ key: `l${seq++}`, id: null, name: e.name || 'Untitled', children: kids });
      }
    }
    return out;
  };
  const tree = walk(order, 0);
  const count = Object.keys(initial).length;
  return count ? { tree, initial, rb, count } : null;
}

export function layerInfo(pdf: PDFDocumentProxy): Promise<LayerInfo | null> {
  let job = cache.get(pdf);
  if (!job) {
    job = pdf.getOptionalContentConfig().then(build).catch(() => null);
    cache.set(pdf, job);
  }
  return job;
}

export function effectiveVisibility(docId: DocId, info: LayerInfo): Record<string, boolean> {
  const cur = getDoc(docId)?.ext[OC_EXT] as Record<string, boolean> | undefined;
  return { ...info.initial, ...(cur ?? {}) };
}

export function setLayerVisible(docId: DocId, info: LayerInfo, id: string, visible: boolean) {
  const next = effectiveVisibility(docId, info);
  if (visible) for (const group of info.rb[id] ?? []) for (const other of group) if (other !== id) next[other] = false;
  next[id] = visible;
  commit(docId, info, next);
}

function commit(docId: DocId, info: LayerInfo, next: Record<string, boolean>) {
  const same = Object.keys(info.initial).every((k) => next[k] === info.initial[k]);
  actions.setExt(docId, OC_EXT, same ? null : next);
}

export function setAllLayers(docId: DocId, info: LayerInfo, visible: boolean | null) {
  if (visible == null) {
    actions.setExt(docId, OC_EXT, null);
    return;
  }
  const next: Record<string, boolean> = {};
  for (const k of Object.keys(info.initial)) next[k] = visible;
  commit(docId, info, next);
}

// ── dynamic registration ────────────────────────────────────────────────────

let panelDef: PanelDef | null = null;
function setPanelRegistered(on: boolean) {
  if (!panelDef) return;
  const has = !!useRegistry.getState().panels[LAYERS_PANEL_ID];
  if (on && !has) registerPanel(panelDef);
  if (!on && has) {
    useRegistry.setState((s) => {
      const panels = { ...s.panels };
      delete panels[LAYERS_PANEL_ID];
      return { panels };
    });
    if (useApp.getState().rightPanelId === LAYERS_PANEL_ID) actions.setRightPanel(null);
  }
}

/** Resolves true when the document has layers (and makes sure the panel is registered). */
export async function ensureLayersPanel(docId: DocId): Promise<boolean> {
  try {
    const info = await layerInfo(await engine.awaitPdf(docId));
    if (useApp.getState().activeDocId === docId) setPanelRegistered(!!info);
    return !!info;
  } catch {
    return false;
  }
}

let started = false;
export function startLayers(def: PanelDef) {
  panelDef = def;
  if (started) return;
  started = true;
  let lastPdf: PDFDocumentProxy | null = null;
  const check = () => {
    const s = useApp.getState();
    const doc = s.activeDocId ? s.docs[s.activeDocId] : undefined;
    const pdf = doc?.pdf ?? null;
    if (!doc) {
      lastPdf = null;
      setPanelRegistered(false);
      return;
    }
    if (!pdf || pdf === lastPdf) return;
    lastPdf = pdf;
    const id = doc.id;
    void layerInfo(pdf).then((info) => {
      if (useApp.getState().activeDocId !== id) return;
      setPanelRegistered(!!info);
    });
  };
  useApp.subscribe((s, p) => {
    if (s.activeDocId !== p.activeDocId || s.docs !== p.docs) check();
  });
  check();
}

// ── panel ───────────────────────────────────────────────────────────────────

interface FlatRow {
  node: LayerNode;
  depth: number;
  parentKey: string | null;
}

function flatten(nodes: LayerNode[], collapsed: Set<string>, depth = 0, parentKey: string | null = null, out: FlatRow[] = []): FlatRow[] {
  for (const n of nodes) {
    out.push({ node: n, depth, parentKey });
    if (n.children.length && !collapsed.has(n.key)) flatten(n.children, collapsed, depth + 1, n.key, out);
  }
  return out;
}

export function LayersPanel({ docId }: { docId: DocId }) {
  const pdf = useDoc(docId, (d) => d?.pdf ?? null);
  const overrides = useDoc(docId, (d) => d?.ext[OC_EXT] as Record<string, boolean> | null | undefined);
  const [state, setState] = useState<{ pdf: PDFDocumentProxy | null; info: LayerInfo | null; error: string | null } | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const treeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pdf) return;
    let live = true;
    layerInfo(pdf).then(
      (info) => live && setState({ pdf, info, error: null }),
      (e) => live && setState({ pdf, info: null, error: errMsg(e) }),
    );
    return () => {
      live = false;
    };
  }, [pdf]);

  const info = state?.info ?? null;
  const rows = useMemo(() => (info ? flatten(info.tree, collapsed) : []), [info, collapsed]);
  const vis = useMemo(() => (info ? { ...info.initial, ...(overrides ?? {}) } : {}), [info, overrides]);
  const modified = !!overrides;

  if (!state || (pdf && state.pdf !== pdf && !state.info)) {
    return (
      <div className="navigation-layers navigation-panel-loading" data-testid="navigation-layers-panel">
        <Spinner size={18} label="Loading layers" />
      </div>
    );
  }
  if (!info) {
    return (
      <div className="navigation-layers" data-testid="navigation-layers-panel">
        <EmptyState compact icon={Layers} title="No layers" description={state.error ? `Couldn’t read the layers: ${state.error}` : 'This document doesn’t have any layers.'} />
      </div>
    );
  }

  const isOn = (n: LayerNode): boolean => (n.id ? vis[n.id] !== false : n.children.some(isOn));
  const toggle = (n: LayerNode) => {
    if (n.id) setLayerVisible(docId, info, n.id, !isOn(n));
    else {
      // A label row toggles all its groups.
      const ids: string[] = [];
      const walk = (l: LayerNode[]) => l.forEach((c) => (c.id && ids.push(c.id), walk(c.children)));
      walk(n.children);
      const on = !isOn(n);
      const next = effectiveVisibility(docId, info);
      for (const id of ids) next[id] = on;
      commit(docId, info, next);
    }
  };
  const setCollapsedKey = (key: string, c: boolean) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (c) next.add(key);
      else next.delete(key);
      return next;
    });
  const focusRow = (key: string) => {
    setFocusKey(key);
    const el = () => treeRef.current?.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`);
    // Move focus right away when the row is rendered (so the next key press acts on it).
    const now = el();
    if (now) now.focus();
    else requestAnimationFrame(() => el()?.focus());
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // The focused row itself (focusKey can lag behind fast key sequences).
    const targetKey = e.target instanceof HTMLElement ? e.target.closest<HTMLElement>('[data-key]')?.dataset.key : undefined;
    const i = Math.max(0, rows.findIndex((r) => r.node.key === (targetKey ?? focusKey)));
    const r = rows[i];
    if (!r) return;
    let handled = true;
    if (e.key === 'ArrowDown') focusRow(rows[Math.min(rows.length - 1, i + 1)].node.key);
    else if (e.key === 'ArrowUp') focusRow(rows[Math.max(0, i - 1)].node.key);
    else if (e.key === 'Home') focusRow(rows[0].node.key);
    else if (e.key === 'End') focusRow(rows[rows.length - 1].node.key);
    else if (e.key === 'ArrowRight') {
      if (r.node.children.length && collapsed.has(r.node.key)) setCollapsedKey(r.node.key, false);
      else if (r.node.children.length) focusRow(r.node.children[0].key);
    } else if (e.key === 'ArrowLeft') {
      if (r.node.children.length && !collapsed.has(r.node.key)) setCollapsedKey(r.node.key, true);
      else if (r.parentKey) focusRow(r.parentKey);
    } else if (e.key === ' ' || e.key === 'Enter') toggle(r.node);
    else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  return (
    <div className="navigation-layers" data-testid="navigation-layers-panel">
      <div className="navigation-toolbar" role="toolbar" aria-label="Layer tools">
        <span className="navigation-toolbar-title">{info.count === 1 ? '1 layer' : `${info.count} layers`}</span>
        <span className="navigation-toolbar-spacer" />
        <IconButton icon={RotateCcw} label="Reset to initial visibility" disabled={!modified} onClick={() => setAllLayers(docId, info, null)} data-testid="navigation-layers-reset" />
        <Dropdown
          label="Layer options"
          align="end"
          trigger={<IconButton icon={Ellipsis} label="Options" data-testid="navigation-layers-options" />}
          items={[
            { id: 'navigation.layers.showAll', label: 'Show all layers', icon: Eye, run: () => setAllLayers(docId, info, true) },
            { id: 'navigation.layers.hideAll', label: 'Hide all layers', icon: EyeOff, run: () => setAllLayers(docId, info, false) },
            'divider',
            { id: 'navigation.layers.reset', label: 'Reset to initial visibility', icon: RotateCcw, disabled: !modified, run: () => setAllLayers(docId, info, null) },
          ]}
        />
      </div>
      <div ref={treeRef} className="navigation-layer-tree" role="tree" aria-label="Layers" data-testid="navigation-layer-tree" onKeyDown={onKeyDown}>
        {rows.map((r, i) => {
          const n = r.node;
          const on = isOn(n);
          const hasKids = n.children.length > 0;
          const open = hasKids && !collapsed.has(n.key);
          const focusable = focusKey ? focusKey === n.key : i === 0;
          return (
            <div
              key={n.key}
              role="treeitem"
              aria-level={r.depth + 1}
              aria-expanded={hasKids ? open : undefined}
              aria-selected={focusKey === n.key}
              aria-checked={on}
              tabIndex={focusable ? 0 : -1}
              data-key={n.key}
              data-layer={n.name}
              data-visible={on ? 'true' : 'false'}
              data-testid="navigation-layer"
              className={`navigation-layer-row${on ? '' : ' is-hidden'}${n.id ? '' : ' is-label'}`}
              style={{ paddingLeft: 6 + r.depth * 16 }}
              onFocus={() => setFocusKey(n.key)}
              onClick={() => setFocusKey(n.key)}
            >
              {hasKids ? (
                <button
                  type="button"
                  tabIndex={-1}
                  className="navigation-tree-twisty"
                  aria-label={open ? 'Collapse' : 'Expand'}
                  onClick={(e) => {
                    e.stopPropagation();
                    setCollapsedKey(n.key, open);
                  }}
                  data-testid="navigation-layer-expand"
                >
                  {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>
              ) : (
                <span className="navigation-tree-twisty" aria-hidden="true" />
              )}
              <button
                type="button"
                tabIndex={-1}
                className="navigation-layer-eye"
                aria-label={`${on ? 'Hide' : 'Show'} ${n.name}`}
                aria-pressed={on}
                title={on ? 'Hide layer' : 'Show layer'}
                onClick={(e) => {
                  e.stopPropagation();
                  setFocusKey(n.key);
                  toggle(n);
                }}
                data-testid="navigation-layer-toggle"
              >
                {on ? <Eye size={15} /> : <EyeOff size={15} />}
              </button>
              <span className="navigation-layer-name" title={n.name}>
                {n.name}
              </span>
            </div>
          );
        })}
      </div>
      <p className="navigation-panel-foot">Layer visibility affects this view only; the PDF isn’t changed.</p>
    </div>
  );
}
