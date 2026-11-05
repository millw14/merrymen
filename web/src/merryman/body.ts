/**
 * THE MERRYMAN'S BODY AND CLOTHES: hips, legs, boots, the torso by style,
 * arms and hands.
 *
 * The same primitives-only rule as the rest of the figure (rig.ts), at three
 * levels of detail:
 *
 *  1. PRIMARY forms carry the silhouette and the ink — the lathe torso, the
 *     limb capsules, boots, belt, hands. Every node they hang from (hips,
 *     spine, thigh/knee/foot, shoulder/elbow/hand) sits exactly where it always
 *     did, so applyPose and every clip still fit.
 *  2. SECONDARY forms sit ON those surfaces: a dagged hem, a laced V-neck, a
 *     buckle with a prong, a pouch, folded boot cuffs, bracers. They are placed
 *     by asking the surface for its radius and slope at that height (`Prof`),
 *     never by eye, so a lace crossing a curved chest does not sink into it.
 *  3. TERTIARY texture — stitching, eyelets, rivets, mail rings — is many tiny
 *     pieces merged per (node, material) into ONE un-inked mesh (`Bag`), so a
 *     hundred rivets cost one draw call and the outline does not turn to mush.
 *
 * Nothing here moves on its own and nothing allocates per frame.
 *
 * In buildRig this replaces the "hips and legs", "torso, by style" and "arms"
 * sections, before the neck and head are built on `spine`:
 *
 *   const { hips, spine, L, R, AL, AR } = buildBody(b, outfit, body);
 */
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CapsuleGeometry,
  CatmullRomCurve3,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Euler,
  Group,
  LatheGeometry,
  Matrix4,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  TorusKnotGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
  type Material,
  type Mesh,
  type Object3D,
} from "three";
import { hexOf, type Outfit } from "./outfit";
import type { Kit } from "./rig";

// ── the contract with rig.ts ─────────────────────────────────────────────

type V3 = [number, number, number];
export type PartOpts = { pos?: V3; rot?: V3; scale?: V3; outline?: boolean; hit?: boolean };

/** rig.ts's Builder, as far as the body needs it — its `b` satisfies this as is. */
export type BodyBuilder = {
  kit: Kit;
  part(geo: BufferGeometry, mat: Material, parent: Object3D, opts?: PartOpts): Mesh;
};

export type LegNodes = { thigh: Group; knee: Group; foot: Group };
export type ArmNodes = { shoulder: Group; elbow: Group; hand: Group };
/** The nodes applyPose rotates, named and placed exactly as rig.ts always had them. */
export type BodyNodes = { hips: Group; spine: Group; L: LegNodes; R: LegNodes; AL: ArmNodes; AR: ArmNodes };

// ── small helpers ────────────────────────────────────────────────────────

const PI = Math.PI;
const TAU = PI * 2;
const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const clamp01 = (x: number) => clamp(x, 0, 1);
const smooth = (x: number) => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};
const shade = (c: string | Color, f: number) => new Color(c).multiplyScalar(f);
const tint = (c: string | Color, toward: string | Color, f: number) => new Color(c).lerp(new Color(toward), f);
const lighten = (c: string | Color, f: number) => tint(c, "#ffffff", f);

const group = (parent: Object3D, x = 0, y = 0, z = 0, name = "") => {
  const g = new Group();
  g.position.set(x, y, z);
  g.name = name;
  parent.add(g);
  return g;
};
const sphere = (r: number, w = 20, h = 14) => new SphereGeometry(r, w, h);
const capsule = (r: number, len: number) => new CapsuleGeometry(r, len, 5, 12);
const v2 = (x: number, y: number) => new Vector2(x, y);
const v3 = (x = 0, y = 0, z = 0) => new Vector3(x, y, z);

/** [radius, height] — a point on a lathe profile. */
type RY = readonly [number, number];
/** [arc length across the front, height] — a point drawn ON a surface. */
type SY = readonly [number, number];

const lathe = (pts: readonly RY[], segs: number) => new LatheGeometry(pts.map(([r, y]) => v2(r, y)), segs, PI, TAU);

const _m = new Matrix4();
const _q = new Quaternion();
const _e = new Euler();
const _s = new Vector3();
const _p = new Vector3();
const UP = new Vector3(0, 1, 0);

/** Bake a transform into a geometry: translate · rotate (XYZ) · scale, like a Mesh. */
function at(g: BufferGeometry, pos: V3 | Vector3, rot?: V3, scale?: V3): BufferGeometry {
  _e.set(rot?.[0] ?? 0, rot?.[1] ?? 0, rot?.[2] ?? 0);
  _q.setFromEuler(_e);
  if (Array.isArray(pos)) _p.set(pos[0], pos[1], pos[2]);
  else _p.copy(pos);
  _s.set(scale?.[0] ?? 1, scale?.[1] ?? 1, scale?.[2] ?? 1);
  return g.applyMatrix4(_m.compose(_p, _q, _s));
}

/** A capsule spanning a → b: one stitch of cord, lace, seam or piping. */
function rod(a: Vector3, b: Vector3, r: number, radial = 6): BufferGeometry {
  const d = new Vector3().subVectors(b, a);
  const len = d.length();
  const g = new CapsuleGeometry(r, Math.max(1e-5, len), 2, radial);
  if (len > 1e-7) _q.setFromUnitVectors(UP, d.divideScalar(len));
  else _q.identity();
  _p.addVectors(a, b).multiplyScalar(0.5);
  return g.applyMatrix4(_m.compose(_p, _q, _s.set(1, 1, 1)));
}

/** Rods along a polyline; round joints, so a zig-zag keeps clean corners. */
function chain(pts: readonly Vector3[], r: number, closed = false, radial = 6): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  const n = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) out.push(rod(pts[i]!, pts[(i + 1) % pts.length]!, r, radial));
  return out;
}

const tube = (pts: Vector3[], r: number, closed: boolean, segs: number, radial = 6) =>
  new TubeGeometry(new CatmullRomCurve3(pts, closed, "centripetal"), segs, r, radial, closed);

/**
 * A capsule that curls: knuckle at the origin, length along −y, bending toward
 * +z through `bend` radians in total. Normals are bent with the vertices, so
 * the toon ramp and the ink both follow the curl. Fingers and thumbs.
 */
function bentCapsule(r: number, len: number, bend: number, radial = 8): BufferGeometry {
  const g = new CapsuleGeometry(r, len, 3, radial, 5);
  g.translate(0, -len / 2, 0);
  if (Math.abs(bend) < 1e-4) return g;
  const R = len / bend;
  const p = g.getAttribute("position") as BufferAttribute;
  const n = g.getAttribute("normal") as BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const y = p.getY(i);
    const z = p.getZ(i);
    const s = -y;
    const sc = clamp(s, 0, len);
    const extra = s - sc;
    const f = sc / R;
    const sf = Math.sin(f);
    const cf = Math.cos(f);
    p.setXYZ(i, x, -R * sf + z * sf - extra * cf, R * (1 - cf) + z * cf + extra * sf);
    const ny = n.getY(i);
    const nz = n.getZ(i);
    n.setXYZ(i, n.getX(i), ny * cf + nz * sf, -ny * sf + nz * cf);
  }
  return g;
}

/** A box with every edge rounded to `r`: pouches, plates, a tie knot. */
function roundBox(w: number, h: number, d: number, r: number, seg = 4): BufferGeometry {
  const g = new BoxGeometry(w, h, d, seg, seg, seg);
  const p = g.getAttribute("position") as BufferAttribute;
  const n = g.getAttribute("normal") as BufferAttribute;
  const hx = Math.max(0, w / 2 - r);
  const hy = Math.max(0, h / 2 - r);
  const hz = Math.max(0, d / 2 - r);
  const v = new Vector3();
  const c = new Vector3();
  for (let i = 0; i < p.count; i++) {
    v.set(p.getX(i), p.getY(i), p.getZ(i));
    c.set(clamp(v.x, -hx, hx), clamp(v.y, -hy, hy), clamp(v.z, -hz, hz));
    v.sub(c);
    if (v.lengthSq() < 1e-14) continue;
    v.normalize();
    n.setXYZ(i, v.x, v.y, v.z);
    p.setXYZ(i, c.x + v.x * r, c.y + v.y * r, c.z + v.z * r);
  }
  return g;
}

/** A flat elliptical sole or heel: a rounded puck of unit radius and height `h`. */
function puck(h: number): BufferGeometry {
  const e = h * 0.14;
  return lathe([[0, -h / 2], [0.8, -h / 2], [0.95, -h / 2 + e], [1, 0], [0.95, h / 2 - e], [0.8, h / 2], [0, h / 2]], 24);
}

/**
 * An open ribbed band (hoodie hem and cuffs) with exact normals, so the ribs
 * read as alternating ramp steps rather than a wobbly silhouette.
 */
function ribbed(rb: number, rt: number, y0: number, y1: number, ribs: number, depth: number, radial: number): BufferGeometry {
  const pos: number[] = [];
  const nor: number[] = [];
  const idx: number[] = [];
  const slope = (rt - rb) / (y1 - y0);
  for (let j = 0; j <= 1; j++) {
    const y = j ? y1 : y0;
    const R = j ? rt : rb;
    for (let i = 0; i <= radial; i++) {
      const th = PI + (i / radial) * TAU;
      const r = R + depth * Math.cos(ribs * th);
      const dr = -depth * ribs * Math.sin(ribs * th);
      const sn = Math.sin(th);
      const cs = Math.cos(th);
      pos.push(r * sn, y, r * cs);
      const ax = dr * sn + r * cs;
      const az = dr * cs - r * sn;
      const nx = -az;
      const ny = az * slope * sn - ax * slope * cs;
      const nz = ax;
      const l = Math.hypot(nx, ny, nz) || 1;
      nor.push(nx / l, ny / l, nz / l);
    }
  }
  for (let i = 0; i < radial; i++) {
    const a = i;
    const b = i + 1;
    const c = radial + 2 + i;
    const d = radial + 1 + i;
    idx.push(a, b, d, b, c, d);
  }
  return fromArrays(pos, nor, idx);
}

function fromArrays(pos: number[], nor: number[], idx: number[]): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute("normal", new BufferAttribute(new Float32Array(nor), 3));
  g.setIndex(idx);
  return g;
}

/** Position, normal and index only — the toon ramp needs no UVs. */
function mergeGeos(list: readonly BufferGeometry[]): BufferGeometry {
  let nv = 0;
  let ni = 0;
  for (const g of list) {
    if (!g.getAttribute("normal")) g.computeVertexNormals();
    const c = g.getAttribute("position").count;
    nv += c;
    ni += g.index ? g.index.count : c;
  }
  const pos = new Float32Array(nv * 3);
  const nor = new Float32Array(nv * 3);
  const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  let vo = 0;
  let io = 0;
  for (const g of list) {
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
    if (g.index) for (let i = 0; i < g.index.count; i++) idx[io++] = g.index.getX(i) + vo;
    else for (let i = 0; i < p.count; i++) idx[io++] = vo + i;
    vo += p.count;
  }
  const out = new BufferGeometry();
  out.setAttribute("position", new BufferAttribute(pos, 3));
  out.setAttribute("normal", new BufferAttribute(nor, 3));
  out.setIndex(new BufferAttribute(idx, 1));
  return out;
}

/**
 * Detail collects here and leaves as one mesh per (node, material, ink, tap):
 * same look as separate meshes, a fraction of the draw calls.
 */
function makeBag() {
  const sets = new Map<string, { parent: Object3D; mat: Material; outline: boolean; hit: boolean; geos: BufferGeometry[] }>();
  return {
    add(parent: Object3D, mat: Material, geo: BufferGeometry | readonly BufferGeometry[], outline = false, hit = false) {
      const key = `${parent.uuid}:${mat.uuid}:${outline ? 1 : 0}:${hit ? 1 : 0}`;
      let set = sets.get(key);
      if (!set) sets.set(key, (set = { parent, mat, outline, hit, geos: [] }));
      if (Array.isArray(geo)) set.geos.push(...(geo as BufferGeometry[]));
      else set.geos.push(geo as BufferGeometry);
    },
    flush(b: BodyBuilder) {
      for (const s of sets.values()) {
        if (!s.geos.length) continue;
        const merged = mergeGeos(s.geos);
        for (const g of s.geos) g.dispose();
        b.part(merged, s.mat, s.parent, { outline: s.outline, hit: s.hit });
      }
      sets.clear();
    },
  };
}

// ── surfaces: where a detail sits ON a form ──────────────────────────────

/** A surface of revolution about local y: radius and slope (dr/dy) at a height. */
type Prof = { r(y: number): number; k(y: number): number };

function prof(pts: readonly RY[]): Prof {
  const p = [...pts].sort((a, b) => a[1] - b[1]);
  const seg = (y: number) => {
    let i = 0;
    while (i < p.length - 2 && y > p[i + 1]![1]) i++;
    return i;
  };
  return {
    r(y) {
      const i = seg(y);
      const [r0, y0] = p[i]!;
      const [r1, y1] = p[i + 1]!;
      return r0 + (r1 - r0) * clamp01((y - y0) / (y1 - y0 || 1));
    },
    k(y) {
      const i = seg(y);
      const [r0, y0] = p[i]!;
      const [r1, y1] = p[i + 1]!;
      return (r1 - r0) / (y1 - y0 || 1);
    },
  };
}
const cylProf = (r: number, y0: number, y1: number) => prof([[r, y0], [r, y1]]);
/** A capsule's outside: the straight part and its top cap, for the shin. */
function capsuleTop(r: number, yBottom: number, yTop: number): Prof {
  const pts: RY[] = [[r, yBottom], [r, yTop]];
  for (let a = 1; a <= 5; a++) {
    const t = (a / 6) * (PI / 2);
    pts.push([r * Math.cos(t), yTop + r * Math.sin(t)]);
  }
  return prof(pts);
}

/** The point at angle `phi` (0 = front, +x = his left) and height y, `off` out along the normal. */
function surf(p: Prof, phi: number, y: number, off: number, out = new Vector3()): Vector3 {
  const r = p.r(y);
  const k = p.k(y);
  const inv = 1 / Math.sqrt(1 + k * k);
  const sn = Math.sin(phi);
  const cs = Math.cos(phi);
  return out.set(sn * (r + off * inv), y - k * inv * off, cs * (r + off * inv));
}
const onS = (p: Prof, s: number, y: number, off: number, out?: Vector3) => surf(p, s / p.r(y), y, off, out);

/** A frame lying on the surface: x round it, y up it, z out of it. */
function frame(p: Prof, phi: number, y: number, off: number, out = new Matrix4()): Matrix4 {
  const k = p.k(y);
  const inv = 1 / Math.sqrt(1 + k * k);
  const sn = Math.sin(phi);
  const cs = Math.cos(phi);
  out.makeBasis(v3(cs, 0, -sn), v3(k * sn * inv, inv, k * cs * inv), v3(sn * inv, -k * inv, cs * inv));
  return out.setPosition(surf(p, phi, y, off));
}
const frameS = (p: Prof, s: number, y: number, off: number) => frame(p, s / p.r(y), y, off);

/** Points along a polyline drawn on a surface; `off` may vary along it (0 → 1). */
function onPath(p: Prof, pts: readonly SY[], off: number | ((t: number) => number), steps = 4): Vector3[] {
  const out: Vector3[] = [];
  const n = pts.length - 1;
  const o = (t: number) => (typeof off === "number" ? off : off(t));
  for (let i = 0; i < n; i++) {
    const [s0, y0] = pts[i]!;
    const [s1, y1] = pts[i + 1]!;
    for (let k = 0; k < steps; k++) {
      const t = k / steps;
      out.push(onS(p, s0 + (s1 - s0) * t, y0 + (y1 - y0) * t, o((i + t) / n)));
    }
  }
  const [s, y] = pts[n]!;
  out.push(onS(p, s, y, o(1)));
  return out;
}

/** A ring of stitches round a surface at one height. */
function dashRing(p: Prof, y: number, count: number, len: number, h: number, d: number, off: number): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  for (let k = 0; k < count; k++) out.push(new BoxGeometry(len, h, d).applyMatrix4(frame(p, PI + ((k + 0.5) / count) * TAU, y, off)));
  return out;
}
/** One stitch at (s, y), turned `rot` radians in the surface plane. */
const dash = (p: Prof, s: number, y: number, len: number, h: number, off: number, rot = 0) =>
  at(new BoxGeometry(len, h, 0.003), [0, 0, 0], [0, 0, rot]).applyMatrix4(frameS(p, s, y, off));

/**
 * A patch that follows a surface — an undershirt, a lapel, a pocket, a tie.
 * `f` maps the unit square to (s, y); the front sits `off + thick` out, with
 * walls down to `off` so its edge catches the light. `back` closes it (plates).
 */
function sheet(p: Prof, f: (u: number, v: number) => SY, nu: number, nv: number, off: number, thick: number, back = false): BufferGeometry {
  const a = f(0.5, 0.5);
  const bu = f(0.6, 0.5);
  const bv = f(0.5, 0.6);
  const ccw = (bu[0] - a[0]) * (bv[1] - a[1]) - (bu[1] - a[1]) * (bv[0] - a[0]) >= 0;
  const F = ccw ? f : (u: number, v: number) => f(1 - u, v);
  const pos: number[] = [];
  const nor: number[] = [];
  const idx: number[] = [];
  const P = new Vector3();
  const N = new Vector3();
  const normalAt = (s: number, y: number) => {
    const phi = s / p.r(y);
    const k = p.k(y);
    const inv = 1 / Math.sqrt(1 + k * k);
    return N.set(Math.sin(phi) * inv, -k * inv, Math.cos(phi) * inv);
  };
  const push = (q: Vector3, n: Vector3) => {
    pos.push(q.x, q.y, q.z);
    nor.push(n.x, n.y, n.z);
    return pos.length / 3 - 1;
  };
  const grid = (o: number, inward: boolean) => {
    const base = pos.length / 3;
    for (let j = 0; j <= nv; j++)
      for (let i = 0; i <= nu; i++) {
        const [s, y] = F(i / nu, j / nv);
        onS(p, s, y, o, P);
        normalAt(s, y);
        if (inward) N.negate();
        push(P, N);
      }
    for (let j = 0; j < nv; j++)
      for (let i = 0; i < nu; i++) {
        const A = base + j * (nu + 1) + i;
        const B = A + 1;
        const C = A + nu + 2;
        const D = A + nu + 1;
        if (inward) idx.push(A, D, B, B, D, C);
        else idx.push(A, B, D, B, C, D);
      }
  };
  grid(off + thick, false);
  if (back) grid(off, true);
  if (thick > 0) {
    const loop: SY[] = [];
    for (let i = 0; i < nu; i++) loop.push(F(i / nu, 0));
    for (let j = 0; j < nv; j++) loop.push(F(1, j / nv));
    for (let i = nu; i > 0; i--) loop.push(F(i / nu, 1));
    for (let j = nv; j > 0; j--) loop.push(F(0, j / nv));
    const t0 = new Vector3();
    const t1 = new Vector3();
    const b0 = new Vector3();
    const b1 = new Vector3();
    const E = new Vector3();
    const W = new Vector3();
    for (let k = 0; k < loop.length; k++) {
      const [s0, y0] = loop[k]!;
      const [s1, y1] = loop[(k + 1) % loop.length]!;
      onS(p, s0, y0, off + thick, t0);
      onS(p, s1, y1, off + thick, t1);
      E.subVectors(t1, t0);
      if (E.lengthSq() < 1e-12) continue;
      onS(p, s0, y0, off, b0);
      onS(p, s1, y1, off, b1);
      W.crossVectors(E, normalAt((s0 + s1) / 2, (y0 + y1) / 2)).normalize();
      const i0 = push(b0, W);
      const i1 = push(b1, W);
      const i2 = push(t1, W);
      const i3 = push(t0, W);
      idx.push(i0, i1, i2, i0, i2, i3);
    }
  }
  return fromArrays(pos, nor, idx);
}

// ── the hand ─────────────────────────────────────────────────────────────

/** Hand scale: chunky, toy-like, about the bulk of the old mitten. */
const HAND = 1.1;

/**
 * A relaxed fist: a rounded palm, four fingers curled toward the palm in a row
 * front-to-back (index at the front, by the thumb), and an opposable thumb
 * closing over the index finger. The palm faces in (−x·sx), the thumb is at
 * the front-inner corner, as the old mitten's was. The fist fills roughly
 * x −0.04..0.04, y +0.02..−0.105, z ±0.05 (hand-local, after HAND); a prop
 * through gear.ts's grip point (0, −0.03, 0) passes through it, which is what
 * reads as "held". A grip below y ≈ −0.1 (the longbow's, at −0.11) shows
 * under the fingers rather than in them.
 */
function handGeos(sx: number): BufferGeometry[] {
  const out: BufferGeometry[] = [];
  out.push(at(roundBox(0.06, 0.084, 0.088, 0.024, 5), [0.004 * sx, -0.03, 0]));
  out.push(at(sphere(0.031, 12, 8), [0, 0.012, 0], undefined, [1, 1.1, 1.05])); // wrist
  out.push(at(sphere(0.024, 12, 8), [-0.012 * sx, -0.03, 0.024], undefined, [0.8, 1.1, 0.9])); // ball of the thumb
  const fingers: readonly (readonly [number, number, number, number])[] = [
    // z, radius, length, curl — index → pinky, each a little shorter and tighter
    [0.0315, 0.0125, 0.042, 1.9],
    [0.0105, 0.013, 0.046, 2.1],
    [-0.0105, 0.0125, 0.043, 2.25],
    [-0.0315, 0.0115, 0.036, 2.4],
  ];
  const turn = new Matrix4().makeRotationY(-sx * PI / 2); // the curl's +z → toward the palm
  for (const [z, r, len, bend] of fingers) {
    const g = bentCapsule(r, len, bend, 8).applyMatrix4(turn);
    g.translate(0.016 * sx, -0.06, z);
    out.push(g);
  }
  const A = v3(-0.012 * sx, -0.012, 0.034);
  const B = v3(-0.03 * sx, -0.042, 0.045);
  const C = v3(-0.029 * sx, -0.067, 0.026);
  out.push(rod(A, B, 0.0148, 8), rod(B, C, 0.013, 8));
  for (const g of out) g.scale(HAND, HAND, HAND);
  return out;
}

// ── the body ─────────────────────────────────────────────────────────────

export function buildBody(b: BodyBuilder, outfit: Outfit, body: Group): BodyNodes {
  const kit = b.kit;
  const bag = makeBag();
  const style = outfit.style;
  const cloth = hexOf("cloth", outfit.cloth);
  const trim = hexOf("trim", outfit.trim);
  const skin = hexOf("skin", outfit.skin);
  const leather = hexOf("leather", outfit.leather);
  const metal = "#b9c2cc";
  const gold = "#e3b341";

  // rig.ts's palette, unchanged — the kit's cache hands back the same materials
  const mCloth = kit.toon(style === "armor" ? lighten(metal, 0) : cloth);
  const mClothDark = kit.toon(style === "armor" ? shade(cloth, 0.8) : shade(cloth, 0.72));
  const pants = style === "suit" ? shade(cloth, 0.55) : style === "armor" ? shade(metal, 0.45) : shade(leather, 1.25);
  const mPants = kit.toon(pants);
  const mTrim = kit.toon(trim);
  const mSkin = kit.toon(skin);
  const mLeather = kit.toon(leather);
  const mMetal = kit.toon(metal);
  const mGold = kit.toon(gold, { emissive: "#6b4a10", emissiveIntensity: 0.35 });
  const mInk = kit.basic("#151216");
  // shades derived from the outfit, so every wardrobe colour still looks chosen
  const mTrimDark = kit.toon(shade(trim, 0.58));
  const mLeatherDark = kit.toon(shade(leather, 0.55));
  const mLeatherMid = kit.toon(shade(leather, 0.78));
  const mLeatherLight = kit.toon(shade(leather, 1.32));
  const mCord = kit.toon(tint(leather, "#f1e2c2", 0.62));
  const mClothThread = kit.toon(lighten(cloth, 0.5));
  const mLeatherThread = kit.toon(tint(leather, "#f1e2c2", 0.5));
  const mPantsThread = kit.toon(shade(pants, 0.62));
  const mMetalDark = kit.toon(shade(metal, 0.62));
  const mMetalLight = kit.toon(lighten(metal, 0.35));
  const mShirt = kit.toon("#f2efe8");
  const mButton = kit.toon("#1c1c20");

  // ── hips and legs ──
  const hips = group(body, 0, 0.62, 0, "hips");
  b.part(sphere(0.2), mPants, hips, { pos: [0, -0.02, 0], scale: [1, 0.62, 0.82] });

  const thighProf = cylProf(0.068, -0.2, -0.04);
  const shinProf = capsuleTop(0.062, -0.17, -0.03);
  const cuffPts: RY[] = [[0.079, 0.07], [0.088, 0.069], [0.0935, 0.075], [0.0965, 0.118], [0.0972, 0.13], [0.093, 0.1375], [0.08, 0.139], [0.066, 0.135]];
  const cuffProf = prof([[0.0935, 0.075], [0.0965, 0.118], [0.0972, 0.13]]);

  /** A soft leather boot: heeled sole, toe cap, instep strap and buckle, folded cuff. */
  const boot = (foot: Group, sx: number) => {
    const vy = -0.029; // the foot's centre; its sole sits just under it
    bag.add(foot, mLeather, [at(sphere(0.1, 22, 14), [0, vy, 0.038], undefined, [0.84, 0.52, 1.26]), new CylinderGeometry(0.081, 0.075, 0.13, 18, 1, true).translate(0, 0.045, 0)], true, true);
    bag.add(foot, mLeatherDark, [at(puck(0.022), [0, -0.073, 0.04], undefined, [0.079, 1, 0.12]), at(puck(0.03), [0, -0.079, -0.048], undefined, [0.055, 1, 0.045])], true, true);
    bag.add(foot, mLeatherMid, at(new SphereGeometry(0.104, 18, 7, 0, TAU, 0, 1.0).rotateX(PI / 2), [0, vy, 0.038], undefined, [0.84, 0.52, 1.26]));
    bag.add(foot, mTrim, lathe(cuffPts, 26), true, true);
    bag.add(foot, mTrimDark, dashRing(cuffProf, 0.083, 18, 0.0115, 0.0042, 0.003, 0.0012));
    // a pull-on loop standing up from the back of the cuff
    bag.add(foot, mLeatherDark, at(new TorusGeometry(0.0125, 0.0036, 4, 12, PI), [0, 0.134, -0.088], [-0.25, 0, 0]));
    // a strap over the instep, following the boot's own cross-section there
    const ex = 0.079;
    const ey = 0.0495;
    const sz = 0.095;
    bag.add(foot, mLeatherDark, at(new TorusGeometry(1, 0.1, 5, 22, PI + 1.0).rotateZ(-0.5), [0, vy, sz], undefined, [ex, ey, 0.08]));
    const t = 0.3;
    const c = v3(sx * ex * Math.cos(t), vy + ey * Math.sin(t), sz);
    const n = v3((sx * Math.cos(t)) / ex, Math.sin(t) / ey, 0).normalize();
    const e1 = v3(-sx * ex * Math.sin(t), ey * Math.cos(t), 0).normalize();
    const e2 = v3(0, 0, 1);
    const B = (a: number, w: number, o: number) => c.clone().addScaledVector(e1, a).addScaledVector(e2, w).addScaledVector(n, o);
    bag.add(foot, mGold, [...chain([B(-0.009, -0.0125, 0.0055), B(0.009, -0.0125, 0.0055), B(0.009, 0.0125, 0.0055), B(-0.009, 0.0125, 0.0055)], 0.0029, true, 5), rod(B(-0.008, 0, 0.0085), B(0.011, 0, 0.0085), 0.0018, 4)]);
  };

  const leg = (sx: number): LegNodes => {
    const thigh = group(hips, 0.1 * sx, -0.03, 0, "thigh");
    b.part(capsule(0.068, 0.16), mPants, thigh, { pos: [0, -0.12, 0] });
    const knee = group(thigh, 0, -0.26, 0, "knee");
    b.part(capsule(0.062, 0.14), mPants, knee, { pos: [0, -0.1, 0] });
    const foot = group(knee, 0, -0.25, 0, "foot");
    boot(foot, sx);
    const meridian = (p: Prof, phi: number, y0: number, y1: number, n: number) => Array.from({ length: n + 1 }, (_, i) => surf(p, phi, y0 + ((y1 - y0) * i) / n, 0.0008));
    if (style === "tunic" || style === "hoodie") {
      // the outside seam of hose or trousers
      bag.add(thigh, mPantsThread, chain(meridian(thighProf, (sx * PI) / 2, -0.045, -0.2, 3), 0.0024, false, 4));
      bag.add(knee, mPantsThread, chain(meridian(shinProf, (sx * PI) / 2, 0.0, -0.118, 5), 0.0024, false, 4));
      if (sx === 1) {
        // a patch sewn on over the left knee, set a little askew
        const patch = (u: number, v: number): SY => [-0.03 + 0.06 * u + (v - 0.5) * 0.009, -0.06 + 0.062 * v - (u - 0.5) * 0.009];
        bag.add(knee, mClothDark, sheet(shinProf, patch, 5, 6, 0.0012, 0.0035));
        const [cs, cy] = patch(0.5, 0.5);
        const ticks: BufferGeometry[] = [];
        for (const w of [0.2, 0.5, 0.8])
          for (const [s, y] of [patch(w, 0), patch(1, w), patch(w, 1), patch(0, w)]) {
            const l = Math.hypot(s - cs, y - cy);
            const ux = (s - cs) / l;
            const uy = (y - cy) / l;
            ticks.push(rod(onS(shinProf, s - ux * 0.0045, y - uy * 0.0045, 0.0052), onS(shinProf, s + ux * 0.0035, y + uy * 0.0035, 0.0012), 0.0019, 4));
          }
        bag.add(knee, mClothThread, ticks);
      }
    }
    if (style === "tunic" || style === "robe") {
      // cross-gartering: two straps wound opposite ways up the shin, tied below the knee
      const helix = (dir: number) => {
        const pts: Vector3[] = [];
        for (let i = 0; i <= 30; i++) pts.push(surf(shinProf, dir * (i / 30) * TAU * 1.25, -0.02 - (i / 30) * 0.1, 0.0045));
        return tube(pts, 0.0056, false, 72, 5);
      };
      const out = (sx * PI) / 2;
      const knot = surf(shinProf, out, -0.018, 0.009);
      bag.add(knee, mLeatherDark, [
        helix(1),
        helix(-1),
        at(new TorusGeometry(shinProf.r(-0.018) + 0.0035, 0.0058, 5, 22), [0, -0.018, 0], [PI / 2, 0, 0]),
        at(sphere(0.0085, 10, 8), knot),
        rod(knot, surf(shinProf, out + 0.16, -0.046, 0.006), 0.0042, 5),
        rod(knot, surf(shinProf, out - 0.1, -0.052, 0.006), 0.0042, 5),
      ]);
    }
    if (style === "suit") {
      // pressed trousers: a crease down the front of each leg
      const mCrease = kit.toon(lighten(pants, 0.28));
      bag.add(thigh, mCrease, chain(meridian(thighProf, 0, -0.06, -0.205, 3), 0.0026, false, 4));
      bag.add(knee, mCrease, chain(meridian(shinProf, 0, 0.012, -0.118, 5), 0.0026, false, 4));
    }
    if (style === "armor") {
      // a knee cop with a fan on the outside, riveted
      bag.add(knee, mMetal, [at(sphere(0.058, 16, 12), [0, -0.012, 0.03], undefined, [1, 0.92, 0.62]), at(sphere(0.04, 12, 8), [sx * 0.046, -0.016, 0.02], undefined, [0.38, 0.95, 0.75])], true, true);
      bag.add(knee, mGold, at(sphere(0.0068, 8, 6), [0, -0.012, 0.0665]));
    }
    return { thigh, knee, foot };
  };
  const L = leg(1);
  const R = leg(-1);

  // ── torso, by style ──
  const spine = group(hips, 0, 0.02, 0, "spine");
  const hem = style === "robe" ? -0.55 : style === "hoodie" || style === "suit" ? -0.12 : -0.17;
  const flare = style === "robe" ? 0.33 : style === "tunic" ? 0.27 : style === "armor" ? 0.25 : 0.23;
  const pts: [number, number][] = [
    [0.001, hem - 0.005], [flare, hem], [flare * 0.93, hem + 0.05], [0.205, -0.02],
    [0.198, 0.04], [0.215, 0.16], [0.208, 0.25], [0.17, 0.33], [0.1, 0.38], [0.001, 0.39],
  ];
  // the tunic's skirt ends in dags: the notch line sits at the second ring
  if (style === "tunic") {
    pts[0] = [0.001, hem + 0.055];
    pts[2] = [flare * 0.912, hem + 0.06];
  }
  const torso = prof(pts.slice(1, -1));
  const SEGS = 28;
  const torsoGeo = lathe(pts, SEGS);
  if (style === "tunic") {
    // Odd columns' hem vertices rise to the notch line, so the skirt's edge
    // zig-zags: 14 triangular dags, one pointing straight at the viewer.
    const p = torsoGeo.getAttribute("position") as BufferAttribute;
    const np = pts.length;
    for (let i = 1; i < SEGS; i += 2) p.setXYZ(i * np + 1, p.getX(i * np + 2), p.getY(i * np + 2), p.getZ(i * np + 2));
    torsoGeo.computeVertexNormals();
    const nr = torsoGeo.getAttribute("normal") as BufferAttribute;
    for (let j = 0; j < np; j++) {
      const a = j;
      const c = SEGS * np + j;
      const x = nr.getX(a) + nr.getX(c);
      const y = nr.getY(a) + nr.getY(c);
      const z = nr.getZ(a) + nr.getZ(c);
      const l = Math.hypot(x, y, z) || 1;
      nr.setXYZ(a, x / l, y / l, z / l);
      nr.setXYZ(c, x / l, y / l, z / l);
    }
  }
  b.part(torsoGeo, mCloth, spine);

  // the hem's edge
  if (style === "tunic") {
    const zz: Vector3[] = [];
    for (let i = 0; i < SEGS; i++) {
      const phi = PI + (i * TAU) / SEGS;
      const [r, y] = i % 2 ? pts[2]! : pts[1]!;
      zz.push(v3(Math.sin(phi) * (r + 0.0035), y + (i % 2 ? 0 : 0.002), Math.cos(phi) * (r + 0.0035)));
    }
    bag.add(spine, mTrim, chain(zz, 0.0078, true, 6));
    bag.add(spine, mClothThread, dashRing(torso, -0.088, 42, 0.017, 0.0055, 0.004, 0.0016));
  } else if (style === "hoodie") {
    bag.add(spine, kit.toon(shade(cloth, 0.86)), ribbed(0.2365, 0.2185, -0.128, -0.068, 46, 0.0024, 184), true, true);
  } else {
    // a jacket wants a piped hem, not a ring
    const band = style === "suit" ? 0.011 : 0.022;
    bag.add(spine, mTrim, at(new TorusGeometry(flare * 0.99, band, 6, 40), [0, hem + band * 0.55, 0], [PI / 2, 0, 0]));
  }

  // a wide leather belt: stitched edges, a framed buckle with its prong, the
  // strap's end through a keeper, punched holes
  if (style === "tunic" || style === "armor") {
    b.part(lathe([[0.207, -0.04], [0.219, -0.039], [0.2235, -0.032], [0.2145, 0.04], [0.2105, 0.0465], [0.196, 0.047]], 40), mLeather, spine);
    const belt = prof([[0.2235, -0.032], [0.2145, 0.04]]);
    bag.add(spine, mLeatherThread, [...dashRing(belt, -0.025, 48, 0.012, 0.004, 0.003, 0.0012), ...dashRing(belt, 0.033, 48, 0.012, 0.004, 0.003, 0.0012)]);
    const tail = (u: number, v: number): SY => {
      const end = 0.093 + 0.012 * Math.sqrt(Math.max(0, 1 - (2 * v - 1) ** 2));
      return [0.026 + u * (end - 0.026), -0.019 + 0.044 * v];
    };
    bag.add(spine, mLeatherMid, [sheet(belt, tail, 8, 4, 0.0003, 0.0045), sheet(belt, (u, v) => [0.031 + 0.011 * u, -0.041 + 0.09 * v], 2, 6, 0.0049, 0.0042)]);
    bag.add(spine, mInk, [0.052, 0.07, 0.088].map((s) => sphere(0.0046, 8, 6).scale(1, 1, 0.45).applyMatrix4(frameS(belt, s, 0.003, 0.0049))));
    const F = frameS(belt, 0, 0.004, 0);
    const P = (x: number, y: number, z: number) => v3(x, y, z).applyMatrix4(F);
    bag.add(spine, mGold, [...chain([P(-0.032, -0.027, 0.007), P(0.032, -0.027, 0.007), P(0.032, 0.027, 0.007), P(-0.032, 0.027, 0.007)], 0.0062, true, 6), rod(P(-0.03, 0, 0.0115), P(0.036, 0, 0.0115), 0.0034, 5)]);
  }

  if (style === "tunic") {
    // ─ the laced V-neck: linen undershirt, piped edge round the neck, eyelets, criss-cross laces and a bow
    const yv = 0.195;
    const yn = 0.352;
    const wTop = 0.056;
    const w = (y: number) => wTop * Math.pow(clamp01((y - yv) / (yn - yv)), 0.85);
    bag.add(spine, kit.toon(tint("#efe6d0", cloth, 0.08)), sheet(torso, (u, v) => {
      const y = yv - 0.006 + v * (0.376 - yv + 0.006);
      const hw = (y <= yn ? w(y) : wTop + (y - yn) * 0.9) + 0.004;
      return [(2 * u - 1) * hw, y];
    }, 6, 30, 0.0022, 0));
    const loop: Vector3[] = [onS(torso, 0, yv, 0.0045)];
    for (let i = 1; i <= 7; i++) {
      const y = yv + ((yn - yv) * i) / 7;
      loop.push(onS(torso, w(y), y, 0.0045));
    }
    const phiL = wTop / torso.r(yn);
    for (let i = 1; i < 18; i++) loop.push(surf(torso, phiL + ((TAU - 2 * phiL) * i) / 18, yn, 0.0045));
    for (let i = 7; i >= 1; i--) {
      const y = yv + ((yn - yv) * i) / 7;
      loop.push(onS(torso, -w(y), y, 0.0045));
    }
    bag.add(spine, mTrim, tube(loop, 0.0085, true, 180, 6));
    const rows = [0.318, 0.276, 0.234];
    const E = (k: number, side: number): SY => [side * (w(rows[k]!) + 0.0075), rows[k]!];
    for (let k = 0; k < 3; k++) for (const side of [1, -1]) {
      const [s, y] = E(k, side);
      bag.add(spine, mMetal, new TorusGeometry(0.0062, 0.0024, 4, 10).applyMatrix4(frameS(torso, s, y, 0.0095)));
    }
    const lace = (a: SY, c: SY, lift = 0) => chain(onPath(torso, [a, c], (t) => 0.0068 + lift + 0.0027 * (2 * t - 1) ** 2, 6), 0.0046, false, 5);
    const knot = onS(torso, 0, 0.336, 0.009);
    bag.add(spine, mLeather, [
      ...lace(E(2, 1), E(1, -1), 0.0012), ...lace(E(2, -1), E(1, 1)),
      ...lace(E(1, 1), E(0, -1), 0.0012), ...lace(E(1, -1), E(0, 1)),
      ...lace(E(2, 1), E(2, -1)),
      ...lace(E(0, 1), [0.004, 0.336]), ...lace(E(0, -1), [-0.004, 0.336]),
      at(sphere(0.0066, 10, 8), knot),
      at(new TorusGeometry(0.0115, 0.0042, 5, 14), [0, 0, 0], [0, 0, 0.5]).applyMatrix4(frameS(torso, 0.014, 0.339, 0.009)),
      at(new TorusGeometry(0.0115, 0.0042, 5, 14), [0, 0, 0], [0, 0, -0.5]).applyMatrix4(frameS(torso, -0.014, 0.339, 0.009)),
      ...chain(onPath(torso, [[0.003, 0.333], [0.009, 0.31], [0.006, 0.29]], 0.0075, 3), 0.0042, false, 5),
      ...chain(onPath(torso, [[-0.003, 0.333], [-0.007, 0.312], [-0.011, 0.296]], 0.0075, 3), 0.0042, false, 5),
    ]);

    // ─ a belt pouch on his left hip: flap with a rounded tongue, a button, stitched seams
    const pm = new Matrix4().compose(v3(Math.sin(0.7) * 0.243, -0.03, Math.cos(0.7) * 0.243), new Quaternion().setFromEuler(new Euler(-0.2, 0.7, 0, "YXZ")), v3(1, 1, 1));
    bag.add(spine, mLeatherLight, roundBox(0.088, 0.085, 0.042, 0.016, 5).applyMatrix4(pm), true, true);
    bag.add(spine, mLeatherMid, [at(roundBox(0.094, 0.044, 0.012, 0.0055, 3), [0, 0.024, 0.0225]), at(new CylinderGeometry(0.024, 0.024, 0.012, 18), [0, 0.004, 0.0225], [PI / 2, 0, 0])].map((g) => g.applyMatrix4(pm)));
    bag.add(spine, mGold, at(sphere(0.0085, 10, 8), [0, -0.004, 0.0305]).applyMatrix4(pm));
    const ps: BufferGeometry[] = [];
    for (const x of [-0.03, -0.015, 0, 0.015, 0.03]) ps.push(at(new BoxGeometry(0.009, 0.0032, 0.003), [x, -0.034, 0.0212]));
    for (const x of [-0.0372, 0.0372]) for (const y of [-0.024, -0.01]) ps.push(at(new BoxGeometry(0.0032, 0.009, 0.003), [x, y, 0.0212]));
    bag.add(spine, mLeatherThread, ps.map((g) => g.applyMatrix4(pm)));

    // ─ a short dagger on his right hip, hilt toward the buckle, tip swung out
    const phd = -0.47;
    const tilt = 0.3;
    const lean = 0.16;
    const rho = v3(Math.sin(phd), 0, Math.cos(phd));
    const tan = v3(Math.cos(phd), 0, -Math.sin(phd));
    const U = v3(0, Math.cos(tilt), 0).addScaledVector(tan, Math.sin(tilt)).addScaledVector(rho, -Math.tan(lean)).normalize();
    const N = rho.clone().addScaledVector(U, -rho.dot(U)).normalize();
    const dm = new Matrix4().makeBasis(new Vector3().crossVectors(U, N), U, N).setPosition(rho.clone().multiplyScalar(0.236).setY(-0.03));
    const D = (g: BufferGeometry) => g.applyMatrix4(dm);
    bag.add(spine, mLeatherDark, D(at(new CylinderGeometry(0.0145, 0.0085, 0.07, 12), [0, -0.035, 0], undefined, [1, 1, 0.62])), true, true);
    bag.add(spine, mMetal, [
      D(at(new CylinderGeometry(0.0158, 0.0152, 0.011, 12), [0, -0.004, 0], undefined, [1, 1, 0.66])),
      D(at(new ConeGeometry(0.0093, 0.018, 10), [0, -0.078, 0], [PI, 0, 0], [1, 1, 0.66])),
      D(at(sphere(0.0052, 8, 6), [0, -0.088, 0])),
    ]);
    bag.add(spine, mGold, [D(rod(v3(-0.021, 0.005, 0), v3(0.021, 0.005, 0), 0.0056, 6)), D(at(sphere(0.0108, 10, 8), [0, 0.0475, 0]))]);
    bag.add(spine, mLeatherMid, D(at(new CylinderGeometry(0.0078, 0.0085, 0.032, 10), [0, 0.026, 0])));
    bag.add(spine, mLeatherDark, [0.017, 0.026, 0.035].map((y) => D(at(new TorusGeometry(0.0086, 0.0022, 4, 12), [0, y, 0], [PI / 2, 0, 0]))));
  }

  /**
   * A hood lying down the upper back, ending in a point, with a seam down its
   * middle. The big head hides anything round the neck, so this is what makes
   * the hood read from behind. Only without a cape: a cape hangs just off the
   * back and the hood would push through it.
   */
  const hoodDrape = (mat: Material) => {
    if (outfit.cape !== "none") return;
    const back = (s: number, y: number): SY => [s + PI * torso.r(y), y];
    const hw = (y: number) => 0.122 - 0.05 * clamp01((0.33 - y) / 0.15);
    const bottom = (u: number) => 0.165 + 0.085 * Math.pow(Math.abs(2 * u - 1), 1.6);
    bag.add(spine, mat, sheet(torso, (u, v) => {
      const y = bottom(u) + v * (0.352 - bottom(u));
      return back((2 * u - 1) * hw(y), y);
    }, 10, 14, 0.0015, 0.011, true), true, true);
    bag.add(spine, mClothDark, chain(onPath(torso, [back(0, 0.35), back(0, 0.25), back(0, 0.172)], 0.0135, 5), 0.0028, false, 4));
  };

  if (style === "robe") {
    // ─ a long robe: trimmed front opening, stitched hem, rope belt with a knot
    //   and tasselled ends, a hood folded down round the back of the neck
    bag.add(spine, mTrim, sheet(torso, (u, v) => [0.006 + 0.028 * u, hem + 0.02 + v * (0.335 - hem - 0.02)], 2, 64, 0.002, 0.004));
    bag.add(spine, mInk, chain(onPath(torso, [[0.0062, hem + 0.03], [0.0062, 0.33]], 0.0058, 26), 0.0024, false, 4));
    const st: BufferGeometry[] = [];
    for (let y = hem + 0.05; y < 0.31; y += 0.028) st.push(dash(torso, 0.041, y, 0.0045, 0.014, 0.0015));
    st.push(...dashRing(torso, hem + 0.055, 52, 0.018, 0.0055, 0.004, 0.0015));
    bag.add(spine, mClothThread, st);
    const mRope = kit.toon(tint(leather, "#e2c48a", 0.62));
    const ropeR = torso.r(0.01) + 0.0135;
    const strand = (d: number) => {
      const ps: Vector3[] = [];
      for (let i = 0; i < 160; i++) {
        const t = (i / 160) * TAU;
        const ph = t * 36 + d;
        const rr = ropeR + 0.0072 * Math.cos(ph);
        ps.push(v3(Math.sin(t) * rr, 0.01 + 0.0072 * Math.sin(ph), Math.cos(t) * rr));
      }
      return tube(ps, 0.0078, true, 320, 5);
    };
    const kphi = 0.32;
    const s0 = kphi * torso.r(-0.01);
    const cords: SY[][] = [
      [[s0, -0.008], [s0 + 0.006, -0.08], [s0 + 0.002, -0.16], [s0 - 0.003, -0.232]],
      [[s0 - 0.008, -0.008], [s0 - 0.016, -0.09], [s0 - 0.022, -0.18], [s0 - 0.018, -0.27]],
    ];
    bag.add(spine, mRope, [strand(0), strand(PI), new TorusKnotGeometry(0.0125, 0.0058, 48, 6, 2, 3).applyMatrix4(frame(torso, kphi, 0.004, 0.03)), ...cords.map((c) => tube(onPath(torso, c, 0.0092, 5), 0.0062, false, 40, 5))]);
    for (const c of cords) {
      const [se, ye] = c[c.length - 1]!;
      const tf = frameS(torso, se, ye - 0.004, 0.021);
      bag.add(spine, mTrim, [at(sphere(0.0085, 10, 8), [0, 0.002, 0]), at(new TorusGeometry(0.0098, 0.0036, 5, 14), [0, -0.007, 0], [PI / 2, 0, 0]), at(new ConeGeometry(0.0195, 0.05, 12), [0, -0.034, 0])].map((g) => g.applyMatrix4(tf)));
    }
    const cowl: Vector3[] = [];
    for (let i = 0; i <= 28; i++) {
      const ph = PI - 0.8 * PI + (1.6 * PI * i) / 28;
      const front = (1 - Math.cos(ph - PI)) / 2; // 0 at the back, ~1 at the ends
      cowl.push(v3(Math.sin(ph) * (0.15 - 0.01 * front), 0.342 - 0.016 * front, Math.cos(ph) * (0.15 - 0.01 * front)));
    }
    bag.add(spine, mCloth, [tube(cowl, 0.042, false, 84, 10), at(sphere(0.042, 12, 10), cowl[0]!), at(sphere(0.042, 12, 10), cowl[28]!)], true, true);
    hoodDrape(mCloth);
    bag.add(spine, mClothThread, dashRing(torso, 0.31, 40, 0.012, 0.0045, 0.003, 0.0015).filter((_, k) => Math.abs(((k + 0.5) / 40) * 2 - 1) > 0.16));
  }

  if (style === "hoodie") {
    // ─ hood, drawstrings with metal aglets, a stitched kangaroo pocket, a chest badge
    bag.add(spine, mClothDark, at(new TorusGeometry(0.13, 0.055, 10, 24), [0, 0.36, -0.04], [PI / 2 - 0.4, 0, 0]), true, true);
    hoodDrape(mClothDark);
    const strings: BufferGeometry[] = [];
    const metalBits: BufferGeometry[] = [];
    for (const side of [1, -1]) {
      const path: SY[] = [[side * 0.038, 0.352], [side * 0.041, 0.31], [side * 0.043, 0.265], [side * 0.045, 0.228]];
      strings.push(tube(onPath(torso, path, 0.0055, 4), 0.0042, false, 36, 5));
      metalBits.push(new TorusGeometry(0.0072, 0.0028, 4, 10).applyMatrix4(frameS(torso, side * 0.038, 0.35, 0.0015)));
      metalBits.push(new CylinderGeometry(0.0062, 0.0058, 0.02, 8).applyMatrix4(frameS(torso, side * 0.045, 0.22, 0.0058)));
    }
    // white cord, unless the hoodie is pale enough to swallow it
    const c = new Color(cloth);
    bag.add(spine, kit.toon(0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b > 0.45 ? trim : "#fbfaf7"), strings);
    bag.add(spine, mMetal, metalBits);
    const hw = (v: number) => 0.128 - 0.046 * v;
    bag.add(spine, kit.toon(shade(cloth, 0.9)), sheet(torso, (u, v) => [(2 * u - 1) * hw(v), -0.012 + 0.122 * v], 10, 5, 0.0012, 0.0045));
    const ps: BufferGeometry[] = [];
    for (let i = 0; i < 8; i++) ps.push(dash(torso, -0.07 + (0.14 * i) / 7, 0.103, 0.011, 0.0035, 0.006));
    for (let i = 0; i < 12; i++) ps.push(dash(torso, -0.115 + (0.23 * i) / 11, -0.005, 0.011, 0.0035, 0.006));
    bag.add(spine, mClothThread, ps);
    bag.add(spine, mInk, [1, -1].flatMap((side) => chain(onPath(torso, [[side * 0.122, -0.004], [side * 0.078, 0.106]], 0.0062, 5), 0.0028, false, 4)));
    const badge = frameS(torso, 0.098, 0.215, 0.003);
    bag.add(spine, mTrim, at(new CylinderGeometry(0.03, 0.03, 0.006, 22), [0, 0, 0], [PI / 2, 0, 0]).applyMatrix4(badge));
    const A = (x: number, y: number) => v3(x, y, 0.0058).applyMatrix4(badge);
    bag.add(spine, kit.toon(shade(trim, 0.32)), [
      rod(A(-0.015, -0.015), A(0.014, 0.014), 0.003, 5),
      rod(A(0.016, 0.016), A(0.003, 0.0135), 0.0026, 5),
      rod(A(0.016, 0.016), A(0.0135, 0.003), 0.0026, 5),
      rod(A(-0.011, -0.011), A(-0.019, -0.004), 0.0026, 5),
      rod(A(-0.011, -0.011), A(-0.004, -0.019), 0.0026, 5),
    ]);
  }

  if (style === "suit") {
    // ─ shirt and tie in a notched-lapel jacket, buttons, a pocket square, pocket flaps
    const yv = 0.118;
    const yn = 0.355;
    const wTop = 0.07;
    const w = (y: number) => (y <= yn ? wTop * Math.pow(clamp01((y - yv) / (yn - yv)), 0.9) : wTop + (y - yn) * 0.9);
    bag.add(spine, mShirt, sheet(torso, (u, v) => {
      const y = yv - 0.004 + v * (0.376 - yv + 0.004);
      return [(2 * u - 1) * (w(y) + 0.003), y];
    }, 6, 30, 0.0022, 0));
    const lapel = (side: number) => (u: number, v: number): SY => {
      const y = yv + v * (0.374 - yv);
      let L = 0.044 * smooth((y - yv) / 0.12);
      const d = Math.abs(y - 0.322);
      if (d < 0.016) L -= 0.03 * (1 - d / 0.016);
      if (y > 0.338) L = 0.034;
      return [side * (w(y) + u * Math.max(0.004, L)), y];
    };
    const mFacing = kit.toon(shade(cloth, 0.8));
    const flap = (side: number) => (u: number, v: number): SY => [side * (0.088 + 0.072 * u), -0.058 + 0.022 * v];
    bag.add(spine, mFacing, [sheet(torso, lapel(1), 3, 40, 0.0028, 0.004), sheet(torso, lapel(-1), 3, 40, 0.0028, 0.004), sheet(torso, flap(1), 4, 2, 0.0012, 0.0035), sheet(torso, flap(-1), 4, 2, 0.0012, 0.0035)]);
    const tieW = (y: number) => (y < 0.165 ? 0.019 * clamp01((y - 0.126) / 0.039) : 0.019 - 0.0105 * clamp01((y - 0.165) / 0.16));
    bag.add(spine, mTrim, [
      sheet(torso, (u, v) => {
        const y = 0.126 + v * (0.33 - 0.126);
        return [(2 * u - 1) * Math.max(0.0006, tieW(y)), y];
      }, 3, 16, 0.0042, 0.0035),
      at(roundBox(0.03, 0.025, 0.017, 0.0075, 3), onS(torso, 0, 0.338, 0.0115), [-0.45, 0, 0]),
    ]);
    bag.add(spine, mTrimDark, [0.3, 0.262, 0.224, 0.186].map((y) => rod(onS(torso, -tieW(y) * 0.92, y - 0.007, 0.0081), onS(torso, tieW(y) * 0.92, y + 0.007, 0.0081), 0.0026, 4)));
    for (const side of [1, -1]) {
      const A: SY = [side * 0.012, 0.372];
      const B: SY = [side * 0.046, 0.36];
      const C: SY = [side * 0.026, 0.326];
      bag.add(spine, mShirt, sheet(torso, (u, v) => [(1 - v) * (A[0] + (B[0] - A[0]) * u) + v * C[0], (1 - v) * (A[1] + (B[1] - A[1]) * u) + v * C[1]], 3, 6, 0.0075, 0.003));
    }
    bag.add(spine, mButton, [0.095, 0.04].map((y) => at(new CylinderGeometry(0.0105, 0.0105, 0.005, 14), [0, 0, 0], [PI / 2, 0, 0]).applyMatrix4(frameS(torso, 0, y, 0.0025))));
    const ink: BufferGeometry[] = [];
    ink.push(...chain(onPath(torso, [[-0.004, yv], [-0.012, 0.06], [-0.014, 0.02], [-0.03, -0.04], [-0.065, -0.09], [-0.09, -0.114]], 0.0015, 3), 0.0024, false, 4));
    ink.push(...chain(onPath(torso, [[0.008, 0.01], [0.035, -0.05], [0.07, -0.1], [0.085, -0.114]], 0.0015, 3), 0.0024, false, 4));
    ink.push(...chain(onPath(torso, [[0.078, 0.206], [0.13, 0.212]], 0.0018, 4), 0.0024, false, 4));
    for (const side of [1, -1]) ink.push(...chain(onPath(torso, [[side * 0.088, -0.035], [side * 0.16, -0.035]], 0.0049, 4), 0.0022, false, 4));
    bag.add(spine, mInk, ink);
    bag.add(spine, kit.toon(lighten(trim, 0.3)), ([[0.088, 0.024, -0.12], [0.103, 0.032, 0.05], [0.118, 0.026, 0.2]] as const).map(([s, h, r]) => at(new ConeGeometry(0.011, h, 4), [0, 0, 0], [0, 0, r], [1, 1, 0.35]).applyMatrix4(frameS(torso, s, 0.207 + h / 2, 0.003))));
  }

  if (style === "armor") {
    // ─ layered pauldrons, a ridged breastplate on a padded collar, a mail
    //   skirt under riveted tassets
    bag.add(spine, mClothDark, at(new TorusGeometry(0.151, 0.017, 8, 32), [0, 0.344, 0], [PI / 2, 0, 0]), true, true);
    bag.add(spine, mMetalLight, chain(onPath(torso, [[0, 0.065], [0, 0.33]], 0.0008, 10), 0.0085, false, 6));
    const goldBits: BufferGeometry[] = [at(new TorusGeometry(0.2046, 0.0075, 5, 40), [0, 0.056, 0], [PI / 2, 0, 0])];
    for (let k = 0; k < 18; k++) goldBits.push(at(sphere(0.0062, 6, 5), surf(torso, PI + ((k + 0.5) / 18) * TAU, 0.072, 0.0015)));
    const plates: BufferGeometry[] = [];
    for (const sx of [1, -1]) {
      const pm = new Matrix4().compose(v3(0.215 * sx, 0.315, 0), new Quaternion().setFromEuler(new Euler(0, 0, -0.32 * sx)), v3(1, 0.72, 1.06));
      plates.push(...[new SphereGeometry(0.112, 22, 8, 0, TAU, 0, 1.12), new SphereGeometry(0.121, 22, 3, 0, TAU, 0.98, 0.42), new SphereGeometry(0.13, 22, 3, 0, TAU, 1.3, 0.42)].map((g) => g.applyMatrix4(pm)));
      for (const [r, th] of [[0.112, 1.12], [0.121, 1.4], [0.13, 1.72]] as const) goldBits.push(at(new TorusGeometry(r * Math.sin(th) + 0.001, 0.0052, 4, 28), [0, r * Math.cos(th), 0], [PI / 2, 0, 0]).applyMatrix4(pm));
      for (let k = -2; k <= 2; k++) {
        const az = k * 0.42;
        for (const [r, th] of [[0.13, 1.6], [0.112, 1.02]] as const) goldBits.push(at(sphere(0.0072, 6, 5), [sx * r * Math.sin(th) * Math.cos(az), r * Math.cos(th), r * Math.sin(th) * Math.sin(az)]).applyMatrix4(pm));
      }
    }
    // tassets hang from the belt over the mail
    for (const sc of [-0.22, -0.083, 0.083, 0.22]) {
      const yb = (u: number) => -0.105 - 0.013 * Math.sin(PI * u);
      plates.push(sheet(torso, (u, v) => [sc - 0.048 + 0.096 * u, yb(u) + v * (-0.032 - yb(u))], 6, 4, 0.0085, 0.0055, true));
      goldBits.push(...chain(Array.from({ length: 7 }, (_, i) => onS(torso, sc - 0.046 + (0.092 * i) / 6, yb(i / 6) + 0.002, 0.0112)), 0.0042, false, 5));
      for (const ds of [-0.034, 0.034]) goldBits.push(at(sphere(0.0058, 6, 5), onS(torso, sc + ds, -0.044, 0.0148)));
    }
    bag.add(spine, mMetal, plates, true, true);
    bag.add(spine, mGold, goldBits);
    const rings: BufferGeometry[] = [];
    const ringRows = [-0.048, -0.074, -0.1, -0.126];
    ringRows.forEach((y, row) => {
      for (let k = 0; k < 32; k++) rings.push(new TorusGeometry(0.0135, 0.0042, 3, 8).applyMatrix4(frame(torso, PI + ((k + (row % 2) * 0.5) / 32) * TAU, y, 0.0035)));
    });
    bag.add(spine, mMetalDark, rings);
  }

  // ── arms ──
  const fore = cylProf(0.056, -0.14, -0.03);
  const arm = (sx: number): ArmNodes => {
    const shoulder = group(spine, 0.235 * sx, 0.29, 0, "shoulder");
    b.part(sphere(0.075), mCloth, shoulder, { pos: [0, -0.01, 0] });
    b.part(capsule(0.062, 0.13), mCloth, shoulder, { pos: [0, -0.1, 0] });
    const elbow = group(shoulder, 0, -0.21, 0, "elbow");
    b.part(capsule(0.056, 0.11), style === "armor" ? mMetal : mCloth, elbow, { pos: [0, -0.085, 0] });
    const hand = group(elbow, 0, -0.2, 0, "hand");
    // the sleeve's seam where it is set into the shoulder
    if (style !== "armor") bag.add(shoulder, mClothDark, at(new TorusGeometry(0.0627, 0.0052, 5, 24), [0, -0.052, 0], [PI / 2, 0, 0]));
    switch (style) {
      case "tunic": {
        // a laced leather bracer over the sleeve, stitched at both edges
        bag.add(elbow, mTrim, at(new TorusGeometry(0.058, 0.0062, 5, 22), [0, -0.072, 0], [PI / 2, 0, 0]));
        b.part(lathe([[0.044, -0.181], [0.062, -0.1845], [0.0675, -0.178], [0.0685, -0.165], [0.0675, -0.11], [0.068, -0.087], [0.0655, -0.0795], [0.056, -0.079]], 20), mLeather, elbow);
        const br = prof([[0.0685, -0.165], [0.0675, -0.11], [0.068, -0.087]]);
        const E = (k: number, side: number): SY => [side * 0.023, -0.097 - k * 0.025];
        const lace = (a: SY, c: SY) => chain(onPath(br, [a, c], 0.0028, 4), 0.0034, false, 4);
        bag.add(elbow, mCord, [...lace(E(0, 1), E(1, -1)), ...lace(E(1, -1), E(2, 1)), ...lace(E(0, -1), E(1, 1)), ...lace(E(1, 1), E(2, -1)), ...lace(E(0, 1), E(0, -1)), ...lace(E(2, 1), E(2, -1))]);
        bag.add(elbow, mLeatherThread, [...dashRing(br, -0.092, 18, 0.0085, 0.0032, 0.0025, 0.001), ...dashRing(br, -0.16, 18, 0.0085, 0.0032, 0.0025, 0.001)]);
        break;
      }
      case "robe": {
        // a wide bell sleeve with a trimmed rim; a laced leather wrist wrap inside it
        b.part(lathe([[0.09, -0.1845], [0.099, -0.1885], [0.1045, -0.184], [0.102, -0.176], [0.088, -0.14], [0.072, -0.09], [0.062, -0.04], [0.058, 0.0]], 20), mCloth, elbow);
        bag.add(elbow, mTrim, at(new TorusGeometry(0.1035, 0.007, 5, 26), [0, -0.176, 0], [PI / 2, 0, 0]));
        bag.add(elbow, mLeather, at(new CylinderGeometry(0.052, 0.043, 0.03, 16), [0, -0.172, 0]));
        const wrap = prof([[0.043, -0.187], [0.052, -0.157]]);
        bag.add(elbow, mCord, [rod(onS(wrap, 0.012, -0.162, 0.0025), onS(wrap, -0.012, -0.182, 0.0025), 0.003, 4), rod(onS(wrap, -0.012, -0.162, 0.0025), onS(wrap, 0.012, -0.182, 0.0025), 0.003, 4)]);
        break;
      }
      case "hoodie":
        bag.add(elbow, kit.toon(shade(cloth, 0.86)), ribbed(0.0525, 0.0595, -0.188, -0.142, 14, 0.0018, 56), true, true);
        break;
      case "suit": {
        // the jacket sleeve's edge, a shirt cuff and cufflink, three sleeve buttons
        bag.add(elbow, mClothDark, at(new TorusGeometry(0.0575, 0.0065, 5, 22), [0, -0.152, 0], [PI / 2, 0, 0]));
        bag.add(elbow, mShirt, at(new CylinderGeometry(0.0605, 0.0565, 0.026, 18), [0, -0.172, 0]));
        bag.add(elbow, mGold, roundBox(0.012, 0.009, 0.006, 0.0025, 2).applyMatrix4(frame(cylProf(0.0585, -0.2, -0.15), sx * 0.95, -0.172, 0.003)));
        bag.add(elbow, mButton, [-0.118, -0.131, -0.144].map((y) => at(new CylinderGeometry(0.0055, 0.0055, 0.003, 10), [0, 0, 0], [PI / 2, 0, 0]).applyMatrix4(frame(fore, sx * (PI / 2 + 0.35), y, 0.0012))));
        break;
      }
      case "armor": {
        // a couter at the elbow and a flared gauntlet cuff, riveted and gold-rimmed
        bag.add(elbow, mMetal, [
          at(sphere(0.0645, 18, 12), [0, 0.002, -0.004], undefined, [1, 0.86, 1]),
          at(sphere(0.05, 14, 10), [sx * 0.062, -0.004, 0], undefined, [0.32, 1, 0.95]),
          lathe([[0.062, -0.187], [0.0745, -0.19], [0.0795, -0.185], [0.0765, -0.176], [0.0655, -0.148], [0.0615, -0.129], [0.054, -0.128]], 20),
        ], true, true);
        const flareProf = prof([[0.0655, -0.148], [0.0765, -0.176]]);
        const gb: BufferGeometry[] = [at(sphere(0.0065, 6, 5), [sx * 0.0785, -0.004, 0]), at(new TorusGeometry(0.0785, 0.0042, 5, 24), [0, -0.1855, 0], [PI / 2, 0, 0])];
        for (let k = 0; k < 6; k++) gb.push(at(sphere(0.0052, 6, 5), surf(flareProf, (k / 6) * TAU, -0.16, 0.0015)));
        bag.add(elbow, mGold, gb);
        break;
      }
    }
    // the hand — a leather glove under steel plates for armour
    const glove = style === "armor";
    bag.add(hand, glove ? mLeather : mSkin, handGeos(sx), true, true);
    if (glove) {
      bag.add(hand, mMetal, [
        at(roundBox(0.013, 0.066, 0.084, 0.0055, 3), [sx * 0.0414 * HAND, -0.031 * HAND, 0], undefined, [HAND, HAND, HAND]),
        at(roundBox(0.012, 0.024, 0.09, 0.0055, 3), [sx * 0.04 * HAND, -0.063 * HAND, 0], undefined, [HAND, HAND, HAND]),
      ]);
    }
    return { shoulder, elbow, hand };
  };
  const AL = arm(1);
  const AR = arm(-1);

  bag.flush(b);
  return { hips, spine, L, R, AL, AR };
}
