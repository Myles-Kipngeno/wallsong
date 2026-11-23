//! Beat detection from what the speakers are playing (WASAPI loopback).
//!
//! Opening an *input* stream on the default *output* device gives us a copy of
//! everything Windows plays. We never touch the microphone and never store audio.
//!
//! Per audio buffer: low-pass the signal (~150 Hz, kick and bass), take its RMS,
//! compare against a slow running average. A jump above the average is a kick.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

const BASS_CUTOFF_HZ: f32 = 150.0;
const KICK_RATIO: f32 = 1.45; // energy must jump this far above the running average
const KICK_FLOOR: f32 = 0.01; // ignore near-silence
const KICK_GAP_MS: u64 = 140; // no two kicks closer than this
const EMIT_EVERY: Duration = Duration::from_millis(33); // ~30 fps, matches the UI loop
const LEVEL_STEP: f32 = 0.005; // skip emits that change the level by less than this

#[derive(Clone, Serialize)]
struct Beat {
    /// 0..1, how hard the bass is hitting right now.
    level: f32,
    /// True on the frame a kick lands.
    kick: bool,
}

#[derive(Default)]
struct Shared {
    level_bits: AtomicU32,
    kick: AtomicBool,
    last_audio_ms: AtomicU64,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

struct Analyser {
    alpha: f32,
    lowpass: f32,
    average: f32,
    peak: f32,
    level: f32,
    last_kick_ms: u64,
}

impl Analyser {
    fn new(sample_rate: u32) -> Self {
        let alpha = 1.0 - (-2.0 * std::f32::consts::PI * BASS_CUTOFF_HZ / sample_rate as f32).exp();
        Analyser { alpha, lowpass: 0.0, average: 0.0, peak: 0.05, level: 0.0, last_kick_ms: 0 }
    }

    /// `mono` is one buffer of samples already mixed down to one channel.
    fn process(&mut self, mono: impl Iterator<Item = f32>, shared: &Shared) {
        let mut sum = 0.0f32;
        let mut n = 0usize;
        for x in mono {
            self.lowpass += self.alpha * (x - self.lowpass);
            sum += self.lowpass * self.lowpass;
            n += 1;
        }
        if n == 0 {
            return;
        }
        let rms = (sum / n as f32).sqrt();

        // Slow average (~1 s) is the baseline; the peak normalises loud vs quiet songs.
        self.average = self.average * 0.97 + rms * 0.03;
        self.peak = (self.peak * 0.995).max(rms).max(0.02);

        let now = now_ms();
        let kick = rms > KICK_FLOOR
            && rms > self.average * KICK_RATIO
            && now.saturating_sub(self.last_kick_ms) > KICK_GAP_MS;
        if kick {
            self.last_kick_ms = now;
            shared.kick.store(true, Ordering::Relaxed);
        }

        // Fast attack, slower release, so the glow punches then breathes out.
        let target = (rms / self.peak).clamp(0.0, 1.0);
        let speed = if target > self.level { 0.6 } else { 0.08 };
        self.level += (target - self.level) * speed;

        shared.level_bits.store(self.level.to_bits(), Ordering::Relaxed);
        shared.last_audio_ms.store(now, Ordering::Relaxed);
    }
}

fn open_loopback(shared: Arc<Shared>) -> Result<cpal::Stream, String> {
    let host = cpal::default_host();
    let device = host.default_output_device().ok_or("no speakers or headphones found")?;
    let supported = device.default_output_config().map_err(|e| e.to_string())?;
    let channels = supported.channels() as usize;
    let sample_rate = supported.sample_rate().0;
    let config: cpal::StreamConfig = supported.config();
    let on_error = |e: cpal::StreamError| log::error!("audio stream error: {e}");

    let stream = match supported.sample_format() {
        cpal::SampleFormat::F32 => {
            let mut analyser = Analyser::new(sample_rate);
            device.build_input_stream(
                &config,
                move |data: &[f32], _| {
                    let mono = data.chunks(channels).map(|f| f.iter().sum::<f32>() / channels as f32);
                    analyser.process(mono, &shared);
                },
                on_error,
                None,
            )
        }
        cpal::SampleFormat::I16 => {
            let mut analyser = Analyser::new(sample_rate);
            device.build_input_stream(
                &config,
                move |data: &[i16], _| {
                    let mono = data
                        .chunks(channels)
                        .map(|f| f.iter().map(|&s| s as f32 / i16::MAX as f32).sum::<f32>() / channels as f32);
                    analyser.process(mono, &shared);
                },
                on_error,
                None,
            )
        }
        other => return Err(format!("unsupported audio format: {other:?}")),
    };
    stream.map_err(|e| e.to_string())
}

pub fn start(app: AppHandle) {
    thread::spawn(move || {
        let shared = Arc::new(Shared::default());
        // The stream must stay alive (and on this thread) for capture to continue.
        let stream = match open_loopback(shared.clone()) {
            Ok(s) => s,
            Err(e) => {
                log::error!("audio capture failed: {e}");
                let _ = app.emit("audio-error", e);
                return;
            }
        };
        if let Err(e) = stream.play() {
            let _ = app.emit("audio-error", e.to_string());
            return;
        }

        let mut level = 0.0f32;
        let mut sent = f32::NAN; // NaN so the first value is always emitted
        loop {
            let silent = now_ms().saturating_sub(shared.last_audio_ms.load(Ordering::Relaxed)) > 200;
            // Windows sends no loopback data during silence, so fade out ourselves,
            // and land on exactly 0 so emits stop until the music returns.
            level = if silent {
                let faded = level * 0.9;
                if faded < 0.01 { 0.0 } else { faded }
            } else {
                f32::from_bits(shared.level_bits.load(Ordering::Relaxed))
            };
            let kick = shared.kick.swap(false, Ordering::Relaxed);
            // The UI keeps the last level, so unchanged frames need no message.
            if kick || !((level - sent).abs() < LEVEL_STEP) {
                let _ = app.emit("beat", Beat { level, kick });
                sent = level;
            }
            thread::sleep(EMIT_EVERY);
        }
    });
}
