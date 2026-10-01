/**
 * "signature" object: a placed signature or initials image (typed / drawn / uploaded).
 * Typed and drawn signatures are stored as black-ink alpha masks and tinted with obj.color.
 * Exported as a PNG image drawn into the page content.
 */
import { Droplet, Signature } from 'lucide-react';
import type { DocId, ExportContext, ObjectRenderProps, ObjectTypeDef, PageInfo, Point, Rotation, UpdateOptions } from '@/core/types';
import { actions, newObject } from '@/core/store';
import { ColorSwatchButton } from '@/core/ui';
import { SIGNATURE, clampRectToPage, rectAround, signatureDefaultSize, uprightSize, type SignatureObject } from './model';
import { Upright } from './Upright';
import { drawLocal, embedPngCached, f, hashKey } from './exportUtil';
import { INK_COLORS, pngBytes } from './sigrender';
import type { SavedSig } from './store';

export function SigImage({ src, recolorable, color, className }: { src: string; recolorable: boolean; color?: string; className?: string }) {
  if (recolorable) {
    const url = `url("${src}")`;
    return (
      <div
        className={`fill-sign-sig-mask${className ? ` ${className}` : ''}`}
        style={{ WebkitMaskImage: url, maskImage: url, background: color ?? '#000000' }}
        role="img"
        aria-label="Signature"
      />
    );
  }
  return <img className={`fill-sign-sig-img${className ? ` ${className}` : ''}`} src={src} alt="Signature" draggable={false} />;
}

function SignatureRender({ obj, scale, rotation, box }: ObjectRenderProps<SignatureObject>) {
  const d = obj.data;
  const { w, h } = uprightSize(obj.rect, d.rot);
  return (
    <Upright box={box} scale={scale} rotation={rotation} rot={d.rot} w={w} h={h} className="fill-sign-signature" style={{ opacity: obj.opacity ?? 1 }}>
      <SigImage src={d.src} recolorable={d.recolorable} color={obj.color} className="fill-sign-sig-fill" />
    </Upright>
  );
}

export function createSignature(docId: DocId, page: PageInfo, center: Point, sig: SavedSig, rot: Rotation): SignatureObject {
  const { w, h } = signatureDefaultSize(sig.role, sig.aspect, page, rot);
  const rect = clampRectToPage(rectAround(center, w, h, rot), page);
  const obj = newObject<SignatureObject>({
    kind: 'signature',
    pageId: page.id,
    rect,
    color: sig.recolorable ? sig.color : undefined,
    data: { src: sig.src, role: sig.role, source: sig.source, recolorable: sig.recolorable, rot },
  });
  actions.addObject(docId, obj, { select: true, label: sig.role === 'initials' ? 'Add initials' : 'Add signature' });
  return obj;
}

const PALETTE = [...INK_COLORS.map((c) => c.value), '#6e6e6e', '#1473e6', '#2dc653', '#7e4cc7'];

function SignatureBar({ obj, update }: { obj: SignatureObject; docId: DocId; update(patch: Partial<SignatureObject>, opts?: UpdateOptions): void }) {
  if (!obj.data.recolorable) return null;
  return (
    <div className="fill-sign-bar">
      <span className="fill-sign-swatch" data-testid="fill-sign-sig-color">
        <ColorSwatchButton
          value={obj.color ?? '#000000'}
          label="Ink color"
          size="sm"
          palette={PALETTE}
          onChange={(c) => c && update({ color: c }, { label: 'Change signature color' })}
        />
      </span>
    </div>
  );
}

async function exportSignature(obj: SignatureObject, ctx: ExportContext) {
  const d = obj.data;
  const { w, h } = uprightSize(obj.rect, d.rot);
  const tint = d.recolorable && obj.color && obj.color.toLowerCase() !== '#000000' ? obj.color.toLowerCase() : undefined;
  const ref = await embedPngCached(ctx.pdfDoc, `sig:${hashKey(d.src)}:${tint ?? ''}`, () => pngBytes(d.src, tint));
  const res = ctx.pdfDoc.context.obj({ XObject: { Im0: ref } });
  drawLocal(ctx, obj, d.rot, `${f(w)} 0 0 ${f(h)} 0 0 cm\n/Im0 Do`, res, 1);
}

export const signatureType: ObjectTypeDef<SignatureObject> = {
  kind: SIGNATURE,
  label: 'Signature',
  icon: Signature,
  category: 'fill-sign',
  Render: SignatureRender,
  keepAspectRatio: true,
  minSize: { width: 6, height: 4 },
  PropertiesBar: SignatureBar,
  summary: (o) => (o.data.role === 'initials' ? 'Initials' : 'Signature'),
  contextMenu(obj, docId) {
    if (!obj.data.recolorable) return [];
    const cur = (obj.color ?? '#000000').toLowerCase();
    return INK_COLORS.filter((c) => c.value.toLowerCase() !== cur).map((c) => ({
      id: `fill-sign.sig.ink.${c.id}`,
      label: `${c.label} ink`,
      icon: Droplet,
      run: () => actions.updateObject(docId, obj.id, { color: c.value }, { label: 'Change signature color' }),
    }));
  },
  exportToPdf: exportSignature,
};
