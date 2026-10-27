/**
 * A KILL THAT LANDS WHILE A PERPS SAVE IS ON ITS WAY IS NEVER UNDONE BY IT.
 *
 * The kill turns the Perps wallet's `perpsEnabled` off in the same blob the
 * settings PUT writes, and takes no save lock: hosted, disablePaperPerpsForKill
 * (settings-store.ts); self-hosted, turnOffLocalPaperPerps (perps-kill.ts). A
 * save that read before the kill and wrote its whole blob back after it put
 * practice perps back ON under a kill that had answered "disabled", so the next
 * Perps permission signed on the same index-1 account traded practice perps
 * nobody had turned back on. Every Perps write is now a compare and swap
 * against the blob that save read, judged afresh from a new read when it misses.
 *
 * Driven through the real PUT and the real kill, the kill placed exactly
 * between the save's read and its write:
 *   - hosted, on the file store and on the Postgres store's own SQL (run on
 *     sqlite, as holder/route.test.ts runs it), at MERRYMEN_PERPS=paper;
 *   - hosted, where Perps are not offered, for a save that only turns
 *     something off (the one save allowed there, D1);
 *   - self-hosted, the kill run at every event-loop turn the save could yield.
 * A save that names `perpsEnabled: true` over an off that landed under it is
 * refused; one that never names it keeps the kill's off.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";

import type { MerrymenSettings } from "@merrymen/core";
import { mintSession } from "@/lib/auth";
import {
  PgSettingsStore,
  disablePaperPerpsForKill,
  getSettingsStore,
  resetSettingsStoreForTest,
  useSettingsStoreForTest,
  type FileSettingsStore,
  type VersionedSettings,
} from "@merrymen/settings-store";
import { purposeHome } from "@merrymen/home";
import { turnOffLocalPaperPerps } from "../../../../../worker/src/perps-kill";
import { mergeSettings } from "../../../../../worker/src/settings";

const OWNER = `0x${"ab".repeat(20)}` as const;
const KEYS = ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_SESSION_SECRET", "DATABASE_URL", "MERRYMEN_PERPS", "MERRYMEN_STORE_DEK"] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let home: string;
let PUT: (r: Request) => Promise<Response>;

before(async () => {
  home = mkdtempSync(path.join(tmpdir(), "mm-perps-kill-race-"));
  process.env.MERRYMEN_HOME = home;
  process.env.MERRYMEN_SESSION_SECRET = randomBytes(32).toString("hex");
  process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 5).toString("base64");
  delete process.env.DATABASE_URL;
  ({ PUT } = await import("./route"));
});
beforeEach(() => {
  process.env.MERRYMEN_HOSTED = "1";
  process.env.MERRYMEN_PERPS = "paper";
  resetSettingsStoreForTest();
  for (const d of ["tenant-settings-perps", "accounts"]) rmSync(path.join(home, d), { recursive: true, force: true });
});
afterEach(() => resetSettingsStoreForTest());
after(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const save = async (body: Record<string, unknown>, hosted = true) => {
  const res = await PUT(
    new Request("https://app.example.test/api/settings?wallet=perps", {
      method: "PUT",
      headers: { "content-type": "application/json", ...(hosted ? { cookie: `mm_session=${mintSession(OWNER)}` } : {}) },
      body: JSON.stringify(hosted ? { ...body, owner: OWNER } : body),
    }),
  );
  return { status: res.status, body: (await res.json()) as { ok?: boolean; errors?: string[]; saved?: string[] } };
};
/** What a Perps worker resolves from a stored blob (worker settings.ts). */
const worker = (s: MerrymenSettings) => mergeSettings(s, { MERRYMEN_WALLET_PURPOSE: "perps", MERRYMEN_PERPS: "paper" });

type Versioned = { getVersioned(tenant: `0x${string}`): Promise<VersionedSettings> };
/**
 * The real kill, run once, right after the save's read returns and before it
 * writes: the order in which a save that does not compare loses the kill.
 * Says what the kill answered.
 */
function killAfterTheSavesRead(store: Versioned & object): () => string | null {
  const real = store.getVersioned.bind(store);
  let killed: string | null = null;
  Object.assign(store, {
    getVersioned: async (tenant: `0x${string}`) => {
      const read = await real(tenant);
      delete (store as Partial<Versioned>).getVersioned; // the kill, and every read after it, read for real
      killed = await disablePaperPerpsForKill(OWNER, store as never);
      return read;
    },
  });
  return () => killed;
}

/** sqlite standing in for Postgres: `$n` → `?n`, rows from anything that returns them, and to_regclass as sqlite says it. */
function sqliteClient() {
  const db = new DatabaseSync(":memory:");
  return {
    async query(sql: string, params: unknown[] = []) {
      await new Promise((r) => setImmediate(r));
      if (/to_regclass/.test(sql)) {
        const found = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(String(params[0]));
        return { rows: [{ found: found !== undefined }] };
      }
      const stmt = db.prepare(sql.replace(/\$(\d+)/g, "?$1"));
      if (/^\s*SELECT|RETURNING/i.test(sql)) return { rows: stmt.all(...(params as string[])) as Record<string, unknown>[] };
      stmt.run(...(params as string[]));
      return { rows: [] };
    },
  };
}

for (const backend of ["file store", "Postgres store"] as const) {
  describe(`hosted, ${backend}: a kill between the save's read and its write`, () => {
    let store: FileSettingsStore | PgSettingsStore;
    beforeEach(() => {
      if (backend === "Postgres store") {
        const client = sqliteClient();
        const pg = new PgSettingsStore("postgres://stand-in", "perps", async () => client);
        useSettingsStoreForTest(pg, "perps");
        store = pg;
      } else store = getSettingsStore("perps") as FileSettingsStore;
    });

    it("A SAVE THAT NEVER NAMES THE SWITCH KEEPS THE KILL'S OFF, and still saves what it did name", async () => {
      await store.put(OWNER, { strategy: "perps-only", perpsEnabled: true, perpsMaxLeverage: 2 });
      const killed = killAfterTheSavesRead(store);
      const r = await save({ perpsMaxLeverage: 3 });
      assert.equal(killed(), "disabled", "the kill ran inside the save and switched practice perps off");
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const after = (await store.get(OWNER)) ?? {};
      assert.equal(after.perpsEnabled, false, `the kill's off stands: ${JSON.stringify(after)}`);
      assert.equal(after.perpsMaxLeverage, 3, "and the owner's change landed on top of it");
      assert.equal(worker(after).perpsEnabled, false, "so a worker on this wallet opens nothing");
    });

    it("A SAVE THAT SWITCHES PRACTICE PERPS ON OVER AN OFF THAT LANDED UNDER IT IS REFUSED, and nothing it carried is written", async () => {
      await store.put(OWNER, { strategy: "perps-only", perpsEnabled: true, perpsMaxLeverage: 2 });
      const killed = killAfterTheSavesRead(store);
      const r = await save({ perpsEnabled: true, perpsMaxLeverage: 3 });
      assert.equal(killed(), "disabled");
      assert.equal(r.status, 400, JSON.stringify(r.body));
      assert.match(r.body.errors?.join(" ") ?? "", /^perpsEnabled: practice perpetuals were switched off while this save was on its way/);
      const after = (await store.get(OWNER)) ?? {};
      assert.equal(after.perpsEnabled, false);
      assert.equal(after.perpsMaxLeverage, 2, "the rest of a refused save is not written");
      // Asked again after the kill, it is the owner's own decision, and it saves.
      const again = await save({ perpsEnabled: true, perpsMaxLeverage: 3 });
      assert.equal(again.status, 200, JSON.stringify(again.body));
      assert.equal((await store.get(OWNER))?.perpsEnabled, true);
    });

    it("WHERE PERPS ARE NOT OFFERED, an off-only save racing the kill keeps both offs", async () => {
      delete process.env.MERRYMEN_PERPS;
      await store.put(OWNER, { strategy: "perps-only", perpsEnabled: true, liveTradingEnabled: true });
      const killed = killAfterTheSavesRead(store);
      const r = await save({ liveTradingEnabled: false });
      assert.equal(killed(), "disabled");
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.saved, ["liveTradingEnabled"]);
      const after = (await store.get(OWNER)) ?? {};
      assert.equal(after.perpsEnabled, false, `the kill's off stands: ${JSON.stringify(after)}`);
      assert.equal(after.liveTradingEnabled, false, "and so does the owner's");
    });

    it("A BLOB THAT KEEPS CHANGING UNDER EVERY READ IS A 503 with nothing from the body written", async () => {
      await store.put(OWNER, { strategy: "perps-only", perpsMaxLeverage: 2 });
      const real = store.getVersioned.bind(store);
      let writes = 0;
      Object.assign(store, {
        getVersioned: async (tenant: `0x${string}`) => {
          const read = await real(tenant);
          writes++;
          await store.put(OWNER, { strategy: "perps-only", perpsMaxLeverage: 2, perpsMaxOpensPerDay: writes });
          return read;
        },
      });
      try {
        const r = await save({ perpsMaxLeverage: 3 });
        assert.equal(r.status, 503, JSON.stringify(r.body));
        assert.match(r.body.errors?.join(" ") ?? "", /kept changing while this save was being written, so nothing was saved/);
        assert.equal(writes, 3, "judged afresh a bounded number of times");
      } finally {
        delete (store as Partial<Versioned>).getVersioned;
      }
      assert.equal((await store.get(OWNER))?.perpsMaxLeverage, 2);
    });
  });
}

describe("self-hosted: the kill at any point of the save", () => {
  const file = () => path.join(purposeHome("perps"), "settings.json");
  const stored = () => JSON.parse(readFileSync(file(), "utf8")) as MerrymenSettings;

  it("WHEREVER THE KILL LANDS, practice perps end off and the owner's change is saved", async () => {
    delete process.env.MERRYMEN_HOSTED;
    for (let turns = 0; turns <= 24; turns++) {
      mkdirSync(purposeHome("perps"), { recursive: true });
      writeFileSync(file(), JSON.stringify({ strategy: "perps-only", perpsEnabled: true, perpsMaxLeverage: 2 }));
      const saving = save({ perpsMaxLeverage: 3 }, false);
      for (let i = 0; i < turns; i++) await new Promise((r) => setImmediate(r));
      const killed = turnOffLocalPaperPerps(purposeHome("perps"));
      const r = await saving;
      assert.equal(r.status, 200, `${turns}: ${JSON.stringify(r.body)}`);
      const after = stored();
      assert.equal(after.perpsEnabled, false, `${turns} turns in (kill said ${killed}): ${JSON.stringify(after)}`);
      assert.equal(after.perpsMaxLeverage, 3, `${turns} turns in`);
    }
  });
});
