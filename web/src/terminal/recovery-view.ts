import { explorerFor, robinhoodChain, robinhoodTestnet, type Autonomy } from "@merrymen/core";
import type { FleetRecoveryView } from "../../../worker/src/fleet-recovery";
import type { TelegramStatus } from "@/app/api/telegram/route";
import { usd } from "@/lib/format";
import { LIVE_WITHIN_SEC } from "@/lib/telegram-poll-window";
import type { AccountState } from "./HostedControls";
import { usdgOrNull } from "./account-read";

/** Optional on older servers. Only an explicit recovery pause changes the UI. */
export function pausedRecovery(value: FleetRecoveryView | null | undefined): FleetRecoveryView | null {
  return value?.tradingPaused === true && ["checking", "history-only", "reconciling"].includes(value.state) ? value : null;
}

export function recoveryDetail(recovery: FleetRecoveryView): string {
  return recovery.history === "available"
    ? "Some saved history is available. Trading remains paused pending reconciliation."
    : "Saved trading records have not yet been verified. Trading remains paused.";
}

export function recoveryMemory(recovery: FleetRecoveryView): string | null {
  return recovery.memory === "preserved" ? "Its saved memories are preserved."
    : recovery.memory === "recovered" ? "Its saved memories have been recovered." : null;
}

export function ownerTradeEmptyTitle(recovery: FleetRecoveryView | null | undefined): string {
  return pausedRecovery(recovery) ? "No saved trades available yet" : "No trades yet.";
}

/**
 * WITHDRAWAL DURING THE HOLD IS NOT SAID UNTIL SOMEBODY HAS SEEN IT WORK.
 *
 * The Withdraw buttons stay on every surface — the recovery tests pin that —
 * but a sentence telling an owner it works while trading is paused is a claim
 * about getting their money out, and nobody has yet run Withdraw against a held
 * tenant. Runbook step R1.4 does exactly that, on a Privy-owned test tenant
 * holding no real funds; this flips to true in its own change after it passes,
 * and not before. Until then the notice says where the money is and nothing
 * about how it leaves.
 */
export const RECOVERY_WITHDRAW_VERIFIED = false;

/**
 * What "Cash on chain" counts, said every time it is shown.
 *
 * `vaultUsdg` is NOT added in, and not shown beside it either: /api/grants reads
 * it as `balanceOf` on the Morpho vault, which is a count of vault SHARES, not
 * of USDG. Printing it as dollars would need `convertToAssets`, which that route
 * does not call — and this notice only uses what the route already returns.
 * Tokens are left out for the same reason: no price for them is read here. And
 * what sits in the account's own vaults (class, Trencher) is not read by that
 * route at all. So the figure is named for what it is, and each of them is
 * named as not in it — the notice has just said the funds are in those vaults.
 */
export const RECOVERY_CASH_EXCLUDES = "Only USDG held in the account itself. Not included: USDG in the Morpho vault, anything held in vaults the account owns, and any tokens the account holds.";

/** The two chains this product runs on — anything else gets no explorer link. */
const KNOWN_CHAINS = new Set<number>([robinhoodChain.id, robinhoodTestnet.id]);

/**
 * WHERE THE OWNER'S MONEY IS WHILE TRADING IS HELD.
 *
 * The hold says trading stopped; it says nothing about the money, and an owner
 * reading "Trading paused for recovery" with no other fact fills that silence
 * with the worst reading. So the notice names the account the funds are in,
 * links it on the grant's own explorer so the owner can check it without us,
 * and prints the cash the chain reported.
 *
 * READ-ONLY, and only from fields /api/grants already returns: the grant's
 * smart account and chain, and `balances.cashUsdg`. It reads nothing, writes
 * nothing, and changes neither the hold nor `recoveryAutonomy` — which is why
 * it is a separate value handed to the notice rather than folded into either.
 *
 * WHAT IT REFUSES TO SAY:
 *   - No account, or a malformed one: null, and the notice says nothing about
 *     funds. Every fact here is about that account; without it there is no
 *     honest place to point.
 *   - A cash read that failed is "couldn't be read", never $0.00 — the same rule
 *     `realCashOf` exists for.
 *   - A chain outside the two known ones gets the address but no link: Blockscout
 *     for the wrong chain shows an empty account, and an empty account during a
 *     pause reads as money gone.
 *   - On the test network, no cash figure at all — and not "couldn't be read
 *     just now" either, because that promises a retry that can never succeed.
 *     /api/grants reads CASH.USDG, the MAINNET token address, through multicall
 *     on whichever chain the grant is on, and robinhoodTestnet defines no
 *     multicall3: on 46630 that read throws every time, so `cashUsdg` is null
 *     every time (explain.ts already says the testnet USDG tile is "pinned at
 *     '—' forever"). Were it ever to answer, it would be a mainnet address read
 *     on the test chain, which is not this account's cash either. So testnet
 *     says the figure isn't read there, ignores `cashUsdg` outright, and drops
 *     the "what it counts" line, which has no figure left to qualify.
 *   - No renewal call to action and no "paused since". `since_at` on the hold
 *     row is when that row was first written, not when trading stopped, so a
 *     date from it would be a wrong fact stated precisely.
 *
 * PAPER IS SAID TO BE PAPER. The hold does not look at `mode`, so a paper
 * tenant is held too, and it has a grant and a smart account like any other.
 * Its profile then shows "Cash on chain: $0.00" in this notice and, right under
 * it, the simulated book as "Last recorded portfolio balance". Each line is
 * true; together, with no cue, they read as "my money is gone" — the reading
 * this notice exists to prevent. So an explicit `mode === "paper"` adds the
 * sentence that the recorded balance is simulated. Only that: a null or missing
 * mode is "not said", never evidence of paper. It is the same `mode` that makes
 * `recoveryAutonomy` say "Last recorded paper cash".
 */
export interface RecoveryFunds {
  /** The grant's smart account, in full — the link target and the tooltip. */
  account: string;
  /** For the sentence: 0x12ab…abcd. */
  short: string;
  /** The account on its own chain's explorer; null for a chain this product does not run on. */
  explorer: string | null;
  /** Test-network money is said to be test-network money. */
  testnet: boolean;
  /** "Cash on chain: $12.34." — or the read failing, or not made on the test network, said as such. */
  cash: string;
  /** RECOVERY_CASH_EXCLUDES beside a figure that can exist; null on the test network, where none does. */
  excludes: string | null;
  /** Said only when the published rail is exactly "paper": the recorded book is simulated. */
  paper: string | null;
  /** Null until RECOVERY_WITHDRAW_VERIFIED. */
  withdraw: string | null;
}

export function recoveryFunds(status: Pick<AccountState["status"], "grant" | "balances" | "mode"> | null | undefined,
  withdrawVerified: boolean = RECOVERY_WITHDRAW_VERIFIED): RecoveryFunds | null {
  const grant = status?.grant;
  const account = grant?.smartAccount;
  if (!grant || typeof account !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(account)) return null;
  const known = Number.isSafeInteger(grant.chainId) && KNOWN_CHAINS.has(grant.chainId);
  const testnet = grant.chainId === robinhoodTestnet.id;
  // Field by field, as grant-balances.ts carries it: no `balances` at all (an
  // older server) and a failed multicall entry are both unread, never zero.
  const cash = status?.balances ? usdgOrNull(status.balances.cashUsdg) : null;
  return {
    account,
    short: `${account.slice(0, 6)}…${account.slice(-4)}`,
    explorer: known ? `${explorerFor(grant.chainId)}/address/${account}` : null,
    testnet,
    // Testnet first: whatever `cashUsdg` says there is not this account's cash (above).
    cash: testnet ? "Cash on chain isn't read on the test network."
      : cash === null ? "Cash on chain: couldn't be read just now." : `Cash on chain: ${usd(cash)}.`,
    excludes: testnet ? null : RECOVERY_CASH_EXCLUDES,
    paper: status?.mode === "paper"
      ? "This agent is in paper mode. Its recorded balance is simulated, not real money, and is not held on chain."
      : null,
    withdraw: withdrawVerified
      ? "Withdraw still works while trading is paused. It sends funds from this account to an address you choose."
      : null,
  };
}

/** Presentation only: never clears a hold or changes wallet/trading authority. */
export function recoveryAutonomy(autonomy: Autonomy, recovery: FleetRecoveryView | null | undefined): Autonomy {
  if (!pausedRecovery(recovery)) return autonomy;
  return { ...autonomy, state: "checking", label: "RECOVERING", rule: null,
    reason: "Trading remains paused pending reconciliation.",
    headline: null, action: null, needsOwnerAction: false,
    moneyLabel: autonomy.simulated ? "Last recorded paper cash" : "Last recorded cash" };
}

/** Recovery is not evidence that a bot is polling or able to reply. */
export function recoveryTelegram(status: TelegramStatus | null, now = Math.floor(Date.now() / 1000)): { label: string; detail: string | null } {
  if (!status) return { label: "Checking connection…", detail: null };
  if (!status.hasToken) return { label: "Not set up", detail: null };
  if (!status.enabled) return { label: "Switched off", detail: null };
  if (status.botElsewhere) return { label: "Connected to another agent", detail: null };
  if (status.listening?.state === "revoked" && !status.connected) return { label: "Token refused", detail: "Check the saved token in Settings." };
  if (!status.connected) return { label: "Connection unverified", detail: null };
  if (status.listening?.state === "conflict") return { label: "Another program has the bot", detail: "Replies are not confirmed." };
  const lastOkAt = status.listening?.lastOkAt;
  if (status.listening?.state === "held" && status.listening.reason === "recovery-replies"
      && status.tradingHeld === "recovery-replies" && typeof lastOkAt === "number" && Number.isSafeInteger(lastOkAt)
      && lastOkAt > 0 && lastOkAt <= now && now - lastOkAt <= LIVE_WITHIN_SEC) {
    return { label: "Listening for public questions", detail: "Charts and project descriptions only. Trading remains paused." };
  }
  return { label: "Waiting for recovery", detail: status.listening?.state === "live"
    ? "Bot polling is confirmed. Trading stays paused."
    : "Replies are not confirmed while recovery is in progress." };
}
