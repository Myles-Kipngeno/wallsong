import { memo, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { WsState } from "../../lib/types";
import { Icon } from "../icons";
import { Art, command, formatTime, getWsState, livePosition } from "../shared";
import { subscribeFrame } from "../../lib/frame";

/** A single line that slides sideways now and then, only when it doesn't fit. */
export function Marquee({ text, className = "" }: { text: string; className?: string }) {
  const box = useRef<HTMLSpanElement>(null);
  const inner = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(0);
  const [run, setRun] = useState(0);

  useLayoutEffect(() => {
    const extra = (inner.current?.offsetWidth ?? 0) - (box.current?.clientWidth ?? 0);
    setOverflow(extra > 2 ? extra : 0);
  }, [text]);

  // One slide every 10 s instead of a never-ending animation: nothing runs in between.
  useEffect(() => {
    if (!overflow) return;
    setRun(1);
    const id = setInterval(() => setRun((r) => r + 1), 10_000);
    return () => clearInterval(id);
  }, [overflow]);

  const style = { "--shift": `-${overflow}px`, "--dur": `${3 + overflow / 35}s` } as CSSProperties;
  return (
    <span ref={box} className={`marquee ${className}`} title={overflow ? text : undefined}>
      <span ref={inner} key={run} className={`marquee-text${overflow && run ? " run" : ""}`} style={style}>
        {text}
      </span>
    </span>
  );
}

/**
 * The song playing: art, title (sliding if long), artist, elapsed and total time
 * with a seekable progress line, and a 2x2 grid of shuffle, play/pause, previous,
 * next. Clicking the art or the title opens the floating player card.
 * Nothing playing: the empty art, "Not playing" and a Search button.
 */
export const NowPlayingTile = memo(function NowPlayingTile({
  ws,
  onOpenSearch,
  onOpenPlayer,
}: {
  ws: WsState | null;
  onOpenSearch: () => void;
  /** Opens the player card, grown out of this tile. */
  onOpenPlayer: (from: HTMLElement) => void;
}) {
  const track = ws?.track ?? null;
  const own = ws?.mode === "wallsong";
  const durationMs = track?.durationMs ?? 0;

  const barRef = useRef<HTMLElement>(null);
  const timeCurRef = useRef<HTMLSpanElement>(null);
  const timeDurRef = useRef<HTMLSpanElement>(null);

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
      if (timeCurRef.current) timeCurRef.current.textContent = formatTime(pos);
      if (timeDurRef.current) timeDurRef.current.textContent = formatTime(dur);
    }, 4);
  }, []);

  // The tile's own click does nothing: each part handles its click and keeps it.
  const button = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };
  const openCard = (e: React.MouseEvent<HTMLElement>) => {
    e.stopPropagation();
    const tile = e.currentTarget.closest<HTMLElement>(".dk-tile");
    if (tile) onOpenPlayer(tile);
  };
  const seek = (e: React.MouseEvent<HTMLElement>) => {
    e.stopPropagation();
    if (!own || durationMs <= 0) return;
    const box = e.currentTarget.getBoundingClientRect();
    command({ type: "seek", ms: Math.max(0, Math.min(1, (e.clientX - box.left) / box.width)) * durationMs });
  };

  if (!track) {
    return (
      <div className="dk-np idle">
        <Art src={null} size="5.2vh" className="dk-np-art" />
        <div className="dk-np-text">
          <span className="dk-np-title">Not playing</span>
        </div>
        <button className="dk-np-search" onClick={button(onOpenSearch)} title="Search (Ctrl+Alt+Space)">
          <Icon name="search" size={13} />
          Search
        </button>
      </div>
    );
  }

  const initialPos = livePosition(ws);
  const initialProg = durationMs > 0 ? Math.min(1, initialPos / durationMs) : 0;

  return (
    <div className="dk-np">
      <button className="dk-np-open" onClick={openCard} title="Open the player">
        <Art src={track.artwork} size="5.2vh" className="dk-np-art" />
      </button>
      <div className="dk-np-text">
        <button className="dk-np-open" onClick={openCard} title="Open the player">
          <Marquee text={track.title} className="dk-np-title" />
        </button>
        <span className="dk-np-sub">{track.artists.join(", ")}</span>
        <span className="dk-np-time">
          <span ref={timeCurRef}>{formatTime(initialPos)}</span>
          <i className={`dk-np-line${own ? " seekable" : ""}`} onClick={seek} title={own ? "Seek" : "Seeking is in the app that's playing"}>
            <b ref={barRef} style={{ display: "block", width: "100%", height: "100%", transformOrigin: "left", transform: `scaleX(${initialProg.toFixed(4)})` }} />
          </i>
          <span ref={timeDurRef}>{formatTime(durationMs)}</span>
        </span>
      </div>
      <div className="dk-np-grid">
        <button onClick={button(() => command({ type: "shuffle" }))} disabled={!own} title={own ? "Shuffle up next" : "Shuffle is in the app that's playing"}>
          <Icon name="shuffle" size={14} />
        </button>
        <button className="main" onClick={button(() => command({ type: "toggle" }))} title={ws?.playing ? "Pause" : "Play"}>
          <Icon name={ws?.playing ? "pause" : "play"} size={15} />
        </button>
        <button onClick={button(() => command({ type: "previous" }))} title="Previous">
          <Icon name="prev" size={14} />
        </button>
        <button onClick={button(() => command({ type: "next" }))} title="Next">
          <Icon name="next" size={14} />
        </button>
      </div>
    </div>
  );
});
