import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { MERRYMEN_TOKEN } from "@merrymen/core";
import { setSettingsReaderForTest } from "@/lib/services/settings-view";
import { SETTING_SPECS } from "../../../../worker/src/telegram/setting-spec";
import { resetMetricsForTest } from "../observe";
import { runTool, type ToolDef } from "../tool";
import { OWNER_A, SLUG_A, SLUG_B, connectAs, errorOf, installFixtures, makeDeps, makeTestDb, type TestDb } from "../testing";
import { AGENT_SETTINGS_TOOLS } from "./agent-settings";

const def = AGENT_SETTINGS_TOOLS[0] as unknown as ToolDef;
const NOW = 1_800_000_000;
let restore: (() => void) | null = null;
let database: TestDb | null = null;
afterEach(() => { restore?.(); restore = null; database?.raw.close(); database = null; resetMetricsForTest(); });

type Settings = {
  agent: string; configured_name: string | null; strategy: string | null;
  settings: Array<{ key: string; label: string; kind: string; unit: string; value: unknown; value_state: string; valid_for_proposal: boolean | null; display_value: string; min: number | null; max: number | null; options: string[] | null; zero_meaning: string | null }>;
  available_basket_symbols: string[]; approval_required: boolean; note: string;
};

async function setup(o: { scopes?: string[]; shared?: string[]; settings?: Record<string, unknown>; profile?: "full" | "directory" } = {}) {
  const d = database = await makeTestDb();
  restore = installFixtures(d, { settings: { [OWNER_A]: o.settings ?? {} } });
  const { principal } = await connectAs(makeDeps(d), OWNER_A, { scopes: o.scopes ?? ["agents:read"], agents: o.shared ?? [SLUG_A], profile: o.profile });
  const call = (args: Record<string, unknown> = {}) => runTool(def, args, principal, "settings-test", { now: () => NOW, ledger: async () => { throw new Error("settings must not read worker ledger"); } });
  const read = async () => {
    const result = await call();
    assert.equal(result.isError, undefined, result.content[0]?.text);
    return result.structuredContent as unknown as Settings;
  };
  return { d, principal, call, read };
}

test("settings expose the configured name and exactly the editable metadata, never secrets or activation controls", async () => {
  const { read } = await setup({ settings: {
    agentName: "Fresh Robin", strategy: "steady-basket", assetMode: "stocks", basketSymbols: ["TSLA"],
    slippageBps: 100, classMaxHoldSec: 7200, telegramDigestHour: 8,
    telegramBotToken: "private-bot-token", telegramChatId: "private-chat", openaiApiKey: "private-model-key",
    liveTradingEnabled: true, maxImpactBps: 5000, telegramControlEnabled: true,
  } });
  const r = await read();
  assert.equal(r.agent, SLUG_A);
  assert.equal(r.configured_name, "Fresh Robin");
  assert.equal(r.strategy, "steady-basket");
  assert.deepEqual(r.settings.map(s => s.key), SETTING_SPECS.map(s => s.key));
  const pct = r.settings.find(s => s.key === "slippageBps")!;
  assert.equal(pct.value, 100); assert.equal(pct.unit, "basis_points"); assert.equal(pct.display_value, "1%");
  assert.equal(pct.min, 1); assert.equal(pct.max, 1000); assert.equal(pct.valid_for_proposal, true);
  const hold = r.settings.find(s => s.key === "classMaxHoldSec")!;
  assert.equal(hold.value, 7200); assert.equal(hold.unit, "seconds"); assert.match(hold.display_value, /2/);
  assert.ok(r.settings.find(s => s.key === "strategy")!.options!.includes("trencher"));
  assert.deepEqual(r.settings.find(s => s.key === "assetMode")!.options, ["all", "stocks", "crypto"]);
  assert.ok(r.available_basket_symbols.includes("TSLA"));
  assert.equal(r.approval_required, true);
  assert.match(r.note, /not a worker acknowledgement/);
  const body = JSON.stringify(r);
  for (const forbidden of ["private-bot-token", "private-chat", "private-model-key", "telegramBotToken", "telegramChatId", "openaiApiKey", "liveTradingEnabled", "maxImpactBps", "telegramControlEnabled"]) assert.ok(!body.includes(forbidden), forbidden);
});

test("unset values stay unknown rather than becoming zero or false", async () => {
  const { read } = await setup();
  const r = await read();
  assert.equal(r.configured_name, null);
  assert.ok(r.settings.every(s => s.value === null && s.value_state === "not_set" && s.valid_for_proposal === null));
  assert.ok(r.settings.every(s => /worker default/.test(s.display_value)));
});

test("legitimate dashboard-only values remain visible without becoming valid chat proposals", async () => {
  const { read } = await setup({ settings: { classMaxPositions: 0, telegramNotifyEveryMin: 0 } });
  const r = await read();
  const max = r.settings.find(s => s.key === "classMaxPositions")!;
  assert.equal(max.value, 0); assert.equal(max.value_state, "stored"); assert.equal(max.valid_for_proposal, false);
  assert.equal(max.zero_meaning, "no limit"); assert.equal(max.display_value, "no limit");
  const batch = r.settings.find(s => s.key === "telegramNotifyEveryMin")!;
  assert.equal(batch.valid_for_proposal, true);
  assert.match(batch.display_value, /per trade/);
});

test("invalid stored shapes do not become usable configuration", async () => {
  const { read } = await setup({ settings: { buyPerTickUsdg: "not-money", officialCoinsEnabled: "yes", strategy: "unknown-playbook", basketSymbols: ["invalid symbol"] } });
  const r = await read();
  for (const key of ["buyPerTickUsdg", "officialCoinsEnabled", "basketSymbols"]) {
    const s = r.settings.find(s => s.key === key)!;
    assert.equal(s.value, null, key); assert.equal(s.value_state, "unavailable", key);
  }
  assert.equal(r.settings.find(s => s.key === "strategy")!.valid_for_proposal, false);
});

test("basket choices include configured tokens while excluding the energy reserve", async () => {
  const { read } = await setup({ settings: {
    customTokens: [{ symbol: "MyCoin", address: `0x${"f".repeat(40)}`, decimals: 18 }, { ...MERRYMEN_TOKEN }],
    basketSymbols: ["MERRYMEN"],
  } });
  const r = await read();
  assert.ok(r.available_basket_symbols.includes("MyCoin"));
  assert.ok(!r.available_basket_symbols.includes("MERRYMEN"));
  assert.equal(r.settings.find(s => s.key === "basketSymbols")!.valid_for_proposal, false);
});

test("foreign and unshared agents are refused before reading any owner settings", async () => {
  const { call } = await setup();
  setSettingsReaderForTest({ async settingsFor() { throw new Error("private settings touched"); }, async specValuesFor() { throw new Error("private settings touched"); } });
  assert.equal(errorOf(await call({ agent: SLUG_B })).code, "not_found");
});

test("draft permission alone cannot read settings even when a slug is supplied", async () => {
  const { call } = await setup({ scopes: ["drafts:write"] });
  setSettingsReaderForTest({ async settingsFor() { throw new Error("private settings touched"); }, async specValuesFor() { throw new Error("private settings touched"); } });
  assert.equal(errorOf(await call({ agent: SLUG_A })).code, "insufficient_scope");
});

test("a disconnected sharing set cannot inspect the owner's settings", async () => {
  const { principal, d } = await setup();
  setSettingsReaderForTest({ async settingsFor() { throw new Error("private settings touched"); }, async specValuesFor() { throw new Error("private settings touched"); } });
  const r = await runTool(def, {}, { ...principal, agentSlugs: [] }, "settings-test", { now: () => NOW, mcp: async () => d });
  assert.equal(errorOf(r).code, "forbidden");
});

test("directory read permission can inspect settings but grants no write authority", async () => {
  const { read } = await setup({ profile: "directory", settings: { strategy: "trencher" } });
  const r = await read();
  assert.equal(r.strategy, "trencher"); assert.equal(r.approval_required, true);
  assert.equal(def.annotations.readOnlyHint, true);
});

test("settings outages and unavailable projections fail instead of returning a blank form", async () => {
  const { call } = await setup();
  setSettingsReaderForTest({ async settingsFor() { return null; } });
  assert.equal(errorOf(await call()).code, "upstream_unavailable");
  setSettingsReaderForTest({ async settingsFor() { return null; }, async specValuesFor() { throw new Error("settings database unavailable"); } });
  assert.equal((await call()).isError, true);
});
