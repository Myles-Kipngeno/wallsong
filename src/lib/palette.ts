import { useEffect, useState } from "react";

/** Wallsong's own colours, used when a song has no artwork. */
export const BRAND_PALETTE = ["#FF3D8B", "#FF9A3D", "#B8FF4D"];

/** Album colours, read from the artwork (the wallpaper, the Dock and the player card all use them). */
export function usePalette(artwork: string | null | undefined): string[] {
  const [palette, setPalette] = useState<string[]>(BRAND_PALETTE);
  useEffect(() => {
    if (!artwork) return setPalette(BRAND_PALETTE);
    let live = true;
    paletteFromImage(artwork)
      .then((p) => live && setPalette(p))
      .catch(() => {
        /* https artwork can't be read by a canvas; the data URL version follows shortly */
      });
    return () => {
      live = false;
    };
  }, [artwork]);
  return palette;
}

/** Reads #rrggbb, rgb(...) and hsl(...) colours (album colours arrive as hsl) as 0..1 RGB. */
export function colorToRgb(color: string): [number, number, number] | null {
  const m = color.trim().match(/^#?([0-9a-f]{6})$/i);
  if (m) {
    const n = parseInt(m[1], 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  const rgb = color.match(/rgba?\(([^)]+)\)/);
  if (rgb) {
    const [r, g, b] = rgb[1].split(/[\s,/]+/).filter(Boolean).map((v) => parseFloat(v) / 255);
    return [r, g, b];
  }
  const hsl = color.match(/hsla?\(\s*([\d.]+)(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/i);
  if (hsl) {
    const h = parseFloat(hsl[1]);
    const s = parseFloat(hsl[2]) / 100;
    const l = parseFloat(hsl[3]) / 100;
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) => {
      const k = (n + h / 30) % 12;
      return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    };
    return [f(0), f(8), f(4)];
  }
  return null;
}

/** Relative luminance (0 black .. 1 white) of a colour mixed `share` with another, as CSS color-mix does. */
export function mixedLuminance(color: string, share: number, other: string): number {
  const a = colorToRgb(color) ?? [1, 0.24, 0.55];
  const b = colorToRgb(other) ?? [0, 0, 0];
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const [r, g, bl] = a.map((v, i) => v * share + b[i] * (1 - share));
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(bl);
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

/**
 * Picks up to three vivid colours from album art.
 * Pixels are grouped into 12 hue buckets; the busiest colourful buckets win.
 * Greys, near-black and near-white are skipped because they make a dull glow.
 */
export async function paletteFromImage(src: string): Promise<string[]> {
  const img = new Image();
  img.src = src;
  await img.decode();

  const size = 48;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return BRAND_PALETTE;
  ctx.drawImage(img, 0, 0, size, size);
  const { data } = ctx.getImageData(0, 0, size, size);

  const buckets = Array.from({ length: 12 }, () => ({ n: 0, h: 0, s: 0, l: 0 }));
  for (let i = 0; i < data.length; i += 4) {
    const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2]);
    if (s < 0.25 || l < 0.12 || l > 0.9) continue;
    const b = buckets[Math.floor(h / 30) % 12];
    b.n += 1;
    b.h += h;
    b.s += s;
    b.l += l;
  }

  const picks = buckets
    .filter((b) => b.n > 8)
    .sort((a, b) => b.n - a.n)
    .slice(0, 3)
    // Push saturation and lightness up so the glow reads on a dark screen.
    .map((b) => {
      const h = Math.round(b.h / b.n);
      const s = Math.round(Math.min(1, (b.s / b.n) * 1.25) * 100);
      const l = Math.round(Math.min(0.65, Math.max(0.5, b.l / b.n)) * 100);
      return `hsl(${h} ${s}% ${l}%)`;
    });

  if (picks.length === 0) return BRAND_PALETTE;
  while (picks.length < 3) picks.push(picks[picks.length - 1]);
  return picks;
}
