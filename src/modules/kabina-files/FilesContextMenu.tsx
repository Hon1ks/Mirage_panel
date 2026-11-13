import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** One line of the menu; `hint` explains a disabled one (shown as its title). */
export type FilesMenuItem =
  | { kind: 'item'; label: string; icon?: ReactNode; onSelect: () => void; disabled?: boolean; hint?: string; danger?: boolean }
  | { kind: 'separator' };

type FilesContextMenuProps = {
  x: number;
  y: number;
  /** The entry's name, as the menu's caption. */
  title: string;
  items: FilesMenuItem[];
  onClose: () => void;
};

const EDGE = 8;

/**
 * Used by FilesScreen: the right-click menu of a tree row (a long press on Android) —
 * every action on the entry in one place, like the authors' tree. Opens at the pointer,
 * kept inside the window; Esc, a click elsewhere, scrolling or resizing closes it.
 * Arrow keys move between the items.
 */
export function FilesContextMenu({ x, y, title, items, onClose }: FilesContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });

  // Kept on screen: flipped left / up when it would run past the window's edge.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menu) return;
    const { width, height } = menu.getBoundingClientRect();
    const left = x + width + EDGE > window.innerWidth ? Math.max(EDGE, x - width) : x;
    const top = y + height + EDGE > window.innerHeight ? Math.max(EDGE, window.innerHeight - height - EDGE) : y;
    setPosition({ left, top });
    menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }, [x, y]);

  useEffect(() => {
    const onPointer = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      event.preventDefault();
      const buttons = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
      if (buttons.length === 0) return;
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      const next = event.key === 'ArrowDown' ? (index + 1) % buttons.length : (index - 1 + buttons.length) % buttons.length;
      buttons[next].focus();
    };
    const close = () => onClose();
    window.addEventListener('pointerdown', onPointer, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [onClose]);

  return createPortal(
    <div ref={menuRef} className="kf-menu kb-bz kb-fadein" role="menu" aria-label={`Действия: ${title}`} style={position}>
      <div className="kb-m kf-menu-title">{title}</div>
      {items.map((item, index) => (
        item.kind === 'separator' ? (
          <div key={`sep-${index}`} className="kf-menu-sep" role="separator" />
        ) : (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            className="kf-menu-item"
            data-danger={item.danger ? '' : undefined}
            disabled={item.disabled}
            title={item.disabled ? item.hint : undefined}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            <span className="kf-menu-icon" aria-hidden="true">{item.icon}</span>
            {item.label}
          </button>
        )
      ))}
    </div>,
    document.body,
  );
}
