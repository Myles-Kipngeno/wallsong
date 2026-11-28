import type { LyricLine } from "./types";

/** One word of a lyric line with the moment it's sung (estimated). */
export interface TimedWord {
  text: string;
  startMs: number;
}

export interface TimedLine extends LyricLine {
  endMs: number;
  words: TimedWord[];
}

/** Rough syllable count: groups of vowels, at least one per word. */
export function syllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-zÀ-ɏ]/g, "");
  if (!w) return 1;
  const groups = w.replace(/e$/, "").match(/[aeiouyà-ÿ]+/g);
  return Math.max(1, groups?.length ?? 1);
}

/** How long one syllable usually takes when sung (ms). Rap is faster, ballads slower. */
const SYLLABLE_MS = 230;
/** A line is never stretched over more than this, so a long instrumental gap doesn't slow the words down. */
const MAX_LINE_MS = 6500;

/**
 * LRCLIB gives a time per line only. Words are spread over the line by syllable
 * count, at a natural singing pace, finishing before the next line starts.
 */
export function timeWords(lines: LyricLine[]): TimedLine[] {
  return lines.map((line, i) => {
    const next = lines[i + 1]?.timeMs ?? line.timeMs + MAX_LINE_MS;
    const gap = Math.max(300, next - line.timeMs);
    const words = line.text.split(/\s+/).filter(Boolean);
    const weights = words.map(syllables);
    const total = weights.reduce((a, b) => a + b, 0) || 1;
    // Sung length: natural pace, but squeezed to 92% of the gap when lines come quickly.
    const span = Math.min(gap * 0.92, Math.max(total * SYLLABLE_MS, gap * 0.55), MAX_LINE_MS);
    let acc = 0;
    const timed = words.map((text, w) => {
      const startMs = line.timeMs + (acc / total) * span;
      acc += weights[w];
      return { text, startMs: Math.round(startMs) };
    });
    return { ...line, endMs: Math.round(line.timeMs + span), words: timed };
  });
}

/** How many words of a line have been sung at time t. */
export function wordsSung(line: TimedLine, t: number): number {
  let n = 0;
  for (const w of line.words) {
    if (w.startMs <= t) n++;
    else break;
  }
  return n;
}
