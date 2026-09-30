import { TOUR_VERSION } from "./tour-version";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

/**
 * THE ONE FACT THIS STORE KEEPS: this owner has been shown around, and must not
 * be interrupted by the tour again.
 *
 * Everything here is about that promise surviving the ways it could quietly
 * break — a second press, a re-read, a store that will not answer.
 *
 * The file backend is the one under test because it is the one that runs
 * without Postgres. The Pg backend is the same interface over the same
 * semantics; its `ON CONFLICT DO NOTHING` is the SQL spelling of the
 * keep-the-first-timestamp rule proved below.
 */

let dir = "";
let saved: string | undefined;
let FileTourStore: typeof import("./tour-store").FileTourStore;

const A = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa" as const;
const B = "0xBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBb" as const;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "merrymen-tour-"));
  saved = process.env.MERRYMEN_HOME;
  process.env.MERRYMEN_HOME = dir;
  ({ FileTourStore } = await import("./tour-store"));
});

after(async () => {
  if (saved === undefined) delete process.env.MERRYMEN_HOME;
  else process.env.MERRYMEN_HOME = saved;
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

describe("who has already been shown around", () => {
  it("new tour versions do not inherit old dismissals in either store", async () => {
    const old = new FileTourStore(2), next = new FileTourStore(3);
    const tenant = "0x1111111111111111111111111111111111111111" as const;
    await old.markDone(tenant);
    assert.equal(await next.done(tenant), false);
    await next.markDone(tenant);
    assert.equal(await old.done(tenant), true);
    assert.equal(await next.done(tenant), true);

    // Exercise both real Pg store methods through the connection seam. No
    // hosted database or account is contacted by this test.
    const { PgTourStore } = await import("./tour-store");
    const records = new Set<string>();
    const connect = async () => ({ query: async (sql: string, params?: unknown[]) => {
      const key = String(params?.[0]);
      if (sql.startsWith("INSERT")) records.add(key);
      return { rows: sql.startsWith("SELECT") && records.has(key) ? [{}] : [] };
    } });
    const pgOld = new PgTourStore("unused", 2, connect), pgNext = new PgTourStore("unused", 3, connect);
    await pgOld.markDone(tenant);
    assert.equal(await pgNext.done(tenant), false);
    await pgNext.markDone(tenant);
    assert.equal(await pgOld.done(tenant), true);
    assert.equal(await pgNext.done(tenant), true);
    assert.deepEqual([...records], [tenant, `${tenant}.v3`]);
  });

  it("allows retry after the initial hosted store connection failed", async () => {
    const { PgTourStore } = await import("./tour-store");
    let attempts = 0;
    const s = new PgTourStore("unused", 2, async () => {
      if (++attempts === 1) throw new Error("temporarily offline");
      return { query: async () => ({ rows: [] }) };
    });
    await assert.rejects(s.done(A), /temporarily offline/);
    assert.equal(await s.done(A), false);
    assert.equal(attempts, 2);
  });
  it("nobody has, until they have", async () => {
    const s = new FileTourStore();
    assert.equal(await s.done(A), false);
  });

  it("ABSENT MEANS NOT YET SEEN, which is what makes a new tour reach everyone once", async () => {
    // There is no migration and no backfill: a tour nobody has a row for is a
    // tour nobody has seen. That is the whole mechanism behind showing a
    // rewritten tour to the entire user base exactly one time.
    const s = new FileTourStore();
    assert.equal(await s.done(B), false);
  });

  it("marking it done is remembered", async () => {
    const s = new FileTourStore();
    await s.markDone(A);
    assert.equal(await s.done(A), true);
  });

  it("and it is remembered by a FRESH store, not just this instance", async () => {
    // The real read happens in a different request, in a different process.
    // An in-memory cache that happened to hold the answer would pass a weaker
    // version of this test and fail in production.
    assert.equal(await new FileTourStore().done(A), true);
  });

  it("one owner's dismissal is not another's", async () => {
    assert.equal(await new FileTourStore().done(B), false);
  });

  it("the address is matched case-insensitively, because a wallet is not a string", async () => {
    // Tenants arrive checksummed from one path and lowercased from another.
    // Keying on the literal bytes would show the tour again to somebody whose
    // session simply spelled their address differently.
    const s = new FileTourStore();
    assert.equal(await s.done(A.toLowerCase() as `0x${string}`), true);
    assert.equal(await s.done(A.toUpperCase().replace("0X", "0x") as `0x${string}`), true);
  });

  it("PRESSING SKIP TWICE IS ONE DISMISSAL, and keeps the first moment", async () => {
    // The interesting number is when they first stopped wanting it. A second
    // press must not rewrite that, which is also why the Postgres backend says
    // ON CONFLICT DO NOTHING rather than DO UPDATE.
    const s = new FileTourStore();
    const c = "0xCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCc" as const;
    await s.markDone(c);
    const first = await readDoneAt(c);
    await new Promise((r) => setTimeout(r, 5));
    await s.markDone(c);
    assert.equal(await readDoneAt(c), first, "a second skip rewrote the first one");
  });

  it("clearing it puts the tour back, which is what a kill has to do", async () => {
    const s = new FileTourStore();
    await s.clear(A);
    assert.equal(await s.done(A), false);
  });

  it("clearing something that was never set is not an error", async () => {
    await new FileTourStore().clear("0xdEaDdEaDdEaDdEaDdEaDdEaDdEaDdEaDdEaDdEaD");
  });

  it("A FILE WE CANNOT READ IS 'NOT YET', NEVER A THROW", async () => {
    // Showing a tour one extra time is the cheap direction to be wrong in; a
    // rejected promise here would surface as a broken page for everybody whose
    // record happened to be unreadable.
    const { writeFile } = await import("node:fs/promises");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.join(dir, "tour"), { recursive: true });
    const junk = "0xEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEeEe" as const;
    await writeFile(path.join(dir, "tour", `${junk.toLowerCase()}${Number(TOUR_VERSION) === 2 ? "" : `.v${TOUR_VERSION}`}.json`), "{ not json");
    assert.equal(await new FileTourStore().done(junk), false);
  });

  it("and neither is a record whose shape is wrong", async () => {
    const { writeFile } = await import("node:fs/promises");
    const odd = "0xFfFfFfFfFfFfFfFfFfFfFfFfFfFfFfFfFfFfFfFf" as const;
    await writeFile(path.join(dir, "tour", `${odd.toLowerCase()}${Number(TOUR_VERSION) === 2 ? "" : `.v${TOUR_VERSION}`}.json`), JSON.stringify({ doneAt: "yesterday" }));
    assert.equal(await new FileTourStore().done(odd), false);
  });
});

async function readDoneAt(tenant: string): Promise<number> {
  const { readFile } = await import("node:fs/promises");
  const raw = JSON.parse(await readFile(path.join(dir, "tour", `${tenant.toLowerCase()}${Number(TOUR_VERSION) === 2 ? "" : `.v${TOUR_VERSION}`}.json`), "utf8")) as {
    doneAt: number;
  };
  return raw.doneAt;
}
