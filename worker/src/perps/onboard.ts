/**
 * THE ON-CHAIN LEGS OF PERPETUALS — deposit, key registration, claim — and the
 * one decision about which of them comes next (docs/perps.md, rules 3, 5, 12,
 * and the `onboard.ts` bullet).
 *
 * Everything the agent does at Lighter it does with the API key over Lighter's
 * L2, EXCEPT three things that only the account's L1 address can do, through
 * the wall, as UserOps on Robinhood Chain:
 *
 *   deposit   USDG.approve(proxy, a) + deposit(self, 3, 0, a). The first one
 *             CREATES the Lighter account (keyed on `_to`, numbered by the
 *             proxy in the same transaction: addressToAccountIndex(self)).
 *   key       changePubKey(index, 16, sealedKey). Authenticated only by
 *             msg.sender, so the Kernel can do it; needs the account to exist
 *             (so it cannot share the first deposit's batch — the index is
 *             unknown until that lands) and cross collateral > 0 (the venue
 *             refuses a key change on an empty account: error 21126).
 *   claim     withdrawPendingBalance(self, 3, pending). Pays this account and
 *             no other. Lighter's relayer normally claims first; this is the
 *             liveness fallback.
 *
 * PURE. `planOnboarding` is a state machine over reads the caller already
 * made; it touches no network, no store and no clock. The builders return EVM
 * calls and nothing else. The lane sends; the final fence (final-fence.ts
 * checkPerpDepositCalls / checkPerpKeyCalls / checkPerpClaimCalls) checks the
 * bytes before anything is signed — unconditionally, there is no other
 * builder and no skip.
 *
 * THE MODEL PROPOSES, THIS DISPOSES. Nothing here takes a producer's word for
 * an amount, an index or a key: the deposit is sized from the open it funds
 * and the caps, the index comes from the chain, the key from the grant.
 *
 * WHAT THE LANE DOES WITH EACH STEP (the call order; lane.ts/index.ts wire it):
 *
 *   1. Read, all of them fail-closed (unread is `null`/'unread', never 0):
 *        addressToAccountIndex(self) and getPendingBalance(self, 3) on chain
 *        (flatness.ts LighterChainRead), USDG balanceOf(self);
 *        GET /apikeys?account_index=idx&api_key_index=16 → apiKeySlotOf();
 *        /account → its `collateralMicro` (C, cross collateral);
 *        /withdrawalDelay (read each time — it varies, 626–1314 s seen).
 *   2. step = planOnboarding(...). At most ONE on-chain leg per tick.
 *   3. deposit  → buildDepositCalls → checkPerpDepositCalls → a `perp-margin`
 *                 deposit intent through checkPolicy (daily cap, collateral
 *                 cap, incident, halt…) → perp_transfers row `submitted`
 *                 BEFORE the UserOp (rule 12a) → the UserOp rail.
 *      register-key → buildKeyCalls → checkPerpKeyCalls → trade kind
 *                 `perp-key` → the UserOp rail. Record `registered_pubkey`
 *                 only once the venue shows it (step `ready`).
 *      claim    → buildClaimCalls → checkPerpClaimCalls → a `perp-margin`
 *                 claim intent (an exit: never capped or halted).
 *      ready    → verifyKeyUsable at arm and after every registration; only a
 *                 pass arms live perps. If ledger.registeredPubKey is not the
 *                 sealed key, record it now (patchPerpAccount).
 *      key-foreign / key-retired(inSlot) → the durable `perp-venue-incident`
 *                 (rule 16): no opens, stand-down, the owner told to recover.
 *      key-retired → perps refused for this grant (`perp-key-retired`): the
 *                 owner re-signs with a fresh key.
 *      cannot-fund → the open this deposit would fund is refused under the
 *                 named rule; nothing is deposited.
 *      await-credit / await-key / idle / unread → nothing on chain this tick.
 */

import { encodeFunctionData, erc20Abi } from "viem";
import {
  GRANT_PERP_LIGHTER,
  LIGHTER_CHANGE_PUBKEY_ABI,
  LIGHTER_DEPOSIT_ABI,
  LIGHTER_ROUTE_V1,
  LIGHTER_WITHDRAW_PENDING_ABI,
  validatePerpPubKey,
  type PerpBlocker,
  type PerpGrant,
} from "../../../packages/core/src/index";
import type { Call } from "../executor";
import type { ApiKeyRead } from "./markets";
import type { LighterResult } from "./api";

// ── constants ───────────────────────────────────────────────────────────────

/** Lighter's floor, assetConfigs(3).minDepositTicks at tick 1: one USDG. A smaller deposit reverts. */
export const MIN_DEPOSIT_MICRO = LIGHTER_ROUTE_V1.minDepositMicro;

/**
 * A deposit funds the open's margin PLUS this share of it (10%): rounding of
 * the IOC's worst price into the venue's integer units, and the gap between
 * the notional the policy judged and the one the venue margins, must not
 * leave the open a few micro short — an open refused for margin after its
 * deposit landed has spent a UserOp for nothing. Never a reason to exceed a
 * cap: the buffer is clamped first (planDeposit).
 */
export const DEPOSIT_BUFFER_DIVISOR = 10n;

/**
 * The relayer's grace before we claim ourselves: 2 × the venue's current
 * withdrawalDelay + this (the margin-in-transit amendment, 12c). Waiting is
 * free; racing the relayer is not — whichever claim lands second reverts
 * (a claim for more than is pending), after its gas was paid.
 */
export const CLAIM_GRACE_SEC = 600;

const UINT48_MAX = 2n ** 48n - 1n;
const UINT128_MAX = 2n ** 128n - 1n;

// ── the key slot ────────────────────────────────────────────────────────────

/**
 * What the venue holds at (our account, the route's key index): a key
 * (canonical `0x` + 80 lowercase hex), `empty` (the venue said so: 21109 "api
 * key not found"), or `unread`.
 */
export type ApiKeySlot = { publicKey: `0x${string}` } | "empty" | "unread";

/** The venue's code for an index holding no key (probe: GET /apikeys on an empty index). */
export const LIGHTER_APIKEY_NOT_FOUND = 21109;

/**
 * The api.ts answer to GET /apikeys?account_index=…&api_key_index=… as a slot.
 *
 * EMPTY ONLY ON THE VENUE'S OWN WORD (21109). A 200 carrying no key is
 * `unread`, not empty: `empty` is the one reading that lets the worker
 * register over whatever is really there, and registering over an
 * owner-rotated key would undo the owner's recover (wall-security.md,
 * owner-key-rotation-undone-by-session-key-or-worker). More than one key at
 * one index is not an answer we understand — `unread` too.
 */
export function apiKeySlotOf(read: LighterResult<ApiKeyRead[]>, apiKeyIndex: number = LIGHTER_ROUTE_V1.apiKeyIndex): ApiKeySlot {
  if (!read.ok) {
    return read.error.kind === "rejected" && read.error.code === LIGHTER_APIKEY_NOT_FOUND ? "empty" : "unread";
  }
  const at = read.value.filter((k) => k.apiKeyIndex === apiKeyIndex);
  if (at.length !== 1 || read.value.length !== 1) return "unread";
  const pk = validatePerpPubKey(at[0]!.publicKey);
  // A key the contract would never have accepted is not a key we can compare.
  return pk === null ? "unread" : { publicKey: pk };
}

/** Canonical form for comparison: lowercase `0x` + 80 hex, or null. */
function canon(pk: string | null | undefined): `0x${string}` | null {
  return typeof pk === "string" ? validatePerpPubKey(pk) : null;
}

// ── the state machine ───────────────────────────────────────────────────────

export interface OnboardingInput {
  /** grantPerp(grant): the sealed route, key index and public key — or null (no perps granted). */
  grantPerp: PerpGrant | null;
  chainState: {
    /** USDG balanceOf(self), micro; null = unread. */
    usdgBalanceMicro: bigint | null;
    /** addressToAccountIndex(self): 0 = no Lighter account yet; null = unread. */
    accountIndex: bigint | number | null;
    /** getPendingBalance(self, 3), micro (tick 1); null = unread. */
    pendingBalanceMicro: bigint | null;
    /**
     * Since when the pending money has been owed, unix s: the oldest open
     * withdraw row's created_at, or when a pending balance with no row was
     * first observed. null = not known, and then no claim is made.
     */
    pendingSinceSec?: number | null;
  };
  venue: {
    /** apiKeySlotOf(GET /apikeys at the route's index). 'unread' when there is no account to ask about. */
    apikeysAtIndex: ApiKeySlot;
    /**
     * C, the account's cross collateral, from ONE /account read; null = unread
     * or the venue does not show the account yet (a deposit landed, not yet
     * credited).
     */
    crossCollateralMicro: bigint | null;
    /** GET /withdrawalDelay, seconds, read for this decision; null = unread (no claim). */
    withdrawalDelaySec?: number | null;
  };
  ledger: {
    /** perp_accounts.registered_pubkey — the key this worker last saw registered at our index. */
    registeredPubKey: string | null;
    /** perp_accounts.retired_pubkeys — keys recover rotated away; never registered again. */
    retiredPubKeys: readonly string[];
    /**
     * Keys `recover` put at our index with the owner key (its throwaway), as it
     * recorded them. A later grant's fresh key may register over one of these;
     * any other key is foreign. Absent = none recorded.
     */
    ownerRotatedPubKeys?: readonly string[];
    /** Deposit rows not yet final (submitted or landed): one deposit at a time, never two. */
    depositsInFlight: number;
    /** Our perp-key UserOp is submitted, or landed and not yet shown by the venue. */
    keyRegistrationInFlight: boolean;
  };
  /**
   * The isolated margin of the PENDING OPEN this tick would place (notional ×
   * IMF at the IOC's worst price), micro; 0n / null when no open is pending.
   * NEVER the margin a losing position wants: a deposit funds an open and
   * nothing else, and no caller may use this to rescue a loser.
   */
  needMarginMicro: bigint | null;
  caps: {
    /** The wall's per-call cap on the deposit (min(sealed perTradeUsdg, …)), micro. */
    perTradeMicro: bigint;
    /** perpsMaxCollateralUsdg, micro — "the most you can lose on Lighter", in software. */
    maxCollateralMicro: bigint;
    /** Already committed at the venue: C + ΣM_iso + T_in (view.ts `committed`), micro. */
    committedMicro: bigint;
  };
  /** Unix s; only the claim's timing reads it. */
  nowSec?: number;
}

export type OnboardingUnread = "account-index" | "api-key" | "collateral" | "cash";

export type CannotFundRule = "perp-per-trade-cap" | "perp-collateral-cap" | "perp-below-min" | "perp-no-cash";

export type OnboardingStep =
  /** The grant carries no perp block: nothing on chain can be done (not even a claim through the wall). */
  | { kind: "not-granted" }
  /** A read this decision needs is unknown. Nothing on chain; never guessed. */
  | { kind: "unread"; what: OnboardingUnread }
  /** Nothing to do: no pending open to fund, no key to register, no claim due. */
  | { kind: "idle" }
  /** Post exactly this much margin (≥ 1 USDG, within every cap). */
  | { kind: "deposit"; amountMicro: bigint }
  /** The pending open cannot be funded without passing a cap (or the cash is not there). Nothing is deposited. */
  | { kind: "cannot-fund"; rule: CannotFundRule; detail: string }
  /** Our deposit is on its way (or landed and not yet credited): wait, never deposit twice. */
  | { kind: "await-credit" }
  /** Register the sealed key at the route's index on this account. */
  | { kind: "register-key"; accountIndex: number }
  /** A key we did not put there, and no rule lets us replace: an incident (rule 16). Never registered over. */
  | { kind: "key-foreign"; publicKey: `0x${string}` }
  /** The grant's sealed key was retired by recover. `inSlot`: it is back at our index anyway — an incident. */
  | { kind: "key-retired"; inSlot: boolean }
  /** Our registration is in flight; the venue does not show it yet. */
  | { kind: "await-key" }
  /** The sealed key is at our index and the open (if any) is funded. verifyKeyUsable before arming. */
  | { kind: "ready" }
  /** Claim this pending payout ourselves: the relayer has not, well past the venue's delay. */
  | { kind: "claim"; amountMicro: bigint };

function accountIndexOf(v: bigint | number | null): bigint | null {
  if (v === null) return null;
  if (typeof v === "bigint") return v >= 0n && v <= UINT48_MAX ? v : null;
  return Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null;
}

/**
 * IS A CLAIM OURS TO MAKE? Only when the pending balance has sat unclaimed
 * for 2 × the venue's CURRENT delay + 10 minutes — the relayer's normal
 * service, twice over — and every input is known. An unread delay, balance or
 * start is "not yet", never "now": a claim is harmless (it can only pay this
 * account) but a claim that races the relayer reverts after it was paid for,
 * and one sized from a guess reverts for certain.
 */
export function claimDue(a: {
  pendingBalanceMicro: bigint | null;
  pendingSinceSec: number | null | undefined;
  withdrawalDelaySec: number | null | undefined;
  nowSec: number | undefined;
}): bigint | null {
  const p = a.pendingBalanceMicro;
  if (p === null || p <= 0n || p > UINT128_MAX) return null;
  const since = a.pendingSinceSec;
  const delay = a.withdrawalDelaySec;
  const now = a.nowSec;
  if (typeof since !== "number" || !Number.isFinite(since)) return null;
  if (typeof delay !== "number" || !Number.isSafeInteger(delay) || delay < 0) return null;
  if (typeof now !== "number" || !Number.isFinite(now)) return null;
  return now - since >= 2 * delay + CLAIM_GRACE_SEC ? p : null;
}

/**
 * HOW MUCH TO DEPOSIT FOR THIS OPEN, or why it cannot be funded.
 *
 * Only when the cross collateral does not already cover the open's margin.
 * Then: top up to margin + 10%, at least Lighter's 1 USDG — and CLAMPED to the
 * per-call cap, the collateral headroom and the cash, in that order. The
 * buffer gives way to a cap; the margin itself never does: if what the caps
 * allow cannot cover the margin, the answer is `cannot-fund` under the cap
 * that bit, and the open is refused rather than a cap relaxed to reach it.
 */
export function planDeposit(a: {
  needMarginMicro: bigint;
  crossCollateralMicro: bigint;
  usdgBalanceMicro: bigint;
  caps: OnboardingInput["caps"];
}): { kind: "none" } | { kind: "deposit"; amountMicro: bigint } | { kind: "cannot-fund"; rule: CannotFundRule; detail: string } {
  const need = a.needMarginMicro;
  const have = a.crossCollateralMicro > 0n ? a.crossCollateralMicro : 0n;
  if (need <= 0n || have >= need) return { kind: "none" };
  const target = need + (need + DEPOSIT_BUFFER_DIVISOR - 1n) / DEPOSIT_BUFFER_DIVISOR;
  let amount = target - have;
  if (amount < MIN_DEPOSIT_MICRO) amount = MIN_DEPOSIT_MICRO;
  const shortfall = need - have;
  const headroom = a.caps.maxCollateralMicro - a.caps.committedMicro;
  let rule: CannotFundRule | null = null;
  if (amount > a.caps.perTradeMicro) {
    amount = a.caps.perTradeMicro;
    rule = "perp-per-trade-cap";
  }
  if (amount > headroom) {
    amount = headroom;
    rule = "perp-collateral-cap";
  }
  if (amount > a.usdgBalanceMicro) {
    amount = a.usdgBalanceMicro;
    rule = "perp-no-cash";
  }
  if (amount < shortfall) {
    const r = rule ?? "perp-collateral-cap";
    return {
      kind: "cannot-fund",
      rule: r,
      detail:
        r === "perp-per-trade-cap"
          ? `the open needs ${shortfall} micro-USDG more margin at Lighter, more than one deposit may post (${a.caps.perTradeMicro})`
          : r === "perp-no-cash"
            ? `the open needs ${shortfall} micro-USDG more margin at Lighter, and the account holds only ${a.usdgBalanceMicro} micro-USDG`
            : `the open needs ${shortfall} micro-USDG more margin at Lighter, past the collateral cap (${a.caps.committedMicro} of ${a.caps.maxCollateralMicro} committed)`,
    };
  }
  if (amount < MIN_DEPOSIT_MICRO) {
    return {
      kind: "cannot-fund",
      rule: rule === "perp-no-cash" ? "perp-no-cash" : "perp-below-min",
      detail: `only ${amount} micro-USDG may be posted, under Lighter's ${MIN_DEPOSIT_MICRO} minimum deposit, which reverts on chain`,
    };
  }
  return { kind: "deposit", amountMicro: amount };
}

/**
 * THE NEXT ON-CHAIN LEG, or why there is none. One step per call; the lane
 * acts on it and asks again next tick. The ORDER below is the contract:
 *
 *   1. No perp block on the grant → not-granted. Nothing through the wall.
 *   2. A claim that is due → claim. Money coming home is an exit: it waits on
 *      nothing below — not an unread key, not an incident (a claim can only
 *      pay this account, and a stand-down wants the money home).
 *   3. The chain's account index unread → unread.
 *   4. A key at our index that is neither the sealed key nor one we may
 *      replace → key-foreign. Replaceable means: this worker registered it
 *      (ledger.registeredPubKey) and it is not retired, or recover recorded
 *      it as the owner's rotation. Checked BEFORE anything is deposited,
 *      because money sent to an account whose key someone else holds is
 *      money that key can lose (rule 4). The sealed key itself at our index
 *      while retired → key-retired, inSlot: somebody holding the old grant put
 *      it back after the owner's recover.
 *   5. The sealed key retired → key-retired. No deposit, no registration: the
 *      key can never be registered again, so nothing is funded for it.
 *   6. No account yet: a deposit in flight → await-credit; an open to fund →
 *      deposit (it creates the account); else idle. Never a deposit without
 *      an open: the first deposit is not onboarding's to volunteer.
 *   7. Account, sealed key at our index → funded? ready, or deposit /
 *      await-credit / cannot-fund for the open's margin.
 *   8. Account, slot empty or replaceable → register-key, but only with C > 0
 *      (21126: the venue refuses a key change on an account with no cross
 *      collateral). C = 0 → await-credit while a deposit is on its way, a
 *      deposit when an open needs one (which also satisfies 21126), else
 *      idle. Our registration already in flight → await-key.
 */
export function planOnboarding(input: OnboardingInput): OnboardingStep {
  const perp = input.grantPerp;
  if (perp === null || perp.route !== GRANT_PERP_LIGHTER || perp.apiKeyIndex !== LIGHTER_ROUTE_V1.apiKeyIndex) {
    return { kind: "not-granted" };
  }
  const sealed = canon(perp.apiPublicKey);
  if (sealed === null) return { kind: "not-granted" };

  // 2 — the claim, first: an exit waits on nothing.
  const claim = claimDue({
    pendingBalanceMicro: input.chainState.pendingBalanceMicro,
    pendingSinceSec: input.chainState.pendingSinceSec,
    withdrawalDelaySec: input.venue.withdrawalDelaySec,
    nowSec: input.nowSec,
  });
  if (claim !== null) return { kind: "claim", amountMicro: claim };

  // 3 — the account, on the chain's word.
  const idx = accountIndexOf(input.chainState.accountIndex);
  if (idx === null) return { kind: "unread", what: "account-index" };

  const retiredRead = input.ledger.retiredPubKeys.map(canon);
  // A retired list we cannot read in full is not a shorter list: a key that
  // failed to parse might be exactly the one we are about to trust.
  if (retiredRead.some((k) => k === null)) return { kind: "key-retired", inSlot: false };
  const retired = new Set(retiredRead as `0x${string}`[]);
  const ownerRotated = new Set((input.ledger.ownerRotatedPubKeys ?? []).map(canon).filter((k): k is `0x${string}` => k !== null));
  const ours = canon(input.ledger.registeredPubKey);
  const slot = idx > 0n ? input.venue.apikeysAtIndex : "unread";

  // 4 — what is at our index, before a single micro more goes there.
  if (typeof slot === "object") {
    const there = canon(slot.publicKey);
    if (there === null) return { kind: "unread", what: "api-key" };
    if (there === sealed) {
      if (retired.has(sealed)) return { kind: "key-retired", inSlot: true };
    } else {
      const replaceable = (ours !== null && there === ours && !retired.has(there)) || ownerRotated.has(there);
      if (!replaceable) return { kind: "key-foreign", publicKey: there };
    }
  }

  // 5 — a key that can never be registered again funds nothing.
  if (retired.has(sealed)) return { kind: "key-retired", inSlot: false };

  const need = input.needMarginMicro !== null && input.needMarginMicro > 0n ? input.needMarginMicro : 0n;
  const inFlight = input.ledger.depositsInFlight > 0;
  const fund = (collateral: bigint): OnboardingStep | null => {
    if (need === 0n) return null;
    if (collateral >= need) return null;
    if (inFlight) return { kind: "await-credit" };
    const cash = input.chainState.usdgBalanceMicro;
    if (cash === null) return { kind: "unread", what: "cash" };
    const d = planDeposit({ needMarginMicro: need, crossCollateralMicro: collateral, usdgBalanceMicro: cash, caps: input.caps });
    if (d.kind === "none") return null;
    return d;
  };

  // 6 — no account yet: only a deposit creates one, and only for an open.
  if (idx === 0n) {
    if (inFlight) return { kind: "await-credit" };
    return fund(0n) ?? { kind: "idle" };
  }

  // 7/8 — an account exists.
  if (slot === "unread") return { kind: "unread", what: "api-key" };
  const c = input.venue.crossCollateralMicro;
  if (typeof slot === "object" && canon(slot.publicKey) === sealed) {
    if (need === 0n) return { kind: "ready" };
    if (c === null) return inFlight ? { kind: "await-credit" } : { kind: "unread", what: "collateral" };
    return fund(c) ?? { kind: "ready" };
  }
  // The slot is empty, or holds a key we may replace.
  if (input.ledger.keyRegistrationInFlight) return { kind: "await-key" };
  if (c === null) return inFlight ? { kind: "await-credit" } : { kind: "unread", what: "collateral" };
  if (c > 0n) return { kind: "register-key", accountIndex: Number(idx) };
  // 21126: no key change on an account with no cross collateral.
  if (inFlight) return { kind: "await-credit" };
  return fund(0n) ?? { kind: "idle" };
}

/**
 * The perps blocker a step implies for the owner-facing report (core
 * PERP_BLOCKERS), or null when the step is not a reason perps are not
 * trading. A key at our index that is not ours — foreign, or a retired key
 * put back — is `perps-key-mismatch`, whose remedy is recover; a retired
 * sealed key needs the same remedy's second half (re-sign), which that text
 * also names.
 */
export function onboardingBlocker(step: OnboardingStep): PerpBlocker | null {
  switch (step.kind) {
    case "not-granted":
      return "perps-not-granted";
    case "unread":
      return step.what === "cash" ? null : "perps-venue-unreachable";
    case "deposit":
    case "await-credit":
      return "perps-awaiting-deposit";
    case "register-key":
    case "await-key":
      return "perps-key-pending";
    case "key-foreign":
    case "key-retired":
      return "perps-key-mismatch";
    case "cannot-fund":
      return step.rule === "perp-no-cash" ? "perps-no-collateral" : null;
    case "idle":
    case "ready":
    case "claim":
      return null;
  }
}

// ── the builders ────────────────────────────────────────────────────────────
//
// Each returns the calls the matching final-fence lane accepts, and nothing
// else. The proxy, token, asset, route and key index come from the frozen
// LIGHTER_ROUTE_V1 — the route a `perp-lighter-v1` grant names forever — and
// the key from the grant; no producer supplies any of them. Each THROWS on a
// term that could not have been decided (an intent built wrong), rather than
// hand the fence calldata it should never see.

function requirePerp(perp: PerpGrant): void {
  if (perp === null || typeof perp !== "object" || perp.route !== GRANT_PERP_LIGHTER || perp.apiKeyIndex !== LIGHTER_ROUTE_V1.apiKeyIndex) {
    throw new Error("perp onboarding: the grant carries no Lighter route (grantPerp)");
  }
}

function requireAccount(account: string): `0x${string}` {
  if (typeof account !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(account)) throw new Error(`perp onboarding: ${String(account)} is not an account address`);
  return account.toLowerCase() as `0x${string}`;
}

/**
 * [USDG.approve(proxy, a), proxy.deposit(account, 3, 0, a)] — EXACTLY the
 * deposit, never a ceiling above it: an allowance larger than the deposit is
 * a standing permission the proxy keeps.
 */
export function buildDepositCalls(a: { perp: PerpGrant; account: `0x${string}`; amountMicro: bigint }): Call[] {
  requirePerp(a.perp);
  const account = requireAccount(a.account);
  if (typeof a.amountMicro !== "bigint" || a.amountMicro < MIN_DEPOSIT_MICRO || a.amountMicro > UINT128_MAX) {
    throw new Error(`perp onboarding: a deposit of ${String(a.amountMicro)} is under Lighter's minimum or not an amount`);
  }
  const proxy = LIGHTER_ROUTE_V1.proxy;
  return [
    { to: LIGHTER_ROUTE_V1.usdg, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [proxy, a.amountMicro] }) },
    {
      to: proxy,
      value: 0n,
      data: encodeFunctionData({
        abi: LIGHTER_DEPOSIT_ABI,
        functionName: "deposit",
        args: [account, LIGHTER_ROUTE_V1.assetIndex, LIGHTER_ROUTE_V1.routePerps, a.amountMicro],
      }),
    },
  ];
}

/**
 * [proxy.changePubKey(accountIndex, 16, sealedKey)] — the key comes from the
 * grant and from nowhere else, so this cannot register any key the wall did
 * not seal.
 */
export function buildKeyCalls(a: { perp: PerpGrant; accountIndex: number | bigint }): Call[] {
  requirePerp(a.perp);
  const pk = validatePerpPubKey(a.perp.apiPublicKey);
  if (pk === null) throw new Error("perp onboarding: the grant's sealed key is not a canonical Lighter API public key");
  const idx = typeof a.accountIndex === "bigint" ? a.accountIndex : Number.isSafeInteger(a.accountIndex) ? BigInt(a.accountIndex) : -1n;
  if (idx < 1n || idx > UINT48_MAX) throw new Error(`perp onboarding: account index ${String(a.accountIndex)} is not a Lighter account`);
  return [
    {
      to: LIGHTER_ROUTE_V1.proxy,
      value: 0n,
      data: encodeFunctionData({
        abi: LIGHTER_CHANGE_PUBKEY_ABI,
        functionName: "changePubKey",
        args: [Number(idx), LIGHTER_ROUTE_V1.apiKeyIndex, pk],
      }),
    },
  ];
}

/** [proxy.withdrawPendingBalance(account, 3, pending)] — pays this account and no other. */
export function buildClaimCalls(a: { perp: PerpGrant; account: `0x${string}`; amountMicro: bigint }): Call[] {
  requirePerp(a.perp);
  const account = requireAccount(a.account);
  if (typeof a.amountMicro !== "bigint" || a.amountMicro <= 0n || a.amountMicro > UINT128_MAX) {
    throw new Error(`perp onboarding: a claim of ${String(a.amountMicro)} is not an amount`);
  }
  return [
    {
      to: LIGHTER_ROUTE_V1.proxy,
      value: 0n,
      data: encodeFunctionData({
        abi: LIGHTER_WITHDRAW_PENDING_ABI,
        functionName: "withdrawPendingBalance",
        args: [account, LIGHTER_ROUTE_V1.assetIndex, a.amountMicro],
      }),
    },
  ];
}

// ── is the key we hold the key the venue holds? ─────────────────────────────

export type KeyUsableVerdict =
  | { ok: true }
  | {
      ok: false;
      rule: "perp-key-mismatch";
      /**
       * true: we could not find out (a read failed, rate limit, the signer
       * would not mint) — live perps stay unarmed and it is retried; the owner
       * is not told the key is compromised on a network blip. false: proven —
       * the venue holds another key, or refused a token our private key made.
       */
      unread: boolean;
      detail: string;
    };

/**
 * THE ARM-TIME SELF-CHECK (venue-signer-spike.md, arm-time-key-self-check).
 * Run at every arm and after every registration; only a pass arms live perps.
 *
 * TWO HALVES, BECAUSE EITHER ALONE PROVES NOTHING:
 *   1. The venue's key at our index EQUALS the sealed public key (compared
 *      canonically: lowercase, no 0x). This proves the right PUBLIC key is
 *      registered — not that we hold its private key.
 *   2. An auth-gated read, with a token our PRIVATE key minted for (account,
 *      16), is accepted. The signer's CreateClient takes a corrupted private
 *      key silently and has no derive-public-key call; the venue accepting
 *      its token is the proof the private key matches the registered one.
 *      Without it, a wrong key surfaces at the first exit — the one moment it
 *      must not.
 *
 * `authProbe` runs that read (e.g. accountActiveOrders with auth from the
 * signer's createAuthToken). It is not called when half 1 already failed.
 * Anything it throws — the signer unloadable, a token that would not mint —
 * is "could not check", never a pass.
 */
export async function verifyKeyUsable(args: {
  apikeysRead: ApiKeySlot | LighterResult<ApiKeyRead[]>;
  sealedPubKey: string;
  authProbe: () => Promise<LighterResult<unknown>>;
}): Promise<KeyUsableVerdict> {
  const sealed = canon(args.sealedPubKey);
  if (sealed === null) {
    return { ok: false, rule: "perp-key-mismatch", unread: false, detail: "the grant's sealed key is not a canonical Lighter API public key" };
  }
  const slot: ApiKeySlot =
    typeof args.apikeysRead === "object" && args.apikeysRead !== null && "ok" in args.apikeysRead ? apiKeySlotOf(args.apikeysRead) : (args.apikeysRead as ApiKeySlot);
  if (slot === "unread") {
    return { ok: false, rule: "perp-key-mismatch", unread: true, detail: "the key at the agent's Lighter index could not be read" };
  }
  if (slot === "empty") {
    return { ok: false, rule: "perp-key-mismatch", unread: false, detail: "Lighter holds no key at the agent's index" };
  }
  if (canon(slot.publicKey) !== sealed) {
    return { ok: false, rule: "perp-key-mismatch", unread: false, detail: "Lighter holds a different key at the agent's index than the one the grant sealed" };
  }
  let probe: LighterResult<unknown>;
  try {
    probe = await args.authProbe();
  } catch (e) {
    const why = e instanceof Error ? e.name : "error";
    return { ok: false, rule: "perp-key-mismatch", unread: true, detail: `an authenticated read could not be made (${why})` };
  }
  if (probe.ok) return { ok: true };
  const err = probe.error;
  // A REFUSAL OF OUR TOKEN is the proof: 401/403, or any venue refusal of a
  // read we built right. Rate limits, outages and unparseable answers say
  // nothing about the key.
  const refused = err.kind === "rejected" || err.status === 401 || err.status === 403;
  return {
    ok: false,
    rule: "perp-key-mismatch",
    unread: !refused,
    detail: refused
      ? "Lighter refused a token the agent's private key made: the key the agent holds is not the one registered"
      : `the authenticated read could not be completed (${err.kind})`,
  };
}
