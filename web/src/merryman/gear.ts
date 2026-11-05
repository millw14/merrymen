/**
 * THE MERRYMAN'S GEAR: hats, held props, back items, capes and pets.
 *
 * Everything he wears or carries, built from the same primitives as his body
 * (rig.ts) and handed back as the Rig fields applyPose drives. Three rules keep
 * a 400 px hero looking hand-made and a 40 px portrait still reading as a shape:
 *
 * - INK ONLY THE BIG FORMS. A crown, a quiver, a bow limb get the inked
 *   outline; a rivet, a stitch or a fletching vane does not, or the outline eats
 *   it and the figure turns to mush when it is small.
 * - MANY BITS, FEW MESHES. Tertiary detail (rivets, pearls, barbs, stitches) is
 *   merged into one geometry per material, so a crown with forty pieces of
 *   jewellery costs nine draw calls, not forty.
 * - DETAIL SITS ON ITS SURFACE. Positions come from the radius of the thing
 *   being decorated (a hat band from the crown's profile, a strap from the
 *   torso's), not from eyeballed constants, so a stud never floats or sinks.
 *
 * Colours derive from the outfit (darken/lighten of hat, trim, leather), so
 * every swatch in the wardrobe still looks chosen.
 */
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CapsuleGeometry,
  CatmullRomCurve3,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Euler,
  ExtrudeGeometry,
  Group,
  LatheGeometry,
  Matrix4,
  Mesh,
  OctahedronGeometry,
  PlaneGeometry,
  Quaternion,
  Shape,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
  type Curve,
  type Material,
  type MeshBasicMaterial,
  type MeshToonMaterial,
  type Object3D,
} from "three";
import { hexOf, type Outfit } from "./outfit";
import type { Kit, Rig } from "./rig";

// ── the contract with rig.ts ─────────────────────────────────────────────

export type PartOpts = {
  pos?: [number, number, number];
  rot?: [number, number, number];
  scale?: [number, number, number];
  outline?: boolean;
  hit?: boolean;
};

/** rig.ts's Builder, structurally: tracks geometries for dispose and meshes for taps. */
export type GearBuilder = {
  kit: Kit;
  geos: BufferGeometry[];
  hit: Mesh[];
  part(geo: BufferGeometry, mat: Material, parent: Object3D, opts?: PartOpts): Mesh;
};

/** The bones gear hangs off. */
export type GearAnchors = { object: Group; spine: Group; head: Group; handL: Group; handR: Group };

/** Exactly the Rig fields applyPose drives for gear, with the same semantics. */
export type Gear = Pick<Rig, "hat" | "halo" | "bow" | "held" | "coin" | "cape" | "wings" | "pet">;

/**
 * Build everything he wears and carries for this outfit and hang it on the
 * rig. In buildRig this replaces the hats … pet sections, called after the
 * head, arms and eyewear exist:
 *
 *   const { hat, halo, bow, held, coin, cape, wings, pet } =
 *     buildGear(b, outfit, { object, spine, head, handL: AL.hand, handR: AR.hand });
 */
export function buildGear(b: GearBuilder, outfit: Outfit, at: GearAnchors): Gear {
  const c = context(b, outfit);
  const { hat, halo } = buildHat(c, at.head);
  const { bow, held } = buildHeld(c, at);
  // the coin a toss throws — parked in the right hand, hidden until it flies
  const coin = new Mesh(new CylinderGeometry(0.045, 0.045, 0.01, 18), c.mGold);
  b.geos.push(coin.geometry);
  coin.rotation.x = Math.PI / 2;
  coin.visible = false;
  at.handR.add(coin);
  const wings = buildBack(c, at.spine);
  const cape = buildCape(c, at.spine);
  const pet = buildPet(c, at.object);
  return { hat, halo, bow, held, coin, cape, wings, pet };
}

// ── shared colours and materials ─────────────────────────────────────────

const METAL = "#b9c2cc";
const GOLD = "#e3b341";
const WOOD = "#8a5a2e";
const BONE = "#efe6cf";
const CREAM = "#f4ecd8";
const THREAD = "#efe3c4";
const IRON = "#34313a";

type Ctx = {
  b: GearBuilder;
  kit: Kit;
  o: Outfit;
  cloth: string;
  trim: string;
  hatHex: string;
  leather: string;
  hair: string;
  mGold: MeshToonMaterial;
  mMetal: MeshToonMaterial;
  mWood: MeshToonMaterial;
  mLeather: MeshToonMaterial;
  mTrim: MeshToonMaterial;
  mInk: MeshBasicMaterial;
  mWhite: MeshBasicMaterial;
};

function context(b: GearBuilder, o: Outfit): Ctx {
  const kit = b.kit;
  const trim = hexOf("trim", o.trim);
  const leather = hexOf("leather", o.leather);
  return {
    b,
    kit,
    o,
    cloth: hexOf("cloth", o.cloth),
    trim,
    hatHex: hexOf("hatColor", o.hatColor),
    leather,
    hair: hexOf("hair", o.hair),
    mGold: kit.toon(GOLD, { emissive: "#6b4a10", emissiveIntensity: 0.35 }),
    mMetal: kit.toon(METAL),
    mWood: kit.toon(WOOD),
    mLeather: kit.toon(leather),
    mTrim: kit.toon(trim),
    mInk: kit.basic("#151216"),
    mWhite: kit.basic("#fbfaf7"),
  };
}

const gem = (kit: Kit, hex: string, glow: string) => kit.toon(hex, { emissive: glow, emissiveIntensity: 0.6 });

// ── small maths ──────────────────────────────────────────────────────────

type V3 = [number, number, number];
const v2 = (x: number, y: number) => new Vector2(x, y);
const v3 = (x: number, y: number, z: number) => new Vector3(x, y, z);
const arr = (v: Vector3): V3 => [v.x, v.y, v.z];
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const darken = (hex: string | Color, f: number) => new Color(hex).multiplyScalar(f);
const lighten = (hex: string | Color, f: number) => new Color(hex).lerp(new Color("#ffffff"), f);
/** Far enough apart to read as two colours side by side. */
const differs = (a: string | Color, b: string | Color) => {
  const x = new Color(a);
  const y = new Color(b);
  return Math.abs(x.r - y.r) + Math.abs(x.g - y.g) + Math.abs(x.b - y.b) > 0.3;
};

const group = (parent: Object3D, x = 0, y = 0, z = 0, name = "") => {
  const g = new Group();
  g.position.set(x, y, z);
  g.name = name;
  parent.add(g);
  return g;
};
const sphere = (r: number, w = 20, h = 14) => new SphereGeometry(r, w, h);
/** A capsule with few segments: toes and chevrons do not need twelve round. */
const capsule = (r: number, len: number) => new CapsuleGeometry(r, len, 3, 8);

const ZP = v3(0, 0, 1);
const YP = v3(0, 1, 0);
/** A rotation taking +z to `n`, after spinning `spin` about +z. */
function onto(n: Vector3, spin = 0, from = ZP): Quaternion {
  const q = new Quaternion().setFromUnitVectors(from, n.clone().normalize());
  if (spin) q.multiply(new Quaternion().setFromAxisAngle(from, spin));
  return q;
}
/** A rotation whose local x lands on `x` and local z on `z` (orthonormal); y follows. */
function basis(x: Vector3, z: Vector3): Quaternion {
  return new Quaternion().setFromRotationMatrix(new Matrix4().makeBasis(x, new Vector3().crossVectors(z, x), z));
}

// ── geometry helpers ─────────────────────────────────────────────────────

type Bit = { geo: BufferGeometry; pos?: V3; rot?: V3; scale?: V3; quat?: Quaternion };
const Z3: V3 = [0, 0, 0];
const ONE3: V3 = [1, 1, 1];

const _m4 = new Matrix4();
const _q = new Quaternion();
const _e = new Euler();
const _p = new Vector3();
const _s = new Vector3();

/**
 * MANY BITS, ONE MESH. Bakes each bit's transform into its geometry and
 * concatenates them (position, normal, uv, index), disposing the inputs.
 */
function merge(bits: readonly Bit[]): BufferGeometry {
  let nv = 0;
  let ni = 0;
  for (const bit of bits) {
    const g = bit.geo;
    _p.set(...(bit.pos ?? Z3));
    if (bit.quat) _q.copy(bit.quat);
    else _q.setFromEuler(_e.set(...(bit.rot ?? Z3)));
    _s.set(...(bit.scale ?? ONE3));
    g.applyMatrix4(_m4.compose(_p, _q, _s));
    const n = g.getAttribute("position").count;
    nv += n;
    ni += g.index ? g.index.count : n;
  }
  const pos = new Float32Array(nv * 3);
  const nor = new Float32Array(nv * 3);
  const uv = new Float32Array(nv * 2);
  const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
  let vo = 0;
  let io = 0;
  for (const { geo: g } of bits) {
    const p = g.getAttribute("position") as BufferAttribute;
    const n = g.getAttribute("normal") as BufferAttribute | undefined;
    const u = g.getAttribute("uv") as BufferAttribute | undefined;
    pos.set(p.array as ArrayLike<number>, vo * 3);
    if (n) nor.set(n.array as ArrayLike<number>, vo * 3);
    if (u) uv.set(u.array as ArrayLike<number>, vo * 2);
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
  out.setAttribute("uv", new BufferAttribute(uv, 2));
  out.setIndex(new BufferAttribute(idx, 1));
  return out;
}

/** One bit, placed: a geometry with a quaternion baked in (b.part takes Euler only). */
const placed = (geo: BufferGeometry, pos: V3, quat: Quaternion, scale?: V3) => merge([{ geo, pos, quat, scale }]);

/**
 * Average the normals of vertices that share a position, so a lathe's or a
 * tube's seam (and a sphere's pole) does not show as a crease in toon light.
 */
function smoothSeams(g: BufferGeometry) {
  const p = g.getAttribute("position") as BufferAttribute;
  const n = g.getAttribute("normal") as BufferAttribute;
  const at = new Map<string, number[]>();
  for (let i = 0; i < p.count; i++) {
    const k = `${Math.round(p.getX(i) * 1e4)},${Math.round(p.getY(i) * 1e4)},${Math.round(p.getZ(i) * 1e4)}`;
    const l = at.get(k);
    if (l) l.push(i);
    else at.set(k, [i]);
  }
  const v = new Vector3();
  for (const l of at.values()) {
    if (l.length < 2) continue;
    v.set(0, 0, 0);
    for (const i of l) v.x += n.getX(i), v.y += n.getY(i), v.z += n.getZ(i);
    v.normalize();
    for (const i of l) n.setXYZ(i, v.x, v.y, v.z);
  }
  n.needsUpdate = true;
}

/** Move every vertex through `fn`, then re-light it. */
function bend<G extends BufferGeometry>(g: G, fn: (v: Vector3) => void): G {
  const p = g.getAttribute("position") as BufferAttribute;
  const v = new Vector3();
  for (let i = 0; i < p.count; i++) {
    v.fromBufferAttribute(p, i);
    fn(v);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  p.needsUpdate = true;
  g.computeVertexNormals();
  smoothSeams(g);
  return g;
}

/** A surface through a grid of points: row i, column j. */
function sheet(rows: Vector3[][]): BufferGeometry {
  const nr = rows.length;
  const nc = rows[0]!.length;
  const pos = new Float32Array(nr * nc * 3);
  const uv = new Float32Array(nr * nc * 2);
  for (let i = 0; i < nr; i++) {
    for (let j = 0; j < nc; j++) {
      const p = rows[i]![j]!;
      const k = i * nc + j;
      pos[k * 3] = p.x;
      pos[k * 3 + 1] = p.y;
      pos[k * 3 + 2] = p.z;
      uv[k * 2] = j / (nc - 1);
      uv[k * 2 + 1] = i / (nr - 1);
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < nr - 1; i++) {
    for (let j = 0; j < nc - 1; j++) {
      const a = i * nc + j;
      const b = (i + 1) * nc + j;
      const c = (i + 1) * nc + j + 1;
      const d = i * nc + j + 1;
      idx.push(a, b, d, b, c, d);
    }
  }
  const g = new BufferGeometry();
  g.setAttribute("position", new BufferAttribute(pos, 3));
  g.setAttribute("uv", new BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  smoothSeams(g);
  return g;
}

/**
 * A closed cross-section swept along a path: straps that lie ON a surface.
 * `up(i)` is the surface normal at path point i; the profile is (side, up)
 * pairs, counter-clockwise, so the faces point outward.
 */
function sweep(path: Vector3[], up: (i: number) => Vector3, profile: readonly (readonly [number, number])[]): BufferGeometry {
  const rows: Vector3[][] = [];
  const T = new Vector3();
  const N = new Vector3();
  const S = new Vector3();
  for (let i = 0; i < path.length; i++) {
    const a = path[Math.max(0, i - 1)]!;
    const b = path[Math.min(path.length - 1, i + 1)]!;
    T.copy(b).sub(a).normalize();
    N.copy(up(i));
    N.addScaledVector(T, -N.dot(T)).normalize();
    S.crossVectors(T, N);
    const P = path[i]!;
    const row = profile.map(([s, u]) => P.clone().addScaledVector(S, s).addScaledVector(N, u));
    row.push(row[0]!.clone());
    rows.push(row);
  }
  return sheet(rows);
}

/** A tube whose radius follows `taper(u)` (1 = full) along its length. */
function taperTube(curve: Curve<Vector3>, segs: number, radius: number, radial: number, taper: (u: number) => number): TubeGeometry {
  const g = new TubeGeometry(curve, segs, radius, radial, false);
  const p = g.getAttribute("position") as BufferAttribute;
  const c = new Vector3();
  for (let i = 0; i <= segs; i++) {
    curve.getPointAt(i / segs, c);
    const k = taper(i / segs);
    for (let j = 0; j <= radial; j++) {
      const vi = i * (radial + 1) + j;
      p.setXYZ(vi, c.x + (p.getX(vi) - c.x) * k, c.y + (p.getY(vi) - c.y) * k, c.z + (p.getZ(vi) - c.z) * k);
    }
  }
  p.needsUpdate = true;
  return g;
}

/** A box with rounded edges (radius r), enough segments in each bevel to read round. */
function roundedBox(w: number, h: number, d: number, r: number): BufferGeometry {
  const S = 10;
  const g = new BoxGeometry(1, 1, 1, S, S, S);
  const p = g.getAttribute("position") as BufferAttribute;
  const n = g.getAttribute("normal") as BufferAttribute;
  const half = [w / 2, h / 2, d / 2] as const;
  const remap = (u: number, H: number) => {
    const k = Math.round((u + 0.5) * S);
    const core = H - r;
    if (k <= 3) return -H + (r * k) / 3;
    if (k >= 7) return core + (r * (k - 7)) / 3;
    return -core + ((k - 3) / 4) * 2 * core;
  };
  const v = new Vector3();
  const c = new Vector3();
  for (let i = 0; i < p.count; i++) {
    v.set(remap(p.getX(i), half[0]), remap(p.getY(i), half[1]), remap(p.getZ(i), half[2]));
    c.set(clamp(v.x, -half[0] + r, half[0] - r), clamp(v.y, -half[1] + r, half[1] - r), clamp(v.z, -half[2] + r, half[2] - r));
    v.sub(c);
    const L = v.length();
    if (L > 1e-9) {
      v.multiplyScalar(1 / L);
      n.setXYZ(i, v.x, v.y, v.z);
      v.multiplyScalar(r);
    }
    v.add(c);
    p.setXYZ(i, v.x, v.y, v.z);
  }
  return g;
}

/** A belt buckle: a rectangular frame with its prong, facing +z. */
function buckleGeo(w: number, h: number, t = 0.007): BufferGeometry {
  return merge([
    { geo: new BoxGeometry(w, t, t), pos: [0, h / 2 - t / 2, 0] },
    { geo: new BoxGeometry(w, t, t), pos: [0, -h / 2 + t / 2, 0] },
    { geo: new BoxGeometry(t, h, t), pos: [-w / 2 + t / 2, 0, 0] },
    { geo: new BoxGeometry(t, h, t), pos: [w / 2 - t / 2, 0, 0] },
    { geo: new BoxGeometry(w * 0.66, t * 0.5, t * 0.55), pos: [-w * 0.1, 0, t * 0.4] },
  ]);
}

/** A chunky five-point star, facing +z. */
function starGeo(ro: number, ri: number, depth: number, points = 5): BufferGeometry {
  const s = new Shape();
  for (let i = 0; i < points * 2; i++) {
    const a = Math.PI / 2 + (i * Math.PI) / points;
    const r = i % 2 ? ri : ro;
    if (i === 0) s.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    else s.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  s.closePath();
  const g = new ExtrudeGeometry(s, { depth, bevelEnabled: true, bevelThickness: depth * 0.45, bevelSize: ro * 0.07, bevelSegments: 1 });
  g.translate(0, 0, -depth / 2);
  return g;
}

/** A crescent moon: a torus arc whose tube thins to points at both horns. */
function moonGeo(r: number): BufferGeometry {
  const arc = Math.PI * 1.3;
  const g = new TorusGeometry(r, r * 0.36, 6, 18, arc);
  return bend(g, (v) => {
    let u = Math.atan2(v.y, v.x);
    if (u < -1e-6) u += Math.PI * 2;
    const k = Math.pow(Math.sin(Math.PI * clamp(u / arc, 0, 1)), 0.6);
    const cx = Math.cos(u) * r;
    const cy = Math.sin(u) * r;
    v.set(cx + (v.x - cx) * k, cy + (v.y - cy) * k, v.z * k);
  });
}

/** A helix round the y axis, for leather wraps and carved grooves. */
function helixY(r: number, y0: number, y1: number, turns: number): CatmullRomCurve3 {
  const pts: Vector3[] = [];
  const n = Math.max(8, Math.round(turns * 14));
  for (let i = 0; i <= n; i++) {
    const a = (i / n) * turns * Math.PI * 2;
    pts.push(v3(Math.cos(a) * r, y0 + ((y1 - y0) * i) / n, Math.sin(a) * r));
  }
  return new CatmullRomCurve3(pts);
}

/** Evenly spread directions on a sphere (for pompoms and fluff). */
function fibonacci(n: number): Vector3[] {
  const out: Vector3[] = [];
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(1 - y * y);
    const a = i * 2.399963;
    out.push(v3(Math.cos(a) * r, y, Math.sin(a) * r));
  }
  return out;
}

/**
 * The torso's radius at height y in the spine's frame — the same profile
 * buildRig lathes — so straps, clasps and collars sit on the cloth.
 */
/**
 * body.ts's armour pauldrons: a dome of radius 0.112 (plus two lower lames out
 * to 0.13) at (±0.215, 0.315, 0), rolled 0.32 outward and squashed to 0.72 in
 * y. A point that would sit inside one (the cape collar's run over the
 * shoulder) is pushed straight out of it, `clear` above the surface.
 */
const PAULDRON_C = v3(0.215, 0.315, 0);
const PAULDRON_S = v3(1, 0.72, 1.06);
function overPauldron(p: Vector3, style: Outfit["style"], clear: number): Vector3 {
  if (style !== "armor") return p;
  const sx = p.x < 0 ? -1 : 1;
  const roll = new Quaternion().setFromEuler(new Euler(0, 0, -0.32 * sx));
  const local = p.clone().sub(v3(PAULDRON_C.x * sx, PAULDRON_C.y, PAULDRON_C.z)).applyQuaternion(roll.clone().invert()).divide(PAULDRON_S);
  const R = (local.y > 0.112 * Math.cos(1.12) ? 0.112 : 0.13) + (clear + 0.004) / 0.72;
  if (local.length() >= R) return p;
  return local.setLength(R).multiply(PAULDRON_S).applyQuaternion(roll).add(v3(PAULDRON_C.x * sx, PAULDRON_C.y, PAULDRON_C.z));
}

function torsoR(y: number, style: Outfit["style"]): number {
  const hem = style === "robe" ? -0.55 : style === "hoodie" || style === "suit" ? -0.12 : -0.17;
  const flare = style === "robe" ? 0.33 : style === "tunic" ? 0.27 : style === "armor" ? 0.25 : 0.23;
  const prof: [number, number][] = [
    [hem, flare], [hem + 0.05, flare * 0.93], [-0.02, 0.205], [0.04, 0.198], [0.16, 0.215], [0.25, 0.208], [0.33, 0.17], [0.38, 0.1], [0.39, 0.001],
  ];
  if (y <= prof[0]![0]) return prof[0]![1];
  for (let i = 1; i < prof.length; i++) {
    const [y1, r1] = prof[i]!;
    const [y0, r0] = prof[i - 1]!;
    if (y <= y1) return r0 + ((r1 - r0) * (y - y0)) / (y1 - y0);
  }
  return 0.001;
}

/** A rounded strap cross-section (side, up), counter-clockwise. */
const strapProfile = (w: number, t: number) =>
  [
    [-w / 2, t * 0.25], [-w / 2 + t * 0.3, 0], [w / 2 - t * 0.3, 0], [w / 2, t * 0.25],
    [w / 2, t * 0.75], [w / 2 - t * 0.3, t], [-w / 2 + t * 0.3, t], [-w / 2, t * 0.75],
  ] as const;

/**
 * An arrow along +y, nock at y1, head (optional) below y0. Returned as bits
 * per material so a quiver's worth can be merged into a handful of meshes.
 */
function arrowBits(y0: number, y1: number, head: boolean, spin = 0) {
  const shaft: Bit[] = [{ geo: new CylinderGeometry(0.0072, 0.0072, y1 - y0, 6), pos: [0, (y0 + y1) / 2, 0] }];
  const metal: Bit[] = [];
  if (head) {
    metal.push(
      { geo: new ConeGeometry(0.027, 0.07, 4), pos: [0, y0 - 0.03, 0], rot: [Math.PI, spin, 0], scale: [1, 1, 0.2] },
      { geo: new CylinderGeometry(0.0095, 0.0085, 0.026, 6), pos: [0, y0 + 0.006, 0] },
    );
  }
  const vane = (phi: number) => {
    const rows: Vector3[][] = [];
    const a = y1 - 0.135;
    const b = y1 - 0.022;
    const d = v3(Math.sin(phi), 0, Math.cos(phi));
    for (let t = 0; t <= 6; t++) {
      const u = t / 6;
      const y = a + (b - a) * u;
      const h = 0.03 * (0.3 + 0.7 * Math.sin((Math.PI / 2) * Math.pow(u, 0.8)));
      rows.push([d.clone().multiplyScalar(0.006).setY(y), d.clone().multiplyScalar(0.006 + h).setY(y + 0.006 * u)]);
    }
    return sheet(rows);
  };
  const vanes: Bit[] = [
    { geo: vane(spin + (Math.PI * 2) / 3) },
    { geo: vane(spin + (Math.PI * 4) / 3) },
    { geo: new CylinderGeometry(0.0098, 0.0098, 0.024, 6), pos: [0, y1 + 0.004, 0] },
    { geo: new TorusGeometry(0.0082, 0.0032, 4, 10), pos: [0, y1 - 0.152, 0], rot: [Math.PI / 2, 0, 0] },
  ];
  const cock: Bit[] = [{ geo: vane(spin) }];
  return { shaft, metal, vanes, cock };
}

// ── hats ─────────────────────────────────────────────────────────────────

function buildHat(c: Ctx, head: Group): { hat: Group; halo: Object3D | null } {
  const hat = group(head, 0, 0, 0, "hat");
  let halo: Object3D | null = null;
  switch (c.o.hat) {
    case "feather": featherCap(c, hat); break;
    case "hood": hood(c, hat); break;
    case "crown": crown(c, hat); break;
    case "wizard": wizard(c, hat); break;
    case "beanie": beanie(c, hat); break;
    case "tophat": tophat(c, hat); break;
    case "viking": viking(c, hat); break;
    case "bandana": bandana(c, hat); break;
    case "halo": halo = haloRing(c, hat); break;
    // no hat: face.ts grows the tousled crown, so there is nothing to add here
  }
  return { hat, halo };
}

/**
 * The cap's ring is seated so its lower edge (the brim's inner row) lands where
 * the old torus brim's underside was — head-space y ≈ 0.19 at his front, 0.125
 * at his sides, 0.06 at his back — the line face.ts cuts his hair to.
 */
const CAP_TILT = -0.2;
const CAP_Y = 0.137;

/**
 * THE FEATHERED CAP. Everything sits in the brim's frame — a ring round the
 * head, tipped back so the cap sits jauntily — so the band, the buckle and the
 * feather's socket are all computed from the same radius as the crown.
 */
function featherCap(c: Ctx, hat: Group) {
  const { b, kit } = c;
  const cap = group(hat, 0, CAP_Y, -0.012, "cap");
  cap.rotation.x = CAP_TILT;
  const R = 0.305;
  const SX = 1.05;
  // the front half is a little deeper than the back, to cover his forehead curls
  // without dropping the brim over his brows
  const FS = 1.12;
  const fz = (z: number) => (z > 0 ? z * FS : z);
  const H = 0.36;
  const lean = (y: number) => 0.3 * Math.pow(clamp(y / H, 0, 1), 1.8);
  /** Outward normal of the cap's (front-stretched) ellipse at angle a. */
  const normalAt = (a: number) => v3(Math.sin(a) / SX, 0, Math.cos(a) / (Math.cos(a) > 0 ? FS : 1)).normalize();

  // crown: a soft cone that leans back into a point, wide enough low down to
  // cover his curls
  const prof = [[0.31, -0.03], [0.305, 0], [0.302, 0.03], [0.295, 0.06], [0.278, 0.1], [0.25, 0.145], [0.21, 0.19], [0.16, 0.235], [0.105, 0.28], [0.055, 0.32], [0.02, 0.348], [0.002, 0.36]] as const;
  const crownGeo = bend(new LatheGeometry(prof.map(([r, y]) => v2(r, y)), 40, Math.PI), (v) => {
    v.x *= SX;
    v.z = fz(v.z) - lean(v.y);
  });
  b.part(crownGeo, kit.toon(c.hatHex, { side: DoubleSide }), cap);

  // brim: a point at the front, turned up all round the back, curling at the lip
  const N = 72;
  const rows: Vector3[][] = [];
  const lip: Vector3[] = [];
  for (let i = 0; i <= N; i++) {
    const a = (i / N) * Math.PI * 2;
    const fa = Math.abs(((a + Math.PI) % (Math.PI * 2)) - Math.PI);
    const point = Math.pow(Math.max(0, 1 - fa / 0.95), 1.8);
    const w = 0.05 + 0.062 * point + 0.04 * smooth(1.5, 3.0, fa);
    const lift = -0.1 + 1.35 * smooth(0.15, 2.7, fa);
    const curl = 0.38 * (1 - point);
    const n = normalAt(a);
    const base = v3(Math.sin(a) * R * SX, 0, fz(Math.cos(a) * R));
    const d1 = n.clone().multiplyScalar(Math.cos(lift)).addScaledVector(YP, Math.sin(lift));
    const d2 = n.clone().multiplyScalar(Math.cos(lift + curl)).addScaledVector(YP, Math.sin(lift + curl));
    const inner = base.clone().addScaledVector(n, -0.012).addScaledVector(YP, -0.006);
    const mid = base.clone().addScaledVector(d1, w * 0.55);
    const outer = mid.clone().addScaledVector(d2, w * 0.45);
    rows.push([inner, base, mid, outer]);
    if (i < N) lip.push(outer);
  }
  b.part(sheet(rows), kit.toon(darken(c.hatHex, 0.86), { side: DoubleSide }), cap, { outline: false });
  b.part(new TubeGeometry(new CatmullRomCurve3(lip, true), 120, 0.013, 6, true), kit.toon(darken(c.hatHex, 0.8)), cap);

  // hatband in the boot leather, with a gold buckle at the front left
  // (tall enough to show above the turned-up brim, and leaning with the crown)
  const BAND = 0.082;
  const crownR = (y: number) => {
    for (let i = 1; i < prof.length; i++) {
      const [r1, y1] = prof[i]!;
      const [r0, y0] = prof[i - 1]!;
      if (y <= y1) return r0 + ((r1 - r0) * (y - y0)) / (y1 - y0);
    }
    return 0;
  };
  const band = bend(new CylinderGeometry(1, 1, BAND, 48, 4, true), (v) => {
    const y = v.y + BAND / 2;
    const r = crownR(y) + 0.007;
    v.set(v.x * r * SX, y, fz(v.z * r) - lean(y));
  });
  b.part(band, c.mLeather, cap, { outline: false });
  const ba = 0.6;
  const by = 0.046;
  const bn = normalAt(ba);
  const br = 0.301;
  b.part(placed(buckleGeo(0.044, 0.056, 0.009), [Math.sin(ba) * br * SX, by, fz(Math.cos(ba) * br) - lean(by) + 0.004], onto(bn)), c.mGold, cap, { outline: false, hit: false });

  // the feather, tucked into the band on his left and sweeping up and back
  const fa = 1.85;
  const fg = group(cap, Math.sin(fa) * 0.305 * SX, 0.05, Math.cos(fa) * 0.305 - lean(0.05), "feather");
  fg.rotation.set(-0.5, 0.25, -0.32);
  featherInto(c, fg, 0.56, 0.07, c.trim);
}

/**
 * A FEATHER: a curved, tapering quill with a two-tone vane — a dark barbed
 * edge that stands in for ink, and a smoother face in the feather's colour.
 * Built in its own frame: quill along +y, vane in the xy plane, face toward +z.
 */
function featherInto(c: Ctx, parent: Group, len: number, width: number, hex: string) {
  const { b, kit } = c;
  const quill = new CatmullRomCurve3([v3(0, -0.05, 0), v3(0.012, len * 0.3, 0.006), v3(0.04, len * 0.65, 0.01), v3(0.085, len * 0.95, 0.004)]);
  const K = 18;
  const edge: Vector3[][] = [];
  const front: Vector3[][] = [];
  const back: Vector3[][] = [];
  const P = new Vector3();
  const T = new Vector3();
  const S = new Vector3();
  for (let k = 0; k <= K; k++) {
    const s = 0.12 + (0.88 * k) / K;
    quill.getPointAt(s, P);
    quill.getTangentAt(s, T);
    S.set(T.y, -T.x, 0).normalize();
    const u = (s - 0.12) / 0.88;
    const w = width * Math.pow(Math.sin(Math.PI * Math.pow(u, 0.72)), 0.8);
    // barbs: the edge notches on alternate samples, offset side to side, with a
    // split or two where a real feather's vane has come apart
    const jl = (k % 2 ? 0.64 : 1) * (k === 7 ? 0.42 : 1);
    const jr = (k % 2 ? 1 : 0.64) * (k === 11 ? 0.42 : 1);
    const rise = Math.sin(Math.PI * u) * 0.007;
    edge.push([
      P.clone().addScaledVector(S, w * jl).addScaledVector(T, w * 0.45),
      P.clone().addScaledVector(ZP, rise),
      P.clone().addScaledVector(S, -w * jr).addScaledVector(T, w * 0.45),
    ]);
    const wf = w * 0.74;
    for (const [rows, dz] of [[front, 1], [back, -1]] as const) {
      rows.push([
        P.clone().addScaledVector(S, wf).addScaledVector(T, wf * 0.3).addScaledVector(ZP, 0.003 * dz),
        P.clone().addScaledVector(ZP, rise + 0.004 * dz),
        P.clone().addScaledVector(S, -wf).addScaledVector(T, wf * 0.3).addScaledVector(ZP, 0.003 * dz),
      ]);
    }
  }
  b.part(sheet(edge), kit.toon(darken(hex, 0.58), { side: DoubleSide }), parent, { outline: false });
  // the feather's colour on both faces, the dark barbed edge between them
  b.part(merge([{ geo: sheet(front) }, { geo: sheet(back) }]), kit.toon(hex, { side: DoubleSide }), parent, { outline: false, hit: false });
  b.part(taperTube(quill, 24, 0.0075, 5, (u) => 1 - 0.7 * u), kit.toon(CREAM), parent, { pos: [0, 0, 0.006], outline: false, hit: false });
}

function hood(c: Ctx, hat: Group) {
  const { b, kit } = c;
  const R = 0.345;
  const OPEN = 0.95;
  const TH = 0.74 * Math.PI;
  const off: V3 = [0, 0.01, -0.015];
  const lining = differs(c.trim, c.hatHex) ? lighten(c.trim, 0.1) : lighten(c.hatHex, 0.45);
  const accent = differs(c.trim, c.hatHex) ? new Color(c.trim) : darken(c.hatHex, 0.62);
  const phi0 = Math.PI / 2 + OPEN;
  const phiL = Math.PI * 2 - 2 * OPEN;
  b.part(new SphereGeometry(R, 36, 20, phi0, phiL, 0, TH), kit.toon(c.hatHex, { side: DoubleSide }), hat, { pos: off });
  // the lining, seen round his face
  b.part(new SphereGeometry(R - 0.01, 36, 20, phi0, phiL, 0, TH), kit.toon(lining, { side: DoubleSide }), hat, { pos: off, outline: false, hit: false });

  // the rolled edge of the face opening, in the lining colour
  const edge: Vector3[] = [];
  const K = 16;
  const re = R - 0.004;
  for (let k = -K; k <= K; k++) {
    const th = (TH * Math.abs(k)) / K;
    const sx = k < 0 ? -1 : 1;
    edge.push(v3(sx * re * Math.sin(OPEN) * Math.sin(th) + off[0], re * Math.cos(th) + off[1], re * Math.cos(OPEN) * Math.sin(th) + off[2]));
  }
  b.part(
    merge([
      { geo: new TubeGeometry(new CatmullRomCurve3(edge), 96, 0.024, 8) },
      { geo: sphere(0.024, 10, 8), pos: arr(edge[0]!) },
      { geo: sphere(0.024, 10, 8), pos: arr(edge[edge.length - 1]!) },
    ]),
    kit.toon(lining),
    hat,
  );

  // a seam down the middle, top to back, with cross-stitches over it
  const seam: Bit[] = [];
  const sp: Vector3[] = [];
  const rs = R + 0.002;
  const thAt = (k: number) => 0.06 + (0.6 * Math.PI * k) / 12;
  for (let k = 0; k <= 12; k++) sp.push(v3(off[0], rs * Math.cos(thAt(k)) + off[1], -rs * Math.sin(thAt(k)) + off[2]));
  seam.push({ geo: new TubeGeometry(new CatmullRomCurve3(sp), 36, 0.0065, 5) });
  for (let k = 1; k < 12; k++) {
    const n = v3(0, Math.cos(thAt(k)), -Math.sin(thAt(k)));
    seam.push({ geo: new BoxGeometry(0.028, 0.0065, 0.006), pos: arr(sp[k]!), quat: onto(n) });
  }
  b.part(merge(seam), kit.toon(darken(c.hatHex, 0.62)), hat, { outline: false, hit: false });

  // the liripipe: a long tapering tail down his back, with a tassel
  const tail = new CatmullRomCurve3([v3(0, 0.21, -0.2), v3(0.01, 0.15, -0.35), v3(0.03, 0.03, -0.42), v3(0.05, -0.11, -0.41), v3(0.065, -0.25, -0.35)]);
  b.part(taperTube(tail, 32, 0.105, 12, (u) => 1 - 0.83 * Math.pow(u, 0.75)), kit.toon(c.hatHex), hat);
  const end = tail.getPointAt(1);
  b.part(
    merge([
      { geo: sphere(0.026, 12, 10), pos: [end.x, end.y - 0.012, end.z], scale: [1, 1.25, 1] },
      { geo: new ConeGeometry(0.024, 0.055, 10), pos: [end.x, end.y - 0.05, end.z], rot: [Math.PI, 0, 0] },
    ]),
    kit.toon(accent),
    hat,
    { hit: false },
  );

  // the mantle over his shoulders, its hem cut into dags, with a band on the hem
  const DAGS = 14;
  const DEPTH = 0.045;
  const dagAt = (x: number, z: number) => Math.pow(Math.abs(Math.sin((DAGS / 2) * Math.atan2(x, z))), 0.6);
  const mantle = bend(new ConeGeometry(0.34, 0.2, DAGS * 4, 2, true), (v) => {
    if (v.y > -0.099) return;
    const s = dagAt(v.x, v.z);
    v.y -= DEPTH * s;
    v.x *= 1 + 0.05 * s;
    v.z *= 1 + 0.05 * s;
  });
  b.part(mantle, kit.toon(c.hatHex, { side: DoubleSide }), hat, { pos: [0, -0.3, -0.02] });
  const band = bend(new CylinderGeometry(1, 1, 1, DAGS * 4, 1, true), (v) => {
    const s = dagAt(v.x, v.z);
    const th = Math.atan2(v.x, v.z);
    const yb = -0.1 - DEPTH * s;
    const rb = 0.34 * (1 + 0.05 * s);
    const t = v.y > 0 ? 0.3 : 0;
    const r = rb + t * (0.17 - rb) + 0.0045;
    v.set(Math.sin(th) * r, yb + t * -yb, Math.cos(th) * r);
  });
  b.part(band, kit.toon(accent, { side: DoubleSide }), hat, { pos: [0, -0.3, -0.02], outline: false, hit: false });
}

function crown(c: Ctx, hat: Group) {
  const { b, kit } = c;
  const ZC = -0.02;
  const Y = 0.3;
  // velvet cap inside the band, in the hat colour
  b.part(new SphereGeometry(0.2, 28, 10, 0, Math.PI * 2, 0, Math.PI / 2), kit.toon(darken(c.hatHex, 0.72)), hat, { pos: [0, 0.335, ZC], scale: [1, 0.55, 1] });
  b.part(new CylinderGeometry(0.21, 0.22, 0.11, 36, 1, true), kit.toon(GOLD, { emissive: "#6b4a10", emissiveIntensity: 0.35, side: DoubleSide }), hat, { pos: [0, Y, ZC] });
  const points: Bit[] = [];
  const fili: Bit[] = [
    { geo: new TorusGeometry(0.211, 0.0085, 6, 48), pos: [0, 0.355, ZC], rot: [Math.PI / 2, 0, 0] },
    { geo: new TorusGeometry(0.2205, 0.0095, 6, 48), pos: [0, 0.246, ZC], rot: [Math.PI / 2, 0, 0] },
    { geo: sphere(0.022, 10, 8), pos: [0, 0.447, ZC] },
  ];
  const red: Bit[] = [];
  const blue: Bit[] = [];
  const green: Bit[] = [];
  const pearls: Bit[] = [];
  const GR = 0.215;
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2;
    const s = Math.sin(a);
    const co = Math.cos(a);
    const n = v3(s, 0, co);
    const front = i === 0;
    points.push({ geo: new ConeGeometry(0.034, 0.1, 10), pos: [s * 0.21, 0.405, co * 0.21 + ZC] });
    (front ? green : i % 2 ? red : blue).push({ geo: sphere(front ? 0.02 : 0.016, 10, 8), pos: [s * 0.21, 0.462, co * 0.21 + ZC] });
    // filigree scrolls either side of each point's foot
    for (const side of [-1, 1]) {
      const a2 = a + side * 0.21;
      fili.push({ geo: new TorusGeometry(0.016, 0.0045, 4, 14, Math.PI * 1.4), pos: [Math.sin(a2) * 0.213, 0.37, Math.cos(a2) * 0.213 + ZC], quat: onto(v3(Math.sin(a2), 0, Math.cos(a2)), side > 0 ? -0.35 : Math.PI * 0.95) });
    }
    // the band: a gem in a bezel under each point, pearls between
    if (front) {
      green.push({ geo: new OctahedronGeometry(0.034), pos: [s * (GR + 0.01), Y, co * (GR + 0.01) + ZC], quat: onto(n), scale: [1, 1.2, 0.55] });
      fili.push({ geo: new TorusGeometry(0.036, 0.006, 5, 20), pos: [s * (GR + 0.004), Y, co * (GR + 0.004) + ZC], quat: onto(n), scale: [1, 1.2, 1] });
    } else {
      (i % 2 ? blue : red).push({ geo: new OctahedronGeometry(0.022), pos: [s * (GR + 0.007), Y, co * (GR + 0.007) + ZC], quat: onto(n), scale: [1, 1.25, 0.55] });
      fili.push({ geo: new TorusGeometry(0.024, 0.0045, 4, 16), pos: [s * (GR + 0.003), Y, co * (GR + 0.003) + ZC], quat: onto(n), scale: [1, 1.25, 1] });
    }
    const pa = a + Math.PI / 7;
    const at = (r: number, y: number): V3 => [Math.sin(pa) * r, y, Math.cos(pa) * r + ZC];
    pearls.push(
      { geo: sphere(0.0135, 10, 8), pos: at(GR + 0.008, Y) },
      { geo: sphere(0.0085, 8, 6), pos: at(GR + 0.004, Y + 0.028) },
      { geo: sphere(0.0085, 8, 6), pos: at(GR + 0.006, Y - 0.028) },
    );
  }
  b.part(merge(points), c.mGold, hat);
  b.part(merge(fili), c.mGold, hat, { outline: false, hit: false });
  b.part(merge(red), gem(kit, "#d8344a", "#801020"), hat, { outline: false, hit: false });
  b.part(merge(blue), gem(kit, "#3a7be0", "#103a80"), hat, { outline: false, hit: false });
  b.part(merge(green), gem(kit, "#2fbf71", "#0f6a3a"), hat, { outline: false, hit: false });
  b.part(merge(pearls), kit.toon("#f6f0e6", { emissive: "#6b6050", emissiveIntensity: 0.25 }), hat, { outline: false, hit: false });
}

function wizard(c: Ctx, hat: Group) {
  const { b, kit } = c;
  const mHat = kit.toon(c.hatHex);
  // a floppy brim: thin at the lip, waving and drooping as it goes out
  const brim = bend(
    new LatheGeometry([v2(0.2, -0.012), v2(0.3, -0.009), v2(0.425, -0.008), v2(0.433, 0), v2(0.405, 0.006), v2(0.3, 0.01), v2(0.2, 0.013)], 64, Math.PI),
    (v) => {
      const t = clamp((Math.hypot(v.x, v.z) - 0.24) / 0.19, 0, 1);
      v.y += t * t * (0.026 * Math.sin(3 * Math.atan2(v.x, v.z) + 0.7) - 0.02);
    },
  );
  b.part(brim, kit.toon(c.hatHex, { side: DoubleSide }), hat, { pos: [0, 0.2, -0.02] });
  const CONE_POS: V3 = [0, 0.42, -0.04];
  const CONE_ROT: V3 = [-0.08, 0, 0];
  b.part(new ConeGeometry(0.27, 0.42, 36), mHat, hat, { pos: CONE_POS, rot: CONE_ROT });
  b.part(new ConeGeometry(0.12, 0.3, 20), mHat, hat, { pos: [0, 0.72, -0.16], rot: [-0.7, 0, 0] });
  b.part(new TorusGeometry(0.255, 0.025, 8, 40), c.mTrim, hat, { pos: [0, 0.23, -0.02], rot: [Math.PI / 2, 0, 0], outline: false });
  b.part(merge([{ geo: buckleGeo(0.05, 0.042, 0.009), pos: [0, 0.23, 0.264] }]), c.mGold, hat, { outline: false, hit: false });

  // stars and moons scattered over the cone, each lying on its surface
  const ALPHA = Math.atan2(0.27, 0.42);
  const onCone = (th: number, y: number, lift = 0.003) => {
    const r = (0.27 * (0.21 - y)) / 0.42;
    const n = v3(Math.sin(th) * Math.cos(ALPHA), Math.sin(ALPHA), Math.cos(th) * Math.cos(ALPHA));
    return { p: [Math.sin(th) * r + n.x * lift, y + n.y * lift, Math.cos(th) * r + n.z * lift] as V3, n };
  };
  const decals: Bit[] = [];
  const SCATTER = [
    [-0.55, 0.05, 1, 0.03, 0.4], [1.15, -0.11, 0, 0.026, 0.3], [-1.25, -0.08, 0, 0.03, 1.0], [0.95, 0.09, 1, 0.022, 2.2],
    [-0.15, 0.13, 0, 0.019, 0.2], [2.3, -0.06, 1, 0.03, 1.4], [-2.2, 0.02, 0, 0.03, 0.6], [Math.PI, 0.1, 0, 0.024, 0.9],
    [0.3, -0.15, 0, 0.016, 0.5], [-0.8, -0.15, 0, 0.018, 0.1], [1.7, 0.03, 0, 0.02, 0.7], [-1.8, 0.12, 1, 0.018, 2.8],
  ] as const;
  for (const [th, y, moon, size, spin] of SCATTER) {
    const { p, n } = onCone(th, y);
    decals.push({ geo: moon ? moonGeo(size) : starGeo(size, size * 0.45, 0.005), pos: p, quat: onto(n, spin) });
  }
  b.part(merge(decals), kit.toon("#ffe9a8", { emissive: "#c9a23a", emissiveIntensity: 0.55 }), hat, { pos: CONE_POS, rot: CONE_ROT, outline: false, hit: false });
  const big = onCone(0.42, -0.04, 0.004);
  b.part(placed(starGeo(0.052, 0.023, 0.008), big.p, onto(big.n, 0.15)), kit.toon("#ffe27a", { emissive: "#ffcf3a", emissiveIntensity: 0.9 }), hat, { pos: CONE_POS, rot: CONE_ROT });

  // a tiny bell on the bent tip
  const tip = v3(0, 0.15, 0).applyEuler(new Euler(-0.7, 0, 0)).add(v3(0, 0.72, -0.16));
  const bell = new LatheGeometry([v2(0.001, -0.042), v2(0.026, -0.046), v2(0.03, -0.041), v2(0.023, -0.031), v2(0.019, -0.013), v2(0.014, -0.001), v2(0.001, 0.005)], 16);
  b.part(
    merge([
      { geo: bell, pos: [tip.x, tip.y - 0.014, tip.z - 0.004] },
      { geo: new TorusGeometry(0.008, 0.0028, 4, 10), pos: [tip.x, tip.y - 0.004, tip.z - 0.003] },
    ]),
    c.mGold,
    hat,
    { hit: false },
  );
}

/**
 * The beanie is worn pushed back: tipped BEANIE_TILT about its own centre so
 * the cuff's lower edge clears his brows at the front (y ≈ 0.17) and drops to
 * the nape at the back, leaving the eyes, brows and fringe free (and any
 * eyewear in front of the knit, not through it). face.ts's CUTS.beanie is
 * this edge; change both together.
 */
const BEANIE_TILT = 0.42;
const BEANIE_AT: V3 = [0, 0.075, -0.03];

function beanie(c: Ctx, hat: Group) {
  const { b, kit } = c;
  const knit = group(hat, ...BEANIE_AT, "beanie");
  knit.rotation.x = -BEANIE_TILT;
  // knit ribs: vertical ridges pressed into the dome, fading out at the crown
  const dome = bend(new SphereGeometry(0.318, 96, 16, 0, Math.PI * 2, 0, Math.PI / 2), (v) => {
    const k = 1 + 0.024 * (0.5 + 0.5 * Math.cos(24 * Math.atan2(v.z, v.x))) * smooth(0.06, 0.24, Math.hypot(v.x, v.z));
    v.x *= k;
    v.z *= k;
  });
  b.part(dome, kit.toon(c.hatHex), knit);
  // the folded cuff, finer-ribbed and a shade darker, with rolled edges
  const mCuff = kit.toon(darken(c.hatHex, 0.84));
  const cuff = bend(new CylinderGeometry(0.333, 0.338, 0.1, 96, 2, true), (v) => {
    const k = 1 + 0.03 * (0.5 + 0.5 * Math.cos(32 * Math.atan2(v.z, v.x)));
    v.x *= k;
    v.z *= k;
  });
  b.part(cuff, mCuff, knit, { pos: [0, 0.015, 0] });
  b.part(
    merge([
      { geo: new TorusGeometry(0.343, 0.013, 6, 64), pos: [0, 0.066, 0], rot: [Math.PI / 2, 0, 0] },
      { geo: new TorusGeometry(0.347, 0.012, 6, 64), pos: [0, -0.034, 0], rot: [Math.PI / 2, 0, 0] },
    ]),
    mCuff,
    knit,
    { outline: false, hit: false },
  );
  // a leather patch on the cuff
  b.part(roundedBox(0.078, 0.052, 0.016, 0.007), c.mLeather, knit, { pos: [0, 0.016, 0.351], outline: false, hit: false });
  // a fluffy pompom: a core and a ring of lumps
  const PY = 0.37;
  const pom: Bit[] = [{ geo: sphere(0.058, 14, 10), pos: [0, PY, -0.01] }];
  fibonacci(11).forEach((d, i) => pom.push({ geo: sphere(0.033 + (i % 3) * 0.004, 10, 8), pos: [d.x * 0.054, PY + d.y * 0.05, -0.01 + d.z * 0.054] }));
  b.part(merge(pom), kit.toon(c.trim), knit);
}

function tophat(c: Ctx, hat: Group) {
  const { b, kit } = c;
  const black = kit.toon("#1c1b22");
  // the brim: a rolled lip, curled up at the sides
  const brim = bend(
    new LatheGeometry([v2(0.19, -0.012), v2(0.31, -0.01), v2(0.338, 0.002), v2(0.35, 0.02), v2(0.344, 0.031), v2(0.331, 0.019), v2(0.3, 0.012), v2(0.19, 0.012)], 64, Math.PI),
    (v) => {
      v.y += ((0.05 * v.x * v.x) / (0.35 * 0.35)) * smooth(0.2, 0.34, Math.hypot(v.x, v.z));
    },
  );
  b.part(brim, black, hat, { pos: [0, 0.22, -0.02] });
  // a waisted crown with a soft top edge
  b.part(new LatheGeometry([v2(0.19, -0.19), v2(0.185, -0.1), v2(0.184, 0), v2(0.19, 0.1), v2(0.198, 0.168), v2(0.201, 0.183), v2(0.194, 0.191), v2(0.001, 0.192)], 36, Math.PI), black, hat, { pos: [0, 0.42, -0.02] });
  b.part(new CylinderGeometry(0.1888, 0.1927, 0.07, 36, 1, true), c.mTrim, hat, { pos: [0, 0.27, -0.02], outline: false });
  const ba = 0.5;
  const bn = v3(Math.sin(ba), 0, Math.cos(ba));
  b.part(placed(buckleGeo(0.04, 0.06, 0.008), [bn.x * 0.196, 0.27, bn.z * 0.196 - 0.02], onto(bn)), c.mGold, hat, { outline: false, hit: false });
  // a playing card tucked into the band
  const ca = -0.75;
  const cn = v3(Math.sin(ca), 0, Math.cos(ca));
  const cq = onto(cn, -0.32);
  const cp: V3 = [cn.x * 0.197, 0.312, cn.z * 0.197 - 0.02];
  b.part(placed(new BoxGeometry(0.068, 0.096, 0.004), cp, cq), kit.toon("#f7f3ea"), hat, { hit: false });
  const pip = v3(0, 0.008, 0.0035).applyQuaternion(cq);
  b.part(placed(new OctahedronGeometry(0.018), [cp[0] + pip.x, cp[1] + pip.y, cp[2] + pip.z], cq, [0.72, 1, 0.25]), kit.basic("#d8344a"), hat, { outline: false, hit: false });
  hat.rotation.z = -0.08;
}

/**
 * The horned helm is tipped back VIKING_TILT about its own centre, so the
 * band's lower edge sits on his brow (y ≈ 0.105 at the front) rather than
 * across his eyes — and glasses, shades or a visor sit under it, not through
 * it. face.ts's CUTS.viking is this edge; change both together.
 */
const VIKING_TILT = 0.26;

function viking(c: Ctx, hat: Group) {
  const { b, kit } = c;
  const helm = group(hat, 0, 0.04, -0.01, "helm");
  helm.rotation.x = -VIKING_TILT;
  b.part(new SphereGeometry(0.325, 32, 14, 0, Math.PI * 2, 0, Math.PI / 2), c.mMetal, helm);
  b.part(new TorusGeometry(0.322, 0.03, 8, 48), c.mGold, helm, { pos: [0, 0.01, 0], rot: [Math.PI / 2, 0, 0] });
  // spangenhelm bands over the top, side to side and front to back
  b.part(
    merge([
      { geo: new TorusGeometry(0.327, 0.016, 6, 40, Math.PI) },
      { geo: new TorusGeometry(0.327, 0.016, 6, 40, Math.PI), rot: [0, Math.PI / 2, 0] },
    ]),
    kit.toon(darken(METAL, 0.78)),
    helm,
    { outline: false, hit: false },
  );
  // rivets round the band and along the bands
  const riv: Bit[] = [];
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2 + 0.17;
    riv.push({ geo: sphere(0.0125, 8, 6), pos: [Math.sin(a) * 0.349, 0.01, Math.cos(a) * 0.349] });
  }
  const rr = 0.327 + 0.016;
  for (const t of [0.35, 0.75, 1.15, Math.PI - 1.15, Math.PI - 0.75, Math.PI - 0.35]) {
    riv.push({ geo: sphere(0.011, 8, 6), pos: [Math.cos(t) * rr, Math.sin(t) * rr, 0] });
    riv.push({ geo: sphere(0.011, 8, 6), pos: [0, Math.sin(t) * rr, -Math.cos(t) * rr] });
  }
  b.part(merge(riv), kit.toon(lighten(METAL, 0.35)), helm, { outline: false, hit: false });
  // nose guard, gold-rimmed
  b.part(roundedBox(0.058, 0.168, 0.016, 0.0075), c.mGold, helm, { pos: [0, -0.048, 0.328], outline: false });
  b.part(roundedBox(0.042, 0.15, 0.022, 0.009), c.mMetal, helm, { pos: [0, -0.046, 0.334] });
  // tapering horns with gold rings near the base
  const horns: Bit[] = [];
  const rings: Bit[] = [];
  const taper = (u: number) => 1 - 0.82 * Math.pow(u, 1.15);
  for (const sx of [1, -1]) {
    const curve = new CatmullRomCurve3([v3(0.24 * sx, 0.09, 0.01), v3(0.38 * sx, 0.15, 0.01), v3(0.47 * sx, 0.28, -0.005), v3(0.49 * sx, 0.46, -0.03)]);
    horns.push({ geo: taperTube(curve, 24, 0.052, 12, taper) }, { geo: sphere(0.052 * taper(1), 8, 6), pos: arr(curve.getPointAt(1)) });
    for (const u of [0.17, 0.28]) {
      rings.push({ geo: new TorusGeometry(0.052 * taper(u) + 0.003, 0.0085, 6, 20), pos: arr(curve.getPointAt(u)), quat: onto(curve.getTangentAt(u)) });
    }
  }
  b.part(merge(horns), kit.toon(BONE), helm);
  b.part(merge(rings), c.mGold, helm, { outline: false, hit: false });
}

function bandana(c: Ctx, hat: Group) {
  const { b, kit } = c;
  const mHat = kit.toon(c.hatHex);
  const BP: V3 = [0, 0.12, -0.01];
  const BR: V3 = [Math.PI / 2 - 0.15, 0, 0];
  const BS: V3 = [1, 1, 1.3];
  const R = 0.3;
  const TUBE = 0.042;
  b.part(new TorusGeometry(R, TUBE, 10, 56), mHat, hat, { pos: BP, rot: BR, scale: BS });
  // a little pattern of dots, two staggered rows, none under the knot
  const dots: Bit[] = [];
  for (let k = 0; k < 34; k++) {
    const u = (k / 34) * Math.PI * 2;
    if (Math.abs(u - Math.PI * 1.5) < 0.3) continue;
    const vv = k % 2 ? 0.6 : -0.6;
    const n = v3(Math.cos(vv) * Math.cos(u), Math.cos(vv) * Math.sin(u), Math.sin(vv));
    const rr = R + (TUBE + 0.001) * Math.cos(vv);
    dots.push({ geo: sphere(0.0115, 8, 6), pos: [rr * Math.cos(u), rr * Math.sin(u), (TUBE + 0.001) * Math.sin(vv)], quat: onto(n), scale: [1, 1, 0.4] });
  }
  b.part(merge(dots), kit.toon("#fbf6ea"), hat, { pos: BP, rot: BR, scale: BS, outline: false, hit: false });
  // the knot at the back, its two loops, and two tails with notched ends
  const back = v3(0, -(R + TUBE), 0).applyEuler(new Euler(...BR)).add(v3(...BP));
  b.part(
    merge([
      { geo: sphere(0.04, 14, 10), pos: [back.x, back.y, back.z - 0.01], scale: [1.15, 0.95, 0.85] },
      { geo: sphere(0.07, 12, 8), pos: [0.055, back.y + 0.012, back.z + 0.004], rot: [0.6, 0.5, 0], scale: [0.6, 1.4, 0.4] },
      { geo: sphere(0.07, 12, 8), pos: [-0.055, back.y + 0.012, back.z + 0.004], rot: [0.6, -0.5, 0], scale: [0.6, 1.4, 0.4] },
    ]),
    mHat,
    hat,
  );
  const tails: Bit[] = [];
  for (const sx of [1, -1]) {
    // hanging nearly plumb from the knot: drifting in toward the head, they sank into the nape hair
    const path = new CatmullRomCurve3([v3(0.015 * sx, back.y - 0.015, back.z - 0.012), v3(0.045 * sx, back.y - 0.075, back.z - 0.008), v3(0.07 * sx, back.y - 0.145, back.z), v3(0.09 * sx, back.y - 0.215, back.z + 0.012)]);
    const rows: Vector3[][] = [];
    for (let k = 0; k <= 10; k++) {
      const u = k / 10;
      const P = path.getPointAt(u);
      const T = path.getTangentAt(u);
      const side = new Vector3().crossVectors(T, v3(0, 0, -1)).normalize().applyAxisAngle(T, Math.sin(u * 2.4) * 0.45 * sx);
      const w = 0.026 * (1 - 0.3 * u);
      rows.push([P.clone().addScaledVector(side, -w), P.clone().addScaledVector(T, k === 10 ? -0.03 : 0), P.clone().addScaledVector(side, w)]);
    }
    tails.push({ geo: sheet(rows) });
  }
  b.part(merge(tails), kit.toon(darken(c.hatHex, 0.9), { side: DoubleSide }), hat, { outline: false });
}

function haloRing(c: Ctx, hat: Group): Group {
  const { b, kit } = c;
  const g = group(hat, 0, 0.47, -0.02, "halo");
  const FLAT: V3 = [Math.PI / 2, 0, 0];
  b.part(new TorusGeometry(0.19, 0.022, 8, 40), kit.toon("#ffe9a0", { emissive: "#ffd34a", emissiveIntensity: 1 }), g, { rot: FLAT, outline: false, hit: false });
  // a hot inner ring and a soft glow round the whole thing
  b.part(new TorusGeometry(0.168, 0.0065, 6, 40), kit.basic("#fffbe6"), g, { rot: FLAT, outline: false, hit: false });
  b.part(new TorusGeometry(0.19, 0.055, 8, 40), kit.basic("#ffe28a", { transparent: true, opacity: 0.2 }), g, { rot: FLAT, outline: false, hit: false });
  // four glints riding the ring
  const glints: Bit[] = [];
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    glints.push({ geo: new OctahedronGeometry(0.022), pos: [Math.cos(a) * 0.19, 0.018, Math.sin(a) * 0.19], scale: [0.3, 1, 0.3] });
  }
  b.part(merge(glints), kit.basic("#fffbe6"), g, { outline: false, hit: false });
  return g;
}

// ── held props ───────────────────────────────────────────────────────────

function buildHeld(c: Ctx, at: GearAnchors): { bow: Rig["bow"]; held: Group | null } {
  const { o } = c;
  if (o.held === "bow") return { bow: longbow(c, at), held: null };
  if (o.held === "none") return { bow: null, held: null };
  const shield = o.held === "shield";
  const held = group(shield ? at.handL : at.handR, 0, -0.03, 0, "held");
  switch (o.held) {
    case "sword": sword(c, held); break;
    case "staff": staff(c, held); break;
    case "lantern": lantern(c, held); break;
    case "coinbag": coinbag(c, held); break;
    case "mug": mug(c, held); break;
    case "shield": shieldOf(c, held); break;
  }
  return { bow: null, held };
}

/**
 * THE LONGBOW. Two copies — drawn in the left hand, slung on the back — so
 * every detail is built by one function. `top`/`bottom` stay the string's
 * anchors at the limb tips, in the bow's own frame, as applyPose expects.
 */
function longbow(c: Ctx, at: GearAnchors): NonNullable<Rig["bow"]> {
  const { b, kit } = c;
  const TOP = v3(0, 0.06, 0.48);
  const BOTTOM = v3(0, 0.06, -0.48);
  const arc = new CatmullRomCurve3([BOTTOM.clone(), v3(0, -0.05, -0.25), v3(0, -0.08, 0), v3(0, -0.05, 0.25), TOP.clone()]);
  const mWrap = kit.toon(darken(c.leather, 0.62));
  const makeBow = (parent: Object3D) => {
    const g = group(parent, 0, 0, 0, "bow");
    // limbs that taper from the grip to the tips
    b.part(taperTube(arc, 40, 0.02, 8, (u) => 0.52 + 0.48 * Math.sin(Math.PI * u)), c.mWood, g);
    // leather grip with a spiral wrap and bound ends
    b.part(new CylinderGeometry(0.026, 0.026, 0.1, 12), c.mLeather, g, { pos: [0, -0.08, 0], rot: [Math.PI / 2, 0, 0], outline: false });
    b.part(
      merge([
        { geo: new TubeGeometry(helixY(0.0265, -0.05, 0.05, 4.5), 64, 0.0042, 4) },
        { geo: new TorusGeometry(0.027, 0.0045, 4, 14), pos: [0, 0.05, 0], rot: [Math.PI / 2, 0, 0] },
        { geo: new TorusGeometry(0.027, 0.0045, 4, 14), pos: [0, -0.05, 0], rot: [Math.PI / 2, 0, 0] },
      ]),
      mWrap,
      g,
      { pos: [0, -0.08, 0], rot: [Math.PI / 2, 0, 0], outline: false, hit: false },
    );
    // coloured bindings on the limbs either side of the grip
    const bands: Bit[] = [];
    for (const u of [0.42, 0.58]) {
      const r = 0.02 * (0.52 + 0.48 * Math.sin(Math.PI * u)) + 0.002;
      bands.push({ geo: new TorusGeometry(r, 0.0045, 4, 12), pos: arr(arc.getPointAt(u)), quat: onto(arc.getTangentAt(u)) });
    }
    b.part(merge(bands), c.mTrim, g, { outline: false, hit: false });
    // horn nocks at the tips
    const nocks: Bit[] = [];
    for (const u of [0, 1]) {
      const out = arc.getTangentAt(u).multiplyScalar(u ? 1 : -1);
      nocks.push({ geo: new ConeGeometry(0.012, 0.042, 8), pos: arr(arc.getPointAt(u).addScaledVector(out, 0.014)), quat: onto(out, 0, YP) });
    }
    b.part(merge(nocks), kit.toon(BONE), g, { outline: false, hit: false });
    return g;
  };
  const hand = makeBow(at.handL);
  // The grip (bow-local y −0.08) lands at hand-local y −0.065, inside the
  // curled fingers of body.ts's fist (which spans y +0.02..−0.105), so the
  // bow is held rather than hanging under the knuckles.
  hand.position.set(0, 0.015, 0);
  const back = makeBow(at.spine);
  back.position.set(0, 0.16, -0.25);
  back.rotation.set(0, Math.PI / 2, 0.75);
  const mString = kit.basic("#f2ead8");
  const mServe = kit.toon("#4a3a30");
  const stringTop = b.part(new CylinderGeometry(0.004, 0.004, 1, 4), mString, hand, { outline: false, hit: false });
  const stringBottom = b.part(new CylinderGeometry(0.004, 0.004, 1, 4), mString, hand, { outline: false, hit: false });
  // the serving where the arrow nocks: the string's local +y end is the nock,
  // and the string is scaled along y to its length, so this rides along
  for (const s of [stringTop, stringBottom]) b.part(new CylinderGeometry(0.0075, 0.0075, 0.16, 6), mServe, s, { pos: [0, 0.42, 0], outline: false, hit: false });
  const arrow = new Mesh();
  hand.add(arrow);
  const a = arrowBits(-0.3, 0.31, true);
  b.part(merge(a.shaft), c.mWood, arrow, { outline: false, hit: false });
  b.part(merge(a.metal), c.mMetal, arrow, { outline: false, hit: false });
  b.part(merge(a.vanes), kit.toon(c.trim, { side: DoubleSide }), arrow, { outline: false, hit: false });
  b.part(merge(a.cock), kit.toon(CREAM, { side: DoubleSide }), arrow, { outline: false, hit: false });
  return { hand, back, top: TOP, bottom: BOTTOM, stringTop, stringBottom, arrow };
}

function sword(c: Ctx, held: Group) {
  const { b, kit } = c;
  const s = group(held, 0, 0, 0.02);
  s.rotation.x = 1.05;
  // the blade: a bevelled edge all round, a fuller down each face
  const shape = new Shape();
  shape.moveTo(-0.019, -0.082);
  shape.lineTo(-0.0175, -0.47);
  shape.quadraticCurveTo(-0.016, -0.56, 0, -0.63);
  shape.quadraticCurveTo(0.016, -0.56, 0.0175, -0.47);
  shape.lineTo(0.019, -0.082);
  shape.closePath();
  const blade = new ExtrudeGeometry(shape, { depth: 0.004, bevelEnabled: true, bevelThickness: 0.0055, bevelSize: 0.005, bevelSegments: 1, curveSegments: 6 });
  blade.translate(0, 0, -0.002);
  b.part(blade, c.mMetal, s);
  b.part(
    merge([
      { geo: new BoxGeometry(0.0075, 0.32, 0.002), pos: [0, -0.27, 0.0078] },
      { geo: new BoxGeometry(0.0075, 0.32, 0.002), pos: [0, -0.27, -0.0078] },
    ]),
    kit.toon(darken(METAL, 0.6)),
    s,
    { outline: false, hit: false },
  );
  // a crossguard whose quillons curl back toward the hand, gold knobs at the ends
  const guard = new CatmullRomCurve3([v3(-0.1, -0.045, 0), v3(-0.096, -0.07, 0), v3(-0.055, -0.08, 0), v3(0, -0.077, 0), v3(0.055, -0.08, 0), v3(0.096, -0.07, 0), v3(0.1, -0.045, 0)]);
  b.part(
    merge([
      { geo: new TubeGeometry(guard, 32, 0.0105, 6) },
      { geo: sphere(0.0145, 10, 8), pos: [-0.1, -0.042, 0] },
      { geo: sphere(0.0145, 10, 8), pos: [0.1, -0.042, 0] },
      { geo: roundedBox(0.04, 0.03, 0.03, 0.008), pos: [0, -0.076, 0] },
    ]),
    c.mGold,
    s,
  );
  // leather grip with a spiral wrap
  b.part(new CylinderGeometry(0.017, 0.019, 0.12, 10), kit.toon(darken(c.leather, 0.72)), s);
  b.part(new TubeGeometry(helixY(0.0192, -0.056, 0.056, 5), 72, 0.0042, 4), kit.toon(lighten(c.leather, 0.22)), s, { outline: false, hit: false });
  // pommel with a gem set in each face
  b.part(
    merge([
      { geo: sphere(0.028, 14, 10), pos: [0, 0.086, 0] },
      { geo: new TorusGeometry(0.018, 0.005, 5, 14), pos: [0, 0.062, 0], rot: [Math.PI / 2, 0, 0] },
    ]),
    c.mGold,
    s,
  );
  b.part(
    merge([
      { geo: new OctahedronGeometry(0.013), pos: [0, 0.086, 0.025], scale: [1, 1.2, 0.6] },
      { geo: new OctahedronGeometry(0.013), pos: [0, 0.086, -0.025], scale: [1, 1.2, 0.6] },
    ]),
    gem(kit, "#d8344a", "#801020"),
    s,
    { outline: false, hit: false },
  );
}

function staff(c: Ctx, hand: Group) {
  const { b, kit } = c;
  // leaned a touch out and forward, so the crystal clears his head when his
  // arm hangs at rest (applyPose spins `held` about y; this tilt rides inside it)
  const held = group(hand, 0, 0, 0, "staffTilt");
  held.rotation.set(0.08, 0, 0.17);
  const Z = 0.03;
  b.part(new CylinderGeometry(0.022, 0.026, 1.25, 10), c.mWood, held, { pos: [0, 0.08, Z] });
  // carved spiral grooves up the top of the shaft, and paired rings
  const carve: Bit[] = [{ geo: new TubeGeometry(helixY(0.0225, 0.25, 0.62, 3.5), 64, 0.0048, 4), pos: [0, 0, Z] }];
  for (const y of [0.2, 0.225, -0.25, -0.275]) carve.push({ geo: new TorusGeometry(0.0245 + (0.705 - y) * 0.0032, 0.0042, 4, 14), pos: [0, y, Z], rot: [Math.PI / 2, 0, 0] });
  b.part(merge(carve), kit.toon(darken(WOOD, 0.58)), held, { outline: false, hit: false });
  // leather grip where the hand closes, bound at both ends
  b.part(
    merge([
      { geo: new CylinderGeometry(0.029, 0.029, 0.15, 12, 1, true), pos: [0, 0, Z] },
      { geo: new TorusGeometry(0.03, 0.005, 4, 14), pos: [0, 0.075, Z], rot: [Math.PI / 2, 0, 0] },
      { geo: new TorusGeometry(0.03, 0.005, 4, 14), pos: [0, -0.075, Z], rot: [Math.PI / 2, 0, 0] },
    ]),
    c.mLeather,
    held,
    { outline: false, hit: false },
  );
  // the forked top: three prongs cradling the crystal
  const fork: Bit[] = [{ geo: sphere(0.032, 12, 10), pos: [0, 0.685, Z], scale: [1, 1.2, 1] }];
  for (let k = 0; k < 3; k++) {
    const th = (k * Math.PI * 2) / 3 + 0.3;
    const at = (r: number, y: number) => v3(Math.sin(th) * r, y, Math.cos(th) * r + Z);
    fork.push({ geo: taperTube(new CatmullRomCurve3([at(0, 0.67), at(0.034, 0.72), at(0.058, 0.78), at(0.052, 0.845), at(0.024, 0.89)]), 14, 0.014, 6, (u) => 1 - 0.6 * u) });
  }
  b.part(merge(fork), c.mWood, held);
  b.part(
    merge([
      { geo: new TorusGeometry(0.027, 0.007, 5, 16), pos: [0, 0.65, Z], rot: [Math.PI / 2, 0, 0] },
      { geo: new TorusGeometry(0.026, 0.005, 5, 16), pos: [0, 0.628, Z], rot: [Math.PI / 2, 0, 0] },
    ]),
    c.mGold,
    held,
    { outline: false, hit: false },
  );
  b.part(new OctahedronGeometry(0.06), kit.toon("#9ff3ff", { emissive: "#3fd6ff", emissiveIntensity: 1.1 }), held, { pos: [0, 0.79, Z], rot: [0, Math.PI / 4, 0], scale: [0.7, 1.3, 0.7], outline: false });
  b.part(sphere(0.11, 16, 12), kit.basic("#8ff0ff", { transparent: true, opacity: 0.18 }), held, { pos: [0, 0.79, Z], outline: false, hit: false });
  // an iron ferrule on the foot
  b.part(new CylinderGeometry(0.027, 0.022, 0.05, 10), c.mMetal, held, { pos: [0, -0.525, Z], outline: false });
}

function lantern(c: Ctx, held: Group) {
  const { b, kit } = c;
  const mIron = kit.toon(IRON);
  const Y = -0.178;
  // the solid ironwork: cap, lip, base, and a knob underneath
  b.part(
    merge([
      { geo: new ConeGeometry(0.064, 0.05, 6), pos: [0, -0.098, 0] },
      { geo: new CylinderGeometry(0.066, 0.066, 0.012, 6), pos: [0, -0.124, 0] },
      { geo: new CylinderGeometry(0.066, 0.06, 0.024, 6), pos: [0, -0.24, 0] },
      { geo: sphere(0.014, 8, 6), pos: [0, -0.256, 0] },
    ]),
    mIron,
    held,
  );
  // the frame bars round the panes, and the bail the hand holds
  const thin: Bit[] = [{ geo: new TorusGeometry(0.04, 0.0045, 5, 16, Math.PI), pos: [0, -0.072, 0] }];
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    thin.push({ geo: new CylinderGeometry(0.0048, 0.0048, 0.106, 4), pos: [Math.sin(a) * 0.053, Y, Math.cos(a) * 0.053] });
  }
  b.part(merge(thin), mIron, held, { outline: false, hit: false });
  b.part(sphere(0.012, 8, 6), c.mGold, held, { pos: [0, -0.07, 0], outline: false, hit: false });
  // a flame behind warm glass, and its glow
  b.part(
    merge([
      { geo: sphere(0.02, 10, 8), pos: [0, -0.192, 0] },
      { geo: new ConeGeometry(0.019, 0.046, 10), pos: [0, -0.165, 0] },
    ]),
    kit.basic("#fff0b0"),
    held,
    { outline: false, hit: false },
  );
  b.part(new CylinderGeometry(0.05, 0.05, 0.1, 6), kit.toon("#ffd27a", { emissive: "#ffb43a", emissiveIntensity: 1.1, transparent: true, opacity: 0.6 }), held, { pos: [0, Y, 0], outline: false });
  b.part(sphere(0.12, 14, 10), kit.basic("#ffc46a", { transparent: true, opacity: 0.15 }), held, { pos: [0, Y, 0], outline: false, hit: false });
}

function coinbag(c: Ctx, held: Group) {
  const { b, kit } = c;
  // a sack cinched at the neck, its mouth flaring into a ruffle under the hand
  const prof = [[0.001, -0.285], [0.055, -0.278], [0.095, -0.25], [0.116, -0.205], [0.114, -0.158], [0.094, -0.118], [0.06, -0.093], [0.034, -0.08], [0.03, -0.072], [0.038, -0.062], [0.05, -0.052], [0.058, -0.044]] as const;
  const rBag = (y: number) => {
    for (let i = 1; i < prof.length; i++) {
      const [r1, y1] = prof[i]!;
      const [r0, y0] = prof[i - 1]!;
      if (y <= y1) return r0 + ((r1 - r0) * (y - y0)) / (y1 - y0);
    }
    return prof[prof.length - 1]![0];
  };
  const SZ = 0.92;
  const Z = 0.02;
  const bag = bend(new LatheGeometry(prof.map(([r, y]) => v2(r, y)), 40, Math.PI), (v) => {
    const k = 1 + 0.18 * Math.sin(10 * Math.atan2(v.x, v.z)) * smooth(-0.075, -0.044, v.y);
    v.x *= k;
    v.z *= k;
  });
  b.part(bag, kit.toon("#b08a52", { side: DoubleSide }), held, { pos: [0, 0, Z], scale: [1, 1, SZ] });
  // the drawstring: a tie round the neck, a knot, two cord ends with beads
  const front = (x: number, y: number) => v3(x, y, Z + SZ * (rBag(y) + 0.009));
  const cord: Bit[] = [
    { geo: new TorusGeometry(0.033, 0.009, 6, 18), pos: [0, -0.076, Z], rot: [Math.PI / 2, 0, 0], scale: [1, SZ, 1] },
    { geo: sphere(0.014, 10, 8), pos: arr(front(0, -0.079)) },
  ];
  for (const sx of [1, -1]) {
    const ends = [front(0.004 * sx, -0.083), front(0.012 * sx, -0.1), front(0.018 * sx, -0.12), front(0.02 * sx, -0.138)];
    cord.push({ geo: new TubeGeometry(new CatmullRomCurve3(ends), 12, 0.0042, 4) }, { geo: sphere(0.0085, 8, 6), pos: arr(ends[3]!) });
  }
  b.part(merge(cord), c.mLeather, held, { outline: false, hit: false });
  // a coin stitched on the belly, with a $ struck on it
  const ey = -0.19;
  const ez = Z + SZ * rBag(ey);
  b.part(new CylinderGeometry(0.04, 0.04, 0.008, 22), c.mGold, held, { pos: [0, ey, ez + 0.002], rot: [Math.PI / 2, 0, 0] });
  const S = 0.021;
  const sCurve = new CatmullRomCurve3([v3(0.6, 0.72, 0), v3(0, 1, 0), v3(-0.62, 0.55, 0), v3(0, 0, 0), v3(0.62, -0.55, 0), v3(0, -1, 0), v3(-0.6, -0.72, 0)].map((p) => p.multiplyScalar(S)));
  b.part(
    merge([
      { geo: new TubeGeometry(sCurve, 32, 0.0045, 5), pos: [0, ey, ez + 0.0075] },
      { geo: new CylinderGeometry(0.0034, 0.0034, 0.062, 5), pos: [0, ey, ez + 0.0075] },
    ]),
    kit.toon(darken(GOLD, 0.5)),
    held,
    { outline: false, hit: false },
  );
  // a couple of coins peeking out of the mouth
  b.part(
    merge([
      { geo: new CylinderGeometry(0.028, 0.028, 0.007, 16), pos: [0.022, -0.05, Z + 0.034], rot: [1.1, 0, -0.35] },
      { geo: new CylinderGeometry(0.026, 0.026, 0.007, 16), pos: [-0.028, -0.052, Z + 0.026], rot: [0.9, 0, 0.5] },
      { geo: new CylinderGeometry(0.024, 0.024, 0.007, 16), pos: [0.05, -0.058, Z - 0.006], rot: [0.3, 0, -1.0] },
    ]),
    c.mGold,
    held,
    { outline: false, hit: false },
  );
}

function mug(c: Ctx, held: Group) {
  const { b, kit } = c;
  const m = group(held, 0, -0.04, 0.08, "mug");
  m.rotation.x = Math.PI / 2;
  const tankard = "#a0703c";
  b.part(new CylinderGeometry(0.06, 0.055, 0.13, 20), kit.toon(tankard), m);
  // stave joints, and two iron hoops
  const staves: Bit[] = [];
  for (let k = 0; k < 10; k++) {
    const a = (k / 10) * Math.PI * 2 + 0.3;
    staves.push({ geo: new BoxGeometry(0.0042, 0.122, 0.004), pos: [Math.sin(a) * 0.0585, 0, Math.cos(a) * 0.0585], rot: [0, a, 0] });
  }
  b.part(merge(staves), kit.toon(darken(tankard, 0.58)), m, { outline: false, hit: false });
  b.part(
    merge([
      { geo: new TorusGeometry(0.0605, 0.0068, 5, 24), pos: [0, 0.042, 0], rot: [Math.PI / 2, 0, 0] },
      { geo: new TorusGeometry(0.0565, 0.0068, 5, 24), pos: [0, -0.042, 0], rot: [Math.PI / 2, 0, 0] },
    ]),
    kit.toon(darken(METAL, 0.72)),
    m,
    { outline: false, hit: false },
  );
  b.part(new TorusGeometry(0.035, 0.011, 8, 16, Math.PI), kit.toon(darken(tankard, 0.8)), m, { pos: [-0.058, 0, 0], rot: [0, 0, Math.PI / 2] });
  // foam heaped over the rim, bubbles round the edge, a drip or two down the side
  const foam: Bit[] = [{ geo: new SphereGeometry(0.058, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2), pos: [0, 0.062, 0], scale: [1, 0.5, 1] }];
  for (let k = 0; k < 7; k++) {
    const a = (k / 7) * Math.PI * 2 + 0.2;
    foam.push({ geo: sphere(0.017 + (k % 3) * 0.0035, 10, 8), pos: [Math.sin(a) * 0.05, 0.068 + (k % 2) * 0.006, Math.cos(a) * 0.05] });
  }
  for (const [a, len] of [[0.9, 0.03], [2.6, 0.02]] as const) foam.push({ geo: capsule(0.0095, len), pos: [Math.sin(a) * 0.0605, 0.055 - len / 2, Math.cos(a) * 0.0605] });
  b.part(merge(foam), kit.toon("#fbf6ea"), m);
}

function shieldOf(c: Ctx, held: Group) {
  const { b, kit } = c;
  const s = group(held, 0.07, 0.05, 0);
  s.rotation.set(0, Math.PI / 2, 0);
  // a domed face, quartered in two tones of the trim colour
  const prof = [v2(0.0, -0.017), v2(0.1, -0.016), v2(0.192, -0.012), v2(0.2, -0.004), v2(0.195, 0.004), v2(0.17, 0.012), v2(0.12, 0.022), v2(0.06, 0.03), v2(0.0, 0.032)];
  const quarter = (from: number) => ({ geo: new LatheGeometry(prof, 10, from, Math.PI / 2), rot: [Math.PI / 2, 0, 0] as V3 });
  b.part(merge([quarter(0), quarter(Math.PI)]), kit.toon(c.trim), s);
  b.part(merge([quarter(Math.PI / 2), quarter(Math.PI * 1.5)]), kit.toon(darken(c.trim, 0.55)), s);
  // iron strips along the quarter lines, following the dome
  const ridge = (r: number) => {
    for (let i = 1; i < prof.length; i++) {
      const p0 = prof[prof.length - i]!;
      const p1 = prof[prof.length - i - 1]!;
      if (r <= p1.x) return p0.y + ((p1.y - p0.y) * (r - p0.x)) / (p1.x - p0.x);
    }
    return 0;
  };
  const strip = (dx: number, dy: number) => {
    const pts: Vector3[] = [];
    for (let k = -8; k <= 8; k++) {
      const r = (Math.abs(k) / 8) * 0.188;
      const t = (k / 8) * 0.188;
      pts.push(v3(dx * t, dy * t, ridge(r) + 0.004));
    }
    return { geo: new TubeGeometry(new CatmullRomCurve3(pts), 24, 0.008, 5) };
  };
  b.part(merge([strip(1, 0), strip(0, 1)]), c.mMetal, s, { outline: false, hit: false });
  // rim, rivets round it, a ring round the boss, and the boss
  b.part(new TorusGeometry(0.2, 0.018, 6, 36), c.mMetal, s, { outline: false });
  const gold: Bit[] = [{ geo: new TorusGeometry(0.05, 0.007, 5, 20), pos: [0, 0, 0.028] }];
  for (let k = 0; k < 12; k++) {
    const a = (k / 12) * Math.PI * 2 + Math.PI / 12;
    gold.push({ geo: sphere(0.0095, 8, 6), pos: [Math.cos(a) * 0.2, Math.sin(a) * 0.2, 0.014] });
  }
  b.part(merge(gold), c.mGold, s, { outline: false, hit: false });
  b.part(sphere(0.045, 14, 10), c.mGold, s, { pos: [0, 0, 0.032], scale: [1, 1, 0.5] });
  // the arm strap behind it
  b.part(roundedBox(0.032, 0.12, 0.012, 0.005), c.mLeather, s, { pos: [0, 0, -0.024], outline: false, hit: false });
}

// ── on the back ──────────────────────────────────────────────────────────

function buildBack(c: Ctx, spine: Group): Rig["wings"] {
  switch (c.o.back) {
    case "quiver": quiver(c, spine); return null;
    case "backpack": backpack(c, spine); return null;
    case "wings": return [wing(c, spine, 1), wing(c, spine, -1)];
    default: return null;
  }
}

function quiver(c: Ctx, spine: Group) {
  const { b, kit, o } = c;
  const q = group(spine, -0.08, 0.15, -0.21, "quiver");
  q.rotation.set(-0.15, 0, -0.5);
  const rq = (y: number) => 0.06 + 0.01 * ((y + 0.21) / 0.42);
  b.part(new CylinderGeometry(0.07, 0.06, 0.42, 16), c.mLeather, q);
  b.part(new CylinderGeometry(0.065, 0.063, 0.05, 16), kit.toon(darken(c.leather, 0.62)), q, { pos: [0, -0.19, 0], outline: false });
  b.part(
    merge([
      { geo: new TorusGeometry(rq(0.05) + 0.001, 0.0085, 5, 24), pos: [0, 0.05, 0], rot: [Math.PI / 2, 0, 0] },
      { geo: new TorusGeometry(rq(-0.155) + 0.001, 0.0075, 5, 24), pos: [0, -0.155, 0], rot: [Math.PI / 2, 0, 0] },
    ]),
    c.mTrim,
    q,
    { outline: false, hit: false },
  );
  // a lumpy fur lip round the mouth
  const LR = 0.072;
  const lipGeo = bend(new TorusGeometry(LR, 0.021, 8, 28), (v) => {
    const u = Math.atan2(v.y, v.x);
    const cx = Math.cos(u) * LR;
    const cy = Math.sin(u) * LR;
    const k = 1 + 0.28 * (0.5 + 0.5 * Math.sin(11 * u));
    v.set(cx + (v.x - cx) * k, cy + (v.y - cy) * k, v.z * k);
  });
  b.part(lipGeo, kit.toon("#efe2c8"), q, { pos: [0, 0.205, 0], rot: [Math.PI / 2, 0, 0] });
  // stitching down the outside
  const stitches: Bit[] = [];
  for (let k = 0; k < 9; k++) {
    const y = -0.14 + k * 0.038;
    stitches.push({ geo: new BoxGeometry(0.0055, 0.018, 0.004), pos: [0, y, -(rq(y) + 0.0005)] });
  }
  b.part(merge(stitches), kit.toon(THREAD), q, { outline: false, hit: false });
  // five arrows, fletched, fanned a little
  const wood: Bit[] = [];
  const vanes: Bit[] = [];
  const cock: Bit[] = [];
  const ARROWS = [[0.0, 0.0, 0.34, 0.0, 0.0], [0.03, 0.018, 0.37, -0.12, 0.08], [-0.028, 0.02, 0.32, 0.1, 0.1], [0.012, -0.03, 0.355, -0.05, -0.12], [-0.02, -0.022, 0.33, 0.12, -0.08]] as const;
  ARROWS.forEach(([x, z, y1, rz, rx], i) => {
    const a = arrowBits(0.1, y1, false, i * 0.9);
    const t = { pos: [x, 0, z] as V3, rot: [rx, 0, rz] as V3 };
    wood.push({ geo: merge(a.shaft), ...t });
    vanes.push({ geo: merge(a.vanes), ...t });
    cock.push({ geo: merge(a.cock), ...t });
  });
  b.part(merge(wood), c.mWood, q, { outline: false, hit: false });
  b.part(merge(vanes), kit.toon(c.trim, { side: DoubleSide }), q, { outline: false, hit: false });
  b.part(merge(cock), kit.toon(CREAM, { side: DoubleSide }), q, { outline: false, hit: false });

  // the strap: from his left shoulder across the chest to the right hip, and
  // round the back, lying on the tunic at every height
  const path: Vector3[] = [];
  const ups: Vector3[] = [];
  const M = 64;
  for (let k = 0; k <= M; k++) {
    const th = (k / M) * Math.PI * 2;
    const y = 0.17 + 0.19 * Math.sin(th);
    const r = torsoR(y, o.style) + 0.013;
    path.push(v3(Math.sin(th) * r, y, Math.cos(th) * r));
    ups.push(v3(Math.sin(th), 0.8 * smooth(0.3, 0.36, y), Math.cos(th)).normalize());
  }
  const mStrap = kit.toon(darken(c.leather, 0.85), { side: DoubleSide });
  b.part(sweep(path, (i) => ups[i]!, strapProfile(0.044, 0.009)), mStrap, spine, { outline: false });
  // a buckle on the chest, and stitching along both edges
  const at = (k: number) => {
    const P = path[k]!;
    const T = path[Math.min(M, k + 1)]!.clone().sub(path[Math.max(0, k - 1)]!).normalize();
    const N = ups[k]!.clone().addScaledVector(T, -ups[k]!.dot(T)).normalize();
    return { P, T, N, S: new Vector3().crossVectors(T, N) };
  };
  const bk = at(Math.round(M * 0.07));
  b.part(placed(buckleGeo(0.032, 0.056, 0.0075), arr(bk.P.clone().addScaledVector(bk.N, 0.011)), basis(bk.T, bk.N)), c.mGold, spine, { outline: false, hit: false });
  const thread: Bit[] = [];
  for (let k = 1; k < M; k++) {
    if (k === Math.round(M * 0.07)) continue;
    const f = at(k);
    for (const side of [-1, 1]) thread.push({ geo: new BoxGeometry(0.016, 0.0045, 0.003), pos: arr(f.P.clone().addScaledVector(f.S, side * 0.016).addScaledVector(f.N, 0.0095)), quat: basis(f.T, f.N) });
  }
  b.part(merge(thread), kit.toon(THREAD), spine, { outline: false, hit: false });
}

function backpack(c: Ctx, spine: Group) {
  const { b, kit, o } = c;
  const p = group(spine, 0, 0.15, -0.23, "pack");
  const canvas = "#8a6a3c";
  const flap = "#6e532e";
  b.part(roundedBox(0.3, 0.32, 0.16, 0.04), kit.toon(canvas), p);
  // the lid, and a flap down the outside with a strap and buckle
  b.part(roundedBox(0.315, 0.1, 0.175, 0.035), kit.toon(flap), p, { pos: [0, 0.12, 0.002] });
  b.part(
    merge([
      { geo: roundedBox(0.12, 0.13, 0.014, 0.006), pos: [0, 0.075, -0.086] },
      { geo: roundedBox(0.03, 0.08, 0.008, 0.003), pos: [0, -0.02, -0.083] },
    ]),
    kit.toon(flap),
    p,
    { outline: false, hit: false },
  );
  // side pockets with their own flaps
  const pockets: Bit[] = [];
  for (const sx of [1, -1]) {
    pockets.push({ geo: roundedBox(0.05, 0.12, 0.1, 0.02), pos: [0.163 * sx, -0.04, 0] }, { geo: roundedBox(0.056, 0.035, 0.106, 0.012), pos: [0.165 * sx, 0.025, 0] });
  }
  b.part(merge(pockets), kit.toon(darken(canvas, 0.88)), p);
  const gold: Bit[] = [{ geo: buckleGeo(0.032, 0.03, 0.006), pos: [0, 0.018, -0.095], rot: [0, Math.PI, 0] }];
  for (const sx of [1, -1]) gold.push({ geo: sphere(0.008, 8, 6), pos: [0.191 * sx, 0.022, 0] });
  b.part(merge(gold), c.mGold, p, { outline: false, hit: false });
  // the bedroll on top, tied twice, its rolled ends spiralling
  b.part(new CylinderGeometry(0.06, 0.06, 0.34, 16), kit.toon(c.trim), p, { pos: [0, 0.22, -0.01], rot: [0, 0, Math.PI / 2] });
  b.part(
    merge([
      { geo: new TorusGeometry(0.063, 0.008, 5, 20), pos: [0.1, 0.22, -0.01], rot: [0, Math.PI / 2, 0] },
      { geo: new TorusGeometry(0.063, 0.008, 5, 20), pos: [-0.1, 0.22, -0.01], rot: [0, Math.PI / 2, 0] },
    ]),
    c.mLeather,
    p,
    { outline: false, hit: false },
  );
  const spiral = (sx: number) => {
    const pts: Vector3[] = [];
    for (let i = 0; i <= 30; i++) {
      const a = (i / 30) * Math.PI * 5;
      const r = 0.052 - (i / 30) * 0.042;
      pts.push(v3(0.1715 * sx, 0.22 + Math.cos(a) * r, -0.01 + Math.sin(a) * r));
    }
    return { geo: new TubeGeometry(new CatmullRomCurve3(pts), 60, 0.0035, 4) };
  };
  b.part(merge([spiral(1), spiral(-1)]), kit.toon(darken(c.trim, 0.6)), p, { outline: false, hit: false });

  // two shoulder straps: off the top of the pack, over each shoulder, down his
  // chest and back under the arm, snapped onto the torso at every point
  const straps: Bit[] = [];
  const sliders: Bit[] = [];
  for (const sx of [1, -1]) {
    const raw = [
      [0.12, 0.29, -0.16], [0.118, 0.345, -0.11], [0.116, 0.378, -0.045], [0.115, 0.388, 0.02], [0.116, 0.37, 0.085], [0.118, 0.33, 0.14],
      [0.12, 0.26, 0.17], [0.125, 0.18, 0.19], [0.15, 0.1, 0.165], [0.19, 0.05, 0.1], [0.21, 0.025, 0], [0.19, 0.01, -0.1], [0.13, 0.01, -0.16],
    ] as const;
    const pts = raw.map(([x, y, z]) => {
      const v = v3(x * sx, y, z);
      if (y < 0.355) {
        const rho = Math.hypot(v.x, v.z);
        const want = torsoR(y, o.style) + 0.013;
        v.x *= want / rho;
        v.z *= want / rho;
      }
      return v;
    });
    const curve = new CatmullRomCurve3(pts);
    const path = curve.getSpacedPoints(48);
    const up = (i: number) => {
      const q = path[i]!;
      return v3(q.x, 0, q.z).normalize().lerp(YP, smooth(0.33, 0.38, q.y)).normalize();
    };
    straps.push({ geo: sweep(path, up, strapProfile(0.045, 0.01)) });
    // a gold slider on the chest
    const k = 17;
    const T = path[k + 1]!.clone().sub(path[k - 1]!).normalize();
    const N = up(k).addScaledVector(T, -up(k).dot(T)).normalize();
    sliders.push({ geo: buckleGeo(0.028, 0.056, 0.0065), pos: arr(path[k]!.clone().addScaledVector(N, 0.012)), quat: basis(T, N) });
  }
  b.part(merge(straps), kit.toon(darken(c.leather, 0.9), { side: DoubleSide }), spine, { outline: false });
  b.part(merge(sliders), c.mGold, spine, { outline: false, hit: false });
}

/**
 * A WING: a curved leading edge with small covert feathers along it, and two
 * fans hanging from it — short secondaries near the body, long primaries at
 * the tip — each layer one inked mesh. `w.rotation.y` is what applyPose flaps.
 */
function wing(c: Ctx, spine: Group, sx: number): Group {
  const { b, kit } = c;
  const w = group(spine, 0.08 * sx, 0.24, -0.2, "wing");
  const arm = new CatmullRomCurve3([v3(0.02 * sx, 0, -0.03), v3(0.16 * sx, 0.12, -0.05), v3(0.32 * sx, 0.16, -0.07), v3(0.43 * sx, 0.1, -0.08)]);
  const feather = (t: number, len: number, phi: number, width: number, z: number): Bit => {
    const p = arm.getPointAt(t);
    const dir = v3(Math.sin(phi) * sx, -Math.cos(phi), 0);
    return { geo: sphere(1, 12, 8), pos: [p.x + dir.x * len * 0.45, p.y + dir.y * len * 0.45, p.z + z], rot: [0, 0, phi * sx], scale: [width, len / 2, 0.016] };
  };
  const primaries = [[0.62, 0.26, 0.35], [0.72, 0.29, 0.5], [0.82, 0.31, 0.65], [0.92, 0.3, 0.8], [1.0, 0.27, 0.95]].map(([t, l, phi]) => feather(t!, l!, phi!, 0.042, -0.012));
  const secondaries = [[0.12, 0.17, 0.0], [0.24, 0.2, 0.08], [0.36, 0.22, 0.16], [0.48, 0.24, 0.25], [0.56, 0.25, 0.3]].map(([t, l, phi]) => feather(t!, l!, phi!, 0.05, -0.004));
  const coverts: Bit[] = [{ geo: new TubeGeometry(arm, 24, 0.028, 8) }];
  for (let i = 0; i < 7; i++) coverts.push(feather(0.08 + i * 0.13, 0.1, 0.1 + i * 0.08, 0.045, 0.01));
  const tint = { emissive: "#9fc0ff", emissiveIntensity: 0.15 };
  b.part(merge(primaries), kit.toon("#ffffff", tint), w);
  b.part(merge(secondaries), kit.toon("#e9f0ff", tint), w);
  b.part(merge(coverts), kit.toon("#f6f8ff", tint), w);
  return w;
}

// ── cape ─────────────────────────────────────────────────────────────────

/**
 * THE CAPE. One plane, rippled by applyPose from its rest positions. Its edge
 * band is part of the SAME geometry — the outermost columns and the bottom row
 * sit in a second index group drawn with a second material — so it bends with
 * every ripple and needs nothing new in applyPose. The hem is cut in shallow
 * points. A rolled collar runs round his shoulders to two gold clasps joined by
 * a short chain.
 */
function buildCape(c: Ctx, spine: Group): Rig["cape"] {
  const { b, kit, o } = c;
  if (o.cape === "none") return null;
  const length = o.cape === "long" ? 0.82 : 0.44;
  const capeHex = o.cape === "long" ? darken(c.trim, 0.85) : new Color(c.trim);
  const bandHex = differs(c.trim, GOLD) ? new Color(GOLD) : differs(c.cloth, c.trim) ? darken(c.cloth, 0.9) : darken(c.trim, 0.55);
  const GX = 8;
  const GY = 14;
  const W = 0.5;
  const BAND = o.cape === "long" ? 0.05 : 0.04;
  const SIDE = 0.028;
  const DAG = 0.018;
  const geo = new PlaneGeometry(W, length, GX, GY);
  const pos = geo.getAttribute("position") as BufferAttribute;
  for (let iy = 0; iy <= GY; iy++) {
    for (let ix = 0; ix <= GX; ix++) {
      const i = iy * (GX + 1) + ix;
      // columns: narrow outermost ones for the side band, the rest even
      const x = ix === 0 ? -W / 2 : ix === GX ? W / 2 : -W / 2 + SIDE + ((ix - 1) / (GX - 2)) * (W - 2 * SIDE);
      // rows: even down to the band, then one band-deep row at the hem
      let y = iy < GY ? -(iy / (GY - 1)) * (length - BAND) : -length;
      if (iy >= GY - 1) y -= ix % 2 ? 0 : DAG;
      pos.setXYZ(i, x, y, 0);
    }
  }
  pos.needsUpdate = true;
  const index = geo.getIndex()!;
  const main: number[] = [];
  const band: number[] = [];
  for (let iy = 0; iy < GY; iy++) {
    for (let ix = 0; ix < GX; ix++) {
      const q = (iy * GX + ix) * 6;
      const dst = iy === GY - 1 || ix === 0 || ix === GX - 1 ? band : main;
      for (let k = 0; k < 6; k++) dst.push(index.getX(q + k));
    }
  }
  geo.setIndex([...main, ...band]);
  geo.clearGroups();
  geo.addGroup(0, main.length, 0);
  geo.addGroup(main.length, band.length, 1);
  geo.computeVertexNormals();
  const mCape = kit.toon(capeHex, { side: DoubleSide });
  const mesh = b.part(geo, mCape, spine, { pos: [0, 0.34, -0.2], outline: false });
  mesh.material = [mCape, kit.toon(bandHex, { side: DoubleSide })];
  mesh.rotation.x = 0.12;

  // the collar: rolled along the cape's top edge, over each shoulder, to the clasps
  const CY = 0.302;
  const ca = 0.62;
  const cr = torsoR(CY, o.style);
  const clasp = (sx: number) => v3(Math.sin(ca) * cr * sx, CY, Math.cos(ca) * cr);
  const half = [[0.12, 0.352, -0.205], [0.22, 0.358, -0.175], [0.255, 0.375, -0.09], [0.235, 0.39, 0.0], [0.19, 0.36, 0.09], [0.14, 0.322, 0.138]] as const;
  const COLLAR_R = 0.024;
  const collarPts = [
    clasp(-1).add(v3(0, 0.004, 0.006)),
    ...[...half].reverse().map(([x, y, z]) => overPauldron(v3(-x, y, z), o.style, COLLAR_R)),
    v3(0, 0.352, -0.208),
    ...half.map(([x, y, z]) => overPauldron(v3(x, y, z), o.style, COLLAR_R)),
    clasp(1).add(v3(0, 0.004, 0.006)),
  ];
  b.part(
    merge([
      { geo: new TubeGeometry(new CatmullRomCurve3(collarPts), 80, COLLAR_R, 8) },
      { geo: sphere(COLLAR_R, 10, 8), pos: arr(collarPts[0]!) },
      { geo: sphere(COLLAR_R, 10, 8), pos: arr(collarPts[collarPts.length - 1]!) },
    ]),
    kit.toon(darken(capeHex, 0.82)),
    spine,
    { hit: false },
  );
  // clasps (a rimmed disc each) joined by a little chain, with a gem in each.
  // Each sits on the FRONT of its collar end, not inside it: the end is a
  // ball of the collar's radius, and a disc any closer would swallow its gem.
  const gold: Bit[] = [];
  const gems: Bit[] = [];
  const disc = (sx: number) => clasp(sx).add(v3(0, 0.004, 0.006)).addScaledVector(v3(Math.sin(ca) * sx, 0, Math.cos(ca)), COLLAR_R + 0.002);
  for (const sx of [1, -1]) {
    const n = v3(Math.sin(ca) * sx, 0, Math.cos(ca));
    const p = disc(sx);
    gold.push({ geo: new CylinderGeometry(0.03, 0.03, 0.01, 18), pos: arr(p), quat: onto(n, 0, YP) }, { geo: new TorusGeometry(0.03, 0.006, 5, 18), pos: arr(p.clone().addScaledVector(n, 0.004)), quat: onto(n) });
    gems.push({ geo: new OctahedronGeometry(0.013), pos: arr(p.clone().addScaledVector(n, 0.008)), quat: onto(n), scale: [1, 1, 0.6] });
  }
  // the chain hangs from each disc's inner edge and lies on the chest between them
  const onChest = (x: number, y: number) => {
    const r = torsoR(y, o.style) + 0.014;
    return v3(x, y, Math.sqrt(Math.max(0, r * r - x * x)));
  };
  const chain = new CatmullRomCurve3([disc(1).add(v3(-0.024, -0.008, -0.004)), onChest(0.05, CY - 0.026), onChest(0, CY - 0.032), onChest(-0.05, CY - 0.026), disc(-1).add(v3(0.024, -0.008, -0.004))]);
  for (let k = 0; k < 7; k++) {
    const u = (k + 0.5) / 7;
    const t = chain.getTangentAt(u);
    const q = onto(t, 0, v3(1, 0, 0));
    if (k % 2) q.multiply(new Quaternion().setFromAxisAngle(v3(1, 0, 0), Math.PI / 2));
    gold.push({ geo: new TorusGeometry(0.0095, 0.0028, 4, 10), pos: arr(chain.getPointAt(u)), quat: q, scale: [1.3, 1, 1] });
  }
  b.part(merge(gold), c.mGold, spine, { outline: false, hit: false });
  b.part(merge(gems), gem(kit, "#d8344a", "#801020"), spine, { outline: false, hit: false });
  return { mesh, rest: Float32Array.from(pos.array as ArrayLike<number>), length };
}

// ── pets ─────────────────────────────────────────────────────────────────

function buildPet(c: Ctx, object: Group): Rig["pet"] {
  const { o } = c;
  if (o.pet === "none") return null;
  const g = group(object, 0.62, 0, 0.18, "pet");
  g.rotation.y = -0.5;
  const pb = group(g, 0, 0, 0, "petBody");
  const ph = group(pb, 0, 0, 0, "petHead");
  const tail = o.pet === "fox" ? fox(c, pb, ph) : o.pet === "owl" ? owl(c, pb, ph) : frog(c, pb, ph);
  return { group: g, body: pb, head: ph, tail, kind: o.pet };
}

function fox(c: Ctx, pb: Group, ph: Group): Object3D {
  const { b, kit } = c;
  const fur = kit.toon("#e0712a");
  const white = kit.toon("#fbf4ea");
  const socks = kit.toon("#2a1a14");
  b.part(sphere(0.12, 16, 12), fur, pb, { pos: [0, 0.12, 0], scale: [0.9, 0.85, 1.25] });
  // a white bib on the chest (laid on the body's front, not buried in it),
  // with a ruff of lumps under the chin
  b.part(
    merge([
      { geo: sphere(0.06, 12, 8), pos: [0, 0.125, 0.128], scale: [0.85, 1.05, 0.45] },
      { geo: sphere(0.03, 10, 8), pos: [0.032, 0.168, 0.13], scale: [1, 0.85, 0.8] },
      { geo: sphere(0.03, 10, 8), pos: [-0.032, 0.168, 0.13], scale: [1, 0.85, 0.8] },
      { geo: sphere(0.026, 10, 8), pos: [0, 0.178, 0.138], scale: [1, 0.85, 0.8] },
    ]),
    white,
    pb,
    { outline: false },
  );
  // legs, each in a black sock
  const legs: Bit[] = [];
  const sock: Bit[] = [];
  for (const [x, z] of [[0.06, 0.07], [-0.06, 0.07], [0.06, -0.07], [-0.06, -0.07]] as const) {
    legs.push({ geo: capsule(0.025, 0.04), pos: [x, 0.03, z] });
    sock.push({ geo: sphere(0.027, 10, 8), pos: [x, 0.012, z + 0.006], scale: [1, 0.7, 1.15] });
  }
  b.part(merge(legs), fur, pb);
  b.part(merge(sock), socks, pb, { outline: false });

  // head: a muzzle, cheek tufts, pointed ears with pale insides and dark tips
  ph.position.set(0, 0.24, 0.1);
  b.part(sphere(0.09, 16, 12), fur, ph, { scale: [1.05, 0.95, 1] });
  b.part(new ConeGeometry(0.05, 0.1, 12), fur, ph, { pos: [0, -0.02, 0.1], rot: [Math.PI / 2, 0, 0] });
  b.part(
    merge([
      { geo: sphere(0.038, 10, 8), pos: [0, -0.042, 0.088], scale: [1, 0.55, 1.3] },
      { geo: sphere(0.04, 10, 8), pos: [0.066, -0.036, 0.03], scale: [0.8, 0.7, 0.8] },
      { geo: sphere(0.04, 10, 8), pos: [-0.066, -0.036, 0.03], scale: [0.8, 0.7, 0.8] },
      { geo: new ConeGeometry(0.019, 0.042, 8), pos: [0.09, -0.048, 0.018], rot: [0, 0, Math.PI / 2 + 0.6], scale: [1, 1, 0.6] },
      { geo: new ConeGeometry(0.019, 0.042, 8), pos: [-0.09, -0.048, 0.018], rot: [0, 0, -Math.PI / 2 - 0.6], scale: [1, 1, 0.6] },
    ]),
    white,
    ph,
  );
  const ears: Bit[] = [];
  const inner: Bit[] = [];
  const tips: Bit[] = [];
  for (const sx of [1, -1]) {
    const rot: V3 = [-0.15, 0, -0.25 * sx];
    const tilt = new Euler(...rot);
    const along = (d: number) => arr(v3(0, d, 0).applyEuler(tilt).add(v3(0.05 * sx, 0.09, -0.01)));
    ears.push({ geo: new ConeGeometry(0.038, 0.085, 10), pos: [0.05 * sx, 0.09, -0.01], rot, scale: [1, 1, 0.55] });
    inner.push({ geo: new ConeGeometry(0.024, 0.06, 8), pos: along(-0.008).map((v, i) => (i === 2 ? v + 0.012 : v)) as V3, rot, scale: [1, 1, 0.4] });
    tips.push({ geo: new ConeGeometry(0.017, 0.032, 8), pos: along(0.028), rot, scale: [1, 1, 0.62] });
  }
  b.part(merge(ears), fur, ph);
  b.part(merge(inner), kit.toon("#fbefe0"), ph, { outline: false, hit: false });
  b.part(merge(tips), socks, ph, { outline: false, hit: false });
  // eyes, nose and whisker dots in ink; a catch-light in each eye
  const ink: Bit[] = [{ geo: sphere(0.016, 8, 6), pos: [0, -0.02, 0.15] }];
  const glint: Bit[] = [];
  for (const sx of [1, -1]) {
    ink.push({ geo: sphere(0.0165, 10, 8), pos: [0.04 * sx, 0.02, 0.076], scale: [0.85, 1.1, 0.6] });
    glint.push({ geo: sphere(0.0055, 6, 5), pos: [0.04 * sx + 0.005, 0.027, 0.085] });
    for (const [dy, dz] of [[-0.006, 0.112], [-0.016, 0.106], [0.004, 0.106]] as const) ink.push({ geo: sphere(0.0045, 5, 4), pos: [0.019 * sx, dy - 0.012, dz] });
  }
  b.part(merge(ink), c.mInk, ph, { outline: false });
  b.part(merge(glint), c.mWhite, ph, { outline: false, hit: false });

  // a big bushy tail curving up, with a white tip
  const tail = group(pb, 0, 0.14, -0.14, "tail");
  const TL = 0.85;
  const prof = [[0.001, 0], [0.025, 0.01], [0.05, 0.05], [0.07, 0.11], [0.076, 0.165], [0.064, 0.215], [0.038, 0.258], [0.001, 0.285]] as const;
  const curl = (v: Vector3) => {
    const t = v.y / 0.285;
    v.set(v.x, v.z + 0.13 * t * t, -v.y * TL);
  };
  b.part(bend(new LatheGeometry(prof.map(([r, y]) => v2(r, y)), 18), curl), fur, tail);
  const tipProf = [[0.0676 * 1.05, 0.2], [0.064 * 1.05, 0.215], [0.038 * 1.06, 0.258], [0.001, 0.287]] as const;
  b.part(bend(new LatheGeometry(tipProf.map(([r, y]) => v2(r, y)), 18), curl), white, tail);
  return tail;
}

function owl(c: Ctx, pb: Group, ph: Group): null {
  const { b, kit } = c;
  const f = kit.toon("#8a6a4a");
  const amber = "#e0a020";
  b.part(sphere(0.13, 16, 12), f, pb, { pos: [0, 0.14, 0], scale: [1, 1.15, 0.95] });
  b.part(sphere(0.09, 12, 10), kit.toon("#e9dcc4"), pb, { pos: [0, 0.1, 0.07], scale: [0.9, 1, 0.5], outline: false });
  // chevrons on the belly, sitting on its surface
  const marks: Bit[] = [];
  for (const [dx, dy] of [[0, 0.035], [-0.032, 0.012], [0.032, 0.012], [0, -0.012], [-0.03, -0.036], [0.03, -0.036]] as const) {
    const z = 0.07 + 0.045 * Math.sqrt(Math.max(0, 1 - (dx / 0.081) ** 2 - (dy / 0.09) ** 2)) + 0.001;
    for (const s of [-1, 1]) marks.push({ geo: capsule(0.0042, 0.012), pos: [dx + s * 0.006, 0.1 + dy, z], rot: [0, 0, s * 1.0] });
  }
  b.part(merge(marks), kit.toon("#7a5a3c"), pb, { outline: false, hit: false });
  // layered wings: coverts over darker primaries
  const coverts: Bit[] = [];
  const primaries: Bit[] = [];
  for (const sx of [1, -1]) {
    coverts.push({ geo: sphere(0.07, 12, 8), pos: [0.12 * sx, 0.145, -0.005], scale: [0.34, 0.92, 0.7], rot: [0, 0, 0.08 * sx] });
    primaries.push(
      { geo: sphere(0.06, 10, 8), pos: [0.124 * sx, 0.1, -0.022], scale: [0.3, 0.95, 0.62], rot: [0, 0, 0.2 * sx] },
      { geo: sphere(0.05, 10, 8), pos: [0.118 * sx, 0.06, -0.04], scale: [0.3, 0.95, 0.6], rot: [0, 0, 0.32 * sx] },
    );
  }
  b.part(merge(coverts), f, pb);
  b.part(merge(primaries), kit.toon("#5e4430"), pb);
  // talons gripping the ground
  const toes: Bit[] = [];
  for (const sx of [1, -1]) for (const a of [-0.45, 0, 0.45]) toes.push({ geo: capsule(0.0085, 0.022), pos: [0.04 * sx + Math.sin(a) * 0.016, 0.006, 0.07 + Math.cos(a) * 0.012], rot: [Math.PI / 2, 0, -a] });
  b.part(merge(toes), kit.toon(amber), pb, { outline: false, hit: false });

  // face: disc round each eye, eyes with pupils and catch-lights, tufts, beak
  ph.position.set(0, 0.25, 0.02);
  const discs: Bit[] = [];
  const rims: Bit[] = [];
  const whites: Bit[] = [];
  const irises: Bit[] = [];
  const pupils: Bit[] = [];
  const glints: Bit[] = [];
  const tufts: Bit[] = [];
  for (const sx of [1, -1]) {
    discs.push({ geo: sphere(0.058, 14, 10), pos: [0.045 * sx, 0, 0.07], scale: [1, 1, 0.35] });
    rims.push({ geo: new TorusGeometry(0.058, 0.0065, 5, 22), pos: [0.045 * sx, 0, 0.074] });
    whites.push({ geo: sphere(0.04, 12, 10), pos: [0.045 * sx, 0, 0.085] });
    irises.push({ geo: sphere(0.022, 10, 8), pos: [0.045 * sx, 0, 0.115] });
    pupils.push({ geo: sphere(0.012, 8, 6), pos: [0.045 * sx, 0, 0.13], scale: [1, 1, 0.5] });
    glints.push({ geo: sphere(0.0055, 6, 5), pos: [0.045 * sx + 0.007, 0.008, 0.135] });
    tufts.push(
      { geo: new ConeGeometry(0.026, 0.07, 8), pos: [0.07 * sx, 0.075, 0], rot: [0, 0, -0.4 * sx], scale: [1, 1, 0.6] },
      { geo: new ConeGeometry(0.018, 0.052, 8), pos: [0.085 * sx, 0.06, -0.012], rot: [0, 0, -0.75 * sx], scale: [1, 1, 0.6] },
    );
  }
  b.part(merge(discs), kit.toon("#d9c3a0"), ph, { outline: false });
  b.part(merge(rims), kit.toon("#5a402a"), ph, { outline: false, hit: false });
  b.part(merge(whites), c.mWhite, ph);
  b.part(merge(irises), kit.basic(amber), ph, { outline: false, hit: false });
  b.part(merge(pupils), c.mInk, ph, { outline: false, hit: false });
  b.part(merge(glints), c.mWhite, ph, { outline: false, hit: false });
  b.part(merge(tufts), f, ph);
  b.part(new ConeGeometry(0.018, 0.04, 4), kit.toon(amber), ph, { pos: [0, -0.04, 0.11], rot: [Math.PI / 2 + 0.6, 0, 0], outline: false });
  return null;
}

function frog(c: Ctx, pb: Group, ph: Group): null {
  const { b, kit } = c;
  const green = "#5bb04a";
  const f = kit.toon(green);
  const pale = kit.toon(new Color(green).lerp(new Color("#f3efb5"), 0.4), { side: DoubleSide });
  b.part(sphere(0.12, 16, 12), f, pb, { pos: [0, 0.09, 0], scale: [1.15, 0.75, 1] });
  const belly = new Color(green).lerp(new Color("#f3efb5"), 0.55);
  b.part(sphere(0.085, 14, 10), kit.toon(belly), pb, { pos: [0, 0.06, 0.06], scale: [1.1, 0.6, 0.7], outline: false });
  // darker spots across the back, lying on its curve
  const spots: Bit[] = [];
  for (const [th, y, r] of [[2.6, 0.15, 0.022], [-2.4, 0.14, 0.018], [3.1, 0.12, 0.016], [1.9, 0.13, 0.017], [-1.8, 0.12, 0.02], [2.9, 0.17, 0.014], [-2.85, 0.165, 0.015]] as const) {
    const c2 = Math.sqrt(Math.max(0, 1 - ((y - 0.09) / 0.09) ** 2));
    const p = v3(Math.sin(th) * 0.138 * c2, y, Math.cos(th) * 0.12 * c2);
    const n = v3(p.x / (0.138 * 0.138), (p.y - 0.09) / (0.09 * 0.09), p.z / (0.12 * 0.12)).normalize();
    spots.push({ geo: sphere(r, 8, 6), pos: arr(p), quat: onto(n), scale: [1, 1, 0.3] });
  }
  b.part(merge(spots), kit.toon(darken(green, 0.62)), pb, { outline: false, hit: false });
  // haunches, and webbed feet: three toes each with a pale web between
  b.part(
    merge([
      { geo: sphere(0.05, 10, 8), pos: [0.1, 0.02, -0.03], scale: [1, 0.5, 1.4] },
      { geo: sphere(0.05, 10, 8), pos: [-0.1, 0.02, -0.03], scale: [1, 0.5, 1.4] },
    ]),
    f,
    pb,
  );
  const toes: Bit[] = [];
  const webs: Bit[] = [];
  for (const [fx, fz, size, aim] of [[0.13, 0.01, 1, 0.9], [-0.13, 0.01, 1, -0.9], [0.07, 0.1, 0.75, 0.35], [-0.07, 0.1, 0.75, -0.35]] as const) {
    const L = 0.034 * size;
    for (const spread of [-0.5, 0, 0.5]) {
      const a = aim + spread;
      toes.push(
        { geo: capsule(0.0075 * size, L), pos: [fx + Math.sin(a) * L * 0.5, 0.008, fz + Math.cos(a) * L * 0.5], rot: [Math.PI / 2, 0, -a] },
        { geo: sphere(0.0105 * size, 8, 6), pos: [fx + Math.sin(a) * L, 0.008, fz + Math.cos(a) * L] },
      );
    }
    webs.push({ geo: new CircleGeometry(L * 0.95, 6, aim - Math.PI / 2 - 0.55, 1.1), pos: [fx, 0.005, fz], rot: [-Math.PI / 2, 0, 0] });
  }
  b.part(merge(toes), f, pb, { outline: false });
  b.part(merge(webs), pale, pb, { outline: false, hit: false });

  // the head: a wide flat blob carrying the eyes and the smile, so they turn together
  ph.position.set(0, 0.13, 0.05);
  b.part(sphere(0.1, 16, 12), f, ph, { scale: [1.2, 0.7, 1] });
  const bulges: Bit[] = [];
  const whites: Bit[] = [];
  const glints: Bit[] = [];
  const ink: Bit[] = [];
  for (const sx of [1, -1]) {
    bulges.push({ geo: sphere(0.045, 12, 10), pos: [0.06 * sx, 0.048, 0.02] });
    whites.push({ geo: sphere(0.032, 12, 10), pos: [0.06 * sx, 0.058, 0.046] });
    ink.push({ geo: sphere(0.016, 10, 8), pos: [0.06 * sx, 0.058, 0.074], scale: [1.4, 0.75, 0.6] });
    glints.push({ geo: sphere(0.006, 6, 5), pos: [0.06 * sx + 0.009, 0.067, 0.079] });
    ink.push({ geo: sphere(0.0058, 6, 5), pos: [0.018 * sx, 0.012, 0.0985] });
  }
  // a wide smile wrapped round the front of the head, corners up
  const smile: Vector3[] = [];
  for (let k = 0; k <= 16; k++) {
    const a = -1.0 + (2 * k) / 16;
    const ym = -0.02 + 0.014 * a * a;
    const cc = Math.sqrt(Math.max(0, 1 - (ym / 0.07) ** 2));
    smile.push(v3(Math.sin(a) * 0.12 * cc * 1.02, ym, Math.cos(a) * 0.1 * cc * 1.02));
  }
  ink.push({ geo: new TubeGeometry(new CatmullRomCurve3(smile), 32, 0.0045, 4) });
  b.part(merge(bulges), f, ph);
  b.part(merge(whites), c.mWhite, ph);
  b.part(merge(ink), c.mInk, ph, { outline: false, hit: false });
  b.part(merge(glints), c.mWhite, ph, { outline: false, hit: false });
  return null;
}
