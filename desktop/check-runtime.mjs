/** Exercise the worker's database driver under Electron's own Node, offline. */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const electron = require("electron");
const root = path.dirname(require.resolve("merrymen/package.json"));
const tsx = [path.join(root, "node_modules"), path.dirname(root)]
  .map((dir) => path.join(dir, "tsx", "dist", "cli.mjs"))
  .find((file) => existsSync(file));
if (!tsx) throw new Error("The desktop package is missing the worker's tsx runtime");

const scratch = mkdtempSync(path.join(tmpdir(), "merrymen-desktop-runtime-"));
try {
  const probe = path.join(scratch, "probe.mts");
  // Import the exact shipped driver, without starting the worker or opening
  // user data. Using the same tsx launcher as main.js also checks its loader.
  writeFileSync(probe, `
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { wrapSqlite } from ${JSON.stringify(pathToFileURL(path.join(root, "worker", "src", "db.ts")).href)};
const raw = new DatabaseSync(":memory:");
try {
  const db = wrapSqlite(raw);
  await db.exec("CREATE TABLE probe (value INTEGER)");
  await db.tx(async (tx) => { await tx.prepare("INSERT INTO probe VALUES (?)").run(7); });
  assert.equal((await db.prepare("SELECT value FROM probe").get()).value, 7);
  await assert.rejects(db.tx(async (tx) => {
    await tx.prepare("INSERT INTO probe VALUES (?)").run(8);
    throw new Error("rollback probe");
  }), /rollback probe/);
  assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM probe").get()).n, 1);
  console.log("[desktop] Electron " + process.versions.electron + " / Node " + process.versions.node + ": worker SQLite commit/rollback OK");
} finally { raw.close(); }
`, "utf8");
  const result = spawnSync(electron, [tsx, probe], {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "inherit",
    windowsHide: true,
    timeout: 60_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Electron worker runtime check failed (exit ${result.status}, signal ${result.signal})`);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
