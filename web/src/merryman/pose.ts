/**
 * A MERRYMAN'S BODY AS A FLAT LIST OF NUMBERS.
 *
 * Every animation writes the same named numbers and the renderer reads them,
 * which is what lets two clips blend: a crossfade is a lerp over this list and
 * nothing else. The values are SEMANTIC rather than raw Euler angles — `lFwd`
 * is "left arm raised forward", whichever axis and sign that is on the rig —
 * so a clip reads like choreography and the mirror maths lives in one place
 * (rig.ts `applyPose`).
 *
 * All angles are radians. Rest is every key at zero, except the face, whose
 * rest is eyes open and a neutral mouth (also zero).
 */

export const POSE_KEYS = [
  // whole body
  "rootX", "rootY", "rootZ", "rootYaw", "rootPitch", "rootRoll", "squash",
  // hips and spine
  "hipsYaw", "hipsRoll", "lean", "twist", "side",
  // head
  "nod", "turn", "tilt",
  // arms: forward raise, outward raise, twist, elbow bend, wrist
  "lFwd", "lOut", "lTwist", "lBend", "lWrist",
  "rFwd", "rOut", "rTwist", "rBend", "rWrist",
  // legs: forward swing, outward swing, knee bend, foot
  "lLeg", "lLegOut", "lKnee", "lFoot",
  "rLeg", "rLegOut", "rKnee", "rFoot",
  // face: blink (1 = shut), mouth open, smile (-1 frown .. 1 grin), brow (-1 cross .. 1 raised), eye look
  "blink", "mouth", "smile", "brow", "lookX", "lookY",
  // props and cloth
  "bowDraw", "arrow", "propSpin", "propLift", "hatTip", "capeLift",
] as const;

export type PoseKey = (typeof POSE_KEYS)[number];
export type Pose = Record<PoseKey, number>;

export function restPose(): Pose {
  const p = {} as Pose;
  for (const k of POSE_KEYS) p[k] = 0;
  return p;
}

export function copyPose(into: Pose, from: Pose): Pose {
  for (const k of POSE_KEYS) into[k] = from[k];
  return into;
}

/** `into = into * (1 - w) + other * w`, key by key. */
export function blendPose(into: Pose, other: Pose, w: number): Pose {
  if (w <= 0) return into;
  if (w >= 1) return copyPose(into, other);
  for (const k of POSE_KEYS) into[k] += (other[k] - into[k]) * w;
  return into;
}

/** Overlay an additive layer (breathing, look-at) onto a pose. */
export function addPose(into: Pose, layer: Partial<Pose>, w = 1): Pose {
  for (const k in layer) into[k as PoseKey] += (layer[k as PoseKey] ?? 0) * w;
  return into;
}

// ── easing and shaping, shared by every clip ─────────────────────────────

export const TAU = Math.PI * 2;
export const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const smooth = (x: number) => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};
export const easeOut = (x: number) => 1 - (1 - clamp01(x)) ** 3;
export const easeIn = (x: number) => clamp01(x) ** 3;
export const easeInOut = (x: number) => {
  const t = clamp01(x);
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
};
/** Overshoot then settle — the "boing" of a cartoon landing. */
export const backOut = (x: number) => {
  const t = clamp01(x) - 1;
  return 1 + 2.70158 * t * t * t + 1.70158 * t * t;
};
/** 0 → 1 → 0 across [a, b], smooth at both ends. */
export const bump = (x: number, a: number, b: number) => {
  if (x <= a || x >= b) return 0;
  return Math.sin(((x - a) / (b - a)) * Math.PI);
};
/** Smoothly 0 before `a`, 1 after `b`. */
export const ramp = (x: number, a: number, b: number) => smooth((x - a) / (b - a));
/** A keyframe track: [[t, v], ...] sorted by t, eased between neighbours. */
export function track(x: number, keys: readonly (readonly [number, number])[]): number {
  if (keys.length === 0) return 0;
  if (x <= keys[0]![0]) return keys[0]![1];
  for (let i = 1; i < keys.length; i++) {
    const [t1, v1] = keys[i]!;
    if (x <= t1) {
      const [t0, v0] = keys[i - 1]!;
      return v0 + (v1 - v0) * easeInOut((x - t0) / (t1 - t0 || 1));
    }
  }
  return keys[keys.length - 1]![1];
}
