/**
 * WHO AN AGENT IS IN PUBLIC.
 *
 * Two questions, one record, because they share a key and would otherwise be
 * two stores that must never disagree:
 *
 *   1. What does a link point at? `/a/<slug>` needs a stable public id, and
 *      before this there was none — PublicThesis deliberately omits agent_id,
 *      and the feed page hashes the agent's NAME for its avatar colour because
 *      the route has nothing else to send. There was literally nothing a follow
 *      could target — which is why this exists. The edge itself lives in
 *      follow-store.ts, keyed on the TENANT for the same reason this table is:
 *      a re-grant mints a new account, and an edge on the account would dangle
 *      every time somebody re-signed.
 *
 *   2. Which social account signed in? (Privy.) That half is declared here and
 *      wired later; it lives in this record because a DID resolves to a TENANT,
 *      and the tenant is already this table's key.
 *
 * KEYED ON THE TENANT, NOT THE SMART ACCOUNT. This is the whole design. A
 * re-grant mints a NEW smart account — agent-for.ts:33-37 — so anything derived
 * from the account changes when an owner re-signs, and a follow edge pointing at
 * the old value dangles with no way to discover the two are the same agent. The
 * tenant is the one identifier that survives, which is why both existing stores
 * key on it too.
 *
 * `accounts` carries the history so a PUBLIC route can resolve slug → the
 * ledger rows that belong to this agent without touching the grant store, which
 * requires the DEK and decrypts a session key. A public page must never need
 * that.
 *
 * THE SLUG IS RANDOM, NOT DERIVED. Every derivation was considered and every
 * one fails:
 *
 *   - the smart account: changes on re-grant, and it IS an address, so
 *     thesis-policy's ADDRESSY backstop would drop any thesis containing it —
 *     publishing it in the same payload contradicts itself.
 *   - an HMAC of the smart account: still a function of the account, so it
 *     still changes on re-grant. It fails SILENTLY: the old slug 404s and every
 *     edge dangles. It would also bind the public namespace to the session
 *     secret, so rotating that secret renames every agent on the site.
 *   - the x_handle: store.ts forbids it categorically — "DISPLAY METADATA,
 *     NEVER AN AUTHORIZATION KEY … deliberately not unique and deliberately not
 *     indexed". A follow target decides whose words enter another agent's
 *     prompt, which is authorization-adjacent.
 *   - the name: editable, so the slug either drifts or freezes at day one's
 *     name, and two agents called "Much" become `much` and `much-2`, where the
 *     difference is a digit nobody reads.
 *
 * NOT SEALED. Both sibling stores call requireDek() in their Postgres
 * constructor because they hold a session key and a bot token. A public id and
 * a handle the owner chose to publish are not secrets, and sealing them would
 * mean a public page could not be rendered without the key that decrypts money.
 * That omission is deliberate; do not "fix" it.
 *
 * NODE-ONLY (node:crypto, node:fs, pg). Imported by the web API and the worker,
 * never the browser bundle.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { merrymenHome } from "./home";

/**
 * Crockford base32, lowercased: no i, l, o or u, so a slug read aloud or
 * retyped from a screenshot cannot become a different agent.
 */
const ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

/** 80 bits — exactly 16 characters, no padding, no partial group. */
export const SLUG_BYTES = 10;
export const SLUG_LENGTH = 16;

/**
 * The shape every public surface validates against BEFORE touching a database.
 * An unauthenticated caller can ask for any slug it likes, and a regex test is
 * a great deal cheaper than a query.
 */
export const SLUG_RE = /^[0-9a-hjkmnp-tv-z]{16}$/;

/** A fresh public id. Random, never derived — see the header. */
export function mintSlug(): string {
  const b = randomBytes(SLUG_BYTES);
  let bits = 0;
  let acc = 0;
  let out = "";
  for (const byte of b) {
    acc = (acc << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(acc >> bits) & 31];
    }
  }
  return out;
}

export type IdentityProvider = "twitter" | "google";

/** The verified social identity, when there is one. Display, never authorization. */
export interface SocialIdentity {
  did: string;
  provider: IdentityProvider;
  /**
   * The provider's own immutable user id. UNIQUENESS LIVES HERE, not on the
   * handle: a handle is reassignable, so making it the identity would hand a
   * released @name the previous owner's agent.
   */
  subject: string;
  handle?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
}

export interface PublicIdentity {
  tenant: `0x${string}`;
  /** Minted once, never re-minted, never derived. Links depend on it. */
  slug: string;
  /** Every smart account this tenant has held, newest first. */
  accounts: `0x${string}`[];
  social?: SocialIdentity | null;
  createdAt: number;
  updatedAt: number;
}

export interface IdentityStore {
  /**
   * Mint-if-absent, and record `account` as this tenant's current one.
   *
   * Idempotent, and it MUST NOT change an existing slug — every published link
   * and every follow edge depends on that. Calling it on a re-grant appends the
   * new account and leaves the slug alone.
   */
  ensure(tenant: `0x${string}`, account: `0x${string}`): Promise<PublicIdentity>;
  get(tenant: `0x${string}`): Promise<PublicIdentity | null>;
  bySlug(slug: string): Promise<PublicIdentity | null>;
  /** Resolve a social login to the tenant that claimed it. */
  byDid(did: string): Promise<PublicIdentity | null>;
  /**
   * Bind a social account to a tenant. FIRST CLAIM WINS: false when the DID is
   * already bound to a DIFFERENT tenant. Re-linking the same pair is a no-op
   * that returns true.
   */
  linkSocial(tenant: `0x${string}`, social: SocialIdentity): Promise<boolean>;
  /** Every identity. Fleet-sized, and read by public routes to build slug maps. */
  all(): Promise<PublicIdentity[]>;
  remove(tenant: `0x${string}`): Promise<void>;
}

const now = () => Math.floor(Date.now() / 1000);

/** Newest first, no duplicates, case-normalised. */
function withAccount(accounts: `0x${string}`[], account: `0x${string}`): `0x${string}`[] {
  const a = account.toLowerCase() as `0x${string}`;
  return [a, ...accounts.filter((x) => x.toLowerCase() !== a)];
}

// ── file backend ─────────────────────────────────────────────────────────────

export class FileIdentityStore implements IdentityStore {
  private dir = path.join(merrymenHome(), "agent-identity");
  private file(tenant: string) {
    return path.join(this.dir, `${tenant.toLowerCase()}.json`);
  }
  private async write(rec: PublicIdentity): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.file(rec.tenant), JSON.stringify(rec, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
  }
  async get(tenant: `0x${string}`): Promise<PublicIdentity | null> {
    try {
      return JSON.parse(await readFile(this.file(tenant), "utf8")) as PublicIdentity;
    } catch {
      return null;
    }
  }
  async ensure(tenant: `0x${string}`, account: `0x${string}`): Promise<PublicIdentity> {
    const existing = await this.get(tenant);
    const rec: PublicIdentity = existing
      ? { ...existing, accounts: withAccount(existing.accounts, account), updatedAt: now() }
      : {
          tenant: tenant.toLowerCase() as `0x${string}`,
          slug: mintSlug(),
          accounts: [account.toLowerCase() as `0x${string}`],
          social: null,
          createdAt: now(),
          updatedAt: now(),
        };
    await this.write(rec);
    return rec;
  }
  async all(): Promise<PublicIdentity[]> {
    try {
      const files = (await readdir(this.dir)).filter((f) => f.endsWith(".json"));
      const out: PublicIdentity[] = [];
      for (const f of files) {
        try {
          out.push(JSON.parse(await readFile(path.join(this.dir, f), "utf8")) as PublicIdentity);
        } catch {
          // One unreadable file is one missing agent, not an unreadable fleet.
        }
      }
      return out;
    } catch {
      return [];
    }
  }
  async bySlug(slug: string): Promise<PublicIdentity | null> {
    if (!SLUG_RE.test(slug)) return null;
    return (await this.all()).find((r) => r.slug === slug) ?? null;
  }
  async byDid(did: string): Promise<PublicIdentity | null> {
    return (await this.all()).find((r) => r.social?.did === did) ?? null;
  }
  async linkSocial(tenant: `0x${string}`, social: SocialIdentity): Promise<boolean> {
    const holder = await this.byDid(social.did);
    if (holder && holder.tenant.toLowerCase() !== tenant.toLowerCase()) return false;
    const rec = await this.get(tenant);
    if (!rec) return false;
    await this.write({ ...rec, social, updatedAt: now() });
    return true;
  }
  async remove(tenant: `0x${string}`): Promise<void> {
    await rm(this.file(tenant), { force: true });
  }
}

// ── postgres backend ─────────────────────────────────────────────────────────

interface PgClientLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

interface Row {
  tenant: string;
  slug: string;
  accounts: unknown;
  privy_did: string | null;
  provider: string | null;
  subject: string | null;
  handle: string | null;
  display_name: string | null;
  avatar_url: string | null;
  created_at: string | number;
  updated_at: string | number;
}

function fromRow(r: Row): PublicIdentity {
  const accounts = Array.isArray(r.accounts)
    ? (r.accounts as `0x${string}`[])
    : typeof r.accounts === "string"
      ? (JSON.parse(r.accounts) as `0x${string}`[])
      : [];
  return {
    tenant: r.tenant as `0x${string}`,
    slug: r.slug,
    accounts,
    social: r.privy_did
      ? {
          did: r.privy_did,
          provider: r.provider as IdentityProvider,
          subject: String(r.subject ?? ""),
          handle: r.handle,
          displayName: r.display_name,
          avatarUrl: r.avatar_url,
        }
      : null,
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}

/**
 * Postgres backend for the hosted deploy. `pg` is imported at RUNTIME only
 * (webpackIgnore) so the file backend builds with it absent — same dance as the
 * grant and settings stores.
 *
 * NO requireDek(). See the header: nothing in this record is a secret, and
 * needing the money key to render a public page would be the wrong dependency.
 */
export class PgIdentityStore implements IdentityStore {
  private ready: Promise<PgClientLike> | null = null;
  constructor(private url: string) {}
  private async client(): Promise<PgClientLike> {
    if (!this.ready) {
      this.ready = (async () => {
        // @ts-expect-error pg has no types here (runtime-only); webpackIgnore stops the bundler resolving it
        const pg = (await import(/* webpackIgnore: true */ "pg")) as unknown as {
          Client: new (c: { connectionString: string }) => PgClientLike & { connect(): Promise<void> };
        };
        const c = new pg.Client({ connectionString: this.url });
        await c.connect();
        await c.query(
          `CREATE TABLE IF NOT EXISTS agent_identity (
             tenant TEXT PRIMARY KEY,
             slug TEXT NOT NULL UNIQUE,
             accounts JSONB NOT NULL DEFAULT '[]'::jsonb,
             privy_did TEXT UNIQUE,
             provider TEXT,
             subject TEXT,
             handle TEXT,
             display_name TEXT,
             avatar_url TEXT,
             created_at BIGINT NOT NULL,
             updated_at BIGINT NOT NULL
           )`,
        );
        await c.query(`CREATE INDEX IF NOT EXISTS agent_identity_slug ON agent_identity (slug)`);
        // Uniqueness on the PROVIDER'S OWN id, never on the handle — a handle
        // can be released and re-registered by somebody else.
        await c.query(
          `CREATE UNIQUE INDEX IF NOT EXISTS agent_identity_subject
             ON agent_identity (provider, subject) WHERE provider IS NOT NULL`,
        );
        return c;
      })();
    }
    return this.ready;
  }
  async get(tenant: `0x${string}`): Promise<PublicIdentity | null> {
    const c = await this.client();
    const { rows } = await c.query(`SELECT * FROM agent_identity WHERE tenant = $1`, [
      tenant.toLowerCase(),
    ]);
    return rows[0] ? fromRow(rows[0] as unknown as Row) : null;
  }
  async ensure(tenant: `0x${string}`, account: `0x${string}`): Promise<PublicIdentity> {
    const c = await this.client();
    const t = tenant.toLowerCase();
    const existing = await this.get(tenant);
    if (existing) {
      const accounts = withAccount(existing.accounts, account);
      await c.query(`UPDATE agent_identity SET accounts = $2, updated_at = $3 WHERE tenant = $1`, [
        t,
        JSON.stringify(accounts),
        now(),
      ]);
      return { ...existing, accounts, updatedAt: now() };
    }
    // A slug collision at 80 bits is theoretical, but a retry turns a 500 into
    // a no-op and costs nothing on the path that never collides.
    for (let attempt = 0; attempt < 3; attempt++) {
      const slug = mintSlug();
      try {
        const { rows } = await c.query(
          `INSERT INTO agent_identity (tenant, slug, accounts, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $4)
           ON CONFLICT (tenant) DO UPDATE SET accounts = EXCLUDED.accounts, updated_at = EXCLUDED.updated_at
           RETURNING *`,
          [t, slug, JSON.stringify([account.toLowerCase()]), now()],
        );
        if (rows[0]) return fromRow(rows[0] as unknown as Row);
      } catch (e) {
        if (attempt === 2) throw e;
      }
    }
    throw new Error("could not mint a public id");
  }
  async all(): Promise<PublicIdentity[]> {
    const c = await this.client();
    const { rows } = await c.query(`SELECT * FROM agent_identity`);
    return rows.map((r) => fromRow(r as unknown as Row));
  }
  async bySlug(slug: string): Promise<PublicIdentity | null> {
    if (!SLUG_RE.test(slug)) return null;
    const c = await this.client();
    const { rows } = await c.query(`SELECT * FROM agent_identity WHERE slug = $1`, [slug]);
    return rows[0] ? fromRow(rows[0] as unknown as Row) : null;
  }
  async byDid(did: string): Promise<PublicIdentity | null> {
    const c = await this.client();
    const { rows } = await c.query(`SELECT * FROM agent_identity WHERE privy_did = $1`, [did]);
    return rows[0] ? fromRow(rows[0] as unknown as Row) : null;
  }
  async linkSocial(tenant: `0x${string}`, social: SocialIdentity): Promise<boolean> {
    const holder = await this.byDid(social.did);
    if (holder && holder.tenant.toLowerCase() !== tenant.toLowerCase()) return false;
    const c = await this.client();
    const { rowCount } = await c.query(
      `UPDATE agent_identity
          SET privy_did = $2, provider = $3, subject = $4, handle = $5,
              display_name = $6, avatar_url = $7, updated_at = $8
        WHERE tenant = $1`,
      [
        tenant.toLowerCase(),
        social.did,
        social.provider,
        social.subject,
        social.handle ?? null,
        social.displayName ?? null,
        social.avatarUrl ?? null,
        now(),
      ],
    );
    return (rowCount ?? 0) > 0;
  }
  async remove(tenant: `0x${string}`): Promise<void> {
    const c = await this.client();
    await c.query(`DELETE FROM agent_identity WHERE tenant = $1`, [tenant.toLowerCase()]);
  }
}

let cached: IdentityStore | null = null;
export function getIdentityStore(): IdentityStore {
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  cached = url ? new PgIdentityStore(url) : new FileIdentityStore();
  return cached;
}

/** Test seam: drop the cached store so a test can change the environment. */
export function resetIdentityStoreForTest(): void {
  cached = null;
}
