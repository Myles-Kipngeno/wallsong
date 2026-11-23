import { listen } from "@tauri-apps/api/event";
import type { Beat, Lyrics, Position, TrackInfo } from "./types";

export interface NativeHandlers {
  onTrack: (t: TrackInfo | null) => void;
  onPosition: (p: Position) => void;
  onLyrics: (l: Lyrics) => void;
  onBeat: (b: Beat) => void;
  onAudioError: (message: string) => void;
}

/** True inside the Tauri app, false in a normal browser (`npm run dev`). */
export const inTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** Subscribes to the Rust core's events. Returns an unsubscribe function. */
export async function connectNative(h: NativeHandlers): Promise<() => void> {
  const offs = await Promise.all([
    listen<TrackInfo | null>("track", (e) => h.onTrack(e.payload)),
    listen<Position>("position", (e) => h.onPosition(e.payload)),
    listen<Lyrics>("lyrics", (e) => h.onLyrics(e.payload)),
    listen<Beat>("beat", (e) => h.onBeat(e.payload)),
    listen<string>("audio-error", (e) => h.onAudioError(e.payload)),
  ]);
  return () => offs.forEach((off) => off());
}

const DEMO_LRC = `[00:01.00]Wallsong demo mode
[00:04.00]You're seeing this in a browser
[00:07.00]Run it with npm run tauri dev
[00:10.00]and play a song in Spotify
[00:13.00]or YouTube Music in Chrome
[00:16.00]Your desktop, on the beat`;

/**
 * Fake events so the UI can be designed in a browser without Windows APIs:
 * a 20-second looping "song" with lyrics and a 120 BPM kick.
 */
export function connectDemo(h: NativeHandlers): () => void {
  const start = Date.now();
  const track: TrackInfo = {
    key: "demo",
    title: "Demo Song",
    artist: "Wallsong",
    album: "",
    durationMs: 20_000,
    source: "demo",
    artwork: null,
  };
  h.onTrack(track);
  h.onLyrics({ trackKey: "demo", synced: DEMO_LRC, plain: null, instrumental: false });

  const positionTimer = setInterval(() => {
    h.onPosition({ positionMs: (Date.now() - start) % 20_000, playing: true, sampledAtMs: Date.now() });
  }, 250);

  let lastBeat = 0;
  const beatTimer = setInterval(() => {
    const t = Date.now() - start;
    const beatIndex = Math.floor(t / 500);
    const phase = (t % 500) / 500;
    const kick = beatIndex !== lastBeat;
    lastBeat = beatIndex;
    h.onBeat({ level: Math.max(0.15, 1 - phase * 1.6), kick });
  }, 16);

  return () => {
    clearInterval(positionTimer);
    clearInterval(beatTimer);
  };
}
