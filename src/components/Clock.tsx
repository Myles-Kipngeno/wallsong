import { useEffect, useState } from "react";

/** The giant condensed clock with a small date line above it. */
export function Clock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const hours = now.getHours() % 12 || 12;
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const date = now.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });

  return (
    <div className="clock" aria-label={`${hours}:${minutes}`}>
      <span className="clock-date">{date}</span>
      <span className="clock-time">
        {hours}:{minutes}
      </span>
    </div>
  );
}
