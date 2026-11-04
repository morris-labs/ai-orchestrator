// Menus: a menu bar and context menus, drawn in the page rather than by
// Electron, so that no native accelerator ever takes a key from a terminal.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export type MenuEntry =
  | {
      type?: "item";
      label: string;
      /** The chord text shown on the right, such as `Ctrl+Shift+N`. */
      chord?: string;
      enabled?: boolean;
      /** `true` or `false` makes the item checkable. */
      checked?: boolean;
      run?: () => void;
      submenu?: MenuEntry[];
    }
  | { type: "separator" };

export interface MenuListProps {
  entries: MenuEntry[];
  x: number;
  y: number;
  onClose: () => void;
  /** Accessible name of the menu. */
  label?: string;
  /** True for a submenu: its parent handles Escape and outside clicks. */
  nested?: boolean;
}

/** A floating menu at `x`, `y`. Closes on Escape, on an outside click, or after an item runs. */
export function MenuList({ entries, x, y, onClose, label, nested }: MenuListProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x, y });
  const [openSub, setOpenSub] = useState<number | null>(null);

  // A top-level menu gives focus back to what had it when the menu opened,
  // such as a terminal, as Qt's QMenu does. It does so only when focus
  // would otherwise be lost: on the page body or inside the closing menu.
  // An item that moved focus somewhere on purpose keeps that. This effect
  // runs before the one below moves focus to the first item.
  useLayoutEffect(() => {
    if (nested) return;
    const previous = document.activeElement as HTMLElement | null;
    const menu = ref.current;
    return () => {
      if (!previous || previous === document.body || !previous.isConnected) return;
      const now = document.activeElement;
      if (now === null || now === document.body || (menu?.contains(now) ?? false)) {
        previous.focus();
      }
    };
  }, [nested]);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth || 1e6;
    const vh = window.innerHeight || 1e6;
    setPos({
      x: Math.max(0, Math.min(x, vw - r.width - 4)),
      y: Math.max(0, Math.min(y, vh - r.height - 4)),
    });
    el.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
  }, [x, y]);

  useEffect(() => {
    if (nested) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose, nested]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    // A submenu sits inside its parent's list; keep the parent from moving focus too.
    e.stopPropagation();
    const items = [
      ...(ref.current?.querySelectorAll<HTMLButtonElement>(":scope > button:not(:disabled)") ?? []),
    ];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
    items[next]?.focus();
  };

  return (
    <div
      ref={ref}
      className="ab-menu"
      role="menu"
      aria-label={label}
      style={{ left: pos.x, top: pos.y }}
      onKeyDown={onKeyDown}
      onContextMenu={(e) => e.preventDefault()}
    >
      {entries.map((entry, i) => {
        if (entry.type === "separator")
          return <div key={i} className="ab-menu-separator" role="separator" />;
        const enabled =
          entry.enabled !== false && (entry.run !== undefined || entry.submenu !== undefined);
        const hasSub = entry.submenu !== undefined && entry.submenu.length > 0;
        return (
          <button
            key={i}
            type="button"
            className="ab-menu-item"
            role={entry.checked === undefined ? "menuitem" : "menuitemcheckbox"}
            aria-checked={entry.checked}
            aria-haspopup={hasSub ? "menu" : undefined}
            disabled={!enabled || (entry.submenu !== undefined && !hasSub)}
            onMouseEnter={() => setOpenSub(hasSub ? i : null)}
            onClick={(e) => {
              if (hasSub) {
                e.preventDefault();
                setOpenSub(i);
                return;
              }
              onClose();
              entry.run?.();
            }}
          >
            {entry.checked !== undefined && (
              <span className="ab-menu-check">{entry.checked ? "\u2713" : ""}</span>
            )}
            <span className="ab-menu-label">{entry.label}</span>
            {entry.chord && <span className="ab-menu-chord">{entry.chord}</span>}
            {hasSub && <span className="ab-menu-chord">{"\u25b8"}</span>}
          </button>
        );
      })}
      {openSub !== null && (
        <SubMenu entries={entries} anchor={ref} index={openSub} onClose={onClose} />
      )}
    </div>
  );
}

function SubMenu({
  entries,
  anchor,
  index,
  onClose,
}: {
  entries: MenuEntry[];
  anchor: React.RefObject<HTMLDivElement | null>;
  index: number;
  onClose: () => void;
}) {
  const entry = entries[index];
  if (!entry || entry.type === "separator" || !entry.submenu) return null;
  const parent = anchor.current;
  const item = parent?.children[index] as HTMLElement | undefined;
  const r = item?.getBoundingClientRect();
  const pr = parent?.getBoundingClientRect();
  return (
    <MenuList
      nested
      label={entry.label}
      entries={entry.submenu}
      x={(pr?.right ?? 0) - 2}
      y={r?.top ?? 0}
      onClose={onClose}
    />
  );
}

/** State for a context menu: where it is and what it shows. */
export interface ContextMenuState {
  x: number;
  y: number;
  entries: MenuEntry[];
}

/** Holds one open context menu. */
export function useContextMenu(): {
  menu: ContextMenuState | null;
  open: (x: number, y: number, entries: MenuEntry[]) => void;
  close: () => void;
  element: ReactNode;
} {
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const close = () => setMenu(null);
  return {
    menu,
    open: (x, y, entries) => setMenu({ x, y, entries }),
    close,
    element: menu ? (
      <MenuList entries={menu.entries} x={menu.x} y={menu.y} onClose={close} />
    ) : null,
  };
}

export interface MenuBarMenu {
  label: string;
  entries: MenuEntry[];
}

/** A menu bar: File, Box, View, and so on. */
export function MenuBar({ menus }: { menus: MenuBarMenu[] }) {
  const [open, setOpen] = useState<{ index: number; x: number; y: number } | null>(null);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const openAt = (index: number) => {
    const r = refs.current[index]?.getBoundingClientRect();
    setOpen({ index, x: r?.left ?? 0, y: r?.bottom ?? 0 });
  };
  return (
    <nav className="ab-menubar" role="menubar">
      {menus.map((m, i) => (
        <button
          key={m.label}
          ref={(el) => {
            refs.current[i] = el;
          }}
          type="button"
          role="menuitem"
          className={`ab-menubar-item${open?.index === i ? " ab-open" : ""}`}
          onMouseDown={(e) => {
            e.preventDefault();
            if (open?.index === i) setOpen(null);
            else openAt(i);
          }}
          onMouseEnter={() => {
            if (open && open.index !== i) openAt(i);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
              e.preventDefault();
              openAt(i);
            }
          }}
        >
          {m.label}
        </button>
      ))}
      {open && (
        <MenuList
          label={menus[open.index]?.label}
          entries={menus[open.index]?.entries ?? []}
          x={open.x}
          y={open.y}
          onClose={() => setOpen(null)}
        />
      )}
    </nav>
  );
}
