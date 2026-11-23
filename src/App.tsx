import { useEffect, useRef, useState } from "react";
import { connectDemo, connectNative, inTauri, type NativeHandlers } from "./lib/native";
import { currentLineIndex, parseLrc } from "./lib/lrc";
import { BRAND_PALETTE, paletteFromImage } from "./lib/palette";
import type { LyricLine, Position, TrackInfo } from "./lib/types";
import { Clock } from "./components/Clock";
import { EdgeGlow } from "./components/EdgeGlow";
import { LyricsView } from "./components/LyricsView";
import { NowPlaying } from "./components/NowPlaying";
import { Backdrop } from "./components/Backdrop";

/** Show each line this many ms early: reading takes a moment. */
const LYRIC_LEAD_MS = 150;
/** Animation loop runs at ~30 fps (a little under 33 ms so 60 Hz vsync jitter can't drop it to 20). */
const FRAME_MS = 1000 / 30 - 4;

type LyricsState =
  | { kind: "loading" }
  | { kind: "synced"; lines: LyricLine[] }
  | { kind: "plain" }
  | { kind: "instrumental" }
  | { kind: "none" };

export default function App() {
  const [track, setTrack] = useState<TrackInfo | null>(null);
  const [lyrics, setLyrics] = useState<LyricsState>({ kind: "none" });
  const [lineIndex, setLineIndex] = useState(-1);
  const [palette, setPalette] = useState<string[]>(BRAND_PALETTE);
  const [audioError, setAudioError] = useState<string | null>(null);

  // Hot values live in refs so 60 fps updates never re-render React.
  const position = useRef<Position | null>(null);
  const beat = useRef({ level: 0, flash: 0 });
  const trackKey = useRef<string | null>(null);
  const lines = useRef<LyricLine[]>([]);

  // Subscribe to the native core (or the demo feed in a browser).
  useEffect(() => {
    const handlers: NativeHandlers = {
      onTrack: (t) => {
        setTrack(t);
        const key = t?.key ?? null;
        // Same song sent again (its artwork arrived late): keep the lyrics.
        if (key === trackKey.current) return;
        trackKey.current = key;
        setLyrics(t ? { kind: "loading" } : { kind: "none" });
        lines.current = [];
        setLineIndex(-1);
      },
      onPosition: (p) => {
        position.current = p;
      },
      onLyrics: (l) => {
        if (l.trackKey !== trackKey.current) return; // late answer for an old song
        if (l.instrumental) return setLyrics({ kind: "instrumental" });
        if (l.synced) {
          lines.current = parseLrc(l.synced);
          return setLyrics({ kind: "synced", lines: lines.current });
        }
        setLyrics(l.plain ? { kind: "plain" } : { kind: "none" });
      },
      onBeat: (b) => {
        beat.current.level = b.level;
        if (b.kick) beat.current.flash = 1;
      },
      onAudioError: setAudioError,
    };
    if (!inTauri) return connectDemo(handlers);
    let off: (() => void) | undefined;
    connectNative(handlers).then((unsub) => (off = unsub));
    return () => off?.();
  }, []);

  // Album colours drive the glow, clock and lyric tint.
  useEffect(() => {
    if (!track?.artwork) return setPalette(BRAND_PALETTE);
    let live = true;
    paletteFromImage(track.artwork)
      .then((p) => live && setPalette(p))
      .catch(() => live && setPalette(BRAND_PALETTE));
    return () => {
      live = false;
    };
  }, [track?.artwork]);

  // One animation loop: extrapolate song time, pick the lyric line, push beat to CSS.
  // Every CSS variable write repaints the blurred glow, clock and lyric shadows, so
  // the loop runs at ~30 fps and writes a variable only when its value visibly changes.
  useEffect(() => {
    const root = document.documentElement;
    const written: Record<string, string> = {};
    const write = (name: string, value: string) => {
      if (written[name] === value) return;
      written[name] = value;
      root.style.setProperty(name, value);
    };
    let frame = 0;
    let last = performance.now();
    const tick = (now: number) => {
      frame = requestAnimationFrame(tick);
      if (now - last < FRAME_MS) return;
      const dt = Math.min(64, now - last);
      last = now;

      const p = position.current;
      if (p && lines.current.length > 0) {
        const t = p.positionMs + (p.playing ? Date.now() - p.sampledAtMs : 0) + LYRIC_LEAD_MS;
        const idx = currentLineIndex(lines.current, t);
        setLineIndex((prev) => (prev === idx ? prev : idx));
      }

      const b = beat.current;
      b.flash = Math.max(0, b.flash - dt / 220); // kick flash fades in ~220 ms
      // Steps of 0.01 are below what the eye can see in a blurred glow.
      // (No colour rotation: it forced the blurred glow to be redrawn every frame.)
      write("--level", b.level.toFixed(2));
      write("--flash", b.flash.toFixed(2));
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  const [c1, c2, c3] = palette;
  const style = { "--c1": c1, "--c2": c2, "--c3": c3 } as React.CSSProperties;

  return (
    <main className="stage" style={style}>
      <Backdrop artwork={track?.artwork ?? null} />
      <Clock />
      {lyrics.kind === "synced" && <LyricsView lines={lyrics.lines} index={lineIndex} />}
      {lyrics.kind === "instrumental" && <p className="lyrics-note">♪</p>}
      {track && lyrics.kind === "none" && <p className="lyrics-note small">No lyrics for this song</p>}
      {track && lyrics.kind === "plain" && <p className="lyrics-note small">Only unsynced lyrics found</p>}
      <NowPlaying track={track} />
      <EdgeGlow palette={palette} />
      {audioError && <p className="status">Glow can't hear the music: {audioError}</p>}
    </main>
  );
}
