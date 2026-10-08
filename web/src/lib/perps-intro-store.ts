/** A lifetime presentation claim, separate from tours, trading settings and grant resets. */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { merrymenHome } from "@merrymen/home";

export interface PerpsIntroStore { claim(owner: string): Promise<boolean> }
function ownerKey(owner: string): string {
  if (owner === "local") return owner;
  if (!/^0x[0-9a-f]{40}$/i.test(owner)) throw new Error("Invalid intro owner");
  return owner.toLowerCase();
}
export class FilePerpsIntroStore implements PerpsIntroStore {
  constructor(private dir = path.join(merrymenHome(), "perps-intro")) {}
  async claim(owner: string): Promise<boolean> {
    const key = ownerKey(owner);
    await mkdir(this.dir, { recursive: true });
    try {
      // Exclusive creation arbitrates across tabs AND server processes. An
      // interrupted write still consumes the claim: never replay the intro.
      await writeFile(path.join(this.dir, `${key}.json`), JSON.stringify({ claimedAt: Date.now() }), { flag: "wx", mode: 0o600 });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw error;
    }
  }
}
interface PgClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  on?(event: "error", listener: (error: Error) => void): unknown;
  end?(): Promise<unknown>;
}
interface PgConnection { ready: Promise<PgClient>; client?: PgClient; failed: boolean }
export class PgPerpsIntroStore implements PerpsIntroStore {
  private connection: PgConnection | null = null;
  constructor(private url: string, private connect?: () => Promise<PgClient>) {}
  private discard(connection: PgConnection): void {
    if (connection.failed) return;
    connection.failed = true;
    // A late rejection from the old connection cannot discard its replacement.
    if (this.connection === connection) this.connection = null;
    try { void connection.client?.end?.().catch(() => {}); } catch { /* already disconnected */ }
  }
  private client(): PgConnection {
    if (this.connection) return this.connection;
    const connection: PgConnection = { ready: undefined!, failed: false };
    this.connection = connection;
    connection.ready = (async () => {
      let client: PgClient;
      if (this.connect) client = await this.connect();
      else {
        // @ts-expect-error pg is runtime-only on hosted deployments
        const pg = await import(/* webpackIgnore: true */ "pg");
        client = new pg.Client({ connectionString: this.url });
      }
      connection.client = client;
      // pg emits idle connection errors outside query promises. Keep a listener
      // on discarded clients too, so a late error cannot terminate the server.
      client.on?.("error", () => this.discard(connection));
      if (!this.connect) await (client as PgClient & { connect(): Promise<void> }).connect();
      await client.query("CREATE TABLE IF NOT EXISTS perps_intro_seen (owner TEXT PRIMARY KEY, claimed_at BIGINT NOT NULL)");
      if (connection.failed) throw new Error("Intro storage connection was lost");
      return client;
    })().catch(error => { this.discard(connection); throw error; });
    return connection;
  }
  async claim(owner: string): Promise<boolean> {
    const key = ownerKey(owner), connection = this.client();
    try {
      const client = await connection.ready;
      const result = await client.query("INSERT INTO perps_intro_seen (owner, claimed_at) VALUES ($1, $2) ON CONFLICT (owner) DO NOTHING RETURNING owner", [key, Date.now()]);
      return result.rows.length === 1;
    } catch (error) {
      this.discard(connection);
      // The insert may have committed before transport failed. Fail this claim;
      // only a later request may reconnect and ask the atomic insert again.
      throw error;
    }
  }
}

let cached: PerpsIntroStore | null = null;
export function getPerpsIntroStore(): PerpsIntroStore {
  return cached ??= process.env.DATABASE_URL ? new PgPerpsIntroStore(process.env.DATABASE_URL) : new FilePerpsIntroStore();
}
export function resetPerpsIntroStoreForTest(): void { cached = null; }
