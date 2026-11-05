/**
 * THE ISLAND HE STANDS ON.
 *
 * A storybook floating island, built the way the merryman is: primitives
 * only, toon-shaded, ink on the big forms and none on the trim, so the two read
 * as one hand-made toy at 400 pixels and as a green lozenge under his boots at
 * 160.
 *
 * - The grass is y = 0 everywhere he can stand. Nothing grows within CLEAR of
 *   the origin (his feet and the blob shadow) or on the pet's spot, so every
 *   framing, the shadow and the pet fit exactly as before.
 * - Every scatter (blades, pebbles, daisies, spots) comes from a seeded
 *   sequence: the same island on every load and in every screenshot.
 * - Small repeated things are InstancedMeshes, one draw call per kind; props
 *   are merged into one geometry per material. Instanced sets never get ink:
 *   the kit's outline shader ignores instance matrices.
 * - The `full` framing sees the island from the front and a little above: the
 *   top, the front lip and the two flanks down to about y = -0.4. Roots, vines,
 *   pebbles and coins crowd the flanks for that reason; the rocky underside is
 *   there so the island is whole from any angle.
 */
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Euler,
  ExtrudeGeometry,
  Group,
  IcosahedronGeometry,
  InstancedMesh,
  LatheGeometry,
  Matrix4,
  Mesh,
  Quaternion,
  Shape,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
  type Material,
  type Object3D,
} from "three";
import { rngOf } from "./outfit";
import type { Kit } from "./rig";

export type Island = {
  /** Add this to the scene. Centred on the origin; the grass top is y = 0. */
  group: Group;
  /** Meshes added, outline children excluded (an InstancedMesh counts once). */
  meshes: number;
  /** Optional, allocation-free: drifts the loose floating rocks. */
  update(t: number): void;
  dispose(): void;
};

const TAU = Math.PI * 2;
const UP = new Vector3(0, 1, 0);
const AX = new Vector3(1, 0, 0);
const AZ = new Vector3(0, 0, 1);
/** Roughly toward the camera in every framing: in front and a little above. */
const VIEW = new Vector3(0, 0.25, 1).normalize();

type P3 = [number, number, number];
/** [radius, height] pairs, top to bottom. */
type Profile = readonly (readonly [number, number])[];
type Inst = { m: Matrix4; c?: Color };

const v3 = (x = 0, y = 0, z = 0) => new Vector3(x, y, z);
const col = (c: string | Color) => (c instanceof Color ? c.clone() : new Color(c));
const darken = (c: string | Color, f: number) => col(c).multiplyScalar(f);
const lighten = (c: string | Color, f: number) => col(c).lerp(new Color("#ffffff"), f);
/** Lighter without going pastel: lifts lightness and a touch of saturation, keeps the hue. */
const brighten = (c: string | Color, l: number) => col(c).offsetHSL(0, l * 0.4, l);

// ── the shape of the island ──────────────────────────────────────────────

const DISC_R = 0.975;
/**
 * The soft grass roll around the rim: a squashed torus whose crown sits just
 * under the grass, so the top flows over the edge instead of ending in a ridge
 * (a raised crown draws an ink line across the front of the island).
 */
const LIP = { r: 0.975, tube: 0.07, y: -0.0605, sy: 0.85 };
const SOIL: Profile = [[0.94, -0.03], [0.958, -0.1], [0.953, -0.165], [0.936, -0.222], [0.906, -0.256], [0.87, -0.27]];
const CLAY: Profile = [[0.918, -0.19], [0.913, -0.255], [0.9, -0.305], [0.873, -0.365], [0.826, -0.425], [0.762, -0.476], [0.69, -0.503]];
const ROCK: Profile = [[0.775, -0.43], [0.73, -0.515], [0.61, -0.635], [0.47, -0.765], [0.31, -0.895], [0.165, -1.005], [0.055, -1.085], [0.003, -1.12]];

/** His feet and the blob shadow (which also drifts a little with rootX). */
const CLEAR = 0.42;
/** Where the pet stands (rig.ts), and how much room it needs. */
const PET: P3 = [0.62, 0.18, 0.17];

/** The rim is not a circle. Every ring of the island shares this wobble, so the layers stay nested. */
function wob(a: number): number {
  return 1 + 0.022 * Math.sin(3 * a + 0.7) + 0.016 * Math.sin(5 * a + 2.1) + 0.01 * Math.sin(8 * a + 0.4);
}
/** How far the topsoil sags into the clay at angle a: a wavy stratum line, not a ruled one. */
function wave(a: number): number {
  return Math.max(0, 0.018 + 0.014 * Math.sin(4 * a + 1.3) + 0.009 * Math.sin(9 * a + 0.2));
}
const soilK = (y: number) => Math.min(1, Math.max(0, (-0.205 - y) / 0.045));

function rAt(p: Profile, y: number): number {
  if (y >= p[0]![1]) return p[0]![0];
  for (let i = 1; i < p.length; i++) {
    const [r0, y0] = p[i - 1]!;
    const [r1, y1] = p[i]!;
    if (y >= y1) return r0 + (r1 - r0) * ((y - y0) / (y1 - y0));
  }
  return p[p.length - 1]![0];
}
const top = (p: Profile) => p[0]![1];
const bottom = (p: Profile) => p[p.length - 1]![1];

/** Radius of the outermost earth at height y and angle a — what a root or a pebble sits on. */
function sideR(y: number, a: number): number {
  const w = wave(a);
  let y0 = y;
  for (let i = 0; i < 3; i++) y0 = y + w * soilK(y0);
  const soil = y0 <= top(SOIL) && y0 >= bottom(SOIL) ? rAt(SOIL, y0) : 0;
  const clay = y <= top(CLAY) && y >= bottom(CLAY) ? rAt(CLAY, y) : 0;
  const rock = y <= top(ROCK) ? rAt(ROCK, y) : 0;
  return Math.max(soil, clay, rock) * wob(a);
}

/** Height of the grass at normalised radius rn (radius ÷ wob): flat, then the lip's roll. */
function groundY(rn: number): number {
  const d = rn - LIP.r;
  const lip = Math.abs(d) < LIP.tube ? LIP.y + LIP.sy * Math.sqrt(LIP.tube * LIP.tube - d * d) : -1;
  return Math.max(rn <= DISC_R ? 0 : -1, lip);
}

/** A point at angle a on the wobbled ring of normalised radius rn. */
const ring = (a: number, rn: number, y: number) => {
  const r = rn * wob(a);
  return v3(Math.cos(a) * r, y, Math.sin(a) * r);
};

/** A stable hash in [0, 1) for jitter on a grid. */
function hash(a: number, b: number): number {
  let h = Math.imul((a + 0x9e3779b9) | 0, 0x85ebca6b) ^ Math.imul((b + 0x632be5ab) | 0, 0xc2b2ae35);
  h ^= h >>> 15;
  h = Math.imul(h, 0x2c1b3c6d);
  h ^= h >>> 12;
  h = Math.imul(h, 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

// ── geometry helpers (build time only) ───────────────────────────────────

function lathe(p: Profile, segments: number): LatheGeometry {
  // LatheGeometry faces outward when its profile runs bottom to top.
  return new LatheGeometry(p.slice().reverse().map(([r, y]) => new Vector2(r, y)), segments);
}

function wobbled<T extends BufferGeometry>(geo: T): T {
  const p = geo.getAttribute("position");
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const z = p.getZ(i);
    const f = wob(Math.atan2(z, x));
    p.setXYZ(i, x * f, p.getY(i), z * f);
  }
  p.needsUpdate = true;
  return geo;
}

/**
 * Area-weighted normals shared by every vertex at the same position, so lathe
 * and torus seams vanish and a faceted rock's ink hull stays closed.
 */
function smoothNormals<T extends BufferGeometry>(geo: T): T {
  const p = geo.getAttribute("position");
  const index = geo.index;
  const keys: string[] = [];
  const acc = new Map<string, Vector3>();
  for (let i = 0; i < p.count; i++) {
    const k = `${Math.round(p.getX(i) * 1e4)}|${Math.round(p.getY(i) * 1e4)}|${Math.round(p.getZ(i) * 1e4)}`;
    keys.push(k);
    if (!acc.has(k)) acc.set(k, new Vector3());
  }
  const a = new Vector3();
  const b = new Vector3();
  const c = new Vector3();
  const tris = (index ? index.count : p.count) / 3;
  for (let t = 0; t < tris; t++) {
    const i0 = index ? index.getX(t * 3) : t * 3;
    const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
    const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
    a.fromBufferAttribute(p, i0);
    b.fromBufferAttribute(p, i1).sub(a);
    c.fromBufferAttribute(p, i2).sub(a);
    b.cross(c);
    acc.get(keys[i0]!)!.add(b);
    acc.get(keys[i1]!)!.add(b);
    acc.get(keys[i2]!)!.add(b);
  }
  const normals = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const n = acc.get(keys[i]!)!;
    const l = n.length() || 1;
    normals[i * 3] = n.x / l;
    normals[i * 3 + 1] = n.y / l;
    normals[i * 3 + 2] = n.z / l;
  }
  geo.setAttribute("normal", new BufferAttribute(normals, 3));
  return geo;
}

/** Flat-shaded copy: one normal per face, for chiselled rock. */
function facet(geo: BufferGeometry): BufferGeometry {
  const flat = geo.index ? geo.toNonIndexed() : geo;
  if (flat !== geo) geo.dispose();
  flat.computeVertexNormals();
  return flat;
}

/** The ink hull for a faceted mesh: same positions, smooth normals, so the line never cracks at an edge. */
function inkHull(geo: BufferGeometry): BufferGeometry {
  const hull = new BufferGeometry();
  const p = geo.getAttribute("position");
  const pos = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    pos[i * 3] = p.getX(i);
    pos[i * 3 + 1] = p.getY(i);
    pos[i * 3 + 2] = p.getZ(i);
  }
  hull.setAttribute("position", new BufferAttribute(pos, 3));
  if (geo.index) hull.setIndex(geo.index.clone());
  return smoothNormals(hull);
}

/** One geometry from many (positions and normals only); the parts are disposed. */
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
  let v = 0;
  let k = 0;
  for (const g of parts) {
    const p = g.getAttribute("position");
    const n = g.getAttribute("normal");
    for (let i = 0; i < p.count; i++) {
      const o = (v + i) * 3;
      pos[o] = p.getX(i);
      pos[o + 1] = p.getY(i);
      pos[o + 2] = p.getZ(i);
      nor[o] = n ? n.getX(i) : 0;
      nor[o + 1] = n ? n.getY(i) : 1;
      nor[o + 2] = n ? n.getZ(i) : 0;
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) idx[k++] = g.index.getX(i) + v;
    else for (let i = 0; i < p.count; i++) idx[k++] = v + i;
    v += p.count;
    g.dispose();
  }
  const out = new BufferGeometry();
  out.setAttribute("position", new BufferAttribute(pos, 3));
  out.setAttribute("normal", new BufferAttribute(nor, 3));
  out.setIndex(new BufferAttribute(idx, 1));
  return out;
}

/**
 * Faceted parts (non-indexed) sorted into material groups by a per-triangle
 * tone, so one mesh carries two or three stone shades.
 */
function toned(parts: { geo: BufferGeometry; tone: (tri: number) => number }[], tones: number): BufferGeometry {
  const pb: number[][] = Array.from({ length: tones }, () => []);
  const nb: number[][] = Array.from({ length: tones }, () => []);
  for (const { geo, tone } of parts) {
    const p = geo.getAttribute("position");
    const n = geo.getAttribute("normal");
    for (let t = 0; t < p.count / 3; t++) {
      const k = Math.min(tones - 1, Math.max(0, tone(t)));
      for (let i = t * 3; i < t * 3 + 3; i++) {
        pb[k]!.push(p.getX(i), p.getY(i), p.getZ(i));
        nb[k]!.push(n.getX(i), n.getY(i), n.getZ(i));
      }
    }
    geo.dispose();
  }
  const out = new BufferGeometry();
  out.setAttribute("position", new BufferAttribute(Float32Array.from(pb.flat()), 3));
  out.setAttribute("normal", new BufferAttribute(Float32Array.from(nb.flat()), 3));
  let start = 0;
  pb.forEach((list, k) => {
    const count = list.length / 3;
    if (count) out.addGroup(start, count, k);
    start += count;
  });
  return out;
}

function mat(pos: P3 | Vector3, rot: P3 = [0, 0, 0], scale: P3 | number = 1, order: "XYZ" | "YXZ" = "XYZ"): Matrix4 {
  const p = pos instanceof Vector3 ? pos : v3(...pos);
  const s = typeof scale === "number" ? v3(scale, scale, scale) : v3(...scale);
  return new Matrix4().compose(p, new Quaternion().setFromEuler(new Euler(rot[0], rot[1], rot[2], order)), s);
}

/** A matrix whose local y runs along `dir` and local z leans toward `up`, scaled per axis. */
function basis(pos: Vector3, dir: Vector3, up: Vector3, sx: number, sy: number, sz: number): Matrix4 {
  const y = dir.clone().normalize();
  const x = new Vector3().crossVectors(y, up);
  if (x.lengthSq() < 1e-8) x.crossVectors(y, Math.abs(y.x) < 0.9 ? AX : AZ);
  x.normalize();
  const z = new Vector3().crossVectors(x, y);
  return new Matrix4().makeBasis(x.multiplyScalar(sx), y.multiplyScalar(sy), z.multiplyScalar(sz)).setPosition(pos);
}

/** A cylinder from a to b, radius r0 at a and r1 at b. */
function rod(a: Vector3, b: Vector3, r0: number, r1 = r0, seg = 6): BufferGeometry {
  const d = new Vector3().subVectors(b, a);
  const g = new CylinderGeometry(r1, r0, d.length(), seg, 1);
  const q = new Quaternion().setFromUnitVectors(UP, d.clone().normalize());
  return g.applyMatrix4(new Matrix4().compose(a.clone().addScaledVector(d, 0.5), q, v3(1, 1, 1)));
}

/** A tube along a smooth curve through pts, tapering from r0 to r1. */
function vine(pts: Vector3[], r0: number, r1: number, seg = 16, radial = 5): { geo: BufferGeometry; curve: CatmullRomCurve3 } {
  const curve = new CatmullRomCurve3(pts);
  const geo = new TubeGeometry(curve, seg, 1, radial, false);
  const p = geo.getAttribute("position");
  const c = new Vector3();
  for (let i = 0; i <= seg; i++) {
    curve.getPointAt(i / seg, c);
    const r = r0 + (r1 - r0) * (i / seg);
    for (let j = 0; j <= radial; j++) {
      const k = i * (radial + 1) + j;
      p.setXYZ(k, c.x + (p.getX(k) - c.x) * r, c.y + (p.getY(k) - c.y) * r, c.z + (p.getZ(k) - c.z) * r);
    }
  }
  return { geo, curve };
}

// ── the builder: tracks every geometry, inks only what asks for it ───────

function islandBuilder(kit: Kit) {
  const geos: BufferGeometry[] = [];
  const insts: InstancedMesh[] = [];
  const noRay = () => {};
  let meshes = 0;
  return {
    geos,
    insts,
    count: () => meshes,
    /** A mesh; inked unless outline is false, or inked with a supplied hull. Never tappable. */
    part(geo: BufferGeometry, mat: Material | Material[], parent: Object3D, opts: { outline?: boolean | BufferGeometry } = {}): Mesh {
      geos.push(geo);
      const m = new Mesh(geo, mat);
      m.raycast = noRay;
      parent.add(m);
      meshes++;
      if (opts.outline !== false) {
        const hull = opts.outline instanceof BufferGeometry ? opts.outline : geo;
        if (hull !== geo) geos.push(hull);
        const o = new Mesh(hull, kit.outline);
        o.raycast = noRay;
        m.add(o);
      }
      return m;
    },
    /** One draw call for a whole scatter. Colours ride on the instances. */
    inst(geo: BufferGeometry, mat: Material, parent: Object3D, items: Inst[]): InstancedMesh | null {
      geos.push(geo);
      if (!items.length) return null;
      const im = new InstancedMesh(geo, mat, items.length);
      items.forEach((it, i) => {
        im.setMatrixAt(i, it.m);
        if (it.c) im.setColorAt(i, it.c);
      });
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      im.computeBoundingSphere();
      im.raycast = noRay;
      parent.add(im);
      insts.push(im);
      meshes++;
      return im;
    },
  };
}

// ── where the props stand (x, z), and the grass they keep for themselves ─

const TARGET = { x: -0.56, z: -0.44, yaw: 0.42 };
const STUMP = { x: 0.68, z: -0.5, yaw: 0.3 };
const SIGN = { x: 0.84, z: -0.2 };
const SAPLING = { x: -0.86, z: -0.1 };
/** The quiver leaning on the easel: its foot, in island space. */
const QUIVER = { x: -0.33, z: -0.49 };
const BUSH = { x: -0.72, z: 0.4 };

type Shroom = { x: number; z: number; s: number; red: boolean; yaw: number; lean: number; spots: number };
const SHROOMS: Shroom[] = [
  { x: -0.5, z: 0.62, s: 1, red: true, yaw: 0.4, lean: 0.12, spots: 9 },
  { x: -0.36, z: 0.71, s: 0.62, red: true, yaw: 2.1, lean: -0.18, spots: 6 },
  { x: -0.6, z: 0.52, s: 0.45, red: true, yaw: 4, lean: 0.22, spots: 4 },
  { x: 0.5, z: -0.7, s: 0.78, red: false, yaw: 1.3, lean: 0.1, spots: 6 },
  { x: 0.46, z: -0.32, s: 0.5, red: false, yaw: 3.3, lean: -0.16, spots: 4 },
];

/** x, z, stem height, petal colour, petal count. */
const FLOWERS: [number, number, number, string, number][] = [
  [0.3, 0.73, 0.07, "#fbf7ee", 6], [0.4, 0.66, 0.088, "#ff8fb8", 5], [0.25, 0.63, 0.056, "#ffd34a", 5],
  [-0.6, 0.1, 0.082, "#b99cff", 5], [-0.54, 0.02, 0.06, "#fbf7ee", 6], [-0.66, 0, 0.07, "#7cc8ff", 5],
  [-0.32, -0.72, 0.088, "#ff8fb8", 5], [-0.24, -0.68, 0.066, "#ffd34a", 5],
  [0.9, 0, 0.076, "#ff7a59", 5], [0.86, 0.08, 0.058, "#fbf7ee", 6],
];

const FERNS: [number, number, number][] = [[-0.86, 0.16, 0.6], [0.66, 0.56, 2.2]]; // x, z, phase
const STONES: [number, number, number, number, number][] = [[0.12, 0.58, 0.075, 0.056, 0.3], [-0.06, 0.73, 0.078, 0.06, 1.1], [0.1, 0.88, 0.066, 0.05, 2]];

/** Footprints on the grass (x, z, r): blades and scatter stay out of them. */
const KEEP: P3[] = [
  [0, 0, CLEAR], PET,
  [TARGET.x, TARGET.z, 0.2], [QUIVER.x, QUIVER.z, 0.06], [STUMP.x, STUMP.z, 0.2], [SIGN.x, SIGN.z, 0.06], [SAPLING.x, SAPLING.z, 0.05], [BUSH.x, BUSH.z, 0.17],
  ...SHROOMS.map((m): P3 => [m.x, m.z, 0.075 * m.s + 0.01]),
  ...FERNS.map(([x, z]): P3 => [x, z, 0.08]),
  ...FLOWERS.map(([x, z]): P3 => [x, z, 0.035]),
  ...STONES.map(([x, z, sx]): P3 => [x, z, sx + 0.01]),
];
const free = (x: number, z: number, pad = 0) => KEEP.every(([kx, kz, r]) => (x - kx) ** 2 + (z - kz) ** 2 >= (r + pad) ** 2);

// ── the island ───────────────────────────────────────────────────────────

export function buildIsland(kit: Kit): Island {
  const b = islandBuilder(kit);
  const group = new Group();
  group.name = "island";

  // palette: a few bases, every shade derived from them
  const grass = "#4a9a4b";
  const stone = "#6c6058";
  const bark = "#7a4b2a";
  const heart = "#e2bf88";
  const wood = "#8a5a2e";
  const plank = "#c99a5b";
  const straw = "#dcb66c";
  const red = "#d9433a";
  const cream = "#f4eee0";
  const leafGreen = "#4fa650";
  const foliage = "#3f8a44";
  const stemHex = "#f2ead8";

  const mGrass = kit.toon(grass);
  const mLip = kit.toon(brighten(grass, 0.05));
  const mSoil = kit.toon("#5a3922");
  const mClay = kit.toon("#80603f");
  const mStone = [kit.toon(stone), kit.toon(darken(stone, 0.78)), kit.toon(lighten(stone, 0.2))];
  const mTint = kit.toon("#ffffff"); // instanced sets carry their own colours
  const mGold = kit.toon("#e3b341", { emissive: "#6b4a10", emissiveIntensity: 0.35 });
  const GREENS = [darken(grass, 0.78), col(grass), brighten(grass, 0.05), brighten(grass, 0.1)];
  const PEBBLES = ["#8e8a85", "#a8a29a", "#75706b", "#bdb5a8", "#9a8f84"].map(col);
  const AUTUMN = ["#e8892f", "#d9a02a", "#c4552b"].map(col);

  // collections: instanced scatters, and one merged geometry per material
  const drips: Inst[] = [];
  const blades: Inst[] = [];
  const patches: Inst[] = [];
  const leaves: Inst[] = [];
  const beads: Inst[] = [];
  const pebbles: Inst[] = [];
  const stems: BufferGeometry[] = [];
  const roots: BufferGeometry[] = [];
  const barkParts: BufferGeometry[] = [];
  const foliageDark: BufferGeometry[] = [];
  const foliageLight: BufferGeometry[] = [];
  const shafts: BufferGeometry[] = [];
  const fletch: BufferGeometry[] = [];
  const fletchLight: BufferGeometry[] = [];
  const shroomStems: BufferGeometry[] = [];
  const gills: BufferGeometry[] = [];
  const capsRed: BufferGeometry[] = [];
  const capsYellow: BufferGeometry[] = [];
  const coins: BufferGeometry[] = [];

  const bead = (pos: Vector3, r: number | P3, c: string | Color) => beads.push({ m: mat(pos, [0, 0, 0], r), c: col(c) });
  /** A pointed leaf from its base along dir, its face turned toward `face`. */
  const leaf = (pos: Vector3, dir: Vector3, face: Vector3, len: number, c: string | Color, wf = 1) =>
    leaves.push({ m: basis(pos, dir, face, len * wf, len, len), c: col(c) });

  // ── grass top and lip ──
  b.part(wobbled(new CylinderGeometry(DISC_R, DISC_R, 0.05, 64, 1).translate(0, -0.025, 0)), mGrass, group, { outline: false });
  const lip = new TorusGeometry(LIP.r, LIP.tube, 12, 96).rotateX(Math.PI / 2).scale(1, LIP.sy, 1).translate(0, LIP.y, 0);
  b.part(smoothNormals(wobbled(lip)), mLip, group);
  // a fringe of turf hanging over the edge: overlapping tongues, so the
  // underside of the lip scallops instead of dotting
  {
    const rd = rngOf("island:drips");
    const N = 40;
    for (let k = 0; k < N; k++) {
      if (rd() < 0.07) continue;
      const a = (k / N) * TAU + (rd() - 0.5) * 0.08;
      const w = 0.06 + rd() * 0.03;
      const h = 0.024 + rd() * rd() * 0.04;
      drips.push({ m: mat(ring(a, 0.998, -0.094 - h * 0.45), [0, Math.PI / 2 - a, 0], [w, h, 0.034]) });
    }
  }

  // ── strata ──
  {
    const soil = lathe(SOIL, 64);
    const p = soil.getAttribute("position");
    for (let i = 0; i < p.count; i++) p.setY(i, p.getY(i) - wave(Math.atan2(p.getZ(i), p.getX(i))) * soilK(p.getY(i)));
    b.part(smoothNormals(wobbled(soil)), mSoil, group);
    b.part(smoothNormals(wobbled(lathe(CLAY, 64))), mClay, group);
  }

  // ── rocky underside: faceted, three tones, a few chunks pushing out ──
  {
    const SEG = 9;
    const n = ROCK.length;
    const cone = lathe(ROCK, SEG);
    const p = cone.getAttribute("position");
    for (let v = 0; v < p.count; v++) {
      const i = Math.floor(v / n) % SEG;
      const j = v % n; // 0 is the tip, n - 1 the hidden top ring
      const jr = 1 + (hash(i, j) - 0.5) * 0.1;
      const jy = j === n - 1 ? 0 : (hash(i + 31, j) - 0.5) * 0.03;
      p.setXYZ(v, p.getX(v) * jr, p.getY(v) + jy, p.getZ(v) * jr);
    }
    const quads = n - 1;
    const parts: { geo: BufferGeometry; tone: (t: number) => number }[] = [
      {
        geo: facet(wobbled(cone)),
        tone: (t) => {
          const q = t >> 1;
          const h = hash(Math.floor(q / quads) + 50, q % quads);
          return h < 0.56 ? 0 : h < 0.8 ? 1 : 2;
        },
      },
    ];
    const CHUNKS: [number, number, number, number][] = [[0.25, -0.6, 0.11, 1], [1.35, -0.7, 0.09, 2], [2.75, -0.58, 0.1, 1], [4.3, -0.66, 0.12, 2], [0.9, -0.86, 0.07, 0], [5.4, -0.8, 0.08, 1]];
    CHUNKS.forEach(([a, y, s, tone], k) => {
      const r = sideR(y, a) - s * 0.25;
      const g = new IcosahedronGeometry(1, 0).applyMatrix4(mat([Math.cos(a) * r, y, Math.sin(a) * r], [hash(k, 1) * 3, hash(k, 2) * 3, hash(k, 3) * 3], [s * 1.25, s * 0.8, s]));
      parts.push({ geo: facet(g), tone: () => tone });
    });
    const rock = toned(parts, 3);
    b.part(rock, mStone, group, { outline: inkHull(rock) });
  }

  // ── roots on the flanks, and a few hanging free under the stone ──
  {
    const ROOTS: [number, number, number][] = [[0.22, -0.37, 0.06], [0.62, -0.3, -0.05], [1.2, -0.33, 0.05], [1.95, -0.3, -0.06], [2.55, -0.39, 0.05], [2.95, -0.32, -0.07], [3.6, -0.34, 0.05], [5.4, -0.33, -0.05]];
    ROOTS.forEach(([a0, y1, drift], k) => {
      const pts: Vector3[] = [];
      for (let i = 0; i <= 7; i++) {
        const t = i / 7;
        const y = -0.105 + (y1 + 0.105) * t;
        const a = a0 + drift * Math.sin(t * 3.2);
        const r = sideR(y, a) + 0.004;
        pts.push(v3(Math.cos(a) * r, y, Math.sin(a) * r));
      }
      roots.push(vine(pts, 0.013, 0.003, 28, 5).geo);
      // a side root that forks off and fades into the earth
      const t0 = 0.35 + hash(k, 9) * 0.2;
      const yb = -0.105 + (y1 + 0.105) * t0;
      const ab = a0 + drift * Math.sin(t0 * 3.2);
      const dir = k % 2 ? 1 : -1;
      const branch: Vector3[] = [];
      for (let i = 0; i <= 3; i++) {
        const y = yb - i * 0.024;
        const a = ab + dir * i * 0.03;
        const r = sideR(y, a) + 0.003;
        branch.push(v3(Math.cos(a) * r, y, Math.sin(a) * r));
      }
      roots.push(vine(branch, 0.008, 0.002, 10, 4).geo);
    });
    for (const [a, len] of [[0.55, 0.2], [2.45, 0.16], [1.6, 0.24]] as const) {
      const r = sideR(-0.56, a) - 0.01;
      const pts = [0, 1, 2, 3, 4].map((i) => {
        const sway = Math.sin(i * 1.3 + a) * 0.015;
        return v3(Math.cos(a) * (r + i * 0.01) - Math.sin(a) * sway, -0.54 - (len * i) / 4, Math.sin(a) * (r + i * 0.01) + Math.cos(a) * sway);
      });
      roots.push(vine(pts, 0.009, 0.002, 14, 4).geo);
    }
  }

  // ── vines hanging from under the lip, leafing as they go ──
  {
    const VINES: [number, number][] = [[0.06, 0.3], [0.4, 0.22], [1.57, 0.18], [2.74, 0.25], [3.1, 0.33], [4, 0.2]];
    VINES.forEach(([a0, len], k) => {
      const pts: Vector3[] = [];
      for (let i = 0; i <= 6; i++) {
        const t = i / 6;
        const a = a0 + 0.035 * Math.sin(t * 4 + a0 * 3);
        const rn = 0.99 + 0.03 * Math.sin(t * Math.PI) - (i === 6 ? 0.014 : 0);
        pts.push(ring(a, rn, -0.095 - len * t + (i === 6 ? 0.02 : 0)));
      }
      const { geo, curve } = vine(pts, 0.0068, 0.0035, 24, 5);
      stems.push(geo);
      const radial = v3(Math.cos(a0), 0, Math.sin(a0));
      const tangent = v3(-Math.sin(a0), 0, Math.cos(a0));
      const face = radial.clone().multiplyScalar(0.6).add(VIEW).normalize();
      for (let i = 0, t = 0.16; t < 0.95; t += 0.13, i++) {
        const side = i % 2 ? 1 : -1;
        const dir = radial.clone().multiplyScalar(0.45).addScaledVector(tangent, side * 0.8).add(v3(0, -0.4, 0));
        leaf(curve.getPointAt(t), dir, face, 0.032 + hash(k, i) * 0.012, i % 3 ? leafGreen : brighten(leafGreen, 0.07), 0.85);
      }
    });
  }

  // ── stones in the earth: a band of pebbles in the clay, grit in the topsoil ──
  {
    const rp = rngOf("island:pebbles");
    const pebble = (pos: Vector3, s: number, squash: number, c: Color) =>
      pebbles.push({ m: mat(pos, [rp() * TAU, rp() * TAU, rp() * TAU], [s * (0.9 + rp() * 0.5), s * squash, s * (0.8 + rp() * 0.4)]), c });
    for (let k = 0; k < 36; k++) {
      const lane = k % 4; // right flank, left flank, front, anywhere
      const a = lane === 0 ? 0.2 + (rp() - 0.5) * 1.2 : lane === 1 ? Math.PI - 0.2 + (rp() - 0.5) * 1.2 : lane === 2 ? Math.PI / 2 + (rp() - 0.5) * 1.6 : rp() * TAU;
      const y = -0.275 - rp() * 0.19;
      const s = 0.014 + rp() * rp() * 0.042;
      const r = sideR(y, a) - s * 0.3;
      pebble(v3(Math.cos(a) * r, y, Math.sin(a) * r), s, 0.6 + rp() * 0.3, PEBBLES[Math.floor(rp() * PEBBLES.length)]!);
    }
    for (let k = 0; k < 10; k++) {
      const a = k % 2 ? 0.25 + (rp() - 0.5) * 1.3 : Math.PI - 0.25 + (rp() - 0.5) * 1.3;
      const y = -0.13 - rp() * 0.08;
      const s = 0.009 + rp() * 0.011;
      const r = sideR(y, a) - s * 0.35;
      pebble(v3(Math.cos(a) * r, y, Math.sin(a) * r), s, 0.7, lighten(PEBBLES[k % PEBBLES.length]!, 0.15));
    }
    // a few on the grass
    for (let k = 0, tries = 0; k < 10 && tries < 300; tries++) {
      const a = rp() * TAU;
      const rr = 0.48 + rp() * 0.42;
      const x = Math.cos(a) * rr;
      const z = Math.sin(a) * rr;
      if (!free(x, z, 0.02)) continue;
      const s = 0.011 + rp() * 0.016;
      pebble(v3(x, s * 0.22, z), s, 0.5, PEBBLES[k % PEBBLES.length]!);
      k++;
    }
    // buried treasure: two gold coins half out of the clay, one on each flank
    for (const [a, y, tilt] of [[0.3, -0.335, 0.5], [2.86, -0.36, -0.6]] as const) {
      const radial = v3(Math.cos(a), 0, Math.sin(a));
      const tangent = v3(-Math.sin(a), 0, Math.cos(a));
      const n = tangent.clone().multiplyScalar(0.85).add(v3(0, tilt, 0)).addScaledVector(radial, 0.25).normalize();
      const r = sideR(y, a) - 0.008;
      const c = new CylinderGeometry(0.034, 0.034, 0.008, 18).applyMatrix4(
        new Matrix4().compose(v3(Math.cos(a) * r, y, Math.sin(a) * r), new Quaternion().setFromUnitVectors(UP, n), v3(1, 1, 1)),
      );
      coins.push(c);
    }
  }

  // ── the archery target, back left, with two arrows in it ──
  const arrowAt = (frame: Matrix4, hit: Vector3, dirIn: Vector3, len: number, vanes = fletch) => {
    const d = dirIn.clone().normalize();
    shafts.push(rod(hit.clone().addScaledVector(d, -0.03), hit.clone().addScaledVector(d, len), 0.0065).applyMatrix4(frame));
    const q = new Quaternion().setFromUnitVectors(UP, d);
    for (const spin of [0, Math.PI / 2]) {
      const vane = new BoxGeometry(0.036, 0.055, 0.0025).rotateY(spin);
      vanes.push(vane.applyMatrix4(new Matrix4().compose(hit.clone().addScaledVector(d, len - 0.04), q, v3(1, 1, 1))).applyMatrix4(frame));
    }
    bead(hit.clone().addScaledVector(d, len + 0.002).applyMatrix4(frame), 0.008, cream);
  };
  const baseTufts: [number, number][] = [];
  {
    const T = mat([TARGET.x, 0, TARGET.z], [0, TARGET.yaw, 0]);
    const F = T.clone().multiply(mat([0, 0.3, 0], [-0.2, 0, 0]));
    b.part(new CylinderGeometry(0.17, 0.17, 0.06, 36, 1).rotateX(Math.PI / 2).applyMatrix4(F), kit.toon(straw), group);
    b.part(merge([0.019, -0.019].map((z) => new TorusGeometry(0.171, 0.008, 5, 44).translate(0, 0, z))).applyMatrix4(F), kit.toon(darken(straw, 0.68)), group, { outline: false });
    ([[0.152, red], [0.114, cream], [0.076, red]] as const).forEach(([r, c], k) =>
      b.part(new CircleGeometry(r, 40).translate(0, 0, 0.0305 + k * 0.0016).applyMatrix4(F), kit.toon(c), group, { outline: false }));
    b.part(new CircleGeometry(0.036, 28).translate(0, 0, 0.0305 + 3 * 0.0016).applyMatrix4(F), mGold, group, { outline: false });
    const legs = merge([
      rod(v3(0.13, -0.01, 0.03), v3(0.095, 0.5, -0.115), 0.014, 0.012),
      rod(v3(-0.13, -0.01, 0.03), v3(-0.095, 0.5, -0.115), 0.014, 0.012),
      rod(v3(0, 0.47, -0.1), v3(0, -0.01, -0.2), 0.012, 0.014),
      rod(v3(-0.13, 0.112, 0.028), v3(0.13, 0.112, 0.028), 0.011),
    ]).applyMatrix4(T);
    b.part(legs, kit.toon(wood), group);
    arrowAt(F, v3(0.035, 0.03, 0.031), v3(0.12, 0.05, 1), 0.24);
    arrowAt(F, v3(-0.075, -0.05, 0.031), v3(-0.22, 0.1, 1), 0.21);
    for (const foot of [v3(0.21, 0, -0.01), v3(-0.15, 0, 0.06), v3(0.02, 0, -0.22)]) {
      foot.applyMatrix4(T);
      baseTufts.push([foot.x, foot.z]);
    }
    // a quiver of spare arrows leaning on the outside of the easel's right leg
    // (easel space: the leg passes (0.116, 0.2, -0.03); the quiver's mouth rests
    // just right of it, clear of the painted face so its arrows read)
    const base = v3(QUIVER.x, 0, QUIVER.z).applyMatrix4(T.clone().invert());
    const axis = v3(0.175, 0.2, -0.03).sub(base).normalize();
    const Q = T.clone().multiply(new Matrix4().compose(base, new Quaternion().setFromUnitVectors(UP, axis), v3(1, 1, 1)));
    b.part(smoothNormals(lathe([[0.047, 0.215], [0.045, 0.16], [0.041, 0.06], [0.037, 0]], 16).applyMatrix4(Q)), kit.toon("#8a4f2a"), group);
    const bands = merge(([[0.2, 0.047], [0.035, 0.039]] as const).map(([y, r]) => new TorusGeometry(r, 0.0065, 5, 24).rotateX(Math.PI / 2).translate(0, y, 0)));
    b.part(bands.applyMatrix4(Q), kit.toon("#5e3218"), group, { outline: false });
    for (const [x, z, dx, dz, len] of [[0.012, 0.006, 0.22, 0.06, 0.13], [-0.01, 0.012, 0.05, 0.12, 0.12], [0.004, -0.012, 0.14, -0.08, 0.15], [-0.014, -0.006, -0.06, 0.02, 0.11]] as const) {
      arrowAt(Q, v3(x, 0.17, z), v3(dx, 1, dz), len, fletchLight);
    }
  }

  // ── the stump, back right: ringed top, bark ridges, roots, a sprout, an arrow ──
  {
    const S = mat([STUMP.x, 0, STUMP.z], [0, STUMP.yaw, 0]);
    const RAD = 14;
    const body = new CylinderGeometry(0.118, 0.142, 0.15, RAD, 2, true);
    const p = body.getAttribute("position");
    for (let i = 0; i < p.count; i++) if ((i % (RAD + 1)) % 2 === 1) p.setXYZ(i, p.getX(i) * 0.88, p.getY(i), p.getZ(i) * 0.88);
    barkParts.push(smoothNormals(body.translate(0, 0.075, 0)).applyMatrix4(S));
    for (let k = 0; k < 5; k++) {
      const flare = new ConeGeometry(0.042, 0.14, 7, 1)
        .scale(1, 0.8 + hash(k, 4) * 0.5, 1)
        .rotateZ(-Math.PI / 2 - 0.42)
        .translate(0.12, 0.028, 0)
        .rotateY((k / 5) * TAU + 0.4 + (hash(k, 3) - 0.5) * 0.5);
      barkParts.push(flare.applyMatrix4(S));
    }
    b.part(new CircleGeometry(0.112, 24).rotateX(-Math.PI / 2).translate(0, 0.1505, 0).applyMatrix4(S), kit.toon(heart), group, { outline: false });
    const rings = merge([
      ...[0.086, 0.058, 0.031].map((r) => new TorusGeometry(r, 0.0032, 3, 36).rotateX(Math.PI / 2).scale(1, 0.4, 1).translate(0.008, 0.151, 0.005)),
      new BoxGeometry(0.05, 0.002, 0.004).translate(0.075, 0.1515, 0).rotateY(2.4),
    ]).applyMatrix4(S);
    b.part(rings, kit.toon(darken(heart, 0.72)), group, { outline: false });
    // bracket fungus on the bark, facing the viewer
    for (const [psi, y, s] of [[1.65, 0.068, 1], [2.05, 0.102, 0.75]] as const) {
      capsYellow.push(new SphereGeometry(1, 12, 6, 0, TAU, 0, Math.PI / 2).applyMatrix4(mat([Math.cos(psi) * 0.118, y, Math.sin(psi) * 0.118], [0, -psi, 0], [0.05 * s, 0.019 * s, 0.056 * s])).applyMatrix4(S));
    }
    // a sprout
    const sprout = [v3(0.04, 0.148, -0.03), v3(0.046, 0.19, -0.03), v3(0.036, 0.235, -0.02)].map((v) => v.applyMatrix4(S));
    stems.push(vine(sprout, 0.006, 0.004, 8, 4).geo);
    const tip = sprout[2]!;
    leaf(tip, v3(0.8, 0.7, 0.2), VIEW, 0.045, brighten(leafGreen, 0.08), 0.9);
    leaf(tip, v3(-0.8, 0.6, 0.1), VIEW, 0.04, leafGreen, 0.9);
    leaf(sprout[1]!, v3(-0.6, 0.3, 0.5), VIEW, 0.026, leafGreen, 0.9);
    // an arrow that hit the stump instead
    arrowAt(new Matrix4(), v3(-0.035, 0.15, 0.04).applyMatrix4(S), v3(-0.65, 0.62, 0.45), 0.2);
    for (const a of [2.6, 3.7, 1.2]) baseTufts.push([STUMP.x + Math.cos(a) * 0.19, STUMP.z + Math.sin(a) * 0.19]);
  }

  // ── signpost, right edge ──
  {
    const G = mat([SIGN.x, 0, SIGN.z], [0.05, -0.35, 0], 1, "YXZ");
    const post = merge([
      new BoxGeometry(0.034, 0.47, 0.034).translate(0, 0.225, 0),
      new ConeGeometry(0.03, 0.045, 4).rotateY(Math.PI / 4).translate(0, 0.482, 0),
    ]).applyMatrix4(G);
    b.part(post, kit.toon(bark), group);
    const board = (dir: 1 | -1) => {
      const s = new Shape();
      const pts: [number, number][] = [[-0.035, -0.034], [0.15, -0.034], [0.195, 0], [0.15, 0.034], [-0.035, 0.034]];
      pts.forEach(([x, y], i) => (i ? s.lineTo(x * dir, y) : s.moveTo(x * dir, y)));
      s.closePath();
      return new ExtrudeGeometry(s, { depth: 0.014, bevelEnabled: false }).translate(0, 0, -0.007);
    };
    const boards: BufferGeometry[] = [];
    const scribbles: BufferGeometry[] = [];
    for (const [dir, B] of [[1, mat([0, 0.385, 0.025], [0, 0.12, 0.04])], [-1, mat([0, 0.29, 0.025], [0, -0.2, -0.06])]] as const) {
      const W = G.clone().multiply(B);
      boards.push(board(dir).applyMatrix4(W));
      scribbles.push(new BoxGeometry(0.085, 0.0055, 0.003).translate(0.075 * dir, 0.009, 0.0085).applyMatrix4(W));
      scribbles.push(new BoxGeometry(0.058, 0.0055, 0.003).translate(0.06 * dir, -0.009, 0.0085).applyMatrix4(W));
      bead(v3(-0.014 * dir, 0, 0.009).applyMatrix4(W), 0.0055, "#3a3436");
    }
    b.part(merge(boards), kit.toon(plank), group);
    b.part(merge(scribbles), kit.toon(darken(plank, 0.42)), group, { outline: false });
    baseTufts.push([SIGN.x - 0.05, SIGN.z + 0.03], [SIGN.x + 0.04, SIGN.z - 0.04]);
  }

  // ── a sapling at the left edge, and a berry bush in front of it ──
  {
    const at = (x: number, y: number, z: number) => v3(SAPLING.x + x, y, SAPLING.z + z);
    barkParts.push(vine([at(0, -0.01, 0), at(0.008, 0.1, 0.004), at(-0.006, 0.2, 0), at(0.002, 0.3, 0)], 0.017, 0.01, 12, 7).geo);
    barkParts.push(vine([at(0, 0.17, 0), at(0.035, 0.21, 0.01), at(0.065, 0.25, 0.02)], 0.008, 0.005, 8, 5).geo);
    const crowns: [number, number, number, number, boolean][] = [
      [0, 0.35, 0, 0.09, false], [-0.065, 0.31, 0.025, 0.062, false], [-0.02, 0.41, -0.03, 0.052, false],
      [0.045, 0.39, 0.045, 0.062, true], [0.07, 0.27, 0.03, 0.05, true],
    ];
    for (const [x, y, z, r, light] of crowns) (light ? foliageLight : foliageDark).push(new SphereGeometry(r, 14, 10).translate(SAPLING.x + x, y, SAPLING.z + z));
    for (const [ci, ax, ay] of [[0, 0.5, -0.4], [1, -0.4, -0.2], [3, 0.3, -0.5]] as const) {
      const [x, y, z, r] = crowns[ci]!;
      const n = v3(ax, ay, 0.8).normalize();
      bead(at(x, y, z).addScaledVector(n, r * 0.98), 0.017, "#e0473a");
    }
    for (let k = 0; k < 7; k++) {
      const [x, y, z, r] = crowns[k % crowns.length]!;
      const n = v3(Math.cos(k * 2.4), 0.4 + hash(k, 7) * 0.5, Math.sin(k * 2.4) * 0.6 + 0.5).normalize();
      leaf(at(x, y, z).addScaledVector(n, r * 0.9), n.clone().add(v3(0, 0.3, 0)), VIEW, 0.04, k % 2 ? foliage : brighten(foliage, 0.08), 0.85);
    }
    baseTufts.push([SAPLING.x + 0.04, SAPLING.z + 0.04], [SAPLING.x - 0.03, SAPLING.z - 0.04]);

    const bush: [number, number, number, number, boolean][] = [
      [0, 0.1, -0.02, 0.12, false], [0.11, 0.075, 0, 0.085, false], [-0.1, 0.07, 0.03, 0.09, false],
      [0.02, 0.17, 0.05, 0.075, true], [0.08, 0.12, 0.08, 0.06, true], [-0.06, 0.13, 0.09, 0.06, true],
    ];
    const bAt = (x: number, y: number, z: number) => v3(BUSH.x + x, y, BUSH.z + z);
    for (const [x, y, z, r, light] of bush) (light ? foliageLight : foliageDark).push(new SphereGeometry(r, 14, 10).translate(BUSH.x + x, y, BUSH.z + z));
    for (let k = 0; k < 9; k++) {
      const [x, y, z, r] = bush[(k * 4) % bush.length]!;
      const n = v3(Math.cos(k * 2.1 + 0.5) * 0.8, 0.35 + hash(k, 11) * 0.5, 0.6 + Math.sin(k * 2.1 + 0.5) * 0.4).normalize();
      bead(bAt(x, y, z).addScaledVector(n, r * 0.97), 0.013 + hash(k, 12) * 0.004, k % 3 ? "#e0473a" : "#b8234a");
    }
    for (let k = 0; k < 10; k++) {
      const [x, y, z, r] = bush[(k * 5 + 1) % bush.length]!;
      const n = v3(Math.cos(k * 2.6), 0.3 + hash(k, 13) * 0.6, Math.sin(k * 2.6) * 0.7 + 0.3).normalize();
      leaf(bAt(x, y, z).addScaledVector(n, r * 0.9), n.clone().add(v3(0, 0.25, 0)), VIEW, 0.042, k % 2 ? foliage : brighten(foliage, 0.08), 0.85);
    }
    baseTufts.push([BUSH.x + 0.16, BUSH.z + 0.06], [BUSH.x - 0.05, BUSH.z + 0.15]);
  }

  // ── mushrooms: bulging stems, gills under the cap, spots on top ──
  {
    const stemGeo = () => lathe([[0.001, 0.09], [0.026, 0.088], [0.025, 0.065], [0.029, 0.035], [0.036, 0.012], [0.034, 0], [0.001, 0]], 12);
    for (const m of SHROOMS) {
      const M = mat([m.x, 0, m.z], [0, m.yaw, m.lean], m.s, "YXZ");
      shroomStems.push(stemGeo().applyMatrix4(M));
      (m.red ? capsRed : capsYellow).push(new SphereGeometry(0.08, 20, 9, 0, TAU, 0, Math.PI / 2).scale(1, 0.68, 1).translate(0, 0.082, 0).applyMatrix4(M));
      gills.push(facet(new ConeGeometry(0.076, 0.03, 20, 1, true).rotateX(Math.PI).translate(0, 0.068, 0)).applyMatrix4(M));
      for (let k = 0; k < m.spots; k++) {
        const phi = 0.22 + 1.08 * Math.sqrt((k + 0.5) / m.spots);
        const th = k * 2.39996 + m.yaw;
        const pos = v3(0.08 * Math.sin(phi) * Math.cos(th), 0.082 + 0.68 * 0.08 * Math.cos(phi), 0.08 * Math.sin(phi) * Math.sin(th));
        const n = v3(Math.sin(phi) * Math.cos(th), Math.cos(phi) / 0.68, Math.sin(phi) * Math.sin(th)).normalize();
        const w = 0.011 + hash(k, m.spots) * 0.007;
        beads.push({ m: M.clone().multiply(basis(pos.addScaledVector(n, 0.0012), n, AX, w, 0.0035, w)), c: col(m.red ? "#fbfaf7" : "#fff4cf") });
      }
      baseTufts.push([m.x + 0.06 * m.s + 0.02, m.z + 0.03]);
    }
  }

  // ── ferns: arching fronds of paired leaflets ──
  {
    const rf = rngOf("island:ferns");
    for (const [cx, cz, phase] of FERNS) {
      for (let k = 0; k < 5; k++) {
        const beta = phase + (k / 5) * TAU + (rf() - 0.5) * 0.5;
        const len = 0.16 * (0.8 + rf() * 0.3);
        const lift = 0.85 + rf() * 0.4;
        const d = v3(Math.cos(beta), 0, Math.sin(beta));
        const P = (s: number, h: number) => v3(cx, 0, cz).addScaledVector(d, len * s).setY(len * h * lift);
        const { geo, curve } = vine([P(0, 0), P(0.2, 0.38), P(0.5, 0.58), P(0.8, 0.5), P(1, 0.3), P(1.08, 0.16)], 0.0055, 0.0018, 16, 4);
        stems.push(geo);
        const shade = k % 2 ? leafGreen : brighten(leafGreen, 0.06);
        for (let j = 0; j < 9; j++) {
          const t = 0.16 + j * 0.1;
          const pt = curve.getPointAt(t);
          const tan = curve.getTangentAt(t);
          const side = new Vector3().crossVectors(tan, UP).normalize();
          const size = len * (0.3 - 0.22 * t);
          for (const s of [1, -1]) leaf(pt, side.clone().multiplyScalar(s * 0.85).addScaledVector(tan, 0.55).add(v3(0, -0.08, 0)), UP, size, shade, 0.7);
        }
      }
    }
  }

  // ── flowers: petals round a centre, a pair of leaves at the foot ──
  {
    const rfl = rngOf("island:flowers");
    for (const [x, z, h, petal, n] of FLOWERS) {
      const yaw = rfl() * TAU;
      const lean = 0.12 + rfl() * 0.2;
      const tilt = v3(Math.cos(yaw) * lean, 1, Math.sin(yaw) * lean).normalize();
      const base = v3(x, -0.004, z);
      const head = base.clone().addScaledVector(tilt, h);
      const mid = base.clone().addScaledVector(tilt, h * 0.5).add(v3(-Math.sin(yaw) * 0.007, 0, Math.cos(yaw) * 0.007));
      stems.push(vine([base, mid, head], 0.0042, 0.003, 8, 4).geo);
      const face = tilt.clone().lerp(VIEW, 0.45).normalize();
      const u = new Vector3().crossVectors(face, Math.abs(face.y) > 0.95 ? AX : UP).normalize();
      const w = new Vector3().crossVectors(face, u);
      const centre = petal === "#ffd34a" ? "#8a5a2e" : "#ffcf3a";
      beads.push({ m: basis(head.clone().addScaledVector(face, 0.004), face, u, 0.0105, 0.0065, 0.0105), c: col(centre) });
      for (let k = 0; k < n; k++) {
        const ang = (k / n) * TAU + yaw;
        const radial = u.clone().multiplyScalar(Math.cos(ang)).addScaledVector(w, Math.sin(ang)).addScaledVector(face, 0.3).normalize();
        beads.push({ m: basis(head.clone().addScaledVector(radial, 0.016), radial, face, 0.0085, 0.014, 0.0032), c: col(petal) });
      }
      for (const s of [1, -1]) leaf(v3(x, 0.004, z), v3(Math.cos(yaw + s * 1.4), 0.45, Math.sin(yaw + s * 1.4)), UP, 0.034, leafGreen, 0.75);
    }
  }

  // ── stepping stones to the front edge ──
  {
    const stones = STONES.map(([x, z, sx, sz, yaw], k) => {
      const g = new CylinderGeometry(1, 1.08, 1, 11, 1);
      const p = g.getAttribute("position");
      for (let i = 0; i < p.count; i++) {
        const x0 = p.getX(i);
        const z0 = p.getZ(i);
        const r = Math.hypot(x0, z0);
        if (r < 1e-6) {
          if (p.getY(i) > 0) p.setY(i, 0.8); // a gently domed top
          continue;
        }
        const f = 0.86 + hash(k, Math.round(((Math.atan2(z0, x0) + TAU) % TAU) / (TAU / 11)) % 11) * 0.24;
        p.setXYZ(i, x0 * f, p.getY(i), z0 * f);
      }
      return smoothNormals(g).applyMatrix4(mat([x, 0.006, z], [0, yaw, 0], [sx, 0.036, sz]));
    });
    b.part(merge(stones), kit.toon("#a49d92"), group);
  }

  // ── grass: tufts across the top, a fringe along the rim, patches, daisies, fallen leaves ──
  {
    const rg = rngOf("island:grass");
    const pick = () => GREENS[Math.floor(rg() * GREENS.length)]!;
    const qa = new Quaternion();
    const qb = new Quaternion();
    const axis = new Vector3();
    const blade = (x: number, y: number, z: number, lean: number, tilt: number, h: number, w: number) => {
      qa.setFromAxisAngle(UP, rg() * TAU);
      axis.set(Math.sin(lean), 0, -Math.cos(lean));
      qb.setFromAxisAngle(axis, tilt);
      blades.push({ m: new Matrix4().compose(v3(x, y, z), qb.multiply(qa), v3(w, h, w)), c: pick() });
    };
    const tufts: [number, number][] = [];
    for (let tries = 0; tufts.length < 40 && tries < 1200; tries++) {
      const a = rg() * TAU;
      const rr = 0.44 + Math.sqrt(rg()) * 0.46;
      const x = Math.cos(a) * rr;
      const z = Math.sin(a) * rr;
      if (!free(x, z, 0.02) || tufts.some(([tx, tz]) => (tx - x) ** 2 + (tz - z) ** 2 < 0.105 ** 2)) continue;
      tufts.push([x, z]);
    }
    for (const [x, z] of [...tufts, ...baseTufts]) {
      const n = 3 + Math.floor(rg() * 3);
      const spin = rg() * TAU;
      for (let j = 0; j < n; j++) {
        const dir = spin + (j / n) * TAU + (rg() - 0.5) * 0.6;
        const centre = j === 0;
        blade(x + Math.cos(dir) * 0.007, -0.004, z + Math.sin(dir) * 0.007, dir, centre ? rg() * 0.12 : 0.22 + rg() * 0.38, (centre ? 0.095 : 0.06) + rg() * 0.05, 0.012 + rg() * 0.007);
      }
    }
    for (let k = 0; k < 64; k++) {
      if (rg() < 0.22) continue;
      const a = (k / 64) * TAU + (rg() - 0.5) * 0.06;
      const n = 1 + Math.floor(rg() * 3);
      for (let j = 0; j < n; j++) {
        const aj = a + (j - 1) * 0.022;
        const rn = 0.94 + rg() * 0.05;
        const p = ring(aj, rn, groundY(rn) - 0.004);
        blade(p.x, p.y, p.z, aj + (rg() - 0.5) * 0.7, 0.3 + rg() * 0.55, 0.05 + rg() * 0.06, 0.012 + rg() * 0.006);
      }
    }
    // short blades on the face of the lip, drooping outward, so the rounded
    // edge reads as turf rather than a smooth roll
    for (let k = 0; k < 96; k++) {
      if (rg() < 0.25) continue;
      const a = (k / 96) * TAU + (rg() - 0.5) * 0.05;
      const d = 0.02 + rg() * 0.04;
      const p = ring(a, LIP.r + d, LIP.y + LIP.sy * Math.sqrt(LIP.tube * LIP.tube - d * d) - 0.006);
      blade(p.x, p.y, p.z, a + (rg() - 0.5) * 0.8, 0.95 + rg() * 0.5, 0.035 + rg() * 0.03, 0.011 + rg() * 0.005);
    }
    // darker and sunlit patches, all clear of his shadow
    const PATCHES: [number, number, number, number, number, boolean][] = [
      [-0.62, -0.2, 0.15, 0.1, 0.4, false], [0.3, -0.66, 0.14, 0.09, 1.2, false], [-0.3, 0.68, 0.12, 0.08, 2, true],
      [0.78, 0.06, 0.12, 0.08, 0.3, false], [0.02, -0.76, 0.13, 0.08, 0.9, true], [-0.46, 0.46, 0.1, 0.07, 2.6, false], [0.5, 0.42, 0.1, 0.07, 1.7, true],
      [-0.16, -0.62, 0.1, 0.065, 0.5, false], [0.6, -0.16, 0.09, 0.06, 1, true], [-0.8, 0.26, 0.09, 0.06, 0.2, false],
    ];
    for (const [x, z, rx, rz, yaw, light] of PATCHES) patches.push({ m: mat([x, 0.003, z], [0, yaw, 0], [rx, 1, rz]), c: light ? brighten(grass, 0.045) : darken(grass, 0.72) });
    // daisies sitting in the grass
    for (let k = 0, tries = 0; k < 16 && tries < 400; tries++) {
      const a = rg() * TAU;
      const rr = 0.48 + rg() * 0.4;
      const x = Math.cos(a) * rr;
      const z = Math.sin(a) * rr;
      if (!free(x, z, 0.015)) continue;
      const head = v3(x, 0.014 + rg() * 0.02, z);
      const face = UP.clone().lerp(VIEW, 0.5).normalize();
      const u = new Vector3().crossVectors(face, AX).normalize();
      const w = new Vector3().crossVectors(face, u);
      beads.push({ m: basis(head, face, u, 0.007, 0.0045, 0.007), c: col("#ffcf3a") });
      const spin = rg() * TAU;
      for (let j = 0; j < 5; j++) {
        const ang = spin + (j / 5) * TAU;
        const radial = u.clone().multiplyScalar(Math.cos(ang)).addScaledVector(w, Math.sin(ang));
        beads.push({ m: basis(head.clone().addScaledVector(radial, 0.01), radial, face, 0.006, 0.009, 0.0025), c: col("#fbfaf7") });
      }
      k++;
    }
    // a few leaves already turned, lying about
    for (let k = 0, tries = 0; k < 8 && tries < 300; tries++) {
      const a = rg() * TAU;
      const rr = 0.52 + rg() * 0.36;
      const x = Math.cos(a) * rr;
      const z = Math.sin(a) * rr;
      if (!free(x, z, 0.02)) continue;
      const d = v3(Math.cos(rg() * TAU), 0.12, Math.sin(rg() * TAU));
      leaf(v3(x, 0.006, z), d, v3(0.2, 1, 0.1), 0.04 + rg() * 0.015, AUTUMN[k % AUTUMN.length]!, 0.9);
      k++;
    }
  }

  // ── floating bits of rock that drifted off ──
  const floaters: { mesh: Mesh; y: number; phase: number; spin: number }[] = [];
  {
    const FLOAT: [number, number, number, number, number][] = [[1.08, -0.62, 0.22, 0.05, 0], [-1.04, -0.7, 0.1, 0.04, 2], [0.32, -1.22, 0.52, 0.07, 1]];
    FLOAT.forEach(([x, y, z, s, tone], k) => {
      const geo = facet(new IcosahedronGeometry(1, 0).scale(s * 1.2, s * 0.85, s));
      const mesh = b.part(geo, mStone[tone]!, group, { outline: inkHull(geo) });
      mesh.position.set(x, y, z);
      floaters.push({ mesh, y, phase: k * 2.1, spin: k % 2 ? -0.25 : 0.3 });
    });
  }

  // ── commit the merged props ──
  b.part(merge(barkParts), kit.toon(bark), group);
  b.part(merge(foliageDark), kit.toon(foliage), group);
  b.part(merge(foliageLight), kit.toon(brighten(foliage, 0.08)), group);
  b.part(merge(shafts), kit.toon("#a8743e"), group, { outline: false });
  b.part(merge(fletch), kit.toon(red), group, { outline: false });
  b.part(merge(fletchLight), kit.toon(cream), group, { outline: false });
  b.part(merge(shroomStems), kit.toon(stemHex), group);
  b.part(merge(gills), kit.toon(darken(stemHex, 0.9)), group, { outline: false });
  b.part(merge(capsRed), kit.toon("#e0473a"), group);
  b.part(merge(capsYellow), kit.toon("#ffcc33"), group);
  b.part(merge(stems), kit.toon("#3b8a41"), group, { outline: false });
  b.part(merge(roots), kit.toon("#c39563"), group, { outline: false });
  b.part(merge(coins), mGold, group, { outline: false });

  // ── commit the scatters ──
  const bladeGeo = new ConeGeometry(1, 1, 3, 1, true).translate(0, 0.5, 0).scale(1, 1, 0.42);
  const leafGeo = lathe([[0.001, 1], [0.22, 0.75], [0.3, 0.45], [0.2, 0.18], [0.001, 0]], 5).scale(1, 1, 0.25);
  const blobGeo = new CircleGeometry(1, 14);
  {
    const p = blobGeo.getAttribute("position");
    for (let i = 1; i < p.count; i++) {
      const f = 0.82 + hash((i - 1) % 14, 77) * 0.3;
      p.setXYZ(i, p.getX(i) * f, p.getY(i) * f, p.getZ(i));
    }
    blobGeo.rotateX(-Math.PI / 2);
  }
  b.inst(new SphereGeometry(1, 10, 6), mLip, group, drips);
  b.inst(bladeGeo, mTint, group, blades);
  b.inst(blobGeo, mTint, group, patches);
  b.inst(leafGeo, mTint, group, leaves);
  b.inst(new SphereGeometry(1, 7, 5), mTint, group, beads);
  b.inst(new IcosahedronGeometry(1, 0), mTint, group, pebbles);

  return {
    group,
    meshes: b.count(),
    update(t: number) {
      for (const f of floaters) {
        f.mesh.position.y = f.y + Math.sin(t * 0.9 + f.phase) * 0.018;
        f.mesh.rotation.y = f.phase + t * f.spin;
      }
    },
    dispose() {
      group.removeFromParent();
      for (const im of b.insts) im.dispose();
      for (const g of b.geos) g.dispose();
    },
  };
}
