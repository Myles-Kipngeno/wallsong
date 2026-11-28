/**
 * Thin wrapper around YouTube's official IFrame Player API.
 * The player fills the wallpaper, so the music video IS the playback:
 * picture and sound can never drift apart.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
declare global {
  interface Window {
    YT?: any;
    onYouTubeIframeAPIReady?: () => void;
  }
}

export type PlayerState = "unstarted" | "playing" | "paused" | "buffering" | "ended";

export interface PlayerEvents {
  onState: (state: PlayerState) => void;
  /** YouTube error codes: 2 bad id, 5 HTML5 error, 100 removed, 101/150 embedding blocked, 153 missing referrer. */
  onError: (code: number) => void;
}

let apiLoading: Promise<void> | null = null;

function loadApi(): Promise<void> {
  if (window.YT?.Player) return Promise.resolve();
  apiLoading ??= new Promise<void>((resolve, reject) => {
    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve();
    };
    const script = document.createElement("script");
    script.src = "https://www.youtube.com/iframe_api";
    script.onerror = () => {
      apiLoading = null;
      reject(new Error("Couldn't load YouTube's player. Check your internet connection."));
    };
    document.head.appendChild(script);
  });
  return apiLoading;
}

const STATES: Record<number, PlayerState> = { [-1]: "unstarted", 0: "ended", 1: "playing", 2: "paused", 3: "buffering", 5: "unstarted" };

export class YtPlayer {
  private player: any = null;
  private ready: Promise<void> | null = null;
  private volume = 80;
  private playing = false;
  private loadSeq = 0;
  /** YouTube only reports the time a few times a second; we smooth between reports. */
  private lastRaw = -1;
  private lastRawAt = 0;

  constructor(
    private readonly host: HTMLElement,
    private readonly events: PlayerEvents,
    /** Mirrors on other screens play silently. */
    private readonly muted = false,
  ) {}

  /** Pre-downloads YouTube's IFrame API script so the first play starts without cold script wait. */
  warm(): void {
    void loadApi().catch(() => {});
  }

  /** Creates the player on first use, so YouTube isn't loaded until you play something. */
  private ensure(): Promise<void> {
    this.ready ??= loadApi().then(
      () =>
        new Promise<void>((resolve) => {
          const mount = document.createElement("div");
          this.host.appendChild(mount);
          this.player = new window.YT.Player(mount, {
            width: "100%",
            height: "100%",
            playerVars: {
              autoplay: 1,
              mute: this.muted ? 1 : 0,
              controls: 0,
              disablekb: 1,
              fs: 0,
              iv_load_policy: 3,
              playsinline: 1,
              rel: 0,
              cc_load_policy: 0,
              origin: window.location.origin,
            },
            events: {
              onReady: () => {
                if (this.muted) this.player.mute();
                else this.player.setVolume(this.volume);
                this.hideCaptions();
                resolve();
              },
              onStateChange: (e: any) => {
                const state = STATES[e.data] ?? "unstarted";
                this.playing = state === "playing";
                this.lastRaw = -1; // resync after seeks, pauses and new videos
                if (state === "playing") this.hideCaptions();
                this.events.onState(state);
              },
              onError: (e: any) => this.events.onError(Number(e.data)),
            },
          });
        }),
    );
    // If YouTube couldn't load (offline), try again on the next play instead of failing forever.
    this.ready.catch(() => {
      this.ready = null;
    });
    return this.ready;
  }

  /** YouTube's own captions ("[Music]") would show over the wallpaper; Wallsong draws its own lyrics. */
  private hideCaptions(): void {
    try {
      this.player?.unloadModule("captions");
    } catch {
      /* not loaded, or this player has no captions module */
    }
    try {
      this.player?.unloadModule("cc");
    } catch {
      /* same, under its older name */
    }
  }

  async load(videoId: string, startSeconds = 0): Promise<void> {
    const seq = ++this.loadSeq;
    await this.ensure();
    if (seq !== this.loadSeq) return;
    this.player.loadVideoById({ videoId, startSeconds });
  }

  play(): void {
    this.player?.playVideo();
  }

  pause(): void {
    this.player?.pauseVideo();
  }

  stop(): void {
    this.player?.stopVideo();
  }

  seekMs(ms: number): void {
    this.lastRaw = -1;
    this.player?.seekTo(ms / 1000, true);
  }

  setVolume(value: number): void {
    this.volume = Math.max(0, Math.min(100, Math.round(value)));
    if (!this.muted) this.player?.setVolume(this.volume);
  }

  isPlaying(): boolean {
    return this.playing;
  }

  getVolume(): number {
    return this.volume;
  }

  positionMs(): number {
    const raw = Math.round((this.player?.getCurrentTime?.() ?? 0) * 1000);
    const now = performance.now();
    if (raw !== this.lastRaw) {
      this.lastRaw = raw;
      this.lastRawAt = now;
      return raw;
    }
    // Same report as last frame: count forward ourselves, but never more than a second.
    return this.playing ? raw + Math.min(1000, now - this.lastRawAt) : raw;
  }

  durationMs(): number {
    return Math.round((this.player?.getDuration?.() ?? 0) * 1000);
  }
}
