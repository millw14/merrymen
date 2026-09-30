/**
 * ONE EXIT TEST, AND IT IS THE BREAKER'S.
 *
 * The energy gate (worker/src/energy.ts) withholds NEW trades a low-energy
 * agent would start on its own and must never withhold an exit. "Is this an
 * exit" already had an answer in this codebase — the drawdown breaker's, the
 * predicate that decides which intents may leave a losing book — and it lived
 * inline inside checkPolicy where nothing else could call it. A second copy in
 * index.ts would be a second definition of the doors, free to drift from the
 * first; the day they disagreed, the gate would lock one the breaker leaves
 * open.
 *
 * So it was MOVED, verbatim, into `isExitIntent`, and checkPolicy calls it on
 * the line where the predicate sat. This file proves the move changed nothing:
 * the old inline expression is reproduced below as the reference, and every
 * kind of intent the book can hold is asked of both.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { checkPolicy, isExitIntent, type AgentLimits, type TradeIntent } from "./policy";

const USDG = "0x00000000000000000000000000000000000000dd" as const;
const TSLA = "0x0000000000000000000000000000000000000001" as const;
const MEME = "0x00000000000000000000000000000000000000ee" as const;
const ROUTER = "0x00000000000000000000000000000000000000ff" as const;
const VAULT = "0x00000000000000000000000000000000000000aa" as const;
const ADAPTER = "0x00000000000000000000000000000000000000ab" as const;
const CURVE = "0x00000000000000000000000000000000000000ac" as const;

/** The expression as it stood inline in checkPolicy before the move, character for character. */
function oldInlineIsExit(intent: TradeIntent, limits: Pick<AgentLimits, "cashToken" | "quoteAssets">): boolean {
  const lc = (a: string) => a.toLowerCase();
  const isExit =
    intent.kind === "vault-withdraw" ||
    intent.kind === "transfer" ||
    (intent.kind === "swap" &&
      limits.cashToken !== undefined &&
      lc(intent.buyToken) === lc(limits.cashToken)) ||
    (intent.kind === "equity-order" && intent.side === "sell") ||
    (intent.kind === "curve-trade" &&
      ((limits.cashToken !== undefined && lc(intent.assetOut) === lc(limits.cashToken)) ||
        (limits.quoteAssets !== undefined && limits.quoteAssets.map(lc).includes(lc(intent.assetOut)))));
  return isExit;
}

const swap = (sellToken: `0x${string}`, buyToken: `0x${string}`): TradeIntent => ({
  kind: "swap",
  target: ROUTER,
  sellToken,
  buyToken,
  sellAmountRaw: 1_000_000n,
  notionalUsdg: 1_000_000n,
});
const curve = (assetIn: `0x${string}`, assetOut: `0x${string}`): TradeIntent => ({
  kind: "curve-trade",
  target: ADAPTER,
  curve: CURVE,
  assetIn,
  assetOut,
  amountInRaw: 1_000_000n,
  minAmountOutRaw: 1n,
  notionalUsdg: 1_000_000n,
});

const TABLE: [string, TradeIntent][] = [
  ["swap into cash (a sell)", swap(TSLA, USDG)],
  ["swap into cash, mixed case", swap(TSLA, USDG.toUpperCase().replace("0X", "0x") as `0x${string}`)],
  ["swap out of cash (a buy)", swap(USDG, TSLA)],
  ["stock to stock", swap(TSLA, MEME)],
  ["curve back into cash", curve(MEME, USDG)],
  ["curve back into a quote stock", curve(MEME, TSLA)],
  ["curve into an extra (an entry)", curve(USDG, MEME)],
  ["vault withdraw", { kind: "vault-withdraw", target: VAULT, amountUsdg: 1_000_000n }],
  ["vault deposit", { kind: "vault-deposit", target: VAULT, amountUsdg: 1_000_000n }],
  ["transfer", { kind: "transfer", target: USDG, recipient: MEME, amountUsdg: 1_000_000n }],
  ["equity buy", { kind: "equity-order", ticker: "TSLA", side: "buy", notionalUsdg: 1_000_000n }],
  ["equity sell", { kind: "equity-order", ticker: "TSLA", side: "sell", notionalUsdg: 1_000_000n }],
];

const LIMITS: Pick<AgentLimits, "cashToken" | "quoteAssets">[] = [
  { cashToken: USDG, quoteAssets: [USDG, TSLA] },
  { cashToken: USDG },
  { quoteAssets: [TSLA] },
  {},
];

describe("isExitIntent is the breaker's predicate, moved and not rewritten", () => {
  for (const [name, intent] of TABLE) {
    it(`${name}: the same answer under every shape of limits`, () => {
      for (const limits of LIMITS) {
        assert.equal(isExitIntent(intent, limits), oldInlineIsExit(intent, limits), JSON.stringify(limits));
      }
    });
  }

  it("the answers themselves, so an equivalence of two wrong things cannot pass", () => {
    const full = LIMITS[0]!;
    const ask = (n: string) => isExitIntent(TABLE.find(([k]) => k === n)![1], full);
    assert.equal(ask("swap into cash (a sell)"), true);
    assert.equal(ask("swap out of cash (a buy)"), false);
    assert.equal(ask("curve back into cash"), true);
    assert.equal(ask("curve back into a quote stock"), true);
    assert.equal(ask("curve into an extra (an entry)"), false);
    assert.equal(ask("vault withdraw"), true);
    assert.equal(ask("vault deposit"), false, "a deposit is not money coming home — the energy gate carves it out itself");
    assert.equal(ask("transfer"), true);
    assert.equal(ask("equity buy"), false);
    assert.equal(ask("equity sell"), true);
  });

  it("CHECKPOLICY STILL ASKS IT, on the line where the predicate sat", () => {
    const src = readFileSync(new URL("./policy.ts", import.meta.url), "utf8");
    assert.match(src, /export function isExitIntent\(/);
    assert.match(src, /const isExit = isExitIntent\(intent, limits\);/);
    // Exactly one assignment, inside checkPolicy — not a second copy beside it.
    assert.equal((src.match(/const isExit =/g) ?? []).length, 1);
    assert.ok(src.indexOf("const isExit =") > src.indexOf("export function checkPolicy("));
  });

  it("and the breaker still lets an exit out at a tripped drawdown — behaviour, not text", () => {
    const limits: AgentLimits = {
      perTradeUsdg: 10_000_000n,
      dailyUsdg: 100_000_000n,
      maxOpsPerDay: 10,
      allowedTargets: [ROUTER],
      allowedAssets: [USDG, TSLA],
      cashToken: USDG,
      maxDrawdownBps: 500,
      expiresAt: 4_000_000_000,
    };
    const state = { spentTodayUsdg: 0n, opsToday: 0, highWaterMarkUsdg: 100_000_000n, equityUsdg: 50_000_000n, nowSec: 1_800_000_000 };
    assert.equal(checkPolicy(swap(TSLA, USDG), limits, state).ok, true);
    const buy = checkPolicy(swap(USDG, TSLA), limits, state);
    assert.equal(buy.ok ? null : buy.rule, "drawdown-breaker");
  });
});
