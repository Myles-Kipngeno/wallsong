import { memo, useEffect, useRef, useState } from "react";
import type { Settings } from "../lib/settings";
import type { MusicItem, SessionInfo, WsState } from "../lib/types";
import { Icon } from "./icons";
import type { Open } from "./Overlay";
import { Art, byline, command } from "./shared";

type ListKind = "next" | "history" | "liked";

const LIST_LABEL: Record<ListKind, string> = { next: "Continue Playing", history: "Recently played", liked: "Liked songs" };

function likedItems(settings: Settings): MusicItem[] {
  return settings.liked.map((l) => ({
    kind: "song",
    title: l.title,
    artists: l.artists,
    album: null,
    duration: null,
    durationMs: null,
    videoId: l.videoId,
    browseId: null,
    videoType: null,
    thumbnail: l.thumbnail,
  }));
}

/** The tilted list on the left: what's playing and what comes next (or history, or liked songs). */
export const ContinuePlaying = memo(function ContinuePlaying({
  ws,
  settings,
  sessions,
  open,
  setOpen,
}: {
  ws: WsState | null;
  settings: Settings;
  sessions: SessionInfo[];
  /** What's open on the control layer; the list picker is "list". */
  open: Open;
  setOpen: React.Dispatch<React.SetStateAction<Open>>;
}) {
  const [list, setList] = useState<ListKind>("next");
  const menu = open === "list";
  const own = ws?.mode === "wallsong";
  const track = ws?.track ?? null;

  const items: MusicItem[] = list === "next" ? (ws?.queue ?? []) : list === "history" ? (ws?.history ?? []) : likedItems(settings);
  const followName = settings.source !== "auto" && settings.source !== "wallsong" ? (sessions.find((s) => s.id === settings.source)?.name ?? "") : (sessions.find((s) => s.playing)?.name ?? "another app");
  const subline =
    list === "next"
      ? own
        ? "Up next on YouTube Music"
        : ws?.mode === "follow"
          ? `Following ${followName}`
          : "Search to start a song"
      : list === "history"
        ? "Played in Wallsong"
        : `${items.length} saved`;

  const pick = (index: number) => {
    if (list === "next") command({ type: "jump", index });
    else if (list === "history") command({ type: "play", item: items[index] });
    else command({ type: "playList", items, start: index, shuffle: false });
  };

  return (
    <aside className={`continue${settings.controls.tilt ? " tilt" : ""}`} data-hit>
      <header className="continue-head">
        <button className="continue-title pop-trigger" onClick={() => setOpen((o) => (o === "list" ? null : "list"))}>
          {LIST_LABEL[list]}
          <Icon name="chevronDown" size={14} />
        </button>
        <span className="continue-sub">{subline}</span>
        {menu && (
          <div className="continue-menu">
            {(Object.keys(LIST_LABEL) as ListKind[]).map((k) => (
              <button key={k} className={k === list ? "on" : ""} onClick={() => (setList(k), setOpen(null))}>
                {LIST_LABEL[k]}
              </button>
            ))}
          </div>
        )}
      </header>

      {track && (
        <div className="continue-now">
          <Art src={track.artwork} size="4.6vh" />
          <div className="row-text">
            <span className="row-title">{track.title}</span>
            <span className="row-sub">{track.artists.join(", ")}</span>
          </div>
          <span className={`eq${ws?.playing ? " live" : ""}`} aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        </div>
      )}

      <div className="continue-list">
        {items.map((item, i) => (
          <button key={`${item.videoId}-${i}`} className="continue-row" onClick={() => pick(i)} title={`Play ${item.title}`}>
            <Art src={item.thumbnail} size="3.8vh" />
            <span className="row-text">
              <span className="row-title">{item.title}</span>
              <span className="row-sub">{byline(item)}</span>
            </span>
          </button>
        ))}
        {items.length === 0 && (
          <p className="continue-empty">
            {list === "liked"
              ? "Tap the heart on the player bar to keep songs here."
              : list === "history"
                ? "Songs you play in Wallsong show up here."
                : own
                  ? "Finding songs like this one…"
                  : "Up next fills in when you play from Wallsong search."}
          </p>
        )}
      </div>
    </aside>
  );
});

/** Card in the middle for a few seconds when a new song starts. */
export function NowStarting({ ws }: { ws: WsState | null }) {
  const [shownFor, setShownFor] = useState(0);
  const last = useRef(0);
  useEffect(() => {
    if (!ws || ws.mode !== "wallsong") {
      setShownFor(0);
      return;
    }
    if (!ws.startedAt || ws.startedAt === last.current) return;
    last.current = ws.startedAt;
    setShownFor(ws.startedAt);
    const id = setTimeout(() => setShownFor(0), 3200);
    return () => clearTimeout(id);
  }, [ws?.startedAt, ws?.mode]);

  if (!shownFor || !ws?.track) return null;
  return (
    <div className="starting" key={shownFor}>
      <Art src={ws.track.artwork} size="16vh" />
      <span className="starting-title">{ws.track.title}</span>
      <span className="starting-sub">{ws.track.artists.join(", ")}</span>
      <span className="starting-pill">
        <i className="live-dot" />
        Starting on YouTube Music
      </span>
    </div>
  );
}
