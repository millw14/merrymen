import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { assertPatched, physicalLock } from "./verify-installed.mjs";

const patched = Object.fromEntries(Object.entries({ postcss: "8.5.28", ws: "8.22.0", "bn.js": "4.12.5", uuid: "11.1.1", "@walletconnect/utils": "2.21.9" }).map(([name, version]) => [`node_modules/${name}`, { name, version }]));

test("physical scan includes hidden vulnerable duplicates and ignores a misleading shrinkwrap", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "merrymen-verify-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  function pkg(location, value) {
    const target = path.join(directory, location);
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, "package.json"), JSON.stringify(value));
  }
  pkg("", { name: "merrymen", version: "1.0.0", dependencies: { next: "15.5.27" }, overrides: { postcss: "8.5.28" } });
  pkg("node_modules/next", { name: "next", version: "15.5.27", dependencies: { postcss: "8.4.31" }, bundleDependencies: ["postcss"] });
  pkg("node_modules/next/node_modules/postcss", { name: "postcss", version: "8.4.31" });
  writeFileSync(path.join(directory, "npm-shrinkwrap.json"), JSON.stringify({ packages: { "node_modules/postcss": { version: "8.5.28" } } }));
  const snapshot = physicalLock(directory);
  const nested = "node_modules/merrymen/node_modules/next/node_modules/postcss";
  assert.equal(snapshot.lock.packages[nested].version, "8.4.31");
  assert.equal(snapshot.lock.packages["node_modules/merrymen"].overrides, undefined);
  assert.equal(snapshot.lock.packages["node_modules/merrymen/node_modules/next"].bundleDependencies, undefined);
  assert.throws(() => assertPatched({ ...patched, [nested]: snapshot.lock.packages[nested] }), /Unpatched.*8\.4\.31/);
});

test("patched families include valid older ws major and reject missing closure", () => {
  assert.doesNotThrow(() => assertPatched({ ...patched, legacy: { name: "ws", version: "7.5.13" } }));
  assert.throws(() => assertPatched({ ...patched, vulnerable: { name: "ws", version: "8.18.3" } }), /Unpatched/);
  assert.throws(() => assertPatched({ ...patched, vulnerable: { name: "bn.js", version: "4.12.2" } }), /Unpatched/);
  assert.throws(() => assertPatched({}), /missing/);
});

test("a missing required runtime fails even without npm's empty placeholder directory", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "merrymen-verify-missing-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(path.join(directory, "package.json"), JSON.stringify({ name: "merrymen", version: "1.0.0", dependencies: { react: "19.2.4" } }));
  assert.throws(() => physicalLock(directory), /Required runtime dependency missing.*react/);
});

test("empty hoisted placeholders are accepted only when required dependencies and peers resolve", (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), "merrymen-verify-hoisted-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  function pkg(location, value) {
    const target = path.join(directory, location);
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, "package.json"), JSON.stringify(value));
  }
  pkg("", { name: "merrymen", version: "1.0.0", dependencies: { wrapper: "1.0.0" } });
  pkg("node_modules/wrapper", { name: "wrapper", version: "1.0.0", dependencies: { "@noble/curves": "1.9.7" }, peerDependencies: { react: "19.2.4", absentOptional: "*" }, peerDependenciesMeta: { absentOptional: { optional: true } } });
  mkdirSync(path.join(directory, "node_modules/wrapper/node_modules/@noble/curves"), { recursive: true });
  assert.throws(() => physicalLock(directory), /missing.*@noble\/curves/);
  pkg("node_modules/@noble/curves", { name: "@noble/curves", version: "1.9.7" });
  assert.throws(() => physicalLock(directory), /missing.*react/);
  pkg("node_modules/react", { name: "react", version: "19.2.4" });
  const snapshot = physicalLock(directory);
  assert.equal(snapshot.lock.packages["node_modules/merrymen/node_modules/wrapper/node_modules/@noble/curves"], undefined);
  assert.equal(snapshot.lock.packages["node_modules/merrymen/node_modules/@noble/curves"].version, "1.9.7");
  writeFileSync(path.join(directory, "node_modules/wrapper/node_modules/@noble/curves/partial.js"), "// incomplete extraction");
  assert.throws(() => physicalLock(directory), /package\.json/);
});
