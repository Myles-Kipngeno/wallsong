import { memo } from "react";
import { useNow } from "./hooks";

/** Today: weekday in red, the day big, the month below. */
export const CalendarTile = memo(function CalendarTile() {
  const now = useNow(60_000);
  return (
    <div className="dk-cal" title={now.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" })}>
      <span className="dk-cal-day">{now.toLocaleDateString(undefined, { weekday: "short" })}</span>
      <span className="dk-cal-num">{now.getDate()}</span>
      <span className="dk-cal-month">{now.toLocaleDateString(undefined, { month: "short" })}</span>
    </div>
  );
});
