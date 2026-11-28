import { call, send } from "../lib/bus";
import type { Lyrics, MusicItem, NowTrack, PlayMode, Position, RepeatMode, TrackInfo, WsCmd, WsState } from "../lib/types";
import { YtPlayer, type PlayerState } from "./ytPlayer";

/**
 * The brain of Wallsong. Lives in the wallpaper window (always running).
 *
 * Two modes:
 * - "wallsong": Wallsong's own YouTube player is playing something you searched.
 * - "follow":   another app (Spotify in Brave, a YouTube Music tab...) is playing;
 *               Wallsong reads it from Windows, as in week 1.
 * Starting a song in Wallsong pauses the other app. Starting music in another
 * app while Wallsong is paused switches back to follow.
 */

const OFFSETS_KEY = "wallsong.lyricOffsets";
const MAX_OFFSET_MS = 10_000;
/** After Wallsong starts a song, the other app may still report "playing" for a moment. */
const CLAIM_GRACE_MS = 1200;

function loadOffsets(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(OFFSETS_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function offsetKey(track: NowTrack): string {
  return `${track.title}|${track.artists[0] ?? ""}`.toLowerCase();
}

function shuffle<T>(items: T[]): T[] {
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error("timed out")), ms))]);
}

export class Controller {
  mode: PlayMode = "idle";
  track: NowTrack | null = null;
  visual: "video" | "audio" | null = null;

  readonly player: YtPlayer;
  private current: MusicItem | null = null;
  private playingVideoId: string | null = null;
  private triedAudioFallback = false;
  private playerState: PlayerState = "unstarted";
  private queue: MusicItem[] = [];
  private history: MusicItem[] = [];
  private notice: string | null = null;
  private videos: MusicItem[] = [];
  private videoIndex = 0;
  private repeat: RepeatMode = "off";
  /** Epoch ms to stop at, -1 = end of this song, null = off. */
  private sleepAt: number | null = null;
  private startedAt = 0;
  /** "wallsong" in Settings > Source: ignore other apps entirely. */
  private wallsongOnly = false;
  private lastLyrics: Lyrics | null = null;
  private reportedPlaying = false;
  private noticeTimer: number | undefined;
  private offsets = loadOffsets();
  private followTrack: TrackInfo | null = null;
  private followPosition: Position | null = null;
  /** When Wallsong last took over playback. */
  private claimedAt = 0;
  /** Bumped on every new song, so slow answers for an old song are dropped. */
  private loadToken = 0;
  /** Bumped on seek, play/pause, or offset change so lyrics re-sync immediately. */
  private syncSeq = 0;
  private lastBroadcastPlaying = false;
  private lastBroadcastKey = "";
  private prefetchCache = new Map<string, { videos?: MusicItem[]; artworkDataUrl?: string; lyrics?: Lyrics }>();
  private prefetchingVideoId: string | null = null;
  private listeners = new Set<() => void>();
  private timer: number;
  private warmTimer: number;

  constructor(
    videoHost: HTMLElement,
    private readonly showLyrics: (lyrics: Lyrics) => void,
  ) {
    this.player = new YtPlayer(videoHost, {
      onState: (s) => this.handleState(s),
      onError: (code) => this.handleError(code),
    });
    this.timer = window.setInterval(() => this.tick(), 250);
    // Warm YouTube's IFrame API shortly after boot so the first clicked song doesn't stall downloading it.
    this.warmTimer = window.setTimeout(() => this.player.warm(), 350);
  }

  /** Lyrics for whatever is on screen; also sent to the other screens. */
  onLyrics(lyrics: Lyrics): void {
    this.lastLyrics = lyrics;
    this.showLyrics(lyrics);
    send<Lyrics>("ws-lyrics", lyrics);
  }

  setWallsongOnly(on: boolean): void {
    if (this.wallsongOnly === on) return;
    this.wallsongOnly = on;
    if (on && this.mode === "follow") {
      this.mode = "idle";
      this.track = null;
      this.changed();
    } else if (!on && this.mode !== "wallsong") {
      this.showFollowTrack();
    }
  }

  private tick(): void {
    // Sleep timer.
    if (this.sleepAt !== null && this.sleepAt > 0 && Date.now() >= this.sleepAt) {
      this.sleepAt = null;
      this.pauseEverything();
      this.flash("Sleep timer: paused");
    }
    const playing = this.isPlaying();
    if (playing !== this.reportedPlaying) {
      this.reportedPlaying = playing;
      this.bumpSync();
      void call("set_playing", { playing }).catch(() => {});
    }

    // Preload next queued song at 40% or 30s remaining.
    if (this.mode === "wallsong" && playing && this.queue.length > 0) {
      const nextItem = this.queue[0];
      const pos = this.positionMs();
      const dur = this.track?.durationMs ?? 0;
      if (nextItem?.videoId && nextItem.videoId !== this.prefetchingVideoId && dur > 0 && (pos >= dur * 0.4 || (dur - pos) <= 30_000)) {
        this.prefetchNextSong(nextItem);
      }
    }

    this.broadcast();
  }

  private pauseEverything(): void {
    if (this.mode === "wallsong") this.player.pause();
    else if (this.followPosition?.playing) void call("media_control", { action: "toggle" }).catch(() => {});
    this.changed();
  }

  dispose(): void {
    clearInterval(this.timer);
    clearTimeout(this.warmTimer);
    this.player.stop();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  syncRevision(): number {
    return this.syncSeq;
  }

  private bumpSync(): void {
    this.syncSeq++;
  }

  private changed(bumpLyrics = false): void {
    if (bumpLyrics) this.bumpSync();
    this.listeners.forEach((l) => l());
    this.broadcast(true);
  }

  private flash(message: string): void {
    this.notice = message;
    clearTimeout(this.noticeTimer);
    this.noticeTimer = window.setTimeout(() => {
      this.notice = null;
      this.changed();
    }, 5000);
    this.changed();
  }

  // ---------- what the wallpaper reads every frame ----------

  /** Song time in ms, before the lyric offset. */
  positionMs(): number {
    if (this.mode === "wallsong") return this.player.positionMs();
    const p = this.followPosition;
    if (!p) return 0;
    return p.positionMs + (p.playing ? Date.now() - p.sampledAtMs : 0);
  }

  offsetMs(): number {
    return this.track ? (this.offsets[offsetKey(this.track)] ?? 0) : 0;
  }

  isPlaying(): boolean {
    if (this.mode === "wallsong") return this.playerState === "playing" || this.playerState === "buffering";
    return this.followPosition?.playing ?? false;
  }

  // ---------- other apps (Windows media session) ----------

  onNativeTrack(t: TrackInfo | null): void {
    const prevKey = this.followTrack?.key;
    this.followTrack = t;
    if (this.wallsongOnly) return;
    if (
      this.mode === "wallsong" &&
      !this.isPlaying() &&
      t &&
      t.key !== prevKey &&
      this.followPosition?.playing &&
      Date.now() - this.claimedAt > CLAIM_GRACE_MS
    ) {
      this.mode = "follow";
      this.bumpSync();
    }
    if (this.mode !== "wallsong") this.showFollowTrack();
  }

  onNativePosition(p: Position): void {
    const prev = this.followPosition;
    const wasPlaying = prev?.playing ?? false;
    let jumped = false;
    if (prev) {
      const predicted = prev.positionMs + (prev.playing ? Math.max(0, p.sampledAtMs - prev.sampledAtMs) : 0);
      if (Math.abs(p.positionMs - predicted) > 650) jumped = true;
    }
    this.followPosition = p;
    // You pressed play in another app (a rising edge, not a leftover "playing" from
    // before Wallsong paused it): one player at a time, so Wallsong steps aside.
    const startedElsewhere = p.playing && !wasPlaying && Date.now() - this.claimedAt > CLAIM_GRACE_MS;
    if (this.wallsongOnly) return;
    if (this.mode === "wallsong" && startedElsewhere) {
      this.player.pause();
      this.mode = "follow";
      this.bumpSync();
      this.showFollowTrack();
    } else if (this.mode === "idle" && this.followTrack) {
      this.mode = "follow";
      this.bumpSync();
      this.showFollowTrack();
    } else if (p.playing !== wasPlaying || jumped) {
      this.changed(true);
    }
  }

  private showFollowTrack(): void {
    const t = this.followTrack;
    this.track = t
      ? { key: t.key, title: t.title, artists: [t.artist].filter(Boolean), album: t.album, durationMs: t.durationMs, artwork: t.artwork }
      : null;
    if (!t && this.mode === "follow") this.mode = "idle";
    this.visual = null;
    this.changed();
  }

  // ---------- commands from the deck ----------

  command(cmd: WsCmd): void {
    switch (cmd.type) {
      case "play":
        void this.play(cmd.item);
        break;
      case "playList": {
        const items = cmd.items.filter((i) => i.videoId);
        if (!items.length) break;
        let order = items.slice(cmd.start).concat(items.slice(0, cmd.start));
        if (cmd.shuffle) order = shuffle(items);
        const [first, ...rest] = order;
        this.queue = rest;
        void this.play(first);
        break;
      }
      case "pickVideo":
        this.pickVideo(cmd.index);
        break;
      case "repeat":
        this.repeat = this.repeat === "off" ? "all" : this.repeat === "all" ? "one" : "off";
        this.flash(this.repeat === "off" ? "Repeat off" : this.repeat === "all" ? "Repeat up next" : "Repeat this song");
        break;
      case "sleep":
        this.sleepAt = cmd.minutes === 0 ? null : cmd.minutes < 0 ? -1 : Date.now() + cmd.minutes * 60_000;
        this.flash(cmd.minutes === 0 ? "Sleep timer off" : cmd.minutes < 0 ? "Stopping after this song" : `Stopping in ${cmd.minutes} min`);
        break;
      case "enqueue":
        this.enqueue(cmd.item, cmd.next);
        break;
      case "shuffle":
        if (this.mode !== "wallsong") break; // other apps shuffle in their own player
        if (this.queue.length < 2) {
          this.flash("Nothing to shuffle in up next yet");
          break;
        }
        this.queue = shuffle(this.queue);
        this.flash(`Shuffled up next (${this.queue.length} songs)`);
        break;
      case "jump": {
        const item = this.queue[cmd.index];
        if (item) {
          this.queue.splice(0, cmd.index + 1);
          void this.play(item);
        }
        break;
      }
      case "toggle":
        if (this.mode === "follow") void call("media_control", { action: "toggle" }).catch(() => {});
        else if (this.isPlaying()) this.player.pause();
        else this.player.play();
        break;
      case "next":
        this.next();
        break;
      case "previous":
        this.previous();
        break;
      case "seek":
        if (this.mode === "wallsong") {
          this.player.seekMs(cmd.ms);
          this.changed(true);
        }
        break;
      case "volume":
        this.player.setVolume(cmd.value);
        this.changed();
        break;
      case "nudge":
        this.nudge(cmd.deltaMs);
        break;
      case "hello":
        this.broadcast(true);
        if (this.lastLyrics) send<Lyrics>("ws-lyrics", this.lastLyrics);
        break;
    }
  }

  private prefetchNextSong(item: MusicItem): void {
    if (!item.videoId || this.prefetchingVideoId === item.videoId) return;
    this.prefetchingVideoId = item.videoId;
    const vid = item.videoId;
    const artist = item.artists[0] ?? "";
    const key = `yt:${vid}`;
    const data: { videos?: MusicItem[]; artworkDataUrl?: string; lyrics?: Lyrics } = {};
    this.prefetchCache.set(vid, data);
    if (this.prefetchCache.size > 5) {
      const oldest = this.prefetchCache.keys().next().value;
      if (oldest) this.prefetchCache.delete(oldest);
    }

    call<MusicItem[]>("yt_videos", { title: item.title, artist })
      .then((videos) => {
        data.videos = videos;
      })
      .catch(() => {});

    if (item.thumbnail) {
      call<string>("fetch_image", { url: item.thumbnail })
        .then((dataUrl) => {
          data.artworkDataUrl = dataUrl;
        })
        .catch(() => {});
    }

    call<Lyrics | null>("fetch_lyrics", {
      key,
      title: item.title,
      artist,
      album: item.album ?? "",
      durationMs: item.durationMs ?? 0,
    })
      .then((l) => {
        data.lyrics = l ?? { trackKey: key, synced: null, plain: null, instrumental: false };
      })
      .catch(() => {});
  }

  private async play(item: MusicItem, fromHistory = false): Promise<void> {
    if (!item.videoId) return;
    const token = ++this.loadToken;
    this.startedAt = Date.now();
    this.videos = [];
    this.videoIndex = 0;
    if (this.current && !fromHistory) this.history = [...this.history.slice(-49), this.current];

    // Ensure the YouTube player script is warming right away.
    this.player.warm();

    // One player at a time: pause the other app if it's playing.
    this.claimedAt = Date.now();
    if (this.followPosition?.playing) {
      void call("media_control", { action: "toggle" }).catch(() => {});
    }

    const cached = this.prefetchCache.get(item.videoId);
    const artist = item.artists[0] ?? "";
    const key = `yt:${item.videoId}`;
    this.mode = "wallsong";
    this.current = item;
    this.triedAudioFallback = false;
    this.track = {
      key,
      title: item.title,
      artists: item.artists,
      album: item.album ?? "",
      durationMs: item.durationMs ?? 0,
      artwork: cached?.artworkDataUrl ?? item.thumbnail,
    };
    this.visual = null;
    this.changed();

    // Launch art, lyrics, video-candidate search, and up-next concurrently at t=0
    // instead of waterfalling them behind the music video lookup.
    if (!cached?.artworkDataUrl && item.thumbnail) {
      call<string>("fetch_image", { url: item.thumbnail })
        .then((dataUrl) => {
          if (token === this.loadToken && this.track) {
            this.track = { ...this.track, artwork: dataUrl };
            this.changed();
          }
        })
        .catch(() => {});
    }

    if (cached?.lyrics) {
      this.onLyrics(cached.lyrics);
    } else {
      call<Lyrics | null>("fetch_lyrics", {
        key,
        title: item.title,
        artist,
        album: item.album ?? "",
        durationMs: item.durationMs ?? 0,
      })
        .then((l) => {
          if (token === this.loadToken) this.onLyrics(l ?? { trackKey: key, synced: null, plain: null, instrumental: false });
        })
        .catch(() => {
          if (token === this.loadToken) this.onLyrics({ trackKey: key, synced: null, plain: null, instrumental: false });
        });
    }

    if (this.queue.length < 3) {
      call<MusicItem[]>("yt_up_next", { videoId: item.videoId })
        .then((items) => {
          if (token !== this.loadToken) return;
          const known = new Set([item.videoId, ...this.queue.map((q) => q.videoId), ...this.history.map((h) => h.videoId)]);
          this.queue.push(...items.filter((i) => i.videoId && !known.has(i.videoId)));
          this.changed();
        })
        .catch((e) => this.flash(`Couldn't load up next: ${e}`));
    }

    const videosPromise = cached?.videos !== undefined ? Promise.resolve(cached.videos) : call<MusicItem[]>("yt_videos", { title: item.title, artist });

    let playId = item.videoId;
    let visual: "video" | "audio" = item.videoType === "MUSIC_VIDEO_TYPE_ATV" ? "audio" : "video";
    if (item.videoType === "MUSIC_VIDEO_TYPE_ATV") {
      try {
        // Wait briefly for the official music video (instant from cache; ~150-350ms on warm pool).
        const videos = await withTimeout(videosPromise, 850);
        if (videos.length && videos[0].videoId) {
          this.videos = videos;
          playId = videos[0].videoId;
          visual = "video";
        }
      } catch {
        // Video search took too long: start the song now and still surface video dots when it finishes.
        videosPromise
          .then((videos) => {
            if (token !== this.loadToken || !videos.length) return;
            this.videos = videos;
            this.changed();
          })
          .catch(() => {});
      }
    } else {
      videosPromise
        .then((videos) => {
          if (token !== this.loadToken) return;
          const others = videos.filter((v) => v.videoId !== item.videoId);
          this.videos = [item, ...others].slice(0, 5);
          this.changed();
        })
        .catch(() => {});
    }
    if (token !== this.loadToken) return;

    this.playingVideoId = playId;
    this.visual = visual;
    this.player.load(playId).catch((e) => this.flash(e instanceof Error ? e.message : String(e)));
    this.changed(true);
  }

  private enqueue(item: MusicItem, next: boolean): void {
    if (!item.videoId) return;
    if (this.mode !== "wallsong" || !this.current) {
      void this.play(item);
      return;
    }
    if (next) this.queue.unshift(item);
    else this.queue.push(item);
    this.flash(next ? `"${item.title}" plays next` : `"${item.title}" added to up next`);
  }

  private next(): void {
    if (this.mode === "follow") {
      void call("media_control", { action: "next" }).catch(() => {});
      return;
    }
    if (this.sleepAt === -1) {
      this.sleepAt = null;
      this.player.pause();
      this.flash("Sleep timer: stopped after the song");
      return;
    }
    if (this.repeat === "all" && this.current) this.queue.push(this.current);
    const upcoming = this.queue.shift();
    if (upcoming) void this.play(upcoming);
    else {
      this.player.pause();
      this.changed();
    }
  }

  private previous(): void {
    if (this.mode === "follow") {
      void call("media_control", { action: "previous" }).catch(() => {});
      return;
    }
    // Like every player: first press restarts the song, second goes back.
    const earlier = this.history.pop();
    if (this.player.positionMs() > 3000 || !earlier) {
      if (earlier) this.history.push(earlier);
      this.player.seekMs(0);
      return;
    }
    if (this.current) this.queue.unshift(this.current);
    void this.play(earlier, true);
  }

  private nudge(deltaMs: number): void {
    if (!this.track) return;
    const key = offsetKey(this.track);
    const next = Math.max(-MAX_OFFSET_MS, Math.min(MAX_OFFSET_MS, (this.offsets[key] ?? 0) + deltaMs));
    if (next === 0) delete this.offsets[key];
    else this.offsets[key] = next;
    try {
      localStorage.setItem(OFFSETS_KEY, JSON.stringify(this.offsets));
    } catch {
      /* storage can be unavailable; the nudge still applies until restart */
    }
    this.changed(true);
  }

  // ---------- player events ----------

  private pickVideo(index: number): void {
    const video = this.videos[index];
    if (!video?.videoId || this.mode !== "wallsong") return;
    const at = this.player.positionMs();
    this.videoIndex = index;
    this.playingVideoId = video.videoId;
    this.visual = "video";
    // Versions differ in length (intros), so start from the beginning unless it's close.
    void this.player.load(video.videoId, at < 15_000 ? at / 1000 : 0);
    this.changed();
  }

  private handleState(state: PlayerState): void {
    const prevPlaying = this.isPlaying();
    this.playerState = state;
    if (state === "ended") {
      if (this.repeat === "one") {
        this.player.seekMs(0);
        this.player.play();
      } else this.next();
    }
    if (state === "playing" && this.track && !this.track.durationMs) {
      this.track = { ...this.track, durationMs: this.player.durationMs() };
    }
    this.changed(prevPlaying !== this.isPlaying());
  }

  private handleError(code: number): void {
    const item = this.current;
    // The music video blocks embedding: fall back to the song's own audio.
    if ((code === 101 || code === 150) && item?.videoId && !this.triedAudioFallback && this.playingVideoId !== item.videoId) {
      this.triedAudioFallback = true;
      this.playingVideoId = item.videoId;
      this.visual = "audio";
      this.flash("This music video can't play inside Wallsong, so the song audio plays instead");
      void this.player.load(item.videoId);
      return;
    }
    if (code === 153) {
      this.flash("YouTube refused to play inside Wallsong (Error 153). See Gate A in the README.");
      return;
    }
    this.flash(`YouTube couldn't play "${item?.title ?? "this"}" (error ${code}), skipping`);
    window.setTimeout(() => this.next(), 1500);
  }

  // ---------- broadcast to the deck ----------

  state(): WsState {
    return {
      mode: this.mode,
      track: this.track,
      playing: this.isPlaying(),
      positionMs: this.positionMs(),
      sampledAtMs: Date.now(),
      item: this.mode === "wallsong" ? this.current : null,
      queue: this.mode === "wallsong" ? this.queue.slice(0, 50) : [],
      history: this.history.slice(-20).reverse(),
      canGoBack: this.history.length > 0,
      volume: this.player.getVolume(),
      offsetMs: this.offsetMs(),
      visual: this.mode === "wallsong" ? this.visual : null,
      videoId: this.mode === "wallsong" ? this.playingVideoId : null,
      videos: this.mode === "wallsong" ? this.videos : [],
      videoIndex: this.videoIndex,
      repeat: this.repeat,
      sleepAt: this.sleepAt,
      startedAt: this.startedAt,
      notice: this.notice,
    };
  }

  private broadcast(force = false): void {
    const s = this.state();
    const stableKey = `${s.mode}|${s.playing}|${s.track?.key ?? ""}|${s.track?.artwork ?? ""}|${s.track?.durationMs ?? 0}|${s.offsetMs}|${s.volume}|${s.visual}|${s.videoId}|${s.videoIndex}|${s.repeat}|${s.sleepAt}|${s.startedAt}|${s.notice}|${s.queue.length}|${s.history.length}|${s.videos.length}|${Math.round(s.positionMs / 250)}`;
    if (!force && !s.playing && !this.lastBroadcastPlaying && stableKey === this.lastBroadcastKey) {
      return;
    }
    this.lastBroadcastPlaying = s.playing;
    this.lastBroadcastKey = stableKey;
    send<WsState>("ws-state", s);
  }
}
