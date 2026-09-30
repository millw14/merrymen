import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";

export interface FeedResult {
  failed: boolean;
  failure?: string;
  observedAt?: number;
  retryAfterMs?: number;
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

const REAL_CLOCK: FeedClock = { now: () => Date.now(), sleep: (ms) => sleep(ms) };

/** Public market data only. SQLite leases coordinate separate tenant processes;
 * no transaction stays open across a network request. */
export class FleetFeedCache {
  private db: DatabaseSync;
  constructor(home: string, private spacingMs = 3000, private clock: FeedClock = REAL_CLOCK) {
    mkdirSync(home, { recursive: true });
    this.db = new DatabaseSync(path.join(home, "gecko-feed-cache.sqlite"));
    this.db.exec(`PRAGMA busy_timeout=1000;
      CREATE TABLE IF NOT EXISTS pages (key TEXT PRIMARY KEY, payload TEXT, expires REAL NOT NULL DEFAULT 0, lease TEXT, lease_until REAL NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS cooldown (id INTEGER PRIMARY KEY, until_ms REAL NOT NULL);
      INSERT OR IGNORE INTO cooldown VALUES (1,0);
      CREATE TABLE IF NOT EXISTS pacing (id INTEGER PRIMARY KEY, next_ms REAL NOT NULL);
      INSERT OR IGNORE INTO pacing VALUES (1,0);`);
  }
  close() { this.db.close(); }

  async get<T extends FeedResult>(key: string, request: () => Promise<T>, unavailable: (reason: string) => T): Promise<T> {
    const deadline = this.clock.now() + 30_000;
    while (this.clock.now() < deadline) {
      const now = this.clock.now();
      const row = this.db.prepare("SELECT * FROM pages WHERE key=?").get(key) as {payload: string | null; expires: number} | undefined;
      if (row?.payload && row.expires > now) return JSON.parse(row.payload) as T;
      const cooldown = this.db.prepare("SELECT until_ms FROM cooldown WHERE id=1").get() as {until_ms: number};
      if (cooldown.until_ms > now) return unavailable("provider-cooldown");
      const lease = randomUUID();
      const claimed = this.db.prepare(`INSERT INTO pages(key,lease,lease_until) VALUES(?,?,?)
        ON CONFLICT(key) DO UPDATE SET lease=excluded.lease, lease_until=excluded.lease_until
        WHERE pages.lease_until<=? AND pages.expires<=?`).run(key, lease, now + 45_000, now, now);
      if (!claimed.changes) { await this.clock.sleep(100); continue; }
      try {
        // Reserve one fleet-wide slot, even for different page keys. The
        // public budget is 30/min; 3s spacing leaves headroom at 20/min.
        for (;;) {
          const time = this.clock.now();
          if (time >= deadline) return unavailable("request-budget");
          const turn = this.db.prepare("UPDATE pacing SET next_ms=? WHERE id=1 AND next_ms<=?")
            .run(time + this.spacingMs, time);
          if (turn.changes) break;
          const pacing = this.db.prepare("SELECT next_ms FROM pacing WHERE id=1").get() as {next_ms: number};
          // Claim at wake-up, not before sleeping: delayed event loops must
          // not release several reserved slots as a catch-up burst.
          await this.clock.sleep(Math.max(1, Math.min(pacing.next_ms - this.clock.now(), deadline - this.clock.now())));
        }
        // Another page may have received 429 while this one waited its turn.
        const latest = this.db.prepare("SELECT until_ms FROM cooldown WHERE id=1").get() as {until_ms: number};
        if (latest.until_ms > this.clock.now()) return unavailable("provider-cooldown");
        const result = await request();
        const at = this.clock.now();
        if (result.failure === "http-429") {
          const delay = Math.max(60_000, Number.isFinite(result.retryAfterMs) ? result.retryAfterMs! : 0);
          this.db.prepare("UPDATE cooldown SET until_ms=MAX(until_ms,?) WHERE id=1").run(at + delay);
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
