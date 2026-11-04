/**
 * THE MERRYMAN, BUILT FROM PRIMITIVES.
 *
 * No model file, no loader, no licence to track: every part of the character is
 * a sphere, capsule, cone, lathe or tube assembled here, so the whole wardrobe
 * is code and a new hat is a function. Toon shading with a three-step ramp and
 * an inked outline keep it reading as a character at 40 pixels and at 400.
 *
 * The skeleton is a tree of Groups — root → pivot → hips → spine → neck → head,
 * shoulders → elbows → hands, thighs → knees → feet — and `applyPose` is the
 * one place a semantic Pose (pose.ts) becomes Euler angles, including every
 * mirror sign for the right side.
 */
import {
  BackSide,
  BoxGeometry,
  BufferAttribute,
  CanvasTexture,
  CapsuleGeometry,
  CatmullRomCurve3,
  CircleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DataTexture,
  DoubleSide,
  Group,
  IcosahedronGeometry,
  LatheGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshToonMaterial,
  NearestFilter,
  Object3D,
  PlaneGeometry,
  RedFormat,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
  type BufferGeometry,
  type Material,
} from "three";
import { hexOf, type Outfit } from "./outfit";
import type { Pose } from "./pose";

// ── the kit: materials shared by every part of one stage ─────────────────

export type Kit = {
  toon(hex: string | Color, opts?: { emissive?: string; emissiveIntensity?: number; side?: typeof DoubleSide; transparent?: boolean; opacity?: number }): MeshToonMaterial;
  basic(hex: string, opts?: { transparent?: boolean; opacity?: number; side?: typeof DoubleSide }): MeshBasicMaterial;
  outline: MeshBasicMaterial;
  dispose(): void;
};

export function createKit(outlineWidth = 0.011): Kit {
  const ramp = new DataTexture(new Uint8Array([90, 170, 255]), 3, 1, RedFormat);
  ramp.minFilter = NearestFilter;
  ramp.magFilter = NearestFilter;
  ramp.needsUpdate = true;
  const cache = new Map<string, Material>();
  const outline = new MeshBasicMaterial({ color: new Color("#120f12"), side: BackSide });
  // Inked outline: push each vertex out along its VIEW-space normal, so the
  // line is the same weight on a 0.06 fingertip and a 0.3 head.
  outline.onBeforeCompile = (shader) => {
    shader.uniforms.outlineWidth = { value: outlineWidth };
    shader.vertexShader = `uniform float outlineWidth;\n${shader.vertexShader.replace(
      "#include <project_vertex>",
      `vec4 mvPosition = modelViewMatrix * vec4( transformed, 1.0 );
       vec3 outlineN = normalize( normalMatrix * normal );
       mvPosition.xyz += outlineN * outlineWidth;
       gl_Position = projectionMatrix * mvPosition;`,
    )}`;
  };
  outline.customProgramCacheKey = () => `merryman-outline-${outlineWidth}`;
  return {
    toon(hex, opts = {}) {
      const c = hex instanceof Color ? hex : new Color(hex);
      const key = `t:${c.getHexString()}:${opts.emissive ?? ""}:${opts.emissiveIntensity ?? ""}:${opts.side ?? ""}:${opts.opacity ?? ""}`;
      let m = cache.get(key) as MeshToonMaterial | undefined;
      if (!m) {
        m = new MeshToonMaterial({ color: c, gradientMap: ramp });
        if (opts.emissive) { m.emissive = new Color(opts.emissive); m.emissiveIntensity = opts.emissiveIntensity ?? 1; }
        if (opts.side) m.side = opts.side;
        if (opts.transparent) { m.transparent = true; m.opacity = opts.opacity ?? 1; m.depthWrite = false; }
        cache.set(key, m);
      }
      return m;
    },
    basic(hex, opts = {}) {
      const key = `b:${hex}:${opts.opacity ?? ""}:${opts.side ?? ""}`;
      let m = cache.get(key) as MeshBasicMaterial | undefined;
      if (!m) {
        m = new MeshBasicMaterial({ color: new Color(hex) });
        if (opts.transparent) { m.transparent = true; m.opacity = opts.opacity ?? 1; m.depthWrite = false; }
        if (opts.side) m.side = opts.side;
        cache.set(key, m);
      }
      return m;
    },
    outline,
    dispose() {
      for (const m of cache.values()) m.dispose();
      cache.clear();
      outline.dispose();
      ramp.dispose();
    },
  };
}

// ── the rig ──────────────────────────────────────────────────────────────

export type Rig = {
  /** Add this to the scene: the merryman and his pet. */
  object: Group;
  root: Group;
  pivot: Group;
  hips: Group;
  spine: Group;
  neck: Group;
  head: Group;
  shoulderL: Group;
  shoulderR: Group;
  elbowL: Group;
  elbowR: Group;
  handL: Group;
  handR: Group;
  thighL: Group;
  thighR: Group;
  kneeL: Group;
  kneeR: Group;
  footL: Group;
  footR: Group;
  eyeL: Group;
  eyeR: Group;
  pupilL: Object3D;
  pupilR: Object3D;
  browL: Object3D;
  browR: Object3D;
  mouthArc: Object3D;
  mouthOpen: Object3D;
  hat: Group;
  halo: Object3D | null;
  bow: { hand: Group; back: Group; top: Vector3; bottom: Vector3; stringTop: Mesh; stringBottom: Mesh; arrow: Mesh } | null;
  held: Group | null;
  coin: Mesh;
  cape: { mesh: Mesh; rest: Float32Array; length: number } | null;
  wings: [Group, Group] | null;
  pet: { group: Group; body: Group; head: Group; tail: Object3D | null; kind: string } | null;
  /** Meshes a tap can land on. */
  hitMeshes: Mesh[];
  outfit: Outfit;
  dispose(): void;
};

const v2 = (x: number, y: number) => new Vector2(x, y);

function darken(hex: string, f: number): Color {
  return new Color(hex).multiplyScalar(f);
}
function lighten(hex: string, f: number): Color {
  return new Color(hex).lerp(new Color("#ffffff"), f);
}

type Builder = {
  kit: Kit;
  geos: BufferGeometry[];
  hit: Mesh[];
  part(geo: BufferGeometry, mat: Material, parent: Object3D, opts?: { pos?: [number, number, number]; rot?: [number, number, number]; scale?: [number, number, number]; outline?: boolean; hit?: boolean }): Mesh;
};

function builder(kit: Kit): Builder {
  const geos: BufferGeometry[] = [];
  const hit: Mesh[] = [];
  return {
    kit,
    geos,
    hit,
    part(geo, mat, parent, opts = {}) {
      geos.push(geo);
      const m = new Mesh(geo, mat);
      if (opts.pos) m.position.set(...opts.pos);
      if (opts.rot) m.rotation.set(...opts.rot);
      if (opts.scale) m.scale.set(...opts.scale);
      parent.add(m);
      if (opts.outline !== false) {
        const o = new Mesh(geo, kit.outline);
        o.raycast = () => {};
        m.add(o);
      }
      if (opts.hit !== false) hit.push(m);
      return m;
    },
  };
}

const group = (parent: Object3D, x = 0, y = 0, z = 0, name = "") => {
  const g = new Group();
  g.position.set(x, y, z);
  g.name = name;
  parent.add(g);
  return g;
};

/** A sphere for an ellipsoid: real radius on the longest axis, so the ink stays even. */
const sphere = (r: number, w = 20, h = 14) => new SphereGeometry(r, w, h);
const capsule = (r: number, len: number) => new CapsuleGeometry(r, len, 5, 12);

export function buildRig(outfit: Outfit, kit: Kit): Rig {
  const b = builder(kit);
  const cloth = hexOf("cloth", outfit.cloth);
  const trim = hexOf("trim", outfit.trim);
  const hatHex = hexOf("hatColor", outfit.hatColor);
  const skin = hexOf("skin", outfit.skin);
  const hair = hexOf("hair", outfit.hair);
  const leather = hexOf("leather", outfit.leather);
  const eyes = hexOf("eyes", outfit.eyes);
  const metal = "#b9c2cc";
  const gold = "#e3b341";
  const wood = "#8a5a2e";

  const mCloth = kit.toon(outfit.style === "armor" ? lighten(metal, 0) : cloth);
  const mClothDark = kit.toon(outfit.style === "armor" ? darken(cloth, 0.8) : darken(cloth, 0.72));
  const mPants = kit.toon(outfit.style === "suit" ? darken(cloth, 0.55) : outfit.style === "armor" ? darken(metal, 0.45) : darken(leather, 1.25));
  const mTrim = kit.toon(trim);
  const mSkin = kit.toon(skin);
  const mSkinShade = kit.toon(darken(skin, 0.88));
  const mHair = kit.toon(hair);
  const mLeather = kit.toon(leather);
  const mMetal = kit.toon(metal);
  const mGold = kit.toon(gold, { emissive: "#6b4a10", emissiveIntensity: 0.35 });
  const mWood = kit.toon(wood);
  const mInk = kit.basic("#151216");
  const mWhite = kit.basic("#fbfaf7");

  const object = new Group();
  object.name = "merryman";
  const root = group(object, 0, 0, 0, "root");
  const pivot = group(root, 0, 0.75, 0, "pivot");
  const body = group(pivot, 0, -0.75, 0, "body");

  // ── hips and legs ──
  const hips = group(body, 0, 0.62, 0, "hips");
  b.part(sphere(0.2), mPants, hips, { pos: [0, -0.02, 0], scale: [1, 0.62, 0.82] });
  const legSide = (sx: number) => {
    const thigh = group(hips, 0.1 * sx, -0.03, 0, "thigh");
    b.part(capsule(0.068, 0.16), mPants, thigh, { pos: [0, -0.12, 0] });
    const knee = group(thigh, 0, -0.26, 0, "knee");
    b.part(capsule(0.062, 0.14), mPants, knee, { pos: [0, -0.1, 0] });
    const foot = group(knee, 0, -0.25, 0, "foot");
    b.part(sphere(0.1), mLeather, foot, { pos: [0, -0.035, 0.035], scale: [0.85, 0.62, 1.3] });
    b.part(new CylinderGeometry(0.078, 0.072, 0.1, 14), mLeather, foot, { pos: [0, 0.04, 0] });
    b.part(new TorusGeometry(0.078, 0.014, 6, 16), mTrim, foot, { pos: [0, 0.09, 0], rot: [Math.PI / 2, 0, 0], outline: false });
    return { thigh, knee, foot };
  };
  const L = legSide(1);
  const R = legSide(-1);

  // ── torso, by style ──
  const spine = group(hips, 0, 0.02, 0, "spine");
  const style = outfit.style;
  const hem = style === "robe" ? -0.55 : style === "hoodie" || style === "suit" ? -0.12 : -0.17;
  const flare = style === "robe" ? 0.33 : style === "tunic" ? 0.27 : style === "armor" ? 0.25 : 0.23;
  const profile = [
    v2(0.001, hem - 0.005), v2(flare, hem), v2(flare * 0.93, hem + 0.05), v2(0.205, -0.02),
    v2(0.198, 0.04), v2(0.215, 0.16), v2(0.208, 0.25), v2(0.17, 0.33), v2(0.1, 0.38), v2(0.001, 0.39),
  ];
  b.part(new LatheGeometry(profile, 28), mCloth, spine);
  // hem band
  b.part(new TorusGeometry(flare * 0.99, 0.022, 6, 32), mTrim, spine, { pos: [0, hem + 0.012, 0], rot: [Math.PI / 2, 0, 0], outline: false });
  // belt and buckle
  b.part(new TorusGeometry(0.205, 0.03, 8, 32), style === "suit" ? kit.toon("#1c1c20") : mLeather, spine, { pos: [0, 0.01, 0], rot: [Math.PI / 2, 0, 0] });
  b.part(new BoxGeometry(0.075, 0.06, 0.03), mGold, spine, { pos: [0, 0.01, 0.215] });
  if (style === "tunic" || style === "robe") {
    // V-neck collar in the trim colour, and a laced front
    b.part(new ConeGeometry(0.08, 0.16, 3), mTrim, spine, { pos: [0, 0.29, 0.165], rot: [Math.PI + 0.25, 0, 0], scale: [1, 1, 0.3], outline: false });
    for (let i = 0; i < 3; i++) b.part(new BoxGeometry(0.05, 0.008, 0.01), mLeather, spine, { pos: [0, 0.13 + i * 0.045, 0.21], rot: [0, 0, i % 2 ? 0.5 : -0.5], outline: false, hit: false });
  }
  if (style === "armor") {
    b.part(sphere(0.11), mMetal, spine, { pos: [0.21, 0.3, 0], scale: [1, 0.7, 1.05] });
    b.part(sphere(0.11), mMetal, spine, { pos: [-0.21, 0.3, 0], scale: [1, 0.7, 1.05] });
    b.part(new BoxGeometry(0.04, 0.22, 0.03), mGold, spine, { pos: [0, 0.16, 0.205], outline: false });
    b.part(new TorusGeometry(0.212, 0.018, 6, 32), mClothDark, spine, { pos: [0, 0.22, 0], rot: [Math.PI / 2, 0, 0], outline: false });
  }
  if (style === "hoodie") {
    b.part(new TorusGeometry(0.13, 0.055, 10, 24), mClothDark, spine, { pos: [0, 0.36, -0.04], rot: [Math.PI / 2 - 0.4, 0, 0] });
    b.part(new BoxGeometry(0.22, 0.09, 0.03), mClothDark, spine, { pos: [0, 0.06, 0.2], outline: false });
    for (const sx of [1, -1]) b.part(new CylinderGeometry(0.006, 0.006, 0.12, 5), mWhite, spine, { pos: [0.04 * sx, 0.27, 0.2], outline: false, hit: false });
  }
  if (style === "suit") {
    b.part(new ConeGeometry(0.1, 0.22, 3), kit.toon("#f2efe8"), spine, { pos: [0, 0.26, 0.17], rot: [Math.PI + 0.2, 0, 0], scale: [1, 1, 0.3], outline: false });
    b.part(new BoxGeometry(0.04, 0.2, 0.02), mTrim, spine, { pos: [0, 0.2, 0.205], rot: [0.12, 0, 0], outline: false });
    b.part(new BoxGeometry(0.06, 0.04, 0.025), mTrim, spine, { pos: [0, 0.3, 0.2], outline: false });
  }

  // ── arms ──
  const armSide = (sx: number) => {
    const shoulder = group(spine, 0.235 * sx, 0.29, 0, "shoulder");
    b.part(sphere(0.075), mCloth, shoulder, { pos: [0, -0.01, 0] });
    b.part(capsule(0.062, 0.13), mCloth, shoulder, { pos: [0, -0.1, 0] });
    const elbow = group(shoulder, 0, -0.21, 0, "elbow");
    b.part(capsule(0.056, 0.11), style === "armor" ? mMetal : mCloth, elbow, { pos: [0, -0.085, 0] });
    b.part(new TorusGeometry(0.058, 0.016, 6, 14), mTrim, elbow, { pos: [0, -0.165, 0], rot: [Math.PI / 2, 0, 0], outline: false });
    const hand = group(elbow, 0, -0.2, 0, "hand");
    b.part(sphere(0.066), mSkin, hand, { pos: [0, -0.02, 0], scale: [0.95, 1, 0.85] });
    b.part(sphere(0.028), mSkin, hand, { pos: [-0.045 * sx, 0.0, 0.035] });
    return { shoulder, elbow, hand };
  };
  const AL = armSide(1);
  const AR = armSide(-1);

  // ── head ──
  const neck = group(spine, 0, 0.37, 0, "neck");
  b.part(new CylinderGeometry(0.075, 0.085, 0.08, 12), mSkinShade, neck, { pos: [0, 0.02, 0] });
  const head = group(neck, 0, 0.28, 0, "head");
  b.part(sphere(0.3, 28, 20), mSkin, head, { scale: [1, 0.96, 0.95] });
  for (const sx of [1, -1]) b.part(sphere(0.06), mSkin, head, { pos: [0.29 * sx, -0.02, 0], scale: [0.55, 1, 0.8] });
  b.part(sphere(0.046), mSkinShade, head, { pos: [0, -0.045, 0.285] });
  // blush
  for (const sx of [1, -1]) {
    const c = b.part(new CircleGeometry(0.045, 16), kit.basic("#ff7c8a", { transparent: true, opacity: 0.35 }), head, { pos: [0.17 * sx, -0.08, 0.252], outline: false, hit: false });
    c.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), c.position.clone().normalize());
  }
  // eyes
  const eye = (sx: number) => {
    const g = group(head, 0.105 * sx, 0.02, 0.255, "eye");
    b.part(sphere(0.064, 16, 12), mWhite, g, { scale: [0.9, 1.05, 0.45] });
    const pupil = new Group();
    pupil.position.set(0, 0, 0.022);
    g.add(pupil);
    b.part(sphere(0.042, 16, 12), kit.basic(eyes), pupil, { scale: [1, 1.1, 0.45], outline: false, hit: false });
    b.part(sphere(0.014, 8, 6), mWhite, pupil, { pos: [0.014, 0.018, 0.018], outline: false, hit: false });
    return { g, pupil };
  };
  const EL = eye(1);
  const ER = eye(-1);
  const brow = (sx: number) => {
    const g = new Group();
    g.position.set(0.11 * sx, 0.12, 0.268);
    head.add(g);
    b.part(capsule(0.014, 0.06), mHair, g, { rot: [0, 0, Math.PI / 2], outline: false, hit: false });
    return g;
  };
  const browL = brow(1);
  const browR = brow(-1);
  const mouthArc = new Group();
  mouthArc.position.set(0, -0.135, 0.272);
  head.add(mouthArc);
  b.part(new TorusGeometry(0.05, 0.011, 6, 16, Math.PI), mInk, mouthArc, { outline: false, hit: false });
  const mouthOpen = new Group();
  mouthOpen.position.set(0, -0.14, 0.27);
  head.add(mouthOpen);
  b.part(sphere(0.05, 14, 10), kit.basic("#3a1218"), mouthOpen, { scale: [1, 1, 0.35], outline: false, hit: false });
  b.part(sphere(0.026, 10, 8), kit.basic("#e0566a"), mouthOpen, { pos: [0, -0.02, 0.01], scale: [1.2, 0.6, 0.4], outline: false, hit: false });

  // hair cap — the back and top, under whatever hat goes on
  b.part(new SphereGeometry(0.312, 24, 14, 0, Math.PI * 2, 0, Math.PI * 0.42), mHair, head, { rot: [-0.55, 0, 0], scale: [1.02, 0.98, 1] });
  for (const [x, y, z, s] of [[0.16, 0.2, 0.2, 0.08], [0.04, 0.24, 0.23, 0.09], [-0.1, 0.22, 0.22, 0.085], [-0.2, 0.15, 0.17, 0.07]] as const) {
    b.part(sphere(s), mHair, head, { pos: [x, y, z], scale: [1.2, 0.8, 0.7] });
  }

  // facial hair
  if (outfit.beard === "full") {
    b.part(sphere(0.2), mHair, head, { pos: [0, -0.2, 0.13], scale: [1.05, 0.8, 0.72] });
    for (const sx of [1, -1]) b.part(sphere(0.07), mHair, head, { pos: [0.24 * sx, -0.08, 0.08], scale: [0.6, 1.3, 0.9] });
  } else if (outfit.beard === "mustache" || outfit.beard === "goatee") {
    for (const sx of [1, -1]) b.part(capsule(0.022, 0.06), mHair, head, { pos: [0.042 * sx, -0.092, 0.285], rot: [0, 0, (Math.PI / 2) + 0.45 * sx], outline: false });
    if (outfit.beard === "goatee") b.part(new ConeGeometry(0.045, 0.1, 10), mHair, head, { pos: [0, -0.23, 0.22], rot: [Math.PI + 0.35, 0, 0] });
  } else if (outfit.beard === "stubble") {
    b.part(new SphereGeometry(0.303, 24, 12, Math.PI * 0.15, Math.PI * 0.7, Math.PI * 0.55, Math.PI * 0.4), kit.toon(hair, { transparent: true, opacity: 0.32 }), head, { outline: false, hit: false });
  }

  // eyewear
  if (outfit.eyewear === "round" || outfit.eyewear === "monocle") {
    const sides = outfit.eyewear === "round" ? [1, -1] : [-1];
    for (const sx of sides) b.part(new TorusGeometry(0.068, 0.009, 6, 20), mGold, head, { pos: [0.105 * sx, 0.02, 0.29], outline: false });
    if (outfit.eyewear === "round") b.part(new CylinderGeometry(0.006, 0.006, 0.07, 5), mGold, head, { pos: [0, 0.03, 0.3], rot: [0, 0, Math.PI / 2], outline: false });
    else b.part(new TubeGeometry(new CatmullRomCurve3([new Vector3(-0.15, -0.04, 0.29), new Vector3(-0.2, -0.2, 0.25), new Vector3(-0.22, -0.3, 0.2)]), 10, 0.004, 4), mGold, head, { outline: false, hit: false });
  } else if (outfit.eyewear === "shades") {
    const dark = kit.toon("#141418", { emissive: "#2b3a55", emissiveIntensity: 0.4 });
    for (const sx of [1, -1]) b.part(new BoxGeometry(0.12, 0.075, 0.02), dark, head, { pos: [0.105 * sx, 0.025, 0.295], rot: [0, 0.18 * sx, 0] });
    b.part(new BoxGeometry(0.07, 0.015, 0.015), dark, head, { pos: [0, 0.045, 0.3] });
  } else if (outfit.eyewear === "visor") {
    b.part(new CylinderGeometry(0.31, 0.31, 0.085, 28, 1, true, -Math.PI * 0.32, Math.PI * 0.64), kit.toon("#26f0c8", { emissive: "#18c8a8", emissiveIntensity: 0.9, side: DoubleSide, transparent: true, opacity: 0.78 }), head, { pos: [0, 0.03, 0.005], rot: [0, 0, 0], outline: false });
  }

  // ── hats ──
  const hat = group(head, 0, 0, 0, "hat");
  let halo: Object3D | null = null;
  const mHat = kit.toon(hatHex);
  switch (outfit.hat) {
    case "feather": {
      b.part(new ConeGeometry(0.3, 0.5, 28, 1, true), kit.toon(hatHex, { side: DoubleSide }), hat, { pos: [0, 0.22, -0.08], rot: [-1.15, 0, 0], scale: [1.05, 1, 0.72] });
      b.part(new TorusGeometry(0.288, 0.035, 8, 32), kit.toon(darken(hatHex, 0.75)), hat, { pos: [0, 0.16, -0.01], rot: [Math.PI / 2 - 0.22, 0, 0] });
      b.part(new ConeGeometry(0.11, 0.18, 4), kit.toon(darken(hatHex, 0.75)), hat, { pos: [0, 0.2, 0.25], rot: [0.9, 0, 0], scale: [1.6, 1, 0.4] });
      const feather = group(hat, 0.2, 0.26, -0.05, "feather");
      feather.rotation.set(-0.9, 0.2, -0.35);
      b.part(sphere(0.2, 12, 8), kit.toon(trim), feather, { pos: [0, 0.16, 0], scale: [0.16, 1.15, 0.05] });
      b.part(new CylinderGeometry(0.005, 0.005, 0.42, 4), mWhite, feather, { pos: [0, 0.16, 0.012], outline: false, hit: false });
      break;
    }
    case "hood": {
      b.part(new SphereGeometry(0.345, 28, 18, Math.PI / 2 + 0.95, Math.PI * 2 - 1.9, 0, Math.PI * 0.74), kit.toon(hatHex, { side: DoubleSide }), hat, { pos: [0, 0.01, -0.015] });
      b.part(new ConeGeometry(0.12, 0.42, 14), mHat, hat, { pos: [0, 0.1, -0.42], rot: [-2.2, 0, 0] });
      b.part(new ConeGeometry(0.34, 0.2, 28, 1, true), kit.toon(hatHex, { side: DoubleSide }), hat, { pos: [0, -0.3, -0.02] });
      break;
    }
    case "crown": {
      b.part(new CylinderGeometry(0.21, 0.22, 0.11, 24, 1, true), kit.toon(gold, { emissive: "#6b4a10", emissiveIntensity: 0.35, side: DoubleSide }), hat, { pos: [0, 0.3, -0.02] });
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2;
        b.part(new ConeGeometry(0.035, 0.1, 6), mGold, hat, { pos: [Math.sin(a) * 0.21, 0.4, Math.cos(a) * 0.21 - 0.02] });
        b.part(sphere(0.022, 8, 6), kit.toon(i % 2 ? "#d8344a" : "#3a7be0", { emissive: i % 2 ? "#801020" : "#103a80", emissiveIntensity: 0.6 }), hat, { pos: [Math.sin(a) * 0.222, 0.3, Math.cos(a) * 0.222 - 0.02], outline: false });
      }
      break;
    }
    case "wizard": {
      b.part(new CylinderGeometry(0.43, 0.43, 0.025, 32), mHat, hat, { pos: [0, 0.2, -0.02] });
      b.part(new ConeGeometry(0.27, 0.42, 28), mHat, hat, { pos: [0, 0.42, -0.04], rot: [-0.08, 0, 0] });
      b.part(new ConeGeometry(0.12, 0.3, 18), mHat, hat, { pos: [0, 0.72, -0.16], rot: [-0.7, 0, 0] });
      b.part(new TorusGeometry(0.255, 0.025, 6, 28), mTrim, hat, { pos: [0, 0.23, -0.02], rot: [Math.PI / 2, 0, 0], outline: false });
      b.part(new IcosahedronGeometry(0.05, 0), kit.toon("#ffe27a", { emissive: "#ffcf3a", emissiveIntensity: 0.9 }), hat, { pos: [0.1, 0.42, 0.2] });
      break;
    }
    case "beanie": {
      b.part(new SphereGeometry(0.318, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.5), mHat, hat, { pos: [0, 0.06, -0.01] });
      b.part(new TorusGeometry(0.31, 0.045, 8, 32), kit.toon(darken(hatHex, 0.8)), hat, { pos: [0, 0.07, -0.01], rot: [Math.PI / 2, 0, 0] });
      b.part(sphere(0.075), mTrim, hat, { pos: [0, 0.4, -0.02] });
      break;
    }
    case "tophat": {
      b.part(new CylinderGeometry(0.34, 0.34, 0.025, 32), kit.toon("#1c1b22"), hat, { pos: [0, 0.22, -0.02] });
      b.part(new CylinderGeometry(0.2, 0.19, 0.38, 28), kit.toon("#1c1b22"), hat, { pos: [0, 0.42, -0.02] });
      b.part(new CylinderGeometry(0.197, 0.197, 0.07, 28, 1, true), mTrim, hat, { pos: [0, 0.27, -0.02], outline: false });
      hat.rotation.z = -0.08;
      break;
    }
    case "viking": {
      b.part(new SphereGeometry(0.325, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.5), mMetal, hat, { pos: [0, 0.04, -0.01] });
      b.part(new TorusGeometry(0.322, 0.03, 8, 32), mGold, hat, { pos: [0, 0.05, -0.01], rot: [Math.PI / 2, 0, 0] });
      b.part(new BoxGeometry(0.04, 0.16, 0.03), mMetal, hat, { pos: [0, 0.0, 0.32] });
      for (const sx of [1, -1]) {
        const horn = new TubeGeometry(new CatmullRomCurve3([new Vector3(0.26 * sx, 0.14, 0), new Vector3(0.42 * sx, 0.22, 0), new Vector3(0.48 * sx, 0.42, -0.02)]), 12, 0.045, 10);
        b.part(horn, kit.toon("#efe6cf"), hat);
        b.part(new ConeGeometry(0.045, 0.1, 10), kit.toon("#efe6cf"), hat, { pos: [0.49 * sx, 0.47, -0.02], rot: [0, 0, -0.2 * sx] });
      }
      break;
    }
    case "bandana": {
      b.part(new TorusGeometry(0.3, 0.042, 8, 32), mHat, hat, { pos: [0, 0.12, -0.01], rot: [Math.PI / 2 - 0.15, 0, 0] });
      for (const sx of [1, -1]) b.part(sphere(0.07), mHat, hat, { pos: [0.05 * sx, 0.08, -0.33], rot: [0.6, 0.5 * sx, 0], scale: [0.6, 1.4, 0.4] });
      break;
    }
    case "halo": {
      const g = group(hat, 0, 0.47, -0.02, "halo");
      b.part(new TorusGeometry(0.19, 0.022, 8, 32), kit.toon("#ffe9a0", { emissive: "#ffd34a", emissiveIntensity: 1 }), g, { rot: [Math.PI / 2, 0, 0], outline: false, hit: false });
      halo = g;
      break;
    }
    default:
      for (const [x, z, rx, rz] of [[0, 0, -0.2, 0], [0.12, -0.04, -0.1, -0.4], [-0.12, -0.04, -0.1, 0.4], [0.05, -0.15, -0.6, -0.15], [-0.06, -0.14, -0.6, 0.15]] as const) {
        b.part(new ConeGeometry(0.06, 0.18, 8), mHair, head, { pos: [x, 0.3, z], rot: [rx, 0, rz] });
      }
  }

  // ── held props ──
  let bow: Rig["bow"] = null;
  let held: Group | null = null;
  if (outfit.held === "bow") {
    const makeBow = (parent: Object3D) => {
      const g = group(parent, 0, 0, 0, "bow");
      const arc = new CatmullRomCurve3([
        new Vector3(0, 0.06, -0.48), new Vector3(0, -0.05, -0.25), new Vector3(0, -0.08, 0), new Vector3(0, -0.05, 0.25), new Vector3(0, 0.06, 0.48),
      ]);
      b.part(new TubeGeometry(arc, 24, 0.016, 6), mWood, g);
      b.part(new CylinderGeometry(0.024, 0.024, 0.09, 8), mLeather, g, { pos: [0, -0.08, 0], rot: [Math.PI / 2, 0, 0], outline: false });
      return g;
    };
    const hand = makeBow(AL.hand);
    hand.position.set(0, -0.03, 0);
    const back = makeBow(spine);
    back.position.set(0, 0.16, -0.25);
    back.rotation.set(0, Math.PI / 2, 0.75);
    const mString = kit.basic("#f2ead8");
    const stringTop = b.part(new CylinderGeometry(0.004, 0.004, 1, 4), mString, hand, { outline: false, hit: false });
    const stringBottom = b.part(new CylinderGeometry(0.004, 0.004, 1, 4), mString, hand, { outline: false, hit: false });
    const arrow = new Mesh();
    hand.add(arrow);
    b.part(new CylinderGeometry(0.007, 0.007, 0.62, 5), mWood, arrow, { rot: [0, 0, 0], outline: false, hit: false });
    b.part(new ConeGeometry(0.018, 0.06, 6), mMetal, arrow, { pos: [0, -0.33, 0], rot: [Math.PI, 0, 0], outline: false, hit: false });
    b.part(new ConeGeometry(0.025, 0.07, 3), mTrim, arrow, { pos: [0, 0.28, 0], outline: false, hit: false });
    bow = { hand, back, top: new Vector3(0, 0.06, 0.48), bottom: new Vector3(0, 0.06, -0.48), stringTop, stringBottom, arrow };
  } else if (outfit.held !== "none") {
    const shield = outfit.held === "shield";
    held = group(shield ? AL.hand : AR.hand, 0, -0.03, 0, "held");
    switch (outfit.held) {
      case "sword": {
        const s = group(held, 0, 0, 0.02);
        s.rotation.x = 1.05;
        b.part(new CylinderGeometry(0.018, 0.018, 0.12, 8), mLeather, s, { pos: [0, 0, 0] });
        b.part(new BoxGeometry(0.16, 0.025, 0.035), mGold, s, { pos: [0, -0.07, 0] });
        b.part(new BoxGeometry(0.05, 0.5, 0.012), mMetal, s, { pos: [0, -0.33, 0] });
        b.part(new ConeGeometry(0.025, 0.06, 4), mMetal, s, { pos: [0, -0.61, 0], rot: [Math.PI, 0, 0], scale: [1, 1, 0.25] });
        b.part(sphere(0.026, 10, 8), mGold, s, { pos: [0, 0.07, 0] });
        break;
      }
      case "staff": {
        b.part(new CylinderGeometry(0.022, 0.026, 1.25, 8), mWood, held, { pos: [0, 0.08, 0.03] });
        b.part(sphere(0.07, 16, 12), kit.toon("#9ff3ff", { emissive: "#3fd6ff", emissiveIntensity: 1.1 }), held, { pos: [0, 0.76, 0.03], outline: false });
        b.part(new TorusGeometry(0.075, 0.012, 6, 16), mGold, held, { pos: [0, 0.7, 0.03], rot: [Math.PI / 2, 0, 0], outline: false });
        break;
      }
      case "lantern": {
        b.part(new CylinderGeometry(0.004, 0.004, 0.1, 4), mInk, held, { pos: [0, -0.06, 0], outline: false, hit: false });
        b.part(new CylinderGeometry(0.05, 0.06, 0.03, 8), mInk, held, { pos: [0, -0.12, 0] });
        b.part(sphere(0.05, 12, 10), kit.toon("#ffd27a", { emissive: "#ffb43a", emissiveIntensity: 1.2 }), held, { pos: [0, -0.18, 0], scale: [1, 1.3, 1], outline: false });
        b.part(new CylinderGeometry(0.065, 0.06, 0.025, 8), mInk, held, { pos: [0, -0.25, 0] });
        break;
      }
      case "coinbag": {
        b.part(sphere(0.11, 16, 12), kit.toon("#b08a52"), held, { pos: [0, -0.15, 0.02], scale: [1, 0.95, 0.9] });
        b.part(new TorusGeometry(0.035, 0.012, 6, 12), mLeather, held, { pos: [0, -0.05, 0.02], rot: [Math.PI / 2, 0, 0], outline: false });
        b.part(new CylinderGeometry(0.035, 0.035, 0.008, 14), mGold, held, { pos: [0.03, -0.03, 0.03], rot: [0.5, 0, 0.3], outline: false });
        break;
      }
      case "mug": {
        b.part(new CylinderGeometry(0.06, 0.055, 0.13, 14), kit.toon("#a0703c"), held, { pos: [0, -0.04, 0.08], rot: [Math.PI / 2, 0, 0] });
        b.part(sphere(0.062, 12, 8), mWhite, held, { pos: [0, -0.04, 0.15], scale: [1, 1, 0.35], outline: false });
        break;
      }
      case "shield": {
        const s = group(held, 0.07, 0.05, 0);
        s.rotation.set(0, Math.PI / 2, 0);
        b.part(new CylinderGeometry(0.2, 0.2, 0.03, 28), kit.toon(trim), s, { rot: [Math.PI / 2, 0, 0] });
        b.part(new TorusGeometry(0.2, 0.018, 6, 28), mMetal, s, { outline: false });
        b.part(sphere(0.045, 12, 8), mGold, s, { pos: [0, 0, 0.02], scale: [1, 1, 0.5], outline: false });
        break;
      }
    }
  }
  // the coin a toss throws — parked in the right hand, hidden until it flies
  const coin = new Mesh(new CylinderGeometry(0.045, 0.045, 0.01, 18), mGold);
  b.geos.push(coin.geometry);
  coin.rotation.x = Math.PI / 2;
  coin.visible = false;
  AR.hand.add(coin);

  // ── on the back ──
  let wings: Rig["wings"] = null;
  if (outfit.back === "quiver") {
    const q = group(spine, -0.08, 0.15, -0.21, "quiver");
    q.rotation.set(-0.15, 0, -0.5);
    b.part(new CylinderGeometry(0.07, 0.06, 0.42, 12), mLeather, q);
    b.part(new TorusGeometry(0.07, 0.014, 6, 14), mTrim, q, { pos: [0, 0.2, 0], rot: [Math.PI / 2, 0, 0], outline: false });
    for (let i = 0; i < 4; i++) {
      const a = group(q, Math.cos(i * 1.7) * 0.03, 0.28 + (i % 2) * 0.03, Math.sin(i * 1.7) * 0.03);
      a.rotation.z = (i - 1.5) * 0.08;
      b.part(new CylinderGeometry(0.006, 0.006, 0.14, 4), mWood, a, { outline: false, hit: false });
      b.part(new ConeGeometry(0.022, 0.07, 3), mTrim, a, { pos: [0, 0.07, 0], outline: false, hit: false });
    }
    b.part(new TorusGeometry(0.24, 0.015, 6, 32, Math.PI), mLeather, spine, { pos: [0, 0.16, 0], rot: [0.0, 0, 0.75], scale: [1, 1.05, 1.02], outline: false, hit: false });
  } else if (outfit.back === "backpack") {
    const p = group(spine, 0, 0.15, -0.23, "pack");
    b.part(new BoxGeometry(0.3, 0.32, 0.16), kit.toon("#8a6a3c"), p);
    b.part(new BoxGeometry(0.31, 0.12, 0.17), kit.toon("#6e532e"), p, { pos: [0, 0.12, 0.005] });
    b.part(new CylinderGeometry(0.06, 0.06, 0.34, 12), kit.toon(trim), p, { pos: [0, 0.22, -0.01], rot: [0, 0, Math.PI / 2] });
  } else if (outfit.back === "wings") {
    const wing = (sx: number) => {
      const w = group(spine, 0.08 * sx, 0.24, -0.2, "wing");
      for (let i = 0; i < 4; i++) {
        b.part(sphere(0.2, 12, 8), kit.toon(i % 2 ? "#ffffff" : "#e9f0ff", { emissive: "#9fc0ff", emissiveIntensity: 0.15 }), w, { pos: [0.18 * sx + i * 0.07 * sx, 0.06 - i * 0.07, -0.05], rot: [0, 0, (0.5 + i * 0.25) * sx], scale: [0.35, 1, 0.12] });
      }
      return w;
    };
    wings = [wing(1), wing(-1)];
  }

  // ── cape ──
  let cape: Rig["cape"] = null;
  if (outfit.cape !== "none") {
    const length = outfit.cape === "long" ? 0.82 : 0.44;
    const geo = new PlaneGeometry(0.5, length, 6, 12);
    geo.translate(0, -length / 2, 0);
    const mesh = b.part(geo, kit.toon(outfit.cape === "long" ? darken(trim, 0.85) : trim, { side: DoubleSide }), spine, { pos: [0, 0.34, -0.2], outline: false });
    mesh.rotation.x = 0.12;
    b.part(sphere(0.03, 10, 8), mGold, spine, { pos: [0.13, 0.33, 0.16], outline: false });
    b.part(sphere(0.03, 10, 8), mGold, spine, { pos: [-0.13, 0.33, 0.16], outline: false });
    const pos = geo.getAttribute("position") as BufferAttribute;
    cape = { mesh, rest: Float32Array.from(pos.array as ArrayLike<number>), length };
  }

  // ── pet ──
  let pet: Rig["pet"] = null;
  if (outfit.pet !== "none") {
    const g = group(object, 0.62, 0, 0.18, "pet");
    g.rotation.y = -0.5;
    const pb = group(g, 0, 0, 0, "petBody");
    const ph = group(pb, 0, 0, 0, "petHead");
    let tail: Object3D | null = null;
    if (outfit.pet === "fox") {
      const fur = kit.toon("#e0712a");
      b.part(sphere(0.12, 16, 12), fur, pb, { pos: [0, 0.12, 0], scale: [0.9, 0.85, 1.25] });
      ph.position.set(0, 0.24, 0.1);
      b.part(sphere(0.09, 16, 12), fur, ph);
      b.part(new ConeGeometry(0.05, 0.1, 10), fur, ph, { pos: [0, -0.02, 0.1], rot: [Math.PI / 2, 0, 0] });
      b.part(sphere(0.016, 8, 6), mInk, ph, { pos: [0, -0.02, 0.15], outline: false });
      for (const sx of [1, -1]) {
        b.part(new ConeGeometry(0.035, 0.08, 4), fur, ph, { pos: [0.05 * sx, 0.09, -0.01], rot: [0, 0, -0.25 * sx] });
        b.part(sphere(0.014, 8, 6), mInk, ph, { pos: [0.04 * sx, 0.02, 0.075], outline: false });
      }
      b.part(sphere(0.07, 12, 8), mWhite, pb, { pos: [0, 0.1, 0.1], scale: [0.8, 0.9, 0.6], outline: false });
      tail = group(pb, 0, 0.14, -0.14, "tail");
      b.part(sphere(0.09, 12, 8), fur, tail, { pos: [0, 0.04, -0.08], scale: [0.6, 0.6, 1.4] });
      b.part(sphere(0.05, 10, 8), mWhite, tail, { pos: [0, 0.06, -0.2], outline: false });
      for (const [x, z] of [[0.06, 0.07], [-0.06, 0.07], [0.06, -0.07], [-0.06, -0.07]] as const) b.part(capsule(0.025, 0.04), fur, pb, { pos: [x, 0.03, z] });
    } else if (outfit.pet === "owl") {
      const f = kit.toon("#8a6a4a");
      b.part(sphere(0.13, 16, 12), f, pb, { pos: [0, 0.14, 0], scale: [1, 1.15, 0.95] });
      b.part(sphere(0.09, 12, 10), kit.toon("#e9dcc4"), pb, { pos: [0, 0.1, 0.07], scale: [0.9, 1, 0.5], outline: false });
      ph.position.set(0, 0.25, 0.02);
      for (const sx of [1, -1]) {
        b.part(sphere(0.04, 12, 10), mWhite, ph, { pos: [0.045 * sx, 0.0, 0.085] });
        b.part(sphere(0.022, 10, 8), kit.basic("#e0a020"), ph, { pos: [0.045 * sx, 0.0, 0.115], outline: false });
        b.part(new ConeGeometry(0.025, 0.06, 4), f, ph, { pos: [0.07 * sx, 0.07, 0], rot: [0, 0, -0.4 * sx] });
        b.part(sphere(0.07, 10, 8), f, pb, { pos: [0.12 * sx, 0.13, -0.01], scale: [0.35, 0.9, 0.7] });
      }
      b.part(new ConeGeometry(0.018, 0.04, 4), kit.toon("#e0a020"), ph, { pos: [0, -0.04, 0.11], rot: [Math.PI / 2 + 0.6, 0, 0], outline: false });
    } else {
      const f = kit.toon("#5bb04a");
      b.part(sphere(0.12, 16, 12), f, pb, { pos: [0, 0.09, 0], scale: [1.15, 0.75, 1] });
      ph.position.set(0, 0.13, 0.05);
      for (const sx of [1, -1]) {
        b.part(sphere(0.04, 12, 10), f, ph, { pos: [0.06 * sx, 0.04, 0.02] });
        b.part(sphere(0.026, 10, 8), mWhite, ph, { pos: [0.06 * sx, 0.05, 0.05], outline: false });
        b.part(sphere(0.013, 8, 6), mInk, ph, { pos: [0.06 * sx, 0.05, 0.07], outline: false });
        b.part(sphere(0.05, 10, 8), f, pb, { pos: [0.1 * sx, 0.02, -0.03], scale: [1, 0.5, 1.4] });
      }
      b.part(new TorusGeometry(0.04, 0.006, 4, 12, Math.PI), mInk, ph, { pos: [0, -0.01, 0.1], rot: [0, 0, Math.PI], outline: false });
    }
    pet = { group: g, body: pb, head: ph, tail, kind: outfit.pet };
  }

  const rig: Rig = {
    object, root, pivot, hips, spine, neck, head,
    shoulderL: AL.shoulder, shoulderR: AR.shoulder, elbowL: AL.elbow, elbowR: AR.elbow, handL: AL.hand, handR: AR.hand,
    thighL: L.thigh, thighR: R.thigh, kneeL: L.knee, kneeR: R.knee, footL: L.foot, footR: R.foot,
    eyeL: EL.g, eyeR: ER.g, pupilL: EL.pupil, pupilR: ER.pupil, browL, browR, mouthArc, mouthOpen,
    hat, halo, bow, held, coin, cape, wings, pet,
    hitMeshes: b.hit,
    outfit,
    dispose() {
      for (const g of b.geos) g.dispose();
      object.removeFromParent();
    },
  };
  for (const g of [AL.shoulder, AR.shoulder, L.thigh, R.thigh]) g.rotation.order = "XZY";
  for (const g of [spine, neck, head, pivot]) g.rotation.order = "YXZ";
  return rig;
}

const _a = new Vector3();
const _b = new Vector3();
const _up = new Vector3(0, 1, 0);

function stretchBetween(mesh: Mesh, from: Vector3, to: Vector3) {
  _a.copy(to).sub(from);
  const len = _a.length();
  mesh.position.copy(from).addScaledVector(_a, 0.5);
  mesh.scale.set(1, Math.max(0.0001, len), 1);
  mesh.quaternion.setFromUnitVectors(_up, _a.normalize());
}

/**
 * Pose → Euler, every frame. `t` is the stage clock in seconds, for the parts
 * that move on their own (cape ripple, halo, wings, pet).
 */
export function applyPose(rig: Rig, p: Pose, t: number, extraYaw = 0, reacting = 0) {
  rig.root.position.set(p.rootX, p.rootY, p.rootZ);
  const sq = Math.max(-0.4, Math.min(0.4, p.squash));
  rig.root.scale.set(1 - sq * 0.5, 1 + sq, 1 - sq * 0.5);
  rig.pivot.rotation.set(p.rootPitch, p.rootYaw + extraYaw, p.rootRoll);
  rig.hips.rotation.set(0, p.hipsYaw, -p.hipsRoll);
  rig.spine.rotation.set(p.lean, p.twist, -p.side);
  rig.neck.rotation.set(p.nod * 0.35, p.turn * 0.35, -p.tilt * 0.35);
  rig.head.rotation.set(p.nod * 0.65, p.turn * 0.65, -p.tilt * 0.65);

  rig.shoulderL.rotation.set(-p.lFwd, p.lTwist, p.lOut);
  rig.shoulderR.rotation.set(-p.rFwd, -p.rTwist, -p.rOut);
  rig.elbowL.rotation.x = -p.lBend;
  rig.elbowR.rotation.x = -p.rBend;
  rig.handL.rotation.x = -p.lWrist;
  rig.handR.rotation.x = -p.rWrist;

  rig.thighL.rotation.set(-p.lLeg, 0, p.lLegOut);
  rig.thighR.rotation.set(-p.rLeg, 0, -p.rLegOut);
  rig.kneeL.rotation.x = p.lKnee;
  rig.kneeR.rotation.x = p.rKnee;
  rig.footL.rotation.x = p.lFoot;
  rig.footR.rotation.x = p.rFoot;

  // face
  const open = Math.max(0.08, 1 - Math.min(1, Math.max(0, p.blink)));
  rig.eyeL.scale.y = open;
  rig.eyeR.scale.y = open;
  const lx = Math.max(-1, Math.min(1, p.lookX)) * 0.017;
  const ly = Math.max(-1, Math.min(1, p.lookY)) * 0.016;
  rig.pupilL.position.set(lx, ly, 0.022);
  rig.pupilR.position.set(lx, ly, 0.022);
  const brow = Math.max(-1, Math.min(1, p.brow));
  rig.browL.position.y = 0.12 + brow * 0.022;
  rig.browR.position.y = 0.12 + brow * 0.022;
  rig.browL.rotation.z = -brow * 0.32;
  rig.browR.rotation.z = brow * 0.32;
  const smile = Math.max(-1, Math.min(1, p.smile));
  rig.mouthArc.rotation.z = smile >= 0 ? Math.PI : 0;
  rig.mouthArc.position.y = smile >= 0 ? -0.12 : -0.155;
  rig.mouthArc.scale.set(1 + smile * 0.18, 0.18 + Math.abs(smile) * 0.82, 1);
  const mouth = Math.max(0, Math.min(1, p.mouth));
  rig.mouthOpen.visible = mouth > 0.03;
  rig.mouthOpen.scale.set(0.7 + mouth * 0.3, 0.05 + mouth * 0.95, 1);

  // hat
  rig.hat.rotation.x = p.hatTip;
  rig.hat.position.set(0, Math.max(0, -p.hatTip) * 0.1, Math.max(0, -p.hatTip) * 0.04);
  if (rig.halo) {
    rig.halo.position.y = 0.47 + Math.sin(t * 2.2) * 0.02;
    rig.halo.rotation.y = t * 0.8;
  }

  // the bow: slung on the back until it is drawn, then in the left hand
  if (rig.bow) {
    const aiming = p.arrow > 0.3 || p.bowDraw > 0.05;
    rig.bow.hand.visible = aiming;
    rig.bow.back.visible = !aiming;
    const nock = _b.set(0, 0.08 + Math.max(0, Math.min(1, p.bowDraw)) * 0.4, 0);
    stretchBetween(rig.bow.stringTop, rig.bow.top, nock);
    stretchBetween(rig.bow.stringBottom, rig.bow.bottom, nock);
    rig.bow.arrow.visible = aiming && p.arrow > 0.5;
    rig.bow.arrow.position.set(0, nock.y - 0.3, 0.01);
  }
  if (rig.held) rig.held.rotation.y = p.propSpin;
  const lift = Math.max(0, p.propLift);
  rig.coin.visible = lift > 0.02;
  if (rig.coin.visible) {
    // A tossing hand is raised forward, so the hand's local +z is roughly world up.
    rig.coin.position.set(0, -0.06 - lift * 0.05, 0.06 + lift * 0.55);
    rig.coin.rotation.set(Math.PI / 2 + t * 18, 0, 0);
  }

  // cape ripple
  if (rig.cape) {
    const pos = rig.cape.mesh.geometry.getAttribute("position") as BufferAttribute;
    const arr = pos.array as Float32Array;
    const rest = rig.cape.rest;
    const lift2 = Math.max(0, Math.min(1.2, p.capeLift));
    for (let i = 0; i < arr.length; i += 3) {
      const x = rest[i]!;
      const y = rest[i + 1]!;
      const d = -y / rig.cape.length;
      arr[i + 2] = rest[i + 2]! - d * d * (0.08 + lift2 * 0.38) - Math.sin(t * 3.1 + d * 5 + x * 4) * 0.018 * d;
      arr[i + 1] = y + d * d * lift2 * 0.12;
      arr[i] = x * (1 + d * 0.25);
    }
    pos.needsUpdate = true;
    rig.cape.mesh.geometry.computeVertexNormals();
  }

  if (rig.wings) {
    const flap = Math.sin(t * (p.rootY > 0.05 ? 16 : 2.4)) * (p.rootY > 0.05 ? 0.5 : 0.12);
    rig.wings[0].rotation.y = -0.3 - flap;
    rig.wings[1].rotation.y = 0.3 + flap;
  }

  if (rig.pet) {
    const sleeping = p.blink > 0.95 && p.rootY < -0.2;
    const hopY = reacting > 0 ? Math.abs(Math.sin(t * 10)) * 0.12 * reacting : 0;
    rig.pet.body.position.y = sleeping ? 0 : Math.abs(Math.sin(t * 2.2)) * 0.015 + hopY;
    rig.pet.body.scale.y = sleeping ? 0.85 : 1 + Math.sin(t * 2.2) * 0.02;
    rig.pet.head.rotation.set(sleeping ? 0.5 : Math.sin(t * 0.7) * 0.15, sleeping ? 0 : -0.6 + Math.sin(t * 0.5) * 0.4, sleeping ? 0.3 : Math.sin(t * 0.9) * 0.1);
    if (rig.pet.tail) rig.pet.tail.rotation.y = Math.sin(t * (reacting > 0 ? 14 : 4)) * 0.5;
  }
}

/** A glyph or glow as a texture, for Z's, notes, sparkles and fireflies. */
export function glyphTexture(text: string, color: string, size = 96): CanvasTexture | null {
  if (typeof document === "undefined") return null;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  if (!g) return null;
  if (text === "glow") {
    const grad = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    grad.addColorStop(0, color);
    grad.addColorStop(0.35, color);
    grad.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = grad;
    g.fillRect(0, 0, size, size);
  } else {
    g.font = `800 ${Math.round(size * 0.72)}px "DM Sans", system-ui, sans-serif`;
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.lineWidth = size * 0.09;
    g.strokeStyle = "#120f12";
    g.strokeText(text, size / 2, size / 2 + size * 0.04);
    g.fillStyle = color;
    g.fillText(text, size / 2, size / 2 + size * 0.04);
  }
  const tex = new CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}
