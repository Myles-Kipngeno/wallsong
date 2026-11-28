//! Synced lyrics from LRCLIB (https://lrclib.net), free and open.
//!
//! Order of attempts:
//! 1. exact match on title + artist + album + duration (`/api/get`)
//! 2. search by title + artist, preferring synced lyrics with a close duration
//! 3. free-text search on "title artist"

use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

const BASE: &str = "https://lrclib.net/api";
const USER_AGENT: &str = "Wallsong/0.1.0 (personal desktop music skin)";
const CACHE_CAP: usize = 64;

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static CACHE: Mutex<VecDeque<(String, Option<Lyrics>)>> = Mutex::new(VecDeque::new());

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Lyrics {
    /// Matches `TrackInfo::key`, so the UI can ignore lyrics for an old song.
    pub track_key: String,
    /// Raw LRC text with [mm:ss.xx] timestamps, parsed in the UI.
    pub synced: Option<String>,
    pub plain: Option<String>,
    pub instrumental: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LrcLibTrack {
    synced_lyrics: Option<String>,
    plain_lyrics: Option<String>,
    instrumental: Option<bool>,
    duration: Option<f64>,
}

fn client() -> Option<&'static reqwest::Client> {
    if CLIENT.get().is_none() {
        if let Ok(c) = reqwest::Client::builder()
            .user_agent(USER_AGENT)
            .pool_max_idle_per_host(4)
            .tcp_keepalive(std::time::Duration::from_secs(30))
            .timeout(std::time::Duration::from_secs(6))
            .build()
        {
            let _ = CLIENT.set(c);
        }
    }
    CLIENT.get()
}

fn cache_get(lookup_key: &str, track_key: &str) -> Option<Option<Lyrics>> {
    let guard = CACHE.lock().ok()?;
    let (_, entry) = guard.iter().find(|(k, _)| k == lookup_key)?;
    Some(entry.clone().map(|mut l| {
        l.track_key = track_key.to_string();
        l
    }))
}

fn cache_put(lookup_key: String, val: Option<Lyrics>) {
    let Ok(mut guard) = CACHE.lock() else { return };
    if let Some(pos) = guard.iter().position(|(k, _)| k == &lookup_key) {
        guard.remove(pos);
    }
    if guard.len() >= CACHE_CAP {
        guard.pop_front();
    }
    guard.push_back((lookup_key, val));
}

fn to_lyrics(key: &str, t: LrcLibTrack) -> Lyrics {
    Lyrics {
        track_key: key.to_string(),
        synced: t.synced_lyrics.filter(|s| !s.trim().is_empty()),
        plain: t.plain_lyrics.filter(|s| !s.trim().is_empty()),
        instrumental: t.instrumental.unwrap_or(false),
    }
}

/// Picks the best search hit: synced first, then the closest duration.
fn best(hits: Vec<LrcLibTrack>, duration_s: f64) -> Option<LrcLibTrack> {
    hits.into_iter().min_by(|a, b| {
        let score = |t: &LrcLibTrack| {
            let synced_penalty = if t.synced_lyrics.is_some() { 0.0 } else { 1000.0 };
            let duration_gap = match (t.duration, duration_s > 0.0) {
                (Some(d), true) => (d - duration_s).abs(),
                _ => 30.0,
            };
            synced_penalty + duration_gap
        };
        score(a).partial_cmp(&score(b)).unwrap_or(std::cmp::Ordering::Equal)
    })
}

async fn fetch_exact(client: &'static reqwest::Client, url: String) -> Option<LrcLibTrack> {
    let resp = client.get(&url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    resp.json::<LrcLibTrack>().await.ok()
}

async fn fetch_search(client: &'static reqwest::Client, url: String, duration_s: f64) -> Option<LrcLibTrack> {
    let resp = client.get(&url).send().await.ok()?;
    let hits = resp.json::<Vec<LrcLibTrack>>().await.ok()?;
    best(hits, duration_s)
}

pub async fn fetch(key: &str, title: &str, artist: &str, album: &str, duration_ms: u64) -> Option<Lyrics> {
    let duration_s = duration_ms as f64 / 1000.0;
    let lookup_key = format!("{}|{}|{}|{}", title.trim().to_lowercase(), artist.trim().to_lowercase(), album.trim().to_lowercase(), duration_s.round() as u64);
    if let Some(hit) = cache_get(&lookup_key, key) {
        return hit;
    }

    let client = client()?;
    let enc = |s: &str| urlencoding::encode(s).into_owned();
    let field_url = format!("{BASE}/search?track_name={}&artist_name={}", enc(title), enc(artist));

    // Fire exact `/api/get` and `/api/search` concurrently so misses don't wait for a second RTT.
    let found = if !album.is_empty() && duration_ms > 0 {
        let exact_url = format!(
            "{BASE}/get?track_name={}&artist_name={}&album_name={}&duration={}",
            enc(title),
            enc(artist),
            enc(album),
            duration_s.round() as u64
        );
        let h_exact = tauri::async_runtime::spawn(fetch_exact(client, exact_url));
        let h_field = tauri::async_runtime::spawn(fetch_search(client, field_url, duration_s));
        let exact = h_exact.await.ok().flatten();
        let field = h_field.await.ok().flatten();
        exact.or(field)
    } else {
        fetch_search(client, field_url, duration_s).await
    };

    let result = if let Some(t) = found {
        Some(to_lyrics(key, t))
    } else {
        let q_url = format!("{BASE}/search?q={}", enc(&format!("{title} {artist}")));
        fetch_search(client, q_url, duration_s).await.map(|t| to_lyrics(key, t))
    };

    cache_put(lookup_key, result.clone());
    result
}
