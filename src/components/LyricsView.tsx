import type { LyricLine } from "../lib/types";

/** Current line large, the two before it small and dim, like iBaila's stack. */
export function LyricsView({ lines, index }: { lines: LyricLine[]; index: number }) {
  if (index < 0) return null;
  const current = lines[index];
  const previous = lines.slice(Math.max(0, index - 2), index).filter((l) => l.text);

  return (
    <section className="lyrics" aria-live="polite">
      {previous.map((l, i) => (
        <p key={`${index}-${i}`} className="lyrics-prev">
          {l.text}
        </p>
      ))}
      {current.text ? (
        // key = index so the entrance animation replays on every new line
        <p key={index} className="lyrics-current">
          {current.text}
        </p>
      ) : (
        <p key={index} className="lyrics-current lyrics-gap">
          ♪
        </p>
      )}
    </section>
  );
}
