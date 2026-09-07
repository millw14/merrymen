/**
 * WHO LIKED WHAT.
 *
 * THE FENCE IS THIS FILE'S LOCATION, and it is the whole design.
 *
 * `follow-store.ts` lives under `worker/src` because the ORCHESTRATOR needs it:
 * it materialises each child's followed theses into a file the agent's desk
 * reads. Likes have no such reader and must never acquire one, so this store
 * lives under `web/src` — where the worker cannot reach it. `imports.test.ts`
 * forbids every file under `worker/src` from alias-importing `@merrymen/*`, and
 * `web/src` is not aliased inward at all. So "an agent cannot read a like" is
 * not a rule somebody has to keep obeying; there is no import that would work.
 *
 * WHY THAT MATTERS MORE THAN IT SOUNDS. `follow-store.ts` states the rule this
 * inherits, about the one number a Sybil can inflate: "Display it if you like;
 * NEVER sort by it, and NEVER let an agent read it. The moment a number here
 * can move an agent's decision, minting wallets becomes a way to move somebody
 * else's money." A like is that number exactly — cheaper to mint than a follow,
 * because a follow is capped at 8 and costs a slot in a prompt.
 *
 * So: likes rank a FEED, for a person, in a browser. They do not reach a
 * strategy, a proposal, a size or a prompt, and the shape of the code is what
 * says so.
 *
 * THE ASYMMETRY, as in the follow store:
 *
 *   liker  = a TENANT  — a `0x` wallet address that signed in
 *   post   = a POST ID — 32 hex chars from `post-id.ts`, derived from what the
 *            post already shows
 *
 * NO FOREIGN KEY and no existence check, deliberately: a like on a post that
 * ages out of the 24-hour window should dangle harmlessly rather than fail a
 * write. The composite primary key IS the idempotence — liking twice is one
 * row — and it is also the rate limit, together with the cap below.
 *
 * NO DEK. A post id is derived from strings already rendered on the page, and
 * the liker is an address that already appears on chain. Sealing it would imply
 * a confidentiality this data does not have.
 *
 * NODE-ONLY (node:fs, pg). Imported by the two like routes, never the browser.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { merrymenHome } from "@merrymen/home";
import { POST_ID_SHAPE } from "./post-id";

/**
 * How many posts one wallet may have liked, ever.
 *
 * NOT a product limit — nobody runs out of likes in a 24-hour window of forty
 * posts. It is the bound on an otherwise unbounded write endpoint: a post id is
 * validated for SHAPE and not for existence (see above), so without this a free
 * wallet could insert rows for arbitrary hex forever. Large enough that a real
 * reader will never see it; small enough that the table cannot be grown into a
 * problem by one signer.
 */
export const MAX_LIKES = 2_000;

/**
 * How many post ids one counts() call may ask about.
 *
 * A CEILING ON THE QUESTION, NOT ON THE ANSWER — and that distinction is the
 * fix for a whole class of defect an adversarial review found. The first
 * version answered "the 500 most-liked posts of all time", which went wrong
 * three ways at once: `post_likes` never expires while the feed window is 24
 * hours, so the two sets drift apart permanently; a post truncated out of the
 * response is ABSENT, and both readers treat absence as zero, so a partial read
 * rendered as "nobody liked this"; and since a post id is validated for shape
 * and not for existence, a few hundred minted wallets liking fabricated ids
 * could evict every real post from a publicly cached response.
 *
 * Asking by id closes all three. The ids come from the feed, so the answer
 * cannot drift from what is on screen, cannot be truncated (the feed shows ~40
 * posts), and a fabricated id crowds out nothing because it is never asked
 * about.
 */
export const MAX_COUNT_IDS = 200;

export interface LikeStore {
  /** Post ids this tenant has liked. */
  liked(tenant: `0x${string}`): Promise<string[]>;
  /**
   * Add a like. Idempotent. Returns `false` when the tenant is at MAX_LIKES and
   * this would be a NEW row, so the caller can say so rather than silently
   * dropping it.
   */
  like(tenant: `0x${string}`, postId: string): Promise<boolean>;
  /** Remove one. Removing a like that is not there is not an error. */
  unlike(tenant: `0x${string}`, postId: string): Promise<void>;
  /**
   * How many wallets have liked each of THESE posts.
   *
   * SESSION-FREE BY SIGNATURE. It takes post ids and no tenant, so the route
   * that serves it cannot accidentally become per-caller — the same "the
   * property is an absence" discipline `read-theses.ts` is built on.
   *
   * Every asked-about id appears in the result, zero included, so a caller can
   * tell "nobody liked it" from "we did not ask" without a second field.
   */
  counts(postIds: readonly string[]): Promise<Record<string, number>>;
  /** Forget every like a tenant cast (on kill). */
  removeTenant(tenant: `0x${string}`): Promise<void>;
}

const clean = (ids: unknown): string[] =>
  Array.isArray(ids) ? ids.filter((v): v is string => typeof v === "string" && POST_ID_SHAPE.test(v)) : [];

// ── file backend ─────────────────────────────────────────────────────────────

export class FileLikeStore implements LikeStore {
  private dir = path.join(merrymenHome(), "likes");
  private file(tenant: string) {
    return path.join(this.dir, `${tenant.toLowerCase()}.json`);
  }
  private async read(tenant: `0x${string}`): Promise<string[]> {
    try {
      return clean(JSON.parse(await readFile(this.file(tenant), "utf8")));
    } catch {
      return [];
    }
  }
  private async write(tenant: `0x${string}`, ids: string[]): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.file(tenant), JSON.stringify(ids, null, 2), { encoding: "utf8", mode: 0o600 });
  }
  async liked(tenant: `0x${string}`): Promise<string[]> {
    return this.read(tenant);
  }
  async like(tenant: `0x${string}`, postId: string): Promise<boolean> {
    const ids = await this.read(tenant);
    if (ids.includes(postId)) return true;
    if (ids.length >= MAX_LIKES) return false;
    ids.push(postId);
    await this.write(tenant, ids);
    return true;
  }
  async unlike(tenant: `0x${string}`, postId: string): Promise<void> {
    const ids = await this.read(tenant);
    const kept = ids.filter((v) => v !== postId);
    if (kept.length !== ids.length) await this.write(tenant, kept);
  }
  async counts(postIds: readonly string[]): Promise<Record<string, number>> {
    // SELF-HOSTED HAS ONE SIGNER, so a scan of one directory is the whole
    // table. Deliberately not cached: the file backend is a single-operator
    // path where the numbers are tiny and staleness would be the only bug.
    const want = new Set(postIds);
    // Every asked-about id answers, zero included — absence in the result would
    // be indistinguishable from a read that never happened.
    const out: Record<string, number> = Object.fromEntries([...want].map((id) => [id, 0]));
    if (!want.size) return out;
    let names: string[] = [];
    try {
      const { readdir } = await import("node:fs/promises");
      names = await readdir(this.dir);
    } catch (e) {
      // NO DIRECTORY MEANS NOBODY HAS LIKED ANYTHING — a true and complete
      // answer. Anything else means we could not look, and swallowing it would
      // publish our own permissions problem as "nobody liked anything", which
      // is the one substitution this codebase refuses everywhere. The route
      // turns a throw into `read: false`.
      if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return out;
      throw e;
    }
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      try {
        for (const id of clean(JSON.parse(await readFile(path.join(this.dir, name), "utf8")))) {
          if (want.has(id)) out[id] += 1;
        }
      } catch {
        /* one unreadable file is not a reason to report zero for everything */
      }
    }
    return out;
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
 * Postgres for the hosted deploy. `pg` is imported at RUNTIME only
 * (webpackIgnore) so the file backend builds with it absent — the same shape as
 * PgFollowStore, minus the DEK neither of them needs.
 */
export class PgLikeStore implements LikeStore {
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
          `CREATE TABLE IF NOT EXISTS post_likes (
             liker TEXT NOT NULL,
             post_id TEXT NOT NULL,
             created_at BIGINT NOT NULL,
             PRIMARY KEY (liker, post_id)
           )`,
        );
        // "How many liked this post" is the only aggregate anything asks, and
        // without this it is a full scan on every feed render.
        await c.query(`CREATE INDEX IF NOT EXISTS post_likes_post ON post_likes (post_id)`);
        return c;
      })();
    }
    return this.ready;
  }
  async liked(tenant: `0x${string}`): Promise<string[]> {
    const c = await this.client();
    const { rows } = await c.query(
      `SELECT post_id FROM post_likes WHERE liker = $1 ORDER BY created_at DESC LIMIT $2`,
      [tenant.toLowerCase(), MAX_LIKES],
    );
    return rows.map((r) => String(r.post_id));
  }
  async like(tenant: `0x${string}`, postId: string): Promise<boolean> {
    const c = await this.client();
    // COUNT FIRST, and not atomically — the same trade the follow store makes
    // and for the same reason. Two concurrent likes by one wallet could both
    // see MAX_LIKES-1; overshooting a DoS bound by one row is not worth a lock
    // around a write that is already idempotent.
    const { rows: already } = await c.query(`SELECT 1 FROM post_likes WHERE liker = $1 AND post_id = $2`, [
      tenant.toLowerCase(),
      postId,
    ]);
    if (already.length === 0) {
      const { rows } = await c.query(`SELECT COUNT(*)::int AS n FROM post_likes WHERE liker = $1`, [
        tenant.toLowerCase(),
      ]);
      if (Number(rows[0]?.n ?? 0) >= MAX_LIKES) return false;
    }
    await c.query(
      `INSERT INTO post_likes (liker, post_id, created_at) VALUES ($1, $2, $3)
       ON CONFLICT (liker, post_id) DO NOTHING`,
      [tenant.toLowerCase(), postId, Math.floor(Date.now() / 1000)],
    );
    return true;
  }
  async unlike(tenant: `0x${string}`, postId: string): Promise<void> {
    const c = await this.client();
    await c.query(`DELETE FROM post_likes WHERE liker = $1 AND post_id = $2`, [tenant.toLowerCase(), postId]);
  }
  async counts(postIds: readonly string[]): Promise<Record<string, number>> {
    const want = [...new Set(postIds)].slice(0, MAX_COUNT_IDS);
    const out: Record<string, number> = Object.fromEntries(want.map((id) => [id, 0]));
    if (!want.length) return out;
    const c = await this.client();
    // BY ID, NOT BY RANK. `ORDER BY n DESC LIMIT 500` over the whole table
    // answered a question nobody asked — the most-liked posts of all time —
    // and its truncation was invisible to every caller. This asks about the
    // posts on the page and answers for all of them, so there is no truncation
    // to be silent about and a fabricated id can evict nothing.
    const { rows } = await c.query(
      `SELECT post_id, COUNT(*)::int AS n FROM post_likes WHERE post_id = ANY($1) GROUP BY post_id`,
      [want],
    );
    for (const r of rows) out[String(r.post_id)] = Number(r.n);
    return out;
  }
  async removeTenant(tenant: `0x${string}`): Promise<void> {
    const c = await this.client();
    await c.query(`DELETE FROM post_likes WHERE liker = $1`, [tenant.toLowerCase()]);
  }
}

let cached: LikeStore | null = null;
export function getLikeStore(): LikeStore {
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  cached = url ? new PgLikeStore(url) : new FileLikeStore();
  return cached;
}

/** Test seam: drop the cached store so a test can change the environment. */
export function resetLikeStoreForTest(): void {
  cached = null;
}
