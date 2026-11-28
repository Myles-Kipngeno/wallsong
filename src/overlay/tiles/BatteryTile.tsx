import { memo } from "react";
import type { BatteryInfo } from "../../lib/types";

/** "2 h 10 min", "2 h", "45 min". */
export function formatLeft(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

type Power = "charging" | "full" | "battery";

/** What the tile shows: charging, plugged in and full, or running on the battery. */
export function powerOf(b: BatteryInfo): Power {
  if (b.charging) return "charging";
  return b.pluggedIn ? "full" : "battery";
}

export function batteryTitle(b: BatteryInfo): string {
  if (b.charging || b.pluggedIn) {
    return b.percent === 100 ? "Plugged in · fully charged" : `Charging · ${b.percent}%`;
  }
  return `On battery · ${b.percent}%${b.minutesLeft ? ` · about ${formatLeft(b.minutesLeft)} left` : ""}`;
}

const R = 40;
const CIRCUMFERENCE = 2 * Math.PI * R;

/**
 * A ring showing how full the battery is.
 * When plugged in (charging or plugged in): a plain lightning bolt next to the percent.
 * Color: white on dark (#ffffff), green tint (#4cd964) only when fully charged (100%).
 * On battery: ring colors (good, low, critical), blink < 10%.
 */
export const BatteryTile = memo(function BatteryTile({ battery }: { battery: BatteryInfo }) {
  const { percent } = battery;
  const plugged = battery.charging || battery.pluggedIn;
  const full = percent === 100;
  const level = plugged ? (full ? "good" : "plugged") : percent > 40 ? "good" : percent >= 20 ? "low" : "critical";
  const lit = full ? 100 : Math.max(0, Math.min(100, percent));
  const motion = !plugged && percent < 10 ? " blink" : "";

  return (
    <div className={`dk-bat ${level}`} title={batteryTitle(battery)}>
      <svg viewBox="0 0 100 100" aria-hidden="true">
        <circle cx="50" cy="50" r={R} className="track" />
      </svg>
      <svg viewBox="0 0 100 100" aria-hidden="true" className={`lit${motion}`}>
        <circle cx="50" cy="50" r={R} className="fill" strokeDasharray={`${(CIRCUMFERENCE * lit) / 100} ${CIRCUMFERENCE}`} transform="rotate(-90 50 50)" />
      </svg>
      <span className="dk-bat-text">
        {plugged && (
          <svg className="glyph bolt" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M13.5 2 5 13.5h5.5L9 22l9-12h-5.6z" />
          </svg>
        )}
        {percent}
      </span>
    </div>
  );
});
