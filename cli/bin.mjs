#!/usr/bin/env node
/**
 * merrymen CLI — the terminal front door.
 *
 * Install (no clone):   npm install -g merrymen        (or github:millw14/merrymen)
 * Then:                 merrymen onboard && merrymen start
 *
 *   merrymen onboard        interactive setup wizard (keys, strategy, basket)
 *   merrymen start          run web + worker together
 *   merrymen doctor         diagnose the whole stack
 *   merrymen status         what the band is doing right now
 *   merrymen strategy new   scaffold a custom strategy in ~/.merrymen/strategies
 *   merrymen strategy list  builtins + your strategies
 *   merrymen selftest       one policy-legal no-op through the full pipeline
 *   merrymen kill           terminal kill switch (deletes the grant)
 *
 * Zero dependencies. All user data lives in ~/.merrymen (override with
 * MERRYMEN_HOME) — the install location stays disposable.
 */

import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { banner, c, spinner, type as typeOut, withSpinner } from "./ui.mjs";

// Where the PACKAGE lives (npm global dir or a checkout) — code, never data.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Where the USER's data lives — settings, grant, ledger, strategies.
const HOME = process.env.MERRYMEN_HOME ?? path.join(os.homedir(), ".merrymen");
const SETTINGS = path.join(HOME, "settings.json");
const GRANT = path.join(HOME, "grant.json");
const HEARTBEAT = path.join(HOME, "heartbeat.json");
const DB = path.join(HOME, "merrymen.db");
const STRATEGIES = path.join(HOME, "strategies");
const PKG_STRATEGIES = path.join(ROOT, "strategies");
const WELCOMED = path.join(HOME, ".welcomed");

const RPC_MAINNET = "https://rpc.mainnet.chain.robinhood.com";
const RPC_TESTNET = "https://rpc.testnet.chain.robinhood.com";
const BUILTINS = ["steady-basket", "weekend-gap", "llm-strategist"];

const green = c.green;
const red = c.red;
const yellow = c.gold;
const dim = c.dim;
const bold = c.bold;
const ok = (s) => console.log(`  ${green("✓")} ${s}`);
const bad = (s) => console.log(`  ${red("✗")} ${s}`);
const warn = (s) => console.log(`  ${yellow("⚑")} ${s}`);

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8").replace(/^﻿/, ""));
  } catch {
    return null;
  }
}

/** Create ~/.merrymen, migrate any legacy <checkout>/.data, seed the example. */
function ensureHome() {
  mkdirSync(STRATEGIES, { recursive: true });
  const legacy = path.join(ROOT, ".data");
  if (existsSync(legacy)) {
    for (const name of ["settings.json", "grant.json", "merrymen.db", "heartbeat.json"]) {
      const from = path.join(legacy, name);
      const to = path.join(HOME, name);
      if (existsSync(from) && !existsSync(to)) {
        try {
          copyFileSync(from, to);
          console.log(dim(`  migrated legacy .data/${name} → ${to}`));
        } catch {
          /* best effort */
        }
      }
    }
  }
  // Seed the example strategy + doc so the folder explains itself.
  for (const name of ["example-dip-buyer.mjs", "README.md"]) {
    const from = path.join(PKG_STRATEGIES, name);
    const to = path.join(STRATEGIES, name);
    if (existsSync(from) && !existsSync(to)) {
      try {
        copyFileSync(from, to);
      } catch {
        /* best effort */
      }
    }
  }
}

function writeSettings(next) {
  ensureHome();
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

/**
 * Spawn a local tool robustly across platforms. On Windows the .bin shims are
 * .cmd files, which Node 22 only runs via shell:true — and shell:true needs the
 * exe path AND any space-containing args quoted (the package or repo path may
 * contain spaces, e.g. "milla projects"). On POSIX we spawn directly, no shell.
 */
function toolSpawn(bin, args, opts, sync = false) {
  const runner = sync ? spawnSync : spawn;
  if (process.platform === "win32") {
    const q = (s) => (/[\s&()[\]{}^=;!'+,`~]/.test(s) ? `"${s}"` : s);
    const line = `${q(bin)} ${args.map(q).join(" ")}`;
    return runner(line, { ...opts, shell: true, windowsHide: true });
  }
  return runner(bin, args, { ...opts, shell: false });
}

/** Local binary from the package's own node_modules (works installed or cloned). */
function localBin(name) {
  const bin = path.join(ROOT, "node_modules", ".bin", process.platform === "win32" ? `${name}.cmd` : name);
  if (!existsSync(bin)) {
    bad(`${name} not found in ${dim(path.join(ROOT, "node_modules", ".bin"))} — is the install complete? (npm install)`);
    process.exit(1);
  }
  return bin;
}

function makePrompter() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const ask = (q) => new Promise((res) => rl.question(q, res));
  const askSecret = (q) =>
    new Promise((res) => {
      const orig = rl._writeToOutput.bind(rl);
      process.stdout.write(q);
      rl._writeToOutput = (s) => {
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

// ─────────────────────────────────────────────────────────────── welcome ──

/** Animated welcome — the delightful first thing after install. */
async function welcome() {
  await banner("stand and deliver — you just joined the band");
  console.log(
    `  ${bold("the band is mustered.")} raise your first agent:\n\n` +
      `     ${bold(c.lime("merrymen onboard"))}   ${dim("gather the band — bundler, keys, strategy, basket")}\n` +
      `     ${bold(c.lime("merrymen start"))}     ${dim("open the tavern (localhost:3100) + loose the worker")}\n\n` +
      `  ${c.gold(c.arrow)} ${dim("your keys, your caps · bounded worst case · every trade simulated first")}\n` +
      `  ${c.gold(c.arrow)} ${dim("learn more:")} ${bold("https://merrymen.dev")}\n`,
  );
}

/**
 * Show the welcome once, the first time any command runs after install.
 * Marker lives in ~/.merrymen so a reinstall (fresh home) re-greets.
 */
async function maybeFirstRun(cmd) {
  if (existsSync(WELCOMED)) return;
  try {
    ensureHome();
    writeFileSync(WELCOMED, new Date().toISOString(), "utf8");
  } catch {
    return; // can't write marker → skip rather than greet every run
  }
  // These already open with their own banner (onboard/start/welcome) or the
  // help banner (bare command) — a second one would just be noise. First-run
  // greeting is for the commands that otherwise start cold.
  if (cmd === undefined || ["welcome", "onboard", "start"].includes(cmd)) return;
  await welcome();
  console.log(dim("  ─────────────────────────────────────────────\n"));
}

// ─────────────────────────────────────────────────────────────── onboard ──

async function onboard() {
  await banner("gather your band · rob the spread · give yourself the yield");
  console.log(
    `  ${dim("your keys, your caps · bounded worst case · every trade simulated first")}\n` +
      `  ${bold("Every step here is optional.")} Press Enter through them all and your band\n` +
      `  rides in ${green("practice mode")} — real market, simulated fills, zero setup. Add a key\n` +
      `  later (here or in the dashboard) whenever you want to go live.\n\n` +
      `  Everything you tell me is stashed in ${dim(HOME)} — yours, outside the install.\n` +
      `  Blank answers keep what's saved. Ctrl+C to slip back into the forest anytime.\n`,
  );

  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) {
    bad(`Node ${process.versions.node} — merrymen needs Node 22+ (node:sqlite). Install from nodejs.org and rerun.`);
    process.exit(1);
  }
  if (!existsSync(path.join(ROOT, "node_modules"))) {
    bad("install incomplete — node_modules missing next to the package. Reinstall: npm install -g merrymen");
    process.exit(1);
  }

  ensureHome();
  const current = readJson(SETTINGS) ?? {};
  const p = makePrompter();
  const keep = (has) => dim(has ? ` [saved — blank keeps it]` : ` [blank skips]`);

  console.log(bold(`\n  ${c.arrow} 1/4 · go live`) + dim("  (optional — skip to stay in practice mode)"));
  console.log(dim("  To place real trades, merrymen needs one key: a free ") + "Pimlico" + dim(" key that relays"));
  console.log(dim("  your agent's transactions on-chain. Grab it at ") + bold("dashboard.pimlico.io") + dim(" → API Keys."));
  console.log(dim("  Paste just the key — we build the right URL for your chain automatically."));
  const bundlerKey = (await p.askSecret(`  Pimlico API key${keep(current.bundlerApiKey || current.bundlerUrl)}: `)).trim();
  if (bundlerKey) current.bundlerApiKey = bundlerKey;

  console.log(bold(`\n  ${c.arrow} 2/4 · give it a brain`) + dim("  (optional — free to test)"));
  console.log(dim("  Plain-English chat and the AI strategist run free on ") + "Groq" + dim("."));
  console.log(dim("  Grab a key at ") + bold("console.groq.com/keys") + dim(" — 30s, no card. (Built-ins need no key.)"));
  const groq = (await p.askSecret(`  Groq API key${keep(current.groqApiKey)}: `)).trim();
  if (groq) current.groqApiKey = groq;
  console.log(dim("  Want the smartest brain + screen vision? Add an Anthropic key to upgrade:"));
  const anthropic = (await p.askSecret(`  Anthropic API key (upgrade)${keep(current.anthropicApiKey)}: `)).trim();
  if (anthropic) current.anthropicApiKey = anthropic;

  console.log(bold(`\n  ${c.arrow} 3/4 · pick your outlaw`) + dim("  (strategy)"));
  const custom = await listCustom();
  const all = [...BUILTINS, ...custom];
  all.forEach((s, i) =>
    console.log(
      `  ${i + 1}. ${s}${custom.includes(s) ? dim(" (yours)") : ""}${s === (current.strategy ?? "steady-basket") ? green(" ← current") : ""}`,
    ),
  );
  console.log(dim(`  forge your own outlaw: merrymen strategy new <name>  (template lands in ${STRATEGIES})`));
  const pick = (await p.ask(`  pick 1-${all.length} [blank keeps current]: `)).trim();
  const idx = Number(pick) - 1;
  if (pick && Number.isInteger(idx) && all[idx]) current.strategy = all[idx];

  console.log(bold(`\n  ${c.arrow} 4/4 · the loot`) + dim("  (basket — equal-weighted)"));
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

  console.log(bold(`\n  ${c.arrow} a raven to Telegram`) + dim("  (chat with your merryman — optional)"));
  console.log(dim("  Create a bot: message @BotFather in Telegram, send /newbot, copy the token."));
  console.log(dim("  Then finish linking from the dashboard settings, or leave blank to skip."));
  const tgToken = (await p.askSecret(`  Telegram bot token${keep(current.telegramBotToken)}: `)).trim();
  if (tgToken) {
    current.telegramBotToken = tgToken;
    current.telegramEnabled = true;
    ok("telegram enabled — you'll link your chat from the dashboard");
  }

  p.close();
  const s = spinner("stashing your plans in the hollow oak");
  writeSettings(current);
  await new Promise((r) => setTimeout(r, 400));
  s.succeed(`stashed ${dim(SETTINGS)}`);

  console.log(`
${bold(`  ${c.arrow} ride out`)}
  1. ${bold("merrymen start")} — opens the tavern (dashboard) at http://localhost:3100 + looses the worker
  2. at ${bold("/grant")}, create your agent wallet — pick testnet 46630 (practice) or mainnet 4663 (real funds)
  3. testnet gas from the sheriff's vault: ${dim("https://faucet.testnet.chain.robinhood.com")} ${dim("(mainnet: fund from your own wallet)")}
  4. prove the shot lands: ${bold("merrymen selftest")}
  5. muster check anytime: ${bold("merrymen doctor")} · tune the band: ${dim("http://localhost:3100/settings")}

  ${dim("guide & docs:")} ${bold("https://merrymen.dev")} ${dim("·")} ${dim("https://merrymen.dev/docs")}

  ${c.gold("nock, draw, loose. 🏹")}
`);
}

/** Open a URL in the default browser, cross-platform. Best-effort, never throws. */
function openBrowser(url) {
  try {
    const [cmd, args] =
      process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : process.platform === "darwin"
          ? ["open", [url]]
          : ["xdg-open", [url]];
    spawn(cmd, args, { stdio: "ignore", detached: true, shell: false }).unref();
  } catch {
    // no browser to open (headless/server) — the URL is printed anyway
  }
}

// ───────────────────────────────────────────────────────────────── start ──

async function start() {
  ensureHome();
  warnIfOldNode();
  const noOpen = process.argv.includes("--no-open");
  // Bind localhost-only by default: the dashboard has no login and holds your
  // trading controls, so it must not be reachable from the LAN. Opt into
  // network access explicitly with MERRYMEN_HOST=0.0.0.0 (e.g. phone on your
  // home WiFi) — only on a network you trust.
  const host = process.env.MERRYMEN_HOST || "127.0.0.1";
  const url = "http://localhost:3100";
  await banner("the band rides out");
  const web = path.join(ROOT, "web");
  // Serve the prebuilt production app (next start), not dev-mode — the robust
  // distribution model. If the build is missing (a source install where the
  // prepare hook didn't run), build it once under a spinner.
  if (!existsSync(path.join(web, ".next", "BUILD_ID"))) {
    try {
      await withSpinner("raising the tavern (first-run build, ~15s)", async () => {
        const b = toolSpawn(localBin("next"), ["build"], { cwd: web }, true);
        if (b.status !== 0) throw new Error("build failed");
      });
    } catch {
      bad("the tavern won't stand (dashboard build failed) — the worker still runs via `merrymen selftest`.");
      process.exit(1);
    }
  }

  let opened = false;
  const openOnce = () => {
    if (opened || noOpen) return;
    opened = true;
    console.log(`\n  ${c.green(c.arrow)} tavern's open — ${c.bold(url)} ${dim("(opening your browser…)")}\n`);
    openBrowser(url);
  };

  // Next serves from the app dir as cwd; the worker runs from ROOT.
  const procs = [
    { name: "tavern", bin: localBin("next"), args: ["start", "-p", "3100", "-H", host], cwd: web },
    { name: "band  ", bin: localBin("tsx"), args: [path.join(ROOT, "worker", "src", "index.ts")], cwd: ROOT },
  ].map(({ name, bin, args, cwd }) => {
    const child = toolSpawn(bin, args, { cwd });
    const pipe = (stream, sink) =>
      stream.on("data", (chunk) => {
        const text = String(chunk);
        if (name === "tavern" && /Ready|started server|Local:/i.test(text)) openOnce();
        text
          .split(/\r?\n/)
          .filter((l) => l.trim())
          .forEach((l) => sink.write(`${dim(`[${name}]`)} ${l}\n`));
      });
    pipe(child.stdout, process.stdout);
    pipe(child.stderr, process.stderr);
    child.on("exit", (code) => console.log(`${dim(`[${name}]`)} rode off (${code})`));
    return child;
  });
  // Fallback: open even if we never matched a ready line.
  setTimeout(openOnce, 12_000);

  console.log(dim("  Ctrl+C calls the whole band home.\n"));
  const stop = () => {
    console.log(`\n  ${c.gold(c.arrow)} calling the band home…`);
    procs.forEach((ch) => ch.kill("SIGINT"));
    setTimeout(() => process.exit(0), 500);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

// ──────────────────────────────────────────────────────────────── doctor ──

async function doctor() {
  console.log(`\n${bold(`  ${c.arrow} muster check`)}  ${dim("is the band ready to ride?")}\n`);
  ensureHome();
  const s = readJson(SETTINGS) ?? {};

  nodeVersionOk()
    ? ok(`node ${process.versions.node}`)
    : bad(`node ${process.versions.node} — need ${NODE_MIN.join(".")}+ for node:sqlite (run: merrymen setup)`);
  const npmV = sh("npm", ["--version"]);
  npmV ? ok(`npm ${npmV}`) : warn("npm not found on PATH — reinstall Node (run: merrymen setup)");
  const binDir = npmGlobalBinDir();
  if (binDir && !onPath(binDir)) warn(`npm global bin not on PATH — "command not found" trap (run: merrymen setup)`);
  existsSync(path.join(ROOT, "node_modules")) ? ok("package install complete") : bad("node_modules missing — reinstall");
  console.log(`  ${dim(`package: ${ROOT}`)}`);
  console.log(`  ${dim(`home:    ${HOME}`)}`);

  existsSync(SETTINGS) ? ok("settings present") : warn("no settings yet — run: merrymen onboard");
  s.bundlerUrl || process.env.MERRYMEN_BUNDLER_URL
    ? ok("bundler URL configured")
    : warn("no bundler URL — the agent will simulate but never sign (get one: dashboard.pimlico.io)");
  s.anthropicApiKey || process.env.ANTHROPIC_API_KEY
    ? ok("Anthropic key set (llm-strategist can trade)")
    : warn("no Anthropic key — llm-strategist would run idle");
  s.rialtoApiKey || process.env.MERRYMEN_RIALTO_API_KEY
    ? ok("Rialto key set")
    : warn("no Rialto key — rialto venue stays approval-only");

  const sp1 = spinner("scouting the Robinhood Chain (mainnet)");
  const mainnetBlock = await rpcCall(s.rpcMainnet ?? RPC_MAINNET, "eth_blockNumber");
  mainnetBlock
    ? sp1.succeed(`mainnet RPC reachable ${dim(`block ${parseInt(mainnetBlock, 16).toLocaleString()}`)}`)
    : sp1.fail("mainnet RPC unreachable");
  const sp2 = spinner("scouting the testnet road");
  const testnetBlock = await rpcCall(s.rpcTestnet ?? RPC_TESTNET, "eth_blockNumber");
  testnetBlock
    ? sp2.succeed(`testnet RPC reachable ${dim(`block ${parseInt(testnetBlock, 16).toLocaleString()}`)}`)
    : sp2.fail("testnet RPC unreachable");

  if (s.bundlerUrl) {
    const sp3 = spinner("waking the getaway horse (bundler)");
    const eps = await rpcCall(s.bundlerUrl, "eth_supportedEntryPoints");
    Array.isArray(eps) && eps.length
      ? sp3.succeed(`bundler reachable ${dim(`${eps.length} entrypoint${eps.length > 1 ? "s" : ""}`)}`)
      : sp3.fail("bundler did not answer eth_supportedEntryPoints — check the URL/key");
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
  else warn("worker not running (no heartbeat in 90s) — merrymen start");

  existsSync(DB) ? ok("ledger present (~/.merrymen/merrymen.db)") : warn("no ledger yet — appears after the worker's first tick");

  const custom = await listCustom();
  const strategy = s.strategy ?? "steady-basket";
  if (BUILTINS.includes(strategy)) ok(`strategy: ${strategy} (builtin)`);
  else if (custom.includes(strategy)) ok(`strategy: ${strategy} (yours, ~/.merrymen/strategies/${strategy}.*)`);
  else bad(`strategy "${strategy}" is neither builtin nor in ${STRATEGIES} — the worker will idle with a warning`);
  if (custom.length) console.log(`  ${dim(`your strategies: ${custom.join(", ")}`)}`);

  // telegram
  if (s.telegramBotToken && s.telegramEnabled) {
    const tg = await rpcTelegramGetMe(s.telegramBotToken);
    tg ? ok(`telegram: connected as @${tg}`) : bad("telegram: token set but getMe failed — check the token");
  } else if (s.telegramBotToken) {
    warn("telegram: token set but disabled — enable it in the dashboard");
  } else {
    console.log(`  ${dim("telegram: not configured (optional — set it up in the dashboard)")}`);
  }
  console.log();
}

/** getMe against the Bot API for `doctor`; returns @username or null. */
async function rpcTelegramGetMe(token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 7000);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal: controller.signal });
    const j = await res.json();
    return j && j.ok && j.result && j.result.username ? j.result.username : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ──────────────────────────────────────────────────────────────── status ──

async function status() {
  console.log(`\n${bold(`  ${c.arrow} the band, right now`)}\n`);
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
 * wall disposes. See README.md and example-dip-buyer.mjs in this folder.
 *
 * No imports needed — ctx injects the registry:
 *   ctx.tokenBySymbol.QQQ · ctx.CASH.USDG · ctx.UNISWAP.swapRouter02
 *   ctx.MORPHO.steakhouseUsdgVault · ctx.STOCK_TOKENS · ctx.usdg(25)
 * Units: USDG = 6dp bigint · stock balances = 18dp bigint · prices = 8dp bigint.
 */

export default {
  name: "${name}",

  tick(snap, ctx) {
    if (!snap.sequencerUp) return [];

    // your logic here — e.g. buy 10 USDG of QQQ when you like the setup:
    // return [{
    //   kind: "swap",
    //   target: ctx.UNISWAP.swapRouter02,
    //   sellToken: ctx.CASH.USDG,
    //   buyToken: ctx.tokenBySymbol.QQQ,
    //   sellAmountRaw: ctx.usdg(10),
    //   notionalUsdg: ctx.usdg(10),
    // }];

    return [];
  },
};
`;

async function strategyCmd(sub, name) {
  ensureHome();
  if (sub === "list") {
    console.log(bold("builtin"));
    BUILTINS.forEach((s) => console.log(`  ${s}`));
    const custom = await listCustom();
    console.log(bold("yours") + dim(` (${STRATEGIES})`));
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
    const file = path.join(STRATEGIES, `${name}.mjs`);
    if (existsSync(file)) {
      bad(`${file} already exists — refusing to overwrite`);
      process.exit(1);
    }
    writeFileSync(file, TEMPLATE(name), "utf8");
    ok(`created ${file}`);
    console.log(`  edit it, then select "${name}" in /settings or: merrymen onboard`);
    return;
  }
  bad("usage: merrymen strategy <list|new> [name]");
  process.exit(1);
}

// ────────────────────────────────────────────────────────── selftest/kill ──

function selftest() {
  console.log(`\n  ${bold(`${c.arrow} one arrow through the whole pipeline`)} ${dim("grant → policy → bundler → chain")}\n`);
  const child = toolSpawn(localBin("tsx"), [path.join(ROOT, "worker", "src", "index.ts"), "--selftest"], {
    cwd: ROOT,
    stdio: "inherit",
  });
  child.on("exit", (code) => process.exit(code ?? 1));
}

async function kill() {
  if (!existsSync(GRANT)) {
    warn("no grant to call in — the band's already home");
    return;
  }
  const p = makePrompter();
  const answer = (await p.ask(`  ${red("CALL THE BAND HOME")} — destroy the grant? The worker halts on its next tick. [y/N]: `)).trim().toLowerCase();
  p.close();
  if (answer === "y" || answer === "yes") {
    rmSync(GRANT, { force: true });
    ok("grant destroyed — the band stands down on the next tick (on-chain expiry is the backstop)");
  } else {
    console.log(dim("  stayed the hand — nothing touched"));
  }
}

// ──────────────────────────────────────────────────────── environment setup ──

const NODE_MIN = [22, 12]; // node:sqlite + the modern APIs the worker leans on

function nodeVersionOk(v = process.versions.node) {
  const [maj, min] = v.split(".").map(Number);
  return maj > NODE_MIN[0] || (maj === NODE_MIN[0] && min >= NODE_MIN[1]);
}

/** Run a command, capture trimmed stdout, never throw. null on any failure. */
function sh(cmd, args) {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", shell: process.platform === "win32" });
    if (r.status === 0 && typeof r.stdout === "string") return r.stdout.trim();
  } catch {
    /* ignore */
  }
  return null;
}

/** The dir npm drops global CLIs into — what must be on PATH for `merrymen`. */
function npmGlobalBinDir() {
  const prefix = sh("npm", ["prefix", "-g"]);
  if (!prefix) return null;
  // Windows: the prefix dir itself holds the shims; POSIX: <prefix>/bin.
  return process.platform === "win32" ? prefix : path.join(prefix, "bin");
}

function onPath(dir) {
  if (!dir) return false;
  const norm = (p) =>
    process.platform === "win32" ? p.toLowerCase().replace(/[\\/]+$/, "") : p.replace(/\/+$/, "");
  return (process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean)
    .map(norm)
    .includes(norm(dir));
}

/** The exact copy-paste line to put a dir on PATH for this OS. */
function pathFix(dir) {
  if (process.platform === "win32") {
    return `[Environment]::SetEnvironmentVariable("Path", [Environment]::GetEnvironmentVariable("Path","User") + ";${dir}", "User")`;
  }
  return `echo 'export PATH="${dir}:$PATH"' >> ~/.zshrc && source ~/.zshrc`;
}

/** How to install a modern Node on this OS. */
function nodeInstallHint() {
  if (process.platform === "win32") return "winget install OpenJS.NodeJS.LTS   (or https://nodejs.org)";
  if (process.platform === "darwin") return "brew install node   (or https://nodejs.org)";
  return "use nvm/fnm, or https://nodejs.org/en/download";
}

/**
 * `merrymen setup` — a rig check that runs even when things are broken:
 * Node version, npm, and the global-bin PATH trap that yields
 * "merrymen: command not found". Prints exact, copy-paste fixes.
 */
async function setup() {
  await banner("kit up — check your rig");
  console.log();

  const v = process.versions.node;
  if (nodeVersionOk(v)) {
    ok(`node ${v} ${dim(`(need ${NODE_MIN.join(".")}+)`)}`);
  } else {
    bad(`node ${v} is too old — merrymen needs ${NODE_MIN.join(".")}+ (node:sqlite)`);
    console.log(`      ${bold("install a newer Node:")} ${dim(nodeInstallHint())}`);
  }

  const npmV = sh("npm", ["--version"]);
  npmV
    ? ok(`npm ${npmV}`)
    : bad("npm not found — it ships with Node; (re)install Node from https://nodejs.org");

  const binDir = npmGlobalBinDir();
  if (!binDir) {
    warn("couldn't locate npm's global bin (npm prefix -g failed) — is npm on PATH?");
  } else if (onPath(binDir)) {
    ok(`global CLIs on PATH ${dim(binDir)}`);
  } else {
    bad('npm\'s global bin isn\'t on PATH — the "merrymen: command not found" trap');
    console.log(`      ${dim(binDir)}`);
    console.log(`      ${bold("fix once")} ${dim("(then open a NEW terminal):")}`);
    console.log(`      ${dim(pathFix(binDir))}`);
    console.log(`      ${dim("…or just prefix commands: ")}${bold("npx merrymen start")}`);
  }

  const resolved =
    process.platform === "win32" ? sh("where", ["merrymen"]) : sh("which", ["merrymen"]);
  resolved
    ? ok(`merrymen resolves ${dim(resolved.split(/\r?\n/)[0])}`)
    : warn("merrymen not yet resolvable by name — use the PATH fix above, or `npx merrymen`");

  console.log(`\n  ${c.gold(c.arrow)} ${dim("rig ready? → ")}${bold("merrymen onboard")}\n`);
}

/** Soft guard for commands that need a modern Node; warns, points to setup. */
function warnIfOldNode() {
  if (!nodeVersionOk()) {
    warn(
      `node ${process.versions.node} is below ${NODE_MIN.join(".")} — the worker needs node:sqlite. Run ${bold("merrymen setup")} for the fix.`,
    );
  }
}

/**
 * Self-update. A running dashboard/worker holds file locks inside the global
 * install, so a bare `npm i -g merrymen@latest` dies with EBUSY on Windows.
 * This stops the band's child processes (NOT this CLI — the pattern matches
 * the nested node_modules the children run from), then upgrades from a cwd
 * OUTSIDE the install folder so nothing we hold can block npm's rename.
 */
async function update() {
  await banner("fresh arrows from the fletcher");
  if (process.platform === "win32") {
    // -Command text is unaffected by the .ps1 execution policy.
    const ps =
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
      "Where-Object { $_.CommandLine -like '*merrymen\\node_modules\\*' -and $_.ProcessId -ne " + process.pid + " } | " +
      "ForEach-Object { Stop-Process -Id $_.ProcessId -Force }";
    spawnSync("powershell", ["-NoProfile", "-Command", ps], { stdio: "ignore" });
  } else {
    spawnSync("sh", ["-c", "pkill -f 'merrymen/node_modules' 2>/dev/null || true"], { stdio: "ignore" });
  }
  ok("band called home — any running dashboard/worker stopped");

  console.log(dim("  fetching the latest from the fletcher…\n"));
  const r =
    process.platform === "win32"
      ? spawnSync("cmd.exe", ["/c", "npm install -g merrymen@latest"], { stdio: "inherit", cwd: os.tmpdir() })
      : spawnSync("sh", ["-c", "npm install -g merrymen@latest"], { stdio: "inherit", cwd: os.tmpdir() });

  if (r.status === 0) {
    console.log(`\n  ${green("✓")} ${bold("upgraded.")} ride out again: ${bold(c.lime("merrymen start"))}\n`);
  } else {
    bad("upgrade failed — if it said EBUSY, close any terminal cd'd into the install folder and rerun merrymen update");
  }
}

// ────────────────────────────────────────────────────────────────── main ──

const [, , cmd, ...rest] = process.argv;
await maybeFirstRun(cmd);
switch (cmd) {
  case "welcome":
    await welcome();
    break;
  case "setup":
    await setup();
    break;
  case "onboard":
    await onboard();
    break;
  case "start":
    await start();
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
  case "update":
  case "upgrade":
    await update();
    break;
  default:
    await banner("stand and deliver — autonomous agents for Robinhood Chain");
    console.log(`${dim("  install: npm install -g merrymen · your loot: ~/.merrymen")}

  ${bold("merrymen setup")}          check your rig — node, npm, PATH (with fixes)
  ${bold("merrymen onboard")}        gather the band (keys, strategy, basket)
  ${bold("merrymen start")}          open the tavern (localhost:3100) + loose the worker
  ${bold("merrymen doctor")}         muster check — node/keys/RPC/bundler/grant/db
  ${bold("merrymen status")}         what the band's up to — heartbeat, grant, trades, equity
  ${bold("merrymen strategy new")}   forge your own outlaw in ~/.merrymen/strategies
  ${bold("merrymen strategy list")}  the roster — builtins + your strategies
  ${bold("merrymen selftest")}       fire one arrow through the whole pipeline
  ${bold("merrymen kill")}           call the band home (kill switch)
  ${bold("merrymen update")}         stop the band, upgrade to latest, no EBUSY
  ${bold("merrymen welcome")}        replay the intro 🏹

  ${c.gold(c.arrow)} ${dim("your keys, your caps · bounded worst case · every trade simulated first")}
`);
}
