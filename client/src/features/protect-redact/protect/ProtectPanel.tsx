/** Left panel of the "Protect a PDF" task. */
import type { ComponentType } from 'react';
import { EyeOff, Info, LockKeyhole, ShieldCheck, ShieldOff } from 'lucide-react';
import { actions, useApp, useDoc } from '@/core/store';
import type { DocId } from '@/core/types';
import { EmptyState, confirmDialog } from '@/core/ui';
import { useReadOnlyReason } from '../shared';
import { openProtectDialog } from './PasswordDialog';
import { hasSecurity } from './permissions';
import { setSecurityUndoable } from './securityHistory';
import { SecuritySummary } from './SecuritySummary';

export function PanelAction(props: {
  icon: ComponentType<{ size?: number; strokeWidth?: number }>;
  label: string;
  description?: string;
  onClick(): void;
  disabled?: boolean;
  active?: boolean;
  testid: string;
  danger?: boolean;
  badge?: string | number;
}) {
  const Icon = props.icon;
  return (
    <button
      type="button"
      className={`protect-redact-action${props.active ? ' is-active' : ''}${props.danger ? ' is-danger' : ''}`}
      onClick={props.onClick}
      disabled={props.disabled}
      aria-pressed={props.active === undefined ? undefined : props.active}
      data-testid={props.testid}
    >
      <span className="protect-redact-action-icon">
        <Icon size={18} strokeWidth={1.75} />
      </span>
      <span className="protect-redact-action-text">
        <span className="protect-redact-action-label">{props.label}</span>
        {props.description && <span className="protect-redact-action-desc">{props.description}</span>}
      </span>
      {props.badge !== undefined && <span className="protect-redact-badge">{props.badge}</span>}
    </button>
  );
}

export async function removeSecurity(docId: DocId) {
  const ok = await confirmDialog({
    title: 'Remove security',
    message: 'Are you sure you want to remove security from this document? Anyone will be able to open, print, copy and change it.',
    confirmLabel: 'Remove',
    danger: true,
    icon: ShieldOff,
  });
  if (!ok) return;
  setSecurityUndoable(docId, null, 'Remove security');
  actions.toast('Security removed. Save or download the document to apply the change.', { kind: 'success' });
}

export function ProtectPanel() {
  const docId = useApp((s) => s.activeDocId);
  const security = useDoc(docId, (d) => d?.security ?? null);
  const readOnly = useReadOnlyReason(docId);
  if (!docId) {
    return (
      <div className="protect-redact-panel">
        <EmptyState icon={LockKeyhole} title="No document open" description="Open a PDF to protect it with a password." compact />
      </div>
    );
  }
  const secured = hasSecurity(security);
  return (
    <div className="protect-redact-panel" data-testid="protect-redact-protect-panel">
      <p className="protect-redact-intro">Prevent others from opening, printing, copying or changing this PDF.</p>
      {readOnly && (
        <div className="protect-redact-notice" role="status" data-testid="protect-redact-readonly">
          <Info size={16} aria-hidden />
          <span>{readOnly}</span>
        </div>
      )}
      <div className="protect-redact-actions">
        <PanelAction
          icon={LockKeyhole}
          label="Protect using password"
          description="Require a password to open the document."
          onClick={() => void openProtectDialog(docId, 'password')}
          disabled={!!readOnly}
          testid="protect-redact-protect-password"
        />
        <PanelAction
          icon={ShieldCheck}
          label="Restrict editing"
          description="Require a password to print, edit or copy."
          onClick={() => void openProtectDialog(docId, 'restrict')}
          disabled={!!readOnly}
          testid="protect-redact-restrict-editing"
        />
        {secured && (
          <PanelAction
            icon={ShieldOff}
            label="Remove security"
            description="Remove the passwords and restrictions."
            onClick={() => void removeSecurity(docId)}
            disabled={!!readOnly}
            testid="protect-redact-remove-security"
            danger
          />
        )}
        <PanelAction
          icon={EyeOff}
          label="Redact a PDF"
          description="Permanently remove sensitive content."
          onClick={() => actions.openTask('redact')}
          testid="protect-redact-open-redact"
        />
      </div>
      <SecuritySummary docId={docId} />
    </div>
  );
}
