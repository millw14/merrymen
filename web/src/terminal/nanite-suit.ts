/*
 * The Spot <-> Perps switch as nanite armour (Canvas 2D, no deps). Scales pour
 * out of the toggle that was pressed. Once the reveal starts, the title and HUD
 * are drawn only on the armour that is left, so nothing of the suit lingers
 * over the new screen. The canvas sits ABOVE the frozen copy of the outgoing
 * screen (see mode-transition-snapshot.ts), and onCovered is the instant the
 * armour is fully opaque: the host hides that frozen copy there, so the reveal
 * uncovers the live destination.
 *
 * Triangular nanite scales spring out of the origin and click into place with
 * squash-and-stretch and sparks, a cheeky HUD rides along, the armour locks
 * (shake + burst ring + optional title stamp), then the scales flip away row by
 * row from the origin like venetian blinds while confetti sparks fly.
 *
 * Every frame is a PURE FUNCTION of (elapsed ms, seed, viewport): nothing is
 * integrated frame to frame, so dropped frames are harmless and drawAt(t) can
 * scrub to any instant. Scratch buffers are allocated once per layout.
 *
 * Null 2D context (jsdom, tests): playNanites does not throw. It returns a
 * timer-only handle that calls onCovered at the cover instant and onDone at
 * `duration` via setTimeout; drawAt is a no-op and cancel() clears the timers.
 */

export type NaniteOptions = {
  canvas: HTMLCanvasElement;
  origin: { x: number; y: number };
  direction: "perps" | "spot";
  dramatic: boolean;
  duration: number;
  seed?: number;
  title?: { top: string; bottom: string; kicker: string };
  onCovered?: () => void;
  onDone?: () => void;
};

export type NaniteHandle = { cancel(): void; drawAt(t: number): void };

/** All phase boundaries in ms for one run. Scaled linearly when `duration` differs from nominal. */
export type NaniteTimeline = {
  duration: number;
  nominal: number;
  k: number;
  coverStart: number;
  popDur: number;
  lastPop: number;
  coveredAt: number;
  shakeDur: number;
  ringDur: number;
  titleAt: number;
  stampDur: number;
  glintStart: number;
  glintEnd: number;
  revealStart: number;
  flipDur: number;
  lastFlip: number;
  hudOut0: number;
  hudOut1: number;
  titleOut0: number;
  titleOut1: number;
  sparkLife: number;
  confettiLife: number;
  charMs: number;
  status: number[];
};

export function naniteTimeline(dramatic: boolean, duration?: number): NaniteTimeline {
  const nominal = dramatic ? 2600 : 950;
  const d = duration && duration > 0 ? duration : nominal;
  const k = d / nominal;
  const T = (ms: number): number => ms * k;
  if (dramatic) {
    const popDur = T(260);
    const coveredAt = T(1180);
    const flipDur = T(250);
    return {
      duration: d, nominal, k,
      coverStart: T(70), popDur, lastPop: coveredAt - popDur - T(6), coveredAt,
      shakeDur: T(240), ringDur: T(420),
      titleAt: T(1200), stampDur: T(280),
      glintStart: T(1430), glintEnd: T(1790),
      revealStart: T(1760), flipDur, lastFlip: d - flipDur - T(70),
      hudOut0: T(1820), hudOut1: T(2160),
      titleOut0: T(1880), titleOut1: T(2230),
      sparkLife: T(300), confettiLife: T(560), charMs: T(20),
      status: [T(140), T(560), T(1200)],
    };
  }
  const popDur = T(115);
  const coveredAt = T(430);
  const flipDur = T(170);
  return {
    duration: d, nominal, k,
    coverStart: 0, popDur, lastPop: coveredAt - popDur - T(4), coveredAt,
    shakeDur: T(150), ringDur: T(260),
    titleAt: -1, stampDur: T(200),
    glintStart: -1, glintEnd: -1,
    revealStart: T(505), flipDur, lastFlip: d - flipDur - T(35),
    hudOut0: T(520), hudOut1: T(650),
    titleOut0: -1, titleOut1: -1,
    sparkLife: T(170), confettiLife: T(300), charMs: T(11),
    status: [T(20), T(440)],
  };
}

// ---------------------------------------------------------------------------
// constants, palettes, maths

const MONO = 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';
const SQ3_2 = 0.8660254037844386;
const TAU = Math.PI * 2;
const PAD = 6; // px of armour beyond each edge so the shake never exposes a seam
const MAX_PLATES = 2300;
const NH = 8; // heat colour levels (buckets 0..7)
const NB = NH + 4; // + 4 cool shades, used only when no offscreen sprite is available
const SEG_B = 9; // additive line buckets: 3 colours x 3 alphas
const SEG_ALPHA = [0.3, 0.6, 1];

type Pal = {
  bg: string;
  plates: [string, string, string, string];
  mid: string;
  hot: string;
  core: string;
  alt: string;
};

const PERPS: Pal = {
  bg: "#0c1009",
  plates: ["#141a10", "#1a2115", "#222a1b", "#2b3423"],
  mid: "#7e953b",
  hot: "#d2f653",
  core: "#fcffe7",
  alt: "#a9c94a",
};

const SPOT: Pal = {
  bg: "#070806",
  plates: ["#0d100b", "#14170f", "#1c1f16", "#25281e"],
  mid: "#66736f",
  hot: "#e5e9d8",
  core: "#fbfcf4",
  alt: "#aebdbd",
};

const DEFAULT_TITLES = {
  perps: { top: "TACTICAL", bottom: "RADAR", kicker: "02 / PERPETUALS" },
  spot: { top: "THE", bottom: "CAMP", kicker: "01 / SPOT" },
};

const STATUS = {
  perps: { dramatic: ["DEPLOYING NANITES", "LOCKING PLATES", "RADAR ONLINE"], quick: ["DEPLOYING NANITES", "RADAR ONLINE"] },
  spot: { dramatic: ["STANDING DOWN", "FOLDING PLATES", "BACK TO CAMP"], quick: ["STANDING DOWN", "BACK TO CAMP"] },
};

const PCT: string[] = [];
for (let i = 0; i <= 100; i++) PCT.push((i < 10 ? "00" : i < 100 ? "0" : "") + i + "%");

function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function rgbOf(hex: string): [number, number, number] {
  const v = parseInt(hex.slice(1), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

function mix(a: string, b: string, k: number, alpha = 1): string {
  const A = rgbOf(a);
  const B = rgbOf(b);
  const q = k < 0 ? 0 : k > 1 ? 1 : k;
  const r = Math.round(A[0] + (B[0] - A[0]) * q);
  const g = Math.round(A[1] + (B[1] - A[1]) * q);
  const bl = Math.round(A[2] + (B[2] - A[2]) * q);
  return alpha >= 1 ? `rgb(${r},${g},${bl})` : `rgba(${r},${g},${bl},${alpha})`;
}

function heatColor(p: Pal, h: number): string {
  if (h < 0.35) return mix(p.plates[3], p.mid, h / 0.35);
  if (h < 0.7) return mix(p.mid, p.hot, (h - 0.35) / 0.35);
  return mix(p.hot, p.core, (h - 0.7) / 0.3);
}

const clamp01 = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x);
const smooth01 = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
const easeOutCubic = (x: number): number => {
  const a = 1 - clamp01(x);
  return 1 - a * a * a;
};

/** Springy 0 -> 1 with ~20% overshoot at u~0.3, settled by u~0.6, exactly 1 at u=1. */
function spring(u: number): number {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  const a = 1 - u;
  return 1 - a * a * a * a * Math.cos(3 * Math.PI * u);
}

/** Rubber-stamp scale: starts 2.25x, slams to 1 at u=0.2, squashes to ~0.84, settles. */
function stamp(u: number): number {
  if (u >= 1) return 1;
  const a = 1 - u;
  return 1 + 1.25 * a * a * a * a * Math.cos(2.5 * Math.PI * u);
}

// ---------------------------------------------------------------------------
// sizing (shared by the engine and naniteBudget)

type Grid = { s: number; rowH: number; r0: number; rows: number; x0: number; cols: number };

function grid(w: number, h: number, s: number): Grid {
  const rowH = s * SQ3_2;
  const r0 = Math.floor(-PAD / rowH);
  const r1 = Math.ceil((h + PAD) / rowH) - 1;
  const x0 = -PAD - s / 2;
  const cols = Math.ceil((w + 2 * PAD) / (s / 2)) + 1;
  return { s, rowH, r0, rows: r1 - r0 + 1, x0, cols };
}

function sizing(w: number, h: number): Grid {
  let s = Math.min(w, h) < 600 ? 31 : 38;
  let g = grid(w, h, s);
  for (let i = 0; i < 80 && g.rows * g.cols > MAX_PLATES; i++) {
    s *= 1.04;
    g = grid(w, h, s);
  }
  return g;
}

function particleScale(w: number, h: number, dramatic: boolean): number {
  const a = (w * h) / (1440 * 900);
  return (a < 0.3 ? 0.3 : a > 1 ? 1 : a) * (dramatic ? 1 : 0.8);
}

/** Counts the engine will use for a viewport (for perf notes / tests). */
export function naniteBudget(w: number, h: number, dramatic: boolean) {
  const g = sizing(w, h);
  const ps = particleScale(w, h, dramatic);
  const stream = Math.round(380 * ps);
  const sparks = Math.round(520 * ps);
  const confetti = Math.round(460 * ps);
  return { side: Math.round(g.s * 10) / 10, plates: g.rows * g.cols, stream, sparks, confetti, particles: stream + sparks + confetti };
}

// ---------------------------------------------------------------------------
// offscreen helpers

function makeCanvas(w: number, h: number): HTMLCanvasElement | null {
  if (typeof document === "undefined" || !document.createElement) return null;
  try {
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.ceil(w));
    c.height = Math.max(1, Math.ceil(h));
    return c;
  } catch {
    return null;
  }
}

function ctxOf(c: HTMLCanvasElement | null): CanvasRenderingContext2D | null {
  if (!c) return null;
  try {
    return c.getContext("2d");
  } catch {
    return null;
  }
}

function resolveFont(el: Element, cssVar: string, fallback: string): string {
  try {
    if (typeof getComputedStyle !== "function") return fallback;
    const v = getComputedStyle(el).getPropertyValue(cssVar).trim();
    return v ? `${v}, ${fallback}` : fallback;
  } catch {
    return fallback;
  }
}

type Sprite = { c: HTMLCanvasElement; w: number; h: number };

/** Pre-rendered title line: glow + offset "ink" copy + face. Built once per layout (shadowBlur is fine here). */
function textSprite(
  text: string, px: number, family: string, face: string, ink: string, glow: string,
  dpr: number, spacing: number,
): Sprite | null {
  const probe = ctxOf(makeCanvas(4, 4));
  if (!probe) return null;
  const font = `800 ${px}px ${family}`;
  probe.font = font;
  let tw = 0;
  for (let i = 0; i < text.length; i++) tw += probe.measureText(text[i]).width + (i < text.length - 1 ? spacing : 0);
  const padX = px * 0.35;
  const padY = px * 0.45;
  const w = tw + padX * 2;
  const h = px * 1.1 + padY * 2;
  const c = makeCanvas(w * dpr, h * dpr);
  const g = ctxOf(c);
  if (!c || !g) return null;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.font = font;
  g.textBaseline = "middle";
  g.textAlign = "left";
  const draw = (dx: number, dy: number, color: string) => {
    let x = padX + dx;
    for (let i = 0; i < text.length; i++) {
      g.fillStyle = color;
      g.fillText(text[i], x, h / 2 + dy);
      x += g.measureText(text[i]).width + spacing;
    }
  };
  const off = Math.max(2, px * 0.045);
  g.shadowColor = glow;
  g.shadowBlur = px * 0.35;
  draw(0, 0, glow);
  g.shadowBlur = 0;
  g.shadowColor = "transparent";
  draw(off, off, ink);
  draw(0, 0, face);
  return { c, w, h };
}

function glowSprite(p: Pal): HTMLCanvasElement | null {
  const c = makeCanvas(128, 128);
  const g = ctxOf(c);
  if (!c || !g) return null;
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, mix(p.core, p.core, 0, 1));
  grad.addColorStop(0.16, mix(p.hot, p.core, 0.4, 0.9));
  grad.addColorStop(0.42, mix(p.hot, p.hot, 0, 0.28));
  grad.addColorStop(1, mix(p.hot, p.hot, 0, 0));
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  return c;
}

// ---------------------------------------------------------------------------
// layout (rebuilt only on resize)

type Layout = {
  w: number; h: number; dpr: number; s: number; n: number;
  ox: number; oy: number; mx: number; my: number; ringMax: number; sizeK: number; small: boolean;
  cols: number; r0: number; x0: number; rowH: number; up: Uint8Array;
  cx: Float32Array; cy: Float32Array; off: Float32Array;
  ux: Float32Array; uy: Float32Array; pop: Float32Array; flip: Float32Array;
  dC: Float32Array; gd: Float32Array; spin: Float32Array; side: Float32Array; shade: Uint8Array;
  dEffMax: number;
  // stream particles
  nS: number; sEmit: Float32Array; sCos: Float32Array; sSin: Float32Array; sSpeed: Float32Array;
  sMod: Float32Array; sLen: Float32Array; sPh: Float32Array; sWob: Float32Array; sCol: Uint8Array;
  // pop sparks
  nK: number; kPlate: Int32Array; kCos: Float32Array; kSin: Float32Array; kSpeed: Float32Array; kLife: Float32Array; kCol: Uint8Array;
  // confetti
  nC: number; cPlate: Int32Array; cSpawn: Float32Array; cLife: Float32Array; cVx: Float32Array; cVy: Float32Array;
  cSpin: Float32Array; cTumble: Float32Array; cPh: Float32Array; cSize: Float32Array; cCol: Uint8Array; cG: number;
  // per-frame scratch (allocated once here)
  verts: Float32Array; mask: Int32Array; under: Int32Array; outl: Int32Array;
  bList: Int32Array[]; bCount: Int32Array;
  seg: Float32Array[]; segCount: Int32Array; quad: Float32Array[]; quadCount: Int32Array;
  // sprites
  armour: HTMLCanvasElement | null;
  titles: (Sprite | null)[];
  // HUD metrics
  m: number; fLabel: string; fBig: string; fLine: string; fTiny: string; fQuick: string; linePx: number; charW: number;
  panelX: number; panelY: number; panelW: number; panelH: number; quickW: number; bracket: number;
};

type Ctx = {
  pal: Pal; tl: NaniteTimeline; dramatic: boolean; seed: number; origin: { x: number; y: number };
  mono: string; display: string; title: { top: string; bottom: string; kicker: string };
};

function buildLayout(w: number, h: number, dpr: number, C: Ctx, measure: CanvasRenderingContext2D): Layout {
  const { tl, pal, dramatic } = C;
  const g = sizing(w, h);
  const s = g.s;
  const n = g.rows * g.cols;
  const rng = mulberry32((C.seed ^ 0x9e3779b9) >>> 0);
  const ox = Number.isFinite(C.origin.x) ? Math.min(w, Math.max(0, C.origin.x)) : w / 2;
  const oy = Number.isFinite(C.origin.y) ? Math.min(h, Math.max(0, C.origin.y)) : 0;
  const mx = w / 2;
  const my = h / 2;
  const small = Math.min(w, h) < 600;

  const cx = new Float32Array(n), cy = new Float32Array(n);
  const off = new Float32Array(n * 6);
  const ux = new Float32Array(n), uy = new Float32Array(n);
  const pop = new Float32Array(n), flip = new Float32Array(n);
  const dC = new Float32Array(n), gd = new Float32Array(n);
  const spin = new Float32Array(n), side = new Float32Array(n);
  const shade = new Uint8Array(n);
  const up = new Uint8Array(n);
  const dEff = new Float32Array(n), rowY = new Float32Array(n);

  // tendril modulation of the wave front: the suit "pours" faster along a few lobes
  const ph1 = rng() * TAU, ph2 = rng() * TAU, ph3 = rng() * TAU;
  const modAt = (th: number): number =>
    1 + 0.14 * Math.sin(3 * th + ph1) + 0.08 * Math.sin(5 * th + ph2) + 0.05 * Math.sin(9 * th + ph3);

  const rin = s / (2 * Math.sqrt(3));
  const gap = Math.max(0.8, s * 0.03);
  const inset = (rin - gap) / rin;
  let dEffMax = 1e-6;
  let i = 0;
  const vx = [0, 0, 0], vy = [0, 0, 0];
  for (let r = 0; r < g.rows; r++) {
    const rr = g.r0 + r;
    const y0 = rr * g.rowH;
    const y1 = y0 + g.rowH;
    for (let k = 0; k < g.cols; k++, i++) {
      const xL = g.x0 + (k * s) / 2;
      const isUp = ((k + rr) & 1) === 0;
      // vertex order: up = [BL, BR, apex]; down = [TR, TL, bottom] (same winding for both)
      vx[2] = xL + s / 2;
      if (isUp) { vx[0] = xL; vx[1] = xL + s; vy[0] = y1; vy[1] = y1; vy[2] = y0; }
      else { vx[0] = xL + s; vx[1] = xL; vy[0] = y0; vy[1] = y0; vy[2] = y1; }
      const ccx = xL + s / 2;
      const ccy = isUp ? y0 + (2 / 3) * g.rowH : y0 + g.rowH / 3;
      cx[i] = ccx; cy[i] = ccy; up[i] = isUp ? 1 : 0;
      for (let v = 0; v < 3; v++) {
        off[i * 6 + v * 2] = (vx[v] - ccx) * inset;
        off[i * 6 + v * 2 + 1] = (vy[v] - ccy) * inset;
      }
      const dx = ccx - ox, dy = ccy - oy;
      const d = Math.hypot(dx, dy);
      if (d > 0.5) { ux[i] = dx / d; uy[i] = dy / d; } else { ux[i] = 0; uy[i] = 1; }
      dEff[i] = d * modAt(Math.atan2(dy, dx));
      if (dEff[i] > dEffMax) dEffMax = dEff[i];
      rowY[i] = y0 + g.rowH / 2;
      dC[i] = Math.hypot(ccx - mx, ccy - my);
      gd[i] = (ccx * 0.8 + ccy) / (w * 0.8 + h);
      spin[i] = (rng() < 0.5 ? -1 : 1) * (0.6 + 0.8 * rng());
      side[i] = dx < 0 ? -1 : 1;
      shade[i] = (isUp ? 2 : 0) + (rng() < 0.5 ? 0 : 1);
    }
  }

  // cover schedule: distance (with tendrils) from origin + jitter; farthest plate pops at lastPop
  const popSpan = tl.lastPop - tl.coverStart;
  let gMax = 1e-6;
  for (let j = 0; j < n; j++) {
    const q = clamp01(dEff[j] / dEffMax + (rng() - 0.5) * 0.07);
    pop[j] = tl.coverStart + popSpan * q;
    const gv = Math.abs(rowY[j] - oy) + 0.3 * Math.abs(cx[j] - ox);
    if (gv > gMax) gMax = gv;
    dEff[j] = gv; // reuse as reveal key
  }
  // reveal schedule: rows outward from the origin's row, V-shaped around origin x (stadium wave)
  const flipSpan = tl.lastFlip - tl.revealStart;
  for (let j = 0; j < n; j++) {
    flip[j] = tl.revealStart + flipSpan * clamp01(dEff[j] / gMax + (rng() - 0.5) * 0.025);
  }

  const sizeK = Math.min(1.4, Math.max(0.5, Math.min(w, h) / 900));
  const ps = particleScale(w, h, dramatic);

  // stream particles: nanites rushing from the emitter to the wave front
  const nS = Math.round(380 * ps);
  const sEmit = new Float32Array(nS), sCos = new Float32Array(nS), sSin = new Float32Array(nS);
  const sSpeed = new Float32Array(nS), sMod = new Float32Array(nS), sLen = new Float32Array(nS);
  const sPh = new Float32Array(nS), sWob = new Float32Array(nS), sCol = new Uint8Array(nS);
  const frontV = dEffMax / Math.max(1, popSpan);
  for (let j = 0; j < nS; j++) {
    sEmit[j] = tl.coverStart + popSpan * rng();
    const th = Math.atan2(rng() * h - oy, rng() * w - ox);
    sCos[j] = Math.cos(th); sSin[j] = Math.sin(th);
    sMod[j] = modAt(th);
    sSpeed[j] = (frontV * (1.5 + 1.2 * rng())) / sMod[j];
    sLen[j] = (8 + 26 * rng()) * sizeK;
    sPh[j] = rng() * TAU;
    sWob[j] = (1 + 3 * rng()) * sizeK;
    sCol[j] = rng() < 0.25 ? 1 : 0;
  }

  // pop sparks: a subset of scales throw a spark as they click in
  const nK = Math.round(520 * ps);
  const kPlate = new Int32Array(nK), kCos = new Float32Array(nK), kSin = new Float32Array(nK);
  const kSpeed = new Float32Array(nK), kLife = new Float32Array(nK), kCol = new Uint8Array(nK);
  const kFast = dramatic ? 1 : 1.5;
  for (let j = 0; j < nK; j++) {
    const p = Math.floor(rng() * n);
    kPlate[j] = p;
    const a = Math.atan2(uy[p], ux[p]) + (rng() - 0.5) * 1.4;
    kCos[j] = Math.cos(a); kSin[j] = Math.sin(a);
    kSpeed[j] = (0.12 + 0.38 * rng()) * sizeK * kFast;
    kLife[j] = tl.sparkLife * (0.5 + 0.5 * rng());
    kCol[j] = rng() < 0.5 ? 1 : 0;
  }

  // confetti: flung from flipping scales during the reveal, gone before `duration`
  const nC = Math.round(460 * ps);
  const cPlate = new Int32Array(nC), cSpawn = new Float32Array(nC), cLife = new Float32Array(nC);
  const cVx = new Float32Array(nC), cVy = new Float32Array(nC), cSpin = new Float32Array(nC);
  const cTumble = new Float32Array(nC), cPh = new Float32Array(nC), cSize = new Float32Array(nC);
  const cCol = new Uint8Array(nC);
  const cFast = dramatic ? 1 : 1.45;
  for (let j = 0; j < nC; j++) {
    let p = 0;
    for (let tries = 0; tries < 5; tries++) {
      p = Math.floor(rng() * n);
      if (cx[p] > 0 && cx[p] < w && cy[p] > 0 && cy[p] < h) break;
    }
    cPlate[j] = p;
    cSpawn[j] = flip[p] + tl.flipDur * 0.35;
    const life = Math.min(tl.confettiLife * (0.55 + 0.45 * rng()), tl.duration - 4 - cSpawn[j]);
    cLife[j] = life > 40 * tl.k ? life : 0;
    cVx[j] = ((rng() - 0.5) * 0.36 + side[p] * 0.08) * sizeK * cFast;
    cVy[j] = -(0.18 + 0.42 * rng()) * sizeK * cFast;
    cSpin[j] = (rng() - 0.5) * 0.05;
    cTumble[j] = 0.012 + 0.03 * rng();
    cPh[j] = rng() * TAU;
    cSize[j] = (3.5 + 3 * rng()) * Math.max(0.8, sizeK);
    const cr = rng();
    cCol[j] = cr < 0.45 ? 0 : cr < 0.75 ? 1 : 2;
  }
  const cG = 0.0016 * sizeK * (dramatic ? 1 : 2.1);

  // scratch
  const segCap = (nS + nK + nC) * 4;
  const seg: Float32Array[] = [];
  for (let b = 0; b < SEG_B; b++) seg.push(new Float32Array(segCap));
  const quad: Float32Array[] = [];
  for (let b = 0; b < 3; b++) quad.push(new Float32Array(nC * 8));
  const bList: Int32Array[] = [];
  for (let b = 0; b < NB; b++) bList.push(new Int32Array(n));

  // armour sprite: every settled scale at rest, bevelled, with glowing circuit seams
  const armour = buildArmour(w, h, dpr, n, cx, cy, off, shade, up, pal, rng);

  // HUD metrics
  const m = small ? 14 : 24;
  const linePx = small ? 10 : 11;
  const fLine = `600 ${linePx}px ${C.mono}`;
  measure.font = fLine;
  const charW = measure.measureText("M").width || linePx * 0.6;
  const panelW = Math.min(300, w - 2 * m - 8);
  const panelH = dramatic ? 104 : 0;
  const panelX = small ? (w - panelW) / 2 : w - m - 30 - panelW;
  const panelY = small ? h - m - 44 - panelH : h - m - 30 - panelH;

  const titles: (Sprite | null)[] = [];
  if (dramatic) {
    const t = C.title;
    const longest = Math.max(t.top.length, t.bottom.length, 4);
    const px = Math.max(28, Math.min((w * 0.86) / (longest * 0.64), h * 0.15, 136));
    const kpx = Math.max(10, Math.min(px * 0.17, 18));
    titles.push(textSprite(t.kicker, kpx, C.mono, pal.hot, pal.bg, mix(pal.hot, pal.hot, 0, 0.6), dpr, kpx * 0.35));
    titles.push(textSprite(t.top, px, C.display, pal.core, pal.hot, mix(pal.hot, pal.hot, 0, 0.55), dpr, px * 0.02));
    titles.push(textSprite(t.bottom, px, C.display, pal.hot, mix(pal.bg, pal.plates[3], 0.5), mix(pal.hot, pal.hot, 0, 0.7), dpr, px * 0.02));
  }

  return {
    w, h, dpr, s, n, ox, oy, mx, my, ringMax: Math.hypot(mx, my) + s * 2, sizeK, small,
    cols: g.cols, r0: g.r0, x0: g.x0, rowH: g.rowH, up,
    cx, cy, off, ux, uy, pop, flip, dC, gd, spin, side, shade, dEffMax,
    nS, sEmit, sCos, sSin, sSpeed, sMod, sLen, sPh, sWob, sCol,
    nK, kPlate, kCos, kSin, kSpeed, kLife, kCol,
    nC, cPlate, cSpawn, cLife, cVx, cVy, cSpin, cTumble, cPh, cSize, cCol, cG,
    verts: new Float32Array(n * 6), mask: new Int32Array(n), under: new Int32Array(n), outl: new Int32Array(n),
    bList, bCount: new Int32Array(NB), seg, segCount: new Int32Array(SEG_B), quad, quadCount: new Int32Array(3),
    armour, titles,
    m, fLabel: `600 ${small ? 9 : 10}px ${C.mono}`, fBig: `800 ${small ? 20 : 24}px ${C.mono}`, fLine,
    fTiny: `600 9px ${C.mono}`, fQuick: `800 15px ${C.mono}`, linePx, charW,
    panelX, panelY, panelW, panelH, quickW: small ? 196 : 214,
    bracket: Math.max(20, Math.min(56, Math.min(w, h) * 0.065)),
  };
}

function buildArmour(
  w: number, h: number, dpr: number, n: number, cx: Float32Array, cy: Float32Array, off: Float32Array,
  shade: Uint8Array, up: Uint8Array, pal: Pal, rng: () => number,
): HTMLCanvasElement | null {
  const c = makeCanvas((w + 2 * PAD) * dpr, (h + 2 * PAD) * dpr);
  const g = ctxOf(c);
  if (!c || !g) return null;
  g.setTransform(dpr, 0, 0, dpr, PAD * dpr, PAD * dpr);
  g.fillStyle = pal.bg;
  g.fillRect(-PAD, -PAD, w + 2 * PAD, h + 2 * PAD);
  const tri = (i: number) => {
    const b = i * 6;
    g.moveTo(cx[i] + off[b], cy[i] + off[b + 1]);
    g.lineTo(cx[i] + off[b + 2], cy[i] + off[b + 3]);
    g.lineTo(cx[i] + off[b + 4], cy[i] + off[b + 5]);
    g.closePath();
  };
  for (let sh = 0; sh < 4; sh++) {
    g.beginPath();
    for (let i = 0; i < n; i++) if (shade[i] === sh) tri(i);
    g.fillStyle = pal.plates[sh];
    g.fill();
  }
  // bevels: lit edge (up: BL->apex, down: TR-TL) and shadow edge (up: BL->BR, down: TR->bottom)
  const edge = (i: number, a: number, b: number) => {
    const o = i * 6;
    g.moveTo(cx[i] + off[o + a * 2], cy[i] + off[o + a * 2 + 1]);
    g.lineTo(cx[i] + off[o + b * 2], cy[i] + off[o + b * 2 + 1]);
  };
  g.lineWidth = 1;
  g.beginPath();
  for (let i = 0; i < n; i++) if (up[i]) edge(i, 0, 2); else edge(i, 0, 1);
  g.strokeStyle = mix(pal.plates[3], pal.hot, 0.16);
  g.stroke();
  g.beginPath();
  for (let i = 0; i < n; i++) if (up[i]) edge(i, 0, 1); else edge(i, 0, 2);
  g.strokeStyle = mix(pal.bg, "#000000", 0.35);
  g.stroke();
  // glowing circuit seams + rivets on a few scales
  g.beginPath();
  for (let i = 0; i < n; i++) if (rng() < 0.05) edge(i, (rng() * 3) | 0, ((rng() * 2) | 0) === 0 ? 1 : 2);
  g.strokeStyle = mix(pal.hot, pal.hot, 0, 0.32);
  g.lineWidth = 1.2;
  g.stroke();
  g.beginPath();
  for (let i = 0; i < n; i++) if (rng() < 0.035) { g.moveTo(cx[i] + 1.3, cy[i]); g.arc(cx[i], cy[i], 1.3, 0, TAU); }
  g.fillStyle = mix(pal.hot, pal.hot, 0, 0.55);
  g.fill();
  // vignette and a soft top light (gradients are fine here: built once per layout)
  const vg = g.createRadialGradient(w / 2, h * 0.42, Math.min(w, h) * 0.15, w / 2, h / 2, Math.hypot(w, h) * 0.62);
  vg.addColorStop(0, mix(pal.bg, pal.bg, 0, 0));
  vg.addColorStop(1, mix(pal.bg, pal.bg, 0, 0.62));
  g.fillStyle = vg;
  g.fillRect(-PAD, -PAD, w + 2 * PAD, h + 2 * PAD);
  const lg = g.createLinearGradient(0, -PAD, 0, h * 0.5);
  lg.addColorStop(0, mix(pal.hot, pal.hot, 0, 0.05));
  lg.addColorStop(1, mix(pal.hot, pal.hot, 0, 0));
  g.fillStyle = lg;
  g.fillRect(-PAD, -PAD, w + 2 * PAD, h * 0.5 + PAD);
  return c;
}

function freeLayout(L: Layout): void {
  if (L.armour) { L.armour.width = 0; L.armour.height = 0; }
  for (const t of L.titles) if (t) { t.c.width = 0; t.c.height = 0; }
}

// ---------------------------------------------------------------------------
// renderer

type Renderer = { render(t: number): void; dispose(): void; clear(): void };

function createRenderer(ctx: CanvasRenderingContext2D, o: NaniteOptions, tl: NaniteTimeline): Renderer {
  const canvas = o.canvas;
  const dir = o.direction === "spot" ? "spot" : "perps";
  const pal = dir === "perps" ? PERPS : SPOT;
  const dramatic = !!o.dramatic;
  const seed = (o.seed ?? 0x5eed1) >>> 0;
  const mono = resolveFont(canvas, "--font-geist-mono", MONO);
  const C: Ctx = {
    pal, tl, dramatic, seed, origin: o.origin || { x: NaN, y: NaN }, mono,
    display: resolveFont(canvas, "--font-geist-pixel", mono),
    title: o.title ?? DEFAULT_TITLES[dir],
  };
  const lines = dramatic ? STATUS[dir].dramatic : STATUS[dir].quick;
  const prefixes: string[][] = lines.map((txt) => {
    const out: string[] = [];
    for (let i = 0; i <= txt.length; i++) out.push("> " + txt.slice(0, i));
    return out;
  });
  const quickPrefixes: string[][] = lines.map((txt) => {
    const out: string[] = [];
    for (let i = 0; i <= txt.length; i++) out.push(txt.slice(0, i));
    return out;
  });

  const heatCols: string[] = [];
  for (let b = 0; b < NH; b++) heatCols.push(heatColor(pal, b / (NH - 1)));
  const bucketCols = heatCols.concat(pal.plates);
  const segCols = [pal.hot, pal.core, pal.alt];
  const quadCols = [pal.hot, pal.core, pal.alt];
  const dim = mix(pal.hot, pal.bg, 0.5);
  const panelFill = mix(pal.bg, pal.bg, 0, 0.82);
  const panelStroke = mix(pal.hot, pal.hot, 0, 0.45);
  const barOff = mix(pal.plates[3], pal.hot, 0.12);
  const suitLabel = dir === "perps" ? "SUIT 02 · PERPS" : "SUIT 01 · SPOT";
  const glow = glowSprite(pal);
  const k = tl.k;
  const impulses = dramatic
    ? [tl.coveredAt, 3.2, tl.titleAt + 50 * k + tl.stampDur * 0.2, 2.2, tl.titleAt + 140 * k + tl.stampDur * 0.2, 1.6]
    : [tl.coveredAt, 2.2];

  let L: Layout | null = null;

  function ensure(): Layout {
    let w = canvas.clientWidth;
    let h = canvas.clientHeight;
    if (!w || !h) {
      w = typeof window !== "undefined" ? window.innerWidth : canvas.width;
      h = typeof window !== "undefined" ? window.innerHeight : canvas.height;
    }
    w = Math.max(1, w);
    h = Math.max(1, h);
    const dpr = Math.min(2, (typeof window !== "undefined" && window.devicePixelRatio) || 1);
    if (L && L.w === w && L.h === h && L.dpr === dpr) return L;
    if (L) freeLayout(L);
    const pw = Math.round(w * dpr);
    const ph = Math.round(h * dpr);
    if (canvas.width !== pw) canvas.width = pw;
    if (canvas.height !== ph) canvas.height = ph;
    L = buildLayout(w, h, dpr, C, ctx);
    // Pre-warm: canvases record draws lazily, so the first drawImage of a fresh sprite pays for
    // rasterising it. Pay that here (1px draw, cleared by the frame) instead of mid-animation.
    try {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (L.armour) ctx.drawImage(L.armour, 0, 0, 1, 1);
      if (glow) ctx.drawImage(glow, 0, 0, 1, 1);
      for (const sp of L.titles) if (sp) ctx.drawImage(sp.c, 0, 0, 1, 1);
    } catch {
      /* ignore */
    }
    return L;
  }

  function triPath(list: Int32Array, count: number, src: Float32Array): void {
    ctx.beginPath();
    for (let j = 0; j < count; j++) {
      const b = list[j] * 6;
      ctx.moveTo(src[b], src[b + 1]);
      ctx.lineTo(src[b + 2], src[b + 3]);
      ctx.lineTo(src[b + 4], src[b + 5]);
      ctx.closePath();
    }
  }

  /**
   * Fill-path for whole cells (un-inset, +0.5px) of an index-sorted plate list. Consecutive plates
   * in a row merge into one trapezoid, so a mostly-settled armour costs a few hundred path ops
   * instead of thousands. All quads share one winding, so overlaps never cancel (no seams).
   */
  function runPath(L: Layout, list: Int32Array, count: number): void {
    const { cols, s, x0, rowH, r0, up } = L;
    const hs = s / 2;
    const e = 0.5;
    ctx.beginPath();
    let j = 0;
    while (j < count) {
      const a = list[j];
      const r = (a / cols) | 0;
      const rowEnd = r * cols + cols - 1;
      let b = a;
      while (j + 1 < count && list[j + 1] === b + 1 && b + 1 <= rowEnd) { j++; b++; }
      j++;
      const y0 = (r0 + r) * rowH - e;
      const y1 = (r0 + r + 1) * rowH + e;
      const xa = x0 + (a - r * cols) * hs;
      const xb = x0 + (b - r * cols) * hs;
      const tl = up[a] ? xa + hs : xa;
      const bl = up[a] ? xa : xa + hs;
      const tr = up[b] ? xb + hs : xb + s;
      const br = up[b] ? xb + s : xb + hs;
      ctx.moveTo(tl - 0.6, y0);
      ctx.lineTo(tr + 0.6, y0);
      ctx.lineTo(br + 0.6, y1);
      ctx.lineTo(bl - 0.6, y1);
      ctx.closePath();
    }
  }

  function pushSeg(L: Layout, b: number, x0: number, y0: number, x1: number, y1: number): void {
    const c = L.segCount[b];
    const a = L.seg[b];
    if (c * 4 + 4 > a.length) return;
    a[c * 4] = x0; a[c * 4 + 1] = y0; a[c * 4 + 2] = x1; a[c * 4 + 3] = y1;
    L.segCount[b] = c + 1;
  }

  function chamfer(x: number, y: number, w: number, h: number, c: number): void {
    ctx.beginPath();
    ctx.moveTo(x + c, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w, y + h - c);
    ctx.lineTo(x + w - c, y + h);
    ctx.lineTo(x, y + h);
    ctx.lineTo(x, y + c);
    ctx.closePath();
  }

  function shake(t: number, out: Float32Array): void {
    let sx = 0, sy = 0;
    for (let i = 0; i < impulses.length; i += 2) {
      const tau = t - impulses[i];
      if (tau < 0 || tau > tl.shakeDur) continue;
      const e = 1 - tau / tl.shakeDur;
      const amp = impulses[i + 1] * e * e;
      sx += amp * Math.sin(tau * 0.21 + i * 1.7);
      sy += amp * Math.cos(tau * 0.17 + i * 2.3);
    }
    out[0] = sx; out[1] = sy;
  }
  const sh = new Float32Array(2);

  function render(tIn: number): void {
    const L = ensure();
    const { w, h, dpr, n, s } = L;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, w, h);
    const t = tIn > 0 ? tIn : 0;
    if (t >= tl.duration) return;

    shake(t, sh);
    const shx = sh[0], shy = sh[1];
    ctx.setTransform(dpr, 0, 0, dpr, shx * dpr, shy * dpr);

    // ---- classify every scale for this instant ------------------------------------
    const { pop, flip, off, cx, cy, verts, mask, under, outl, bList, bCount, ux, uy, spin, side } = L;
    const popDur = tl.popDur, flipDur = tl.flipDur;
    const noSprite = !L.armour;
    const fullCover = t >= tl.coveredAt && t < tl.revealStart;
    const ringP = (t - tl.coveredAt) / tl.ringDur;
    const ringOn = ringP >= 0 && ringP < 1;
    const ringR = ringOn ? L.ringMax * easeOutCubic(ringP) : 0;
    const ringAmp = ringOn ? 0.85 * (1 - ringP * 0.7) : 0;
    const ringBW = s * 1.4;
    const glintOn = dramatic && t >= tl.glintStart && t < tl.glintEnd;
    const gp = glintOn ? -0.15 + (1.3 * (t - tl.glintStart)) / (tl.glintEnd - tl.glintStart) : 0;
    bCount.fill(0);
    let nMask = 0, nUnder = 0, nOut = 0, locked = 0;

    for (let i = 0; i < n; i++) {
      const a = pop[i];
      if (t < a) continue;
      const i6 = i * 6;
      const u = (t - a) / popDur;
      if (u < 1) {
        // popping: fly out from the origin side, spring past the seat, squash, settle
        const sp = spring(u);
        const e1 = Math.sin(u * TAU) * Math.pow(1 - u, 1.5);
        const sr = sp * (1 + 0.45 * e1);
        const st = sp * (1 - 0.25 * e1);
        const rx = ux[i], ry = uy[i];
        const slide = (1 - sp) * s * 0.95;
        const px = cx[i] - rx * slide, py = cy[i] - ry * slide;
        const rot = (1 - sp) * 0.8 * spin[i];
        const cr = Math.cos(rot), sn = Math.sin(rot);
        for (let v = 0; v < 6; v += 2) {
          const ox = off[i6 + v], oy = off[i6 + v + 1];
          const rad = (ox * rx + oy * ry) * sr;
          const tan = (oy * rx - ox * ry) * st;
          const x = rad * rx - tan * ry, y = rad * ry + tan * rx;
          verts[i6 + v] = px + x * cr - y * sn;
          verts[i6 + v + 1] = py + x * sn + y * cr;
        }
        // white-hot at the click, lime while it bounces, back to gunmetal as it seats
        const heat = u < 0.18 ? 1 - u * 2.2 : 0.6 * Math.pow(1 - (u - 0.18) / 0.82, 2.2);
        const lvl = Math.min(NH - 1, (heat * (NH - 1) + 0.5) | 0);
        bList[lvl][bCount[lvl]++] = i;
        if (u > 0.3) under[nUnder++] = i;
        if (u < 0.32) outl[nOut++] = i;
        continue;
      }
      const f = flip[i];
      if (t < f) {
        // settled: shown through the armour sprite, plus a heat overlay while hot
        locked++;
        if (!fullCover) mask[nMask++] = i;
        let hh = 0;
        if (ringOn) {
          const dd = Math.abs(L.dC[i] - ringR);
          if (dd < ringBW) { const r = ringAmp * (1 - dd / ringBW); if (r > hh) hh = r; }
        }
        if (glintOn) {
          const gg = Math.abs(L.gd[i] - gp);
          if (gg < 0.055) { const r = 0.32 * (1 - gg / 0.055); if (r > hh) hh = r; }
        }
        let b = -1;
        if (hh > 0.07) b = Math.min(NH - 1, (hh * (NH - 1) + 0.5) | 0);
        else if (noSprite) b = NH + L.shade[i];
        if (b >= 0) {
          for (let v = 0; v < 6; v += 2) {
            verts[i6 + v] = cx[i] + off[i6 + v];
            verts[i6 + v + 1] = cy[i] + off[i6 + v + 1];
          }
          bList[b][bCount[b]++] = i;
        }
        continue;
      }
      const v = (t - f) / flipDur;
      if (v < 1) {
        // flipping away like a blind: y-scale cos(pi v), shrink, lift, drift away from origin
        if (v < 0.5) locked++;
        const ys = Math.cos(Math.PI * v);
        const gsc = 1 - smooth01((v - 0.35) / 0.65);
        const px = cx[i] + side[i] * v * v * s * 0.35;
        const py = cy[i] - v * v * s * 0.9;
        for (let q = 0; q < 6; q += 2) {
          verts[i6 + q] = px + off[i6 + q] * gsc;
          verts[i6 + q + 1] = py + off[i6 + q + 1] * ys * gsc;
        }
        // dark face first, a bright glint as the scale goes edge-on, then the lit underside fades
        const sv = Math.sin(Math.PI * v);
        const heat = 0.1 + 0.58 * sv * sv * (v < 0.5 ? 1 : 0.8);
        const lvl = Math.min(NH - 1, (heat * (NH - 1) + 0.5) | 0);
        bList[lvl][bCount[lvl]++] = i;
      }
    }

    // ---- armour body ------------------------------------------------------------
    if (fullCover) {
      if (L.armour) {
        ctx.setTransform(1, 0, 0, 1, Math.round((shx - PAD) * dpr), Math.round((shy - PAD) * dpr));
        ctx.drawImage(L.armour, 0, 0);
        ctx.setTransform(dpr, 0, 0, dpr, shx * dpr, shy * dpr);
      } else {
        ctx.fillStyle = pal.bg;
        ctx.fillRect(-PAD, -PAD, w + 2 * PAD, h + 2 * PAD);
      }
    } else if (nMask > 0) {
      runPath(L, mask, nMask);
      ctx.fillStyle = pal.bg;
      ctx.fill();
      if (L.armour) {
        // keep the pre-rendered armour only where scales have settled
        ctx.globalCompositeOperation = "source-in";
        ctx.setTransform(1, 0, 0, 1, Math.round((shx - PAD) * dpr), Math.round((shy - PAD) * dpr));
        ctx.drawImage(L.armour, 0, 0);
        ctx.setTransform(dpr, 0, 0, dpr, shx * dpr, shy * dpr);
        ctx.globalCompositeOperation = "source-over";
      }
    }
    if (nUnder > 0) {
      runPath(L, under, nUnder);
      ctx.fillStyle = pal.bg;
      ctx.fill();
    }
    for (let b = 0; b < NB; b++) {
      if (!bCount[b]) continue;
      triPath(bList[b], bCount[b], verts);
      ctx.fillStyle = bucketCols[b];
      ctx.fill();
    }

    // ---- additive light: hot outlines, nanite streams, sparks -----------------------
    ctx.globalCompositeOperation = "lighter";
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    if (nOut > 0) {
      triPath(outl, nOut, verts);
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 1.2;
      ctx.strokeStyle = pal.hot;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }
    L.segCount.fill(0);
    if (t < tl.coveredAt) {
      const span = Math.max(1, tl.lastPop - tl.coverStart);
      const frontQ = clamp01((t - tl.coverStart) / span) * L.dEffMax;
      for (let j = 0; j < L.nS; j++) {
        const e = L.sEmit[j];
        if (t < e) continue;
        const r = L.sSpeed[j] * (t - e);
        const front = frontQ / L.sMod[j] + s * 0.5;
        if (r > front) continue;
        const r0 = r - L.sLen[j] > 0 ? r - L.sLen[j] : 0;
        const c = L.sCos[j], sn = L.sSin[j];
        const wob = L.sWob[j];
        const l1 = Math.sin(r * 0.045 + L.sPh[j]) * wob;
        const l0 = Math.sin(r0 * 0.045 + L.sPh[j]) * wob;
        const near = r / front;
        const ai = near > 0.78 ? 2 : near > 0.45 ? 1 : 0;
        pushSeg(L, ai * 3 + L.sCol[j], L.ox + c * r0 - sn * l0, L.oy + sn * r0 + c * l0, L.ox + c * r - sn * l1, L.oy + sn * r + c * l1);
      }
    }
    {
      const drag = 0.008;
      const tail = 22 * k;
      for (let j = 0; j < L.nK; j++) {
        const p = L.kPlate[j];
        const tau = t - (pop[p] + popDur * 0.18);
        const life = L.kLife[j];
        if (tau < 0 || tau >= life) continue;
        const d1 = (L.kSpeed[j] * (1 - Math.exp(-drag * tau))) / drag;
        const ta = tau > tail ? tau - tail : 0;
        const d0 = (L.kSpeed[j] * (1 - Math.exp(-drag * ta))) / drag;
        const fr = tau / life;
        const ai = fr < 0.35 ? 2 : fr < 0.7 ? 1 : 0;
        pushSeg(L, ai * 3 + L.kCol[j], cx[p] + L.kCos[j] * d0, cy[p] + L.kSin[j] * d0, cx[p] + L.kCos[j] * d1, cy[p] + L.kSin[j] * d1);
      }
    }
    // confetti trails (additive) and pieces (solid)
    L.quadCount.fill(0);
    if (t >= tl.revealStart) {
      const g = L.cG;
      const tail = 30 * k;
      for (let j = 0; j < L.nC; j++) {
        const life = L.cLife[j];
        const tau = t - L.cSpawn[j];
        if (tau < 0 || tau >= life) continue;
        const p = L.cPlate[j];
        const vx = L.cVx[j], vy = L.cVy[j];
        const x1 = cx[p] + vx * tau, y1 = cy[p] + vy * tau + 0.5 * g * tau * tau;
        const fr = tau / life;
        const fade = 1 - fr * fr * fr;
        const tl2 = tail * fade;
        const ta = tau > tl2 ? tau - tl2 : 0;
        const x0 = cx[p] + vx * ta, y0 = cy[p] + vy * ta + 0.5 * g * ta * ta;
        pushSeg(L, (fr < 0.5 ? 1 : 0) * 3 + L.cCol[j], x0, y0, x1, y1);
        const size = L.cSize[j] * fade;
        const ang = L.cPh[j] + L.cSpin[j] * tau;
        const ca = Math.cos(ang), sa = Math.sin(ang);
        const hw = size * Math.cos(L.cPh[j] * 1.7 + L.cTumble[j] * tau);
        const hh = size * 0.5;
        const cc = L.cCol[j];
        const qa = L.quad[cc];
        const qi = L.quadCount[cc]++ * 8;
        qa[qi] = x1 + hw * ca - hh * sa; qa[qi + 1] = y1 + hw * sa + hh * ca;
        qa[qi + 2] = x1 - hw * ca - hh * sa; qa[qi + 3] = y1 - hw * sa + hh * ca;
        qa[qi + 4] = x1 - hw * ca + hh * sa; qa[qi + 5] = y1 - hw * sa - hh * ca;
        qa[qi + 6] = x1 + hw * ca + hh * sa; qa[qi + 7] = y1 + hw * sa - hh * ca;
      }
    }
    ctx.lineWidth = 1.5 * Math.max(1, L.sizeK);
    for (let b = 0; b < SEG_B; b++) {
      const c = L.segCount[b];
      if (!c) continue;
      const a = L.seg[b];
      ctx.beginPath();
      for (let j = 0; j < c; j++) {
        ctx.moveTo(a[j * 4], a[j * 4 + 1]);
        ctx.lineTo(a[j * 4 + 2], a[j * 4 + 3]);
      }
      ctx.globalAlpha = SEG_ALPHA[(b / 3) | 0];
      ctx.strokeStyle = segCols[b % 3];
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // emitter core at the origin while the suit pours out
    if (glow && t < tl.coveredAt) {
      const inten = smooth01(t / (80 * k)) * (1 - smooth01((t - tl.lastPop) / Math.max(1, tl.coveredAt - tl.lastPop)));
      if (inten > 0.01) {
        const sz = (dramatic ? 120 : 84) * L.sizeK * (1 + 0.12 * Math.sin(t * 0.03));
        ctx.globalAlpha = inten;
        ctx.drawImage(glow, L.ox - sz / 2, L.oy - sz / 2, sz, sz);
        ctx.strokeStyle = pal.hot;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        const r1 = 13 * L.sizeK, r2 = 21 * L.sizeK;
        const a1 = t * 0.012, a2 = -t * 0.008;
        for (let q = 0; q < 3; q++) {
          ctx.moveTo(L.ox + Math.cos(a1 + q * 2.094) * r1, L.oy + Math.sin(a1 + q * 2.094) * r1);
          ctx.arc(L.ox, L.oy, r1, a1 + q * 2.094, a1 + q * 2.094 + 1.3);
          ctx.moveTo(L.ox + Math.cos(a2 + q * 2.094) * r2, L.oy + Math.sin(a2 + q * 2.094) * r2);
          ctx.arc(L.ox, L.oy, r2, a2 + q * 2.094, a2 + q * 2.094 + 0.8);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }

    // lock beat: flash + burst ring from the lock point
    if (ringOn) {
      if (ringP < 0.35) {
        const fl = 1 - ringP / 0.35;
        ctx.globalAlpha = 0.16 * fl * fl;
        ctx.fillStyle = pal.hot;
        ctx.fillRect(-PAD, -PAD, w + 2 * PAD, h + 2 * PAD);
      }
      if (glow) {
        const fl = 1 - ringP;
        const sz = Math.min(w, h) * (0.35 + ringP * 0.9);
        ctx.globalAlpha = fl * fl * fl;
        ctx.drawImage(glow, L.mx - sz / 2, L.my - sz / 2, sz, sz);
      }
      ctx.globalAlpha = 1 - ringP;
      ctx.strokeStyle = pal.hot;
      ctx.lineWidth = 1 + 5 * (1 - ringP);
      ctx.beginPath();
      ctx.arc(L.mx, L.my, ringR, 0, TAU);
      ctx.stroke();
      ctx.strokeStyle = pal.core;
      ctx.lineWidth = 1 + 1.5 * (1 - ringP);
      ctx.beginPath();
      ctx.arc(L.mx, L.my, ringR * 0.86, 0, TAU);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    ctx.globalCompositeOperation = "source-over";
    for (let b = 0; b < 3; b++) {
      const c = L.quadCount[b];
      if (!c) continue;
      const a = L.quad[b];
      ctx.beginPath();
      for (let j = 0; j < c; j++) {
        const q = j * 8;
        ctx.moveTo(a[q], a[q + 1]);
        ctx.lineTo(a[q + 2], a[q + 3]);
        ctx.lineTo(a[q + 4], a[q + 5]);
        ctx.lineTo(a[q + 6], a[q + 7]);
        ctx.closePath();
      }
      ctx.fillStyle = quadCols[b];
      ctx.fill();
    }

    // ---- HUD ------------------------------------------------------------------------
    // After the blinds open, the HUD and title belong to the armour: source-atop
    // paints them only where plates remain, so they fold away with the plates
    // instead of hanging over the live screen.
    if (t >= tl.revealStart) ctx.globalCompositeOperation = "source-atop";
    const pct = Math.max(0, Math.min(100, Math.round((100 * locked) / n)));
    const hudA = 1 - smooth01((t - tl.hudOut0) / Math.max(1, tl.hudOut1 - tl.hudOut0));
    if (hudA > 0.01) {
      if (dramatic) {
        drawBrackets(L, t, hudA);
        drawReticle(L, t);
        drawPanel(L, t, hudA, pct);
      } else {
        drawQuick(L, t, hudA, pct);
      }
    }
    if (dramatic) drawTitle(L, t);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
  }

  // corner brackets snap out from the centre to the corners with a springy click
  function drawBrackets(L: Layout, t: number, a: number): void {
    const { w, h, m } = L;
    const len = L.bracket;
    const travel = Math.min(w, h) * 0.1;
    ctx.lineCap = "square";
    ctx.lineJoin = "miter";
    for (let c = 0; c < 4; c++) {
      const tc = t - 35 * k * c;
      if (tc < 0) continue;
      const b = spring(tc / (240 * k));
      const sx = c % 2 === 0 ? 1 : -1;
      const sy = c < 2 ? 1 : -1;
      const x = (c % 2 === 0 ? m : w - m) + sx * (1 - b) * travel;
      const y = (c < 2 ? m : h - m) + sy * (1 - b) * travel * 0.7;
      ctx.globalAlpha = a * Math.min(1, tc / (60 * k));
      ctx.strokeStyle = pal.hot;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x, y + sy * len);
      ctx.lineTo(x, y);
      ctx.lineTo(x + sx * len, y);
      ctx.stroke();
      // click flash on the corner pip
      const fl = 1 - clamp01((tc - 40 * k) / (160 * k));
      const pip = 3 + 3 * fl;
      ctx.fillStyle = fl > 0.05 ? pal.core : pal.hot;
      ctx.fillRect(x - pip / 2 + sx * 1, y - pip / 2 + sy * 1, pip, pip);
    }
    ctx.globalAlpha = a * smooth01((t - 120 * k) / (160 * k));
    if (ctx.globalAlpha > 0.01) {
      ctx.font = L.fTiny;
      ctx.fillStyle = dim;
      ctx.textBaseline = "alphabetic";
      ctx.textAlign = "left";
      ctx.fillText("NANO-WEAVE MK.II", m + 10, m + L.bracket + 14);
      ctx.textAlign = "right";
      ctx.fillText(suitLabel, w - m - 10, m + L.bracket + 14);
    }
    ctx.globalAlpha = 1;
  }

  // reticle chases from the origin to the centre and locks at full coverage
  function drawReticle(L: Layout, t: number): void {
    const t0 = tl.coverStart + 60 * k;
    if (t < t0) return;
    const lockT = tl.coveredAt;
    const q = clamp01((t - t0) / Math.max(1, lockT - 90 * k - t0));
    const e = spring(q);
    const px = L.ox + (L.mx - L.ox) * e;
    const py = L.oy + (L.my - L.oy) * e;
    let r = 30 * Math.max(0.85, L.sizeK);
    let alpha = Math.min(1, (t - t0) / (120 * k));
    if (t > lockT - 90 * k && t < lockT) r *= 1 - (0.3 * (t - (lockT - 90 * k))) / (90 * k);
    if (t >= lockT) {
      const p = (t - lockT) / (240 * k);
      if (p >= 1) return;
      r = r * 0.7 + p * p * Math.min(L.w, L.h) * 0.25;
      alpha *= 1 - p;
    }
    const rot = t * 0.0035 + q * q * 3;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = t >= lockT ? pal.core : pal.hot;
    ctx.lineWidth = 2;
    ctx.lineCap = "butt";
    ctx.beginPath();
    for (let i = 0; i < 4; i++) {
      const a0 = rot + i * (Math.PI / 2) + 0.28;
      ctx.moveTo(px + Math.cos(a0) * r, py + Math.sin(a0) * r);
      ctx.arc(px, py, r, a0, a0 + Math.PI / 2 - 0.56);
    }
    for (let i = 0; i < 4; i++) {
      const c = Math.cos(i * (Math.PI / 2)), sn = Math.sin(i * (Math.PI / 2));
      ctx.moveTo(px + c * (r + 4), py + sn * (r + 4));
      ctx.lineTo(px + c * (r + 12), py + sn * (r + 12));
    }
    ctx.stroke();
    ctx.fillStyle = pal.core;
    ctx.fillRect(px - 1.5, py - 1.5, 3, 3);
    ctx.font = L.fTiny;
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = pal.hot;
    ctx.fillText(t >= lockT - 90 * k ? "LOCKED" : "TRACKING", px, py + r + 24);
    ctx.globalAlpha = 1;
  }

  function drawStatus(L: Layout, t: number, x: number, y: number, right: number, set: string[][], lineGap: number, onlyLast: boolean): void {
    ctx.font = L.fLine;
    ctx.textBaseline = "alphabetic";
    let yy = y;
    for (let li = 0; li < set.length; li++) {
      const st = tl.status[li];
      if (t < st) break;
      const next = li + 1 < set.length ? tl.status[li + 1] : Infinity;
      const done = t >= next;
      if (onlyLast && done) continue;
      const pre = set[li];
      const nChars = Math.min(pre.length - 1, Math.floor((t - st) / tl.charMs));
      ctx.textAlign = "left";
      ctx.fillStyle = done ? dim : pal.hot;
      ctx.fillText(pre[nChars], x, yy);
      if (done) {
        ctx.textAlign = "right";
        ctx.fillStyle = pal.core;
        ctx.fillText("OK", right, yy);
      } else if (nChars < pre.length - 1 || ((t / (130 * k)) | 0) % 2 === 0) {
        const typed = onlyLast ? nChars : nChars + 2;
        ctx.fillStyle = pal.core;
        ctx.fillRect(x + L.charW * typed + 1, yy - L.linePx * 0.8, L.charW * 0.7, L.linePx * 0.95);
      }
      yy += lineGap;
    }
  }

  function drawPanel(L: Layout, t: number, a: number, pct: number): void {
    const pin = smooth01((t - tl.status[0] + 40 * k) / (180 * k));
    if (pin <= 0) return;
    const pw = L.panelW, ph = L.panelH;
    const x = L.panelX;
    const y = L.panelY + (1 - pin) * 14;
    ctx.globalAlpha = a * pin;
    chamfer(x, y, pw, ph, 10);
    ctx.fillStyle = panelFill;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = panelStroke;
    ctx.stroke();
    ctx.textBaseline = "alphabetic";
    ctx.font = L.fLabel;
    ctx.textAlign = "left";
    ctx.fillStyle = dim;
    ctx.fillText("NANO-WEAVE", x + 12, y + 22);
    ctx.fillText(t >= tl.revealStart ? "RETRACTING" : pct >= 100 ? "ARMOUR LOCKED" : "COVERAGE", x + 12, y + 34);
    ctx.font = L.fBig;
    ctx.textAlign = "right";
    ctx.fillStyle = pct >= 100 ? pal.core : pal.hot;
    ctx.fillText(PCT[pct], x + pw - 12, y + 32);
    // 20-segment bar
    const segs = 20, gapw = 2;
    const bw = (pw - 24 - gapw * (segs - 1)) / segs;
    const filled = Math.round(pct / 5);
    ctx.beginPath();
    for (let i = 0; i < filled; i++) ctx.rect(x + 12 + i * (bw + gapw), y + 42, bw, 6);
    ctx.fillStyle = pal.hot;
    ctx.fill();
    ctx.beginPath();
    for (let i = filled; i < segs; i++) ctx.rect(x + 12 + i * (bw + gapw), y + 42, bw, 6);
    ctx.fillStyle = barOff;
    ctx.fill();
    drawStatus(L, t, x + 12, y + 66, x + pw - 12, prefixes, 15, false);
    ctx.globalAlpha = 1;
  }

  function drawQuick(L: Layout, t: number, a: number, pct: number): void {
    const u = (t - tl.status[0]) / (170 * k);
    if (u <= 0) return;
    const sc = spring(u);
    const pw = L.quickW, ph = 46;
    ctx.save();
    ctx.translate(L.mx, L.my);
    ctx.scale(sc, sc);
    ctx.globalAlpha = a * Math.min(1, u * 3);
    chamfer(-pw / 2, -ph / 2, pw, ph, 8);
    ctx.fillStyle = panelFill;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = panelStroke;
    ctx.stroke();
    ctx.textBaseline = "alphabetic";
    ctx.font = L.fLabel;
    ctx.textAlign = "left";
    ctx.fillStyle = dim;
    ctx.fillText("NANO-WEAVE", -pw / 2 + 12, -ph / 2 + 18);
    ctx.font = L.fQuick;
    ctx.textAlign = "right";
    ctx.fillStyle = pct >= 100 ? pal.core : pal.hot;
    ctx.fillText(PCT[pct], pw / 2 - 12, -ph / 2 + 20);
    drawStatus(L, t, -pw / 2 + 12, ph / 2 - 10, pw / 2 - 12, quickPrefixes, 0, true);
    ctx.restore();
  }

  // dramatic title: kicker + two lines stamp in with a bounce, then flip shut with the reveal
  function drawTitle(L: Layout, t: number): void {
    if (t < tl.titleAt) return;
    const out = smooth01((t - tl.titleOut0) / Math.max(1, tl.titleOut1 - tl.titleOut0));
    if (out >= 1) return;
    const [kick, top, bottom] = L.titles;
    const lineH = top ? top.h * 0.62 : 60;
    const items: [Sprite | null, number, number][] = [
      [kick, tl.titleAt, L.my - lineH * 1.25],
      [top, tl.titleAt + 50 * k, L.my - lineH * 0.42],
      [bottom, tl.titleAt + 140 * k, L.my + lineH * 0.5],
    ];
    const close = Math.cos((out * Math.PI) / 2);
    for (const [spr, st, y] of items) {
      if (!spr || t < st) continue;
      const u = (t - st) / tl.stampDur;
      const sc = stamp(u);
      const sx = sc < 1 ? 1 + (1 - sc) * 0.7 : sc;
      const sy = sc * close;
      ctx.globalAlpha = Math.min(1, u * 6) * (1 - out * 0.4);
      const dw = spr.w * sx, dh = spr.h * sy;
      ctx.drawImage(spr.c, L.mx - dw / 2, y - dh / 2, dw, dh);
    }
    ctx.globalAlpha = 1;
  }

  return {
    render,
    clear() {
      try {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = "source-over";
        ctx.globalAlpha = 1;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      } catch {
        /* canvas gone */
      }
    },
    dispose() {
      if (L) freeLayout(L);
      L = null;
    },
  };
}

// ---------------------------------------------------------------------------
// public entry

function timerHandle(o: NaniteOptions, tl: NaniteTimeline): NaniteHandle {
  let covered = false;
  let live = true;
  const t1 = setTimeout(() => {
    if (!live || covered) return;
    covered = true;
    o.onCovered?.();
  }, tl.coveredAt);
  const t2 = setTimeout(() => {
    if (!live) return;
    live = false;
    if (!covered) { covered = true; o.onCovered?.(); }
    o.onDone?.();
  }, tl.duration);
  return {
    cancel() { live = false; clearTimeout(t1); clearTimeout(t2); },
    drawAt() { /* no 2D context: nothing to draw */ },
  };
}

/**
 * Play the transition on `o.canvas` (a full-viewport canvas above the frozen old screen).
 * onCovered fires on the first frame at/after the cover instant (canvas fully opaque);
 * onDone fires at `duration` after the canvas is cleared to transparent.
 * cancel() stops the loop, removes listeners and clears the canvas without calling callbacks.
 * drawAt(t) renders the frame for elapsed `t` ms (no callbacks) and keeps working after cancel().
 */
export function playNanites(o: NaniteOptions): NaniteHandle {
  const tl = naniteTimeline(!!o.dramatic, o.duration);
  let ctx: CanvasRenderingContext2D | null = null;
  try {
    ctx = o.canvas.getContext("2d");
  } catch {
    ctx = null;
  }
  if (!ctx) return timerHandle(o, tl);

  const R = createRenderer(ctx, o, tl);
  const hasWin = typeof window !== "undefined";
  const raf: (cb: () => void) => number =
    hasWin && window.requestAnimationFrame ? (cb) => window.requestAnimationFrame(cb) : (cb) => setTimeout(cb, 16) as unknown as number;
  const caf: (id: number) => void =
    hasWin && window.cancelAnimationFrame ? (id) => window.cancelAnimationFrame(id) : (id) => clearTimeout(id);
  const now = (): number => (typeof performance !== "undefined" ? performance.now() : Date.now());

  const start = now();
  let rafId = 0;
  let covered = false;
  let running = true;
  let safety: ReturnType<typeof setTimeout> | null = null;
  // drawAt/render re-read the canvas size each frame; resize just requests a frame promptly
  const onResize = (): void => {
    if (running) R.render(now() - start);
  };

  const stop = (): void => {
    running = false;
    if (rafId) caf(rafId);
    rafId = 0;
    if (safety) clearTimeout(safety);
    safety = null;
    if (hasWin) window.removeEventListener("resize", onResize);
  };

  const finish = (): void => {
    if (!running) return;
    stop();
    R.clear();
    R.dispose();
    if (!covered) { covered = true; o.onCovered?.(); }
    o.onDone?.();
  };

  const frame = (): void => {
    rafId = 0;
    if (!running) return;
    const t = now() - start;
    if (t >= tl.duration) { finish(); return; }
    R.render(t);
    if (!covered && t >= tl.coveredAt) { covered = true; o.onCovered?.(); }
    if (running) rafId = raf(frame);
  };

  if (hasWin) window.addEventListener("resize", onResize);
  // rAF is paused in background tabs: guarantee the host is released anyway
  safety = setTimeout(finish, tl.duration + 400);
  R.render(0);
  rafId = raf(frame);

  return {
    cancel(): void {
      if (!running) return;
      stop();
      R.clear();
      R.dispose();
    },
    drawAt(t: number): void {
      R.render(t);
    },
  };
}
