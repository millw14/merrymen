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
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { mintSession } from "@/lib/auth";
import { getSettingsStore, resetSettingsStoreForTest } from "@merrymen/settings-store";
import { SETTING_SPECS, validStoredSetting, type SettingSpec } from "../../../../../worker/src/telegram/setting-spec";

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
