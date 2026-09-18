import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { MAX_CUSTOM_TOKENS, saveTokenSettings, stageToken } from "./tokens";
import type { CustomToken } from "../../../packages/core/src/tokens";

const ADDR = "0x1111111111111111111111111111111111111111";
const ADDR2 = "0x2222222222222222222222222222222222222222";
const TENANT = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;

describe("stageToken — pure validation, no chain, no disk", () => {
  it("accepts a well-formed candidate", () => {
    const r = stageToken([], ADDR, undefined, { decimals: 18, symbol: "ruben" });
    assert.deepEqual(r, { ok: true, token: { symbol: "RUBEN", address: ADDR, decimals: 18 } });
  });

  it("prefers the owner-supplied symbol, uppercased", () => {
    const r = stageToken([], ADDR, "cate", { decimals: 6, symbol: "IGNORED" });
    assert.deepEqual(r, { ok: true, token: { symbol: "CATE", address: ADDR, decimals: 6 } });
  });

  it("rejects bad addresses, duplicates (case-insensitive), full lists, bad symbols and bad reads", () => {
    const fail = (r: { ok: boolean; reason?: string }): string => {
      assert.equal(r.ok, false);
      return (r as { reason: string }).reason;
    };
    assert.match(fail(stageToken([], "notanaddress", undefined, { decimals: 18, symbol: "X" })), /contract address/);
    const dupAddr = "0xAbC123AbC123AbC123AbC123AbC123AbC123AbC1";
    const dup = stageToken(
      [{ symbol: "RUBEN", address: dupAddr.toLowerCase() as `0x${string}`, decimals: 18 }],
      dupAddr,
      undefined,
      { decimals: 18, symbol: "RUBEN" },
    );
    assert.match(fail(dup), /already listed as RUBEN/);
    const full: CustomToken[] = Array.from({ length: MAX_CUSTOM_TOKENS }, (_, i) => ({
      symbol: `T${i}`,
      address: `0x${String(i).padStart(40, "0")}` as `0x${string}`,
      decimals: 18,
    }));
    assert.match(fail(stageToken(full, ADDR2, undefined, { decimals: 18, symbol: "X" })), /full \(50\)/);
    assert.match(
      fail(stageToken([], ADDR2, "way-too-long-symbol-name", { decimals: 18, symbol: "X" })),
      /1–16 chars/,
    );
    assert.match(fail(stageToken([], ADDR2, undefined, { error: "no contract there" })), /couldn't read/);
    assert.match(fail(stageToken([], ADDR2, undefined, { decimals: 99, symbol: "X" })), /validation/);
  });
});

describe("saveTokenSettings — durable write, both backings", () => {
  let dir = "";
  let OLD_SETTINGS_FILE: string | undefined;
  let OLD_HOME: string | undefined;
  let OLD_HOSTED: string | undefined;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "tgram-tokens-"));
    OLD_SETTINGS_FILE = process.env.MERRYMEN_SETTINGS_FILE;
    OLD_HOME = process.env.MERRYMEN_HOME;
    OLD_HOSTED = process.env.MERRYMEN_HOSTED;
    process.env.MERRYMEN_SETTINGS_FILE = path.join(dir, "settings.json");
    process.env.MERRYMEN_HOME = dir;
    delete process.env.MERRYMEN_HOSTED;
  });
  afterEach(() => {
    if (OLD_SETTINGS_FILE === undefined) delete process.env.MERRYMEN_SETTINGS_FILE;
    else process.env.MERRYMEN_SETTINGS_FILE = OLD_SETTINGS_FILE;
    if (OLD_HOME === undefined) delete process.env.MERRYMEN_HOME;
    else process.env.MERRYMEN_HOME = OLD_HOME;
    if (OLD_HOSTED === undefined) delete process.env.MERRYMEN_HOSTED;
    else process.env.MERRYMEN_HOSTED = OLD_HOSTED;
    rmSync(dir, { recursive: true, force: true });
  });

  it("self-host patches the settings file", async () => {
    const token: CustomToken = { symbol: "RUBEN", address: ADDR as `0x${string}`, decimals: 18 };
    const r = await saveTokenSettings(null, { customTokens: [token], discoveryEnabled: true });
    assert.deepEqual(r, { ok: true });
    const { readSettingsFile } = await import("../settings");
    const saved = readSettingsFile();
    assert.equal(saved.customTokens?.length, 1);
    assert.equal(saved.discoveryEnabled, true);
  });

  it("hosted writes the tenant store, and refuses without a tenant", async () => {
    process.env.MERRYMEN_HOSTED = "1";
    const noTenant = await saveTokenSettings(null, { discoveryEnabled: true });
    assert.equal(noTenant.ok, false);
    const token: CustomToken = { symbol: "RUBEN", address: ADDR as `0x${string}`, decimals: 18 };
    const r = await saveTokenSettings(TENANT, { customTokens: [token] });
    assert.deepEqual(r, { ok: true });
    const { getSettingsStore } = await import("../settings-store");
    const stored = await getSettingsStore().get(TENANT);
    assert.equal(stored?.customTokens?.length, 1);
    assert.equal(stored?.customTokens?.[0]?.address, ADDR);
  });
});
