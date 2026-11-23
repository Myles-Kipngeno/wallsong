// Shapes of the events the Rust core emits (serde camelCase).

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
