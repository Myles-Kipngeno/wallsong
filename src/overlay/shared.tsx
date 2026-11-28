import { useEffect, useState } from "react";
import { call, on, send } from "../lib/bus";
import { inTauri } from "../lib/native";
import type { AlbumPage, ArtistPage, MusicItem, SearchResults, SessionInfo, WsCmd, WsState } from "../lib/types";
import { demoAlbum, demoArtist, demoSearch } from "./demo";

export function command(cmd: WsCmd): void {
  send<WsCmd>("ws-cmd", cmd);
}

export function formatTime(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0:00";
  const total = Math.floor(ms / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export { useWs, getWsState } from "../lib/wsStore";

/** Apps Windows knows are playing (for the source menu). */
export function useSessions(): SessionInfo[] {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  useEffect(() => {
    if (!inTauri) {
      setSessions([{ id: "Brave", name: "Brave", playing: false, title: "Demo: an app Windows reports" }]);
      return;
    }
    let off: (() => void) | undefined;
    let disposed = false;
    void call<SessionInfo[]>("media_sessions").then(setSessions).catch(() => {});
    on<SessionInfo[]>("sessions", setSessions).then((u) => (disposed ? u() : (off = u)));
    return () => {
      disposed = true;
      off?.();
    };
  }, []);
  return sessions;
}

/** Ticks a few times a second so progress bars move between state updates. */
export function useTicker(ms = 250): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

/** [x, y, width, height] of the screen minus the taskbar, in CSS px of the control layer. */
export type WorkArea = [number, number, number, number];

/** How often the work area is re-read (the taskbar can move or auto-hide). */
const WORK_AREA_MS = 30_000;

/** Where the taskbar leaves room: re-read on resize and every 30 s. */
export function useWorkArea(): WorkArea {
  const [area, setArea] = useState<WorkArea>(() => [0, 0, window.innerWidth, window.innerHeight]);
  useEffect(() => {
    const read = () => {
      const next: Promise<WorkArea> = inTauri ? call<WorkArea>("work_area") : Promise.resolve([0, 0, window.innerWidth, window.innerHeight]);
      void next.then((a) => setArea((prev) => (prev.every((v, i) => Math.abs(v - a[i]) < 0.5) ? prev : a))).catch(() => {});
    };
    read();
    window.addEventListener("resize", read);
    const id = setInterval(read, WORK_AREA_MS);
    return () => {
      window.removeEventListener("resize", read);
      clearInterval(id);
    };
  }, []);
  return area;
}

export function livePosition(ws: WsState | null): number {
  if (!ws) return 0;
  const p = ws.positionMs + (ws.playing ? Date.now() - ws.sampledAtMs : 0);
  return ws.track?.durationMs ? Math.min(ws.track.durationMs, p) : p;
}

export const api = {
  search: (query: string) => (inTauri ? call<SearchResults>("yt_search", { query }) : demoSearch(query)),
  suggest: (input: string) =>
    inTauri ? call<{ queries: string[]; items: MusicItem[] }>("yt_suggest", { input }) : Promise.resolve({ queries: [`${input} remix`, `${input} live`], items: [] }),
  artist: (browseId: string) => (inTauri ? call<ArtistPage>("yt_artist", { browseId }) : demoArtist(browseId)),
  album: (browseId: string) => (inTauri ? call<AlbumPage>("yt_album", { browseId }) : demoAlbum(browseId)),
};

export function Art({
  src,
  size,
  round = false,
  className = "",
}: {
  src: string | null | undefined;
  size: number | string;
  round?: boolean;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  const style = { width: size, height: size, borderRadius: round ? "50%" : undefined };
  if (!src || failed) return <div className={`art art-empty ${className}`} style={style} aria-hidden="true" />;
  return <img className={`art ${className}`} style={style} src={src} alt="" loading="lazy" onError={() => setFailed(true)} />;
}

/** "Daft Punk, Pharrell" or the subtitle YouTube Music gave. */
export function byline(item: MusicItem): string {
  return item.artists.join(", ") || item.subtitle || "";
}
