/**
 * WHAT BOTH /api/x/* ROUTE TESTS STAND ON: a hosted environment with a real
 * session secret and DEK, the X-posting tables on an in-memory sqlite through
 * the ledger's own driver, and an X that answers from a script and writes down
 * every request it was sent.
 *
 * Test-only, imported by nothing that ships. It is a file of its own rather
 * than a copy in each test because "what X was asked" is the assertion that
 * matters most here — the code must not be redeemed for the wrong owner, and
 * a token must never be sent anywhere but X — and two copies of the recorder
 * could disagree about what counts as a call.
 */
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mintSession, SESSION_COOKIE } from "@/lib/auth";
import { setXpostForTest } from "@/lib/x-connect";
import { wrapSqlite, type Db } from "../../../worker/src/db";
import {
  X_ME_URL,
  X_REVOKE_URL,
  X_TOKEN_URL,
  type FetchLike,
} from "../../../worker/src/xpost/client";
import { ensureXpostSchema } from "../../../worker/src/xpost/store";

export const ORIGIN = "https://app.merrymen.test";
export const OWNER_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
export const OWNER_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" as const;

/** The X app a test runs against. Its callback is built from the public origin. */
export const APP_ENV: Record<string, string> = {
  MERRYMEN_X_CLIENT_ID: "test-client-id",
  MERRYMEN_X_CLIENT_SECRET: "test-client-secret",
  MERRYMEN_PUBLIC_ORIGIN: ORIGIN,
};

/** What X hands out when a script does not say otherwise. Distinctive, so a leak is findable. */
export const X_ACCESS = "ACCESS-TOKEN-a1b2c3d4e5f6-never-shown";
export const X_REFRESH = "REFRESH-TOKEN-f6e5d4c3b2a1-never-shown";
export const X_USER = { id: "1234567890", username: "merry_poster" } as const;

export interface XCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

export interface XAnswer {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** An X whose three endpoints answer from `answers`, recording every request. */
export function scriptedX() {
  const calls: XCall[] = [];
  const answers: { token: XAnswer; me: XAnswer; revoke: XAnswer } = {
    token: {
      status: 200,
      body: {
        token_type: "bearer",
        access_token: X_ACCESS,
        refresh_token: X_REFRESH,
        expires_in: 7200,
        scope: "tweet.read tweet.write users.read offline.access",
      },
    },
    me: { status: 200, body: { data: { ...X_USER, name: "Merry" } } },
    revoke: { status: 200, body: { revoked: true } },
  };
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: init.body ?? "" });
    const a =
      url === X_TOKEN_URL ? answers.token : url === X_ME_URL ? answers.me : url === X_REVOKE_URL ? answers.revoke : null;
    if (!a) throw new Error(`unscripted X call to ${url}`);
    const text = typeof a.body === "string" ? a.body : JSON.stringify(a.body);
    return { status: a.status, headers: { get: (n: string) => a.headers?.[n.toLowerCase()] ?? null }, text: async () => text };
  };
  return {
    fetch,
    calls,
    answers,
    to: (url: string) => calls.filter((c) => c.url === url),
  };
}

const SAVED_KEYS = [
  "MERRYMEN_HOSTED",
  "MERRYMEN_SESSION_SECRET",
  "MERRYMEN_STORE_DEK",
  "DATABASE_URL",
  "MERRYMEN_X_CLIENT_ID",
  "MERRYMEN_X_CLIENT_SECRET",
  "MERRYMEN_X_REDIRECT_URI",
  "MERRYMEN_PUBLIC_ORIGIN",
] as const;

/**
 * A hosted world for one test. `close()` puts the process back as it was:
 * the seam off, the database closed and every variable restored.
 */
export async function xWorld(opts: { start?: number } = {}) {
  const saved = Object.fromEntries(SAVED_KEYS.map((k) => [k, process.env[k]]));
  process.env.MERRYMEN_HOSTED = "1";
  process.env.MERRYMEN_SESSION_SECRET = "x-routes-test-secret-at-least-32-characters-long";
  const dek = randomBytes(32);
  process.env.MERRYMEN_STORE_DEK = dek.toString("base64");
  delete process.env.DATABASE_URL;
  // The app comes from the seam's env; the process has none, so a route that
  // read process.env instead would find the feature unavailable and say so.
  for (const k of ["MERRYMEN_X_CLIENT_ID", "MERRYMEN_X_CLIENT_SECRET", "MERRYMEN_X_REDIRECT_URI", "MERRYMEN_PUBLIC_ORIGIN"]) {
    delete process.env[k];
  }
  const raw = new DatabaseSync(":memory:");
  const db: Db = wrapSqlite(raw);
  await ensureXpostSchema(db, "sqlite");
  const x = scriptedX();
  const clock = { now: opts.start ?? 1_800_000_000_000 };
  const env: Record<string, string | undefined> = { ...APP_ENV };
  setXpostForTest({ db, fetch: x.fetch, now: () => clock.now, env });
  return {
    db,
    raw,
    dek,
    x,
    clock,
    env,
    close() {
      setXpostForTest(null);
      try {
        raw.close();
      } catch {
        /* a test closed it on purpose */
      }
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    },
  };
}

/** The session cookie header for `tenant`, or none. */
export function sessionHeaders(tenant: `0x${string}` | null): Record<string, string> {
  return tenant ? { cookie: `${SESSION_COOKIE}=${mintSession(tenant)}` } : {};
}

/** A JSON request to `path` as `tenant`. A string body is sent as it is. */
export function jsonRequest(path: string, method: string, tenant: `0x${string}` | null, body?: unknown): Request {
  return new Request(`${ORIGIN}${path}`, {
    method,
    headers: { "content-type": "application/json", ...sessionHeaders(tenant) },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
}
