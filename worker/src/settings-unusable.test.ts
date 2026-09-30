/**
 * A settings.json THAT IS THERE BUT CANNOT BE USED IS NOT "NO SETTINGS".
 *
 * resolveConfig caught every read and parse failure and returned
 * mergeSettings({}, env): paper, steady-basket, an empty Telegram allowlist.
 * Missing and broken were the same thing. Hosted, the atomic writers leave
 * nothing to trip on; self-hosted, a stray comma in a hand edit (or an editor
 * that saves by truncating) ran the agent on settings nobody chose, silently,
 * while the owner believed theirs were in force.
 *
 * Now: missing is still "no overrides". Unusable keeps the last usable read in
 * force and says so once; and a process that has never had a usable read says
 * it is running on nobody's settings, and the worker will not arm on them.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { Worker } from "node:worker_threads";
import {
  mergeSettings,
  readSettingsFileAt,
  resolveConfig,
  settingsArmRefusal,
  settingsHoldNotice,
  settingsProblem,
  settingsSource,
  type SettingsProblem,
} from "./settings";

const codeOf = (src: string) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
const INDEX = codeOf(readFileSync(new URL("./index.ts", import.meta.url), "utf8"));

const ENV_KEYS = [
  "MERRYMEN_SETTINGS_FILE",
  "MERRYMEN_HOSTED",
  "MERRYMEN_STRATEGY",
  "MERRYMEN_PAPER_TRADING",
  "MERRYMEN_TELEGRAM_ALLOWLIST",
] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
let root = "";
before(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "merrymen-settings-unusable-"));
  for (const k of ENV_KEYS) delete process.env[k];
});
after(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(root, { recursive: true, force: true });
});

/** A fresh path per test: the last good read is remembered per path, per process. */
let n = 0;
const freshFile = () => path.join(root, `settings-${++n}.json`);

const OWNER = { strategy: "dip-hunter", paperTradingEnabled: false, telegramAllowlist: [123456789] };
const SECRET = "123456:SECRET-bot-token";

describe("readSettingsFileAt tells missing from broken", () => {
  it("missing is absent; a BOM'd object is parsed", () => {
    const file = freshFile();
    assert.deepEqual(readSettingsFileAt(file), { kind: "absent" });
    writeFileSync(file, "﻿" + JSON.stringify(OWNER));
    assert.deepEqual(readSettingsFileAt(file), { kind: "parsed", settings: OWNER });
  });

  it("empty, cut short, a trailing comma, null, an array, a number and a directory are all unusable", () => {
    for (const broken of ["", '{"strategy":"dip-h', '{"strategy":"dip-hunter",}', "null", "[]", "3"]) {
      const file = freshFile();
      writeFileSync(file, broken);
      const r = readSettingsFileAt(file);
      assert.equal(r.kind, "unusable", `${JSON.stringify(broken)} read as ${r.kind}`);
    }
    const dir = freshFile();
    mkdirSync(dir);
    const r = readSettingsFileAt(dir);
    assert.equal(r.kind, "unusable");
    assert.match(r.kind === "unusable" ? r.why : "", /could not be read \(EISDIR\)/);
  });

  it("says where it broke and NEVER quotes the file — it holds keys, and `why` goes to the event feed", () => {
    // Both V8 message shapes: one quotes the input, one gives a position.
    for (const broken of [`{"telegramBotToken":"${SECRET}" x}`, `{"telegramBotToken": ${SECRET}}`, `x${SECRET}`]) {
      const file = freshFile();
      writeFileSync(file, broken);
      const r = readSettingsFileAt(file);
      assert.equal(r.kind, "unusable");
      const why = r.kind === "unusable" ? r.why : "";
      assert.ok(!why.includes("SECRET"), `leaked the file into: ${why}`);
      assert.match(why, /^settings\.json is not valid JSON/);
    }
    const file = freshFile();
    writeFileSync(file, '{\n  "strategy": "dip-hunter",\n}');
    const r = readSettingsFileAt(file);
    assert.equal(r.kind === "unusable" ? r.why : "", "settings.json is not valid JSON (line 3, column 1)");
  });

  it("counts line and column itself — and agrees with V8 where V8 says (CI's Node may not)", () => {
    for (const broken of ['{"strategy":"dip-hunter",}', '{\n  "a": 1,\n  "b": 2\n  "c": 3\n}', '{\r\n  "a": [1, 2,,]\r\n}', '{"a":1}}']) {
      const file = freshFile();
      writeFileSync(file, broken);
      const r = readSettingsFileAt(file);
      const why = r.kind === "unusable" ? r.why : "";
      let v8 = "";
      try {
        JSON.parse(broken);
      } catch (e) {
        v8 = (e as Error).message;
      }
      // A position is all it takes; without one (V8's quoting "Unexpected
      // token" form) it says no more than that the file is not JSON.
      if (/\bat position \d+/.test(v8)) assert.match(why, /^settings\.json is not valid JSON \(line \d+, column \d+\)$/, why);
      else assert.equal(why, "settings.json is not valid JSON");
      const says = /\(line (\d+) column (\d+)\)/.exec(v8);
      if (says) assert.ok(why.endsWith(`(line ${says[1]}, column ${says[2]})`), `${why} vs V8's ${v8}`);
    }
  });
});

describe("settingsSource keeps the last usable read", () => {
  it("walks every transition, and warns once per run of unusable reads", () => {
    const file = freshFile();
    let t = 1_000;
    const warned: string[] = [];
    const src = settingsSource(file, () => t, (l) => warned.push(l));

    // Broken from the first read: nothing to keep. Nobody's settings.
    writeFileSync(file, '{"strategy":"dip-hunter",}');
    assert.deepEqual(src.read(), {});
    assert.deepEqual(src.problem(), { why: "settings.json is not valid JSON (line 1, column 26)", since: 1_000, holding: false });
    t = 2_000;
    src.read();
    assert.equal(src.problem()?.since, 1_000, "one run, not one per read");
    assert.equal(warned.length, 1);
    assert.match(warned[0]!, /nothing usable has been read from it since this process started/);

    // Fixed: in force, and said.
    writeFileSync(file, JSON.stringify(OWNER));
    assert.deepEqual(src.read(), OWNER);
    assert.equal(src.problem(), null);
    assert.match(warned[1]!, /usable again/);

    // Broken again: the owner's settings stay in force, not the defaults.
    t = 3_000;
    writeFileSync(file, "");
    assert.deepEqual(src.read(), OWNER);
    assert.deepEqual(src.problem(), { why: "settings.json is not valid JSON (it ends early: empty, or cut short)", since: 3_000, holding: true });
    assert.match(warned[2]!, /keeping the settings last read from it/);
    // Broken differently in the same run: the reason follows, the run does not restart.
    t = 4_000;
    writeFileSync(file, "[]");
    assert.deepEqual(src.read(), OWNER);
    assert.deepEqual(src.problem(), { why: "settings.json is not a JSON object", since: 3_000, holding: true });
    assert.equal(warned.length, 3);

    // DELETED is a choice: the defaults, on purpose, and no problem.
    rmSync(file);
    assert.deepEqual(src.read(), {});
    assert.equal(src.problem(), null);
    // ...and it counts as a usable read: breaking it now holds `{}`.
    writeFileSync(file, "{");
    assert.deepEqual(src.read(), {});
    assert.equal(src.problem()?.holding, true);
  });
});

describe("resolveConfig", () => {
  const defaults = () => mergeSettings({}, process.env);

  it("a broken edit after a good read keeps the OWNER'S settings — not paper, steady-basket, an empty allowlist", () => {
    const file = freshFile();
    process.env.MERRYMEN_SETTINGS_FILE = file;
    try {
      writeFileSync(file, JSON.stringify(OWNER));
      const good = resolveConfig();
      assert.equal(good.strategy, "dip-hunter");
      assert.equal(good.paperTradingEnabled, false);
      assert.deepEqual(good.telegramAllowlist, [123456789]);
      assert.equal(settingsProblem(), null);

      writeFileSync(file, '{"strategy":"even-keel","paperTradingEnabled":false,}');
      const held = resolveConfig();
      assert.deepEqual(held, good, "the last good read, exactly");
      assert.notDeepEqual(held, defaults(), "and not what a broken file used to mean");
      assert.equal(settingsProblem()?.holding, true);
    } finally {
      delete process.env.MERRYMEN_SETTINGS_FILE;
    }
  });

  it("broken from the first read: the defaults, flagged as nobody's — and another file's good read never stands in", () => {
    const good = freshFile();
    const broken = freshFile();
    writeFileSync(good, JSON.stringify(OWNER));
    writeFileSync(broken, "{");
    try {
      process.env.MERRYMEN_SETTINGS_FILE = good;
      assert.equal(resolveConfig().strategy, "dip-hunter");
      process.env.MERRYMEN_SETTINGS_FILE = broken;
      assert.deepEqual(resolveConfig(), defaults());
      assert.equal(settingsProblem()?.holding, false);
      assert.ok(settingsArmRefusal(settingsProblem(), false), "a worker reading this file will not arm");
    } finally {
      delete process.env.MERRYMEN_SETTINGS_FILE;
    }
  });

  it("a missing file is still the defaults, with no problem", () => {
    process.env.MERRYMEN_SETTINGS_FILE = freshFile();
    try {
      assert.deepEqual(resolveConfig(), defaults());
      assert.equal(settingsProblem(), null);
      assert.equal(settingsArmRefusal(settingsProblem(), false), null);
    } finally {
      delete process.env.MERRYMEN_SETTINGS_FILE;
    }
  });
});

describe("what the owner is told", () => {
  const nobodys: SettingsProblem = { why: "settings.json is not valid JSON (line 3, column 1)", since: 1, holding: false };
  const held: SettingsProblem = { ...nobodys, holding: true };

  it("settingsArmRefusal: only when nothing usable was ever read, and it says what to do", () => {
    assert.equal(settingsArmRefusal(null, false), null);
    assert.equal(settingsArmRefusal(held, false), null, "a running agent is not stopped over a typo");
    const self = settingsArmRefusal(nobodys, false) ?? "";
    assert.match(self, /^this agent is NOT TRADING: settings\.json is not valid JSON \(line 3, column 1\)/);
    assert.match(self, /paper, the default strategy, an empty Telegram allowlist/);
    assert.match(self, /Fix the file, or remove it to run on the defaults on purpose/);
    // Hosted the file is the orchestrator's, and it is rewritten within a pass.
    const hosted = settingsArmRefusal(nobodys, true) ?? "";
    assert.match(hosted, /The file is ours, not yours/);
    assert.doesNotMatch(hosted, /Fix the file/);
  });

  it("settingsHoldNotice: once per run, once more when it is usable again, never for nobody's settings", () => {
    let told: number | null = null;
    const step = (p: SettingsProblem | null) => {
      const r = settingsHoldNotice(p, told, false);
      told = r.told;
      return r.event;
    };
    assert.equal(step(null), null);
    assert.equal(step(nobodys), null, "the arm refusal speaks for this one");
    const first = step(held);
    assert.equal(first?.level, "warn");
    assert.match(first?.message ?? "", /keeps running on the settings it last read.*Fix the file/);
    assert.equal(step({ ...held, why: "settings.json is not a JSON object" }), null, "same run, said once");
    assert.equal(step({ ...held, since: 2 })?.level, "warn", "a new run is news");
    assert.deepEqual(step(null), { level: "ok", message: "settings.json is usable again — its settings are in force" });
    assert.equal(step(null), null);
    assert.match(settingsHoldNotice(held, null, true).event?.message ?? "", /The file is ours, not yours/);
  });
});

describe("the worker acts on it", () => {
  const syncGrant = INDEX.slice(INDEX.indexOf("async function syncGrant("), INDEX.indexOf("const unchanged =", INDEX.indexOf("async function syncGrant(")));

  it("syncGrant refuses to arm on nobody's settings — after the kill and expiry checks, before anything arms", () => {
    const at = syncGrant.indexOf("const settingsRefusal = settingsArmRefusal(settingsProblem());");
    assert.ok(at > 0, "the refusal must sit ahead of `const unchanged` in syncGrant");
    assert.ok(at > syncGrant.indexOf("if (!grant) {") && at > syncGrant.indexOf("grantExpired(grant"));
    const branch = syncGrant.slice(at, syncGrant.indexOf("\n    }\n", at));
    assert.match(branch, /await setAgentStatus\(agentId, "error"\);/);
    assert.match(branch, /if \(lastArmFailure !== settingsRefusal\) \{[\s\S]*?await addEvent\(agentId, "err", settingsRefusal\);/, "said once per reason");
    assert.match(branch, /active = null;\s*return false;/);
  });

  it("refreshConfig tells an armed owner, once, that their edit has not taken effect", () => {
    const refresh = INDEX.slice(INDEX.indexOf("async function refreshConfig("), INDEX.indexOf("\n  }\n", INDEX.indexOf("async function refreshConfig(")));
    assert.match(refresh, /await noteSettingsHeld\(\);/);
    const note = INDEX.slice(INDEX.indexOf("async function noteSettingsHeld("), INDEX.indexOf("\n  }\n", INDEX.indexOf("async function noteSettingsHeld(")));
    assert.match(note, /settingsHoldNotice\(settingsProblem\(\), settingsHeldTold\)/);
    assert.match(note, /if \(!active\) \{\s*if \(!settingsProblem\(\)\) settingsHeldTold = null;\s*return;/, "a run fixed while unarmed is forgotten, not announced on the next arm");
    assert.match(note, /if \(event\) await addEvent\(active\.agentId, event\.level, event\.message\);/);
  });
});

/**
 * THE REASON THIS EXISTS, EXECUTED. A writer on another thread saves the
 * owner's settings the way an editor that truncates does — writeFileSync, no
 * rename — while this thread resolves the config in a loop. Some reads tear:
 * the test fails if none did, since then it proved nothing. Not one torn read
 * may reach the config as anything but the owner's settings.
 */
describe("a truncating writer racing resolveConfig", () => {
  const WRITER = `
const { writeFileSync } = require("node:fs");
const { parentPort, workerData } = require("node:worker_threads");
const flags = new Int32Array(workerData.ctl);
let v = 0;
parentPort.postMessage("ready");
while (Atomics.load(flags, 0) === 0) {
  v++;
  const pad = "x".repeat(v % 2 === 0 ? 2 * 1024 * 1024 : 512 * 1024);
  writeFileSync(workerData.file, JSON.stringify({ ...workerData.owner, pad }), "utf8");
  Atomics.store(flags, 1, v);
}
parentPort.postMessage("done");
`;

  it("tears reads, and none of them reaches the config as the defaults", async () => {
    const file = freshFile();
    writeFileSync(file, JSON.stringify(OWNER));
    process.env.MERRYMEN_SETTINGS_FILE = file;
    const warn = console.warn;
    console.warn = () => {};
    const ctl = new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT);
    const flags = new Int32Array(ctl);
    const writer = new Worker(WRITER, { eval: true, workerData: { file, ctl, owner: OWNER } });
    try {
      assert.equal(resolveConfig().strategy, "dip-hunter", "a good first read");
      await new Promise<void>((resolve, reject) => {
        writer.once("message", () => resolve());
        writer.once("error", reject);
      });
      let reads = 0;
      let torn = 0;
      let wrong = 0;
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline && torn < 5) {
        const cfg = resolveConfig();
        reads++;
        if (settingsProblem()) torn++;
        if (cfg.strategy !== "dip-hunter" || cfg.paperTradingEnabled !== false || cfg.telegramAllowlist[0] !== 123456789) wrong++;
      }
      assert.ok(torn > 0, `no torn read in ${reads} reads against ${Atomics.load(flags, 1)} writes — the race proved nothing`);
      assert.equal(wrong, 0, `${wrong} of ${reads} reads (${torn} torn) ran on something other than the owner's settings`);
    } finally {
      Atomics.store(flags, 0, 1);
      await writer.terminate();
      console.warn = warn;
      delete process.env.MERRYMEN_SETTINGS_FILE;
    }
  });
});
