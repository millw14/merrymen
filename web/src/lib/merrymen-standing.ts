/**
 * ONE ANSWER TO "HOW MUCH $MERRYMEN DOES THIS OWNER HAVE", for every route.
 *
 * The worker's Circle gate and its energy both count the COMBINED balance: the
 * owner's holder wallet plus the agent's own account (design D1). /api/tier,
 * /api/circle and /api/alpha drive the Circle banner, the create and settings
 * standing, the Android banner and the iOS Circle and Grant screens — and they
 * read only the owner's wallet. So "send $MERRYMEN to my account" would clear
 * the worker's gate while every one of those screens went on saying "isn't
 * running — you hold 0": two surfaces, two confident answers, about the same
 * person. holder-wallet.ts's header records the last time that happened.
 *
 * So all three read the same two balances through this, in ONE multicall.
 *
 * THE RULES, each for a reason:
 *
 *   THE AGENT COUNTS ONLY ON ROBINHOOD CHAIN. A grant on any other network has
 *   a counterfactual address on mainnet that this app cannot recover from, so
 *   tokens sent there must never be reported as counting (countedAgent).
 *
 *   COUNTED ONCE. Self-hosted, an operator can name their agent's own account
 *   as their holder wallet; the same tokens are not twice the tokens.
 *
 *   ANY READ THAT FAILS FAILS THE WHOLE STANDING. Half a sum is a smaller
 *   number, and a smaller number is the sentence that sends somebody to buy
 *   tokens they already hold. readStanding throws, and every route turns that
 *   into its own `unreadable` answer with every count null — never a 0.
 *
 *   A BALANCE IS CACHED, NEVER A VERDICT. Per address, per route, the way
 *   /api/alpha always did it: the tier is re-derived every request, so a
 *   wallet that sold out loses its perks with nothing to invalidate. The
 *   holder keeps its ten minutes; the agent's account gets one, because it is
 *   the balance an owner has just been told to top up and is now watching.
 *
 * Server-only. It builds no transport: each route passes a client over its own
 * webChainRead(), which chain-read.test.ts pins route by route.
 */
import { readFile } from "node:fs/promises";
import { parseAbi } from "viem";
import { homePaths } from "@merrymen/home";
import { MERRYMEN_TOKEN, wholeTokens, type MerrymenSettings } from "@merrymen/core";
import type { AgentAccount } from "./agent-account";

const BALANCE_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);

/** One multicall entry, in the shape viem returns with `allowFailure` on. */
type Settled = { status: "success" | "failure"; result?: unknown };

/** The one viem call this makes, and nothing else of the client. */
export interface StandingClient {
  multicall(args: {
    contracts: readonly {
      address: `0x${string}`;
      abi: typeof BALANCE_ABI;
      functionName: "balanceOf";
      args: readonly [`0x${string}`];
    }[];
  }): Promise<readonly Settled[]>;
}

/** A raw balance per lowercase address, with when it was read. Never a verdict. */
export type BalanceCache = Map<string, { at: number; raw: bigint }>;

/** The owner's wallet moves when they trade the token. */
export const HOLDER_BALANCE_TTL_MS = 10 * 60_000;
/** The agent's account is the one an owner has just been told to top up. */
export const AGENT_BALANCE_TTL_MS = 60_000;

/**
 * The agent account that counts toward this owner's standing, or null: only on
 * the token's own chain, and never the same address twice.
 */
export function countedAgent(
  holder: string | null | undefined,
  agent: AgentAccount | null | undefined,
): `0x${string}` | null {
  if (!agent || agent.chainId !== MERRYMEN_TOKEN.chainId) return null;
  if (holder && holder.toLowerCase() === agent.address.toLowerCase()) return null;
  return agent.address;
}

export interface Standing {
  /** Holder plus counted agent, raw (18dp). */
  raw: bigint;
  /** The owner wallet's own part; null when there is no wallet to read. */
  holderRaw: bigint | null;
  /** The agent account's part; null when it does not count (none, another chain, or the holder itself). */
  agentRaw: bigint | null;
  /** The agent account that was counted. */
  agent: `0x${string}` | null;
}

/**
 * Read the combined standing. THROWS when any present address could not be
 * read — see the header: half a sum is a lie in the expensive direction.
 */
export async function readStanding(opts: {
  client: StandingClient;
  holder: `0x${string}` | null;
  agent: AgentAccount | null;
  holderCache?: BalanceCache;
  agentCache?: BalanceCache;
  holderTtlMs?: number;
  agentTtlMs?: number;
  now?: number;
}): Promise<Standing> {
  const now = opts.now ?? Date.now();
  const holder = opts.holder;
  const agent = countedAgent(holder, opts.agent);

  const cached = (cache: BalanceCache | undefined, address: string, ttl: number): bigint | undefined => {
    const hit = cache?.get(address.toLowerCase());
    return hit && now - hit.at < ttl ? hit.raw : undefined;
  };
  let holderRaw: bigint | null | undefined = holder
    ? cached(opts.holderCache, holder, opts.holderTtlMs ?? HOLDER_BALANCE_TTL_MS)
    : null;
  let agentRaw: bigint | null | undefined = agent
    ? cached(opts.agentCache, agent, opts.agentTtlMs ?? AGENT_BALANCE_TTL_MS)
    : null;

  const want: { address: `0x${string}`; part: "holder" | "agent" }[] = [];
  if (holderRaw === undefined) want.push({ address: holder!, part: "holder" });
  if (agentRaw === undefined) want.push({ address: agent!, part: "agent" });

  if (want.length > 0) {
    // ONE multicall for both, so the two halves of the sum are read together.
    const results = await opts.client.multicall({
      contracts: want.map((w) => ({
        address: MERRYMEN_TOKEN.address as `0x${string}`,
        abi: BALANCE_ABI,
        functionName: "balanceOf" as const,
        args: [w.address] as const,
      })),
    });
    const values = want.map((w, i) => {
      const r = results?.[i];
      // A "success" carrying no number is not a balance of zero.
      if (r?.status !== "success" || typeof r.result !== "bigint") {
        throw new Error(`$MERRYMEN balance of the ${w.part} could not be read`);
      }
      return r.result;
    });
    // Cached only once EVERY read answered: the pair is one fact.
    want.forEach((w, i) => {
      const raw = values[i]!;
      if (w.part === "holder") {
        holderRaw = raw;
        opts.holderCache?.set(w.address.toLowerCase(), { at: now, raw });
      } else {
        agentRaw = raw;
        opts.agentCache?.set(w.address.toLowerCase(), { at: now, raw });
      }
    });
  }

  const h = holderRaw ?? null;
  const a = agentRaw ?? null;
  return { raw: (h ?? 0n) + (a ?? 0n), holderRaw: h, agentRaw: a, agent: a === null ? null : agent };
}

/** Whole tokens for each part. A part that was not counted is null, never 0. */
export function standingTokens(s: Standing): {
  tokens: number;
  holderTokens: number | null;
  agentTokens: number | null;
} {
  return {
    tokens: wholeTokens(s.raw),
    holderTokens: s.holderRaw === null ? null : wholeTokens(s.holderRaw),
    agentTokens: s.agentRaw === null ? null : wholeTokens(s.agentRaw),
  };
}

/**
 * Is the energy gate ENFORCING on this deployment? For copy only — it never
 * grants or withholds anything; the worker reads the same switch and decides.
 * Mirrors design D2: unset/'0' off, 'observe' counts silently (so nothing is
 * said to an owner), '1'/'enforce' enforces; self-hosted is always off.
 */
export function energyGateOn(raw: string | undefined, hosted: boolean): boolean {
  if (!hosted) return false;
  const v = raw?.trim().toLowerCase();
  return v === "1" || v === "enforce";
}

/**
 * SELF-HOSTED ONLY: the operator's own holder wallet and RPC, from their own
 * settings file. There, and only there, the typed-in `holderAddress` is a
 * declaration about the operator's own wallet — it is exactly what their worker
 * counts. Hosted it is a claim about anyone's balance and is never read
 * (holder-wallet.ts); callers reach this only on the self-hosted branch.
 */
export async function diskHolder(): Promise<{ address: `0x${string}` | null; rpcMainnet: string | undefined }> {
  try {
    const settings = JSON.parse(
      (await readFile(homePaths.settings(), "utf8")).replace(/^﻿/, ""),
    ) as MerrymenSettings;
    const a = settings.holderAddress;
    return {
      address: typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a) ? (a as `0x${string}`) : null,
      rpcMainnet: settings.rpcMainnet,
    };
  } catch {
    return { address: null, rpcMainnet: undefined };
  }
}
