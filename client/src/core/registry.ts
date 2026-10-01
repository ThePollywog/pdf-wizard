/**
 * Plugin registry. Features live in `client/src/features/<name>/index.ts(x)` and call the
 * register* functions at module top level. The shell loads every feature module lazily and
 * in isolation (a feature that throws while loading is skipped and reported in the console),
 * so a broken feature never takes the whole app down.
 *
 * The registry is a zustand store, so React components re-render when features register.
 */
import { create } from 'zustand';
import type {
  CommandDef, ContextMenuContribution, ExportHook, FileHandler, HomeSection, ImportHook,
  ObjectTypeDef, PageLayerDef, PanelDef, PdfObject, RouteHandler, TaskDef, TextSelectionAction, ToolDef,
  ViewerOverlayDef,
} from './types';

export interface RegistryState {
  tools: Record<string, ToolDef>;
  objectTypes: Record<string, ObjectTypeDef<any>>;
  tasks: Record<string, TaskDef>;
  panels: Record<string, PanelDef>;
  commands: Record<string, CommandDef>;
  importHooks: ImportHook[];
  exportHooks: ExportHook[];
  textSelectionActions: TextSelectionAction[];
  contextMenus: ContextMenuContribution[];
  fileHandlers: FileHandler[];
  homeSections: HomeSection[];
  routeHandlers: RouteHandler[];
  pageLayers: PageLayerDef[];
  viewerOverlays: ViewerOverlayDef[];
  /** Feature ids that loaded / failed. */
  loaded: string[];
  failed: { id: string; error: string }[];
  ready: boolean;
}

export const useRegistry = create<RegistryState>(() => ({
  tools: {},
  objectTypes: {},
  tasks: {},
  panels: {},
  commands: {},
  importHooks: [],
  exportHooks: [],
  textSelectionActions: [],
  contextMenus: [],
  fileHandlers: [],
  homeSections: [],
  routeHandlers: [],
  pageLayers: [],
  viewerOverlays: [],
  loaded: [],
  failed: [],
  ready: false,
}));

const set = useRegistry.setState;
const byOrder = <T extends { order?: number }>(a: T, b: T) => (a.order ?? 0) - (b.order ?? 0);
function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  return [...list.filter((x) => x.id !== item.id), item];
}

export function registerTool(def: ToolDef) {
  set((s) => ({ tools: { ...s.tools, [def.id]: def } }));
}
export function registerObjectType<T extends PdfObject>(def: ObjectTypeDef<T>) {
  set((s) => ({ objectTypes: { ...s.objectTypes, [def.kind]: def } }));
}
export function registerTask(def: TaskDef) {
  set((s) => ({ tasks: { ...s.tasks, [def.id]: def } }));
}
export function registerPanel(def: PanelDef) {
  set((s) => ({ panels: { ...s.panels, [def.id]: def } }));
}
export function registerCommand(def: CommandDef) {
  set((s) => ({ commands: { ...s.commands, [def.id]: def } }));
}
export function registerCommands(defs: CommandDef[]) {
  defs.forEach(registerCommand);
}
export function registerImportHook(hook: ImportHook) {
  set((s) => ({ importHooks: upsert(s.importHooks, hook).sort(byOrder) }));
}
export function registerExportHook(hook: ExportHook) {
  set((s) => ({ exportHooks: upsert(s.exportHooks, hook).sort(byOrder) }));
}
export function registerTextSelectionAction(action: TextSelectionAction) {
  set((s) => ({ textSelectionActions: upsert(s.textSelectionActions, action).sort(byOrder) }));
}
export function registerContextMenu(c: ContextMenuContribution) {
  set((s) => ({ contextMenus: upsert(s.contextMenus, c).sort(byOrder) }));
}
export function registerFileHandler(h: FileHandler) {
  set((s) => ({ fileHandlers: upsert(s.fileHandlers, h) }));
}
export function registerHomeSection(h: HomeSection) {
  set((s) => ({ homeSections: upsert(s.homeSections, h).sort(byOrder) }));
}
/** Always-on layer on every rendered page (see PageLayerDef). */
export function registerPageLayer(l: PageLayerDef) {
  set((s) => ({ pageLayers: upsert(s.pageLayers, l).sort(byOrder) }));
}
/** Overlay mounted once over each document viewer (see ViewerOverlayDef). */
export function registerViewerOverlay(o: ViewerOverlayDef) {
  set((s) => ({ viewerOverlays: upsert(s.viewerOverlays, o).sort(byOrder) }));
}
const CORE_ROUTE_PREFIXES = new Set(['', 'tools', 'file', 'share', 'doc', 'task']);
/** Feature hash route `#/<prefix>/<arg>` (see RouteHandler). */
export function registerRouteHandler(h: RouteHandler) {
  if (CORE_ROUTE_PREFIXES.has(h.prefix) || !/^[a-z][a-z0-9-]*$/.test(h.prefix)) {
    throw new Error(`[registry] invalid or reserved route prefix "${h.prefix}"`);
  }
  set((s) => ({ routeHandlers: [...s.routeHandlers.filter((x) => x.prefix !== h.prefix), h] }));
}

/** Non-reactive accessors (for use outside React). */
export const reg = {
  get: () => useRegistry.getState(),
  tool: (id: string) => useRegistry.getState().tools[id] as ToolDef | undefined,
  objectType: (kind: string) => useRegistry.getState().objectTypes[kind] as ObjectTypeDef | undefined,
  task: (id: string) => useRegistry.getState().tasks[id] as TaskDef | undefined,
  command: (id: string) => useRegistry.getState().commands[id] as CommandDef | undefined,
  route: (prefix: string) => useRegistry.getState().routeHandlers.find((h) => h.prefix === prefix),
};

/** Run a registered command by id (no-op with console warning if missing). */
export async function runCommand(id: string) {
  const c = reg.command(id);
  if (!c) {
    console.warn(`[registry] command not found: ${id}`);
    return;
  }
  if (c.enabled && !c.enabled()) return;
  await c.run();
}

// ─────────────────────────────────────────────────────────────────────────────
// Feature loading
// ─────────────────────────────────────────────────────────────────────────────

const featureModules = import.meta.glob('../features/*/index.{ts,tsx}');

/**
 * Loads all feature modules in isolation. Restrict with `?features=a,b` in the URL or
 * localStorage['pdfwizard.features'] = 'a,b' (useful while developing a single feature).
 */
export async function loadFeatures(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const filterRaw = params.get('features') ?? localStorage.getItem('pdfwizard.features') ?? '';
  const filter = filterRaw.split(',').map((s) => s.trim()).filter(Boolean);
  const entries = Object.entries(featureModules)
    .map(([path, load]) => ({ id: path.split('/')[2], load }))
    .filter((e) => filter.length === 0 || filter.includes(e.id))
    .sort((a, b) => a.id.localeCompare(b.id));

  const results = await Promise.allSettled(entries.map((e) => e.load()));
  const loaded: string[] = [];
  const failed: { id: string; error: string }[] = [];
  results.forEach((r, i) => {
    const id = entries[i].id;
    if (r.status === 'fulfilled') loaded.push(id);
    else {
      const error = r.reason instanceof Error ? `${r.reason.message}\n${r.reason.stack ?? ''}` : String(r.reason);
      failed.push({ id, error });
      console.error(`[features] failed to load "${id}":`, r.reason);
    }
  });
  set({ loaded, failed, ready: true });
}
