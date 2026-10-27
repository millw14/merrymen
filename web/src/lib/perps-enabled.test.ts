/**
 * THE WEB'S PERPS GATE IS THE WORKER'S, READ THE SAME WAY.
 *
 * perpsOffered and perpsCreationAllowed answer from MERRYMEN_PERPS through the
 * one core parser, so the web cannot offer a wallet the deployment's workers
 * would stand down. Unset is off (rule 1), `live` is off in this build, and a
 * typo is off.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { perpsCreationAllowed, perpsOffered } from "./perps-enabled";
import { perpsCeilingOf as workerCeilingOf } from "../../../worker/src/settings";

describe("the web's perps gate", () => {
  it("unset is off: nothing offered, nothing made", () => {
    assert.equal(perpsOffered({}), false);
    assert.equal(perpsCreationAllowed({}), false);
  });

  it("paper offers Perps and allows a paper wallet to be made", () => {
    for (const v of ["paper", " Paper "]) {
      assert.equal(perpsOffered({ MERRYMEN_PERPS: v }), true, v);
      assert.equal(perpsCreationAllowed({ MERRYMEN_PERPS: v }), true, v);
    }
  });

  it("off, live (not in this build) and anything unrecognised are off for both", () => {
    for (const v of ["off", "", "live", "LIVE", "lvie", "1", "true", "on", "paper,live"]) {
      assert.equal(perpsOffered({ MERRYMEN_PERPS: v }), false, v);
      assert.equal(perpsCreationAllowed({ MERRYMEN_PERPS: v }), false, v);
    }
  });

  it("reads the process's own environment when none is passed", () => {
    const saved = process.env.MERRYMEN_PERPS;
    try {
      delete process.env.MERRYMEN_PERPS;
      assert.equal(perpsOffered(), false);
      assert.equal(perpsCreationAllowed(), false);
      process.env.MERRYMEN_PERPS = "paper";
      assert.equal(perpsOffered(), true);
      assert.equal(perpsCreationAllowed(), true);
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
