import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { call } from "../lib/bus";
import { inTauri } from "../lib/native";
import type { ShelfItem } from "../lib/types";
import { Icon } from "./icons";
import { ContextMenu, type MenuEntry } from "./menus";

/** How often the open panel re-reads its folder (things you add or delete show up). */
const REFRESH_MS = 10_000;
/** A second click within this long is a double-click, so a single click on a folder waits this long before browsing. */
const DOUBLE_CLICK_MS = 260;

interface Crumb {
  name: string;
  path: string;
}

/**
 * Your desktop as a grid, opened from the Dock's Desktop tile. Browse into folders,
 * open anything, pin things to the Dock. In pin mode (from Edit Dock) a click pins.
 */
export const DesktopPanel = memo(function DesktopPanel({
  pinMode,
  pinned,
  onPin,
  onUnpin,
  onClose,
}: {
  pinMode: boolean;
  /** Paths already pinned to the Dock. */
  pinned: Set<string>;
  onPin: (item: ShelfItem) => void;
  onUnpin: (path: string) => void;
  onClose: () => void;
}) {
  const [trail, setTrail] = useState<Crumb[]>([]);
  const [items, setItems] = useState<ShelfItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(36);
  const [menu, setMenu] = useState<{ x: number; y: number; item: ShelfItem } | null>(null);
  const clickTimer = useRef<number | undefined>(undefined);
  const folder = trail[trail.length - 1] ?? null;

  const load = useCallback(() => {
    if (!inTauri) {
      setItems([]);
      setError("The desktop shows here in the Wallsong app.");
      return;
    }
    const request = folder ? call<ShelfItem[]>("shelf_folder", { path: folder.path }) : call<ShelfItem[]>("shelf_desktop");
    void request
      .then((list) => {
        setItems(list);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }, [folder]);

  useEffect(() => {
    setItems(null);
    setQuery("");
    setLimit(36);
    load();
    const id = setInterval(load, REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  useEffect(() => {
    setLimit(36);
  }, [query]);

  useEffect(() => () => clearTimeout(clickTimer.current), []);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q && items ? items.filter((i) => i.name.toLowerCase().includes(q)) : items;
  }, [items, query]);

  const open = (path: string) => {
    void call("shelf_open", { path }).catch(() => {});
    onClose();
  };
  const reveal = (path: string) => void call("shelf_reveal", { path }).catch(() => {});

  const openInExplorer = () => {
    if (folder) open(folder.path);
    else
      void call<string>("shelf_desktop_dir")
        .then((dir) => open(dir))
        .catch(() => {});
  };

  const click = (item: ShelfItem, e: React.MouseEvent) => {
    if (pinMode) {
      onPin(item);
      onClose();
      return;
    }
    if (!item.isDir) {
      open(item.path);
      return;
    }
    // A folder: browse into it, unless this turns out to be a double-click (open it in File Explorer).
    clearTimeout(clickTimer.current);
    if (e.detail >= 2) {
      open(item.path);
      return;
    }
    clickTimer.current = window.setTimeout(() => setTrail((t) => [...t, { name: item.name, path: item.path }]), DOUBLE_CLICK_MS);
  };

  const entries = (item: ShelfItem): MenuEntry[] => [
    { label: "Open", onClick: () => open(item.path) },
    { label: "Show in folder", onClick: () => reveal(item.path) },
    pinned.has(item.path) ? { label: "Unpin from Dock", onClick: () => onUnpin(item.path) } : { label: "Pin to Dock", onClick: () => onPin(item) },
    "divider",
    { label: "Copy path", onClick: () => void navigator.clipboard?.writeText(item.path) },
  ];

  return (
    <section className={`dk-panel${pinMode ? " pin-mode" : ""}`} data-hit onPointerDown={() => setMenu(null)} onContextMenu={(e) => e.preventDefault()}>
      <header className="dk-panel-head">
        <nav className="crumbs" aria-label="Folder">
          <button className={trail.length === 0 ? "here" : ""} onClick={() => setTrail([])}>
            Desktop
          </button>
          {trail.map((c, i) => (
            <span key={c.path}>
              <i>›</i>
              <button className={i === trail.length - 1 ? "here" : ""} onClick={() => setTrail(trail.slice(0, i + 1))}>
                {c.name}
              </button>
            </span>
          ))}
        </nav>
        {pinMode && <span className="dk-panel-hint">Pick something to pin to the Dock</span>}
        <label className="dk-panel-search">
          <Icon name="search" size={14} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${folder?.name ?? "Desktop"}`} spellCheck={false} />
        </label>
        <button className="pill-btn" onClick={openInExplorer} title="Open this folder in File Explorer">
          Open in File Explorer
        </button>
        <button className="ib" onClick={onClose} title="Close (Esc)">
          <Icon name="close" size={16} />
        </button>
      </header>

      <div
        className="dk-grid"
        onScroll={(e) => {
          const el = e.currentTarget;
          if (el.scrollTop + el.clientHeight >= el.scrollHeight - 150) {
            setLimit((l) => (shown && l < shown.length ? l + 24 : l));
          }
        }}
      >
        {shown === null &&
          Array.from({ length: 12 }, (_, i) => (
            <div key={i} className="dk-item skeleton" aria-hidden="true">
              <i />
              <b />
            </div>
          ))}
        {shown?.slice(0, limit).map((item) => (
          <button
            key={item.path}
            className={`dk-item${pinned.has(item.path) ? " pinned" : ""}`}
            title={item.path}
            onClick={(e) => click(item, e)}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setMenu({ x: e.clientX, y: e.clientY, item });
            }}
          >
            {item.icon ? <img src={item.icon} alt="" draggable={false} /> : <i className="dk-item-blank" />}
            <span>{item.name}</span>
          </button>
        ))}
        {shown?.length === 0 && <p className="empty">{error ?? (query ? `Nothing called "${query}" here.` : "This folder is empty.")}</p>}
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} entries={entries(menu.item)} onClose={() => setMenu(null)} />}
    </section>
  );
});
