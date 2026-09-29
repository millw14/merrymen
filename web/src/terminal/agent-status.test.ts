/**
 * THE STATES THE HOME SCREEN MUST NOT COLLAPSE.
 *
 * The web settings screen has a live honesty bug that this module exists to
 * stop repeating: `loadTelegram()` only calls `setTg` on a truthy response, so
 * a failed `/api/telegram` leaves `tg === null`, and the connection field's
 * ternary chain then prints the literal string "no token". An owner whose
 * network hiccupped is told, in plain words, that they never saved a token —
 * a measured absence standing in for an unread state, which is exactly what
 * this codebase forbids everywhere else.
 *
 * Every assertion below is one of those collapses, written out.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { heldNotice, telegramLabel, telegramRow, trencherRow } from "./agent-status";
import type { TelegramStatus } from "@/app/api/telegram/route";

const tg = (over: Partial<TelegramStatus> = {}): TelegramStatus => ({
  enabled: true,
  hasToken: true,
  connected: true,
  botUsername: "merrybot",
  ownerId: 4242,
  allowlist: [],
  linkCode: null,
  linkPending: false,
  botElsewhere: false,
  listening: { state: "live", lastOkAt: 1_790_000_000, reason: null },
  tradingHeld: null,
  control: true,
  ...over,
});

describe("an unread bridge is not a disconnected one", () => {
  it("reports unread when the status never arrived", () => {
    // THE BUG THIS FILE EXISTS FOR. `null` must not become "no token".
    assert.deepEqual(telegramRow(null), { kind: "unread" });
    assert.deepEqual(telegramRow(undefined), { kind: "unread" });
  });

  it("reports no-token only when the server actually said so", () => {
    assert.deepEqual(telegramRow(tg({ hasToken: false })), { kind: "no-token" });
  });
});

describe("the four states a tester can get stuck in", () => {
  it("names a saved-but-switched-off bridge as off, not unverified", () => {
    // Telling somebody to check their token when the real problem is a
    // checkbox is how an afternoon disappears. The switch is checked first.
    assert.deepEqual(telegramRow(tg({ enabled: false })), { kind: "off" });
  });

  it("keeps off distinct from no-token", () => {
    // Both mean "nothing is listening" and they have completely different
    // remedies: one is a checkbox, the other is a trip to @BotFather.
    assert.notDeepEqual(telegramRow(tg({ enabled: false })), telegramRow(tg({ hasToken: false })));
  });

  it("names a token that getMe could not confirm as unverified", () => {
    assert.deepEqual(telegramRow(tg({ connected: false })), { kind: "unverified" });
  });

  it("carries the link code out with the unlinked state", () => {
    // THE HIGHEST-VALUE FACT ON THE WHOLE STRIP. The instruction and the code
    // live in two different closed drawers in Settings, and two beta testers
    // stopped exactly there. A state that knew it was unlinked but not what to
    // send would reproduce the same dead end in a new place.
    assert.deepEqual(telegramRow(tg({ ownerId: null, linkCode: "K7M2QX" })), {
      kind: "unlinked",
      linkCode: "K7M2QX",
      linkPending: false,
      botUsername: "merrybot",
    });
  });

  it("stays unlinked, with a null code, when the code has not been minted yet", () => {
    // Saving a token does not produce a code immediately — the agent mints one
    // on its next pass. "No code yet" is a WAIT, not an absence, and the row
    // has to be able to express that rather than claim there is no code.
    assert.deepEqual(telegramRow(tg({ ownerId: null, linkCode: null })), {
      kind: "unlinked",
      linkCode: null,
      linkPending: false,
      botUsername: "merrybot",
    });
  });

  it("says when there is no code because the agent has not picked up this bot", () => {
    // A different wait from the one above, with a different end: the code on
    // file was minted for another bot, and would not link this one.
    const row = telegramRow(tg({ ownerId: null, linkCode: null, linkPending: true }));
    assert.equal(row.kind, "unlinked");
    assert.equal(row.kind === "unlinked" && row.linkPending, true);
  });

  it("reports linked once somebody has claimed the bot", () => {
    assert.deepEqual(telegramRow(tg({ ownerId: 99, allowlist: [1, 2] })), {
      kind: "linked",
      botUsername: "merrybot",
      chats: 2,
    });
  });

  it("treats an owner with no extra chats as linked, not unlinked", () => {
    // The normal case. An empty allowlist is not an unclaimed bot.
    assert.equal(telegramRow(tg({ ownerId: 99, allowlist: [] })).kind, "linked");
  });
});

describe("what the polling process measured comes before the owner", () => {
  // THE INCIDENT THESE STATES CAME FROM: nothing polled a linked owner's bot
  // for days, and this row said "✓ connected" throughout, because the owner
  // check came first and getMe (`connected`) only proves the token is good.

  it("A LINKED BOT NOBODY HEARS IS NOT 'CONNECTED'", () => {
    const row = telegramRow(tg({ ownerId: 99, listening: { state: "not-listening", lastOkAt: 1_700_000_000, reason: null } }));
    assert.deepEqual(row, {
      kind: "not-listening",
      why: "stale",
      lastOkAt: 1_700_000_000,
      linked: true,
      linkCode: null,
      botUsername: "merrybot",
    });
    assert.notEqual(telegramLabel(row), telegramLabel(telegramRow(tg({ ownerId: 99 }))));
  });

  it("keeps the code on an unlinked bot that is not being heard, with the warning", () => {
    // Hiding it would send the owner looking for another code; it works once
    // the bot is heard again. The row carries it so the screen can show both.
    const row = telegramRow(tg({ ownerId: null, linkCode: "K7M2QX", listening: { state: "not-listening", lastOkAt: null, reason: null } }));
    assert.equal(row.kind, "not-listening");
    assert.equal(row.kind === "not-listening" && row.linkCode, "K7M2QX");
    assert.equal(row.kind === "not-listening" && row.linked, false);
  });

  it("names a conflict and a refused token apart from plain silence", () => {
    // Three different remedies: wait or tell us, stop the other program, paste
    // a new token. A revoked token fails getMe as well, so that is the
    // combination the route really gives.
    const why = (state: "conflict" | "revoked" | "not-listening") => {
      const r = telegramRow(tg({ connected: state !== "revoked", listening: { state, lastOkAt: null, reason: "x" } }));
      return r.kind === "not-listening" ? r.why : null;
    };
    assert.deepEqual([why("not-listening"), why("conflict"), why("revoked")], ["stale", "conflict", "revoked"]);
  });

  it("A REVOKED TOKEN GETS ITS REMEDY, not 'not verified'", () => {
    // getMe is refused for a revoked token exactly as getUpdates is. With the
    // getMe check first, the row could only ever say "not verified".
    const row = telegramRow(tg({ connected: false, ownerId: 99, listening: { state: "revoked", lastOkAt: 1_700_000_000, reason: "401 Unauthorized" } }));
    assert.deepEqual(row, { kind: "not-listening", why: "revoked", lastOkAt: 1_700_000_000, linked: true, linkCode: null, botUsername: "merrybot" });
    // And with nothing measured, a token getMe refuses is still "not verified".
    assert.equal(telegramRow(tg({ connected: false, listening: { state: "unknown", lastOkAt: null, reason: null } })).kind, "unverified");
  });

  it("BUT NOT RIGHT AFTER A NEW TOKEN WAS PASTED: getMe takes it, and the agent has not been handed it yet", () => {
    // Telling the owner to paste a new token then is telling them to do what
    // they just did. The row says what it would say without the record.
    const revoked = { state: "revoked" as const, lastOkAt: null, reason: "401 Unauthorized" };
    assert.equal(telegramRow(tg({ connected: true, ownerId: 99, listening: revoked })).kind, "linked");
    assert.equal(telegramRow(tg({ connected: true, ownerId: null, linkCode: "K7M2QX", listening: revoked })).kind, "unlinked");
  });

  it("A BOT ANOTHER AGENT HAS IS SAID, with no code, whatever was heard on it here", () => {
    const row = telegramRow(tg({ botElsewhere: true, ownerId: null, linkCode: null, listening: { state: "not-listening", lastOkAt: null, reason: null } }));
    assert.deepEqual(row, { kind: "elsewhere", botUsername: "merrybot" });
  });

  it("a held tenant says so, with the class, linked or not", () => {
    const held = { state: "held" as const, lastOkAt: null, reason: "trades newer than the last valuation" };
    assert.deepEqual(telegramRow(tg({ ownerId: 99, listening: held })), {
      kind: "held",
      reason: "trades newer than the last valuation",
      linked: true,
      linkCode: null,
      botUsername: "merrybot",
    });
    assert.equal(telegramRow(tg({ ownerId: null, linkCode: "K7M2QX", listening: held })).kind, "held");
  });

  it("UNKNOWN IS NOT A VERDICT: the row says what it always said", () => {
    const unknown = { state: "unknown" as const, lastOkAt: null, reason: null };
    assert.equal(telegramRow(tg({ ownerId: 99, listening: unknown })).kind, "linked");
    assert.equal(telegramRow(tg({ ownerId: null, listening: unknown })).kind, "unlinked");
  });

  it("TRADING HELD IS SAID APART FROM THE BOT, for an owner the Telegram row cannot tell", () => {
    // No bot, a bot switched off, or one getMe will not confirm: no hold
    // reply and no direct message reach them, so the strip says it.
    const held = "trades newer than the last valuation";
    for (const over of [{ hasToken: false }, { enabled: false }, { connected: false }] as Partial<TelegramStatus>[]) {
      const status = tg({ ...over, tradingHeld: held, listening: { state: "held", lastOkAt: null, reason: held } });
      assert.equal(heldNotice(status, telegramRow(status)), held, JSON.stringify(over));
    }
    // A deaf bot's row says the bot's state; the hold is still said.
    const deaf = tg({ tradingHeld: held, listening: { state: "not-listening", lastOkAt: null, reason: null } });
    assert.equal(heldNotice(deaf, telegramRow(deaf)), held);
    // Not twice: the Telegram row already says it.
    const said = tg({ tradingHeld: held, listening: { state: "held", lastOkAt: null, reason: held } });
    assert.equal(telegramRow(said).kind, "held");
    assert.equal(heldNotice(said, telegramRow(said)), null);
    // Nothing held, nothing said; and an unread status says nothing either.
    assert.equal(heldNotice(tg(), telegramRow(tg())), null);
    assert.equal(heldNotice(null, telegramRow(null)), null);
  });

  it("the switch and the token are still read first", () => {
    // A bot switched off is not "not listening" in any way the owner can act
    // on except the switch; and an unconfirmed token is checked before what
    // was heard on it.
    const quiet = { state: "not-listening" as const, lastOkAt: null, reason: null };
    assert.equal(telegramRow(tg({ enabled: false, listening: quiet })).kind, "off");
    assert.equal(telegramRow(tg({ connected: false, listening: quiet })).kind, "unverified");
  });
});

describe("what the trencher row says", () => {
  it("is unread when settings have not arrived", () => {
    assert.deepEqual(trencherRow(null), { kind: "unread" });
    assert.deepEqual(trencherRow(undefined), { kind: "unread" });
  });

  it("is off for any other strategy", () => {
    assert.deepEqual(trencherRow({ strategy: "steady-basket" }), { kind: "off" });
    assert.deepEqual(trencherRow({ strategy: null }), { kind: "off" });
  });

  it("separates paper from live", () => {
    assert.deepEqual(trencherRow({ strategy: "trencher", trencherLiveEnabled: false }), { kind: "paper" });
    assert.deepEqual(trencherRow({ strategy: "trencher", trencherLiveEnabled: true }), { kind: "live" });
  });

  it("treats a missing live flag as paper, not as live", () => {
    // Fail closed. An unset flag must never read as permission to spend.
    assert.deepEqual(trencherRow({ strategy: "trencher" }), { kind: "paper" });
  });

  it("SURFACES THE REFUSAL NOTHING ELSE SURFACES", () => {
    // assetMode "stocks" empties the candidate feed by construction, and the
    // worker announces it at event level "ok" while the agent screen's notice
    // slot only renders warn/err. So this is the one Trencher refusal an owner
    // can cause from a dropdown and then never see explained anywhere.
    assert.deepEqual(trencherRow({ strategy: "trencher", assetMode: "stocks" }), { kind: "no-crypto" });
  });

  it("reports no-crypto ahead of live, because live cannot happen either way", () => {
    // Order matters: with no candidates there is nothing to trade, so "live"
    // would be a true flag describing an agent that cannot act on it.
    assert.deepEqual(
      trencherRow({ strategy: "trencher", assetMode: "stocks", trencherLiveEnabled: true }),
      { kind: "no-crypto" },
    );
  });

  it("is unaffected by asset modes that do permit coins", () => {
    for (const assetMode of ["all", "crypto", null, undefined]) {
      assert.equal(trencherRow({ strategy: "trencher", assetMode }).kind, "paper", String(assetMode));
    }
  });
});

describe("the short label the settings field shows", () => {
  it("never says 'no token' for an unread bridge", () => {
    // THE REGRESSION THIS GUARDS. The settings screen printed exactly this for
    // a failed fetch, telling an owner they had not saved a token they had.
    assert.equal(telegramLabel(telegramRow(null)), "checking…");
    assert.notEqual(telegramLabel(telegramRow(null)), telegramLabel(telegramRow(tg({ hasToken: false }))));
  });

  it("gives every state its own words", () => {
    const labels = [
      telegramRow(null),
      telegramRow(tg({ hasToken: false })),
      telegramRow(tg({ enabled: false })),
      telegramRow(tg({ connected: false })),
      telegramRow(tg({ ownerId: null })),
      telegramRow(tg()),
      telegramRow(tg({ listening: { state: "held", lastOkAt: null, reason: null } })),
      telegramRow(tg({ listening: { state: "not-listening", lastOkAt: null, reason: null } })),
      telegramRow(tg({ listening: { state: "conflict", lastOkAt: null, reason: null } })),
      // Refused by getMe too, as a revoked token is.
      telegramRow(tg({ connected: false, listening: { state: "revoked", lastOkAt: null, reason: null } })),
      telegramRow(tg({ botElsewhere: true })),
    ].map(telegramLabel);
    assert.equal(new Set(labels).size, labels.length, `two states share a label: ${labels.join(" / ")}`);
  });

  it("names the bot when there is one", () => {
    assert.equal(telegramLabel(telegramRow(tg({ botUsername: "merrybot" }))), "✓ @merrybot");
  });

  it("does not print 'undefined' when the bot name is missing", () => {
    assert.equal(telegramLabel(telegramRow(tg({ botUsername: null }))), "✓ connected");
  });
});
