/**
 * Bootstrap: theme → engine → core commands/shortcuts → features (isolated) → React → router.
 */
import './styles/index.css';
import { createRoot } from 'react-dom/client';
import * as engine from '@/core/engine';
import { loadFeatures } from '@/core/registry';
import { App } from './app/App';
import { registerCoreCommands, registerCoreTools } from './app/commands';
import { askPassword } from './app/dialogs/PasswordDialog';
import { installRouter } from './app/router';
import { installShortcuts } from './app/shortcuts';
import { initTheme } from './app/theme';

function safely(label: string, fn: () => void) {
  try {
    fn();
  } catch (e) {
    console.error(`[shell] ${label} failed:`, e);
  }
}

function removeSplash() {
  const splash = document.getElementById('splash');
  if (!splash) return;
  splash.classList.add('is-done');
  window.setTimeout(() => splash.remove(), 250);
}

async function bootstrap() {
  initTheme();
  safely('engine init', () => engine.initPdfjs());
  safely('engine sync', () => void engine.startEngineSync());
  safely('password provider', () => engine.setPasswordProvider(askPassword));

  registerCoreCommands();
  installShortcuts();

  try {
    await loadFeatures();
  } catch (e) {
    console.error('[shell] loading features failed:', e);
  }
  // Features may provide their own select / hand tools; fill in the built-ins otherwise.
  registerCoreTools();

  const root = document.getElementById('root');
  if (!root) throw new Error('#root element missing');
  createRoot(root).render(<App />);
  installRouter();
  requestAnimationFrame(removeSplash);

  if (import.meta.env.DEV) {
    const w = window as unknown as Record<string, unknown>;
    w.__engine ??= engine;
  }
}

void bootstrap().catch((e) => {
  console.error('[shell] bootstrap failed:', e);
  const splash = document.getElementById('splash');
  if (splash) {
    splash.classList.add('is-error');
    const msg = splash.querySelector('.splash-text');
    if (msg) msg.textContent = 'PDF Wizard could not start. Reload the page to try again.';
  }
});
