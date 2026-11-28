import { useEffect, useState } from "react";
import { call, on } from "./bus";
import { inTauri } from "./native";

/** Every lyric style Wallsong can draw. */
export const LYRIC_STYLES = [
  { id: "stack", label: "Stack", hint: "Line builds word by word" },
  { id: "drop", label: "Drop", hint: "Words fall and pile up" },
  { id: "scrawl", label: "Scrawl", hint: "Marker on a wall" },
  { id: "sweep", label: "Sweep", hint: "Huge words wipe across" },
  { id: "tube", label: "Tube", hint: "Old TV glow" },
  { id: "lens", label: "Lens", hint: "Bulging fisheye word" },
  { id: "stretch", label: "Stretch", hint: "Tall warped letters" },
  { id: "stars", label: "Stars", hint: "Words joined like stars" },
  { id: "chat", label: "Chat", hint: "Lines as messages" },
  { id: "icons", label: "Icons", hint: "Words with little pictures" },
  { id: "roll", label: "Roll", hint: "One big word at a time, rolling up" },
  { id: "orbit", label: "Orbit", hint: "3D rotating sphere, word Z-tumbles & spinning orb" },
  { id: "tape", label: "Tape", hint: "Mixed-size word stacks with highlight tape" },
  { id: "cascade", label: "Cascade", hint: "Words rise in a queue; choruses become posters" },
  { id: "slam", label: "Slam", hint: "One giant word at a time, colour flips" },
] as const;

export type LyricStyle = (typeof LYRIC_STYLES)[number]["id"];
export type DisplayRole = "all" | "video" | "lyrics" | "off";

/** One tile in the Dock. Order in `dock.items` is the order on screen. */
export type DockItem =
  | { type: "clock" }
  | { type: "nowPlaying" }
  /** Every player control from the v0.3 bar (v0.5.1). Added after Now Playing to older settings by the core. */
  | { type: "controls" }
  | { type: "calendar" }
  | { type: "weather" }
  | { type: "battery" }
  | { type: "desktop" }
  | { type: "recycle" }
  | { type: "pin"; path: string; name: string };

export type DockTileType = DockItem["type"];

export const DEFAULT_DOCK_ITEMS: DockItem[] = [
  { type: "clock" },
  { type: "nowPlaying" },
  { type: "controls" },
  { type: "weather" },
  { type: "calendar" },
  { type: "battery" },
  { type: "desktop" },
  { type: "recycle" },
];

/** The floating player card's layouts. */
export const CARD_LAYOUTS = [
  { id: "compact", label: "Compact" },
  { id: "squared", label: "Squared" },
  { id: "fullCover", label: "Full Cover" },
  { id: "halfCover", label: "Half Cover" },
  { id: "minimal", label: "Minimal" },
  { id: "vinyl", label: "Vinyl" },
  { id: "minimalArt", label: "Minimal Art Color" },
  { id: "vinylArt", label: "Vinyl Art Color" },
] as const;

export type CardLayout = (typeof CARD_LAYOUTS)[number]["id"];

export interface Settings {
  /** "auto", "wallsong", or a Windows app id to follow. */
  source: string;
  lyrics: {
    visible: boolean;
    style: LyricStyle;
    font: string;
    size: number;
    colorMode: "auto" | "custom";
    text: string;
    highlight: string;
    secondary: string;
    /** Picking Roll the first time switched the clock to compact (only ever done once). */
    rollClockApplied: boolean;
  };
  clock: {
    visible: boolean;
    /** "tall": the big narrow clock. "compact": small and light, made for Roll. */
    layout: "tall" | "compact";
    font: string;
    size: number;
    hours: "12" | "24";
    showDate: boolean;
  };
  glow: {
    visible: boolean;
    style: "flame" | "smooth" | "chase";
    /** Chase: how many lights travel around the edge (1 to 3). */
    comets: number;
    thickness: number;
    intensity: number;
    motion: number;
    sparks: boolean;
    colors: "album" | "custom";
    primary: string;
    secondary: string;
  };
  video: { enabled: boolean; dim: number };
  displays: Record<string, DisplayRole>;
  controlsDisplay: string | null;
  keepAwake: boolean;
  controls: {
    tilt: boolean;
    listCollapsed: boolean;
    /** "dock": the Dock of tiles. "bar": the v0.3 player bar. */
    bottom: "dock" | "bar";
  };
  general: {
    /** "dock": hidden from the desktop, shown in the Dock's Desktop tile. "desktop": left on the desktop. */
    desktopIcons: "dock" | "desktop";
  };
  dock: {
    /** Folded down to just the song (the chevron). */
    folded: boolean;
    items: DockItem[];
    weatherCity: string;
    weatherLat: number | null;
    weatherLon: number | null;
    weatherUnit: "c" | "f";
    clockStyle: "analog" | "digital";
  };
  /** The floating player card. */
  card: {
    open: boolean;
    layout: CardLayout;
    /** Top-left corner as a share of the screen; null = next to the Now Playing tile. */
    x: number | null;
    y: number | null;
    tilt: boolean;
    /** Lives in its own always-on-top window instead of on the desktop. */
    onTop: boolean;
    /** Shows the current lyric line. */
    lyrics: boolean;
  };
  liked: Array<{ videoId: string; title: string; artists: string[]; thumbnail: string | null }>;
}

export const DEFAULT_SETTINGS: Settings = {
  source: "auto",
  lyrics: {
    visible: true,
    style: "stack",
    font: "nunito",
    size: 1,
    colorMode: "auto",
    text: "#ffffff",
    highlight: "#ff9a3d",
    secondary: "#c9c9d6",
    rollClockApplied: false,
  },
  clock: { visible: true, layout: "tall", font: "antonio", size: 1, hours: "12", showDate: true },
  glow: {
    visible: true,
    style: "flame",
    comets: 2,
    thickness: 1,
    intensity: 1,
    motion: 1,
    sparks: true,
    colors: "album",
    primary: "#ff3d8b",
    secondary: "#ff9a3d",
  },
  video: { enabled: true, dim: 0.3 },
  displays: {},
  controlsDisplay: null,
  keepAwake: true,
  controls: { tilt: true, listCollapsed: false, bottom: "dock" },
  general: { desktopIcons: "dock" },
  dock: {
    folded: false,
    items: DEFAULT_DOCK_ITEMS,
    weatherCity: "",
    weatherLat: null,
    weatherLon: null,
    weatherUnit: "c",
    clockStyle: "analog",
  },
  card: { open: false, layout: "fullCover", x: null, y: null, tilt: true, onTop: false, lyrics: true },
  liked: [],
};

type Plain = Record<string, unknown>;

function isPlain(v: unknown): v is Plain {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Stored values over defaults, key by key, so new settings get their default. */
export function withDefaults<T>(defaults: T, stored: unknown): T {
  if (!isPlain(defaults) || !isPlain(stored)) return (stored ?? defaults) as T;
  const out: Plain = { ...defaults };
  for (const [key, value] of Object.entries(stored)) {
    out[key] = key in defaults && isPlain((defaults as Plain)[key]) ? withDefaults((defaults as Plain)[key], value) : value;
  }
  return out as T;
}

export type SettingsPatch = { [K in keyof Settings]?: Settings[K] extends object ? Partial<Settings[K]> | Settings[K] : Settings[K] };

const LOCAL_KEY = "wallsong.settings";
const local = typeof BroadcastChannel !== "undefined" && !inTauri ? new BroadcastChannel("wallsong-settings") : null;

function mergeDeep(base: Plain, patch: Plain): Plain {
  const out: Plain = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = isPlain(v) && isPlain(base[k]) ? mergeDeep(base[k] as Plain, v) : v;
  }
  return out;
}

export async function loadSettings(): Promise<Settings> {
  if (inTauri) return withDefaults(DEFAULT_SETTINGS, await call<unknown>("settings_get"));
  try {
    return withDefaults(DEFAULT_SETTINGS, JSON.parse(localStorage.getItem(LOCAL_KEY) ?? "{}"));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** Saves a partial change; every window hears about it. */
export async function saveSettings(patch: SettingsPatch): Promise<void> {
  if (inTauri) {
    await call("settings_set", { patch });
    return;
  }
  let stored: Plain = {};
  try {
    stored = JSON.parse(localStorage.getItem(LOCAL_KEY) ?? "{}");
  } catch {
    /* start fresh */
  }
  const next = mergeDeep(stored, patch as Plain);
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable: still broadcast */
  }
  const full = withDefaults(DEFAULT_SETTINGS, next);
  local?.postMessage(full);
  listeners.forEach((l) => l(full));
}

const listeners = new Set<(s: Settings) => void>();

export function useSettings(): Settings {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  useEffect(() => {
    let live = true;
    loadSettings().then((s) => live && setSettings(s));
    const apply = (s: Settings) => live && setSettings(s);
    listeners.add(apply);
    let off: (() => void) | undefined;
    if (inTauri) {
      on<unknown>("settings", (raw) => apply(withDefaults(DEFAULT_SETTINGS, raw))).then((u) => (live ? (off = u) : u()));
    } else {
      const handler = (m: MessageEvent) => apply(m.data as Settings);
      local?.addEventListener("message", handler);
      off = () => local?.removeEventListener("message", handler);
    }
    return () => {
      live = false;
      listeners.delete(apply);
      off?.();
    };
  }, []);
  return settings;
}
