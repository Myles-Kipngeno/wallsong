import { useEffect, useRef, useState } from "react";
import { CLOCK_FONTS, fontById } from "../lib/fonts";
import type { Settings } from "../lib/settings";
import { beat } from "../lib/beat";
import { subscribeFrame } from "../lib/frame";

/**
 * The clock, with a small date line above it. Two layouts:
 * - tall: tall, narrow digits in the album colour, in the chosen clock font;
 * - compact: small, light white digits (Inter 300), the look that goes with Roll.
 */
export function Clock({ settings }: { settings: Settings["clock"] }) {
  const [now, setNow] = useState(() => new Date());
  const clockRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    // Only Tall clock uses --level for text-shadow glow; Compact skips the subscription.
    if (settings.layout === "compact") return;
    let last = "";
    return subscribeFrame(() => {
      const el = clockRef.current;
      if (!el) return;
      const val = beat.level.toFixed(2);
      if (val !== last) {
        last = val;
        el.style.setProperty("--level", val);
      }
    }, 15);
  }, [settings.layout]);

  const hours = settings.hours === "24" ? String(now.getHours()).padStart(2, "0") : String(now.getHours() % 12 || 12);
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const date = now.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const font = fontById(CLOCK_FONTS, settings.font);
  const style = {
    "--clock-font": font.family,
    "--clock-weight": font.weight,
    "--clock-size": settings.size,
  } as React.CSSProperties;

  return (
    <div ref={clockRef} className={settings.layout === "compact" ? "clock clock-compact" : `clock clock-${font.id}`} style={style} aria-label={`${hours}:${minutes}`}>
      {settings.showDate && <span className="clock-date">{date}</span>}
      <span className="clock-time">
        {hours}
        <span className="clock-colon">:</span>
        {minutes}
      </span>
    </div>
  );
}
