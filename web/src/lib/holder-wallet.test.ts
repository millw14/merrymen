/**
 * ONE $MERRYMEN WALLET POWERS ONE AGENT — as every holder screen sees it.
 *
 * /api/tier, /api/circle and /api/alpha all ask holderWalletFor whose wallet
 * counts, and the orchestrator asks effectiveHolder the same question about the
 * same claims before it writes the child's settings.json. These run the real
 * resolver over the real (file) store: a linked wallet counts only while its
 * claim names this account, a login wallet only while nobody else claims it,
 * and a store we cannot read is an unread standing — never a guess.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { getSettingsStore, resetSettingsStoreForTest } from "@merrymen/settings-store";
import { holderWalletFor } from "./holder-wallet";

const A = "0x00000000000000000000000000000000000000a1";
const B = "0x00000000000000000000000000000000000000b2";
const W = "0x000000000000000000000000000000000000beef";
const KEYS = ["MERRYMEN_HOME", "DATABASE_URL", "MERRYMEN_STORE_DEK"] as const;
const original = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
let root: string;
let n = 0;

before(() => {
  root = mkdtempSync(path.join(tmpdir(), "merrymen-holder-wallet-"));
  delete process.env.DATABASE_URL;
});
beforeEach(() => {
  // A fresh home (and a fresh store over it) per case: no claims, no proofs.
  process.env.MERRYMEN_HOME = path.join(root, `case-${++n}`);
  resetSettingsStoreForTest();
});
after(() => {
  for (const k of KEYS) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
  resetSettingsStoreForTest();
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

const link = async (tenant: `0x${string}`, wallet: string) =>
  getSettingsStore().put(tenant, { holderProof: { address: wallet, at: 1 } });

describe("holderWalletFor — whose wallet counts", () => {
  it("signed out: nobody", async () => {
    assert.equal(await holderWalletFor(null), null);
  });

  it("NOTHING LINKED: the login wallet", async () => {
    assert.deepEqual(await holderWalletFor(A), { address: A, source: "login" });
  });

  it("A LINKED WALLET WHOSE CLAIM NAMES THIS ACCOUNT: that wallet", async () => {
    await getSettingsStore().claimHolder(W, A);
    await link(A, W);
    assert.deepEqual(await holderWalletFor(A), { address: W, source: "linked" });
  });

  it("A LINKED WALLET ANOTHER ACCOUNT HOLDS: not here — the login wallet instead", async () => {
    await getSettingsStore().claimHolder(W, B);
    await link(A, W);
    await link(B, W);
    assert.deepEqual(await holderWalletFor(A), { address: A, source: "login" });
    assert.deepEqual(await holderWalletFor(B), { address: W, source: "linked" }, "it powers the account holding it");
  });

  it("A PROOF NOBODY CLAIMED (pre-backfill) is a signature, not a holding", async () => {
    await link(A, W);
    assert.deepEqual(await holderWalletFor(A), { address: A, source: "login" });
  });

  it("A LOGIN WALLET LINKED INTO ANOTHER ACCOUNT COUNTS THERE, NOT HERE: no wallet", async () => {
    await getSettingsStore().claimHolder(A, B);
    await link(B, A);
    assert.deepEqual(await holderWalletFor(A), { address: null, source: null });
    assert.deepEqual(await holderWalletFor(B), { address: A, source: "linked" });
  });

  it("settings.holderAddress is never read, whatever it names", async () => {
    await getSettingsStore().put(A, { holderAddress: W });
    assert.deepEqual(await holderWalletFor(A), { address: A, source: "login" });
  });

  it("AN UNREADABLE CLAIMS STORE THROWS — it used to fall back to the login wallet, which may be another account's now", async () => {
    await getSettingsStore().claimHolder(A, B);
    const dir = path.join(process.env.MERRYMEN_HOME!, "holder-claims");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${A}.json`), "{ torn");
    await assert.rejects(holderWalletFor(A));
  });
});

/** Comments stripped, so a header naming what a route refuses does not satisfy a pin. */
const code = (p: string) =>
  readFileSync(new URL(p, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split(/\r?\n/)
    .map((l) => l.replace(/(^|[^:])\/\/.*$/, "$1"))
    .join("\n");

describe("every holder screen answers an unreadable resolver as unreadable", () => {
  it("/api/tier: a throw is why 'unreadable', before any count", () => {
    const src = code("../app/api/tier/route.ts");
    const at = src.indexOf("holderWalletFor(tenantOf(req))");
    assert.ok(at > 0);
    const after = src.slice(at, src.indexOf("wallet = resolved.address", at));
    assert.match(after, /\} catch \{\s*return NextResponse\.json\(view\(\{ why: "unreadable" \}\)\);/);
  });

  it("/api/circle: a throw is why 'unreadable' with every balance null", () => {
    const src = code("../app/api/circle/route.ts");
    const at = src.indexOf("holderWalletFor(tenantOf(req))");
    const arm = src.slice(at, src.indexOf("if (!resolved)", at));
    assert.match(arm, /why: "unreadable"/);
    for (const f of ["balance: null", "holderBalance: null", "agentBalance: null", "tier: null"]) assert.ok(arm.includes(f), f);
  });

  it("/api/alpha: resolved inside the try, and NEVER falls back to the session wallet", () => {
    const src = code("../app/api/alpha/route.ts");
    const tryAt = src.indexOf("try {", src.indexOf("let raw: bigint;"));
    const resolve = src.indexOf("holderWalletFor(tenant)");
    const cat = src.indexOf("} catch {", tryAt);
    assert.ok(tryAt > 0 && resolve > tryAt && resolve < cat, "a claims store that throws is `unreachable`, not a crash");
    assert.ok(!/holderWalletFor\(tenant\)\)\?\.address \?\? tenant/.test(src), "the login wallet may be powering another account");
    assert.match(src, /holderWalletFor\(tenant\)\)\?\.address \?\? null/);
  });
});
