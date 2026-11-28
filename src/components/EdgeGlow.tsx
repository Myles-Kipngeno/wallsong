import { useEffect, useRef } from "react";
import { beat } from "../lib/beat";
import { subscribeFrame } from "../lib/frame";

/**
 * The light around the screen. A rotating conic gradient of the album colours,
 * masked to a frame and blurred. CSS variables set on this container:
 * --level (bass, 0..1), --flash (kick, 0..1), --angle (rotation).
 */
export function EdgeGlow() {
  const glowRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let lastL = "";
    let lastF = "";
    let lastA = "";
    return subscribeFrame(() => {
      const el = glowRef.current;
      if (!el) return;
      const l = beat.level.toFixed(3);
      const f = beat.flash.toFixed(3);
      const a = `${beat.angle.toFixed(1)}deg`;
      if (l !== lastL) {
        lastL = l;
        el.style.setProperty("--level", l);
      }
      if (f !== lastF) {
        lastF = f;
        el.style.setProperty("--flash", f);
      }
      if (a !== lastA) {
        lastA = a;
        el.style.setProperty("--angle", a);
      }
    }, 30);
  }, []);

  return (
    <div ref={glowRef} className="glow" aria-hidden="true">
      {/* Blur sits on the wrapper: CSS masks after filtering, so blurring the
          masked frame itself would leave a hard inner edge. */}
      <div className="glow-blur glow-soft">
        <div className="glow-frame" />
      </div>
      <div className="glow-blur glow-core">
        <div className="glow-frame" />
      </div>
    </div>
  );
}
