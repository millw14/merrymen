/**
 * WHO READS WHOM.
 *
 * The follow graph: an owner wires their agent to another agent's published
 * thinking, and that agent's theses go into their own agent's next prompt. It is
 * the mechanism the whole product claim rests on, and until now it did not exist
 * in any form — no store, no route, no field, no tool. Four comments in this repo
 * described it in the present tense for three weeks.
 *
 * THE ASYMMETRY IS DELIBERATE, and it is the design decision here.
 *
 *   follower  = a TENANT   — a `0x` wallet address that signed in
 *   target    = a SLUG     — the random 16-char public id from identity-store
 *
 * A follow is an act by a signed-in OWNER on behalf of their agent, not an act
 * by an agent. That single choice keeps the edge out of the ledger entirely: the
 * ledger's every table keys on one `agent_id` partition, the mirror is
 * child→shared only, and a follow is a pair whose first element is not an
 * agent_id at all. It also makes `tenantOf` the rate limit, so no new limiter is
 * needed.
 *
 * Keyed on the TENANT rather than the smart account because a re-grant mints a
 * new account — the same reason identity-store is keyed that way, recorded there
 * at length. An edge that dangled on every re-grant would be worse than no edge.
 *
 * NO FOREIGN KEY to the identity store, deliberately. A follow of a slug that
 * later vanishes should dangle harmlessly and read as "nothing to fetch", not
 * fail a write or a read somewhere else. The composite primary key IS the
 * idempotence: following twice is one row.
 *
 * NO DEK. Unlike the grant and settings stores, none of this is secret — a slug
 * is a public id and the follower is an address that already appears on chain.
 * Sealing it would imply a confidentiality this data does not have.
 *
 * ONE THING THIS STORE MUST NEVER GROW. `followerCount` is the only value here a
 * Sybil can inflate, since a grantless tenant can follow anything. Display it if
 * you like; NEVER sort by it, and NEVER let an agent read it. The moment a
 * number here can move an agent's decision, minting wallets becomes a way to
 * move somebody else's money. store.ts:438-448 writes the same rule about
 * x_handle for the same reason.
 *
 * NODE-ONLY (node:fs, pg). Imported by the web API and the orchestrator, never
 * the browser bundle.
 */
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { merrymenHome } from "./home";

/**
 * How many agents one owner may wire in.
 *
 * A PROMPT HAS A CONTEXT WINDOW, which is the whole reason a cap exists here and
 * the reason the number is small. It is also what makes the feature legible:
 * nobody caps bookmarks, so a visible `WIRED 4 / 8` is the clearest available
 * statement that this is wiring rather than saving-for-later.
 */
export const MAX_FOLLOWS = 8;

/** A slug as identity-store mints them: Crockford base32, i/l/o/u removed. */
export const SLUG_SHAPE = /^[0-9a-hjkmnp-tv-z]{16}$/;

export interface FollowEdge {
  target: string;
  createdAt: number;
}

export interface FollowStore {
  /** Slugs this tenant's agent reads, newest first. */
  following(tenant: `0x${string}`): Promise<FollowEdge[]>;
  /**
   * Add an edge. Idempotent — following twice is one row and one `createdAt`.
   * Returns `false` when the tenant is already at MAX_FOLLOWS and this would be
   * a NEW edge, so the caller can say so rather than silently dropping it.
   */
  follow(tenant: `0x${string}`, target: string): Promise<boolean>;
  /** Remove an edge. Removing one that is not there is not an error. */
  unfollow(tenant: `0x${string}`, target: string): Promise<void>;
  /** Forget every edge a tenant owns (on kill). */
  removeTenant(tenant: `0x${string}`): Promise<void>;
}

/** Newest first, so a truncated list keeps the most recent decisions. */
const newestFirst = (a: FollowEdge, b: FollowEdge) => b.createdAt - a.createdAt;

// ── file backend ─────────────────────────────────────────────────────────────

export class FileFollowStore implements FollowStore {
  private dir = path.join(merrymenHome(), "follows");
  private file(tenant: string) {
    return path.join(this.dir, `${tenant.toLowerCase()}.json`);
  }
  private async read(tenant: `0x${string}`): Promise<FollowEdge[]> {
    try {
      const raw = JSON.parse(await readFile(this.file(tenant), "utf8")) as unknown;
      if (!Array.isArray(raw)) return [];
      return raw
        .filter(
          (e): e is FollowEdge =>
            !!e &&
            typeof (e as FollowEdge).target === "string" &&
            SLUG_SHAPE.test((e as FollowEdge).target) &&
            Number.isFinite((e as FollowEdge).createdAt),
        )
        .sort(newestFirst);
    } catch {
      return [];
    }
  }
  private async write(tenant: `0x${string}`, edges: FollowEdge[]): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.file(tenant), JSON.stringify(edges, null, 2), { encoding: "utf8", mode: 0o600 });
  }
  async following(tenant: `0x${string}`): Promise<FollowEdge[]> {
    return this.read(tenant);
  }
  async follow(tenant: `0x${string}`, target: string): Promise<boolean> {
    const edges = await this.read(tenant);
    // Idempotent: an existing edge keeps its original timestamp, so re-following
    // does not reorder somebody's list under them.
    if (edges.some((e) => e.target === target)) return true;
    if (edges.length >= MAX_FOLLOWS) return false;
    edges.push({ target, createdAt: Math.floor(Date.now() / 1000) });
    await this.write(tenant, edges.sort(newestFirst));
    return true;
  }
  async unfollow(tenant: `0x${string}`, target: string): Promise<void> {
    const edges = await this.read(tenant);
    const kept = edges.filter((e) => e.target !== target);
    if (kept.length !== edges.length) await this.write(tenant, kept);
  }
  async removeTenant(tenant: `0x${string}`): Promise<void> {
    await rm(this.file(tenant), { force: true });
  }
}

// ── postgres backend ─────────────────────────────────────────────────────────

interface PgClientLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

/**
 * Postgres backend for the hosted deploy. `pg` is imported at RUNTIME only
 * (webpackIgnore) so the file backend builds with it absent — the same shape as
 * PgSettingsStore and PgGrantStore, minus the DEK those two require.
 */
export class PgFollowStore implements FollowStore {
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
          `CREATE TABLE IF NOT EXISTS agent_follows (
             follower TEXT NOT NULL,
             target_slug TEXT NOT NULL,
             created_at BIGINT NOT NULL,
             PRIMARY KEY (follower, target_slug)
           )`,
        );
        // The reverse direction — "who reads this agent" — is the one a profile
        // page asks, and without this it is a full scan per view.
        await c.query(`CREATE INDEX IF NOT EXISTS agent_follows_target ON agent_follows (target_slug)`);
        return c;
      })();
    }
    return this.ready;
  }
  async following(tenant: `0x${string}`): Promise<FollowEdge[]> {
    const c = await this.client();
    const { rows } = await c.query(
      `SELECT target_slug, created_at FROM agent_follows WHERE follower = $1 ORDER BY created_at DESC`,
      [tenant.toLowerCase()],
    );
    return rows.map((r) => ({ target: String(r.target_slug), createdAt: Number(r.created_at) }));
  }
  async follow(tenant: `0x${string}`, target: string): Promise<boolean> {
    const c = await this.client();
    // COUNT FIRST, and accept that this is not atomic. Two concurrent follows by
    // one owner could both see 7 and both insert, leaving 9. That is the benign
    // direction: the cap exists to bound a prompt, the peer file truncates to
    // MAX_FOLLOWS when it materialises, and the alternative is a transaction
    // around a write that is already idempotent. A cap overshot by one for one
    // owner is not worth a lock.
    const { rows } = await c.query(`SELECT COUNT(*)::int AS n FROM agent_follows WHERE follower = $1`, [
      tenant.toLowerCase(),
    ]);
    const existing = Number(rows[0]?.n ?? 0);
    const { rows: already } = await c.query(
      `SELECT 1 FROM agent_follows WHERE follower = $1 AND target_slug = $2`,
      [tenant.toLowerCase(), target],
    );
    if (already.length === 0 && existing >= MAX_FOLLOWS) return false;
    await c.query(
      `INSERT INTO agent_follows (follower, target_slug, created_at) VALUES ($1, $2, $3)
       ON CONFLICT (follower, target_slug) DO NOTHING`,
      [tenant.toLowerCase(), target, Math.floor(Date.now() / 1000)],
    );
    return true;
  }
  async unfollow(tenant: `0x${string}`, target: string): Promise<void> {
    const c = await this.client();
    await c.query(`DELETE FROM agent_follows WHERE follower = $1 AND target_slug = $2`, [
      tenant.toLowerCase(),
      target,
    ]);
  }
  async removeTenant(tenant: `0x${string}`): Promise<void> {
    const c = await this.client();
    await c.query(`DELETE FROM agent_follows WHERE follower = $1`, [tenant.toLowerCase()]);
  }
}

let cached: FollowStore | null = null;
export function getFollowStore(): FollowStore {
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  cached = url ? new PgFollowStore(url) : new FileFollowStore();
  return cached;
}

/** Test seam: drop the cached store so a test can change the environment. */
export function resetFollowStoreForTest(): void {
  cached = null;
}
