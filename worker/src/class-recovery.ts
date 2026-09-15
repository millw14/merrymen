/**
 * Getting class positions OUT — the half of PonsClassVault nothing implemented.
 *
 * The contract says, at `sweep`, that it "is what `merrymen recover` uses to
 * pull class positions out of the vault, and what makes 'the tokens are in a
 * contract' recoverable rather than a one-way door". That was a claim about code
 * that did not exist: `recover.ts` sweeps ERC-20 balances of the smart account
 * and has no notion of a vault, of `sweep(address)`, or of a second holder.
 *
 * WHY THIS LANDS BEFORE THE EXECUTOR. Nothing can create a class position yet,
 * so nothing is stranded today. The moment a producer exists, every class
 * position an agent opens is unrecoverable by the command that exists to get
 * money out — and building the escape hatch after the trapdoor is the wrong
 * order for a feature whose entire justification is "not a trap".
 *
 * THREE PROBLEMS, and each has a wrong answer that looks reasonable.
 *
 * 1. FINDING THE VAULT. The grant seals it, but recovery may have no grant: the
 *    CLI accepts a pasted owner key, and it can run against an ARCHIVED grant.
 *    So it must also be derivable from the owner key alone — which means the
 *    factory, and a CREATE2 read. Both sources are consulted and DISAGREEMENT IS
 *    A REFUSAL, not a preference: two answers means the factory constant is
 *    wrong for this chain or the grant was signed against a different one, and
 *    sweeping the wrong address is a no-op reported as a success.
 *
 * 2. FINDING THE CONTENTS. `sweep` takes a token and the vault has no
 *    enumeration — "tokens the owner never enumerated" is the framing, and the
 *    token argument is the contract acknowledging the record can be lost. The
 *    local table is fast and is the machine that may be gone; the `ClassBuy`
 *    log is slower and survives. Both, unioned, with the CHAIN as the authority
 *    on what is actually there.
 *
 * 3. GETTING IT OUT. `sweep` pushes to `owner` and takes no recipient, so the
 *    path is vault -> account -> destination and the middle amount is not known
 *    until the sweep executes. See planClassSweep for why that forces two
 *    operations rather than one.
 */
import { erc20Abi, type PublicClient } from "viem";
import {
  PONS_CLASS_VAULT_FACTORY,
  PONS_CLASS_VAULT_FACTORY_ABI,
  grantPonsClassVault,
  grantPonsClassVaultFactory,
  type StoredGrant,
} from "../../packages/core/src/index";

/**
 * Where a vault address came from, so a disagreement can name both sides.
 *
 * `grant` is authoritative when present — it is the address the wall actually
 * pinned. `derived` is the fallback that works with no grant at all.
 */
export type VaultSource = "grant" | "derived" | "none";

export type VaultLookup =
  | { kind: "none"; why: string }
  | { kind: "found"; vault: `0x${string}`; source: VaultSource }
  /** Two sources, two answers. Sweeping either would be a guess. */
  | { kind: "conflict"; why: string }
  /** We could not ask. NOT "there is no vault" — see RecoverPlan.unreadable. */
  | { kind: "unreadable"; why: string };

/**
 * The vault for this account, from every source available.
 *
 * Deliberately does NOT fall back from a failed read to "no vault". An owner
 * whose RPC blinked must not be told their class book is empty — that is the
 * same "unreadable became absent" failure `classifyBalance` exists to prevent,
 * on the path where believing it costs the most.
 */
export async function findClassVault(args: {
  client: Pick<PublicClient, "readContract">;
  chainId: number;
  smartAccount: `0x${string}`;
  /** The grant, when recovery has one. Archived grants count. */
  grant?: Pick<StoredGrant, "grantFeatures" | "ponsClassVaultAddress" | "ponsClassVaultFactoryAddress"> | null;
}): Promise<VaultLookup> {
  const sealed = grantPonsClassVault(args.grant);
  // The grant's own factory first: it is what this signature was built against.
  // The chain constant is for the no-grant case only.
  const factory =
    grantPonsClassVaultFactory(args.grant) ?? PONS_CLASS_VAULT_FACTORY[args.chainId] ?? null;

  if (!sealed && !factory) {
    return {
      kind: "none",
      why: "no class vault: this grant carries no class marker and no factory is known for this chain",
    };
  }

  let derived: `0x${string}` | null = null;
  if (factory) {
    try {
      const answer = (await args.client.readContract({
        address: factory as `0x${string}`,
        abi: PONS_CLASS_VAULT_FACTORY_ABI,
        functionName: "vaultFor",
        args: [args.smartAccount],
      })) as `0x${string}`;
      // The zero address is what a call to a contract that isn't there decodes
      // to on some transports. Treating it as an address would send the sweep
      // at nothing and report success.
      derived = /^0x0{40}$/i.test(answer) ? null : (answer.toLowerCase() as `0x${string}`);
    } catch (e) {
      // A sealed vault is still usable without the derivation — the grant is the
      // authority. Only a lookup with nothing else to fall back on is unreadable.
      if (!sealed) {
        return {
          kind: "unreadable",
          why: `the class-vault factory at ${factory} could not be read (${e instanceof Error ? e.message : String(e)}), so whether this account has class positions is unknown`,
        };
      }
    }
  }

  if (sealed && derived && sealed !== derived) {
    return {
      kind: "conflict",
      why:
        `the grant seals a class vault at ${sealed} but the factory derives ${derived} for this ` +
        `account. One of them holds the position and sweeping the other would report success ` +
        `over an untouched book, so this refuses rather than guessing. Check the chain and the ` +
        `factory address.`,
    };
  }
  if (sealed) return { kind: "found", vault: sealed, source: "grant" };
  if (derived) return { kind: "found", vault: derived, source: "derived" };
  return {
    kind: "none",
    why: `the factory at ${factory} reports no vault for ${args.smartAccount}`,
  };
}

export interface ClassHolding {
  token: `0x${string}`;
  symbol: string;
  raw: bigint;
  /**
   * The token's OWN decimals, carried because the vault is no longer all one
   * shape.
   *
   * `planRecovery` formatted every class holding at 18dp — correct while the
   * only things a vault held were Pons launch tokens, and wrong the moment the
   * enumeration started asking about the quote asset too. USDG is 6dp, so a
   * real 5.785344 USDG was disclosed to an owner as 0.000000000005785344 USDG:
   * the right money, misstated by twelve orders of magnitude, on the screen
   * where they decide whether to sign.
   *
   * The sweep itself was never affected — `sweep(token)` takes no amount and
   * moves the whole balance — which is exactly what makes this dangerous. It is
   * a disclosure bug with no execution symptom, so nothing else would have
   * caught it.
   */
  decimals: number;
}

export type ClassContents =
  | { kind: "read"; holdings: ClassHolding[] }
  /** Some part of the enumeration failed. The list is INCOMPLETE, not empty. */
  | { kind: "partial"; holdings: ClassHolding[]; why: string };

/**
 * What the vault actually holds, from a candidate list the caller assembled.
 *
 * CANDIDATES PROPOSE; THE CHAIN DECIDES. A row in the local table is a token to
 * ask about and nothing more — it may have been sold, swept, or recorded by a
 * worker whose database has since been rebuilt. Only a non-zero on-chain balance
 * makes it a holding.
 *
 * A failed balance read yields `partial`, never a dropped token: the caller
 * prints "there may be more here than this shows" rather than an empty list, for
 * the same reason `planRecovery` carries `unreadable` at all.
 */
/**
 * WHAT TO ASK THE VAULT ABOUT — from its logs AND from the token registry.
 *
 * THE LOGS CANNOT NAME THE QUOTE ASSET. `ClassBuy`/`ClassSell`/`Swept` carry
 * the CLASS token in `token` and the quote only as an amount; the quote asset's
 * address appears in no event this contract emits. So a candidate list built
 * from logs alone can never include USDG, and a vault holding stranded quote
 * enumerates as holding nothing but its class tokens — which is what an owner
 * is then shown, and what the sweep then moves.
 *
 * Measured: Shogun's vault holds 1,063,408.141815 DOGGOS and 5.785344 USDG. The
 * DOGGOS came from a ClassBuy; the USDG from a refund leg that did not land.
 * Only the first was ever disclosed.
 *
 * The registry list is the same one the ACCOUNT sweep enumerates, which is right
 * twice over: it certainly contains the quote asset, and "the assets we already
 * check on the account" stays true as the registry changes, where a hard-coded
 * USDG address would go stale on the next chain.
 *
 * Log-derived tokens come FIRST and win the symbol, because a class token's
 * real symbol is not in the registry and the short-address placeholder is
 * better than nothing; a registry token keeps its proper name.
 */
export function classSweepCandidates(
  logTokens: readonly `0x${string}`[],
  registry: readonly { address: string; symbol: string; decimals?: number }[],
): { token: `0x${string}`; symbol: string; decimals: number }[] {
  const seen = new Set<string>();
  const out: { token: `0x${string}`; symbol: string; decimals: number }[] = [];
  for (const token of logTokens) {
    const k = token.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    // 18dp is the launchpad's shape: every Pons launch is 18 decimals, and a
    // log-derived token is a launch by construction — `readClassLog` reads the
    // vault's own ClassBuy/ClassSell events and nothing else writes them.
    out.push({ token, symbol: `${token.slice(0, 10)}…`, decimals: 18 });
  }
  for (const t of registry) {
    const k = t.address.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    // The registry KNOWS its decimals — USDG is 6 — and that is the whole
    // reason this branch exists separately from the one above.
    out.push({ token: t.address as `0x${string}`, symbol: t.symbol, decimals: t.decimals ?? 18 });
  }
  return out;
}

export async function readClassHoldings(args: {
  client: Pick<PublicClient, "readContract">;
  vault: `0x${string}`;
  candidates: readonly { token: `0x${string}`; symbol: string; decimals?: number }[];
}): Promise<ClassContents> {
  const holdings: ClassHolding[] = [];
  const failed: string[] = [];
  for (const c of args.candidates) {
    try {
      const raw = (await args.client.readContract({
        address: c.token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [args.vault],
      })) as bigint;
      if (raw > 0n) holdings.push({ token: c.token, symbol: c.symbol, raw, decimals: c.decimals ?? 18 });
    } catch {
      failed.push(c.symbol);
    }
  }
  return failed.length === 0
    ? { kind: "read", holdings }
    : {
        kind: "partial",
        holdings,
        why: `could not read ${failed.join(", ")} at the class vault — there may be more here than this list shows`,
      };
}

/**
 * WHY A CLASS SWEEP IS TWO OPERATIONS AND NOT ONE.
 *
 * `sweep(token)` pushes the whole balance to `owner` — the smart account — and
 * takes no recipient. So the path out is vault -> account -> destination, and
 * the amount arriving at the account is not known until the sweep has executed.
 *
 * A Kernel batch cannot thread call N's return value into call N+1's arguments,
 * so `[sweep(t), transfer(to, X)]` needs X in advance. Predicting it from a
 * pre-read `balanceOf(vault)` is the option that looks cheapest and is the one
 * that must not be taken: a curve token is precisely the asset that moves
 * between the read and the send, an over-sized transfer reverts, and the batch
 * is ATOMIC — so it would take the USDG and the ETH down with it. `recover.ts`
 * already reasons about leg ordering for exactly this class of failure, and its
 * answer there was pre-simulation, which cannot help when the balance does not
 * exist until the op runs.
 *
 * So: op 1 sweeps, then the account's balances are RE-READ, then op 2 is the
 * ordinary transfer batch it already builds. The window between them is safe
 * because the tokens land in an account the same key controls — if op 2 fails,
 * rerunning `merrymen recover` sweeps them as ordinary account balances. That
 * property is what makes two ops safe and one op not.
 *
 * A helper contract would give one op and an exact amount. It would also
 * contradict PonsClassVault's own "no owner-admin, no pause, no upgrade, no
 * rescue-to-anywhere", and add a deploy and an audit to a recovery path.
 */
/** What the sweep needs to know. Deliberately NOT the whole holding: decimals
 * are a display concern and this builds calls, so requiring them here would make
 * every caller and fixture carry a number the sweep never reads. */
export type SweepableHolding = Pick<ClassHolding, "token" | "symbol" | "raw">;

export function planClassSweep<T extends SweepableHolding>(holdings: readonly T[]): T[] {
  // ZERO BALANCES ARE FILTERED OUT, not skipped later. `sweep` reverts
  // ZeroAmount() on an empty balance, and the sweep batch is atomic — so one
  // empty token would revert the whole thing. Unlike recover.ts's per-token
  // simulation, failing open here fails the batch rather than one leg, which is
  // why the filter is upstream of the build rather than a catch around it.
  return holdings.filter((h) => h.raw > 0n);
}
