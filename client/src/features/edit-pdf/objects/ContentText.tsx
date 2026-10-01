/**
 * content-text — a text box added with Edit PDF → Add text. Drawn like the PDF writer lays it
 * out; exported as real page content (standard-14 font, or embedded Liberation Sans for text
 * outside WinAnsi), so after saving it is ordinary page text that Edit PDF can edit again.
 */
import { useEffect } from 'react';
import { Pencil, Type } from 'lucide-react';
import { actions, useApp } from '@/core/store';
import type { ObjectRenderProps, ObjectTypeDef } from '@/core/types';
import { insertTextOnPage } from '../content/ops';
import { exportFontLoader } from '../edits';
import { KIND_TEXT, TOOL_CONTENT, type ContentTextObject } from '../model';
import { startObjectEdit } from '../sessions';
import { useEditPdf } from '../state';
import { boxRect, firstBaselineOf, objectFrame } from '../textbox';
import { TextLines } from '../tools/TextLines';
import { frameForRect } from '../viewmath';

function ContentTextRender({ obj, docId, pageIndex, viewport, scale, box, editing }: ObjectRenderProps<ContentTextObject>) {
  const hidden = useEditPdf((s) => s.edit?.source.type === 'object' && s.edit.source.objectId === obj.id && s.edit.docId === docId);

  // Double-click / Enter with the Select tool: continue in Edit PDF with the text editor open.
  useEffect(() => {
    if (!editing) return;
    actions.setEditing(docId, null);
    if (useApp.getState().activeToolId !== TOOL_CONTENT) actions.setTool(TOOL_CONTENT);
    startObjectEdit(docId, pageIndex, obj, 'end');
  }, [editing, docId, pageIndex, obj]);

  if (hidden) return null;
  const d = obj.data;
  return (
    <div className="edit-pdf-obj-text" style={{ left: -box.left, top: -box.top }} data-testid="edit-pdf-text-object">
      <TextLines
        text={d.text}
        style={d.style}
        frame={objectFrame(obj)}
        firstBaseline={firstBaselineOf(d.style)}
        autoWidth={!!d.autoWidth}
        vp={viewport}
        zoom={scale}
      />
    </div>
  );
}

export const contentTextType: ObjectTypeDef<ContentTextObject> = {
  kind: KIND_TEXT,
  label: 'Text',
  icon: Type,
  category: 'content',
  Render: ContentTextRender,
  editable: true,
  minSize: { width: 8, height: 4 },
  resize(obj, rect) {
    // a new width reflows the text; the height follows the lines
    const frame = frameForRect(rect, obj.data.rotation ?? 0);
    const r = boxRect(frame, obj.data.text, obj.data.style, false);
    return { rect: r.rect, data: { ...obj.data, autoWidth: false } };
  },
  summary: (obj) => obj.data.text,
  contextMenu: (obj, docId) => [
    {
      id: 'edit-pdf-edit-text-object',
      label: 'Edit text',
      icon: Pencil,
      run: () => {
        const doc = useApp.getState().docs[docId];
        const pageIndex = doc ? doc.pages.findIndex((p) => p.id === obj.pageId) : -1;
        if (pageIndex < 0) return;
        actions.setTool(TOOL_CONTENT);
        startObjectEdit(docId, pageIndex, obj, 'end');
      },
    },
  ],
  async exportToPdf(obj, ctx) {
    const d = obj.data;
    if (!d.text.trim()) return;
    try {
      await insertTextOnPage(
        ctx.pdfDoc,
        ctx.page(obj.pageId),
        { text: d.text, style: d.style, frame: objectFrame(obj), firstBaseline: firstBaselineOf(d.style), wrap: !d.autoWidth },
        exportFontLoader(ctx),
      );
    } catch (e) {
      console.warn('[edit-pdf] text box could not be written', e);
      actions.toast(`A text box couldn’t be saved: ${e instanceof Error ? e.message : String(e)}`, { kind: 'warning' });
    }
  },
};
