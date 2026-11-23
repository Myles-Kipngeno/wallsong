import type { TrackInfo } from "../lib/types";

/**
 * Glass card with the current song. Read-only for now: the wallpaper sits
 * behind the icons, so clicks never reach it. Controls arrive in week 2 in
 * their own window above the icons.
 */
export function NowPlaying({ track }: { track: TrackInfo | null }) {
  return (
    <div className="now-playing">
      {track?.artwork ? (
        <img className="np-art" src={track.artwork} alt="" />
      ) : (
        <div className="np-art np-art-empty" aria-hidden="true" />
      )}
      <div className="np-text">
        <span className="np-title">{track?.title ?? "Not playing"}</span>
        <span className="np-artist">
          {track ? [track.artist, track.album].filter(Boolean).join(" — ") : "Play something in Spotify or YouTube Music"}
        </span>
      </div>
    </div>
  );
}
