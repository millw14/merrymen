/**
 * AN AGENT'S OWN FACE AND BANNER — the bytes an owner uploaded.
 *
 * ── WHY THIS IS ITS OWN TABLE, NOT A COLUMN SOMEWHERE ────────────────────
 *
 * The identity store is the right KEY and the wrong TABLE. It is keyed on the
 * tenant (which is what we want — a slug survives a re-grant because the
 * identity does), it is deliberately unsealed because its contents are public,
 * and adding a column there would be one line. But every reader of that table
 * does `SELECT *`, and `all()` is called per request by the public feed and
 * the leaderboard to map accounts to slugs. A megabyte of image bytes on that
 * row means every one of those reads drags both images across the wire for
 * every agent in the fleet, to render a name.
 *
 * So: same key, same backends, same unsealed reasoning, separate table, and
 * the bytes are only ever read by the one route that serves them.
 *
 * ── AND NOT THE SETTINGS STORE, WHICH IS THE TEMPTING WRONG ANSWER ───────
 *
 * `PgSettingsStore` seals its whole JSON blob under `MERRYMEN_STORE_DEK` — the
 * same key that protects grants — and `put` REPLACES the blob. Putting an
 * avatar there would mean a public page cannot render a face without the key
 * that decrypts money, base64 would inflate the blob the orchestrator hands
 * every child on every settings read, and a concurrent settings write would
 * drop the image or vice versa. Three separate reasons, any one of them fatal.
 *
 * ── WHAT IS DELIBERATELY NOT SEALED ──────────────────────────────────────
 *
 * Nothing here is secret. It is a picture the owner chose to put on a public
 * profile. `identity-store.ts` makes the same argument about slugs and handles
 * and says "do not fix"; sealing public data implies a confidentiality it does
 * not have, and buys a dependency on the money DEK for a page anybody can load.
 *
 * NODE-ONLY (node:fs, pg). Imported by the web API routes and nothing in the
 * browser bundle.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { merrymenHome } from "./home";

/**
 * The two kinds, closed.
 *
 * A closed union rather than a free string because it is a path segment on a
 * public route and a primary-key component: an open one is a directory
 * traversal and an unbounded row count wearing the same clothes.
 */
export const IMAGE_KINDS = ["avatar", "banner"] as const;
export type ImageKind = (typeof IMAGE_KINDS)[number];

export function isImageKind(v: unknown): v is ImageKind {
  return typeof v === "string" && (IMAGE_KINDS as readonly string[]).includes(v);
}

export interface StoredImage {
  bytes: Uint8Array;
  contentType: string;
  /**
   * Of the STORED bytes, not the upload.
   *
   * It is the cache key the public URL carries, so it has to identify what a
   * reader will actually receive. Hashing the upload would produce a new URL
   * for a re-encode that changed nothing, and — worse — the same URL for two
   * different uploads that happen to normalise identically, which is the
   * direction that serves a stale image.
   */
  sha256: string;
  updatedAt: number;
}

export interface ImageStore {
  get(tenant: `0x${string}`, kind: ImageKind): Promise<StoredImage | null>;
  put(tenant: `0x${string}`, kind: ImageKind, image: Omit<StoredImage, "updatedAt">): Promise<void>;
  remove(tenant: `0x${string}`, kind: ImageKind): Promise<void>;
  /** Forget both images a tenant owns (on kill). */
  removeTenant(tenant: `0x${string}`): Promise<void>;
}

export function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const now = () => Math.floor(Date.now() / 1000);

// ── file backend ─────────────────────────────────────────────────────────────

/**
 * Two files per image: the bytes, and a sidecar naming their type.
 *
 * The alternative — encoding the content type into the extension — looks
 * simpler and loses the distinction between "no image" and "an image whose
 * type we cannot name", which is exactly the kind of collapse this codebase
 * keeps paying for. A sidecar that is missing means the record is incomplete,
 * and an incomplete record reads as absent rather than as a guess.
 */
export class FileImageStore implements ImageStore {
  private dir = path.join(merrymenHome(), "agent-image");
  private base(tenant: string, kind: ImageKind) {
    return path.join(this.dir, `${tenant.toLowerCase()}.${kind}`);
  }
  async get(tenant: `0x${string}`, kind: ImageKind): Promise<StoredImage | null> {
    try {
      const bytes = new Uint8Array(await readFile(this.base(tenant, kind)));
      const meta = JSON.parse(await readFile(`${this.base(tenant, kind)}.json`, "utf8")) as {
        contentType?: string;
        sha256?: string;
        updatedAt?: number;
      };
      if (typeof meta.contentType !== "string" || typeof meta.sha256 !== "string") return null;
      return {
        bytes,
        contentType: meta.contentType,
        sha256: meta.sha256,
        updatedAt: Number(meta.updatedAt) || 0,
      };
    } catch {
      return null;
    }
  }
  async put(tenant: `0x${string}`, kind: ImageKind, image: Omit<StoredImage, "updatedAt">): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const base = this.base(tenant, kind);
    // BYTES FIRST, SIDECAR SECOND. A crash between the two leaves bytes with no
    // sidecar, which `get` reads as absent — the safe direction. The other
    // order would leave a sidecar promising bytes that are not there.
    await writeFile(base, image.bytes, { mode: 0o600 });
    await writeFile(
      `${base}.json`,
      JSON.stringify({ contentType: image.contentType, sha256: image.sha256, updatedAt: now() }),
      { encoding: "utf8", mode: 0o600 },
    );
  }
  async remove(tenant: `0x${string}`, kind: ImageKind): Promise<void> {
    const base = this.base(tenant, kind);
    // SIDECAR FIRST on the way out, for the same reason: the moment it is gone
    // the record reads as absent, whatever happens to the bytes after.
    await rm(`${base}.json`, { force: true });
    await rm(base, { force: true });
  }
  async removeTenant(tenant: `0x${string}`): Promise<void> {
    for (const kind of IMAGE_KINDS) await this.remove(tenant, kind);
  }
}

// ── postgres backend ─────────────────────────────────────────────────────────

interface PgClientLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export class PgImageStore implements ImageStore {
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
          // The CHECK is the same closed union as the TypeScript one. Two
          // spellings of one rule, and the database's copy is the one that
          // survives a caller that skipped the type.
          `CREATE TABLE IF NOT EXISTS agent_image (
             tenant TEXT NOT NULL,
             kind TEXT NOT NULL CHECK (kind IN ('avatar', 'banner')),
             bytes BYTEA NOT NULL,
             content_type TEXT NOT NULL,
             sha256 TEXT NOT NULL,
             updated_at BIGINT NOT NULL,
             PRIMARY KEY (tenant, kind)
           )`,
        );
        return c;
      })();
    }
    return this.ready;
  }
  async get(tenant: `0x${string}`, kind: ImageKind): Promise<StoredImage | null> {
    const c = await this.client();
    const { rows } = await c.query(
      `SELECT bytes, content_type, sha256, updated_at FROM agent_image WHERE tenant = $1 AND kind = $2`,
      [tenant.toLowerCase(), kind],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      bytes: new Uint8Array(r.bytes as Buffer),
      contentType: String(r.content_type),
      sha256: String(r.sha256),
      updatedAt: Number(r.updated_at) || 0,
    };
  }
  async put(tenant: `0x${string}`, kind: ImageKind, image: Omit<StoredImage, "updatedAt">): Promise<void> {
    const c = await this.client();
    await c.query(
      `INSERT INTO agent_image (tenant, kind, bytes, content_type, sha256, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant, kind) DO UPDATE SET
         bytes = excluded.bytes,
         content_type = excluded.content_type,
         sha256 = excluded.sha256,
         updated_at = excluded.updated_at`,
      [tenant.toLowerCase(), kind, Buffer.from(image.bytes), image.contentType, image.sha256, now()],
    );
  }
  async remove(tenant: `0x${string}`, kind: ImageKind): Promise<void> {
    const c = await this.client();
    await c.query(`DELETE FROM agent_image WHERE tenant = $1 AND kind = $2`, [tenant.toLowerCase(), kind]);
  }
  async removeTenant(tenant: `0x${string}`): Promise<void> {
    const c = await this.client();
    await c.query(`DELETE FROM agent_image WHERE tenant = $1`, [tenant.toLowerCase()]);
  }
}

let cached: ImageStore | null = null;
export function getImageStore(): ImageStore {
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  cached = url ? new PgImageStore(url) : new FileImageStore();
  return cached;
}

/** Test seam: drop the cached store so a test can change the environment. */
export function resetImageStoreForTest(): void {
  cached = null;
}
