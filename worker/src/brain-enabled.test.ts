/**
 * OFF IS THE DEFAULT, and it has to survive a missing variable.
 *
 * The failure direction for a feature that spends money is silence. This fleet's
 * one real incident was an unwatched background feature emptying a shared
 * allowance, and the thing that would have prevented it is exactly this: an
 * absent setting meaning nobody, rather than everybody.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { shadowBrainEnabledFor } from "./brain-enabled";

const A = "0x3E34E58e39DC6614e047dFD3BAD5B7DEA45DCd62";
const B = "0x1102b20c835ff07DCA4eDC15F0B4C7d805bbB22F";
const env = (v?: string) => ({ MERRYMEN_BRAIN_SHADOW: v }) as NodeJS.ProcessEnv;

describe("who may think", () => {
  it("nobody, when the variable is absent or blank", () => {
    assert.equal(shadowBrainEnabledFor(A, {} as NodeJS.ProcessEnv), false);
    assert.equal(shadowBrainEnabledFor(A, env("")), false);
    assert.equal(shadowBrainEnabledFor(A, env("   ")), false);
  });

  it("matches on a prefix, the way the reconcile shadow already does", () => {
    assert.equal(shadowBrainEnabledFor(A, env("0x3E34E58e")), true);
    assert.equal(shadowBrainEnabledFor(B, env("0x3E34E58e")), false);
  });

  it("is case-insensitive, because an operator pastes what the dashboard shows", () => {
    assert.equal(shadowBrainEnabledFor(A, env("0x3e34e58e")), true);
    assert.equal(shadowBrainEnabledFor(A.toLowerCase(), env("0x3E34E58E")), true);
  });

  it("takes a list, so a cohort is one edit", () => {
    assert.equal(shadowBrainEnabledFor(A, env("0x1102b20c, 0x3E34E58e")), true);
    assert.equal(shadowBrainEnabledFor(B, env("0x1102b20c, 0x3E34E58e")), true);
    assert.equal(shadowBrainEnabledFor("0xdead", env("0x1102b20c, 0x3E34E58e")), false);
  });

  it("accepts `all`, but only when written out", () => {
    assert.equal(shadowBrainEnabledFor(A, env("all")), true);
    // Not a wildcard, not a truthy value — the literal word or nothing.
    assert.equal(shadowBrainEnabledFor(A, env("*")), false);
    assert.equal(shadowBrainEnabledFor(A, env("true")), false);
    assert.equal(shadowBrainEnabledFor(A, env("1")), false);
  });

  it("an empty agent id never matches, whatever the list says", () => {
    assert.equal(shadowBrainEnabledFor("", env("all")), false);
  });
});
