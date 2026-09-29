/**
 * THE HOSTED CHILD'S perp-key.json (docs/perps.md rule 5), against real files.
 *
 *   - a grant with a sealed key: the orchestrator opens it with the DEK and
 *     writes 0600 perp-key.json in keystore's format, which the child's
 *     keystore loads against the sealed public key;
 *   - a grant without a perp block: a stale perp-key.json is removed — only
 *     AFTER the grant is written;
 *   - no DEK, or a blob sealed for anyone else: nothing is written;
 *   - the key never goes into the child's environment (the orchestrator
 *     source is checked for that, and for where the calls sit).
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { hostedPerpKeyFile, loadPerpPrivateKey } from "./keystore";
import { sealPerpKey } from "./key-seal";
import { syncChildPerpKey } from "./child-key";

const ROOT = mkdtempSync(path.join(os.tmpdir(), "merrymen-perp-childkey-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));
let n = 0;
const home = () => {
  const h = path.join(ROOT, `child-${n++}`);
  mkdirSync(h, { recursive: true });
  return h;
};

const DEK = Buffer.alloc(32, 7);
const TENANT = "0x00000000000000000000000000000000000000aa" as const;
const ACCOUNT = "0x00000000000000000000000000000000000000a1" as const;
const pub = (b: number) => `0x${(b.toString(16).padStart(2, "0") + "00".repeat(7)).repeat(5)}` as `0x${string}`;
const PRIV = `0x${"ab".repeat(40)}` as `0x${string}`;
const POSIX = process.platform !== "win32";

function grant(opts: { perp?: boolean; pub?: `0x${string}`; priv?: `0x${string}`; sealedFor?: string } = {}) {
  const p = opts.pub ?? pub(1);
  const base = { smartAccount: ACCOUNT, chainId: 4663, grantFeatures: ["tradeable-v2"] as string[] };
  if (opts.perp === false) return base;
  const apiKeySealed = sealPerpKey(opts.priv ?? PRIV, { tenant: opts.sealedFor ?? TENANT, smartAccount: ACCOUNT, apiPublicKey: p, apiKeyIndex: 16 }, DEK);
  return { ...base, grantFeatures: [...base.grantFeatures, "perp-lighter-v1"], perp: { route: "perp-lighter-v1", apiKeyIndex: 16, apiPublicKey: p, apiKeySealed } };
}

describe("syncChildPerpKey", () => {
  it("WRITES the opened key, 0600, in keystore's format — and the child's keystore loads it", () => {
    const h = home();
    assert.equal(syncChildPerpKey({ home: h, tenant: TENANT, grant: grant(), dek: DEK, phase: "before-grant" }), "written");
    const file = hostedPerpKeyFile(h);
    if (POSIX) assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(loadPerpPrivateKey({ home: h, apiPublicKey: pub(1) }), { privateKey: PRIV, publicKey: pub(1) });
    assert.deepEqual(readdirSync(h), ["perp-key.json"], "no temp file left behind");
    // Idempotent: a second pass touches nothing.
    const before = statSync(file).mtimeMs;
    assert.equal(syncChildPerpKey({ home: h, tenant: TENANT, grant: grant(), dek: DEK, phase: "before-grant" }), "unchanged");
    assert.equal(statSync(file).mtimeMs, before);
  });

  it("a ROTATED key replaces the old file; a loosened mode is rewritten, not kept", () => {
    const h = home();
    syncChildPerpKey({ home: h, tenant: TENANT, grant: grant(), dek: DEK, phase: "before-grant" });
    const rotated = `0x${"cd".repeat(40)}` as `0x${string}`;
    assert.equal(syncChildPerpKey({ home: h, tenant: TENANT, grant: grant({ pub: pub(2), priv: rotated }), dek: DEK, phase: "before-grant" }), "written");
    assert.deepEqual(loadPerpPrivateKey({ home: h, apiPublicKey: pub(2) }), { privateKey: rotated, publicKey: pub(2) });
    if (POSIX) {
      chmodSync(hostedPerpKeyFile(h), 0o644);
      assert.equal(syncChildPerpKey({ home: h, tenant: TENANT, grant: grant({ pub: pub(2), priv: rotated }), dek: DEK, phase: "before-grant" }), "written");
      assert.equal(statSync(hostedPerpKeyFile(h)).mode & 0o777, 0o600);
    }
  });

  it("REMOVES a stale key when the grant has no perp block — after the grant, never before", () => {
    const h = home();
    syncChildPerpKey({ home: h, tenant: TENANT, grant: grant(), dek: DEK, phase: "before-grant" });
    assert.equal(syncChildPerpKey({ home: h, tenant: TENANT, grant: grant({ perp: false }), dek: DEK, phase: "before-grant" }), "absent");
    assert.ok(existsSync(hostedPerpKeyFile(h)), "not before the new grant is in place");
    assert.equal(syncChildPerpKey({ home: h, tenant: TENANT, grant: grant({ perp: false }), dek: DEK, phase: "after-grant" }), "removed");
    assert.ok(!existsSync(hostedPerpKeyFile(h)));
    assert.equal(syncChildPerpKey({ home: h, tenant: TENANT, grant: grant({ perp: false }), dek: DEK, phase: "after-grant" }), "absent");
  });

  it("NO DEK, or a blob sealed for another tenant: nothing is written", () => {
    const h = home();
    assert.equal(syncChildPerpKey({ home: h, tenant: TENANT, grant: grant(), dek: null, phase: "before-grant" }), "no-dek");
    assert.equal(
      syncChildPerpKey({ home: h, tenant: TENANT, grant: grant({ sealedFor: "0x00000000000000000000000000000000000000bb" }), dek: DEK, phase: "before-grant" }),
      "unopenable",
    );
    assert.equal(syncChildPerpKey({ home: h, tenant: TENANT, grant: grant(), dek: Buffer.alloc(32, 9), phase: "before-grant" }), "unopenable");
    assert.ok(!existsSync(hostedPerpKeyFile(h)));
  });

  it("a perp block with no sealed key (a self-hosted grant) leaves the home alone", () => {
    const h = home();
    writeFileSync(path.join(h, "sentinel"), "x");
    const g = grant();
    delete (g as { perp: { apiKeySealed?: string } }).perp.apiKeySealed;
    assert.equal(syncChildPerpKey({ home: h, tenant: TENANT, grant: g, dek: DEK, phase: "before-grant" }), "unsealed");
    assert.deepEqual(readdirSync(h), ["sentinel"]);
  });
});

describe("the orchestrator writes it where rule 5 says, and nowhere else", () => {
  const code = readFileSync(new URL("../orchestrator.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");
  const body = (name: string) => {
    const at = code.indexOf(`async function ${name}(`);
    assert.ok(at > 0, `${name} must exist`);
    return code.slice(at, code.indexOf("\nasync function ", at + 10));
  };

  for (const fn of ["writeGrantForChild", "refreshGrantForChild"]) {
    it(`${fn}: the key before grant.json, the stale-key removal after it`, () => {
      const b = body(fn);
      const before = b.indexOf('"before-grant"');
      const write = b.indexOf("writeFileSync(");
      const afterAt = b.lastIndexOf('"after-grant"');
      assert.ok(before > 0 && write > before, "perp-key.json is written before grant.json");
      assert.ok(afterAt > write, "a stale key is removed only after grant.json");
    });
  }

  it("the key never enters a child's environment", () => {
    const env = code.slice(code.indexOf("export function childEnv("), code.indexOf("\n}\n", code.indexOf("export function childEnv(")));
    assert.ok(env.length > 0);
    assert.ok(!/perp|PERP|syncChildPerpKey|openPerpKey/.test(env), "childEnv must not carry anything perp");
    assert.match(code, /"MERRYMEN_STORE_DEK"/, "and the DEK stays stripped from children");
  });
});
