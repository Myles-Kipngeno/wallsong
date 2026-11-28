import { useState, type CSSProperties, type ReactNode } from "react";
import { call } from "../lib/bus";
import { DEFAULT_DOCK_ITEMS, saveSettings, type DockItem, type DockTileType, type Settings } from "../lib/settings";
import type { SessionInfo, ShelfItem, WsState } from "../lib/types";
import { DesktopPanel } from "./DesktopPanel";
import { Icon } from "./icons";
import type { Open } from "./Overlay";
import { BatteryTile } from "./tiles/BatteryTile";
import { CalendarTile } from "./tiles/CalendarTile";
import { ClockTile } from "./tiles/ClockTile";
import { ControlsTile, type ControlsPopover } from "./tiles/ControlsTile";
import { DesktopTile } from "./tiles/DesktopTile";
import { useBattery, usePoll, useRecycleBin } from "./tiles/hooks";
import { NowPlayingTile } from "./tiles/NowPlayingTile";
import { PinTile } from "./tiles/PinTile";
import { RecycleTile } from "./tiles/RecycleTile";
import { WeatherTile } from "./tiles/WeatherTile";
import "./dock.css";

/** Tile widths, as shares of the screen height (they're 6.4vh tall). */
const TILE_WIDTH_VH: Record<DockTileType, number> = {
  clock: 8,
  nowPlaying: 26,
  controls: 20,
  weather: 18,
  calendar: 7,
  battery: 7,
  desktop: 7,
  recycle: 6.4,
  pin: 6.4,
};

const TILE_NAMES: Record<Exclude<DockTileType, "pin">, string> = {
  clock: "Clock",
  nowPlaying: "Now playing",
  controls: "Controls",
  weather: "Weather",
  calendar: "Calendar",
  battery: "Battery",
  desktop: "Desktop",
  recycle: "Recycle Bin",
};

/** How often the Desktop tile's peek refreshes (the panel refreshes faster while open). */
const DESKTOP_PEEK_MS = 60_000;

const itemKey = (item: DockItem) => (item.type === "pin" ? `pin:${item.path}` : item.type);

export function saveDockItems(items: DockItem[]) {
  void saveSettings({ dock: { items } });
}

/** Where the Dock sits: its centre, and its bottom edge's distance from the window's bottom (px). */
export interface DockPlace {
  centerX: number;
  bottom: number;
}

export function Dock({
  ws,
  settings,
  sessions,
  place,
  open,
  setOpen,
  editing,
  setEditing,
  iconRow,
  onOpenPlayer,
  onPlayerMenu,
  onDockMenu,
  onPinMenu,
  onOpenSearch,
  onOpenSettings,
  onControlsPopover,
}: {
  ws: WsState | null;
  settings: Settings;
  /** Apps Windows lists as players (the Controls tile's source button). */
  sessions: SessionInfo[];
  place: DockPlace;
  open: Open;
  setOpen: React.Dispatch<React.SetStateAction<Open>>;
  editing: boolean;
  setEditing: (on: boolean) => void;
  /** Search, settings and song-list buttons: sit above the Dock's right end. */
  iconRow: ReactNode;
  onOpenPlayer: (from: HTMLElement) => void;
  onPlayerMenu: (x: number, y: number) => void;
  onDockMenu: (x: number, y: number) => void;
  onPinMenu: (pin: Extract<DockItem, { type: "pin" }>, x: number, y: number) => void;
  onOpenSearch: () => void;
  onOpenSettings: (section?: string) => void;
  /** The Controls tile's popovers: drawn by the control layer, upward from the tile. */
  onControlsPopover: (name: ControlsPopover, button: HTMLElement) => void;
}) {
  const dock = settings.dock;
  const battery = useBattery();
  const bin = useRecycleBin();
  const desktopItems = usePoll<ShelfItem[]>("shelf_desktop", {}, DESKTOP_PEEK_MS);
  const [pinMode, setPinMode] = useState(false);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  const folded = dock.folded && !editing;
  // Keep each tile's place in the saved list: the battery tile may be hidden (no battery).
  const shown = dock.items.map((item, index) => ({ item, index })).filter(({ item }) => item.type !== "battery" || battery?.hasBattery);
  const pinned = new Set(dock.items.flatMap((i) => (i.type === "pin" ? [i.path] : [])));
  const missing = (Object.keys(TILE_NAMES) as Array<keyof typeof TILE_NAMES>).filter(
    (type) => !dock.items.some((i) => i.type === type) && (type !== "battery" || battery?.hasBattery),
  );

  const pin = (item: ShelfItem) => {
    if (pinned.has(item.path)) return;
    saveDockItems([...dock.items, { type: "pin", path: item.path, name: item.name }]);
  };
  const unpin = (path: string) => saveDockItems(dock.items.filter((i) => !(i.type === "pin" && i.path === path)));
  const remove = (index: number) => saveDockItems(dock.items.filter((_, i) => i !== index));
  const add = (type: keyof typeof TILE_NAMES) => saveDockItems([...dock.items, { type } as DockItem]);
  const move = (from: number, to: number) => {
    if (from === to) return;
    const next = dock.items.slice();
    const [moved] = next.splice(from, 1);
    next.splice(from < to ? to - 1 : to, 0, moved);
    saveDockItems(next);
  };

  /** A click on a tile, or Enter/Space on it (`byKey`). */
  const activate = (item: DockItem, el: HTMLElement, byKey = false) => {
    if (editing) return;
    switch (item.type) {
      case "nowPlaying":
        // Clicks open the card from the art or the title (their own handlers); the keyboard from the tile.
        if (byKey && ws?.track) onOpenPlayer(el);
        break;
      case "weather":
        if (dock.weatherLat === null) onOpenSettings("dock");
        break;
      case "calendar":
        // Windows Calendar; if it isn't installed, nothing happens.
        void call("shelf_open", { path: "outlookcal:" }).catch(() => {});
        break;
      case "desktop":
        setPinMode(false);
        setOpen((o) => (o === "desktop" ? null : "desktop"));
        break;
      case "pin":
        void call("shelf_open", { path: item.path }).catch(() => {});
        break;
      case "recycle":
        void call("shelf_open", { path: "shell:RecycleBinFolder" }).catch(() => {});
        break;
      default:
        break;
    }
  };

  const contextMenu = (item: DockItem | null, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (editing) return;
    if (item?.type === "clock") void saveSettings({ dock: { clockStyle: dock.clockStyle === "analog" ? "digital" : "analog" } });
    else if (item?.type === "nowPlaying" || item?.type === "controls") onPlayerMenu(e.clientX, e.clientY);
    else if (item?.type === "pin") onPinMenu(item, e.clientX, e.clientY);
    else onDockMenu(e.clientX, e.clientY);
  };

  const tileBody = (item: DockItem): ReactNode => {
    switch (item.type) {
      case "clock":
        return <ClockTile style={dock.clockStyle} hours={settings.clock.hours} />;
      case "nowPlaying":
        return <NowPlayingTile ws={ws} onOpenSearch={onOpenSearch} onOpenPlayer={onOpenPlayer} />;
      case "controls":
        return <ControlsTile ws={ws} settings={settings} sessions={sessions} open={open} onPopover={onControlsPopover} />;
      case "weather":
        return <WeatherTile dock={dock} />;
      case "calendar":
        return <CalendarTile />;
      case "battery":
        return battery ? <BatteryTile battery={battery} /> : null;
      case "desktop":
        return <DesktopTile items={desktopItems} />;
      case "pin":
        return <PinTile path={item.path} name={item.name} />;
      case "recycle":
        return <RecycleTile bin={bin} />;
    }
  };

  return (
    <div className="dk-wrap" style={{ left: place.centerX, bottom: place.bottom }}>
      <div className="dk-row">{iconRow}</div>

      {open === "desktop" && (
        <DesktopPanel
          pinMode={pinMode}
          pinned={pinned}
          onPin={pin}
          onUnpin={unpin}
          onClose={() => {
            setPinMode(false);
            setOpen(null);
          }}
        />
      )}

      {open === "addTile" && editing && (
        <div className="dk-picker" data-hit>
          <p className="pop-title">Add to the Dock</p>
          {missing.map((type) => (
            <button key={type} className="pop-item" onClick={() => (add(type), setOpen(null))}>
              {TILE_NAMES[type]}
            </button>
          ))}
          {missing.length === 0 && <p className="pop-hint">Every tile is already in the Dock.</p>}
          <hr />
          <button
            className="pop-item"
            onClick={() => {
              setPinMode(true);
              setOpen("desktop");
            }}
          >
            Pin something from the Desktop…
          </button>
        </div>
      )}

      <div className={`dk${folded ? " folded" : ""}${editing ? " editing" : ""}`} data-hit onContextMenu={(e) => contextMenu(null, e)}>
        <button className="dk-chev" onClick={() => void saveSettings({ dock: { folded: !dock.folded } })} title={folded ? "Show the whole Dock" : "Fold the Dock down to the song"}>
          <Icon name="chevronDown" size={16} />
        </button>

        {shown.map(({ item, index }) => {
          const away = folded && item.type !== "nowPlaying";
          const name = item.type === "pin" ? item.name : TILE_NAMES[item.type];
          return (
            <div
              key={itemKey(item)}
              role="button"
              tabIndex={away ? -1 : 0}
              aria-label={name}
              className={`dk-tile dk-${item.type}${away ? " away" : ""}${item.type === "desktop" ? " pop-trigger" : ""}${dragOver === index && dragFrom !== index ? " drop-before" : ""}${dragFrom === index ? " dragging" : ""}`}
              style={{ "--w": `${TILE_WIDTH_VH[item.type]}vh` } as CSSProperties}
              draggable={editing}
              onDragStart={(e) => {
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData("text/plain", String(index));
                setDragFrom(index);
              }}
              onDragOver={(e) => {
                if (dragFrom === null) return;
                e.preventDefault();
                setDragOver(index);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragFrom !== null) move(dragFrom, index);
                setDragFrom(null);
                setDragOver(null);
              }}
              onDragEnd={() => {
                setDragFrom(null);
                setDragOver(null);
              }}
              onClick={(e) => activate(item, e.currentTarget)}
              onKeyDown={(e) => {
                // Only the tile's own keys: Enter on one of its buttons is that button's.
                if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) activate(item, e.currentTarget, true);
              }}
              onContextMenu={(e) => contextMenu(item, e)}
            >
              <div className="dk-tile-body">{tileBody(item)}</div>
              {editing && (
                <button
                  className="dk-remove"
                  title={`Remove ${name}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(index);
                  }}
                >
                  −
                </button>
              )}
            </div>
          );
        })}

        {editing && (
          <>
            <button
              className={`dk-tile dk-add pop-trigger${dragOver === dock.items.length ? " drop-before" : ""}`}
              style={{ "--w": `${TILE_WIDTH_VH.pin}vh` } as CSSProperties}
              title="Add a tile"
              onClick={() => setOpen((o) => (o === "addTile" ? null : "addTile"))}
              onDragOver={(e) => {
                if (dragFrom === null) return;
                e.preventDefault();
                setDragOver(dock.items.length);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragFrom !== null) move(dragFrom, dock.items.length);
                setDragFrom(null);
                setDragOver(null);
              }}
            >
              <Icon name="plus" size={20} />
            </button>
            <button className="dk-done" onClick={() => setEditing(false)}>
              Done
            </button>
          </>
        )}
      </div>
    </div>
  );
}

/** Puts every default tile back, keeping your pins. */
export function resetDock(settings: Settings) {
  const pins = settings.dock.items.filter((i) => i.type === "pin");
  void saveSettings({ dock: { items: [...DEFAULT_DOCK_ITEMS, ...pins], folded: false } });
}
