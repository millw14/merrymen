/**
 * `merrymen preflight` — gather, then judge.
 *
 * The gathering lives here and the judging lives in preflight.ts, so the
 * decisions are testable without a chain. This half does the I/O: read the
 * settings and the grant, probe the bundler, read the account's two balances
 * from the chain the grant is actually on.
 */

import { readFileSync } from "node:fs";
import { homePaths } from "./home";
import { loadGrantFile } from "./grant";
import { grantHasDeadRateLimit } from "./session-account";
import { preflight, rank, verdict, type Check, type PreflightInput } from "./preflight";
import { resolveConfig } from "./settings";
import { CASH, WALL_POLICY_CONTRACTS, chainForId } from "../../packages/core/src/index";

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const OFF = "\x1b[0m";

function readSettings(): PreflightInput["settings"] {
  try {
    return JSON.parse(readFileSync(homePaths.settings(), "utf8").replace(/^﻿/, ""));
  } catch {
    return {};
  }
}

/** Minimal JSON-RPC — the same shape doctor uses, no dependency needed. */
async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message ?? "rpc error");
  return body.result;
}

/** ERC-20 balanceOf, hand-encoded — one selector needs no ABI machinery. */
async function usdgBalance(url: string, account: string): Promise<number | null> {
  try {
    const data = `0x70a08231${account.toLowerCase().replace(/^0x/, "").padStart(64, "0")}`;
    const r = await rpc(url, "eth_call", [{ to: CASH.USDG, data }, "latest"]);
    return Number(BigInt(r as string)) / 1e6;
  } catch {
    return null;
  }
}

async function ethBalance(url: string, account: string): Promise<bigint | null> {
  try {
    return BigInt((await rpc(url, "eth_getBalance", [account, "latest"])) as string);
  } catch {
    return null;
  }
}

/**
 * Which of the wall's own validator contracts are missing on this chain.
 *
 * `null` on ANY read failure, deliberately — a partial answer here would be
 * worse than none: reporting "RateLimitPolicy absent" because the RPC blinked
 * is the same false accusation delivery.ts refuses to make about a balance.
 * All-or-nothing, and the caller renders "couldn't check" rather than "fine".
 */
async function missingPolicyContracts(url: string): Promise<string[] | null> {
  try {
    const missing: string[] = [];
    for (const c of WALL_POLICY_CONTRACTS) {
      const code = (await rpc(url, "eth_getCode", [c.address, "latest"])) as string | null;
      if (typeof code !== "string") return null;
      if (code === "0x" || code === "") missing.push(`${c.name} (${c.address})`);
    }
    return missing;
  } catch {
    return null;
  }
}

/**
 * Does the smart account have code on this chain?
 *
 * `null` on any read failure, like the probe above — "we could not look" and
 * "it is not there" have different remedies, and for an account that is
 * counterfactual by design the second is not even a fault.
 */
async function hasCode(url: string, account: string): Promise<boolean | null> {
  try {
    const code = (await rpc(url, "eth_getCode", [account, "latest"])) as string | null;
    if (typeof code !== "string") return null;
    return code !== "0x" && code !== "";
  } catch {
    return null;
  }
}

/**
 * Does the bundler answer?
 *
 * doctor probes only when a full `bundlerUrl` was pasted, so the common path —
 * a Pimlico API key, where the URL is built for you — was never contacted. A key
 * that is present but wrong looked identical to one that works.
 */
async function bundlerAnswers(s: PreflightInput["settings"], chainId: number): Promise<boolean | null> {
  const url =
    s.bundlerUrl ||
    (s.bundlerApiKey
      ? `https://api.pimlico.io/v2/${chainId}/rpc?apikey=${encodeURIComponent(s.bundlerApiKey)}`
      : null);
  if (!url) return null;
  try {
    const eps = await rpc(url, "eth_supportedEntryPoints", []);
    return Array.isArray(eps) && eps.length > 0;
  } catch {
    return false;
  }
}

function render(check: Check): void {
  const mark =
    check.level === "ok" ? `${GREEN}✓${OFF}` : check.level === "warn" ? `${YELLOW}!${OFF}` : `${RED}✗${OFF}`;
  const title = check.level === "blocker" ? `${BOLD}${check.title}${OFF}` : check.title;
  console.log(`  ${mark} ${check.id.padEnd(14)} ${title}`);
  if (check.detail) {
    for (const line of wrap(check.detail, 72)) console.log(`    ${DIM}${line}${OFF}`);
  }
}

function wrap(text: string, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if (line.length + w.length + 1 > width) {
      lines.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(line);
  return lines;
}

async function main(): Promise<void> {
  console.log(`\n${BOLD}  ➳ preflight${OFF}  ${DIM}can this actually make a real trade?${OFF}\n`);

  const settings = readSettings();
  const grant = loadGrantFile();
  const chainId = grant?.chainId ?? 4663;
  const chain = chainForId(chainId);
  const rpcUrl =
    (chainId === 46630 ? settings.rpcTestnet : settings.rpcMainnet) ??
    chain.rpcUrls.default.http[0]!;

  const [usdg, ethWei, bundlerReachable, missingPolicy, accountDeployed] = await Promise.all([
    grant ? usdgBalance(rpcUrl, grant.smartAccount) : Promise.resolve(null),
    grant ? ethBalance(rpcUrl, grant.smartAccount) : Promise.resolve(null),
    bundlerAnswers(settings, chainId),
    missingPolicyContracts(rpcUrl),
    grant ? hasCode(rpcUrl, grant.smartAccount) : Promise.resolve(null),
  ]);

  // Resolved through the worker's OWN resolver rather than by re-reading the
  // settings file here: sponsorship comes from the file OR MERRYMEN_SPONSOR_GAS,
  // and `settings` above is the raw file only. resolveConfig already merges both
  // and already tolerates an absent or malformed file, so this borrows a rule
  // that is correct instead of spelling a third copy of it.
  const rcfg = resolveConfig();
  const sponsored = rcfg.sponsorGasEnabled && !!rcfg.bundlerApiKey;

  const checks = rank(
    preflight({
      settings,
      sponsored,
      grant,
      nowSec: Math.floor(Date.now() / 1000),
      usdg,
      ethWei,
      bundlerReachable,
      missingPolicyContracts: missingPolicy,
      // Asked of the SIGNATURE, not of the chain — the probe above reads the
      // addresses this code seals today and can never see what an older key
      // sealed. Absent a grant there is nothing to judge, and the no-grant
      // blocker above has already fired.
      deadPolicy: grant ? grantHasDeadRateLimit(grant.serialized) : false,
      accountDeployed,
    }),
  );
  for (const c of checks) render(c);

  const v = verdict(checks);
  console.log("");
  if (v.ready) {
    console.log(
      `  ${GREEN}${BOLD}READY${OFF}${v.warnings ? ` ${DIM}— with ${v.warnings} warning(s) above${OFF}` : ""}`,
    );
    // True and worth saying: everything above can be right and the agent can
    // still do nothing, because the feeds it prices from run 24/5.
    console.log(
      `  ${DIM}Stock feeds are 24/5 and go stale after 2h, so trading only happens during US`,
    );
    console.log(`  market hours — outside them the agent proposes nothing, and that is correct.${OFF}`);
  } else {
    console.log(`  ${RED}${BOLD}NOT READY${OFF} — ${v.blockers} blocker(s)`);
  }
  console.log("");
  process.exit(v.ready ? 0 : 1);
}

await main();
