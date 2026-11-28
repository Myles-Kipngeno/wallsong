import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { call, on, send } from "../lib/bus";
import { inTauri } from "../lib/native";
import { mixedLuminance, usePalette } from "../lib/palette";
import { CARD_LAYOUTS, saveSettings, useSettings, type CardLayout, type Settings } from "../lib/settings";
import type { LyricLineNow, WsState } from "../lib/types";
import { Icon, type IconName } from "./icons";
import { anchorOf, ContextMenu, Floating, type Anchor, type MenuEntry } from "./menus";
import { SleepPopover, SourcePopover, TimingPopover, VolumePopover } from "./popovers";
import { Art, command, formatTime, getWsState, livePosition, useSessions, useWs, type WorkArea } from "./shared";
import { subscribeFrame } from "../lib/frame";
import "./playerCard.css";

/**
 * The floating player card. Opens from the Dock's Now Playing tile (or the player
 * bar's art), switches between eight layouts, and either sits on the desktop layer
 * (FloatingPlayer, in the overlay) or in its own always-on-top window (MiniPlayer).
 */

/** Card size per layout: [width, height] as shares of the screen height. */
export const CARD_SIZE: Record<CardLayout, [number, number]> = {
  fullCover: [28, 42],
  halfCover: [28, 38],
  squared: [30, 30],
  compact: [40, 13],
  minimal: [34, 11],
  minimalArt: [34, 11],
  vinyl: [30, 36],
  vinylArt: [30, 36],
};

/** Room left around the card in its own window, for its shadow (each side, share of screen height). */
export const MINI_MARGIN = 2;
/** Layout changes morph over this long. */
const MORPH_MS = 300;
/** The record turns once per this long while playing… */
const VINYL_TURN_MS = 1800;
/** …and winds down to a stop over this long on pause. */
const VINYL_STOP_MS = 800;
/** Layouts that can show the line being sung. */
const LYRIC_LAYOUTS = new Set<CardLayout>(["fullCover", "halfCover", "compact", "minimal", "minimalArt"]);
/** Album-colour layouts switch to dark text when the colour behind it is this light. */
const LIGHT_BACKGROUND = 0.6;

type PopName = "timing" | "sleep" | "source" | "volume";
type Control = "volume" | "shuffle" | "prev" | "play" | "next" | "expand" | "lyrics";

const layoutLabel = (id: CardLayout) => CARD_LAYOUTS.find((l) => l.id === id)?.label ?? id;

/** The lyric line being sung (from the wallpaper's "ws-lyric-line"). */
export function useLyricLine(): LyricLineNow {
  const [line, setLine] = useState<LyricLineNow>({ index: -1, text: "" });
  useEffect(() => {
    let off: (() => void) | undefined;
    let disposed = false;
    on<LyricLineNow>("ws-lyric-line", setLine).then((u) => {
      if (disposed) return u();
      off = u;
      command({ type: "hello" }); // ask for the current line now that we're listening
    });
    return () => {
      disposed = true;
      off?.();
    };
  }, []);
  return line;
}

/** The player menu, shared by the card, the Now Playing tile and the card's own window. */
export function playerMenu(
  settings: Settings,
  actions: { popover: (name: Exclude<PopName, "volume">) => void; edit: () => void; toggleOnTop: () => void },
): MenuEntry[] {
  const pick = (id: CardLayout): MenuEntry => ({
    label: layoutLabel(id),
    checked: settings.card.open && settings.card.layout === id,
    onClick: () => void saveSettings({ card: { layout: id, open: true } }),
  });
  return [
    pick("compact"),
    pick("squared"),
    "divider",
    pick("fullCover"),
    pick("halfCover"),
    pick("minimal"),
    pick("vinyl"),
    pick("minimalArt"),
    pick("vinylArt"),
    "divider",
    { label: "Lyrics", checked: settings.card.lyrics, onClick: () => void saveSettings({ card: { lyrics: !settings.card.lyrics } }) },
    { label: "Lyrics timing…", onClick: () => actions.popover("timing") },
    { label: "Sleep timer…", onClick: () => actions.popover("sleep") },
    { label: "Play from…", onClick: () => actions.popover("source") },
    { label: "Edit…", onClick: actions.edit },
    "divider",
    { label: "Keep above all windows", checked: settings.card.onTop, onClick: actions.toggleOnTop },
    { label: "Close player", onClick: () => void saveSettings({ card: { open: false } }) },
  ];
}

// ---------- the record (Vinyl layouts) ----------

/** A spinning record with the art as its label. Speeds up and winds down instead of jumping. */
function Record({ art, playing }: { art: string | null; playing: boolean }) {
  const disc = useRef<HTMLDivElement>(null);
  const spin = useRef<Animation | null>(null);
  const rate = useRef(0);

  useEffect(() => {
    const el = disc.current;
    if (!el?.animate) return;
    const anim = el.animate([{ transform: "rotate(0turn)" }, { transform: "rotate(1turn)" }], { duration: VINYL_TURN_MS, iterations: Infinity });
    anim.pause();
    spin.current = anim;
    return () => anim.cancel();
  }, []);

  useEffect(() => {
    const anim = spin.current;
    if (!anim) return;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      if (playing) anim.play();
      else anim.pause();
      return;
    }
    const from = rate.current;
    const to = playing ? 1 : 0;
    if (to > 0 && anim.playState !== "running") {
      anim.playbackRate = Math.max(from, 0.001);
      anim.play();
    }
    const start = performance.now();
    let frame = 0;
    // Ease the rotation speed itself, like a turntable motor.
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / VINYL_STOP_MS);
      const eased = 1 - (1 - t) * (1 - t);
      rate.current = from + (to - from) * eased;
      anim.updatePlaybackRate(Math.max(rate.current, 0.001));
      if (t < 1) frame = requestAnimationFrame(step);
      else if (to === 0) {
        rate.current = 0;
        anim.pause();
      }
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  // The label paints the art as its own rounded background, over the same gradient the
  // other layouts show without art. No clipped <img> inside the spinning layer, so
  // nothing can leave it blank, and missing or broken art still looks like a label.
  const label = art ? { backgroundImage: `url(${JSON.stringify(art)}), var(--pc-no-art)` } : undefined;
  return (
    <div className="pc-record" ref={disc}>
      <div className={`pc-label${art ? " has-art" : ""}`} style={label} />
    </div>
  );
}

/** The little bars in Compact that move while music plays. */
function Wave({ playing }: { playing: boolean }) {
  return (
    <span className={`pc-wave${playing ? " live" : ""}`} aria-hidden="true">
      <i />
      <i />
      <i />
      <i />
    </span>
  );
}

// ---------- what's inside the card ----------

interface ContentProps {
  layout: CardLayout;
  ws: WsState | null;
  settings: Settings;
  lyric: LyricLineNow;
  onPopover: (name: PopName, at: Element) => void;
  onExpand: () => void;
  /** Nothing playing: the card offers search instead of controls that can't do anything. */
  onSearch: () => void;
}

function CardProgressRow({
  ws,
  own,
  durationMs,
  seek,
  remaining = false,
}: {
  ws: WsState | null;
  own: boolean;
  durationMs: number;
  seek: (e: React.MouseEvent<HTMLDivElement>) => void;
  remaining?: boolean;
}) {
  const barRef = useRef<HTMLElement>(null);
  const curRef = useRef<HTMLSpanElement>(null);
  const durRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    return subscribeFrame(() => {
      const state = getWsState();
      const dur = state?.track?.durationMs ?? 0;
      if (barRef.current && dur > 0) {
        const p = Math.min(1, livePosition(state) / dur);
        barRef.current.style.transform = `scaleX(${p.toFixed(4)})`;
      }
    }, 30);
  }, []);

  useEffect(() => {
    return subscribeFrame(() => {
      const state = getWsState();
      const dur = state?.track?.durationMs ?? 0;
      const pos = livePosition(state);
      if (curRef.current) curRef.current.textContent = formatTime(pos);
      if (durRef.current) durRef.current.textContent = remaining ? `-${formatTime(Math.max(0, dur - pos))}` : formatTime(dur);
    }, 4);
  }, [remaining]);

  const initialPos = livePosition(ws);
  const initialProg = durationMs > 0 ? Math.min(1, initialPos / durationMs) : 0;

  return (
    <div className="pc-progress">
      <span ref={curRef}>{formatTime(initialPos)}</span>
      <div className={`pc-bar${own ? " seekable" : ""}`} onClick={seek} title={own ? "Seek" : undefined}>
        <b ref={barRef} style={{ display: "block", width: "100%", height: "100%", transformOrigin: "left", transform: `scaleX(${initialProg.toFixed(4)})` }} />
      </div>
      <span ref={durRef}>{remaining ? `-${formatTime(Math.max(0, durationMs - initialPos))}` : formatTime(durationMs)}</span>
    </div>
  );
}

function CardContent({ layout, ws, settings, lyric, onPopover, onExpand, onSearch }: ContentProps) {
  const track = ws?.track ?? null;
  const own = ws?.mode === "wallsong";
  const durationMs = track?.durationMs ?? 0;
  const title = track?.title ?? "Not playing";
  const artist = track?.artists.join(", ") ?? "Search, or play something in another app";
  const art = track?.artwork ?? null;

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!own || durationMs <= 0) return;
    const box = e.currentTarget.getBoundingClientRect();
    command({ type: "seek", ms: ((e.clientX - box.left) / box.width) * durationMs });
  };

  const lyricLine =
    settings.card.lyrics && LYRIC_LAYOUTS.has(layout) && lyric.text ? (
      <p className="pc-lyric" key={lyric.index}>
        {lyric.text}
      </p>
    ) : null;

  // Nothing playing: no times or bar to show.
  const progressRow = (remaining = false) =>
    track ? <CardProgressRow ws={ws} own={own} durationMs={durationMs} seek={seek} remaining={remaining} /> : null;

  const control = (c: Control): ReactNode => {
    const button = (icon: IconName, title: string, onClick: (e: React.MouseEvent<HTMLButtonElement>) => void, opts: { disabled?: boolean; on?: boolean; main?: boolean } = {}) => (
      <button
        key={c}
        className={`pc-btn${opts.main ? " main" : ""}${opts.on ? " on" : ""}${c === "volume" ? " pop-trigger" : ""}`}
        title={title}
        disabled={opts.disabled}
        onClick={(e) => {
          e.stopPropagation();
          onClick(e);
        }}
      >
        <Icon name={icon} size={opts.main ? 20 : 15} />
      </button>
    );
    switch (c) {
      case "volume":
        return button((ws?.volume ?? 80) === 0 ? "volumeOff" : "volume", own ? "Volume" : "Volume is in the app that's playing", (e) => onPopover("volume", e.currentTarget), { disabled: !own });
      case "shuffle":
        return button("shuffle", own ? "Shuffle up next" : "Shuffle is in the app that's playing", () => command({ type: "shuffle" }), { disabled: !own });
      case "prev":
        return button("prev", "Previous", () => command({ type: "previous" }), { disabled: !track });
      case "play":
        return button(ws?.playing ? "pause" : "play", ws?.playing ? "Pause" : "Play", () => command({ type: "toggle" }), { disabled: !track, main: true });
      case "next":
        return button("next", "Next", () => command({ type: "next" }), { disabled: !track });
      case "expand":
        // Wallsong's own songs open the artist's page; other apps' songs have nowhere to go.
        return own && track?.artists[0] ? button("expand", `Go to ${track.artists[0]}`, onExpand) : null;
      case "lyrics":
        return button("lyrics", settings.card.lyrics ? "Hide lyrics in the card" : "Show lyrics in the card", () => void saveSettings({ card: { lyrics: !settings.card.lyrics } }), {
          on: settings.card.lyrics,
        });
    }
  };
  const controls = (list: Control[]) =>
    track ? (
      <div className="pc-controls">{list.map(control)}</div>
    ) : (
      <div className="pc-controls pc-idle">
        <button
          className="pc-search"
          title="Search (Ctrl+Alt+Space)"
          onClick={(e) => {
            e.stopPropagation();
            onSearch();
          }}
        >
          <Icon name="search" size={14} />
          Search
        </button>
      </div>
    );
  const full: Control[] = ["volume", "shuffle", "prev", "play", "next", "expand", "lyrics"];
  const short: Control[] = ["volume", "shuffle", "prev", "play", "next", "lyrics"];
  const noLyrics: Control[] = ["volume", "shuffle", "prev", "play", "next", "expand"];

  switch (layout) {
    case "fullCover":
      return (
        <>
          <Art src={art} size="100%" className="pc-art-fill" />
          <div className="pc-shade" />
          <div className="pc-bottom">
            <p className="pc-title big">{title}</p>
            {lyricLine}
            {progressRow()}
            {controls(full)}
          </div>
        </>
      );
    case "halfCover":
      return (
        <>
          <div className="pc-top-art">
            <Art src={art} size="100%" className="pc-art-fill" />
          </div>
          <div className="pc-panel">
            <p className="pc-title">{title}</p>
            <p className="pc-artist">{artist}</p>
            {lyricLine}
            {progressRow()}
            {controls(full)}
          </div>
        </>
      );
    case "squared":
      return (
        <>
          <Art src={art} size="100%" className="pc-art-fill" />
          <div className="pc-hover-only">
            <div className="pc-shade" />
            <div className="pc-bottom">
              <p className="pc-title">{title}</p>
              <p className="pc-artist">{artist}</p>
              {progressRow()}
              {controls(noLyrics)}
            </div>
          </div>
        </>
      );
    case "compact":
      return (
        <div className="pc-glass">
          <div className="pc-row">
            <Art src={art} size="calc(6 * var(--svh))" className="pc-art-small" />
            <div className="pc-text">
              <p className="pc-title">{title}</p>
              <p className="pc-artist">{artist}</p>
              {lyricLine}
            </div>
            {track && <Wave playing={!!ws?.playing} />}
          </div>
          {progressRow(true)}
          {controls(short)}
        </div>
      );
    case "minimal":
    case "minimalArt":
      return (
        <div className="pc-glass">
          <p className="pc-title">{title}</p>
          <p className="pc-artist">{artist}</p>
          {lyricLine}
          {progressRow()}
          {controls(short)}
        </div>
      );
    case "vinyl":
    case "vinylArt":
      return (
        <>
          <div className="pc-vinyl">
            <Record art={art} playing={!!ws?.playing} />
          </div>
          <div className="pc-under">
            <p className="pc-title">{title}</p>
            <p className="pc-artist">{artist}</p>
            {controls(noLyrics)}
          </div>
        </>
      );
  }
}

/** The card box: morphs between layouts (size animates, contents cross-fade). */
const CardBox = memo(function CardBox({
  ws,
  settings,
  lyric,
  c1,
  dragging,
  onPointerDown,
  onMenu,
  onPopover,
  onExpand,
  onSearch,
  boxRef,
}: {
  ws: WsState | null;
  settings: Settings;
  lyric: LyricLineNow;
  c1: string;
  dragging: boolean;
  onPointerDown: (e: React.PointerEvent<HTMLDivElement>) => void;
  onMenu: (x: number, y: number) => void;
  onPopover: (name: PopName, at: Element) => void;
  onExpand: () => void;
  onSearch: () => void;
  boxRef?: React.Ref<HTMLDivElement>;
}) {
  const layout = settings.card.layout;
  const [w, h] = CARD_SIZE[layout];
  const [leaving, setLeaving] = useState<CardLayout | null>(null);
  const last = useRef(layout);
  useEffect(() => {
    if (last.current === layout) return;
    setLeaving(last.current);
    last.current = layout;
    const id = setTimeout(() => setLeaving(null), MORPH_MS);
    return () => clearTimeout(id);
  }, [layout]);

  const artColour = layout === "minimalArt" || layout === "vinylArt";
  const darkInk = artColour && mixedLuminance(c1, 0.7, "#141419") > LIGHT_BACKGROUND;
  const style = { "--w": w, "--h": h } as CSSProperties;
  const content = (l: CardLayout) => <CardContent layout={l} ws={ws} settings={settings} lyric={lyric} onPopover={onPopover} onExpand={onExpand} onSearch={onSearch} />;

  return (
    <div
      ref={boxRef}
      className={`pc pc-${layout}${settings.card.tilt && !dragging ? " tilt" : ""}${dragging ? " dragging" : ""}${artColour ? " art-colour" : ""}${darkInk ? " ink-dark" : ""}`}
      style={style}
      title={ws?.track ? `${ws.track.title} · ${ws.track.artists.join(", ")}` : undefined}
      onPointerDown={onPointerDown}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onMenu(e.clientX, e.clientY);
      }}
    >
      {leaving && (
        <div className={`pc-content pc-in-${leaving} leaving`} key={`out-${leaving}`} aria-hidden="true">
          {content(leaving)}
        </div>
      )}
      <div className={`pc-content pc-in-${layout}`} key={`in-${layout}`}>
        {content(layout)}
      </div>
      <button
        className="pc-more pop-trigger"
        title="Player menu"
        onClick={(e) => {
          e.stopPropagation();
          const r = e.currentTarget.getBoundingClientRect();
          onMenu(r.left, r.bottom + 4);
        }}
      >
        <Icon name="more" size={16} />
      </button>
    </div>
  );
});

/** Settings > Player card: a small, live copy of one layout (the real card, drawn at a tiny --svh). */
export function CardPreview({ layout, ws, settings, c1 }: { layout: CardLayout; ws: WsState | null; settings: Settings; c1: string }) {
  const [w, h] = CARD_SIZE[layout];
  const artColour = layout === "minimalArt" || layout === "vinylArt";
  const darkInk = artColour && mixedLuminance(c1, 0.7, "#141419") > LIGHT_BACKGROUND;
  const shown = { ...settings, card: { ...settings.card, layout } };
  return (
    <div className="pc-preview" aria-hidden="true">
      <div className={`pc pc-${layout}${artColour ? " art-colour" : ""}${darkInk ? " ink-dark" : ""}`} style={{ "--w": w, "--h": h } as CSSProperties}>
        <div className={`pc-content pc-in-${layout}`}>
          <CardContent layout={layout} ws={ws} settings={shown} lyric={{ index: -1, text: "" }} onPopover={() => {}} onExpand={() => {}} onSearch={() => {}} />
        </div>
      </div>
    </div>
  );
}

/** Clicks on these move or act; anything else on the card is "empty" and drags it. */
const INTERACTIVE = "button, input, a, .pc-bar";

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Keeps a card of size w×h inside the work area. */
function inside(spot: { x: number; y: number }, w: number, h: number, [ax, ay, aw, ah]: WorkArea) {
  return { x: clamp(spot.x, ax, ax + aw - w), y: clamp(spot.y, ay, ay + ah - h) };
}

/** Where the card goes the first time: lined up with the Now Playing tile, 2vh above the Dock (or the bar). */
export function defaultCardSpot(w: number, h: number): { x: number; y: number } {
  const vh = window.innerHeight / 100;
  const tile = document.querySelector(".dk-nowPlaying, .now-art")?.getBoundingClientRect();
  const base = document.querySelector(".dk, .bar")?.getBoundingClientRect();
  return { x: tile ? tile.left : (window.innerWidth - w) / 2, y: (base ? base.top : window.innerHeight * 0.8) - 2 * vh - h };
}

/** The card's spot on the control layer (CSS px), from Settings or the default. */
export function cardSpot(settings: Settings, workArea: WorkArea): { x: number; y: number; w: number; h: number } {
  const vh = window.innerHeight / 100;
  const [wv, hv] = CARD_SIZE[settings.card.layout];
  const w = wv * vh;
  const h = hv * vh;
  const saved = settings.card.x !== null && settings.card.y !== null ? { x: settings.card.x * window.innerWidth, y: settings.card.y * window.innerHeight } : null;
  return { ...inside(saved ?? defaultCardSpot(w, h), w, h, workArea), w, h };
}

// ---------- on the desktop layer (inside the overlay) ----------

/**
 * The card on the desktop: grows out of the tile that opened it, drags anywhere in
 * the work area, and stays open when you click elsewhere (it's a player, not a menu).
 */
export function FloatingPlayer({
  ws,
  settings,
  lyric,
  c1,
  workArea,
  from,
  onMenu,
  onPopover,
  onExpand,
  onSearch,
}: {
  ws: WsState | null;
  settings: Settings;
  lyric: LyricLineNow;
  c1: string;
  workArea: WorkArea;
  /** The tile (or bar art) the card grows out of. */
  from: HTMLElement | null;
  onMenu: (x: number, y: number) => void;
  onPopover: (name: PopName, at: Element) => void;
  onExpand: () => void;
  onSearch: () => void;
}) {
  const anchor = useRef<HTMLDivElement>(null);
  const base = cardSpot(settings, workArea);
  // While dragging (and until Settings has the new spot), the card follows the mouse.
  const [moved, setMoved] = useState<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const grab = useRef<{ dx: number; dy: number } | null>(null);
  const spot = moved ? inside(moved, base.w, base.h, workArea) : base;

  useEffect(() => setMoved(null), [settings.card.x, settings.card.y]);

  // Grow out of the tile (FLIP): start at the tile's box, end at the card's.
  useLayoutEffect(() => {
    const el = anchor.current;
    if (!el?.animate) return;
    const end = el.getBoundingClientRect();
    const start = from?.isConnected ? from.getBoundingClientRect() : null;
    const first = start
      ? `translate(${start.left - end.left}px, ${start.top - end.top}px) scale(${start.width / end.width}, ${start.height / end.height})`
      : "translateY(1.5vh) scale(0.98)";
    el.animate([{ transform: first, opacity: 0 }, { transform: "none", opacity: 1 }], { duration: 300, easing: "cubic-bezier(0.2, 0.9, 0.2, 1)" });
    // Only when the card first appears.
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || (e.target as Element).closest(INTERACTIVE)) return;
    grab.current = { dx: e.clientX - spot.x, dy: e.clientY - spot.y };
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!grab.current) return;
    setMoved({ x: e.clientX - grab.current.dx, y: e.clientY - grab.current.dy });
  };
  const onPointerUp = () => {
    if (!grab.current) return;
    grab.current = null;
    setDragging(false);
    if (moved) {
      const at = inside(moved, base.w, base.h, workArea);
      void saveSettings({ card: { x: at.x / window.innerWidth, y: at.y / window.innerHeight } });
    }
  };

  return (
    <div className="pc-anchor" ref={anchor} data-hit style={{ left: spot.x, top: spot.y }} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
      <CardBox
        ws={ws}
        settings={settings}
        lyric={lyric}
        c1={c1}
        dragging={dragging}
        onPointerDown={onPointerDown}
        onMenu={onMenu}
        onPopover={onPopover}
        onExpand={onExpand}
        onSearch={onSearch}
      />
    </div>
  );
}

// ---------- in its own always-on-top window ("Keep above all windows") ----------

/** Tells the control layer to do something only it can (open a page in Settings, an artist). */
export type OverlayCmd = { type: "artist"; name: string } | { type: "settings"; section: string };

/**
 * The page of the "mini" window: just the card. The window hugs the card (plus a
 * margin for its shadow); while a menu is open it grows to the work area so the
 * menu has room, then shrinks back. Coordinates are the control layer's CSS px.
 */
export function MiniPlayer() {
  const ws = useWs();
  const settings = useSettings();
  const sessions = useSessions();
  const lyric = useLyricLine();
  const [c1, c2, c3] = usePalette(ws?.track?.artwork);
  // Card sizes are shares of the screen, not of this small window.
  const svh = window.screen.height / 100;
  const margin = MINI_MARGIN * svh;
  const [wv, hv] = CARD_SIZE[settings.card.layout];
  const w = wv * svh;
  const h = hv * svh;

  const [cardAt, setCardAt] = useState<{ x: number; y: number } | null>(null);
  const [roomy, setRoomy] = useState<WorkArea | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [pop, setPop] = useState<{ name: PopName; at: "card" | "button" } | null>(null);
  const [popAnchor, setPopAnchor] = useState<Anchor | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const button = useRef<Element | null>(null);
  /** When Wallsong itself last moved this window (those moves aren't drags to remember). */
  const selfMoved = useRef(0);

  const place = useCallback(
    () =>
      call<[number, number, number, number]>("mini_place").then(([x, y, sw, sh]) => {
        const at = { x: x + margin, y: y + margin };
        setCardAt(at);
        return { ...at, sw, sh };
      }),
    [margin],
  );

  useEffect(() => {
    if (inTauri) void place().catch(() => {});
  }, [place]);

  // Remember where you drag it.
  useEffect(() => {
    if (!inTauri) return;
    let timer: number | undefined;
    const unlisten = getCurrentWindow().onMoved(() => {
      if (roomy || Date.now() - selfMoved.current < 600) return;
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        void place()
          .then((p) => saveSettings({ card: { x: p.x / p.sw, y: p.y / p.sh } }))
          .catch(() => {});
      }, 300);
    });
    return () => {
      clearTimeout(timer);
      void unlisten.then((u) => u());
    };
  }, [place, roomy]);

  // Layout changes: grow the window first, or shrink it once the card has finished shrinking.
  const lastSize = useRef({ w, h });
  useEffect(() => {
    if (!inTauri || roomy) return;
    const grow = w > lastSize.current.w || h > lastSize.current.h;
    lastSize.current = { w, h };
    const apply = () => void call("mini_resize", { width: w + 2 * margin, height: h + 2 * margin }).catch(() => {});
    if (grow) apply();
    else {
      const id = setTimeout(apply, MORPH_MS);
      return () => clearTimeout(id);
    }
  }, [w, h, margin, roomy]);

  // A menu needs room: grow to the work area while it's open, then hug the card again.
  const needsRoom = menu !== null || pop !== null;
  useEffect(() => {
    if (!inTauri || !cardAt) return;
    if (needsRoom && !roomy) {
      void call<WorkArea>("work_area")
        .then((wa) => {
          selfMoved.current = Date.now();
          setRoomy(wa);
          return call("mini_open", { width: wa[2], height: wa[3], x: wa[0], y: wa[1] });
        })
        .catch(() => {
          // No room to be had: the menu can't show here, so close it rather than leave it hanging.
          setMenu(null);
          setPop(null);
        });
    } else if (!needsRoom && roomy) {
      selfMoved.current = Date.now();
      void call("mini_open", { width: w + 2 * margin, height: h + 2 * margin, x: cardAt.x - margin, y: cardAt.y - margin })
        .catch(() => {})
        .finally(() => setRoomy(null));
    }
  }, [needsRoom, roomy, cardAt, w, h, margin]);

  // Point popovers at the card (or the button that opened them) once the window has room.
  useLayoutEffect(() => {
    if (!pop || !roomy) return setPopAnchor(null);
    const el = pop.at === "button" && button.current?.isConnected ? button.current : box.current;
    if (el) setPopAnchor(anchorOf(el));
  }, [pop, roomy, settings.card.layout]);

  const frame = roomy ? { x: roomy[0], y: roomy[1] } : cardAt ? { x: cardAt.x - margin, y: cardAt.y - margin } : { x: 0, y: 0 };
  const cardLeft = cardAt ? cardAt.x - frame.x : margin;
  const cardTop = cardAt ? cardAt.y - frame.y : margin;
  const closeMenus = () => {
    setMenu(null);
    setPop(null);
  };
  const tellOverlay = (cmd: OverlayCmd) => send<OverlayCmd>("overlay-cmd", cmd);

  const style = { "--c1": c1, "--c2": c2, "--c3": c3, "--svh": `${svh}px` } as CSSProperties;
  return (
    <div className="mini-root" style={style} onContextMenu={(e) => e.preventDefault()}>
      {needsRoom && roomy && <div className="mini-scrim" onPointerDown={closeMenus} />}
      <div className="pc-anchor" style={{ left: cardLeft, top: cardTop }}>
        <CardBox
          boxRef={box}
          ws={ws}
          settings={settings}
          lyric={lyric}
          c1={c1}
          dragging={false}
          onPointerDown={(e) => {
            if (e.button !== 0 || roomy || (e.target as Element).closest(INTERACTIVE)) return;
            void getCurrentWindow().startDragging().catch(() => {});
          }}
          // Menus are placed in the control layer's coordinates, so they stay put when the window grows.
          onMenu={(x, y) => {
            setPop(null);
            setMenu({ x: x + frame.x, y: y + frame.y });
          }}
          onPopover={(name, at) => {
            button.current = at;
            setMenu(null);
            setPop({ name, at: "button" });
          }}
          onExpand={() => track0(ws) && tellOverlay({ type: "artist", name: track0(ws)! })}
          // Search lives on the control layer: the core brings it forward, like Ctrl+Alt+Space.
          onSearch={() => void call("open_search").catch(() => {})}
        />
      </div>

      {menu && roomy && (
        <ContextMenu
          x={menu.x - roomy[0]}
          y={menu.y - roomy[1]}
          onClose={() => setMenu(null)}
          entries={playerMenu(settings, {
            popover: (name) => setPop({ name, at: "card" }),
            edit: () => tellOverlay({ type: "settings", section: "card" }),
            toggleOnTop: () => void saveSettings({ card: { onTop: false } }),
          })}
        />
      )}

      {pop && popAnchor && (
        <Floating anchor={popAnchor}>
          {pop.name === "source" && <SourcePopover settings={settings} sessions={sessions} />}
          {pop.name === "sleep" && <SleepPopover ws={ws} onDone={() => setPop(null)} />}
          {pop.name === "timing" && <TimingPopover ws={ws} />}
          {pop.name === "volume" && <VolumePopover ws={ws} vertical />}
        </Floating>
      )}
    </div>
  );
}

const track0 = (ws: WsState | null) => ws?.track?.artists[0] ?? null;
