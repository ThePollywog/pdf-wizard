/**
 * Extract pages into new PDFs (one file, or one file per page), then open them as tabs or
 * download them (a single PDF, or a ZIP for several files). Optionally deletes the extracted
 * pages from the source afterwards (one undo step).
 */
import type { DocId } from '@/core/types';
import * as engine from '@/core/engine';
import { actions, getDoc } from '@/core/store';
import { downloadBlob } from '@/core/util';
import { buildParts } from '../splitter';
import { zipFiles } from '../zip';
import { plural } from '../ranges';
import { organize, type ExtractOutput } from '../store';
import { attempt, runBusy, stem } from '../util';
import { closeOrganizeTask } from '../tasks';

/** Separate files beyond this count are downloaded as a ZIP rather than opened as tabs. */
export const MAX_EXTRACT_TABS = 20;

export interface ExtractJob {
  indices: number[];
  deleteAfter: boolean;
  separate: boolean;
  output: ExtractOutput;
}

export function extractNames(docName: string, indices: number[], separate: boolean): string[] {
  const s = stem(docName);
  return separate ? indices.map((i) => `${s}_Page${i + 1}.pdf`) : [`Pages from ${s}.pdf`];
}

export async function runExtract(docId: DocId, job: ExtractJob): Promise<boolean> {
  const doc = getDoc(docId);
  if (!doc || !job.indices.length) return false;
  const indices = [...job.indices].sort((a, b) => a - b);
  const separate = job.separate && indices.length > 1;
  const groups = separate ? indices.map((i) => [i]) : [indices];
  const names = extractNames(doc.name, indices, separate);
  const parts = await runBusy(separate ? `Extracting ${indices.length} files…` : 'Extracting pages…', (report) =>
    buildParts(docId, groups, { names, report: (done, total) => report(done / total) }),
  );
  if (!parts) return false;

  // Opening dozens of tabs is unwieldy: many separate files are downloaded as a ZIP instead.
  const output: ExtractOutput = job.output === 'open' && parts.length > MAX_EXTRACT_TABS ? 'download' : job.output;
  if (output !== job.output) actions.toast(`${parts.length} files are too many to open as tabs, so they were downloaded as a ZIP archive.`, { kind: 'info' });

  if (output === 'download') {
    if (parts.length === 1) downloadBlob(parts[0].bytes, parts[0].name);
    else {
      const zip = await runBusy('Creating ZIP archive…', () => zipFiles(parts));
      if (!zip) return false;
      downloadBlob(zip, `${stem(doc.name)}_Pages.zip`, 'application/zip');
    }
  }

  let deleted = false;
  if (job.deleteAfter && indices.length < doc.pages.length && !engine.isReadOnly(docId)) {
    deleted = await attempt(() => engine.deletePages(docId, indices));
    if (deleted) organize.clear(docId);
  }

  if (output === 'open') {
    // The new tabs should show the viewer, not the organize tool of the source.
    closeOrganizeTask();
    for (const p of parts) {
      try {
        await engine.newDocumentFromBytes(p.name, p.bytes);
      } catch (e) {
        actions.toast(`Couldn't open “${p.name}”: ${e instanceof Error ? e.message : String(e)}`, { kind: 'error' });
      }
    }
  }

  const what = separate ? plural(parts.length, 'file', 'files') : plural(indices.length, 'page', 'pages');
  const verb = output === 'download' ? 'downloaded' : 'opened';
  actions.toast(
    separate ? `Extracted ${what} (${verb})${deleted ? ' and deleted the pages' : ''}` : `Extracted ${what} (${verb})${deleted ? ' and deleted them from the document' : ''}`,
    { kind: 'success' },
  );
  return true;
}
