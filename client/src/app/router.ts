/**
 * Hash routing, kept in sync with the store both ways.
 *
 *   #/                 Home
 *   #/tools            All tools
 *   #/file/<fileId>    Library file (opened, or re-used if already open)
 *   #/doc/<docId>      Local (unsaved) document tab — only meaningful within the session
 *   #/task/<taskId>    Standalone task (no document)
 *   #/<prefix>/<arg>   Feature route (registerRouteHandler, e.g. #/sign/<token>)
 */
import { reg } from '@/core/registry';
import { actions, getDoc, useApp, type AppState } from '@/core/store';
import type { DocState } from '@/core/types';
import { openLibraryFile } from './docActions';

export type HashRoute =
  | { name: 'home' }
  | { name: 'tools' }
  | { name: 'file'; id: string }
  | { name: 'doc'; id: string }
  | { name: 'task'; id: string }
  | { name: 'feature'; prefix: string; arg: string };

export function parseHash(hash: string): HashRoute {
  const h = hash.replace(/^#\/?/, '');
  const [head, ...rest] = h.split('/');
  const arg = rest.length ? decodeURIComponent(rest.join('/')) : '';
  switch (head) {
    case 'tools':
      return { name: 'tools' };
    case 'file':
      return arg ? { name: 'file', id: arg } : { name: 'home' };
    case 'doc':
      return arg ? { name: 'doc', id: arg } : { name: 'home' };
    case 'task':
      return arg ? { name: 'task', id: arg } : { name: 'tools' };
    default:
      return head && reg.route(head) ? { name: 'feature', prefix: head, arg } : { name: 'home' };
  }
}

/** Hash that represents the current store state. */
export function hashFor(s: Pick<AppState, 'route' | 'activeDocId' | 'activeTaskId' | 'docs'>): string {
  switch (s.route) {
    case 'tools':
      return '#/tools';
    case 'task':
      return s.activeTaskId ? `#/task/${encodeURIComponent(s.activeTaskId)}` : '#/tools';
    case 'document': {
      const d = s.activeDocId ? s.docs[s.activeDocId] : undefined;
      if (!d) return '#/';
      const featureHash = featureDocHash(d);
      if (featureHash) return featureHash;
      if (d.fileId) return `#/file/${encodeURIComponent(d.fileId)}`;
      return `#/doc/${encodeURIComponent(d.id)}`;
    }
    default:
      return '#/';
  }
}

function featureDocHash(d: DocState): string | null {
  for (const h of reg.get().routeHandlers) {
    try {
      const hash = h.docHash?.(d);
      if (hash) return hash;
    } catch (e) {
      console.warn(`[router] docHash of "${h.prefix}" failed`, e);
    }
  }
  return null;
}

const normalize = (h: string) => (h === '' || h === '#' ? '#/' : h);

let applying = 0;
let lastKey = '';

/** Apply a hash to the store (opening files / shares as needed). */
export async function applyHash(hash: string): Promise<void> {
  const r = parseHash(hash);
  const s = useApp.getState();
  applying++;
  try {
    switch (r.name) {
      case 'home':
        actions.setRoute('home');
        break;
      case 'tools':
        actions.setRoute('tools');
        break;
      case 'doc':
        if (getDoc(r.id)) actions.setActiveDoc(r.id);
        else actions.setRoute(s.activeDocId && s.route === 'document' ? 'document' : 'home');
        break;
      case 'file': {
        const id = await openLibraryFile(r.id);
        if (!id && useApp.getState().route === 'document' && !useApp.getState().activeDocId) actions.setRoute('home');
        break;
      }
      case 'task': {
        const task = reg.task(r.id);
        if (!task) {
          actions.setRoute('tools');
          break;
        }
        if (task.requiresDocument && !s.activeDocId) {
          actions.setRoute('tools');
          break;
        }
        actions.openTask(r.id);
        if (!task.requiresDocument && !useApp.getState().activeDocId) actions.setRoute('task');
        break;
      }
      case 'feature':
        try {
          await reg.route(r.prefix)?.open(r.arg);
        } catch (e) {
          console.warn(`[router] route "${r.prefix}" failed`, e);
          actions.setRoute('home');
        }
        break;
    }
  } finally {
    applying--;
  }
  syncHash(true);
}

function stateKey(s: AppState) {
  const d = s.activeDocId ? s.docs[s.activeDocId] : undefined;
  return `${s.route}|${s.activeDocId}|${d?.fileId ?? ''}|${d ? featureDocHash(d) ?? '' : ''}|${s.activeTaskId ?? ''}`;
}

/** Write the store state into the URL (pushState for navigation, replaceState for in-place updates). */
function syncHash(replace = false) {
  if (applying > 0) return;
  const s = useApp.getState();
  const next = hashFor(s);
  if (normalize(location.hash) === next) return;
  const url = `${location.pathname}${location.search}${next}`;
  if (replace) history.replaceState(history.state, '', url);
  else history.pushState(history.state, '', url);
}

let installed = false;

/** Installs the listeners and applies the current URL. Call once after the first render. */
export function installRouter(): () => void {
  if (installed) return () => {};
  installed = true;

  let prevDocId = useApp.getState().activeDocId;
  lastKey = stateKey(useApp.getState());
  const unsub = useApp.subscribe((s) => {
    const key = stateKey(s);
    if (key === lastKey) return;
    lastKey = key;
    // Same document, only its file id / share token changed (e.g. first save) → replace.
    const sameDoc = s.route === 'document' && s.activeDocId === prevDocId;
    prevDocId = s.activeDocId;
    syncHash(sameDoc && normalize(location.hash).startsWith('#/doc/'));
  });

  let lastApplied = normalize(location.hash);
  const onNav = () => {
    const h = normalize(location.hash);
    if (h === lastApplied && h === hashFor(useApp.getState())) return;
    lastApplied = h;
    void applyHash(h);
  };
  window.addEventListener('hashchange', onNav);
  window.addEventListener('popstate', onNav);

  void applyHash(location.hash).then(() => {
    lastApplied = normalize(location.hash);
  });

  return () => {
    installed = false;
    unsub();
    window.removeEventListener('hashchange', onNav);
    window.removeEventListener('popstate', onNav);
  };
}
