/**
 * THE TELEGRAM CHAT KNOWS ITS ENERGY, SAYS IT HONESTLY, AND NEVER BUYS IT.
 *
 * Both chat prompts (the narrator and the answer loop) carry one rule about
 * energy, and the answer loop's agent_status lookup carries the same line
 * /status does, from the worker's own report. And nothing on Telegram's
 * command side special-cases $MERRYMEN: a "buy merrymen" is the ordinary buy,
 * which the worker's order path refuses with a pointer to the app chat — no
 * energy command, no buy button, no parked action (design D6).
 *
 * Real sqlite ledger in a throwaway home, so agent_status runs for real.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import type { EnergyStatus } from "../../../packages/core/src/index";

const HOME = mkdtempSync(path.join(os.tmpdir(), "merrymen-energy-words-"));
process.env.MERRYMEN_HOME = HOME;
process.env.MERRYMEN_HOSTED = "1";

const { closeStoreForTest, initStore } = await import("../store");
const { toolByName } = await import("./chat-tools");
const { ENERGY_WORDS } = await import("./energy-words");
const { answerSystem } = await import("./answer");

const SHOGUN = "0x05a198a677fbcd8f5c168d397fa7ef5eb6d65487";
const NOW = Math.floor(Date.now() / 1000);
const SPENT: EnergyStatus = {
  v: 1, gated: true, mode: "enforce", level: "low", agentTokens: 10, holderTokens: 20, needTokens: 100_000,
  day: "2026-09-27", resetsAt: NOW + 3_600, reviews: null, entries: { used: 2, allowed: 2 }, spent: true,
  buy: "ready", estimateUsdg: null, at: NOW - 5,
};

before(() => initStore());
after(() => {
  closeStoreForTest();
  rmSync(HOME, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

function ctx(energy: EnergyStatus | null) {
  return {
    status: {
      agentId: SHOGUN, name: "Shogun", strategy: "trencher", venue: "uniswap", paused: false, workerAliveSec: 5,
      grant: { perTradeUsdg: 10, dailyUsdg: 50, maxDrawdownPct: 20, expiresInDays: 12 }, chainId: 4663, telegramMaxActionUsdg: 25,
      energy,
    },
    cfg: { customTokens: [], liveTradingEnabled: true, paperTradingEnabled: false, classSnipeEnabled: false, classPerEntryUsdg: 0, trencherLiveEnabled: true, sponsorGasEnabled: true },
    paused: false,
    grant: null,
    book: [SHOGUN],
    client: null,
    now: NOW,
  } as never;
}

describe("agent_status carries today's energy, from the worker's report", () => {
  it("spent: said, with the doors still open", async () => {
    const out = await toolByName("agent_status")!.run({}, ctx(SPENT));
    assert.match(out, /Energy: spent for today — back at 00:00 UTC/);
    assert.match(out, /Stop-losses, take-profits and your own orders still run; my own AI reviews, including of my open positions, are paced/);
  });

  it("no report, or an ungated one: nothing about energy", async () => {
    assert.doesNotMatch(await toolByName("agent_status")!.run({}, ctx(null)), /Energy/);
    assert.doesNotMatch(await toolByName("agent_status")!.run({}, ctx({ ...SPENT, gated: false, mode: "observe" })), /Energy/);
  });
});

describe("the rule both chat prompts carry", () => {
  it("what energy is, exactly what it never limits, that AI reviews of holdings are paced, and that unread is not zero", () => {
    assert.match(ENERGY_WORDS, /resets at 00:00 UTC/);
    assert.match(ENERGY_WORDS, /about a tenth of a STANDARD day, not of your owner's own settings/);
    assert.match(ENERGY_WORDS, /Stop-losses, take-profits and your owner's own orders are NEVER limited by it; your own AI reviews — including your reviews of your open positions — are paced/);
    assert.match(ENERGY_WORDS, /never that selling in general is unaffected/);
    assert.doesNotMatch(ENERGY_WORDS, /Selling[^.]*NEVER limited/, "the old, false promise");
    assert.match(ENERGY_WORDS, /never that they hold nothing/);
    assert.match(ENERGY_WORDS, /100,000 \$MERRYMEN/);
  });

  it("ON ANOTHER NETWORK only their own wallet counts — never /wallet, never the app-chat buy", () => {
    assert.match(ENERGY_WORDS, /IF THE LINE SAYS YOUR ACCOUNT IS ON ANOTHER NETWORK, only their own wallet on Robinhood Chain counts/);
    assert.match(ENERGY_WORDS, /never point them at \/wallet for \$MERRYMEN, never suggest sending anything to your account, and do not offer the app-chat buy/);
  });

  it("the buy is the app chat's, the address is /wallet's, and nothing is said about price", () => {
    assert.match(ENERGY_WORDS, /Merrymen app chat/);
    assert.match(ENERGY_WORDS, /you never buy it from Telegram/);
    assert.match(ENERGY_WORDS, /NEVER TYPE AN ADDRESS/);
    assert.match(ENERGY_WORDS, /\/wallet/);
    assert.doesNotMatch(ENERGY_WORDS, /0x[0-9a-fA-F]{6,}/);
    assert.match(ENERGY_WORDS, /never say anything about its price/);
  });

  it("the answer loop's system prompt and the narrator's both include it", () => {
    assert.ok(answerSystem("Shogun", "YOUR IDENTITY: Shogun.").includes(ENERGY_WORDS));
    const src = readFileSync(new URL("./interpreter.ts", import.meta.url), "utf8");
    const chat = src.slice(src.indexOf("const CHAT_SYSTEM"));
    assert.match(chat.slice(0, chat.indexOf("`;")), /\$\{ENERGY_WORDS\}/);
  });
});

describe("Telegram never special-cases $MERRYMEN into a trade", () => {
  const read = (f: string) => readFileSync(new URL(`./${f}`, import.meta.url), "utf8");
  // The TICKER (upper case — "merrymen" is also the band's name) and the word
  // energy. MERRYMEN_HOSTED and friends are environment names, not the token.
  const special = (s: string) => /\bMERRYMEN\b(?!_)/.test(s) || /\benergy\b/i.test(s);

  it("the executor, the poll service and the confirm buttons know nothing of it", () => {
    for (const f of ["executor.ts", "service.ts", "buttons.ts"]) {
      assert.ok(!special(read(f)), `${f} must not route $MERRYMEN or energy anywhere`);
    }
  });

  it("the classifier maps it like any other ticker: no energy command in its prompt, its enum or its slash parser", () => {
    const src = read("interpreter.ts");
    const classifier = src.slice(src.indexOf("const SYSTEM = `"), src.indexOf("const CHAT_SYSTEM"));
    assert.ok(classifier.includes("COMMAND_TOOL"), "the slice spans the classifier's prompt and its enum");
    assert.ok(!special(classifier));
    const slash = src.slice(src.indexOf("export function parseSlash"));
    assert.ok(!special(slash.slice(0, slash.indexOf("\n}\n"))));
  });
});
