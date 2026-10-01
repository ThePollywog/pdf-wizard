/**
 * Menus: Dropdown (a trigger + menu), showContextMenu (global host at the pointer), submenus,
 * checkable items, section headers. Keyboard: ↑/↓/Home/End move, Enter/Space activate,
 * → opens a submenu, ← / Esc closes it, type-ahead by first letter, Tab closes.
 */
import {
  cloneElement,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type MouseEvent as RMouseEvent,
  type ReactElement,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronRight } from 'lucide-react';
import type { IconType, MenuItem } from '../types';
import { actions } from '../store';
import { LAYER_ATTR, nextLayerOrder, useEscapeLayer, useOutsidePointerDown } from './layers';
import { useFloating, type AnchorRect, type Placement } from './position';
import { formatShortcut } from './shortcut';

// ── Entry types ─────────────────────────────────────────────────────────────

/** A normal item; `checked` renders a check mark column (menuitemcheckbox). */
export type MenuActionItem = MenuItem & { checked?: boolean; description?: string };
export interface SubmenuItem {
  id: string;
  label: string;
  icon?: IconType;
  disabled?: boolean;
  submenu: MenuEntry[] | (() => MenuEntry[]);
}
export interface MenuHeader {
  header: string;
}
export type MenuEntry = MenuActionItem | SubmenuItem | MenuHeader | 'divider';

const isSub = (e: MenuEntry): e is SubmenuItem => typeof e === 'object' && 'submenu' in e;
const isHeader = (e: MenuEntry): e is MenuHeader => typeof e === 'object' && 'header' in e;
const isAction = (e: MenuEntry): e is MenuActionItem => typeof e === 'object' && 'run' in e;
const isInteractive = (e: MenuEntry) => (isSub(e) || isAction(e)) && !e.disabled;

/** Remove leading/trailing/double dividers and headers followed by nothing. */
export function cleanMenu(entries: MenuEntry[]): MenuEntry[] {
  const out: MenuEntry[] = [];
  for (const e of entries) {
    if (e === 'divider' && (out.length === 0 || out[out.length - 1] === 'divider')) continue;
    out.push(e);
  }
  while (out.length && (out[out.length - 1] === 'divider' || isHeader(out[out.length - 1]))) out.pop();
  // Drop headers directly followed by a divider/header
  return out.filter((e, i) => !(isHeader(e) && (i + 1 >= out.length || out[i + 1] === 'divider' || isHeader(out[i + 1]))));
}

async function runItem(item: MenuActionItem) {
  try {
    await item.run();
  } catch (err) {
    console.error(err);
    actions.toast(err instanceof Error ? err.message : String(err), { kind: 'error' });
  }
}

// ── MenuList (the floating list) ────────────────────────────────────────────

interface MenuListProps {
  entries: MenuEntry[];
  anchor: () => Element | AnchorRect | null | undefined;
  placement: Placement;
  offset?: number;
  /** Close the whole menu tree. `restoreFocus` is false when closing because of an outside click. */
  onClose(restoreFocus: boolean): void;
  /** For submenus: close only this level (← key). */
  onCloseLevel?(): void;
  autoFocusFirst?: boolean;
  /** Elements that count as "inside" (e.g. the trigger). */
  insideElements?: () => (Element | null | undefined)[];
  className?: string;
  minWidth?: number;
  level?: number;
  label?: string;
}

function MenuList({ entries: rawEntries, anchor, placement, offset, onClose, onCloseLevel, autoFocusFirst, insideElements, className, minWidth, level = 0, label }: MenuListProps) {
  const entries = useMemo(() => cleanMenu(rawEntries), [rawEntries]);
  const [order] = useState(nextLayerOrder);
  const [active, setActive] = useState<number>(-1);
  const [openSub, setOpenSub] = useState<number>(-1);
  const itemRefs = useRef<(HTMLElement | null)[]>([]);
  const subTimer = useRef<number | undefined>(undefined);
  const typeahead = useRef({ text: '', t: 0 });
  const floating = useFloating<HTMLDivElement>({ open: true, anchor, placement, offset });

  const hasChecks = entries.some((e) => isAction(e) && e.checked !== undefined);
  const hasIcons = entries.some((e) => (isAction(e) || isSub(e)) && e.icon);

  useEscapeLayer(true, () => {
    if (level > 0 && onCloseLevel) onCloseLevel();
    else onClose(true);
  });
  useOutsidePointerDown(level === 0, () => [floating.ref.current, ...(insideElements?.() ?? [])], () => onClose(false), order);

  // Focus the menu (or its first item) when it opens.
  useLayoutEffect(() => {
    const first = entries.findIndex(isInteractive);
    if (autoFocusFirst && first >= 0) {
      setActive(first);
      requestAnimationFrame(() => itemRefs.current[first]?.focus({ preventScroll: true }));
    } else {
      requestAnimationFrame(() => floating.ref.current?.focus({ preventScroll: true }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => window.clearTimeout(subTimer.current), []);

  const focusIndex = useCallback((i: number) => {
    setActive(i);
    itemRefs.current[i]?.focus({ preventScroll: false });
  }, []);

  const move = (dir: 1 | -1, from = active) => {
    const n = entries.length;
    for (let k = 1; k <= n; k++) {
      const i = (from + dir * k + n * 2) % n;
      if (isInteractive(entries[i])) return focusIndex(i);
    }
  };

  const activate = (i: number, viaKeyboard: boolean) => {
    const e = entries[i];
    if (!e || !isInteractive(e)) return;
    if (isSub(e)) {
      setOpenSub(i);
      setSubKeyboard(viaKeyboard);
      return;
    }
    if (isAction(e)) {
      onClose(true);
      // Run after the menu closed (so focus/dialogs behave)
      window.setTimeout(() => void runItem(e), 0);
    }
  };
  const [subKeyboard, setSubKeyboard] = useState(false);

  const onKeyDown = (ev: KeyboardEvent<HTMLDivElement>) => {
    // Keys typed inside a submenu bubble through the React tree: ignore those.
    if (!floating.ref.current?.contains(ev.target as Node)) return;
    switch (ev.key) {
      case 'ArrowDown':
        ev.preventDefault();
        move(1);
        break;
      case 'ArrowUp':
        ev.preventDefault();
        move(-1, active < 0 ? 0 : active);
        break;
      case 'Home':
        ev.preventDefault();
        move(1, -1);
        break;
      case 'End':
        ev.preventDefault();
        move(-1, 0);
        break;
      case 'ArrowRight':
        if (active >= 0 && isSub(entries[active])) {
          ev.preventDefault();
          activate(active, true);
        }
        break;
      case 'ArrowLeft':
        if (level > 0) {
          ev.preventDefault();
          onCloseLevel?.();
        }
        break;
      case 'Enter':
      case ' ':
        ev.preventDefault();
        if (active >= 0) activate(active, true);
        break;
      case 'Tab':
        ev.preventDefault();
        onClose(true);
        break;
      default:
        if (ev.key.length === 1 && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
          const now = Date.now();
          const ta = typeahead.current;
          ta.text = now - ta.t < 700 ? ta.text + ev.key.toLowerCase() : ev.key.toLowerCase();
          ta.t = now;
          const n = entries.length;
          for (let k = 1; k <= n; k++) {
            const i = (active + k + n) % n;
            const e = entries[i];
            if (isInteractive(e) && (e as MenuActionItem).label.toLowerCase().startsWith(ta.text)) {
              focusIndex(i);
              break;
            }
          }
        }
    }
  };

  return createPortal(
    <div
      ref={floating.ref}
      {...{ [LAYER_ATTR]: order }}
      role="menu"
      aria-label={label}
      aria-orientation="vertical"
      tabIndex={-1}
      className={`menu ${className ?? ''}`}
      style={{ ...floating.style, minWidth: minWidth ?? floating.style.minWidth }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {entries.map((e, i) => {
        if (e === 'divider') return <div key={`d${i}`} className="menu-divider" role="separator" />;
        if (isHeader(e))
          return (
            <div key={`h${i}`} className="menu-header" role="presentation">
              {e.header}
            </div>
          );
        const Icon = e.icon;
        const sub = isSub(e);
        const checked = isAction(e) ? e.checked : undefined;
        const shortcut = isAction(e) ? e.shortcut : undefined;
        const danger = isAction(e) && e.danger;
        const description = isAction(e) ? e.description : undefined;
        return (
          <div
            key={e.id}
            ref={(el) => {
              itemRefs.current[i] = el;
            }}
            role={checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
            aria-checked={checked !== undefined ? checked : undefined}
            aria-disabled={e.disabled || undefined}
            aria-haspopup={sub ? 'menu' : undefined}
            aria-expanded={sub ? openSub === i : undefined}
            tabIndex={-1}
            data-menu-id={e.id}
            className={`menu-item${active === i ? ' is-active' : ''}${e.disabled ? ' is-disabled' : ''}${danger ? ' is-danger' : ''}${sub && openSub === i ? ' is-open' : ''}`}
            onPointerMove={() => {
              if (e.disabled) return;
              if (active !== i) {
                setActive(i);
                itemRefs.current[i]?.focus({ preventScroll: true });
              }
              window.clearTimeout(subTimer.current);
              if (sub && openSub !== i) {
                subTimer.current = window.setTimeout(() => {
                  setOpenSub(i);
                  setSubKeyboard(false);
                }, 120);
              } else if (!sub && openSub >= 0) {
                subTimer.current = window.setTimeout(() => setOpenSub(-1), 250);
              }
            }}
            onClick={(ev: RMouseEvent) => {
              ev.stopPropagation();
              activate(i, false);
            }}
          >
            {hasChecks && <span className="menu-check">{checked && <Check size={16} strokeWidth={2.25} />}</span>}
            {hasIcons && <span className="menu-icon">{Icon && <Icon size={16} strokeWidth={1.75} />}</span>}
            <span className="menu-label">
              <span className="menu-label-text">{e.label}</span>
              {description && <span className="menu-desc">{description}</span>}
            </span>
            {shortcut && <span className="menu-shortcut">{formatShortcut(shortcut)}</span>}
            {sub && <ChevronRight className="menu-chevron" size={16} strokeWidth={1.75} />}
          </div>
        );
      })}
      {entries.length === 0 && <div className="menu-empty">No items</div>}
      {openSub >= 0 && isSub(entries[openSub]) && (
        <MenuList
          key={openSub}
          entries={resolveSub(entries[openSub] as SubmenuItem)}
          anchor={() => itemRefs.current[openSub]}
          placement="right-start"
          offset={2}
          level={level + 1}
          autoFocusFirst={subKeyboard}
          onClose={onClose}
          onCloseLevel={() => {
            const i = openSub;
            setOpenSub(-1);
            requestAnimationFrame(() => focusIndex(i));
          }}
          label={(entries[openSub] as SubmenuItem).label}
        />
      )}
    </div>,
    document.body,
  );
}

const resolveSub = (s: SubmenuItem) => (typeof s.submenu === 'function' ? s.submenu() : s.submenu);

// ── Dropdown ────────────────────────────────────────────────────────────────

export interface DropdownProps {
  /** Element that toggles the menu (receives onClick, aria-haspopup, aria-expanded). */
  trigger: ReactElement;
  items: MenuEntry[] | (() => MenuEntry[]);
  align?: 'start' | 'end';
  placement?: Placement;
  className?: string;
  minWidth?: number;
  onOpenChange?(open: boolean): void;
  label?: string;
}

export function Dropdown({ trigger, items, align = 'start', placement, className, minWidth, onOpenChange, label }: DropdownProps) {
  const [open, setOpen] = useState<null | { keyboard: boolean }>(null);
  const triggerEl = useRef<HTMLElement | null>(null);
  const setOpenState = (v: null | { keyboard: boolean }) => {
    setOpen(v);
    onOpenChange?.(!!v);
  };
  const props = trigger.props as Record<string, any>;
  const entries = open ? (typeof items === 'function' ? items() : items) : [];

  const t = cloneElement(trigger, {
    'aria-haspopup': 'menu',
    'aria-expanded': !!open,
    'data-open': open ? '' : undefined,
    onClick: (e: RMouseEvent<HTMLElement>) => {
      props.onClick?.(e);
      if (e.defaultPrevented) return;
      triggerEl.current = e.currentTarget;
      setOpenState(open ? null : { keyboard: e.detail === 0 });
    },
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      props.onKeyDown?.(e);
      if (e.key === 'ArrowDown' && !open) {
        e.preventDefault();
        triggerEl.current = e.currentTarget;
        setOpenState({ keyboard: true });
      }
    },
  } as Record<string, unknown>);

  return (
    <>
      {t}
      {open && (
        <MenuList
          entries={entries}
          anchor={() => triggerEl.current}
          placement={placement ?? (align === 'end' ? 'bottom-end' : 'bottom-start')}
          autoFocusFirst={open.keyboard}
          insideElements={() => [triggerEl.current]}
          className={className}
          minWidth={minWidth}
          label={label}
          onClose={(restore) => {
            setOpenState(null);
            if (restore) triggerEl.current?.focus({ preventScroll: true });
          }}
        />
      )}
    </>
  );
}
export const Menu = Dropdown;

// ── Context menu (global host) ──────────────────────────────────────────────

interface CtxState {
  x: number;
  y: number;
  items: MenuEntry[];
  nonce: number;
  restore: HTMLElement | null;
}
let ctxState: CtxState | null = null;
const ctxListeners = new Set<() => void>();
const setCtx = (s: CtxState | null) => {
  ctxState = s;
  ctxListeners.forEach((l) => l());
};
let ctxNonce = 0;

/** Open a context menu at the pointer position. Call from an onContextMenu handler (it calls preventDefault). */
export function showContextMenu(e: { clientX: number; clientY: number; preventDefault?: () => void; stopPropagation?: () => void }, items: MenuEntry[]): void {
  e.preventDefault?.();
  e.stopPropagation?.();
  const clean = cleanMenu(items);
  if (clean.length === 0) return;
  setCtx({
    x: e.clientX,
    y: e.clientY,
    items: clean,
    nonce: ++ctxNonce,
    restore: document.activeElement instanceof HTMLElement ? document.activeElement : null,
  });
}

export function closeContextMenu() {
  setCtx(null);
}

/** Mount once (the shell does it via <UIHosts/>). */
export function ContextMenuHost() {
  const s = useSyncExternalStore(
    (l) => {
      ctxListeners.add(l);
      return () => ctxListeners.delete(l);
    },
    () => ctxState,
  );
  if (!s) return null;
  return (
    <MenuList
      key={s.nonce}
      entries={s.items}
      anchor={() => ({ left: s.x, top: s.y, width: 0, height: 0 })}
      placement="bottom-start"
      offset={2}
      className="context-menu"
      onClose={(restore) => {
        setCtx(null);
        if (restore) s.restore?.focus?.({ preventScroll: true });
      }}
    />
  );
}
