/**
 * /status TELLS THE OWNER WHERE ENERGY STANDS — AND ONLY WHAT WAS READ.
 *
 * Telegram is read-only for energy in v1: one line on /status (which the chat
 * model also reads, through readLlmState) and one alert a day. The line is
 * executed here in every arm the worker can report, and held to the rules the
 * other surfaces keep: an unread balance is our read failing and never 0, a
 * count the worker did not report prints "—", yesterday's "spent" is not
 * today's, and the account is never offered as a destination when it sits on
 * another network.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import type { EnergyStatus } from "../../../packages/core/src/index";
import { energyStatusLine, readStatus, type StatusContext } from "./reads";

const NOW = 1_790_000_000; // some moment inside the report's day
const REPORT: EnergyStatus = {
  v: 1,
  gated: true,
  mode: "enforce",
  level: "low",
  agentTokens: 345,
  holderTokens: 12_000,
  needTokens: 100_000,
  day: "2026-09-21",
  resetsAt: NOW + 3_600,
  reviews: { used: 3, allowed: 29 },
  entries: { used: 1, allowed: 2 },
  spent: false,
  buy: "ready",
  estimateUsdg: 37.12,
  at: NOW - 30,
};
const line = (over: Partial<EnergyStatus>) => energyStatusLine({ ...REPORT, ...over }, NOW);

const statusCtx = (energy: EnergyStatus | null | undefined): StatusContext => ({
  name: "Robin",
  strategy: "steady-basket",
  venue: "uniswap",
  paused: false,
  workerAliveSec: 0,
  grant: null,
  chainId: 4663,
  telegramMaxActionUsdg: 25,
  energy,
});

describe("the energy line — spoken only while the gate enforces", () => {
  it("no report, a null report, or an ungated one says nothing at all", () => {
    assert.equal(energyStatusLine(undefined, NOW), null);
    assert.equal(energyStatusLine(null, NOW), null);
    assert.equal(line({ gated: false, mode: "observe", spent: true }), null, "observe limits nothing");
    assert.equal(line({ gated: false, mode: "off", level: "unread" }), null);
  });

  it("a report from a day that has already reset is not today's", () => {
    assert.equal(energyStatusLine({ ...REPORT, spent: true }, REPORT.resetsAt), null);
    assert.equal(energyStatusLine({ ...REPORT, spent: true }, REPORT.resetsAt + 60), null);
  });

  it("full", () => {
    assert.equal(line({ level: "full", reviews: null, entries: null }), "• energy: full ⚡");
  });

  it("low: used of allowed for both meters, today", () => {
    assert.equal(
      line({}),
      "• energy: low — about a tenth of a standard day (3 of 29 AI reviews, 1 of 2 new trades used today)",
    );
  });

  it("low: a count the worker could not report prints —, never 0", () => {
    const l = line({ reviews: { used: null, allowed: 29 }, entries: { used: null, allowed: null } })!;
    assert.match(l, /— of 29 AI reviews/);
    assert.match(l, /— of — new trades/);
    assert.doesNotMatch(l, /\b0 of\b|of 0\b/);
  });

  it("low: a meter that was not reported is left out rather than read as '— of —'", () => {
    const noReviewer = line({ reviews: null })!;
    assert.doesNotMatch(noReviewer, /AI reviews/);
    assert.match(noReviewer, /1 of 2 new trades used today/);
    assert.equal(line({ reviews: null, entries: null }), "• energy: low — about a tenth of a standard day");
  });

  it("spent: back at 00:00 UTC, the doors still open, and /wallet for the address", () => {
    const l = line({ spent: true, entries: { used: 2, allowed: 2 } })!;
    assert.match(l, /^• energy: spent for today — back at 00:00 UTC\./);
    assert.match(l, /Stop-losses, take-profits and your own orders still run; my own AI reviews, including of my open positions, are paced\./);
    assert.doesNotMatch(l, /\bselling\b/i, "an exit the AI decides is paced like the rest");
    assert.match(l, /\/wallet shows my address for \$MERRYMEN/);
    assert.doesNotMatch(l, /0x[0-9a-fA-F]{40}/, "the line never types an address; /wallet prints it from the ledger");
  });

  it("spent on an account on another network: the owner's wallet, never the account", () => {
    const l = line({ spent: true, buy: "not-mainnet", agentTokens: null })!;
    assert.doesNotMatch(l, /\/wallet/, "tokens sent to that account would not count");
    assert.match(l, /100,000 \$MERRYMEN in your own wallet on Robinhood Chain/);
  });

  it("LOW on an account on another network: the owner's wallet is named, /wallet never is", () => {
    // The chat model reads this line; without the marker it would send them
    // to /wallet — an address whose $MERRYMEN is never counted there.
    const l = line({ buy: "not-mainnet", agentTokens: null })!;
    assert.match(l, /^• energy: low — /);
    assert.match(l, /100,000 \$MERRYMEN in your own wallet on Robinhood Chain — my account is on another network, so only your own wallet counts$/);
    assert.doesNotMatch(l, /\/wallet/);
  });

  it("UNREAD on another network says the same, and a mainnet line carries no such suffix", () => {
    const l = line({ level: "unread", buy: "not-mainnet", agentTokens: null, holderTokens: null })!;
    assert.match(l, /our read, not your wallet\)\. Full strength: 100,000 \$MERRYMEN in your own wallet on Robinhood Chain/);
    assert.doesNotMatch(l, /\/wallet/);
    for (const over of [{}, { level: "unread" as const }, { spent: true }]) {
      assert.doesNotMatch(line(over)!, /another network/, JSON.stringify(over));
    }
  });

  it("unread: couldn't read — our read, not your wallet — and no number", () => {
    const l = line({ level: "unread", agentTokens: null, holderTokens: null })!;
    assert.match(l, /couldn't read the \$MERRYMEN balances/);
    assert.match(l, /our read, not your wallet/);
    assert.doesNotMatch(l, /\d/);
  });

  it("unread AND spent says both", () => {
    const l = line({ level: "unread", spent: true, agentTokens: null, holderTokens: null })!;
    assert.match(l, /spent for today — back at 00:00 UTC/);
    assert.match(l, /couldn't read the \$MERRYMEN balances/);
    assert.match(l, /our read, not your wallet/);
  });

  it("no arm says anything about the token's price or returns", () => {
    const arms: Partial<EnergyStatus>[] = [
      {}, { level: "full" }, { spent: true }, { level: "unread" }, { level: "unread", spent: true },
      { spent: true, buy: "not-mainnet" }, { spent: true, buy: "paper" }, { spent: true, buy: "resign" },
    ];
    for (const over of arms) {
      const l = line(over) ?? "";
      // "take-profit" names a sell rule; it is not a word about returns.
      assert.doesNotMatch(l, /price|returns?\b|(?<!take-)profit|moon|pump|buyback|burn|invest/i, l);
    }
  });
});

describe("readStatus carries it — and the chat model sees the same line", () => {
  it("one energy line when gated, none when not", () => {
    const gated = readStatus(statusCtx({ ...REPORT, resetsAt: Math.floor(Date.now() / 1000) + 3_600 }));
    assert.equal(gated.split("\n").filter((l) => l.startsWith("• energy:")).length, 1, gated);
    assert.doesNotMatch(readStatus(statusCtx({ ...REPORT, gated: false, mode: "observe" })), /energy/);
    assert.doesNotMatch(readStatus(statusCtx(undefined)), /energy/);
    assert.doesNotMatch(readStatus(statusCtx(null)), /energy/);
  });

  it("readLlmState builds on readStatus, so the model gets the line without a second source", () => {
    const src = readFileSync(new URL("./reads.ts", import.meta.url), "utf8");
    const fn = src.slice(src.indexOf("export async function readLlmState"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    assert.match(body, /strip\(readStatus\(ctx\)\)/);
  });

  it("the public campfire report never reads the energy report", () => {
    // virtuals-streamer posts readReport(ctx, true) to a public terminal; an
    // owner's token shortfall and remedies are not anybody else's business.
    const src = readFileSync(new URL("./reads.ts", import.meta.url), "utf8");
    const fn = src.slice(src.indexOf("export function readReport"));
    const body = fn.slice(0, fn.indexOf("\n}\n"));
    assert.doesNotMatch(body, /energy/i);
  });
});
