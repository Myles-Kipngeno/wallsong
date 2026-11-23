import type { LyricLine } from "./types";

const STAMP = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;

/** Parses LRC text ("[01:02.34]words") into lines sorted by time. */
export function parseLrc(lrc: string): LyricLine[] {
  const lines: LyricLine[] = [];
  let offsetMs = 0;

  for (const raw of lrc.split(/\r?\n/)) {
    const offset = raw.match(/^\[offset:\s*([+-]?\d+)\]/i);
    if (offset) {
      offsetMs = Number(offset[1]);
      continue;
    }
    const stamps = [...raw.matchAll(STAMP)];
    if (stamps.length === 0) continue;
    const text = raw.replace(STAMP, "").trim();
    // One line can carry several stamps when a chorus repeats.
    for (const m of stamps) {
      const fraction = m[3] ? Number(m[3].padEnd(3, "0")) : 0;
      const timeMs = Number(m[1]) * 60_000 + Number(m[2]) * 1000 + fraction - offsetMs;
      lines.push({ timeMs: Math.max(0, timeMs), text });
    }
  }
  return lines.sort((a, b) => a.timeMs - b.timeMs);
}

/** Index of the line being sung at `timeMs`, or -1 before the first line. */
export function currentLineIndex(lines: LyricLine[], timeMs: number): number {
  let lo = 0;
  let hi = lines.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].timeMs <= timeMs) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}
