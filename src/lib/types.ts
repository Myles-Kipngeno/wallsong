// Shapes of the events and command results the Rust core sends (serde camelCase),
// plus the messages the two windows exchange.

export interface TrackInfo {
  key: string;
  title: string;
  artist: string;
  album: string;
  durationMs: number;
  source: string;
  artwork: string | null;
}

export interface Position {
  positionMs: number;
  playing: boolean;
  sampledAtMs: number;
}

export interface Lyrics {
  trackKey: string;
  synced: string | null;
  plain: string | null;
  instrumental: boolean;
}

export interface Beat {
  level: number;
  kick: boolean;
}

export interface LyricLine {
  timeMs: number;
  text: string;
}

/** A YouTube Music result (see src-tauri/src/ytmusic.rs). */
export interface MusicItem {
  kind: "song" | "video" | "artist" | "album" | "playlist" | "episode";
  title: string;
  artists: string[];
  album: string | null;
  duration: string | null;
  durationMs: number | null;
  videoId: string | null;
  browseId: string | null;
  videoType: string | null;
  thumbnail: string | null;
  year?: string | null;
  subtitle?: string | null;
}

export interface Shelf {
  title: string;
  items: MusicItem[];
}

export interface ArtistPage {
  browseId: string;
  name: string;
  description: string | null;
  thumbnail: string | null;
  topSongs: MusicItem[];
  shelves: Shelf[];
}

export interface AlbumPage {
  browseId: string;
  title: string;
  artists: string[];
  year: string | null;
  kind: string;
  thumbnail: string | null;
  tracks: MusicItem[];
}

/** An app talking to Windows' media controls (source menu). */
export interface SessionInfo {
  id: string;
  name: string;
  playing: boolean;
  title: string;
}

export interface SearchResults {
  top: MusicItem | null;
  songs: MusicItem[];
  videos: MusicItem[];
  artists: MusicItem[];
  albums: MusicItem[];
}

/** What's on screen, whoever is playing it. */
export interface NowTrack {
  key: string;
  title: string;
  artists: string[];
  album: string;
  durationMs: number;
  /** Data URL or https URL. */
  artwork: string | null;
}

export type PlayMode = "wallsong" | "follow" | "idle";
export type RepeatMode = "off" | "all" | "one";

/** Broadcast by the wallpaper window (the player) to the other windows, ~4 times a second. */
export interface WsState {
  mode: PlayMode;
  track: NowTrack | null;
  /** The song as picked from search (for like, go to artist...). */
  item: MusicItem | null;
  playing: boolean;
  positionMs: number;
  sampledAtMs: number;
  queue: MusicItem[];
  history: MusicItem[];
  canGoBack: boolean;
  volume: number;
  offsetMs: number;
  /** "video" = a music video on the wallpaper, "audio" = song audio with its artwork. */
  visual: "video" | "audio" | null;
  /** The YouTube video playing now, so other screens can mirror it. */
  videoId: string | null;
  /** Other videos for this song (video picker dots) and which one is on. */
  videos: MusicItem[];
  videoIndex: number;
  repeat: RepeatMode;
  /** Epoch ms when the sleep timer stops playback, -1 for "end of this song", null when off. */
  sleepAt: number | null;
  /** Bumped when a new song starts, for the "now starting" card. */
  startedAt: number;
  notice: string | null;
}

/** Sent by the controls to the wallpaper window. */
export type WsCmd =
  | { type: "play"; item: MusicItem }
  | { type: "playList"; items: MusicItem[]; start: number; shuffle: boolean }
  | { type: "enqueue"; item: MusicItem; next: boolean }
  | { type: "jump"; index: number }
  | { type: "toggle" }
  | { type: "next" }
  | { type: "previous" }
  | { type: "seek"; ms: number }
  | { type: "volume"; value: number }
  | { type: "nudge"; deltaMs: number }
  | { type: "pickVideo"; index: number }
  | { type: "repeat" }
  | { type: "sleep"; minutes: number }
  /** Shuffles the up-next queue once (Wallsong songs only). */
  | { type: "shuffle" }
  | { type: "hello" };

/** Something on the desktop or in a folder (src-tauri/src/shelf.rs). */
export interface ShelfItem {
  name: string;
  path: string;
  isDir: boolean;
  kind: "folder" | "shortcut" | "file" | "app";
  /** data:image/png;base64 */
  icon: string | null;
  modifiedMs: number;
}

/** src-tauri/src/shelf.rs: from the `battery` command and the "battery" event. */
export interface BatteryInfo {
  hasBattery: boolean;
  percent: number;
  /** Windows says charging, or plugged in below 100%. */
  charging: boolean;
  pluggedIn: boolean;
  /** On battery, when Windows knows. */
  minutesLeft: number | null;
}

export interface RecycleBinInfo {
  items: number;
  bytes: number;
}

/** Open-Meteo weather now and today, in °C (src-tauri/src/weather.rs). */
export interface WeatherNow {
  temperature: number;
  high: number;
  low: number;
  code: number;
  isDay: boolean;
  glyph: "sun" | "moon" | "cloud" | "rain" | "storm" | "snow" | "fog";
}

/** A city from the weather search. */
export interface Place {
  name: string;
  region: string;
  latitude: number;
  longitude: number;
}

/** The lyric line being sung, broadcast by the wallpaper whenever it changes (-1: none). */
export interface LyricLineNow {
  index: number;
  text: string;
}
