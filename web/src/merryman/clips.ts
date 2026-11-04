/**
 * EVERY MOVE A MERRYMAN KNOWS.
 *
 * A clip is a pure function of time: `sample(pose, t)` writes the pose for the
 * instant `t` seconds into the clip, starting from rest. Nothing is integrated
 * frame to frame — the same rule the nanite transition follows — so a dropped
 * frame costs nothing, a tab returning from the background resumes mid-move,
 * and a test can sample any instant.
 *
 * Loops are the merryman's STATE (napping because trading is paused, scouting
 * because it is live); one-shots are EVENTS (an arrow loosed because a buy
 * landed, a coin flipped because a sale closed in profit). Stage.ts plays a
 * loop as the base layer and a one-shot over it, crossfading both ways.
 *
 * Conventions (see pose.ts): arm `Fwd` raises the arm forward, `Out` raises it
 * out to the side, `Bend` folds the elbow forward; leg `Leg` swings forward and
 * `Knee` folds the shin back. `side` leans toward the merryman's own left.
 */
import {
  TAU,
  backOut,
  bump,
  clamp01,
  easeInOut,
  easeOut,
  ramp,
  smooth,
  track,
  type Pose,
} from "./pose";

export type Fx =
  | "confetti" | "arrow" | "coin" | "coins" | "z" | "question" | "note" | "drop"
  | "stars" | "spark" | "heart" | "exclaim" | "puff" | "sparkles" | "shield";

export type Clip = {
  id: string;
  label: string;
  /** A loop is a state the merryman sits in; a one-shot plays once and hands back. */
  loop: boolean;
  /** Seconds — the loop period for a loop, the whole move for a one-shot. */
  duration: number;
  /** Offered in the emote picker. Internal clips (hop, poses) are not. */
  emote?: boolean;
  /** One-shot effects at fixed instants. */
  cues?: readonly { at: number; fx: Fx }[];
  /** Loop effects every `every` seconds. */
  emit?: { fx: Fx; every: number; offset?: number };
  sample(p: Pose, t: number, seed: number): void;
};

type Side = "l" | "r";
function arm(p: Pose, s: Side, fwd: number, out: number, bend = 0.15, twist = 0, wrist = 0) {
  if (s === "l") { p.lFwd = fwd; p.lOut = out; p.lBend = bend; p.lTwist = twist; p.lWrist = wrist; }
  else { p.rFwd = fwd; p.rOut = out; p.rBend = bend; p.rTwist = twist; p.rWrist = wrist; }
}
function leg(p: Pose, s: Side, swing: number, knee = 0, out = 0, foot = 0) {
  if (s === "l") { p.lLeg = swing; p.lKnee = knee; p.lLegOut = out; p.lFoot = foot; }
  else { p.rLeg = swing; p.rKnee = knee; p.rLegOut = out; p.rFoot = foot; }
}
/** The small motions every living pose carries: breath, a weight shift, a drifting gaze. */
function alive(p: Pose, t: number, seed: number, amount = 1) {
  const ph = seed * 1.7;
  p.squash += Math.sin(t * TAU / 3.4 + ph) * 0.012 * amount;
  p.lean += Math.sin(t * TAU / 3.4 + ph + 0.6) * 0.015 * amount;
  p.hipsRoll += Math.sin(t * TAU / 7 + ph) * 0.025 * amount;
  p.turn += Math.sin(t * 0.41 + ph) * 0.07 * amount;
  p.nod += Math.sin(t * 0.53 + ph * 2) * 0.03 * amount;
  p.lookX += Math.sin(t * 0.31 + ph) * 0.25 * amount;
}
/** Relaxed arms at the sides, swaying a little with the breath. */
function restArms(p: Pose, t: number, seed: number) {
  const sway = Math.sin(t * TAU / 3.4 + seed) * 0.03;
  arm(p, "l", 0.05 + sway, 0.14, 0.2);
  arm(p, "r", 0.05 - sway, 0.14, 0.2);
}
/** A hop of `height` across [a, b] seconds with anticipation and landing squash. */
function hop(p: Pose, t: number, a: number, b: number, height: number) {
  const pre = 0.12;
  if (t > a - pre && t < a) p.squash -= bump(t, a - pre, a + 0.02) * 0.12;
  if (t >= a && t <= b) {
    const x = (t - a) / (b - a);
    p.rootY += 4 * height * x * (1 - x);
    p.squash += (x < 0.3 ? 0.08 : 0) * bump(x, 0, 0.3);
    p.capeLift += 0.6;
  }
  if (t > b && t < b + 0.18) p.squash -= bump(t, b - 0.01, b + 0.18) * 0.14;
}
/** Ease a one-shot in from rest and back out to it, so it blends with any base. */
const envelope = (t: number, dur: number, edge = 0.22) => Math.min(ramp(t, 0, edge), 1 - ramp(t, dur - edge, dur));

// ── LOOPS: the states ────────────────────────────────────────────────────

const idle: Clip = {
  id: "idle", label: "Idle", loop: true, duration: 6.8,
  sample(p, t, seed) {
    alive(p, t, seed);
    restArms(p, t, seed);
    p.smile = 0.35;
  },
};

const happy: Clip = {
  id: "happy", label: "Bouncy", loop: true, duration: 1.25, emote: true,
  sample(p, t, seed) {
    const b = Math.abs(Math.sin((t / 1.25) * TAU));
    p.rootY = b * 0.045;
    p.squash = (1 - b) * -0.03 + b * 0.02;
    p.tilt = Math.sin((t / 1.25) * TAU) * 0.08;
    p.side = Math.sin((t / 1.25) * TAU) * 0.04;
    arm(p, "l", 0.2 + b * 0.25, 0.35 + b * 0.15, 0.6);
    arm(p, "r", 0.2 + b * 0.25, 0.35 + b * 0.15, 0.6);
    p.smile = 0.9;
    p.brow = 0.3;
    p.lookX = Math.sin(t * 0.5 + seed) * 0.2;
    p.capeLift = b * 0.2;
  },
};

const scout: Clip = {
  id: "scout", label: "Scout", loop: true, duration: 6, emote: true,
  sample(p, t, seed) {
    alive(p, t, seed, 0.6);
    const sweep = Math.sin((t / 6) * TAU);
    p.turn = sweep * 0.65;
    p.twist = sweep * 0.18;
    p.lean = 0.08;
    p.nod = -0.05;
    p.lookX = sweep * 0.6;
    arm(p, "r", 2.15, 0.55, 2.25, 0.1, -0.2);
    arm(p, "l", 0.15, 0.18, 0.3);
    p.brow = 0.35;
    p.smile = 0.15;
    leg(p, "l", 0.05, 0.08);
    leg(p, "r", -0.08, 0.12, 0, 0.05);
  },
};

const think: Clip = {
  id: "think", label: "Think", loop: true, duration: 4.4, emote: true,
  emit: { fx: "question", every: 2.6, offset: 0.4 },
  sample(p, t, seed) {
    alive(p, t, seed, 0.5);
    arm(p, "r", 1.25, 0.12, 2.45, 0.35, -0.3 + Math.sin(t * 9) * 0.08);
    arm(p, "l", 0.95, -0.1, 1.55, -0.2);
    p.tilt = 0.16 + Math.sin(t * 0.8) * 0.04;
    p.nod = -0.08;
    p.lookY = 0.45;
    p.lookX = -0.3 + Math.sin(t * 0.7 + seed) * 0.25;
    p.brow = -0.25 + Math.sin(t * 1.3) * 0.25;
    p.smile = -0.05;
    p.mouth = 0.05;
  },
};

const talk: Clip = {
  id: "talk", label: "Chat", loop: true, duration: 3.2, emote: true,
  sample(p, t, seed) {
    alive(p, t, seed, 0.6);
    const g = (t / 3.2) * TAU;
    arm(p, "r", 0.7 + Math.sin(g) * 0.35, 0.3 + Math.sin(g * 2) * 0.12, 1.4 + Math.sin(g * 1.5) * 0.3, -0.5);
    arm(p, "l", 0.45 + Math.sin(g + 2) * 0.25, 0.22, 1.1 + Math.sin(g * 2 + 1) * 0.3, 0.4);
    p.nod = Math.sin(g * 3) * 0.06;
    p.tilt = Math.sin(g) * 0.08;
    const syll = Math.max(0, Math.sin(t * 15 + Math.sin(t * 3.1) * 2));
    p.mouth = syll * 0.7 * (0.6 + 0.4 * Math.sin(t * 1.7) ** 2);
    p.smile = 0.5;
    p.brow = Math.sin(g * 2) * 0.35;
  },
};

const sleep: Clip = {
  id: "sleep", label: "Nap", loop: true, duration: 4, emote: true,
  emit: { fx: "z", every: 1.4 },
  sample(p, t) {
    const br = Math.sin((t / 4) * TAU);
    p.rootY = -0.36;
    leg(p, "l", 1.45, 1.35, 0.18, -0.2);
    leg(p, "r", 1.45, 1.35, 0.18, -0.2);
    p.lean = 0.28 + br * 0.03;
    p.nod = 0.45 + br * 0.06;
    p.tilt = 0.18;
    arm(p, "l", 0.7, 0.2, 0.7);
    arm(p, "r", 0.7, 0.2, 0.7);
    p.squash = br * 0.02;
    p.blink = 1;
    p.mouth = 0.12 + Math.max(0, br) * 0.12;
    p.smile = 0.1;
    p.hatTip = 0.25;
  },
};

const sad: Clip = {
  id: "sad", label: "Mope", loop: true, duration: 5, emote: true,
  emit: { fx: "drop", every: 3.2, offset: 1 },
  sample(p, t, seed) {
    alive(p, t, seed, 0.4);
    const sigh = bump(t % 5, 2.2, 3.4);
    p.lean = 0.22 + sigh * 0.06;
    p.nod = 0.38 + sigh * 0.08;
    p.squash = -0.025 - sigh * 0.02;
    arm(p, "l", 0.18, 0.05, 0.12);
    arm(p, "r", 0.18, 0.05, 0.12);
    p.smile = -0.85;
    p.brow = 0.55;
    p.lookY = -0.4;
    p.rootX = Math.sin(t * 0.6) * 0.01;
  },
};

const walk: Clip = {
  id: "walk", label: "Stroll", loop: true, duration: 1.1, emote: true,
  sample(p, t) {
    const g = (t / 1.1) * TAU;
    const s = Math.sin(g);
    leg(p, "l", s * 0.5, Math.max(0, -Math.cos(g)) * 0.7 + 0.05, 0, -s * 0.2);
    leg(p, "r", -s * 0.5, Math.max(0, Math.cos(g)) * 0.7 + 0.05, 0, s * 0.2);
    arm(p, "l", -s * 0.45, 0.12, 0.35);
    arm(p, "r", s * 0.45, 0.12, 0.35);
    p.rootY = Math.abs(Math.cos(g)) * 0.03;
    p.hipsYaw = s * 0.1;
    p.twist = -s * 0.08;
    p.lean = 0.05;
    p.smile = 0.5;
    p.capeLift = 0.25;
  },
};

const run: Clip = {
  id: "run", label: "Sprint", loop: true, duration: 0.62, emote: true,
  sample(p, t) {
    const g = (t / 0.62) * TAU;
    const s = Math.sin(g);
    leg(p, "l", s * 0.85, Math.max(0, -Math.cos(g)) * 1.5 + 0.2, 0, -s * 0.3);
    leg(p, "r", -s * 0.85, Math.max(0, Math.cos(g)) * 1.5 + 0.2, 0, s * 0.3);
    arm(p, "l", -s * 0.9, 0.18, 1.5);
    arm(p, "r", s * 0.9, 0.18, 1.5);
    p.rootY = Math.abs(Math.cos(g)) * 0.09;
    p.lean = 0.28;
    p.nod = -0.18;
    p.twist = -s * 0.14;
    p.mouth = 0.3;
    p.smile = 0.6;
    p.brow = -0.3;
    p.capeLift = 1;
  },
};

const jig: Clip = {
  id: "jig", label: "Jig", loop: true, duration: 1.2, emote: true,
  emit: { fx: "note", every: 0.9 },
  sample(p, t) {
    const g = (t / 1.2) * TAU;
    const left = Math.sin(g) > 0;
    const kick = Math.abs(Math.sin(g));
    p.rootY = Math.abs(Math.sin(g * 2)) * 0.06;
    leg(p, "l", left ? kick * 0.9 : -0.05, left ? 0.25 : 0.1, 0.05, left ? -0.4 : 0);
    leg(p, "r", left ? -0.05 : kick * 0.9, left ? 0.1 : 0.25, 0.05, left ? 0 : -0.4);
    arm(p, "l", -0.15, 0.75, 2.1, -1.2);
    arm(p, "r", -0.15, 0.75, 2.1, 1.2);
    p.side = Math.sin(g) * 0.1;
    p.nod = Math.sin(g * 2) * 0.08;
    p.tilt = -Math.sin(g) * 0.12;
    p.smile = 1;
    p.brow = 0.4;
    p.mouth = 0.25;
    p.capeLift = 0.4;
  },
};

const sway: Clip = {
  id: "sway", label: "Sway", loop: true, duration: 2, emote: true,
  emit: { fx: "note", every: 1.1, offset: 0.5 },
  sample(p, t) {
    const g = (t / 2) * TAU;
    const s = Math.sin(g);
    p.rootX = s * 0.05;
    p.hipsRoll = s * 0.12;
    p.side = -s * 0.14;
    p.squash = Math.abs(Math.sin(g * 2)) * -0.02;
    arm(p, "l", 0.25, 2.55 + Math.sin(g * 2) * 0.25, 0.35);
    arm(p, "r", 0.25, 2.55 - Math.sin(g * 2) * 0.25, 0.35);
    leg(p, "l", 0, Math.max(0, s) * 0.25, 0.06);
    leg(p, "r", 0, Math.max(0, -s) * 0.25, 0.06);
    p.tilt = s * 0.15;
    p.smile = 1;
    p.blink = 0.55;
  },
};

const robot: Clip = {
  id: "robot", label: "Robot", loop: true, duration: 2, emote: true,
  emit: { fx: "note", every: 1, offset: 0.2 },
  sample(p, t) {
    const step = Math.floor((t / 2) * 8) % 8;
    const pose = [
      [1.57, 0, 1.57, 0], [1.57, 0, 0, 1.57], [0, 1.57, 0, 1.57], [0, 1.57, 1.57, 0],
      [1.57, 1.57, 1.57, 1.57], [0.3, 0.3, 1.57, 0], [1.57, 0, 0.3, 0.3], [0.8, 0.8, 0.8, 0.8],
    ][step]!;
    arm(p, "l", pose[0]!, 0.25, pose[1]! + 0.2);
    arm(p, "r", pose[2]!, 0.25, pose[3]! + 0.2);
    p.turn = [0, 0.5, 0, -0.5, 0, 0.5, 0, -0.5][step]!;
    p.rootY = step % 2 ? 0.02 : 0;
    p.squash = step % 2 ? -0.02 : 0.01;
    leg(p, "l", 0, step % 4 === 1 ? 0.4 : 0);
    leg(p, "r", 0, step % 4 === 3 ? 0.4 : 0);
    p.smile = 0.2;
    p.brow = -0.2;
  },
};

const guard: Clip = {
  id: "guard", label: "On guard", loop: true, duration: 2.2, emote: true,
  emit: { fx: "shield", every: 2.2 },
  sample(p, t) {
    const b = Math.sin((t / 2.2) * TAU);
    p.rootY = -0.05 + b * 0.012;
    leg(p, "l", 0.25, 0.35, 0.22);
    leg(p, "r", -0.2, 0.35, 0.22);
    p.lean = 0.12;
    arm(p, "l", 1.45, 0.2, 1.45, 0.3);
    arm(p, "r", 0.4, 0.35, 1.6, -0.3);
    p.twist = 0.12;
    p.brow = -0.65;
    p.smile = -0.2;
    p.turn = b * 0.08;
  },
};

const meditate: Clip = {
  id: "meditate", label: "Meditate", loop: true, duration: 4.5, emote: true,
  emit: { fx: "sparkles", every: 1.6 },
  sample(p, t) {
    const f = Math.sin((t / 4.5) * TAU);
    p.rootY = 0.12 + f * 0.05;
    leg(p, "l", 1.35, 2.3, 0.85, 0.4);
    leg(p, "r", 1.35, 2.3, 0.85, 0.4);
    arm(p, "l", 0.55, 0.55, 0.9, 0, 0.5);
    arm(p, "r", 0.55, 0.55, 0.9, 0, 0.5);
    p.lean = -0.02;
    p.blink = 1;
    p.smile = 0.5;
    p.nod = f * 0.02;
    p.squash = f * 0.015;
  },
};

const aim: Clip = {
  id: "aim", label: "Take aim", loop: true, duration: 5, emote: true,
  sample(p, t, seed) {
    const sweep = Math.sin((t / 5) * TAU);
    p.rootYaw = -0.55 + sweep * 0.2;
    p.turn = 0.5 + sweep * 0.1;
    p.twist = 0.15;
    arm(p, "l", 1.5, 0.18, 0.05, 0, 0);
    arm(p, "r", 1.45, -0.05, 2.35, 0.1, 0);
    p.bowDraw = 0.65 + Math.sin(t * 2.3 + seed) * 0.04;
    p.arrow = 1;
    leg(p, "l", 0.25, 0.12, 0.12);
    leg(p, "r", -0.2, 0.18, 0.12);
    p.brow = -0.45;
    p.smile = 0.1;
    p.lookX = 0.2;
  },
};

const sit: Clip = {
  id: "sit", label: "Sit", loop: true, duration: 3, emote: true,
  sample(p, t, seed) {
    const s = Math.sin((t / 3) * TAU);
    p.rootY = -0.37;
    leg(p, "l", 1.35 + s * 0.12, 0.65 + s * 0.2);
    leg(p, "r", 1.35 - s * 0.12, 0.65 - s * 0.2);
    p.lean = -0.18;
    arm(p, "l", -0.5, 0.35, 0.05);
    arm(p, "r", -0.5, 0.35, 0.05);
    p.turn = Math.sin(t * 0.4 + seed) * 0.15;
    p.smile = 0.6;
  },
};

const counting: Clip = {
  id: "counting", label: "Count coins", loop: true, duration: 1.6, emote: true,
  emit: { fx: "coin", every: 1.6, offset: 0.2 },
  sample(p, t) {
    const g = (t / 1.6) * TAU;
    arm(p, "l", 0.95, 0.15, 1.3);
    arm(p, "r", 0.95 + Math.max(0, Math.sin(g)) * 0.25, 0.15, 1.3, 0, Math.max(0, Math.sin(g)) * 0.6);
    p.nod = 0.35;
    p.lookY = -0.4;
    p.mouth = Math.max(0, Math.sin(t * 9)) * 0.3;
    p.smile = 0.75;
    p.propLift = Math.max(0, Math.sin(g));
  },
};

/** Calling you over: a big overhead wave every few seconds, then waiting. */
const beckon: Clip = {
  id: "beckon", label: "Call you over", loop: true, duration: 3.6, emote: true,
  emit: { fx: "exclaim", every: 3.6, offset: 0.2 },
  sample(p, t, seed) {
    alive(p, t, seed, 0.5);
    const wave = bump(t, 0.1, 1.9);
    arm(p, "r", 0.3 * wave, 2.6 * wave + 0.14 * (1 - wave), 0.4 + Math.sin(t * 12) * 0.35 * wave, 0, Math.sin(t * 12 + 1) * 0.3 * wave);
    arm(p, "l", 0.05, 0.14, 0.2);
    p.rootY = Math.abs(Math.sin(t * 6)) * 0.03 * wave;
    p.tilt = -0.12 * wave;
    p.brow = 0.6;
    p.smile = 0.5;
    p.mouth = 0.25 * wave;
    p.lookX = 0;
  },
};

// ── ONE-SHOTS: the events ────────────────────────────────────────────────

const wave: Clip = {
  id: "wave", label: "Wave", loop: false, duration: 2.2, emote: true,
  sample(p, t, seed) {
    const e = envelope(t, 2.2, 0.3);
    alive(p, t, seed, 0.5);
    arm(p, "l", 0.05, 0.15, 0.2);
    p.rFwd = 0.35 * e;
    p.rOut = 2.45 * e;
    p.rBend = (0.35 + Math.sin(t * 13) * 0.4) * e;
    p.rWrist = Math.sin(t * 13 + 1) * 0.3 * e;
    p.tilt = -0.14 * e;
    p.side = 0.05 * e;
    p.smile = 0.4 + 0.6 * e;
    p.brow = 0.5 * e;
  },
};

const jump: Clip = {
  id: "jump", label: "Jump", loop: false, duration: 1.1, emote: true,
  sample(p, t) {
    hop(p, t, 0.25, 0.75, 0.55);
    const air = bump(t, 0.2, 0.8);
    const e = envelope(t, 1.1, 0.2);
    arm(p, "l", (0.4 + air * 1.2) * e, (0.6 + air * 1.2) * e, 0.4 * e);
    arm(p, "r", (0.4 + air * 1.2) * e, (0.6 + air * 1.2) * e, 0.4 * e);
    leg(p, "l", air * 0.5, air * 1.0);
    leg(p, "r", air * 0.3, air * 0.8);
    p.lean = -bump(t, 0.05, 0.3) * -0.25 - air * 0.1;
    p.smile = 0.8;
    p.mouth = air * 0.5;
    p.brow = air * 0.6;
  },
};

const celebrate: Clip = {
  id: "celebrate", label: "Celebrate", loop: false, duration: 2.6, emote: true,
  cues: [{ at: 0.45, fx: "confetti" }, { at: 1.45, fx: "confetti" }],
  sample(p, t) {
    hop(p, t, 0.3, 0.85, 0.6);
    hop(p, t, 1.3, 1.85, 0.45);
    const e = envelope(t, 2.6, 0.25);
    const pump = Math.sin(t * 11) * 0.2;
    arm(p, "l", 0.3 * e, (2.6 + pump) * e, 0.25 * e);
    arm(p, "r", 0.3 * e, (2.6 - pump) * e, 0.25 * e);
    const air = bump(t, 0.25, 0.9) + bump(t, 1.25, 1.9);
    leg(p, "l", air * 0.6, air * 1.1);
    leg(p, "r", air * 0.2, air * 0.6);
    p.rootYaw = smooth((t - 1.3) / 0.55) * TAU;
    p.smile = 1;
    p.mouth = 0.55 * e;
    p.brow = 0.8 * e;
    p.blink = 0.5 * e;
  },
};

const backflip: Clip = {
  id: "backflip", label: "Backflip", loop: false, duration: 1.6, emote: true,
  cues: [{ at: 1.18, fx: "sparkles" }],
  sample(p, t) {
    const crouch = bump(t, 0, 0.42);
    p.rootY -= crouch * 0.1;
    p.squash -= crouch * 0.1;
    if (t > 0.35 && t < 1.15) {
      const x = (t - 0.35) / 0.8;
      p.rootY += 4 * 0.8 * x * (1 - x);
      p.rootPitch = -easeInOut(x) * TAU;
      leg(p, "l", 1.3 * bump(x, 0, 1), 2 * bump(x, 0, 1));
      leg(p, "r", 1.3 * bump(x, 0, 1), 2 * bump(x, 0, 1));
      arm(p, "l", 1.2 * bump(x, 0, 1), 0.4, 1.5 * bump(x, 0, 1));
      arm(p, "r", 1.2 * bump(x, 0, 1), 0.4, 1.5 * bump(x, 0, 1));
      p.capeLift = 1;
    }
    const land = bump(t, 1.12, 1.4);
    p.squash -= land * 0.12;
    arm(p, "l", p.lFwd, p.lOut + land * 1.6, p.lBend);
    arm(p, "r", p.rFwd, p.rOut + land * 1.6, p.rBend);
    p.smile = 0.9;
    p.mouth = bump(t, 0.3, 1.2) * 0.4;
  },
};

const spin: Clip = {
  id: "spin", label: "Twirl", loop: false, duration: 1.3, emote: true,
  sample(p, t) {
    const x = clamp01((t - 0.1) / 1.05);
    p.rootYaw = easeInOut(x) * TAU;
    const e = bump(t, 0, 1.3);
    arm(p, "l", 0.1, 1.5 * e, 0.2);
    arm(p, "r", 0.1, 1.5 * e, 0.2);
    p.rootY = e * 0.05;
    leg(p, "l", 0, e * 0.6, 0.1);
    p.capeLift = e;
    p.smile = 0.9;
    p.tilt = e * 0.12;
  },
};

const courtesy: Clip = {
  id: "courtesy", label: "Take a bow", loop: false, duration: 2.2, emote: true,
  sample(p, t) {
    const e = track(t, [[0, 0], [0.5, 1], [1.4, 1], [2.1, 0]]);
    p.lean = 0.85 * e;
    p.nod = 0.35 * e;
    arm(p, "r", 1.0 * e, -0.15 * e, 1.9 * e);
    arm(p, "l", 0.2 * e, 1.25 * e, 0.3);
    leg(p, "r", -0.35 * e, 0.25 * e);
    p.hatTip = -0.6 * e;
    p.smile = 0.7;
    p.blink = 0.7 * e;
  },
};

const shoot: Clip = {
  id: "shoot", label: "Loose an arrow", loop: false, duration: 2.1, emote: true,
  cues: [{ at: 1.2, fx: "arrow" }],
  sample(p, t) {
    const raise = track(t, [[0, 0], [0.4, 1], [1.6, 1], [2.1, 0]]);
    const draw = track(t, [[0.35, 0], [1.0, 1], [1.18, 1], [1.24, 0]]);
    const recoil = bump(t, 1.2, 1.55);
    p.rootYaw = -0.6 * raise;
    p.turn = 0.55 * raise;
    p.twist = 0.18 * raise;
    arm(p, "l", 1.52 * raise, 0.18 * raise, 0.05);
    arm(p, "r", (0.2 + 1.25 * raise) - recoil * 0.1, -0.05 * raise + recoil * 0.4, (0.3 + 2.0 * draw) * raise + recoil * 0.4);
    p.bowDraw = draw;
    p.arrow = t < 1.22 ? raise : 0;
    leg(p, "l", 0.25 * raise, 0.12 * raise, 0.12 * raise);
    leg(p, "r", -0.2 * raise, 0.18 * raise, 0.12 * raise);
    p.lean = -recoil * 0.05;
    p.brow = -0.55 * draw + recoil * 0.6;
    p.smile = recoil > 0 ? 0.9 : 0;
    p.blink = draw * 0.35;
  },
};

const coinToss: Clip = {
  id: "coinToss", label: "Flip a coin", loop: false, duration: 1.9, emote: true,
  cues: [{ at: 0.35, fx: "coin" }, { at: 1.3, fx: "coins" }],
  sample(p, t) {
    const e = envelope(t, 1.9, 0.25);
    const flick = bump(t, 0.2, 0.5);
    arm(p, "r", (0.85 + flick * 0.5) * e, 0.15 * e, 1.3 * e, 0, flick * 0.8);
    arm(p, "l", 0.1, 0.15, 0.2);
    const fly = clamp01((t - 0.35) / 0.95);
    p.propLift = 4 * fly * (1 - fly) * (t > 0.35 && t < 1.3 ? 1 : 0);
    p.nod = -0.35 * p.propLift;
    p.lookY = 0.6 * p.propLift;
    p.smile = t > 1.3 ? 1 : 0.4;
    p.brow = t > 1.3 ? 0.6 : 0.2;
    if (t > 1.3) hop(p, t, 1.35, 1.65, 0.12);
  },
};

const facepalm: Clip = {
  id: "facepalm", label: "Facepalm", loop: false, duration: 2.2, emote: true,
  cues: [{ at: 0.55, fx: "drop" }],
  sample(p, t) {
    const e = track(t, [[0, 0], [0.45, 1], [1.7, 1], [2.2, 0]]);
    arm(p, "r", 2.0 * e, 0.1 * e, 2.45 * e, 0.2 * e, -0.3 * e);
    arm(p, "l", 0.1, 0.12, 0.3);
    p.nod = 0.42 * e;
    p.turn = Math.sin(t * 6) * 0.1 * e;
    p.lean = 0.12 * e;
    p.smile = -0.7 * e;
    p.blink = e;
    p.squash = -0.02 * e;
  },
};

const shrug: Clip = {
  id: "shrug", label: "Shrug", loop: false, duration: 1.5, emote: true,
  sample(p, t) {
    const e = track(t, [[0, 0], [0.35, 1], [1.0, 1], [1.5, 0]]);
    arm(p, "l", 0.35 * e, 0.55 * e, 1.55 * e, -1.0 * e);
    arm(p, "r", 0.35 * e, 0.55 * e, 1.55 * e, 1.0 * e);
    p.squash = 0.03 * e;
    p.tilt = 0.2 * e;
    p.brow = 0.9 * e;
    p.smile = -0.3 * e;
    p.mouth = 0.08 * e;
  },
};

const salute: Clip = {
  id: "salute", label: "Salute", loop: false, duration: 1.7, emote: true,
  sample(p, t) {
    const e = track(t, [[0, 0], [0.22, 1], [1.25, 1], [1.45, 0]]);
    arm(p, "r", 1.5 * e, 0.85 * e, 2.4 * e, 0.4 * e, 0.2 * e);
    arm(p, "l", 0, 0.05, 0.05);
    leg(p, "l", 0, 0, -0.02);
    leg(p, "r", 0, 0, -0.02);
    p.squash = 0.02 * e;
    p.nod = -0.05 * e;
    p.brow = -0.3 * e;
    p.smile = 0.3;
  },
};

const clap: Clip = {
  id: "clap", label: "Applaud", loop: false, duration: 1.9, emote: true,
  cues: [{ at: 0.4, fx: "spark" }, { at: 0.75, fx: "spark" }, { at: 1.1, fx: "spark" }],
  sample(p, t) {
    const e = envelope(t, 1.9, 0.25);
    const c = (Math.cos(t * TAU * 2.8) + 1) / 2;
    arm(p, "l", 1.25 * e, (0.05 + c * 0.45) * e, 0.7 * e, -0.6 * e);
    arm(p, "r", 1.25 * e, (0.05 + c * 0.45) * e, 0.7 * e, 0.6 * e);
    p.rootY = Math.abs(Math.sin(t * TAU * 1.4)) * 0.03 * e;
    p.smile = 1;
    p.blink = 0.4 * e;
    p.mouth = 0.3 * e;
  },
};

const point: Clip = {
  id: "point", label: "Point", loop: false, duration: 1.7, emote: true,
  sample(p, t) {
    const e = track(t, [[0, 0], [0.3, 1], [1.3, 1], [1.7, 0]]);
    arm(p, "r", 1.55 * e, 0.25 * e, 0.05, -0.4 * e);
    arm(p, "l", -0.1, 0.6 * e, 2.0 * e, -1.1 * e);
    p.lean = 0.08 * e;
    p.tilt = -0.12 * e;
    p.smile = 1;
    p.brow = 0.5 * e;
  },
};

const stretch: Clip = {
  id: "stretch", label: "Stretch", loop: false, duration: 2.8, emote: true,
  sample(p, t) {
    const e = track(t, [[0, 0], [0.7, 1], [1.9, 1], [2.6, 0]]);
    arm(p, "l", 0.4 * e, 2.85 * e, 0.4 * e);
    arm(p, "r", 0.4 * e, 2.85 * e, 0.4 * e);
    p.lean = -0.22 * e;
    p.nod = -0.25 * e;
    p.squash = 0.07 * e;
    p.rootY = 0.02 * e;
    p.side = Math.sin(t * 2.4) * 0.08 * e;
    p.mouth = 0.7 * bump(t, 0.5, 2.0);
    p.blink = 0.9 * e;
    leg(p, "l", 0, 0, 0, -0.25 * e);
    leg(p, "r", 0, 0, 0, -0.25 * e);
  },
};

const yawn: Clip = {
  id: "yawn", label: "Yawn", loop: false, duration: 2.3, emote: true,
  sample(p, t) {
    const e = track(t, [[0, 0], [0.5, 1], [1.6, 1], [2.2, 0]]);
    arm(p, "r", 1.75 * e, 0.05, 2.5 * e, 0.3 * e);
    arm(p, "l", 0.1, 0.14, 0.2);
    p.nod = -0.2 * e;
    p.mouth = 0.85 * e;
    p.blink = e;
    p.squash = 0.03 * e;
    p.brow = 0.4 * e;
  },
};

const scratchHead: Clip = {
  id: "scratchHead", label: "Scratch head", loop: false, duration: 2.1, emote: true,
  cues: [{ at: 0.5, fx: "question" }],
  sample(p, t) {
    const e = track(t, [[0, 0], [0.4, 1], [1.6, 1], [2.1, 0]]);
    arm(p, "r", 2.3 * e, 0.6 * e, (2.0 + Math.sin(t * 22) * 0.15) * e, 0.3 * e);
    arm(p, "l", 0.1, 0.14, 0.2);
    p.tilt = 0.22 * e;
    p.brow = 0.5 * e;
    p.smile = -0.15 * e;
    p.lookY = 0.5 * e;
  },
};

const lookAround: Clip = {
  id: "lookAround", label: "Look around", loop: false, duration: 2.8, emote: true,
  sample(p, t, seed) {
    const look = track(t, [[0, 0], [0.5, 0.75], [1.3, 0.75], [1.8, -0.75], [2.4, -0.75], [2.8, 0]]);
    alive(p, t, seed, 0.4);
    restArms(p, t, seed);
    p.turn = look;
    p.twist = look * 0.25;
    p.lookX = look * 0.8;
    p.brow = 0.35 * Math.abs(look);
    p.smile = 0.25;
  },
};

const tapFoot: Clip = {
  id: "tapFoot", label: "Tap foot", loop: false, duration: 2.6, emote: true,
  sample(p, t) {
    const e = envelope(t, 2.6, 0.3);
    arm(p, "l", 1.0 * e, -0.25 * e, 1.9 * e, 0.6 * e);
    arm(p, "r", 0.9 * e, -0.25 * e, 1.9 * e, -0.6 * e);
    leg(p, "r", 0.12 * e, 0.05, 0, -Math.max(0, Math.sin(t * 14)) * 0.5 * e);
    p.hipsRoll = 0.05 * e;
    p.tilt = 0.12 * e;
    p.brow = -0.45 * e;
    p.smile = -0.2 * e;
    p.lookX = Math.sin(t * 1.5) * 0.4;
  },
};

const dizzy: Clip = {
  id: "dizzy", label: "Dizzy", loop: false, duration: 2.6, emote: true,
  cues: [{ at: 0.15, fx: "stars" }, { at: 1.2, fx: "stars" }],
  sample(p, t) {
    const e = envelope(t, 2.6, 0.3);
    const g = t * TAU * 1.2;
    p.nod = Math.sin(g) * 0.2 * e;
    p.tilt = Math.cos(g) * 0.25 * e;
    p.side = Math.cos(g) * 0.12 * e;
    p.lean = Math.sin(g) * 0.1 * e;
    p.rootX = Math.cos(g) * 0.03 * e;
    arm(p, "l", 0.2, (0.6 + Math.sin(g) * 0.3) * e, 0.3);
    arm(p, "r", 0.2, (0.6 - Math.sin(g) * 0.3) * e, 0.3);
    leg(p, "l", 0, 0.15 * e, 0.1 * e);
    leg(p, "r", 0, 0.15 * e, 0.1 * e);
    p.blink = 0.6 * e;
    p.mouth = 0.25 * e;
    p.smile = -0.3 * e;
    p.lookX = Math.cos(g * 2) * e;
    p.lookY = Math.sin(g * 2) * e;
  },
};

const giggle: Clip = {
  id: "giggle", label: "Giggle", loop: false, duration: 1.5, emote: true,
  cues: [{ at: 0.2, fx: "heart" }],
  sample(p, t) {
    const e = envelope(t, 1.5, 0.2);
    arm(p, "l", 1.6 * e, -0.05 * e, 2.4 * e, 0.4 * e);
    arm(p, "r", 1.6 * e, -0.05 * e, 2.4 * e, -0.4 * e);
    p.squash = Math.abs(Math.sin(t * 22)) * 0.04 * e;
    p.rootY = Math.abs(Math.sin(t * 11)) * 0.025 * e;
    p.nod = 0.15 * e;
    p.tilt = Math.sin(t * 5) * 0.12 * e;
    p.smile = 1;
    p.blink = 0.85 * e;
  },
};

const nodYes: Clip = {
  id: "nodYes", label: "Nod", loop: false, duration: 1.3, emote: true,
  sample(p, t, seed) {
    alive(p, t, seed, 0.4);
    restArms(p, t, seed);
    const e = envelope(t, 1.3, 0.15);
    p.nod = Math.sin(t * TAU * 2.4) * 0.22 * e;
    p.smile = 0.8;
    p.brow = 0.3 * e;
  },
};

const shakeNo: Clip = {
  id: "shakeNo", label: "Shake head", loop: false, duration: 1.3, emote: true,
  sample(p, t, seed) {
    alive(p, t, seed, 0.4);
    restArms(p, t, seed);
    const e = envelope(t, 1.3, 0.15);
    p.turn = Math.sin(t * TAU * 2.4) * 0.35 * e;
    p.smile = -0.4 * e;
    p.brow = -0.3 * e;
  },
};

const flex: Clip = {
  id: "flex", label: "Flex", loop: false, duration: 2, emote: true,
  cues: [{ at: 0.55, fx: "sparkles" }],
  sample(p, t) {
    const e = track(t, [[0, 0], [0.4, 1], [1.5, 1], [2, 0]]);
    const pulse = Math.max(0, Math.sin(t * 9)) * 0.15 * e;
    arm(p, "l", 0.1 * e, 1.55 * e, (2.1 + pulse) * e, -1.55 * e);
    arm(p, "r", 0.1 * e, 1.55 * e, (2.1 + pulse) * e, 1.55 * e);
    p.squash = 0.03 * e + pulse * 0.1;
    p.lean = -0.06 * e;
    leg(p, "l", 0, 0.15 * e, 0.12 * e);
    leg(p, "r", 0, 0.15 * e, 0.12 * e);
    p.rootY = -0.02 * e;
    p.smile = 1;
    p.brow = -0.35 * e;
  },
};

const thumbsUp: Clip = {
  id: "thumbsUp", label: "Thumbs up", loop: false, duration: 1.6, emote: true,
  cues: [{ at: 0.35, fx: "spark" }],
  sample(p, t) {
    const e = track(t, [[0, 0], [0.3, 1], [1.2, 1], [1.6, 0]]);
    arm(p, "r", 1.35 * e, 0.25 * e, 1.3 * e, 1.2 * e);
    arm(p, "l", 0.1, 0.15, 0.2);
    p.tilt = -0.1 * e;
    p.smile = 1;
    p.blink = 0.6 * e;
    p.brow = 0.4 * e;
  },
};

const surprised: Clip = {
  id: "surprised", label: "Gasp", loop: false, duration: 1.3, emote: true,
  cues: [{ at: 0.05, fx: "exclaim" }],
  sample(p, t) {
    const e = envelope(t, 1.3, 0.12);
    const jolt = bump(t, 0, 0.35);
    p.rootY = jolt * 0.12;
    p.lean = -0.15 * e;
    arm(p, "l", 0.6 * e, 1.1 * e, 1.6 * e);
    arm(p, "r", 0.6 * e, 1.1 * e, 1.6 * e);
    p.mouth = 0.8 * e;
    p.brow = 1 * e;
    p.smile = 0;
    p.squash = jolt * 0.06;
  },
};

const kick: Clip = {
  id: "kick", label: "High kick", loop: false, duration: 1.3, emote: true,
  cues: [{ at: 0.55, fx: "puff" }],
  sample(p, t) {
    const k = track(t, [[0, 0], [0.3, -0.3], [0.55, 1.6], [0.8, 1.6], [1.2, 0]]);
    const e = envelope(t, 1.3, 0.2);
    leg(p, "r", k, (k < 0 ? 0.8 : Math.max(0, 0.6 - k * 0.3)) * e);
    leg(p, "l", 0, 0.15 * e, 0, 0);
    p.lean = -0.3 * clamp01(k);
    arm(p, "l", 0.3 * e, 1.2 * clamp01(k + 0.3) * e, 0.5 * e);
    arm(p, "r", 1.0 * clamp01(k), 0.4 * e, 1.6 * clamp01(k));
    p.brow = -0.6 * clamp01(k);
    p.mouth = 0.4 * bump(t, 0.4, 0.8);
    p.smile = 0.6;
  },
};

const sneeze: Clip = {
  id: "sneeze", label: "Sneeze", loop: false, duration: 1.8, emote: true,
  cues: [{ at: 1.05, fx: "puff" }],
  sample(p, t) {
    const wind = track(t, [[0, 0], [0.4, 0.3], [0.7, 0.45], [0.95, 0.55], [1.05, -0.7], [1.3, -0.2], [1.8, 0]]);
    p.lean = -wind * 0.5;
    p.nod = -wind * 0.6;
    p.mouth = wind > 0 ? wind : 0.2;
    p.blink = clamp01(wind * 2 + (wind < 0 ? 1 : 0));
    p.brow = wind > 0 ? 0.6 : -0.3;
    p.squash = wind < -0.3 ? -0.05 : 0;
    p.hatTip = wind < -0.4 ? 0.7 : 0;
    arm(p, "l", 0.1, 0.15, 0.2);
    arm(p, "r", 0.1, 0.15, 0.2);
  },
};

const hopTap: Clip = {
  id: "hop", label: "Hop", loop: false, duration: 0.7,
  sample(p, t) {
    hop(p, t, 0.1, 0.45, 0.18);
    const e = envelope(t, 0.7, 0.15);
    arm(p, "l", 0.2 * e, 0.6 * bump(t, 0, 0.6), 0.4 * e);
    arm(p, "r", 0.2 * e, 0.6 * bump(t, 0, 0.6), 0.4 * e);
    p.smile = 1;
    p.blink = 0.7 * bump(t, 0, 0.7);
  },
};

const hatTip: Clip = {
  id: "hatTip", label: "Tip hat", loop: false, duration: 1.6, emote: true,
  sample(p, t) {
    const e = track(t, [[0, 0], [0.35, 1], [1.1, 1], [1.6, 0]]);
    arm(p, "r", 2.2 * e, 0.45 * e, 2.0 * e, 0.3 * e);
    arm(p, "l", 0.1, 0.14, 0.2);
    p.hatTip = -0.5 * bump(t, 0.3, 1.2);
    p.nod = 0.12 * e;
    p.tilt = -0.08 * e;
    p.smile = 0.9;
    p.blink = 0.5 * bump(t, 0.5, 0.9);
  },
};

/** Turntable pose for the wardrobe: standing tall, arms a little out so the outfit reads. */
const model: Clip = {
  id: "model", label: "Pose", loop: true, duration: 4, emote: true,
  sample(p, t, seed) {
    alive(p, t, seed, 0.5);
    arm(p, "l", 0.08, 0.32, 0.35);
    arm(p, "r", 0.08, 0.32, 0.35);
    p.smile = 0.75;
    p.brow = 0.2;
  },
};

export const CLIPS: readonly Clip[] = [
  idle, happy, scout, think, talk, sleep, sad, walk, run, jig, sway, robot, guard, meditate, aim, sit, counting, model, beckon,
  wave, jump, celebrate, backflip, spin, courtesy, shoot, coinToss, facepalm, shrug, salute, clap, point, stretch,
  yawn, scratchHead, lookAround, tapFoot, dizzy, giggle, nodYes, shakeNo, flex, thumbsUp, surprised, kick, sneeze,
  hopTap, hatTip,
];

const BY_ID = new Map(CLIPS.map((c) => [c.id, c]));

export type ClipId = (typeof CLIPS)[number]["id"];

export function clipOf(id: string): Clip {
  return BY_ID.get(id) ?? idle;
}

/** What the emote picker offers, loops first (they are moods), then the moves. */
export const EMOTES = CLIPS.filter((c) => c.emote);

/**
 * The little things a merryman does when nothing is happening. Picked at
 * random every few seconds by the stage while the base loop is a calm one, so
 * a merryman left on screen keeps finding something to do — which is most of
 * what makes it read as alive rather than as a model on a turntable.
 */
export const FIDGETS = [
  "lookAround", "stretch", "scratchHead", "tapFoot", "yawn", "wave", "hop", "nodYes",
  "flex", "giggle", "hatTip", "coinToss", "thumbsUp", "spin", "sneeze",
] as const;

/** Calm bases that fidgets may interrupt. Napping, scouting, or a dance are left alone. */
export const FIDGETY_BASES = new Set(["idle", "happy", "model"]);

/** Re-exported so callers can shape their own timings the same way. */
export { easeOut, backOut };
