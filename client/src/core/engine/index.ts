/**
 * ENGINE public API. See docs/ARCHITECTURE.md → Engine.
 *
 *   setup/sync  pdfjs.ts, sync.ts        opening   open.ts, images.ts, PasswordPrompt.tsx
 *   page ops    pageops.ts               export    export.ts, hooks.ts, forms.ts, fonts.ts, pdfcrypt.ts
 *   text        text.ts                  render    render.ts
 *   helpers     lib.ts (pdf-lib), state.ts (engine-private per-document state & queue)
 */
import { registerExportHook, registerFileHandler, useRegistry } from '../registry';
import { configurePdfjs } from './pdfjs';
import { imageFileHandler } from './images';
import { builtinExportHooks } from './hooks';
import * as self from './index';

export type { PageText, PageTextItem } from './text';
export type { RenderOptions } from './render';
export type { PasswordProvider } from './state';

// setup / sync
let initialized = false;
/** Configure pdf.js (worker, cmaps, fonts, wasm) and register the built-in file handler and export hooks. */
export function initPdfjs(): void {
  configurePdfjs();
  if (initialized) return;
  initialized = true;
  const reg = useRegistry.getState();
  if (!reg.fileHandlers.some((h) => h.id === imageFileHandler.id)) registerFileHandler(imageFileHandler);
  for (const hook of builtinExportHooks) if (!reg.exportHooks.some((h) => h.id === hook.id)) registerExportHook(hook);
  if (import.meta.env.DEV && typeof window !== 'undefined') {
    (window as unknown as Record<string, unknown>).__engine = self;
  }
}
export { startEngineSync, awaitPdf, reconcileSoon } from './sync';
export { setPasswordProvider, isReadOnly, markPristine, getFileBytes } from './state';
export { loadPdfjs } from './pdfjs';
export { loadLib } from './lib';

// opening
export { openFiles, openBytes, openFromLibrary, readPages, readMeta, readOutline, newDocumentFromBytes, hasPdfHeader } from './open';
export { imagesToPdf, imageFileHandler } from './images';
export { passwordPrompt } from './PasswordPrompt';

// page operations
export {
  withLib, replaceBytes, rotatePages, deletePages, movePages, movePagesTo, insertBlankPages, insertPdfBytes, insertFiles,
  duplicatePages, replacePages, cropPages, extractPagesToBytes,
} from './pageops';

// export
export {
  exportPdf, bakeObjects, downloadDoc, saveDoc, saveDocAs, printDoc, exportableObjects, preparePage,
  flattenExistingAnnotations, ensurePdfExtension,
  patchFontkitSubset, // [integration] for fonts embedded outside ExportContext.customFont (which already applies it)
} from './export';
export { commitFormValues } from './forms';
export { builtinExportHooks, needsEncryption, OUTLINE_HOOK_ID, METADATA_HOOK_ID, ENCRYPTION_HOOK_ID } from './hooks';
export { fontForText, unicodeFont, canEncode, encodableText, UNICODE_FONT_URL, UNICODE_FONT_URLS } from './fonts';

// text & rendering
export { getPageText, rangeRects } from './text';
export { renderPageToCanvas, getThumbnail } from './render';
