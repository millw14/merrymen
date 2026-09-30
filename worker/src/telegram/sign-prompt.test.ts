import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  REPEAT_SEC,
  SETTLE_SEC,
  UPDATE_REPEAT_SEC,
  isPublicHttpsUrl,
  settleFor,
  signDecision,
  signKeyboard,
  signMessage,
  signNeed,
  signPromptText,
  signUrl,
} from "./sign-prompt";

const NOW = 1_800_000_000;
const DAY = 86_400;
// Signed AFTER the last permission-set change, so "update" stays out of the
// way of the tests that are not about it.
const WALL = NOW - 30 * DAY;
const grant = { grantedAt: NOW - 10 * DAY, grantExpiresAt: NOW + 20 * DAY, wallChangedAt: WALL };

describe("signNeed — when a signature is the fix", () => {
  it("asks for the three blockers only a signature clears", () => {
    for (const blocker of ["dead-policy", "wrong-chain", "grant-too-wide"]) {
      const n = signNeed({ blocker, ...grant, now: NOW });
      assert.equal(n?.reason, blocker);
      assert.equal(n?.settles, true, `${blocker} waits out the ferry lag`);
    }
  });

  it("never asks for a signature that would change nothing", () => {
    for (const blocker of ["no-gas", "no-cash", "no-executor", "live-not-enabled", "not-armed", null]) {
      assert.equal(signNeed({ blocker, ...grant, now: NOW }), null, String(blocker));
    }
  });

  it("no grant at all is onboarding, not a stall — no prompt", () => {
    assert.equal(signNeed({ blocker: "dead-policy", grantedAt: null, grantExpiresAt: null, now: NOW }), null);
  });

  it("an expired permission is spoken at once, and outranks any blocker", () => {
    const n = signNeed({ blocker: "dead-policy", grantedAt: NOW - DAY, grantExpiresAt: NOW - 1, now: NOW });
    assert.equal(n?.reason, "expired");
    assert.equal(n?.settles, false);
  });

  it("running out within a day is its own reason, but a blocker is the one thing to ask for", () => {
    const soon = { grantedAt: NOW - DAY, grantExpiresAt: NOW + 3600 * 5 };
    assert.equal(signNeed({ blocker: null, ...soon, now: NOW })?.reason, "expiring");
    assert.equal(signNeed({ blocker: "wrong-chain", ...soon, now: NOW })?.reason, "wrong-chain");
  });

  it("keys on the grant, so a NEW grant that is still wrong asks again", () => {
    const a = signNeed({ blocker: "grant-too-wide", ...grant, now: NOW })!;
    const b = signNeed({ blocker: "grant-too-wide", grantedAt: NOW, grantExpiresAt: NOW + 30 * DAY, now: NOW })!;
    assert.notEqual(a.key, b.key);
  });
});

describe("signDecision — once, settled, then daily", () => {
  const blocked = { key: "sign:dead-policy:1-2", settles: true };

  it("does not speak a blocker the moment it appears — the child may not have seen the new grant yet", () => {
    const first = signDecision(blocked, null, undefined, NOW);
    assert.equal(first.send, false);
    assert.deepEqual(first.watch, { key: blocked.key, since: NOW });
    const early = signDecision(blocked, first.watch, undefined, NOW + SETTLE_SEC - 1);
    assert.equal(early.send, false);
    const settled = signDecision(blocked, first.watch, undefined, NOW + SETTLE_SEC);
    assert.equal(settled.send, true);
  });

  it("a blocker that clears inside the settle window is never spoken", () => {
    const first = signDecision(blocked, null, undefined, NOW);
    const cleared = signDecision(null, first.watch, undefined, NOW + 60);
    assert.deepEqual(cleared, { send: false, watch: null });
  });

  it("repeats once a day while it stays true, not every pass", () => {
    const watch = { key: blocked.key, since: NOW - SETTLE_SEC };
    assert.equal(signDecision(blocked, watch, NOW - 60, NOW).send, false);
    assert.equal(signDecision(blocked, watch, NOW - REPEAT_SEC, NOW).send, true);
  });

  it("expiry needs no settling", () => {
    const d = signDecision({ key: "sign:expired:x", settles: false }, null, undefined, NOW);
    assert.equal(d.send, true);
  });

  it("a different key restarts the settle clock", () => {
    const watch = { key: "sign:dead-policy:old", since: NOW - DAY };
    const d = signDecision(blocked, watch, undefined, NOW);
    assert.equal(d.send, false);
    assert.equal(d.watch?.since, NOW);
  });
});

describe("the message and the button", () => {
  it("says free, names the agent, and never uses the internal words", () => {
    for (const reason of ["dead-policy", "wrong-chain", "grant-too-wide", "expiring", "expired", "update"] as const) {
      const text = signPromptText(reason, { blocker: null, ...grant, grantExpiresAt: NOW + 3600 * 5, now: NOW }, "Shogun");
      assert.match(text, /Shogun/);
      assert.match(text, /free/i, reason);
      assert.doesNotMatch(text, /\bgrant\b|policy|wall|session key|bundler|smart account/i, reason);
    }
  });

  it("escapes the agent's name — it is owner-chosen text inside HTML", () => {
    assert.match(signPromptText("expired", { blocker: null, ...grant, now: NOW }, "<b>x</b>"), /&lt;b&gt;x&lt;\/b&gt;/);
  });

  it("opens the dashboard's own re-sign anchor, and pins the network only for a wrong-chain fix", () => {
    assert.equal(signUrl("https://app.merrymen.dev/", "dead-policy"), "https://app.merrymen.dev/grant#resign");
    assert.equal(signUrl("https://app.merrymen.dev", "wrong-chain"), "https://app.merrymen.dev/grant?chain=4663#resign");
    assert.deepEqual(signKeyboard("https://x/grant#resign"), [[{ text: "✍️ Sign now", url: "https://x/grant#resign" }]]);
  });
});

describe("an update that changed what a permission carries", () => {
  it("asks a grant signed before the change to sign again — even with no blocker (practice mode masks one)", () => {
    const n = signNeed({ blocker: "live-not-enabled", grantedAt: WALL - DAY, grantExpiresAt: NOW + 20 * DAY, now: NOW, wallChangedAt: WALL });
    assert.equal(n?.reason, "update");
    assert.equal(n?.settles, false);
    assert.equal(n?.repeatSec, UPDATE_REPEAT_SEC, "a nudge every few days, not a daily alarm");
  });

  it("a grant signed after the change is left alone", () => {
    assert.equal(signNeed({ blocker: null, grantedAt: WALL + 1, grantExpiresAt: NOW + 20 * DAY, now: NOW, wallChangedAt: WALL }), null);
  });

  it("a real blocker or an expiry outranks it — one thing to ask for", () => {
    const old = { grantedAt: WALL - DAY, now: NOW, wallChangedAt: WALL };
    assert.equal(signNeed({ ...old, blocker: "dead-policy", grantExpiresAt: NOW + 20 * DAY })?.reason, "dead-policy");
    assert.equal(signNeed({ ...old, blocker: null, grantExpiresAt: NOW - 1 })?.reason, "expired");
  });

  it("repeats on its own cadence", () => {
    const need = signNeed({ blocker: null, grantedAt: WALL - DAY, grantExpiresAt: NOW + 20 * DAY, now: NOW, wallChangedAt: WALL })!;
    assert.equal(signDecision(need, null, NOW - REPEAT_SEC, NOW).send, false, "a day is too soon");
    assert.equal(signDecision(need, null, NOW - UPDATE_REPEAT_SEC, NOW).send, true);
  });
});

describe("timing and links", () => {
  it("the settle window grows with a slow tick, never below the floor", () => {
    assert.equal(settleFor(60), SETTLE_SEC);
    assert.equal(settleFor(300), 630);
    const blocked = { key: "k", settles: true };
    assert.equal(signDecision(blocked, { key: "k", since: NOW - 400 }, undefined, NOW, settleFor(300)).send, false);
  });

  it("only an https link a phone can open becomes a button", () => {
    assert.equal(isPublicHttpsUrl("https://app.merrymen.dev/grant#resign"), true);
    for (const u of ["http://localhost:3100/grant", "https://localhost/grant", "https://192.168.1.4/grant", "http://app.merrymen.dev/grant", "https://box.local/grant", "not a url"]) {
      assert.equal(isPublicHttpsUrl(u), false, u);
    }
  });

  it("hosted gets a button and a sign-in hint; self-hosted gets where to open it", () => {
    const inputs = { blocker: null, ...grant, now: NOW };
    const hosted = signMessage("dead-policy", inputs, "Shogun", "https://app.merrymen.dev");
    assert.ok(hosted.keyboard);
    assert.match(hosted.text, /sign in with the login/);
    const local = signMessage("dead-policy", inputs, "Shogun", "http://localhost:3100");
    assert.equal(local.keyboard, undefined, "no button Telegram would refuse");
    assert.match(local.text, /on the computer that runs merrymen/);
  });
});
