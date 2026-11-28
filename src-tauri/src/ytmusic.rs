//! YouTube Music search and "up next", straight from YouTube Music's own web API
//! (the same requests music.youtube.com makes; no key, no account).
//!
//! This API is unofficial. The parser therefore doesn't depend on exact page
//! layout: it finds every result item anywhere in the response and works out
//! what each one is from its IDs, the way the open-source ytmusicapi library does.

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const API: &str = "https://music.youtube.com/youtubei/v1";
const USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

static HTTP: OnceLock<reqwest::Client> = OnceLock::new();
static VIDEO_CACHE: Mutex<VecDeque<(String, Vec<MusicItem>)>> = Mutex::new(VecDeque::new());
static UP_NEXT_CACHE: Mutex<VecDeque<(String, Vec<MusicItem>)>> = Mutex::new(VecDeque::new());

/// Words YouTube Music puts first in a subtitle to say what a result is.
const TYPE_LABELS: [&str; 12] =
    ["song", "video", "artist", "album", "single", "ep", "playlist", "episode", "podcast", "profile", "station", "audiobook"];

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MusicItem {
    /// "song", "video", "artist", "album" or "playlist".
    pub kind: String,
    pub title: String,
    pub artists: Vec<String>,
    pub album: Option<String>,
    /// As shown, e.g. "3:41".
    pub duration: Option<String>,
    pub duration_ms: Option<u64>,
    /// Playable id for songs and videos.
    pub video_id: Option<String>,
    /// Page id for artists, albums and playlists.
    pub browse_id: Option<String>,
    /// MUSIC_VIDEO_TYPE_ATV (official audio), _OMV (official video), _UGC (upload)...
    pub video_type: Option<String>,
    pub thumbnail: Option<String>,
    /// Release year, for albums and singles.
    pub year: Option<String>,
    /// The line under a tile as YouTube Music shows it, e.g. "Single • 2024".
    pub subtitle: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResults {
    pub top: Option<MusicItem>,
    pub songs: Vec<MusicItem>,
    pub videos: Vec<MusicItem>,
    pub artists: Vec<MusicItem>,
    pub albums: Vec<MusicItem>,
}

// ---------- helpers for walking untyped JSON ----------

fn at<'a>(v: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut cur = v;
    for key in path {
        cur = match key.parse::<usize>() {
            Ok(i) => cur.get(i)?,
            Err(_) => cur.get(*key)?,
        };
    }
    Some(cur)
}

fn text_at(v: &Value, path: &[&str]) -> Option<String> {
    at(v, path).and_then(|x| x.as_str()).map(str::to_string)
}

/// Every object stored under `key`, anywhere in the tree, in document order.
fn find_all<'a>(v: &'a Value, key: &str, out: &mut Vec<&'a Value>) {
    match v {
        Value::Object(map) => {
            for (k, child) in map {
                if k == key {
                    out.push(child);
                }
                find_all(child, key, out);
            }
        }
        Value::Array(items) => items.iter().for_each(|c| find_all(c, key, out)),
        _ => {}
    }
}

fn largest_thumbnail(v: &Value) -> Option<String> {
    let list = at(v, &["thumbnail", "musicThumbnailRenderer", "thumbnail", "thumbnails"])
        .or_else(|| at(v, &["thumbnailRenderer", "musicThumbnailRenderer", "thumbnail", "thumbnails"]))
        .or_else(|| at(v, &["thumbnail", "croppedSquareThumbnailRenderer", "thumbnail", "thumbnails"]))
        .or_else(|| at(v, &["foregroundThumbnail", "musicThumbnailRenderer", "thumbnail", "thumbnails"]))
        .or_else(|| at(v, &["thumbnail", "thumbnails"]))?
        .as_array()?;
    let url = list.last()?.get("url")?.as_str()?;
    // Google image URLs carry their size; ask for a sharper copy.
    Some(match url.find("=w") {
        Some(i) if url.contains("googleusercontent") => format!("{}=w544-h544-l90-rj", &url[..i]),
        _ => url.to_string(),
    })
}

pub fn parse_duration_ms(s: &str) -> Option<u64> {
    let parts: Vec<&str> = s.trim().split(':').collect();
    if parts.len() < 2 || parts.len() > 3 || parts.iter().any(|p| p.is_empty() || !p.chars().all(|c| c.is_ascii_digit())) {
        return None;
    }
    let total = parts.iter().try_fold(0u64, |acc, p| Some(acc * 60 + p.parse::<u64>().ok()?))?;
    Some(total * 1000)
}

fn browse_id_of(run: &Value) -> Option<String> {
    text_at(run, &["navigationEndpoint", "browseEndpoint", "browseId"])
}

fn is_artist_id(id: &str) -> bool {
    id.starts_with("UC") || id.starts_with("MPLA")
}

/// Reads "Song • Daft Punk & Pharrell • Random Access Memories • 4:08" style runs.
fn fill_from_subtitle(item: &mut MusicItem, runs: &[Value]) {
    // Split runs into segments at the " • " separators.
    let mut segments: Vec<Vec<&Value>> = vec![vec![]];
    for run in runs {
        let text = run.get("text").and_then(|t| t.as_str()).unwrap_or("");
        if text.trim() == "•" {
            segments.push(vec![]);
        } else {
            segments.last_mut().unwrap().push(run);
        }
    }

    let mut loose_text: Vec<String> = vec![];
    for seg in segments.iter().filter(|s| !s.is_empty()) {
        let joined: String = seg.iter().filter_map(|r| r.get("text")?.as_str()).collect::<String>().trim().to_string();
        if joined.is_empty() {
            continue;
        }
        let linked: Vec<(String, String)> = seg
            .iter()
            .filter_map(|r| Some((browse_id_of(r)?, r.get("text")?.as_str()?.to_string())))
            .collect();

        if TYPE_LABELS.contains(&joined.to_lowercase().as_str()) {
            continue;
        } else if let Some(ms) = parse_duration_ms(&joined) {
            item.duration = Some(joined.clone());
            item.duration_ms = Some(ms);
        } else if linked.iter().any(|(id, _)| is_artist_id(id)) {
            item.artists.extend(linked.iter().filter(|(id, _)| is_artist_id(id)).map(|(_, name)| name.clone()));
        } else if let Some((_, name)) = linked.iter().find(|(id, _)| id.starts_with("MPRE")) {
            item.album = Some(name.clone());
        } else if joined.len() == 4 && joined.chars().all(|c| c.is_ascii_digit()) {
            item.year = Some(joined.clone());
        } else if joined.ends_with("views") || joined.ends_with("plays") || joined.ends_with("subscribers") || joined.ends_with("monthly audience") {
            // counts: not needed
        } else {
            loose_text.push(joined);
        }
    }
    // Uploads and some videos have no artist links: the first plain segment is the channel.
    if item.artists.is_empty() && item.kind != "artist" {
        if let Some(first) = loose_text.first() {
            item.artists.push(first.clone());
        }
    }
}

fn classify(browse_id: Option<&str>, video_type: Option<&str>, has_video: bool) -> &'static str {
    if let Some(id) = browse_id {
        if is_artist_id(id) {
            return "artist";
        }
        if id.starts_with("MPRE") {
            return "album";
        }
        if id.starts_with("VL") || id.starts_with("RD") || id.starts_with("VM") {
            return "playlist";
        }
    }
    if has_video {
        return match video_type {
            Some("MUSIC_VIDEO_TYPE_ATV") => "song",
            Some("MUSIC_VIDEO_TYPE_PODCAST_EPISODE") => "episode",
            _ => "video",
        };
    }
    "unknown"
}

/// One row of a results list (musicResponsiveListItemRenderer).
pub fn parse_list_item(v: &Value) -> Option<MusicItem> {
    let col = |i: &str| at(v, &["flexColumns", i, "musicResponsiveListItemFlexColumnRenderer", "text", "runs"]);
    let title_runs = col("0")?.as_array()?;
    let title: String = title_runs.iter().filter_map(|r| r.get("text")?.as_str()).collect();

    let play = at(v, &["overlay", "musicItemThumbnailOverlayRenderer", "content", "musicPlayButtonRenderer", "playNavigationEndpoint"]);
    let video_id = play
        .and_then(|p| text_at(p, &["watchEndpoint", "videoId"]))
        .or_else(|| text_at(v, &["playlistItemData", "videoId"]))
        .or_else(|| title_runs.first().and_then(|r| text_at(r, &["navigationEndpoint", "watchEndpoint", "videoId"])));
    let video_type = play
        .and_then(|p| text_at(p, &["watchEndpoint", "watchEndpointMusicSupportedConfigs", "watchEndpointMusicConfig", "musicVideoType"]))
        .or_else(|| {
            title_runs.first().and_then(|r| {
                text_at(r, &["navigationEndpoint", "watchEndpoint", "watchEndpointMusicSupportedConfigs", "watchEndpointMusicConfig", "musicVideoType"])
            })
        });
    let browse_id = text_at(v, &["navigationEndpoint", "browseEndpoint", "browseId"]);

    let kind = classify(browse_id.as_deref(), video_type.as_deref(), video_id.is_some());
    let mut item = MusicItem {
        kind: kind.to_string(),
        title,
        video_id,
        browse_id,
        video_type,
        thumbnail: largest_thumbnail(v),
        ..Default::default()
    };
    if let Some(runs) = col("1").and_then(|r| r.as_array()) {
        fill_from_subtitle(&mut item, runs);
    }
    // Filtered "Songs" searches put the album in a third column.
    if let Some(runs) = col("2").and_then(|r| r.as_array()) {
        if item.album.is_none() {
            item.album = runs.iter().find(|r| browse_id_of(r).map_or(false, |id| id.starts_with("MPRE"))).and_then(|r| r.get("text")?.as_str()).map(str::to_string);
        }
    }
    // Durations sometimes live in a fixed column on the right.
    if item.duration.is_none() {
        if let Some(text) = text_at(v, &["fixedColumns", "0", "musicResponsiveListItemFixedColumnRenderer", "text", "runs", "0", "text"]) {
            item.duration_ms = parse_duration_ms(&text);
            item.duration = item.duration_ms.map(|_| text);
        }
    }
    if item.kind == "artist" {
        item.artists = vec![item.title.clone()];
    }
    (!item.title.is_empty() && item.kind != "unknown").then_some(item)
}

/// The big "Top result" card (musicCardShelfRenderer).
pub fn parse_top_card(v: &Value) -> Option<MusicItem> {
    let title_run = at(v, &["title", "runs", "0"])?;
    let title = title_run.get("text")?.as_str()?.to_string();
    let video_id = text_at(title_run, &["navigationEndpoint", "watchEndpoint", "videoId"])
        .or_else(|| text_at(v, &["onTap", "watchEndpoint", "videoId"]));
    let video_type = text_at(title_run, &["navigationEndpoint", "watchEndpoint", "watchEndpointMusicSupportedConfigs", "watchEndpointMusicConfig", "musicVideoType"])
        .or_else(|| text_at(v, &["onTap", "watchEndpoint", "watchEndpointMusicSupportedConfigs", "watchEndpointMusicConfig", "musicVideoType"]));
    let browse_id = browse_id_of(title_run);
    let kind = classify(browse_id.as_deref(), video_type.as_deref(), video_id.is_some());
    let mut item = MusicItem {
        kind: kind.to_string(),
        title,
        video_id,
        browse_id,
        video_type,
        thumbnail: largest_thumbnail(v),
        ..Default::default()
    };
    if let Some(runs) = at(v, &["subtitle", "runs"]).and_then(|r| r.as_array()) {
        fill_from_subtitle(&mut item, runs);
    }
    if item.kind == "artist" {
        item.artists = vec![item.title.clone()];
    }
    (item.kind != "unknown").then_some(item)
}

pub fn parse_search(body: &Value) -> SearchResults {
    let mut results = SearchResults::default();
    let mut cards = vec![];
    find_all(body, "musicCardShelfRenderer", &mut cards);
    results.top = cards.first().and_then(|c| parse_top_card(c));

    let mut rows = vec![];
    find_all(body, "musicResponsiveListItemRenderer", &mut rows);
    let mut seen = std::collections::HashSet::new();
    if let Some(top) = &results.top {
        seen.insert(top.video_id.clone().or(top.browse_id.clone()).unwrap_or_default());
    }
    for item in rows.into_iter().filter_map(parse_list_item) {
        let id = item.video_id.clone().or(item.browse_id.clone()).unwrap_or_default();
        if id.is_empty() || !seen.insert(id) {
            continue;
        }
        match item.kind.as_str() {
            "song" => results.songs.push(item),
            "video" => results.videos.push(item),
            "artist" => results.artists.push(item),
            "album" => results.albums.push(item),
            _ => {}
        }
    }
    results
}

/// The radio queue YouTube Music builds after a song (the "Up next" list).
pub fn parse_up_next(body: &Value) -> Vec<MusicItem> {
    let mut rows = vec![];
    find_all(body, "playlistPanelVideoRenderer", &mut rows);
    let mut seen = std::collections::HashSet::new();
    rows.into_iter()
        .filter_map(|v| {
            let video_id = text_at(v, &["videoId"])?;
            if !seen.insert(video_id.clone()) {
                return None;
            }
            let title: String = at(v, &["title", "runs"])?.as_array()?.iter().filter_map(|r| r.get("text")?.as_str()).collect();
            let video_type = text_at(v, &["navigationEndpoint", "watchEndpoint", "watchEndpointMusicSupportedConfigs", "watchEndpointMusicConfig", "musicVideoType"]);
            let mut item = MusicItem {
                kind: if video_type.as_deref() == Some("MUSIC_VIDEO_TYPE_ATV") { "song".into() } else { "video".into() },
                title,
                video_id: Some(video_id),
                video_type,
                thumbnail: largest_thumbnail(v),
                ..Default::default()
            };
            if let Some(runs) = at(v, &["longBylineText", "runs"]).and_then(|r| r.as_array()) {
                fill_from_subtitle(&mut item, runs);
            }
            if let Some(len) = text_at(v, &["lengthText", "runs", "0", "text"]) {
                item.duration_ms = parse_duration_ms(&len);
                item.duration = Some(len);
            }
            Some(item)
        })
        .collect()
}

/// A tile in a carousel: albums, singles, playlists and videos on artist and home pages
/// (musicTwoRowItemRenderer).
pub fn parse_two_row(v: &Value) -> Option<MusicItem> {
    let title_run = at(v, &["title", "runs", "0"])?;
    let title: String = at(v, &["title", "runs"])?.as_array()?.iter().filter_map(|r| r.get("text")?.as_str()).collect();
    let nav = v.get("navigationEndpoint");
    let browse_id = nav
        .and_then(|n| text_at(n, &["browseEndpoint", "browseId"]))
        .or_else(|| browse_id_of(title_run));
    let video_id = nav.and_then(|n| text_at(n, &["watchEndpoint", "videoId"]));
    let video_type = nav.and_then(|n| {
        text_at(n, &["watchEndpoint", "watchEndpointMusicSupportedConfigs", "watchEndpointMusicConfig", "musicVideoType"])
    });
    let kind = classify(browse_id.as_deref(), video_type.as_deref(), video_id.is_some());
    let mut item = MusicItem {
        kind: kind.to_string(),
        title,
        video_id,
        browse_id,
        video_type,
        thumbnail: largest_thumbnail(v),
        ..Default::default()
    };
    item.subtitle = runs_text(v.get("subtitle"));
    if let Some(runs) = at(v, &["subtitle", "runs"]).and_then(|r| r.as_array()) {
        fill_from_subtitle(&mut item, runs);
        // Playlists list artists as plain comma-separated text: keep it as one credit line.
        if item.kind == "playlist" && item.artists.len() == 1 {
            let line: String = runs.iter().filter_map(|r| r.get("text")?.as_str()).collect();
            item.artists = vec![line];
        }
    }
    if item.kind == "artist" {
        item.artists = vec![item.title.clone()];
    }
    (!item.title.is_empty() && item.kind != "unknown").then_some(item)
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shelf {
    pub title: String,
    pub items: Vec<MusicItem>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtistPage {
    pub browse_id: String,
    pub name: String,
    pub description: Option<String>,
    pub thumbnail: Option<String>,
    pub top_songs: Vec<MusicItem>,
    /// Albums, Singles, Videos, Featured on... in page order.
    pub shelves: Vec<Shelf>,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AlbumPage {
    pub browse_id: String,
    pub title: String,
    pub artists: Vec<String>,
    pub year: Option<String>,
    pub kind: String,
    pub thumbnail: Option<String>,
    pub tracks: Vec<MusicItem>,
}

const HEADER_KEYS: [&str; 5] = [
    "musicImmersiveHeaderRenderer",
    "musicVisualHeaderRenderer",
    "musicResponsiveHeaderRenderer",
    "musicDetailHeaderRenderer",
    "musicHeaderRenderer",
];

fn find_header(body: &Value) -> Option<&Value> {
    HEADER_KEYS.iter().find_map(|key| {
        let mut found = vec![];
        find_all(body, key, &mut found);
        found.into_iter().next()
    })
}

fn runs_text(v: Option<&Value>) -> Option<String> {
    let text: String = v?.get("runs")?.as_array()?.iter().filter_map(|r| r.get("text")?.as_str()).collect();
    let text = text.trim().to_string();
    (!text.is_empty()).then_some(text)
}

fn carousel_title(shelf: &Value) -> String {
    runs_text(at(shelf, &["header", "musicCarouselShelfBasicHeaderRenderer", "title"])).unwrap_or_default()
}

/// An artist's page: header, top songs and every carousel (albums, singles, videos...).
pub fn parse_artist(body: &Value, browse_id: &str) -> ArtistPage {
    let mut page = ArtistPage { browse_id: browse_id.to_string(), ..Default::default() };
    if let Some(header) = find_header(body) {
        page.name = runs_text(header.get("title")).unwrap_or_default();
        page.description = runs_text(header.get("description"));
        page.thumbnail = largest_thumbnail(header);
    }
    if page.description.is_none() {
        let mut shelves = vec![];
        find_all(body, "musicDescriptionShelfRenderer", &mut shelves);
        page.description = shelves.first().and_then(|s| runs_text(s.get("description")));
    }

    let mut song_shelves = vec![];
    find_all(body, "musicShelfRenderer", &mut song_shelves);
    let mut seen = std::collections::HashSet::new();
    for shelf in song_shelves {
        for row in shelf.get("contents").and_then(|c| c.as_array()).into_iter().flatten() {
            if let Some(mut item) = row.get("musicResponsiveListItemRenderer").and_then(parse_list_item) {
                if item.video_id.is_none() || !seen.insert(item.video_id.clone()) {
                    continue;
                }
                if item.artists.is_empty() && !page.name.is_empty() {
                    item.artists.push(page.name.clone());
                }
                page.top_songs.push(item);
            }
        }
    }

    let mut carousels = vec![];
    find_all(body, "musicCarouselShelfRenderer", &mut carousels);
    for shelf in carousels {
        let items: Vec<MusicItem> = shelf
            .get("contents")
            .and_then(|c| c.as_array())
            .into_iter()
            .flatten()
            .filter_map(|c| c.get("musicTwoRowItemRenderer").and_then(parse_two_row))
            .map(|mut item| {
                if item.artists.is_empty() && item.kind != "artist" && !page.name.is_empty() {
                    item.artists.push(page.name.clone());
                }
                item
            })
            .collect();
        if !items.is_empty() {
            page.shelves.push(Shelf { title: carousel_title(shelf), items });
        }
    }
    page
}

/// An album or single: header and its tracks.
pub fn parse_album(body: &Value, browse_id: &str) -> AlbumPage {
    let mut page = AlbumPage { browse_id: browse_id.to_string(), kind: "Album".into(), ..Default::default() };
    if let Some(header) = find_header(body) {
        page.title = runs_text(header.get("title")).unwrap_or_default();
        page.thumbnail = largest_thumbnail(header);
        let mut meta = MusicItem::default();
        // Newer pages put the artist on its own line ("strapline"); older ones in the subtitle.
        for key in ["straplineTextOne", "subtitle"] {
            if let Some(runs) = at(header, &[key, "runs"]).and_then(|r| r.as_array()) {
                fill_from_subtitle(&mut meta, runs);
                if key == "subtitle" {
                    if let Some(first) = runs.first().and_then(|r| r.get("text")?.as_str()) {
                        if TYPE_LABELS.contains(&first.to_lowercase().as_str()) {
                            page.kind = first.to_string();
                        }
                    }
                }
            }
        }
        // A plain-text subtitle segment is not an artist when the strapline named one.
        page.artists = meta.artists;
        page.year = meta.year;
    }
    let mut rows = vec![];
    find_all(body, "musicResponsiveListItemRenderer", &mut rows);
    let mut seen = std::collections::HashSet::new();
    for mut item in rows.into_iter().filter_map(parse_list_item) {
        if item.video_id.is_none() || !seen.insert(item.video_id.clone()) {
            continue;
        }
        if item.artists.is_empty() {
            item.artists = page.artists.clone();
        }
        if item.thumbnail.is_none() {
            item.thumbnail = page.thumbnail.clone();
        }
        if item.album.is_none() && !page.title.is_empty() {
            item.album = Some(page.title.clone());
        }
        page.tracks.push(item);
    }
    page
}

/// Search-as-you-type suggestions: plain queries first, then songs/artists YouTube Music suggests.
pub fn parse_suggestions(body: &Value) -> (Vec<String>, Vec<MusicItem>) {
    let mut found = vec![];
    find_all(body, "searchSuggestionRenderer", &mut found);
    let queries = found.iter().filter_map(|s| runs_text(s.get("suggestion"))).collect();
    let mut rows = vec![];
    find_all(body, "musicResponsiveListItemRenderer", &mut rows);
    let items = rows.into_iter().filter_map(parse_list_item).collect();
    (queries, items)
}

/// Up to five videos for a song, best first: official videos, then live and other uploads,
/// with still-image uploads (audio, lyric, visualizer) last. Used by the video picker dots.
pub fn video_candidates(results: &SearchResults, title: &str, artist: &str) -> Vec<MusicItem> {
    let want_title = squash(title.split(['(', '[']).next().unwrap_or(title));
    let want_artist = squash(artist);
    let mut seen = std::collections::HashSet::new();
    let mut list: Vec<&MusicItem> = results
        .top
        .iter()
        .chain(results.videos.iter())
        .filter(|v| v.kind == "video" && v.video_id.is_some())
        .filter(|v| {
            let t = squash(&v.title);
            let a = squash(&v.artists.join(" "));
            !want_title.is_empty() && t.contains(&want_title) && (want_artist.is_empty() || a.contains(&want_artist) || want_artist.contains(&a) || t.contains(&want_artist))
        })
        .filter(|v| {
            // Covers, karaoke and edits aren't the song's video.
            let t = v.title.to_lowercase();
            !["karaoke", "instrumental", "piano", "cover", "slowed", "sped up", "nightcore", "reverb", "8d"].iter().any(|w| t.contains(w))
        })
        .filter(|v| seen.insert(v.video_id.clone()))
        .collect();
    let rank = |v: &&MusicItem| {
        let t = v.title.to_lowercase();
        let still = ["audio", "lyric", "visualizer", "visualiser"].iter().any(|w| t.contains(w));
        let official = v.video_type.as_deref() == Some("MUSIC_VIDEO_TYPE_OMV");
        (still as u8) * 2 + (!official) as u8
    };
    list.sort_by_key(rank);
    list.into_iter().take(5).cloned().collect()
}

/// Lowercase letters and digits only, for loose title comparisons.
fn squash(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).collect::<String>().to_lowercase()
}

/// From search results, the official music video that best matches a song.
pub fn pick_music_video(results: &SearchResults, title: &str, artist: &str) -> Option<MusicItem> {
    let want_title = squash(title.split(['(', '[']).next().unwrap_or(title));
    let want_artist = squash(artist);
    let candidates = results.top.iter().chain(results.videos.iter());
    let mut matches: Vec<&MusicItem> = candidates
        .filter(|v| v.video_type.as_deref() == Some("MUSIC_VIDEO_TYPE_OMV"))
        .filter(|v| {
            let t = squash(&v.title);
            let a = squash(&v.artists.join(" "));
            !want_title.is_empty() && t.contains(&want_title) && (want_artist.is_empty() || a.contains(&want_artist) || want_artist.contains(&a) || t.contains(&want_artist))
        })
        .collect();
    // "Official Audio", lyric and visualizer uploads are still images or text:
    // only use them when there's no real video.
    let still_image = |v: &&MusicItem| {
        let t = v.title.to_lowercase();
        ["audio", "lyric", "visualizer", "visualiser"].iter().any(|w| t.contains(w))
    };
    matches.sort_by_key(|v| still_image(v));
    matches.first().map(|v| (*v).clone())
}

// ---------- network ----------

/// YouTube Music's web client version is "1.YYYYMMDD.01.00"; today's date works.
fn client_version() -> String {
    let days = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs() / 86_400).unwrap_or(20_000) as i64;
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("1.{y:04}{m:02}{d:02}.01.00")
}

fn client() -> Result<&'static reqwest::Client, String> {
    if let Some(c) = HTTP.get() {
        return Ok(c);
    }
    let c = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .pool_max_idle_per_host(6)
        .tcp_keepalive(Duration::from_secs(30))
        .timeout(Duration::from_secs(8))
        .build()
        .map_err(|e| e.to_string())?;
    let _ = HTTP.set(c);
    HTTP.get().ok_or_else(|| "http client init failed".into())
}

fn cache_lookup<T: Clone>(cache: &Mutex<VecDeque<(String, T)>>, key: &str) -> Option<T> {
    cache.lock().ok()?.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone())
}

fn cache_insert<T>(cache: &Mutex<VecDeque<(String, T)>>, key: String, val: T, cap: usize) {
    let Ok(mut guard) = cache.lock() else { return };
    if let Some(pos) = guard.iter().position(|(k, _)| k == &key) {
        guard.remove(pos);
    }
    if guard.len() >= cap {
        guard.pop_front();
    }
    guard.push_back((key, val));
}

fn video_cache_key(title: &str, artist: &str) -> String {
    format!("{}|{}", squash(title), squash(artist))
}

async fn call(endpoint: &str, mut body: Value) -> Result<Value, String> {
    body["context"] = json!({
        "client": { "clientName": "WEB_REMIX", "clientVersion": client_version(), "hl": "en", "gl": "KE" },
        "user": {}
    });
    let resp = client()?
        .post(format!("{API}/{endpoint}?prettyPrint=false"))
        .header("Origin", "https://music.youtube.com")
        .header("Referer", "https://music.youtube.com/")
        .header("Cookie", "SOCS=CAI") // skips the EU consent page
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("YouTube Music unreachable: {e}"))?;
    let status = resp.status();
    let value: Value = resp.json().await.map_err(|e| format!("YouTube Music sent something unreadable: {e}"))?;
    if !status.is_success() {
        let msg = text_at(&value, &["error", "message"]).unwrap_or_default();
        return Err(format!("YouTube Music returned {status}: {msg}"));
    }
    Ok(value)
}

pub async fn search(query: &str) -> Result<SearchResults, String> {
    let body = call("search", json!({ "query": query })).await?;
    let results = parse_search(&body);
    // Index video matches already present in search results so clicking a song doesn't repeat the same search.
    if !results.videos.is_empty() {
        for song in results.top.iter().chain(results.songs.iter()) {
            let artist = song.artists.first().map(String::as_str).unwrap_or("");
            let cands = video_candidates(&results, &song.title, artist);
            if !cands.is_empty() {
                cache_insert(&VIDEO_CACHE, video_cache_key(&song.title, artist), cands, 128);
            }
        }
    }
    Ok(results)
}

pub async fn up_next(video_id: &str) -> Result<Vec<MusicItem>, String> {
    if let Some(hit) = cache_lookup(&UP_NEXT_CACHE, video_id) {
        return Ok(hit);
    }
    let body = call(
        "next",
        json!({
            "videoId": video_id,
            "playlistId": format!("RDAMVM{video_id}"),
            "isAudioOnly": true,
            "enablePersistentPlaylistPanel": true,
            "tunerSettingValue": "AUTOMIX_SETTING_NORMAL",
            "watchEndpointMusicSupportedConfigs": {
                "watchEndpointMusicConfig": { "hasPersistentPlaylistPanel": true, "musicVideoType": "MUSIC_VIDEO_TYPE_ATV" }
            }
        }),
    )
    .await?;
    let mut items = parse_up_next(&body);
    // The first entry is the song itself.
    items.retain(|i| i.video_id.as_deref() != Some(video_id));
    cache_insert(&UP_NEXT_CACHE, video_id.to_string(), items.clone(), 32);
    Ok(items)
}

/// The official music video for a song, if YouTube Music has one.
pub async fn find_music_video(title: &str, artist: &str) -> Result<Option<MusicItem>, String> {
    let results = search(&format!("{title} {artist}")).await?;
    Ok(pick_music_video(&results, title, artist))
}

pub async fn suggestions(input: &str) -> Result<(Vec<String>, Vec<MusicItem>), String> {
    let body = call("music/get_search_suggestions", json!({ "input": input })).await?;
    Ok(parse_suggestions(&body))
}

pub async fn artist(browse_id: &str) -> Result<ArtistPage, String> {
    let body = call("browse", json!({ "browseId": browse_id })).await?;
    let page = parse_artist(&body, browse_id);
    if page.name.is_empty() && page.top_songs.is_empty() {
        return Err("YouTube Music sent an artist page Wallsong couldn't read".into());
    }
    Ok(page)
}

pub async fn album(browse_id: &str) -> Result<AlbumPage, String> {
    let body = call("browse", json!({ "browseId": browse_id })).await?;
    let page = parse_album(&body, browse_id);
    if page.tracks.is_empty() {
        return Err("YouTube Music sent an album page Wallsong couldn't read".into());
    }
    Ok(page)
}

pub async fn find_videos(title: &str, artist: &str) -> Result<Vec<MusicItem>, String> {
    let key = video_cache_key(title, artist);
    if let Some(hit) = cache_lookup(&VIDEO_CACHE, &key) {
        return Ok(hit);
    }
    let results = search(&format!("{title} {artist}")).await?;
    let cands = video_candidates(&results, title, artist);
    cache_insert(&VIDEO_CACHE, key, cands.clone(), 128);
    Ok(cands)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durations() {
        assert_eq!(parse_duration_ms("4:08"), Some(248_000));
        assert_eq!(parse_duration_ms("1:02:03"), Some(3_723_000));
        assert_eq!(parse_duration_ms("2013"), None);
        assert_eq!(parse_duration_ms("1.2B views"), None);
    }

    #[test]
    fn client_version_shape() {
        let v = client_version();
        assert!(v.starts_with("1.20") && v.ends_with(".01.00") && v.len() == 16, "{v}");
    }

    #[test]
    fn subtitle_song() {
        let runs: Vec<Value> = serde_json::from_str(r#"[
            {"text":"Song"},{"text":" • "},
            {"text":"Daft Punk","navigationEndpoint":{"browseEndpoint":{"browseId":"UC123"}}},
            {"text":" & "},
            {"text":"Pharrell Williams","navigationEndpoint":{"browseEndpoint":{"browseId":"UC456"}}},
            {"text":" • "},
            {"text":"Random Access Memories","navigationEndpoint":{"browseEndpoint":{"browseId":"MPREb_x"}}},
            {"text":" • "},{"text":"4:08"}]"#).unwrap();
        let mut item = MusicItem { kind: "song".into(), ..Default::default() };
        fill_from_subtitle(&mut item, &runs);
        assert_eq!(item.artists, vec!["Daft Punk", "Pharrell Williams"]);
        assert_eq!(item.album.as_deref(), Some("Random Access Memories"));
        assert_eq!(item.duration_ms, Some(248_000));
    }

    #[test]
    fn subtitle_upload_without_links() {
        let runs: Vec<Value> = serde_json::from_str(r#"[{"text":"Video"},{"text":" • "},{"text":"Some Channel"},{"text":" • "},{"text":"3M views"},{"text":" • "},{"text":"3:10"}]"#).unwrap();
        let mut item = MusicItem { kind: "video".into(), ..Default::default() };
        fill_from_subtitle(&mut item, &runs);
        assert_eq!(item.artists, vec!["Some Channel"]);
        assert_eq!(item.duration.as_deref(), Some("3:10"));
    }
    #[test]
    fn artist_page_shape() {
        // Shape of an artist page (header + top songs shelf + albums carousel), trimmed to what Wallsong reads.
        let body: Value = serde_json::from_str(r#"{
          "header":{"musicImmersiveHeaderRenderer":{
            "title":{"runs":[{"text":"Sauti Sol"}]},
            "description":{"runs":[{"text":"Kenyan afro-pop band."}]},
            "thumbnail":{"musicThumbnailRenderer":{"thumbnail":{"thumbnails":[{"url":"https://x/a.jpg"}]}}}}},
          "contents":{"singleColumnBrowseResultsRenderer":{"tabs":[{"tabRenderer":{"content":{"sectionListRenderer":{"contents":[
            {"musicShelfRenderer":{"title":{"runs":[{"text":"Top songs"}]},"contents":[
              {"musicResponsiveListItemRenderer":{
                "flexColumns":[
                  {"musicResponsiveListItemFlexColumnRenderer":{"text":{"runs":[{"text":"Suzanna","navigationEndpoint":{"watchEndpoint":{"videoId":"vid1","watchEndpointMusicSupportedConfigs":{"watchEndpointMusicConfig":{"musicVideoType":"MUSIC_VIDEO_TYPE_ATV"}}}}}]}}},
                  {"musicResponsiveListItemFlexColumnRenderer":{"text":{"runs":[{"text":"Sauti Sol","navigationEndpoint":{"browseEndpoint":{"browseId":"UCss"}}}]}}}]}}]}},
            {"musicCarouselShelfRenderer":{
              "header":{"musicCarouselShelfBasicHeaderRenderer":{"title":{"runs":[{"text":"Albums"}]}}},
              "contents":[{"musicTwoRowItemRenderer":{
                "title":{"runs":[{"text":"Midnight Train"}]},
                "subtitle":{"runs":[{"text":"Album"},{"text":" • "},{"text":"2020"}]},
                "navigationEndpoint":{"browseEndpoint":{"browseId":"MPREb_mt"}},
                "thumbnailRenderer":{"musicThumbnailRenderer":{"thumbnail":{"thumbnails":[{"url":"https://x/mt.jpg"}]}}}}}]}}
          ]}}}}]}}}"#).unwrap();
        let page = parse_artist(&body, "UCss");
        assert_eq!(page.name, "Sauti Sol");
        assert_eq!(page.description.as_deref(), Some("Kenyan afro-pop band."));
        assert_eq!(page.top_songs.len(), 1);
        assert_eq!(page.top_songs[0].video_id.as_deref(), Some("vid1"));
        assert_eq!(page.shelves.len(), 1);
        assert_eq!(page.shelves[0].title, "Albums");
        let album = &page.shelves[0].items[0];
        assert_eq!((album.kind.as_str(), album.year.as_deref()), ("album", Some("2020")));
        assert_eq!(album.artists, vec!["Sauti Sol"]);
    }

    #[test]
    fn album_page_shape() {
        let body: Value = serde_json::from_str(r#"{"contents":{"twoColumnBrowseResultsRenderer":{
          "tabs":[{"tabRenderer":{"content":{"sectionListRenderer":{"contents":[{"musicResponsiveHeaderRenderer":{
            "title":{"runs":[{"text":"Midnight Train"}]},
            "subtitle":{"runs":[{"text":"Album"},{"text":" • "},{"text":"2020"}]},
            "straplineTextOne":{"runs":[{"text":"Sauti Sol","navigationEndpoint":{"browseEndpoint":{"browseId":"UCss"}}}]},
            "thumbnail":{"musicThumbnailRenderer":{"thumbnail":{"thumbnails":[{"url":"https://x/mt.jpg"}]}}}}}]}}}}],
          "secondaryContents":{"sectionListRenderer":{"contents":[{"musicShelfRenderer":{"contents":[
            {"musicResponsiveListItemRenderer":{
              "playlistItemData":{"videoId":"t1"},
              "flexColumns":[{"musicResponsiveListItemFlexColumnRenderer":{"text":{"runs":[{"text":"Midnight Train"}]}}}],
              "fixedColumns":[{"musicResponsiveListItemFixedColumnRenderer":{"text":{"runs":[{"text":"3:21"}]}}}],
              "overlay":{"musicItemThumbnailOverlayRenderer":{"content":{"musicPlayButtonRenderer":{"playNavigationEndpoint":{"watchEndpoint":{"videoId":"t1","watchEndpointMusicSupportedConfigs":{"watchEndpointMusicConfig":{"musicVideoType":"MUSIC_VIDEO_TYPE_ATV"}}}}}}}}}}]}}]}}}}}"#).unwrap();
        let page = parse_album(&body, "MPREb_mt");
        assert_eq!(page.title, "Midnight Train");
        assert_eq!(page.artists, vec!["Sauti Sol"]);
        assert_eq!(page.year.as_deref(), Some("2020"));
        assert_eq!(page.tracks.len(), 1);
        let t = &page.tracks[0];
        assert_eq!((t.kind.as_str(), t.duration_ms), ("song", Some(201_000)));
        assert_eq!(t.artists, vec!["Sauti Sol"]);
        assert_eq!(t.thumbnail.as_deref(), Some("https://x/mt.jpg"));
    }
}
