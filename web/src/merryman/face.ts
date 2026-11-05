/**
 * THE MERRYMAN'S HEAD: skin, face, ears, hair, facial hair and eyewear.
 *
 * Charm lives here, so this is where the detail goes — but every piece is
 * still a primitive (a sphere, a spherical cap, a disc, a tapered tube), and
 * every piece is placed by computing where the surface it decorates actually
 * is: a freckle is bent onto the cheek's curve, a lock of hair is walked over
 * the scalp, a lash rides the eyelid's own edge. Nothing floats, nothing is
 * buried.
 *
 * Two rules keep 400 px and 40 px both working:
 * - Ink (the outline hull) only on primary forms: head, ears, hair, beard.
 *   Marks and trim go without, or a 40 px face turns to mush; so does the
 *   nose, whose ring read as a clown's ball stuck on.
 * - Same-material detail is MERGED into one geometry: forty locks of hair are
 *   one mesh and one outline, not eighty draw calls.
 *
 * The animated nodes keep the shape rig.ts `applyPose` drives: eye groups whose
 * scale.y is the blink, pupil groups whose position is the gaze, brow groups
 * whose y and z-rotation are the expression, the mouth arc it scales and flips,
 * and the open mouth it shows and stretches. Anything that must move with one
 * of them is built inside it.
 *
 * Hair never pokes through a hat: `CUTS` records where each hat's lower edge
 * sits (from the hat geometry in gear.ts), and a lock rooted higher than that
 * edge is re-rooted under it — or not built at all when what is left would be
 * a stub.
 */
import {
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  Euler,
  Group,
  Matrix4,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  type Material,
  type Mesh,
  type Object3D,
} from "three";
import { hexOf, type Outfit } from "./outfit";
import type { Kit } from "./rig";

type V3 = [number, number, number];
type PartOpts = { pos?: V3; rot?: V3; scale?: V3; outline?: boolean; hit?: boolean };

/** rig.ts's Builder, as far as the head needs it — its `b` satisfies this as is. */
export type FaceBuilder = {
  kit: Kit;
  part(geo: BufferGeometry, mat: Material, parent: Object3D, opts?: PartOpts): Mesh;
};

/** The nodes `applyPose` animates, exactly as rig.ts's Rig names them. */
export type Face = {
  eyeL: Group;
  eyeR: Group;
  pupilL: Group;
  pupilR: Group;
  browL: Group;
  browR: Group;
  mouthArc: Group;
  mouthOpen: Group;
};

// ── colour ───────────────────────────────────────────────────────────────

const darken = (hex: string, f: number) => new Color(hex).multiplyScalar(f);
const lighten = (hex: string, f: number) => new Color(hex).lerp(new Color("#ffffff"), f);
const css = (c: Color) => `#${c.getHexString()}`;

// ── small maths ──────────────────────────────────────────────────────────

const DEG = Math.PI / 180;
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smooth = (x: number) => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};
const smoothstep = (a: number, b: number, x: number) => smooth((x - a) / (b - a));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const FWD = new Vector3(0, 0, 1);
const X_AXIS = new Vector3(1, 0, 0);
const Z_AXIS = new Vector3(0, 0, 1);
const NOFX = { outline: false, hit: false } as const;

// Build-time scratch (nothing here runs per frame).
const _q = new Quaternion();
const _e = new Euler();
const _m = new Matrix4();
const _v = new Vector3();
const _s = new Vector3();
const _n = new Vector3();
const _up = new Vector3();

/** Direction from azimuth (0 = his front, +90 = his left, i.e. +x) and elevation, in degrees. */
function azel(az: number, el: number, out = new Vector3()): Vector3 {
  const a = az * DEG;
  const e = el * DEG;
  return out.set(Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e));
}

// ── geometry helpers ─────────────────────────────────────────────────────

/** Bake a transform into a geometry (for merging). */
function place(geo: BufferGeometry, pos: V3 = [0, 0, 0], rot: V3 = [0, 0, 0], scale: V3 = [1, 1, 1]): BufferGeometry {
  _q.setFromEuler(_e.set(rot[0], rot[1], rot[2]));
  _m.compose(_v.set(pos[0], pos[1], pos[2]), _q, _s.set(scale[0], scale[1], scale[2]));
  return geo.applyMatrix4(_m);
}

/**
 * Many same-material pieces as ONE geometry: positions and normals only (no
 * part of the head uses a texture), indices offset. The inputs are disposed.
 */
function merge(parts: BufferGeometry[]): BufferGeometry {
  let nv = 0;
  let ni = 0;
  for (const g of parts) {
    const n = g.getAttribute("position").count;
    nv += n;
    ni += g.index ? g.index.count : n;
  }
  const pos = new Float32Array(nv * 3);
  const nor = new Float32Array(nv * 3);
  const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  let vo = 0;
  let io = 0;
  for (const g of parts) {
    if (!g.hasAttribute("normal")) g.computeVertexNormals();
    const p = g.getAttribute("position");
    const n = g.getAttribute("normal");
    for (let i = 0; i < p.count; i++) {
      const k = (vo + i) * 3;
      pos[k] = p.getX(i);
      pos[k + 1] = p.getY(i);
      pos[k + 2] = p.getZ(i);
      nor[k] = n.getX(i);
      nor[k + 1] = n.getY(i);
      nor[k + 2] = n.getZ(i);
    }
    if (g.index) {
      for (let i = 0; i < g.index.count; i++) idx[io + i] = g.index.getX(i) + vo;
      io += g.index.count;
    } else {
      for (let i = 0; i < p.count; i++) idx[io + i] = vo + i;
      io += p.count;
    }
    vo += p.count;
    g.dispose();
  }
  const out = new BufferGeometry();
  out.setAttribute("position", new BufferAttribute(pos, 3));
  out.setAttribute("normal", new BufferAttribute(nor, 3));
  out.setIndex(new BufferAttribute(idx, 1));
  return out;
}

type Prof = (u: number) => number;
type StrandOpts = {
  seg?: number;
  radial?: number;
  /** Half-width across the stroke (along the surface), by arc-length u in [0, 1]. */
  w: Prof;
  /** Half-thickness off the surface. */
  d?: Prof;
  /** Which way is "off the surface": a fixed vector or one per point. */
  up?: Vector3 | ((p: Vector3) => Vector3);
};

const _P = new Vector3();
const _T = new Vector3();
const _U = new Vector3();
const _N = new Vector3();
const _B = new Vector3();
const _O = new Vector3();
const _W = new Vector3();

/**
 * A TAPERED TUBE along a smooth curve, with an elliptical cross-section: wide
 * along the surface it lies on, thin off it. Hair locks, brows, lashes, the
 * smile line, a moustache and a spectacle temple are all this one shape.
 * Normals are the ellipse's own, so toon shading shows no seam.
 */
function strand(pts: Vector3[], o: StrandOpts): BufferGeometry {
  const seg = o.seg ?? 12;
  const R = o.radial ?? 6;
  const depth = o.d ?? ((u: number) => o.w(u) * 0.6);
  const curve = new CatmullRomCurve3(pts, false, "centripetal");
  const rings = seg + 1;
  const nv = rings * R + 2;
  const pos = new Float32Array(nv * 3);
  const nor = new Float32Array(nv * 3);
  const ends: Vector3[] = [];
  const endT: Vector3[] = [];
  for (let i = 0; i < rings; i++) {
    const u = i / seg;
    curve.getPointAt(u, _P);
    curve.getTangentAt(u, _T);
    if (typeof o.up === "function") _U.copy(o.up(_P));
    else _U.copy(o.up ?? FWD);
    _N.copy(_U).addScaledVector(_T, -_U.dot(_T));
    if (_N.lengthSq() < 1e-12) {
      _N.set(1, 0, 0).addScaledVector(_T, -_T.x);
      if (_N.lengthSq() < 1e-8) _N.set(0, 1, 0).addScaledVector(_T, -_T.y);
    }
    _N.normalize();
    _B.crossVectors(_T, _N).normalize();
    const w = Math.max(0, o.w(u));
    const d = Math.max(0, depth(u));
    const we = Math.max(w, 1e-4);
    const de = Math.max(d, 1e-4);
    for (let j = 0; j < R; j++) {
      const a = (j / R) * Math.PI * 2;
      const c = Math.cos(a);
      const s = Math.sin(a);
      const k = (i * R + j) * 3;
      _O.copy(_B).multiplyScalar(c * w).addScaledVector(_N, s * d);
      pos[k] = _P.x + _O.x;
      pos[k + 1] = _P.y + _O.y;
      pos[k + 2] = _P.z + _O.z;
      _W.copy(_B).multiplyScalar(c * de).addScaledVector(_N, s * we).normalize();
      nor[k] = _W.x;
      nor[k + 1] = _W.y;
      nor[k + 2] = _W.z;
    }
    if (i === 0 || i === seg) {
      ends.push(_P.clone());
      endT.push(_T.clone());
    }
  }
  const c0 = rings * R;
  const c1 = c0 + 1;
  const [e0, e1] = [ends[0]!, ends[ends.length - 1]!];
  const [t0, t1] = [endT[0]!, endT[endT.length - 1]!];
  pos.set([e0.x, e0.y, e0.z, e1.x, e1.y, e1.z], c0 * 3);
  nor.set([-t0.x, -t0.y, -t0.z, t1.x, t1.y, t1.z], c0 * 3);
  const idx: number[] = [];
  for (let i = 0; i < seg; i++) {
    for (let j = 0; j < R; j++) {
      const a = i * R + j;
      const b = i * R + ((j + 1) % R);
      const c = (i + 1) * R + j;
      const d = (i + 1) * R + ((j + 1) % R);
      idx.push(a, c, b, b, c, d);
    }
  }
  for (let j = 0; j < R; j++) {
    idx.push(c0, j, (j + 1) % R);
    idx.push(c1, seg * R + ((j + 1) % R), seg * R + j);
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(pos, 3));
  g.setAttribute("normal", new BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}

// ── the surfaces details sit on ──────────────────────────────────────────

type Ell = { x: number; y: number; z: number; a: number; b: number; c: number };

/** The head: rig.ts's 0.3 sphere scaled (1, 0.96, 0.95). Its semi-axes. */
export const HEAD = { a: 0.3, b: 0.288, c: 0.285 } as const;
const HEAD_E: Ell = { x: 0, y: 0, z: 0, ...HEAD };

function ellNormal(e: Ell, p: Vector3, out: Vector3): Vector3 {
  return out.set((p.x - e.x) / (e.a * e.a), (p.y - e.y) / (e.b * e.b), (p.z - e.z) / (e.c * e.c)).normalize();
}

/** The ellipsoid's front (+z) surface over (x, y), lifted `lift` along its normal. */
function front(e: Ell, x: number, y: number, lift = 0, out = new Vector3()): Vector3 {
  const t = 1 - ((x - e.x) / e.a) ** 2 - ((y - e.y) / e.b) ** 2;
  out.set(x, y, e.z + e.c * Math.sqrt(Math.max(0, t)));
  if (lift) out.addScaledVector(ellNormal(e, out, _n), lift);
  return out;
}

/** The surface point along a direction from the centre, lifted along the normal. */
function along(e: Ell, dir: Vector3, lift = 0, out = new Vector3()): Vector3 {
  const k = 1 / Math.sqrt((dir.x / e.a) ** 2 + (dir.y / e.b) ** 2 + (dir.z / e.c) ** 2);
  out.set(e.x + dir.x * k, e.y + dir.y * k, e.z + dir.z * k);
  if (lift) out.addScaledVector(ellNormal(e, out, _n), lift);
  return out;
}

/**
 * A FLAT MARK LAID ON A CURVED SURFACE — a freckle, the blush, a nostril, the
 * nose's shine. A disc is oriented to the surface, then every vertex is pulled
 * onto the ellipsoid and lifted by the same hair's breadth, so even a wide
 * blush hugs the cheek instead of standing off it like a sticker.
 */
function decal(e: Ell, at: Vector3, r: number, o: { sx?: number; sy?: number; twist?: number; lift?: number; seg?: number } = {}): BufferGeometry {
  const g = new CircleGeometry(r, o.seg ?? 12);
  g.scale(o.sx ?? 1, o.sy ?? 1, 1);
  if (o.twist) g.rotateZ(o.twist);
  ellNormal(e, at, _n);
  g.applyQuaternion(_q.setFromUnitVectors(FWD, _n));
  g.translate(at.x, at.y, at.z);
  const lift = o.lift ?? 0.0015;
  const p = g.getAttribute("position");
  const nrm = g.getAttribute("normal");
  for (let i = 0; i < p.count; i++) {
    _v.set(p.getX(i) - e.x, p.getY(i) - e.y, p.getZ(i) - e.z);
    const k = 1 / Math.sqrt((_v.x / e.a) ** 2 + (_v.y / e.b) ** 2 + (_v.z / e.c) ** 2);
    _v.multiplyScalar(k).add(_s.set(e.x, e.y, e.z));
    ellNormal(e, _v, _n);
    _v.addScaledVector(_n, lift);
    p.setXYZ(i, _v.x, _v.y, _v.z);
    nrm.setXYZ(i, _n.x, _n.y, _n.z);
  }
  return g;
}

// ── the scalp: hair cap where there is one, skin elsewhere ───────────────

/** rig.ts's hair cap, which every hat sits over: a 0.312 sphere segment, tilted back. */
const CAP = { r: 0.312, theta: Math.PI * 0.42, tilt: 0.55, sx: 1.02, sy: 0.98 } as const;
const CAP_COS = Math.cos(CAP.tilt);
const CAP_SIN = Math.sin(CAP.tilt);
/** The cap's pole (its whorl, where a crown of hair swirls from) and the way "forward" from it. */
const WHORL = new Vector3(0, CAP_COS, -CAP_SIN);
const WHORL_FWD = new Vector3(0, CAP_SIN, CAP_COS);

/**
 * How far from the head's centre the scalp is along a unit direction: the hair
 * cap inside the hairline, the skin outside it, blended over a few degrees
 * so a fringe flows off the cap and down the forehead without a kink.
 */
function scalpR(d: Vector3): number {
  const rh = 1 / Math.sqrt((d.x / HEAD.a) ** 2 + (d.y / HEAD.b) ** 2 + (d.z / HEAD.c) ** 2);
  const ly = d.y * CAP_COS - d.z * CAP_SIN;
  const lz = d.y * CAP_SIN + d.z * CAP_COS;
  const rc = 1 / Math.sqrt((d.x / (CAP.r * CAP.sx)) ** 2 + (ly / (CAP.r * CAP.sy)) ** 2 + (lz / CAP.r) ** 2);
  const edge = Math.cos(CAP.theta);
  return rh + (rc - rh) * smoothstep(edge - 0.16, edge + 0.004, ly);
}

/** A direction around the whorl: psi 0 = toward his face, delta = degrees out from the whorl. */
function whorl(psi: number, delta: number, out = new Vector3()): Vector3 {
  const p = psi * DEG;
  const d = delta * DEG;
  return out
    .copy(WHORL)
    .multiplyScalar(Math.cos(d))
    .addScaledVector(X_AXIS, Math.sin(d) * Math.sin(p))
    .addScaledVector(WHORL_FWD, Math.sin(d) * Math.cos(p))
    .normalize();
}

// ── locks of hair ────────────────────────────────────────────────────────

/** One lock: root, bend and tip directions, a width, and how it lifts off the scalp. */
type Lock = {
  r: Vector3;
  m: Vector3;
  t: Vector3;
  /** Half-width at the lock's widest. */
  w: number;
  /** Lift off the scalp: buried root, widest point, tip (a tip higher than the body flicks out). */
  root: number;
  lift: number;
  tip: number;
  /** Thickness as a share of width. */
  flat: number;
};

/** A lock written in degrees, for the tables below. */
type LockDeg = { a0: number; e0: number; a1: number; e1: number; w: number; bow?: number; lift?: number; tip?: number; root?: number; flat?: number };

function lockDir(L: Lock, u: number, out: Vector3): Vector3 {
  const a = (1 - u) * (1 - u);
  const b = 2 * u * (1 - u);
  const c = u * u;
  return out.set(L.r.x * a + L.m.x * b + L.t.x * c, L.r.y * a + L.m.y * b + L.t.y * c, L.r.z * a + L.m.z * b + L.t.z * c).normalize();
}

function lockLift(L: Lock, u: number): number {
  return u < 0.32 ? L.root + (L.lift - L.root) * smooth(u / 0.32) : L.lift + (L.tip - L.lift) * smooth((u - 0.32) / 0.68);
}

function lockPoints(L: Lock, n = 8): Vector3[] {
  const pts: Vector3[] = [];
  for (let k = 0; k < n; k++) {
    const u = k / (n - 1);
    const d = lockDir(L, u, new Vector3());
    pts.push(d.multiplyScalar(scalpR(d) + lockLift(L, u)));
  }
  return pts;
}

/** Leaf-shaped: closed at the root, widest a third of the way down, a point at the tip. */
const teardrop = (u: number) => Math.pow(Math.max(0, Math.sin(Math.PI * Math.pow(clamp01(u), 0.6))), 0.85);
const radial = (p: Vector3) => _up.copy(p).normalize();

function lockGeo(L: Lock): BufferGeometry {
  return strand(lockPoints(L), {
    seg: 14,
    radial: 7,
    w: (u) => L.w * teardrop(u),
    d: (u) => L.flat * L.w * teardrop(u) + 0.0012,
    up: radial,
  });
}

/** A glossy streak riding the outer face of a lock, a third of the way down. */
function shineGeo(L: Lock): BufferGeometry {
  const curve = new CatmullRomCurve3(lockPoints(L), false, "centripetal");
  const u0 = 0.2;
  const u1 = 0.5;
  const pts: Vector3[] = [];
  for (let k = 0; k <= 5; k++) {
    const u = lerp(u0, u1, k / 5);
    const p = curve.getPointAt(u, new Vector3());
    pts.push(p.addScaledVector(_v.copy(p).normalize(), L.flat * L.w * teardrop(u) + 0.0028));
  }
  return strand(pts, {
    seg: 8,
    radial: 5,
    w: (v) => 0.3 * L.w * teardrop(lerp(u0, u1, v)) * Math.pow(Math.max(0, Math.sin(Math.PI * v)), 0.6),
    d: () => 0.0012,
    up: radial,
  });
}

function lockOf(L: LockDeg, sx = 1): Lock {
  return {
    r: azel(L.a0 * sx, L.e0),
    m: azel(((L.a0 + L.a1) / 2 + (L.bow ?? 0)) * sx, (L.e0 + L.e1) / 2),
    t: azel(L.a1 * sx, L.e1),
    w: L.w,
    root: L.root ?? -0.006,
    lift: L.lift ?? 0.018,
    tip: L.tip ?? 0.012,
    flat: L.flat ?? 0.38,
  };
}

// ── what each hat leaves showing ─────────────────────────────────────────

/**
 * WHERE EACH HAT'S LOWER EDGE IS, in head space, measured from the hat
 * geometry (gear.ts; the feathered cap there is seated on this very line):
 * head-local y of the band or brim's underside at his front, his sides and
 * his back. Hair is only built below it: a lock rooted higher is re-rooted
 * `tuck` above the edge (hidden behind the band where the band stands off the
 * head, as a feathered cap's does at the front; zero or less where it hugs
 * the hair) or dropped.
 * If a hat's height changes in gear.ts, change it here too.
 */
type Cut = {
  edge: [front: number, side: number, back: number] | null;
  tuck: [front: number, side: number, back: number];
  /** The top hat's roll: the edge drops this much per unit of +x. */
  roll: number;
  /** A band with hair above it (bandana): its upper edge; top locks stop short of it. */
  over: [front: number, side: number, back: number] | null;
  top: "full" | "tuft" | "none";
  fringe: "full" | "hood" | "none";
  sides: boolean;
  nape: boolean;
  cowlick: boolean;
};

const OPEN: Cut = { edge: null, tuck: [0, 0, 0], roll: 0, over: null, top: "full", fringe: "full", sides: true, nape: true, cowlick: true };

export const CUTS: Record<Outfit["hat"], Cut> = {
  none: OPEN,
  halo: OPEN,
  // The crown's band floats round the top: hair shows under it. (gear.ts lines
  // it with a velvet cap; without one, "tuft" puts a short tuft inside the band.)
  crown: { ...OPEN, edge: [0.238, 0.238, 0.238], top: "none", cowlick: false },
  // A headband: hair above it and below it, but no fringe through it.
  bandana: { ...OPEN, edge: [0.11, 0.065, 0.02], tuck: [-0.006, -0.006, -0.006], over: [0.22, 0.175, 0.13], fringe: "none" },
  // Brimmed: fringe, sides and nape peek out under the edge.
  feather: { ...OPEN, edge: [0.19, 0.125, 0.06], tuck: [0.01, 0, 0], top: "none", cowlick: false },
  wizard: { ...OPEN, edge: [0.1875, 0.1875, 0.1875], tuck: [0.02, 0.02, 0.02], top: "none", cowlick: false },
  tophat: { ...OPEN, edge: [0.2075, 0.2075, 0.2075], tuck: [0.02, 0.02, 0.02], roll: -0.08, top: "none", cowlick: false },
  // Only the face opening shows: a fringe inside it.
  hood: { ...OPEN, top: "none", fringe: "hood", sides: false, nape: false, cowlick: false },
  // Worn pushed back (gear.ts BEANIE_TILT): the cuff clears the brows at the
  // front and drops to the nape at the back, so the fringe shows under it.
  beanie: { ...OPEN, edge: [0.1745, 0.033, -0.1085], tuck: [0.02, 0, 0.01], top: "none", cowlick: false },
  // The helm is tipped back (gear.ts VIKING_TILT): its band sits on the brow.
  viking: { ...OPEN, edge: [0.1035, 0.0207, -0.0621], tuck: [-0.006, -0.006, -0.006], top: "none", fringe: "none", cowlick: false },
};

function edgeAt(e: [number, number, number], cosAz: number, x: number, roll: number): number {
  const base = cosAz >= 0 ? e[1] + (e[0] - e[1]) * cosAz : e[1] + (e[2] - e[1]) * -cosAz;
  return base + roll * x;
}

/**
 * Fit a lock under a hat: if its root is above the hat's edge, slide the root
 * down (toward the tip) until it hides just inside the edge. Null when what is
 * left is too short to be worth a lock.
 */
function underHat(L: Lock, cut: Cut): Lock | null {
  if (!cut.edge) return L;
  const edge = cut.edge;
  const yAt = (u: number) => {
    const d = lockDir(L, u, _v);
    const r = scalpR(d) + lockLift(L, u);
    const cosAz = d.z / Math.max(1e-6, Math.hypot(d.x, d.z));
    return { y: d.y * r, limit: edgeAt(edge, cosAz, d.x * r, cut.roll) + edgeAt(cut.tuck, cosAz, 0, 0) };
  };
  const at0 = yAt(0);
  if (at0.y <= at0.limit) return L;
  let lo = 0;
  let hi = 1;
  const end = yAt(1);
  if (end.y > end.limit) return null;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    const s = yAt(mid);
    if (s.y > s.limit) lo = mid;
    else hi = mid;
  }
  if (hi > 0.78) return null;
  // The same curve from the new root on, a little narrower for being shorter,
  // and lying flatter: the gap under a band is only a couple of centimetres.
  const r = lockDir(L, hi, new Vector3());
  const m = lockDir(L, (hi + 1) / 2, new Vector3());
  return { ...L, r, m, w: L.w * (1 - hi * 0.35), root: -0.004, lift: Math.min(L.lift, 0.011), flat: Math.min(L.flat, 0.3) };
}

/** Under a band with hair above it: stop a top lock short of the band. */
function aboveBand(L: Lock, cut: Cut): Lock | null {
  if (!cut.over) return L;
  const over = cut.over;
  let last = 1;
  for (let k = 1; k <= 24; k++) {
    const u = k / 24;
    const d = lockDir(L, u, _v);
    const r = scalpR(d) + lockLift(L, u);
    const lim = edgeAt(over, d.z / Math.max(1e-6, Math.hypot(d.x, d.z)), d.x * r, 0) + 0.028;
    if (d.y * r < lim) {
      last = (k - 1) / 24;
      break;
    }
  }
  if (last >= 1) return L;
  if (last < 0.45) return null;
  const t = lockDir(L, last, new Vector3());
  const m = lockDir(L, last / 2, new Vector3());
  return { ...L, t, m, tip: L.lift + (L.tip - L.lift) * 0.5 };
}

// ── the tables: one hairstyle, told lock by lock ─────────────────────────

/** The fringe, parted on his right and swept across to his left. */
const FRINGE: LockDeg[] = [
  // the small side of the parting, out to his right temple
  { a0: -34, e0: 56, a1: -54, e1: 30, w: 0.044, bow: -4, lift: 0.02, tip: 0.013 },
  { a0: -50, e0: 50, a1: -66, e1: 20, w: 0.038, lift: 0.019, tip: 0.014 },
  // the big side, across the brow
  { a0: -20, e0: 60, a1: 0, e1: 34, w: 0.056, bow: 5, lift: 0.021, tip: 0.014 },
  { a0: -4, e0: 58, a1: 19, e1: 33, w: 0.054, bow: 5, lift: 0.021, tip: 0.014 },
  { a0: 12, e0: 56, a1: 35, e1: 29.5, w: 0.05, bow: 4, lift: 0.02, tip: 0.014 },
  { a0: 28, e0: 53, a1: 50, e1: 22, w: 0.046, bow: 3, lift: 0.019, tip: 0.014 },
  { a0: 44, e0: 48, a1: 63, e1: 14, w: 0.04, lift: 0.018, tip: 0.013 },
];
/** Which fringe locks catch the light. */
const FRINGE_SHINE = new Set([2, 3, 4]);

/** Per side (mirrored): a lock in front of the ear, one over it, one behind it. */
const SIDES: LockDeg[] = [
  { a0: 66, e0: 32, a1: 77, e1: 3, w: 0.036, lift: 0.015, tip: 0.012 },
  { a0: 90, e0: 32, a1: 99, e1: 12, w: 0.042, lift: 0.017, tip: 0.021 },
  { a0: 116, e0: 24, a1: 127, e1: -4, w: 0.042, lift: 0.017, tip: 0.024 },
];
const SIDEBURN: LockDeg = { a0: 77, e0: 12, a1: 75, e1: -15, w: 0.016, lift: 0.005, tip: 0.003, root: -0.004, flat: 0.3 };

/** The nape: five locks that flip out over the collar. */
const NAPE: LockDeg[] = [145, 163, 180, 197, 215].map((a, i) => ({
  a0: a,
  e0: 2,
  a1: a + (a - 180) * 0.12,
  e1: i % 2 ? -32 : -37,
  w: 0.05,
  lift: 0.016,
  tip: 0.03,
}));

/** The tousled crown (no hat): twelve big locks swirling out of the whorl, six more on top. */
function crownLocks(): { lock: Lock; shine: boolean }[] {
  const out: { lock: Lock; shine: boolean }[] = [];
  const reach = [70, 64, 68, 72, 66, 70, 64, 69, 71, 65, 68, 72];
  for (let i = 0; i < 12; i++) {
    const psi = i * 30 + (i % 2 ? 7 : -4);
    const swirl = 16;
    const d1 = reach[i]!;
    out.push({
      lock: {
        r: whorl(psi, 9),
        m: whorl(psi + swirl * 0.6, (9 + d1) / 2),
        t: whorl(psi + swirl, d1),
        w: i % 2 ? 0.058 : 0.066,
        root: -0.006,
        lift: 0.026,
        tip: 0.036 + (i % 3) * 0.004,
        flat: 0.36,
      },
      // the ones facing forward catch the key light
      shine: psi < 70 || psi > 290,
    });
  }
  for (let i = 0; i < 6; i++) {
    const psi = i * 60 + 20;
    out.push({
      lock: { r: whorl(psi, 2), m: whorl(psi + 10, 19), t: whorl(psi + 18, 36), w: 0.05, root: -0.002, lift: 0.04, tip: 0.046, flat: 0.38 },
      shine: false,
    });
  }
  return out;
}

/** Inside a crown: a short forward tuft that stays within the band. */
function tuftLocks(): Lock[] {
  return [-45, 0, 45].map((psi) => ({ r: whorl(psi, 2), m: whorl(psi + 6, 18), t: whorl(psi + 10, 34), w: 0.048, root: -0.003, lift: 0.03, tip: 0.04, flat: 0.4 }));
}

/** The cowlick: one curl springing up from the whorl and hooking over to his left. */
function cowlickGeo(): BufferGeometry {
  const w0 = WHORL.clone().multiplyScalar(scalpR(WHORL) - 0.006);
  const pts = [
    [0, 0, 0],
    [0, 0.046, 0.004],
    [0.012, 0.094, 0.012],
    [0.045, 0.126, 0.02],
    [0.079, 0.116, 0.026],
    [0.09, 0.09, 0.026],
  ].map(([x, y, z]) => w0.clone().add(new Vector3(x, y, z)));
  return strand(pts, {
    seg: 16,
    radial: 7,
    w: (u) => 0.021 * Math.pow(Math.max(0, Math.sin(Math.PI * Math.pow(u, 0.55))), 0.8),
    d: (u) => 0.012 * Math.pow(Math.max(0, Math.sin(Math.PI * Math.pow(u, 0.55))), 0.8) + 0.001,
    up: FWD,
  });
}

/** A moustache half (sx = his side): rooted under the nose, out along the lip. */
function moustacheHalf(sx: number, style: "curl" | "droop" | "neat"): BufferGeometry {
  const base: [number, number, number][] = [
    [0.004, -0.088, 0.008],
    [0.028, -0.094, 0.015],
    [0.054, -0.104, 0.016],
  ];
  const tail: [number, number, number][] =
    style === "curl"
      ? [[0.078, -0.108, 0.014], [0.094, -0.097, 0.013], [0.093, -0.082, 0.012], [0.083, -0.077, 0.011]]
      : style === "droop"
        ? [[0.08, -0.124, 0.017], [0.097, -0.153, 0.021]]
        : [[0.074, -0.114, 0.014], [0.085, -0.121, 0.012]];
  const pts = [...base, ...tail].map(([x, y, l]) => front(HEAD_E, x * sx, y, l));
  const W = style === "droop" ? 0.019 : style === "curl" ? 0.017 : 0.015;
  const w = (u: number) => W * (u < 0.12 ? 0.8 + 0.2 * (u / 0.12) : 1 - 0.92 * Math.pow((u - 0.12) / 0.88, 1.35));
  return strand(pts, { seg: style === "curl" ? 18 : 12, radial: 7, w, d: (u) => 0.6 * w(u) + 0.001, up: (p) => ellNormal(HEAD_E, p, _up) });
}

// ── the eye ──────────────────────────────────────────────────────────────

/** Where the eyes sit, and the sclera's semi-axes (a 0.064 sphere scaled 0.9, 1.05, 0.45). */
const EYE = { x: 0.105, y: 0.02, z: 0.255, turn: 0.1 } as const;
/**
 * The upper lid: an ellipsoid just bigger than the eyeball, cut by a plane
 * tilted back so its lower edge arches over the eye. It sits proud of the
 * iris even when he looks all the way up, so the iris slides under it.
 */
const LID = { a: 0.064, b: 0.074, c: 0.05, theta: 70 * DEG, tilt: 0.35, droop: 0.08 } as const;
const LID_E: Ell = { x: 0, y: 0, z: 0, a: LID.a, b: LID.b, c: LID.c };
/**
 * The iris: concentric caps on one 0.12 sphere, apex this far ahead of the
 * pupil node, stretched tall. Sized so that at a full diagonal glance
 * (applyPose moves the pupil node up to 0.012 each way) it stays inside the
 * white of the eye — larger and it slides out from under the lid's corner.
 */
const IRIS = { r: 0.039, R: 0.12, apex: 0.0132, tall: 1.08 } as const;

function lidPoint(phi: number, sx: number, out: Vector3): Vector3 {
  const st = Math.sin(LID.theta);
  out.set(-Math.cos(phi) * st, Math.cos(LID.theta), Math.sin(phi) * st);
  out.applyAxisAngle(X_AXIS, -LID.tilt).applyAxisAngle(Z_AXIS, -LID.droop * sx);
  return out.set(out.x * LID.a, out.y * LID.b, out.z * LID.c);
}

/** One layer of the iris: a cap of the iris sphere, `lift` above it, centred (dx, dy) off the axis. */
function irisCap(r: number, lift: number, dx = 0, dy = 0, seg = 18): BufferGeometry {
  const R = IRIS.R + lift;
  const g = new SphereGeometry(R, seg, 3, 0, Math.PI * 2, 0, Math.asin(Math.min(0.99, r / R)));
  g.rotateX(Math.PI / 2);
  if (dy) g.rotateX(-dy / R);
  if (dx) g.rotateY(dx / R);
  g.translate(0, 0, IRIS.apex - IRIS.R);
  return g.scale(1, IRIS.tall, 1);
}

// ── the head ─────────────────────────────────────────────────────────────

/**
 * Build the neck's skin, the head and everything on it onto rig.ts's `neck`
 * and `head` groups (which stay rig.ts's: their positions and rotation orders
 * are the skeleton's). Returns the nodes applyPose animates.
 */
export function buildFace(b: FaceBuilder, neck: Group, head: Group, outfit: Outfit): Face {
  const kit = b.kit;
  const skin = hexOf("skin", outfit.skin);
  const hair = hexOf("hair", outfit.hair);
  const eyes = hexOf("eyes", outfit.eyes);
  const gold = "#e3b341";

  const mSkin = kit.toon(skin);
  const mSkinShade = kit.toon(darken(skin, 0.88));
  const mHair = kit.toon(hair);
  const mInk = kit.basic("#151216");
  const mWhite = kit.basic("#fbfaf7");
  const mGold = kit.toon(gold, { emissive: "#6b4a10", emissiveIntensity: 0.35 });
  const cut = CUTS[outfit.hat] ?? OPEN;
  const beard = outfit.beard;

  // ── neck: skin, and the shadow where the collar meets it ──
  b.part(new CylinderGeometry(0.075, 0.085, 0.08, 14), mSkinShade, neck, { pos: [0, 0.02, 0] });
  b.part(new TorusGeometry(0.081, 0.009, 6, 20), kit.toon(darken(skin, 0.7)), neck, { pos: [0, 0.012, 0], rot: [Math.PI / 2, 0, 0], ...NOFX });

  // ── the head itself ──
  b.part(new SphereGeometry(0.3, 28, 20), mSkin, head, { scale: [1, 0.96, 0.95] });

  // ── ears: a shell turned a little forward, a lobe, the inner fold and the helix's drawn C ──
  {
    const shells: BufferGeometry[] = [];
    const folds: BufferGeometry[] = [];
    for (const sx of [1, -1] as const) {
      const m = new Matrix4().compose(new Vector3(0.293 * sx, -0.025, 0.004), new Quaternion().setFromEuler(new Euler(0, -0.4 * sx, -0.12 * sx)), new Vector3(1, 1, 1));
      shells.push(new SphereGeometry(0.064, 16, 12).scale(0.42, 1, 0.74).applyMatrix4(m));
      shells.push(new SphereGeometry(0.019, 10, 8).translate(0.004 * sx, -0.05, 0.008).applyMatrix4(m));
      folds.push(new SphereGeometry(0.036, 12, 8).scale(0.38, 0.95, 0.62).translate(0.016 * sx, -0.006, 0.012).applyMatrix4(m));
      const helix: Vector3[] = [];
      for (let i = 0; i <= 8; i++) {
        const th = (55 + (190 * i) / 8) * DEG;
        const y = 0.049 * Math.sin(th);
        const z = 0.036 * Math.cos(th);
        const x = 0.0269 * Math.sqrt(Math.max(0, 1 - (y / 0.064) ** 2 - (z / 0.0474) ** 2)) + 0.0016;
        helix.push(new Vector3(x * sx, y, z));
      }
      folds.push(strand(helix, { seg: 14, radial: 5, w: (u) => 0.0034 * (0.4 + 0.6 * Math.sin(Math.PI * u)), d: () => 0.0018, up: new Vector3(sx, 0, 0) }).applyMatrix4(m));
    }
    b.part(merge(shells), mSkin, head);
    b.part(merge(folds), kit.toon(darken(skin, 0.74)), head, NOFX);
  }

  // ── nose: a button with a shine, two nostrils and the shadow it drops on the lip ──
  // NO INK on the nose: a full outline ring round a sphere this small, in the
  // middle of the face, read as a clown's ball stuck on. Shading, the shine
  // and the nostrils carry it; the head's own outline still gives the profile.
  const NOSE: Ell = { x: 0, y: -0.054, z: 0.284, a: 0.036 * 1.2, b: 0.036 * 0.9, c: 0.036 * 0.85 };
  b.part(new SphereGeometry(0.036, 18, 12), kit.toon(new Color(skin).lerp(new Color("#ff8a7a"), 0.12).multiplyScalar(0.95)), head, {
    pos: [NOSE.x, NOSE.y, NOSE.z],
    scale: [1.2, 0.9, 0.85],
    outline: false,
  });
  b.part(decal(NOSE, along(NOSE, new Vector3(0.42, 0.5, 0.76).normalize()), 0.0088, { sx: 1, sy: 0.7, twist: -0.65, lift: 0.0012, seg: 10 }), kit.basic(css(lighten(skin, 0.62))), head, NOFX);
  b.part(
    merge([1, -1].map((sx) => decal(NOSE, along(NOSE, new Vector3(0.42 * sx, -0.62, 0.66).normalize()), 0.0062, { sx: 1.3, sy: 0.7, twist: 0.5 * sx, lift: 0.001, seg: 8 }))),
    kit.toon(darken(skin, 0.5)),
    head,
    NOFX,
  );
  b.part(decal(HEAD_E, front(HEAD_E, -0.006, -0.096), 0.021, { sx: 1, sy: 0.38, lift: 0.0012, seg: 14 }), kit.toon(darken(skin, 0.84)), head, NOFX);

  // ── cheeks: blush, freckles across the nose, a hint of chin ──
  b.part(
    merge([1, -1].map((sx) => decal(HEAD_E, front(HEAD_E, 0.165 * sx, -0.085), 0.046, { sx: 1.15, sy: 0.72, lift: 0.0026, seg: 18 }))),
    kit.basic("#ff7c8a", { transparent: true, opacity: 0.35 }),
    head,
    NOFX,
  );
  {
    const spots: [number, number, number][] = [
      [0.074, -0.06, 1], [0.1, -0.075, 0.85], [0.126, -0.061, 1.05], [0.147, -0.081, 0.8], [0.113, -0.093, 0.9],
      [-0.078, -0.064, 0.95], [-0.104, -0.078, 1.05], [-0.13, -0.06, 0.85], [-0.143, -0.086, 1],
    ];
    const marks = spots.map(([x, y, s]) => decal(HEAD_E, front(HEAD_E, x, y), 0.0056 * s, { lift: 0.0015, seg: 8 }));
    // two on the bridge of the button nose
    for (const sx of [1, -1]) marks.push(decal(NOSE, along(NOSE, new Vector3(0.36 * sx, 0.66, 0.66).normalize()), 0.0048, { lift: 0.001, seg: 8 }));
    b.part(merge(marks), kit.toon(darken(skin, 0.7)), head, NOFX);
  }
  if (beard !== "full" && beard !== "goatee") {
    const chin = [-0.021, -0.01, 0, 0.01, 0.021].map((x) => front(HEAD_E, x, -0.211 + 0.0065 * (x / 0.021) ** 2, 0.0018));
    b.part(strand(chin, { seg: 10, radial: 5, w: (u) => 0.0032 * Math.pow(Math.sin(Math.PI * u), 0.8) + 0.0006, d: () => 0.0018, up: (p) => ellNormal(HEAD_E, p, _up) }), kit.toon(darken(skin, 0.8)), head, NOFX);
  }

  // ── eyes ──
  const mIrisRing = kit.basic(css(darken(eyes, 0.42)));
  const mIris = kit.basic(eyes);
  const mIrisGlow = kit.basic(css(lighten(eyes, 0.2)));
  const mPupil = kit.basic("#0b0a0e");
  const eye = (sx: 1 | -1) => {
    const g = new Group();
    g.name = "eye";
    g.position.set(EYE.x * sx, EYE.y, EYE.z);
    g.rotation.y = EYE.turn * sx;
    head.add(g);
    b.part(new SphereGeometry(0.064, 18, 14), mWhite, g, { scale: [0.9, 1.05, 0.45] });
    // the gaze moves this node; the iris, pupil and both catch-lights ride it
    const pupil = new Group();
    pupil.name = "pupil";
    pupil.position.set(0, 0, 0.022);
    g.add(pupil);
    b.part(irisCap(IRIS.r, 0), mIrisRing, pupil, NOFX);
    b.part(irisCap(IRIS.r * 0.82, 0.0008), mIris, pupil, NOFX);
    b.part(irisCap(IRIS.r * 0.47, 0.0016, 0, -IRIS.r * 0.3, 14), mIrisGlow, pupil, NOFX);
    b.part(irisCap(IRIS.r * 0.41, 0.0024, 0, 0.001, 14), mPupil, pupil, NOFX);
    b.part(merge([irisCap(IRIS.r * 0.26, 0.0032, IRIS.r * 0.3, IRIS.r * 0.38, 12), irisCap(IRIS.r * 0.13, 0.0032, -IRIS.r * 0.28, -IRIS.r * 0.45, 10)]), mWhite, pupil, NOFX);
    // the upper lid and its lash line: inside the eye group, so the blink closes them too
    b.part(new SphereGeometry(1, 22, 7, 0, Math.PI * 2, 0, LID.theta).rotateX(-LID.tilt).rotateZ(-LID.droop * sx).scale(LID.a, LID.b, LID.c), mSkin, g, NOFX);
    const lash: Vector3[] = [];
    for (let i = 0; i <= 8; i++) {
      const s = i / 8;
      const phi = sx > 0 ? lerp(0.52, Math.PI - 0.3, s) : lerp(Math.PI - 0.52, 0.3, s);
      const p = lidPoint(phi, sx, new Vector3());
      lash.push(p.addScaledVector(ellNormal(LID_E, p, _n), 0.0032));
    }
    const corner = lash[lash.length - 1]!;
    const lid = lash.slice(1, -1);
    lash.push(corner.clone().add(new Vector3(0.011 * sx, 0.004, -0.0015)), corner.clone().add(new Vector3(0.019 * sx, 0.012, -0.0035)));
    const lashW = (u: number) => 0.0066 * (u < 0.1 ? 0.5 + 0.5 * smooth(u / 0.1) : u < 0.82 ? 0.92 + (0.18 * (u - 0.1)) / 0.72 : 1.1 * Math.pow(Math.max(0, 1 - (u - 0.82) / 0.18), 0.8));
    const lidUp = (p: Vector3) => ellNormal(LID_E, p, _up);
    b.part(strand(lash, { seg: 22, radial: 6, w: lashW, d: () => 0.0034, up: lidUp }), mInk, g, NOFX);
    // THE CLOSED EYE. A blink squashes the eye group flat, and a flat eye's
    // own ink sinks behind the skin, so a shut eye would be a pale sliver. A
    // hair-thin core inside the lash carries an outline: open, the lid hides
    // all of that ink above the lash and it only thickens the line a little
    // below; shut, it is the bold line a closed cartoon eye is drawn with.
    b.part(strand(lid, { seg: 14, radial: 5, w: () => 0.0012, d: () => 0.0012, up: lidUp }), mInk, g, { hit: false });
    return { g, pupil };
  };
  const EL = eye(1);
  const ER = eye(-1);

  // ── brows: tapered and arched, fat at the inner end, wrapped round the brow bone ──
  const mBrow = kit.toon(darken(hair, 0.85));
  const brow = (sx: 1 | -1) => {
    const g = new Group();
    g.name = "brow";
    const o = front(HEAD_E, 0.112 * sx, 0.12, 0.024);
    g.position.set(o.x, 0.12, o.z);
    head.add(g);
    const pts: Vector3[] = [];
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      const x = sx * (0.062 + 0.1 * t);
      const y = 0.111 + 0.021 * Math.sin(Math.PI * Math.pow(t, 0.8)) - 0.004 * t;
      pts.push(front(HEAD_E, x, y, 0.021 + 0.007 * (1 - t)).sub(g.position));
    }
    const w = (u: number) => 0.0105 * (u < 0.12 ? 0.55 + 0.45 * smooth(u / 0.12) : 1 - 0.78 * Math.pow((u - 0.12) / 0.88, 1.2));
    b.part(strand(pts, { seg: 14, radial: 6, w, d: (u) => 0.55 * w(u) + 0.001, up: (p) => ellNormal(HEAD_E, _up.copy(p).add(g.position), _up) }), mBrow, g, NOFX);
    return g;
  };
  const browL = brow(1);
  const browR = brow(-1);

  // ── mouth ──
  // The smile: applyPose flips it (a frown is the same arc the other way up)
  // and squashes it flat at rest, so the stroke is fat in the middle — where
  // the squash thins it — and fine at the corners, with a dimple tick each side.
  const mouthArc = new Group();
  mouthArc.name = "mouthArc";
  mouthArc.position.set(0, -0.135, 0.27);
  head.add(mouthArc);
  {
    const arc: Vector3[] = [];
    for (let i = 0; i <= 10; i++) {
      const a = (i / 10) * Math.PI;
      const x = 0.05 * Math.cos(a);
      arc.push(new Vector3(x, 0.05 * Math.sin(a), -0.012 * (x / 0.05) ** 2));
    }
    const parts = [strand(arc, { seg: 20, radial: 6, w: (u) => 0.0035 + 0.0085 * Math.pow(Math.sin(Math.PI * u), 1.2), d: () => 0.0045 })];
    for (const c of [1, -1]) {
      const tick = [new Vector3(0.0525 * c, -0.0095, -0.013), new Vector3(0.0575 * c, 0, -0.012), new Vector3(0.0525 * c, 0.0095, -0.013)];
      parts.push(strand(tick, { seg: 6, radial: 5, w: (u) => 0.0026 * Math.pow(Math.sin(Math.PI * u), 0.7) + 0.0008, d: () => 0.003 }));
    }
    b.part(merge(parts), mInk, mouthArc, NOFX);
  }
  // Open: a dark oval with the top of the same oval as upper teeth, and a tongue.
  const mouthOpen = new Group();
  mouthOpen.name = "mouthOpen";
  mouthOpen.position.set(0, -0.14, 0.27);
  head.add(mouthOpen);
  b.part(new SphereGeometry(0.05, 16, 12), kit.basic("#3a1218"), mouthOpen, { scale: [1, 1, 0.35], ...NOFX });
  b.part(new SphereGeometry(0.047, 16, 6, 0, Math.PI, 0, 1.08), mWhite, mouthOpen, { scale: [1, 1, 0.44], ...NOFX });
  b.part(new SphereGeometry(0.028, 14, 10), kit.basic("#e0566a"), mouthOpen, { pos: [0, -0.024, 0.006], scale: [1.3, 0.62, 0.42], ...NOFX });

  // ── hair: the cap rig.ts has always had, plus the locks this hat leaves showing ──
  {
    const locks: BufferGeometry[] = [];
    const shines: BufferGeometry[] = [];
    locks.push(place(new SphereGeometry(CAP.r, 24, 14, 0, Math.PI * 2, 0, CAP.theta), [0, 0, 0], [-CAP.tilt, 0, 0], [CAP.sx, CAP.sy, 1]));
    const add = (L: Lock | null, shine = false) => {
      if (!L) return;
      locks.push(lockGeo(L));
      if (shine) shines.push(shineGeo(L));
    };
    if (cut.top === "full") {
      for (const { lock, shine } of crownLocks()) add(aboveBand(lock, cut), shine && !cut.over);
    } else if (cut.top === "tuft") {
      for (const L of tuftLocks()) add(L);
    }
    if (cut.cowlick) locks.push(cowlickGeo());
    if (cut.fringe !== "none") {
      FRINGE.forEach((def, i) => {
        if (cut.fringe === "hood" && (def.a0 < -30 || def.a0 > 30)) return;
        // Under a brim most of the fringe is hidden, so what peeks out hangs a little lower.
        const shaped = cut.fringe === "hood" ? { ...def, lift: (def.lift ?? 0.018) * 0.75 } : cut.edge ? { ...def, e1: def.e1 - 4, w: def.w * 1.08 } : def;
        const L = lockOf(shaped);
        const fitted = underHat(L, cut);
        // a fringe cut short by a brim is too small for a shine to read
        add(fitted, FRINGE_SHINE.has(i) && fitted === L);
      });
    }
    for (const sx of [1, -1]) {
      if (cut.sides) for (const def of SIDES) add(underHat(lockOf(def, sx), cut));
      if (cut.fringe !== "hood") add(underHat(lockOf(SIDEBURN, sx), cut));
    }
    if (cut.nape) for (const def of NAPE) add(underHat(lockOf(def), cut));
    b.part(merge(locks), mHair, head);
    if (shines.length) b.part(merge(shines), kit.toon(lighten(hair, 0.22)), head, NOFX);
  }

  // ── facial hair ──
  if (beard === "full") {
    const clumps: BufferGeometry[] = [];
    const defs: LockDeg[] = [
      { a0: 82, e0: 0, a1: 72, e1: -32, w: 0.048, lift: 0.024, tip: 0.03, root: -0.01 },
      { a0: 62, e0: -14, a1: 50, e1: -50, w: 0.054, lift: 0.032, tip: 0.042, root: -0.012 },
      { a0: 40, e0: -28, a1: 30, e1: -60, w: 0.056, lift: 0.036, tip: 0.05, root: -0.012 },
      { a0: 18, e0: -36, a1: 13, e1: -66, w: 0.054, lift: 0.04, tip: 0.058, root: -0.012 },
    ];
    // Inside a hood only the face opening shows: the clumps rooted back by the
    // ears would stand out through its sides, so they are left off.
    const shown = cut.fringe === "hood" ? defs.filter((d) => d.a0 < 55) : defs;
    for (const sx of [1, -1]) for (const d of shown) clumps.push(lockGeo(lockOf({ ...d, flat: 0.42 }, sx)));
    clumps.push(lockGeo(lockOf({ a0: 0, e0: -38, a1: 0, e1: -70, w: 0.058, lift: 0.042, tip: 0.064, root: -0.012, flat: 0.42 })));
    clumps.push(lockGeo(lockOf({ a0: 0, e0: -34, a1: 0, e1: -50, w: 0.03, lift: 0.014, tip: 0.02, root: -0.006, flat: 0.4 })));
    for (const sx of [1, -1]) clumps.push(moustacheHalf(sx, "droop"));
    b.part(merge(clumps), mHair, head);
    // the darker mass under the clumps, so the gaps between them read as depth
    b.part(new SphereGeometry(0.16, 18, 12), kit.toon(darken(hair, 0.78)), head, { pos: [0, -0.19, 0.08], scale: [1.2, 0.78, 0.8] });
  } else if (beard === "mustache") {
    b.part(merge([moustacheHalf(1, "curl"), moustacheHalf(-1, "curl")]), mHair, head);
  } else if (beard === "goatee") {
    const tuft = [front(HEAD_E, 0, -0.168, 0.004), front(HEAD_E, 0, -0.205, 0.02), new Vector3(0, -0.255, 0.198), new Vector3(0.005, -0.3, 0.172)];
    const w = (u: number) => 0.03 * Math.pow(Math.max(0, Math.sin(Math.PI * Math.pow(u, 0.7))), 0.85);
    const pieces = [moustacheHalf(1, "neat"), moustacheHalf(-1, "neat"), strand(tuft, { seg: 14, radial: 7, w, d: (u) => 0.6 * w(u) + 0.001, up: new Vector3(0, 0.3, 1).normalize() })];
    b.part(merge(pieces), mHair, head);
  } else if (beard === "stubble") {
    b.part(new SphereGeometry(0.3, 24, 10, Math.PI * 0.12, Math.PI * 0.76, Math.PI * 0.58, Math.PI * 0.4), kit.toon(hair, { transparent: true, opacity: 0.3 }), head, {
      scale: [1.03, 0.97, 0.985],
      ...NOFX,
    });
    // a scatter of dots on the jaw and lip, the same every build
    const dots: BufferGeometry[] = [];
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let tries = 0; dots.length < 26 && tries < 400; tries++) {
      const x = (rnd() - 0.5) * 0.44;
      const y = -0.075 - rnd() * 0.17;
      if (Math.abs(x) < 0.075 && y < -0.098 && y > -0.2) continue; // the mouth
      if (Math.abs(x) < 0.04 && y > -0.098) continue; // the nose
      if ((x / HEAD.a) ** 2 + (y / HEAD.b) ** 2 > 0.84) continue; // over the jaw's edge
      dots.push(decal(HEAD_E, front(HEAD_E, x, y), 0.0038, { lift: 0.0125, seg: 6 }));
    }
    b.part(merge(dots), kit.toon(darken(hair, 0.75)), head, NOFX);
  }

  // ── eyewear ──
  if (outfit.eyewear === "round" || outfit.eyewear === "monocle") {
    const round = outfit.eyewear === "round";
    const sides = round ? [1, -1] : [-1];
    const metal: BufferGeometry[] = [];
    const lenses: BufferGeometry[] = [];
    const glints: BufferGeometry[] = [];
    for (const sx of sides) {
      const at: V3 = [EYE.x * sx, EYE.y, 0.306];
      const turn: V3 = [0, EYE.turn * sx, 0];
      metal.push(place(new TorusGeometry(0.07, 0.008, 6, 30), at, turn));
      if (!round) metal.push(place(new TorusGeometry(0.0615, 0.0035, 5, 30), [at[0], at[1], at[2] + 0.004], turn));
      lenses.push(place(new CircleGeometry(0.067, 26), [at[0], at[1], at[2] - 0.002], turn));
      const glint = [new Vector3(-0.034, 0.008, 0.002), new Vector3(-0.022, 0.03, 0.002), new Vector3(-0.004, 0.046, 0.002)];
      glints.push(place(strand(glint, { seg: 8, radial: 5, w: (u) => 0.0055 * Math.pow(Math.sin(Math.PI * u), 0.6), d: () => 0.0008 }), [at[0], at[1], at[2] - 0.001], turn));
      glints.push(place(new CircleGeometry(0.0045, 8), [at[0] + 0.018, at[1] - 0.03, at[2] + 0.0008], turn));
    }
    if (round) {
      const thin = (r: number) => () => r;
      // keyhole bridge
      metal.push(strand([new Vector3(-0.036, 0.03, 0.303), new Vector3(-0.016, 0.044, 0.309), new Vector3(0.016, 0.044, 0.309), new Vector3(0.036, 0.03, 0.303)], { seg: 10, radial: 5, w: thin(0.0055), d: thin(0.0045) }));
      for (const sx of [1, -1]) {
        // nose pads on little arms, resting on the skin
        const pad = front(HEAD_E, 0.031 * sx, -0.012, 0.004);
        metal.push(strand([new Vector3(0.052 * sx, -0.022, 0.303), new Vector3(0.042 * sx, -0.018, 0.298), pad.clone()], { seg: 6, radial: 4, w: thin(0.0025), d: thin(0.0025) }));
        metal.push(place(new SphereGeometry(0.0075, 8, 6), [pad.x, pad.y, pad.z], [0, 0.5 * sx, 0], [0.55, 1, 0.5]));
        // temples back to the ears, over the top of each ear
        const temple = [[0.174, 0.026, 0.298], [0.235, 0.03, 0.24], [0.29, 0.032, 0.13], [0.315, 0.035, 0.02], [0.305, 0.0, -0.06]].map(([x, y, z]) => new Vector3(x! * sx, y!, z!));
        metal.push(strand(temple, { seg: 16, radial: 5, w: thin(0.0045), d: thin(0.0035) }));
      }
    } else {
      // the monocle's chain, bead by bead, draped over the cheek to the collar
      const chain = new CatmullRomCurve3([new Vector3(-0.155, -0.03, 0.302), new Vector3(-0.172, -0.085, 0.248), new Vector3(-0.185, -0.15, 0.19), new Vector3(-0.18, -0.215, 0.12), new Vector3(-0.165, -0.27, 0.09)], false, "centripetal");
      const n = Math.round(chain.getLength() / 0.0105);
      for (const p of chain.getSpacedPoints(n)) metal.push(place(new SphereGeometry(0.0046, 6, 4), [p.x, p.y, p.z]));
      const end = chain.getPoint(1);
      metal.push(place(new SphereGeometry(0.012, 10, 8), [end.x, end.y - 0.01, end.z], [0, 0, 0], [1, 1.25, 0.7]));
      metal.push(place(new TorusGeometry(0.008, 0.0025, 5, 10), [-0.155, -0.03, 0.302], [0, 0, 0.6]));
    }
    b.part(merge(metal), mGold, head, NOFX);
    b.part(merge(lenses), kit.basic("#d6ecff", { transparent: true, opacity: 0.16 }), head, NOFX);
    b.part(merge(glints), kit.basic("#ffffff", { transparent: true, opacity: 0.6 }), head, NOFX);
  } else if (outfit.eyewear === "shades") {
    const dark = kit.toon("#141418", { emissive: "#2b3a55", emissiveIntensity: 0.4 });
    const frame: BufferGeometry[] = [];
    const stripes: BufferGeometry[] = [];
    for (const sx of [1, -1]) {
      const at: V3 = [EYE.x * sx, 0.024, 0.306];
      const turn: V3 = [Math.PI / 2, 0.12 * sx, 0];
      frame.push(place(new CylinderGeometry(0.064, 0.064, 0.016, 26), at, turn, [1.08, 1, 0.78]));
      frame.push(strand([[0.17, 0.042, 0.29], [0.235, 0.044, 0.235], [0.29, 0.04, 0.13], [0.315, 0.036, 0.02]].map(([x, y, z]) => new Vector3(x! * sx, y!, z!)), { seg: 12, radial: 5, w: () => 0.0055, d: () => 0.004 }));
      // a glossy stripe across each lens, and a thinner one beside it
      for (const [x0, y0, x1, y1, w] of [[-0.046, -0.012, -0.012, 0.034, 0.0075], [-0.006, -0.028, 0.018, 0.006, 0.0035]] as const) {
        const s = strand([new Vector3(x0, y0, 0), new Vector3(x1, y1, 0)], { seg: 4, radial: 4, w: (u) => w * Math.pow(Math.sin(Math.PI * u), 0.4), d: () => 0.0008 });
        _q.setFromEuler(_e.set(0, 0.12 * sx, 0));
        s.applyQuaternion(_q).translate(at[0], at[1], at[2] + 0.0105);
        stripes.push(s);
      }
    }
    // the brow bar over both lenses
    frame.push(strand([new Vector3(-0.168, 0.052, 0.293), new Vector3(-0.07, 0.06, 0.312), new Vector3(0.07, 0.06, 0.312), new Vector3(0.168, 0.052, 0.293)], { seg: 14, radial: 5, w: () => 0.0075, d: () => 0.006 }));
    b.part(merge(frame), dark, head);
    b.part(merge(stripes), kit.basic("#ffffff", { transparent: true, opacity: 0.7 }), head, NOFX);
  } else if (outfit.eyewear === "visor") {
    const span = Math.PI * 0.32;
    // Deeper than round (z × VZ): the lids stand proud and the lash flicks
    // reach out to x ≈ ±0.15 at z 0.29, which a round 0.31 band would cut.
    const VZ = 1.07;
    b.part(new CylinderGeometry(0.31, 0.31, 0.085, 28, 1, true, -span, span * 2), kit.toon("#26f0c8", { emissive: "#18c8a8", emissiveIntensity: 0.9, side: DoubleSide, transparent: true, opacity: 0.78 }), head, { pos: [0, 0.03, 0.005], scale: [1, 1, VZ], outline: false });
    // the bright scan line inside it
    b.part(new CylinderGeometry(0.306, 0.306, 0.016, 28, 1, true, -span * 0.94, span * 1.88), kit.basic("#d9fff6", { transparent: true, opacity: 0.85, side: DoubleSide }), head, { pos: [0, 0.03, 0.005], scale: [1, 1, VZ], ...NOFX });
    // hinges at either end and the arms back over the ears
    const sidePieces: BufferGeometry[] = [];
    for (const sx of [1, -1]) {
      const ex = 0.31 * Math.sin(span) * sx;
      const ez = 0.005 + 0.31 * Math.cos(span) * VZ;
      sidePieces.push(place(new SphereGeometry(0.022, 12, 8), [ex, 0.03, ez], [0, span * sx, 0], [0.6, 1.15, 0.85]));
      sidePieces.push(strand([new Vector3(ex, 0.03, ez), new Vector3(0.3 * sx, 0.03, 0.08), new Vector3(0.316 * sx, 0.03, 0)], { seg: 10, radial: 6, w: () => 0.012, d: () => 0.007, up: new Vector3(sx, 0, 0) }));
    }
    b.part(merge(sidePieces), kit.toon("#2a2f3a"), head);
  }

  return { eyeL: EL.g, eyeR: ER.g, pupilL: EL.pupil, pupilR: ER.pupil, browL, browR, mouthArc, mouthOpen };
}
