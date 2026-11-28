import type { TimedLine } from "../lib/wordTiming";

/** Same look for the same word every time. */
export function seeded(seed: number) {
  let a = seed + 0x6d2b79f5;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The word as shown: without the brackets, quotes and punctuation around it. */
export const shown = (w: string) => w.replace(/^[([\"“‘]+/, "").replace(/[)\]\"”.,!?;:…]+$/, "") || w;

const SMALL = new Set(
  "a an the and or but nor to of in on at for with by from up as if so is am are was were be been it its it's that this these those i i'm im me my you your you're we our us he she his her they them their oh ooh yeah yea uh ah na da la just no not do don't can can't will i'll got get".split(" "),
);
export const isSmall = (w: string) => SMALL.has(shown(w).toLowerCase().replace(/’/g, "'"));

/** Estimated width in ems so oversized words scale to fit without clipping. */
export function wordWidthEm(text: string, extra = 0): number {
  let w = extra;
  for (const ch of text) {
    if ("iltfrjI'|!.,:;/ ".includes(ch)) w += 0.44;
    else if ("mwMW".includes(ch)) w += 1.06;
    else if (ch >= "A" && ch <= "Z") w += 0.84;
    else w += 0.68;
  }
  return Math.max(0.8, w);
}

/** Every word of the song in order, plus where each line starts. */
export function flatten(lines: TimedLine[]) {
  const words: Array<{ text: string; line: number }> = [];
  const start: number[] = [];
  lines.forEach((l, li) => {
    start.push(words.length);
    for (const w of l.words) words.push({ text: w.text, line: li });
  });
  return { words, start };
}

/** Global index of the word being sung (the last word of an earlier line before the first word lands). */
export const currentWord = (start: number[], index: number, sung: number) => (index >= 0 ? start[index] + sung - 1 : -1);

/** Splits n words into balanced groups of at most `max` (10 words -> 4, 3, 3). */
export function groupSizes(n: number, max = 4): number[] {
  if (n <= 0) return [];
  const k = Math.ceil(n / max);
  const base = Math.floor(n / k);
  const extra = n % k;
  return Array.from({ length: k }, (_, i) => base + (i < extra ? 1 : 0));
}

/** Which group word `w` falls in, and where that group starts. */
export function locate(sizes: number[], w: number): { group: number; from: number } {
  let from = 0;
  for (let g = 0; g < sizes.length; g++) {
    if (w < from + sizes[g]) return { group: g, from };
    from += sizes[g];
  }
  return { group: sizes.length - 1, from: from - (sizes[sizes.length - 1] ?? 0) };
}

/** Picks the hero word index: prefers non-filler words, breaking ties by last longest word. */
export function pickHero(words: string[]): number {
  let hero = -1;
  words.forEach((w, i) => {
    const len = [...shown(w)].length;
    const heroLen = hero >= 0 ? [...shown(words[hero])].length : 0;
    const better = hero < 0 || (!isSmall(w) && isSmall(words[hero])) || (isSmall(w) === isSmall(words[hero]) && len >= heroLen);
    if (better) hero = i;
  });
  return hero;
}
