import assert from "node:assert/strict";
import { afterEach, beforeEach, it } from "node:test";
import React from "react";
import { mintSlug } from "@merrymen/identity-store";
import { Face } from "./ui";
import { avatarGradient } from "@/lib/agent-avatar";
import { testDom } from "./test-dom";

/**
 * The terminal's Face, rendered. Every Robin used to be the same colour with
 * the same "RO" because the gradient was seeded on the name; the feed read as
 * one agent posting three times when it was three agents.
 */
let ui: ReturnType<typeof testDom>;
const originalFetch = globalThis.fetch;
beforeEach(() => {
  ui = testDom();
  // The image layer asks our own route for an upload; nobody has one here.
  globalThis.fetch = async () => new Response(null, { status: 404 });
});
afterEach(async () => {
  await ui.close();
  globalThis.fetch = originalFetch;
});

const backgrounds = () =>
  Array.from(ui.container.querySelectorAll<HTMLElement>(".face")).map((f) => f.style.background);
const initials = () =>
  Array.from(ui.container.querySelectorAll<HTMLElement>(".face")).map((f) => f.firstChild?.textContent);

it("two agents that share a name get two faces", async () => {
  // Two slugs whose hues differ — 1 in 360 pairs would collide by chance, and
  // a flaky test is worse than a picked pair.
  const a = mintSlug();
  let b = mintSlug();
  while (avatarGradient(a) === avatarGradient(b)) b = mintSlug();
  await ui.render(
    React.createElement("div", null, React.createElement(Face, { name: "Robin", slug: a }), React.createElement(Face, { name: "Robin", slug: b })),
  );
  const [one, two] = backgrounds();
  assert.ok(one && two, "both faces carry a gradient");
  assert.notEqual(one, two);
  // The initials are still the name's: the name is what the reader reads.
  assert.deepEqual(initials(), ["RO", "RO"]);
});

it("a renamed agent keeps its face", async () => {
  const slug = mintSlug();
  await ui.render(
    React.createElement("div", null,
      React.createElement(Face, { name: "Robin", slug }),
      React.createElement(Face, { name: "Amber Heron", slug })),
  );
  const [before, after] = backgrounds();
  assert.equal(before, after);
  assert.deepEqual(initials(), ["RO", "AH"]);
});

it("an unlinked row's placeholder slug does not colour the face", async () => {
  // `unlinked-<index>` moves with the board's order; the name does not.
  await ui.render(
    React.createElement("div", null,
      React.createElement(Face, { name: "Robin", slug: "unlinked-0" }),
      React.createElement(Face, { name: "Robin", slug: "unlinked-7" }),
      React.createElement(Face, { name: "Robin", slug: null })),
  );
  const [x, y, z] = backgrounds();
  assert.equal(x, y);
  assert.equal(y, z);
});
