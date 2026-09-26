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
import { telegramLabel, telegramRow, trencherRow } from "./agent-status";
import type { TelegramStatus } from "@/app/api/telegram/route";

const tg = (over: Partial<TelegramStatus> = {}): TelegramStatus => ({
  enabled: true,
  hasToken: true,
  connected: true,
  botUsername: "merrybot",
  ownerId: 4242,
  allowlist: [],
  linkCode: null,
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
      botUsername: "merrybot",
    });
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

describe("what the trencher row says", () => {
  it("is unread when settings have not arrived", () => {
    assert.deepEqual(trencherRow(null, "live"), { kind: "unread" });
    assert.deepEqual(trencherRow(undefined, "paper"), { kind: "unread" });
  });

  it("is off for any other strategy", () => {
    assert.deepEqual(trencherRow({ strategy: "steady-basket" }, "live"), { kind: "off" });
    assert.deepEqual(trencherRow({ strategy: null }, "live"), { kind: "off" });
  });

  it("separates paper from live", () => {
    assert.deepEqual(trencherRow({ strategy: "trencher", trencherLiveEnabled: false }, "paper"), { kind: "paper" });
    assert.deepEqual(trencherRow({ strategy: "trencher", trencherLiveEnabled: true }, "live"), { kind: "live" });
  });

  it("treats a missing live flag as not allowed, never as live", () => {
    // Fail closed. An unset flag must never read as permission to spend.
    assert.deepEqual(trencherRow({ strategy: "trencher" }, "live"), { kind: "live-not-allowed" });
    assert.deepEqual(trencherRow({ strategy: "trencher", trencherLiveEnabled: null }, null), { kind: "not-allowed" });
  });

  it("SURFACES THE REFUSAL NOTHING ELSE SURFACES", () => {
    // assetMode "stocks" empties the candidate feed by construction, and the
    // worker announces it at event level "ok" while the agent screen's notice
    // slot only renders warn/err. So this is the one Trencher refusal an owner
    // can cause from a dropdown and then never see explained anywhere.
    assert.deepEqual(trencherRow({ strategy: "trencher", assetMode: "stocks" }, "paper"), { kind: "no-crypto" });
  });

  it("reports no-crypto ahead of live, because live cannot happen either way", () => {
    // Order matters: with no candidates there is nothing to trade, so "live"
    // would be a true flag describing an agent that cannot act on it.
    assert.deepEqual(
      trencherRow({ strategy: "trencher", assetMode: "stocks", trencherLiveEnabled: true }, "live"),
      { kind: "no-crypto" },
    );
  });

  it("is unaffected by asset modes that do permit coins", () => {
    for (const assetMode of ["all", "crypto", null, undefined]) {
      assert.equal(trencherRow({ strategy: "trencher", assetMode, trencherLiveEnabled: true }, "live").kind, "live", String(assetMode));
    }
  });
});

/**
 * THE PERMISSION IS NOT THE RAIL (TW-2).
 *
 * "Let trencher trade for real" is what trencher MAY do once the agent is
 * live. The worker checks the rail first — `!paperActive() &&
 * !cfg.trencherLiveEnabled` empties trencher's feed — so a paper agent trenches
 * on practice money whatever the box says, and a live agent without it buys
 * nothing. The row read the box alone and said "on, trading real money" under
 * a PAPER chip. Every rail against both answers, as the worker decides them.
 */
describe("the trencher row reads the rail, not only the permission", () => {
  const trencher = (trencherLiveEnabled: boolean) => ({ strategy: "trencher", trencherLiveEnabled, assetMode: "crypto" });

  it("NEVER CALLS PAPER TRADING REAL MONEY — a paper agent with the box ticked is practice money", () => {
    assert.deepEqual(trencherRow(trencher(true), "paper"), { kind: "paper" });
    assert.deepEqual(trencherRow(trencher(false), "paper"), { kind: "paper" });
  });

  it("says a live agent without the permission buys nothing, not that it practises", () => {
    // On the live rail with the box off the worker returns an empty feed:
    // no practice trades happen either, so "practice money only" was false.
    assert.deepEqual(trencherRow(trencher(false), "live"), { kind: "live-not-allowed" });
  });

  it("says real money only for a live agent that is allowed it", () => {
    const real = (["paper", "live", "idle", null] as const).flatMap((mode) =>
      [true, false].filter((allowed) => trencherRow(trencher(allowed), mode).kind === "live").map((allowed) => `${mode}/${allowed}`),
    );
    assert.deepEqual(real, ["live/true"]);
  });

  it("says only what the permission allows while the rail is unread or idle — never that it is trading", () => {
    for (const mode of ["idle", null] as const) {
      assert.deepEqual(trencherRow(trencher(true), mode), { kind: "allowed" }, String(mode));
      assert.deepEqual(trencherRow(trencher(false), mode), { kind: "not-allowed" }, String(mode));
    }
  });
});

/**
 * ONLY A STORED ANSWER IS KNOWN. A stored value beats MERRYMEN_TRENCHER_LIVE
 * on any install (worker/src/settings.ts `bool`), but a box never saved on a
 * self-hosted install is decided by that variable, in a process /api/settings
 * cannot see. Read as "not allowed", a live agent buying with real money on
 * it was told it buys nothing.
 */
describe("a self-hosted box never saved is the environment's to decide", () => {
  const unsaved = { strategy: "trencher", assetMode: "crypto", selfHosted: true };

  it("SAYS THE ENVIRONMENT DECIDES — never that a live agent buys nothing", () => {
    for (const mode of ["live", "idle", null] as const) {
      assert.deepEqual(trencherRow(unsaved, mode), { kind: "env-decides" }, String(mode));
      assert.deepEqual(trencherRow({ ...unsaved, trencherLiveEnabled: null }, mode), { kind: "env-decides" }, String(mode));
    }
  });

  it("still says practice money on paper, which no environment changes", () => {
    assert.deepEqual(trencherRow(unsaved, "paper"), { kind: "paper" });
  });

  it("takes a SAVED answer as the answer, self-hosted or not", () => {
    assert.deepEqual(trencherRow({ ...unsaved, trencherLiveEnabled: false }, "live"), { kind: "live-not-allowed" });
    assert.deepEqual(trencherRow({ ...unsaved, trencherLiveEnabled: true }, "live"), { kind: "live" });
  });

  it("leaves a hosted tenant's unsaved box at the default, off", () => {
    assert.deepEqual(trencherRow({ ...unsaved, selfHosted: false }, "live"), { kind: "live-not-allowed" });
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
