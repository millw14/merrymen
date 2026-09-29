/**
 * IS THE VENUE PROVABLY FLAT — the one question that decides whether a
 * Lighter key may be let go.
 *
 * docs/perps.md rule 5: a registered API key stays valid at the venue whatever
 * the grant says, and only the owner can revoke it (recover rotates it). So
 * "no path may leave a non-flat venue account without its key": dropping the
 * perp block from a grant, or re-signing for another account, is refused
 * unless EVERY account under our L1 address is provably flat. This module is
 * the proof, read by the server (POST /api/grants, partner activation) and
 * shown to the owner before a drop (GET /api/perps/flat).
 *
 * WHAT "FLAT" MEANS, AND IN WHAT ORDER IT IS READ:
 *
 *   1. On chain, addressToAccountIndex(self). ZERO means no deposit ever
 *      landed for this address — there is no venue account, nothing a key
 *      could reach, and nothing else is read (rule 11's "a known 0").
 *   2. On chain, getPendingBalance(self, USDG) must be 0. Money waiting on the
 *      contract is claimable by anyone to `self` and needs no key, but the
 *      rule counts it: "flat" is a statement about the venue, not about
 *      whether this particular leg needs a signature.
 *   3. At the venue, accountsByL1Address(self) — the master AND every
 *      sub-account (rule 16: the API key can create sub-accounts and move
 *      collateral into them). One page only; a next cursor is "more accounts
 *      than we read", which is not flat. The master the contract names must be
 *      in the list, or the two sources disagree about who we are.
 *   4. Each account's full read (/api/v1/account) must be empty by
 *      markets.accountReadsEmpty: no position, no open or pending order, no
 *      collateral or isolated margin, no pool shares, no spot balance, no
 *      pending unlock.
 *
 * UNKNOWN IS NEVER FLAT (rule 11). Every failure — an RPC that throws, a venue
 * that rate-limits, a body that does not parse, an account whose position we
 * cannot scale — is `flat: null`, which every caller treats exactly like
 * `false`. The answer is `false` only when something was actually SEEN; a
 * definite finding outranks an unread one, so the owner is told what is there
 * rather than that something could not be read.
 *
 * WHAT IT DOES NOT COUNT, and why that is safe here: a secure withdrawal still
 * inside the venue's withdrawalDelay (the ledger's in-flight perp_transfers).
 * Its money has already left every account, will land in the pending balance
 * and is paid to `self` by whoever claims it — no API key is involved from here
 * on. The server has no ledger to read it from; the worker's own stand-down
 * and the dashboard, which do, say so.
 *
 * PUBLIC READS ONLY. accountsByL1Address and account-by-index answer without
 * auth, and the server holds no key to sign a token with. The client is the
 * "public" budget (api.ts): it never carries a token and never sends a tx.
 */

import { LIGHTER_READ_ABI, LIGHTER_ROUTE_V1 } from "../../../packages/core/src/index";
import { createLighterApi, type LighterApiError, type LighterFetch } from "./api";
import { accountReadsEmpty, openPositions, type PerpAccountRead, type PerpDecimals } from "./markets";

export type VenueFlatness =
  | { flat: true; detail?: string }
  | { flat: false; detail: string }
  | { flat: null; detail: string };

/** The two contract reads flatness needs, as a caller-bound function (address and ABI fixed below). */
export type LighterReadCall =
  | { functionName: "addressToAccountIndex"; args: readonly [`0x${string}`] }
  | { functionName: "getPendingBalance"; args: readonly [`0x${string}`, number] };
export type LighterChainRead = (call: LighterReadCall) => Promise<unknown>;

/**
 * Bind a viem-shaped client to the proxy and the never-granted read ABI.
 * Structural on purpose, so web and worker can pass their own clients.
 */
export function lighterReadFromClient(client: { readContract: (args: never) => Promise<unknown> }): LighterChainRead {
  return (call) =>
    client.readContract({
      address: LIGHTER_ROUTE_V1.proxy,
      abi: LIGHTER_READ_ABI,
      functionName: call.functionName,
      args: call.args,
    } as never);
}

export interface VenueFlatnessArgs {
  smartAccount: string;
  /** The chain the `read` function is connected to. Anything but 4663 cannot answer. */
  chainId: number;
  read: LighterChainRead;
  /** MERRYMEN_HOME, for the fleet Lighter cooldown file (api.ts). */
  home: string;
  fetch?: LighterFetch;
  baseUrl?: string;
  /** Default 5 s per venue request (api.ts). */
  timeoutMs?: number;
}

/** More sub-accounts than this is not a list we walk request by request; it is not flat. */
const MAX_ACCOUNTS = 16;
/** uint48 — the contract's account-index type. */
const MAX_ACCOUNT_INDEX = 2n ** 48n - 1n;

function asUint(v: unknown, max: bigint): bigint | null {
  if (typeof v === "bigint") return v >= 0n && v <= max ? v : null;
  if (typeof v === "number" && Number.isSafeInteger(v)) return v >= 0 && BigInt(v) <= max ? BigInt(v) : null;
  return null;
}

function unread(e: LighterApiError): string {
  return `${e.kind}${e.status !== null ? ` (HTTP ${e.status})` : ""}`;
}

function usdg(micro: bigint): string {
  const whole = micro / 1_000_000n;
  const frac = (micro % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** What a non-empty account read holds, in words. Never a key, never a price. */
function holdings(acct: PerpAccountRead): string {
  const parts: string[] = [];
  const open = openPositions(acct);
  if (open.length > 0) parts.push(`${open.length} open position${open.length === 1 ? "" : "s"} (${open.map((p) => p.key ?? p.symbol).join(", ")})`);
  if (acct.collateralMicro !== 0n) parts.push(`${usdg(acct.collateralMicro)} USDG collateral`);
  if (acct.isolatedMarginMicro !== 0n) parts.push(`${usdg(acct.isolatedMarginMicro)} USDG isolated margin`);
  const orders = acct.totalOrderCount + acct.pendingOrderCount + acct.positions.reduce((n, p) => n + p.openOrderCount + p.pendingOrderCount + p.positionTiedOrderCount, 0);
  if (orders > 0) parts.push("open or pending orders");
  if (acct.poolShareCount > 0) parts.push("public-pool shares");
  if (acct.spotHoldings.length > 0) parts.push("spot balances");
  if (acct.pendingUnlockCount > 0) parts.push("pending unlocks");
  return parts.length > 0 ? parts.join(", ") : "a non-empty balance";
}

/**
 * Read whether every Lighter account under `smartAccount` is provably flat.
 * Never throws: every failure is `{ flat: null, detail }`.
 */
export async function venueFlatness(args: VenueFlatnessArgs): Promise<VenueFlatness> {
  const self = typeof args.smartAccount === "string" && /^0x[0-9a-fA-F]{40}$/.test(args.smartAccount) ? (args.smartAccount.toLowerCase() as `0x${string}`) : null;
  if (self === null) return { flat: null, detail: "not an account address" };
  if (args.chainId !== LIGHTER_ROUTE_V1.chainId) {
    return { flat: null, detail: `Lighter settles on chain ${LIGHTER_ROUTE_V1.chainId}; a chain ${args.chainId} reader cannot say` };
  }

  // 1. Has this address EVER had a venue account?
  let master: bigint | null;
  try {
    master = asUint(await args.read({ functionName: "addressToAccountIndex", args: [self] }), MAX_ACCOUNT_INDEX);
  } catch {
    return { flat: null, detail: "the Lighter contract could not be read (account index)" };
  }
  if (master === null) return { flat: null, detail: "the Lighter contract answered an account index that is not one" };
  if (master === 0n) return { flat: true, detail: "no Lighter account has ever existed for this address" };

  // 2. Anything waiting on the contract to be claimed.
  let pending: bigint | null;
  try {
    pending = asUint(await args.read({ functionName: "getPendingBalance", args: [self, LIGHTER_ROUTE_V1.assetIndex] }), 2n ** 128n - 1n);
  } catch {
    return { flat: null, detail: "the Lighter contract could not be read (pending balance)" };
  }
  if (pending === null) return { flat: null, detail: "the Lighter contract answered a pending balance that is not one" };
  const found: string[] = [];
  if (pending > 0n) found.push(`${usdg(pending * BigInt(LIGHTER_ROUTE_V1.usdgTickSize))} USDG waiting to be claimed from the Lighter contract`);

  // 3–4. Every account under our L1 address, each read in full.
  const api = createLighterApi({ home: args.home, budgetKey: "public", fetchFn: args.fetch, baseUrl: args.baseUrl, timeoutMs: args.timeoutMs });
  // Decimals let a NON-flat position parse, so the owner is told "2 open
  // positions" rather than "unreadable". Without them a flat row still parses
  // and a non-flat one is unread — never flat — so a failure here only costs
  // the wording.
  let decimals: ReadonlyMap<number, PerpDecimals> = new Map();
  const details = await api.orderBookDetails();
  if (details.ok) decimals = details.value.decimals;

  const list = await api.accountsByL1Address(self);
  if (!list.ok) {
    if (found.length > 0) return { flat: false, detail: found.join("; ") };
    return { flat: null, detail: `Lighter's account list could not be read: ${unread(list.error)}` };
  }
  const unreadNotes: string[] = [];
  if (list.value.nextCursor !== null) unreadNotes.push("the venue lists more accounts than one page");
  const accounts = list.value.accounts;
  if (!accounts.some((a) => BigInt(a.accountIndex) === master)) {
    unreadNotes.push(`the venue's list does not include account ${master}, which the contract names`);
  }
  if (accounts.length > MAX_ACCOUNTS) unreadNotes.push(`${accounts.length} accounts under this address — more than are read here`);

  for (const a of accounts.slice(0, MAX_ACCOUNTS)) {
    // The list's own collateral is a definite finding even if the full read fails.
    if (a.collateralMicro !== 0n) {
      found.push(`account ${a.accountIndex}: ${usdg(a.collateralMicro)} USDG collateral`);
      continue;
    }
    const r = await api.account({ by: "index", accountIndex: a.accountIndex }, decimals);
    if (!r.ok) {
      unreadNotes.push(`account ${a.accountIndex} could not be read: ${unread(r.error)}`);
      continue;
    }
    if (r.value.l1Address !== self) {
      unreadNotes.push(`account ${a.accountIndex} answered for a different address`);
      continue;
    }
    if (!accountReadsEmpty(r.value)) found.push(`account ${a.accountIndex}: ${holdings(r.value)}`);
  }

  if (found.length > 0) return { flat: false, detail: found.join("; ") };
  if (unreadNotes.length > 0) return { flat: null, detail: unreadNotes.join("; ") };
  return { flat: true };
}
