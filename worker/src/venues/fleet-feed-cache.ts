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

/** Public market data only. SQLite leases coordinate separate tenant processes;
 * no transaction stays open across a network request. */
export class FleetFeedCache {
  private db: DatabaseSync;
  constructor(home: string, private spacingMs = 3000) {
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
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const now = Date.now();
      const row = this.db.prepare("SELECT * FROM pages WHERE key=?").get(key) as {payload: string | null; expires: number} | undefined;
      if (row?.payload && row.expires > now) return JSON.parse(row.payload) as T;
      const cooldown = this.db.prepare("SELECT until_ms FROM cooldown WHERE id=1").get() as {until_ms: number};
      if (cooldown.until_ms > now) return unavailable("provider-cooldown");
      const lease = randomUUID();
      const claimed = this.db.prepare(`INSERT INTO pages(key,lease,lease_until) VALUES(?,?,?)
        ON CONFLICT(key) DO UPDATE SET lease=excluded.lease, lease_until=excluded.lease_until
        WHERE pages.lease_until<=? AND pages.expires<=?`).run(key, lease, now + 45_000, now, now);
      if (!claimed.changes) { await sleep(100); continue; }
      try {
        // Reserve one fleet-wide slot, even for different page keys. The
        // public budget is 30/min; 3s spacing leaves headroom at 20/min.
        for (;;) {
          const time = Date.now();
          if (time >= deadline) return unavailable("request-budget");
          const turn = this.db.prepare("UPDATE pacing SET next_ms=? WHERE id=1 AND next_ms<=?")
            .run(time + this.spacingMs, time);
          if (turn.changes) break;
          const pacing = this.db.prepare("SELECT next_ms FROM pacing WHERE id=1").get() as {next_ms: number};
          // Claim at wake-up, not before sleeping: delayed event loops must
          // not release several reserved slots as a catch-up burst.
          await sleep(Math.max(1, Math.min(pacing.next_ms - Date.now(), deadline - Date.now())));
        }
        // Another page may have received 429 while this one waited its turn.
        const latest = this.db.prepare("SELECT until_ms FROM cooldown WHERE id=1").get() as {until_ms: number};
        if (latest.until_ms > Date.now()) return unavailable("provider-cooldown");
        const result = await request();
        const at = Date.now();
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
