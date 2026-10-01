/** Tool options bars (secondary toolbar) of the Fill & Sign tools. */
import { Plus } from 'lucide-react';
import { actions, useToolOptions } from '@/core/store';
import { Button, ColorSwatchButton, Dropdown, Select } from '@/core/ui';
import { DATE_FORMATS, formatDate, type DateFormat } from './date';
import { FONT_SIZES, type SigRole } from './model';
import { DATE_DEFAULTS, DATE_OPTIONS_KEY, MARK_DEFAULTS, MARK_OPTIONS_KEY, TEXT_DEFAULTS, TEXT_OPTIONS_KEY } from './options';
import { SigImage } from './signature';
import { openSignatureManager } from './SignatureManager';
import { setPending, useFillSign } from './store';

function TextStyleControls() {
  const o = useToolOptions(TEXT_OPTIONS_KEY, TEXT_DEFAULTS);
  return (
    <>
      <Select
        size="sm"
        aria-label="Font size"
        value={o.fontSize}
        width={78}
        options={FONT_SIZES.map((s) => ({ value: s, label: `${s} pt` }))}
        onChange={(v) => actions.setToolOption(TEXT_OPTIONS_KEY, 'fontSize', v)}
        data-testid="fill-sign-opt-size"
      />
      <span className="fill-sign-swatch" data-testid="fill-sign-opt-color">
        <ColorSwatchButton value={o.color} label="Text color" size="sm" onChange={(c) => c && actions.setToolOption(TEXT_OPTIONS_KEY, 'color', c)} />
      </span>
    </>
  );
}

export function TextOptionsBar() {
  return (
    <div className="fill-sign-options">
      <TextStyleControls />
      <span className="fill-sign-options-hint">Click where you want to type. Enter starts a new line.</span>
    </div>
  );
}

export function DateOptionsBar() {
  const o = useToolOptions(DATE_OPTIONS_KEY, DATE_DEFAULTS);
  const now = new Date();
  return (
    <div className="fill-sign-options">
      <Select<DateFormat>
        size="sm"
        aria-label="Date format"
        value={o.format}
        width={168}
        options={DATE_FORMATS.map((f) => ({ value: f.id, label: f.id === 'locale' ? `${formatDate(now, 'locale')} (regional)` : `${formatDate(now, f.id)}` }))}
        onChange={(v) => actions.setToolOption(DATE_OPTIONS_KEY, 'format', v)}
        data-testid="fill-sign-date-format"
      />
      <TextStyleControls />
    </div>
  );
}

export function MarkOptionsBar() {
  const o = useToolOptions(MARK_OPTIONS_KEY, MARK_DEFAULTS);
  return (
    <div className="fill-sign-options">
      <span className="fill-sign-swatch" data-testid="fill-sign-opt-mark-color">
        <ColorSwatchButton value={o.color} label="Symbol color" size="sm" onChange={(c) => c && actions.setToolOption(MARK_OPTIONS_KEY, 'color', c)} />
      </span>
      <span className="fill-sign-options-hint">Click to place the symbol.</span>
    </div>
  );
}

function SignatureOptions({ role }: { role: SigRole }) {
  const pending = useFillSign((s) => s.pending[role]);
  const saved = useFillSign((s) => s.saved[role]);
  const noun = role === 'initials' ? 'initials' : 'signature';
  return (
    <div className="fill-sign-options">
      {pending && (
        <Dropdown
          label={`Choose ${noun}`}
          trigger={
            <button type="button" className="fill-sign-opt-sig" data-testid="fill-sign-opt-sig" aria-label={`Choose ${noun}`} title={`Choose ${noun}`}>
              <SigImage src={pending.src} recolorable={pending.recolorable} color={pending.color} className="fill-sign-sig-fill" />
            </button>
          }
          items={[
            ...saved.map((s, i) => ({
              id: `fill-sign.use.${role}.${i}`,
              label: `Saved ${noun} ${i + 1}`,
              checked: s.id === pending.id,
              run: () => setPending(role, s),
            })),
            ...(saved.length ? (['divider'] as const) : []),
            { id: `fill-sign.new.${role}`, label: role === 'initials' ? 'Add new initials…' : 'Add new signature…', icon: Plus, run: () => void openSignatureManager(role) },
          ]}
        />
      )}
      {!pending && (
        <Button size="sm" variant="secondary" icon={Plus} onClick={() => void openSignatureManager(role)} data-testid="fill-sign-opt-sig-new">
          {role === 'initials' ? 'Add initials' : 'Add signature'}
        </Button>
      )}
      <span className="fill-sign-options-hint">{pending ? `Click where you want to place your ${noun}.` : `Create your ${noun} first.`}</span>
    </div>
  );
}

export function SignatureOptionsBar() {
  return <SignatureOptions role="signature" />;
}
export function InitialsOptionsBar() {
  return <SignatureOptions role="initials" />;
}

