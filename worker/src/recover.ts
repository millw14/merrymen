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

import { classSweepCandidates, findClassVaults, planClassSweep, readClassHoldings } from "./class-recovery";
import { readClassLog } from "./venues/class-log";
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
import { privateKeyToAccount, toAccount } from "viem/accounts";
import type { LocalAccount } from "viem";
import { createKernelAccount, createKernelAccountClient } from "@zerodev/sdk";
import { KERNEL_V3_3, getEntryPoint } from "@zerodev/sdk/constants";
import { signerToEcdsaValidator } from "@zerodev/ecdsa-validator";
import { assertDerivedAccount } from "../../packages/core/src/index";
import {
  CASH,
  MERRYMEN_TOKEN,
  MORPHO,
  STOCK_TOKENS,
  USDG_DECIMALS,
  energyReserveTokens,
  isValidCustomToken,
  shortAddress,
} from "../../packages/core/src/index";
import {
  GOLDILOCKS_P,
  LIGHTER_CHANGE_PUBKEY_ABI,
  LIGHTER_OWNER_RECOVER_ABI,
  LIGHTER_READ_ABI,
  LIGHTER_ROUTE_V1,
  LIGHTER_WITHDRAW_PENDING_ABI,
  validatePerpPubKey,
} from "../../packages/core/src/index";
// THE VENUE PARSERS, NOT THE VENUE CLIENT. markets.ts imports nothing but
// core, so it travels to the browser and the phones with this module; api.ts
// (cooldown files, node:fs) does not, which is why the reads below are a
// plain fetch rather than createLighterApi.
import {
  accountReadsEmpty,
  openPositions,
  parseAccount,
  parseAccountsByL1Address,
  parseApiKeys,
  parseOrderBookDetails,
  parseWithdrawalDelay,
  type PerpAccountRead,
  type PerpDecimals,
} from "./perps/markets";
import { userOpGasConfig } from "./gas";

/** Shares are an ERC-4626 position: priced, never counted. Same reads snapshot.ts uses. */
const VAULT_READS = parseAbi(["function convertToAssets(uint256 shares) view returns (uint256)"]);

/** The vault's unconditional exit. No recipient, no amount: one destination, fixed at construction. */
const CLASS_VAULT_SWEEP = parseAbi(["function sweep(address token) returns (uint256)"]);

/**
 * The vault owner, read to prove the account can actually sweep it.
 *
 * A PonsClassVault is owned by the SMART ACCOUNT, not by the human — measured
 * on chain, and it is why recovery must arrive as a UserOp. Checking it before
 * signing turns a NotOwner() revert into a refusal that costs nothing.
 */
const CLASS_VAULT_OWNER = parseAbi(["function owner() view returns (address)"]);

/**
 * How far back recovery reads a vault's history. ~7 days at 0.101 s/block.
 *
 * Bounded because an owner running this is waiting at a prompt. A holding older
 * than the window is NOT lost — it is simply absent from the enumeration, which
 * is why `classNote` says the list may be short rather than implying it is
 * complete.
 */
const CLASS_RECOVERY_LOOKBACK = 6_000_000n;

export interface TokenBalance {
  symbol: string;
  address: Address;
  raw: bigint;
  decimals: number;
  /**
   * Human-readable amount, for display only. "unknown" when the holding is
   * real but not expressible — see the vault leg, where the share count is
   * meaningless and the USDG value could not be read. "<n> raw units" when the
   * count is exact but the token will not state its decimals.
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
   * What the ETH leg WOULD move, and what would stay to pay for the move.
   *
   * A forecast, from the same `nativeSweep` the sweep itself uses — so the
   * confirmation can name the ETH instead of listing only the tokens. Zero
   * recoverable when the gas price could not be read, which also puts
   * "gas price" in `unreadable`: a disclosure must not promise ETH it cannot
   * price. The settled figures are `nativeSweptWei` on the result.
   */
  nativeRecoverableWei: bigint;
  nativeReserveWei: bigint;
  /**
   * What could not be READ — distinct from what is not held.
   *
   * A recovery that reports "this account is empty" because an RPC blinked is
   * how someone concludes their money is gone. Absence and ignorance are
   * different facts and this is where they are kept apart; `unreadable` being
   * non-empty means the plan is incomplete, not that the account is.
   */
  unreadable: string[];
  /**
   * What the CLASS VAULT holds, which the account itself does not.
   *
   * A separate field because it is a separate contract and a separate
   * operation: `sweep` moves a token from the vault to the account, and only
   * then can the ordinary transfer batch reach it. Reported here so an owner
   * can SEE it before deciding — `recover-cli` used to say "this account is
   * empty" about an owner whose whole book was class tokens.
   */
  classVault: Address | null;
  classHoldings: { token: Address; symbol: string; raw: bigint; amount: string; decimals: number }[];
  /**
   * Why the class list may be short. Null when it is complete.
   *
   * The class book is reconstructed from the vault's own ClassBuy logs, which
   * is the only source that works with no database and no worker — and a log
   * scan can be refused. An incomplete list must say so, for the same reason
   * `unreadable` exists.
   */
  classNote: string | null;
  /**
   * EVERY vault this account could have, because after v2 there are two.
   *
   * `classVault` above is still the PRIMARY one and every existing reader keeps
   * working through it — with one factory pinned there is exactly one candidate
   * and the two agree exactly, which is the state on this chain today.
   *
   * The second one is not hypothetical and the timing is the point. When an
   * owner re-signs onto a v2 factory their v1 vault stops being reachable by the
   * session key, so recovery becomes the only way left to whatever is still
   * sitting in it. A recovery that looks in one place reports "nothing found"
   * over a real balance.
   *
   * THE SWEEP TARGET TRAVELS WITH THE HOLDING. `sweep(token)` is a call ON a
   * vault, so a plural book needs a plural target — and the batch is atomic, so
   * two vaults cannot share one operation without a dead one taking the live one
   * down with it.
   */
  classVaults: {
    vault: Address;
    /** 1, 2, or null when the factory is in neither pinned table. Never guessed. */
    version: 1 | 2 | null;
    holdings: { token: Address; symbol: string; raw: bigint; amount: string; decimals: number }[];
    note: string | null;
  }[];
  /**
   * WHAT IS AT LIGHTER, which no transfer from this account can reach.
   *
   * Perp collateral, positions and a withdrawal waiting to be claimed live in
   * Lighter's settlement contract and its rollup, keyed on this account — so
   * a recovery that listed only the account's own balances would tell an
   * owner with 900 USDG on the venue that 12 USDG was everything. Read with
   * `eth_call` and the venue's public GETs only, so every platform that runs
   * this module can show it (docs/perps.md, "Recover").
   *
   * KEPT OUT OF `unreadable` ON PURPOSE. That list gates the phone's
   * withdrawal button (WithdrawScreen.swift disables "Review withdrawal"
   * while it is non-empty), and a venue the phone cannot reach must not
   * strand the USDG and ETH it can see. The venue group carries its own
   * unread states instead; `venueStanding` is what a surface asks before it
   * says anything is empty.
   *
   * Optional only for plans built by other code (tests, old callers):
   * planRecovery always sets it, and an ABSENT venue is unknown, never none.
   */
  venue?: RecoverVenue;
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
 *
 * $MERRYMEN IS SWEPT TOO, BUT ONLY WHERE IT EXISTS — see `reserveRows`.
 */
interface SweepToken {
  symbol: string;
  address: Address;
  decimals: number;
  /**
   * True for an owner token known only by its ADDRESS, whose `decimals` is then
   * a placeholder. The transfer never reads it — it moves `raw` — but the amount
   * the owner confirms against does, so `planRecovery` reads the real figure on
   * chain rather than formatting at a number nothing established.
   */
  decimalsUnknown?: true;
}

const BUILTIN_SWEEPABLE: SweepToken[] = [
  { symbol: "USDG", address: CASH.USDG as Address, decimals: USDG_DECIMALS },
  ...STOCK_TOKENS.map((t) => ({ symbol: t.symbol, address: t.address as Address, decimals: 18 })),
  { symbol: "vault", address: MORPHO.steakhouseUsdgVault as Address, decimals: USDG_DECIMALS },
];

/**
 * The energy reserve's row(s) on THIS chain — none where it is not deployed.
 *
 * The reserve is the agent's energy: bought into the account on the owner's
 * say-so, and deliberately never watched, never a position and never on any
 * token list the owner configures — so without this row the one command that
 * exists to get money out would leave it behind. A sweep of it moves no USDG,
 * so no capital flow is written, which is right: the reserve left the trading
 * book when it was bought.
 *
 * PER CHAIN, FROM `energyReserveTokens`, never a mainnet constant everywhere.
 * An unconditional row on testnet read `absent` (the mainnet address has no
 * code there) and, worse, TOOK THE NAME: an owner whose own custom token was
 * their testnet "MERRYMEN" had it dropped from the sweep as a symbol collision,
 * and was told nothing was left while it sat in the account. The reserve IS
 * $MERRYMEN wherever it is listed, so its label and decimals are the token's.
 */
function reserveRows(chainId: number): SweepToken[] {
  return energyReserveTokens(chainId).map((address) => ({
    symbol: MERRYMEN_TOKEN.symbol,
    address: address as Address,
    decimals: MERRYMEN_TOKEN.decimals,
  }));
}

/**
 * The builtin set for this chain plus whatever the owner added themselves.
 *
 * Recovery is the escape hatch, and it swept a list frozen at ship time — so
 * the exact tokens an owner chose, and every quarantined scout position (an
 * owner-added ERC-20 by definition), were stranded by the one command that
 * exists to get money out. The wall has nothing to do with it: this path signs
 * with the sudo validator and can move any ERC-20 the account holds.
 *
 * AN ADDRESS IS A TOKEN; A SYMBOL IS A LABEL. Same address as a row already
 * here → the same token, already swept, so it is skipped. Same SYMBOL at a
 * different address → a different token, and it is swept: dropping it would
 * strand the owner's money on the one path that exists to rescue it, which is
 * what a builtin $MERRYMEN row did to every other token called MERRYMEN. What
 * symbol-dedupe was protecting still holds: no two rows carry the same label.
 * The first row keeps the bare symbol — builtins come first, so the curated
 * address always does — and a later one is labelled with its address, so the
 * confirmation never shows two identical-looking "AAPL" rows on the one screen
 * where the owner is agreeing to move real money.
 *
 * Shape is re-validated here rather than trusted, because a caller reads
 * settings.json off disk directly. That is also why the parameter is `unknown`
 * rather than CustomToken: isValidCustomToken is a type guard over unknown, and
 * demanding a typed value here would only push a cast onto callers holding data
 * they have not checked — which is how an unvalidated address reaches an atomic
 * sweep of someone's whole account.
 *
 * AN ADDRESS WITH NO NAME IS NOT MALFORMED. The browser and the phone recover
 * signed out, so the only token list they hold is the grant's `grantTokens` —
 * addresses, nothing else — and they pass each as `{ address, symbol: "" }`.
 * isValidCustomToken refuses an empty symbol, which is right for settings,
 * where a ticker is required; here it silently dropped every owner-added token
 * from those sweeps and left it in the account. So an address-only entry is
 * accepted, with its address checked exactly as strictly as any other.
 *
 * It is labelled BY ADDRESS, never by a symbol read off the token: a contract
 * chooses its own `symbol()`, so a name the owner never typed — "USDG", say —
 * would lend a stranger's token the look of a curated one on the screen where
 * they agree to move money. A short address cannot collide with a ticker (the
 * `…` is outside the ticker alphabet); if two share one, the later gets its
 * full address — the same last resort a named collision takes.
 *
 * `chainId` IS REQUIRED: a caller that forgot it would silently never sweep
 * the reserve on mainnet, or sweep a codeless one elsewhere.
 */
export function sweepList(chainId: number, extra: readonly unknown[] = []): SweepToken[] {
  const out = [...BUILTIN_SWEEPABLE, ...reserveRows(chainId)];
  const floor = out.length;
  const addresses = new Set(out.map((t) => t.address.toLowerCase()));
  const labels = new Set(out.map((t) => t.symbol.toUpperCase()));
  for (const t of extra) {
    const named = isValidCustomToken(t);
    if (!named && !isAddressOnly(t)) continue;
    const addr = t.address.toLowerCase();
    if (addresses.has(addr)) continue;
    // A shortened address can itself repeat; the full one cannot.
    const short = shortAddress(addr);
    const candidates = named ? [t.symbol, `${t.symbol} (${short})`, `${t.symbol} (${addr})`] : [short, addr];
    const symbol = candidates.find((c) => !labels.has(c.toUpperCase())) ?? candidates[candidates.length - 1]!;
    addresses.add(addr);
    labels.add(symbol.toUpperCase());
    out.push(
      named
        ? { symbol, address: t.address as Address, decimals: t.decimals }
        : { symbol, address: t.address, decimals: 18, decimalsUnknown: true },
    );
    // The same ceiling settings.ts puts on customTokens. A recovery is one
    // atomic UserOp, and an unbounded call list is one that runs out of gas
    // and moves nothing at all.
    if (out.length >= floor + 50) break;
  }
  return out;
}

/** `{ address, symbol: "" }` (or no symbol at all), with a well-formed address. */
function isAddressOnly(t: unknown): t is { address: Address } {
  if (!t || typeof t !== "object") return false;
  const c = t as { symbol?: unknown; address?: unknown };
  return (
    (c.symbol === undefined || c.symbol === "") &&
    typeof c.address === "string" &&
    /^0x[0-9a-fA-F]{40}$/.test(c.address)
  );
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
 * WHO AUTHORISES A RECOVERY — a signer, not a key.
 *
 * This module took a raw `ownerPrivateKey` because there was only one kind of
 * owner: a keypair generated in a browser or written to ~/.merrymen. A hosted
 * agent owned by a PRIVY EMBEDDED WALLET has no such key and never will — the
 * whole point of it — so those accounts were structurally unrecoverable by the
 * one path that exists to get money out. Measured 2026-09-12 on a funded
 * account holding 1,063,408.141815 DOGGOS.
 *
 * `web/src/lib/session.ts:199` already solved this for MINTING, with the same
 * shape and for the same reason; this is that seam reaching recovery.
 *
 * NOT AN EIP-1193 PROVIDER, and that is load-bearing rather than stylistic.
 * ZeroDev's `toSigner` resolves a provider's address with
 * `Promise.any([eth_requestAccounts, eth_accounts])` and takes [0] — whichever
 * RPC answers first. The owner address is the ONLY free variable in the Kernel
 * CREATE2 preimage, so that race would decide which account you derive, and on
 * a recovery path deriving the wrong account means signing a sweep of an empty
 * one while the real funds sit untouched. Privy's `toViemAccount({ wallet })`
 * returns a LocalAccount with a fixed address instead; `usePrivyOwner` already
 * does this and refuses rather than guessing.
 */
export type RecoveryOwner =
  /** A browser- or disk-held key. The existing CLI path. */
  | { kind: "private-key"; privateKey: `0x${string}` }
  /** A LocalAccount that signs without exposing a key — a Privy embedded wallet. */
  | { kind: "signer"; account: LocalAccount }
  /**
   * An ADDRESS ONLY, which can derive but never sign.
   *
   * This is what keeps the planner honest: reconstruction needs the owner's
   * address and nothing more, so a read-only caller can prove which account an
   * owner controls without holding anything capable of authorising a transfer.
   * `recoverFunds` refuses it before it touches a bundler.
   */
  | { kind: "address"; address: Address };

export const ownerFromPrivateKey = (privateKey: `0x${string}`): RecoveryOwner => ({
  kind: "private-key",
  privateKey,
});
export const ownerFromSigner = (account: LocalAccount): RecoveryOwner => ({ kind: "signer", account });
export const ownerFromAddress = (address: Address): RecoveryOwner => ({ kind: "address", address });

/**
 * The viem account the Kernel derivation reads its address from.
 *
 * For `address` the signing methods throw rather than returning something
 * plausible: derivation only ever reads `.address` (the validator's
 * `getEnableData` returns exactly that), so a stub is enough to reconstruct —
 * and anything that tries to SIGN with it must fail loudly rather than
 * silently produce a signature the owner never authorised.
 */
function ownerAccountOf(owner: RecoveryOwner): LocalAccount {
  if (owner.kind === "private-key") return privateKeyToAccount(owner.privateKey);
  if (owner.kind === "signer") return owner.account;
  const refuse = (): never => {
    throw new Error(
      "this recovery owner is address-only: it can reconstruct the account but cannot sign for it.",
    );
  };
  return toAccount({
    address: owner.address,
    signMessage: refuse,
    signTransaction: refuse,
    signTypedData: refuse,
  }) as LocalAccount;
}

/** The owner's address, for every kind — no signing capability required. */
export const ownerAddressOf = (owner: RecoveryOwner): Address =>
  owner.kind === "private-key"
    ? privateKeyToAccount(owner.privateKey).address
    : owner.kind === "signer"
      ? owner.account.address
      : owner.address;

/**
 * THE ONE PLACE THE KERNEL ACCOUNT IS RECONSTRUCTED.
 *
 * `planRecovery` and `recoverFunds` each built this independently with the same
 * three arguments. Identical today, and exactly the kind of duplication that
 * drifts: the plan would show one account's contents and the sweep would sign
 * for another, with nothing in between to notice. The address is a CREATE2
 * derivation whose preimage is (kernelVersion, entryPoint, validator, index,
 * owner address) — so a single differing argument silently produces a different,
 * empty account, and a recovery that "succeeds" having moved nothing.
 *
 * No `index`, no `address` override, no factory overrides: the SDK's defaults
 * (index 0n, useMetaFactory true) are what every other construction in this
 * repo uses, so this reproduces an account minted by web/src/lib/session.ts.
 */
async function deriveKernelAccount(chain: Chain, rpcUrl: string | undefined, ownerAccount: LocalAccount) {
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const entryPoint = getEntryPoint("0.7");
  const ecdsaValidator = await signerToEcdsaValidator(publicClient, {
    signer: ownerAccount,
    entryPoint,
    kernelVersion: KERNEL_V3_3,
  });
  return createKernelAccount(publicClient, {
    entryPoint,
    kernelVersion: KERNEL_V3_3,
    plugins: { sudo: ecdsaValidator },
  });
}

/**
 * Rebuild the smart account from the owner and read what it holds. Read-only
 * — no bundler, no signing. Use this to show the user what recovery will move
 * (and to verify the owner actually controls the expected account) before
 * they commit.
 *
 * SIGNER-INDEPENDENT: it reads the owner's ADDRESS and never asks it to sign,
 * so `ownerFromAddress` is a first-class way to call it.
 */
export async function planRecovery(opts: {
  chain: Chain;
  owner: RecoveryOwner;
  rpcUrl?: string;
  /** If given, throw when the derived account doesn't match (wrong owner key). */
  expectedSmartAccount?: Address;
  /** Owner-added tokens from settings. Optional — the builtin set is the floor. */
  extraTokens?: readonly unknown[];
  /**
   * The grant's sealed Lighter API public key, when the caller holds the grant.
   * Used ONLY to label what sits at the key index ("the agent's key" or not);
   * nothing is decided on it, so a caller with a pasted owner key and no grant
   * loses a label, not a step.
   */
  agentPerpPubKey?: string | null;
  /** The venue reads' fetch and base URL — test seams; production uses the global fetch and Lighter's API. */
  venueFetch?: VenueFetch;
  lighterApiBase?: string;
}): Promise<RecoverPlan> {
  const publicClient = createPublicClient({ chain: opts.chain, transport: http(opts.rpcUrl) });
  const ownerAccount = ownerAccountOf(opts.owner);
  const account = await deriveKernelAccount(opts.chain, opts.rpcUrl, ownerAccount);

  // A sweep aimed at the zero address would be a signed transaction to nothing.
  assertDerivedAccount(account.address, "that owner does not derive an account");

  if (
    opts.expectedSmartAccount &&
    account.address.toLowerCase() !== opts.expectedSmartAccount.toLowerCase()
  ) {
    throw new Error(
      `this owner controls ${account.address}, not the expected ${opts.expectedSmartAccount}. ` +
        `Wrong owner, or the account was created with a different Kernel version.`,
    );
  }

  // STARTED NOW, AWAITED LAST. The venue leg is a handful of independent
  // reads that never throw (every failure is its own unread field), so it
  // runs beside the token and class-vault reads instead of after them — an
  // owner at a prompt waits for the slower of the two, not their sum.
  const venuePromise = readRecoverVenue({
    smartAccount: account.address,
    chainId: opts.chain.id,
    chainRead: lighterChainReader(publicClient),
    agentPerpPubKey: opts.agentPerpPubKey ?? null,
    fetch: opts.venueFetch,
    baseUrl: opts.lighterApiBase,
  });

  const tokens = sweepList(opts.chain.id, opts.extraTokens);
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
      if (t.decimalsUnknown) {
        // ITS OWN DECIMALS, asked of the token, for the same reason the vault
        // row below is priced: an address-only entry used to carry a guessed
        // 18, and a 9-decimal memecoin formatted at 18 is shown to the owner a
        // billion times smaller than what they are agreeing to move. Bounded as
        // isValidCustomToken bounds a typed-in figure; outside that, or no
        // answer, the amount is the exact raw count rather than a guess.
        //
        // NOT `unreadable`. That list says a BALANCE could not be read, so the
        // plan may be missing money — and the phone refuses to start a
        // withdrawal while it is non-empty. Here the balance was read and the
        // token sweeps; only its display unit is missing, and letting that veto
        // the whole withdrawal would strand everything else over a cosmetic gap.
        const decimals = await publicClient
          .readContract({ address: t.address, abi: erc20Abi, functionName: "decimals" })
          .then((d) => Number(d))
          .catch(() => null);
        if (decimals !== null && Number.isInteger(decimals) && decimals >= 0 && decimals <= 36) {
          return { symbol: t.symbol, address: t.address, raw, decimals, amount: formatUnits(raw, decimals) };
        }
        return {
          symbol: t.symbol,
          address: t.address,
          raw,
          decimals: t.decimals,
          amount: `${raw} raw units`,
          note: "held, but the token would not state its decimals, so this is its raw count. It sweeps regardless.",
        };
      }
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

  // ── AND WHAT THE CLASS VAULT HOLDS ───────────────────────────────────────
  //
  // THE PART THAT HAD TO WORK WITH NOTHING RUNNING. The vault's contents are
  // enumerated from its own `ClassBuy` logs, not from `class_positions` — that
  // table lives in a child container's sqlite, and this path exists precisely
  // for the case where no worker, no orchestrator and no database are available
  // at all. An owner key and an RPC are the whole dependency list.
  //
  // Every failure here is reported and none of it stops the plan: a class vault
  // that cannot be read must not prevent an owner sweeping the USDG and ETH
  // they can see.
  let classVault: Address | null = null;
  let classHoldings: RecoverPlan["classHoldings"] = [];
  let classNote: string | null = null;
  const classVaults: RecoverPlan["classVaults"] = [];
  try {
    const lookup = await findClassVaults({
      client: publicClient,
      chainId: opts.chain.id,
      smartAccount: account.address,
      // NO GRANT. Recovery may run from a pasted key with nothing else, so the
      // vaults are derived from the factory constants — which is exactly why
      // those constants are a deploy fact and not a setting.
      grant: null,
    });
    for (const u of lookup.unreadable) {
      // NAMED PER FACTORY. "class vault" as one label cannot say which of two
      // could not be asked, and an owner reading it would not know whether the
      // empty list they are looking at covers one vault or none.
      unreadable.push(`class vault factory ${u.factory}`);
      classNote = `the class vault factory at ${u.factory} could not be read (${u.why}), so this list may be short`;
    }
    for (const candidate of lookup.candidates) {
      const head = await publicClient.getBlockNumber();
      const from = head > CLASS_RECOVERY_LOOKBACK ? head - CLASS_RECOVERY_LOOKBACK : 0n;
      const scan = await readClassLog(publicClient, candidate.vault, from, head);
      /**
       * TWO SOURCES, BECAUSE THE LOGS CANNOT NAME THE QUOTE ASSET.
       *
       * `ClassBuy`/`ClassSell`/`Swept` carry the CLASS token in `token` and the
       * quote only as an amount — the quote asset's address appears in no event
       * this contract emits. So a vault holding stranded USDG enumerated from
       * logs alone reads as holding nothing but its class tokens, and the sweep
       * that follows moves nothing but those.
       *
       * That is not hypothetical. Shogun's vault holds 1,063,408.141815 DOGGOS
       * and 5.785344 USDG; the DOGGOS came from a ClassBuy and the USDG from a
       * refund leg that did not land, so only the first was ever disclosed. An
       * owner confirming that plan is told about one of the two assets they are
       * being asked to recover.
       *
       * The registry list is the same one the ACCOUNT sweep already enumerates,
       * which is the right answer twice over: it certainly contains the quote
       * asset, and "the assets we check on the account" is a rule that stays
       * true as the registry changes rather than a hard-coded USDG address that
       * would go stale on the next chain.
       *
       * Costs one balanceOf per registry token against the vault. An owner is
       * waiting at a prompt, but they are waiting to be told the truth about
       * what they own, and `readClassHoldings` already degrades a failed read to
       * `partial` rather than dropping the token.
       */
      const candidates = classSweepCandidates(
        scan.events.map((e) => e.token),
        tokens,
      );
      const contents = await readClassHoldings({
        client: publicClient,
        vault: candidate.vault,
        candidates,
      });
      const holdings = contents.holdings.map((h) => ({
        token: h.token,
        symbol: h.symbol,
        raw: h.raw,
        decimals: h.decimals,
        /**
         * THE TOKEN'S OWN DECIMALS, not the launchpad's.
         *
         * This hard-coded 18, which was right while a vault could only hold Pons
         * launch tokens and became wrong the moment the enumeration also asked
         * about the quote asset. USDG is 6dp, so a real 5.785344 USDG was shown
         * to an owner as 0.000000000005785344 USDG — the correct money,
         * misstated by twelve orders of magnitude, on the screen where they
         * decide whether to sign.
         *
         * The old comment was right that the sweep never uses this number —
         * `sweep(token)` takes no amount and moves the whole balance. That is
         * precisely what made it dangerous: a disclosure defect with no
         * execution symptom, which nothing downstream could have caught.
         */
        amount: formatUnits(h.raw, h.decimals),
      }));
      let note: string | null = null;
      if (scan.failed) {
        note =
          "the vault's history could not be read in full, so this list may be short — there may be more in the vault than it shows";
      } else if (scan.unreadable > 0) {
        // A log this build cannot decode is not an absent log. A v2 vault read
        // by a v1-era build looks exactly like a vault that never traded.
        note =
          `${scan.unreadable} of this vault's own log entries could not be decoded by this build, so its ` +
          `history is incomplete — update before trusting this list`;
      } else if (contents.kind === "partial") {
        note = contents.why;
      }
      classVaults.push({ vault: candidate.vault, version: candidate.version, holdings, note });
    }

    /**
     * THE PRIMARY VAULT, for every reader that still asks for one address.
     *
     * The first candidate that actually HOLDS something, else the first at all.
     * With one factory pinned there is one candidate and this is exactly the old
     * behaviour — which is the state on this chain today, so nothing changes
     * until a second factory is deployed.
     *
     * "Holds something" rather than "is first" because the singular field is a
     * disclosure, and a disclosure that names an empty vault while a full one
     * goes unmentioned is the failure this plurality exists to remove.
     */
    const primary = classVaults.find((v) => v.holdings.length > 0) ?? classVaults[0] ?? null;
    if (primary) {
      classVault = primary.vault;
      classHoldings = primary.holdings;
      classNote = primary.note ?? classNote;
    }
  } catch (e) {
    classNote = `could not check the class vault: ${e instanceof Error ? e.message : String(e)}`;
    unreadable.push("class vault");
  }

  // ── HOW MUCH NATIVE ETH WOULD ACTUALLY LEAVE ────────────────────────────
  //
  // Forecast here so the CONFIRMATION can state it. The ETH leg moves on every
  // recovery — `recoverFunds` appends a bare value call — and a disclosure that
  // lists the tokens but not the ETH understates what the owner is agreeing to.
  //
  // THE SAME FUNCTION THE SWEEP USES, deliberately: `nativeSweep` is called
  // here and again at execution, so the number shown and the number sent come
  // from one rule rather than two that can drift. They are not guaranteed
  // IDENTICAL — the gas price is read twice and moves in between — which is
  // exactly why the wording is "approximately" and why this is named
  // `recoverable` rather than `swept`. `nativeSweptWei` on the RESULT is the
  // settled fact; these two are the estimate.
  //
  // A failed gas read forecasts ZERO recoverable rather than the whole balance:
  // over-promising on an exit is the direction that turns into a complaint.
  let nativeRecoverableWei = 0n;
  let nativeReserveWei = gas ?? 0n;
  try {
    const split = nativeSweep(gas ?? 0n, await publicClient.getGasPrice());
    nativeRecoverableWei = split.sweep;
    nativeReserveWei = split.reserve;
  } catch {
    unreadable.push("gas price");
  }

  return {
    smartAccount: account.address,
    ownerAddress: ownerAccount.address,
    balances,
    gasWei: gas ?? 0n,
    nativeRecoverableWei,
    nativeReserveWei,
    unreadable,
    classVault,
    classHoldings,
    classNote,
    classVaults,
    venue: await venuePromise,
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
  owner: RecoveryOwner;
  bundlerUrl: string;
  rpcUrl?: string;
  to: Address;
  expectedSmartAccount?: Address;
  extraTokens?: readonly unknown[];
  /**
   * THE CLASS RECOVERY THE OWNER ACTUALLY APPROVED.
   *
   * Recovery re-plans internally, so without this the text on the confirmation
   * and the operation that runs are derived from two different reads. Measured
   * 2026-09-13: an owner approved a sweep naming 1,063,408.141815 DOGGOS, the
   * re-plan enumerated no class holdings, the vault leg was quietly skipped and
   * the account sweep went ahead — 20 USDG and the ETH left, the DOGGOS did
   * not, and the operation reported success.
   *
   * Passing this pins WHAT was approved. It is not trusted as a BALANCE: the
   * amount comes from a fresh `balanceOf(vault)` immediately before signing.
   * What it pins is the vault, the token and the destination — identity, not
   * quantity.
   */
  approvedClass?: {
    vault: Address;
    tokens: readonly Address[];
    destination: Address;
  };
  /**
   * A DISCLOSED CLASS SWEEP THAT CANNOT RUN IS FATAL, not a skipped line item.
   *
   * Default false, which preserves the existing best-effort contract for the
   * CLI and for any caller that approved no class leg: a vault that will not
   * give up its tokens must not strand the USDG and ETH an owner can see.
   *
   * True for a browser-confirmed class plan, where the opposite is required —
   * if the thing the owner was shown cannot happen, nothing should happen,
   * because the alternative is an operation that succeeds while quietly
   * omitting the largest holding in it.
   */
  requireApprovedClassSweep?: boolean;
}): Promise<RecoverResult> {
  // REFUSED BEFORE ANYTHING ELSE. An address-only owner can reconstruct the
  // account but cannot authorise a transfer, and finding that out at signing
  // time would mean having already read balances, priced gas and built calls
  // against money it was never entitled to move.
  if (opts.owner.kind === "address") {
    throw new Error(
      "recovery needs an owner that can sign: this one is address-only, which can reconstruct " +
        "the account but not authorise moving anything out of it.",
    );
  }
  const plan = await planRecovery({
    chain: opts.chain,
    owner: opts.owner,
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

  // "NOTHING TO RECOVER" MUST NOT BE SAID OVER A FULL VAULT.
  //
  // This read `plan.balances.length === 0 && nativeSweptWei === 0n`, and the
  // class vault is not in `balances` — it is a different contract holding
  // tokens the ACCOUNT does not. So an owner whose entire book was class
  // positions was told their account was empty by the one command that exists
  // to get money out.
  if (plan.balances.length === 0 && nativeSweptWei === 0n && plan.classHoldings.length === 0) {
    return { ...plan, txHash: null, to: opts.to, skipped: [], nativeSweptWei: 0n, nativeReservedWei };
  }
  const ownerAccount = ownerAccountOf(opts.owner);
  const account = await deriveKernelAccount(opts.chain, opts.rpcUrl, ownerAccount);
  assertDerivedAccount(account.address, "that owner does not derive an account");
  // DERIVED TWICE, CHECKED TWICE. `planRecovery` already compared this against
  // `expectedSmartAccount`, but that was a different derivation a moment
  // earlier; re-asserting here means the account about to be SIGNED FOR is the
  // one the owner was shown, not merely one that matched once.
  if (
    opts.expectedSmartAccount &&
    account.address.toLowerCase() !== opts.expectedSmartAccount.toLowerCase()
  ) {
    throw new Error(
      `this owner controls ${account.address}, not the expected ${opts.expectedSmartAccount}. ` +
        "Refusing to sign a recovery for a different account.",
    );
  }
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

  // ── OP 1: EMPTY THE CLASS VAULT INTO THE ACCOUNT ─────────────────────────
  //
  // TWO OPERATIONS, NOT ONE, and `planClassSweep` already argues why: `sweep`
  // takes no recipient and no amount, so the path out is vault → account →
  // destination, and the amount arriving is not known until the sweep has run.
  // A Kernel batch cannot thread call N's return into call N+1's arguments, and
  // predicting it from a pre-read balance is the tempting option that must not
  // be taken — a curve token is exactly the asset that moves between the read
  // and the send, an oversized transfer reverts, and the batch is ATOMIC, so it
  // would take the USDG and the ETH down with it.
  //
  // The window between the two ops is safe because the tokens land in an
  // account the same key controls: if op 2 fails, rerunning `merrymen recover`
  // sweeps them as ordinary account balances. That property is what makes two
  // ops safe and one op not.
  //
  // Failures here are REPORTED AND SURVIVED. A vault that will not give up its
  // tokens must not stop an owner recovering the USDG and ETH they can see.
  // ── WHAT THE OWNER APPROVED IS WHAT GETS ATTEMPTED ──────────────────────
  //
  // The approved intent overrides the re-plan for IDENTITY — which vault, which
  // tokens, where to. The re-plan is still what it always was for everything
  // else, and the AMOUNT never comes from either: it comes from a fresh
  // balanceOf(vault) a moment before signing, below.
  const approved = opts.approvedClass ?? null;
  const requireClass = opts.requireApprovedClassSweep === true && approved !== null;
  // FATAL, BEFORE THE ACCOUNT SWEEP. Each of these says the operation about to
  // be signed is not the one that was shown, and on a withdrawal that is a
  // reason to stop rather than to proceed with the part that still works.
  if (requireClass && approved) {
    const fail = (why: string): never => {
      throw new Error(
        `refusing to recover: ${why}. Nothing has been signed, and your funds are where they were. ` +
          "Re-open recovery so the confirmation is rebuilt from current state.",
      );
    };
    if (approved.destination.toLowerCase() !== opts.to.toLowerCase()) {
      fail(`the approved destination was ${approved.destination}, but this call would send to ${opts.to}`);
    }
    // MEMBERSHIP, not equality, and this is the only rule here that loosens.
    //
    // The plan now names every vault this account could have, so an approval of
    // the v1 vault is legitimate while `plan.classVault` reports the v2 one. It
    // is still a closed set derived on THIS side from the account — nothing the
    // caller supplies can add to it — so an approval naming a vault this account
    // does not derive is refused exactly as before. Every other check in this
    // block is untouched.
    const derivable = plan.classVaults.map((v) => v.vault.toLowerCase());
    if (!derivable.includes(approved.vault.toLowerCase())) {
      // The vault is a CREATE2 prediction from the account, so a disagreement
      // here means the two sides derived different accounts.
      fail(
        `the approved class vault was ${approved.vault}, but this account derives ` +
          `${derivable.length > 0 ? derivable.join(", ") : "none"}`,
      );
    }
    const vaultOwner = (await publicClient
      .readContract({ address: approved.vault, abi: CLASS_VAULT_OWNER, functionName: "owner" })
      .catch(() => null)) as Address | null;
    if (!vaultOwner) fail("the class vault would not say who owns it");
    if (vaultOwner!.toLowerCase() !== account.address.toLowerCase()) {
      fail(`the class vault is owned by ${vaultOwner}, not by this account (${account.address})`);
    }
  }

  /**
   * ONE OPERATION PER VAULT, because the batch is atomic.
   *
   * `sweep(token)` is a call ON a vault, so the target travels with the holding
   * and two vaults cannot share one operation. If they did, a dead v1 vault
   * would take the live v2 recovery down with it and `skipped` could not name
   * which one failed — the owner would be told the whole class leg failed when
   * half of it would have worked.
   *
   * An APPROVED sweep is narrowed to the one vault that was approved. An
   * unapproved one (the CLI path) sweeps every vault that holds something,
   * which is the behaviour an owner running `merrymen recover` expects: get my
   * money out of wherever it is.
   */
  const vaultsToSweep = approved
    ? plan.classVaults.filter((v) => v.vault.toLowerCase() === approved.vault.toLowerCase())
    : plan.classVaults.filter((v) => v.holdings.length > 0);
  for (const target of vaultsToSweep) {
    await sweepOneVault(target.vault, target.holdings);
  }

  async function sweepOneVault(
    classVault: Address,
    vaultHoldings: RecoverPlan["classHoldings"],
  ): Promise<void> {
    if (!classVault || !(requireClass || vaultHoldings.length > 0)) return;
    // THE AMOUNT IS READ FRESH, ALWAYS. The approved intent names the tokens;
    // the chain says how many there are, at this moment, so a stale UI figure
    // can never become a transfer amount.
    const wanted = approved ? approved.tokens : vaultHoldings.map((h) => h.token);
    const live: { token: Address; symbol: string; raw: bigint }[] = [];
    for (const token of wanted) {
      const raw = (await publicClient
        .readContract({
          address: token,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [classVault],
        })
        .catch(() => null)) as bigint | null;
      if (raw === null) {
        if (requireClass) {
          throw new Error(
            `refusing to recover: could not read the class vault balance of ${token}. ` +
              "That is not a zero balance, and signing against an unread holding is how one gets stranded. " +
              "Nothing has been signed.",
          );
        }
        continue;
      }
      if (raw === 0n) {
        if (requireClass) {
          throw new Error(
            `refusing to recover: the class vault holds no ${token}, but the confirmation you approved said it did. ` +
              "Nothing has been signed — re-open recovery so the figures are rebuilt from current state.",
          );
        }
        continue;
      }
      const known = plan.classHoldings.find((h) => h.token.toLowerCase() === token.toLowerCase());
      live.push({
        token,
        symbol: known?.symbol ?? `${token.slice(0, 6)}…${token.slice(-4)}`,
        raw,
      });
    }
    const sweepable = planClassSweep(live);
    if (requireClass && sweepable.length === 0) {
      throw new Error(
        "refusing to recover: the class sweep you approved has nothing it can move. Nothing has been signed.",
      );
    }
    if (sweepable.length > 0) {
      try {
        const sent = await client.sendUserOperation({
          calls: sweepable.map((h) => ({
            to: classVault,
            value: 0n,
            data: encodeFunctionData({
              abi: CLASS_VAULT_SWEEP,
              functionName: "sweep",
              args: [h.token],
            }),
          })),
        });
        await client.waitForUserOperationReceipt({ hash: sent });
        // The account now holds them. Re-read so op 2 moves the REAL amount
        // rather than the one predicted before the sweep ran.
        for (const h of sweepable) {
          const raw = (await publicClient
            .readContract({
              address: h.token,
              abi: erc20Abi,
              functionName: "balanceOf",
              args: [account.address],
            })
            .catch(() => 0n)) as bigint;
          if (raw > 0n) {
            plan.balances.push({
              symbol: h.symbol,
              address: h.token,
              raw,
              decimals: 18,
              amount: formatUnits(raw, 18),
              note: "swept out of your class vault by this recovery",
            });
          }
        }
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        // FATAL WHEN IT WAS APPROVED. Continuing here is what produced an
        // operation that moved the USDG and the ETH, left 1,063,408 DOGGOS in
        // the vault, and reported success — the owner having approved a
        // confirmation that named them.
        if (requireClass) {
          throw new Error(
            `refusing to continue: the class vault sweep you approved failed (${why}). ` +
              "The account sweep has NOT been attempted, so nothing has moved. Your tokens are still in the vault.",
          );
        }
        // NAMES THE VAULT. With one vault "the class vault sweep failed" was a
        // complete sentence; with two it is a question the owner cannot answer,
        // and they would not know which address still holds their tokens.
        skipped.push({
          symbol: `class vault ${classVault} (${sweepable.length} token(s))`,
          reason: `the vault sweep did not go through: ${why}. Your tokens are still in that vault — rerun this command.`,
        });
      }
    }
  }

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
      // NOT EVERY REVERT IS A TOKEN REFUSING TO MOVE.
      //
      // This regex was written when every leg was `token.transfer(...)`, where a
      // revert really does mean "this token will not move and the others still
      // should". Once a leg can be `vault.sweep(token)` the same regex swallows
      // a revert that means something completely different:
      //
      //   NotOwner()  — we are asking the WRONG VAULT. A different owner key, a
      //                 stale factory constant, or another account's vault. The
      //                 class book is untouched and the sweep would report
      //                 success, which is the failure this whole path exists to
      //                 prevent. Abort and name it.
      //   ZeroAmount() — an empty balance. Filtered out before the batch is
      //                 built; reaching here means a balance moved between the
      //                 read and the simulation, which is ordinary.
      //
      // Everything else keeps the original behaviour, including the fail-open
      // below: on an escape hatch, attempting a move that might fail beats
      // leaving money behind because a network call flaked.
      if (/NotOwner/.test(msg)) {
        throw new Error(
          `refusing to sweep: ${b.symbol} at ${b.address} answered NotOwner(). This owner key does ` +
            `not control that contract, so nothing here would move and reporting a successful ` +
            `recovery would be a lie. Check the owner key and the chain.`,
        );
      }
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

// ════════════════════════════════════════════════════════════════════════════
// THE LIGHTER LEG — docs/perps.md rule 13 and "Surfaces → Recover".
// ════════════════════════════════════════════════════════════════════════════
//
// An agent with perps holds money where no ERC-20 transfer reaches it: USDG
// posted as collateral in Lighter's settlement contract, positions and orders
// on Lighter's rollup, and a secure withdrawal waiting on the contract to be
// claimed. All of it is keyed on this smart account, and the account's owner
// key can act on it through L1 PRIORITY REQUESTS — calls the Kernel makes to
// the proxy in a sudo UserOp, which Lighter's sequencer must process:
//
//   cancelAllOrders(idx)                 every resting order on the account
//   changePubKey(idx, 16, throwaway)     replace the agent's API key
//   withdraw(idx, 3, 0, amount)          a secure withdrawal of collateral
//   withdrawPendingBalance(self, 3, x)   claim what the withdrawal left pending
//
// This section DISCLOSES everywhere (fetch + eth_call only, so the CLI, the
// browser, Expo and the iOS JSContext all run it) and EXECUTES only where the
// caller can send an owner-signed UserOp with calls to the proxy: today that is
// `merrymen recover`. The hosted relay forwards withdrawal-shaped ERC-20
// traffic only (web/src/lib/recovery-shape.ts), so the browser shows the
// disclosure and names the CLI path instead of offering a button that the
// relay would refuse.
//
// STATELESS. Nothing here remembers a previous run. Every visit re-reads the
// venue and offers the NEXT step: an unwind while there are orders, a key or
// free collateral; a claim once a withdrawal is pending on the contract. The
// executor re-reads again before signing and refuses when what it would sign
// is not what the owner was shown.
//
// WHAT IS DELIBERATELY NOT OFFERED:
//   - Closing positions. The owner's `createOrder` priority request has no
//     reduce-only flag and lands after a delay, so if a resting stop fires
//     first a "close" opens a fresh, unmanaged position. It stays off until
//     the mainnet checklist proves its semantics on this instance; until then
//     positions are closed by the agent's own stand-down (`merrymen kill`)
//     or end at Lighter's liquidation.
//   - Sub-accounts. We never create them (rule 2); one existing is an
//     incident (rule 16). They are disclosed, not unwound.
//   - Pool shares and spot-route balances. Disclosed; not movable from here.

/** The fetch the venue reads use. `typeof fetch` so a browser, Node and a test double all fit. */
export type VenueFetch = typeof fetch;

/** One field of the venue disclosure: read, or why not. A failure is never a zero standing in for one. */
export type VenueField<T> = { read: true; value: T } | { read: false; why: string };

const venueField = <T>(value: T): VenueField<T> => ({ read: true, value });
const venueUnread = <T>(why: string): VenueField<T> => ({ read: false, why });

/** One open position, as the owner is shown it. Amounts are exact; prices and sizes in the market's own decimals. */
export interface RecoverVenuePosition {
  /** `BTC-PERP`, or the venue's symbol for a market this build does not list (still exposure). */
  market: string;
  marketId: number;
  side: "long" | "short";
  size: string;
  marginMode: "cross" | "isolated";
  /** Isolated margin allocated to it (0 for cross). */
  marginMicro: bigint;
  unrealizedMicro: bigint;
  /** The venue's liquidation price, or null when it reports none. */
  liqPrice: string | null;
  /** Orders tied to the position — its resting stop (and take-profit) at the venue. */
  stopsResting: number;
}

/** The master account's ONE /api/v1/account snapshot, reduced to what recovery needs. */
export interface RecoverVenueAccount {
  /** C: cross collateral — the free balance a secure withdrawal can take (when no cross position uses it). */
  collateralMicro: bigint;
  /** ΣM: margin held by isolated positions. It stays with them; nothing here can move it while they are open. */
  isolatedMarginMicro: bigint;
  unrealizedMicro: bigint;
  positions: RecoverVenuePosition[];
  /** Open positions in CROSS margin — C backs them, so C is not free. */
  crossPositions: number;
  /**
   * Resting and pending orders. The account's counters and the rows' can
   * overlap, so the LARGER is kept: overstating an order count is honest,
   * understating it is not (standdown.ts does the same).
   */
  orders: number;
  poolShareCount: number;
  /** Spot-route balances plus pending unlocks — money outside the perps account. */
  spotBalanceCount: number;
}

/** Another Lighter account under this smart account (a sub-account). */
export interface RecoverOtherAccount {
  accountIndex: number;
  /** true: holds something; false: read empty; null: could not be read. */
  holds: boolean | null;
  summary: string;
}

/** What sits at the route's key index (16). */
export type RecoverKeySlot =
  | { state: "empty" }
  /** `agents`: equal to the grant's sealed key; null when the caller had no grant to compare with. */
  | { state: "key"; publicKey: `0x${string}`; agents: boolean | null };

/** The owner-key priority requests an unwind may carry, IN THE ORDER THEY ARE SENT. */
export type VenueCallName = "cancelAllOrders" | "changePubKey" | "withdraw";

export interface VenueUnwind {
  kind: "unwind";
  accountIndex: number;
  /** In send order: cancelAllOrders → changePubKey → withdraw (see planVenueSteps). */
  calls: VenueCallName[];
  /** The collateral the withdraw requests, micro-USDG; 0n when there is no withdraw. */
  withdrawMicro: bigint;
  /**
   * Open positions whose resting stops this unwind cancels. They stay open,
   * with no stop, until Lighter liquidates them or someone with a key closes
   * them. The confirmation says so and asks for a different word.
   */
  positionsLeftOpen: number;
}

export interface VenueClaim {
  kind: "claim";
  accountIndex: number;
  /** getPendingBalance(self, 3) × tick size, micro-USDG, as read. */
  amountMicro: bigint;
}

export type RecoverVenue =
  /** Lighter settles on 4663 only. On any other chain there is nothing to read and nothing there. */
  | { kind: "elsewhere"; chainId: number }
  /** addressToAccountIndex(self) is 0: no deposit ever landed, so no venue account exists. A known none. */
  | { kind: "none" }
  /** The account index itself could not be read. Unknown — never none. */
  | { kind: "unreadable"; why: string }
  | {
      kind: "account";
      accountIndex: number;
      account: VenueField<RecoverVenueAccount>;
      otherAccounts: VenueField<{ accounts: RecoverOtherAccount[]; complete: boolean }>;
      /** Waiting on the contract for a claim — getPendingBalance(self, 3). */
      pendingMicro: VenueField<bigint>;
      /** /api/v1/withdrawalDelay, seconds, read live: it moves (398 s to 1314 s observed). */
      withdrawalDelaySec: VenueField<number>;
      keySlot: VenueField<RecoverKeySlot>;
      unwind: VenueUnwind | null;
      claim: VenueClaim | null;
      /** Why a step that might be expected is not offered. Said, never silent. */
      notOffered: string[];
    };

/** The two contract views the venue leg needs, bound to the proxy and the never-granted read ABI. */
export type LighterChainReader = (
  functionName: "addressToAccountIndex" | "getPendingBalance",
  args: readonly unknown[],
) => Promise<unknown>;

/** Bind a viem-shaped client to Lighter's proxy. Structural, so every platform's client fits. */
export function lighterChainReader(client: { readContract: (args: never) => Promise<unknown> }): LighterChainReader {
  return (functionName, args) =>
    client.readContract({ address: LIGHTER_ROUTE_V1.proxy, abi: LIGHTER_READ_ABI, functionName, args } as never);
}

const UINT48_MAX = 2n ** 48n - 1n;
const UINT64_MAX = 2n ** 64n - 1n;
const UINT128_MAX = 2n ** 128n - 1n;

function asUint(v: unknown, max: bigint): bigint | null {
  if (typeof v === "bigint") return v >= 0n && v <= max ? v : null;
  if (typeof v === "number" && Number.isSafeInteger(v)) return v >= 0 && BigInt(v) <= max ? BigInt(v) : null;
  return null;
}

/** 8 s per request: an owner is waiting at a prompt, and a slow venue must become "unread", not a hang. */
const VENUE_TIMEOUT_MS = 8_000;
/** orderBookDetails is the largest real answer (~100 KB); ten times that. */
const VENUE_MAX_BYTES = 1_000_000;
/** Sub-accounts read in full, at most. We never create any; a list longer than this is an incident, disclosed as incomplete. */
const VENUE_MAX_OTHER_ACCOUNTS = 8;
/** The venue's code for "api key not found" — an empty key slot, on the venue's own word (onboard.ts). */
const LIGHTER_APIKEY_NOT_FOUND = 21109;

interface VenueIo {
  fetch?: VenueFetch;
  baseUrl?: string;
  timeoutMs?: number;
}

/**
 * A response body, refused rather than buffered past `max`. PORTABLE: this
 * module runs in browsers and JSContext, so no `Buffer` (bounded-read.ts uses
 * it) — a TextDecoder over the stream, or the plain text where there is none.
 */
async function readCapped(
  res: { headers: { get(n: string): string | null }; body?: unknown; text(): Promise<string> },
  max: number,
): Promise<string | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  const body = res.body as
    | { getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> } }
    | null
    | undefined;
  if (!body || typeof body.getReader !== "function") {
    const text = await res.text();
    return text.length > max ? null : text;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    bytes += value.byteLength;
    if (bytes > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    out += decoder.decode(value, { stream: true });
  }
  return out + decoder.decode();
}

/**
 * One public GET to Lighter → the parsed body, or why not. Never throws, and
 * never waits longer than the deadline.
 *
 * `redirect: "error"` for the reason api.ts gives, and a hand-rolled abort
 * timer rather than AbortSignal.timeout, which not every JS runtime this
 * module reaches has. The whole exchange — headers AND body — is also RACED
 * against that deadline, because an abort signal is only a request: a host
 * fetch that ignores it (a native bridge that never answers for a host its
 * network policy blocks, say) would otherwise hang planRecovery, and with it
 * the one screen that gets an owner's spot money out.
 */
async function venueGetJson(
  io: VenueIo,
  path: string,
  query: Record<string, string | number>,
): Promise<{ ok: true; status: number; body: unknown } | { ok: false; why: string }> {
  const base = io.baseUrl ?? LIGHTER_ROUTE_V1.apiBase;
  const qs = Object.entries(query)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join("&");
  const url = `${base}${path}${qs ? `?${qs}` : ""}`;
  const f = io.fetch ?? (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : undefined);
  if (!f) return { ok: false, why: "this runtime cannot make web requests" };
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<{ ok: false; why: string }>((resolve) => {
    timer = setTimeout(() => {
      ctl.abort();
      resolve({ ok: false, why: "Lighter did not answer in time" });
    }, io.timeoutMs ?? VENUE_TIMEOUT_MS);
  });
  const exchange = (async (): Promise<{ ok: true; status: number; body: unknown } | { ok: false; why: string }> => {
    try {
      const res = await f(url, { method: "GET", redirect: "error", signal: ctl.signal, headers: { accept: "application/json" } });
      const text = await readCapped(res, VENUE_MAX_BYTES);
      if (text === null) return { ok: false, why: "Lighter's answer was larger than any real one" };
      try {
        return { ok: true, status: res.status, body: JSON.parse(text) as unknown };
      } catch {
        return { ok: false, why: `Lighter answered HTTP ${res.status} with something that is not JSON` };
      }
    } catch {
      return { ok: false, why: ctl.signal.aborted ? "Lighter did not answer in time" : "Lighter could not be reached" };
    }
  })();
  try {
    return await Promise.race([exchange, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** A GET whose body must parse, as a field. A body that does not parse is unread, never empty. */
async function venueRead<T>(
  io: VenueIo,
  path: string,
  query: Record<string, string | number>,
  parse: (raw: unknown) => T | null,
  what: string,
): Promise<VenueField<T>> {
  const got = await venueGetJson(io, path, query);
  if (!got.ok) return venueUnread(`${what}: ${got.why}`);
  if (got.status !== 200) return venueUnread(`${what}: Lighter answered HTTP ${got.status}`);
  const parsed = parse(got.body);
  return parsed === null ? venueUnread(`${what}: Lighter's answer did not parse, which is not the same as empty`) : venueField(parsed);
}

function isRecordish(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

/**
 * GET /api/v1/apikeys at (account, 16) → the slot. EMPTY ONLY ON THE VENUE'S
 * OWN WORD (21109), exactly as onboard.ts reads it: a 200 with no key, two
 * keys, or a key the contract would never have accepted is unread.
 */
export async function readVenueKeySlot(
  accountIndex: number,
  io: VenueIo & { agentPerpPubKey?: string | null } = {},
): Promise<VenueField<RecoverKeySlot>> {
  const what = `the API key at index ${LIGHTER_ROUTE_V1.apiKeyIndex}`;
  const got = await venueGetJson(io, "/api/v1/apikeys", { account_index: accountIndex, api_key_index: LIGHTER_ROUTE_V1.apiKeyIndex });
  if (!got.ok) return venueUnread(`${what}: ${got.why}`);
  if (isRecordish(got.body) && got.body.code === LIGHTER_APIKEY_NOT_FOUND) return venueField({ state: "empty" });
  if (got.status !== 200) return venueUnread(`${what}: Lighter answered HTTP ${got.status}`);
  const keys = parseApiKeys(got.body);
  if (keys === null || keys.length !== 1) return venueUnread(`${what}: Lighter's answer did not parse`);
  const k = keys[0]!;
  if (k.accountIndex !== accountIndex || k.apiKeyIndex !== LIGHTER_ROUTE_V1.apiKeyIndex) {
    return venueUnread(`${what}: Lighter answered about another account or index`);
  }
  const publicKey = validatePerpPubKey(k.publicKey);
  if (publicKey === null) return venueUnread(`${what}: Lighter answered a key the contract would not accept`);
  const agent = io.agentPerpPubKey ? validatePerpPubKey(io.agentPerpPubKey) : null;
  return venueField({ state: "key", publicKey, agents: agent === null ? null : agent === publicKey });
}

function venueUsdg(micro: bigint): string {
  return `${formatUnits(micro, USDG_DECIMALS)} USDG`;
}

function venueSigned(micro: bigint): string {
  return `${micro < 0n ? "−" : "+"}${formatUnits(micro < 0n ? -micro : micro, USDG_DECIMALS)} USDG`;
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The master account read, reduced. Every open position must be scalable, or parseAccount refused the read. */
function reduceAccount(acct: PerpAccountRead, decimals: ReadonlyMap<number, PerpDecimals>): RecoverVenueAccount | null {
  const positions: RecoverVenuePosition[] = [];
  for (const p of openPositions(acct)) {
    const d = decimals.get(p.marketId);
    if (d === undefined || p.side === null) return null;
    positions.push({
      market: p.key ?? p.symbol,
      marketId: p.marketId,
      side: p.side,
      size: formatUnits(p.baseAmount, d.sizeDecimals),
      marginMode: p.marginMode,
      marginMicro: p.allocatedMarginMicro,
      unrealizedMicro: p.unrealizedMicro,
      liqPrice: p.liqPrice === null ? null : formatUnits(p.liqPrice, d.priceDecimals),
      stopsResting: p.positionTiedOrderCount,
    });
  }
  const rowOrders = acct.positions.reduce((n, p) => n + p.openOrderCount + p.pendingOrderCount, 0);
  return {
    collateralMicro: acct.collateralMicro,
    isolatedMarginMicro: acct.isolatedMarginMicro,
    unrealizedMicro: acct.unrealizedMicro,
    positions,
    crossPositions: positions.filter((p) => p.marginMode === "cross").length,
    orders: Math.max(acct.totalOrderCount + acct.pendingOrderCount, rowOrders),
    poolShareCount: acct.poolShareCount,
    spotBalanceCount: acct.spotHoldings.length + acct.pendingUnlockCount,
  };
}

/** One sub-account's summary line, from its own full read. */
function otherSummary(acct: PerpAccountRead): string {
  if (accountReadsEmpty(acct)) return "reads empty";
  const parts: string[] = [];
  const open = openPositions(acct);
  if (open.length > 0) parts.push(plural(open.length, "open position", "open positions"));
  if (acct.collateralMicro !== 0n) parts.push(`${venueUsdg(acct.collateralMicro)} collateral`);
  if (acct.isolatedMarginMicro !== 0n) parts.push(`${venueUsdg(acct.isolatedMarginMicro)} isolated margin`);
  if (acct.totalOrderCount + acct.pendingOrderCount > 0) parts.push("resting orders");
  if (acct.poolShareCount > 0) parts.push("public-pool shares");
  if (acct.spotHoldings.length + acct.pendingUnlockCount > 0) parts.push("spot balances");
  return parts.length > 0 ? `holds ${parts.join(", ")}` : "holds something";
}

/**
 * Read everything recovery can say about Lighter for `smartAccount`. NEVER
 * THROWS: each field fails on its own into `{ read: false, why }`.
 *
 * The order is rule 11's: the chain first. A zero account index is a KNOWN
 * none — no deposit ever landed — and then the venue's API is never asked
 * anything, so an agent that never used perps costs recovery one eth_call.
 */
export async function readRecoverVenue(args: {
  smartAccount: Address;
  chainId: number;
  chainRead: LighterChainReader;
  agentPerpPubKey?: string | null;
  fetch?: VenueFetch;
  baseUrl?: string;
  timeoutMs?: number;
}): Promise<RecoverVenue> {
  if (args.chainId !== LIGHTER_ROUTE_V1.chainId) return { kind: "elsewhere", chainId: args.chainId };
  if (typeof args.smartAccount !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(args.smartAccount)) {
    return { kind: "unreadable", why: "not an account address" };
  }
  const self = args.smartAccount.toLowerCase() as Address;
  const io: VenueIo = { fetch: args.fetch, baseUrl: args.baseUrl, timeoutMs: args.timeoutMs };

  let index: bigint | null;
  try {
    index = asUint(await args.chainRead("addressToAccountIndex", [self]), UINT48_MAX);
  } catch {
    return { kind: "unreadable", why: "the Lighter contract could not be read (account index)" };
  }
  if (index === null) return { kind: "unreadable", why: "the Lighter contract answered an account index that is not one" };
  if (index === 0n) return { kind: "none" };
  const accountIndex = Number(index);

  const [pendingMicro, details, list, withdrawalDelaySec, keySlot] = await Promise.all([
    args
      .chainRead("getPendingBalance", [self, LIGHTER_ROUTE_V1.assetIndex])
      .then((v): VenueField<bigint> => {
        const raw = asUint(v, UINT128_MAX);
        return raw === null
          ? venueUnread("the Lighter contract answered a pending balance that is not one")
          : venueField(raw * BigInt(LIGHTER_ROUTE_V1.usdgTickSize));
      })
      .catch((): VenueField<bigint> => venueUnread("the Lighter contract could not be read (pending balance)")),
    venueRead(io, "/api/v1/orderBookDetails", { filter: "perp" }, parseOrderBookDetails, "Lighter's market list"),
    venueRead(io, "/api/v1/accountsByL1Address", { l1_address: self }, (raw) => parseAccountsByL1Address(raw, self), "the accounts under this address"),
    venueRead(io, "/api/v1/withdrawalDelay", {}, parseWithdrawalDelay, "the withdrawal delay"),
    readVenueKeySlot(accountIndex, { ...io, agentPerpPubKey: args.agentPerpPubKey }),
  ]);

  // Decimals let an OPEN position parse. Without them a flat row still reads
  // and an open one refuses the whole account — unread, never flat — so a
  // failed market list costs the disclosure, not its honesty.
  const decimals: ReadonlyMap<number, PerpDecimals> = details.read ? details.value.decimals : new Map();
  const readAccountAt = async (idx: number): Promise<VenueField<PerpAccountRead>> => {
    const r = await venueRead(
      io,
      "/api/v1/account",
      { by: "index", value: idx },
      (raw) => parseAccount(raw, decimals, { accountIndex: idx }),
      `account ${idx}`,
    );
    if (r.read && r.value.l1Address !== self) return venueUnread(`account ${idx}: Lighter answered for a different address`);
    if (!r.read && !details.read) return venueUnread(`${r.why} (the market list, which open positions need, could not be read either)`);
    return r;
  };

  const masterRead = await readAccountAt(accountIndex);
  let account: VenueField<RecoverVenueAccount>;
  if (!masterRead.read) {
    account = masterRead;
  } else {
    const reduced = reduceAccount(masterRead.value, decimals);
    account = reduced === null ? venueUnread(`account ${accountIndex}: a position could not be scaled`) : venueField(reduced);
  }

  let otherAccounts: VenueField<{ accounts: RecoverOtherAccount[]; complete: boolean }>;
  if (!list.read) {
    otherAccounts = list;
  } else {
    const others = list.value.accounts.filter((a) => a.accountIndex !== accountIndex);
    let complete = list.value.nextCursor === null && others.length <= VENUE_MAX_OTHER_ACCOUNTS;
    // The contract and the venue must agree on who we are. A list that does
    // not name the account the contract names is not a list we can finish.
    if (!list.value.accounts.some((a) => a.accountIndex === accountIndex)) complete = false;
    const accounts: RecoverOtherAccount[] = [];
    for (const a of others.slice(0, VENUE_MAX_OTHER_ACCOUNTS)) {
      const r = await readAccountAt(a.accountIndex);
      if (r.read) {
        accounts.push({ accountIndex: a.accountIndex, holds: !accountReadsEmpty(r.value), summary: otherSummary(r.value) });
      } else if (a.collateralMicro !== 0n) {
        // The list's own collateral is a definite finding even when the full read fails.
        accounts.push({ accountIndex: a.accountIndex, holds: true, summary: `holds ${venueUsdg(a.collateralMicro)} collateral (the rest could not be read)` });
      } else {
        accounts.push({ accountIndex: a.accountIndex, holds: null, summary: `could not be read (${r.why})` });
      }
    }
    otherAccounts = venueField({ accounts, complete });
  }

  const steps = planVenueSteps({ accountIndex, account, pendingMicro, keySlot });
  return { kind: "account", accountIndex, account, otherAccounts, pendingMicro, withdrawalDelaySec, keySlot, ...steps };
}

/**
 * WHICH OWNER-KEY STEPS ARE HONEST TO OFFER, from what was read. Pure.
 *
 * THE UNWIND IS ONE UserOp, IN THIS ORDER, and the order is the point:
 *
 *   1. cancelAllOrders(idx). Whatever the (possibly compromised) API key left
 *      resting stops resting. It also cancels the stops on open positions —
 *      which is why the confirmation names them and asks for another word.
 *   2. changePubKey(idx, 16, throwaway). The agent's key stops working at the
 *      venue. Lighter REFUSES a key change on an account whose cross
 *      collateral is zero (error 21126), so this must run while C > 0 …
 *   3. withdraw(idx, 3, 0, C) … which is why the withdrawal of free
 *      collateral comes AFTER it. Priority requests execute in the order they
 *      were sent, so the rotation sees the collateral still there and the
 *      withdrawal then takes it. The other order would empty C first and the
 *      rotation would fail at the venue, silently, after this op "succeeded".
 *
 * AND WHEN EACH IS LEFT OUT:
 *   - No unwind at all while the account is unread: the rotation's 21126
 *     precondition and the withdraw's amount would both be guesses.
 *   - No rotation when the slot is provably empty (nothing to revoke), or
 *     when C is zero (21126 — it would fail at the venue).
 *   - No withdraw when C is zero, or when an open CROSS position uses C as
 *     margin (it is not free; taking it would push that position toward
 *     liquidation, and the venue would refuse the amount anyway).
 *   - No cancel-only unwind over open positions: without a rotation it would
 *     strip their stops while the key that could replace them stays live —
 *     strictly worse than doing nothing. Cancel-only is offered when there
 *     are orders and no positions.
 *
 * THE CLAIM IS ALWAYS A SEPARATE OPERATION. withdrawPendingBalance reverts
 * when Lighter's relayer claimed first (it usually does), and a batch is
 * atomic: a claim riding with the unwind could revert the key rotation with
 * it.
 */
export function planVenueSteps(input: {
  accountIndex: number;
  account: VenueField<RecoverVenueAccount>;
  pendingMicro: VenueField<bigint>;
  keySlot: VenueField<RecoverKeySlot>;
}): { unwind: VenueUnwind | null; claim: VenueClaim | null; notOffered: string[] } {
  const notOffered: string[] = [];
  let claim: VenueClaim | null = null;
  if (input.pendingMicro.read && input.pendingMicro.value > 0n) {
    claim = { kind: "claim", accountIndex: input.accountIndex, amountMicro: input.pendingMicro.value };
  }
  if (!input.account.read) {
    notOffered.push(
      "No unwind is offered while Lighter's account cannot be read: whether the key can be changed and how much can be withdrawn would be guesses. Run recover again.",
    );
    return { unwind: null, claim, notOffered };
  }
  const a = input.account.value;
  const open = a.positions.length;
  const C = a.collateralMicro;
  const slotMayHoldKey = !input.keySlot.read || input.keySlot.value.state === "key";
  const rotate = slotMayHoldKey && C > 0n;
  const withdrawMicro = C > 0n && a.crossPositions === 0 ? C : 0n;
  if (slotMayHoldKey && C <= 0n) {
    notOffered.push(
      `The key at index ${LIGHTER_ROUTE_V1.apiKeyIndex} cannot be changed from here: Lighter refuses a key change while the account's cross collateral is zero (error 21126).`,
    );
  }
  if (C > 0n && a.crossPositions > 0) {
    notOffered.push(
      `The ${venueUsdg(C)} of cross collateral backs ${plural(a.crossPositions, "open cross-margin position", "open cross-margin positions")}, so it is not free and is not withdrawn.`,
    );
  }
  const cancel = rotate || (a.orders > 0 && open === 0);
  if (!rotate && open > 0 && a.orders > 0) {
    notOffered.push(
      "Resting orders are not cancelled: without a key change that would strip the open positions' stops while the key that could replace them stays live.",
    );
  }
  const calls: VenueCallName[] = [];
  if (cancel) calls.push("cancelAllOrders");
  if (rotate) calls.push("changePubKey");
  if (withdrawMicro > 0n) calls.push("withdraw");
  const unwind: VenueUnwind | null =
    calls.length === 0
      ? null
      : { kind: "unwind", accountIndex: input.accountIndex, calls, withdrawMicro, positionsLeftOpen: cancel ? open : 0 };
  return { unwind, claim, notOffered };
}

/**
 * Is anything at Lighter? "holds" (something is there), "nothing" (every
 * field was READ and is empty, or there is no venue account at all) or
 * "unknown". The question every surface asks before it says "empty": no
 * surface may say "nothing left to recover" unless this is "nothing".
 *
 * A key registered over an empty account is not money, so it does not make
 * the venue "hold" anything; the disclosure still names it.
 */
export function venueStanding(v: RecoverVenue | undefined | null): "nothing" | "holds" | "unknown" {
  if (!v) return "unknown";
  if (v.kind === "elsewhere" || v.kind === "none") return "nothing";
  if (v.kind === "unreadable") return "unknown";
  if (v.kind !== "account") return "unknown";
  let holds = false;
  let unknown = false;
  if (v.account.read) {
    const a = v.account.value;
    if (a.collateralMicro !== 0n || a.isolatedMarginMicro !== 0n || a.positions.length > 0 || a.orders > 0 || a.poolShareCount > 0 || a.spotBalanceCount > 0) {
      holds = true;
    }
  } else {
    unknown = true;
  }
  if (v.pendingMicro.read) {
    if (v.pendingMicro.value > 0n) holds = true;
  } else {
    unknown = true;
  }
  if (v.otherAccounts.read) {
    if (v.otherAccounts.value.accounts.some((o) => o.holds === true)) holds = true;
    if (!v.otherAccounts.value.complete || v.otherAccounts.value.accounts.some((o) => o.holds === null)) unknown = true;
  } else {
    unknown = true;
  }
  return holds ? "holds" : unknown ? "unknown" : "nothing";
}

/** What the executor re-derives and must match: identity, never amounts (amounts are re-read before signing). */
export type ApprovedVenueStep =
  | { kind: "unwind"; accountIndex: number; calls: VenueCallName[]; positionsLeftOpen: number }
  | { kind: "claim"; accountIndex: number };

/** One step, in words, for a confirmation. JSON-safe. */
export interface VenueOfferText {
  kind: "unwind" | "claim";
  title: string;
  /** What each call does, in send order. */
  lines: string[];
  /** What the owner must understand before typing the word. */
  warnings: string[];
  /** The word the CLI asks for. Different when open positions lose their stops. */
  confirmWord: string;
  approved: ApprovedVenueStep;
}

/**
 * The venue group in words, JSON-safe, so the CLI child, the web panel and
 * any future route print ONE text rather than three that drift. Every amount
 * is exact; every unread field says it was not read and that this is not a
 * zero.
 */
export interface VenueDisclosure {
  standing: "nothing" | "holds" | "unknown";
  accountIndex: number | null;
  headline: string;
  /** Grouped by custody: the account at Lighter, the contract, other accounts, the key. */
  groups: { title: string; lines: string[] }[];
  offers: VenueOfferText[];
  notes: string[];
}

function shortKey(pk: string): string {
  return `${pk.slice(0, 10)}…${pk.slice(-6)}`;
}

function delayText(d: VenueField<number>): string {
  return d.read ? ` (Lighter's delay right now: about ${Math.max(1, Math.ceil(d.value / 60))} min, read live — it varies)` : "";
}

/**
 * Build the disclosure. `gasWei` adds the one note that stops an unwind dead
 * (no ETH to pay for it); omit it when unknown.
 */
export function venueDisclosure(v: RecoverVenue | undefined | null, opts: { gasWei?: bigint | null } = {}): VenueDisclosure {
  const standing = venueStanding(v);
  if (!v) {
    return {
      standing,
      accountIndex: null,
      headline: "Lighter (perpetuals) was not checked here, so whether anything is there is unknown.",
      groups: [],
      offers: [],
      notes: [],
    };
  }
  if (v.kind === "elsewhere") {
    return {
      standing,
      accountIndex: null,
      headline: `Lighter runs only on Robinhood Chain mainnet (${LIGHTER_ROUTE_V1.chainId}); there is nothing of it on chain ${v.chainId}.`,
      groups: [],
      offers: [],
      notes: [],
    };
  }
  if (v.kind === "none") {
    return { standing, accountIndex: null, headline: "Lighter: no account has ever existed for this smart account.", groups: [], offers: [], notes: [] };
  }
  if (v.kind === "unreadable") {
    return {
      standing,
      accountIndex: null,
      headline: "Lighter could not be read, so what is still there is unknown.",
      groups: [
        {
          title: "At Lighter",
          lines: [`could not be read (${v.why}) — that is NOT an empty account: positions, their stops and USDG may be there`],
        },
      ],
      offers: [],
      notes: ["Run recover again when the chain answers."],
    };
  }
  const groups: VenueDisclosure["groups"] = [];
  const acct: string[] = [];
  if (!v.account.read) {
    acct.push(`could not be read (${v.account.why}) — that is NOT an empty account: positions, their stops and USDG may be there`);
  } else {
    const a = v.account.value;
    if (a.collateralMicro !== 0n) acct.push(`${venueUsdg(a.collateralMicro)} cross collateral`);
    if (a.isolatedMarginMicro !== 0n) acct.push(`${venueUsdg(a.isolatedMarginMicro)} isolated margin, held by the open positions below`);
    for (const p of a.positions) {
      const margin = p.marginMode === "isolated" ? `margin ${venueUsdg(p.marginMicro)}` : "cross margin";
      const liq = p.liqPrice === null ? "no liquidation price reported" : `liquidation ${p.liqPrice}`;
      const stops = p.stopsResting > 0 ? `${plural(p.stopsResting, "order", "orders")} resting on it (its stop)` : "no stop seen resting";
      acct.push(`${p.market} ${p.side} ${p.size} · ${margin} · unrealized ${venueSigned(p.unrealizedMicro)} · ${liq} · ${stops}`);
    }
    if (a.orders > 0) acct.push(plural(a.orders, "resting order", "resting orders"));
    if (a.poolShareCount > 0) acct.push(`shares in ${plural(a.poolShareCount, "public pool", "public pools")} — not movable from here`);
    if (a.spotBalanceCount > 0) {
      acct.push(`${plural(a.spotBalanceCount, "balance", "balances")} in Lighter's spot account or unlocking — not movable from here`);
    }
    if (acct.length === 0) acct.push("reads empty: no collateral, positions, orders, pool shares or spot balances");
  }
  groups.push({ title: `At Lighter · account ${v.accountIndex}`, lines: acct });

  groups.push({
    title: "Waiting on the Lighter contract",
    lines: [
      v.pendingMicro.read
        ? v.pendingMicro.value > 0n
          ? `${venueUsdg(v.pendingMicro.value)} claimable into this smart account`
          : "nothing waiting to be claimed"
        : `could not be read (${v.pendingMicro.why}) — not the same as nothing`,
    ],
  });

  if (!v.otherAccounts.read) {
    groups.push({ title: "Other Lighter accounts under this smart account", lines: [`could not be read (${v.otherAccounts.why}) — whether they hold anything is unknown`] });
  } else if (v.otherAccounts.value.accounts.length > 0 || !v.otherAccounts.value.complete) {
    const lines = v.otherAccounts.value.accounts.map((o) => `account ${o.accountIndex}: ${o.summary}`);
    if (!v.otherAccounts.value.complete) lines.push("the venue lists more than was read here, so this list may be short");
    lines.push("the agent never creates these; this build discloses them and does not unwind them");
    groups.push({ title: "Other Lighter accounts under this smart account", lines });
  }

  const key = `API key at index ${LIGHTER_ROUTE_V1.apiKeyIndex}`;
  if (!v.keySlot.read) {
    groups.push({ title: key, lines: [`could not be read (${v.keySlot.why})`] });
  } else if (v.keySlot.value.state === "empty") {
    groups.push({ title: key, lines: ["no key registered"] });
  } else {
    const s = v.keySlot.value;
    groups.push({
      title: key,
      lines: [
        s.agents === true
          ? `the agent's key (${shortKey(s.publicKey)}) — whoever holds it can trade this account and send its money home, until it is changed`
          : s.agents === false
            ? `a key that is not the agent's current one (${shortKey(s.publicKey)}) — an earlier recover's throwaway, or a key from an older grant`
            : `a key is registered (${shortKey(s.publicKey)})`,
      ],
    });
  }

  const notes = [...v.notOffered];
  notes.push(
    v.withdrawalDelaySec.read
      ? `Lighter's withdrawal delay right now: about ${Math.max(1, Math.ceil(v.withdrawalDelaySec.value / 60))} min (read live; it varies).`
      : `Lighter's withdrawal delay could not be read (${v.withdrawalDelaySec.why}).`,
  );
  if (v.account.read && v.account.value.positions.length > 0) {
    notes.push(
      "Open positions cannot be closed from the owner key in this build: Lighter's on-chain createOrder has no reduce-only flag, so it stays off until the mainnet checklist proves it. The agent's own stand-down (`merrymen kill`) closes them with its key; otherwise their stops and Lighter's liquidation are what end them.",
    );
  }

  const offers: VenueOfferText[] = [];
  const noGas = opts.gasWei === 0n ? ["The account has no ETH to pay for this operation — send a little ETH to it first."] : [];
  if (v.claim) {
    offers.push({
      kind: "claim",
      title: "Claim what is waiting on the Lighter contract",
      lines: [`withdrawPendingBalance — ${venueUsdg(v.claim.amountMicro)} into this smart account; it can only ever pay this account`],
      warnings: [
        "Anyone may make this claim and Lighter's relayer usually does it first. If it has, this operation fails, costs a little gas, and the money is already in the account.",
        ...noGas,
      ],
      confirmWord: "claim",
      approved: { kind: "claim", accountIndex: v.accountIndex },
    });
  }
  if (v.unwind) {
    const u = v.unwind;
    const lines: string[] = [];
    for (const c of u.calls) {
      if (c === "cancelAllOrders") {
        lines.push(
          `cancelAllOrders — every resting order on account ${u.accountIndex}` +
            (u.positionsLeftOpen > 0 ? `, INCLUDING the stops on ${plural(u.positionsLeftOpen, "open position", "open positions")}` : ""),
        );
      } else if (c === "changePubKey") {
        lines.push(
          `changePubKey — replace the API key at index ${LIGHTER_ROUTE_V1.apiKeyIndex} with a fresh key nobody holds, so the agent's key can no longer trade, cancel or withdraw`,
        );
      } else {
        lines.push(
          `withdraw — ${venueUsdg(u.withdrawMicro)} of free cross collateral, as a secure withdrawal that can only pay this smart account. ` +
            `It waits on the Lighter contract after the delay${delayText(v.withdrawalDelaySec)}; run recover again then to claim it`,
        );
      }
    }
    const warnings: string[] = [];
    if (u.calls.includes("changePubKey") && u.calls.includes("withdraw")) {
      warnings.push(
        "The withdrawal comes after the key change on purpose: Lighter refuses a key change on an account with no cross collateral (error 21126).",
      );
    }
    if (u.positionsLeftOpen > 0) {
      const a = v.account.read ? v.account.value : null;
      warnings.push(
        `${plural(u.positionsLeftOpen, "position stays OPEN", "positions stay OPEN")} with NO stop and no key that can close ${u.positionsLeftOpen === 1 ? "it" : "them"}: only Lighter's liquidation ends ${u.positionsLeftOpen === 1 ? "it" : "them"}` +
          (a && a.isolatedMarginMicro > 0n ? `, and the ${venueUsdg(a.isolatedMarginMicro)} of isolated margin stays with ${u.positionsLeftOpen === 1 ? "it" : "them"}` : "") +
          ". If the agent is still running and its key is not suspected, `merrymen kill` first closes positions with the agent's own key.",
      );
    }
    if (u.calls.includes("changePubKey")) {
      warnings.push(
        "Changing the key does not durably revoke the agent while its session permission is valid (until the grant expires): whoever holds the grant can register the agent's key again. This build does not revoke that permission on chain.",
      );
    }
    warnings.push(
      "These are priority requests: Lighter processes them after this operation lands, and one it then refuses (if the collateral moved, say) fails there, where this operation cannot see it. Run recover again afterwards to see what is left.",
    );
    warnings.push(...noGas);
    offers.push({
      kind: "unwind",
      title: "Unwind at Lighter with your owner key (one operation)",
      lines,
      warnings,
      confirmWord: u.positionsLeftOpen > 0 ? "unwind anyway" : "unwind",
      approved: { kind: "unwind", accountIndex: u.accountIndex, calls: [...u.calls], positionsLeftOpen: u.positionsLeftOpen },
    });
  }

  const headline =
    standing === "holds"
      ? `Lighter: money or positions are still at the venue (account ${v.accountIndex}). They are NOT part of the sweep — see below.`
      : standing === "unknown"
        ? `Lighter could not be read in full (account ${v.accountIndex}), so what is still there is unknown — see below.`
        : `Lighter: account ${v.accountIndex} reads empty.`;
  return { standing, accountIndex: v.accountIndex, headline, groups, offers, notes };
}

/**
 * A fresh Lighter API public key that NOBODY holds the private key for.
 *
 * Five 8-byte little-endian limbs, each a Goldilocks element (< p), not all
 * zero — exactly what validatePerpPubKey (and the contract's changePubKey)
 * accept. Each limb is rejection-sampled, never reduced mod p, so every
 * canonical value is equally likely.
 *
 * WHY A KEY WITH NO PRIVATE KEY IS SAFE HERE, AND IS THE POINT: its only job is
 * to occupy index 16 so the agent's key stops working. Lighter verifies L2
 * transactions against the registered key; a key whose discrete log nobody
 * knows can sign nothing, so nothing can ever trade, cancel or withdraw with
 * it — a revocation, not a hand-over. Generating a real pair would need the
 * 14 MB Go signer on every recovering device (recover.ts must stay free of it)
 * and would leave a private key lying around to be leaked.
 *
 * IT IS SAMPLED TO DECODE TO A CURVE POINT, not merely to be canonical. The
 * contract checks only that the limbs are canonical, but whether Lighter's
 * circuit ALSO insists the key decode (ECgFp5, ecgfp5Decodes below) is
 * unproven — and about half of random canonical values do not. That mattered
 * more than a failed rotation: the unwind sends the key change and the
 * withdrawal of all free cross collateral in ONE operation, the venue
 * processes them independently, and a refused key change beside a landed
 * withdrawal leaves cross collateral at 0 — where Lighter refuses every later
 * key change (21126) and the agent's key stays live over the isolated
 * positions, with no recover path left to revoke it. Every real Lighter public
 * key decodes (the test holds this against keys the official signer made), so
 * a throwaway drawn from the decoding half is indistinguishable in form from
 * one: whatever the circuit checks about a key's encoding, it passes. The CLI
 * still re-reads index 16 afterwards, and the mainnet checklist's recover
 * drill (H2) records whether a canonical NON-decoding key is accepted.
 *
 * `random` is injectable for tests; the default is the platform CSPRNG.
 */
export function throwawayLighterKey(
  random: (n: number) => Uint8Array = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n)),
): `0x${string}` {
  let zero = 0;
  // Half of canonical values decode, so 128 draws failing in a row means the
  // source is broken (or repeating itself), not unlucky: 2^-128.
  for (let attempt = 0; attempt < 128; attempt++) {
    const bytes = new Uint8Array(40);
    for (let limb = 0; limb < 5; limb++) {
      let placed = false;
      // p = 2^64 − 2^32 + 1, so a uniform u64 is ≥ p with probability ~2^-32;
      // 64 draws failing in a row means the source is broken, not unlucky.
      for (let draw = 0; draw < 64 && !placed; draw++) {
        const b = random(8);
        if (!(b instanceof Uint8Array) || b.length !== 8) throw new Error("throwawayLighterKey: the random source did not return 8 bytes");
        let v = 0n;
        for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[i]!);
        if (v < GOLDILOCKS_P) {
          bytes.set(b, limb * 8);
          placed = true;
        }
      }
      if (!placed) throw new Error("throwawayLighterKey: the random source never produced a canonical limb");
    }
    const hex = `0x${Array.from(bytes, (x) => x.toString(16).padStart(2, "0")).join("")}`;
    // validatePerpPubKey also refuses all-zero — the one canonical value that is not a key.
    const key = validatePerpPubKey(hex);
    if (key === null) {
      zero++;
      if (zero >= 16) break;
      continue;
    }
    if (ecgfp5Decodes(key)) return key;
  }
  throw new Error(
    zero >= 16
      ? "throwawayLighterKey: the random source keeps producing the zero key"
      : "throwawayLighterKey: the random source never produced a key that decodes to a curve point",
  );
}

// ── ECgFp5: does a Lighter public key decode to a curve point? ──────────────

/**
 * GF(p^5) = GF(p)[z]/(z^5 − 3) over the Goldilocks prime, as five bigint
 * coefficients, lowest first — the field Lighter's Schnorr keys live in
 * (Pornin's ECgFp5; lighter-go's poseidon_crypto curve/ecgfp5). Pure BigInt:
 * this runs wherever recover.ts does, and is only ever asked about PUBLIC keys.
 */
type Gfp5 = readonly [bigint, bigint, bigint, bigint, bigint];

const gfMod = (x: bigint): bigint => ((x % GOLDILOCKS_P) + GOLDILOCKS_P) % GOLDILOCKS_P;

function gfp5Mul(a: Gfp5, b: Gfp5): Gfp5 {
  const c = [0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n];
  for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) c[i + j]! += a[i]! * b[j]!;
  // z^5 = 3: fold the high half back down.
  return [
    gfMod(c[0]! + 3n * c[5]!),
    gfMod(c[1]! + 3n * c[6]!),
    gfMod(c[2]! + 3n * c[7]!),
    gfMod(c[3]! + 3n * c[8]!),
    gfMod(c[4]!),
  ];
}

function gfp5Sub(a: Gfp5, b: Gfp5): Gfp5 {
  return [gfMod(a[0] - b[0]), gfMod(a[1] - b[1]), gfMod(a[2] - b[2]), gfMod(a[3] - b[3]), gfMod(a[4] - b[4])];
}

function gfp5Pow(a: Gfp5, e: bigint): Gfp5 {
  let r: Gfp5 = [1n, 0n, 0n, 0n, 0n];
  let b = a;
  while (e > 0n) {
    if (e & 1n) r = gfp5Mul(r, b);
    b = gfp5Mul(b, b);
    e >>= 1n;
  }
  return r;
}

/** (p^5 − 1) / 2: Euler's criterion in GF(p^5). */
const GFP5_HALF_ORDER = (GOLDILOCKS_P ** 5n - 1n) / 2n;
/** The curve y² = x(x² + a·x + b): a = 2, and 4b with b = 263·z. */
const ECGFP5_A: Gfp5 = [2n, 0n, 0n, 0n, 0n];
const ECGFP5_B4: Gfp5 = [0n, 4n * 263n, 0n, 0n, 0n];

/**
 * DOES THIS 40-BYTE KEY DECODE TO A POINT ON ECgFp5? The key is w = y/x as five
 * little-endian 8-byte limbs (validatePerpPubKey's layout). Decoding solves
 * x² − (w² − a)·x + b = 0, which has a root exactly when δ = (w² − a)² − 4b is
 * a square in GF(p^5) (or w = 0, the neutral point). About half of all
 * canonical values fail; every key the official signer makes passes.
 */
export function ecgfp5Decodes(pubKey: string): boolean {
  const key = validatePerpPubKey(pubKey);
  if (key === null) return false;
  const hex = key.slice(2);
  const limbs: bigint[] = [];
  for (let l = 0; l < 5; l++) {
    let v = 0n;
    for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(parseInt(hex.slice((l * 8 + i) * 2, (l * 8 + i) * 2 + 2), 16));
    limbs.push(v);
  }
  const w = limbs as unknown as Gfp5;
  const e = gfp5Sub(gfp5Mul(w, w), ECGFP5_A);
  const delta = gfp5Sub(gfp5Mul(e, e), ECGFP5_B4);
  if (delta.every((x) => x === 0n)) return true;
  const chi = gfp5Pow(delta, GFP5_HALF_ORDER);
  return chi[0] === 1n && chi[1] === 0n && chi[2] === 0n && chi[3] === 0n && chi[4] === 0n;
}

/**
 * The unwind's calls, IN SEND ORDER, to the proxy, each with zero value.
 * Pure, so the order — cancel, rotate, then withdraw (21126) — is testable
 * without a chain.
 */
export function venueUnwindCalls(
  u: Pick<VenueUnwind, "accountIndex" | "calls" | "withdrawMicro">,
  freshKey: `0x${string}` | null,
): { to: Address; value: bigint; data: `0x${string}` }[] {
  const idx = BigInt(u.accountIndex);
  if (idx <= 0n || idx > UINT48_MAX) throw new RangeError("venueUnwindCalls: not a Lighter account index");
  const order: VenueCallName[] = ["cancelAllOrders", "changePubKey", "withdraw"];
  // The order is the contract's, not the caller's: a list in any other order
  // is refused rather than silently re-sorted, because the caller that built
  // it believed something else would happen.
  const want = order.filter((c) => u.calls.includes(c));
  if (want.length !== u.calls.length || want.some((c, i) => u.calls[i] !== c)) {
    throw new Error(`venueUnwindCalls: calls must be a subset of ${order.join(" → ")} in that order`);
  }
  const out: { to: Address; value: bigint; data: `0x${string}` }[] = [];
  for (const c of u.calls) {
    if (c === "cancelAllOrders") {
      out.push({ to: LIGHTER_ROUTE_V1.proxy, value: 0n, data: encodeFunctionData({ abi: LIGHTER_OWNER_RECOVER_ABI, functionName: "cancelAllOrders", args: [Number(idx)] }) });
    } else if (c === "changePubKey") {
      const key = freshKey === null ? null : validatePerpPubKey(freshKey);
      if (key === null) throw new Error("venueUnwindCalls: a key change needs a canonical fresh key");
      out.push({
        to: LIGHTER_ROUTE_V1.proxy,
        value: 0n,
        data: encodeFunctionData({ abi: LIGHTER_CHANGE_PUBKEY_ABI, functionName: "changePubKey", args: [Number(idx), LIGHTER_ROUTE_V1.apiKeyIndex, key] }),
      });
    } else {
      // uint64 base amount; USDG's tick size is 1, so micro-USDG is the unit.
      const amount = u.withdrawMicro / BigInt(LIGHTER_ROUTE_V1.usdgTickSize);
      if (amount <= 0n || amount > UINT64_MAX) throw new RangeError("venueUnwindCalls: withdraw amount out of range");
      out.push({
        to: LIGHTER_ROUTE_V1.proxy,
        value: 0n,
        data: encodeFunctionData({
          abi: LIGHTER_OWNER_RECOVER_ABI,
          functionName: "withdraw",
          args: [Number(idx), LIGHTER_ROUTE_V1.assetIndex, LIGHTER_ROUTE_V1.routePerps, amount],
        }),
      });
    }
  }
  return out;
}

/** The claim's one call: withdrawPendingBalance(self, 3, amount). It always pays `self`. */
export function venueClaimCall(self: Address, amountMicro: bigint): { to: Address; value: bigint; data: `0x${string}` } {
  const amount = amountMicro / BigInt(LIGHTER_ROUTE_V1.usdgTickSize);
  if (amount <= 0n || amount > UINT128_MAX) throw new RangeError("venueClaimCall: amount out of range");
  return {
    to: LIGHTER_ROUTE_V1.proxy,
    value: 0n,
    data: encodeFunctionData({ abi: LIGHTER_WITHDRAW_PENDING_ABI, functionName: "withdrawPendingBalance", args: [self, LIGHTER_ROUTE_V1.assetIndex, amount] }),
  };
}

export interface VenueStepResult {
  kind: "unwind" | "claim";
  smartAccount: Address;
  accountIndex: number;
  calls: string[];
  userOpHash: `0x${string}`;
  txHash: `0x${string}`;
  /**
   * The fresh key now asked for at index 16. PUBLIC, and nobody holds its
   * private key. Recorded (recover-cli writes it to perp-owner-rotations.json)
   * so the worker can tell the owner's rotation from an attacker's.
   */
  rotatedTo: `0x${string}` | null;
  /** The key that was at the index as read just before signing; null when empty or unread. */
  replacedPubKey: `0x${string}` | null;
  withdrawRequestedMicro: bigint;
  claimedMicro: bigint;
  positionsLeftOpen: number;
}

/**
 * Execute ONE venue step — the unwind or the claim — the owner approved.
 *
 * Re-reads the venue, re-derives the step, and signs only when it is the one
 * approved: the same account index and the same calls in the same order, and
 * never MORE open positions losing their stops than the owner agreed to.
 * Amounts are NOT pinned: they come from the fresh read, because an amount
 * shown a minute ago that no longer exists is how a priority request fails
 * at the venue out of sight. Every refusal happens before anything is signed.
 */
export async function recoverVenueStep(opts: {
  chain: Chain;
  owner: RecoveryOwner;
  bundlerUrl: string;
  rpcUrl?: string;
  expectedSmartAccount?: Address;
  agentPerpPubKey?: string | null;
  approved: ApprovedVenueStep;
  venueFetch?: VenueFetch;
  lighterApiBase?: string;
  /** Test seam for the throwaway key; production draws a fresh one. */
  freshKey?: () => `0x${string}`;
}): Promise<VenueStepResult> {
  if (opts.owner.kind === "address") {
    throw new Error("the Lighter unwind needs an owner that can sign: this one is address-only.");
  }
  if (opts.chain.id !== LIGHTER_ROUTE_V1.chainId) {
    throw new Error(`Lighter settles on chain ${LIGHTER_ROUTE_V1.chainId}; there is nothing of it on chain ${opts.chain.id}.`);
  }
  const refuse = (why: string): never => {
    throw new Error(`refusing the Lighter step: ${why}. Nothing has been signed. Run recover again so the confirmation is rebuilt from current state.`);
  };
  const publicClient = createPublicClient({ chain: opts.chain, transport: http(opts.rpcUrl) });
  const ownerAccount = ownerAccountOf(opts.owner);
  const account = await deriveKernelAccount(opts.chain, opts.rpcUrl, ownerAccount);
  assertDerivedAccount(account.address, "that owner does not derive an account");
  if (opts.expectedSmartAccount && account.address.toLowerCase() !== opts.expectedSmartAccount.toLowerCase()) {
    refuse(`this owner controls ${account.address}, not the expected ${opts.expectedSmartAccount}`);
  }

  const venue = await readRecoverVenue({
    smartAccount: account.address,
    chainId: opts.chain.id,
    chainRead: lighterChainReader(publicClient),
    agentPerpPubKey: opts.agentPerpPubKey ?? null,
    fetch: opts.venueFetch,
    baseUrl: opts.lighterApiBase,
  });
  if (venue.kind !== "account") {
    refuse(venue.kind === "unreadable" ? `Lighter could not be read (${venue.why})` : "this account has no Lighter account");
  }
  const v = venue as Extract<RecoverVenue, { kind: "account" }>;
  if (v.accountIndex !== opts.approved.accountIndex) {
    refuse(`the approved Lighter account was ${opts.approved.accountIndex}, but the contract now names ${v.accountIndex}`);
  }

  let calls: { to: Address; value: bigint; data: `0x${string}` }[];
  let rotatedTo: `0x${string}` | null = null;
  let withdrawRequestedMicro = 0n;
  let claimedMicro = 0n;
  let names: string[];
  let positionsLeftOpen = 0;
  if (opts.approved.kind === "claim") {
    if (!v.claim) {
      refuse(
        v.pendingMicro.read
          ? "nothing is waiting on the Lighter contract any more — Lighter's relayer has most likely claimed it into the account already"
          : `the pending balance could not be read (${v.pendingMicro.why})`,
      );
    }
    claimedMicro = v.claim!.amountMicro;
    calls = [venueClaimCall(account.address, claimedMicro)];
    names = ["withdrawPendingBalance"];
  } else {
    const approved = opts.approved;
    const u = v.unwind;
    if (!u) refuse(`there is no unwind to do now${v.notOffered.length ? ` (${v.notOffered.join(" ")})` : ""}`);
    const fresh = u!;
    if (fresh.calls.join(",") !== approved.calls.join(",")) {
      refuse(`the approved unwind was ${approved.calls.join(" → ")}, but what is possible now is ${fresh.calls.join(" → ")}`);
    }
    if (fresh.positionsLeftOpen > approved.positionsLeftOpen) {
      refuse(
        `${fresh.positionsLeftOpen} open position(s) would now lose their stops, and the confirmation you approved named ${approved.positionsLeftOpen}`,
      );
    }
    if (fresh.calls.includes("changePubKey")) rotatedTo = (opts.freshKey ?? throwawayLighterKey)();
    calls = venueUnwindCalls(fresh, rotatedTo);
    withdrawRequestedMicro = fresh.withdrawMicro;
    names = [...fresh.calls];
    positionsLeftOpen = fresh.positionsLeftOpen;
  }

  // The operation pays its own gas from the account's ETH. Finding that out
  // from a bundler's AA21 is the confusing version of this sentence.
  const eth = await publicClient.getBalance({ address: account.address }).catch(() => null);
  if (eth === 0n) refuse("the account has no ETH to pay for this operation — send a little ETH to it first");

  const client = createKernelAccountClient({
    account,
    chain: opts.chain,
    bundlerTransport: http(opts.bundlerUrl),
    userOperation: userOpGasConfig(publicClient, opts.bundlerUrl),
  });
  const userOpHash = await client.sendUserOperation({ callData: await account.encodeCalls(calls) });
  const receipt = await client.waitForUserOperationReceipt({ hash: userOpHash });
  if (!receipt.success) {
    throw new Error(
      opts.approved.kind === "claim"
        ? `the claim reverted on-chain (${userOpHash}) — most likely Lighter's relayer claimed first and the money is already in the account; run recover again to see`
        : `the Lighter unwind reverted on-chain (${userOpHash}); nothing reached Lighter`,
    );
  }
  return {
    kind: opts.approved.kind,
    smartAccount: account.address,
    accountIndex: v.accountIndex,
    calls: names,
    userOpHash,
    txHash: receipt.receipt.transactionHash,
    rotatedTo,
    replacedPubKey: v.keySlot.read && v.keySlot.value.state === "key" ? v.keySlot.value.publicKey : null,
    withdrawRequestedMicro,
    claimedMicro,
    positionsLeftOpen,
  };
}
