import assert from "node:assert/strict";
import { it } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { GRANT_V4, GRANT_V4_ADAPTER } from "@merrymen/core";
import { V4PermissionLine } from "./V4PermissionLine";

const ADAPTER = "0x0000000000000000000000000000000000000abc" as const;
const line = (grantFeatures: string[], v4AdapterAddress?: `0x${string}`, configuredAdapter?: string) =>
  renderToStaticMarkup(
    createElement(V4PermissionLine, { grant: { grantFeatures, v4AdapterAddress }, configuredAdapter }),
  );

it("shows a sealed adapter as granted even though the unsafe legacy route is off", () => {
  const html = line([GRANT_V4_ADAPTER], ADAPTER);
  assert.match(html, /adapter permission sealed to/);
  assert.match(html, new RegExp(ADAPTER));
  assert.doesNotMatch(html, /not granted/);
});

it("explains why another re-sign cannot add v4 without an adapter address", () => {
  const html = line([]);
  assert.match(html, /not granted/);
  assert.match(html, /Check that a deployed/);
  assert.match(html, /Settings, then re-sign/);
});

it("distinguishes a saved address from one sealed into the current signature", () => {
  const html = line([], undefined, ADAPTER);
  assert.match(html, /address saved in Settings/);
  assert.match(html, /this key does not grant it/);
  assert.match(html, /Re-sign below/);
});

it("warns when Settings changed to a different adapter after signing", () => {
  const html = line([GRANT_V4_ADAPTER], ADAPTER, "0x0000000000000000000000000000000000000def");
  assert.match(html, /Settings now names a different adapter/);
  assert.match(html, /still uses the adapter sealed in this signed key if it is deployed/);
  assert.match(html, /re-sign to switch adapters/);
  assert.doesNotMatch(html, /cannot use v4/);
  assert.doesNotMatch(line([GRANT_V4_ADAPTER], ADAPTER, ADAPTER.toUpperCase()), /different adapter/);
});

it("still warns about an old unrestricted router permission", () => {
  const html = line([GRANT_V4]);
  assert.match(html, /old unrestricted router permission/);
  assert.match(html, /Re-sign below/);
  assert.doesNotMatch(html, /adapter permission sealed/);
});

it("shows both permissions if a stored grant contains both markers", () => {
  const html = line([GRANT_V4, GRANT_V4_ADAPTER], ADAPTER);
  assert.match(html, /old unrestricted router permission/);
  assert.match(html, /adapter permission sealed to/);
});
