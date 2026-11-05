/**
 * DETAIL HAS A PRICE, AND THIS IS THE CEILING.
 *
 * The figure is built from primitives so a new buckle costs one line, which
 * also makes it easy to add forty of them without noticing. Every mesh is a
 * draw call (two when it is inked), and the Home hero redraws the whole figure
 * and his island every frame on a phone. These pin the totals measured when
 * the detail pass landed, with some headroom, so the next pass has to merge or
 * trim instead of quietly doubling the frame cost. They also pin that every
 * outfit builds into a figure of sane size: a part placed with a typo for a
 * coordinate is a mesh flying off into the sky, which nothing else would catch.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Box3, Mesh, type Object3D } from "three";

import { buildIsland } from "./island";
import { DEFAULT_OUTFIT, randomOutfit, rngOf, type Outfit } from "./outfit";
import { buildRig, createKit, type Kit } from "./rig";

function count(root: Object3D, kit: Kit) {
  let meshes = 0;
  let draws = 0;
  root.traverse((o) => {
    if (!(o instanceof Mesh)) return;
    draws++;
    if (o.material !== kit.outline) meshes++;
  });
  return { meshes, draws };
}

/** Measured: 134 meshes / 174 draws. */
const DEFAULT_CEILING = { meshes: 150, draws: 200 };
/** Measured: 158 / 211 for the heaviest outfit found (below). */
const ANY_CEILING = { meshes: 180, draws: 240 };
/** Measured: 42 / 63, most of the grass instanced into a handful of calls. */
const ISLAND_CEILING = { meshes: 50, draws: 80 };

const HEAVIEST: Outfit = { ...DEFAULT_OUTFIT, hat: "hood", style: "tunic", cape: "short", held: "bow", back: "quiver", beard: "stubble", eyewear: "round", pet: "fox" };

describe("the figure's draw budget", () => {
  const kit = createKit();

  it("the default merryman stays under his ceiling", () => {
    const rig = buildRig(DEFAULT_OUTFIT, kit);
    const c = count(rig.object, kit);
    assert.ok(c.meshes <= DEFAULT_CEILING.meshes, `default: ${c.meshes} meshes > ${DEFAULT_CEILING.meshes}`);
    assert.ok(c.draws <= DEFAULT_CEILING.draws, `default: ${c.draws} draws > ${DEFAULT_CEILING.draws}`);
    rig.dispose();
  });

  it("no outfit, however loaded, goes over the ceiling or flies apart", () => {
    const r = rngOf("rig-budget");
    const outfits = [HEAVIEST, ...Array.from({ length: 80 }, () => randomOutfit(r))];
    const box = new Box3();
    for (const outfit of outfits) {
      const rig = buildRig(outfit, kit);
      const c = count(rig.object, kit);
      const label = JSON.stringify({ hat: outfit.hat, style: outfit.style, cape: outfit.cape, held: outfit.held, back: outfit.back, beard: outfit.beard, eyewear: outfit.eyewear, pet: outfit.pet });
      assert.ok(c.meshes <= ANY_CEILING.meshes, `${label}: ${c.meshes} meshes > ${ANY_CEILING.meshes}`);
      assert.ok(c.draws <= ANY_CEILING.draws, `${label}: ${c.draws} draws > ${ANY_CEILING.draws}`);
      rig.object.updateMatrixWorld(true);
      box.setFromObject(rig.object);
      for (const v of [box.min, box.max]) assert.ok(Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z), `${label}: non-finite bounds`);
      // He is about 2 units tall; wings, a staff or a held bow reach further out, but nothing reaches across the island.
      assert.ok(box.min.y > -0.3 && box.max.y < 2.8, `${label}: height ${box.min.y.toFixed(2)}..${box.max.y.toFixed(2)}`);
      assert.ok(Math.max(-box.min.x, box.max.x, -box.min.z, box.max.z) < 1.6, `${label}: reaches ${JSON.stringify(box)}`);
      rig.dispose();
    }
  });

  it("the island stays under its ceiling", () => {
    const island = buildIsland(kit);
    const c = count(island.group, kit);
    assert.ok(c.meshes <= ISLAND_CEILING.meshes, `island: ${c.meshes} meshes > ${ISLAND_CEILING.meshes}`);
    assert.ok(c.draws <= ISLAND_CEILING.draws, `island: ${c.draws} draws > ${ISLAND_CEILING.draws}`);
    island.dispose();
  });
});
