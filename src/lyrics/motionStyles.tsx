import { useLayoutEffect, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import type { TimedLine } from "../lib/wordTiming";
import type { StyleProps } from "./LyricsStage";
import { emojiFor } from "./emoji";
import { currentWord, flatten, groupSizes, isSmall, locate, pickHero, seeded, shown, wordWidthEm } from "./lyricHelpers";
import "./motionStyles.css";

/**
 * Three lyric styles modelled on reference clips of animated lyric wallpapers:
 *
 *  - Tape:    words of a phrase build a centred stack of mixed sizes (one huge
 *             hero word, medium content words, small connectors). Hero words
 *             sometimes sit on a tilted strip of tape, small words in a pill.
 *  - Cascade: sung words pop in at the bottom of a staggered column and push
 *             the older ones up, shrinking and fading. Repeated lines (the
 *             chorus) turn into tilted ALL-CAPS poster blocks with echo trails.
 *  - Slam:    one giant word fills the screen, each in its own colour, with a
 *             glow behind it and a different punchy entrance every time.
 *
 * Like every style they only re-render when the line or the sung word changes;
 * all motion is CSS (transform / opacity), so nothing runs per frame.
 */

// ---------- shared helpers ----------

/** The visible group: the one holding the sung word, or (before a line's first word) the last non-empty group before it. */
function focusGroup(lines: TimedLine[], groups: number[][], index: number, sung: number) {
  if (index < 0) return null;
  if (sung > 0) {
    const { group, from } = locate(groups[index], sung - 1);
    return { line: index, group, from, count: sung - from };
  }
  for (let li = index - 1; li >= 0; li--) {
    if (!groups[li]?.length) continue;
    const group = groups[li].length - 1;
    const size = groups[li][group];
    return { line: li, group, from: lines[li].words.length - size, count: size };
  }
  return null;
}

/** The group shown just before (line, group), skipping empty break lines. */
function groupBefore(lines: TimedLine[], groups: number[][], line: number, group: number) {
  if (group > 0) {
    const from = groups[line].slice(0, group - 1).reduce((a, b) => a + b, 0);
    return { line, group: group - 1, from, count: groups[line][group - 1] };
  }
  for (let li = line - 1; li >= 0; li--) {
    if (!groups[li]?.length) continue;
    const g = groups[li].length - 1;
    return { line: li, group: g, from: lines[li].words.length - groups[li][g], count: groups[li][g] };
  }
  return null;
}

/**
 * A centred block that grows as words are added would jump up by half a row
 * each time. This slides it there instead: when the block gets taller, the
 * inner wrapper starts where it was and eases to its new centre.
 */
function useSmoothGrow<T extends HTMLElement>(dep: unknown) {
  const ref = useRef<T>(null);
  const last = useRef(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = el.offsetHeight;
    const dh = h - last.current;
    const reduced = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!reduced && last.current > 0 && dh > 1 && typeof el.animate === "function") {
      el.animate([{ transform: `translateY(${dh / 2}px)` }, { transform: "translateY(0)" }], {
        duration: 240,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
      });
    }
    last.current = h;
  }, [dep]);
  return ref;
}

// ---------- Tape ----------

type TapeSize = "sm" | "md" | "xl";
type TapeColour = "red" | "gold" | "cream";

interface TapeWord {
  text: string;
  size: TapeSize;
  colour: TapeColour;
  tape: boolean;
  pill: boolean;
  tilt: number;
}

/** Sizes, colours and decorations for one group: the same every time it's shown. */
function tapeLook(words: string[], seed: number): TapeWord[] {
  const r = seeded(seed);
  const hero = pickHero(words);
  const taped = r() < 0.45;
  let pillDone = false;
  return words.map((w, i) => {
    const isHero = i === hero || words.length === 1;
    const small = !isHero && isSmall(w);
    const pick = r();
    const colour: TapeColour = isHero ? "red" : small ? (pick < 0.6 ? "cream" : "gold") : pick < 0.45 ? "gold" : pick < 0.7 ? "cream" : "red";
    const pill = small && !pillDone && i < words.length - 1 && r() < 0.3;
    if (pill) pillDone = true;
    return {
      text: shown(w),
      size: isHero ? "xl" : small ? "sm" : "md",
      colour,
      tape: isHero && taped && words.length > 1,
      pill,
      tilt: -3 - r() * 4,
    };
  });
}

function TapeGroup({ words, count, seed, out }: { words: string[]; count: number; seed: number; out: boolean }) {
  const look = useMemo(() => tapeLook(words, seed), [words, seed]);
  const inner = useSmoothGrow<HTMLDivElement>(count);
  // Rows: one word each, except a pill word, which shares a row with the word after it.
  const rows: number[][] = [];
  for (let i = 0; i < look.length; i++) {
    if (look[i].pill && i + 1 < look.length) {
      rows.push([i, i + 1]);
      i++;
    } else rows.push([i]);
  }
  const active = out ? -1 : count - 1;
  return (
    <div className={`tape-group${out ? " out" : " cur"}`}>
      <div className="tape-inner" ref={inner}>
        {rows.map((row) => {
          const visible = row.filter((i) => i < count);
          if (!visible.length) return null;
          return (
            <div className="tape-row" key={row[0]}>
              {visible.map((i) => {
                const w = look[i];
                const cls = `tape-w ${w.size} ${w.colour}${w.tape ? " taped" : ""}${w.pill ? " pill" : ""}${i === active ? " on" : ""}`;
                const extra = (w.pill ? 0.55 : 0) + (w.tape ? 0.35 : 0);
                return (
                  <span key={i} className={cls} style={{ "--w": wordWidthEm(w.text, extra).toFixed(2), "--tilt": `${w.tilt}deg` } as CSSProperties}>
                    {w.text}
                  </span>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function Tape({ lines, index, sung }: StyleProps) {
  const groups = useMemo(() => lines.map((l) => groupSizes(l.words.length)), [lines]);
  const focus = focusGroup(lines, groups, index, sung);
  const before = focus ? groupBefore(lines, groups, focus.line, focus.group) : null;
  const wordsOf = (g: { line: number; from: number; count: number }, size: number) =>
    lines[g.line].words.slice(g.from, g.from + size).map((w) => w.text);
  const items: ReactNode[] = [];
  // The group before stays mounted under the same key it had while current, so
  // it just switches to its exit animation (blur and fade out).
  if (before) {
    items.push(
      <TapeGroup key={`${before.line}-${before.group}`} words={wordsOf(before, before.count)} count={before.count} seed={before.line * 131 + before.group * 17} out />,
    );
  }
  if (focus) {
    const size = groups[focus.line][focus.group];
    items.push(
      <TapeGroup key={`${focus.line}-${focus.group}`} words={wordsOf(focus, size)} count={focus.count} seed={focus.line * 131 + focus.group * 17} out={false} />,
    );
  }
  return <section className="ly ly-tape">{items}</section>;
}

// ---------- Cascade ----------

/** How many words the column holds; the next one pushes the oldest off the top. */
const CASCADE_ROWS = 5;
const CASCADE_OPACITY = [1, 0.8, 0.64, 0.5, 0.36, 0];

/** Lines that come back (the chorus): those become poster blocks. */
function repeatedLines(lines: TimedLine[]): Set<number> {
  const norm = (t: string) => t.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, "").replace(/\s+/g, " ").trim();
  const counts = new Map<string, number>();
  for (const l of lines) {
    const k = norm(l.text);
    if (k) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const out = new Set<number>();
  lines.forEach((l, i) => {
    const k = norm(l.text);
    if (k && (counts.get(k) ?? 0) >= 2 && l.words.length >= 2) out.add(i);
  });
  return out;
}

function CascadeColumn({ words, cur, floor }: { words: Array<{ text: string }>; cur: number; floor: number }) {
  const items: ReactNode[] = [];
  for (let k = 0; k <= CASCADE_ROWS; k++) {
    const i = cur - k;
    if (i < floor) break;
    const r = seeded(i * 7349 + 11);
    const text = shown(words[i].text);
    const len = [...text].length;
    const box = r() < 0.22 ? (r() < 0.5 ? " box-a" : " box-b") : "";
    const emoji = emojiFor(text);
    const style = {
      "--k": k,
      "--x": `${(r() * 9).toFixed(2)}vw`,
      "--r": `${((r() - 0.5) * 6).toFixed(2)}deg`,
      "--sc": k === 0 ? 1 : 0.85,
      "--op": CASCADE_OPACITY[k],
      "--fs": isSmall(text) ? 0.78 : len >= 7 ? 1.18 : 1,
      "--w": wordWidthEm(text, (box ? 0.5 : 0) + (emoji ? 1.2 : 0)).toFixed(2),
    } as CSSProperties;
    items.push(
      <span key={i} className={`cas-w${k === 0 ? " new" : ""}${box}`} style={style}>
        <span className="cas-t">{text}</span>
        {emoji && <em className="cas-emoji">{emoji}</em>}
      </span>,
    );
  }
  return <div className="cas-col">{items}</div>;
}

function Poster({ words, count, seed }: { words: string[]; count: number; seed: number }) {
  const inner = useSmoothGrow<HTMLDivElement>(count);
  const r = seeded(seed);
  const tilt = -6 - r() * 5;
  const hero = pickHero(words);
  return (
    <div className="poster" style={{ "--tilt": `${tilt.toFixed(2)}deg` } as CSSProperties}>
      <div className="poster-inner" ref={inner}>
        {words.slice(0, count).map((w, i) => {
          const text = shown(w).toUpperCase();
          const len = [...text].length;
          const small = i !== hero && isSmall(w);
          const echo = i === hero && !small && len >= 3;
          const cls = `pw${small ? " sm" : ""}${i === hero ? " hero" : ""}${i === count - 1 ? " on" : ""}`;
          return (
            <span key={i} className={cls} style={{ "--w": wordWidthEm(text, 0.2).toFixed(2) } as CSSProperties}>
              {echo &&
                [4, 3, 2, 1].map((e) => (
                  <span key={e} className="pw-echo" aria-hidden="true" style={{ "--e": e } as CSSProperties}>
                    {text}
                  </span>
                ))}
              {text}
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function Cascade({ lines, index, sung }: StyleProps) {
  const flat = useMemo(() => flatten(lines), [lines]);
  const chorus = useMemo(() => repeatedLines(lines), [lines]);
  const groups = useMemo(() => lines.map((l) => groupSizes(l.words.length)), [lines]);
  const cur = currentWord(flat.start, index, sung);
  if (cur < 0) return <section className="ly ly-cascade" />;
  // The line of the word on screen (the line before, until this line's first word lands).
  const line = flat.words[cur].line;

  if (chorus.has(line)) {
    const w = cur - flat.start[line];
    const { group, from } = locate(groups[line], w);
    const size = groups[line][group];
    const words = lines[line].words.slice(from, from + size).map((x) => x.text);
    return (
      <section className="ly ly-cascade">
        <Poster key={`${line}-${group}`} words={words} count={w - from + 1} seed={line * 61 + group} />
      </section>
    );
  }

  // Coming out of a chorus, the column starts fresh rather than replaying its words.
  let floor = 0;
  for (let li = line - 1; li >= Math.max(0, line - 8); li--) {
    if (chorus.has(li)) {
      floor = flat.start[li + 1];
      break;
    }
  }
  return (
    <section className="ly ly-cascade">
      <CascadeColumn words={flat.words} cur={cur} floor={floor} />
    </section>
  );
}

// ---------- Slam ----------

const SLAM_COLOURS = ["#f27d72", "#e62b1a", "#f5f3ec", "#38bdf8", "#facc15"];
/** Curated high-contrast [text, box] pairs for occasional highlight boxes. */
const SLAM_BOXES: Array<[string, string]> = [
  ["#38bdf8", "#e62b1a"],
  ["#0d0d12", "#facc15"],
  ["#38bdf8", "#f27d72"],
  ["#facc15", "#e62b1a"],
  ["#0d0d12", "#f5f3ec"],
];
type SlamEntry = "punch" | "grow" | "streak" | "tumble";

interface SlamLook {
  colour: string;
  box: string | null;
  glow: string;
  swoosh: boolean;
  entry: SlamEntry;
}

function buildSlamLooks(words: Array<{ text: string }>): SlamLook[] {
  let prevIdx = -1;
  return words.map((w, i) => {
    const r = seeded(i * 7919 + 13);
    const text = shown(w.text);
    const len = [...text].length;
    // Never the same primary colour twice in a row.
    let c = Math.floor(r() * SLAM_COLOURS.length);
    if (c === prevIdx) c = (c + 1 + Math.floor(r() * (SLAM_COLOURS.length - 1))) % SLAM_COLOURS.length;
    prevIdx = c;
    const e = r();
    const entry: SlamEntry = len >= 2 && len <= 9 && e < 0.25 ? "tumble" : e < 0.55 ? "punch" : e < 0.8 ? "grow" : "streak";
    const boxed = r() < 0.14;
    if (boxed) {
      const [tc, bc] = SLAM_BOXES[(c + Math.floor(r() * SLAM_BOXES.length)) % SLAM_BOXES.length];
      return { colour: tc, box: bc, glow: bc, swoosh: false, entry };
    }
    return { colour: SLAM_COLOURS[c], box: null, glow: SLAM_COLOURS[c], swoosh: len >= 5 && r() < 0.25, entry };
  });
}

function SlamWord({ text, look, out }: { text: string; look: SlamLook; out: boolean }) {
  const cls = `${out ? "slam-word out" : `slam-word cur ${look.entry}`}${look.box ? " boxed" : ""}`;
  const style = { "--c": look.colour, "--bx": look.box ?? "transparent", "--w": wordWidthEm(text, look.box ? 0.35 : 0.1).toFixed(2) } as CSSProperties;
  return (
    <p className={cls} style={style}>
      {look.entry === "tumble"
        ? [...text].map((ch, j) => (
            <span key={j} className="slam-l" style={{ "--d": `${j * 28}ms`, "--rx": j % 2 ? "-95deg" : "95deg", "--ry": j % 3 === 0 ? "40deg" : "-25deg" } as CSSProperties}>
              {ch}
            </span>
          ))
        : text}
      {look.swoosh && (
        <svg className="slam-swoosh" viewBox="0 0 200 30" preserveAspectRatio="none" aria-hidden="true">
          <path d="M4 25 Q 96 -2 196 12 Q 100 8 4 25 Z" />
        </svg>
      )}
    </p>
  );
}

export function Slam({ lines, index, sung }: StyleProps) {
  const flat = useMemo(() => flatten(lines), [lines]);
  const looks = useMemo(() => buildSlamLooks(flat.words), [flat]);
  const cur = currentWord(flat.start, index, sung);
  if (cur < 0) return <section className="ly ly-slam" />;
  const text = shown(flat.words[cur].text);
  const look = looks[cur];
  return (
    <section className="ly ly-slam">
      <div key={`g${cur}`} className="slam-glow" style={{ "--c": look.glow } as CSSProperties} />
      {cur > 0 && <SlamWord key={cur - 1} text={shown(flat.words[cur - 1].text)} look={looks[cur - 1]} out />}
      <SlamWord key={cur} text={text} look={look} out={false} />
    </section>
  );
}
