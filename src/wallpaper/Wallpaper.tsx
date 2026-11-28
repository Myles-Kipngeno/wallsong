import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { connectDemo, connectNative, inTauri, type NativeHandlers } from "../lib/native";
import { call, on, send } from "../lib/bus";
import { beat } from "../lib/beat";
import { setFramePaused, subscribeFrame } from "../lib/frame";
import { currentLineIndex, parseLrc } from "../lib/lrc";
import { usePalette } from "../lib/palette";
import { LYRIC_FONTS, fontById } from "../lib/fonts";
import { useSettings, type DisplayRole, type Settings } from "../lib/settings";
import { timeWords, type TimedLine } from "../lib/wordTiming";
import type { LyricLineNow, Lyrics, NowTrack, WsCmd, WsState } from "../lib/types";
import { Clock } from "../components/Clock";
import { GlowCanvas } from "../components/GlowCanvas";
import { Backdrop } from "../components/Backdrop";
import { LyricsStage } from "../lyrics/LyricsStage";
import { Controller } from "./controller";
import { YtPlayer } from "./ytPlayer";

/** Show each word this many ms early: reading takes a moment. */
const LYRIC_LEAD_MS = 150;

type LyricsState =
  | { kind: "loading" }
  | { kind: "synced"; lines: TimedLine[] }
  | { kind: "plain" }
  | { kind: "instrumental" }
  | { kind: "none" };

function lyricsState(l: Lyrics): LyricsState {
  if (l.instrumental) return { kind: "instrumental" };
  if (l.synced) return { kind: "synced", lines: timeWords(parseLrc(l.synced)) };
  return l.plain ? { kind: "plain" } : { kind: "none" };
}

/** Bass level and kick flash for JS beat object and the glow. */
function useBeatLoop() {
  useEffect(() => {
    return subscribeFrame((_now, dt) => {
      beat.flash = Math.max(0, beat.flash - dt / 220); // kick flash fades in ~220 ms
      beat.angle = (beat.angle + dt * (0.006 + beat.level * 0.03)) % 360;
    });
  }, []);
}

/** How often the line being sung is checked for the player card (it only sends when it changes). */
const LYRIC_LINE_CHECK_MS = 100;

/** Tells the player card which lyric line is being sung, whenever it changes ("ws-lyric-line"). */
function useLyricLineBroadcast(lyrics: LyricsState, timeMs: () => number) {
  useEffect(() => {
    let last: LyricLineNow = { index: -2, text: "" };
    const lines = lyrics.kind === "synced" ? lyrics.lines : [];
    const tick = () => {
      const index = lines.length ? currentLineIndex(lines, timeMs()) : -1;
      if (index === last.index) return;
      last = { index, text: index >= 0 ? lines[index].text : "" };
      send<LyricLineNow>("ws-lyric-line", last);
    };
    tick();
    const id = setInterval(tick, LYRIC_LINE_CHECK_MS);
    // A window that opens mid-line asks with "hello": tell it straight away.
    let off: (() => void) | undefined;
    let disposed = false;
    on<WsCmd>("ws-cmd", (cmd) => cmd.type === "hello" && send<LyricLineNow>("ws-lyric-line", last)).then((u) => (disposed ? u() : (off = u)));
    return () => {
      disposed = true;
      clearInterval(id);
      off?.();
    };
  }, [lyrics, timeMs]);
}

/** Everything drawn on the wallpaper, the same on the main screen and mirrors. */
function Scene({
  settings,
  role,
  track,
  lyrics,
  showVideo,
  videoHost,
  timeMs,
  playing,
  syncSeq,
  audioError,
}: {
  settings: Settings;
  role: DisplayRole;
  track: NowTrack | null;
  lyrics: LyricsState;
  showVideo: boolean;
  videoHost: React.RefObject<HTMLDivElement | null>;
  timeMs: () => number;
  playing: boolean;
  syncSeq: number;
  audioError: string | null;
}) {
  const palette = usePalette(track?.artwork);
  const [c1, c2, c3] = palette;
  const ly = settings.lyrics;
  const font = fontById(LYRIC_FONTS, ly.font);
  const auto = ly.colorMode === "auto";
  const style = {
    "--c1": c1,
    "--c2": c2,
    "--c3": c3,
    "--ly-font": font.family,
    "--ly-weight": font.weight,
    "--ly-size": ly.size,
    "--ly-text": auto ? "#ffffff" : ly.text,
    "--ly-hi": auto ? `color-mix(in srgb, ${c1} 75%, white)` : ly.highlight,
    "--ly-sec": auto ? "rgba(255,255,255,0.85)" : ly.secondary,
    "--video-dim": settings.video.dim,
  } as React.CSSProperties;

  const withVideo = role !== "lyrics" && showVideo;
  const withWords = role !== "video";

  return (
    <main className="stage" style={style}>
      <Backdrop artwork={withVideo ? null : (track?.artwork ?? null)} />
      <div className={`video-layer${withVideo ? " on" : ""}`} aria-hidden="true">
        <div ref={videoHost} className="video-host" />
        <div className="video-shade" />
      </div>
      {withWords && settings.clock.visible && <Clock settings={settings.clock} />}
      {withWords && ly.visible && (
        <>
          {lyrics.kind === "synced" && <LyricsStage lines={lyrics.lines} style={ly.style} timeMs={timeMs} playing={playing} syncSeq={syncSeq} />}
          {lyrics.kind === "instrumental" && <p className="lyrics-note">♪</p>}
          {track && lyrics.kind === "none" && <p className="lyrics-note small">No lyrics for this song</p>}
          {track && lyrics.kind === "plain" && <p className="lyrics-note small">Only unsynced lyrics found</p>}
        </>
      )}
      {settings.glow.visible && <GlowCanvas settings={settings.glow} palette={palette} />}
      {audioError && <p className="status">Glow can't hear the music: {audioError}</p>}
    </main>
  );
}

/** Main screen: hosts the player and the brain, shows its own role from Settings > Displays. */
export function Wallpaper() {
  const settings = useSettings();
  const [displayKey, setDisplayKey] = useState<string | null>(null);
  const [track, setTrack] = useState<NowTrack | null>(null);
  const [showVideo, setShowVideo] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [syncSeq, setSyncSeq] = useState(0);
  const [lyrics, setLyrics] = useState<LyricsState>({ kind: "none" });
  const [audioError, setAudioError] = useState<string | null>(null);

  const videoHost = useRef<HTMLDivElement>(null);
  const controller = useRef<Controller | null>(null);
  const trackKey = useRef<string | null>(null);
  /** Lyrics can arrive before or after the song they belong to shows up; keep the last few. */
  const lyricsCache = useRef(new Map<string, Lyrics>());

  useBeatLoop();

  useEffect(() => {
    if (inTauri) void call<string | null>("my_display").then(setDisplayKey).catch(() => {});
  }, []);

  useEffect(() => {
    const show = (l: Lyrics) => {
      const cache = lyricsCache.current;
      cache.set(l.trackKey, l);
      if (cache.size > 8) cache.delete(cache.keys().next().value!);
      if (l.trackKey === trackKey.current) setLyrics(lyricsState(l));
    };

    const c = new Controller(videoHost.current!, show);
    controller.current = c;

    const sync = () => {
      setShowVideo(c.mode === "wallsong" && c.visual === "video");
      setTrack(c.track);
      setPlaying(c.isPlaying());
      setSyncSeq(c.syncRevision());
      const key = c.track?.key ?? null;
      if (key === trackKey.current) return;
      trackKey.current = key;
      const cached = key ? lyricsCache.current.get(key) : undefined;
      if (cached) c.onLyrics(cached);
      else setLyrics(key ? { kind: "loading" } : { kind: "none" });
    };
    const unsubscribe = c.subscribe(sync);

    const handlers: NativeHandlers = {
      onTrack: (t) => c.onNativeTrack(t),
      onPosition: (p) => c.onNativePosition(p),
      onLyrics: (l) => c.onLyrics(l),
      onBeat: (b) => {
        beat.level = b.level;
        if (b.kick) beat.flash = 1;
      },
      onAudioError: setAudioError,
    };

    let disposed = false;
    const offs: Array<() => void> = [];
    const keep = (off: () => void) => (disposed ? off() : offs.push(off));
    if (inTauri) connectNative(handlers).then(keep);
    else keep(connectDemo(handlers));
    on<WsCmd>("ws-cmd", (cmd) => c.command(cmd)).then(keep);
    on<{ covered: boolean }>("visibility", (v) => setFramePaused(v.covered)).then(keep);

    return () => {
      disposed = true;
      offs.forEach((off) => off());
      unsubscribe();
      c.dispose();
      controller.current = null;
    };
  }, []);

  useEffect(() => {
    controller.current?.setWallsongOnly(settings.source === "wallsong");
  }, [settings.source]);

  const timeMs = useCallback(() => {
    const c = controller.current;
    return c ? c.positionMs() + c.offsetMs() + LYRIC_LEAD_MS : 0;
  }, []);

  useLyricLineBroadcast(lyrics, timeMs);

  const role = (displayKey && settings.displays[displayKey]) || "all";
  return (
    <Scene
      settings={settings}
      role={role === "off" ? "all" : role}
      track={track}
      lyrics={lyrics}
      showVideo={showVideo && settings.video.enabled}
      videoHost={videoHost}
      timeMs={timeMs}
      playing={playing}
      syncSeq={syncSeq}
      audioError={audioError}
    />
  );
}

/** Drift allowed between the main screen's video and a mirror before it re-seeks. */
const MIRROR_TOLERANCE_MS = 450;

/** Another screen: mirrors the main one from its broadcasts; its video plays muted and follows. */
export function Mirror({ displayKey }: { displayKey: string }) {
  const settings = useSettings();
  const [state, setState] = useState<WsState | null>(null);
  const [syncSeq, setSyncSeq] = useState(0);
  const [lyrics, setLyrics] = useState<LyricsState>({ kind: "none" });
  const videoHost = useRef<HTMLDivElement>(null);
  const latest = useRef<WsState | null>(null);
  const lyricsFor = useRef<string | null>(null);
  const role = settings.displays[displayKey] ?? "all";
  const effectiveRole = role === "off" ? "all" : role;
  const wantVideo = effectiveRole !== "lyrics" && settings.video.enabled;

  useBeatLoop();

  useEffect(() => {
    const offs: Array<() => void> = [];
    let disposed = false;
    const keep = (off: () => void) => (disposed ? off() : offs.push(off));
    on<WsState>("ws-state", (s) => {
      const prev = latest.current;
      if (
        prev &&
        (prev.offsetMs !== s.offsetMs ||
          prev.playing !== s.playing ||
          prev.track?.key !== s.track?.key ||
          Math.abs(s.positionMs - (prev.positionMs + (prev.playing ? Math.max(0, s.sampledAtMs - prev.sampledAtMs) : 0))) > 650)
      ) {
        setSyncSeq((n) => n + 1);
      }
      latest.current = s;
      setState(s);
    }).then(keep);
    on<Lyrics>("ws-lyrics", (l) => {
      lyricsFor.current = l.trackKey;
      setLyrics(lyricsState(l));
    }).then(keep);
    on<{ covered: boolean }>("visibility", (v) => setFramePaused(v.covered)).then(keep);
    if (inTauri) {
      connectNative({
        onTrack: () => {},
        onPosition: () => {},
        onLyrics: () => {},
        onBeat: (b) => {
          beat.level = b.level;
          if (b.kick) beat.flash = 1;
        },
        onAudioError: () => {},
      }).then(keep);
    }
    // Ask the main screen to send what it has.
    send<WsCmd>("ws-cmd", { type: "hello" });
    return () => {
      disposed = true;
      offs.forEach((o) => o());
    };
  }, []);

  // Muted copy of the video, kept in step with the main screen (skipped when this display hides video).
  const player = useMemo(() => ({ current: null as YtPlayer | null, id: null as string | null }), []);
  const syncMirror = useCallback(() => {
    const s = latest.current;
    const host = videoHost.current;
    if (!wantVideo) {
      player.current?.stop();
      player.id = null;
      return;
    }
    if (!s || !host) return;
    const target = s.positionMs + (s.playing ? Date.now() - s.sampledAtMs : 0);
    if (!s.videoId || s.visual !== "video") {
      player.current?.stop();
      player.id = null;
      return;
    }
    player.current ??= new YtPlayer(host, { onState: () => {}, onError: () => {} }, true);
    if (player.id !== s.videoId) {
      player.id = s.videoId;
      void player.current.load(s.videoId, target / 1000).catch(() => {});
      return;
    }
    if (Math.abs(player.current.positionMs() - target) > MIRROR_TOLERANCE_MS) player.current.seekMs(target);
    if (s.playing && !player.current.isPlaying()) player.current.play();
    if (!s.playing && player.current.isPlaying()) player.current.pause();
  }, [player, wantVideo]);

  useEffect(() => {
    syncMirror();
  }, [state?.videoId, state?.playing, state?.visual, wantVideo, syncMirror]);

  useEffect(() => {
    if (!wantVideo) return;
    const id = setInterval(syncMirror, 1000);
    return () => clearInterval(id);
  }, [wantVideo, syncMirror]);

  const timeMs = useCallback(() => {
    const s = latest.current;
    if (!s) return 0;
    return s.positionMs + (s.playing ? Date.now() - s.sampledAtMs : 0) + s.offsetMs + LYRIC_LEAD_MS;
  }, []);

  const track = state?.track ?? null;
  const shownLyrics: LyricsState = track && lyricsFor.current === track.key ? lyrics : { kind: track ? "loading" : "none" };
  return (
    <Scene
      settings={settings}
      role={effectiveRole}
      track={track}
      lyrics={shownLyrics}
      showVideo={wantVideo && !!state?.videoId && state.visual === "video"}
      videoHost={videoHost}
      timeMs={timeMs}
      playing={state?.playing ?? false}
      syncSeq={syncSeq}
      audioError={null}
    />
  );
}
