import { useEffect, useState, type CSSProperties } from "react";
import type { AlbumPage, ArtistPage, MusicItem, SearchResults } from "../lib/types";
import { Icon } from "./icons";
import { Art, byline, command } from "./shared";

const KIND: Record<string, string> = { song: "Song", video: "Video", artist: "Artist", album: "Album", playlist: "Playlist", episode: "Episode" };

export interface BrowseActions {
  /** Songs and videos play; artists and albums open their page. */
  open: (item: MusicItem) => void;
}

function QueueButtons({ item }: { item: MusicItem }) {
  return (
    <>
      <button
        className="ib small"
        title="Play next"
        onClick={(e) => {
          e.stopPropagation();
          command({ type: "enqueue", item, next: true });
        }}
      >
        <Icon name="playNext" size={15} />
      </button>
      <button
        className="ib small"
        title="Add to up next"
        onClick={(e) => {
          e.stopPropagation();
          command({ type: "enqueue", item, next: false });
        }}
      >
        <Icon name="plus" size={15} />
      </button>
    </>
  );
}

function SongRow({ item, index, onOpen }: { item: MusicItem; index?: number; onOpen: (item: MusicItem) => void }) {
  return (
    <div className="song-row" role="button" tabIndex={0} onClick={() => onOpen(item)} onKeyDown={(e) => e.key === "Enter" && onOpen(item)}>
      {index !== undefined && <span className="song-index">{index + 1}</span>}
      <span className="song-art">
        <Art src={item.thumbnail} size="4vh" />
        <span className="song-play">
          <Icon name="play" size={14} />
        </span>
      </span>
      <span className="row-text">
        <span className="row-title">{item.title}</span>
        <span className="row-sub">{[item.kind === "video" ? "Video" : null, byline(item), item.album].filter(Boolean).join(" · ")}</span>
      </span>
      {item.duration && <span className="song-time">{item.duration}</span>}
      <QueueButtons item={item} />
    </div>
  );
}

/** Albums and singles in 3D: the chosen one flat in the middle, the rest angled away. */
export function CoverFlow({ items, onOpen }: { items: MusicItem[]; onOpen: (item: MusicItem) => void }) {
  const [active, setActive] = useState(Math.min(2, Math.floor((items.length - 1) / 2)));
  useEffect(() => setActive(Math.min(2, Math.floor((items.length - 1) / 2))), [items]);
  const move = (d: number) => setActive((a) => Math.max(0, Math.min(items.length - 1, a + d)));
  return (
    <div
      className="coverflow"
      onWheel={(e) => move(Math.sign(e.deltaY || e.deltaX))}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") move(-1);
        if (e.key === "ArrowRight") move(1);
        if (e.key === "Enter" && items[active]) onOpen(items[active]);
      }}
    >
      {items.map((item, i) => {
        const offset = i - active;
        const abs = Math.abs(offset);
        if (abs > 4) return null;
        const style = {
          "--o": offset,
          "--a": abs,
          zIndex: 20 - abs,
        } as CSSProperties;
        return (
          <button
            key={`${item.browseId ?? item.videoId}-${i}`}
            className={`cover${offset === 0 ? " active" : ""}`}
            style={style}
            onClick={() => (offset === 0 ? onOpen(item) : setActive(i))}
            title={offset === 0 ? `Open ${item.title}` : item.title}
          >
            <Art src={item.thumbnail} size="100%" className="cover-art" />
            <span className="cover-title">{item.title}</span>
            <span className="cover-sub">{item.subtitle ?? [item.year, KIND[item.kind]].filter(Boolean).join(" · ")}</span>
          </button>
        );
      })}
    </div>
  );
}

export function SearchView({ query, results, searching, error, actions }: { query: string; results: SearchResults | null; searching: boolean; error: string | null; actions: BrowseActions }) {
  if (error) return <p className="empty">Search failed: {error}</p>;
  if (!results) return <p className="empty">{searching ? "Searching…" : query.trim().length < 2 ? "Type a song, artist or album." : "Press Enter to search"}</p>;
  const { top, songs, videos, artists, albums } = results;
  if (!top && !songs.length && !videos.length && !artists.length && !albums.length) return <p className="empty">Nothing found for "{query.trim()}"</p>;

  // Top results row: the top hit, then the best songs and videos.
  const topRow = [top, ...songs.slice(0, 3), ...videos.slice(0, 2)].filter((x): x is MusicItem => !!x).slice(0, 6);

  return (
    <div className={`browse${searching ? " stale" : ""}`}>
      <h3>Top results</h3>
      <div className="tile-row">
        {topRow.map((item, i) => (
          <button key={`${item.videoId ?? item.browseId}-${i}`} className="tile" onClick={() => actions.open(item)} title={item.title}>
            <Art src={item.thumbnail} size="11vh" round={item.kind === "artist"} />
            <span className="tile-title">{item.title}</span>
            <span className="tile-sub">{[KIND[item.kind], byline(item)].filter(Boolean).join(" · ")}</span>
          </button>
        ))}
      </div>

      {artists.length > 0 && (
        <>
          <h3>Artists</h3>
          <div className="tile-row">
            {artists.slice(0, 6).map((a) => (
              <button key={a.browseId ?? a.title} className="tile artist" onClick={() => actions.open(a)} title={`Open ${a.title}`}>
                <Art src={a.thumbnail} size="9vh" round />
                <span className="tile-title">{a.title}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {songs.length > 0 && (
        <>
          <h3>Songs</h3>
          <div className="song-grid">
            {songs.slice(0, 8).map((s) => (
              <SongRow key={s.videoId} item={s} onOpen={actions.open} />
            ))}
          </div>
        </>
      )}

      {albums.length > 0 && (
        <>
          <h3>Albums</h3>
          <CoverFlow items={albums} onOpen={actions.open} />
        </>
      )}

      {videos.length > 0 && (
        <>
          <h3>Videos</h3>
          <div className="song-grid">
            {videos.slice(0, 6).map((v) => (
              <SongRow key={v.videoId} item={v} onOpen={actions.open} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function ArtistView({ page, loading, error, actions }: { page: ArtistPage | null; loading: boolean; error: string | null; actions: BrowseActions }) {
  const [more, setMore] = useState(false);
  if (error) return <p className="empty">Couldn't open the artist: {error}</p>;
  if (!page) return <p className="empty">{loading ? "Opening the artist…" : ""}</p>;
  const songs = page.topSongs;
  return (
    <div className="browse artist-view">
      <div className="artist-head">
        <Art src={page.thumbnail} size="16vh" className="artist-photo" />
        <div className="artist-info">
          <h2>{page.name}</h2>
          {page.description && (
            <p className={`artist-bio${more ? " open" : ""}`} onClick={() => setMore((m) => !m)} title={more ? "Show less" : "Show more"}>
              {page.description}
            </p>
          )}
          <div className="artist-actions">
            <button className="pill-btn primary" disabled={!songs.length} onClick={() => command({ type: "playList", items: songs, start: 0, shuffle: false })}>
              <Icon name="play" size={15} />
              Play
            </button>
            <button className="pill-btn" disabled={!songs.length} onClick={() => command({ type: "playList", items: songs, start: 0, shuffle: true })}>
              <Icon name="shuffle" size={15} />
              Shuffle
            </button>
          </div>
        </div>
        <div className="artist-top">
          <h3>Top songs</h3>
          {songs.slice(0, 5).map((s, i) => (
            <SongRow key={s.videoId} item={s} index={i} onOpen={(item) => command({ type: "playList", items: songs, start: songs.indexOf(item), shuffle: false })} />
          ))}
        </div>
      </div>
      {page.shelves.map((shelf) => {
        const flow = shelf.items.every((i) => i.kind === "album" || i.kind === "playlist");
        return (
          <section key={shelf.title}>
            <h3>{shelf.title}</h3>
            {flow ? (
              <CoverFlow items={shelf.items} onOpen={actions.open} />
            ) : (
              <div className="tile-row">
                {shelf.items.map((item, i) => (
                  <button key={`${item.videoId ?? item.browseId}-${i}`} className={`tile${item.kind === "artist" ? " artist" : ""}`} onClick={() => actions.open(item)}>
                    <Art src={item.thumbnail} size={item.kind === "video" ? "10vh" : "11vh"} round={item.kind === "artist"} className={item.kind === "video" ? "wide" : ""} />
                    <span className="tile-title">{item.title}</span>
                    <span className="tile-sub">{item.subtitle ?? byline(item)}</span>
                  </button>
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

export function AlbumView({ page, loading, error }: { page: AlbumPage | null; loading: boolean; error: string | null }) {
  if (error) return <p className="empty">Couldn't open the album: {error}</p>;
  if (!page) return <p className="empty">{loading ? "Opening the album…" : ""}</p>;
  const tracks = page.tracks;
  return (
    <div className="browse album-view">
      <div className="album-head">
        <Art src={page.thumbnail} size="16vh" />
        <div className="artist-info">
          <span className="top-kind">{[page.kind, page.year].filter(Boolean).join(" · ")}</span>
          <h2>{page.title}</h2>
          <p className="album-artist">{page.artists.join(", ")}</p>
          <p className="album-count">
            {tracks.length} {tracks.length === 1 ? "song" : "songs"}
          </p>
          <div className="artist-actions">
            <button className="pill-btn primary" disabled={!tracks.length} onClick={() => command({ type: "playList", items: tracks, start: 0, shuffle: false })}>
              <Icon name="play" size={15} />
              Play
            </button>
            <button className="pill-btn" disabled={!tracks.length} onClick={() => command({ type: "playList", items: tracks, start: 0, shuffle: true })}>
              <Icon name="shuffle" size={15} />
              Shuffle
            </button>
          </div>
        </div>
      </div>
      <div className="track-list">
        {tracks.map((t, i) => (
          <SongRow key={`${t.videoId}-${i}`} item={t} index={i} onOpen={() => command({ type: "playList", items: tracks, start: i, shuffle: false })} />
        ))}
      </div>
    </div>
  );
}
