/** "Document security" summary of the active document (what will be written on save). */
import { Check, X } from 'lucide-react';
import { useDoc } from '@/core/store';
import type { DocId } from '@/core/types';
import { hasSecurity, isRestricted, restrictionRows } from './permissions';

export function SecuritySummary({ docId }: { docId: DocId }) {
  const security = useDoc(docId, (d) => d?.security ?? null);
  const wasEncrypted = useDoc(docId, (d) => !!d?.meta.isEncrypted);
  const secured = hasSecurity(security);
  const rows = restrictionRows(security?.permissions);
  const restricted = isRestricted(security?.permissions);
  const openPw = !!security?.userPassword;
  const permPw = !!security?.ownerPassword || (restricted && !!security);
  return (
    <section className="protect-redact-summary" data-testid="protect-redact-summary" data-secured={secured ? 'true' : 'false'}>
      <h3 className="protect-redact-section-title">Document security</h3>
      <dl className="protect-redact-kv">
        <div>
          <dt>Security method</dt>
          <dd data-testid="protect-redact-summary-method">{secured ? 'Password security' : 'No security'}</dd>
        </div>
        {secured && (
          <div>
            <dt>Encryption level</dt>
            <dd data-testid="protect-redact-summary-encryption">256-bit AES</dd>
          </div>
        )}
        <div>
          <dt>Document open password</dt>
          <dd data-testid="protect-redact-summary-open">{openPw ? 'Yes' : 'No'}</dd>
        </div>
        <div>
          <dt>Permissions password</dt>
          <dd data-testid="protect-redact-summary-perms">{permPw ? 'Yes' : 'No'}</dd>
        </div>
        {wasEncrypted && (
          <div>
            <dt>Opened as</dt>
            <dd>Encrypted file</dd>
          </div>
        )}
      </dl>
      <h4 className="protect-redact-subtitle">Document restrictions summary</h4>
      <ul className="protect-redact-restrictions" data-testid="protect-redact-restrictions">
        {rows.map((r) => (
          <li key={r.label} className={r.allowed ? 'is-allowed' : 'is-denied'} data-row={r.label}>
            {r.allowed ? <Check size={14} aria-hidden /> : <X size={14} aria-hidden />}
            <span className="protect-redact-restriction-label">{r.label}</span>
            <span className="protect-redact-restriction-value">{r.value}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
