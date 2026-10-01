/**
 * Run a split: build every part (bookmarks, links, labels, comments and form fields of the
 * part's pages are kept), then download them as one ZIP, save them to the library or open them
 * as tabs.
 */
import type { DocId } from '@/core/types';
import * as engine from '@/core/engine';
import { library } from '@/core/library';
import { actions, getDoc, useApp } from '@/core/store';
import { downloadBlob } from '@/core/util';
import { buildParts, type BuiltPart } from '../splitter';
import { zipFiles } from '../zip';
import { plural } from '../ranges';
import type { SplitOutput } from '../store';
import { errMsg, runBusy, stem } from '../util';
import { TASK_SPLIT } from '../tasks';

/** More tabs than this would be unwieldy; the tabs output is disabled beyond it. */
export const MAX_TABS = 20;


export async function runSplit(docId: DocId, groups: number[][], names: string[], output: SplitOutput): Promise<boolean> {
  const doc = getDoc(docId);
  if (!doc || groups.length === 0) return false;
  const files = plural(groups.length, 'file', 'files');
  const parts = await runBusy(`Splitting into ${files}…`, (report) =>
    buildParts(docId, groups, { names, report: (done, total) => report(done / total, `Splitting into ${files}… (${done} of ${total})`) }),
  );
  if (!parts) return false;

  switch (output) {
    case 'zip': {
      const zip = await runBusy('Creating ZIP archive…', () => zipFiles(parts));
      if (!zip) return false;
      const zipName = `${stem(doc.name)}_Split.zip`;
      downloadBlob(zip, zipName, 'application/zip');
      actions.toast(`Split “${doc.name}” into ${files}. Downloaded ${zipName}.`, { kind: 'success' });
      return true;
    }
    case 'library':
      return saveToLibrary(doc.name, parts);
    case 'tabs': {
      // Show the new tabs in the viewer, not the split tool of the source.
      if (useApp.getState().activeTaskId === TASK_SPLIT) actions.openTask(null);
      let opened = 0;
      for (const p of parts) {
        try {
          if (await engine.newDocumentFromBytes(p.name, p.bytes)) opened++;
        } catch (e) {
          actions.toast(`Couldn't open ${p.name}: ${errMsg(e)}`, { kind: 'error' });
        }
      }
      if (opened) actions.toast(`Split “${doc.name}” into ${plural(opened, 'file', 'files')}, opened as tabs.`, { kind: 'success' });
      return opened > 0;
    }
  }
}

async function saveToLibrary(docName: string, parts: BuiltPart[]): Promise<boolean> {
  const saved = await runBusy(`Saving ${plural(parts.length, 'file', 'files')} to your files…`, async (report) => {
    let n = 0;
    for (const p of parts) {
      await library.createFile(p.name, p.bytes);
      n++;
      report(n / parts.length);
    }
    return n;
  });
  if (!saved) return false;
  actions.toast(`Split “${docName}” into ${plural(saved, 'file', 'files')}, saved to your files.`, {
    kind: 'success',
    action: { label: 'View files', run: () => actions.setRoute('home') },
  });
  return true;
}
