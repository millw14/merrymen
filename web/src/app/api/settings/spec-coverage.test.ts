/**
 * EVERY SETTING A CONVERSATION MAY CHANGE IS ONE THIS ROUTE SAVES.
 *
 * Two allowlists name the settings an owner can change without the dashboard:
 * SETTING_SPECS (worker/src/telegram/setting-spec.ts: Telegram, and MCP's
 * propose_settings_change and agent drafts, which apply through this route)
 * and this route's own field tables. A key in the first and missing from the
 * second came back {ok:true, ignored:[key]} and changed nothing, while an
 * approved proposal for it read "Approved and applied" — which is what
 * happened to classExitAtGraduationPct. This runs the real PUT, hosted, for
 * each spec key at BOTH of its bounds, and reads the store back.
 *
 * PERPETUALS are the other way round and covered here too (docs/perps.md
 * "Settings": every key is "in the worker's clamps, the web PUT allowlist with
 * identical bounds … and spec-coverage.test.ts"). No perps key is in
 * SETTING_SPECS — a conversation may not change one — so this route is their
 * only writer, and each is driven at both bounds and just past each, with the
 * worker's own resolver run on the same values: the two enforcement points
 * must agree on every edge, not just share a table.
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { mintSession } from "@/lib/auth";
import { getSettingsStore, resetSettingsStoreForTest } from "@merrymen/settings-store";
import { PERPS_NUM_BOUNDS, SETTINGS_DEFAULTS, type MerrymenSettings, type PerpsNumKey } from "@merrymen/core";
import { SETTING_SPECS, validStoredSetting, type SettingSpec } from "../../../../../worker/src/telegram/setting-spec";
import { mergeSettings } from "../../../../../worker/src/settings";

const TENANT = "0xcccccccccccccccccccccccccccccccccccccccc";
const KEYS = ["MERRYMEN_HOME", "MERRYMEN_HOSTED", "MERRYMEN_SESSION_SECRET", "DATABASE_URL"] as const;
const original = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let dir: string;
let PUT: (req: Request) => Promise<Response>;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "merrymen-settings-spec-"));
  process.env.MERRYMEN_HOME = dir;
  process.env.MERRYMEN_HOSTED = "1";
  process.env.MERRYMEN_SESSION_SECRET = randomBytes(32).toString("hex");
  delete process.env.DATABASE_URL;
  resetSettingsStoreForTest();
  // After the env: the route resolves its paths when it loads.
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

/** Values a proposal for this key may carry: the spec's own bounds for a number, a real choice otherwise. */
function samples(spec: SettingSpec): unknown[] {
  switch (spec.kind) {
    case "bool": return [true, false];
    case "enum": return [...spec.values!];
    case "strategy": return ["steady-basket", "trencher"];
    case "symbols": return [["NVDA"], ["QQQ", "TSLA"]];
    default: return [spec.min ?? 0, spec.max ?? 1_000_000];
  }
}

describe("SETTING_SPECS against PUT /api/settings", () => {
  for (const spec of SETTING_SPECS) {
    it(`${spec.key} is saved, never ignored, at every value a proposal for it may carry`, async () => {
      for (const value of samples(spec)) {
        assert.equal(validStoredSetting(spec.key, value), true, `${spec.key}=${JSON.stringify(value)} is a value the spec allows`);
        const res = await put({ [spec.key]: value });
        assert.equal(res.status, 200, `${spec.key}=${JSON.stringify(value)}: ${JSON.stringify(res.body)}`);
        assert.equal((res.body.ignored ?? []).includes(spec.key), false, `${spec.key} came back ignored: the route has no branch for it`);
        const stored = (await getSettingsStore().get(TENANT)) as Record<string, unknown> | null;
        assert.deepEqual(stored?.[spec.key], value, `${spec.key}=${JSON.stringify(value)} was not stored`);
      }
    });
  }

  it("the key that drifted: classExitAtGraduationPct is saved, and out of its bounds is refused, not ignored", async () => {
    const ok = await put({ classExitAtGraduationPct: 50 });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.ignored, undefined);
    assert.equal(((await getSettingsStore().get(TENANT)) as Record<string, unknown>).classExitAtGraduationPct, 50);
    for (const bad of [0, 101]) {
      const res = await put({ classExitAtGraduationPct: bad });
      assert.equal(res.status, 400, `${bad}: ${JSON.stringify(res.body)}`);
      assert.match(res.body.errors?.join(" ") ?? "", /classExitAtGraduationPct/);
    }
  });
});

describe("every perps number against PUT /api/settings, and the worker on the same values", () => {
  /**
   * What each key needs beside it to be saved ALONE: the per-trade cap may not
   * exceed the open-notional cap, so each is tested with the other out of the way.
   */
  const room: Partial<Record<PerpsNumKey, Record<string, number>>> = {
    perpsPerTradeUsdg: { perpsMaxOpenNotionalUsdg: 100_000 },
    perpsMaxOpenNotionalUsdg: { perpsPerTradeUsdg: 10 },
  };
  const stored = async () => ((await getSettingsStore().get(TENANT)) ?? {}) as Record<string, unknown>;

  for (const key of Object.keys(PERPS_NUM_BOUNDS) as PerpsNumKey[]) {
    const { min, max, decimals } = PERPS_NUM_BOUNDS[key];
    const step = decimals === 0 ? 1 : 0.01;

    it(`${key}: saved at ${min} and ${max}, refused just past either — and the worker resolves exactly that`, async () => {
      for (const value of [min, max]) {
        await getSettingsStore().put(TENANT, {});
        const res = await put({ ...room[key], [key]: value });
        assert.equal(res.status, 200, `${key}=${value}: ${JSON.stringify(res.body)}`);
        assert.equal((res.body.ignored ?? []).includes(key), false, `${key} came back ignored`);
        assert.equal((await stored())[key], value, `${key}=${value} was not stored`);
        assert.equal(mergeSettings((await stored()) as MerrymenSettings, {})[key], value, `the worker does not honour ${key}=${value}`);
      }
      for (const bad of [min - step, max + step]) {
        await getSettingsStore().put(TENANT, {});
        const res = await put({ ...room[key], [key]: bad });
        assert.equal(res.status, 400, `${key}=${bad} was accepted: ${JSON.stringify(res.body)}`);
        assert.match(res.body.errors?.join(" ") ?? "", new RegExp(`^${key}: must be`), `${key}=${bad}`);
        assert.equal((await stored())[key], undefined, `${key}=${bad} was stored`);
        // The worker, handed the same value from a file, refuses it to the default.
        assert.equal(mergeSettings({ ...room[key], [key]: bad } as MerrymenSettings, {})[key], SETTINGS_DEFAULTS[key], `the worker honours ${key}=${bad}`);
      }
    });

    it(`${key}: off its grid is refused by both, typed or sent as a number`, async () => {
      // Four places, not three: "10.001" typed is ten thousand and one to a
      // German owner (parse-amount.ts), a reading this route rightly accepts.
      const off = decimals === 0 ? min + 0.5 : min + 0.0015;
      await getSettingsStore().put(TENANT, {});
      for (const sent of [off, String(off)]) {
        const res = await put({ ...room[key], [key]: sent });
        assert.equal(res.status, 400, `${key}=${JSON.stringify(sent)}: ${JSON.stringify(res.body)}`);
        assert.match(res.body.errors?.join(" ") ?? "", decimals === 0 ? /whole number/ : /at most 2 decimals/);
      }
      assert.equal(mergeSettings({ ...room[key], [key]: off } as MerrymenSettings, {})[key], SETTINGS_DEFAULTS[key]);
      // A typed value on the grid is read as the number it is.
      const typed = await put({ ...room[key], [key]: String(max) });
      assert.equal(typed.status, 200, JSON.stringify(typed.body));
      assert.equal((await stored())[key], max);
    });
  }
});
