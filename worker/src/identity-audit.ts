/**
 * IS THE IDENTITY TABLE ALREADY CLEAN ENOUGH TO CONSTRAIN?
 *
 * `agent_identity` is about to gain uniqueness it has never had. Adding a
 * UNIQUE index to a table that already violates it does not fail safely — it
 * fails at CREATE INDEX, in the store's own lazy bootstrap, which every read
 * path awaits. So a duplicate that exists today would not surface as a
 * migration error; it would surface as the public routes going dark.
 *
 * This is the read that has to happen first. It NEVER WRITES and it never
 * proposes a fix: two rows claiming one smart account is a question about which
 * human owns an agent, and the answer is not something a migration gets to
 * decide by picking the older row. It reports, and a person decides.
 *
 * THE RELATIONSHIPS THAT MUST BE ONE-TO-ONE, and why each one:
 *
 *   privy_did → tenant        one login, one Merryman. Without it, logging out
 *                             and back in can land on a second agent.
 *   (provider, subject)       the provider's own immutable user id. The handle
 *                             is reassignable and must never be the key —
 *                             identity-store.ts:104-109 says so.
 *   smart_account → tenant    every ledger table keys on smart_account, so two
 *                             tenants holding one account write into one
 *                             partition. This is the one with no constraint
 *                             behind it today.
 *
 * `accounts` IS DELIBERATELY A HISTORY and stays one: a re-grant mints a new
 * account and appends it, and the slug — with every published link and follow
 * edge pointing at it — must survive that. So uniqueness is asked of the
 * CURRENT account, and the history is only checked for cross-row overlap, which
 * would mean two identities disagreeing about who once held an address.
 *
 * PURE. Handed rows, returns strings.
 */

export interface IdentityRowLite {
  tenant: string;
  slug: string;
  /** Newest first, as the store writes it. */
  accounts: string[];
  privyDid: string | null;
  provider: string | null;
  subject: string | null;
}

/** One tenant's currently-installed grant, as the grant store holds it. */
export interface GrantClaimLite {
  tenant: string;
  smartAccount: string;
}

const lc = (s: string) => s.trim().toLowerCase();

/** Keys held by more than one tenant, with the tenants that hold them. */
function collisions(pairs: { key: string; tenant: string }[]): Map<string, string[]> {
  const by = new Map<string, Set<string>>();
  for (const p of pairs) {
    if (!p.key) continue;
    const set = by.get(p.key) ?? new Set<string>();
    set.add(p.tenant);
    by.set(p.key, set);
  }
  const out = new Map<string, string[]>();
  for (const [k, tenants] of by) if (tenants.size > 1) out.set(k, [...tenants].sort());
  return out;
}

export interface IdentityAudit {
  lines: string[];
  /** True only when every one-to-one relationship already holds. */
  safeToConstrain: boolean;
}

export function auditIdentity(rows: IdentityRowLite[], claims: GrantClaimLite[]): IdentityAudit {
  const lines: string[] = [];
  const tenants = new Set(rows.map((r) => lc(r.tenant)));

  lines.push(
    `${rows.length} identity row(s), ${tenants.size} distinct tenant(s), ${claims.length} installed grant(s)`,
  );

  // ── the current account, which is what a UNIQUE would cover ──────────────
  const current = collisions(
    rows
      .filter((r) => r.accounts.length > 0)
      .map((r) => ({ key: lc(r.accounts[0]!), tenant: lc(r.tenant) })),
  );
  // ── the whole history, which would mean a deeper disagreement ────────────
  const historical = collisions(
    rows.flatMap((r) => r.accounts.map((a) => ({ key: lc(a), tenant: lc(r.tenant) }))),
  );
  const dids = collisions(
    rows.filter((r) => r.privyDid).map((r) => ({ key: lc(r.privyDid!), tenant: lc(r.tenant) })),
  );
  const subjects = collisions(
    rows
      .filter((r) => r.provider && r.subject)
      .map((r) => ({ key: `${lc(r.provider!)}/${lc(r.subject!)}`, tenant: lc(r.tenant) })),
  );
  const claimed = collisions(claims.map((c) => ({ key: lc(c.smartAccount), tenant: lc(c.tenant) })));

  const report = (label: string, found: Map<string, string[]>) => {
    if (found.size === 0) {
      lines.push(`${label.padEnd(22)} clean`);
      return;
    }
    lines.push(`${label.padEnd(22)} ${found.size} COLLISION(S) — nothing was changed`);
    for (const [key, holders] of found) lines.push(`  ${key} held by ${holders.join(" and ")}`);
  };

  report("current account", current);
  report("account history", historical);
  report("privy did", dids);
  report("provider+subject", subjects);
  report("installed grants", claimed);

  // A grant whose account the identity row does not list at all means the two
  // stores disagree about what this tenant holds. Not a uniqueness violation,
  // but it is the shape a half-finished write leaves behind, and a constraint
  // added over it would freeze the disagreement in place.
  const byTenant = new Map(rows.map((r) => [lc(r.tenant), r]));
  const drifted: string[] = [];
  for (const c of claims) {
    const row = byTenant.get(lc(c.tenant));
    if (!row) {
      drifted.push(`${lc(c.tenant)} has a grant but no identity row`);
      continue;
    }
    if (!row.accounts.map(lc).includes(lc(c.smartAccount))) {
      drifted.push(`${lc(c.tenant)} holds ${lc(c.smartAccount)}, which its identity row does not list`);
    }
  }
  if (drifted.length === 0) lines.push(`${"store agreement".padEnd(22)} clean`);
  else {
    lines.push(`${"store agreement".padEnd(22)} ${drifted.length} DISAGREEMENT(S)`);
    for (const d of drifted) lines.push(`  ${d}`);
  }

  const safeToConstrain =
    current.size === 0 && historical.size === 0 && dids.size === 0 && subjects.size === 0 && claimed.size === 0;

  lines.push(
    safeToConstrain
      ? "VERDICT: every one-to-one relationship already holds — a UNIQUE index would apply cleanly"
      : "VERDICT: DO NOT ADD THE CONSTRAINT. Resolve the collisions above by hand first; " +
          "deduplicating them automatically would pick an owner for an agent, which is not a migration's call",
  );
  return { lines, safeToConstrain };
}
