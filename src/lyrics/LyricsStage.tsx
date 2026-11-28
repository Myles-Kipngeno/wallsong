import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { LyricStyle } from "../lib/settings";
import { currentLineIndex } from "../lib/lrc";
import { wordsSung, type TimedLine } from "../lib/wordTiming";
import { iconGoesFirst, wordIcon, WORD_ICON_PATHS, type WordIconId } from "./wordIcons";
import { beat } from "../lib/beat";
import { subscribeFrame } from "../lib/frame";
import { emojiFor } from "./emoji";
import { Cascade, Slam, Tape } from "./motionStyles";
import { Orbit } from "./OrbitStyle";
import "./lyrics.css";

/**
 * Draws synced lyrics in one of eleven styles. Every style gets the same
 * things: the lines (with estimated word times), which line is being sung,
 * how many of its words have been sung so far, and the song clock (for styles
 * that time things between words, like Roll).
 */

export interface StyleProps {
  lines: TimedLine[];
  index: number;
  sung: number;
  /** Song time for the lyrics (offset and reading lead already applied). */
  timeMs: () => number;
  playing?: boolean;
  syncSeq?: number;
}

/** Same layout for the same line every time (positions, angles). */
function seeded(seed: number) {
  let a = seed + 0x6d2b79f5;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sungWords = (line: TimedLine | undefined, sung: number) => (line ? line.words.slice(0, sung) : []);
const clean = (w: string) => w.replace(/[.,!?;:"“”]+$/g, "");

// ---------- Stack: the default. Two dim lines above, the current line building word by word. ----------

function Stack({ lines, index, sung }: StyleProps) {
  const line = lines[index];
  const previous = lines.slice(Math.max(0, index - 2), index).filter((l) => l.text);
  return (
    <section className="ly ly-stack">
      {previous.map((l, i) => (
        <p key={`${index}-p${i}`} className="ly-prev">
          {l.text}
        </p>
      ))}
      <p className="ly-current" key={index}>
        {line && !line.text ? <span className="ly-note">♪</span> : null}
        {sungWords(line, sung).map((w, i) => (
          <span key={i} className="ly-word">
            {w.text}{" "}
          </span>
        ))}
      </p>
    </section>
  );
}

// ---------- Drop: sung words fall in and pile up, one per row. ----------

function Drop({ lines, index, sung }: StyleProps) {
  // The pile keeps the last five words so it never runs into the player bar.
  const words = sungWords(lines[index], sung).slice(-5);
  return (
    <section className="ly ly-drop" key={index}>
      {words.map((w, i) => {
        const len = clean(w.text).length || 1;
        const size = Math.max(0.55, Math.min(1.5, 4.2 / Math.sqrt(len + 1)));
        return (
          <span key={i} className="ly-drop-word" style={{ "--s": size } as CSSProperties}>
            {clean(w.text)}
          </span>
        );
      })}
    </section>
  );
}

// ---------- Scrawl: marker writing on the wall, the last few lines stay up. ----------

function Scrawl({ lines, index, sung }: StyleProps) {
  const shown = [index - 2, index - 1, index].filter((i) => i >= 0 && lines[i]?.text);
  return (
    <section className="ly ly-scrawl">
      {shown.map((i) => {
        const r = seeded(i * 97);
        const words = i === index ? sungWords(lines[i], sung) : lines[i].words;
        const style = {
          "--x": `${12 + r() * 52}vw`,
          "--y": `${36 + ((i % 3) * 14 + r() * 6)}vh`,
          "--rot": `${(r() - 0.5) * 14}deg`,
          opacity: i === index ? 1 : i === index - 1 ? 0.55 : 0.25,
        } as CSSProperties;
        return (
          <p key={i} className="ly-scrawl-line" style={style}>
            {words.map((w, j) => (
              <span key={j} className="ly-scrawl-word">
                {w.text}{" "}
              </span>
            ))}
          </p>
        );
      })}
    </section>
  );
}

// ---------- Sweep: the word being sung, huge, wiping in. ----------

function Sweep({ lines, index, sung }: StyleProps) {
  const line = lines[index];
  const word = line?.words[Math.max(0, sung - 1)];
  return (
    <section className="ly ly-sweep">
      {word && sung > 0 && (
        <p key={`${index}-${sung}`} className="ly-sweep-word">
          {clean(word.text)}
        </p>
      )}
      <p className="ly-sweep-line">{line?.text}</p>
    </section>
  );
}

// ---------- Tube: an old TV, scanlines and colour fringes. ----------

function Tube({ lines, index, sung }: StyleProps) {
  const line = lines[index];
  return (
    <section className="ly ly-tube">
      <div className="ly-tube-screen">
        <p className="ly-tube-text" key={index}>
          {sungWords(line, sung).map((w, i) => (
            <span key={i}>{w.text} </span>
          ))}
          <span className="ly-tube-cursor">▌</span>
        </p>
      </div>
    </section>
  );
}

// ---------- Lens: the sung word bulges as if seen through a fisheye. ----------

function Lens({ lines, index, sung }: StyleProps) {
  const word = clean(lines[index]?.words[Math.max(0, sung - 1)]?.text ?? "");
  const letters = [...word];
  const mid = (letters.length - 1) / 2;
  return (
    <section className="ly ly-lens">
      {sung > 0 && (
        <p className="ly-lens-word" key={`${index}-${sung}`}>
          {letters.map((ch, i) => {
            const d = mid === 0 ? 0 : Math.abs(i - mid) / (mid + 0.5);
            const bulge = 1.55 - d * d * 0.85;
            return (
              <span key={i} style={{ "--b": bulge.toFixed(3), "--sk": `${((i - mid) / (mid + 1)) * -8}deg` } as CSSProperties}>
                {ch}
              </span>
            );
          })}
        </p>
      )}
    </section>
  );
}

// ---------- Stretch: tall, warped letters that keep wobbling. ----------

function Stretch({ lines, index, sung }: StyleProps) {
  const words = sungWords(lines[index], sung).slice(-2);
  return (
    <section className="ly ly-stretch" key={index}>
      {words.map((w, i) => (
        <p key={`${sung}-${i}`} className="ly-stretch-word">
          {[...clean(w.text)].map((ch, j) => (
            <span key={j} style={{ "--d": `${j * 90}ms` } as CSSProperties}>
              {ch}
            </span>
          ))}
        </p>
      ))}
    </section>
  );
}

// ---------- Stars: each word a star, joined in order; a reticle on the word being sung. ----------

function Stars({ lines, index, sung }: StyleProps) {
  const nodes = useMemo(() => {
    const out: Array<{ text: string; x: number; y: number; line: number; word: number; big: boolean }> = [];
    for (let li = Math.max(0, index - 1); li <= index; li++) {
      const line = lines[li];
      if (!line) continue;
      const r = seeded(li * 131 + 7);
      line.words.forEach((w, wi) => {
        const big = clean(w.text).length >= 6 && r() > 0.55;
        out.push({ text: clean(w.text), x: 16 + r() * 68, y: 40 + r() * 34, line: li, word: wi, big });
      });
    }
    return out;
  }, [lines, index]);
  const visible = nodes.filter((n) => n.line < index || n.word < sung);
  const active = visible[visible.length - 1];
  return (
    <section className="ly ly-stars">
      <svg className="ly-stars-lines" viewBox="0 0 100 100" preserveAspectRatio="none">
        {visible.slice(1).map((n, i) => {
          const a = visible[i];
          return <line key={i} x1={a.x} y1={a.y} x2={n.x} y2={n.y} className={n.line < index ? "old" : ""} />;
        })}
      </svg>
      {visible.map((n, i) => (
        <span
          key={`${n.line}-${n.word}`}
          className={`ly-star${n === active ? " active" : ""}${n.line < index ? " old" : ""}${n.big ? " big" : ""}`}
          style={{ left: `${n.x}vw`, top: `${n.y}vh` }}
        >
          <i className="ly-star-dot" />
          {n.text}
          {n === active && <i className="ly-star-reticle" aria-hidden="true" key={i} />}
        </span>
      ))}
    </section>
  );
}

// ---------- Chat: lines arrive as messages, alternating sides. ----------

function Chat({ lines, index, sung }: StyleProps) {
  const first = Math.max(0, index - 4);
  const shown = lines.slice(first, index + 1).map((l, k) => ({ line: l, i: first + k })).filter((x) => x.line.text);
  const typing = sung === 0 && lines[index]?.text;
  return (
    <section className="ly ly-chat">
      {shown.map(({ line, i }) => {
        const mine = i % 2 === 1;
        const words = i === index ? sungWords(line, sung) : line.words;
        if (i === index && !words.length) return null;
        return (
          <div key={i} className={`ly-bubble${mine ? " mine" : ""}${i === index ? " now" : ""}`}>
            {words.map((w) => w.text).join(" ")}
          </div>
        );
      })}
      {typing && (
        <div className={`ly-bubble typing${index % 2 === 1 ? " mine" : ""}`}>
          <i />
          <i />
          <i />
        </div>
      )}
    </section>
  );
}

// ---------- Icons: stacked words, some with a little picture; the sung word underlined. ----------

const iconFor = emojiFor;

function Icons({ lines, index, sung }: StyleProps) {
  const words = sungWords(lines[index], sung).slice(-6);
  return (
    <section className="ly ly-icons" key={index}>
      {words.map((w, i) => {
        const icon = iconFor(w.text);
        return (
          <span key={i} className={`ly-icon-word${i === words.length - 1 ? " active" : ""}`}>
            {clean(w.text)}
            {icon && <em className="ly-icon">{icon}</em>}
          </span>
        );
      })}
    </section>
  );
}

// ---------- Roll: one big word at a time, rolling up a column. ----------
//
// Three slots, centred: the previous word small above, the current word big, the
// next word below. The next word shows as a coloured block just before it's sung;
// then everything rolls up one slot. Each word element keeps its key (its place
// in the song) while it moves from slot to slot, so CSS transitions do the motion.

/** The next word shows as a block this long before it's sung. */
const ROLL_BLOCK_LEAD_MS = 220;
/** A word that comes this soon after the previous one skips the block and rolls twice as fast. */
const ROLL_FAST_MS = 160;
/** No new word for this long: the current word dims until the next one shows up. */
const ROLL_IDLE_MS = 3000;
/** How many recent block indices to remember (enough to cover every slot on screen). */
const ROLL_BLOCK_MEMORY = 4;

interface RollWord {
  text: string;
  startMs: number;
  icon: WordIconId | null;
  /** Starts less than ROLL_FAST_MS after the word before it. */
  fast: boolean;
}

/** The word as shown: without the brackets, quotes and punctuation around it. */
const rollText = (w: string) => w.replace(/^[(["“‘]+/, "").replace(/[)\]"”.,!?;:…]+$/, "");

/** Every word of the song in order, so line changes roll through like any other word. */
function rollWords(lines: TimedLine[]): RollWord[] {
  const out: RollWord[] = [];
  for (const line of lines) {
    for (const w of line.words) {
      const text = rollText(w.text);
      if (!/[\p{L}\p{N}]/u.test(text)) continue;
      const before = out[out.length - 1];
      out.push({ text, startMs: w.startMs, icon: wordIcon(text), fast: !!before && w.startMs - before.startMs < ROLL_FAST_MS });
    }
  }
  return out;
}

/** Index of the last word with startMs <= t, or -1 before the first. */
function rollWordAt(words: RollWord[], t: number): number {
  let lo = 0;
  let hi = words.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].startMs <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    if (typeof matchMedia === "undefined") return;
    const query = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

interface RollState {
  /** Word being sung (global index), -1 before the first. */
  cur: number;
  /** The next word is close enough to show. */
  next: boolean;
  /** Nothing new for a while: dim the current word. */
  idle: boolean;
  /** Words that were shown as a block in the next slot (they wipe it away as they land). */
  blocks: number[];
}

const ROLL_START: RollState = { cur: -1, next: false, idle: false, blocks: [] };

type RollSlot = "leaving" | "prev" | "current" | "next";

function RollGlyph({ word, slot, block, out }: { word: RollWord; slot: RollSlot; block: boolean; out?: boolean }) {
  const icon = word.icon && (
    <svg className="roll-icon" viewBox="0 0 24 24" aria-hidden="true">
      {WORD_ICON_PATHS[word.icon].map((d, i) => (
        <path key={i} d={d} fillRule="evenodd" />
      ))}
    </svg>
  );
  const first = !!word.icon && iconGoesFirst(word.icon);
  return (
    <span className={`roll-word roll-${slot}${block ? "" : " noblock"}${out ? " out" : ""}`}>
      {first && icon}
      <span className="roll-core">
        <span className="roll-glyphs">{word.text}</span>
        <span className="roll-block" aria-hidden="true">
          {word.text}
        </span>
      </span>
      {!first && icon}
    </span>
  );
}

function Roll({ lines, timeMs, playing = true, syncSeq = 0 }: StyleProps) {
  const words = useMemo(() => rollWords(lines), [lines]);
  const reduced = usePrefersReducedMotion();
  const [state, setState] = useState<RollState>(ROLL_START);

  useEffect(() => {
    setState(ROLL_START);
  }, [words]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let safety: ReturnType<typeof setInterval> | null = null;

    const update = () => {
      if (timer) clearTimeout(timer);
      const t = timeMs();
      const cur = rollWordAt(words, t);
      const upcoming = words[cur + 1];
      const next = !!upcoming && t >= upcoming.startMs - ROLL_BLOCK_LEAD_MS;
      const idle = cur >= 0 && !next && t - words[cur].startMs >= ROLL_IDLE_MS;
      const showsBlock = next && !upcoming.fast && !reduced;
      setState((s) => {
        const blocks = showsBlock && !s.blocks.includes(cur + 1) ? [...s.blocks.slice(1 - ROLL_BLOCK_MEMORY), cur + 1] : s.blocks;
        return s.cur === cur && s.next === next && s.idle === idle && s.blocks === blocks ? s : { cur, next, idle, blocks };
      });

      if (!playing) return;

      const candidates: number[] = [];
      if (upcoming) {
        const blockTime = upcoming.startMs - ROLL_BLOCK_LEAD_MS;
        if (blockTime > t) candidates.push(blockTime);
        if (upcoming.startMs > t) candidates.push(upcoming.startMs);
      }
      if (cur >= 0 && !idle) {
        const idleTime = words[cur].startMs + ROLL_IDLE_MS;
        if (idleTime > t) candidates.push(idleTime);
      }
      if (cur < 0 && words.length > 0) {
        const firstBlock = words[0].startMs - ROLL_BLOCK_LEAD_MS;
        if (firstBlock > t) candidates.push(firstBlock);
        if (words[0].startMs > t) candidates.push(words[0].startMs);
      }
      if (candidates.length > 0) {
        const nextWakeMs = Math.min(...candidates);
        const delay = Math.max(10, nextWakeMs - t);
        if (delay < 1100) timer = setTimeout(update, delay);
      }
    };

    update();
    if (playing) safety = setInterval(update, 1000);

    return () => {
      if (timer) clearTimeout(timer);
      if (safety) clearInterval(safety);
    };
  }, [words, timeMs, reduced, playing, syncSeq]);

  const { cur, next, idle, blocks } = state;
  const fast = cur >= 0 && words[cur]?.fast;
  const className = `ly ly-roll${fast ? " fast" : ""}${idle ? " idle" : ""}`;
  const at = (i: number) => (i >= 0 && i < words.length ? words[i] : null);

  if (reduced) {
    // No motion: each slot cross-fades from its old word to its new one.
    const items: Array<{ slot: RollSlot; i: number; out: boolean }> = [
      { slot: "prev", i: cur - 2, out: true },
      { slot: "prev", i: cur - 1, out: false },
      { slot: "current", i: cur - 1, out: true },
      { slot: "current", i: cur, out: false },
      { slot: "next", i: next ? cur + 1 : -1, out: false },
    ];
    return (
      <section className={className}>
        {items.map(({ slot, i, out }) => {
          const word = at(i);
          return word && <RollGlyph key={`${slot}-${i}-${out ? "o" : "i"}`} word={word} slot={slot} block={false} out={out} />;
        })}
      </section>
    );
  }

  const slots: Array<[RollSlot, number]> = [
    ["leaving", cur - 2],
    ["prev", cur - 1],
    ["current", cur],
    ["next", next ? cur + 1 : -1],
  ];
  return (
    <section className={className}>
      {slots.map(([slot, i]) => {
        const word = at(i);
        return word && <RollGlyph key={i} word={word} slot={slot} block={blocks.includes(i)} />;
      })}
    </section>
  );
}

const STYLES: Record<LyricStyle, (p: StyleProps) => React.ReactElement> = {
  stack: Stack,
  drop: Drop,
  scrawl: Scrawl,
  sweep: Sweep,
  tube: Tube,
  lens: Lens,
  stretch: Stretch,
  stars: Stars,
  chat: Chat,
  icons: Icons,
  roll: Roll,
  orbit: Orbit,
  tape: Tape,
  cascade: Cascade,
  slam: Slam,
};

/** Watches the song time and re-renders only when the line or the sung word changes. */
export function LyricsStage({
  lines,
  style,
  timeMs,
  playing = true,
  syncSeq = 0,
  className = "",
}: {
  lines: TimedLine[];
  style: LyricStyle;
  /** Song time for the lyrics (offset and reading lead already applied). */
  timeMs: () => number;
  playing?: boolean;
  syncSeq?: number;
  className?: string;
}) {
  const [pos, setPos] = useState({ index: -1, sung: 0 });
  const stageRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let lastL = "";
    let lastF = "";
    return subscribeFrame(() => {
      const el = stageRef.current;
      if (!el) return;
      const l = beat.level.toFixed(2);
      const f = beat.flash.toFixed(2);
      if (l !== lastL) {
        lastL = l;
        el.style.setProperty("--level", l);
      }
      if (f !== lastF) {
        lastF = f;
        el.style.setProperty("--flash", f);
      }
    }, 15);
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let safety: ReturnType<typeof setInterval> | null = null;

    const update = () => {
      if (timer) clearTimeout(timer);
      const t = timeMs();
      const index = currentLineIndex(lines, t);
      const sung = index >= 0 ? wordsSung(lines[index], t) : 0;
      setPos((p) => (p.index === index && p.sung === sung ? p : { index, sung }));

      if (!playing) return;

      let nextTargetMs: number | null = null;
      if (index < 0) {
        if (lines.length > 0) nextTargetMs = lines[0].timeMs;
      } else {
        const line = lines[index];
        if (sung < line.words.length) {
          nextTargetMs = line.words[sung].startMs;
        } else if (index + 1 < lines.length) {
          nextTargetMs = lines[index + 1].timeMs;
        }
      }

      if (nextTargetMs !== null) {
        const delay = Math.max(10, nextTargetMs - t);
        if (delay < 1100) timer = setTimeout(update, delay);
      }
    };

    update();
    if (playing) safety = setInterval(update, 1000);

    return () => {
      if (timer) clearTimeout(timer);
      if (safety) clearInterval(safety);
    };
  }, [lines, timeMs, playing, syncSeq]);

  // Roll runs its own clock, so it can show the first word's block before the first line starts.
  if (pos.index < 0 && style !== "roll") return null;
  const Style = STYLES[style] ?? Stack;
  return (
    <div ref={stageRef} className={`lyrics-stage ${className}`} aria-live="polite">
      <Style lines={lines} index={pos.index} sung={pos.sung} timeMs={timeMs} playing={playing} syncSeq={syncSeq} />
    </div>
  );
}
