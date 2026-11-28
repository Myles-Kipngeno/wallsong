import { memo } from "react";
import type { Settings } from "../../lib/settings";
import type { WeatherNow } from "../../lib/types";
import { useWeather } from "./hooks";

/** Wallsong's own weather pictures, drawn from circles and lines. */
export function WeatherGlyph({ glyph }: { glyph: WeatherNow["glyph"] }) {
  const cloud = (fill: string) => (
    <g fill={fill}>
      <circle cx="8" cy="12" r="3.5" />
      <circle cx="12.5" cy="9.5" r="4.5" />
      <circle cx="16.5" cy="12.5" r="3" />
      <rect x="8" y="12" width="8.5" height="3.5" />
    </g>
  );
  switch (glyph) {
    case "sun":
      return (
        <svg className="wx-glyph" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="4.6" fill="#ffc94a" />
          <g stroke="#ffc94a" strokeWidth="1.8" strokeLinecap="round">
            {Array.from({ length: 8 }, (_, i) => (
              <line key={i} x1="12" y1="2.4" x2="12" y2="4.8" transform={`rotate(${i * 45} 12 12)`} />
            ))}
          </g>
        </svg>
      );
    case "moon":
      return (
        <svg className="wx-glyph" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M14.5 3.2a8.8 8.8 0 1 0 6.3 12.3A7.3 7.3 0 0 1 14.5 3.2z" fill="#f3e7b0" />
        </svg>
      );
    case "rain":
      return (
        <svg className="wx-glyph" viewBox="0 0 24 24" aria-hidden="true">
          {cloud("#dfe5ef")}
          <g stroke="#6cb6ff" strokeWidth="1.6" strokeLinecap="round">
            <line x1="9" y1="18" x2="8" y2="21" />
            <line x1="12.6" y1="18" x2="11.6" y2="21" />
            <line x1="16.2" y1="18" x2="15.2" y2="21" />
          </g>
        </svg>
      );
    case "storm":
      return (
        <svg className="wx-glyph" viewBox="0 0 24 24" aria-hidden="true">
          {cloud("#aab2c0")}
          <path d="M13.4 15.8 10.2 20.4h2.4l-1.2 3.2 4-4.9h-2.4l1.3-2.9z" fill="#ffd24a" />
        </svg>
      );
    case "snow":
      return (
        <svg className="wx-glyph" viewBox="0 0 24 24" aria-hidden="true">
          {cloud("#dfe5ef")}
          <g fill="#ffffff">
            <circle cx="8.8" cy="19" r="1.1" />
            <circle cx="12.6" cy="20.4" r="1.1" />
            <circle cx="16.4" cy="19" r="1.1" />
            <circle cx="10.7" cy="22.4" r="1.1" />
            <circle cx="14.5" cy="22.4" r="1.1" />
          </g>
        </svg>
      );
    case "fog":
      return (
        <svg className="wx-glyph" viewBox="0 0 24 24" aria-hidden="true">
          <g stroke="#cfd6e2" strokeWidth="2" strokeLinecap="round">
            <line x1="4" y1="8" x2="18" y2="8" />
            <line x1="6" y1="12" x2="20" y2="12" />
            <line x1="4" y1="16" x2="17" y2="16" />
          </g>
        </svg>
      );
    default:
      return (
        <svg className="wx-glyph" viewBox="0 0 24 24" aria-hidden="true">
          <g transform="translate(0 2)">{cloud("#e8ecf4")}</g>
        </svg>
      );
  }
}

const degrees = (celsius: number, unit: "c" | "f") => Math.round(unit === "f" ? (celsius * 9) / 5 + 32 : celsius);

/** City, temperature, today's high and low, and a picture. "Set your city" until there is one. */
export const WeatherTile = memo(function WeatherTile({ dock }: { dock: Settings["dock"] }) {
  const weather = useWeather(dock.weatherLat, dock.weatherLon);
  if (dock.weatherLat === null || dock.weatherLon === null) {
    return (
      <div className="dk-wx unset">
        <WeatherGlyph glyph="sun" />
        <span>Set your city</span>
      </div>
    );
  }
  const unit = dock.weatherUnit;
  return (
    <div className="dk-wx" title={weather ? `${dock.weatherCity}: ${degrees(weather.temperature, unit)}°` : `${dock.weatherCity}: loading the weather`}>
      <div className="dk-wx-text">
        <span className="dk-wx-city">{dock.weatherCity}</span>
        <span className="dk-wx-temp">{weather ? `${degrees(weather.temperature, unit)}°` : "--"}</span>
        <span className="dk-wx-range">{weather ? `H ${degrees(weather.high, unit)}°  L ${degrees(weather.low, unit)}°` : " "}</span>
      </div>
      {weather && <WeatherGlyph glyph={weather.glyph} />}
    </div>
  );
});
