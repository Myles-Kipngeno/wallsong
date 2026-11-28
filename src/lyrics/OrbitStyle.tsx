import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { StyleProps } from "./LyricsStage";
import { currentWord, flatten, groupSizes, locate, pickHero, seeded, shown, wordWidthEm } from "./lyricHelpers";
import { subscribeFrame } from "../lib/frame";
import "./orbit.css";

/**
 * Orbit: modelled on the top-screen 3D rotating lyrics style from Video 3.
 * Cycles smoothly across three rotating movements:
 *
 *  - sphere: words stack on a 3D globe lens and scroll bottom-to-top through the
 *            equator (`∩` arch above, crisp large focal word, `∪` wrap below),
 *            with gentle counter-clockwise Z tilt and perimeter rim streaks.
 *  - tumble: individual words pop in tilted counter-clockwise (`-14deg`), then
 *            drop and spin to `-86deg` vertically sideways as newer words stack
 *            above, mixing with angled pairs (`-16deg`) and crisp pill badges.
 *  - orb:    launches a fast 3D Y-axis spinning shaded orb with horizontal
 *            meridian smear ribbons, left silver-white Fresnel crescent and
 *            right shadow terminator, unwarping directly into crisp upright
 *            words with a fading 4–5 o'clock white perimeter arc streak.
 */

type OrbitMode = "sphere" | "tumble" | "orb";
type GlowMood = "crimson" | "amber" | "slate" | "charcoal";

const ORBIT_RED = "#e62b1a";
const ORBIT_CORAL = "#f27d72";
const ORBIT_CREAM = "#f5f3ec";
const ORBIT_GOLD = "#facc15";
const ORBIT_PILL_BG = "#e63b1a";

interface OrbitGroupRef {
  line: number;
  group: number;
  words: string[];
  /** Global index of the last shown word inside flat.words (used as stable seed/trigger). */
  triggerId: number;
  /** Number of words revealed so far in this group (1..words.length). */
  count: number;
  /** Cycle index across the song's groups so every mode appears promptly. */
  seq: number;
}

function resolveOrbitGroup(
  lines: StyleProps["lines"],
  groups: number[][],
  flatStart: number[],
  flatWords: Array<{ text: string; line: number }>,
  cur: number,
): OrbitGroupRef | null {
  if (cur < 0) return null;
  const line = flatWords[cur].line;
  const wInLine = cur - flatStart[line];
  const { group, from } = locate(groups[line], wInLine);
  let seq = group;
  for (let li = 0; li < line; li++) seq += groups[li]?.length ?? 0;
  const size = groups[line][group];
  const words = lines[line].words.slice(from, from + size).map((w) => shown(w.text));
  return { line, group, words, triggerId: cur, count: wInLine - from + 1, seq };
}

function modeFor(seq: number): OrbitMode {
  const m = seq % 4;
  if (m === 2) return "tumble";
  if (m === 3) return "orb";
  return "sphere";
}

function moodFor(mode: OrbitMode, seq: number): GlowMood {
  if (mode === "orb") return "slate";
  if (mode === "tumble") return seq % 8 === 2 ? "amber" : "crimson";
  return seq % 2 === 0 ? "crimson" : "charcoal";
}

// ---------- WebGL 3D Sphere & Spinning Orb Canvas ----------

const VERT = `
attribute vec2 a;
void main() { gl_Position = vec4(a, 0.0, 1.0); }
`;

const FRAG = `
precision mediump float;
uniform sampler2D uTex;
uniform vec2 uRes;
uniform float uScrollY, uBulge, uRotY, uRotZ, uOrb, uSmear, uZoomBlur, uStreak;

const float PI = 3.14159265;
const float TEX_SCALE = 0.34;

vec2 rotCW(vec2 v, float ang) {
  float c = cos(ang), s = sin(ang);
  return vec2(v.x * c + v.y * s, -v.x * s + v.y * c);
}

vec4 sampleWrap(vec2 uv, float wrapY) {
  if (uv.x <= 0.01 || uv.x >= 0.99) return vec4(0.0);
  if (wrapY < 0.5 && (uv.y <= 0.01 || uv.y >= 0.99)) return vec4(0.0);
  return texture2D(uTex, vec2(uv.x, wrapY > 0.5 ? fract(uv.y) : uv.y));
}

void main() {
  vec2 center = vec2(uRes.x * 0.5, uRes.y * 0.48);
  float R = min(uRes.x, uRes.y) * 0.41;
  vec2 p = (gl_FragCoord.xy - center) / R;
  float r = length(p);
  float rSafe = min(r, 0.999);
  float nz = sqrt(max(0.0, 1.0 - rSafe * rSafe));

  // Clip cleanly to the globe edge whenever spherical warp or orb is active;
  // leave wide flat words unclipped horizontally once settled.
  float clipStrength = max(uOrb, smoothstep(0.15, 0.72, uBulge));
  float diskMask = mix(1.0, smoothstep(1.015, 0.985, r), clipStrength);

  vec4 texCol = vec4(0.0);
  float wrapV = smoothstep(0.18, 0.55, uBulge) * (1.0 - uOrb);

  if (uOrb < 0.995) {
    vec2 pr = rotCW(p, uRotZ);
    float denom = mix(1.0, pow(max(nz, 0.14), 0.72), uBulge);
    vec2 wp = pr / denom;
    vec2 baseUv = wp * TEX_SCALE + vec2(0.5, 0.5 + uScrollY);

    if (uZoomBlur > 0.01) {
      vec4 acc = vec4(0.0);
      vec2 stepDir = p * vec2(0.02, 0.075) * uZoomBlur;
      acc += sampleWrap(baseUv - stepDir * 1.4, wrapV) * 0.14;
      acc += sampleWrap(baseUv - stepDir * 0.7, wrapV) * 0.22;
      acc += sampleWrap(baseUv, wrapV) * 0.28;
      acc += sampleWrap(baseUv + stepDir * 0.7, wrapV) * 0.22;
      acc += sampleWrap(baseUv + stepDir * 1.4, wrapV) * 0.14;
      texCol = acc;
    } else {
      texCol = sampleWrap(baseUv, wrapV);
    }
  }

  vec3 outRgb = texCol.a > 0.002 ? texCol.rgb / texCol.a : vec3(0.0);
  float outA = texCol.a * diskMask;

  // --- 3D Spinning Shaded Orb pass ---
  if (uOrb > 0.005 && r <= 1.02) {
    vec3 n = vec3(p.x, p.y, nz);
    // Slight clockwise meridian slant (+4 deg) like Video 3 at 00:11.
    vec2 nxy = rotCW(n.xy, -0.07);
    vec3 nt = vec3(nxy, n.z);
    // Rotate around Y axis.
    float cy = cos(uRotY), sy = sin(uRotY);
    vec3 q = vec3(nt.x * cy + nt.z * sy, nt.y, -nt.x * sy + nt.z * cy);

    float lon = atan(q.x, q.z);
    float lat = asin(clamp(q.y, -1.0, 1.0));
    float orbU = lon / PI + 0.5;
    float orbV = clamp(0.5 + lat * 0.44, 0.02, 0.98);

    // Horizontal azimuthal smear along latitude creates vertical glowing meridian bands.
    vec4 blurAcc = vec4(0.0);
    float wSum = 0.0;
    for (int i = -5; i <= 5; i++) {
      float f = float(i) / 5.0;
      float w = exp(-f * f * 1.8);
      float du = f * 0.26 * uSmear;
      float dv = f * 0.012 * uSmear;
      blurAcc += texture2D(uTex, vec2(fract(orbU + du), clamp(orbV + dv, 0.02, 0.98))) * w;
      wSum += w;
    }
    vec4 orbTex = blurAcc / max(wSum, 0.001);
    vec3 orbTexRgb = orbTex.a > 0.002 ? orbTex.rgb / orbTex.a : vec3(0.0);

    // Subtle warm peach / coral / cream meridian bands during spin so short words still fill the orb.
    float stripe = 0.5 + 0.5 * cos(lon * 6.0 + sin(lat * 2.5) * 0.4);
    float stripe2 = 0.5 + 0.5 * cos(lon * 11.0 - lat * 1.3);
    float equaFade = smoothstep(1.45, 0.12, abs(lat));
    vec3 ribbonCol = mix(vec3(0.14, 0.10, 0.11), vec3(0.96, 0.62, 0.46), stripe * 0.65 * equaFade);
    ribbonCol = mix(ribbonCol, vec3(0.98, 0.87, 0.78), stripe2 * 0.35 * equaFade);
    vec3 orbBody = mix(ribbonCol, orbTexRgb, clamp(orbTex.a * 1.15, 0.0, 0.92));

    // Upper-left diffuse lighting + dark right shadow terminator.
    vec3 L = normalize(vec3(-0.62, 0.24, 0.74));
    float diff = smoothstep(-0.28, 0.66, dot(n, L));
    orbBody *= (0.08 + 0.96 * diff);

    // Bright left white-silver crescent Fresnel highlight (9-11 o'clock) + dark inner crease.
    float leftRim = smoothstep(0.74, 0.985, r) * smoothstep(0.998, 0.96, r)
      * smoothstep(0.16, -0.55, p.x) * smoothstep(-0.58, 0.38, p.y);
    float crease = 1.0 - 0.58 * exp(-pow((r - 0.87) / 0.042, 2.0))
      * smoothstep(0.16, -0.55, p.x);
    orbBody = orbBody * crease + vec3(0.96, 0.97, 1.0) * leftRim * 1.1;

    // Dim right-edge catchlight.
    float rightRim = smoothstep(0.90, 0.99, r) * smoothstep(0.998, 0.965, r)
      * smoothstep(-0.1, 0.68, p.x) * smoothstep(-0.4, 0.5, p.y);
    orbBody += vec3(0.45, 0.50, 0.58) * rightRim * 0.26;

    float orbDisk = smoothstep(1.012, 0.982, r);
    float orbAlpha = orbDisk * mix(0.88, max(orbTex.a, 0.72), 1.0 - uSmear * 0.4);
    outRgb = mix(outRgb, orbBody, uOrb);
    outA = mix(outA, orbAlpha, uOrb);
  }

  // --- Curved perimeter rim streaks (top/bottom glints in Sphere + 4-5 o'clock arc on Orb exit) ---
  if (r > 0.90 && r < 1.02) {
    float ang = atan(p.y, p.x);
    // Double white streak at 4-5 o'clock (ang -1.25 .. -0.35 rad)
    float brMask = smoothstep(-1.26, -0.95, ang) * smoothstep(-0.32, -0.56, ang);
    float arc1 = exp(-pow((r - 0.986) / 0.008, 2.0));
    float arc2 = exp(-pow((r - 0.958) / 0.005, 2.0)) * 0.6;
    float whiteStreak = (arc1 + arc2) * brMask * uStreak;

    // Subtle spherical rim glints at 11-1 o'clock & 7-8 o'clock during strong Sphere bulge.
    float topMask = smoothstep(1.15, 1.45, ang) * smoothstep(2.05, 1.75, ang);
    float blMask = smoothstep(-2.55, -2.25, ang) * smoothstep(-1.60, -1.85, ang);
    float topGlint = exp(-pow((r - 0.986) / 0.006, 2.0)) * topMask * smoothstep(0.45, 0.9, uBulge) * 0.35;
    float blGlint = exp(-pow((r - 0.982) / 0.007, 2.0)) * blMask * smoothstep(0.45, 0.9, uBulge) * 0.42;

    float extraA = clamp(whiteStreak + topGlint + blGlint, 0.0, 1.0);
    if (extraA > 0.005) {
      vec3 streakCol = vec3(0.96, 0.96, 0.98) * (whiteStreak + topGlint)
        + vec3(0.95, 0.25, 0.16) * blGlint;
      float nextA = max(outA, extraA);
      outRgb = mix(outRgb, streakCol / max(extraA, 0.001), clamp(extraA / max(nextA, 0.001), 0.0, 1.0));
      outA = nextA;
    }
  }

  outA = clamp(outA, 0.0, 1.0);
  gl_FragColor = vec4(clamp(outRgb * outA, 0.0, 1.0), outA);
}
`;

function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, source);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader failed");
  return s;
}

const TEX_SIZE = 1024;
const FONT_FAMILY = `"Archivo Black", Nunito, Inter, sans-serif`;

/** Measures and shrinks font size cleanly so no word touches canvas edges. */
function fitFont(ctx: CanvasRenderingContext2D, text: string, targetPx: number, maxWidth: number, italic = false) {
  let size = targetPx;
  ctx.font = `${italic ? "italic " : ""}900 ${Math.round(size)}px ${FONT_FAMILY}`;
  const measured = ctx.measureText(text).width;
  if (measured > maxWidth && measured > 0) {
    size = size * (maxWidth / measured);
    ctx.font = `${italic ? "italic " : ""}900 ${Math.round(size)}px ${FONT_FAMILY}`;
  }
  return size;
}

/** Paints the phrase stack onto the 1024×1024 canvas texture for the WebGL globe/orb. */
function drawCanvasWords(
  ctx: CanvasRenderingContext2D,
  words: string[],
  count: number,
  mode: OrbitMode,
  sizeMul: number,
  seed: number,
  wrappedTail: string[],
) {
  ctx.clearRect(0, 0, TEX_SIZE, TEX_SIZE);
  const shownWords = words.slice(0, count);
  if (!shownWords.length) return;

  const scale = Math.max(0.7, Math.min(1.4, sizeMul));
  const maxW = TEX_SIZE * 0.72;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";

  if (mode === "sphere") {
    // Active word sits dead-center at y = 512 (equator), older words arch above (`∩`),
    // and wrapped/tail words sit near the poles (`∪` around bottom/top perimeter).
    const active = shownWords[shownWords.length - 1];
    const r = seeded(seed * 97 + shownWords.length);
    const activeBox = shownWords.length === 1 && r() < 0.2;

    // Wrapped ghost/tail lines near lower rim so the circular wrap looks continuous.
    const ghostBottom = wrappedTail[0] ?? shownWords[0];
    if (ghostBottom && shownWords.length >= 2) {
      ctx.save();
      ctx.globalAlpha = 0.62;
      fitFont(ctx, ghostBottom, 76 * scale, maxW * 0.78);
      ctx.fillStyle = ORBIT_RED;
      ctx.fillText(ghostBottom, 512, 835);
      ctx.restore();
    }

    // Preceding words stacked upward above equator (`So`, `out`, `hold`, `you`).
    const above = shownWords.slice(0, -1);
    above.forEach((w, idx) => {
      const dist = above.length - idx;
      const y = 512 - dist * 168 * Math.min(1.1, scale);
      if (y < 70) return;
      const px = (dist === 1 ? 88 : 58) * scale;
      fitFont(ctx, w, px, maxW * 0.82);
      ctx.fillStyle = dist === 1 ? ORBIT_CREAM : "rgba(245, 243, 236, 0.72)";
      ctx.fillText(w, 512, y);
    });

    // Equator hero word (`call`, `my`, `name`, `close`, `me`).
    const heroPx = (active.length <= 3 ? 178 : active.length <= 6 ? 152 : 124) * scale;
    const actual = fitFont(ctx, active, heroPx, maxW);
    if (activeBox) {
      const w = ctx.measureText(active).width + actual * 0.36;
      const h = actual * 1.12;
      ctx.fillStyle = ORBIT_GOLD;
      ctx.beginPath();
      ctx.roundRect(512 - w / 2, 512 - h / 2, w, h, actual * 0.12);
      ctx.fill();
      ctx.fillStyle = "#0b0b10";
      ctx.fillText(active, 512, 516);
    } else {
      ctx.fillStyle = r() < 0.72 ? ORBIT_RED : ORBIT_CORAL;
      ctx.fillText(active, 512, 512);
    }
    return;
  }

  // `orb` mode (post-spin upright crisp reveal: e.g. `So / gently` or `I / [want] / you`).
  const countShown = shownWords.length;
  const startY = countShown === 1 ? 512 : countShown === 2 ? 430 : 350;
  const stepY = countShown === 2 ? 158 : 142;
  const r = seeded(seed * 193 + 7);
  const hero = pickHero(shownWords);
  const wantBox = countShown >= 2 && r() < 0.45;

  shownWords.forEach((w, idx) => {
    const y = startY + idx * stepY * Math.min(1.08, scale);
    const isH = idx === hero;
    const isPill = wantBox && isH;
    const px = (isH ? (w.length <= 4 ? 168 : 138) : 96) * scale;
    const actual = fitFont(ctx, w, px, maxW, !isH && idx === countShown - 1 && r() < 0.5);

    if (isPill) {
      const tw = ctx.measureText(w).width + actual * 0.38;
      const th = actual * 1.12;
      ctx.fillStyle = ORBIT_PILL_BG;
      ctx.beginPath();
      ctx.roundRect(512 - tw / 2, y - th / 2, tw, th, actual * 0.14);
      ctx.fill();
      ctx.fillStyle = idx % 2 === 0 ? "#38bdf8" : ORBIT_CREAM;
      ctx.fillText(w, 512, y + actual * 0.03);
    } else {
      ctx.fillStyle = isH && !wantBox ? (idx === countShown - 1 ? ORBIT_CREAM : ORBIT_CORAL) : idx === 0 && countShown > 1 ? "rgba(245, 243, 236, 0.85)" : ORBIT_CREAM;
      ctx.fillText(w, 512, y);
    }

    // Tapered curved swoosh underline on long hero word (`gently`), just like Video 3 at 00:12.
    if (isH && !isPill && w.length >= 5 && countShown <= 2) {
      const lineW = Math.min(ctx.measureText(w).width * 0.9, maxW * 0.85);
      const sy = y + actual * 0.58;
      ctx.fillStyle = ORBIT_CREAM;
      ctx.beginPath();
      ctx.moveTo(512 - lineW * 0.48, sy + 16);
      ctx.quadraticCurveTo(512, sy - 6, 512 + lineW * 0.48, sy + 2);
      ctx.quadraticCurveTo(512, sy + 6, 512 - lineW * 0.48, sy + 16);
      ctx.closePath();
      ctx.fill();
    }
  });
}

interface GlobeState {
  mode: OrbitMode;
  words: string[];
  count: number;
  seed: number;
  triggerId: number;
  wrappedTail: string[];
  dimmed: boolean;
}

function OrbitGlobeCanvas({ state, onFallback }: { state: GlobeState; onFallback: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const live = useRef(state);
  const fallbackRef = useRef(onFallback);
  fallbackRef.current = onFallback;
  const lastSizeRef = useRef(1);
  const glStateRef = useRef<{
    dirtyTex: boolean;
    wakeAt: number;
    prevSig: string;
    prevSeqMode: OrbitMode | null;
    scrollY: number;
    bulge: number;
    targetBulge: number;
    rotZ: number;
    targetRotZ: number;
    rotY: number;
    orb: number;
    smear: number;
    zoomBlur: number;
    streak: number;
    orbStart: number;
    orbActive: boolean;
    settled: boolean;
  }>({
    dirtyTex: true,
    wakeAt: 0,
    prevSig: "",
    prevSeqMode: null,
    scrollY: 0,
    bulge: 0.85,
    targetBulge: 0.85,
    rotZ: 0,
    targetRotZ: 0,
    rotY: 0,
    orb: 0,
    smear: 0,
    zoomBlur: 0,
    streak: 0,
    orbStart: -99999,
    orbActive: false,
    settled: false,
  });

  // Trigger transitions cleanly whenever the active word, song, or mode changes.
  useEffect(() => {
    const g = glStateRef.current;
    const sig = `${state.seed}|${state.triggerId}|${state.words.join(" ")}`;
    const changed = g.prevSig !== sig || g.prevSeqMode !== state.mode;
    live.current = state;
    g.dirtyTex = true;
    g.settled = false;
    if (!changed) return;

    const now = performance.now();
    const firstWordOfGroup = state.count === 1;
    const r = seeded(state.triggerId * 613 + 9);

    if (state.mode === "sphere") {
      g.orbActive = false;
      g.orb = 0;
      g.smear = 0;
      g.rotY = 0;
      g.scrollY = 0.16;
      const isEnd = state.count === state.words.length;
      g.targetBulge = isEnd ? 0.34 : 0.88;
      g.bulge = Math.max(g.bulge, 0.65);
      // Slight counter-clockwise tilt on dynamic mid-phrase beats (`my` at 00:03), level on phrase end (`name`).
      g.targetRotZ = isEnd ? 0 : (r() < 0.6 ? 0.11 : 0.04);
      g.streak = isEnd ? 0.85 : 0.45;
      g.zoomBlur = state.count > 1 && r() < 0.35 ? 0.6 : 0;
    } else if (state.mode === "orb") {
      if (firstWordOfGroup || g.prevSeqMode !== "orb") {
        // Trigger fast 3D Y-axis spinning orb transition (`00:11 -> 00:12`).
        g.orbActive = true;
        g.orbStart = now;
        g.scrollY = 0;
        g.targetBulge = 0;
        g.targetRotZ = 0;
        g.rotZ = 0;
        g.zoomBlur = 0;
      } else {
        // Subsequent words in the orb group: vertical radial-zoom streak settle (`00:08–00:09`).
        g.scrollY = 0.06;
        g.zoomBlur = 0.72;
        g.targetBulge = 0;
      }
    }
    g.prevSig = sig;
    g.prevSeqMode = state.mode;
    g.wakeAt = now;
  }, [state]);

  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const gl = el.getContext("webgl", { premultipliedAlpha: true, alpha: true, antialias: true });
    if (!gl) {
      fallbackRef.current();
      return;
    }

    let program: WebGLProgram;
    let vs: WebGLShader | null = null;
    let fs: WebGLShader | null = null;
    try {
      program = gl.createProgram()!;
      vs = compileShader(gl, gl.VERTEX_SHADER, VERT);
      fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG);
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "link failed");
      gl.detachShader(program, vs);
      gl.detachShader(program, fs);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      vs = null;
      fs = null;
    } catch {
      if (vs) gl.deleteShader(vs);
      if (fs) gl.deleteShader(fs);
      fallbackRef.current();
      return;
    }

    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, "a");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

    const texCanvas = document.createElement("canvas");
    texCanvas.width = TEX_SIZE;
    texCanvas.height = TEX_SIZE;
    const ctx2d = texCanvas.getContext("2d")!;

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, 1);

    const u = (name: string) => gl.getUniformLocation(program, name);
    const U = {
      tex: u("uTex"), res: u("uRes"), scrollY: u("uScrollY"), bulge: u("uBulge"),
      rotY: u("uRotY"), rotZ: u("uRotZ"), orb: u("uOrb"), smear: u("uSmear"),
      zoomBlur: u("uZoomBlur"), streak: u("uStreak"),
    };
    gl.uniform1i(U.tex, 0);

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      el.width = Math.max(2, Math.round(window.innerWidth * dpr));
      el.height = Math.max(2, Math.round(window.innerHeight * dpr));
      gl.viewport(0, 0, el.width, el.height);
      glStateRef.current.settled = false;
    };
    resize();
    window.addEventListener("resize", resize);

    let lastNow = performance.now();
    const draw = (now: number) => {
      const s = live.current;
      const g = glStateRef.current;

      if (s.dimmed) {
        if (!g.settled) {
          gl.clearColor(0, 0, 0, 0);
          gl.clear(gl.COLOR_BUFFER_BIT);
          g.settled = true;
        }
        return;
      }

      const liveSize = parseFloat(getComputedStyle(el).getPropertyValue("--ly-size") || "1") || 1;
      if (Math.abs(liveSize - lastSizeRef.current) > 0.01) {
        lastSizeRef.current = liveSize;
        g.dirtyTex = true;
      }

      if (g.dirtyTex) {
        drawCanvasWords(ctx2d, s.words, s.count, s.mode, liveSize, s.seed, s.wrappedTail);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, texCanvas);
        g.dirtyTex = false;
        g.settled = false;
      }

      if (g.settled) return;

      const dt = Math.min(60, Math.max(1, now - lastNow));
      lastNow = now;
      const reduced = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

      if (reduced) {
        g.scrollY = 0;
        g.bulge = s.mode === "sphere" ? 0.35 : 0;
        g.rotZ = 0;
        g.rotY = 0;
        g.orb = 0;
        g.smear = 0;
        g.zoomBlur = 0;
        g.streak = 0;
        g.orbActive = false;
      } else {
        const kFast = 1 - Math.exp(-dt / 95);
        const kMed = 1 - Math.exp(-dt / 150);
        g.scrollY += (0 - g.scrollY) * kFast;
        g.bulge += (g.targetBulge - g.bulge) * kMed;
        g.rotZ += (g.targetRotZ - g.rotZ) * kMed;
        g.zoomBlur = Math.max(0, g.zoomBlur - dt / 210);

        if (g.orbActive) {
          const t = now - g.orbStart;
          if (t < 640) {
            // 0..300ms: rapid rotateY spin (`-2*PI -> ~ -0.7*PI`), peak smear & shaded orb;
            // 300..640ms: decelerate smoothly straight to `rotY = 0` facing front!
            const p = t / 640;
            const easeOut = 1 - Math.pow(1 - p, 3);
            g.rotY = -Math.PI * 2 * (1 - easeOut);
            g.orb = p < 0.48 ? Math.min(1, p / 0.16) : Math.max(0, 1 - (p - 0.48) / 0.44);
            g.smear = p < 0.44 ? Math.min(1, p / 0.14) : Math.max(0, 1 - (p - 0.44) / 0.38);
            // Trailing curved white arc at 4-5 o'clock emerges as orb decelerates (`00:12`).
            g.streak = p > 0.55 ? Math.sin(((p - 0.55) / 0.45) * Math.PI * 0.5) * 0.95 : 0;
          } else {
            g.orbActive = false;
            g.rotY = 0;
            g.orb = 0;
            g.smear = 0;
            g.streak = Math.max(0, g.streak - dt / 460);
          }
        } else {
          g.streak = Math.max(0, g.streak - dt / 520);
        }
      }

      gl.uniform2f(U.res, el.width, el.height);
      gl.uniform1f(U.scrollY, g.scrollY);
      gl.uniform1f(U.bulge, g.bulge);
      gl.uniform1f(U.rotY, g.rotY);
      gl.uniform1f(U.rotZ, g.rotZ);
      gl.uniform1f(U.orb, g.orb);
      gl.uniform1f(U.smear, g.smear);
      gl.uniform1f(U.zoomBlur, g.zoomBlur);
      gl.uniform1f(U.streak, g.streak);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // Stop ticking once all springs and rim streaks have come to rest.
      if (
        !g.orbActive &&
        Math.abs(g.scrollY) < 0.002 &&
        Math.abs(g.bulge - g.targetBulge) < 0.004 &&
        Math.abs(g.rotZ - g.targetRotZ) < 0.003 &&
        g.zoomBlur < 0.005 &&
        g.streak < 0.005
      ) {
        g.settled = true;
      }
    };

    const onContextLost = (e: Event) => {
      e.preventDefault();
      fallbackRef.current();
    };
    el.addEventListener("webglcontextlost", onContextLost);

    const unsub = subscribeFrame(draw, 30);
    return () => {
      unsub();
      el.removeEventListener("webglcontextlost", onContextLost);
      window.removeEventListener("resize", resize);
      gl.deleteTexture(tex);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    };
  }, []);

  return <canvas ref={canvasRef} className={`orbit-canvas${state.dimmed ? " dimmed" : ""}`} aria-hidden="true" />;
}

// ---------- Tumble cluster (CSS Z-roll: `-14deg` -> `-86deg` drop + pill / tilted pair) ----------

function OrbitTumble({ words, count, seed, seq }: { words: string[]; count: number; seed: number; seq: number }) {
  const r = seeded(seed * 41 + 3);
  const styleKind = seq % 8 === 2 ? "spinOut" : "tiltPair";
  const shownWords = words.slice(0, count);

  return (
    <div className="orbit-tumble cur" key={seq}>
      {shownWords.map((w, i) => {
        const isLast = i === count - 1;
        const text = w;
        const width = wordWidthEm(text, 0.25).toFixed(2);

        if (styleKind === "spinOut") {
          // Video 3 `00:05 -> 00:06`: Word 0 (`Call`) enters at -14deg, then drops down & tumbles
          // counter-clockwise to -86deg sideways as newer words (`my`, `na`) stack above it!
          let oy = "0vh";
          let rz = "-14deg";
          let sc = 1;
          let op = 1;
          let color = ORBIT_CREAM;
          const isPill = count >= 3 && i === 2 && words.length >= 3 && r() < 0.45;
          const isItalic = isPill ? false : count >= 3 && i === 2 && !isPill;

          if (i === 0 && count === 1) {
            oy = "0vh";
            rz = "-14deg";
            color = ORBIT_CREAM;
          } else if (i === 0 && count >= 2) {
            oy = count >= 3 ? "16.5vh" : "14vh";
            rz = "-86deg";
            sc = 0.54;
            op = 0.85;
            color = ORBIT_CREAM;
          } else if (i === 1) {
            oy = count === 2 ? "-4vh" : "0vh";
            rz = count === 2 ? "-6deg" : "-3deg";
            sc = 0.92;
            color = ORBIT_CORAL;
          } else if (i >= 2) {
            oy = `${-13.5 - (i - 2) * 11}vh`;
            rz = isPill ? "0deg" : "-4deg";
            sc = i === count - 1 ? 1 : 0.88;
            color = isPill ? ORBIT_CREAM : ORBIT_RED;
          }

          return (
            <p
              key={i}
              className={`orbit-tw ${i === 0 || isLast ? "hero" : "med"}${isPill ? " pill" : ""}${isItalic ? " italic" : ""}`}
              style={{ "--oy": oy, "--rz": rz, "--sc": sc, "--op": op, "--oc": color, "--obg": ORBIT_PILL_BG, "--w": width } as CSSProperties}
            >
              {text}
            </p>
          );
        }

        // Video 3 `00:07` / `00:10`: crisp -16deg tilted stack (`ki / I`), flipping upright
        // with an orange-red highlight pill on the final word (`[baby] / So`).
        const done = count === words.length && words.length >= 2;
        const pos = count - 1 - i;
        const isPill = done && i === 0;
        const tilt = done ? "0deg" : "-16deg";
        const oy = `${(pos - (count - 1) / 2) * -13}vh`;
        const color = isPill ? ORBIT_CREAM : done && i === count - 1 ? ORBIT_GOLD : isLast ? ORBIT_CREAM : ORBIT_CORAL;

        return (
          <p
            key={i}
            className={`orbit-tw ${isLast ? "hero" : "med"}${isPill ? " pill" : ""}${done && !isPill ? " italic" : ""}`}
            style={{ "--oy": oy, "--rz": tilt, "--sc": isLast ? 1 : 0.86, "--op": 1, "--oc": color, "--obg": ORBIT_PILL_BG, "--w": width } as CSSProperties}
          >
            {text}
          </p>
        );
      })}
    </div>
  );
}

// ---------- Fallback if WebGL context is unavailable ----------

function OrbitFallback({ words, count }: { words: string[]; count: number }) {
  return (
    <div className="orbit-fallback">
      {words.slice(0, count).map((w, i) => (
        <span
          key={i}
          className={`orbit-fb-w${i === count - 1 ? " on" : ""}`}
          style={{ "--oc": i === count - 1 ? ORBIT_RED : ORBIT_CREAM, "--w": wordWidthEm(w, 0.2).toFixed(2) } as CSSProperties}
        >
          {w}
        </span>
      ))}
    </div>
  );
}

// ---------- Top-level Orbit component ----------

export function Orbit({ lines, index, sung }: StyleProps) {
  const flat = useMemo(() => flatten(lines), [lines]);
  const groups = useMemo(() => lines.map((l) => groupSizes(l.words.length, 3)), [lines]);
  const [glFailed, setGlFailed] = useState(false);
  const handleFallback = useCallback(() => setGlFailed(true), []);

  const cur = currentWord(flat.start, index, sung);
  const ref = resolveOrbitGroup(lines, groups, flat.start, flat.words, cur);
  if (!ref) return <section className="ly ly-orbit" />;

  const mode = modeFor(ref.seq);
  const mood = moodFor(mode, ref.seq);
  // Next/previous tail words to wrap subtly near bottom rim in sphere scroll.
  const tail: string[] = [];
  if (cur + 1 < flat.words.length) tail.push(shown(flat.words[cur + 1].text));

  const globeState: GlobeState = {
    mode: mode === "tumble" ? "sphere" : mode,
    words: ref.words,
    count: ref.count,
    seed: ref.line * 131 + ref.group * 17,
    triggerId: ref.triggerId,
    wrappedTail: tail,
    dimmed: mode === "tumble",
  };

  return (
    <section className="ly ly-orbit">
      <div className={`orbit-glow ${mood}`} aria-hidden="true" />
      {!glFailed && <OrbitGlobeCanvas state={globeState} onFallback={handleFallback} />}
      {mode === "tumble" && <OrbitTumble words={ref.words} count={ref.count} seed={ref.line * 71 + ref.group} seq={ref.seq} />}
      {glFailed && mode !== "tumble" && <OrbitFallback words={ref.words} count={ref.count} />}
    </section>
  );
}
