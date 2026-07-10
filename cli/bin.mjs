#!/usr/bin/env node
/**
 * merrymen CLI — the terminal front door.
 *
 *   merrymen onboard        interactive setup wizard (keys, strategy, basket)
 *   merrymen start          run web + worker together
 *   merrymen doctor         diagnose the whole stack
 *   merrymen status         what the band is doing right now
 *   merrymen strategy new   scaffold a custom strategy file
 *   merrymen strategy list  builtins + your strategies
 *   merrymen selftest       one policy-legal no-op through the full pipeline
 *   merrymen kill           terminal kill switch (deletes the grant)
 *
 * Zero dependencies. Everything lands in .data/settings.json — the same file
 * the /settings web page edits and the worker re-reads every tick.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, ".data");
const SETTINGS = path.join(DATA, "settings.json");
const GRANT = path.join(DATA, "grant.json");
const HEARTBEAT = path.join(DATA, "heartbeat.json");
const DB = path.join(DATA, "merrymen.db");
const STRATEGIES = path.join(ROOT, "strategies");

const RPC_MAINNET = "https://rpc.mainnet.chain.robinhood.com";
const RPC_TESTNET = "https://rpc.testnet.chain.robinhood.com";
const BUILTINS = ["steady-basket", "weekend-gap", "llm-strategist"];

const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const ok = (s) => console.log(`  ${green("✓")} ${s}`);
const bad = (s) => console.log(`  ${red("✗")} ${s}`);
const warn = (s) => console.log(`  ${yellow("!")} ${s}`);

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch {
    return null;
  }
}

function writeSettings(next) {
  mkdirSync(DATA, { recursive: true });
  writeFileSync(SETTINGS, JSON.stringify(next, null, 2), "utf8");
}

/** Symbols straight from the registry source — stays in sync with core. */
function knownSymbols() {
  try {
    const src = readFileSync(path.join(ROOT, "packages", "core", "src", "tokens.ts"), "utf8");
    return [...src.matchAll(/symbol: "([A-Z]+)"/g)].map((m) => m[1]);
  } catch {
    return ["AAPL", "MSFT", "QQQ"];
  }
}

async function listCustom() {
  const { readdir } = await import("node:fs/promises");
  try {
    const files = await readdir(STRATEGIES);
    return files
      .filter((f) => /\.(ts|mts|mjs|js)$/.test(f) && !f.startsWith("."))
      .map((f) => f.replace(/\.(ts|mts|mjs|js)$/, ""))
      .filter((n) => /^[A-Za-z0-9_-]{1,64}$/.test(n))
      .sort();
  } catch {
    return [];
  }
}

function makePrompter() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const ask = (q) => new Promise((res) => rl.question(q, res));
  const askSecret = (q) =>
    new Promise((res) => {
      const orig = rl._writeToOutput.bind(rl);
      process.stdout.write(q);
      rl._writeToOutput = (s) => {
        // echo * for typed chars; pass through control sequences on enter
        if (s.includes("\n") || s.includes("\r")) orig(s);
        else rl.output.write("*");
      };
      rl.question("", (answer) => {
        rl._writeToOutput = orig;
        res(answer);
      });
    });
  return { rl, ask, askSecret, close: () => rl.close() };
}

async function rpcCall(url, method, params = []) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    const json = await res.json();
    return json.result ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ─────────────────────────────────────────────────────────────── onboard ──

async function onboard() {
  console.log(`
${bold("➳ merrymen")} — autonomous trading agents for Robinhood Chain
${dim("your keys, your caps · bounded worst case · every trade simulated first")}

This wizard writes ${dim(".data/settings.json")} — the same file the /settings
page edits. Blank answers keep what's already saved. Ctrl+C to bail anytime.
`);

  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) {
    bad(`Node ${process.versions.node} — merrymen needs Node 22+ (node:sqlite). Install from nodejs.org and rerun.`);
    process.exit(1);
  }
  if (!existsSync(path.join(ROOT, "node_modules"))) {
    bad("dependencies not installed — run `npm install` first, then rerun this wizard.");
    process.exit(1);
  }

  const current = readJson(SETTINGS) ?? {};
  const p = makePrompter();
  const keep = (label, has) => dim(has ? ` [saved — blank keeps it]` : ` [blank skips]`);

  console.log(bold("\n1/4 · execution"));
  console.log(dim("  A 4337 bundler signs and submits the agent's operations."));
  console.log(dim("  Free keys: dashboard.pimlico.io or dashboard.alchemy.com (chain 46630 testnet / 4663 mainnet)."));
  const bundler = (await p.ask(`  bundler RPC URL${keep("bundler", current.bundlerUrl)}: `)).trim();
  if (bundler) current.bundlerUrl = bundler;

  console.log(bold("\n2/4 · api keys") + dim("  (stored locally, never leave this machine)"));
  console.log(dim("  Anthropic key powers the llm-strategist — console.anthropic.com → API keys."));
  const anthropic = (await p.askSecret(`  Anthropic API key${keep("anthropic", current.anthropicApiKey)}: `)).trim();
  if (anthropic) current.anthropicApiKey = anthropic;
  console.log(dim("  Rialto integrator key enables their meta-router — docs.rialto.xyz (wallet-signed onboarding)."));
  const rialto = (await p.askSecret(`  Rialto API key${keep("rialto", current.rialtoApiKey)}: `)).trim();
  if (rialto) current.rialtoApiKey = rialto;

  console.log(bold("\n3/4 · strategy"));
  const custom = await listCustom();
  const all = [...BUILTINS, ...custom];
  all.forEach((s, i) =>
    console.log(
      `  ${i + 1}. ${s}${custom.includes(s) ? dim(" (yours)") : ""}${s === (current.strategy ?? "steady-basket") ? green(" ← current") : ""}`,
    ),
  );
  console.log(dim(`  write your own: merrymen strategy new <name>  (drops a template in strategies/)`));
  const pick = (await p.ask(`  pick 1-${all.length} [blank keeps current]: `)).trim();
  const idx = Number(pick) - 1;
  if (pick && Number.isInteger(idx) && all[idx]) current.strategy = all[idx];

  console.log(bold("\n4/4 · basket"));
  const symbols = knownSymbols();
  console.log(dim(`  available: ${symbols.join(" ")}`));
  const basketNow = (current.basketSymbols ?? ["AAPL", "MSFT", "QQQ"]).join(",");
  const basket = (await p.ask(`  symbols, comma-separated [${basketNow}]: `)).trim();
  if (basket) {
    const chosen = basket.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
    const unknown = chosen.filter((s) => !symbols.includes(s));
    if (unknown.length) warn(`ignoring unknown symbols: ${unknown.join(", ")}`);
    const valid = chosen.filter((s) => symbols.includes(s));
    if (valid.length) current.basketSymbols = valid;
  }

  p.close();
  writeSettings(current);

  console.log(`
${green("✓ saved")} ${dim(SETTINGS)}

${bold("next steps")}
  1. ${bold("npm start")} — dashboard on http://localhost:3100 + the worker
  2. open ${bold("http://localhost:3100/grant")} and sign the permission wall with MetaMask (testnet 46630)
  3. testnet gas: ${dim("https://faucet.testnet.chain.robinhood.com")}
  4. prove the pipeline: ${bold("npx merrymen selftest")}
  5. checkup anytime: ${bold("npx merrymen doctor")} · fine-tuning: ${dim("http://localhost:3100/settings")}
`);
}

// ───────────────────────────────────────────────────────────────── start ──

function start() {
  console.log(`${bold("➳ merrymen")} — starting web (http://localhost:3100) + worker. Ctrl+C stops both.\n`);
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const procs = [
    { name: "web   ", args: ["run", "dev", "-w", "@merrymen/web", "--", "-p", "3100"] },
    { name: "worker", args: ["run", "dev", "-w", "@merrymen/worker"] },
  ].map(({ name, args }) => {
    const child = spawn(npmCmd, args, { cwd: ROOT, shell: process.platform === "win32" });
    const pipe = (stream, sink) =>
      stream.on("data", (chunk) =>
        String(chunk)
          .split(/\r?\n/)
          .filter((l) => l.trim())
          .forEach((l) => sink.write(`${dim(`[${name}]`)} ${l}\n`)),
      );
    pipe(child.stdout, process.stdout);
    pipe(child.stderr, process.stderr);
    child.on("exit", (code) => {
      console.log(`${dim(`[${name}]`)} exited (${code})`);
    });
    return child;
  });
  const stop = () => {
    procs.forEach((c) => c.kill("SIGINT"));
    setTimeout(() => process.exit(0), 500);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

// ──────────────────────────────────────────────────────────────── doctor ──

async function doctor() {
  console.log(`${bold("➳ merrymen doctor")}\n`);
  const s = readJson(SETTINGS) ?? {};

  const major = Number(process.versions.node.split(".")[0]);
  major >= 22 ? ok(`node ${process.versions.node}`) : bad(`node ${process.versions.node} — need 22+ for node:sqlite`);
  existsSync(path.join(ROOT, "node_modules")) ? ok("dependencies installed") : bad("node_modules missing — run npm install");

  existsSync(SETTINGS) ? ok("settings file present") : warn("no settings yet — run: npx merrymen onboard");
  s.bundlerUrl || process.env.MERRYMEN_BUNDLER_URL
    ? ok("bundler URL configured")
    : warn("no bundler URL — the agent will simulate but never sign (get one: dashboard.pimlico.io)");
  s.anthropicApiKey || process.env.ANTHROPIC_API_KEY
    ? ok("Anthropic key set (llm-strategist can trade)")
    : warn("no Anthropic key — llm-strategist would run idle");
  s.rialtoApiKey || process.env.MERRYMEN_RIALTO_API_KEY
    ? ok("Rialto key set")
    : warn("no Rialto key — rialto venue stays approval-only");

  const mainnetBlock = await rpcCall(s.rpcMainnet ?? RPC_MAINNET, "eth_blockNumber");
  mainnetBlock ? ok(`mainnet RPC reachable (block ${parseInt(mainnetBlock, 16).toLocaleString()})`) : bad("mainnet RPC unreachable");
  const testnetBlock = await rpcCall(s.rpcTestnet ?? RPC_TESTNET, "eth_blockNumber");
  testnetBlock ? ok(`testnet RPC reachable (block ${parseInt(testnetBlock, 16).toLocaleString()})`) : bad("testnet RPC unreachable");

  if (s.bundlerUrl) {
    const eps = await rpcCall(s.bundlerUrl, "eth_supportedEntryPoints");
    Array.isArray(eps) && eps.length
      ? ok(`bundler reachable (${eps.length} entrypoint${eps.length > 1 ? "s" : ""})`)
      : bad("bundler did not answer eth_supportedEntryPoints — check the URL/key");
  }

  const grant = readJson(GRANT);
  if (!grant) {
    warn("no grant — sign one at http://localhost:3100/grant");
  } else {
    const left = grant.expiresAt - Math.floor(Date.now() / 1000);
    left > 0
      ? ok(`grant armed for ${grant.smartAccount.slice(0, 10)}… (chain ${grant.chainId}, expires in ${Math.floor(left / 86400)}d ${Math.floor((left % 86400) / 3600)}h)`)
      : bad("grant EXPIRED — sign a new one at /grant");
  }

  const hb = readJson(HEARTBEAT);
  if (hb && Math.floor(Date.now() / 1000) - hb.at < 90) ok(`worker alive (heartbeat ${Math.floor(Date.now() / 1000) - hb.at}s ago, block ${hb.block})`);
  else warn("worker not running (no heartbeat in 90s) — npm start");

  existsSync(DB) ? ok("ledger present (.data/merrymen.db)") : warn("no ledger yet — appears after the worker's first tick");

  const custom = await listCustom();
  const strategy = s.strategy ?? "steady-basket";
  if (BUILTINS.includes(strategy)) ok(`strategy: ${strategy} (builtin)`);
  else if (custom.includes(strategy)) ok(`strategy: ${strategy} (yours, strategies/${strategy}.*)`);
  else bad(`strategy "${strategy}" is neither builtin nor in strategies/ — the worker will idle with a warning`);
  if (custom.length) console.log(`  ${dim(`your strategies: ${custom.join(", ")}`)}`);
  console.log();
}

// ──────────────────────────────────────────────────────────────── status ──

async function status() {
  console.log(`${bold("➳ merrymen status")}\n`);
  const hb = readJson(HEARTBEAT);
  const now = Math.floor(Date.now() / 1000);
  if (hb && now - hb.at < 90) ok(`worker alive — heartbeat ${now - hb.at}s ago at block ${hb.block}`);
  else warn("worker not running");

  const grant = readJson(GRANT);
  if (grant) {
    const left = grant.expiresAt - now;
    console.log(`  agent ${grant.smartAccount} ${dim(`chain ${grant.chainId}`)}`);
    console.log(`  caps: ${grant.caps.perTradeUsdg}/trade · ${grant.caps.dailyUsdg}/day · ${grant.caps.maxOpsPerDay} ops · breaker ${grant.caps.maxDrawdownPct}% · ${left > 0 ? `expires in ${Math.floor(left / 86400)}d` : red("EXPIRED")}`);
  } else {
    warn("no grant signed");
  }

  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(DB, { readOnly: true });
    const t = db.prepare("SELECT COUNT(*) AS n, SUM(status='landed') AS landed FROM trades").get();
    const eq = db.prepare("SELECT equity_usdg, datetime(at,'unixepoch') AS at FROM equity ORDER BY at DESC, id DESC LIMIT 1").get();
    const events = db.prepare("SELECT level, message, datetime(created_at,'unixepoch') AS at FROM events ORDER BY created_at DESC, id DESC LIMIT 3").all();
    console.log(`  trades: ${t?.landed ?? 0} landed / ${t?.n ?? 0} attempts`);
    if (eq) console.log(`  equity: ${Number(eq.equity_usdg).toFixed(2)} USDG ${dim(`(${eq.at} UTC)`)}`);
    if (events.length) {
      console.log(dim("  recent:"));
      for (const e of events) console.log(`    ${dim(e.at)} [${e.level}] ${e.message.slice(0, 100)}`);
    }
    db.close();
  } catch {
    console.log(dim("  no ledger yet"));
  }
  console.log();
}

// ────────────────────────────────────────────────────────────── strategy ──

const TEMPLATE = (name) => `/**
 * ${name} — your strategy. Hot-reloads on save; crash-isolated; every intent
 * you return is validated, policy-capped, quote-simulated, and finally
 * enforced by the on-chain session key the user signed. You propose; the
 * wall disposes. See strategies/README.md and example-dip-buyer.ts.
 *
 * Units: USDG = 6dp bigint · stock balances = 18dp bigint · prices = 8dp bigint.
 */
import type { Snapshot } from "../worker/src/strategies/types";
import type { TradeIntent } from "../worker/src/policy";
import { CASH, STOCK_TOKENS, UNISWAP } from "../packages/core/src";

const USDG = CASH.USDG as \`0x\${string}\`;
const ROUTER = UNISWAP.swapRouter02 as \`0x\${string}\`;

export default {
  name: "${name}",

  tick(snap: Snapshot): TradeIntent[] {
    if (!snap.sequencerUp) return [];

    // your logic here — e.g. buy 10 USDG of QQQ when you like the setup:
    // const qqq = STOCK_TOKENS.find((t) => t.symbol === "QQQ")!.address;
    // return [{ kind: "swap", target: ROUTER, sellToken: USDG, buyToken: qqq,
    //           sellAmountRaw: 10_000_000n, notionalUsdg: 10_000_000n }];

    return [];
  },
};
`;

async function strategyCmd(sub, name) {
  if (sub === "list") {
    console.log(bold("builtin"));
    BUILTINS.forEach((s) => console.log(`  ${s}`));
    const custom = await listCustom();
    console.log(bold("yours") + dim(" (strategies/)"));
    custom.length ? custom.forEach((s) => console.log(`  ${s}`)) : console.log(dim("  none yet — merrymen strategy new <name>"));
    return;
  }
  if (sub === "new") {
    if (!name || !/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
      bad("usage: merrymen strategy new <name>   (letters, digits, - and _ only)");
      process.exit(1);
    }
    if (BUILTINS.includes(name)) {
      bad(`"${name}" is a builtin — pick another name`);
      process.exit(1);
    }
    mkdirSync(STRATEGIES, { recursive: true });
    const file = path.join(STRATEGIES, `${name}.ts`);
    if (existsSync(file)) {
      bad(`${file} already exists — refusing to overwrite`);
      process.exit(1);
    }
    writeFileSync(file, TEMPLATE(name), "utf8");
    ok(`created strategies/${name}.ts`);
    console.log(`  edit it, then select "${name}" in /settings or: npx merrymen onboard`);
    return;
  }
  bad("usage: merrymen strategy <list|new> [name]");
  process.exit(1);
}

// ────────────────────────────────────────────────────────── selftest/kill ──

function selftest() {
  console.log(`${bold("➳ merrymen selftest")} — one policy-legal no-op through grant → policy → bundler → chain\n`);
  const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
  const child = spawn(npmCmd, ["run", "start", "-w", "@merrymen/worker", "--", "--selftest"], {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  child.on("exit", (code) => process.exit(code ?? 1));
}

async function kill() {
  if (!existsSync(GRANT)) {
    warn("no grant to kill — the band is already standing down");
    return;
  }
  const p = makePrompter();
  const answer = (await p.ask(`${red("KILL SWITCH")} — destroy the grant? The worker halts on its next tick. [y/N]: `)).trim().toLowerCase();
  p.close();
  if (answer === "y" || answer === "yes") {
    rmSync(GRANT, { force: true });
    ok("grant destroyed — trading halts on the worker's next tick (on-chain expiry remains the backstop)");
  } else {
    console.log(dim("aborted — nothing touched"));
  }
}

// ────────────────────────────────────────────────────────────────── main ──

const [, , cmd, ...rest] = process.argv;
switch (cmd) {
  case "onboard":
    await onboard();
    break;
  case "start":
    start();
    break;
  case "doctor":
    await doctor();
    break;
  case "status":
    await status();
    break;
  case "strategy":
    await strategyCmd(rest[0], rest[1]);
    break;
  case "selftest":
    selftest();
    break;
  case "kill":
    await kill();
    break;
  default:
    console.log(`
${bold("➳ merrymen")} — self-hosted trading agents for Robinhood Chain

  ${bold("npx merrymen onboard")}        setup wizard (keys, strategy, basket)
  ${bold("npx merrymen start")}          run dashboard (localhost:3100) + worker
  ${bold("npx merrymen doctor")}         diagnose node/keys/RPC/bundler/grant/db
  ${bold("npx merrymen status")}         heartbeat, grant, trades, equity
  ${bold("npx merrymen strategy new")}   scaffold your own bot in strategies/
  ${bold("npx merrymen strategy list")}  builtins + your strategies
  ${bold("npx merrymen selftest")}       prove the pipeline end to end
  ${bold("npx merrymen kill")}           kill switch from the terminal
`);
}
