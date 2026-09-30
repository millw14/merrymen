/**
 * THE OLDER SHELL'S FACE IS SEEDED ON THE SLUG TOO.
 *
 * The terminal's Face moved its gradient onto the slug, and agent-avatar.ts
 * says the face is slug-seeded "wherever there is one" — but AgentAvatar, which
 * ThesisCard, EntryTimeline, YouClient and RailAlerts render, still called
 * `avatarGradient(name)`. Every Robin there kept the same tile. Rendered, so
 * the test reads the colour the component actually paints.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as React from "react";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { mintSlug } from "@merrymen/identity-store";

(globalThis as unknown as { React: typeof React }).React = React;

const background = (html: string) => /background:([^;"]+)/.exec(html)?.[1] ?? "";

test("two agents called Robin get two faces, and a rename keeps one's face", async () => {
  const { AgentAvatar } = await import("./AgentAvatar");
  const paint = (name: string, slug: string | null) => background(renderToStaticMarkup(createElement(AgentAvatar, { name, slug })));
  const slugs = Array.from({ length: 12 }, () => mintSlug());
  const faces = new Set(slugs.map((s) => paint("Robin", s)));
  assert.ok(faces.size > 1, "a dozen Robins painted one colour");
  assert.equal(paint("Robin", slugs[0]!), paint("Amber Heron", slugs[0]!), "renaming an agent does not move its face");
  assert.equal(paint("Robin", null), paint("Robin", "unlinked-3"), "no real slug falls back to the name");
});
