import { memo } from "react";
import type { Settings } from "../../lib/settings";
import { useNow } from "./hooks";

/**
 * Clock tile. Analog: white hour and minute hands, a thin second hand in the
 * album colour, 12 ticks. Digital: "10 45" on two flip cards with AM/PM.
 * Right-click switches between them (handled by the Dock).
 */
export const ClockTile = memo(function ClockTile({ style, hours }: { style: Settings["dock"]["clockStyle"]; hours: Settings["clock"]["hours"] }) {
  const now = useNow(1000);
  const h = now.getHours();
  const m = now.getMinutes();
  const s = now.getSeconds();
  const label = now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

  if (style === "digital") {
    const hh = hours === "24" ? String(h).padStart(2, "0") : String(h % 12 || 12);
    const mm = String(m).padStart(2, "0");
    return (
      <div className="dk-clock-digital" aria-label={label}>
        <span className="flip" key={`h${hh}`}>
          {hh}
        </span>
        <span className="flip" key={`m${mm}`}>
          {mm}
        </span>
        {hours === "12" && <small>{h < 12 ? "AM" : "PM"}</small>}
      </div>
    );
  }

  const hourAngle = (h % 12) * 30 + m * 0.5;
  const minuteAngle = m * 6 + s * 0.1;
  const secondAngle = s * 6;
  return (
    <svg className="dk-clock-face" viewBox="0 0 100 100" role="img" aria-label={label}>
      <circle cx="50" cy="50" r="48" className="dial" />
      {Array.from({ length: 12 }, (_, i) => (
        <line key={i} x1="50" y1={i % 3 === 0 ? 7 : 9} x2="50" y2="14" className={i % 3 === 0 ? "tick major" : "tick"} transform={`rotate(${i * 30} 50 50)`} />
      ))}
      <line x1="50" y1="50" x2="50" y2="27" className="hand hour" transform={`rotate(${hourAngle} 50 50)`} />
      <line x1="50" y1="50" x2="50" y2="15" className="hand minute" transform={`rotate(${minuteAngle} 50 50)`} />
      <line x1="50" y1="58" x2="50" y2="11" className="hand second" transform={`rotate(${secondAngle} 50 50)`} />
      <circle cx="50" cy="50" r="3.2" className="pin" />
    </svg>
  );
});
