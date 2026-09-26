/**
 * get_agent_controls tells an owner where each control lives, and an owner
 * asks for the kill switch in an emergency. So every `where` must name a
 * control that exists: each quoted label and each screen on the path is
 * checked against the web app's source and the Telegram bot's command list,
 * and a label nobody mapped here fails too. A renamed button then fails this
 * test instead of sending an owner to look for one that is not there.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { resetMetricsForTest } from "../observe";
import { runTool, type CallToolResult, type ToolDef } from "../tool";
import { OWNER_A, SLUG_A, connectAs, installFixtures, makeDeps, makeTestDb } from "../testing";
import { ALL_TOOLS } from "./index";
import { toolInProfile } from "../server";
import { AGENT_CONTROLS, AGENT_TOOLS, SETTINGS_CONTROL_HERE, SETTINGS_CONTROL_IN_APP } from "./agents";

const NOW = 1_800_000_000;
const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const source = (path: string) => readFileSync(join(ROOT, path), "utf8");
/** JSX spells "&" as "&amp;"; either spelling is the same label on screen. */
const shows = (text: string, label: string) => text.includes(label) || text.includes(label.replaceAll("&", "&amp;"));

let restore: (() => void) | null = null;
afterEach(() => { restore?.(); restore = null; resetMetricsForTest(); });

const where = (control: string) => {
  const c = AGENT_CONTROLS.find((x) => x.control === control);
  assert.ok(c, `a ${control} control is listed`);
  return c.where;
};

/** Every label quoted in a `where`, and the file that must show it. */
const QUOTED: Record<string, string> = {
  "discard & start over": "web/src/terminal/screens/Wallet.tsx",
  "allow control commands": "web/src/lib/messages/en.ts",
  "live trading": "web/src/lib/messages/en.ts",
  "Edit signed limits": "web/src/terminal/HostedControls.tsx",
};

test("get_agent_controls returns the controls list, and the kill switch is where the web app and Telegram put it", async () => {
  const d = await makeTestDb();
  const deps = makeDeps(d);
  restore = installFixtures(d);
  const a = await connectAs(deps, OWNER_A, { scopes: ["agents:read", "offline_access"] });
  const def = AGENT_TOOLS.find((t) => t.name === "get_agent_controls") as unknown as ToolDef;
  const r: CallToolResult = await runTool(def, { agent: SLUG_A }, a.principal, "trace-test", { now: () => NOW });
  assert.equal(r.isError, undefined, r.content[0]?.text);
  // Read-only: no drafts:write, so setting changes point at Merrymen's Settings, not at propose_settings_change.
  assert.deepEqual((r.structuredContent as { controls: unknown }).controls, [...AGENT_CONTROLS.filter((c) => c.control !== "setting changes"), SETTINGS_CONTROL_IN_APP]);

  const kill = where("kill switch");
  assert.ok(kill.includes("You → Wallet & permissions (/grant) → 'discard & start over'"), kill);
  // Hosted /kill now removes the stored grant (worker/src/kill-request.ts), so it is named as a kill switch again.
  assert.ok(kill.includes("Telegram /kill, then /confirm"), kill);
  assert.ok(!kill.includes("rather than the Telegram kill command"), kill);
  for (const c of AGENT_CONTROLS) {
    assert.ok(!/dashboard|→ Stop/.test(c.where), `${c.control}: no invented dashboard or Stop button (${c.where})`);
  }
});

test("get_agent_controls never names a tool the connection lacks: on the directory profile, setting changes point at Merrymen's Settings", async () => {
  const d = await makeTestDb();
  const deps = makeDeps(d);
  restore = installFixtures(d);
  const def = AGENT_TOOLS.find((t) => t.name === "get_agent_controls") as unknown as ToolDef;
  const controlsOf = async (principal: Parameters<typeof runTool>[2]) => {
    const r: CallToolResult = await runTool(def, { agent: SLUG_A }, principal, "trace-test", { now: () => NOW });
    assert.equal(r.isError, undefined, r.content[0]?.text);
    return (r.structuredContent as { controls: Array<{ control: string; where: string; effect: string; available_here: boolean }> }).controls;
  };
  const excluded = ALL_TOOLS.filter((t) => !toolInProfile(t, "directory")).map((t) => t.name);
  assert.ok(excluded.includes("propose_settings_change"));

  // Full server with drafts:write: as before, the setting change is proposed here.
  const full = await connectAs(deps, OWNER_A, { scopes: ["agents:read", "drafts:write", "offline_access"] });
  const onFull = await controlsOf(full.principal);
  assert.deepEqual(onFull.find((c) => c.control === "setting changes"), SETTINGS_CONTROL_HERE);
  assert.equal(SETTINGS_CONTROL_HERE.available_here, true);

  // The directory profile, even with drafts:write forced onto the principal.
  const dir = await connectAs(deps, OWNER_A, { profile: "directory", scopes: ["agents:read", "offline_access"], clientId: full.clientId });
  assert.equal(dir.principal.profile, "directory");
  for (const principal of [dir.principal, { ...dir.principal, scopes: new Set([...dir.principal.scopes, "drafts:write"]) }]) {
    const controls = await controlsOf(principal);
    assert.equal(controls.length, onFull.length, "the same controls, only where they live differs");
    for (const c of controls) {
      for (const name of excluded) assert.ok(!c.where.includes(name) && !c.effect.includes(name), `${c.control} names ${name}`);
      assert.equal(c.available_here, false, c.control);
    }
    const settings = controls.find((c) => c.control === "setting changes")!;
    assert.deepEqual(settings, SETTINGS_CONTROL_IN_APP);
    assert.ok(settings.where.includes("Settings (/settings)"), settings.where);
  }
});

test("every label a control's `where` quotes is on screen in the web app", () => {
  for (const c of AGENT_CONTROLS) {
    const quoted = c.where.split("'").filter((_, i) => i % 2 === 1);
    for (const label of quoted) {
      const file = QUOTED[label];
      assert.ok(file, `${c.control}: '${label}' is mapped to the file that shows it`);
      assert.ok(shows(source(file), label), `${c.control}: '${label}' is in ${file}`);
    }
  }
});

test("the screens on each path exist and lead where the text says", () => {
  const you = source("web/src/terminal/screens/You.tsx");
  const app = source("web/src/terminal/App.tsx");
  const wallet = source("web/src/terminal/screens/Wallet.tsx");
  const settings = source("web/src/terminal/screens/Settings.tsx");
  const en = source("web/src/lib/messages/en.ts");
  const hosted = source("web/src/terminal/HostedControls.tsx");

  // You → Wallet & permissions opens /grant, whose red discard button deletes the stored grant.
  assert.ok(shows(you, "<strong>Wallet & permissions</strong>"));
  assert.ok(app.includes(`onStop={() => {window.location.href="/grant";}}`));
  assert.ok(shows(wallet, `<button className="btn-kill" style={{ padding: "10px 16px" }} onClick={discard}>`));
  assert.ok(wallet.includes(`fetch("/api/grants", { method: "DELETE" })`), "discard deletes the server-side grant");

  // You → Trading limits → Edit signed limits goes to /grant; You → Settings is /settings.
  assert.ok(you.includes("<strong>Trading limits</strong>"));
  assert.ok(hosted.includes(`<a className="flow-primary" href="/grant">Edit signed limits</a>`));
  assert.ok(you.includes(`href="/settings"`) && you.includes("<strong>Settings</strong>"));
  assert.ok(settings.includes(`t("settings.label.liveTrading")`) && en.includes(`"settings.label.liveTrading": "live trading"`));

  // Settings → Advanced settings → Telegram controls → allow control commands.
  assert.ok(settings.includes("<summary>Advanced settings</summary>"));
  assert.ok(settings.includes(`t("settings.section.telegramControls")`) && en.includes(`"settings.section.telegramControls": "Telegram controls"`));
  assert.ok(settings.includes(`t("settings.label.allowControlCommands")`));
  for (const c of AGENT_CONTROLS.filter((x) => x.where.includes("Telegram /"))) {
    assert.ok(c.where.includes("Settings → Advanced settings → Telegram controls → 'allow control commands'"), `${c.control}: says the Telegram switch it needs`);
  }
});

test("the Telegram commands named are in the bot's command list", () => {
  const help = source("worker/src/telegram/reads.ts");
  const executor = source("worker/src/telegram/executor.ts");
  for (const cmd of ["/kill —", "/pause · /resume"]) assert.ok(help.includes(`"${cmd}`), cmd);
  assert.ok(executor.includes("/confirm to kill"), "/kill asks for /confirm");
  assert.ok(executor.includes(`case "kill"`) && executor.includes("if (!deps.controlEnabled)"), "kill is refused while control commands are off");
});
