/**
 * A DRESSED LOOK GOES TO ONE AGENT, ONCE.
 *
 * The draft dressed before an agent exists becomes that agent's look when its
 * slug is first known — and is cleared then, so on a shared browser it never
 * reaches the next account that signs in. An agent that already has a look
 * keeps it. Storage that throws is survivable.
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";

import { testDom } from "../terminal/test-dom";
import { DEFAULT_OUTFIT } from "./outfit";
import { DRAFT, adoptDraft, loadOutfit, saveOutfit } from "./wardrobe-store";

let ui: ReturnType<typeof testDom>;
beforeEach(() => { ui = testDom(); });
afterEach(async () => { await ui.close(); });

it("adopts the draft into a new agent and clears it", () => {
  saveOutfit(DRAFT, { ...DEFAULT_OUTFIT, hat: "crown" });
  adoptDraft("aaaaaaaaaaaaaaaa");
  assert.equal(loadOutfit("aaaaaaaaaaaaaaaa")?.hat, "crown");
  assert.equal(loadOutfit(DRAFT), null, "the draft is not left for the next account");
  adoptDraft("bbbbbbbbbbbbbbbb");
  assert.equal(loadOutfit("bbbbbbbbbbbbbbbb"), null);
});

it("never overwrites an agent's own look, and still clears the draft", () => {
  saveOutfit("aaaaaaaaaaaaaaaa", { ...DEFAULT_OUTFIT, hat: "wizard" });
  saveOutfit(DRAFT, { ...DEFAULT_OUTFIT, hat: "crown" });
  adoptDraft("aaaaaaaaaaaaaaaa");
  assert.equal(loadOutfit("aaaaaaaaaaaaaaaa")?.hat, "wizard");
  assert.equal(loadOutfit(DRAFT), null);
});

it("a stored look that is not a look parses to a valid one", () => {
  localStorage.setItem("merryman.outfit.v1:cccccccccccccccc", JSON.stringify({ hat: "jetpack", cloth: 7 }));
  assert.equal(loadOutfit("cccccccccccccccc")?.hat, DEFAULT_OUTFIT.hat);
  localStorage.setItem("merryman.outfit.v1:dddddddddddddddd", "{not json");
  assert.equal(loadOutfit("dddddddddddddddd"), null);
});
