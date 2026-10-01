/**
 * Redaction properties (the standard "Redaction Tool Properties"): fill color of the redacted area,
 * mark outline, overlay text (custom text or a redaction code, font, size, color, repeat, alignment).
 * Edits the given marks, and optionally saves the settings as defaults for new marks.
 */
import { useMemo, useState } from 'react';
import { AlertTriangle, AlignCenter, AlignLeft, AlignRight, ChevronDown, Settings2 } from 'lucide-react';
import { actions, getDoc } from '@/core/store';
import type { DocId, PdfObject } from '@/core/types';
import { Button, Checkbox, ColorSwatchButton, Dropdown, Modal, NumberField, Radio, SegmentedControl, Select, TextField } from '@/core/ui';
import { plural, readOnlyReason } from '../shared';
import { markDefaults } from './marks';
import { layoutOverlay, unsupportedChars } from './overlay';
import { CSS_FONT, DEFAULT_OUTLINE, FONT_OPTIONS, MARK_TOOL, isRedaction, overlayText, type OverlayAlign, type OverlayProps } from './types';
import { codeMenu } from './objectType';

interface Props {
  fillColor: string | null;
  outlineColor: string;
  overlay: OverlayProps;
}

const PREVIEW = { x: 0, y: 0, width: 240, height: 64 };

function Preview({ p }: { p: Props }) {
  const lay = layoutOverlay(p.overlay, PREVIEW, 0);
  return (
    <svg
      className="protect-redact-props-preview"
      viewBox={`0 0 ${PREVIEW.width} ${PREVIEW.height}`}
      width={PREVIEW.width}
      height={PREVIEW.height}
      data-testid="protect-redact-props-preview"
      aria-label="Preview of the redacted area"
    >
      <defs>
        <clipPath id="protect-redact-props-clip">
          <rect x={0} y={0} width={PREVIEW.width} height={PREVIEW.height} />
        </clipPath>
      </defs>
      <rect x={0} y={0} width={PREVIEW.width} height={PREVIEW.height} fill={p.fillColor ?? '#ffffff'} />
      <g clipPath="url(#protect-redact-props-clip)">
        {lay?.runs.map((r, i) => {
          const [a, b, c, d, e, f] = r.matrix;
          // PDF space (y up) → SVG (y down).
          const m = [a, -b, -c, d, e, PREVIEW.height - f].map((n) => Number(n.toFixed(4)));
          return (
            <text key={i} transform={`matrix(${m.join(' ')})`} fontSize={r.size} fontFamily={CSS_FONT[lay.font]} fill={lay.color} style={{ whiteSpace: 'pre' }}>
              {r.text}
            </text>
          );
        })}
      </g>
      <rect x={0.75} y={0.75} width={PREVIEW.width - 1.5} height={PREVIEW.height - 1.5} fill="none" stroke={p.outlineColor} strokeWidth={1.5} className="protect-redact-props-preview-outline" />
    </svg>
  );
}

const ALIGN_OPTIONS: { value: OverlayAlign; icon: typeof AlignLeft; title: string }[] = [
  { value: 'left', icon: AlignLeft, title: 'Align left' },
  { value: 'center', icon: AlignCenter, title: 'Center' },
  { value: 'right', icon: AlignRight, title: 'Align right' },
];

function PropertiesForm({ initial, count, close }: { initial: Props; count: number; close(v?: { props: Props; asDefault: boolean }): void }) {
  const [p, setP] = useState<Props>(initial);
  const [asDefault, setAsDefault] = useState(count === 0);
  const [source, setSource] = useState<'text' | 'code'>(initial.overlay.code ? 'code' : 'text');
  const o = p.overlay;
  const setO = (patch: Partial<OverlayProps>) => setP((s) => ({ ...s, overlay: { ...s.overlay, ...patch } }));
  const result = useMemo<Props>(() => ({ ...p, overlay: { ...p.overlay, code: source === 'code' ? p.overlay.code : '' } }), [p, source]);
  const missing = useMemo(() => (result.overlay.useText ? unsupportedChars(overlayText(result.overlay)) : []), [result]);
  const title = count === 0 ? 'Redaction tool properties' : count === 1 ? 'Redaction properties' : `Redaction properties (${plural(count, 'mark')})`;

  return (
    <Modal
      title={title}
      icon={Settings2}
      width={560}
      onClose={() => close(undefined)}
      className="protect-redact-dialog"
      footerStart={
        count > 0 ? (
          <span data-testid="protect-redact-props-default">
            <Checkbox label="Use as defaults for new marks" checked={asDefault} onChange={setAsDefault} />
          </span>
        ) : undefined
      }
      footer={
        <>
          <Button onClick={() => close(undefined)} data-testid="protect-redact-props-cancel">
            Cancel
          </Button>
          <Button variant="primary" onClick={() => close({ props: result, asDefault })} data-testid="protect-redact-props-ok">
            OK
          </Button>
        </>
      }
    >
      <div className="protect-redact-props" data-testid="protect-redact-props-dialog">
        <div className="protect-redact-props-preview-wrap">
          <Preview p={result} />
        </div>
        <section className="protect-redact-props-section">
          <h4>Appearance</h4>
          <div className="protect-redact-props-row">
            <span className="protect-redact-props-label">Redacted area fill color</span>
            <span data-testid="protect-redact-props-fill">
              <ColorSwatchButton label="Redacted area fill color" allowNone value={p.fillColor} onChange={(fillColor) => setP((s) => ({ ...s, fillColor }))} />
            </span>
          </div>
          <div className="protect-redact-props-row">
            <span className="protect-redact-props-label">Mark outline color</span>
            <span data-testid="protect-redact-props-outline">
              <ColorSwatchButton label="Mark outline color" value={p.outlineColor} onChange={(hex) => hex && setP((s) => ({ ...s, outlineColor: hex }))} />
            </span>
          </div>
        </section>
        <section className="protect-redact-props-section">
          <h4>Overlay text</h4>
          <span data-testid="protect-redact-props-use-text">
            <Checkbox label="Use overlay text" checked={o.useText} onChange={(useText) => setO({ useText })} />
          </span>
          <fieldset className="protect-redact-props-fieldset" disabled={!o.useText}>
            <div className="protect-redact-props-grid">
              <Select label="Font" value={o.font} options={FONT_OPTIONS} onChange={(font) => setO({ font })} disabled={!o.useText} data-testid="protect-redact-props-font" />
              <div className="protect-redact-props-size" data-testid="protect-redact-props-size">
                <NumberField label="Font size" value={o.fontSize} min={4} max={96} step={1} suffix="pt" disabled={!o.useText || o.autoSize} onChange={(fontSize) => setO({ fontSize })} />
              </div>
              <div className="protect-redact-props-color">
                <span className="protect-redact-props-label">Font color</span>
                <span data-testid="protect-redact-props-text-color">
                  <ColorSwatchButton label="Overlay text color" value={o.textColor} disabled={!o.useText} onChange={(hex) => hex && setO({ textColor: hex })} />
                </span>
              </div>
            </div>
            <span data-testid="protect-redact-props-autosize">
              <Checkbox label="Auto-size text to fit redaction region" checked={o.autoSize} disabled={!o.useText} onChange={(autoSize) => setO({ autoSize })} />
            </span>
            <span data-testid="protect-redact-props-repeat">
              <Checkbox label="Repeat overlay text" checked={o.repeat} disabled={!o.useText} onChange={(repeat) => setO({ repeat })} />
            </span>
            <div className="protect-redact-props-row">
              <span className="protect-redact-props-label">Text alignment</span>
              <span data-testid="protect-redact-props-align">
                <SegmentedControl
                  size="sm"
                  label="Text alignment"
                  value={o.align}
                  disabled={!o.useText}
                  options={ALIGN_OPTIONS.map((a) => ({ value: a.value, icon: a.icon, title: a.title }))}
                  onChange={(align) => setO({ align })}
                />
              </span>
            </div>
            <div className="protect-redact-props-source">
              <span data-testid="protect-redact-props-custom">
                <Radio name="protect-redact-overlay-source" label="Custom text" checked={source === 'text'} disabled={!o.useText} onChange={() => setSource('text')} />
              </span>
              <TextField
                aria-label="Custom overlay text"
                value={o.text}
                onChange={(text) => setO({ text })}
                placeholder="e.g. REDACTED"
                disabled={!o.useText || source !== 'text'}
                data-testid="protect-redact-props-text"
                maxLength={200}
              />
              <span data-testid="protect-redact-props-code-radio">
                <Radio name="protect-redact-overlay-source" label="Redaction code" checked={source === 'code'} disabled={!o.useText} onChange={() => setSource('code')} />
              </span>
              <Dropdown
                label="Redaction code"
                items={() => codeMenu(o.code, (code) => {
                  setSource('code');
                  setO({ code });
                })}
                trigger={
                  <button
                    type="button"
                    className="btn btn-secondary btn-md protect-redact-props-code"
                    disabled={!o.useText || source !== 'code'}
                    data-testid="protect-redact-props-code"
                  >
                    <span className="btn-label">{o.code || 'Choose a code…'}</span>
                    <ChevronDown size={16} strokeWidth={2} />
                  </button>
                }
              />
            </div>
            {missing.length > 0 && (
              <p className="protect-redact-props-warning" role="status" data-testid="protect-redact-props-text-warning">
                <AlertTriangle size={14} strokeWidth={2} aria-hidden />
                <span>
                  {missing.length === 1 ? 'The character ' : 'The characters '}
                  <b>{missing.slice(0, 12).join(' ')}{missing.length > 12 ? ' …' : ''}</b>
                  {' can’t be shown with the standard PDF fonts used for overlay text and will be left out.'}
                </span>
              </p>
            )}
          </fieldset>
        </section>
      </div>
    </Modal>
  );
}

/** Edit the properties of the given marks (none: edit the defaults for new marks). */
export async function openPropertiesDialog(docId: DocId | null, ids: string[]): Promise<boolean> {
  const doc = docId ? getDoc(docId) : undefined;
  const marks = doc ? ids.map((id) => doc.objects[id]).filter(isRedaction) : [];
  if (marks.length && docId) {
    const reason = readOnlyReason(docId);
    if (reason) {
      actions.toast(reason, { kind: 'error' });
      return false;
    }
  }
  const d = markDefaults();
  const first = marks[0];
  const initial: Props = first
    ? { fillColor: first.fillColor ?? null, outlineColor: first.color ?? DEFAULT_OUTLINE, overlay: { ...d.overlay, ...first.data.overlay } }
    : { fillColor: d.fillColor, outlineColor: d.outlineColor, overlay: { ...d.overlay } };
  const res = await actions.openModal<{ props: Props; asDefault: boolean }>((close) => (
    <PropertiesForm initial={initial} count={marks.length} close={close} />
  ));
  if (!res) return false;
  const { props, asDefault } = res;
  if (marks.length && docId) {
    const patches: Record<string, Partial<PdfObject>> = {};
    for (const m of marks) {
      patches[m.id] = { fillColor: props.fillColor, color: props.outlineColor, data: { ...m.data, overlay: { ...props.overlay } } } as Partial<PdfObject>;
    }
    actions.updateObjects(docId, patches, { label: 'Change redaction properties' });
  }
  if (asDefault || !marks.length) {
    actions.setToolOption(MARK_TOOL, 'fillColor', props.fillColor);
    actions.setToolOption(MARK_TOOL, 'outlineColor', props.outlineColor);
    actions.setToolOption(MARK_TOOL, 'overlay', { ...props.overlay });
    if (!marks.length) actions.toast('Saved the properties for new redaction marks.', { kind: 'info' });
  }
  return true;
}
