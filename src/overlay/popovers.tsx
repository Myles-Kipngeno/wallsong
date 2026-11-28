import { useState } from "react";
import { saveSettings, type Settings } from "../lib/settings";
import type { MusicItem, NowTrack, SessionInfo, WsState } from "../lib/types";
import { Icon } from "./icons";
import { command } from "./shared";

/**
 * The small menus shared by the player bar (v0.3 layout), the Dock's Controls tile
 * and the player menu: where music comes from, more, sleep timer, lyrics timing,
 * volume. Each renders its own `.popover` box; the caller decides where it sits.
 */

const NUDGE_STEP_MS = 250;

/** Where music comes from, in words (the source button's tooltip). */
export function sourceLabel(settings: Settings, sessions: SessionInfo[]): string {
  if (settings.source === "wallsong") return "Wallsong only";
  if (settings.source === "auto") return "Automatic";
  return sessions.find((s) => s.id === settings.source)?.name ?? settings.source;
}

/** The song playing is in your liked songs. */
export function isLiked(settings: Settings, item: MusicItem | null): boolean {
  return !!item?.videoId && settings.liked.some((l) => l.videoId === item.videoId);
}

/** Adds the song to your liked songs, or takes it out. Only Wallsong's own songs can be liked. */
export function toggleLike(settings: Settings, item: MusicItem | null): void {
  if (!item?.videoId) return;
  const next = isLiked(settings, item)
    ? settings.liked.filter((l) => l.videoId !== item.videoId)
    : [{ videoId: item.videoId, title: item.title, artists: item.artists, thumbnail: item.thumbnail }, ...settings.liked].slice(0, 200);
  void saveSettings({ liked: next });
}

/** "More": go to the artist or the album, copy the link, search for the song. */
export function MorePopover({
  track,
  item,
  onGoToArtist,
  onGoToAlbum,
  onSearch,
  onDone,
}: {
  track: NowTrack;
  item: MusicItem | null;
  onGoToArtist: (name: string) => void;
  onGoToAlbum: (name: string, artist: string) => void;
  /** Opens search with this text. */
  onSearch: (query: string) => void;
  onDone: () => void;
}) {
  return (
    <div className="popover pop-more" data-hit>
      {track.artists[0] && (
        <button className="pop-item" onClick={() => (onGoToArtist(track.artists[0]), onDone())}>
          Go to {track.artists[0]}
        </button>
      )}
      {track.album && (
        <button className="pop-item" onClick={() => (onGoToAlbum(track.album, track.artists[0] ?? ""), onDone())}>
          Go to the album
        </button>
      )}
      {item?.videoId && (
        <button
          className="pop-item"
          onClick={() => {
            void navigator.clipboard?.writeText(`https://music.youtube.com/watch?v=${item.videoId}`);
            onDone();
          }}
        >
          Copy link
        </button>
      )}
      <button className="pop-item" onClick={() => (onSearch(`${track.title} ${track.artists[0] ?? ""}`), onDone())}>
        Search for this song
      </button>
    </div>
  );
}

export function SourcePopover({ settings, sessions }: { settings: Settings; sessions: SessionInfo[] }) {
  return (
    <div className="popover pop-source" data-hit>
      <p className="pop-title">Play from</p>
      <SourceRow
        label="Wallsong · YouTube Music"
        hint="Only songs you play from Wallsong search"
        active={settings.source === "wallsong"}
        onClick={() => void saveSettings({ source: "wallsong" })}
      />
      <SourceRow label="Automatic" hint="Wallsong, or whichever app is playing" active={settings.source === "auto"} onClick={() => void saveSettings({ source: "auto" })} />
      {sessions.length > 0 && <p className="pop-title">Follow one app</p>}
      {sessions.map((s) => (
        <SourceRow
          key={s.id}
          label={s.name}
          hint={s.playing ? `Playing: ${s.title}` : s.title || "Paused"}
          active={settings.source === s.id}
          dot={s.playing}
          onClick={() => void saveSettings({ source: s.id })}
        />
      ))}
      {sessions.length === 0 && <p className="pop-hint">No other players open. Play something in Brave or Spotify and it shows here.</p>}
    </div>
  );
}

export function SleepPopover({ ws, onDone }: { ws: WsState | null; onDone: () => void }) {
  const sleeping = ws?.sleepAt != null;
  return (
    <div className="popover pop-sleep" data-hit>
      <p className="pop-title">Sleep timer</p>
      {[15, 30, 45, 60].map((m) => (
        <button key={m} className="pop-item" onClick={() => (command({ type: "sleep", minutes: m }), onDone())}>
          {m} minutes
        </button>
      ))}
      <button className="pop-item" onClick={() => (command({ type: "sleep", minutes: -1 }), onDone())}>
        End of this song
      </button>
      {sleeping && (
        <button className="pop-item danger" onClick={() => (command({ type: "sleep", minutes: 0 }), onDone())}>
          Turn off{ws?.sleepAt && ws.sleepAt > 0 ? ` (${Math.max(1, Math.round((ws.sleepAt - Date.now()) / 60000))} min left)` : ""}
        </button>
      )}
    </div>
  );
}

export function TimingPopover({ ws }: { ws: WsState | null }) {
  const offset = ws?.offsetMs ?? 0;
  return (
    <div className="popover pop-timing" data-hit>
      <p className="pop-title">Lyrics timing for this song</p>
      <div className="timing-row">
        <button className="ib" onClick={() => command({ type: "nudge", deltaMs: -NUDGE_STEP_MS })} title="Lyrics later">
          −
        </button>
        <span className="timing-value">
          {offset > 0 ? "+" : ""}
          {(offset / 1000).toFixed(2)} s
        </span>
        <button className="ib" onClick={() => command({ type: "nudge", deltaMs: NUDGE_STEP_MS })} title="Lyrics sooner">
          +
        </button>
      </div>
      <p className="pop-hint">Lyrics early? Press −. Late? Press +. Wallsong remembers it for this song.</p>
      {offset !== 0 && (
        <button className="pop-item" onClick={() => command({ type: "nudge", deltaMs: -offset })}>
          Reset to 0
        </button>
      )}
    </div>
  );
}

/** Wallsong's own player volume. `vertical` is the player card's upright slider. */
export function VolumePopover({ ws, vertical = false }: { ws: WsState | null; vertical?: boolean }) {
  // While dragging, show the slider's own value rather than waiting for the player to report it.
  const [dragging, setDragging] = useState<number | null>(null);
  const value = dragging ?? ws?.volume ?? 80;
  return (
    <div className={`popover pop-volume${vertical ? " vertical" : ""}`} data-hit>
      <input
        type="range"
        min={0}
        max={100}
        value={value}
        onChange={(e) => {
          const next = Number(e.target.value);
          setDragging(next);
          command({ type: "volume", value: next });
        }}
        onPointerUp={() => setDragging(null)}
        aria-label="Volume"
      />
      <span>{value}</span>
    </div>
  );
}

function SourceRow({ label, hint, active, dot, onClick }: { label: string; hint: string; active: boolean; dot?: boolean; onClick: () => void }) {
  return (
    <button className={`pop-item source-row${active ? " active" : ""}`} onClick={onClick}>
      <span className="source-text">
        <span>
          {label}
          {dot && <i className="live-dot" />}
        </span>
        <small>{hint}</small>
      </span>
      {active && <Icon name="check" size={15} />}
    </button>
  );
}
