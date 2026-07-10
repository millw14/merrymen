import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { makeCustomStrategy, resolveStrategyFile, validateIntent } from "./custom";
import type { Snapshot } from "./types";

const ROUTER = "0x1111111111111111111111111111111111111111";
const USDG = "0x3333333333333333333333333333333333333333";
const AAPL = "0x4444444444444444444444444444444444444444";

function snap(): Snapshot {
  return {
    cashUsdg: 100_000_000n,
    vaultUsdg: 0n,
    holdings: new Map(),
    prices: new Map(),
    pausedTokens: new Set(),
    staleFeeds: new Set(),
    sequencerUp: true,
  };
}

function tempDir(): string {
  const dir = path.join(tmpdir(), `merrymen-custom-${process.pid}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("validateIntent — user output is untrusted", () => {
  it("accepts a well-formed swap and strips extra fields", () => {
    const { intent } = validateIntent({
      kind: "swap",
      target: ROUTER,
      sellToken: USDG,
      buyToken: AAPL,
      sellAmountRaw: 10n,
      notionalUsdg: 10n,
      evil: "calldata-injection-attempt",
    });
    assert.ok(intent);
    assert.equal(Object.keys(intent).length, 6); // no extra fields survive
  });

  it("rejects non-bigint amounts, bad addresses, unknown kinds", () => {
    assert.equal(validateIntent({ kind: "swap", target: ROUTER, sellToken: USDG, buyToken: AAPL, sellAmountRaw: 10, notionalUsdg: 10n }).intent, null);
    assert.equal(validateIntent({ kind: "swap", target: "router", sellToken: USDG, buyToken: AAPL, sellAmountRaw: 1n, notionalUsdg: 1n }).intent, null);
    assert.equal(validateIntent({ kind: "rug-pull", target: ROUTER }).intent, null);
    assert.equal(validateIntent({ kind: "vault-deposit", target: ROUTER, amountUsdg: -5n }).intent, null);
    assert.equal(validateIntent("buy everything").intent, null);
  });
});

describe("resolveStrategyFile — names are tokens, not paths", () => {
  it("refuses traversal and junk names", () => {
    const dir = tempDir();
    assert.equal(resolveStrategyFile("../../etc/passwd", dir), null);
    assert.equal(resolveStrategyFile("a/b", dir), null);
    assert.equal(resolveStrategyFile("has spaces", dir), null);
  });

  it("finds a file by token name", () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "my-bot.mjs"), "export default { tick: () => [] }");
    assert.ok(resolveStrategyFile("my-bot", dir)!.endsWith("my-bot.mjs"));
    assert.equal(resolveStrategyFile("other", dir), null);
  });
});

describe("makeCustomStrategy — hot-loaded, crash-isolated", () => {
  it("loads a user strategy and validates its intents", async () => {
    const dir = tempDir();
    writeFileSync(
      path.join(dir, "buyer.mjs"),
      `export default { name: "buyer", tick: (snap) => [
         { kind: "swap", target: "${ROUTER}", sellToken: "${USDG}", buyToken: "${AAPL}", sellAmountRaw: 5000000n, notionalUsdg: 5000000n },
         { kind: "swap", target: "not-an-address", sellToken: "${USDG}", buyToken: "${AAPL}", sellAmountRaw: 1n, notionalUsdg: 1n },
         "nonsense",
       ] }`,
    );
    const notes: string[] = [];
    const s = makeCustomStrategy("buyer", { dir, onNote: (_l, m) => notes.push(m) });
    const intents = await s.tick(snap());
    assert.equal(intents.length, 1); // only the valid one
    assert.equal(intents[0]!.kind, "swap");
    assert.equal(notes.length, 2); // two dropped with reasons
  });

  it("a missing file means no trades and one note, not a crash", async () => {
    const dir = tempDir();
    const notes: string[] = [];
    const s = makeCustomStrategy("ghost", { dir, onNote: (_l, m) => notes.push(m) });
    assert.deepEqual(await s.tick(snap()), []);
    assert.deepEqual(await s.tick(snap()), []); // repeated ticks
    assert.equal(notes.length, 1); // the reason is logged once, not spammed
    assert.match(notes[0]!, /no strategy file/);
  });

  it("a throwing tick degrades to no trades", async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "boom.mjs"), `export default { tick: () => { throw new Error("bug in my bot") } }`);
    const notes: string[] = [];
    const s = makeCustomStrategy("boom", { dir, onNote: (_l, m) => notes.push(m) });
    assert.deepEqual(await s.tick(snap()), []);
    assert.match(notes[0]!, /bug in my bot/);
  });

  it("a bad export shape is reported, not imported blind", async () => {
    const dir = tempDir();
    writeFileSync(path.join(dir, "shapeless.mjs"), `export const foo = 42;`);
    const notes: string[] = [];
    const s = makeCustomStrategy("shapeless", { dir, onNote: (_l, m) => notes.push(m) });
    assert.deepEqual(await s.tick(snap()), []);
    assert.match(notes[0]!, /must default-export/);
  });

  it("hot-reloads when the file changes (mtime-busted import)", async () => {
    const dir = tempDir();
    const file = path.join(dir, "evolving.mjs");
    writeFileSync(file, `export default { tick: () => [] }`);
    const s = makeCustomStrategy("evolving", { dir });
    assert.deepEqual(await s.tick(snap()), []);

    // Rewrite the file with a real intent and force a different mtime.
    writeFileSync(
      file,
      `export default { tick: () => [{ kind: "vault-deposit", target: "${ROUTER}", amountUsdg: 7n }] }`,
    );
    const future = new Date(Date.now() + 5_000);
    const { utimesSync } = await import("node:fs");
    utimesSync(file, future, future);

    const intents = await s.tick(snap());
    assert.equal(intents.length, 1);
    assert.equal(intents[0]!.kind, "vault-deposit");
  });
});
