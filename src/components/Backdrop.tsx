import { useEffect, useRef } from "react";

/**
 * Size of the pre-blurred art. Stretched full-screen, a 64 px image already looks
 * heavily blurred, so the blur costs nothing per frame. (A live CSS `filter: blur()`
 * on the full-screen image was re-run on every repaint: ~4% CPU on a UHD 620.)
 */
const ART_PX = 64;
/** Roughly the old 60 px screen blur, measured in canvas pixels. */
const BAKED_FILTER = "blur(1.5px) saturate(1.35) brightness(0.5)";

/**
 * Stand-in for the music-video wallpaper (week 2): the album art, huge and
 * blurred. Falls back to a dark gradient.
 */
export function Backdrop({ artwork }: { artwork: string | null }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!artwork || !ctx) return;
    let live = true;
    const img = new Image();
    img.onload = () => {
      if (!live) return;
      // Overdraw past the edges so the blur doesn't pull transparent pixels in.
      const m = 4;
      ctx.clearRect(0, 0, ART_PX, ART_PX);
      ctx.filter = BAKED_FILTER;
      ctx.drawImage(img, -m, -m, ART_PX + 2 * m, ART_PX + 2 * m);
    };
    img.src = artwork;
    return () => {
      live = false;
    };
  }, [artwork]);

  return (
    <div className="backdrop" aria-hidden="true">
      {artwork && (
        <canvas key={artwork.length} ref={canvas} className="backdrop-art" width={ART_PX} height={ART_PX} />
      )}
      <div className="backdrop-shade" />
    </div>
  );
}
