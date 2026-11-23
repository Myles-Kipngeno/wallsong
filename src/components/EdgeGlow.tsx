import { useEffect, useRef } from "react";

/** Band thickness and blur in CSS pixels, for the wide soft glow and the thin bright edge. */
const SOFT = { thickness: 44, blur: 36 };
const CORE = { thickness: 7, blur: 4 };

/**
 * Draws one glow frame into `canvas`: a conic gradient of the album colours (starting
 * at 12 o'clock, like CSS `from 0deg`), cut to a band around the screen edge, blurred.
 * Done in device pixels, so it stays sharp at any display scaling.
 */
function drawFrame(canvas: HTMLCanvasElement, colors: string[], thickness: number, blur: number) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.round(window.innerWidth * dpr);
  const h = Math.round(window.innerHeight * dpr);
  const t = thickness * dpr;

  const band = document.createElement("canvas");
  band.width = w;
  band.height = h;
  const b = band.getContext("2d");
  const out = canvas.getContext("2d");
  if (!b || !out) return;

  const gradient = b.createConicGradient(-Math.PI / 2, w / 2, h / 2);
  const [c1, c2, c3] = colors;
  [c1, c2, c3, c1].forEach((c, i) => gradient.addColorStop(i / 3, c));
  b.fillStyle = gradient;
  b.fillRect(0, 0, w, h);
  b.clearRect(t, t, w - 2 * t, h - 2 * t);

  canvas.width = w;
  canvas.height = h;
  out.filter = `blur(${blur * dpr}px)`;
  out.drawImage(band, 0, 0);
}

/**
 * The light around the screen. Both frames are drawn once into canvases (again only
 * when the album colours or the screen size change); the beat only changes their
 * opacity, through CSS variables set by App: --level (bass, 0..1), --flash (kick, 0..1).
 * A live CSS mask + blur was rebuilt by the browser on every frame and cost ~6% CPU.
 */
export function EdgeGlow({ palette }: { palette: string[] }) {
  const soft = useRef<HTMLCanvasElement>(null);
  const core = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const draw = () => {
      if (soft.current) drawFrame(soft.current, palette, SOFT.thickness, SOFT.blur);
      if (core.current) drawFrame(core.current, palette, CORE.thickness, CORE.blur);
    };
    draw();
    window.addEventListener("resize", draw);
    return () => window.removeEventListener("resize", draw);
  }, [palette]);

  return (
    <div className="glow" aria-hidden="true">
      <canvas ref={soft} className="glow-soft" />
      <canvas ref={core} className="glow-core" />
    </div>
  );
}
