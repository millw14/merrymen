import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

export interface FeedResult {
  failed: boolean;
  failure?: string;
  observedAt?: number;
  retryAfterMs?: number;
  provider?: "coingecko-pro" | "geckoterminal-public";
  /** Safe primary diagnostic when a separate public source was consulted. */
  primaryFailure?: string;
}

/**
 * THE CLOCK, INJECTABLE — so the pace can be asserted instead of estimated.
 *
 * The spacing guarantee is made where the slot is CLAIMED: one UPDATE that
 * only succeeds when `next_ms <= now`. A test outside this class cannot see
 * that moment; the nearest thing it can observe is when its own request
 * callback runs, which is the claim plus however long the event loop took to
 * get there. That delay is unbounded and asymmetric, so a wall-clock test
 * measures `spacing + (delay2 - delay1)` and calls it the pace.
 *
 * Measured on an IDLE machine over 240 samples: median 108ms against a 100ms
 * pace, but a minimum of 35ms — a 65ms asymmetry, with 0.8% of gaps already
 * under the old 85ms assertion. Under a loaded CI runner it reddened main
 * three times in one day, every time on a pace that had worked correctly.
 *
 * With the clock injected the test drives time itself and asserts the exact
 * spacing, so the flake is gone and the assertion is stronger than the one it
 * replaces. Production passes nothing and keeps the real clock.
 */
export interface FeedClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const REAL_FEED_CLOCK: FeedClock = { now: () => Date.now(), sleep: (ms) => sleep(ms) };

/** Persistent failures should not spend an exhausted monthly quota every minute. */
function cooldownDelay(result: FeedResult, failures: number): number {
  return Math.max(Math.min(900_000, 60_000 * 2 ** Math.min(4, failures)),
    Number.isFinite(result.retryAfterMs) ? result.retryAfterMs! : 0);
}

/**
 * WHICH PACING ROW A READ TAKES.
 *
 * `default` is every caller there has ever been: the tape feeds, the desk, the
 * facts and the X lines. `evidence` is a read something is WAITING on — the
 * Brain's candle and trade legs under a five-second budget per leg, and on
 * web a chart somebody has open.
 *
 * On one shared row those legs queued behind the sixty-second tape burst
 * (seven or eight page requests), so `candles=budget` was the normal outcome,
 * not a fault. A second row lets them skip that queue.
 *
 * IT IS PRIORITY, NOT EXTRA QUOTA. Every evidence slot taken also pushes the
 * default row back by one slot, so in any stretch of time the two rows make
 * at most ONE request more than a single row at `spacingMs` could — the pace
 * the operator configured and the monthly ceiling was computed for. That one
 * is a burst of two when both rows fire in the same instant, far inside the
 * provider's per-minute limit (fleet-feed-cache.test.ts checks the bound over
 * every window of a long mixed run). Under sustained evidence demand the default
 * row waits: the tape goes stale and says so ("request-budget"); no extra
 * credit is spent. Evidence demand is bounded by the review cadence and a
 * one-minute memo per pool, so in practice it takes a few slots a minute.
 *
 * One 429 cooldown still covers both rows: a rate limit is a fact about the
 * key, not about which caller earned it.
 *
 * ONLY A CACHE BUILT WITH `priorityRow` HAS THE SECOND ROW — the Pro lane.
 * The keyless public lane's 6.5 s spacing is its whole defence against a
 * documented ~10/min limit, and even a one-request burst there earns a 429
 * and a cooldown of a minute or more for every public read. So on a cache
 * without it an `evidence` read simply takes the default row, and every
 * request, whoever asked, is at least one spacing from the last.
 */
export type FeedLane = "default" | "evidence";

export interface FeedGetOptions {
  /** Pacing row; omitted means `default`, exactly the old behaviour. */
  lane?: FeedLane;
  /**
   * The provider route this read asks for (path, optionally with a query).
   * Its TEMPLATE — ids replaced, query dropped — is the plan-refusal latch key.
   * Ignored unless the cache was built with `latchRefusals`.
   */
  route?: string;
}

export interface FeedCacheOptions {
  /**
   * Latch plan refusals per endpoint family (see PLAN_LATCH_MS). Meant for
   * the credit-metered Pro lane only: a 401 there is a fact about the plan,
   * and asking again every five seconds is a slot spent on a known answer.
   */
  latchRefusals?: boolean;
  /**
   * WHOSE refusal a latch records: a short fingerprint of the credential the
   * lane sends (credentialFingerprint), never the credential itself.
   *
   * A latch is a fact about one key's plan, and the fleet's latches live in a
   * file on the persistent data home that outlives every restart. Unbound, a
   * mistyped or expired key latched each family it touched for an hour, and
   * fixing the key and restarting changed nothing for that hour: every family
   * still answered `plan-restricted` without asking, with no public fallback,
   * which is worse than both a working key and no key. Bound, a different key
   * starts clean and the old key's latches simply expire.
   */
  credential?: string;
  /**
   * Honour `lane: "evidence"` with its own pacing row (see FeedLane). Off, the
   * default, every read takes the default row. The Pro lane only.
   */
  priorityRow?: boolean;
  /** Where a newly set latch is said. Defaults to console.warn. */
  log?: (line: string) => void;
}

/**
 * HOW LONG A PLAN REFUSAL IS BELIEVED, fleet-wide: one hour.
 *
 * A 401 (or CoinGecko's body code 10005, "you may not have access to this
 * endpoint", on any client error) from the Pro lane was cached for five
 * seconds like any other failure, so an endpoint the plan does not include
 * burned a pacing slot every five seconds, all day, for an answer that could
 * not change. Latched, it costs one request an hour.
 *
 * NEVER ON 5xx OR 429. Those are about the provider's moment, not the plan,
 * and they already have their own short cache and the shared cooldown.
 *
 * NOR ON A BARE 403 (review, 2026-10-12). CoinGecko documents 403 as access
 * blocked by its server, which a firewall rule or a shared egress address
 * can set off for a moment; only the 10005 body says it is the plan. Latched,
 * one such 403 on a trades, candles or tape page shut that endpoint family
 * off for every agent for an hour with no public fallback: Trencher reviews
 * went blind and the tape went empty. A bare 403 is now the five-second
 * failure it always was.
 *
 * PER KEY. A latch belongs to the credential that was refused
 * (FeedCacheOptions.credential), so a fixed or rotated key is asked afresh on
 * its first request. A plan upgrade under the SAME key takes effect when the
 * hour runs out.
 */
export const PLAN_LATCH_MS = 3_600_000;

/** A refusal that says the plan does not cover this endpoint (10005), or that the key is refused (401). Never a bare 403. */
export function isPlanRefusal(failure: string | undefined): boolean {
  return failure === "http-401" || failure === "plan-restricted";
}

/**
 * A route's template: the path without its query, with every hex id replaced.
 *
 * The latch is per FAMILY so one refused pool does not leave every other pool
 * of the same endpoint free to be refused in turn, and so the log line names
 * an endpoint rather than an address or a search somebody typed.
 */
export function endpointFamily(route: string): string {
  const pathOnly = route.split(/[?#]/, 1)[0]!.replace(/^\/+/, "");
  // A hex id (an EVM address, a v4 poolId) or a base58 one (a Solana mint).
  const isId = (seg: string) => /0x[\da-f]{6,}/i.test(seg) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(seg);
  return pathOnly.split("/").map(seg => isId(seg) ? "{id}" : seg).join("/").slice(0, 160);
}

/**
 * A credential as a latch may record it: the first 12 hex characters of its
 * sha256. Enough to tell two keys apart, not enough to recover either, and
 * never logged.
 */
export function credentialFingerprint(secret: string): string {
  return createHash("sha256").update(secret).digest("hex").slice(0, 12);
}

const latchLine = (family: string, failure: string | undefined) =>
  `[gecko] coingecko-pro refused ${family} (${failure ?? "refused"}); not asking that endpoint again for 1h`;

export interface FeedCache {
  get<T extends FeedResult>(key: string, request: () => Promise<T>, unavailable: (reason: string) => T, deadlineMs?: number, options?: FeedGetOptions): Promise<T>;
  close(): void;
}

/** Public market data only. SQLite leases coordinate separate tenant processes;
 * no transaction stays open across a network request. */
export class FleetFeedCache implements FeedCache {
  private db: DatabaseSync;
  private latchRefusals: boolean;
  private credential: string;
  private priorityRow: boolean;
  private log: (line: string) => void;
  constructor(home: string, private spacingMs = 6500, private clock: FeedClock = REAL_FEED_CLOCK, options: FeedCacheOptions = {}) {
    this.latchRefusals = options.latchRefusals === true;
    this.credential = options.credential ?? "";
    this.priorityRow = options.priorityRow === true;
    this.log = options.log ?? (line => console.warn(line));
    mkdirSync(home, { recursive: true });
    this.db = new DatabaseSync(path.join(home, "gecko-feed-cache.sqlite"));
    // Row 1 is the default pacing row every existing caller has always used;
    // row 2 is the evidence row (see FeedLane). Additive: an older process on
    // the same file keeps using row 1 and never reads row 2 or the latch.
    // Latches are keyed by family AND credential (FeedCacheOptions.credential).
    this.db.exec(`PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS pages (key TEXT PRIMARY KEY, payload TEXT, expires REAL NOT NULL DEFAULT 0, lease TEXT, lease_until REAL NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS cooldown (id INTEGER PRIMARY KEY, until_ms REAL NOT NULL);
      INSERT OR IGNORE INTO cooldown(id,until_ms) VALUES (1,0);
      CREATE TABLE IF NOT EXISTS provider_backoff (id INTEGER PRIMARY KEY, failures INTEGER NOT NULL DEFAULT 0);
      INSERT OR IGNORE INTO provider_backoff VALUES (1,0);
      CREATE TABLE IF NOT EXISTS pacing (id INTEGER PRIMARY KEY, next_ms REAL NOT NULL);
      INSERT OR IGNORE INTO pacing VALUES (1,0);
      INSERT OR IGNORE INTO pacing VALUES (2,0);
      CREATE TABLE IF NOT EXISTS plan_refusal (family TEXT NOT NULL, credential TEXT NOT NULL, until_ms REAL NOT NULL, PRIMARY KEY (family, credential));`);
  }
  close() { this.db.close(); }

  private latched(family: string | undefined, now: number): boolean {
    if (!family) return false;
    const row = this.db.prepare("SELECT until_ms FROM plan_refusal WHERE family=? AND credential=?").get(family, this.credential) as { until_ms: number } | undefined;
    return (row?.until_ms ?? 0) > now;
  }

  async get<T extends FeedResult>(key: string, request: () => Promise<T>, unavailable: (reason: string) => T, deadlineMs = this.clock.now() + 30_000, options: FeedGetOptions = {}): Promise<T> {
    const deadline = Math.min(deadlineMs, this.clock.now() + 30_000);
    const row = options.lane === "evidence" && this.priorityRow ? 2 : 1;
    const family = this.latchRefusals && options.route ? endpointFamily(options.route) : undefined;
    while (this.clock.now() < deadline) {
      const now = this.clock.now();
      const page = this.db.prepare("SELECT * FROM pages WHERE key=?").get(key) as {payload: string | null; expires: number} | undefined;
      if (page?.payload && page.expires > now) return JSON.parse(page.payload) as T;
      // Before the cooldown and before any slot: a latched family costs nothing.
      if (this.latched(family, now)) return unavailable("plan-restricted");
      const cooldown = this.db.prepare("SELECT until_ms FROM cooldown WHERE id=1").get() as {until_ms: number};
      if (cooldown.until_ms > now) return unavailable("provider-cooldown");
      const lease = randomUUID();
      const claimed = this.db.prepare(`INSERT INTO pages(key,lease,lease_until) VALUES(?,?,?)
        ON CONFLICT(key) DO UPDATE SET lease=excluded.lease, lease_until=excluded.lease_until
        WHERE pages.lease_until<=? AND pages.expires<=?`).run(key, lease, now + 45_000, now, now);
      if (!claimed.changes) { await this.clock.sleep(Math.min(100, deadline - this.clock.now())); continue; }
      try {
        // One provider-wide slot per row, even for different page keys. The
        // public API currently documents ~10/min, so its lane uses 6.5s spacing.
        for (;;) {
          const time = this.clock.now();
          if (time >= deadline) return unavailable("request-budget");
          const turn = this.db.prepare("UPDATE pacing SET next_ms=? WHERE id=? AND next_ms<=?")
            .run(time + this.spacingMs, row, time);
          if (turn.changes) {
            // PRIORITY, NOT EXTRA QUOTA: the evidence slot is paid for by
            // pushing the default row one slot later (see FeedLane).
            if (row === 2) this.db.prepare("UPDATE pacing SET next_ms=MAX(next_ms,?)+? WHERE id=1").run(time, this.spacingMs);
            break;
          }
          const pacing = this.db.prepare("SELECT next_ms FROM pacing WHERE id=?").get(row) as {next_ms: number};
          // Claim at wake-up, not before sleeping: delayed event loops must
          // not release several reserved slots as a catch-up burst.
          await this.clock.sleep(Math.max(1, Math.min(pacing.next_ms - this.clock.now(), deadline - this.clock.now())));
        }
        // Another page may have received 429 while this one waited its turn,
        // or another process may have latched this endpoint.
        const latest = this.db.prepare("SELECT until_ms FROM cooldown WHERE id=1").get() as {until_ms: number};
        if (latest.until_ms > this.clock.now()) return unavailable("provider-cooldown");
        if (this.latched(family, this.clock.now())) return unavailable("plan-restricted");
        const result = await request();
        const at = this.clock.now();
        if (family && isPlanRefusal(result.failure)) {
          // Set only when no live latch exists, so the process that set it is
          // the one that says so: once per latch, not once per tenant.
          const set = this.db.prepare(`INSERT INTO plan_refusal(family,credential,until_ms) VALUES(?,?,?)
            ON CONFLICT(family,credential) DO UPDATE SET until_ms=excluded.until_ms WHERE plan_refusal.until_ms<=?`).run(family, this.credential, at + PLAN_LATCH_MS, at);
          if (set.changes) this.log(latchLine(family, result.failure));
        }
        if (result.failure === "http-429") {
          const state = this.db.prepare("UPDATE provider_backoff SET failures=MIN(failures+1,5) WHERE id=1 RETURNING failures").get() as { failures: number };
          this.db.prepare("UPDATE cooldown SET until_ms=MAX(until_ms,?) WHERE id=1")
            .run(at + cooldownDelay(result, state.failures - 1));
        } else if (!result.failed) {
          this.db.prepare("UPDATE provider_backoff SET failures=0 WHERE id=1 AND (SELECT until_ms FROM cooldown WHERE id=1)<=?").run(at);
        }
        // Never change the observation timestamp on a cache hit.
        this.db.prepare("UPDATE pages SET payload=?,expires=?,lease_until=0 WHERE key=? AND lease=?")
          .run(JSON.stringify(result), result.failed ? at + 5000 : (result.observedAt ?? now) + 60_000, key, lease);
        return result;
      } finally {
        this.db.prepare("UPDATE pages SET lease_until=0 WHERE key=? AND lease=?").run(key, lease);
      }
    }
    return unavailable("timeout");
  }
}

/** Self-hosted equivalent; a fleet always uses the durable shared SQLite lane. */
export class LocalFeedCache implements FeedCache {
  private pages = new Map<string, { result: FeedResult; expires: number }>();
  private pending = new Set<string>();
  /** Next free slot per pacing row: [default, evidence] (see FeedLane). */
  private nextMs: [number, number] = [0, 0];
  private untilMs = 0;
  private failures = 0;
  /** In memory, so it never outlives the process; `credential` binds it anyway, for parity. */
  private latches = new Map<string, number>();
  private latchRefusals: boolean;
  private credential: string;
  private priorityRow: boolean;
  private log: (line: string) => void;
  constructor(private spacingMs: number, private clock: FeedClock = REAL_FEED_CLOCK, options: FeedCacheOptions = {}) {
    this.latchRefusals = options.latchRefusals === true;
    this.credential = options.credential ?? "";
    this.priorityRow = options.priorityRow === true;
    this.log = options.log ?? (line => console.warn(line));
  }
  close() { this.pages.clear(); this.latches.clear(); }

  private latched(family: string | undefined, now: number): boolean {
    return family !== undefined && (this.latches.get(`${this.credential}\n${family}`) ?? 0) > now;
  }

  async get<T extends FeedResult>(key: string, request: () => Promise<T>, unavailable: (reason: string) => T, deadlineMs = this.clock.now() + 30_000, options: FeedGetOptions = {}): Promise<T> {
    const deadline = Math.min(deadlineMs, this.clock.now() + 30_000);
    const row = options.lane === "evidence" && this.priorityRow ? 1 : 0;
    const family = this.latchRefusals && options.route ? endpointFamily(options.route) : undefined;
    while (this.clock.now() < deadline) {
      const now = this.clock.now(), hit = this.pages.get(key);
      if (hit && hit.expires > now) return hit.result as T;
      if (this.latched(family, now)) return unavailable("plan-restricted");
      if (this.untilMs > now) return unavailable("provider-cooldown");
      if (this.pending.has(key)) { await this.clock.sleep(Math.min(100, deadline - now)); continue; }
      this.pending.add(key);
      try {
        while (this.nextMs[row] > this.clock.now()) {
          if (this.clock.now() >= deadline) return unavailable("request-budget");
          await this.clock.sleep(Math.min(this.nextMs[row] - this.clock.now(), deadline - this.clock.now()));
        }
        if (this.clock.now() >= deadline) return unavailable("request-budget");
        if (this.untilMs > this.clock.now()) return unavailable("provider-cooldown");
        if (this.latched(family, this.clock.now())) return unavailable("plan-restricted");
        const claimedAt = this.clock.now();
        this.nextMs[row] = claimedAt + this.spacingMs;
        // Priority, not extra quota: an evidence slot pushes the default row.
        if (row === 1) this.nextMs[0] = Math.max(this.nextMs[0], claimedAt) + this.spacingMs;
        const result = await request(), at = this.clock.now();
        if (family && isPlanRefusal(result.failure) && !this.latched(family, at)) {
          if (this.latches.size >= 256) this.latches.delete(this.latches.keys().next().value!);
          this.latches.set(`${this.credential}\n${family}`, at + PLAN_LATCH_MS);
          this.log(latchLine(family, result.failure));
        }
        if (result.failure === "http-429") {
          this.untilMs = Math.max(this.untilMs, at + cooldownDelay(result, this.failures));
          this.failures = Math.min(5, this.failures + 1);
        } else if (!result.failed && this.untilMs <= at) this.failures = 0;
        if (this.pages.size >= 256) this.pages.delete(this.pages.keys().next().value!);
        this.pages.set(key, { result, expires: result.failed ? at + 5000 : (result.observedAt ?? now) + 60_000 });
        return result;
      } finally { this.pending.delete(key); }
    }
    return unavailable("request-budget");
  }
}
