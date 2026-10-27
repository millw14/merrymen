/**
 * THE WEB'S PERPS GATE IS THE WORKER'S, READ THE SAME WAY.
 *
 * perpsOffered, perpsCreationAllowed and perpsWorkersRun answer from
 * MERRYMEN_PERPS through the one core parser, so the web cannot offer a wallet
 * the deployment's workers would stand down, or queue for a worker that is not
 * running. Unset is off (rule 1), `live` is off in this build, and a typo is off.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { perpsCreationAllowed, perpsOffered, perpsWalletRefused, perpsWorkersRun } from "./perps-enabled";
import { perpsCeilingOf as workerCeilingOf } from "../../../worker/src/settings";

describe("the web's perps gate", () => {
  it("unset is off: nothing offered, nothing made, no worker runs", () => {
    assert.equal(perpsOffered({}), false);
    assert.equal(perpsCreationAllowed({}), false);
    assert.equal(perpsWorkersRun({}), false);
  });

  it("paper offers Perps, allows a paper wallet to be made, and runs its worker", () => {
    for (const v of ["paper", " Paper "]) {
      assert.equal(perpsOffered({ MERRYMEN_PERPS: v }), true, v);
      assert.equal(perpsCreationAllowed({ MERRYMEN_PERPS: v }), true, v);
      assert.equal(perpsWorkersRun({ MERRYMEN_PERPS: v }), true, v);
    }
  });

  it("off, live (not in this build) and anything unrecognised are off for all three", () => {
    for (const v of ["off", "", "live", "LIVE", "lvie", "1", "true", "on", "paper,live"]) {
      assert.equal(perpsOffered({ MERRYMEN_PERPS: v }), false, v);
      assert.equal(perpsCreationAllowed({ MERRYMEN_PERPS: v }), false, v);
      assert.equal(perpsWorkersRun({ MERRYMEN_PERPS: v }), false, v);
    }
  });

  it("perpsWorkersRun is the orchestrator's spawn rule and the worker's stand-down, read the same way", async () => {
    const { mergeSettings, perpsWorkerStoodDown } = await import("../../../worker/src/settings");
    for (const v of [undefined, "paper", "live", "off", "x"]) {
      const perpsWorker = mergeSettings({}, { MERRYMEN_WALLET_PURPOSE: "perps", ...(v === undefined ? {} : { MERRYMEN_PERPS: v }) });
      assert.equal(perpsWorkersRun({ MERRYMEN_PERPS: v }), !perpsWorkerStoodDown(perpsWorker), String(v));
    }
  });

  it("perpsWalletRefused: 403 perps-wallet-not-offered, the grants route's code, in the owner's words, never stored", async () => {
    const res = perpsWalletRefused("No Perps order was queued.");
    assert.equal(res.status, 403);
    assert.equal(res.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await res.json(), {
      error: "Perps wallets are not offered on this server yet. No Perps order was queued.",
      code: "perps-wallet-not-offered",
      ownerFacing: true,
    });
  });

  it("reads the process's own environment when none is passed", () => {
    const saved = process.env.MERRYMEN_PERPS;
    try {
      delete process.env.MERRYMEN_PERPS;
      assert.equal(perpsOffered(), false);
      assert.equal(perpsCreationAllowed(), false);
      assert.equal(perpsWorkersRun(), false);
      process.env.MERRYMEN_PERPS = "paper";
      assert.equal(perpsOffered(), true);
      assert.equal(perpsCreationAllowed(), true);
      assert.equal(perpsWorkersRun(), true);
    } finally {
      if (saved === undefined) delete process.env.MERRYMEN_PERPS;
      else process.env.MERRYMEN_PERPS = saved;
    }
  });

  it("is the worker's parser, not a second one that can drift", () => {
    // worker/src/settings.ts re-exports the core parser; the web imports the same file.
    for (const v of [undefined, "paper", "live", "off", "x"]) {
      assert.equal(perpsOffered({ MERRYMEN_PERPS: v }), workerCeilingOf(v) !== "off", String(v));
      assert.equal(perpsCreationAllowed({ MERRYMEN_PERPS: v }), workerCeilingOf(v) === "paper", String(v));
      assert.equal(perpsWorkersRun({ MERRYMEN_PERPS: v }), workerCeilingOf(v) === "paper", String(v));
    }
  });

  it("no client module imports it: in a browser bundle process.env is empty, so it would always say off", () => {
    const SRC = path.join(process.cwd(), "web", "src");
    const walk = (dir: string, out: string[] = []): string[] => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full, out);
        else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full);
      }
      return out;
    };
    const offenders = walk(SRC)
      .filter((f) => {
        const text = readFileSync(f, "utf8");
        return /^\s*["']use client["']/m.test(text) && /perps-enabled/.test(text);
      })
      .map((f) => path.relative(process.cwd(), f));
    assert.deepEqual(offenders, []);
  });
});
