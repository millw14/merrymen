/**
 * THE MERRYMAN, BUILT FROM PRIMITIVES.
 *
 * No model file, no loader, no licence to track: every part of the character is
 * a sphere, capsule, cone, lathe or tube, so the whole wardrobe is code and a
 * new hat is a function. Toon shading with a three-step ramp and an inked
 * outline keep it reading as a character at 40 pixels and at 400.
 *
 * buildRig owns the skeleton and hands each region to its module, all through
 * one Builder (so every geometry is tracked and disposed): body.ts (hips, legs,
 * torso by style, arms, hands), face.ts (neck, head, face, hair, facial hair,
 * eyewear) and gear.ts (hats, held props, back items, cape, pet).
 *
 * The skeleton is a tree of Groups — root → pivot → hips → spine → neck → head,
 * shoulders → elbows → hands, thighs → knees → feet — and `applyPose` is the
 * one place a semantic Pose (pose.ts) becomes Euler angles, including every
 * mirror sign for the right side.
 */
import {
  BackSide,
  BufferAttribute,
  CanvasTexture,
  Color,
  DataTexture,
  DoubleSide,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshToonMaterial,
  NearestFilter,
  Object3D,
  RedFormat,
  Vector3,
  type BufferGeometry,
  type Material,
} from "three";
import { buildBody } from "./body";
import { buildFace } from "./face";
import { buildGear } from "./gear";
import type { Outfit } from "./outfit";
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

export function buildRig(outfit: Outfit, kit: Kit): Rig {
  const b = builder(kit);

  const object = new Group();
  object.name = "merryman";
  const root = group(object, 0, 0, 0, "root");
  const pivot = group(root, 0, 0.75, 0, "pivot");
  const body = group(pivot, 0, -0.75, 0, "body");

  // hips, legs, torso by style, arms and hands (body.ts)
  const { hips, spine, L, R, AL, AR } = buildBody(b, outfit, body);

  // neck, head, face, hair, facial hair and eyewear (face.ts)
  const neck = group(spine, 0, 0.37, 0, "neck");
  const head = group(neck, 0, 0.28, 0, "head");
  const face = buildFace(b, neck, head, outfit);

  // hats, held props, back items, cape and pet (gear.ts)
  const { hat, halo, bow, held, coin, cape, wings, pet } =
    buildGear(b, outfit, { object, spine, head, handL: AL.hand, handR: AR.hand });

  const rig: Rig = {
    object, root, pivot, hips, spine, neck, head,
    shoulderL: AL.shoulder, shoulderR: AR.shoulder, elbowL: AL.elbow, elbowR: AR.elbow, handL: AL.hand, handR: AR.hand,
    thighL: L.thigh, thighR: R.thigh, kneeL: L.knee, kneeR: R.knee, footL: L.foot, footR: R.foot,
    eyeL: face.eyeL, eyeR: face.eyeR, pupilL: face.pupilL, pupilR: face.pupilR, browL: face.browL, browR: face.browR,
    mouthArc: face.mouthArc, mouthOpen: face.mouthOpen,
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
