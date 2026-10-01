/**
 * "Add signature" / "Add initials" dialog with Type, Draw and Image tabs.
 * Produces a SavedSig (transparent PNG) that is optionally stored for later use and becomes the
 * pending signature for placement.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type Ref, type RefObject } from 'react';
import { Eraser, ImageUp, Keyboard, PenLine, Signature } from 'lucide-react';
import { actions, useApp } from '@/core/store';
import { Button, Checkbox, FileDropZone, Modal, TextField } from '@/core/ui';
import type { SigRole, SigSource } from './model';
import { INK_COLORS, SIG_STYLES, processImage, readAsDataUrl, renderDrawn, renderTyped, type SigImage } from './sigrender';
import { newSig, saveSig, setPending, type SavedSig } from './store';

type Tab = SigSource;

const TABS: { id: Tab; label: string; icon: typeof Keyboard }[] = [
  { id: 'type', label: 'Type', icon: Keyboard },
  { id: 'draw', label: 'Draw', icon: PenLine },
  { id: 'image', label: 'Image', icon: ImageUp },
];

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  return parts
    .slice(0, 3)
    .map((p) => [...p][0]?.toUpperCase() ?? '')
    .join('');
}

function defaultName(role: SigRole): string {
  const n = useApp.getState().prefs.userName?.trim() ?? '';
  if (!n || n === 'Guest') return '';
  return role === 'initials' ? initialsOf(n) : n;
}

/** Open the manager; resolves with the created signature (already set as pending) or undefined. */
export function openSignatureManager(role: SigRole): Promise<SavedSig | undefined> {
  return actions.openModal<SavedSig>((close) => <SignatureManager role={role} onDone={(s) => close(s)} onCancel={() => close()} />);
}

function SignatureManager({ role, onDone, onCancel }: { role: SigRole; onDone(s: SavedSig): void; onCancel(): void }) {
  const [tab, setTab] = useState<Tab>('type');
  const [name, setName] = useState(() => defaultName(role));
  const [styleId, setStyleId] = useState(SIG_STYLES[0].id);
  const [color, setColor] = useState(INK_COLORS[0].value);
  const [save, setSave] = useState(true);
  const [hasInk, setHasInk] = useState(false);
  const [image, setImage] = useState<{ raw: string; name: string } | null>(null);
  const [removeWhite, setRemoveWhite] = useState(true);
  const [processed, setProcessed] = useState<SigImage | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const padRef = useRef<PadHandle | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const title = role === 'initials' ? 'Add initials' : 'Add signature';
  const style = SIG_STYLES.find((s) => s.id === styleId) ?? SIG_STYLES[0];

  // Process uploaded images (white removal + crop) whenever the image or the option changes.
  useEffect(() => {
    if (!image) {
      setProcessed(null);
      return;
    }
    let alive = true;
    setProcessing(true);
    processImage(image.raw, removeWhite)
      .then((r) => {
        if (!alive) return;
        setProcessed(r);
        setImageError(r ? null : 'The image is empty (nothing left after removing the background).');
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setProcessed(null);
        setImageError(e instanceof Error ? e.message : 'The image could not be read.');
      })
      .finally(() => alive && setProcessing(false));
    return () => {
      alive = false;
    };
  }, [image, removeWhite]);

  const onFiles = async (files: File[]) => {
    const file = files[0];
    if (!file) return;
    if (!/^image\/(png|jpe?g)$/i.test(file.type) && !/\.(png|jpe?g)$/i.test(file.name)) {
      setImageError('Choose a PNG or JPG image.');
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setImageError('The image is too large (maximum 10 MB).');
      return;
    }
    try {
      setImageError(null);
      setImage({ raw: await readAsDataUrl(file), name: file.name });
    } catch (e) {
      setImageError(e instanceof Error ? e.message : 'The image could not be read.');
    }
  };

  const canApply =
    tab === 'type' ? name.trim().length > 0 : tab === 'draw' ? hasInk : !!processed && !processing;

  const apply = () => {
    let img: SigImage | null = null;
    let recolorable = true;
    if (tab === 'type') img = renderTyped(name, style, '#000000');
    else if (tab === 'draw') img = padRef.current ? renderDrawn(padRef.current.canvas()) : null;
    else {
      img = processed;
      recolorable = false;
    }
    if (!img) {
      actions.toast(tab === 'draw' ? 'Draw your signature first.' : 'Nothing to add yet.', { kind: 'warning' });
      return;
    }
    const sig = newSig({ role, src: img.src, source: tab, recolorable, color: recolorable ? color : '#000000', aspect: img.aspect, saved: save });
    if (save && !saveSig(sig)) actions.toast('The signature could not be saved in this browser (storage is full). It can still be used now.', { kind: 'warning' });
    setPending(role, sig);
    onDone(sig);
  };

  return (
    <Modal
      title={title}
      icon={Signature}
      onClose={onCancel}
      width={640}
      className="fill-sign-sig-modal"
      footerStart={
        <span data-testid="fill-sign-sig-save">
          <Checkbox label={role === 'initials' ? 'Save initials' : 'Save signature'} checked={save} onChange={setSave} />
        </span>
      }
      footer={
        <>
          <Button variant="secondary" onClick={onCancel} data-testid="fill-sign-sig-cancel">
            Cancel
          </Button>
          <Button variant="primary" disabled={!canApply} onClick={apply} data-testid="fill-sign-sig-done">
            Done
          </Button>
        </>
      }
    >
      <div className="tabs tabs-md fill-sign-sig-tabs" role="tablist" aria-label="Signature method">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={`tab${tab === t.id ? ' is-selected' : ''}`}
            data-testid={`fill-sign-sig-tab-${t.id}`}
            onClick={() => {
              if (t.id === tab) return;
              if (tab === 'draw') setHasInk(false);
              setTab(t.id);
            }}
          >
            <t.icon size={16} strokeWidth={1.9} />
            <span>{t.label}</span>
          </button>
        ))}
      </div>

      <div className="fill-sign-sig-body" role="tabpanel">
        {tab === 'type' && (
          <div className="fill-sign-sig-type">
            <TextField
              label={role === 'initials' ? 'Initials' : 'Full name'}
              value={name}
              onChange={setName}
              maxLength={role === 'initials' ? 8 : 64}
              placeholder={role === 'initials' ? 'Your initials' : 'Your name'}
              autoFocus
              data-testid="fill-sign-sig-name"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canApply) {
                  e.preventDefault();
                  apply();
                }
              }}
            />
            <div className="fill-sign-sig-preview" data-testid="fill-sign-sig-preview">
              <span style={{ fontFamily: style.family, color, fontSize: `${38 * style.scale}px` }}>{name.trim() || (role === 'initials' ? 'AB' : 'Your name')}</span>
              <div className="fill-sign-sig-baseline" />
            </div>
            <div className="fill-sign-sig-styles" role="radiogroup" aria-label="Signature style">
              {SIG_STYLES.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  role="radio"
                  aria-checked={s.id === styleId}
                  className={`fill-sign-sig-style${s.id === styleId ? ' is-selected' : ''}`}
                  data-testid={`fill-sign-sig-style-${s.id}`}
                  title={s.label}
                  onClick={() => setStyleId(s.id)}
                >
                  <span style={{ fontFamily: s.family, fontSize: `${22 * s.scale}px` }}>{name.trim() || s.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {tab === 'draw' && <DrawPad ref={padRef} color={color} hasInk={hasInk} onInk={setHasInk} />}

        {tab === 'image' && (
          <div className="fill-sign-sig-image">
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg"
              hidden
              data-testid="fill-sign-sig-image-input"
              onChange={(e) => {
                const files = Array.from(e.target.files ?? []);
                e.target.value = '';
                void onFiles(files);
              }}
            />
            {processed || processing ? (
              <div className="fill-sign-sig-image-preview" data-testid="fill-sign-sig-image-preview">
                {processed && <img src={processed.src} alt="Signature image" draggable={false} />}
                {processing && <span className="fill-sign-muted">Processing…</span>}
              </div>
            ) : (
              <FileDropZone
                accept="image/png,image/jpeg,.png,.jpg,.jpeg"
                title="Drag and drop an image of your signature"
                hint="PNG or JPG"
                clickable={false}
                onFiles={(f) => void onFiles(f)}
                onReject={() => setImageError('Choose a PNG or JPG image.')}
              />
            )}
            <div className="fill-sign-sig-image-actions">
              <Button variant="secondary" size="sm" icon={ImageUp} onClick={() => fileRef.current?.click()} data-testid="fill-sign-sig-image-choose">
                {image ? 'Choose another image' : 'Choose image'}
              </Button>
              <span data-testid="fill-sign-sig-remove-bg">
                <Checkbox label="Remove white background" checked={removeWhite} onChange={setRemoveWhite} />
              </span>
            </div>
            {imageError && (
              <p className="fill-sign-error" role="alert" data-testid="fill-sign-sig-image-error">
                {imageError}
              </p>
            )}
          </div>
        )}

        {tab !== 'image' && (
          <div className="fill-sign-sig-colors" role="radiogroup" aria-label="Ink color">
            {INK_COLORS.map((c) => (
              <button
                key={c.id}
                type="button"
                role="radio"
                aria-checked={color === c.value}
                aria-label={c.label}
                title={c.label}
                className={`fill-sign-ink${color === c.value ? ' is-selected' : ''}`}
                data-testid={`fill-sign-sig-color-${c.id}`}
                style={{ background: c.value }}
                onClick={() => setColor(c.value)}
              />
            ))}
            {tab === 'draw' && (
              <Button variant="ghost" size="sm" icon={Eraser} className="fill-sign-sig-clear" onClick={() => padRef.current?.clear()} disabled={!hasInk} data-testid="fill-sign-sig-clear">
                Clear
              </Button>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

// ── drawing pad ──────────────────────────────────────────────────────────────

interface PadHandle {
  canvas(): HTMLCanvasElement;
  clear(): void;
}

interface Pt {
  x: number;
  y: number;
  t: number;
}

function DrawPad({ ref, color, hasInk, onInk }: { ref: Ref<PadHandle | null>; color: string; hasInk: boolean; onInk(v: boolean): void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const colorRef = useRef(color);
  const inkRef = useRef(false);
  const stroke = useRef<{ id: number; last: Pt; mid: { x: number; y: number }; w: number } | null>(null);

  const dpr = useMemo(() => Math.min(3, Math.max(1, window.devicePixelRatio || 1)), []);

  useLayoutEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    const r = c.getBoundingClientRect();
    c.width = Math.max(1, Math.round(r.width * dpr));
    c.height = Math.max(1, Math.round(r.height * dpr));
  }, [dpr]);

  const setInk = useCallback(
    (v: boolean) => {
      if (inkRef.current !== v) {
        inkRef.current = v;
        onInk(v);
      }
    },
    [onInk],
  );

  // Recolor what's already drawn when the ink color changes.
  useEffect(() => {
    colorRef.current = color;
    const c = canvasRef.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx || !inkRef.current) return;
    ctx.save();
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.restore();
  }, [color]);

  useEffect(() => {
    const handle: PadHandle = {
      canvas: () => canvasRef.current!,
      clear: () => {
        const c = canvasRef.current;
        c?.getContext('2d')?.clearRect(0, 0, c.width, c.height);
        setInk(false);
      },
    };
    if (typeof ref === 'function') ref(handle);
    else if (ref) (ref as RefObject<PadHandle | null>).current = handle;
    return () => {
      if (typeof ref === 'function') ref(null);
      else if (ref) (ref as RefObject<PadHandle | null>).current = null;
    };
  }, [ref, setInk]);

  const point = (e: RPointerEvent<HTMLCanvasElement>): Pt => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: (e.clientX - r.left) * dpr, y: (e.clientY - r.top) * dpr, t: e.timeStamp || performance.now() };
  };

  const base = 2.6 * dpr;
  const minW = 1.1 * dpr;
  const maxW = 4.2 * dpr;

  const dot = (p: Pt, w: number) => {
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = colorRef.current;
    ctx.beginPath();
    ctx.arc(p.x, p.y, w / 2, 0, Math.PI * 2);
    ctx.fill();
  };

  const onPointerDown = (e: RPointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = point(e);
    stroke.current = { id: e.pointerId, last: p, mid: { x: p.x, y: p.y }, w: base };
    dot(p, base);
    setInk(true);
  };

  const onPointerMove = (e: RPointerEvent<HTMLCanvasElement>) => {
    const s = stroke.current;
    if (!s || s.id !== e.pointerId) return;
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const events = typeof e.nativeEvent.getCoalescedEvents === 'function' ? e.nativeEvent.getCoalescedEvents() : [];
    const pts: Pt[] = events.length
      ? events.map((ev) => {
          const r = e.currentTarget.getBoundingClientRect();
          return { x: (ev.clientX - r.left) * dpr, y: (ev.clientY - r.top) * dpr, t: ev.timeStamp || performance.now() };
        })
      : [point(e)];
    for (const p of pts) {
      const dist = Math.hypot(p.x - s.last.x, p.y - s.last.y);
      if (dist < 0.5 * dpr) continue;
      const dt = Math.max(1, p.t - s.last.t);
      const v = dist / dpr / dt; // CSS px per ms
      const target = Math.min(maxW, Math.max(minW, maxW - v * 1.6 * dpr));
      const w = s.w * 0.65 + target * 0.35;
      const mid = { x: (s.last.x + p.x) / 2, y: (s.last.y + p.y) / 2 };
      ctx.strokeStyle = colorRef.current;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(s.mid.x, s.mid.y);
      ctx.quadraticCurveTo(s.last.x, s.last.y, mid.x, mid.y);
      ctx.stroke();
      s.mid = mid;
      s.last = p;
      s.w = w;
    }
  };

  const end = (e: RPointerEvent<HTMLCanvasElement>) => {
    const s = stroke.current;
    if (!s || s.id !== e.pointerId) return;
    const ctx = canvasRef.current?.getContext('2d');
    if (ctx) {
      ctx.strokeStyle = colorRef.current;
      ctx.lineWidth = s.w;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(s.mid.x, s.mid.y);
      ctx.lineTo(s.last.x, s.last.y);
      ctx.stroke();
    }
    stroke.current = null;
  };

  return (
    <div className="fill-sign-sig-pad-wrap">
      <canvas
        ref={canvasRef}
        className="fill-sign-sig-pad"
        data-testid="fill-sign-sig-pad"
        aria-label="Draw your signature here"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={end}
        onPointerCancel={end}
      />
      <div className="fill-sign-sig-pad-line" aria-hidden="true" />
      {!hasInk && <span className="fill-sign-sig-pad-hint">Draw your signature here</span>}
    </div>
  );
}
