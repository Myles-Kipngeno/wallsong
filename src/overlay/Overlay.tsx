import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { call, on } from "../lib/bus";
import { inTauri } from "../lib/native";
import { usePalette } from "../lib/palette";
import { saveSettings, useSettings, type DockItem } from "../lib/settings";
import type { AlbumPage, ArtistPage, MusicItem, SearchResults } from "../lib/types";
import { AlbumView, ArtistView, SearchView } from "./Browse";
import { Dock, saveDockItems, type DockPlace } from "./Dock";
import { ContinuePlaying, NowStarting } from "./Library";
import { anchorOf, ContextMenu, Floating, type Anchor, type MenuEntry } from "./menus";
import { cardSpot, FloatingPlayer, MINI_MARGIN, playerMenu, useLyricLine, type OverlayCmd } from "./PlayerCard";
import { IconRow, PlayerBar } from "./PlayerBar";
import { MorePopover, SleepPopover, SourcePopover, TimingPopover, VolumePopover } from "./popovers";
import { SettingsPanel } from "./SettingsPanel";
import { Icon } from "./icons";
import { api, command, useSessions, useWorkArea, useWs } from "./shared";
import type { ControlsPopover } from "./tiles/ControlsTile";
import "./overlay.css";

type View =
  | { kind: "search" }
  | { kind: "artist"; browseId: string; name: string }
  | { kind: "album"; browseId: string; name: string }
  | { kind: "settings"; section?: string };

/** What's open on the control layer, besides the centre card. Only one at a time. */
export type Open =
  | null
  | "source" | "more" | "timing" | "sleep" | "volume" // player popovers
  | "list" //                                             Continue Playing dropdown
  | "suggestions"
  | "desktop" //                                          the Dock's Desktop panel
  | "addTile" //                                          Edit Dock's "+" picker
  | "dockMenu" | "pinMenu" | "playerMenu"; //             right-click menus

const SEARCH_DEBOUNCE_MS = 220;
const SUGGEST_DEBOUNCE_MS = 100;
/** Clicks on these don't close what's open: the open piece itself, and the buttons that toggle it. */
const KEEPS_OPEN = ".popover, .pop-trigger, .continue-menu, .suggestions, .search-pill, .context-menu, .floating-pop, .dk-panel, .dk-picker";
/** The popovers that float: from the player menu, the card's buttons, or the Dock's Controls tile. */
const POPOVERS = ["source", "timing", "sleep", "volume", "more"] as const;
type PopoverName = (typeof POPOVERS)[number];
const isPopover = (o: Open): o is PopoverName => POPOVERS.includes(o as PopoverName);
/** Where a floating popover points, and whether its volume slider stands upright (the card's). */
type PopAt = Anchor & { upright: boolean };
/** A saved "card open" comes back at startup only if a song starts playing within this long. */
const CARD_RESTORE_MS = 5000;

/**
 * Tells the core where the clickable pieces are (anything marked data-hit), so the
 * mouse passes through to the desktop everywhere else. Returns `reportNow` for
 * changes that can't wait for the next tick (opening or closing something).
 */
function useHitRegions(): () => void {
  const last = useRef("");
  const rafId = useRef<number | null>(null);

  const reportNow = useCallback(() => {
    if (!inTauri) return;
    if (rafId.current !== null) {
      cancelAnimationFrame(rafId.current);
      rafId.current = null;
    }
    const rects = [...document.querySelectorAll<HTMLElement>("[data-hit]")]
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0)
      .map((r) => [Math.floor(r.left), Math.floor(r.top), Math.ceil(r.width), Math.ceil(r.height)]);
    const key = JSON.stringify(rects);
    if (key !== last.current) {
      last.current = key;
      void call("overlay_regions", { rects }).catch(() => {});
    }
  }, []);

  const scheduleReport = useCallback(() => {
    if (rafId.current !== null) return;
    rafId.current = requestAnimationFrame(() => {
      rafId.current = null;
      reportNow();
    });
  }, [reportNow]);

  useEffect(() => {
    if (!inTauri) return;
    reportNow();

    const ro = new ResizeObserver(scheduleReport);
    const observeHits = () => {
      ro.disconnect();
      ro.observe(document.body);
      document.querySelectorAll<HTMLElement>("[data-hit]").forEach((el) => ro.observe(el));
    };
    observeHits();

    const mo = new MutationObserver((records) => {
      if (records.some((r) => r.type === "childList" || r.attributeName === "data-hit")) {
        observeHits();
      }
      scheduleReport();
    });
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class", "data-hit"] });

    document.body.addEventListener("transitionend", scheduleReport);
    window.addEventListener("resize", scheduleReport);

    return () => {
      if (rafId.current !== null) cancelAnimationFrame(rafId.current);
      mo.disconnect();
      ro.disconnect();
      document.body.removeEventListener("transitionend", scheduleReport);
      window.removeEventListener("resize", scheduleReport);
    };
  }, [reportNow, scheduleReport]);

  return reportNow;
}

/** The control layer: the Dock (or the player bar), song list, search and pages, settings. */
export default function Overlay() {
  const ws = useWs();
  const settings = useSettings();
  const sessions = useSessions();
  const workArea = useWorkArea();
  const lyric = useLyricLine();
  const [c1, c2, c3] = usePalette(ws?.track?.artwork);
  /** The tile (or bar art) the player card grows out of when it opens. */
  const [playerFrom, setPlayerFrom] = useState<HTMLElement | null>(null);
  const [stack, setStack] = useState<View[]>([]);
  const [open, setOpen] = useState<Open>(null);
  /** Where a right-click menu was opened, and for which pin. */
  const [menuAt, setMenuAt] = useState<{ x: number; y: number; pin?: Extract<DockItem, { type: "pin" }> } | null>(null);
  /** Where a floating popover points (null: inline in the player bar). */
  const [popAnchor, setPopAnchor] = useState<PopAt | null>(null);
  /** Startup: the card stays closed until a song is playing (see CARD_RESTORE_MS). */
  const [cardHeld, setCardHeld] = useState(true);
  const [editing, setEditing] = useState(false);
  const collapsed = settings.controls.listCollapsed;
  const dockMode = settings.controls.bottom === "dock";
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [results, setResults] = useState<SearchResults | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [artist, setArtist] = useState<{ page: ArtistPage | null; loading: boolean; error: string | null }>({ page: null, loading: false, error: null });
  const [album, setAlbum] = useState<{ page: AlbumPage | null; loading: boolean; error: string | null }>({ page: null, loading: false, error: null });
  const input = useRef<HTMLInputElement>(null);
  const searchToken = useRef(0);
  const artistToken = useRef(0);
  const albumToken = useRef(0);
  const lastSearched = useRef("");

  const reportNow = useHitRegions();

  const view = stack[stack.length - 1] ?? null;
  const searchOpen = view?.kind === "search" || (stack.some((v) => v.kind === "search") && view?.kind !== "settings");
  // Whether the open piece is actually on screen (a late reply or a vanished track can leave it with nothing to show).
  const openShown =
    open === "suggestions"
      ? searchOpen && suggestions.length > 0
      : open === "list"
        ? !collapsed
        : open === "more"
          ? !!ws?.track
          : open === "desktop"
            ? dockMode
            : open === "addTile"
              ? dockMode && editing
              : open === "dockMenu" || open === "pinMenu" || open === "playerMenu"
                ? menuAt !== null
                : open !== null;
  const anythingOpen = openShown || view !== null;

  // Never keep an invisible menu "open": its scrim would swallow clicks meant for the desktop.
  useEffect(() => {
    if (open !== null && !openShown) setOpen(null);
  }, [open, openShown]);

  // A popover opened from the player menu floats; once it closes, the bar's own popovers sit inline again.
  useEffect(() => {
    if (!isPopover(open)) setPopAnchor(null);
  }, [open]);

  const push = useCallback((v: View) => setStack((s) => [...s.filter((x) => x.kind !== v.kind || x.kind === "artist" || x.kind === "album"), v].slice(-6)), []);
  const close = useCallback(() => setStack([]), []);
  const back = useCallback(() => setStack((s) => s.slice(0, -1)), []);
  /** Closes every menu, popover and card. */
  const closeAll = useCallback(() => {
    setOpen(null);
    setStack([]);
    input.current?.blur();
  }, []);

  // Re-measure as soon as something opens or closes: the scrim must catch the very
  // next click, and after closing, clicks must reach the desktop again at once.
  useLayoutEffect(() => {
    reportNow();
  }, [open, stack, anythingOpen, editing, reportNow]);

  const openSearch = useCallback(() => {
    setStack((s) => (s[s.length - 1]?.kind === "search" ? s : [{ kind: "search" }]));
    requestAnimationFrame(() => {
      input.current?.focus();
      input.current?.select();
    });
  }, []);
  const openSettings = useCallback((section?: string) => setStack([{ kind: "settings", section }]), []);

  // Tray menu and Ctrl+Alt+Space.
  useEffect(() => {
    const offs: Array<() => void> = [];
    let disposed = false;
    const keep = (u: () => void) => (disposed ? u() : offs.push(u));
    on("open-search", openSearch).then(keep);
    on("open-settings", () => openSettings()).then(keep);
    return () => {
      disposed = true;
      offs.forEach((o) => o());
    };
  }, [openSearch, openSettings]);

  // Esc closes a menu, then leaves Edit Dock, then goes back, then closes the card.
  // Switching to another app folds everything away.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (open) setOpen(null);
      else if (editing) setEditing(false);
      else if (stack.length > 1) back();
      else {
        close();
        input.current?.blur();
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", closeAll);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", closeAll);
    };
  }, [open, editing, stack.length, back, close, closeAll]);

  const runSearch = useCallback((q: string) => {
    const text = q.trim();
    if (text.length < 2) return;
    lastSearched.current = text;
    const token = ++searchToken.current;
    setSearching(true);
    setSearchError(null);
    setSuggestions([]);
    setOpen((o) => (o === "suggestions" ? null : o));
    api
      .search(text)
      .then((r) => token === searchToken.current && setResults(r))
      .catch((e) => token === searchToken.current && setSearchError(String(e)))
      .finally(() => token === searchToken.current && setSearching(false));
  }, []);

  // Search as you type, after a short pause; suggestions a little sooner.
  useEffect(() => {
    const text = query.trim();
    if (text.length < 2 || text === lastSearched.current) return;
    const s = setTimeout(() => {
      api
        .suggest(text)
        .then((r) => {
          const list = r.queries.filter((x) => x.toLowerCase() !== text.toLowerCase());
          setSuggestions(list);
          // Show them unless another menu is open.
          setOpen((o) => (list.length > 0 ? (o ?? "suggestions") : o === "suggestions" ? null : o));
        })
        .catch(() => setSuggestions([]));
    }, SUGGEST_DEBOUNCE_MS);
    const id = setTimeout(() => runSearch(text), SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(s);
      clearTimeout(id);
    };
  }, [query, runSearch]);

  const openArtist = useCallback(
    (browseId: string, name: string) => {
      const token = ++artistToken.current;
      push({ kind: "artist", browseId, name });
      setArtist({ page: null, loading: true, error: null });
      api
        .artist(browseId)
        .then((page) => token === artistToken.current && setArtist({ page, loading: false, error: null }))
        .catch((e) => token === artistToken.current && setArtist({ page: null, loading: false, error: String(e) }));
    },
    [push],
  );

  const openAlbum = useCallback(
    (browseId: string, name: string) => {
      const token = ++albumToken.current;
      push({ kind: "album", browseId, name });
      setAlbum({ page: null, loading: true, error: null });
      api
        .album(browseId)
        .then((page) => token === albumToken.current && setAlbum({ page, loading: false, error: null }))
        .catch((e) => token === albumToken.current && setAlbum({ page: null, loading: false, error: String(e) }));
    },
    [push],
  );

  const openItem = useCallback(
    (item: MusicItem) => {
      if (item.videoId && (item.kind === "song" || item.kind === "video" || item.kind === "episode")) {
        // Get out of the way so the video and the "now starting" card show.
        command({ type: "play", item });
        close();
      } else if (item.browseId && item.kind === "artist") {
        openArtist(item.browseId, item.title);
      } else if (item.browseId) {
        openAlbum(item.browseId, item.title);
      } else if (item.videoId) {
        command({ type: "play", item });
        close();
      }
    },
    [openArtist, openAlbum, close],
  );

  const goToArtist = useCallback(
    (name: string) => {
      api
        .search(name)
        .then((r) => {
          const hit = r.top?.kind === "artist" ? r.top : r.artists[0];
          if (hit?.browseId) openArtist(hit.browseId, hit.title);
        })
        .catch(() => {});
    },
    [openArtist],
  );

  const goToAlbum = useCallback(
    (name: string, artistName: string) => {
      api
        .search(`${name} ${artistName}`)
        .then((r) => {
          const hit = r.top?.kind === "album" ? r.top : r.albums[0];
          if (hit?.browseId) openAlbum(hit.browseId, hit.title);
        })
        .catch(() => {});
    },
    [openAlbum],
  );

  // ---------- the floating player card ----------

  const openPlayer = useCallback((from: HTMLElement) => {
    setPlayerFrom(from);
    setCardHeld(false);
    void saveSettings({ card: { open: true } });
  }, []);

  // Wallsong starts with the card closed. If it was open last time, it comes back
  // once a song is playing (Spotify already going, say); if nothing plays within
  // a few seconds, it's saved as closed. Opening it yourself ends the wait.
  const cardSaved = settings.card.open;
  const anythingPlaying = !!ws?.playing && !!ws.track;
  useEffect(() => {
    if (cardHeld && cardSaved && anythingPlaying) setCardHeld(false);
  }, [cardHeld, cardSaved, anythingPlaying]);
  const latestCard = useRef({ cardSaved, cardHeld });
  latestCard.current = { cardSaved, cardHeld };
  useEffect(() => {
    const id = setTimeout(() => {
      if (!latestCard.current.cardHeld) return;
      if (latestCard.current.cardSaved) void saveSettings({ card: { open: false } });
      setCardHeld(false);
    }, CARD_RESTORE_MS);
    return () => clearTimeout(id);
  }, []);
  const cardShown = settings.card.open && !cardHeld;

  // "Keep above all windows": the card lives in its own always-on-top window instead.
  const miniWanted = inTauri && cardShown && settings.card.onTop;
  const latest = useRef({ settings, workArea });
  latest.current = { settings, workArea };
  useEffect(() => {
    if (!inTauri) return;
    if (!miniWanted) {
      void call("mini_close").catch(() => {});
      return;
    }
    const spot = cardSpot(latest.current.settings, latest.current.workArea);
    const margin = (MINI_MARGIN * window.innerHeight) / 100;
    void call("mini_open", { width: spot.w + 2 * margin, height: spot.h + 2 * margin, x: spot.x - margin, y: spot.y - margin }).catch(() => {});
  }, [miniWanted]);

  // The card's own window asks for things only the control layer can show.
  useEffect(() => {
    let off: (() => void) | undefined;
    let disposed = false;
    on<OverlayCmd>("overlay-cmd", (cmd) => {
      if (cmd.type === "artist") goToArtist(cmd.name);
      else openSettings(cmd.section);
    }).then((u) => (disposed ? u() : (off = u)));
    return () => {
      disposed = true;
      off?.();
    };
  }, [goToArtist, openSettings]);

  /** Opens one of the player popovers next to something (a card button, the card, or the Now Playing tile). */
  const openPopoverAt = (name: PopoverName, at: Element | null) => {
    if (!at) return;
    setPopAnchor({ ...anchorOf(at), upright: true });
    setOpen(name);
  };

  /**
   * The Controls tile: the popover opens upward from the top of the tile, lined up
   * with its button. Pressing the button of the open one closes it.
   */
  const toggleTilePopover = (name: ControlsPopover, button: HTMLElement) => {
    if (open === name) {
      setOpen(null);
      return;
    }
    const b = button.getBoundingClientRect();
    const tile = (button.closest(".dk-tile") ?? button).getBoundingClientRect();
    setPopAnchor({ left: b.left, right: b.right, top: tile.top, bottom: tile.bottom, upright: false });
    setOpen(name);
  };

  const toggleOnTop = () => {
    const on = !settings.card.onTop;
    // Leave the desktop exactly where the card is now.
    const card = document.querySelector(".pc-anchor")?.getBoundingClientRect();
    const here = on && card ? { x: card.left / window.innerWidth, y: card.top / window.innerHeight } : {};
    void saveSettings({ card: { onTop: on, ...here } });
  };

  const playerEntries = (): MenuEntry[] =>
    playerMenu(settings, {
      // Next to the card if it's open, else next to the song in the Dock (or the bar).
      popover: (name) => openPopoverAt(name, document.querySelector(".pc-anchor .pc") ?? document.querySelector(".dk-nowPlaying, .now-art")),
      edit: () => openSettings("card"),
      toggleOnTop,
      // Anything you pick here is you using the card: it shows straight away.
    }).map((entry) => (entry === "divider" ? entry : { ...entry, onClick: () => (setCardHeld(false), entry.onClick()) }));

  // ---------- right-click menus ----------

  const showMenu = (kind: "dockMenu" | "pinMenu" | "playerMenu", x: number, y: number, pin?: Extract<DockItem, { type: "pin" }>) => {
    setMenuAt({ x, y, pin });
    setOpen(kind);
  };

  const menuEntries = (): MenuEntry[] => {
    if (open === "dockMenu") {
      return [
        { label: "Edit Dock", onClick: () => setEditing(true) },
        { label: "Dock settings…", onClick: () => openSettings("dock") },
      ];
    }
    if (open === "pinMenu" && menuAt?.pin) {
      const pin = menuAt.pin;
      return [
        { label: "Open", onClick: () => void call("shelf_open", { path: pin.path }).catch(() => {}) },
        { label: "Show in folder", onClick: () => void call("shelf_reveal", { path: pin.path }).catch(() => {}) },
        "divider",
        { label: "Unpin", onClick: () => saveDockItems(settings.dock.items.filter((i) => !(i.type === "pin" && i.path === pin.path))) },
      ];
    }
    return [];
  };

  // ---------- layout ----------

  const [wx, wy, ww, wh] = workArea;
  const vh = window.innerHeight / 100;
  // The Dock's bottom edge sits 1.2vh above the taskbar, wherever the work area ends.
  const dockBottom = Math.max(0, window.innerHeight - (wy + wh)) + 1.2 * vh;
  const dockPlace: DockPlace = { centerX: wx + ww / 2, bottom: dockBottom };
  // Centre cards stop 2vh above the icon row that sits on the Dock.
  const dockClear = dockBottom + Math.max(64, 8 * vh) + 0.6 * vh + 3.4 * vh + 2 * vh;

  const title =
    view?.kind === "search" ? (query.trim() ? `Results for "${query.trim()}"` : "Search") : view?.kind === "settings" ? "Settings" : (view?.name ?? "");

  const rowProps = {
    ws,
    open: popAnchor && isPopover(open) ? null : open,
    searchOpen,
    query,
    onQuery: setQuery,
    onSubmit: () => runSearch(query),
    onOpenSearch: () => (view?.kind === "search" ? close() : openSearch()),
    onOpenSettings: () => (view?.kind === "settings" ? close() : openSettings()),
    inputRef: input,
    collapsed,
    onCollapse: () => void saveSettings({ controls: { listCollapsed: !collapsed } }),
    suggestions,
    onPickSuggestion: (q: string) => {
      setQuery(q);
      runSearch(q);
    },
  };

  const style = { "--c1": c1, "--c2": c2, "--c3": c3, "--dock-clear": `${dockClear}px` } as CSSProperties;

  return (
    <div
      className={`overlay${view ? " busy" : ""}${dockMode ? " dock-mode" : ""}`}
      style={style}
      // A click on another Wallsong piece closes an open menu, like any app's menus.
      onPointerDownCapture={(e) => {
        if (open && !(e.target as Element).closest(KEEPS_OPEN)) setOpen(null);
      }}
      // Wallsong has its own right-click menus; never the browser's.
      onContextMenu={(e) => {
        if (!(e.target as Element).closest("input")) e.preventDefault();
      }}
    >
      {/* While anything is open the whole screen belongs to Wallsong: one click outside closes it
          and doesn't fall through to the desktop. Nothing open, no scrim: clicks pass through again. */}
      {anythingOpen && <div className="scrim" data-hit onPointerDown={closeAll} />}

      {!collapsed && <ContinuePlaying ws={ws} settings={settings} sessions={sessions} open={open} setOpen={setOpen} />}

      {!view && <NowStarting ws={ws} />}

      {view && (
        <section className={`card card-${view.kind}`} data-hit key={view.kind === "artist" || view.kind === "album" ? view.browseId : view.kind}>
          <header className="card-head">
            {stack.length > 1 && (
              <button className="ib" onClick={back} title="Back (Esc)">
                <Icon name="back" size={16} />
              </button>
            )}
            <span className="card-title">{title}</span>
            <button className="ib" onClick={close} title="Close">
              <Icon name="close" size={16} />
            </button>
          </header>
          <div className="card-body">
            {view.kind === "search" && <SearchView query={query} results={results} searching={searching} error={searchError} actions={{ open: openItem }} />}
            {view.kind === "artist" && <ArtistView page={artist.page} loading={artist.loading} error={artist.error} actions={{ open: openItem }} />}
            {view.kind === "album" && <AlbumView page={album.page} loading={album.loading} error={album.error} />}
            {view.kind === "settings" && (
              <SettingsPanel
                settings={settings}
                section={view.section}
                ws={ws}
                c1={c1}
                onEditDock={() => {
                  close();
                  if (dockMode) setEditing(true);
                }}
              />
            )}
          </div>
        </section>
      )}

      {ws?.notice && <div className="toast">{ws.notice}</div>}

      {dockMode ? (
        <Dock
          ws={ws}
          settings={settings}
          sessions={sessions}
          place={dockPlace}
          open={open}
          setOpen={setOpen}
          editing={editing}
          setEditing={(on) => {
            setEditing(on);
            if (!on) setOpen((o) => (o === "addTile" ? null : o));
          }}
          iconRow={<IconRow {...rowProps} />}
          onOpenPlayer={openPlayer}
          onPlayerMenu={(x, y) => showMenu("playerMenu", x, y)}
          onDockMenu={(x, y) => showMenu("dockMenu", x, y)}
          onPinMenu={(pin, x, y) => showMenu("pinMenu", x, y, pin)}
          onOpenSearch={openSearch}
          onOpenSettings={(section) => openSettings(section)}
          onControlsPopover={toggleTilePopover}
        />
      ) : (
        <PlayerBar {...rowProps} settings={settings} sessions={sessions} setOpen={setOpen} onGoToArtist={goToArtist} onGoToAlbum={goToAlbum} onOpenPlayer={openPlayer} />
      )}

      {cardShown && !miniWanted && (
        <FloatingPlayer
          ws={ws}
          settings={settings}
          lyric={lyric}
          c1={c1}
          workArea={workArea}
          from={playerFrom}
          onMenu={(x, y) => showMenu("playerMenu", x, y)}
          onPopover={(name, at) => openPopoverAt(name, at)}
          onExpand={() => ws?.track?.artists[0] && goToArtist(ws.track.artists[0])}
          onSearch={openSearch}
        />
      )}

      {menuAt && (open === "dockMenu" || open === "pinMenu") && <ContextMenu x={menuAt.x} y={menuAt.y} entries={menuEntries()} onClose={() => setOpen(null)} />}
      {menuAt && open === "playerMenu" && <ContextMenu x={menuAt.x} y={menuAt.y} entries={playerEntries()} onClose={() => setOpen(null)} />}

      {popAnchor && isPopover(open) && (
        <Floating anchor={popAnchor}>
          {open === "source" && <SourcePopover settings={settings} sessions={sessions} />}
          {open === "sleep" && <SleepPopover ws={ws} onDone={() => setOpen(null)} />}
          {open === "timing" && <TimingPopover ws={ws} />}
          {open === "volume" && <VolumePopover ws={ws} vertical={popAnchor.upright} />}
          {open === "more" && ws?.track && (
            <MorePopover
              track={ws.track}
              item={ws.item}
              onGoToArtist={goToArtist}
              onGoToAlbum={goToAlbum}
              onSearch={(q) => {
                setQuery(q);
                openSearch();
              }}
              onDone={() => setOpen(null)}
            />
          )}
        </Floating>
      )}
    </div>
  );
}
