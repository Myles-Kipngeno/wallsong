// Every font Wallsong uses, bundled with the app (all open-licence, from Fontsource).
import "@fontsource/antonio/200.css";
import "@fontsource/antonio/300.css";
import "@fontsource/big-shoulders-display/300";
import "@fontsource/bebas-neue/400.css";
import "@fontsource/anton/400.css";
import "@fontsource/playfair-display/400.css";
import "@fontsource/playfair-display/700.css";
import "@fontsource/nunito/700.css";
import "@fontsource/nunito/800.css";
import "@fontsource/nunito/900.css";
import "@fontsource/inter/300.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/barlow-condensed/600.css";
import "@fontsource/barlow-condensed/800.css";
import "@fontsource/archivo-black/400.css";
import "@fontsource/permanent-marker/400.css";
import "@fontsource/vt323/400.css";
import "@fontsource/dm-serif-display/400.css";

export interface FontChoice {
  id: string;
  label: string;
  family: string;
  weight: number;
}

export const CLOCK_FONTS: FontChoice[] = [
  { id: "antonio", label: "Antonio Thin", family: "Antonio, sans-serif", weight: 200 },
  { id: "shoulders", label: "Big Shoulders", family: "'Big Shoulders Display', sans-serif", weight: 300 },
  { id: "bebas", label: "Bebas Neue", family: "'Bebas Neue', sans-serif", weight: 400 },
  { id: "anton", label: "Anton", family: "Anton, sans-serif", weight: 400 },
  { id: "playfair", label: "Playfair (serif)", family: "'Playfair Display', serif", weight: 400 },
];

export const LYRIC_FONTS: FontChoice[] = [
  { id: "nunito", label: "Nunito Rounded", family: "Nunito, sans-serif", weight: 800 },
  { id: "inter", label: "Inter", family: "Inter, sans-serif", weight: 700 },
  { id: "barlow", label: "Barlow Condensed", family: "'Barlow Condensed', sans-serif", weight: 800 },
  { id: "archivo", label: "Archivo Black", family: "'Archivo Black', sans-serif", weight: 400 },
  { id: "anton", label: "Anton", family: "Anton, sans-serif", weight: 400 },
  { id: "bebas", label: "Bebas Neue", family: "'Bebas Neue', sans-serif", weight: 400 },
  { id: "playfair", label: "Playfair (serif)", family: "'Playfair Display', serif", weight: 700 },
  { id: "dmserif", label: "DM Serif", family: "'DM Serif Display', serif", weight: 400 },
];

export function fontById(list: FontChoice[], id: string): FontChoice {
  return list.find((f) => f.id === id) ?? list[0];
}
