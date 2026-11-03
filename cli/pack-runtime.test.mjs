import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { assertBuildOnlyBundled, buildOnlyPackages, packRuntime, runtimeBundlePlan } from "./pack-runtime.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), "merrymen-runtime-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = { name: "merrymen-runtime-fixture", version: "1.0.0", files: ["cli"], dependencies: { wrapper: "^1.0.0" }, scripts: { prepack: "exit 19", prepare: "exit 20" }, overrides: { leaf: "2.0.0" } };
  const wrapper = { name: "wrapper", version: "1.0.0", dependencies: { leaf: "1.0.0" }, optionalDependencies: { "platform-addon": "1.0.0" } };
  const leaf = { name: "leaf", version: "2.0.0" };
  const lock = { name: manifest.name, version: manifest.version, lockfileVersion: 3, packages: { "": { ...manifest }, "node_modules/wrapper": { ...wrapper }, "node_modules/leaf": { ...leaf }, "node_modules/platform-addon": { version: "1.0.0", optional: true, os: ["linux"], cpu: ["x64"] } } };
  mkdirSync(path.join(root, "cli"));
  writeFileSync(path.join(root, "cli/bin.mjs"), "console.log('fixture');\n");
  writeFileSync(path.join(root, ".env"), "unrelated local data");
  writeFileSync(path.join(root, "package.json"), JSON.stringify(manifest));
  writeFileSync(path.join(root, "package-lock.json"), JSON.stringify(lock));
  for (const pkg of [wrapper, leaf]) {
    const dir = path.join(root, "node_modules", pkg.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "package.json"), JSON.stringify(pkg));
    writeFileSync(path.join(dir, "LICENSE"), "fixture license");
    writeFileSync(path.join(dir, "index.js"), "module.exports = 1;\n");
  }
  return { root, manifest, lock, wrapper, outDir: path.join(root, "release"), bundleRoots: ["wrapper"], requireBuild: false };
}

function tarRead(tarball, file) {
  const result = spawnSync("tar", ["-xOf", tarball, `package/${file}`], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test("release plan pins the audited override tree and externalizes optional native packages", t => {
  const f = fixture(t); const plan = runtimeBundlePlan(f.manifest, f.lock, f.bundleRoots);
  assert.deepEqual(plan.manifest.dependencies, { wrapper: "1.0.0" });
  assert.deepEqual(plan.manifest.optionalDependencies, { "platform-addon": "1.0.0" });
  assert.deepEqual(plan.manifest.bundleDependencies, ["wrapper"]);
  assert.equal(plan.manifest.overrides, undefined);
  assert.equal(plan.manifest.scripts.prepack, undefined);
  assert.equal(plan.manifest.scripts.prepare, undefined);
  assert.deepEqual(plan.packages.map(p => [p.path, p.version, p.externalOptionals]), [["node_modules/wrapper", "1.0.0", ["platform-addon"]], ["node_modules/leaf", "2.0.0", []]]);
});

test("a direct optional runtime remains an unbundled production dependency", t => {
  const f = fixture(t);
  f.manifest.dependencies["platform-addon"] = "^1.0.0";
  f.lock.packages[""].dependencies = { ...f.manifest.dependencies };
  const plan = runtimeBundlePlan(f.manifest, f.lock, f.bundleRoots);
  assert.equal(plan.manifest.dependencies["platform-addon"], "1.0.0");
  assert.equal(plan.manifest.optionalDependencies["platform-addon"], undefined);
  assert(!plan.packages.some(p => p.path.endsWith("platform-addon")));
});

test("pack refuses stale lock metadata and absent runtime dependencies", t => {
  const f = fixture(t);
  f.lock.packages[""].dependencies = { wrapper: "^9.0.0" };
  assert.throws(() => runtimeBundlePlan(f.manifest, f.lock, f.bundleRoots), /stale dependencies/);
  f.lock.packages[""].dependencies = f.manifest.dependencies;
  delete f.lock.packages["node_modules/leaf"];
  assert.throws(() => runtimeBundlePlan(f.manifest, f.lock, f.bundleRoots), /lock is missing leaf/);
});

test("conflicting optional versions refuse normalization instead of changing behavior", t => {
  const f = fixture(t);
  f.manifest.dependencies["platform-addon"] = "2.0.0";
  f.lock.packages[""].dependencies = { ...f.manifest.dependencies };
  f.lock.packages["node_modules/platform-addon"].version = "2.0.0";
  f.lock.packages["node_modules/wrapper/node_modules/platform-addon"] = { version: "1.0.0", optional: true };
  assert.throws(() => runtimeBundlePlan(f.manifest, f.lock, f.bundleRoots), /conflicting optional dependency/);
});

test("bundled required peers must exist in the audit lock and remain explicitly installed", t => {
  const f = fixture(t);
  f.lock.packages["node_modules/wrapper"].peerDependencies = { "required-peer": "^3.0.0", "unused-optional-peer": "*" };
  f.lock.packages["node_modules/wrapper"].peerDependenciesMeta = { "unused-optional-peer": { optional: true } };
  assert.throws(() => runtimeBundlePlan(f.manifest, f.lock, f.bundleRoots), /lock is missing required-peer/);
  f.lock.packages["node_modules/required-peer"] = { version: "3.0.4" };
  const plan = runtimeBundlePlan(f.manifest, f.lock, f.bundleRoots);
  assert.equal(plan.manifest.dependencies["required-peer"], "3.0.4");
  assert.equal(plan.manifest.dependencies["unused-optional-peer"], undefined);
  assert.deepEqual(plan.packages[0].externalPeers, ["required-peer", "unused-optional-peer"]);
});

test("packed external peer declarations cannot suppress installation of pinned root peers", async t => {
  const f = fixture(t);
  const peers = { "required-peer": "^3.0.0", "unused-optional-peer": "*" };
  const peerMeta = { "unused-optional-peer": { optional: true } };
  Object.assign(f.lock.packages["node_modules/wrapper"], { peerDependencies: peers, peerDependenciesMeta: peerMeta });
  f.lock.packages["node_modules/required-peer"] = { version: "3.0.4" };
  writeFileSync(path.join(f.root, "package-lock.json"), JSON.stringify(f.lock));
  writeFileSync(path.join(f.root, "node_modules/wrapper/package.json"), JSON.stringify({ ...f.wrapper, peerDependencies: peers, peerDependenciesMeta: peerMeta }));
  const packed = await packRuntime(f);
  const wrapper = JSON.parse(tarRead(packed.path, "node_modules/wrapper/package.json"));
  assert.deepEqual(wrapper.peerDependencies, {});
  assert.deepEqual(wrapper.peerDependenciesMeta, {});
  const manifest = JSON.parse(tarRead(packed.path, "package.json"));
  assert.equal(manifest.dependencies["required-peer"], "3.0.4");
  assert.equal(manifest.dependencies["unused-optional-peer"], undefined);
});

test("release packaging refuses incomplete dashboard builds", async t => {
  const f = fixture(t);
  await assert.rejects(() => packRuntime({ ...f, requireBuild: true }), /Production dashboard is incomplete/);
  assert.equal(existsSync(f.outDir), false);
});

test("real npm pack includes audited JS and licenses without mutating source or running scripts", async t => {
  const f = fixture(t);
  const manifestBefore = readFileSync(path.join(f.root, "package.json"), "utf8");
  const wrapperBefore = readFileSync(path.join(f.root, "node_modules/wrapper/package.json"), "utf8");
  const packed = await packRuntime(f);
  assert.equal(readFileSync(path.join(f.root, "package.json"), "utf8"), manifestBefore);
  assert.equal(readFileSync(path.join(f.root, "node_modules/wrapper/package.json"), "utf8"), wrapperBefore);
  assert.equal(JSON.parse(tarRead(packed.path, "node_modules/leaf/package.json")).version, "2.0.0");
  assert.deepEqual(JSON.parse(tarRead(packed.path, "node_modules/wrapper/package.json")).optionalDependencies, {});
  assert.equal(tarRead(packed.path, "node_modules/wrapper/LICENSE"), "fixture license");
  const metadata = JSON.parse(tarRead(packed.path, "cli/runtime-dependencies.json"));
  assert.match(metadata.lockSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(metadata.packages[0].externalOptionals, ["platform-addon"]);
  const listing = spawnSync("tar", ["-tzf", packed.path], { encoding: "utf8" });
  assert.equal(listing.status, 0);
  assert(!listing.stdout.includes("package/.env"));
  assert(!listing.stdout.includes("npm-shrinkwrap.json"));
  assert(!listing.stdout.includes("node_modules/platform-addon"));
  await assert.rejects(() => packRuntime(f), /EEXIST/);
});

test("packing refuses installed code with a different version than the audited lock", async t => {
  const f = fixture(t);
  writeFileSync(path.join(f.root, "node_modules/leaf/package.json"), JSON.stringify({ name: "leaf", version: "1.0.0" }));
  await assert.rejects(() => packRuntime(f), /audited lock requires 2.0.0/);
  assert.equal(existsSync(f.outDir), false);
});

test("a files allowlist cannot accidentally publish nested environment files", async t => {
  const f = fixture(t);
  mkdirSync(path.join(f.root, "web"));
  writeFileSync(path.join(f.root, "web/.env.local"), "synthetic test sentinel");
  f.manifest.files.push("web");
  writeFileSync(path.join(f.root, "package.json"), JSON.stringify(f.manifest));
  await assert.rejects(() => packRuntime(f), /Refusing to package an environment file/);
  assert.equal(existsSync(f.outDir), false);
  f.manifest.files.push("!**/.env", "!**/.env.*");
  writeFileSync(path.join(f.root, "package.json"), JSON.stringify(f.manifest));
  const packed = await packRuntime(f);
  const listing = spawnSync("tar", ["-tzf", packed.path], { encoding: "utf8" });
  assert.equal(listing.status, 0);
  assert(!listing.stdout.includes(".env"));
});


test("prebuilt releases omit browser build trees while source plans retain them", () => {
  const root = new URL("../", import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
  const lock = JSON.parse(readFileSync(new URL("package-lock.json", root), "utf8"));
  const source = runtimeBundlePlan(manifest, lock);
  const prebuilt = runtimeBundlePlan(manifest, lock, undefined, ["@gloamtrade/sdk", "snarkjs"]);
  for (const name of ["@gloamtrade/sdk", "snarkjs"]) {
    assert.ok(source.manifest.dependencies[name]);
    assert.equal(prebuilt.manifest.dependencies[name], undefined);
  }
  const omitted = buildOnlyPackages(manifest, lock);
  for (const name of ["@gloamtrade/sdk", "snarkjs", "circomlibjs", "elliptic", "filelist"]) {
    assert.ok(omitted.includes(`node_modules/${name}`), name);
  }
  assert.ok(!omitted.includes("node_modules/viem"), "shared worker runtime stays installed");
});

test("prebuilt omission refuses traced or external runtime imports", t => {
  const f = fixture(t);
  const server = path.join(f.root, "web/.next/server");
  mkdirSync(server, { recursive: true });
  const trace = path.join(server, "page.js.nft.json");
  const js = path.join(server, "page.js");
  writeFileSync(js, "module.exports = 42");
  writeFileSync(trace, JSON.stringify({ files: ["../../../node_modules/viem/index.js"] }));
  assert.doesNotThrow(() => assertBuildOnlyBundled(f.root, ["node_modules/@gloamtrade/sdk", "node_modules/snarkjs"]));
  writeFileSync(trace, JSON.stringify({ files: ["../../../node_modules/snarkjs/main.js"] }));
  assert.throws(() => assertBuildOnlyBundled(f.root, ["node_modules/snarkjs"]), /trace still needs/);
  writeFileSync(trace, JSON.stringify({ files: [] }));
  for (const source of ['module.exports = require("snarkjs")', 'import("@gloamtrade/sdk")', 'import { groth16 } from "snarkjs"']) {
    writeFileSync(js, source);
    assert.throws(() => assertBuildOnlyBundled(f.root, ["node_modules/@gloamtrade/sdk", "node_modules/snarkjs"]), /still imports/);
  }
  writeFileSync(js, "module.exports = 42");
  writeFileSync(path.join(f.root, "cli/bin.mjs"), 'import "snarkjs";');
  assert.throws(() => assertBuildOnlyBundled(f.root, ["node_modules/snarkjs"]), /still imports/);
});


test("prebuilt packaging retains build-input provenance and licenses without Node implementation trees", async t => {
  const f = fixture(t);
  const prover = { name: "snarkjs", version: "1.0.0", license: "GPL-3.0" };
  f.manifest.dependencies.snarkjs = "1.0.0";
  f.lock.packages[""].dependencies = { ...f.manifest.dependencies };
  f.lock.packages["node_modules/snarkjs"] = { ...prover, resolved: "https://registry.npmjs.org/snarkjs/-/snarkjs-1.0.0.tgz", integrity: "sha512-fixture" };
  writeFileSync(path.join(f.root, "package.json"), JSON.stringify(f.manifest));
  writeFileSync(path.join(f.root, "package-lock.json"), JSON.stringify(f.lock));
  mkdirSync(path.join(f.root, "node_modules/snarkjs"), { recursive: true });
  writeFileSync(path.join(f.root, "node_modules/snarkjs/package.json"), JSON.stringify(prover));
  writeFileSync(path.join(f.root, "node_modules/snarkjs/COPYING"), "prover license");
  writeFileSync(path.join(f.root, "node_modules/snarkjs/index.js"), "module.exports = 'unused Node implementation';");
  mkdirSync(path.join(f.root, "web/.next/server"), { recursive: true });
  for (const name of ["BUILD_ID", "required-server-files.json", "prerender-manifest.json", "routes-manifest.json"]) writeFileSync(path.join(f.root, "web/.next", name), "{}");
  writeFileSync(path.join(f.root, "web/.next/server/page.js"), "module.exports = 42;");
  writeFileSync(path.join(f.root, "web/.next/server/page.js.nft.json"), JSON.stringify({ files: [] }));
  mkdirSync(path.join(f.root, "sdk/dist"), { recursive: true });
  writeFileSync(path.join(f.root, "sdk/dist/browser.js"), "export {};");
  const packed = await packRuntime({ ...f, requireBuild: true });
  const manifest = JSON.parse(tarRead(packed.path, "package.json"));
  assert.equal(manifest.dependencies.snarkjs, undefined);
  const report = JSON.parse(tarRead(packed.path, "cli/runtime-dependencies.json"));
  const metadata = report.browserBuildDependencies.find(pkg => pkg.name === "snarkjs");
  assert.equal(metadata.version, "1.0.0");
  assert.equal(metadata.integrity, "sha512-fixture");
  assert.equal(metadata.license, "GPL-3.0");
  assert.equal(tarRead(packed.path, metadata.licenses[0]), "prover license");
  const listing = spawnSync("tar", ["-tzf", packed.path], { encoding: "utf8" });
  assert.equal(listing.status, 0);
  assert.ok(!listing.stdout.includes("node_modules/snarkjs"));
});
