/** Applies prefs.theme ('light' | 'dark' | 'system') to <html data-theme>. */
import { useSyncExternalStore } from 'react';
import { useApp } from '@/core/store';

const mq = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
const listeners = new Set<() => void>();
let current: 'light' | 'dark' = 'light';

export function resolveTheme(pref: 'light' | 'dark' | 'system'): 'light' | 'dark' {
  if (pref === 'system') return mq?.matches ? 'dark' : 'light';
  return pref;
}

function apply() {
  const t = resolveTheme(useApp.getState().prefs.theme);
  const root = document.documentElement;
  root.dataset.theme = t;
  root.style.colorScheme = t;
  try {
    localStorage.setItem('pdfwizard.themeResolved', t);
  } catch {
    /* ignore */
  }
  if (t !== current) {
    current = t;
    listeners.forEach((l) => l());
  }
}

let installed = false;
/** Call once at startup. */
export function initTheme() {
  if (installed) return;
  installed = true;
  apply();
  useApp.subscribe((s) => s.prefs.theme, apply);
  mq?.addEventListener('change', apply);
}

/** The effective theme (after resolving 'system'). */
export function useResolvedTheme(): 'light' | 'dark' {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
