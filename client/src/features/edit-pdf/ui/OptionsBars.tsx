/** Tool options bars (secondary toolbar) of the Edit PDF tools. */
import { ImagePlus } from 'lucide-react';
import { actions, useToolOptions } from '@/core/store';
import { Button, Switch } from '@/core/ui';
import { pickImage } from '../images';
import { CONTENT_DEFAULTS, TOOL_CONTENT } from '../model';
import { ui, useEditPdf } from '../state';
import { FormatBarControls, useFormatState } from './FormatControls';

export function ContentOptionsBar() {
  const o = useToolOptions(TOOL_CONTENT, CONTENT_DEFAULTS);
  return (
    <div className="edit-pdf-options" data-edit-pdf-keep="">
      <span data-testid="edit-pdf-opt-boxes">
        <Switch label="Show bounding boxes" checked={o.showBoxes} onChange={(v) => actions.setToolOption(TOOL_CONTENT, 'showBoxes', v)} />
      </span>
      <span className="edit-pdf-options-hint">Click text to edit it · drag a border to move</span>
    </div>
  );
}

export function TextOptionsBar() {
  const f = useFormatState();
  return (
    <div className="edit-pdf-options" data-edit-pdf-keep="" data-testid="edit-pdf-opt-text">
      {f && !f.disabled && <FormatBarControls style={f.style} />}
      <span className="edit-pdf-options-hint">Click to type · drag to set the width</span>
    </div>
  );
}

export async function chooseImage(): Promise<boolean> {
  const img = await pickImage();
  if (!img) return false;
  ui.setPendingImage(img);
  return true;
}

export function ImageOptionsBar() {
  const pending = useEditPdf((s) => s.pendingImage);
  return (
    <div className="edit-pdf-options" data-edit-pdf-keep="">
      <Button size="sm" variant="secondary" icon={ImagePlus} onClick={() => void chooseImage()} data-testid="edit-pdf-opt-choose">
        {pending ? 'Change image…' : 'Choose image…'}
      </Button>
      {pending && (
        <span className="edit-pdf-options-file" title={pending.name} data-testid="edit-pdf-opt-file">
          <img src={pending.dataUrl} alt="" />
          {pending.name} · {pending.width}×{pending.height}
        </span>
      )}
      <span className="edit-pdf-options-hint">{pending ? 'Click to place · drag to set the size' : 'Choose a PNG or JPEG image to place'}</span>
    </div>
  );
}

export function LinkOptionsBar() {
  return (
    <div className="edit-pdf-options" data-edit-pdf-keep="">
      <span className="edit-pdf-options-hint">Drag a rectangle to create a link · double-click a link to edit it</span>
    </div>
  );
}
