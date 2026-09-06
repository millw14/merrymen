/**
 * Fund recovery — sweep an agent's smart account back to a wallet you control,
 * signed by the OWNER key (the account's sudo validator), NOT the session key.
 *
 * Why this exists: the address you funded is an ERC-4337 (ZeroDev Kernel) smart
 * account — a counterfactual contract, not a plain EOA. Its owner private key
 * derives a DIFFERENT address, so importing that key into MetaMask shows an
 * empty wallet while the funds sit in the smart account. And after a kill switch
 * the session key is gone. The one thing that always works: rebuild the account
 * from the owner key as the sudo signer and have IT move the money out.
 *
 * The sudo validator has no session-key policies attached, so recovery is not
 * bound by the per-trade / daily caps — it can move the whole balance in one op.
 * The account pays its own gas from its native ETH (no paymaster), exactly like
 * the trading executor. Nothing here transmits the key: it signs one UserOp
 * locally and only the signed op reaches the bundler.
 */

import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  http,
  parseAbi,
  type Address,
  type Chain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createKernelAccount, createKernelAccountClient } from "@zerodev/sdk";
import { KERNEL_V3_3, getEntryPoint } from "@zerodev/sdk/constants";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { assertDerivedAccount } from "../../packages/core/src/index";
import {
  CASH,
  MORPHO,
  STOCK_TOKENS,
  USDG_DECIMALS,
  isValidCustomToken,
} from "../../packages/core/src/index";
import { userOpGasConfig } from "./gas";

/** Shares are an ERC-4626 position: priced, never counted. Same reads snapshot.ts uses. */
const VAULT_READS = parseAbi(["function convertToAssets(uint256 shares) view returns (uint256)"]);

export interface TokenBalance {
  symbol: string;
  address: Address;
  raw: bigint;
  decimals: number;
  /**
   * Human-readable amount, for display only. "unknown" when the holding is
   * real but not expressible — see the vault leg, where the share count is
   * meaningless and the USDG value could not be read.
   */
  amount: string;
  /** Extra context for the owner when the number needs it. */
  note?: string;
}

export interface RecoverPlan {
  smartAccount: Address;
  ownerAddress: Address;
  /** Every token the account holds with a non-zero balance. */
  balances: TokenBalance[];
  gasWei: bigint;
  /**
   * What could not be READ — distinct from what is not held.
   *
   * A recovery that reports "this account is empty" because an RPC blinked is
   * how someone concludes their money is gone. Absence and ignorance are
   * different facts and this is where they are kept apart; `unreadable` being
   * non-empty means the plan is incomplete, not that the account is.
   */
  unreadable: string[];
}

export interface RecoverResult extends RecoverPlan {
  /** null when there was nothing to sweep. */
  txHash: `0x${string}` | null;
  to: Address;
  /** Held, but left behind — with the reason. Never silent. */
  skipped: { symbol: string; reason: string }[];
  /**
   * Native ETH actually swept, in wei. Reported separately from `balances`
   * because it is not a token transfer and cannot be swept in full — the
   * account pays this very operation's gas out of the same balance, so a
   * reserve stays behind on purpose.
   */
  nativeSweptWei: bigint;
  /** What was deliberately left to cover gas, in wei. */
  nativeReservedWei: bigint;
}

/**
 * What EVERY agent can hold without the owner configuring anything.
 *
 * The vault leg is not optional and its absence was the worst of this: the
 * idle-cash sweep parks most of the float in Morpho on the FIRST tick, so an
 * agent doing exactly what it is designed to do holds almost nothing else — and
 * recovery reported it as an empty account.
 *
 * Vault shares are a plain transferable ERC-20, so they move with the same
 * transfer() as anything else and the owner redeems them at leisure. Their
 * decimals are deliberately NOT guessed at 18: nothing in this repo establishes
 * them, and snapshot.ts goes through convertToAssets precisely to avoid the
 * question. The amount an owner confirms a sweep against must not be a number
 * we made up, so the vault row is priced in USDG instead (see planRecovery).
 */
const BUILTIN_SWEEPABLE: { symbol: string; address: Address; decimals: number }[] = [
  { symbol: "USDG", address: CASH.USDG as Address, decimals: USDG_DECIMALS },
  ...STOCK_TOKENS.map((t) => ({ symbol: t.symbol, address: t.address as Address, decimals: 18 })),
  { symbol: "vault", address: MORPHO.steakhouseUsdgVault as Address, decimals: USDG_DECIMALS },
];

/**
 * The builtin set plus whatever the owner added themselves.
 *
 * Recovery is the escape hatch, and it swept a list frozen at ship time — so
 * the exact tokens an owner chose, and every quarantined scout position (an
 * owner-added ERC-20 by definition), were stranded by the one command that
 * exists to get money out. The wall has nothing to do with it: this path signs
 * with the sudo validator and can move any ERC-20 the account holds.
 *
 * Builtin entries WIN on collision, and collision means symbol OR address —
 * the rule strategies/registry.ts already applies. Address-only dedupe would
 * let `{symbol:"AAPL", address:<anything>}` produce two identical-looking AAPL
 * rows in the confirmation prose with no way for the owner to tell which is
 * which, on the one screen where they are agreeing to move real money.
 *
 * Shape is re-validated here rather than trusted, because a caller reads
 * settings.json off disk directly. That is also why the parameter is `unknown`
 * rather than CustomToken: isValidCustomToken is a type guard over unknown, and
 * demanding a typed value here would only push a cast onto callers holding data
 * they have not checked — which is how an unvalidated address reaches an atomic
 * sweep of someone's whole account.
 */
export function sweepList(
  extra: readonly unknown[] = [],
): { symbol: string; address: Address; decimals: number }[] {
  const out = [...BUILTIN_SWEEPABLE];
  const addresses = new Set(out.map((t) => t.address.toLowerCase()));
  const symbols = new Set(out.map((t) => t.symbol.toUpperCase()));
  for (const t of extra) {
    if (!isValidCustomToken(t)) continue;
    const addr = t.address.toLowerCase();
    if (addresses.has(addr) || symbols.has(t.symbol.toUpperCase())) continue;
    addresses.add(addr);
    symbols.add(t.symbol.toUpperCase());
    out.push({ symbol: t.symbol, address: t.address as Address, decimals: t.decimals });
    // The same ceiling settings.ts puts on customTokens. A recovery is one
    // atomic UserOp, and an unbounded call list is one that runs out of gas
    // and moves nothing at all.
    if (out.length >= BUILTIN_SWEEPABLE.length + 50) break;
  }
  return out;
}

export type BalanceOutcome =
  | { kind: "read"; raw: bigint }
  /** Nothing is deployed at that address here. An honest zero. */
  | { kind: "absent" }
  /** We could not find out. NOT a zero — see RecoverPlan.unreadable. */
  | { kind: "unreadable" };

/**
 * THREE OUTCOMES, NOT TWO, and the middle one is the whole point.
 *
 * The original code was `.catch(() => 0n)`, which made an RPC failure
 * indistinguishable from an empty wallet — and a recovery that says "this
 * account is empty" because the network blinked is how somebody concludes their
 * money is gone.
 *
 * But a plain two-way ok/failed split is just as wrong in the other direction.
 * recover-cli accepts chain 46630, where every address in the registry is an
 * undeployed MAINNET address, so every read fails — and a two-way split would
 * flag all twenty-seven as "could not be read, that is NOT a zero balance",
 * which is false, alarming, and unactionable about an account that really is
 * empty. So a failed read asks the chain whether anything is deployed there at
 * all.
 *
 * THE TRAP, and the reason this is injectable rather than inline: viem's
 * getCode returns `undefined` — not "0x" — for an address with no contract; it
 * normalises "0x" away. So writing the probe as `.catch(() => undefined)` makes
 * "nothing is deployed" and "the probe itself failed" the SAME VALUE, and the
 * three-way split silently collapses back into the two-way one. That is exactly
 * the bug this function was extracted to make testable, and recover.test.ts
 * covers all four paths.
 */
export async function classifyBalance(io: {
  balanceOf: () => Promise<bigint>;
  getCode: () => Promise<string | undefined>;
}): Promise<BalanceOutcome> {
  try {
    return { kind: "read", raw: await io.balanceOf() };
  } catch {
    const probe = await io.getCode().then(
      (code) => ({ reached: true as const, code }),
      () => ({ reached: false as const, code: undefined }),
    );
    if (!probe.reached) return { kind: "unreadable" }; // we could not even ask
    if (probe.code === undefined || probe.code === "0x") return { kind: "absent" };
    return { kind: "unreadable" }; // a contract IS there, but it would not answer
  }
}

/**
 * Rebuild the smart account from the owner key and read what it holds. Read-only
 * — no bundler, no signing. Use this to show the user what recovery will move
 * (and to verify the owner key actually controls the expected account) before
 * they commit.
 */
export async function planRecovery(opts: {
  chain: Chain;
  ownerPrivateKey: `0x${string}`;
  rpcUrl?: string;
  /** If given, throw when the derived account doesn't match (wrong owner key). */
  expectedSmartAccount?: Address;
  /** Owner-added tokens from settings. Optional — the builtin set is the floor. */
  extraTokens?: readonly unknown[];
}): Promise<RecoverPlan> {
  const publicClient = createPublicClient({ chain: opts.chain, transport: http(opts.rpcUrl) });
  const entryPoint = getEntryPoint("0.7");
  const ownerAccount = privateKeyToAccount(opts.ownerPrivateKey);

  const ecdsaValidator = await signerToEcdsaValidator(publicClient, {
    signer: ownerAccount,
    entryPoint,
    kernelVersion: KERNEL_V3_3,
  });
  const account = await createKernelAccount(publicClient, {
    entryPoint,
    kernelVersion: KERNEL_V3_3,
    plugins: { sudo: ecdsaValidator },
  });

  // A sweep aimed at the zero address would be a signed transaction to nothing.
  assertDerivedAccount(account.address, "that owner key does not derive an account");

  if (
    opts.expectedSmartAccount &&
    account.address.toLowerCase() !== opts.expectedSmartAccount.toLowerCase()
  ) {
    throw new Error(
      `this owner key controls ${account.address}, not the expected ${opts.expectedSmartAccount}. ` +
        `Wrong key, or the account was created with a different Kernel version.`,
    );
  }

  const tokens = sweepList(opts.extraTokens);
  const unreadable: string[] = [];

  // THREE OUTCOMES, NOT TWO. A read can succeed, or find no contract at that
  // address, or fail. Collapsing the last two into "unreadable" would be just
  // as wrong as the `.catch(() => 0n)` this replaces — recover-cli accepts
  // chain 46630, where every address in the registry is an undeployed mainnet
  // address, so a two-way split would flag all of them and tell the owner to
  // "rerun before you trust it" about an account that is genuinely empty.
  //
  // An EOA-style call to an address with no code returns 0x, which viem raises
  // as a zero-data error. So on failure, ask the chain whether anything is
  // deployed there: no code is an honest zero, code plus a failed read is an
  // honest unknown.
  const readBalance = async (address: Address, label: string): Promise<bigint | null> => {
    const outcome = await classifyBalance({
      balanceOf: () =>
        publicClient.readContract({
          address,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [account.address],
        }) as Promise<bigint>,
      getCode: () => publicClient.getCode({ address }),
    });
    if (outcome.kind === "read") return outcome.raw;
    if (outcome.kind === "absent") return 0n;
    unreadable.push(label);
    return null;
  };

  const [gas, ...raws] = await Promise.all([
    publicClient
      .getBalance({ address: account.address })
      .then((v) => v as bigint)
      .catch(() => {
        // The gas leg gets the same discipline as the tokens. It is printed to
        // the owner, and a fabricated 0.000000 ETH is what convinces someone
        // their recovery cannot possibly work.
        unreadable.push("eth");
        return null;
      }),
    ...tokens.map((t) => readBalance(t.address, t.symbol)),
  ]);

  const held = tokens
    .map((t, i) => ({ t, raw: raws[i] ?? null }))
    .filter((x): x is { t: (typeof tokens)[number]; raw: bigint } => x.raw !== null && x.raw > 0n);

  const balances: TokenBalance[] = await Promise.all(
    held.map(async ({ t, raw }) => {
      if (t.address.toLowerCase() !== (MORPHO.steakhouseUsdgVault as string).toLowerCase()) {
        return { symbol: t.symbol, address: t.address, raw, decimals: t.decimals, amount: formatUnits(raw, t.decimals) };
      }
      // The vault row is priced, not counted. A raw share figure formatted at a
      // decimals we invented would be a number the owner confirms a real sweep
      // against — so ask the vault what the shares are worth, and say plainly
      // when it will not tell us rather than printing something plausible.
      const assets = await publicClient
        .readContract({
          address: t.address,
          abi: VAULT_READS,
          functionName: "convertToAssets",
          args: [raw],
        })
        .then((v) => v as bigint)
        .catch(() => null);
      if (assets === null) unreadable.push("vault value");
      return {
        symbol: t.symbol,
        address: t.address,
        raw,
        decimals: t.decimals,
        amount: assets === null ? "unknown" : formatUnits(assets, USDG_DECIMALS),
        note:
          assets === null
            ? "Morpho vault shares — held, but the vault would not price them. They sweep regardless."
            : "Morpho vault shares, shown at their USDG value. The shares move; redeem them at your leisure.",
      };
    }),
  );

  return {
    smartAccount: account.address,
    ownerAddress: ownerAccount.address,
    balances,
    gasWei: gas ?? 0n,
    unreadable,
  };
}

/**
 * Sweep every non-zero token balance AND the account's native ETH to `to` in a
 * single owner-signed UserOp (the account deploys itself on this same op if it
 * never traded). Requires a bundler — a counterfactual smart account cannot
 * move funds any other way.
 *
 * ETH USED TO BE ABANDONED HERE, on the reasoning that it only pays for this
 * op's gas and the remainder is dust. That holds on testnet and is wrong the
 * moment anyone funds a real account: gas money on mainnet is money, and an
 * account funded with ETH and no tokens hit the empty-balances branch below and
 * was told "nothing to recover" while its whole balance sat there. Someone
 * following the fund instructions — which ask for ETH for gas — could be told
 * their funded account was empty.
 *
 * So the ETH goes too, minus a reserve for this operation's own gas. The reserve
 * is deliberately generous: reserving too much leaves a little behind, while
 * reserving too little makes the op unaffordable and moves NOTHING, tokens
 * included. One of those is a rounding error and the other strands the sweep,
 * so the bias is not a close call.
 */
/**
 * How much native ETH can leave, and how much must stay to pay for the move.
 *
 * Pure, because this is the arithmetic that decides whether the sweep happens at
 * all. Reserve too little and the operation cannot be paid for, so NOTHING
 * moves — the tokens included — and the account is left exactly as stuck as
 * before. Reserve too much and a few cents stay behind. Those are not
 * comparable failures, so the buffer is deliberately fat: a gas limit well above
 * what a handful of transfers costs, doubled.
 *
 * Returns a zero sweep when the balance does not clear the reserve, which is the
 * ordinary case for an account holding only gas money.
 */
export function nativeSweep(heldWei: bigint, gasPriceWei: bigint): { sweep: bigint; reserve: bigint } {
  const GAS_LIMIT_GUESS = 900_000n;
  const reserve = gasPriceWei * GAS_LIMIT_GUESS * 2n;
  if (heldWei <= reserve) return { sweep: 0n, reserve: heldWei };
  return { sweep: heldWei - reserve, reserve };
}

export async function recoverFunds(opts: {
  chain: Chain;
  ownerPrivateKey: `0x${string}`;
  bundlerUrl: string;
  rpcUrl?: string;
  to: Address;
  expectedSmartAccount?: Address;
  extraTokens?: readonly unknown[];
}): Promise<RecoverResult> {
  const plan = await planRecovery({
    chain: opts.chain,
    ownerPrivateKey: opts.ownerPrivateKey,
    rpcUrl: opts.rpcUrl,
    expectedSmartAccount: opts.expectedSmartAccount,
    extraTokens: opts.extraTokens,
  });

  const publicClient = createPublicClient({ chain: opts.chain, transport: http(opts.rpcUrl) });

  // ── how much native ETH can leave ────────────────────────────────────────
  // The account pays for this operation out of the same balance it is sending,
  // so a reserve has to stay. Size it from the live gas price against a gas
  // limit comfortably above what a handful of transfers costs, then double it.
  // If the estimate is short the op simply cannot be paid for and NOTHING
  // moves — tokens included — so the buffer is protecting the whole sweep, not
  // just the ETH leg.
  let { sweep: nativeSweptWei, reserve: nativeReservedWei } = { sweep: 0n, reserve: plan.gasWei };
  try {
    ({ sweep: nativeSweptWei, reserve: nativeReservedWei } = nativeSweep(
      plan.gasWei,
      await publicClient.getGasPrice(),
    ));
  } catch {
    // Couldn't price gas — take nothing rather than risk making the op
    // unaffordable. The tokens still move, which is the larger sum.
  }

  if (plan.balances.length === 0 && nativeSweptWei === 0n) {
    return { ...plan, txHash: null, to: opts.to, skipped: [], nativeSweptWei: 0n, nativeReservedWei };
  }
  const entryPoint = getEntryPoint("0.7");
  const ownerAccount = privateKeyToAccount(opts.ownerPrivateKey);
  const ecdsaValidator = await signerToEcdsaValidator(publicClient, {
    signer: ownerAccount,
    entryPoint,
    kernelVersion: KERNEL_V3_3,
  });
  const account = await createKernelAccount(publicClient, {
    entryPoint,
    kernelVersion: KERNEL_V3_3,
    plugins: { sudo: ecdsaValidator },
  });
  assertDerivedAccount(account.address, "that owner key does not derive an account");
  const client = createKernelAccountClient({
    account,
    chain: opts.chain,
    bundlerTransport: http(opts.bundlerUrl),
    // See worker/src/gas.ts — required so recovery works with a Pimlico bundler.
    userOperation: userOpGasConfig(publicClient, opts.bundlerUrl),
  });

  // ONE BAD TOKEN MUST NOT STRAND THE REST. The sweep is a single atomic
  // UserOp, so a token that reverts on transfer — a blacklist, a paused
  // contract, a hostile scout buy — takes the whole recovery down with it and
  // there is no partial success to fall back on. So each leg is simulated
  // first, and the ones that cannot move are reported rather than allowed to
  // veto everything else.
  //
  // TWO THINGS THIS DELIBERATELY DOES NOT DO.
  //
  // It does not simulate through viem's `erc20Abi`, whose `transfer` declares a
  // bool return. Plenty of real ERC-20s return nothing at all (the USDT shape),
  // and viem raises a zero-data error for those — which would classify exactly
  // the odd, owner-added memecoins this fix exists to rescue as "reverting" and
  // strand them permanently. The no-output signature accepts both shapes.
  //
  // And it FAILS OPEN: if the simulation itself cannot run — an RPC error, a
  // timeout — the token is swept anyway. On the escape hatch, attempting a move
  // that might fail is strictly better than silently leaving money behind
  // because a network call flaked.
  const TRANSFER_ANY_RETURN = parseAbi(["function transfer(address,uint256)"]);
  const skipped: { symbol: string; reason: string }[] = [];
  const movable: TokenBalance[] = [];
  for (const b of plan.balances) {
    try {
      await publicClient.simulateContract({
        address: b.address,
        abi: TRANSFER_ANY_RETURN,
        functionName: "transfer",
        args: [opts.to, b.raw],
        account: account.address,
      });
      movable.push(b);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/revert|execution reverted/i.test(msg)) {
        skipped.push({ symbol: b.symbol, reason: msg.replace(/\s+/g, " ").slice(0, 120) });
      } else {
        movable.push(b); // couldn't tell — try it rather than abandon it
      }
    }
  }

  if (movable.length === 0 && nativeSweptWei === 0n) {
    // NOT "the account is empty". Everything here is held; none of it would
    // move. Callers must be able to tell those apart — `skipped` is non-empty
    // and says why for each one.
    return { ...plan, txHash: null, to: opts.to, skipped, nativeSweptWei: 0n, nativeReservedWei };
  }

  const calls = movable.map((b) => ({
    to: b.address,
    value: 0n,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [opts.to, b.raw] }),
  }));

  // The ETH leg goes LAST: a plain value transfer with no calldata. Ordering it
  // after the token moves means a token that reverts unexpectedly takes the ETH
  // down with it rather than the reverse — the account keeps its gas money and
  // the sweep can simply be retried.
  if (nativeSweptWei > 0n) {
    calls.push({ to: opts.to, value: nativeSweptWei, data: "0x" as `0x${string}` });
  }

  const userOpHash = await client.sendUserOperation({ callData: await account.encodeCalls(calls) });
  const receipt = await client.waitForUserOperationReceipt({ hash: userOpHash });
  if (!receipt.success) {
    throw new Error(`recovery UserOp reverted on-chain: ${userOpHash}`);
  }
  return {
    ...plan,
    balances: movable,
    txHash: receipt.receipt.transactionHash,
    to: opts.to,
    skipped,
    nativeSweptWei,
    nativeReservedWei,
  };
}
