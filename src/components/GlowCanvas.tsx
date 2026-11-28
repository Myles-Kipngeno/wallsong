import { useEffect, useRef, useState } from "react";
import type { Settings } from "../lib/settings";
import { EdgeGlow } from "./EdgeGlow";
import { beat } from "../lib/beat";
import { colorToRgb } from "../lib/palette";
import { subscribeFrame } from "../lib/frame";

/**
 * The edge glow, drawn by the graphics card.
 *
 * "flame": a thick band whose inner edge is shaped by moving noise, white-hot at
 * the screen edge and fading into the album colours, with sparks drifting off it.
 * "smooth": an even soft band with a bright line at the edge.
 * "chase": a thin bright line hugging the edge with a warm haze, lit only where
 * a few lights ("comets") travel around the frame; the rest stays dim.
 * Depth, brightness and churn follow the bass (--level) and kick (--flash).
 */

/** Settings > Glow description of each style. */
export const GLOW_STYLE_HINTS: Record<"flame" | "smooth" | "chase", string> = {
  flame: "A thick flame with a ragged moving edge, white-hot at the screen edge",
  smooth: "An even soft band with a bright line at the edge",
  chase: "Lights travel around the edge",
};

const STYLE_ID = { flame: 0, smooth: 1, chase: 2 } as const;

/** Chase: how far (in laps of the screen edge) every light jumps forward on a kick. */
const KICK_JUMP = 0.025;
/** Chase: the jump plays out over roughly this long (ms), so it reads as a jump, not a teleport. */
const KICK_EASE_MS = 60;

const VERT = `
attribute vec2 a;
void main() { gl_Position = vec4(a, 0.0, 1.0); }
`;

const FRAG = `
precision mediump float;
uniform vec2 uRes;
uniform float uTime, uLevel, uFlash, uThick, uIntensity, uMotion, uStyle, uSparks, uComets, uKickOffset;
uniform vec3 uC1, uC2, uC3;

// Album colours around a loop: 0..1 runs c1 -> c2 -> c3 -> c1.
vec3 paletteAt(float k01) {
  float k = fract(k01) * 3.0;
  return k < 1.0 ? mix(uC1, uC2, k) : (k < 2.0 ? mix(uC2, uC3, k - 1.0) : mix(uC3, uC1, k - 2.0));
}

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  for (int i = 0; i < 3; i++) { v += a * noise(p); p = p * 2.03 + 7.1; a *= 0.5; }
  return v;
}

void main() {
  float aspect = uRes.x / uRes.y;
  vec2 uv = gl_FragCoord.xy / uRes;
  vec2 p = vec2(uv.x * aspect, uv.y);
  // Distance to the nearest screen edge, in screen heights.
  float dx = min(p.x, aspect - p.x);
  float dy = min(p.y, 1.0 - p.y);
  // Smooth minimum of the two: rounds the corners instead of a hard diagonal seam.
  float ks = 45.0;
  float d = -log(exp(-ks * dx) + exp(-ks * dy)) / ks;
  d = max(d, 0.0);

  if (uStyle > 1.5) {
    // ---- Chase ----
    float maxChaseReach = (0.035 + 0.03 * uLevel) * uThick * 4.5 + 0.015;
    if (d > maxChaseReach) { gl_FragColor = vec4(0.0); return; }
    // Position around the frame, 0..1 clockwise from the top-left corner, taken
    // from the nearest edge. P is the perimeter in screen heights.
    float P = 2.0 * aspect + 2.0;
    float dTop = 1.0 - p.y, dRight = aspect - p.x, dBottom = p.y, dLeft = p.x;
    float m = min(min(dTop, dRight), min(dBottom, dLeft));
    float s;
    if (m == dTop) s = p.x / P;
    else if (m == dRight) s = (aspect + (1.0 - p.y)) / P;
    else if (m == dBottom) s = (aspect + 1.0 + (aspect - p.x)) / P;
    else s = (2.0 * aspect + 1.0 + p.y) / P;

    // Lights: a short bright head and a long fading tail. Each next light runs at
    // 0.65x the speed of the one before, the other way round.
    float lit = 0.0;
    float head = 0.0;
    float speed = 0.07 * uMotion;
    float dir = 1.0;
    for (int i = 0; i < 3; i++) {
      if (float(i) >= uComets) break;
      float h = fract(dir * (uTime * speed + uKickOffset) + float(i) / uComets);
      float b = fract(dir * (h - s)); // distance behind the head, along the direction of travel
      float c = smoothstep(0.0, 0.02, b) * (1.0 - smoothstep(0.02, 0.32, b));
      if (c > lit) { lit = c; head = h; }
      speed *= 0.65;
      dir = -dir;
    }
    lit = max(lit, 0.12); // the frame never goes fully dark

    float line = exp(-d / (0.0025 * uThick));
    float spill = exp(-d / ((0.035 + 0.03 * uLevel) * uThick)) * 0.55;
    float alpha = (line * 0.95 + spill) * lit * uIntensity;
    alpha *= 1.0 + 0.45 * uFlash;

    vec3 tint = mix(paletteAt(head), vec3(1.0, 0.45, 0.15), 0.25);
    tint = mix(tint, vec3(1.0, 0.85, 0.7), line * 0.6);
    alpha = clamp(alpha, 0.0, 1.0);
    gl_FragColor = vec4(tint * alpha, alpha);
    return;
  }

  float beat = uLevel * 0.8 + uFlash * 0.5;
  // Top and bottom burn a little deeper than the sides, like the videos.
  float edgeBias = mix(0.85, 1.3, smoothstep(-0.03, 0.03, dx - dy));
  float depth = (0.042 + 0.025 * beat) * uThick * edgeBias;
  float maxReach = depth * (uStyle < 0.5 ? 2.6 : 3.0);
  if (d > maxReach) { gl_FragColor = vec4(0.0); return; }

  float t = uTime * (0.25 + 0.75 * uMotion);
  float shape = 1.0;
  if (uStyle < 0.5) {
    // Flame: noise pushes the inner edge in and out; it rises along the edge over time.
    vec2 q = p * 5.5 + vec2(t * 0.35, -t * 0.9);
    float n = fbm(q + fbm(q * 0.7 - t * 0.2));
    shape = 0.45 + 1.2 * n;
  }
  float reach = depth * shape;
  float core = 1.0 - smoothstep(0.0, reach, d);
  float haze = exp(-d / max(0.0001, reach * 0.6)) * 0.5;
  if (uStyle >= 0.5) {
    float line = exp(-d / (0.004 * uThick));
    core = line * 0.9 + (1.0 - smoothstep(0.0, depth * 1.4, d)) * 0.35;
    haze = exp(-d / (depth * 0.9)) * 0.45;
  }

  // Colour runs around the frame and slowly turns.
  float ang = atan(p.y - 0.5, p.x - aspect * 0.5) / 6.2831853 + 0.5 + t * 0.03;
  vec3 col = paletteAt(ang);
  // White-hot right at the edge.
  float heat = pow(core, 1.6) * (0.7 + 0.3 * beat);
  col = mix(col, vec3(1.0, 0.96, 0.9), clamp(heat, 0.0, 0.85));

  float a = clamp(core * 0.95 + haze, 0.0, 1.0);

  // Sparks: a few bright points drifting inward from the edge.
  if (uSparks > 0.5 && uStyle < 0.5) {
    vec2 cell = floor(p * 38.0 + vec2(0.0, -t * 2.0));
    vec2 f = fract(p * 38.0 + vec2(0.0, -t * 2.0));
    float r = hash(cell);
    if (r > 0.93) {
      vec2 c = vec2(hash(cell + 3.1), hash(cell + 7.7));
      float dot = smoothstep(0.12, 0.0, length(f - c));
      float zone = 1.0 - smoothstep(depth * 0.6, depth * 2.6, d);
      float flicker = 0.5 + 0.5 * sin(uTime * 9.0 + r * 40.0);
      a = max(a, dot * zone * flicker);
      col = mix(col, vec3(1.0, 0.9, 0.75), dot * zone);
    }
  }

  a *= clamp(uIntensity * (0.75 + 0.35 * beat), 0.0, 1.6);
  a = clamp(a, 0.0, 1.0);
  gl_FragColor = vec4(col * a, a);
}
`;

const hexToRgb = (color: string) => colorToRgb(color) ?? [1, 0.4, 0.6];

function compile(gl: WebGLRenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)!;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "shader failed");
  return shader;
}

/** Glow drawn at this fraction of screen resolution: it's soft, so 0.35 is plenty and saves the GPU. */
const RENDER_SCALE = 0.35;

export function GlowCanvas({ settings, palette }: { settings: Settings["glow"]; palette: string[] }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [failed, setFailed] = useState(false);
  const live = useRef({ settings, palette });
  live.current = { settings, palette };

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const gl = el.getContext("webgl", { premultipliedAlpha: true, alpha: true, antialias: false });
    if (!gl) {
      setFailed(true);
      return;
    }
    let program: WebGLProgram;
    let vs: WebGLShader | null = null;
    let fs: WebGLShader | null = null;
    try {
      program = gl.createProgram()!;
      vs = compile(gl, gl.VERTEX_SHADER, VERT);
      fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
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
    } catch (e) {
      if (vs) gl.deleteShader(vs);
      if (fs) gl.deleteShader(fs);
      console.warn("Glow shader unavailable, using the simple glow:", e);
      setFailed(true);
      return;
    }
    gl.useProgram(program);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(program, "a");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const u = (name: string) => gl.getUniformLocation(program, name);
    const U = {
      res: u("uRes"), time: u("uTime"), level: u("uLevel"), flash: u("uFlash"), thick: u("uThick"),
      intensity: u("uIntensity"), motion: u("uMotion"), style: u("uStyle"), sparks: u("uSparks"),
      comets: u("uComets"), kickOffset: u("uKickOffset"),
      c1: u("uC1"), c2: u("uC2"), c3: u("uC3"),
    };

    const resize = () => {
      el.width = Math.max(2, Math.round(window.innerWidth * RENDER_SCALE));
      el.height = Math.max(2, Math.round(window.innerHeight * RENDER_SCALE));
      gl.viewport(0, 0, el.width, el.height);
    };
    resize();
    window.addEventListener("resize", resize);

    const start = performance.now();
    let lastNow = start;
    let lastFlash = 0;
    let lastDraw = 0;
    // Chase: every kick pushes the lights a little further round. `kickTarget` collects
    // the jumps; `kickOffset` catches up with it within a few frames.
    let kickTarget = 0;
    let kickOffset = 0;
    const draw = (now: number) => {
      const { settings: s, palette: pal } = live.current;
      const { level, flash } = beat;
      const isIdle = level < 0.01 && flash < 0.01;
      // When nothing is playing, draw one frame per second
      if (isIdle && now - lastDraw < 1000) return;
      lastDraw = now;

      const dt = Math.min(100, now - lastNow);
      lastNow = now;
      if (flash > lastFlash + 0.3) kickTarget += KICK_JUMP * flash; // a new kick (the flash only rises on kicks)
      lastFlash = flash;
      kickOffset += (kickTarget - kickOffset) * (1 - Math.exp(-dt / KICK_EASE_MS));
      if (kickTarget > 1) {
        // Whole laps change nothing on screen; dropping them keeps the numbers small.
        kickTarget -= 1;
        kickOffset -= 1;
      }
      const colors = s.colors === "custom" ? [s.primary, s.secondary, s.primary] : pal;
      gl.uniform2f(U.res, el.width, el.height);
      gl.uniform1f(U.time, (now - start) / 1000);
      gl.uniform1f(U.level, level);
      gl.uniform1f(U.flash, flash);
      gl.uniform1f(U.thick, s.thickness);
      gl.uniform1f(U.intensity, s.intensity);
      gl.uniform1f(U.motion, s.motion);
      gl.uniform1f(U.style, STYLE_ID[s.style] ?? 0);
      gl.uniform1f(U.sparks, s.sparks ? 1 : 0);
      gl.uniform1f(U.comets, Math.max(1, Math.min(3, Math.round(s.comets))));
      gl.uniform1f(U.kickOffset, kickOffset);
      gl.uniform3fv(U.c1, hexToRgb(colors[0] ?? "#ff3d8b"));
      gl.uniform3fv(U.c2, hexToRgb(colors[1] ?? "#ff9a3d"));
      gl.uniform3fv(U.c3, hexToRgb(colors[2] ?? colors[0] ?? "#b8ff4d"));
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    const onContextLost = (e: Event) => {
      e.preventDefault();
      setFailed(true);
    };
    el.addEventListener("webglcontextlost", onContextLost);

    const unsub = subscribeFrame(draw, 30);
    return () => {
      unsub();
      el.removeEventListener("webglcontextlost", onContextLost);
      window.removeEventListener("resize", resize);
      gl.deleteProgram(program);
      gl.deleteBuffer(buffer);
    };
  }, []);

  if (failed) return <EdgeGlow />;
  return <canvas ref={canvas} className="glow-canvas" aria-hidden="true" />;
}
