import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./icons";

/**
 * Menus are drawn at the top of the page (inside `.overlay`), never inside the piece
 * that opened them: a transformed parent (the centred Dock, a tilted card) would
 * otherwise drag fixed-position menus along with it.
 */
function toTop(node: ReactNode) {
  const host = document.querySelector(".overlay, .mini-root") ?? document.body;
  return createPortal(node, host);
}

/** A line in a context menu, or a divider. */
export type MenuEntry =
  | { label: string; onClick: () => void; checked?: boolean; disabled?: boolean; danger?: boolean }
  | "divider";

/** Keeps a box of the given size inside the window, preferring (x, y) as its top-left. */
function fit(x: number, y: number, w: number, h: number, margin = 8): { left: number; top: number } {
  const left = Math.max(margin, Math.min(x, window.innerWidth - w - margin));
  // Not enough room below: open upwards from the same point.
  const top = y + h > window.innerHeight - margin ? Math.max(margin, y - h) : y;
  return { left, top };
}

/** A glass menu at the mouse (right-click menus, the player menu). */
export function ContextMenu({ x, y, entries, onClose, className = "" }: { x: number; y: number; entries: MenuEntry[]; onClose: () => void; className?: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (el) setPos(fit(x, y, el.offsetWidth, el.offsetHeight));
  }, [x, y, entries.length]);
  return toTop(
    <div
      ref={box}
      className={`context-menu ${className}`}
      role="menu"
      data-hit
      style={pos ? { left: pos.left, top: pos.top } : { left: x, top: y, visibility: "hidden" }}
      onContextMenu={(e) => e.preventDefault()}
      // React passes events up through portals: don't let the opener's "click elsewhere closes me" see these.
      onPointerDown={(e) => e.stopPropagation()}
    >
      {entries.map((entry, i) =>
        entry === "divider" ? (
          <hr key={i} />
        ) : (
          <button
            key={i}
            role="menuitem"
            className={`${entry.danger ? "danger" : ""}`}
            disabled={entry.disabled}
            onClick={() => {
              onClose();
              entry.onClick();
            }}
          >
            <span>{entry.label}</span>
            {entry.checked && <Icon name="check" size={14} />}
          </button>
        ),
      )}
    </div>,
  );
}

/** Where a floating popover points: a box on screen (usually the button or card it belongs to). */
export interface Anchor {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export function anchorOf(el: Element): Anchor {
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
}

/** Shows a popover just above its anchor (below if there's no room), kept on screen. */
export function Floating({ anchor, children }: { anchor: Anchor; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const gap = 10;
    const above = anchor.top - h - gap;
    const top = above >= 8 ? above : Math.min(anchor.bottom + gap, window.innerHeight - h - 8);
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - w - 8));
    setPos({ left, top });
  }, [anchor.left, anchor.top, anchor.bottom]);
  return toTop(
    <div
      ref={box}
      className="floating-pop"
      style={pos ? { left: pos.left, top: pos.top } : { left: anchor.left, top: anchor.top, visibility: "hidden" }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
  );
}
