import { memo } from "react";
import { saveSettings, type Settings } from "../../lib/settings";
import type { SessionInfo, WsState } from "../../lib/types";
import { Icon } from "../icons";
import type { Open } from "../Overlay";
import { isLiked, sourceLabel, toggleLike } from "../popovers";
import { command } from "../shared";

/** The popovers the Controls tile opens. They open upward from the tile and close with the scrim. */
export type ControlsPopover = Extract<Open, "source" | "more" | "timing" | "sleep" | "volume">;

/**
 * Every control of the v0.3 player bar, with the bar's icons, in two rows:
 * source, previous, play/pause, next, repeat, shuffle;
 * like, more, lyrics on/off, lyrics timing, sleep timer, volume.
 * The popovers are the bar's own (popovers.tsx); the control layer draws them above the tile.
 */
export const ControlsTile = memo(function ControlsTile({
  ws,
  settings,
  sessions,
  open,
  onPopover,
}: {
  ws: WsState | null;
  settings: Settings;
  sessions: SessionInfo[];
  open: Open;
  /** Opens (or, if it's already open, closes) a popover for the button pressed. */
  onPopover: (name: ControlsPopover, button: HTMLElement) => void;
}) {
  const track = ws?.track ?? null;
  const own = ws?.mode === "wallsong";
  const item = ws?.item ?? null;
  const liked = isLiked(settings, item);
  const offset = ws?.offsetMs ?? 0;
  const sleeping = ws?.sleepAt != null;

  // Only the buttons act; the tile itself does nothing on click.
  const act = (fn: (button: HTMLButtonElement) => void) => (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    fn(e.currentTarget);
  };
  const pop = (name: ControlsPopover) => act((button) => onPopover(name, button));
  const is = (name: ControlsPopover) => (open === name ? " open" : "");

  return (
    <div className="dk-ctl">
      <div className="dk-ctl-row">
        <button className={`src-btn pop-trigger mode-${ws?.mode ?? "idle"}${is("source")}`} title={`Source: ${sourceLabel(settings, sessions)}`} onClick={pop("source")}>
          <Icon name="source" size={15} />
        </button>
        <button onClick={act(() => command({ type: "previous" }))} disabled={!track} title="Previous">
          <Icon name="prev" size={15} />
        </button>
        <button className="main" onClick={act(() => command({ type: "toggle" }))} disabled={!track} title={ws?.playing ? "Pause" : "Play"}>
          <Icon name={ws?.playing ? "pause" : "play"} size={16} />
        </button>
        <button onClick={act(() => command({ type: "next" }))} disabled={!track} title="Next">
          <Icon name="next" size={15} />
        </button>
        <button
          className={ws?.repeat && ws.repeat !== "off" ? "on" : ""}
          onClick={act(() => command({ type: "repeat" }))}
          disabled={!own}
          title={!own ? "Repeat is in the app that's playing" : ws?.repeat === "one" ? "Repeating this song" : ws?.repeat === "all" ? "Repeating up next" : "Repeat"}
        >
          <Icon name={ws?.repeat === "one" ? "repeatOne" : "repeat"} size={14} />
        </button>
        <button onClick={act(() => command({ type: "shuffle" }))} disabled={!own} title={own ? "Shuffle up next" : "Shuffle is in the app that's playing"}>
          <Icon name="shuffle" size={14} />
        </button>
      </div>
      <div className="dk-ctl-row">
        <button className={liked ? "on" : ""} onClick={act(() => toggleLike(settings, item))} disabled={!item?.videoId} title={liked ? "Remove from liked" : "Like"}>
          <Icon name={liked ? "heartFill" : "heart"} size={14} />
        </button>
        <button className={`pop-trigger${is("more")}`} onClick={pop("more")} disabled={!track} title="More">
          <Icon name="more" size={15} />
        </button>
        <button
          className={settings.lyrics.visible ? "on" : ""}
          onClick={act(() => void saveSettings({ lyrics: { visible: !settings.lyrics.visible } }))}
          title={settings.lyrics.visible ? "Hide lyrics" : "Show lyrics"}
        >
          <Icon name="lyrics" size={14} />
        </button>
        <button className={`pop-trigger${offset !== 0 ? " on" : ""}${is("timing")}`} onClick={pop("timing")} disabled={!track} title="Lyrics timing">
          <Icon name="timing" size={14} />
        </button>
        <button className={`pop-trigger${sleeping ? " on" : ""}${is("sleep")}`} onClick={pop("sleep")} title="Sleep timer">
          <Icon name="moon" size={14} />
        </button>
        <button className={`pop-trigger${is("volume")}`} onClick={pop("volume")} disabled={!own} title={own ? "Volume" : "Volume is in the app that's playing"}>
          <Icon name={(ws?.volume ?? 80) === 0 ? "volumeOff" : "volume"} size={15} />
        </button>
      </div>
    </div>
  );
});
