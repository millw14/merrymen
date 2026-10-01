import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { stagePackLock, cleanPackLock } from "./pack-lock.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "merrymen-pack-lock-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, "cli"));
  copyFileSync(fileURLToPath(new URL("./pack-lock.mjs", import.meta.url)), path.join(root, "cli/pack-lock.mjs"));
  const manifest = { name: "merrymen-lock-fixture", version: "1.0.0", files: ["cli", "npm-shrinkwrap.json"], scripts: { prepack: "node cli/pack-lock.mjs stage", postpack: "node cli/pack-lock.mjs clean" } };
  writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest));
  const lock = JSON.stringify({ name: manifest.name, version: manifest.version, lockfileVersion: 3, packages: { "": { name: manifest.name, version: manifest.version } } }, null, 2) + "\n";
  writeFileSync(path.join(root, "package-lock.json"), lock);
  return { root, lock, wrap: path.join(root, "npm-shrinkwrap.json"), marker: path.join(root, ".merrymen-pack-lock.json") };
}
function pack(root, flags = []) {
  const packed = spawnSync("npm", ["pack", "--json", ...flags], { cwd: root, encoding: "utf8", shell: process.platform === "win32" });
  assert.equal(packed.status, 0, packed.stderr);
  const [{ filename, files }] = JSON.parse(packed.stdout);
  assert(files.some(f => f.path === "npm-shrinkwrap.json"));
  assert(!files.some(f => f.path === "package-lock.json" || f.path === ".merrymen-pack-lock.json"));
  const unpacked = spawnSync("tar", ["-xOf", path.join(root, filename), "package/npm-shrinkwrap.json"], { encoding: "utf8" });
  assert.equal(unpacked.status, 0, unpacked.stderr);
  return unpacked.stdout;
}

test("normal npm pack includes the exact dependency lock and cleans only its staged copy", t => {
  const f = fixture(t);
  assert.equal(pack(f.root), f.lock);
  assert.equal(existsSync(f.wrap), false);
  assert.equal(existsSync(f.marker), false);
  assert.equal(readFileSync(path.join(f.root, "package-lock.json"), "utf8"), f.lock);
});

test("explicit staging preserves the lock in npm pack --ignore-scripts", t => {
  const f = fixture(t); stagePackLock(f.root);
  assert.equal(pack(f.root, ["--ignore-scripts"]), f.lock);
  assert.equal(existsSync(f.wrap), true);
  cleanPackLock(f.root);
  assert.equal(existsSync(f.wrap), false);
});

test("a matching pre-existing shrinkwrap belongs to the user and survives postpack", t => {
  const f = fixture(t); writeFileSync(f.wrap, f.lock);
  assert.equal(pack(f.root), f.lock);
  assert.equal(readFileSync(f.wrap, "utf8"), f.lock);
  assert.equal(existsSync(f.marker), false);
});

test("a mismatched pre-existing shrinkwrap is never overwritten or removed", t => {
  const f = fixture(t); writeFileSync(f.wrap, "user content");
  assert.throws(() => stagePackLock(f.root), /differs/);
  cleanPackLock(f.root);
  assert.equal(readFileSync(f.wrap, "utf8"), "user content");
});

test("cleanup preserves a generated shrinkwrap modified after staging", t => {
  const f = fixture(t); stagePackLock(f.root); writeFileSync(f.wrap, "changed by user");
  assert.throws(() => cleanPackLock(f.root), /changed during packing/);
  assert.equal(readFileSync(f.wrap, "utf8"), "changed by user");
  assert.equal(existsSync(f.marker), true);
});

test("interrupted packaging has an explicit safe cleanup before retry", t => {
  const f = fixture(t); stagePackLock(f.root);
  assert.throws(() => stagePackLock(f.root), /earlier pack/);
  cleanPackLock(f.root); stagePackLock(f.root); cleanPackLock(f.root);
  assert.equal(existsSync(f.wrap), false);
});

test("packing refuses a lock whose root dependency declarations are stale", t => {
  const f = fixture(t);
  const manifestPath = path.join(f.root, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.dependencies = { ws: "^8.22.0" };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  assert.throws(() => stagePackLock(f.root), /stale dependencies/);
  assert.equal(existsSync(f.wrap), false);
  assert.equal(existsSync(f.marker), false);
});
