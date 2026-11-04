/**
 * A MERRYMAN IS DATA BEFORE HE IS PIXELS.
 *
 * The renderer trusts two things completely: that an Outfit only ever names
 * parts that exist, and that every clip writes a finite number into every key
 * of the pose at every instant. A NaN in one joint would not throw — it would
 * fold the whole character to a point, silently, on somebody's Home screen.
 * These pin both, plus the determinism the board depends on: the same agent
 * wears the same look on every visit.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { readFileSync } from "node:fs";
import { CALM_BASES, CALM_SHOTS, CALM_STAND_IN, CLIPS, EMOTES, FIDGETS, FIDGETY_BASES, clipOf } from "./clips";
import {
  COLOR_SLOTS,
  DEFAULT_OUTFIT,
  SLOTS,
  hexOf,
  outfitKey,
  parseOutfit,
  randomOutfit,
  rngOf,
  seededOutfit,
} from "./outfit";
import { POSE_KEYS, blendPose, restPose, track } from "./pose";

describe("outfits", () => {
  it("anything at all parses to a complete outfit made only of catalogued parts", () => {
    for (const raw of [null, undefined, 42, "hat", [], { hat: "jetpack", cloth: "#ff0000", skin: 7 }, { __proto__: { hat: "crown" } }]) {
      const o = parseOutfit(raw);
      for (const [slot, list] of Object.entries(SLOTS)) assert.ok(list.some((c) => c.id === o[slot as keyof typeof o]), `${slot} is catalogued`);
      for (const [slot, list] of Object.entries(COLOR_SLOTS)) assert.ok(list.some((c) => c.id === o[slot as keyof typeof o]), `${slot} is catalogued`);
    }
  });

  it("one bad slot costs only that slot", () => {
    const o = parseOutfit({ ...DEFAULT_OUTFIT, hat: "crown", cloth: "plum", pet: "dragon" });
    assert.equal(o.hat, "crown");
    assert.equal(o.cloth, "plum");
    assert.equal(o.pet, DEFAULT_OUTFIT.pet);
  });

  it("the same agent wears the same look on every visit, and agents differ", () => {
    assert.deepEqual(seededOutfit("k7q2m9x4p1a8c3d5"), seededOutfit("k7q2m9x4p1a8c3d5"));
    const keys = new Set(["a", "b", "c", "d", "e", "f", "g", "h"].map((s) => outfitKey(seededOutfit(`agent-${s}`))));
    assert.ok(keys.size >= 7, "eight agents, (almost) eight looks");
  });

  it("a seeded look is always a valid one", () => {
    for (let i = 0; i < 200; i++) assert.deepEqual(parseOutfit(seededOutfit(`s${i}`)), seededOutfit(`s${i}`));
  });

  it("the dice only roll catalogued parts", () => {
    const r = rngOf("dice");
    for (let i = 0; i < 100; i++) {
      const o = randomOutfit(r);
      assert.deepEqual(parseOutfit(o), o);
    }
  });

  it("a colour id always resolves to a hex, even a bad one", () => {
    assert.match(hexOf("cloth", "forest"), /^#[0-9a-f]{6}$/);
    assert.match(hexOf("skin", "nope"), /^#[0-9a-f]{6}$/);
  });

  it("the PRNG is deterministic and in [0, 1)", () => {
    const a = rngOf("x");
    const b = rngOf("x");
    for (let i = 0; i < 50; i++) {
      const v = a();
      assert.equal(v, b());
      assert.ok(v >= 0 && v < 1);
    }
  });
});

describe("clips", () => {
  it("every clip writes a finite number into every pose key at every instant", () => {
    for (const clip of CLIPS) {
      for (let i = 0; i <= 40; i++) {
        const t = (clip.duration * i) / 40;
        const p = restPose();
        clip.sample(p, t, 3.3);
        for (const k of POSE_KEYS) assert.ok(Number.isFinite(p[k]), `${clip.id}.${k} at ${t.toFixed(2)}s is ${p[k]}`);
      }
    }
  });

  it("a one-shot starts and ends near rest, so it can be blended over any mood", () => {
    // Root motion and the face are allowed to differ; limbs must come home.
    const LIMBS = ["lFwd", "lOut", "lBend", "rFwd", "rOut", "rBend", "lLeg", "rLeg", "lKnee", "rKnee", "rootY", "lean"] as const;
    for (const clip of CLIPS.filter((c) => !c.loop)) {
      const end = restPose();
      clip.sample(end, clip.duration, 1);
      for (const k of LIMBS) assert.ok(Math.abs(end[k]) < 0.35, `${clip.id} ends with ${k} = ${end[k].toFixed(2)}`);
    }
  });

  it("ids are unique, every fidget and calm base exists, and there are lots of moves", () => {
    const ids = CLIPS.map((c) => c.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const f of FIDGETS) assert.ok(ids.includes(f), `fidget ${f}`);
    for (const b of FIDGETY_BASES) assert.ok(ids.includes(b), `base ${b}`);
    assert.ok(EMOTES.length >= 40, `${EMOTES.length} emotes`);
  });

  it("REDUCE MOTION: every calm clip exists, and every stand-in is itself calm", () => {
    const ids = new Set(CLIPS.map((c) => c.id));
    for (const b of CALM_BASES) assert.ok(ids.has(b) && clipOf(b).loop, `calm base ${b}`);
    for (const c of CALM_SHOTS) assert.ok(ids.has(c) && !clipOf(c).loop, `calm one-shot ${c}`);
    for (const [from, to] of Object.entries(CALM_STAND_IN)) {
      assert.ok(ids.has(from), `stand-in source ${from}`);
      assert.ok(CALM_SHOTS.has(to), `${from} stands in with ${to}, which must be calm`);
    }
    for (const big of ["celebrate", "backflip", "spin", "jump", "hop", "dizzy"]) assert.ok(!CALM_SHOTS.has(big), `${big} is not calm`);
  });

  it("pinch-zoom stays the browser's over every merryman", () => {
    const css = readFileSync(new URL("./merryman.css", import.meta.url), "utf8");
    assert.match(css, /\.mm-merryman \{[^}]*touch-action: pan-y pinch-zoom/);
  });

  it("an unknown clip id is the idle loop, never undefined", () => {
    assert.equal(clipOf("moonwalk").id, "idle");
  });

  it("cues land inside their clip", () => {
    for (const c of CLIPS) for (const cue of c.cues ?? []) assert.ok(cue.at >= 0 && cue.at <= c.duration, `${c.id} cue at ${cue.at}`);
  });
});

describe("pose maths", () => {
  it("blending is a lerp, clamped at both ends", () => {
    const a = restPose();
    const b = restPose();
    b.lFwd = 2;
    blendPose(a, b, 0.25);
    assert.equal(a.lFwd, 0.5);
    blendPose(a, b, 1);
    assert.equal(a.lFwd, 2);
  });

  it("a keyframe track holds its ends and passes through its keys", () => {
    const keys = [[0, 0], [1, 10], [2, 4]] as const;
    assert.equal(track(-1, keys), 0);
    assert.equal(track(1, keys), 10);
    assert.equal(track(3, keys), 4);
    const mid = track(0.5, keys);
    assert.ok(mid > 0 && mid < 10);
  });
});
