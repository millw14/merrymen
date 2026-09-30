/**
 * THE /link DECISION ON ITS OWN, as any process answering a bot will use it.
 * service.ts drives it through the real poll loop in backlog.integration.test.ts
 * and poll-bounded.integration.test.ts; this pins the rules without a loop.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { LINK_LOCKOUT_SEC, LINK_MAX_FAILS, linkReply, linksToPromote, tryLink, type LinkDeps, type LinkFails } from "./link";
import type { TelegramState } from "./state";

const T = Math.floor(Date.parse("2026-09-28T12:00:00Z") / 1000);

function blank(over: Partial<TelegramState> = {}): TelegramState {
  return {
    offset: 0, botId: null, priorBots: [], tokenTag: null, boundAt: null, chatSettings: null, linkCode: "ABCDEF",
    linkRound: 0, ownerId: null, linkedAt: null, linkedChats: [], linkedChatAt: {}, messageCount: 0, lastNotifiedTradeId: -1,
    lastTradeDigestAt: 0, lastRemedyRule: null, firedAlerts: {}, signWatch: null, lastDigestDate: "",
    lastJournalDate: "", priceAlerts: [], reminders: [], watchers: [], nextId: 1, poll: null, ...over,
  };
}

function rig(over: Partial<TelegramState> = {}) {
  let state = blank(over);
  let t = T;
  const allowed: number[] = [];
  const linked: number[] = [];
  const fails: LinkFails = new Map();
  const deps: LinkDeps = {
    stateRef: { get: () => state, set: (s) => { state = s; } },
    fails,
    now: () => t,
    allow: (c) => allowed.push(c),
    onLinked: (w) => linked.push(w.chatId),
  };
  return {
    deps,
    fails,
    allowed,
    linked,
    state: () => state,
    at: (sec: number) => { t = sec; },
    link: (chatId: number, code: string) => tryLink(deps, { chatId, fromId: chatId }, code),
  };
}

describe("tryLink", () => {
  it("the right code links: allowlisted, first linker is the owner, the code rotates, and it cannot link again", () => {
    const r = rig();
    assert.deepEqual(r.link(555, "abcdef"), { ok: true }, "case does not matter");
    assert.deepEqual(r.allowed, [555]);
    assert.deepEqual(r.linked, [555]);
    assert.equal(r.state().ownerId, 555);
    assert.equal(r.state().linkedAt, T);
    assert.deepEqual(r.state().linkedChats, [555]);
    assert.notEqual(r.state().linkCode, "ABCDEF");
    assert.equal(r.state().linkRound, 1);
    assert.deepEqual(r.link(666, "ABCDEF"), { ok: false, locked: false }, "a used code is spent");
    assert.equal(r.state().ownerId, 555, "a second linker is not the owner");
  });

  it("a wrong or empty code counts, and LINK_MAX_FAILS of them lock the chat for LINK_LOCKOUT_SEC", () => {
    const r = rig();
    for (let i = 0; i < LINK_MAX_FAILS; i++) assert.deepEqual(r.link(999, i === 0 ? "" : `WRONG${i}`), { ok: false, locked: false });
    assert.deepEqual(r.link(999, "ABCDEF"), { ok: false, locked: true, until: T + LINK_LOCKOUT_SEC });
    r.at(T + LINK_LOCKOUT_SEC);
    assert.deepEqual(r.link(999, "ABCDEF"), { ok: true }, "and it lifts");
  });

  it("the lock is checked before the code: a locked chat's right code is not spent", () => {
    const r = rig();
    for (let i = 0; i < LINK_MAX_FAILS; i++) r.link(999, "WRONG");
    assert.equal(r.link(999, "ABCDEF").ok, false);
    assert.equal(r.state().linkCode, "ABCDEF", "not consumed");
    assert.deepEqual(r.allowed, []);
  });

  it("a lockout is per chat, and a successful link forgives every chat's count", () => {
    const r = rig();
    for (let i = 0; i < LINK_MAX_FAILS; i++) r.link(999, "WRONG");
    for (let i = 0; i < LINK_MAX_FAILS - 1; i++) r.link(777, "WRONG");
    assert.deepEqual(r.link(555, "ABCDEF"), { ok: true }, "another chat is not locked by 999's guesses");
    assert.equal(r.fails.size, 0, "every count was against a code that no longer exists");
    assert.deepEqual(r.link(999, r.state().linkCode), { ok: true });
  });

  it("a link that fails part way forgives nobody: the counts stand until the rotation is saved", () => {
    // `allow` writes settings.json, and a full disk throws there. The code has
    // not rotated, so a locked-out guesser must not get five fresh guesses at it.
    const r = rig();
    for (let i = 0; i < LINK_MAX_FAILS; i++) r.link(999, "WRONG");
    r.deps.allow = () => {
      throw new Error("ENOSPC");
    };
    assert.throws(() => r.link(555, "ABCDEF"), /ENOSPC/);
    assert.equal(r.state().linkCode, "ABCDEF", "premise: nothing rotated");
    assert.equal(r.fails.get(999)?.fails, LINK_MAX_FAILS);
    assert.deepEqual(r.link(999, "ABCDEF"), { ok: false, locked: true, until: T + LINK_LOCKOUT_SEC });
  });

  it("a code minted on the spot is kept, not thrown away with the wrong guess", () => {
    const r = rig({ linkCode: "" });
    r.link(999, "WRONG");
    const minted = r.state().linkCode;
    assert.match(minted, /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    assert.deepEqual(r.link(555, minted), { ok: true });
  });
});

describe("each link is promoted once (linksToPromote)", () => {
  it("A LINK RECORDS WHEN, and a second link of the same chat, with a fresh code, is a new time", () => {
    const r = rig();
    r.link(555, "ABCDEF");
    assert.deepEqual(r.state().linkedChatAt, { "555": T });
    r.at(T + 3_600);
    r.link(555, r.state().linkCode);
    assert.deepEqual(r.state().linkedChats, [555], "listed once");
    assert.deepEqual(r.state().linkedChatAt, { "555": T + 3_600 });
  });

  it("A CHAT THE OWNER REMOVED IS NOT PROMOTED AGAIN, whatever the allowlist now says; a new link is", () => {
    const first = linksToPromote([111, 222], { "111": T, "222": T + 5 }, {});
    assert.deepEqual(first.due, [111, 222]);
    // The owner removes 222 on the dashboard. The child's list still has it,
    // and the promotion does not look at the allowlist to decide.
    const again = linksToPromote([111, 222], { "111": T, "222": T + 5 }, first.record);
    assert.deepEqual(again.due, []);
    assert.deepEqual(again.record, first.record);
    // A new chat, and 222 linking again with a code of its own.
    const later = linksToPromote([111, 222, 333], { "111": T, "222": T + 900, "333": T + 60 }, first.record);
    assert.deepEqual(later.due, [222, 333]);
    assert.deepEqual(later.record, { "111": T, "222": T + 900, "333": T + 60 });
  });

  it("a chat with no link time (a file from before) is promoted once, then left alone", () => {
    const once = linksToPromote([444], {}, {});
    assert.deepEqual(once.due, [444]);
    assert.deepEqual(linksToPromote([444], {}, once.record).due, []);
  });

  it("a group's negative id is keyed like any other", () => {
    const r = linksToPromote([-100123], { "-100123": T }, {});
    assert.deepEqual(r.due, [-100123]);
    assert.deepEqual(linksToPromote([-100123], { "-100123": T }, r.record).due, []);
  });
});

describe("linkReply", () => {
  it("a lockout says how many minutes, until when in UTC, and where the code is", () => {
    const r = linkReply({ ok: false, locked: true, until: T + 600 }, T);
    assert.equal(
      r.reason,
      "too many wrong codes from this chat — try again in about 10 min (after 12:10 UTC). Use the code in Settings → Telegram.",
    );
    assert.match(linkReply({ ok: false, locked: true, until: T + 61 }, T).reason!, /about 2 min \(after 12:01 UTC\)/);
    assert.match(linkReply({ ok: false, locked: true, until: T + 5 }, T).reason!, /about 1 min/);
  });

  it("a wrong code and a link read as before", () => {
    assert.deepEqual(linkReply({ ok: false, locked: false }, T), { ok: false, reason: "bad or expired code" });
    assert.deepEqual(linkReply({ ok: true }, T), { ok: true });
  });
});

describe("link.ts stays importable without the trading service", () => {
  it("imports only the telegram state", () => {
    // A process that answers the owner while trading is held reuses this, and
    // must not pull in the store, the ledger, a model client or the service.
    const src = readFileSync(new URL("./link.ts", import.meta.url), "utf8");
    const imports = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
    assert.deepEqual(imports, ["./state"]);
  });
});
