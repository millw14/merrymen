/**
 * Opt-in LOCAL process drill. Runs the real index.ts (no worker mock), with a
 * fresh synthetic owner and the canonical signer's real serialized empty Perps
 * wall. macOS sandbox-exec denies all networking except this test's loopback RPC.
 * The sandbox must prove external denial before the worker is started.
 *
 * MERRYMEN_TEST_PERPS_CHILD=1 node --import tsx --test worker/src/perps-child-process.test.ts
 * No user session, real chain, venue, bundler or production home is involved.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { decodeFunctionData, encodeFunctionResult, multicall3Abi, toFunctionSelector } from "viem";
import { signerGrant } from "../../web/src/lib/canonical-wall-fixture";
import { writeCommand, readCommandState } from "./command-files";
import { writeFileAtomicSync } from "./atomic-write";
import { readLighterFeed, specToJson } from "./perps/feed-reader";
import { parseOrderBookDetails } from "./perps/markets";
import { candles, H4 } from "./perps/testkit-perps";

const enabled = process.env.MERRYMEN_TEST_PERPS_CHILD === "1";
const root = path.resolve(import.meta.dirname, "../..");
const account = "0x00000000000000000000000000000000c11d0001" as const;
const word = (n: bigint) => n.toString(16).padStart(64, "0");
const zero = `0x${"0".repeat(64)}`;

test("real paper Perps child: isolated startup, durable commands, restart and stop", {
  skip: !enabled, timeout: 180_000,
}, async t => {
  assert.equal(process.platform, "darwin", "this explicit drill needs the tested OS network sandbox");
  assert.ok(existsSync("/usr/bin/sandbox-exec"));
  const scratch = mkdtempSync(path.join(os.tmpdir(), "merrymen-perps-child-"));
  chmodSync(scratch, 0o700);
  const installHome = path.join(scratch, "install");
  const home = path.join(installHome, "accounts", "perps");
  const cwd = path.join(scratch, "cwd");
  mkdirSync(home, { recursive: true, mode: 0o700 }); mkdirSync(cwd, { mode: 0o700 });
  const rpcMethods: string[] = [];
  const forbiddenRpc: string[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) {
      body += String(chunk);
      if (body.length > 1_048_576) { res.writeHead(413).end(); return; }
    }
    const answer = (q: { id: unknown; method: string; params?: unknown[] }) => {
      rpcMethods.push(q.method);
      let result: unknown;
      switch (q.method) {
        case "eth_chainId": result = "0x1237"; break;
        case "eth_blockNumber": result = "0x3039"; break;
        case "eth_getBlockByNumber": result = {
          number: "0x3039", timestamp: `0x${Math.floor(Date.now() / 1000).toString(16)}`,
          hash: zero, parentHash: zero, transactions: [], uncles: [], gasLimit: "0x1c9c380", gasUsed: "0x0",
          baseFeePerGas: "0x1", difficulty: "0x0", extraData: "0x", miner: `0x${"0".repeat(40)}`,
          nonce: "0x0000000000000000", size: "0x1", logsBloom: `0x${"0".repeat(512)}`,
        }; break;
        case "eth_getCode": result = "0x"; break;
        case "eth_getBalance": result = "0x0"; break;
        case "eth_getLogs": result = []; break;
        case "eth_call": {
          const input = q.params?.[0] as { data?: `0x${string}` } | undefined;
          const readCall = (data: `0x${string}`): `0x${string}` => {
            const selector = data.slice(0, 10);
            if (selector === toFunctionSelector("latestRoundData()")) {
              const now = BigInt(Math.floor(Date.now() / 1000));
              return `0x${[1n, 100_00000000n, now, now, 1n].map(word).join("")}`;
            }
            if (selector === toFunctionSelector("uiMultiplier()")) return `0x${word(10n ** 18n)}`;
            if (["tokenPaused()", "balanceOf(address)", "getPool(address,address,uint24)", "currentNonce()", "validNonceFrom(address)"].map(toFunctionSelector).includes(selector as `0x${string}`)) return zero as `0x${string}`;
            forbiddenRpc.push(`eth_call:${selector}`);
            throw new Error("Not a permitted fixture contract read");
          };
          if (input?.data?.slice(0, 10) === toFunctionSelector("aggregate3((address,bool,bytes)[])")) {
            const call = decodeFunctionData({ abi: multicall3Abi, data: input.data });
            assert.equal(call.functionName, "aggregate3");
            if (call.functionName !== "aggregate3") throw new Error("unexpected multicall");
            result = encodeFunctionResult({ abi: multicall3Abi, functionName: "aggregate3",
              result: call.args[0].map(c => ({ success: true, returnData: readCall(c.callData) })) });
          } else result = readCall(input?.data ?? "0x");
          break;
        }
        default: forbiddenRpc.push(q.method); return { jsonrpc: "2.0", id: q.id, error: { code: -32601, message: "Not a permitted fixture read" } };
      }
      return { jsonrpc: "2.0", id: q.id, result };
    };
    try {
      const input = JSON.parse(body);
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(Array.isArray(input) ? input.map(answer) : answer(input)));
    } catch { res.writeHead(400).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const rpc = `http://127.0.0.1:${port}`;
  const profile = `(version 1) (allow default) (deny network*) (allow network-outbound (remote ip "localhost:${port}"))`;
  const env: NodeJS.ProcessEnv = {
    PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: scratch, TMPDIR: scratch,
    MERRYMEN_HOME: home, MERRYMEN_PERPS: "paper", MERRYMEN_WALLET_PURPOSE: "perps",
    MERRYMEN_RPC_MAINNET: rpc, MERRYMEN_RPC_TESTNET: rpc,
    MERRYMEN_HALT_PERP_ENTRIES: "1", NO_COLOR: "1",
  };
  const spec = parseOrderBookDetails(JSON.parse(readFileSync(path.join(root, "worker/src/perps/fixtures/orderBookDetails.perp.json"), "utf8")))!.markets.get(1)!.spec;
  const feedFile = path.join(home, "lighter-feed.json");
  const publishFeed = () => {
    const now = Date.now();
    const lastClosed = Math.floor(now / H4) * H4 - H4;
    const lastHour = Math.floor(now / 3_600_000) * 3600 - 3600;
    const m = {
      observedAt: now, priceSource: "ws", mark: "800000", index: "800000", status: "active",
      spec: specToJson(spec), specObservedAt: now, takerFeePpm: 0, makerFeePpm: 0,
      bids: [["799999", "100000000"]], asks: [["800001", "100000000"]], bookObservedAt: now, bookSource: "ws",
      closed4h: candles(Array(120).fill(800_000n), 200n, lastClosed).map(c => ({ t: c.t, o: String(c.o), h: String(c.h), l: String(c.l), c: String(c.c) })),
      candlesObservedAt: now, fundingsObservedAt: now,
      fundings1h: Array.from({ length: 8 }, (_, i) => ({ t: lastHour - (7 - i) * 3600, rate: "0.0000", direction: "long" })),
    };
    writeFileAtomicSync(feedFile, JSON.stringify({ v: 1, observedAt: now, markets: { "1": m } }));
  };
  publishFeed();
  assert.ok(readLighterFeed(feedFile, Date.now()), "synthetic public feed passes the real reader");
  const feedTimer = setInterval(publishFeed, 1000);
  let child: ChildProcess | null = null;
  let output = "";
  const logPath = path.join(scratch, "worker.log");
  const waitFor = async (label: string, check: () => boolean, timeout = 35_000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      assert.ok(!child || (child.exitCode === null && child.signalCode === null), `${label}: child exited ${child?.exitCode}/${child?.signalCode}\n${output.slice(-6000)}`);
      if (check()) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.fail(`${label}: timed out\n${output.slice(-6000)}`);
  };
  const launch = () => {
    child = spawn("/usr/bin/sandbox-exec", ["-p", profile, process.execPath, "--import", path.join(root, "node_modules/tsx/dist/loader.mjs"), path.join(root, "worker/src/index.ts")], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    for (const stream of [child.stdout, child.stderr]) stream?.on("data", chunk => { output += String(chunk); writeFileSync(logPath, output, { mode: 0o600 }); });
  };
  const stop = async () => {
    if (!child) return;
    const proc = child;
    assert.equal(proc.exitCode, null, "worker must still be alive when a graceful stop is requested");
    assert.equal(proc.signalCode, null);
    proc.kill("SIGTERM");
    const timer = setTimeout(() => proc.kill("SIGKILL"), 22_000);
    const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>(resolve => proc.once("exit", (c, s) => resolve([c, s])));
    clearTimeout(timer); child = null;
    assert.equal(signal, null, "worker must drain, not need forced termination");
    assert.equal(code, 0);
  };
  const crash = async () => {
    const proc = child as ChildProcess | null;
    assert.ok(proc && proc.exitCode === null && proc.signalCode === null);
    const exited = new Promise<[number | null, NodeJS.Signals | null]>(resolve => proc.once("exit", (c, sig) => resolve([c, sig])));
    proc.kill("SIGKILL"); // Deliberate crash injection AFTER the durable reset acknowledgement.
    const [code, signal] = await exited;
    child = null;
    assert.equal(code, null);
    assert.equal(signal, "SIGKILL");
  };
  const isolatedControl = async (code: string) => {
    const proc = spawn("/usr/bin/sandbox-exec", ["-p", profile, process.execPath, "--import", path.join(root, "node_modules/tsx/dist/loader.mjs"), "--input-type=module", "-e", code], {
      cwd, env: { ...env, MERRYMEN_HOME: installHome, MERRYMEN_PERPS: "off" }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    proc.stdout.on("data", chunk => { stdout += String(chunk); });
    proc.stderr.on("data", chunk => { stderr += String(chunk); });
    const timer = setTimeout(() => proc.kill("SIGKILL"), 20_000);
    const [codeOut, signal] = await new Promise<[number | null, NodeJS.Signals | null]>(resolve => proc.once("exit", (c, sig) => resolve([c, sig])));
    clearTimeout(timer);
    assert.equal(signal, null, "isolated local control must complete");
    assert.equal(codeOut, 0, stderr);
    return JSON.parse(stdout);
  };
  const rows = (sql: string) => {
    const file = path.join(home, "merrymen.db");
    const db = new DatabaseSync(file, { readOnly: true });
    try { return db.prepare(sql).all(); } finally { db.close(); }
  };
  const step = async (label: string, run: () => Promise<void>) => { await run(); t.diagnostic(label); };
  try {
    await step("OS isolation refuses external TCP before allowing the fixture RPC", async () => {
      const code = `const net=require('node:net');const c=net.connect({host:'203.0.113.1',port:443});c.on('connect',()=>process.exit(2));c.on('error',e=>{if(e.code!=='EPERM')process.exit(3);const l=net.connect({host:'127.0.0.1',port:${port}},()=>{l.end();process.stdout.write('external=EPERM loopback=ok');});l.on('error',()=>process.exit(4));});setTimeout(()=>process.exit(5),3000).unref();`;
      const probe = spawn("/usr/bin/sandbox-exec", ["-p", profile, process.execPath, "-e", code], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
      let said = ""; probe.stdout.on("data", chunk => { said += String(chunk); });
      assert.equal(await new Promise(resolve => probe.once("exit", resolve)), 0);
      assert.equal(said, "external=EPERM loopback=ok");
    });
    const { grant } = await signerGrant({ account, purpose: "perps" });
    assert.equal(grant.purpose, "perps");
    assert.deepEqual(grant.grantFeatures, []);
    const serialized = JSON.parse(Buffer.from(grant.serialized, "base64").toString("utf8"));
    assert.equal(BigInt(`0x${serialized.accountParams.initCode.slice(2 + 8 + 64 * 2, 2 + 8 + 64 * 3)}`), 1n);
    writeFileSync(path.join(home, "grant.json"), JSON.stringify(grant), { mode: 0o600 });
    writeFileSync(path.join(home, "settings.json"), JSON.stringify({
      paperTradingEnabled: true, liveTradingEnabled: false, perpsEnabled: false, perpsLiveEnabled: false,
      paperStartUsdg: 100, tickSeconds: 15, rpcMainnet: rpc, rpcTestnet: rpc, telegramEnabled: false,
    }), { mode: 0o600 });
    await step("the actual child arms paper with entries off and writes its own book", async () => {
      launch();
      await waitFor("paper book", () => {
        if (!existsSync(path.join(home, "merrymen.db"))) return false;
        try { return rows("SELECT cash_usdg FROM paper_book").length === 1; }
        catch (e) { if (String(e).includes("no such table")) return false; throw e; }
      });
      assert.equal(rows("SELECT cash_usdg FROM paper_book")[0]!.cash_usdg, 100);
      assert.equal(rows("SELECT mode FROM agents")[0]!.mode, "paper");
      assert.match(output, /strategy perps-only/);
      await waitFor("Perps lane report", () => typeof rows("SELECT perps FROM agents")[0]!.perps === "string");
      const report = JSON.parse(String(rows("SELECT perps FROM agents")[0]!.perps));
      assert.equal(report.mode, "off", "paper Perps entries remain off");
      assert.equal(report.blocker, "perps-off");
      assert.ok(report.protectAt > 0, "real Perps lane ran its independent protection/report clock");
      const armed = rows("SELECT smart_account,owner_address,session_key_address,chain_id FROM agents")[0]!;
      assert.equal(armed.smart_account, account);
      assert.equal(String(armed.owner_address).toLowerCase(), grant.owner.toLowerCase());
      assert.equal(String(armed.session_key_address).toLowerCase(), grant.sessionKeyAddress.toLowerCase());
      assert.equal(armed.chain_id, grant.chainId);
      assert.equal(rows("SELECT * FROM perp_fills").length, 0);
      assert.equal(rows("SELECT * FROM trades").length, 0);
    });
    await step("real Perps close-all persists its halt and cross-account reset is refused", async () => {
      const at = Date.now();
      writeCommand(home, { id: "isolated-close-all", kind: "trade", at, expiresAt: at + 90_000, account,
        args: { side: "sell", symbol: "ALL-PERPS", usdgAmount: 0, purpose: "flatten-perps" } });
      await waitFor("close-all answer", () => readCommandState(home, "isolated-close-all")?.state === "done");
      assert.equal(readCommandState(home, "isolated-close-all")!.result?.ok, true);
      assert.equal(rows("SELECT entries_halted FROM perp_accounts WHERE mode='paper'")[0]!.entries_halted, 1);
      const epoch = rows("SELECT epoch FROM agents")[0]!.epoch;
      writeCommand(home, { id: "wrong-account-reset", kind: "paper-reset", at: Date.now(), expiresAt: Date.now() + 90_000,
        account: "0x00000000000000000000000000000000c11d0002" });
      await waitFor("wrong-account refusal", () => readCommandState(home, "wrong-account-reset")?.state === "done");
      assert.equal(readCommandState(home, "wrong-account-reset")!.result?.ok, false);
      assert.equal(rows("SELECT epoch FROM agents")[0]!.epoch, epoch);
      assert.equal(rows("SELECT entries_halted FROM perp_accounts WHERE mode='paper'")[0]!.entries_halted, 1);
    });
    await step("a real reset command survives process death and restart does not replay it", async () => {
      const at = Date.now();
      writeCommand(home, { id: "isolated-paper-reset", kind: "paper-reset", at, expiresAt: at + 90_000, account });
      await waitFor("reset result", () => readCommandState(home, "isolated-paper-reset", { kind: "paper-reset", account })?.state === "done");
      const result = readCommandState(home, "isolated-paper-reset", { kind: "paper-reset", account });
      assert.ok(result && result.state === "done");
      assert.equal(result.result?.ok, true);
      assert.equal(rows("SELECT entries_halted FROM perp_accounts WHERE mode='paper'")[0]!.entries_halted, 0);
      const before = JSON.stringify(rows("SELECT cash_usdg,vault_usdg,shares FROM paper_book"));
      const epoch = rows("SELECT epoch FROM agents")[0]!.epoch;
      await crash();
      const offset = output.length;
      launch();
      await waitFor("restart paper tick", () => output.slice(offset).includes("[tick] mainnet block 12345"));
      await waitFor("post-restart valuation", () => rows("SELECT hwm_usdg FROM paper_book")[0]!.hwm_usdg === 100);
      await stop(); // Drain that NEW tick before checking that no reset or trade replayed.
      assert.equal(JSON.stringify(rows("SELECT cash_usdg,vault_usdg,shares FROM paper_book")), before);
      assert.equal(rows("SELECT epoch FROM agents")[0]!.epoch, epoch, "restart must not apply the answered reset twice");
      assert.deepEqual(readCommandState(home, "isolated-paper-reset", { kind: "paper-reset", account }), result);
    });
    await step("local kill removes authority, preserves recoverable archive and keeps restart unarmed", async () => {
      const before = JSON.stringify(rows("SELECT cash_usdg,vault_usdg,shares FROM paper_book"));
      const epoch = rows("SELECT epoch FROM agents")[0]!.epoch;
      const activeOffset = output.length;
      launch();
      await waitFor("paper worker before kill", () => output.slice(activeOffset).includes("[tick] mainnet block 12345"));
      const spotSettings = JSON.stringify({ paperTradingEnabled: true, agentName: "untouched Spot fixture" });
      writeFileSync(path.join(installHome, "settings.json"), spotSettings, { mode: 0o600 });
      const module = pathToFileURL(path.join(root, "worker/src/perps-kill.ts")).href;
      const result = await isolatedControl(`import {stopLocalPerpsWallet} from ${JSON.stringify(module)};console.log(JSON.stringify(await stopLocalPerpsWallet()));`);
      assert.equal(result.grant, "revoked");
      await waitFor("running worker honours removed grant", () => rows("SELECT status FROM agents")[0]!.status === "killed");
      await stop();
      assert.equal(existsSync(path.join(home, "grant.json")), false);
      assert.equal(JSON.parse(readFileSync(path.join(home, "settings.json"), "utf8")).perpsEnabled, false);
      assert.equal(readFileSync(path.join(installHome, "settings.json"), "utf8"), spotSettings);
      const archive = path.join(home, "grants", `${account}.json`);
      assert.equal(statSync(archive).mode & 0o777, 0o600);
      const digest = (value: string) => createHash("sha256").update(value).digest("hex");
      assert.equal(digest(readFileSync(archive, "utf8")), digest(JSON.stringify(grant)), "archived permission is exact without printing its synthetic secret");
      const discover = pathToFileURL(path.join(root, "cli/recovery-wallets.mjs")).href;
      const recovered = await isolatedControl(`import {recoveryWallets} from ${JSON.stringify(discover)};const r=await recoveryWallets(process.env.MERRYMEN_HOME);console.log(JSON.stringify({unread:r.unread.length,wallets:r.wallets.map(w=>({purpose:w.purpose,account:w.g.smartAccount,active:w.active}))}));`);
      assert.deepEqual(recovered, { unread: 0, wallets: [{ purpose: "perps", account, active: false }] });
      const offset = output.length;
      launch();
      await waitFor("killed restart heartbeat", () => output.slice(offset).includes("[tick] mainnet block 12345"));
      await stop();
      assert.equal(output.slice(offset).includes("PAPER MODE"), false, "the archived session must not re-arm");
      assert.equal(JSON.stringify(rows("SELECT cash_usdg,vault_usdg,shares FROM paper_book")), before);
      assert.equal(rows("SELECT epoch FROM agents")[0]!.epoch, epoch);
    });
    assert.equal(rows("SELECT * FROM perp_fills").length, 0, "no fills across the entire process lifecycle");
    assert.equal(rows("SELECT * FROM trades").length, 0, "no trades across the entire process lifecycle");
    assert.equal(rows("SELECT * FROM perp_positions").length, 0);
    assert.ok(rpcMethods.includes("eth_getCode"), "real child must have reached its arm-time read path");
    assert.deepEqual(forbiddenRpc, [], "nothing attempted a signing or unexpected RPC method");
    t.diagnostic(`Real child ran; RPC read methods: ${[...new Set(rpcMethods)].sort().join(", ")}; entries/fills/trades remained off.`);
  } finally {
    clearInterval(feedTimer);
    const remaining = child as ChildProcess | null;
    if (remaining && remaining.exitCode === null && remaining.signalCode === null) { remaining.kill("SIGKILL"); await new Promise(resolve => remaining.once("exit", resolve)); }
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (process.env.MERRYMEN_TEST_KEEP_CHILD === "1") t.diagnostic(`Isolated drill evidence retained at ${scratch}`);
    else rmSync(scratch, { recursive: true, force: true });
  }
});
