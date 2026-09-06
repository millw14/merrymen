/**
 * AN ACCOUNT BELONGS TO ONE IDENTITY, EVER.
 *
 * Every per-agent ledger table keys on `smart_account` — trades, equity, flows,
 * positions, cost basis, decisions. So two identities holding one account do not
 * merely disagree about a label; they write into one partition, and neither
 * one's history means anything afterward. The identity store had no constraint
 * behind that at all: the check was a read of `tenantForAccount` and a write
 * thirty lines later, which holds only while nothing runs concurrently.
 *
 * WHY A CLAIM TABLE AND NOT A UNIQUE INDEX ON THE CURRENT ACCOUNT.
 * `agent_identity.accounts` is deliberately a HISTORY: a re-grant mints a new
 * account, appends it, and keeps the slug so every published link and follow
 * edge survives. A unique index over "the newest entry" would leave an address
 * sitting in someone's history claimable by a different tenant — and the ledger
 * rows under that address are permanent, so a later claim silently inherits
 * somebody else's trades. The claim is therefore over EVERY account any
 * identity has ever held, which is the invariant the ledger already assumes.
 *
 * FAIL CLOSED, NEVER REASSIGN. A backfill that finds one address claimed by two
 * tenants does not pick the older row, the bigger book, or the first it read.
 * Which of two people owns an agent is not a question a migration is allowed to
 * answer. It refuses, says which address and which tenants, and leaves both
 * rows exactly as they were.
 *
 * PURE. Handed candidate claims, returns a verdict. The SQL that applies it
 * lives in identity-store.ts; this is the part that decides.
 */

/** One (account, tenant) pair, from wherever it was observed. */
export interface AccountClaim {
  account: string;
  tenant: string;
  /** Where this pair was read from, so a conflict names its sources. */
  source: "identity-history" | "installed-grant" | "existing-claim";
}

export interface ClaimConflict {
  account: string;
  tenants: string[];
  sources: string[];
}

export type ClaimPlan =
  | { ok: true; insert: { account: string; tenant: string }[]; alreadyHeld: number }
  | { ok: false; conflicts: ClaimConflict[]; why: string };

const norm = (s: string) => s.trim().toLowerCase();

/**
 * Reduce every observed claim to the set that should exist, or refuse.
 *
 * IDEMPOTENT BY CONSTRUCTION. The same account mapping to the same tenant twice
 * — which is the normal case, since an installed grant's account is also in its
 * identity's history — collapses to one entry, and an account already recorded
 * in `existing` is counted rather than re-inserted. Running this against a
 * database it has already been applied to produces an empty insert list.
 */
export function planClaims(observed: readonly AccountClaim[], existing: readonly AccountClaim[]): ClaimPlan {
  const byAccount = new Map<string, Map<string, Set<string>>>();
  for (const c of [...existing, ...observed]) {
    const account = norm(c.account);
    const tenant = norm(c.tenant);
    // A malformed or empty pair is not a claim. Counting it would invent a
    // conflict on the empty string, which is the shape a half-written row
    // leaves behind rather than a real dispute between two people.
    if (!account || !tenant) continue;
    const tenants = byAccount.get(account) ?? new Map<string, Set<string>>();
    const sources = tenants.get(tenant) ?? new Set<string>();
    sources.add(c.source);
    tenants.set(tenant, sources);
    byAccount.set(account, tenants);
  }

  const conflicts: ClaimConflict[] = [];
  for (const [account, tenants] of byAccount) {
    if (tenants.size > 1) {
      conflicts.push({
        account,
        tenants: [...tenants.keys()].sort(),
        sources: [...new Set([...tenants.values()].flatMap((s) => [...s]))].sort(),
      });
    }
  }
  if (conflicts.length > 0) {
    return {
      ok: false,
      conflicts,
      why:
        `${conflicts.length} smart account(s) are claimed by more than one tenant. ` +
        "Nothing was written. Which of two identities owns an agent is not a question a " +
        "migration may answer, so this refuses rather than picking one.",
    };
  }

  const held = new Set(existing.map((c) => norm(c.account)).filter(Boolean));
  const insert: { account: string; tenant: string }[] = [];
  for (const [account, tenants] of byAccount) {
    if (held.has(account)) continue;
    const tenant = [...tenants.keys()][0]!;
    insert.push({ account, tenant });
  }
  // Deterministic order, so a replayed backfill writes the same rows in the
  // same sequence and two replicas racing it deadlock-free.
  insert.sort((a, b) => (a.account < b.account ? -1 : a.account > b.account ? 1 : 0));
  return { ok: true, insert, alreadyHeld: held.size };
}

/**
 * Is this social identity well-formed enough to be an identity at all?
 *
 * REJECTED AT THE BOUNDARY, NOT BY THE INDEX. A partial unique index written
 * `WHERE provider IS NOT NULL` does not exclude the empty string — Postgres
 * indexes `''` like any other value — so two rows carrying it collide under a
 * constraint that looks as though it tolerates missing data. Widening the index
 * until the malformed value fits would be solving the wrong problem: an empty
 * provider id is not a valid identity, whoever sent it.
 *
 * NO CASE FOLDING. A Privy DID and a provider's user id are opaque strings
 * whose issuer defines their equality, and neither Privy nor X documents them
 * as case-insensitive. Lowercasing them here would silently merge two distinct
 * identities — the one direction that is never recoverable — so they are
 * trimmed and otherwise left exactly as issued. Addresses are different and are
 * lowercased everywhere, because the chain says they are case-insensitive.
 */
export function socialIdentityProblem(social: {
  did: string;
  provider: string;
  subject: string;
}): string | null {
  if (social.did.trim() === "") return "the social identity has no DID";
  if (social.provider.trim() === "") return "the social identity has no provider";
  if (social.subject.trim() === "") return "the social identity has no provider user id";
  return null;
}
