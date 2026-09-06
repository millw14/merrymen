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

import { UNDERIVED_ADDRESS } from "../../packages/core/src/index";

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
  /**
   * The key the account derives from. Read because two questions can only be
   * answered from it, and both are about grants that already exist:
   * whether any account was sealed at the zero address, and whether any owner
   * is also its own tenant. See the residue section below.
   */
  owner?: string | null;
  /**
   * The `binding.version` this grant was PERSISTED with, if any.
   *
   * Read because the version field is new and the table is old: every grant
   * written before it existed carries none, and anything else that turns up
   * here was written by a client we did not ship. Both are facts worth having
   * before the dispatch starts refusing on it.
   */
  bindingVersion?: string | null;
}

/** Addresses are case-insensitive; the chain says so and every store lowercases. */
const lc = (s: string) => s.trim().toLowerCase();

/**
 * A DID and a provider subject are NOT case-insensitive.
 *
 * The indexes that will actually enforce these are plain `UNIQUE` over `text`,
 * which is case-SENSITIVE. Folding case here would report two legitimately
 * distinct identifiers as one collision and block a constraint that would have
 * applied cleanly — an audit that is stricter than the index it is checking is
 * just as wrong as one that is laxer.
 */
const exact = (s: string) => s.trim();

/**
 * A one-way fingerprint, for keys that must be COUNTED in a log but not READ.
 *
 * A Privy DID printed next to a tenant address joins a person's social login to
 * their on-chain identity, in a log the whole fleet writes to. The audit's job
 * is to say THAT two tenants collide and WHICH tenants they are — the tenant
 * addresses are already public and already logged. The identifier itself is not
 * needed to act on the finding, so it does not get printed.
 *
 * Not a secret-strength hash and not trying to be: it exists so two lines about
 * the same DID are recognisably about the same DID.
 */
function fingerprint(value: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `#${h.toString(16).padStart(8, "0")}`;
}

/** Keys held by more than one tenant, with the tenants that hold them. */
function collisions(pairs: { key: string; tenant: string }[]): Map<string, string[]> {
  const by = new Map<string, Set<string>>();
  for (const p of pairs) {
    // NO TRUTHINESS SKIP. An empty string is a value Postgres indexes like any
    // other, so two rows carrying one would violate a UNIQUE index while a
    // `if (!p.key) continue` here quietly blessed them. Deciding what counts as
    // ABSENT belongs to each caller, which knows the difference between a NULL
    // column and a present-but-empty one; this function only counts keys.
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
  /**
   * THE WHOLE ANSWER ON ONE LINE.
   *
   * The first run of this audit printed twelve lines into an orchestrator whose
   * twenty-two children write about five hundred lines every three minutes, and
   * eleven of them were dropped before they reached the log store. A report that
   * survives partially is worse than one that does not print at all: the line
   * that did arrive said "22 identity rows" and looked like a clean result.
   *
   * So every count the rollout decision depends on is also emitted as ONE
   * record, which either arrives whole or not at all.
   */
  summary: string;
  /** True only when every one-to-one relationship already holds. */
  safeToConstrain: boolean;
  /** Accounts already sealed at 0x0 by the bug the mint-time guard now stops. */
  zeroAddressResidue: number;
  /** Grants whose owner key is also their login wallet. See the residue section. */
  sameKeyOwners: number;
  /** Identity keys that are present but empty — malformed input, not absence. */
  emptyIdentityKeys: number;
  /** Persisted binding versions the dispatch would refuse. */
  unknownBindingVersions: number;
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
    rows.filter((r) => r.privyDid).map((r) => ({ key: exact(r.privyDid!), tenant: lc(r.tenant) })),
  );
  const subjects = collisions(
    rows
      .filter((r) => r.provider && r.subject)
      .map((r) => ({ key: `${exact(r.provider!)}/${exact(r.subject!)}`, tenant: lc(r.tenant) })),
  );
  // AN EMPTY STRING IS A VALUE, NOT AN ABSENCE. Postgres indexes lower('') like
  // any other key, so two grants carrying an empty smartAccount would collide
  // under the constraint — while a JS truthiness filter drops them and the
  // audit blesses a table the index will reject.
  const claimed = collisions(
    claims
      .filter((c) => c.smartAccount !== null && c.smartAccount !== undefined)
      .map((c) => ({ key: lc(c.smartAccount), tenant: lc(c.tenant) })),
  );

  const report = (label: string, found: Map<string, string[]>, hide = false) => {
    if (found.size === 0) {
      lines.push(`${label.padEnd(22)} clean`);
      return;
    }
    lines.push(`${label.padEnd(22)} ${found.size} COLLISION(S) — nothing was changed`);
    for (const [key, holders] of found) {
      lines.push(`  ${hide ? fingerprint(key) : key} held by ${holders.join(" and ")}`);
    }
  };

  report("current account", current);
  report("account history", historical);
  // Fingerprinted: a DID beside a tenant address joins a social login to an
  // on-chain identity, and the fleet's logs are not the place for that join.
  report("privy did", dids, true);
  report("provider+subject", subjects, true);
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

  // ── RESIDUE: did the bug this PR fixes already happen? ───────────────────
  //
  // The guard is mint-time. It stops a NEW grant being sealed at the zero
  // address; it says nothing about whether an old one already was. That is the
  // question a read of production exists to answer, and it would be strange to
  // ship the audit without asking it.
  const zeroed: string[] = [];
  for (const r of rows) {
    for (const a of r.accounts) {
      if (lc(a) === UNDERIVED_ADDRESS) zeroed.push(`${lc(r.tenant)} lists the zero address in its history`);
    }
  }
  for (const c of claims) {
    if (lc(c.smartAccount) === UNDERIVED_ADDRESS) {
      zeroed.push(`${lc(c.tenant)} has an INSTALLED GRANT on the zero address`);
    }
  }
  lines.push(
    zeroed.length === 0
      ? `${"zero-address residue".padEnd(22)} none — no account was ever sealed at 0x0`
      : `${"zero-address residue".padEnd(22)} ${zeroed.length} FOUND`,
  );
  for (const z of zeroed) lines.push(`  ${z}`);

  // ── RESIDUE: is anyone using their login wallet as the owner key? ────────
  //
  // `restoreAgentWallet` accepts any 64-hex key, so a user could have pasted
  // the private key of the wallet they sign in with. The legacy binding arm now
  // refuses a claim whose two signatures come from one key, which would bar
  // exactly those users from re-arming. Whether that population is EMPTY is a
  // fact about production, not something to believe — so count it here rather
  // than assert it in a comment.
  const sameKey = claims
    .filter((c) => c.owner && lc(c.owner) === lc(c.tenant))
    .map((c) => `${lc(c.tenant)} owns its account with its own login key`);
  const ownersKnown = claims.filter((c) => c.owner).length;
  lines.push(
    ownersKnown === 0
      ? `${"owner is tenant".padEnd(22)} not checked — no grant exposed an owner`
      : sameKey.length === 0
        ? `${"owner is tenant".padEnd(22)} none of ${ownersKnown} — every owner key is separate from its login`
        : `${"owner is tenant".padEnd(22)} ${sameKey.length} of ${ownersKnown} FOUND — these cannot re-arm`,
  );
  for (const s of sameKey) lines.push(`  ${s}`);

  // ── CENSUS: identity keys that are present but empty ─────────────────────
  //
  // An empty string is not an absence. A partial index (`WHERE provider IS NOT
  // NULL`) does not exclude it, so two rows carrying `''` collide under a
  // constraint that looks like it tolerates missing values — and an empty
  // identifier is malformed input either way. Counted here so the fix is
  // "reject it at the boundary", not "widen the index until it fits".
  const emptyKeys: string[] = [];
  for (const r of rows) {
    if (r.privyDid !== null && exact(r.privyDid) === "") emptyKeys.push(`${lc(r.tenant)} has an empty privy_did`);
    if (r.provider !== null && exact(r.provider) === "") emptyKeys.push(`${lc(r.tenant)} has an empty provider`);
    if (r.subject !== null && exact(r.subject) === "") emptyKeys.push(`${lc(r.tenant)} has an empty subject`);
    if (r.accounts.some((a) => lc(a) === "")) emptyKeys.push(`${lc(r.tenant)} lists an empty account`);
    if (exact(r.slug) === "") emptyKeys.push(`${lc(r.tenant)} has an empty slug`);
  }
  for (const c of claims) {
    if (lc(c.smartAccount) === "") emptyKeys.push(`${lc(c.tenant)} has a grant with an empty smart account`);
  }
  lines.push(
    emptyKeys.length === 0
      ? `${"empty identity keys".padEnd(22)} none`
      : `${"empty identity keys".padEnd(22)} ${emptyKeys.length} FOUND — reject these at the boundary, not in the index`,
  );
  for (const e of emptyKeys) lines.push(`  ${e}`);

  // ── CENSUS: binding versions already on disk ─────────────────────────────
  //
  // The dispatch refuses a version it does not recognise. Before it can do that
  // safely we need to know what is actually stored: absent is expected and
  // legacy by construction, `legacy-wallet-owner-v1` is expected, and anything
  // else was written by a client we did not ship.
  const versions = new Map<string, number>();
  for (const c of claims) {
    const v = c.bindingVersion === null || c.bindingVersion === undefined ? "(absent)" : exact(c.bindingVersion);
    versions.set(v, (versions.get(v) ?? 0) + 1);
  }
  const KNOWN = new Set(["(absent)", "legacy-wallet-owner-v1", "privy-did-owner-v1"]);
  const unknownVersions = [...versions].filter(([v]) => !KNOWN.has(v));
  lines.push(
    `${"binding versions".padEnd(22)} ` +
      ([...versions].map(([v, n]) => `${v} x${n}`).join(", ") || "no grants read") +
      (unknownVersions.length > 0 ? " — UNRECOGNISED PRESENT, these would be refused" : ""),
  );

  const safeToConstrain =
    current.size === 0 && historical.size === 0 && dids.size === 0 && subjects.size === 0 && claimed.size === 0;

  lines.push(
    safeToConstrain
      ? `VERDICT: every one-to-one relationship already holds — a UNIQUE index would apply cleanly` +
          (drifted.length > 0
            ? `, but ${drifted.length} store disagreement(s) above would be frozen in place by it. Read those first.`
            : "")
      : "VERDICT: DO NOT ADD THE CONSTRAINT. Resolve the collisions above by hand first; " +
          "deduplicating them automatically would pick an owner for an agent, which is not a migration's call",
  );
  const summary = [
    `rows=${rows.length}`,
    `tenants=${tenants.size}`,
    `grants=${claims.length}`,
    `dupCurrentAccount=${current.size}`,
    `dupAccountHistory=${historical.size}`,
    `dupPrivyDid=${dids.size}`,
    `dupProviderSubject=${subjects.size}`,
    `dupInstalledGrant=${claimed.size}`,
    `zeroAddressResidue=${zeroed.length}`,
    `ownerIsTenant=${sameKey.length}/${ownersKnown}`,
    `emptyIdentityKeys=${emptyKeys.length}`,
    `unknownBindingVersions=${unknownVersions.reduce((n, [, count]) => n + count, 0)}`,
    `storeDrift=${drifted.length}`,
    `safeToConstrain=${safeToConstrain}`,
  ].join(" ");

  return {
    lines,
    summary,
    safeToConstrain,
    zeroAddressResidue: zeroed.length,
    sameKeyOwners: sameKey.length,
    emptyIdentityKeys: emptyKeys.length,
    unknownBindingVersions: unknownVersions.reduce((n, [, count]) => n + count, 0),
  };
}
