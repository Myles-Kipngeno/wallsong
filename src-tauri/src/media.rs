//! What is playing, from the Windows media session (SMTC).
//!
//! Spotify, Chrome/Edge tabs (YouTube Music, SoundCloud...), Apple Music for
//! Windows and most players publish their song here. Subscribes to WinRT SMTC
//! change events to wake immediately when the browser switches songs or play
//! state, with a 250 ms park timeout to smooth timeline extrapolation.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use windows::Foundation::TypedEventHandler;
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
/// Artwork often arrives a moment after the song changes; retry this many polls.
const ARTWORK_RETRIES: u8 = 12;

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

/// The app you chose to follow in the source menu (its Windows app id), or None for automatic.
static PINNED: Mutex<Option<String>> = Mutex::new(None);

pub fn set_pinned(source: Option<String>) {
    if let Ok(mut pinned) = PINNED.lock() {
        *pinned = source.filter(|s| !s.is_empty());
    }
}

/// The latest list of apps, for windows that open after it was last sent.
static SESSIONS: Mutex<Vec<SessionInfo>> = Mutex::new(Vec::new());

pub fn sessions() -> Vec<SessionInfo> {
    SESSIONS.lock().map(|s| s.clone()).unwrap_or_default()
}

fn pinned() -> Option<String> {
    PINNED.lock().ok().and_then(|p| p.clone())
}

/// One app that's talking to Windows' media controls, for the source menu.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    /// Windows app id, e.g. "Spotify.exe" or "Brave".
    pub id: String,
    /// Friendly name, e.g. "Spotify" or "Brave".
    pub name: String,
    pub playing: bool,
    pub title: String,
}

/// Turns a Windows app id into a name people recognise.
pub fn friendly_name(id: &str) -> String {
    let lower = id.to_lowercase();
    let known = [
        ("spotify", "Spotify"),
        ("brave", "Brave"),
        ("chrome", "Chrome"),
        ("msedge", "Edge"),
        ("firefox", "Firefox"),
        ("308046b0af4a39cb", "Firefox"),
        ("opera", "Opera"),
        ("vivaldi", "Vivaldi"),
        ("applemusic", "Apple Music"),
        ("itunes", "iTunes"),
        ("zunemusic", "Media Player"),
        ("vlc", "VLC"),
        ("soundcloud", "SoundCloud"),
        ("amazon", "Amazon Music"),
        ("tidal", "TIDAL"),
        ("deezer", "Deezer"),
    ];
    if let Some((_, name)) = known.iter().find(|(k, _)| lower.contains(k)) {
        return name.to_string();
    }
    // "Company.App_xyz!App" or "app.exe": keep the readable middle part.
    let base = id.split('!').next().unwrap_or(id);
    let base = base.split('_').next().unwrap_or(base);
    let base = base.trim_end_matches(".exe").trim_end_matches(".EXE");
    base.rsplit('.').next().filter(|s| !s.is_empty()).unwrap_or(base).to_string()
}

fn list_sessions(manager: &SessionManager) -> Vec<SessionInfo> {
    let Ok(sessions) = manager.GetSessions() else { return vec![] };
    let mut out: Vec<SessionInfo> = vec![];
    for s in &sessions {
        let id = s.SourceAppUserModelId().map(|h| h.to_string()).unwrap_or_default();
        if id.is_empty() || is_own_session(&id) || out.iter().any(|o| o.id == id) {
            continue;
        }
        let playing = s
            .GetPlaybackInfo()
            .and_then(|i| i.PlaybackStatus())
            .map(|st| st == PlaybackStatus::Playing)
            .unwrap_or(false);
        // Avoid slow COM IPC for non-playing background apps: only fetch title if playing.
        let title = if playing {
            s.TryGetMediaPropertiesAsync()
                .and_then(|op| op.get())
                .and_then(|p| p.Title())
                .map(|h| h.to_string())
                .unwrap_or_default()
        } else {
            String::new()
        };
        out.push(SessionInfo { name: friendly_name(&id), id, playing, title });
    }
    out
}

/// Wallsong's own player also shows up in Windows' media list; never follow it.
fn is_own_session(source: &str) -> bool {
    let s = source.to_lowercase();
    s.contains("wallsong") || s.contains("webview")
}

fn pick_session(manager: &SessionManager) -> Option<Session> {
    let sessions = manager.GetSessions().ok()?;
    let pin = pinned();
    if let Some(pin) = &pin {
        // You chose an app in the source menu: follow only that one.
        return sessions.into_iter().find(|s| s.SourceAppUserModelId().map(|h| h.to_string()).ok().as_ref() == Some(pin));
    }
    let mut best: Option<(u8, Session)> = None;
    for s in &sessions {
        if is_own_session(&s.SourceAppUserModelId().map(|h| h.to_string()).unwrap_or_default()) {
            continue;
        }
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
    best.map(|(_, s)| s).or_else(|| {
        manager
            .GetCurrentSession()
            .ok()
            .filter(|s| !is_own_session(&s.SourceAppUserModelId().map(|h| h.to_string()).unwrap_or_default()))
    })
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

/// Set by WinRT SMTC events when track metadata or active session changes.
static PROPS_DIRTY: AtomicBool = AtomicBool::new(true);

struct SessionSubs {
    session: Session,
    id: String,
    props_tok: i64,
    playback_tok: i64,
    timeline_tok: i64,
}

impl SessionSubs {
    fn attach(session: Session, id: String, worker: thread::Thread) -> Option<Self> {
        let w1 = worker.clone();
        let props_tok = session
            .MediaPropertiesChanged(&TypedEventHandler::new(move |_, _| {
                PROPS_DIRTY.store(true, Ordering::Release);
                w1.unpark();
                Ok(())
            }))
            .ok()?;
        let w2 = worker.clone();
        let playback_tok = session
            .PlaybackInfoChanged(&TypedEventHandler::new(move |_, _| {
                w2.unpark();
                Ok(())
            }))
            .ok()?;
        let timeline_tok = session
            .TimelinePropertiesChanged(&TypedEventHandler::new(move |_, _| {
                w3_unpark(&worker);
                Ok(())
            }))
            .ok()?;
        Some(Self { session, id, props_tok, playback_tok, timeline_tok })
    }
}

fn w3_unpark(t: &thread::Thread) {
    t.unpark();
}

impl Drop for SessionSubs {
    fn drop(&mut self) {
        let _ = self.session.RemoveMediaPropertiesChanged(self.props_tok);
        let _ = self.session.RemovePlaybackInfoChanged(self.playback_tok);
        let _ = self.session.RemoveTimelinePropertiesChanged(self.timeline_tok);
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

        let worker = thread::current();
        let w_sess = worker.clone();
        let _sess_tok = manager.SessionsChanged(&TypedEventHandler::new(move |_, _| {
            PROPS_DIRTY.store(true, Ordering::Release);
            w_sess.unpark();
            Ok(())
        }));
        let w_cur = worker.clone();
        let _cur_tok = manager.CurrentSessionChanged(&TypedEventHandler::new(move |_, _| {
            PROPS_DIRTY.store(true, Ordering::Release);
            w_cur.unpark();
            Ok(())
        }));

        let mut subs: Option<SessionSubs> = None;
        let mut current: Option<TrackInfo> = None;
        let mut artwork_tries = 0u8;
        let mut clock = LocalClock::default();
        let mut last_sessions: Vec<SessionInfo> = vec![];
        let mut tick = 0u32;

        loop {
            // The source menu's list of apps, once every 5 seconds (20 ticks), only when it changes.
            tick = tick.wrapping_add(1);
            if tick % 20 == 1 {
                let sessions = list_sessions(&manager);
                if sessions != last_sessions {
                    let _ = app.emit("sessions", &sessions);
                    if let Ok(mut store) = SESSIONS.lock() {
                        *store = sessions.clone();
                    }
                    last_sessions = sessions;
                }
            }

            if let Some(session) = pick_session(&manager) {
                let sid = session.SourceAppUserModelId().map(|h| h.to_string()).unwrap_or_default();
                if subs.as_ref().map(|s| s.id != sid).unwrap_or(true) {
                    drop(subs.take());
                    PROPS_DIRTY.store(true, Ordering::Release);
                    subs = SessionSubs::attach(session.clone(), sid, worker.clone());
                }

                if let Some((state, fresh_props)) = poll(&session) {
                    let changed = current.as_ref().map(|t| t.key != state.key).unwrap_or(true);
                    if changed {
                        artwork_tries = 0;
                        clock.reset(state.playing);
                        let mut track = TrackInfo {
                            key: state.key.clone(),
                            title: state.title.clone(),
                            artist: state.artist.clone(),
                            album: state.album.clone(),
                            duration_ms: state.duration_ms,
                            source: state.source.clone(),
                            artwork: None,
                        };
                        // Emit track & start lyrics fetch BEFORE blocking on WinRT artwork stream IPC.
                        let _ = app.emit("track", Some(&track));
                        fetch_lyrics(&app, &track);

                        let artwork = fresh_props
                            .as_ref()
                            .and_then(read_artwork)
                            .or_else(|| session.TryGetMediaPropertiesAsync().and_then(|op| op.get()).ok().and_then(|p| read_artwork(&p)));
                        if artwork.is_some() {
                            track.artwork = artwork;
                            let _ = app.emit("track", Some(&track));
                        }
                        current = Some(track);
                    } else if let Some(track) = current.as_mut() {
                        if track.artwork.is_none() && artwork_tries < ARTWORK_RETRIES {
                            artwork_tries += 1;
                            let artwork = fresh_props
                                .as_ref()
                                .and_then(read_artwork)
                                .or_else(|| session.TryGetMediaPropertiesAsync().and_then(|op| op.get()).ok().and_then(|p| read_artwork(&p)));
                            if artwork.is_some() {
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
                } else if current.take().is_some() {
                    let _ = app.emit("track", Option::<TrackInfo>::None);
                }
            } else {
                subs = None;
                if current.take().is_some() {
                    let _ = app.emit("track", Option::<TrackInfo>::None);
                }
            }
            thread::park_timeout(POLL);
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

#[derive(Clone)]
struct CachedMediaProps {
    session_id: String,
    title: String,
    artist: String,
    album: String,
    duration_ms: u64,
    last_fetched_ms: u64,
}

static CACHED_PROPS: Mutex<Option<CachedMediaProps>> = Mutex::new(None);

fn poll(session: &Session) -> Option<(State, Option<MediaProperties>)> {
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

    let dirty = PROPS_DIRTY.swap(false, Ordering::AcqRel);
    let mut fresh_props: Option<MediaProperties> = None;
    let (title, artist, album) = {
        let mut guard = CACHED_PROPS.lock().ok();
        let now = now_ms();
        // Browser streams with end_ms == 0 still refresh quickly if dirty wasn't signalled;
        // once MediaPropertiesChanged arrives, PROPS_DIRTY bypasses the cache immediately.
        let max_age = if end_ms == 0 { 750 } else { 10_000 };
        let reuse = (!dirty).then(|| {
            guard.as_ref().and_then(|c| c.as_ref()).filter(|c| {
                c.session_id == source && c.duration_ms == end_ms && now.saturating_sub(c.last_fetched_ms) < max_age
            })
        }).flatten();

        if let Some(c) = reuse {
            (c.title.clone(), c.artist.clone(), c.album.clone())
        } else {
            let props = session.TryGetMediaPropertiesAsync().ok()?.get().ok()?;
            let title = props.Title().ok()?.to_string();
            if title.trim().is_empty() {
                return None;
            }
            let artist = props.Artist().map(|h| h.to_string()).unwrap_or_default();
            let album = props.AlbumTitle().map(|h| h.to_string()).unwrap_or_default();
            if let Some(ref mut g) = guard {
                **g = Some(CachedMediaProps {
                    session_id: source.clone(),
                    title: title.clone(),
                    artist: artist.clone(),
                    album: album.clone(),
                    duration_ms: end_ms,
                    last_fetched_ms: now,
                });
            }
            fresh_props = Some(props);
            (title, artist, album)
        }
    };

    if title.trim().is_empty() {
        return None;
    }

    Some((
        State {
            key: meta::track_key(&title, &artist, &album),
            title,
            artist,
            album,
            source,
            duration_ms: end_ms,
            position_ms,
            playing,
        },
        fresh_props,
    ))
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
