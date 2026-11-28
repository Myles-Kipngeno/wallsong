/** Words that get a little emoji next to them (Icons and Cascade styles). */

const ICONS: Array<[RegExp, string]> = [
  [/^(car|cars|whip|ride|ridin|riding|drive|drivin|driving|benz|coupe)$/, "🚗"],
  [/^(love|lovin|loving|heart|hearts)$/, "❤️"],
  [/^(money|cash|bands|paid|rich|racks|dollar|dollars)$/, "💸"],
  [/^(fire|lit|flame|flames|burn|burning)$/, "🔥"],
  [/^(night|moon|midnight|tonight)$/, "🌙"],
  [/^(star|stars|shine|shining)$/, "⭐"],
  [/^(phone|call|calling|text|texts)$/, "📱"],
  [/^(rain|raining|storm|cry|cryin|crying|tears)$/, "🌧️"],
  [/^(sun|sunshine|summer|day|daylight)$/, "☀️"],
  [/^(eyes|see|look|lookin|looking|watch|watching)$/, "👀"],
  [/^(kiss|kisses|lips)$/, "💋"],
  [/^(king|queen|crown)$/, "👑"],
  [/^(rose|roses|flower|flowers)$/, "🌹"],
  [/^(diamond|diamonds|ice|icy)$/, "💎"],
  [/^(party|dance|dancin|dancing)$/, "🪩"],
  [/^(laugh|laughin|laughing|smile|smilin|smiling|happy)$/, "😊"],
  [/^(baby|babe)$/, "🐾"],
  [/^(time|clock|minutes|hours)$/, "⏳"],
  [/^(home|house)$/, "🏠"],
  [/^(fly|flyin|flying|plane|sky)$/, "✈️"],
  [/^(music|song|songs|beat|beats)$/, "🎧"],
  [/^(world|earth)$/, "🌍"],
  [/^(angel|angels|heaven)$/, "😇"],
  [/^(devil|demons|hell)$/, "😈"],
];

export function emojiFor(word: string): string | null {
  const w = word
    .replace(/[.,!?;:"“”]+$/g, "")
    .toLowerCase()
    .replace(/[’']/g, "");
  return ICONS.find(([re]) => re.test(w))?.[1] ?? null;
}

