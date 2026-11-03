import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { after, test } from "node:test";
import { settingsLockFile, withSettingsFileLock } from "./settings-file-lock";
import { readSettingsFileWithText, writeSettingsFileIfUnchanged } from "./settings";
import { turnOffLocalPaperPerps } from "./perps-kill";
import { FileSettingsStore } from "./settings-store";

const root = mkdtempSync(path.join(tmpdir(), "mm-settings-lock-"));
after(() => rmSync(root, { recursive: true, force: true }));
const initial = JSON.stringify({ perpsEnabled: true, perpsMaxLeverage: 2 });
const stale = JSON.stringify({ perpsEnabled: true, perpsMaxLeverage: 3 });
let serial = 0;
function fresh(): string {
  const home = path.join(root, String(serial++));
  mkdirSync(home);
  const file = path.join(home, "settings.json");
  writeFileSync(file, initial);
  return file;
}
function hold(file: string): DatabaseSync {
  const db = new DatabaseSync(settingsLockFile(file));
  db.exec("BEGIN IMMEDIATE");
  return db;
}

test("a different process cannot save or kill inside an in-flight settings mutation", () => {
  const file = fresh();
  const db = hold(file);
  try {
    // Real child processes, so JavaScript's single-thread ordering cannot
    // accidentally make this pass. Both mutation paths must honor the lock.
    for (const action of ["save", "kill"]) {
      const script = `
        import { writeSettingsFileIfUnchanged } from './worker/src/settings.ts';
        import { turnOffLocalPaperPerps } from './worker/src/perps-kill.ts';
        import path from 'node:path';
        const [file, before, after, action] = process.argv.slice(1);
        try {
          if (action === 'save') writeSettingsFileIfUnchanged(file, before, after);
          else turnOffLocalPaperPerps(path.dirname(file));
          process.stdout.write('unexpected-write');
        } catch (e) {
          if (!/locked|busy/.test(e.message)) throw e;
          process.stdout.write('contended');
        }
      `;
      const result = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script, file, initial, stale, action], { encoding: "utf8", timeout: 20_000 });
      assert.equal(result, "contended", action);
      assert.equal(readFileSync(file, "utf8"), initial);
    }
  } finally { db.close(); }
  assert.equal(turnOffLocalPaperPerps(path.dirname(file)), "disabled");
  assert.equal(writeSettingsFileIfUnchanged(file, initial, stale), false);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).perpsEnabled, false);
});

test("a symlink and its destination use the same lock before and after replacement", () => {
  const file = fresh();
  const link = path.join(path.dirname(file), "linked.json");
  symlinkSync(file, link);
  assert.equal(settingsLockFile(link), settingsLockFile(file));
  assert.equal(writeSettingsFileIfUnchanged(link, initial, stale), true);
  assert.equal(settingsLockFile(link), settingsLockFile(file));
  const db = hold(file);
  try { assert.throws(() => writeSettingsFileIfUnchanged(link, stale, initial), /locked|busy/); }
  finally { db.close(); }
});

test("a failed mutation releases the lock without changing the settings", () => {
  const file = fresh();
  assert.throws(() => withSettingsFileLock(file, () => { throw new Error("injected"); }), /injected/);
  assert.equal(readSettingsFileWithText(file).text, initial);
  assert.equal(writeSettingsFileIfUnchanged(file, initial, stale), true);
});

test("the hosted file backend's conditional save and kill share the lock", async (t) => {
  const savedHome = process.env.MERRYMEN_HOME;
  const savedKey = process.env.MERRYMEN_STORE_DEK;
  const home = path.join(root, String(serial++));
  process.env.MERRYMEN_HOME = home;
  process.env.MERRYMEN_STORE_DEK = Buffer.alloc(32, 9).toString("base64");
  t.after(() => {
    if (savedHome === undefined) delete process.env.MERRYMEN_HOME; else process.env.MERRYMEN_HOME = savedHome;
    if (savedKey === undefined) delete process.env.MERRYMEN_STORE_DEK; else process.env.MERRYMEN_STORE_DEK = savedKey;
  });
  const store = new FileSettingsStore("perps");
  const tenant = `0x${"ab".repeat(20)}` as const;
  await store.put(tenant, { perpsEnabled: true, perpsMaxLeverage: 2 });
  const seen = await store.getVersioned(tenant);
  const file = path.join(home, "tenant-settings-perps", `${tenant}.json`);
  const db = hold(file);
  try {
    await assert.rejects(store.putIfUnchanged(tenant, { perpsEnabled: true, perpsMaxLeverage: 3 }, seen.version), /locked|busy/);
    await assert.rejects(store.disablePerpsForKill(tenant), /locked|busy/);
  } finally { db.close(); }
  assert.equal(await store.disablePerpsForKill(tenant), "disabled");
  assert.equal(await store.putIfUnchanged(tenant, { perpsEnabled: true }, seen.version), false);
  assert.equal((await store.get(tenant))?.perpsEnabled, false);
});
