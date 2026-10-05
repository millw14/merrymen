/**
 * GET /api/auth/session says whether this deployment runs Fomo research, so
 * the Settings page shows the Fomo switches only where they do something:
 * always self-hosted, hosted only with MERRYMEN_FOMO_ENABLED=1 (fomo-switch.ts).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, it } from "node:test";
import { GET } from "./route";

const KEYS = ["MERRYMEN_HOSTED", "MERRYMEN_FOMO_ENABLED"] as const;
const saved = new Map(KEYS.map((k) => [k, process.env[k]]));
after(() => {
  for (const k of KEYS) {
    const v = saved.get(k);
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const session = async () => (await GET(new Request("https://app.merrymen.dev/api/auth/session"))).json() as Promise<Record<string, unknown>>;

it("hosted: fomo only when the deployment opted in", async () => {
  process.env.MERRYMEN_HOSTED = "1";
  delete process.env.MERRYMEN_FOMO_ENABLED;
  assert.deepEqual(await session(), { hosted: true, address: null, fomo: false });
  process.env.MERRYMEN_FOMO_ENABLED = "1";
  assert.equal((await session()).fomo, true);
  process.env.MERRYMEN_FOMO_ENABLED = "true";
  assert.equal((await session()).fomo, false, "only exactly 1");
});

it("self-hosted: always", async () => {
  delete process.env.MERRYMEN_HOSTED;
  delete process.env.MERRYMEN_FOMO_ENABLED;
  assert.deepEqual(await session(), { hosted: false, address: null, fomo: true });
});

it("the Settings page shows the Fomo section only once the answer is yes", () => {
  const src = readFileSync(new URL("../../../../terminal/screens/Settings.tsx", import.meta.url), "utf8");
  assert.match(src, /setFomoOn\(d\?\.fomo === true\)/);
  const open = src.indexOf("{fomoOn === true && (<>");
  const heading = src.indexOf("fomo research · traders, coins and theses");
  const close = src.indexOf("</>)}", heading);
  assert.ok(open > 0 && heading > open && close > heading, "the section, heading to its last hint, is inside the guard");
  assert.ok(src.slice(heading, close).includes("settings.hint.fomoHostedOnly"));
});
