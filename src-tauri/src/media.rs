//! What is playing, from the Windows media session (SMTC).
//!
//! Spotify, Chrome/Edge tabs (YouTube Music, SoundCloud...), Apple Music for
//! Windows and most players publish their song here. Polling every 250 ms is
//! simple and cheap; event subscriptions can replace it later.

use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use tauri::{AppHandle, Emitter};
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session,
    GlobalSystemMediaTransportControlsSessionManager as SessionManager,
    GlobalSystemMediaTransportControlsSessionMediaProperties as MediaProperties,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus,
};
use windows::Storage::Streams::DataReader;
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

use crate::lyrics;
use crate::meta::{self, Position, TrackInfo};

/// 100 ns ticks between 1601-01-01 (Windows epoch) and 1970-01-01 (Unix epoch).
const EPOCH_GAP_TICKS: i64 = 116_444_736_000_000_000;
const POLL: Duration = Duration::from_millis(250);
/// Artwork often arrives a moment after the song changes, and browsers may still hand
/// over the previous song's thumbnail at first; keep re-reading it this many polls (~10 s).
const ARTWORK_RETRIES: u8 = 40;

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn ticks_to_ms(ticks: i64) -> u64 {
    (ticks.max(0) / 10_000) as u64
}

fn init_winrt() {
    // Safe to call more than once per thread; errors mean "already initialised".
    unsafe {
        let _ = RoInitialize(RO_INIT_MULTITHREADED);
    }
}

/// Apps we prefer when several are playing at once.
fn priority(source: &str) -> u8 {
    let s = source.to_lowercase();
    if s.contains("spotify") {
        3
    } else if ["chrome", "msedge", "firefox", "brave", "opera", "vivaldi"].iter().any(|b| s.contains(b)) {
        2
    } else {
        1
    }
}

fn pick_session(manager: &SessionManager) -> Option<Session> {
    let sessions = manager.GetSessions().ok()?;
    let mut best: Option<(u8, Session)> = None;
    for s in &sessions {
        let playing = s
            .GetPlaybackInfo()
            .and_then(|i| i.PlaybackStatus())
            .map(|st| st == PlaybackStatus::Playing)
            .unwrap_or(false);
        let source = s.SourceAppUserModelId().map(|h| h.to_string()).unwrap_or_default();
        let score = priority(&source) + if playing { 10 } else { 0 };
        if best.as_ref().map_or(true, |(b, _)| score > *b) {
            best = Some((score, s));
        }
    }
    best.map(|(_, s)| s).or_else(|| manager.GetCurrentSession().ok())
}

fn read_artwork(props: &MediaProperties) -> Option<String> {
    let reference = props.Thumbnail().ok()?;
    let stream = reference.OpenReadAsync().ok()?.get().ok()?;
    let size = stream.Size().ok()? as u32;
    if size == 0 || size > 8_000_000 {
        return None;
    }
    let reader = DataReader::CreateDataReader(&stream.GetInputStreamAt(0).ok()?).ok()?;
    reader.LoadAsync(size).ok()?.get().ok()?;
    let mut bytes = vec![0u8; size as usize];
    reader.ReadBytes(&mut bytes).ok()?;
    let mime = stream
        .ContentType()
        .map(|h| h.to_string())
        .ok()
        .filter(|m| m.starts_with("image/"))
        .unwrap_or_else(|| "image/png".into());
    Some(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes)))
}

/// Our own clock for apps that publish no timeline (position stuck at 0).
#[derive(Default)]
struct LocalClock {
    position_ms: u64,
    at_ms: u64,
    playing: bool,
}

impl LocalClock {
    fn reset(&mut self, playing: bool) {
        *self = LocalClock { position_ms: 0, at_ms: now_ms(), playing };
    }
    fn now(&self) -> u64 {
        if self.playing {
            self.position_ms + now_ms().saturating_sub(self.at_ms)
        } else {
            self.position_ms
        }
    }
    fn set_playing(&mut self, playing: bool) {
        if playing != self.playing {
            self.position_ms = self.now();
            self.at_ms = now_ms();
            self.playing = playing;
        }
    }
}

pub fn start(app: AppHandle) {
    thread::spawn(move || {
        init_winrt();
        let manager = loop {
            match SessionManager::RequestAsync().and_then(|op| op.get()) {
                Ok(m) => break m,
                Err(e) => {
                    log::warn!("media session manager unavailable, retrying: {e}");
                    thread::sleep(Duration::from_secs(2));
                }
            }
        };

        let mut current: Option<TrackInfo> = None;
        let mut artwork_tries = 0u8;
        // The previous song's artwork. If the new song reports the same image it may be
        // stale, so it is shown but re-checked; same-album songs simply keep it.
        let mut stale_artwork: Option<String> = None;
        let mut clock = LocalClock::default();

        loop {
            match pick_session(&manager).and_then(|s| poll(&s).map(|state| (s, state))) {
                Some((session, state)) => {
                    let changed = current.as_ref().map(|t| t.key != state.key).unwrap_or(true);
                    if changed {
                        let artwork = session
                            .TryGetMediaPropertiesAsync()
                            .and_then(|op| op.get())
                            .ok()
                            .and_then(|p| read_artwork(&p));
                        artwork_tries = 0;
                        if let Some(previous) = current.take() {
                            stale_artwork = previous.artwork;
                        }
                        clock.reset(state.playing);
                        let track = TrackInfo {
                            key: state.key.clone(),
                            title: state.title.clone(),
                            artist: state.artist.clone(),
                            album: state.album.clone(),
                            duration_ms: state.duration_ms,
                            source: state.source.clone(),
                            artwork,
                        };
                        let _ = app.emit("track", Some(&track));
                        fetch_lyrics(&app, &track);
                        current = Some(track);
                    } else if let Some(track) = current.as_mut() {
                        let suspect = track.artwork.is_none() || track.artwork == stale_artwork;
                        if suspect && artwork_tries < ARTWORK_RETRIES {
                            artwork_tries += 1;
                            let artwork = session
                                .TryGetMediaPropertiesAsync()
                                .and_then(|op| op.get())
                                .ok()
                                .and_then(|p| read_artwork(&p));
                            if artwork.is_some() && artwork != track.artwork {
                                track.artwork = artwork;
                                let _ = app.emit("track", Some(&*track));
                            }
                        }
                    }

                    clock.set_playing(state.playing);
                    let position_ms = state.position_ms.unwrap_or_else(|| clock.now());
                    let _ = app.emit(
                        "position",
                        Position { position_ms, playing: state.playing, sampled_at_ms: now_ms() },
                    );
                }
                None => {
                    // Keep the artwork across a gap between songs, so the next song's
                    // stale thumbnail is still recognised.
                    if let Some(previous) = current.take() {
                        stale_artwork = previous.artwork;
                        let _ = app.emit("track", Option::<TrackInfo>::None);
                    }
                }
            }
            thread::sleep(POLL);
        }
    });
}

struct State {
    key: String,
    title: String,
    artist: String,
    album: String,
    source: String,
    duration_ms: u64,
    /// None when the app publishes no timeline; the local clock takes over.
    position_ms: Option<u64>,
    playing: bool,
}

fn poll(session: &Session) -> Option<State> {
    let props = session.TryGetMediaPropertiesAsync().ok()?.get().ok()?;
    let title = props.Title().ok()?.to_string();
    if title.trim().is_empty() {
        return None;
    }
    let artist = props.Artist().map(|h| h.to_string()).unwrap_or_default();
    let album = props.AlbumTitle().map(|h| h.to_string()).unwrap_or_default();
    let source = session.SourceAppUserModelId().map(|h| h.to_string()).unwrap_or_default();
    let playing = session
        .GetPlaybackInfo()
        .and_then(|i| i.PlaybackStatus())
        .map(|s| s == PlaybackStatus::Playing)
        .unwrap_or(false);

    let timeline = session.GetTimelineProperties().ok()?;
    let end_ms = timeline.EndTime().map(|t| ticks_to_ms(t.Duration)).unwrap_or(0);
    let position_ms = if end_ms == 0 {
        None
    } else {
        let reported = timeline.Position().map(|t| ticks_to_ms(t.Duration)).unwrap_or(0);
        let updated_ms = timeline
            .LastUpdatedTime()
            .map(|t| ticks_to_ms(t.UniversalTime - EPOCH_GAP_TICKS))
            .unwrap_or_else(|_| now_ms());
        // The app reported `reported` at `updated_ms`; move it forward to now.
        let drift = if playing { now_ms().saturating_sub(updated_ms) } else { 0 };
        Some((reported + drift).min(end_ms))
    };

    Some(State {
        key: meta::track_key(&title, &artist, &album),
        title,
        artist,
        album,
        source,
        duration_ms: end_ms,
        position_ms,
        playing,
    })
}

fn fetch_lyrics(app: &AppHandle, track: &TrackInfo) {
    let app = app.clone();
    let (title, artist) = meta::clean(&track.title, &track.artist);
    let (key, album, duration_ms) = (track.key.clone(), track.album.clone(), track.duration_ms);
    tauri::async_runtime::spawn(async move {
        let found = lyrics::fetch(&key, &title, &artist, &album, duration_ms).await;
        let payload = found.unwrap_or(lyrics::Lyrics { track_key: key, synced: None, plain: None, instrumental: false });
        let _ = app.emit("lyrics", payload);
    });
}

/// Play/pause/next/previous on the chosen session. Runs on its own WinRT thread.
pub fn control(action: &str) -> Result<(), String> {
    let action = action.to_string();
    thread::spawn(move || -> Result<(), String> {
        init_winrt();
        let manager = SessionManager::RequestAsync().and_then(|op| op.get()).map_err(|e| e.to_string())?;
        let session = pick_session(&manager).ok_or("nothing is playing")?;
        let op = match action.as_str() {
            "toggle" => session.TryTogglePlayPauseAsync(),
            "next" => session.TrySkipNextAsync(),
            "previous" => session.TrySkipPreviousAsync(),
            other => return Err(format!("unknown action: {other}")),
        };
        op.and_then(|o| o.get()).map(|_| ()).map_err(|e| e.to_string())
    })
    .join()
    .map_err(|_| "media control thread panicked".to_string())?
}
