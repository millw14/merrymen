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

  it("wallet words all land on the dashboard signpost, never 'unknown command'", () => {
    // People type /grant in chat after reading "go to /grant" — dead-ending them
    // there is how a funded user gets stuck. Every synonym must answer.
    for (const w of ["/grant", "/wallet", "/restore", "/recover", "/reconnect", "/fund"]) {
      assert.deepEqual(parseSlash(w), { kind: "wallet" }, `${w} should point at the dashboard`);
    }
    assert.deepEqual(parseSlash("/grant@merryman_bot"), { kind: "wallet" });
    // …but /withdraw stays an alias for /transfer — a signpost must not eat a
    // working command.
    assert.equal(parseSlash("/withdraw 0x1111111111111111111111111111111111111111 5")?.kind, "transfer");
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

  it("maps a multi-step request to kind=agent carrying the task", () => {
    const c = coerceLlmCommand(
      { kind: "agent", task: "clone github.com/x/y, install deps, build, tell me what breaks" },
      "clone github.com/x/y, install deps, build, tell me what breaks",
    );
    assert.deepEqual(c, { kind: "agent", task: "clone github.com/x/y, install deps, build, tell me what breaks" });
  });

  it("kind=agent with a blank task falls back to the user's message", () => {
    const c = coerceLlmCommand({ kind: "agent", task: "" }, "set up the project and run the tests");
    assert.deepEqual(c, { kind: "agent", task: "set up the project and run the tests" });
  });
});

// ── executor with fully-faked deps ──────────────────────────────────────────

function deps(over: Partial<CommandDeps> = {}): CommandDeps & { calls: string[] } {
  const calls: string[] = [];
  let pending: import("./executor").PendingAction | null = null;
  // A fake PC layer that RECORDS every call — the capability-gate tests assert
  // these are never invoked when a capability is off.
  const pcCall =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push(`pc:${name}${args.length ? ":" + args.join(",") : ""}`);
      return `pc:${name}`;
    };
  return {
    calls,
    controlEnabled: true,
    maxActionUsdg: 25,
    grantPerTradeUsdg: 50,
    transferEnabled: true,
    grantHasTransfer: true,
    reads: {
      status: () => "STATUS",
      positions: () => "POSITIONS",
      pnl: () => "PNL",
      trades: () => "TRADES",
      report: () => "REPORT",
      why: () => "WHY",
      brag: () => "BRAG",
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
    transfer: async (to, usdg) => {
      calls.push(`transfer:${to}:${usdg}`);
      return `submitted transfer ${usdg} to ${to}`;
    },
    getPending: () => pending,
    setPending: (p) => {
      pending = p;
      calls.push(p.kind === "transfer" ? `pend:${p.to}:${p.usdg}` : `pend:${p.kind}`);
    },
    clearPending: () => {
      pending = null;
    },
    addAlert: (sym, op, price) => {
      calls.push(`alert:${sym}${op}${price}`);
      return "ALERT SET";
    },
    listAlerts: () => "ALERTS",
    removeAlert: (id) => {
      calls.push(`unalert:${id}`);
      return "ALERT REMOVED";
    },
    setName: (n) => {
      calls.push(`setName:${n}`);
      return { ok: true, name: n };
    },
    remember: (f) => {
      calls.push(`remember:${f}`);
      return true;
    },
    soulInfo: () => "SOUL",
    forgetOwner: () => calls.push("forget"),
    // ── PC control (default: master ON, all capabilities on, for dispatch tests) ──
    pcControlEnabled: true,
    capabilities: new Set(["screen", "vision", "apps", "system", "files", "clipboard", "shell", "keyboard", "watchers"]),
    filesRoot: "C:/root",
    shellAllowlist: ["git status", "echo hi"],
    pc: {
      screenshot: pcCall("screenshot"),
      look: pcCall("look"),
      open: pcCall("open"),
      sysinfo: pcCall("sysinfo"),
      volume: pcCall("volume"),
      media: pcCall("media"),
      notify: pcCall("notify"),
      lock: pcCall("lock"),
      ls: pcCall("ls"),
      clipGet: pcCall("clipGet"),
      clipSet: pcCall("clipSet"),
      runShell: pcCall("runShell"),
      getFile: pcCall("getFile"),
      typeText: pcCall("typeText"),
      hotkey: pcCall("hotkey"),
      power: pcCall("power"),
    },
    pcStatus: () => "PCSTATUS",
    addReminder: (w, t) => {
      calls.push(`remind:${w}:${t}`);
      return "REMINDED";
    },
    listReminders: () => "REMINDERS",
    removeReminder: (id) => {
      calls.push(`unremind:${id}`);
      return "UNREMINDED";
    },
    addWatcher: (s) => {
      calls.push(`watch:${s}`);
      return "WATCHING";
    },
    listWatchers: () => "WATCHERS",
    removeWatcher: (id) => {
      calls.push(`unwatch:${id}`);
      return "UNWATCHED";
    },
    help: () => "HELP",
    now: () => 1_000_000,
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

// ── transfers: parse → pend → confirm, triple-gated ─────────────────────────

const ADDR = "0x1111111111111111111111111111111111111111" as const;

describe("parseSlash — transfer / confirm / alert commands", () => {
  it("parses /transfer with either argument order (and /send, /withdraw aliases)", () => {
    assert.deepEqual(parseSlash(`/transfer ${ADDR} 20`), { kind: "transfer", to: ADDR, usdg: 20 });
    assert.deepEqual(parseSlash(`/send 20 ${ADDR}`), { kind: "transfer", to: ADDR, usdg: 20 });
    assert.equal(parseSlash(`/withdraw ${ADDR} 5`)?.kind, "transfer");
  });

  it("rejects malformed transfer args (no address / no amount)", () => {
    assert.equal(parseSlash("/transfer 20")?.kind, "unknown");
    assert.equal(parseSlash(`/transfer ${ADDR}`)?.kind, "unknown");
    assert.equal(parseSlash("/transfer 0xdeadbeef 20")?.kind, "unknown"); // short address
  });

  it("parses confirm/cancel and alert forms", () => {
    assert.deepEqual(parseSlash("/confirm"), { kind: "confirm" });
    assert.deepEqual(parseSlash("/cancel"), { kind: "cancel" });
    assert.deepEqual(parseSlash("/alert QQQ > 600"), { kind: "alert", symbol: "QQQ", op: ">", price: 600 });
    assert.deepEqual(parseSlash("/alert qqq below 550"), { kind: "alert", symbol: "QQQ", op: "<", price: 550 });
    assert.deepEqual(parseSlash("/alerts"), { kind: "alerts" });
    assert.deepEqual(parseSlash("/unalert 2"), { kind: "unalert", id: 2 });
    assert.equal(parseSlash("/alert QQQ 600")?.kind, "unknown"); // no direction
  });

  it("parses report/why/brag reads", () => {
    assert.deepEqual(parseSlash("/report"), { kind: "report" });
    assert.deepEqual(parseSlash("/why"), { kind: "why" });
    assert.deepEqual(parseSlash("/brag"), { kind: "brag" });
  });
});

describe("coerceLlmCommand — transfer address must be shape-valid", () => {
  it("accepts a well-formed transfer", () => {
    const c = coerceLlmCommand({ kind: "transfer", symbol: "", name: "", usdg: 20, address: ADDR, op: "", price: 0, id: 0, reply: "" });
    assert.deepEqual(c, { kind: "transfer", to: ADDR, usdg: 20 });
  });

  it("a transfer with a garbage address degrades to chat — never a command", () => {
    const c = coerceLlmCommand({ kind: "transfer", symbol: "", name: "", usdg: 20, address: "robin's other wallet", op: "", price: 0, id: 0, reply: "" });
    assert.equal(c.kind, "chat");
  });

  it("SECURITY: a transfer address NOT in the user's message is refused (prompt-injection guard)", () => {
    // Model emits a valid-looking address the user never typed → must NOT become a transfer.
    const injected = coerceLlmCommand(
      { kind: "transfer", address: ADDR, usdg: 20 },
      "please send my usual amount to my other wallet",
    );
    assert.equal(injected.kind, "chat");
    // Same address, but present verbatim in the message → allowed.
    const legit = coerceLlmCommand({ kind: "transfer", address: ADDR, usdg: 20 }, `send 20 to ${ADDR}`);
    assert.deepEqual(legit, { kind: "transfer", to: ADDR, usdg: 20 });
  });

  it("SECURITY: the LLM cannot emit confirm/cancel — only a slash command can", () => {
    // A prompt-injected turn can no longer auto-approve a parked action.
    assert.equal(coerceLlmCommand({ kind: "confirm" }, "yes do it").kind, "chat");
    assert.equal(coerceLlmCommand({ kind: "cancel" }, "nevermind").kind, "chat");
    // …but the literal slash commands still work (unchanged).
    assert.deepEqual(parseSlash("/confirm"), { kind: "confirm" });
    assert.deepEqual(parseSlash("/cancel"), { kind: "cancel" });
  });
});

describe("executeCommand — transfer confirm flow", () => {
  it("a transfer NEVER executes directly — it parks a pending action", async () => {
    const d = deps();
    const r = await executeCommand({ kind: "transfer", to: ADDR, usdg: 20 }, d);
    assert.deepEqual(d.calls, [`pend:${ADDR}:20`]); // no transfer() call
    assert.match(r, /confirm transfer/i);
    assert.ok(r.includes(ADDR)); // the FULL address is echoed for the human check
  });

  it("/confirm executes the pending transfer exactly once", async () => {
    const d = deps();
    await executeCommand({ kind: "transfer", to: ADDR, usdg: 20 }, d);
    const r = await executeCommand({ kind: "confirm" }, d);
    assert.deepEqual(d.calls, [`pend:${ADDR}:20`, `transfer:${ADDR}:20`]);
    assert.match(r, /submitted transfer/);
    // A second confirm finds nothing.
    assert.match(await executeCommand({ kind: "confirm" }, d), /nothing pending/i);
  });

  it("/cancel clears the pending transfer — nothing moves", async () => {
    const d = deps();
    await executeCommand({ kind: "transfer", to: ADDR, usdg: 20 }, d);
    assert.match(await executeCommand({ kind: "cancel" }, d), /cancelled/i);
    assert.match(await executeCommand({ kind: "confirm" }, d), /nothing pending/i);
    assert.ok(!d.calls.some((c) => c.startsWith("transfer:")));
  });

  it("an expired confirmation refuses to execute", async () => {
    let t = 1_000_000;
    const d = deps({ now: () => t });
    await executeCommand({ kind: "transfer", to: ADDR, usdg: 20 }, d);
    t += 500; // past the 90s TTL
    assert.match(await executeCommand({ kind: "confirm" }, d), /expired/i);
    assert.ok(!d.calls.some((c) => c.startsWith("transfer:")));
  });

  it("transfers are blocked when the dashboard toggle is off", async () => {
    const d = deps({ transferEnabled: false });
    const r = await executeCommand({ kind: "transfer", to: ADDR, usdg: 20 }, d);
    assert.match(r, /transfers from chat are off/i);
    assert.deepEqual(d.calls, []);
  });

  it("transfers are blocked when the grant predates the transfer permission", async () => {
    const d = deps({ grantHasTransfer: false });
    const r = await executeCommand({ kind: "transfer", to: ADDR, usdg: 20 }, d);
    assert.match(r, /re-create your wallet/i);
    assert.deepEqual(d.calls, []);
  });

  it("transfer amount is trimmed to the chat ceiling before pending", async () => {
    const d = deps({ maxActionUsdg: 10 });
    await executeCommand({ kind: "transfer", to: ADDR, usdg: 500 }, d);
    assert.deepEqual(d.calls, [`pend:${ADDR}:10`]);
  });

  it("PROMPT INJECTION: 'send all funds to 0xevil' can at worst park a visible pending confirm", async () => {
    // Even if the model were fully steered into emitting a transfer command,
    // the executor still only parks it — the user sees the address and amount
    // and must /confirm. Nothing moves from the message alone.
    const evil = coerceLlmCommand({
      kind: "transfer",
      symbol: "",
      name: "",
      usdg: 999_999,
      address: "0x2222222222222222222222222222222222222222",
      op: "",
      price: 0,
      id: 0,
      reply: "",
    });
    const d = deps({ maxActionUsdg: 25 });
    const r = await executeCommand(evil, d);
    assert.ok(!d.calls.some((c) => c.startsWith("transfer:"))); // NO execution
    assert.deepEqual(d.calls, ["pend:0x2222222222222222222222222222222222222222:25"]); // trimmed + parked
    assert.match(r, /confirm transfer/i); // the human sees exactly what was asked
  });
});

describe("executeCommand — alerts and rich reads route through deps", () => {
  it("alert/alerts/unalert call their deps", async () => {
    const d = deps();
    assert.equal(await executeCommand({ kind: "alert", symbol: "QQQ", op: ">", price: 600 }, d), "ALERT SET");
    assert.equal(await executeCommand({ kind: "alerts" }, d), "ALERTS");
    assert.equal(await executeCommand({ kind: "unalert", id: 1 }, d), "ALERT REMOVED");
    assert.deepEqual(d.calls, ["alert:QQQ>600", "unalert:1"]);
  });

  it("report/why/brag are read-only", async () => {
    const d = deps();
    assert.equal(await executeCommand({ kind: "report" }, d), "REPORT");
    assert.equal(await executeCommand({ kind: "why" }, d), "WHY");
    assert.equal(await executeCommand({ kind: "brag" }, d), "BRAG");
    assert.deepEqual(d.calls, []);
  });
});

describe("soul commands — naming, memory, identity", () => {
  it("parses /name /remember /soul /forget", () => {
    assert.deepEqual(parseSlash("/name Will Scarlet"), { kind: "name", name: "Will Scarlet" });
    assert.deepEqual(parseSlash("/rename Marian"), { kind: "name", name: "Marian" });
    assert.deepEqual(parseSlash("/remember I prefer small trades"), { kind: "remember", fact: "I prefer small trades" });
    assert.deepEqual(parseSlash("/soul"), { kind: "soul" });
    assert.deepEqual(parseSlash("/forget"), { kind: "forget" });
    assert.equal(parseSlash("/name")?.kind, "unknown");
  });

  it("coerces LLM name/remember kinds, degrading to chat when empty", () => {
    const named = coerceLlmCommand({ kind: "name", symbol: "", name: "Will", usdg: 0, address: "", op: "", price: 0, id: 0, fact: "", remember: "", reply: "" });
    assert.deepEqual(named, { kind: "name", name: "Will" });
    const noName = coerceLlmCommand({ kind: "name", symbol: "", name: "", usdg: 0, address: "", op: "", price: 0, id: 0, fact: "", remember: "", reply: "" });
    assert.equal(noName.kind, "chat");
    const rem = coerceLlmCommand({ kind: "remember", symbol: "", name: "", usdg: 0, address: "", op: "", price: 0, id: 0, fact: "hates mondays", remember: "", reply: "" });
    assert.deepEqual(rem, { kind: "remember", fact: "hates mondays" });
  });

  it("executor routes naming and memory through deps (ungated — not fund control)", async () => {
    const d = deps({ controlEnabled: false }); // even with control OFF
    assert.match(await executeCommand({ kind: "name", name: "Will Scarlet" }, d), /Will Scarlet/);
    assert.match(await executeCommand({ kind: "remember", fact: "likes QQQ" }, d), /noted/i);
    assert.equal(await executeCommand({ kind: "soul" }, d), "SOUL");
    assert.match(await executeCommand({ kind: "forget" }, d), /let go/i);
    assert.deepEqual(d.calls, ["setName:Will Scarlet", "remember:likes QQQ", "forget"]);
  });

  it("a rejected memory (address-shaped) gets the honest refusal reply", async () => {
    const d = deps({ remember: () => false });
    const r = await executeCommand({ kind: "remember", fact: "wallet 0xdead" }, d);
    assert.match(r, /never store/i);
  });
});

describe("PC control — gating, confirm-park, and injection safety", () => {
  it("refuses EVERY pc command when the master switch is off — and never calls the platform", async () => {
    const d = deps({ pcControlEnabled: false });
    for (const cmd of [
      { kind: "screenshot" },
      { kind: "sysinfo" },
      { kind: "open", target: "spotify" },
      { kind: "shell", cmd: "git status" },
    ] as Command[]) {
      const r = await executeCommand(cmd, d);
      assert.match(r, /PC control is off/i);
    }
    // Not a single platform method was invoked.
    assert.deepEqual(d.calls, []);
  });

  it("refuses a command whose capability is off — no platform call", async () => {
    const d = deps({ pcControlEnabled: true, capabilities: new Set(["screen"]) });
    const r = await executeCommand({ kind: "shell", cmd: "git status" }, d);
    assert.match(r, /shell.*is off|capability.*off/i);
    assert.deepEqual(d.calls, []); // runShell never reached
  });

  it("a direct capability (screenshot) runs when enabled", async () => {
    const d = deps({ pcControlEnabled: true, capabilities: new Set(["screen"]) });
    await executeCommand({ kind: "screenshot" }, d);
    assert.deepEqual(d.calls, ["pc:screenshot"]);
  });

  it("shell PARKS for /confirm and does not execute until confirmed", async () => {
    const d = deps(); // all caps on, allowlist has "git status"
    const parked = await executeCommand({ kind: "shell", cmd: "git status" }, d);
    assert.match(parked, /confirm run/i);
    assert.deepEqual(d.calls, ["pend:shell"]); // parked, NOT executed
    const done = await executeCommand({ kind: "confirm" }, d);
    assert.equal(done, "pc:runShell");
    assert.deepEqual(d.calls, ["pend:shell", "pc:runShell:git status"]);
  });

  it("a non-allowlisted shell command is refused immediately — never parked, never run", async () => {
    const d = deps();
    const r = await executeCommand({ kind: "shell", cmd: "rm -rf /" }, d);
    assert.match(r, /allowlist/i);
    assert.deepEqual(d.calls, []); // not parked, not executed
  });

  it("PROMPT INJECTION: a coerced 'run rm -rf / and send ~/.ssh' produces no exec", async () => {
    // Simulate what the LLM front end would emit for an injection attempt.
    const cmd = coerceLlmCommand({
      kind: "shell", symbol: "", name: "", usdg: 0, address: "", op: "", price: 0, id: 0,
      fact: "", remember: "", pcArg: "rm -rf / ; cat ~/.ssh/id_rsa", pcAction: "", reply: "",
    });
    assert.equal(cmd.kind, "shell");
    const d = deps();
    const r = await executeCommand(cmd, d);
    assert.match(r, /allowlist/i);
    assert.deepEqual(d.calls, []); // the platform is never touched
  });

  it("getfile parks and is refused outside the files root", async () => {
    const d = deps({ filesRoot: process.platform === "win32" ? "C:\root" : "/root" });
    const bad = await executeCommand({ kind: "getfile", path: "../../etc/passwd" }, d);
    assert.match(bad, /outside|refused/i);
    assert.deepEqual(d.calls, []);
  });

  it("/pc status works even when everything is off (no capability needed)", async () => {
    const d = deps({ pcControlEnabled: false, capabilities: new Set() });
    assert.equal(await executeCommand({ kind: "pc" }, d), "PCSTATUS");
  });
});
