import { memo, useEffect, useRef } from "react";
import { saveSettings, type Settings } from "../lib/settings";
import type { MusicItem, SessionInfo, WsState } from "../lib/types";
import { Icon } from "./icons";
import type { Open } from "./Overlay";
import { isLiked, MorePopover, SleepPopover, SourcePopover, sourceLabel, TimingPopover, toggleLike, VolumePopover } from "./popovers";
import { Art, command, formatTime, getWsState, livePosition } from "./shared";
import { subscribeFrame } from "../lib/frame";

type Popover = Extract<Open, "source" | "more" | "timing" | "sleep" | "volume">;

/** Search, settings and song-list buttons, plus the search box or video dots. Shared by the bar and the Dock. */
export interface IconRowProps {
  ws: WsState | null;
  open: Open;
  searchOpen: boolean;
  query: string;
  onQuery: (q: string) => void;
  onSubmit: () => void;
  onOpenSearch: () => void;
  onOpenSettings: () => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  collapsed: boolean;
  onCollapse: () => void;
  suggestions: string[];
  onPickSuggestion: (q: string) => void;
}

/** The row above the bar (or the Dock): video dots or search on the left, quick buttons on the right. */
export const IconRow = memo(function IconRow({
  ws,
  open,
  searchOpen,
  query,
  onQuery,
  onSubmit,
  onOpenSearch,
  onOpenSettings,
  inputRef,
  collapsed,
  onCollapse,
  suggestions,
  onPickSuggestion,
}: IconRowProps) {
  const own = ws?.mode === "wallsong";
  const videos = ws?.videos ?? [];
  return (
    <div className="dock-row">
      <div className="dock-left">
        {searchOpen ? (
          <div className="search-wrap" data-hit>
            <label className="search-pill">
              <Icon name="search" size={15} />
              <input
                ref={inputRef}
                value={query}
                placeholder="Search YouTube Music"
                spellCheck={false}
                onChange={(e) => onQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") onSubmit();
                }}
              />
            </label>
            {open === "suggestions" && suggestions.length > 0 && (
              <div className="suggestions">
                {suggestions.slice(0, 6).map((s) => (
                  <button key={s} onMouseDown={(e) => e.preventDefault()} onClick={() => onPickSuggestion(s)}>
                    <Icon name="search" size={13} />
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          own &&
          videos.length > 1 && (
            <div className="video-dots" data-hit>
              {videos.map((v, i) => (
                <button
                  key={v.videoId ?? i}
                  className={i === ws?.videoIndex ? "on" : ""}
                  title={`${v.title}${v.artists.length ? ` · ${v.artists.join(", ")}` : ""}`}
                  onClick={() => command({ type: "pickVideo", index: i })}
                />
              ))}
            </div>
          )
        )}
      </div>
      <div className="dock-right" data-hit>
        <button className={`ghost${searchOpen ? " on" : ""}`} title="Search (Ctrl+Alt+Space)" onClick={onOpenSearch}>
          <Icon name="search" size={16} />
        </button>
        <button className="ghost" title="Settings" onClick={onOpenSettings}>
          <Icon name="settings" size={16} />
        </button>
        <button className="ghost" title={collapsed ? "Show the song list" : "Hide the song list"} onClick={onCollapse}>
          <Icon name={collapsed ? "expand" : "collapse"} size={16} />
        </button>
      </div>
    </div>
  );
});

/** The v0.3 player bar (Settings > Controls > Bottom of the screen: Player bar). */
export const PlayerBar = memo(function PlayerBar({
  settings,
  sessions,
  setOpen,
  onGoToArtist,
  onGoToAlbum,
  onOpenPlayer,
  ...row
}: IconRowProps & {
  settings: Settings;
  sessions: SessionInfo[];
  setOpen: React.Dispatch<React.SetStateAction<Open>>;
  onGoToArtist: (name: string) => void;
  onGoToAlbum: (name: string, artist: string) => void;
  /** Clicking the art opens the floating player card. */
  onOpenPlayer: (from: HTMLElement) => void;
}) {
  const { ws, open: popover, onQuery, onOpenSearch } = row;
  const closePopover = () => setOpen(null);

  // Pressing the button of a menu that's already open closes it.
  const toggle = (p: Popover) => setOpen((cur) => (cur === p ? null : p));
  const track = ws?.track ?? null;
  const own = ws?.mode === "wallsong";
  const durationMs = track?.durationMs ?? 0;
  const item: MusicItem | null = ws?.item ?? null;
  const liked = isLiked(settings, item);
  const offset = ws?.offsetMs ?? 0;
  const sleeping = ws?.sleepAt != null;

  const barRef = useRef<HTMLDivElement>(null);
  const progressBoxRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    return subscribeFrame(() => {
      const state = getWsState();
      const dur = state?.track?.durationMs ?? 0;
      if (barRef.current && dur > 0) {
        const p = Math.min(1, livePosition(state) / dur);
        barRef.current.style.transform = `scaleX(${p.toFixed(4)})`;
      }
    }, 30);
  }, []);

  useEffect(() => {
    return subscribeFrame(() => {
      const state = getWsState();
      const dur = state?.track?.durationMs ?? 0;
      const pos = livePosition(state);
      if (progressBoxRef.current) {
        progressBoxRef.current.title = `${formatTime(pos)} / ${formatTime(dur)}`;
      }
    }, 4);
  }, []);

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!own || durationMs <= 0) return;
    const box = e.currentTarget.getBoundingClientRect();
    command({ type: "seek", ms: ((e.clientX - box.left) / box.width) * durationMs });
  };

  const initialPos = livePosition(ws);
  const initialProg = durationMs > 0 ? Math.min(1, initialPos / durationMs) : 0;

  return (
    <div className="dock">
      <IconRow {...row} />

      <div className="bar" data-hit>
        <button className={`src-btn pop-trigger mode-${ws?.mode ?? "idle"}`} title={`Source: ${sourceLabel(settings, sessions)}`} onClick={() => toggle("source")}>
          <Icon name="source" size={16} />
        </button>
        <button className="ib" onClick={() => command({ type: "previous" })} disabled={!track} title="Previous">
          <Icon name="prev" size={16} />
        </button>
        <button className="ib play" onClick={() => command({ type: "toggle" })} disabled={!track} title={ws?.playing ? "Pause" : "Play"}>
          <Icon name={ws?.playing ? "pause" : "play"} size={18} />
        </button>
        <button className="ib" onClick={() => command({ type: "next" })} disabled={!track} title="Next">
          <Icon name="next" size={16} />
        </button>
        <button
          className={`ib${ws?.repeat && ws.repeat !== "off" ? " on" : ""}`}
          onClick={() => command({ type: "repeat" })}
          disabled={!own}
          title={ws?.repeat === "one" ? "Repeating this song" : ws?.repeat === "all" ? "Repeating up next" : "Repeat"}
        >
          <Icon name={ws?.repeat === "one" ? "repeatOne" : "repeat"} size={15} />
        </button>

        <div className="now">
          <button className="now-art" onClick={(e) => track && onOpenPlayer(e.currentTarget)} disabled={!track} title="Open the player">
            <Art src={track?.artwork} size="3.2vh" />
          </button>
          <div className="now-text">
            <span className="now-title">{track?.title ?? "Not playing"}</span>
            <span className="now-sub">
              {track ? [track.artists.join(", "), track.album].filter(Boolean).join(" — ") : "Search, or play something in another app"}
            </span>
            <div ref={progressBoxRef} className={`now-progress${own ? " seekable" : ""}`} onClick={seek} title={`${formatTime(initialPos)} / ${formatTime(durationMs)}`}>
              <div ref={barRef} className="now-fill" style={{ width: "100%", transformOrigin: "left", transform: `scaleX(${initialProg.toFixed(4)})` }} />
            </div>
          </div>
        </div>

        <button className={`ib${liked ? " on" : ""}`} onClick={() => toggleLike(settings, item)} disabled={!item?.videoId} title={liked ? "Remove from liked" : "Like"}>
          <Icon name={liked ? "heartFill" : "heart"} size={15} />
        </button>
        <button className="ib pop-trigger" onClick={() => toggle("more")} disabled={!track} title="More">
          <Icon name="more" size={16} />
        </button>
        <button
          className={`ib${settings.lyrics.visible ? " on" : ""}`}
          onClick={() => void saveSettings({ lyrics: { visible: !settings.lyrics.visible } })}
          title={settings.lyrics.visible ? "Hide lyrics" : "Show lyrics"}
        >
          <Icon name="lyrics" size={15} />
        </button>
        <button className={`ib pop-trigger${offset !== 0 ? " on" : ""}`} onClick={() => toggle("timing")} disabled={!track} title="Lyrics timing">
          <Icon name="timing" size={15} />
        </button>
        <button className={`ib pop-trigger${sleeping ? " on" : ""}`} onClick={() => toggle("sleep")} title="Sleep timer">
          <Icon name="moon" size={15} />
        </button>
        <button className="ib pop-trigger" onClick={() => toggle("volume")} disabled={!own} title={own ? "Volume" : "Volume is in the app that's playing"}>
          <Icon name={(ws?.volume ?? 80) === 0 ? "volumeOff" : "volume"} size={16} />
        </button>

        {popover === "source" && <SourcePopover settings={settings} sessions={sessions} />}
        {popover === "sleep" && <SleepPopover ws={ws} onDone={closePopover} />}
        {popover === "timing" && <TimingPopover ws={ws} />}
        {popover === "volume" && <VolumePopover ws={ws} />}

        {popover === "more" && track && (
          <MorePopover
            track={track}
            item={item}
            onGoToArtist={onGoToArtist}
            onGoToAlbum={onGoToAlbum}
            onSearch={(q) => (onQuery(q), onOpenSearch())}
            onDone={closePopover}
          />
        )}
      </div>
    </div>
  );
});
