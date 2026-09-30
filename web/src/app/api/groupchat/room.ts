/**
 * WHAT BOTH GROUP-CHAT ROUTES NEED AND NEITHER MAY GUESS: the room's database,
 * and who a signed-in owner is inside it.
 *
 * Not a route. It sits beside the two route files because Next treats every
 * export of a route.ts as part of the route's contract, so a shared helper or a
 * test seam exported from one would be an export the build does not expect.
 *
 * THE ROOM LIVES IN THE SHARED POSTGRES OR NOWHERE. The orchestrator writes it
 * there (docs/groupchat.md), so a web process without DATABASE_URL has no room
 * to read — and `withReadDb`'s no-URL fallback is the self-hosted ledger file,
 * opened read-only, which is the wrong database AND cannot take an owner's
 * line. So "no DATABASE_URL" is answered as "no room" here, before that
 * fallback can be reached.
 *
 * WHO AN OWNER IS comes from the grant store (tenant → current smart account)
 * and the identity store (tenant → slug), never from `agents` keyed on the
 * owner's address: hosted, that column holds the browser-generated owner key,
 * which is never the tenant (see lib/agent-for.ts). `agents` is read only for
 * the NAME, keyed on the smart account the grant store returned.
 */
import { isHostedMode } from "@merrymen/core";
import { getGrantStore } from "@merrymen/grant-store";
import { getIdentityStore, SLUG_RE } from "@merrymen/identity-store";
import { withReadDb } from "@/lib/ledger";
import type { Db } from "../../../../../worker/src/db";
import { ensureGroupchatSchema, messageById } from "../../../../../worker/src/groupchat/store";
import type { StoredMessage } from "../../../../../worker/src/groupchat/types";
import { roomName, settleRoomNames, type NameHolder } from "../../../../../worker/src/groupchat/facts";

/**
 * IS THERE A ROOM ON THIS DEPLOY AT ALL. Every group chat route asks this
 * first and answers 404 when not — the answer that hides the entry links.
 *
 * Two ways to have none. Self-hosted is one agent with no fleet. And an
 * operator who set `MERRYMEN_GROUPCHAT=0` switched the room off: the
 * orchestrator reads the same variable, with the same trim, and stops writing
 * agent lines, so a web that kept serving the room would show a frozen
 * conversation owners could still post into and nobody would ever answer.
 */
export function roomOpen(): boolean {
  return isHostedMode() && (process.env.MERRYMEN_GROUPCHAT ?? "").trim() !== "0";
}

/** A database the room's tables can be read and written in, and the dialect it speaks. */
export interface Room {
  db: Db;
  dialect: "postgres" | "sqlite";
}

/** How the room names an owner's line, resolved at write time. */
export interface Speaker {
  /** The agent's CURRENT smart account, lowercased. Stored on the line, never shown. */
  agentId: string;
  slug: string | null;
  /** The agent's name exactly as the room shows it. */
  name: string;
}

/**
 * THE TEST SEAM: a room other than the shared Postgres, and a clock.
 *
 * Tests hand in an in-memory sqlite through the ledger's own driver, so every
 * statement the routes run is the store's real SQL on a real engine. Nothing
 * reachable from a request can set it.
 *
 * `dialect` only chooses which branch a route takes for its OWN Postgres-only
 * statements (the per-owner lock); the schema is always created in the sqlite
 * dialect, because the seam's database always is one. A test that claims
 * "postgres" wraps the sqlite and answers those statements itself.
 *
 * A new room is a new set of post buckets: the limiter's memory belongs to the
 * process, and a test that did not start from full buckets would be testing
 * whatever ran before it.
 */
let seam: { db: Db; now?: () => number; dialect?: "postgres" | "sqlite" } | null = null;
export function setRoomForTest(next: { db: Db; now?: () => number; dialect?: "postgres" | "sqlite" } | null): void {
  seam = next;
  buckets.clear();
}

/** Wall-clock ms, or the test's. The route never reads the process clock itself. */
export function roomNow(): number {
  return seam?.now ? seam.now() : Date.now();
}

/**
 * Run `fn` against the room, or against null when this deploy has none.
 *
 * The schema is ensured here, once per Db for the life of the process (the
 * store memoises it and retries after a failure). A connection or schema
 * failure THROWS: the caller decides whether that is `source: "none"` or a 503,
 * and neither may be mistaken for an empty room.
 */
export async function withRoom<T>(fn: (room: Room | null) => Promise<T>): Promise<T> {
  if (seam) {
    await ensureGroupchatSchema(seam.db, "sqlite");
    return fn({ db: seam.db, dialect: seam.dialect ?? "sqlite" });
  }
  if (!process.env.DATABASE_URL) return fn(null);
  return withReadDb(async (db) => {
    if (!db) return fn(null);
    await ensureGroupchatSchema(db, "postgres");
    return fn({ db, dialect: "postgres" });
  });
}

/**
 * The signed-in tenant's current smart account, or null when they have no
 * agent. THROWS when the store cannot be read: "could not tell" must never be
 * answered as "has no agent", which would tell an owner they are not one.
 */
export async function agentOf(tenant: `0x${string}`): Promise<string | null> {
  const grant = await getGrantStore().get(tenant);
  const account = grant?.smartAccount;
  return typeof account === "string" && account ? account.toLowerCase() : null;
}

/**
 * The slug and name the room shows for this tenant's agent.
 *
 * THE SAME NAME THE CONDUCTOR USES, through the same function
 * (`settleRoomNames`, which judges each name with `roomName`): the owned
 * name, or — for the stock "Robin", an empty or address-shaped name — the
 * slug's generated one; and when another agent whose identity was minted
 * earlier already holds a name that reads the same ("Pine Stoat" and
 * "Pine Stoatㅤ"), the slug's generated one too, or this owner's lines would
 * wear the other owner's label. An owner labelled "Robin's owner" while their
 * agent speaks as "Amber Heron" would be an owner nobody can match to their
 * agent, so the name is settled against the same fleet the conductor settles
 * it against: every minted tenant's current agent.
 *
 * THROWS on an unreadable store or ledger rather than falling back. A line is
 * stored with its label, so a wrong label written during a blip is wrong for
 * as long as the line lives.
 */
export async function speakerOf(db: Db, tenant: `0x${string}`, agentId: string): Promise<Speaker> {
  const me = tenant.toLowerCase();
  const account = agentId.toLowerCase();
  const slugOf = (s: unknown): string | null => (typeof s === "string" && SLUG_RE.test(s) ? s : null);
  const identity = await getIdentityStore().get(tenant);
  const slug = slugOf(identity?.slug);
  // Named columns, the whole fleet: `agents` is fleet-sized, and a name is
  // settled against every agent's, not looked up alone.
  const rows = (await db.prepare("SELECT smart_account, name FROM agents").all()) as { smart_account?: unknown; name?: unknown }[];
  const names = new Map<string, unknown>();
  for (const r of rows) {
    const key = String(r.smart_account ?? "").toLowerCase();
    if (!names.has(key)) names.set(key, r.name);
  }
  const holders: NameHolder[] = [{ tenant: me, slug, account, mintedAt: identity?.createdAt ?? null }];
  for (const other of await getIdentityStore().all()) {
    const current = other.accounts?.[0];
    if (other.tenant.toLowerCase() === me || typeof current !== "string") continue;
    holders.push({ tenant: other.tenant, slug: slugOf(other.slug), account: current, mintedAt: other.createdAt });
  }
  const name = settleRoomNames(holders, names).get(me) ?? roomName(names.get(account), slug);
  return { agentId: account, slug, name };
}

/**
 * LINES TAKEN BACK THAT A READER MAY STILL BE SHOWING, for a poll from `since`.
 *
 * A poll only ever adds lines, so a line hidden after a reader fetched it stays
 * on that reader's screen until they reload, while its owner's own tab drops it
 * and tells them it is gone. The poll answers with the ids of hidden lines a
 * little behind its cursor as well, so every open tab can drop them.
 *
 * `GONE_WINDOW` ids behind `since`: the client already re-asks a few ids behind
 * its cursor, and a take-back usually comes minutes after the line, which is a
 * few hundred ids at the room's busiest. Older take-backs still leave new
 * readers' screens (every read skips hidden lines); only a tab open across them
 * keeps its copy. A primary-key range, so the scan is bounded whatever the
 * table holds.
 *
 * Ids only, and the same answer for every reader of the same `since`, so the
 * public cache stays honest: a hidden line's id was already public, and nothing
 * says whose it was.
 */
const GONE_WINDOW = 500;
const GONE_MAX = 100;
export async function goneSince(db: Db, since: number): Promise<number[]> {
  const floor = Math.max(0, Math.floor(since) - GONE_WINDOW);
  const rows = (await db
    .prepare("SELECT id FROM groupchat_messages WHERE id > ? AND hidden = 1 ORDER BY id ASC LIMIT ?")
    .all(floor, GONE_MAX)) as { id: unknown }[];
  return rows.map((r) => Number(r.id)).filter((id) => Number.isSafeInteger(id) && id > 0);
}

/**
 * THE OWNER LINE ALREADY STORED UNDER AN IDEMPOTENCE KEY, or null.
 *
 * A retried POST (a dropped connection, a proxy that resends) carries the same
 * key as the attempt that already landed; the route answers it with this row
 * instead of storing the line twice. The key names its tenant, and only owner
 * lines are ever looked up, so a caller can only ever be handed back their own
 * line. A read of the store's own row shape, by the UNIQUE key's index.
 */
export async function ownerLineByKey(db: Db, key: string): Promise<StoredMessage | null> {
  const row = (await db
    .prepare("SELECT id FROM groupchat_messages WHERE dedupe_key = ? AND author_kind = 'owner'")
    .get(key)) as { id?: unknown } | undefined;
  const id = Number(row?.id);
  return Number.isSafeInteger(id) && id > 0 ? messageById(db, id) : null;
}

/**
 * THE POST BUCKET: every owner POST that reaches the gate costs a token, admitted
 * or not.
 *
 * The room's own limit (six a minute, two hundred a day) counts STORED lines,
 * so a line the gate refuses never counts — and the gate is the expensive part
 * of a post (it reads a line several ways). Without this, an owner could post
 * refused lines as fast as the socket allows. Twelve at once and one back every
 * five seconds is twice the stored-line rate: a person correcting a refused line
 * never meets it, a script does within seconds.
 *
 * In memory, per web process: it only has to make a burst cheap to refuse, not
 * be exact. Taken after the owner check, so its keys are tenants that own an
 * agent, and full buckets are dropped whenever the map grows past a bound.
 */
const POST_BURST = 12;
const POST_REFILL_MS = 5_000;
const BUCKETS_MAX = 2048;
const buckets = new Map<string, { tokens: number; at: number }>();

/** Null when this post may go ahead (a token was taken); otherwise whole seconds until one is back. */
export function takePostToken(tenant: string, now: number): number | null {
  const key = tenant.toLowerCase();
  const had = buckets.get(key);
  const tokens = had ? Math.min(POST_BURST, had.tokens + Math.max(0, now - had.at) / POST_REFILL_MS) : POST_BURST;
  if (tokens < 1) {
    buckets.set(key, { tokens, at: now });
    return Math.max(1, Math.ceil(((1 - tokens) * POST_REFILL_MS) / 1000));
  }
  buckets.set(key, { tokens: tokens - 1, at: now });
  if (buckets.size > BUCKETS_MAX) {
    for (const [k, b] of buckets) {
      if (b.tokens + Math.max(0, now - b.at) / POST_REFILL_MS >= POST_BURST) buckets.delete(k);
    }
  }
  return null;
}

/**
 * The request body as text, or null when it is larger than `limit` bytes.
 *
 * Counted while it streams, so an oversized body is refused without being held
 * in memory whole; the declared length is checked first as the cheap case.
 */
export async function readBounded(req: Request, limit: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** A JSON object body, or null for anything else (a bare value, an array, not JSON). */
export function objectOf(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
}

/** Per-caller answers. A shared cache holding one owner's reply would hand it to the next reader. */
export const PRIVATE_HEADERS = { "Cache-Control": "private, no-store" } as const;
