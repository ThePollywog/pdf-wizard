/**
 * the standard "Password Security – Settings" permission choices ↔ SecuritySettings.permissions
 * (the PDF /P bits written by the core encryption hook).
 */
import type { SecuritySettings } from '@/core/types';

export type Permissions = NonNullable<SecuritySettings['permissions']>;
export type PrintingChoice = 'none' | 'low' | 'high';
export type ChangesChoice = 'none' | 'pages' | 'forms' | 'comments' | 'any';

export const PRINTING_OPTIONS: { value: PrintingChoice; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'low', label: 'Low resolution (150 dpi)' },
  { value: 'high', label: 'High resolution' },
];

export const CHANGES_OPTIONS: { value: ChangesChoice; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'pages', label: 'Inserting, deleting and rotating pages' },
  { value: 'forms', label: 'Filling in form fields and signing existing signature fields' },
  { value: 'comments', label: 'Commenting, filling in form fields and signing existing signature fields' },
  { value: 'any', label: 'Any except extracting pages' },
];

export interface PermissionChoices {
  printing: PrintingChoice;
  changes: ChangesChoice;
  copying: boolean;
  screenReader: boolean;
}

export const DEFAULT_CHOICES: PermissionChoices = { printing: 'high', changes: 'none', copying: false, screenReader: true };

export function choicesToPermissions(c: PermissionChoices): Permissions {
  const base: Permissions = {
    printing: c.printing === 'none' ? false : c.printing === 'low' ? 'lowResolution' : 'highResolution',
    modifying: false,
    annotating: false,
    fillingForms: false,
    documentAssembly: false,
    copying: c.copying,
    contentAccessibility: c.screenReader || c.copying,
  };
  switch (c.changes) {
    case 'pages':
      base.documentAssembly = true;
      break;
    case 'forms':
      base.fillingForms = true;
      break;
    case 'comments':
      base.fillingForms = true;
      base.annotating = true;
      break;
    case 'any':
      base.modifying = true;
      base.annotating = true;
      base.fillingForms = true;
      base.documentAssembly = true;
      break;
    default:
      break;
  }
  return base;
}

/** Best matching dialog choices for existing permissions (unset = allowed). */
export function permissionsToChoices(p: Permissions | undefined): PermissionChoices {
  if (!p) return { ...DEFAULT_CHOICES };
  const allowed = (v: boolean | undefined) => v !== false;
  const printing: PrintingChoice = p.printing === false ? 'none' : p.printing === 'lowResolution' ? 'low' : 'high';
  let changes: ChangesChoice = 'none';
  if (allowed(p.modifying)) changes = 'any';
  else if (allowed(p.annotating)) changes = 'comments';
  else if (allowed(p.fillingForms)) changes = 'forms';
  else if (allowed(p.documentAssembly)) changes = 'pages';
  return { printing, changes, copying: allowed(p.copying), screenReader: allowed(p.contentAccessibility) };
}

export function isRestricted(p: Permissions | undefined): boolean {
  if (!p) return false;
  return (
    p.printing === false || p.printing === 'lowResolution' || p.modifying === false || p.copying === false ||
    p.annotating === false || p.fillingForms === false || p.contentAccessibility === false || p.documentAssembly === false
  );
}

export function hasSecurity(s: SecuritySettings | null | undefined): boolean {
  if (!s) return false;
  return !!s.userPassword || !!s.ownerPassword || isRestricted(s.permissions);
}

export interface SummaryRow {
  label: string;
  value: string;
  allowed?: boolean;
}

/** Rows of the standard "Document Restrictions Summary". */
export function restrictionRows(p: Permissions | undefined): SummaryRow[] {
  const ok = (v: boolean | undefined) => v !== false;
  const row = (label: string, allowed: boolean): SummaryRow => ({ label, value: allowed ? 'Allowed' : 'Not allowed', allowed });
  const printing = p?.printing;
  return [
    {
      label: 'Printing',
      value: printing === false ? 'Not allowed' : printing === 'lowResolution' ? 'Low resolution' : 'High resolution',
      allowed: printing !== false,
    },
    row('Changing the document', ok(p?.modifying)),
    row('Document assembly', ok(p?.documentAssembly) || ok(p?.modifying)),
    row('Content copying', ok(p?.copying)),
    row('Content copying for accessibility', ok(p?.contentAccessibility) || ok(p?.copying)),
    row('Page extraction', ok(p?.copying) && (ok(p?.documentAssembly) || ok(p?.modifying))),
    row('Commenting', ok(p?.annotating)),
    row('Filling of form fields', ok(p?.fillingForms) || ok(p?.annotating)),
    row('Signing', ok(p?.fillingForms) || ok(p?.annotating)),
    row('Creation of template pages', ok(p?.modifying)),
  ];
}
