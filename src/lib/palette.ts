/** Wallsong's own colours, used when a song has no artwork. */
export const BRAND_PALETTE = ["#FF3D8B", "#FF9A3D", "#B8FF4D"];

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
