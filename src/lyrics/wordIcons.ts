/**
 * Little pictures for the Roll lyric style: solid one-colour glyphs on a 24×24
 * grid, drawn for Wallsong from plain shapes (circles, rectangles, curves).
 * Each glyph is a list of paths painted on top of each other; a path that
 * contains a second outline uses it as a hole (even-odd fill).
 */

export type WordIconId =
  | "heart" | "person" | "people" | "gift" | "paw" | "flame" | "moon" | "star"
  | "car" | "phone" | "money" | "note" | "home" | "eye" | "crown" | "rose"
  | "diamond" | "drop" | "sun" | "plane" | "globe" | "clock" | "lips";

const circle = (cx: number, cy: number, r: number) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0z`;

export const WORD_ICON_PATHS: Record<WordIconId, string[]> = {
  heart: [circle(7.5, 9, 4.5), circle(16.5, 9, 4.5), "M3.4 11 12 21l8.6-10L12 7z"],
  person: [circle(12, 7, 4), "M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8z"],
  people: [
    circle(17, 7, 3),
    "M14.5 13.4c.8-.3 1.6-.4 2.5-.4 3.3 0 6 2.7 6 6v2h-5.6c0-3-1.1-5.7-2.9-7.6z",
    circle(9, 8, 3.5),
    "M2 21c0-3.9 3.1-7 7-7s7 3.1 7 7z",
  ],
  gift: [
    "M3 8h8v4H3zM13 8h8v4h-8z",
    "M4.5 13H11v8H4.5zM13 13h6.5v8H13z",
    "M12 8C10.5 5 7 4 6.2 5.8 5.5 7.4 8.5 8 12 8z",
    "M12 8c1.5-3 5-4 5.8-2.2C18.5 7.4 15.5 8 12 8z",
  ],
  paw: [
    "M12 12c-3 0-6 3.4-6 6 0 1.7 1.3 2.6 3 2.6 1.2 0 2-.6 3-.6s1.8.6 3 .6c1.7 0 3-.9 3-2.6 0-2.6-3-6-6-6z",
    circle(5, 10.5, 1.9),
    circle(9, 6.5, 2.1),
    circle(15, 6.5, 2.1),
    circle(19, 10.5, 1.9),
  ],
  flame: ["M12 2c1 3.5 5.5 6 5.5 11.5A5.5 5.5 0 0 1 12 22a5.5 5.5 0 0 1-5.5-8.5c.6 1.6 1.7 2.5 2.7 2.7C8.2 11.8 10.6 7.4 12 2z"],
  // Wallsong's own moon (overlay/icons.tsx), filled.
  moon: ["M14.5 3.2a8.8 8.8 0 1 0 6.3 12.3A7.3 7.3 0 0 1 14.5 3.2z"],
  star: ["M12 2.5l2.47 6.6 7.04.31-5.52 4.39 1.89 6.79L12 16.7l-5.88 3.89 1.89-6.79-5.52-4.39 7.04-.31z"],
  car: [
    "M2.5 16.5V13c0-.9.6-1.6 1.5-1.8l2.6-.6 2.3-3.3c.4-.5 1-.8 1.6-.8h5.4c.6 0 1.1.3 1.5.7l2.7 3.4 1.5.3c.9.2 1.4.9 1.4 1.8v2.8c0 .6-.4 1-1 1h-.8a2.75 2.75 0 0 0-5.4 0H9.4a2.75 2.75 0 0 0-5.4 0h-.5c-.6 0-1-.4-1-1zM9.6 8.4h2.6v2.3H8.1zM13.8 8.4h1.9l1.8 2.3h-3.7z",
    circle(6.7, 17, 2.1),
    circle(18.5, 17, 2.1),
  ],
  phone: ["M7 2h10a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zM7 5v13h10V5zM10.8 19h2.4v1.3h-2.4z"],
  money: ["M2 6h20v12H2zM4 8v8h16V8z", circle(12, 12, 3)],
  note: ["M9 5.2 20 2.8V15h-2V7.3l-7 1.5V18H9z", circle(7, 18, 3), circle(16, 15, 3)],
  home: ["M12 3 2 11.5h3V21h5.5v-6h3v6H19v-9.5h3z"],
  eye: ["M12 5C6.5 5 2.7 9 1.5 12c1.2 3 5 7 10.5 7s9.3-4 10.5-7C21.3 9 17.5 5 12 5zM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z", circle(12, 12, 2)],
  crown: ["M3 7l4.5 4L12 4l4.5 7L21 7l-2 11H5z", "M5 19.5h14V21H5z"],
  rose: [
    "M12 3c-2.5 0-5 1.8-5 4.8C7 10.6 9.2 13 12 13s5-2.4 5-5.2C17 4.8 14.5 3 12 3zM10 6.6c.8-.9 3.2-.9 4 0-1 .4-3 .4-4 0z",
    "M7 6.5C5 7 4 9 4.5 11c1 .9 2.4 1.2 3.6 1A6 6 0 0 1 7 6.5z",
    "M17 6.5c2 .5 3 2.5 2.5 4.5-1 .9-2.4 1.2-3.6 1A6 6 0 0 0 17 6.5z",
    "M11.2 13h1.6v9h-1.6z",
    "M12.8 17.5c.5-2 2.4-3.2 4.7-3-.4 2.2-2.4 3.5-4.7 3z",
  ],
  diamond: ["M7 3h10l5 6-10 12L2 9zM7.6 4.5h8.8l2.4 2.9H5.2z"],
  drop: ["M12 2.5c3 4.2 6.5 8 6.5 12a6.5 6.5 0 0 1-13 0c0-4 3.5-7.8 6.5-12z"],
  sun: [
    circle(12, 12, 5),
    "M23 12l-3.8-1.4v2.8z",
    "M19.78 19.78l-1.7-3.68-1.98 1.98z",
    "M12 23l1.4-3.8h-2.8z",
    "M4.22 19.78l3.68-1.7-1.98-1.98z",
    "M1 12l3.8 1.4v-2.8z",
    "M4.22 4.22l1.7 3.68 1.98-1.98z",
    "M12 1l-1.4 3.8h2.8z",
    "M19.78 4.22l-3.68 1.7 1.98 1.98z",
  ],
  plane: ["M21 15.5v-2L13.5 9V4a1.5 1.5 0 0 0-3 0v5L3 13.5v2l7.5-2.5V18l-2 1.5V21l3.5-1 3.5 1v-1.5l-2-1.5v-5z"],
  globe: [
    `${circle(12, 12, 9.5)}${circle(12, 12, 8)}`,
    "M7.5 12a4.5 9.5 0 1 0 9 0a4.5 9.5 0 1 0-9 0zM9 12a3 8 0 1 0 6 0a3 8 0 1 0-6 0z",
    "M2.5 11.25h19v1.5h-19z",
    "M4 7.2h16v1.3H4zM4 15.5h16v1.3H4z",
  ],
  // Wallsong's own clock (overlay/icons.tsx).
  clock: ["M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 2a8 8 0 1 1 0 16 8 8 0 0 1 0-16zm-1 3h2v4.6l3.3 2-1 1.7L11 12.7z"],
  lips: [
    "M2 12c2.2-2.6 4.8-5 7.2-5 1.2 0 2.1.6 2.8 1.3.7-.7 1.6-1.3 2.8-1.3 2.4 0 5 2.4 7.2 5-3.2-.3-6.4-.5-10-.5s-6.8.2-10 .5z",
    "M2 12.5c3.2.6 6.6.9 10 .9s6.8-.3 10-.9C19.8 16 16.2 18 12 18s-7.8-2-10-5.5z",
  ],
};

/**
 * Which words get a picture. The lists are the Icons style's (LyricsStage.tsx),
 * for every picture there's a glyph for, plus you/we/give/feel.
 */
const WORD_ICONS: Array<[RegExp, WordIconId]> = [
  [/^(car|cars|whip|ride|ridin|riding|drive|drivin|driving|benz|coupe)$/, "car"],
  [/^(love|lovin|loving|heart|hearts|feel|feeling|feelings)$/, "heart"],
  [/^(money|cash|bands|paid|rich|racks|dollar|dollars)$/, "money"],
  [/^(fire|lit|flame|flames|burn|burning)$/, "flame"],
  [/^(night|moon|midnight|tonight)$/, "moon"],
  [/^(star|stars|shine|shining)$/, "star"],
  [/^(phone|call|calling|text|texts)$/, "phone"],
  [/^(rain|raining|storm|cry|cryin|crying|tears)$/, "drop"],
  [/^(sun|sunshine|summer|day|daylight)$/, "sun"],
  [/^(eyes|see|look|lookin|looking|watch|watching)$/, "eye"],
  [/^(kiss|kisses|lips)$/, "lips"],
  [/^(king|queen|crown)$/, "crown"],
  [/^(rose|roses|flower|flowers)$/, "rose"],
  [/^(diamond|diamonds|ice|icy)$/, "diamond"],
  [/^(baby|babe)$/, "paw"],
  [/^(time|clock|minutes|hours)$/, "clock"],
  [/^(home|house)$/, "home"],
  [/^(fly|flyin|flying|plane|sky)$/, "plane"],
  [/^(music|song|songs|beat|beats|party|dance|dancin|dancing)$/, "note"],
  [/^(world|earth)$/, "globe"],
  [/^(you|u)$/, "person"],
  [/^(we|us)$/, "people"],
  [/^(give|gift)$/, "gift"],
];

/** The picture for a sung word, if it has one. */
export function wordIcon(word: string): WordIconId | null {
  const w = word.toLowerCase().replace(/[’']/g, "").replace(/[^a-z]/g, "");
  return WORD_ICONS.find(([re]) => re.test(w))?.[1] ?? null;
}

/** Feelings put their picture before the word ("♥ love"); everything else after it. */
export function iconGoesFirst(icon: WordIconId): boolean {
  return icon === "heart";
}
