/**
 * EVERY CHANGE AN OWNER CAN ASK FOR IN WORDS IS ONE THIS ROUTE SAVES — AND
 * NOTHING OUTSIDE THE BOUNDS IT ENFORCES.
 *
 * SETTINGS_CATALOG (packages/core/src/settings-catalog.ts) is what the agent
 * turns a sentence into, and a dashboard approval applies it through this
 * PUT. A key the catalog offers and this route ignores would come back
 * {ok:true, ignored:[key]} while the owner was told it changed — the failure
 * spec-coverage.test.ts already records once. So every proposable entry is
 * saved here, hosted, at each value a proposal may carry, and every numeric
 * one is refused one step outside its catalog bounds: the two tables agree.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { mintSession } from "@/lib/auth";
import { getSettingsStore, resetSettingsStoreForTest } from "@merrymen/settings-store";
import { SETTINGS_CATALOG, validCatalogValue, type CatalogEntry } from "@merrymen/core";

const TENANT = "0xdddddddddddddddddddddddddddddddddddddddd";
const KEYS = ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_SESSION_SECRET", "DATABASE_URL"] as const;
const original = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let dir: string;
let PUT: (req: Request) => Promise<Response>;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "merrymen-settings-catalog-"));
  process.env.MERRYMEN_HOME = dir;
  process.env.MERRYMEN_HOSTED = "1";
  process.env.MERRYMEN_SESSION_SECRET = randomBytes(32).toString("hex");
  delete process.env.DATABASE_URL;
  resetSettingsStoreForTest();
  ({ PUT } = await import("./route"));
});
after(() => {
  for (const k of KEYS) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
  resetSettingsStoreForTest();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

async function put(body: Record<string, unknown>) {
  const res = await PUT(new Request("https://app.example.test/api/settings", {
    method: "PUT",
    headers: { "content-type": "application/json", cookie: `mm_session=${mintSession(TENANT)}` },
    body: JSON.stringify({ ...body, owner: TENANT }),
  }));
  return { status: res.status, body: (await res.json()) as { ok?: boolean; errors?: string[]; ignored?: string[] } };
}

const NUMERIC = new Set(["usd", "pct", "int", "minutes", "seconds", "hoursAsSec", "hour"]);

function samples(s: CatalogEntry): unknown[] {
  switch (s.kind) {
    case "bool": return [true, false];
    case "enum": return [...s.values!];
    case "symbols": return [["NVDA"], ["QQQ", "TSLA"]];
    case "text": return ["Robin Hood"];
    default: return [s.min!, s.max!];
  }
}

/** Proposable on a HOSTED agent: not a secret, not sealed, not a list, not self-hosted-only. */
const proposable = SETTINGS_CATALOG.filter(
  (s) => (s.route === "chat" || s.route === "dashboard") && s.kind !== "special" && !s.hostedForbidden,
);

describe("SETTINGS_CATALOG against PUT /api/settings", () => {
  it("covers a real share of the page, not a token handful", () => {
    assert.ok(proposable.length >= 50, `only ${proposable.length} proposable settings`);
  });

  for (const s of proposable) {
    it(`${s.key} is saved, never ignored, at every value a proposal may carry`, async () => {
      for (const value of samples(s)) {
        assert.equal(validCatalogValue(s.key, value), true, `${s.key}=${JSON.stringify(value)} is a value the catalog allows`);
        const res = await put({ [s.key]: value });
        assert.equal(res.status, 200, `${s.key}=${JSON.stringify(value)}: ${JSON.stringify(res.body)}`);
        assert.equal((res.body.ignored ?? []).includes(s.key), false, `${s.key} came back ignored`);
        const stored = (await getSettingsStore().get(TENANT)) as Record<string, unknown> | null;
        assert.deepEqual(stored?.[s.key], value, `${s.key}=${JSON.stringify(value)} was not stored`);
      }
      if (NUMERIC.has(s.kind)) {
        for (const bad of [s.min! - 1, s.max! + 1]) {
          assert.equal(validCatalogValue(s.key, bad), false, `${s.key}=${bad} is outside the catalog`);
          const res = await put({ [s.key]: bad });
          assert.equal(res.status, 400, `${s.key}=${bad} must be refused by the route too: ${JSON.stringify(res.body)}`);
        }
      }
    });
  }
});
