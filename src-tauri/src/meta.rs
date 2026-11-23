//! Track metadata shared by every module, plus title cleaning.
//!
//! Browsers report a plain YouTube video as title "Artist - Song (Official Video)"
//! with the channel as artist. Lyrics and video lookups need "Song" and "Artist".

use serde::Serialize;

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrackInfo {
    /// Stable id for this song: changes when the song changes.
    pub key: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration_ms: u64,
    /// App that is playing, e.g. "Spotify.exe" or "Chrome".
    pub source: String,
    /// Album art as a data URL, when the app provides one.
    pub artwork: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Position {
    pub position_ms: u64,
    pub playing: bool,
    /// Unix time in ms at which `position_ms` was true. The UI extrapolates from it.
    pub sampled_at_ms: u64,
}

pub fn track_key(title: &str, artist: &str, album: &str) -> String {
    format!("{}|{}|{}", title.trim(), artist.trim(), album.trim()).to_lowercase()
}

/// A bracket is dropped when any of its words is one of these.
const NOISE: [&str; 15] = [
    "official", "video", "audio", "lyric", "lyrics", "visualizer", "visualiser", "hd", "4k", "mv",
    "remaster", "remastered", "explicit", "clean", "live",
];

/// Removes "(Official Video)", "[Lyrics]" and similar bracketed noise.
fn strip_noise(s: &str) -> String {
    let mut out = String::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        let close = match c {
            '(' => Some(')'),
            '[' => Some(']'),
            _ => None,
        };
        match close {
            Some(close) => {
                let inner: String = chars.by_ref().take_while(|&x| x != close).collect();
                let lower = inner.to_lowercase();
                let is_noise = lower
                    .split(|c: char| !c.is_alphanumeric())
                    .any(|word| NOISE.contains(&word));
                if !is_noise {
                    out.push(c);
                    out.push_str(&inner);
                    out.push(close);
                }
            }
            None => out.push(c),
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Returns (title, artist) cleaned for lyrics and video lookups.
pub fn clean(title: &str, artist: &str) -> (String, String) {
    let mut artist = artist.trim().to_string();
    for suffix in [" - Topic", "VEVO", "Vevo"] {
        if let Some(stripped) = artist.strip_suffix(suffix) {
            artist = stripped.trim().to_string();
        }
    }
    let mut title = strip_noise(title);

    // "Artist - Song" in the title, typical of plain YouTube uploads.
    // Compare ignoring case, spaces and punctuation: "KodakBlack" matches "Kodak Black".
    let squash = |s: &str| s.chars().filter(|c| c.is_alphanumeric()).collect::<String>().to_lowercase();
    if let Some((left, right)) = title.split_once(" - ") {
        let left = left.trim();
        let (l, a) = (squash(left), squash(&artist));
        let channel_like = a.is_empty() || (!l.is_empty() && (l.contains(&a) || a.contains(&l)));
        if channel_like {
            artist = left.to_string();
            title = right.trim().to_string();
        }
    }
    (title, artist)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strips_official_video() {
        assert_eq!(
            clean("Kodak Black - Tunnel Vision (Official Video)", "KodakBlackVEVO"),
            ("Tunnel Vision".into(), "Kodak Black".into())
        );
    }

    #[test]
    fn keeps_real_brackets() {
        assert_eq!(
            clean("Stuck In A Dream (feat. Gunna)", "Lil Mosey"),
            ("Stuck In A Dream (feat. Gunna)".into(), "Lil Mosey".into())
        );
    }

    #[test]
    fn topic_channels() {
        assert_eq!(clean("Lucid Dreams", "Juice WRLD - Topic"), ("Lucid Dreams".into(), "Juice WRLD".into()));
    }

    #[test]
    fn leaves_dashed_titles_from_real_artists() {
        // Spotify titles like "Song - Remastered 2011" must not be split into artist/title.
        assert_eq!(
            clean("Redrum - Live", "21 Savage"),
            ("Redrum - Live".into(), "21 Savage".into())
        );
    }

    #[test]
    fn lyrics_tag() {
        assert_eq!(clean("Love Me [Lyrics]", "Lil Tecca"), ("Love Me".into(), "Lil Tecca".into()));
    }
}
