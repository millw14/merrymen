/**
 * Is this install actually able to make a real trade?
 *
 * `merrymen doctor` answers "is the software installed and configured" — node,
 * npm, PATH, keys present, RPCs reachable, the grant not expired. It is good at
 * that and says nothing about the thing an owner is about to bet money on:
 * whether the account can trade at all.
 *
 * Of the conditions that must hold for one live trade, doctor checks none of
 * the following: the account's USDG, the account's ETH (the only one that
 * guarantees failure), whether the grant's CHAIN can trade, whether the
 * signature can sell what the basket buys, whether the trade size is above the
 * point where gas stops dominating, or whether a bundler API key actually
 * answers — its probe only runs for a hand-pasted full URL, so the common path
 * is never contacted.
 *
 * This is that check. It JUDGES rather than reports: a testnet grant is a
 * blocker, not a green line with an interesting number in it.
 *
 * Pure, and takes everything as data, so it is testable without a chain — the
 * CLI gathers, this decides.
 */

import {
  DEFAULT_BASKET_SYMBOLS,
  LEGACY_TRADEABLE_SYMBOLS,
  STOCK_TOKENS,
  TRADEABLE_SYMBOLS,
  grantHasMultihop,
  sellableAssets,
  type StoredGrant,
} from "../../packages/core/src/index";

/** Mainnet. Anything else cannot execute a real swap — see the chain check. */
export const TRADEABLE_CHAIN_ID = 4663;

/**
 * Below this, gas is most of a round trip rather than a rounding error.
 *
 * Measured on this chain: ~47 bps total at a 50 USDG leg (40.1 venue + 6.9
 * gas), but ~89 bps at 6.25 (33.6 + 55.2). Gas is a fixed cost per operation,
 * so it is `~400/size` bps — it dominates precisely when the trade is small.
 */
export const GAS_FLOOR_USDG = 40;

export type Level = "ok" | "warn" | "blocker";

export interface Check {
  id: string;
  level: Level;
  title: string;
  /** What to do about it. Empty for an `ok`. */
  detail?: string;
}

export interface PreflightInput {
  settings: {
    bundlerApiKey?: string;
    bundlerUrl?: string;
    paperTradingEnabled?: boolean;
    basketSymbols?: string[];
    buyPerTickUsdg?: number;
    idleFloorUsdg?: number;
    /** RPC overrides, if the owner set them — the CLI reads balances through these. */
    rpcMainnet?: string;
    rpcTestnet?: string;
  };
  /**
   * Is a sponsor paying this agent's TRADING gas?
   *
   * Not read from `settings` above, because sponsorship resolves from the
   * settings file OR the environment and this shape is the raw file. The caller
   * resolves it the same way the worker does and passes the answer.
   *
   * Absent means no, which is the default and every deployment that has not
   * opted in.
   */
  sponsored?: boolean;
  grant: StoredGrant | null;
  nowSec: number;
  /** Read from the grant's chain. null = could not be read, which is not zero. */
  usdg: number | null;
  ethWei: bigint | null;
  /** null = not probed (no bundler configured at all). */
  bundlerReachable: boolean | null;
  /**
   * Names of WALL_POLICY_CONTRACTS entries with no code on the grant chain.
   * `[]` means all present; `null` means the probe could not run — which says
   * nothing about the contracts and must never read as "absent".
   */
  missingPolicyContracts: string[] | null;
  /**
   * Does THIS grant seal the dead rate-limit policy?
   *
   * A DIFFERENT QUESTION FROM THE ONE ABOVE, and the gap between them is why
   * this command reported a healthy install for a grant that could never
   * validate. `missingPolicyContracts` probes the three singletons this code
   * seals TODAY. It cannot see what an OLDER signature sealed — and a signature
   * is frozen, so the only grants that carry the dead policy are exactly the
   * ones no probe of current addresses will ever look at.
   *
   * Passed as data rather than computed here, like the probe above:
   * `grantHasDeadRateLimit` lives in `session-account.ts`, which imports the
   * whole ZeroDev SDK, and this module's entire value is being pure enough to
   * test without a chain.
   */
  deadPolicy: boolean;
  /**
   * Does the smart account have code on the grant chain? `null` = not probed.
   *
   * Not a blocker in either direction: an account with no code is the normal
   * state of one that has never traded, and 4337 deploys it with the first
   * operation. It is here because it changes what the FIRST operation costs and
   * because it is the only observable that distinguishes "the wall is signed"
   * from "the wall has been evaluated by a chain".
   */
  accountDeployed: boolean | null;
}

const ok = (id: string, title: string): Check => ({ id, level: "ok", title });

export function preflight(input: PreflightInput): Check[] {
  const out: Check[] = [];
  const s = input.settings;
  const g = input.grant;

  // ── the signer ────────────────────────────────────────────────────────
  const hasBundler = Boolean(s.bundlerApiKey || s.bundlerUrl);
  if (!hasBundler) {
    out.push({
      id: "bundler",
      level: "blocker",
      title: "no bundler key — nothing can be signed",
      detail:
        "A smart account can only act by sending a UserOperation, and that needs a bundler. " +
        "Get a free key at dashboard.pimlico.io and paste it into /settings. " +
        "Without one the agent runs in paper mode: real prices, simulated fills, nothing signed.",
    });
  } else if (input.bundlerReachable === false) {
    out.push({
      id: "bundler",
      level: "blocker",
      title: "bundler configured but not answering",
      detail: "It did not respond to eth_supportedEntryPoints. Check the key or URL in /settings.",
    });
  } else {
    out.push(ok("bundler", input.bundlerReachable ? "bundler reachable" : "bundler key configured"));
  }

  // ── the grant ─────────────────────────────────────────────────────────
  if (!g) {
    out.push({
      id: "grant",
      level: "blocker",
      title: "no grant signed",
      detail: "Sign one at http://localhost:3100/grant — that is what gives the agent its bounded key.",
    });
    return out; // every check below reads the grant
  }

  if (g.chainId !== TRADEABLE_CHAIN_ID) {
    out.push({
      id: "chain",
      level: "blocker",
      title: `grant is on chain ${g.chainId} — it cannot trade`,
      detail:
        "Testnet is practice only. Every token and router address merrymen knows is a MAINNET " +
        `deployment, so a funded testnet balance reads as 0 and swaps only simulate. Re-sign at ` +
        `/grant and pick mainnet ${TRADEABLE_CHAIN_ID} (it asks you to confirm, deliberately).`,
    });
  } else {
    out.push(ok("chain", `mainnet ${TRADEABLE_CHAIN_ID} — real funds`));
  }

  // ── the contracts the wall itself is built on ────────────────────────
  // A ZeroDev policy is an address plus its data, and the addresses are the
  // library's defaults for a deployment it assumes exists. On this chain one of
  // them did not: RATE_LIMIT_POLICY_CONTRACT has zero bytes on 4663 AND 46630,
  // measured 2026-08-30, while the timestamp policy, the call policy and the
  // ECDSA signer all carry real bytecode. Every grant built before that
  // discovery sealed a pointer into empty space.
  //
  // A BLOCKER, unlike the arm-time warn that mirrors it. The whole job of this
  // command is to answer "can this thing trade", and the honest answer when the
  // wall's own validator contracts are absent is no — the failure would
  // otherwise arrive as a UserOp that will not validate, reported by nothing,
  // at the price of a prefund per attempt.
  //
  // `null` means the probe did not run (no RPC, or the CLI could not reach the
  // chain). That is NOT the same as absent, and it must not read as one.
  if (input.missingPolicyContracts === null) {
    out.push({
      id: "policy-contracts",
      level: "warn",
      title: "couldn't check the contracts the wall is built on",
      detail:
        "The signature seals the addresses of the ZeroDev policy contracts it validates against. " +
        "This run could not read the chain to confirm they are deployed, so it is unverified rather " +
        "than fine. Re-run when the RPC is reachable.",
    });
  } else if (input.missingPolicyContracts.length > 0) {
    out.push({
      id: "policy-contracts",
      level: "blocker",
      title: `the wall depends on contracts with no code on chain ${g.chainId}`,
      detail:
        `${input.missingPolicyContracts.join(", ")} — every UserOp this grant signs is validated ` +
        "against them, so nothing can land until this is resolved. This is a merrymen bug, not " +
        "something you configured: report it rather than working around it.",
    });
  } else {
    out.push(ok("policy-contracts", "the wall's validator contracts are deployed"));
  }

  // THE ONE CONDITION NO AMOUNT OF SETUP CAN CLEAR.
  //
  // Ahead of expiry, funding and sizing, because it invalidates every one of
  // them: an owner who reads "fund 50 USDG" and does it has spent real money on
  // an account whose every operation will still fail validation. Measured
  // 2026-08-30 — RATE_LIMIT_POLICY_CONTRACT has zero bytes on 4663 AND 46630.
  if (input.deadPolicy) {
    out.push({
      id: "dead-policy",
      level: "blocker",
      title: "this key was signed before a wall fix and CANNOT trade",
      detail:
        "It seals a rate-limit policy whose contract has no code on this chain, so Kernel has " +
        "nothing to call and every operation fails validation. A signature is frozen: no deploy, " +
        "no funding and no setting fixes it. Re-signing is free and instant — open the wallet page " +
        "and use 're-sign this key'. Your funds are untouched, and practice mode still works.",
    });
  }

  if (input.accountDeployed === false) {
    out.push({
      id: "account",
      level: "warn",
      title: "this account has never operated",
      detail:
        "A smart account is counterfactual until its first operation deploys it, so this is normal " +
        "for a new install. Two consequences worth knowing before you fund it: the first operation " +
        "costs meaningfully more than the ones after it, and no chain has yet evaluated the " +
        "permissions this key was signed under.",
    });
  } else if (input.accountDeployed === true) {
    out.push(ok("account", "the account is deployed"));
  }

  const secsLeft = g.expiresAt - input.nowSec;
  if (secsLeft <= 0) {
    out.push({
      id: "expiry",
      level: "blocker",
      title: "grant EXPIRED",
      detail: "Re-sign at /grant. Same wallet, same funds — a session key is meant to run out.",
    });
  } else if (secsLeft < 2 * 86_400) {
    out.push({
      id: "expiry",
      level: "warn",
      title: `grant expires in ${Math.floor(secsLeft / 3600)}h`,
      detail: "Re-sign before it lapses, or the agent stops mid-run.",
    });
  } else {
    out.push(ok("expiry", `grant valid for ${Math.floor(secsLeft / 86_400)}d`));
  }

  // ── what this signature can actually sell ─────────────────────────────
  const sellable = sellableAssets(g);
  // An ABSENT basketSymbols is not an empty basket — it means the worker will
  // use its default. Treating it as empty made the leg-size maths divide by one
  // and report a leg three times the real size, which is the opposite of the
  // warning this check exists to give.
  const basket = s.basketSymbols?.length ? s.basketSymbols : [...DEFAULT_BASKET_SYMBOLS];
  const uncovered = basket.filter((sym) => {
    const token = STOCK_TOKENS.find((t) => t.symbol === sym);
    return !token || !sellable.has(token.address.toLowerCase());
  });
  if (uncovered.length) {
    out.push({
      id: "sellable",
      level: "blocker",
      title: `this key cannot sell ${uncovered.join(", ")}`,
      detail:
        "Buys of those are refused outright (the `no-exit` rule) — entering a position the key " +
        "cannot exit is the one outcome no cap protects you from. Re-sign at /grant to cover them.",
    });
  } else if (basket.length) {
    out.push(ok("sellable", `all ${basket.length} basket symbol(s) are sellable by this key`));
  }

  const isLegacy = !(g.grantFeatures ?? []).includes("tradeable-v2");
  if (isLegacy) {
    const gained = TRADEABLE_SYMBOLS.filter(
      (sym) => !(LEGACY_TRADEABLE_SYMBOLS as readonly string[]).includes(sym),
    );
    out.push({
      id: "grant-features",
      level: "warn",
      title: `legacy grant — limited to ${LEGACY_TRADEABLE_SYMBOLS.join("/")}`,
      detail: `Re-signing widens it to ${TRADEABLE_SYMBOLS.length} names, adding ${gained.join(", ")}. Free, same wallet.`,
    });
  }

  if (!grantHasMultihop(g)) {
    out.push({
      id: "multihop",
      level: "warn",
      title: "single-hop routes only",
      detail:
        "This key can't execute a multi-hop swap, so tokens with no direct USDG pool are " +
        "unreachable — that is most memecoins on this chain. The stock basket is unaffected.",
    });
  }

  // ── funding ───────────────────────────────────────────────────────────
  // ETH first: it is the one that guarantees failure, and the one people forget
  // because USDG is the thing they think of as "the money".
  if (input.ethWei === null) {
    out.push({
      id: "gas",
      level: "warn",
      title: "couldn't read the account's ETH",
      detail: "Check the RPC. Without ETH the account cannot pay for a single operation.",
    });
  } else if (input.ethWei === 0n && input.sponsored) {
    // SPONSORED: zero ETH no longer stops a trade, so calling it a blocker would
    // fail a deployment that works. It is still worth saying, because the way
    // OUT is not sponsored — recovery pays its own fee from the balance it is
    // sweeping — so an owner who never adds any ETH can trade for months and
    // then find they cannot withdraw.
    //
    // A warning, not an ok: the account is one step short of complete, and this
    // is the only screen that will ever mention it.
    out.push({
      id: "gas",
      level: "warn",
      title: "no ETH — trading is sponsored, but moving money OUT is not",
      detail:
        `A sponsor pays the network fee on this agent's trades, so an empty ETH balance does not ` +
        "stop it trading. Sweeping funds back to your own wallet is a different path and pays " +
        `its own way, so send a dollar or two of ETH to ${g.smartAccount} before you need to ` +
        "withdraw.",
    });
  } else if (input.ethWei === 0n) {
    out.push({
      id: "gas",
      level: "blocker",
      title: "no ETH — every operation fails before it reaches the chain",
      detail:
        `Send ETH to ${g.smartAccount}. The account pays its own gas (there is no paymaster), ` +
        "and USDG is capital — it cannot pay for anything. The FIRST operation also pays to " +
        "deploy the account, so it costs more than the ones after it.",
    });
  } else {
    out.push(ok("gas", `${(Number(input.ethWei) / 1e18).toFixed(6)} ETH for gas`));
  }

  const perTick = s.buyPerTickUsdg ?? 25;
  if (input.usdg === null) {
    out.push({
      id: "cash",
      level: "warn",
      title: "couldn't read the account's USDG",
      detail: "Check the RPC, or the chain — a testnet account always reads 0.",
    });
  } else if (input.usdg <= 0) {
    out.push({
      id: "cash",
      level: "blocker",
      title: "no USDG — nothing to trade with",
      detail: `Send USDG to ${g.smartAccount} on chain ${g.chainId}.`,
    });
  } else if (input.usdg < perTick) {
    out.push({
      id: "cash",
      level: "warn",
      title: `${input.usdg.toFixed(2)} USDG is below one tick's buy (${perTick})`,
      detail: "The strategy will hold rather than trade until there is enough for a full round.",
    });
  } else {
    out.push(ok("cash", `${input.usdg.toFixed(2)} USDG`));
  }

  // ── sizing ────────────────────────────────────────────────────────────
  const legs = Math.max(1, basket.length);
  const legSize = perTick / legs;
  if (legSize < GAS_FLOOR_USDG) {
    out.push({
      id: "leg-size",
      level: "warn",
      title: `${legSize.toFixed(2)} USDG per leg — gas will dominate`,
      detail:
        `${perTick} USDG per tick split ${legs} way(s). Below about ${GAS_FLOOR_USDG} USDG a trade ` +
        "pays more in gas than in venue fees, so the result measures your gas bill rather than the " +
        "strategy. Raise buyPerTickUsdg or trade fewer symbols.",
    });
  } else {
    out.push(ok("leg-size", `${legSize.toFixed(2)} USDG per leg`));
  }

  // The vault sweep is a real day-one surprise: it fires on the first tick and
  // a vault deposit counts against the DAILY spend cap, so it can consume most
  // of the day's allowance before the agent has traded anything.
  const idleFloor = s.idleFloorUsdg ?? 50;
  if (input.usdg !== null && input.usdg > idleFloor + perTick) {
    out.push({
      id: "idle-sweep",
      level: "warn",
      title: `idle cash above ${idleFloor} USDG is swept to the vault on the first tick`,
      detail:
        `About ${(input.usdg - idleFloor - perTick).toFixed(2)} USDG would move to Morpho immediately, ` +
        "and that deposit counts against the daily spend cap — so it can eat most of the day's " +
        "allowance before any trading happens. Raise idleFloorUsdg above your deposit to stop it.",
    });
  }

  return out;
}

/** Blockers first, then warnings — an operator reads the top of the list. */
export function rank(checks: readonly Check[]): Check[] {
  const order: Record<Level, number> = { blocker: 0, warn: 1, ok: 2 };
  return [...checks].sort((a, b) => order[a.level] - order[b.level]);
}

export function verdict(checks: readonly Check[]): { ready: boolean; blockers: number; warnings: number } {
  const blockers = checks.filter((c) => c.level === "blocker").length;
  const warnings = checks.filter((c) => c.level === "warn").length;
  return { ready: blockers === 0, blockers, warnings };
}
