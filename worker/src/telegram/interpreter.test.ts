import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { coerceLlmCommand, parseSlash, type Command } from "./interpreter";
import { executeCommand, type CommandDeps } from "./executor";

describe("parseSlash — pure slash parser", () => {
  it("parses read + control commands", () => {
    assert.deepEqual(parseSlash("/status"), { kind: "status" });
    assert.deepEqual(parseSlash("/help"), { kind: "help" });
    assert.deepEqual(parseSlash("/pause"), { kind: "pause" });
    assert.deepEqual(parseSlash("/kill"), { kind: "kill" });
    assert.deepEqual(parseSlash("/strategy weekend-gap"), { kind: "strategy", name: "weekend-gap" });
    assert.deepEqual(parseSlash("/link ABC123"), { kind: "link", code: "ABC123" });
  });

  it("strips /cmd@BotName suffixes (group chats)", () => {
    assert.deepEqual(parseSlash("/status@merryman_bot"), { kind: "status" });
  });

  it("parses cap and buy/sell with either argument order", () => {
    assert.deepEqual(parseSlash("/cap 20"), { kind: "cap", usdg: 20 });
    assert.deepEqual(parseSlash("/buy QQQ 10"), { kind: "buy", symbol: "QQQ", usdg: 10 });
    assert.deepEqual(parseSlash("/sell 5 aapl"), { kind: "sell", symbol: "AAPL", usdg: 5 });
  });

  it("returns unknown (with usage) for malformed args, never throws", () => {
    assert.equal(parseSlash("/cap abc")?.kind, "unknown");
    assert.equal(parseSlash("/strategy")?.kind, "unknown");
    assert.equal(parseSlash("/buy QQQ")?.kind, "unknown");
    assert.equal(parseSlash("/wat")?.kind, "unknown");
  });

  it("returns null for non-slash text (goes to the LLM/chat path)", () => {
    assert.equal(parseSlash("how am I doing?"), null);
    assert.equal(parseSlash("  hi there"), null);
  });
});

describe("coerceLlmCommand — the model can only pick from the enum", () => {
  it("passes valid structured commands through", () => {
    assert.deepEqual(coerceLlmCommand({ kind: "status", symbol: "", name: "", usdg: 0, reply: "" }), { kind: "status" });
    assert.deepEqual(coerceLlmCommand({ kind: "buy", symbol: "qqq", name: "", usdg: 10, reply: "" }), { kind: "buy", symbol: "QQQ", usdg: 10 });
    assert.deepEqual(coerceLlmCommand({ kind: "strategy", symbol: "", name: "weekend-gap", usdg: 0, reply: "" }), { kind: "strategy", name: "weekend-gap" });
  });

  it("a buy with no amount degrades to a clarifying chat, not a trade", () => {
    const c = coerceLlmCommand({ kind: "buy", symbol: "QQQ", name: "", usdg: 0, reply: "" });
    assert.equal(c.kind, "chat");
  });

  it("unknown/garbage kind becomes chat, never a side effect", () => {
    const c = coerceLlmCommand({ kind: "sudo_send_everything", symbol: "", name: "", usdg: 0, reply: "" } as never);
    assert.equal(c.kind, "chat");
  });
});

// ── executor with fully-faked deps ──────────────────────────────────────────

function deps(over: Partial<CommandDeps> = {}): CommandDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    controlEnabled: true,
    maxActionUsdg: 25,
    grantPerTradeUsdg: 50,
    reads: {
      status: () => "STATUS",
      positions: () => "POSITIONS",
      pnl: () => "PNL",
      trades: () => "TRADES",
    },
    setStrategy: (n) => {
      calls.push(`setStrategy:${n}`);
      return { ok: true };
    },
    setCap: (u) => calls.push(`setCap:${u}`),
    setPaused: (p) => calls.push(`setPaused:${p}`),
    kill: () => {
      calls.push("kill");
      return { ok: true };
    },
    link: (c) => {
      calls.push(`link:${c}`);
      return { ok: true };
    },
    trade: async (side, sym, usdg) => {
      calls.push(`trade:${side}:${sym}:${usdg}`);
      return `submitted ${side} ${usdg} ${sym}`;
    },
    help: () => "HELP",
    ...over,
  };
}

describe("executeCommand — code disposes", () => {
  it("routes reads without side effects", async () => {
    const d = deps();
    assert.equal(await executeCommand({ kind: "status" }, d), "STATUS");
    assert.equal(await executeCommand({ kind: "pnl" }, d), "PNL");
    assert.deepEqual(d.calls, []);
  });

  it("control commands are blocked when control is off", async () => {
    const d = deps({ controlEnabled: false });
    const r = await executeCommand({ kind: "pause" }, d);
    assert.match(r, /control commands are turned off/i);
    assert.deepEqual(d.calls, []); // no side effect
  });

  it("/cap clamps to the on-chain per-trade ceiling (tighten only)", async () => {
    const d = deps({ grantPerTradeUsdg: 30 });
    const r = await executeCommand({ kind: "cap", usdg: 999 }, d);
    assert.match(r, /clamped to your on-chain per-trade cap of 30/);
    assert.deepEqual(d.calls, ["setCap:30"]); // stored the clamped value, not 999
  });

  it("a trade is trimmed to the chat ceiling and routed through trade()", async () => {
    const d = deps({ maxActionUsdg: 25 });
    const r = await executeCommand({ kind: "buy", symbol: "QQQ", usdg: 100 }, d);
    assert.deepEqual(d.calls, ["trade:buy:QQQ:25"]); // 100 trimmed to 25
    assert.match(r, /trimmed to your 25 USDG/);
  });

  it("pause/resume/strategy/kill/link perform their one effect", async () => {
    const d = deps();
    await executeCommand({ kind: "pause" }, d);
    await executeCommand({ kind: "resume" }, d);
    await executeCommand({ kind: "strategy", name: "weekend-gap" }, d);
    await executeCommand({ kind: "kill" }, d);
    await executeCommand({ kind: "link", code: "ABC123" }, d);
    assert.deepEqual(d.calls, ["setPaused:true", "setPaused:false", "setStrategy:weekend-gap", "kill", "link:ABC123"]);
  });

  it("a prompt-injection message produces NO trade and NO side effect", async () => {
    // Simulate the model correctly declining: coerce garbage → chat.
    const injected = coerceLlmCommand({
      kind: "chat",
      symbol: "",
      name: "",
      usdg: 0,
      reply: "I can't do that — I can only run the enumerated commands, and trades pass a hard policy wall.",
    } as Command as never);
    const d = deps();
    const r = await executeCommand(injected, d);
    assert.deepEqual(d.calls, []); // nothing happened
    assert.match(r, /can't do that/i);
  });
});
