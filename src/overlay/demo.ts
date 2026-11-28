import type { MusicItem, SearchResults } from "../lib/types";

/**
 * Browser-only stand-in for search (`npm run dev`), so the deck can be designed
 * without the Rust core. These are real YouTube ids, so pressing play in a
 * browser loads them in the wallpaper tab. The app uses live search.
 */
const song = (title: string, artists: string[], album: string, duration: string, videoId: string): MusicItem => ({
  kind: "song",
  title,
  artists,
  album,
  duration,
  durationMs: null,
  videoId,
  browseId: null,
  videoType: "MUSIC_VIDEO_TYPE_ATV",
  thumbnail: null,
});

const SONGS: MusicItem[] = [
  song("Get Lucky (feat. Pharrell Williams and Nile Rodgers)", ["Daft Punk", "Pharrell Williams", "Nile Rodgers"], "Random Access Memories", "6:10", "4D7u5KF7SP8"),
  song("Lose Yourself to Dance (feat. Pharrell Williams)", ["Daft Punk", "Pharrell Williams"], "Random Access Memories", "5:54", "iU7oF4OXZSE"),
  song("Billie Jean", ["Michael Jackson"], "Thriller", "4:55", "Kr4EQDVETuA"),
];

const VIDEO: MusicItem = {
  kind: "video",
  title: "Get Lucky (Radio Edit - feat. Pharrell Williams and Nile Rodgers)",
  artists: ["Nile Rodgers", "Pharrell", "Daft Punk"],
  album: null,
  duration: "6:10",
  durationMs: null,
  videoId: "gx7GyiDZQms",
  browseId: null,
  videoType: "MUSIC_VIDEO_TYPE_OMV",
  thumbnail: null,
};

const ARTIST: MusicItem = {
  kind: "artist",
  title: "Daft Punk",
  artists: [],
  album: null,
  duration: null,
  durationMs: null,
  videoId: null,
  browseId: "UCRr1xG_2WIDs18a6cIiCxeA",
  videoType: null,
  thumbnail: null,
};

const ALBUM: MusicItem = {
  kind: "album",
  title: "Random Access Memories",
  artists: ["Daft Punk"],
  album: null,
  duration: null,
  durationMs: null,
  videoId: null,
  browseId: "MPREb_K8qWMWVqXGi",
  videoType: null,
  thumbnail: null,
};

export function demoSearch(query: string): Promise<SearchResults> {
  const q = query.trim().toLowerCase();
  const hit = (i: MusicItem) => !q || `${i.title} ${i.artists.join(" ")} ${i.album ?? ""}`.toLowerCase().includes(q);
  const songs = SONGS.filter(hit);
  const results: SearchResults = {
    top: hit(VIDEO) ? VIDEO : (songs[0] ?? null),
    songs: songs.length ? songs : SONGS,
    videos: [VIDEO],
    artists: [ARTIST],
    albums: [ALBUM],
  };
  return new Promise((resolve) => setTimeout(() => resolve(results), 250));
}

/** Browser-only artist page for designing the artist view. */
export function demoArtist(browseId: string): Promise<import("../lib/types").ArtistPage> {
  const album = (title: string, year: string, kind = "Album"): MusicItem => ({
    ...ALBUM,
    title,
    year,
    subtitle: `${kind} • ${year}`,
    browseId: `MPRE_${title}`,
  });
  return Promise.resolve({
    browseId,
    name: "Daft Punk",
    description:
      "Demo artist page. In the app this comes live from YouTube Music: the artist's photo, their bio, top songs, albums, singles and videos.",
    thumbnail: null,
    topSongs: SONGS,
    shelves: [
      { title: "Albums", items: [album("Random Access Memories", "2013"), album("Discovery", "2001"), album("Homework", "1997"), album("Human After All", "2005"), album("TRON: Legacy", "2010")] },
      { title: "Singles", items: [album("Get Lucky", "2013", "Single"), album("Instant Crush", "2013", "Single")] },
      { title: "Videos", items: [VIDEO] },
    ],
  });
}

export function demoAlbum(browseId: string): Promise<import("../lib/types").AlbumPage> {
  return Promise.resolve({
    browseId,
    title: "Random Access Memories",
    artists: ["Daft Punk"],
    year: "2013",
    kind: "Album",
    thumbnail: null,
    tracks: SONGS.slice(0, 2),
  });
}
