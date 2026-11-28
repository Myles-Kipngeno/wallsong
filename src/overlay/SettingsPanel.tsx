import { useEffect, useRef, useState } from "react";
import { call } from "../lib/bus";
import { inTauri } from "../lib/native";
import { CLOCK_FONTS, LYRIC_FONTS } from "../lib/fonts";
import { GLOW_STYLE_HINTS } from "../components/GlowCanvas";
import { CARD_LAYOUTS, LYRIC_STYLES, saveSettings, type DisplayRole, type LyricStyle, type Settings } from "../lib/settings";
import type { Place, WsState } from "../lib/types";
import { resetDock } from "./Dock";
import { Icon, type IconName } from "./icons";
import { CardPreview } from "./PlayerCard";

type Section = "lyrics" | "clock" | "glow" | "colours" | "video" | "displays" | "controls" | "dock" | "card" | "general";

const SECTIONS: Array<{ id: Section; label: string; icon: IconName }> = [
  { id: "lyrics", label: "Lyrics", icon: "lyrics" },
  { id: "clock", label: "Clock", icon: "clock" },
  { id: "glow", label: "Glow", icon: "sparkle" },
  { id: "colours", label: "Colours", icon: "palette" },
  { id: "video", label: "Video", icon: "video" },
  { id: "displays", label: "Displays", icon: "monitor" },
  { id: "controls", label: "Controls", icon: "bottom" },
  { id: "dock", label: "Dock", icon: "dock" },
  { id: "card", label: "Player card", icon: "card" },
  { id: "general", label: "General", icon: "settings" },
];

/** How long to wait after typing before looking the city up. */
const CITY_DEBOUNCE_MS = 400;

/** Settings > Dock: type a city, pick the right one from what Open-Meteo knows. */
function CitySearch({ dock }: { dock: Settings["dock"] }) {
  const [text, setText] = useState("");
  const [places, setPlaces] = useState<Place[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  useEffect(() => {
    const q = text.trim();
    if (q.length < 2) {
      setPlaces([]);
      setStatus(null);
      return;
    }
    if (!inTauri) {
      setStatus("City search works in the Wallsong app.");
      return;
    }
    const id = setTimeout(() => {
      setStatus("Searching…");
      void call<Place[]>("weather_find", { city: q })
        .then((found) => {
          setPlaces(found);
          setStatus(found.length ? null : `No place called "${q}".`);
        })
        .catch((e) => setStatus(String(e)));
    }, CITY_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [text]);
  return (
    <div className="city">
      <div className="set-row">
        <span>City{dock.weatherCity ? `: ${dock.weatherCity}` : ""}</span>
        <input className="city-input" value={text} onChange={(e) => setText(e.target.value)} placeholder={dock.weatherCity ? "Change city…" : "Type your city…"} spellCheck={false} />
      </div>
      {places.length > 0 && (
        <div className="city-results">
          {places.map((p) => (
            <button
              key={`${p.latitude},${p.longitude}`}
              className="pop-item"
              onClick={() => {
                void saveSettings({ dock: { weatherCity: p.name, weatherLat: p.latitude, weatherLon: p.longitude } });
                setText("");
                setPlaces([]);
              }}
            >
              <span>{p.name}</span>
              <small>{p.region}</small>
            </button>
          ))}
        </div>
      )}
      {status && <p className="set-hint">{status}</p>}
    </div>
  );
}

interface DisplayInfo {
  key: string;
  label: string;
  width: number;
  height: number;
  primary: boolean;
}

const ROLES: Array<{ id: DisplayRole; label: string }> = [
  { id: "all", label: "Everything" },
  { id: "video", label: "Video only" },
  { id: "lyrics", label: "Lyrics and clock" },
  { id: "off", label: "Off" },
];

function Toggle({ label, value, onChange }: { label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="set-row">
      <span>{label}</span>
      <button className={`switch${value ? " on" : ""}`} role="switch" aria-checked={value} onClick={() => onChange(!value)}>
        <i />
      </button>
    </label>
  );
}

function Slider({ label, value, min, max, step, onChange, format }: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void; format?: (v: number) => string }) {
  const [local, setLocal] = useState(value);
  const timer = useRef<number | null>(null);
  const pending = useRef<{ v: number; fn: (v: number) => void } | null>(null);

  useEffect(() => {
    if (timer.current === null) setLocal(value);
  }, [value]);

  useEffect(() => {
    return () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
        if (pending.current) {
          pending.current.fn(pending.current.v);
          pending.current = null;
        }
      }
    };
  }, []);

  const handleChange = (v: number) => {
    setLocal(v);
    pending.current = { v, fn: onChange };
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      const p = pending.current;
      pending.current = null;
      p?.fn(p.v);
    }, 250);
  };

  return (
    <label className="set-row">
      <span>{label}</span>
      <span className="slider">
        <input type="range" min={min} max={max} step={step} value={local} onChange={(e) => handleChange(Number(e.target.value))} />
        <output>{format ? format(local) : local.toFixed(2)}</output>
      </span>
    </label>
  );
}

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<{ id: T; label: string }>; onChange: (v: T) => void }) {
  return (
    <div className="set-row">
      <span>{label}</span>
      <span className="segmented">
        {options.map((o) => (
          <button key={o.id} className={o.id === value ? "on" : ""} onClick={() => onChange(o.id)}>
            {o.label}
          </button>
        ))}
      </span>
    </div>
  );
}

function ColourRow({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="set-row">
      <span>{label}</span>
      <span className="colour">
        <input type="color" value={value.slice(0, 7)} onChange={(e) => onChange(e.target.value)} />
        <code>{value.slice(0, 7)}</code>
      </span>
    </label>
  );
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

/** The style gallery: the newest (Roll, Orbit, Tape, Cascade, Slam) first. */
const NEWEST = ["roll", "orbit", "tape", "cascade", "slam"];
const GALLERY = [...NEWEST.map((id) => LYRIC_STYLES.find((s) => s.id === id)!), ...LYRIC_STYLES.filter((s) => !NEWEST.includes(s.id))];

const isSection = (s: string | undefined): s is Section => SECTIONS.some((x) => x.id === s);

export function SettingsPanel({
  settings,
  section: initial,
  ws,
  c1,
  onEditDock,
}: {
  settings: Settings;
  section?: string;
  /** For the player card previews (they show the song playing). */
  ws: WsState | null;
  c1: string;
  onEditDock: () => void;
}) {
  const [section, setSection] = useState<Section>(isSection(initial) ? initial : "lyrics");
  // Opened again at a particular page (e.g. the weather tile's "Set your city").
  useEffect(() => {
    if (isSection(initial)) setSection(initial);
  }, [initial]);
  const [displays, setDisplays] = useState<DisplayInfo[]>([]);
  useEffect(() => {
    if (inTauri) void call<DisplayInfo[]>("displays").then(setDisplays).catch(() => {});
    else setDisplays([{ key: "demo-1", label: "Display 1 (1920×1080) · main", width: 1920, height: 1080, primary: true }]);
  }, []);

  const ly = settings.lyrics;
  const cl = settings.clock;
  const gl = settings.glow;

  const pickStyle = (style: LyricStyle) => {
    // The big-word styles look best with the compact clock: switch it the first time only, so it can be switched back.
    const bigWords = style === "roll" || style === "orbit" || style === "tape" || style === "cascade" || style === "slam";
    if (bigWords && !ly.rollClockApplied) void saveSettings({ lyrics: { style, rollClockApplied: true }, clock: { layout: "compact" } });
    else void saveSettings({ lyrics: { style } });
  };

  return (
    <div className="settings">
      <nav className="settings-nav">
        {SECTIONS.map((s) => (
          <button key={s.id} className={s.id === section ? "on" : ""} onClick={() => setSection(s.id)}>
            <Icon name={s.icon} size={16} />
            {s.label}
          </button>
        ))}
      </nav>
      <div className="settings-body">
        {section === "lyrics" && (
          <>
            <h3>Style</h3>
            <div className="style-grid">
              {GALLERY.map((s) => (
                <button key={s.id} className={`style-tile${ly.style === s.id ? " on" : ""}`} onClick={() => pickStyle(s.id)} title={s.hint}>
                  <span className={`tp tp-${s.id}`}>
                    <StylePreview id={s.id} />
                  </span>
                  <span className="style-name">{s.label}</span>
                </button>
              ))}
            </div>
            <h3>Font</h3>
            <div className="font-list">
              {LYRIC_FONTS.map((f) => (
                <button
                  key={f.id}
                  className={ly.font === f.id ? "on" : ""}
                  style={{ fontFamily: f.family, fontWeight: f.weight }}
                  onClick={() => void saveSettings({ lyrics: { font: f.id } })}
                >
                  {f.label}
                </button>
              ))}
            </div>
            <p className="set-hint">Stack, Stars and Icons use this font; the other styles have their own lettering.</p>
            <Slider label="Text size" value={ly.size} min={0.6} max={1.8} step={0.05} format={pct} onChange={(size) => void saveSettings({ lyrics: { size } })} />
            <Toggle label="Show lyrics" value={ly.visible} onChange={(visible) => void saveSettings({ lyrics: { visible } })} />
          </>
        )}

        {section === "clock" && (
          <>
            <Segmented
              label="Layout"
              value={cl.layout}
              options={[
                { id: "tall", label: "Tall" },
                { id: "compact", label: "Compact" },
              ]}
              onChange={(layout) => void saveSettings({ clock: { layout } })}
            />
            {cl.layout === "compact" && <p className="set-hint">Compact is small and light, in its own font. The fonts below are for Tall.</p>}
            <h3>Font</h3>
            <div className="font-list clock-fonts">
              {CLOCK_FONTS.map((f) => (
                <button key={f.id} className={cl.font === f.id ? "on" : ""} onClick={() => void saveSettings({ clock: { font: f.id } })}>
                  <span style={{ fontFamily: f.family, fontWeight: f.weight }} className="clock-sample">
                    9:41
                  </span>
                  <small>{f.label}</small>
                </button>
              ))}
            </div>
            <Slider label="Size" value={cl.size} min={0.5} max={1.4} step={0.05} format={pct} onChange={(size) => void saveSettings({ clock: { size } })} />
            <Segmented label="Hours" value={cl.hours} options={[{ id: "12", label: "12-hour" }, { id: "24", label: "24-hour" }]} onChange={(hours) => void saveSettings({ clock: { hours } })} />
            <Toggle label="Show the date" value={cl.showDate} onChange={(showDate) => void saveSettings({ clock: { showDate } })} />
            <Toggle label="Show the clock" value={cl.visible} onChange={(visible) => void saveSettings({ clock: { visible } })} />
          </>
        )}

        {section === "glow" && (
          <>
            <Segmented
              label="Style"
              value={gl.style}
              options={[
                { id: "flame", label: "Flame" },
                { id: "smooth", label: "Smooth" },
                { id: "chase", label: "Chase" },
              ]}
              onChange={(style) => void saveSettings({ glow: { style } })}
            />
            <p className="set-hint">{GLOW_STYLE_HINTS[gl.style]}</p>
            {gl.style === "chase" && (
              <Slider label="Lights" value={gl.comets} min={1} max={3} step={1} format={(v) => String(Math.round(v))} onChange={(comets) => void saveSettings({ glow: { comets } })} />
            )}
            <Slider label="Thickness" value={gl.thickness} min={0.3} max={2.5} step={0.05} format={pct} onChange={(thickness) => void saveSettings({ glow: { thickness } })} />
            <Slider label="Brightness" value={gl.intensity} min={0.2} max={1.6} step={0.05} format={pct} onChange={(intensity) => void saveSettings({ glow: { intensity } })} />
            <Slider label="Movement" value={gl.motion} min={0} max={2} step={0.05} format={pct} onChange={(motion) => void saveSettings({ glow: { motion } })} />
            <Toggle label="Sparks" value={gl.sparks} onChange={(sparks) => void saveSettings({ glow: { sparks } })} />
            <Toggle label="Show the glow" value={gl.visible} onChange={(visible) => void saveSettings({ glow: { visible } })} />
          </>
        )}

        {section === "colours" && (
          <>
            <h3>Lyrics</h3>
            <Segmented label="Colours" value={ly.colorMode} options={[{ id: "auto", label: "From the album" }, { id: "custom", label: "My own" }]} onChange={(colorMode) => void saveSettings({ lyrics: { colorMode } })} />
            {ly.colorMode === "custom" && (
              <>
                <ColourRow label="Lyric text" value={ly.text} onChange={(text) => void saveSettings({ lyrics: { text } })} />
                <ColourRow label="Highlight" value={ly.highlight} onChange={(highlight) => void saveSettings({ lyrics: { highlight } })} />
                <ColourRow label="Secondary text" value={ly.secondary} onChange={(secondary) => void saveSettings({ lyrics: { secondary } })} />
              </>
            )}
            <h3>Glow</h3>
            <Segmented label="Colours" value={gl.colors} options={[{ id: "album", label: "From the album" }, { id: "custom", label: "My own" }]} onChange={(colors) => void saveSettings({ glow: { colors } })} />
            {gl.colors === "custom" && (
              <>
                <ColourRow label="Primary" value={gl.primary} onChange={(primary) => void saveSettings({ glow: { primary } })} />
                <ColourRow label="Secondary" value={gl.secondary} onChange={(secondary) => void saveSettings({ glow: { secondary } })} />
              </>
            )}
            <button
              className="pill-btn"
              onClick={() =>
                void saveSettings({
                  lyrics: { colorMode: "auto", text: "#ffffff", highlight: "#ff9a3d", secondary: "#c9c9d6" },
                  glow: { colors: "album", primary: "#ff3d8b", secondary: "#ff9a3d" },
                })
              }
            >
              Reset colours
            </button>
          </>
        )}

        {section === "video" && (
          <>
            <Toggle label="Music videos on the wallpaper" value={settings.video.enabled} onChange={(enabled) => void saveSettings({ video: { enabled } })} />
            <Slider label="Darken the video" value={settings.video.dim} min={0} max={0.7} step={0.05} format={pct} onChange={(dim) => void saveSettings({ video: { dim } })} />
            <p className="set-hint">With videos off, Wallsong shows the album art behind the lyrics instead. The dots above the player bar switch between versions of the video.</p>
          </>
        )}

        {section === "displays" && (
          <>
            {displays.map((d) => (
              <div className="set-row" key={d.key}>
                <span>{d.label}</span>
                <select
                  value={settings.displays[d.key] ?? "all"}
                  onChange={(e) => void saveSettings({ displays: { ...settings.displays, [d.key]: e.target.value as DisplayRole } })}
                >
                  {ROLES.filter((r) => !(d.primary && r.id === "off")).map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </div>
            ))}
            {displays.length > 1 && (
              <div className="set-row">
                <span>Controls on</span>
                <select value={settings.controlsDisplay ?? displays.find((d) => d.primary)?.key ?? ""} onChange={(e) => void saveSettings({ controlsDisplay: e.target.value })}>
                  {displays.map((d) => (
                    <option key={d.key} value={d.key}>
                      {d.label}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <p className="set-hint">Other screens mirror the main one. Their video plays silently, kept in step with the main screen.</p>
          </>
        )}

        {section === "controls" && (
          <>
            <Segmented
              label="Bottom of the screen"
              value={settings.controls.bottom}
              options={[
                { id: "dock", label: "Dock" },
                { id: "bar", label: "Player bar" },
              ]}
              onChange={(bottom) => void saveSettings({ controls: { bottom } })}
            />
            <Segmented
              label="Desktop icons"
              value={settings.general.desktopIcons}
              options={[
                { id: "dock", label: "In the Dock" },
                { id: "desktop", label: "On the desktop" },
              ]}
              onChange={(desktopIcons) => void saveSettings({ general: { desktopIcons } })}
            />
            <p className="set-hint">
              In the Dock, your desktop icons are hidden from the desktop and open from the Dock's Desktop tile. With the player bar there's no Dock to hold them, so they stay on
              the desktop.
            </p>
            <Toggle label="Tilt the song list" value={settings.controls.tilt} onChange={(tilt) => void saveSettings({ controls: { tilt } })} />
          </>
        )}

        {section === "dock" && (
          <>
            <h3>Weather</h3>
            <CitySearch dock={settings.dock} />
            <Segmented
              label="Temperature"
              value={settings.dock.weatherUnit}
              options={[
                { id: "c", label: "°C" },
                { id: "f", label: "°F" },
              ]}
              onChange={(weatherUnit) => void saveSettings({ dock: { weatherUnit } })}
            />
            <h3>Clock</h3>
            <Segmented
              label="Clock style"
              value={settings.dock.clockStyle}
              options={[
                { id: "analog", label: "Analog" },
                { id: "digital", label: "Digital" },
              ]}
              onChange={(clockStyle) => void saveSettings({ dock: { clockStyle } })}
            />
            <h3>Tiles</h3>
            <div className="set-buttons">
              <button className="pill-btn" onClick={onEditDock}>
                Edit Dock
              </button>
              <button className="pill-btn" onClick={() => resetDock(settings)}>
                Reset Dock
              </button>
            </div>
            <p className="set-hint">Edit Dock: remove tiles with −, add them with +, drag to reorder. Reset puts every tile back in its first order; your pins stay. Right-click the Dock for these too.</p>
          </>
        )}

        {section === "card" && (
          <>
            <h3>Layout</h3>
            <div className="card-grid">
              {CARD_LAYOUTS.map((l) => (
                // A div, not a button: the preview inside is the real card, buttons and all.
                <div
                  key={l.id}
                  role="button"
                  tabIndex={0}
                  aria-pressed={settings.card.layout === l.id}
                  className={`card-tile${settings.card.layout === l.id ? " on" : ""}`}
                  onClick={() => void saveSettings({ card: { layout: l.id } })}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") void saveSettings({ card: { layout: l.id } });
                  }}
                >
                  <CardPreview layout={l.id} ws={ws} settings={settings} c1={c1} />
                  <span className="style-name">{l.label}</span>
                </div>
              ))}
            </div>
            <Toggle label="Tilt the card" value={settings.card.tilt} onChange={(tilt) => void saveSettings({ card: { tilt } })} />
            <Toggle label="Keep above all windows" value={settings.card.onTop} onChange={(onTop) => void saveSettings({ card: { onTop } })} />
            <Toggle label="Lyrics in the card" value={settings.card.lyrics} onChange={(lyrics) => void saveSettings({ card: { lyrics } })} />
            <p className="set-hint">Click the song in the Dock to open the card. Right-click it (or its ··· button) for the player menu.</p>
          </>
        )}

        {section === "general" && (
          <>
            <Toggle label="Keep the screen awake while music plays" value={settings.keepAwake} onChange={(keepAwake) => void saveSettings({ keepAwake })} />
            {/* Back where v0.4 had them; Controls shows the same two settings. */}
            <Toggle label="Tilt the song list" value={settings.controls.tilt} onChange={(tilt) => void saveSettings({ controls: { tilt } })} />
            <Segmented
              label="Desktop icons"
              value={settings.general.desktopIcons}
              options={[
                { id: "dock", label: "In the Dock" },
                { id: "desktop", label: "On the desktop" },
              ]}
              onChange={(desktopIcons) => void saveSettings({ general: { desktopIcons } })}
            />
            <p className="set-hint">Ctrl+Alt+Space opens search from anywhere. Quit from the Wallsong icon by the clock.</p>
            <p className="set-hint">Wallsong 0.5.2</p>
          </>
        )}
      </div>
    </div>
  );
}

/** Tiny static sample of each lyric style for the gallery. */
function StylePreview({ id }: { id: string }) {
  switch (id) {
    case "roll":
      return (
        <>
          <b className="rp">your</b>
          <b className="rc">words</b>
          <b className="rn">roll</b>
        </>
      );
    case "orbit":
      return (
        <span className="orb">
          <b className="o1">So</b>
          <b className="o2">call</b>
          <b className="o3">out</b>
        </span>
      );
    case "tape":
      return (
        <>
          <b className="s">see the</b>
          <b className="x">road</b>
        </>
      );
    case "cascade":
      return (
        <>
          <b className="o2">runnin'</b>
          <b className="o1 box">summer,</b>
          <b className="n">brand-new</b>
        </>
      );
    case "slam":
      return <b>So</b>;
    case "drop":
      return (
        <>
          <b>your</b>
          <b>words</b>
          <b>fall</b>
        </>
      );
    case "stars":
      return (
        <svg viewBox="0 0 100 56">
          <polyline points="14,40 38,18 62,34 86,14" />
          {[
            [14, 40],
            [38, 18],
            [62, 34],
            [86, 14],
          ].map(([x, y]) => (
            <circle key={x} cx={x} cy={y} r="2.4" />
          ))}
          <circle cx="86" cy="14" r="7" className="ring" />
        </svg>
      );
    case "chat":
      return (
        <>
          <i className="b1">your words</i>
          <i className="b2">land here</i>
        </>
      );
    case "icons":
      return (
        <>
          <b>night 🌙</b>
          <b className="u">ride 🚗</b>
        </>
      );
    case "lens":
      return (
        <b>
          {"words".split("").map((c, i) => (
            <span key={i} style={{ transform: `scale(${[1, 1.35, 1.6, 1.35, 1][i]})` }}>
              {c}
            </span>
          ))}
        </b>
      );
    default:
      return <b>{id === "sweep" ? "WORDS" : id === "stretch" ? "HERE" : id === "tube" ? "BEAT" : id === "scrawl" ? "your words" : "your words land"}</b>;
  }
}
