/**
 * WHO HAS ALREADY BEEN SHOWN AROUND.
 *
 * One fact per owner: they finished or skipped the guided first visit, and must
 * not be interrupted by it again.
 *
 * ── WHY THIS IS NOT A SETTING ───────────────────────────────────────────────
 *
 * The obvious home was `MerrymenSettings`, and it is the wrong one for three
 * reasons, the last of which is decisive.
 *
 * The settings blob is the TRADING worker's configuration. The orchestrator
 * reads it and writes each child a `settings.json`; it is sealed at rest because
 * it can hold a Telegram bot token. A dismissed tooltip does not belong in the
 * same record as an API key and a per-trade ceiling.
 *
 * Self-hosted writes ONE global settings file, so "this owner has seen it" would
 * become "this installation has seen it".
 *
 * And the one that settles it: the settings PUT answers 401 without a tenant.
 * The tour is shown to everyone, including a visitor who has not signed in — so
 * storing the flag there would refuse a write for exactly the population the
 * feature is about, and read back nothing for them either.
 *
 * So this follows the shape the repo already chose for per-owner state that is
 * not trading configuration: its own tiny store, keyed on the tenant, with a
 * file backend and a Postgres backend. See `like-store.ts`, which this is
 * modelled on line for line, and `worker/src/follow-store.ts` for the argument
 * in full.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ───────────────────────────────────────────
 *
 * NO DEK. A dismissed tour is not a secret. Sealing it would imply a
 * confidentiality this fact does not have, and would make the store depend on a
 * key the web app should not need for a tooltip.
 *
 * NO STEP NUMBER. Which stop somebody reached is a convenience and lives in
 * `localStorage`, where losing it costs a scroll. What is promised here is
 * narrower and firmer: pressing "Skip tour" means never again. Storing a resume
 * point would be a second, different promise, and the two would eventually
 * disagree about what "done" meant.
 *
 * NO ANONYMOUS ROW. A signed-out visitor has no tenant and therefore no row.
 * That is not a gap to paper over with a synthetic id — it is the honest limit
 * of a server-side flag, and the component treats `localStorage` as the layer
 * that is always present. See `web/src/terminal/FirstVisit.tsx`, which asks both
 * and treats EITHER saying "done" as done.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { merrymenHome } from "@merrymen/home";
import { TOUR_VERSION } from "./tour-version";

// v2 retains existing records. Later revisions have their own namespace in
// both backends, so an old dismissal cannot suppress a rewritten tour.
function ownerKey(tenant: string, version: number): string {
  if (!Number.isSafeInteger(version) || version < 2) throw new Error("Invalid tour version");
  return `${tenant.toLowerCase()}${version === 2 ? "" : `.v${version}`}`;
}

export interface TourStore {
  /** Has this owner finished or skipped the tour? */
  done(tenant: `0x${string}`): Promise<boolean>;
  /**
   * Record that they have. IDEMPOTENT, and it keeps the FIRST timestamp.
   *
   * Pressing skip twice is one dismissal, and the interesting number is when
   * they first stopped wanting it — not when they last happened to click.
   */
  markDone(tenant: `0x${string}`): Promise<void>;
  /** Forget it, so the tour can be shown again. Used on kill, and by tests. */
  clear(tenant: `0x${string}`): Promise<void>;
}

// ── file backend ─────────────────────────────────────────────────────────────

export class FileTourStore implements TourStore {
  private dir = path.join(merrymenHome(), "tour");
  constructor(private version = TOUR_VERSION) {}
  private file(tenant: string) {
    return path.join(this.dir, `${ownerKey(tenant, this.version)}.json`);
  }
  async done(tenant: `0x${string}`): Promise<boolean> {
    try {
      const raw = JSON.parse(await readFile(this.file(tenant), "utf8")) as { doneAt?: unknown };
      return typeof raw?.doneAt === "number" && raw.doneAt > 0;
    } catch {
      // No file is "not yet", which is the same answer as a file we could not
      // read. Both mean "show it", and showing a tour one extra time is the
      // cheap direction to be wrong in.
      return false;
    }
  }
  async markDone(tenant: `0x${string}`): Promise<void> {
    if (await this.done(tenant)) return;
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.file(tenant), JSON.stringify({ doneAt: Date.now() }, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
  }
  async clear(tenant: `0x${string}`): Promise<void> {
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
 * PgLikeStore, and for the same reason.
 */
export class PgTourStore implements TourStore {
  private ready: Promise<PgClientLike> | null = null;
  constructor(private url: string, private version = TOUR_VERSION, private connect?: () => Promise<PgClientLike>) {}
  private async client(): Promise<PgClientLike> {
    if (!this.ready) {
      this.ready = (async () => {
        if (this.connect) return this.connect();
        // @ts-expect-error pg has no types here (runtime-only); webpackIgnore stops the bundler resolving it
        const pg = (await import(/* webpackIgnore: true */ "pg")) as unknown as {
          Client: new (c: { connectionString: string }) => PgClientLike & { connect(): Promise<void> };
        };
        const c = new pg.Client({ connectionString: this.url });
        await c.connect();
        // One row per owner, and the tenant IS the key — so a second dismissal
        // cannot make a second row, and there is no count to grow unbounded.
        await c.query(
          `CREATE TABLE IF NOT EXISTS tour_seen (
             tenant TEXT PRIMARY KEY,
             done_at BIGINT NOT NULL
           )`,
        );
        return c;
      })().catch(error => { this.ready = null; throw error; });
    }
    return this.ready;
  }
  async done(tenant: `0x${string}`): Promise<boolean> {
    const c = await this.client();
    const { rows } = await c.query(`SELECT 1 FROM tour_seen WHERE tenant = $1`, [ownerKey(tenant, this.version)]);
    return rows.length > 0;
  }
  async markDone(tenant: `0x${string}`): Promise<void> {
    const c = await this.client();
    // DO NOTHING rather than DO UPDATE: the first dismissal is the one that
    // means something, and a re-press should not rewrite its timestamp.
    await c.query(
      `INSERT INTO tour_seen (tenant, done_at) VALUES ($1, $2) ON CONFLICT (tenant) DO NOTHING`,
      [ownerKey(tenant, this.version), Date.now()],
    );
  }
  async clear(tenant: `0x${string}`): Promise<void> {
    const c = await this.client();
    await c.query(`DELETE FROM tour_seen WHERE tenant = $1`, [ownerKey(tenant, this.version)]);
  }
}

let cached: TourStore | null = null;
export function getTourStore(): TourStore {
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  cached = url ? new PgTourStore(url) : new FileTourStore();
  return cached;
}

/** Test seam: drop the cached store so a test can change the environment. */
export function resetTourStoreForTest(): void {
  cached = null;
}
