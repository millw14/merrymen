import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { assertPatched, evaluateAudit, physicalLock, ZOD3_EXCEPTION } from "./verify-installed.mjs";

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

// npm audit's report, as it reads for the installed tree on 2026-10-25.
const advisory = (id, severity, title) => ({ source: 1, name: id, title, url: `https://github.com/advisories/${id}`, severity, range: "*" });
const ZOD = advisory("GHSA-mrhx-c7xc-m3w5", "high", "Zod can exhaust memory while validating oversized constrained collections");
const NEXT = advisory("GHSA-2464-fhr4-w9xw", "critical", "Next.js: Unauthenticated Remote Code Execution in Image Optimization API");
const zodUnder = (parent) => `node_modules/merrymen/node_modules/${parent}/node_modules/zod`;
const sdkCopies = [...ZOD3_EXCEPTION.parents.map(zodUnder), "node_modules/merrymen/node_modules/@wagmi/connectors/node_modules/@reown/appkit-wallet/node_modules/zod"];
const zod3 = (nodes) => Object.fromEntries(nodes.map((node) => [node, { name: "zod", version: node.includes("appkit-wallet") ? "3.22.4" : "3.25.76" }]));
const report = (vulnerabilities) => ({ vulnerabilities, metadata: { vulnerabilities: { total: Object.keys(vulnerabilities).length } } });
const zodFinding = (nodes, via = [ZOD]) => ({ name: "zod", severity: "high", via, nodes });
const dependent = (name, ...via) => ({ name, severity: "high", via, nodes: [`node_modules/merrymen/node_modules/${name}`] });
const october = new Date("2026-10-25T12:00:00Z");

test("the zod 3 exception excuses only the five SDKs' copies and what is flagged through them", () => {
  const audit = report({
    zod: zodFinding(sdkCopies),
    "@privy-io/api-base": dependent("@privy-io/api-base", "zod"),
    "@privy-io/react-auth": dependent("@privy-io/react-auth", "@privy-io/api-base"),
    merrymen: dependent("merrymen", "@privy-io/react-auth", "zod"),
  });
  assert.deepEqual(evaluateAudit(audit, zod3(sdkCopies), october), sdkCopies);
  assert.deepEqual(evaluateAudit(report({}), {}, october), []);
});

test("a zod copy anywhere else, or a zod 4 copy under one of the five, still fails", () => {
  const own = "node_modules/merrymen/node_modules/zod";
  assert.throws(() => evaluateAudit(report({ zod: zodFinding([...sdkCopies, own]) }), { ...zod3(sdkCopies), [own]: { name: "zod", version: "4.6.5" } }, october), /1 vulnerable packages: zod \(high/);
  const other = zodUnder("@some/other-sdk");
  assert.throws(() => evaluateAudit(report({ zod: zodFinding([other]) }), zod3([other]), october), /zod \(high/);
  const four = zodUnder("x402");
  assert.throws(() => evaluateAudit(report({ zod: zodFinding([four]) }), { [four]: { name: "zod", version: "4.6.5" } }, october), /zod \(high/);
  assert.throws(() => evaluateAudit(report({ zod: zodFinding([sdkCopies[0]]) }), {}, october), /zod \(high/);
});

test("every other advisory still fails, alone or beside the excused one", () => {
  const audit = report({
    zod: zodFinding(sdkCopies),
    next: { name: "next", severity: "critical", via: [NEXT], nodes: ["node_modules/merrymen/node_modules/next"] },
    merrymen: dependent("merrymen", "next", "zod"),
  });
  assert.throws(() => evaluateAudit(audit, zod3(sdkCopies), october), /2 vulnerable packages: next \(critical: https:\/\/github\.com\/advisories\/GHSA-2464-fhr4-w9xw\); merrymen \(high: via next, via zod\)/);
  assert.throws(() => evaluateAudit(report({ zod: zodFinding(sdkCopies, [ZOD, NEXT]) }), zod3(sdkCopies), october), /zod \(high/);
  assert.throws(() => evaluateAudit(report({ zod: zodFinding(sdkCopies, [ZOD, "@some/dep"]) }), zod3(sdkCopies), october), /zod \(high/);
});

test("the exception ends after its last day, and npm's own failure is never a pass", () => {
  const audit = report({ zod: zodFinding(sdkCopies) });
  assert.deepEqual(evaluateAudit(audit, zod3(sdkCopies), new Date(`${ZOD3_EXCEPTION.lastDay}T23:59:59Z`)), sdkCopies);
  assert.throws(() => evaluateAudit(audit, zod3(sdkCopies), new Date("2026-11-09T00:00:00Z")), /ended after 2026-11-08/);
  assert.throws(() => evaluateAudit({ error: { code: "ENOAUDIT", summary: "registry unreachable" } }, {}, october), /npm audit failed/);
});
