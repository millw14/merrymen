import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ensureLinkCode, rotateLinkCode, type TelegramState } from "./state";

const base: TelegramState = {
  offset: 0,
  linkCode: "",
  linkRound: 0,
  ownerId: null,
  linkedAt: null,
  messageCount: 0,
  lastNotifiedTradeId: -1,
  firedAlerts: {},
  lastDigestDate: "",
  priceAlerts: [],
};

describe("link code — deterministic, rotating, unambiguous", () => {
  it("is deterministic for a given seed + round", () => {
    const a = ensureLinkCode(base, "123:token");
    const b = ensureLinkCode(base, "123:token");
    assert.equal(a.linkCode, b.linkCode);
    assert.match(a.linkCode, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
  });

  it("does not regenerate when a code already exists", () => {
    const a = ensureLinkCode(base, "123:token");
    const again = ensureLinkCode(a, "different-seed");
    assert.equal(again.linkCode, a.linkCode);
  });

  it("rotateLinkCode consumes the code — a used code can't link twice", () => {
    const a = ensureLinkCode(base, "123:token");
    const rotated = rotateLinkCode(a, "123:token");
    assert.equal(rotated.linkRound, 1);
    assert.notEqual(rotated.linkCode, a.linkCode); // fresh code, new round
    assert.match(rotated.linkCode, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
  });

  it("each rotation yields a different code", () => {
    let st = ensureLinkCode(base, "seed");
    const seen = new Set<string>([st.linkCode]);
    for (let i = 0; i < 5; i++) {
      st = rotateLinkCode(st, "seed");
      assert.ok(!seen.has(st.linkCode), `round ${st.linkRound} repeated a code`);
      seen.add(st.linkCode);
    }
  });
});
