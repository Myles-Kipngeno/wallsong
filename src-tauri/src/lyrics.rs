//! Synced lyrics from LRCLIB (https://lrclib.net), free and open.
//!
//! Order of attempts:
//! 1. exact match on title + artist + album + duration (`/api/get`)
//! 2. search by title + artist, preferring synced lyrics with a close duration
//! 3. free-text search on "title artist"

use serde::{Deserialize, Serialize};

const BASE: &str = "https://lrclib.net/api";
const USER_AGENT: &str = "Wallsong/0.1.0 (personal desktop music skin)";

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

fn client() -> Option<reqwest::Client> {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .ok()
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

pub async fn fetch(key: &str, title: &str, artist: &str, album: &str, duration_ms: u64) -> Option<Lyrics> {
    let client = client()?;
    let enc = |s: &str| urlencoding::encode(s).into_owned();
    let duration_s = duration_ms as f64 / 1000.0;

    // 1. Exact match.
    if !album.is_empty() && duration_ms > 0 {
        let url = format!(
            "{BASE}/get?track_name={}&artist_name={}&album_name={}&duration={}",
            enc(title),
            enc(artist),
            enc(album),
            duration_s.round() as u64
        );
        if let Ok(resp) = client.get(&url).send().await {
            if resp.status().is_success() {
                if let Ok(t) = resp.json::<LrcLibTrack>().await {
                    return Some(to_lyrics(key, t));
                }
            }
        }
    }

    // 2. Field search, then 3. free-text search.
    let searches = [
        format!("{BASE}/search?track_name={}&artist_name={}", enc(title), enc(artist)),
        format!("{BASE}/search?q={}", enc(&format!("{title} {artist}"))),
    ];
    for url in searches {
        let Ok(resp) = client.get(&url).send().await else { continue };
        let Ok(hits) = resp.json::<Vec<LrcLibTrack>>().await else { continue };
        if let Some(t) = best(hits, duration_s) {
            return Some(to_lyrics(key, t));
        }
    }
    None
}
