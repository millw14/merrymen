/**
 * Which agents an authenticated owner has, resolved ONLY from the owner's
 * verified tenant — never from an address, slug or id a caller supplies.
 *
 * A tenant (the owner's sign-in address) has at most one Merryman today: one
 * identity row (slug, account history) and one grant (current smart account).
 * The directory still returns a list so the MCP surface does not change when
 * owners can run several.
 *
 * The grant is read through a projection of its non-secret JSON fields. The
 * grant store's own get() decrypts the session key, and nothing here needs it.
 */
import { getIdentityStore } from "@merrymen/identity-store";
import type { Db } from "../../../worker/src/db";
import { mcpDb } from "./db";

export interface GrantCapsView {
  perTradeUsdg: number | null;
  dailyUsdg: number | null;
  expiryDays: number | null;
  maxDrawdownPct: number | null;
  maxOpsPerDay: number | null;
}

export interface OwnedAgent {
  slug: string;
  /** The ledger's agent_id: the current smart account, lowercased. Null before the first signed grant. */
  account: `0x${string}` | null;
  /**
   * The same account spelled EXACTLY as the grant stores it. The owner-order
   * queue (agent_commands) and its ferry match agent_id with `=`, not lower(),
   * so an order must be written under this spelling or it is never delivered.
   */
  orderAgentId: string | null;
  /** Every smart account this identity has held, newest first (older ledger rows live under these). */
  accounts: `0x${string}`[];
  chainId: number | null;
  grantedAt: number | null;
  expiresAt: number | null;
  caps: GrantCapsView | null;
  features: string[];
  /** Extra token addresses the signed grant covers (lowercase). */
  grantTokens: `0x${string}`[];
}

export interface AgentDirectory {
  agentsFor(tenant: `0x${string}`): Promise<OwnedAgent[]>;
}

const ADDRESS = /^0x[0-9a-f]{40}$/;
const num = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};
const addr = (v: unknown): `0x${string}` | null => {
  const s = typeof v === "string" ? v.toLowerCase() : "";
  return ADDRESS.test(s) ? (s as `0x${string}`) : null;
};

interface GrantProjection {
  chain_id: number | string | null;
  smart_account: string | null;
  granted_at: string | number | null;
  expires_at: string | number | null;
  caps: string | null;
  features: string | null;
  tokens: string | null;
}

/** Only these JSON paths are read from a grant; `serialized` and key fields never leave the database. */
export async function readGrantProjection(db: Db, tenant: `0x${string}`): Promise<GrantProjection | null> {
  try {
    return (await db.prepare(`SELECT chain_id,
        grant_json->>'smartAccount' AS smart_account,
        grant_json->>'grantedAt' AS granted_at,
        grant_json->>'expiresAt' AS expires_at,
        grant_json->>'caps' AS caps,
        grant_json->>'grantFeatures' AS features,
        grant_json->>'grantTokens' AS tokens
      FROM grants WHERE tenant = ?`).get(tenant) as GrantProjection | undefined) ?? null;
  } catch {
    // No grants table yet (a fresh database) is "no agent", not an outage.
    return null;
  }
}

function parseList(raw: string | null): unknown[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

function capsOf(raw: string | null): GrantCapsView | null {
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as Record<string, unknown>;
    return {
      perTradeUsdg: num(c.perTradeUsdg),
      dailyUsdg: num(c.dailyUsdg),
      expiryDays: num(c.expiryDays),
      maxDrawdownPct: num(c.maxDrawdownPct),
      maxOpsPerDay: num(c.maxOpsPerDay),
    };
  } catch {
    return null;
  }
}

export function agentFromParts(
  identity: { slug: string; accounts: string[] } | null,
  grant: GrantProjection | null,
): OwnedAgent | null {
  if (!identity) return null;
  const current = addr(grant?.smart_account);
  const history = identity.accounts.map(addr).filter((a): a is `0x${string}` => !!a);
  const accounts = current ? [current, ...history.filter((a) => a !== current)] : history;
  const raw = typeof grant?.smart_account === "string" && ADDRESS.test(grant.smart_account.toLowerCase()) ? grant.smart_account : null;
  return {
    slug: identity.slug,
    account: current,
    orderAgentId: raw,
    accounts,
    chainId: num(grant?.chain_id),
    grantedAt: num(grant?.granted_at),
    expiresAt: num(grant?.expires_at),
    caps: capsOf(grant?.caps ?? null),
    features: parseList(grant?.features ?? null).filter((f): f is string => typeof f === "string").slice(0, 32),
    grantTokens: parseList(grant?.tokens ?? null).map(addr).filter((a): a is `0x${string}` => !!a).slice(0, 64),
  };
}

export const hostedAgentDirectory: AgentDirectory = {
  async agentsFor(tenant) {
    const t = tenant.toLowerCase() as `0x${string}`;
    const identity = await getIdentityStore().get(t);
    if (!identity || identity.tenant.toLowerCase() !== t) return [];
    const { db } = await mcpDb();
    const agent = agentFromParts(identity, await readGrantProjection(db, t));
    return agent ? [agent] : [];
  },
};

let directory: AgentDirectory = hostedAgentDirectory;
export function agentDirectory(): AgentDirectory {
  return directory;
}
export function setAgentDirectoryForTest(d: AgentDirectory | null): void {
  directory = d ?? hostedAgentDirectory;
}
