/** Built-in stamp sets (Standard business, Dynamic, Sign here) modelled after the usual desktop sets. */
import type { StampData, StampSet, StampShape } from '../model';

export type StampTone = 'green' | 'red' | 'blue';

export interface CatalogStamp {
  set: Exclude<StampSet, 'custom' | 'imported'>;
  id: string;
  /** PDF /Name (standard names where the spec defines one). */
  name: string;
  label: string;
  tone: StampTone;
  shape: StampShape;
}

export const TONES: Record<StampTone, string> = {
  green: '#1a7f37',
  red: '#c62828',
  blue: '#1d4f9e',
};

const std = (id: string, name: string, label: string, tone: StampTone): CatalogStamp => ({ set: 'standard', id, name, label, tone, shape: 'box' });
const dyn = (id: string, name: string, label: string, tone: StampTone): CatalogStamp => ({ set: 'dynamic', id, name, label, tone, shape: 'box' });
const sign = (id: string, name: string, label: string, tone: StampTone, shape: StampShape): CatalogStamp => ({ set: 'sign', id, name, label, tone, shape });

export const STANDARD: CatalogStamp[] = [
  std('approved', 'Approved', 'APPROVED', 'green'),
  std('not-approved', 'NotApproved', 'NOT APPROVED', 'red'),
  std('draft', 'Draft', 'DRAFT', 'blue'),
  std('final', 'Final', 'FINAL', 'green'),
  std('completed', 'SBCompleted', 'COMPLETED', 'green'),
  std('confidential', 'Confidential', 'CONFIDENTIAL', 'red'),
  std('for-public-release', 'ForPublicRelease', 'FOR PUBLIC RELEASE', 'green'),
  std('not-for-public-release', 'NotForPublicRelease', 'NOT FOR PUBLIC RELEASE', 'red'),
  std('for-comment', 'ForComment', 'FOR COMMENT', 'blue'),
  std('void', 'SBVoid', 'VOID', 'red'),
  std('preliminary-results', 'SBPreliminaryResults', 'PRELIMINARY RESULTS', 'blue'),
  std('information-only', 'SBInformationOnly', 'INFORMATION ONLY', 'blue'),
];

export const DYNAMIC: CatalogStamp[] = [
  dyn('approved', 'DApproved', 'APPROVED', 'green'),
  dyn('reviewed', 'DReviewed', 'REVIEWED', 'blue'),
  dyn('received', 'DReceived', 'RECEIVED', 'blue'),
  dyn('revised', 'DRevised', 'REVISED', 'blue'),
  dyn('confidential', 'DConfidential', 'CONFIDENTIAL', 'red'),
];

export const SIGN_HERE: CatalogStamp[] = [
  sign('sign-here', 'SHSignHere', 'SIGN HERE', 'red', 'arrow'),
  sign('witness', 'SHWitness', 'WITNESS', 'red', 'arrow'),
  sign('initial-here', 'SHInitialHere', 'INITIAL HERE', 'red', 'arrow'),
  sign('accepted', 'SHAccepted', 'ACCEPTED', 'green', 'check'),
  sign('rejected', 'SHRejected', 'REJECTED', 'red', 'cross'),
];

export const CATALOG: CatalogStamp[] = [...STANDARD, ...DYNAMIC, ...SIGN_HERE];

export function findCatalog(set: string, id: string): CatalogStamp | undefined {
  return CATALOG.find((s) => s.set === set && s.id === id);
}
export function findByName(name: string | undefined): CatalogStamp | undefined {
  if (!name) return undefined;
  const n = name.replace(/^#/, '').toLowerCase();
  return CATALOG.find((s) => s.name.toLowerCase() === n) ?? CATALOG.find((s) => `sb${s.name}`.toLowerCase() === n);
}

/** Conventional dynamic stamp line: "By Jordan Lee at 3:04 PM, Sep 27, 2026". */
export function dynamicLine(user: string, when = new Date()): string {
  const time = when.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const date = when.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return `By ${user || 'Guest'} at ${time}, ${date}`;
}

/** Tone of stamp data (catalog stamps; imported/custom default to blue). */
export function toneOf(d: Pick<StampData, 'set' | 'id'>): StampTone {
  return findCatalog(d.set, d.id)?.tone ?? 'blue';
}

export const SET_LABELS: Record<StampSet, string> = {
  standard: 'Standard business',
  dynamic: 'Dynamic',
  sign: 'Sign here',
  custom: 'Custom',
  imported: 'Stamp',
};
