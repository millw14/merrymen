/**
 * The perps half of `merrymen status`, `doctor` and `kill` — invoked by
 * cli/bin.mjs via tsx, the way `recover` runs recover-cli.ts. Kept out of the
 * CLI because it needs the worker's TypeScript (the stand-down files, the
 * signer, core's parsers and custody text), which the zero-dependency CLI
 * cannot import.
 *
 * Contract with bin.mjs:
 *   argv:  standdown-request
 *          standdown-wait <nonce> <smartAccount> [timeoutMs]
 *          status <smartAccount>
 *          doctor
 *   env:   MERRYMEN_HOME (the same home the worker uses)
 *
 * Progress → stdout as `__PROGRESS__<text>` lines (streamed live).
 * One machine result line → stdout: `__RESULT__{json}`. Lines for the owner
 * travel INSIDE the result as { level, text } so bin.mjs prints them in its
 * own colours — the house style lives there, not here.
 *
 * NEVER A KEY. Nothing here loads the Lighter private key or prints one; the
 * stand-down request carries a reason, a time and a nonce.
 */

import { existsSync, readFileSync } from "node:fs";
import { createPublicClient, formatUnits, http } from "viem";
import { LIGHTER_ROUTE_V1, chainForId, validatePerpPubKey } from "../../packages/core/src/index";
import { homePaths, merrymenHome } from "./home";
import {
  grantPerpOf,
  killCustodyText,
  perpsReportLines,
  readLedgerPerpsReport,
  readOwnerRotations,
  type CliLine,
} from "./perps-local";
import { standdownLines } from "./perps/standdown";
import {
  STANDDOWN_CLI_WAIT_MS,
  isStanddownNonce,
  newStanddownNonce,
  waitForStanddownResult,
  writeStanddownRequest,
} from "./perps/standdown-files";
import { lighterChainReader, readRecoverVenue, type RecoverVenue } from "./recover";
import { resolveConfig } from "./settings";

const emit = (obj: unknown) => process.stdout.write(`__RESULT__${JSON.stringify(obj)}\n`);
/** Exact micro-USDG, never a rounded float: a doctor that rounds 0.004 to 0.00 has just said "nothing". */
const fmt = (micro: bigint) => `${formatUnits(micro, 6)} USDG`;
const progress = (s: string) => process.stdout.write(`__PROGRESS__${s.replace(/[\r\n]+/g, " ")}\n`);

function readGrant(): unknown {
  try {
    return JSON.parse(readFileSync(homePaths.grant(), "utf8").replace(/^﻿/, "")) as unknown;
  } catch {
    return null;
  }
}

/** Lighter's venue leg for `account`, read the way recover reads it. Never throws. */
async function readVenue(account: string, timeoutMs = 6_000): Promise<RecoverVenue> {
  const cfg = resolveConfig();
  const client = createPublicClient({ chain: chainForId(LIGHTER_ROUTE_V1.chainId), transport: http(cfg.rpcMainnet, { timeout: timeoutMs, retryCount: 0 }) });
  return readRecoverVenue({
    smartAccount: account as `0x${string}`,
    chainId: LIGHTER_ROUTE_V1.chainId,
    chainRead: lighterChainReader(client),
    agentPerpPubKey: grantPerpOf(readGrant())?.apiPublicKey ?? null,
    timeoutMs,
  }).catch((e): RecoverVenue => ({ kind: "unreadable", why: e instanceof Error ? e.message : String(e) }));
}

/**
 * `standdown-request` — docs/perps.md rule 13: "every kill path writes
 * standdown-request.json before archiving the grant". bin.mjs runs this
 * BEFORE it archives or deletes grant.json, and this reads grant.json to
 * decide, so a request can only ever be written while the grant still exists
 * — the worker still holds the key and knows the account when it reads it.
 */
function standdownRequest(): void {
  const home = merrymenHome();
  const grant = readGrant();
  const perp = grantPerpOf(grant);
  if (perp === null) {
    emit({ ok: false, error: existsSync(homePaths.grant()) ? "no-perps" : "no-grant" });
    return;
  }
  const nonce = newStanddownNonce();
  writeStanddownRequest(home, { reason: "kill", requestedAt: Date.now(), nonce });
  emit({ ok: true, nonce, smartAccount: (grant as { smartAccount?: string }).smartAccount ?? null });
}

/** `standdown-wait` — up to 120 s, progress as it comes, then the custody sentence built from the result. */
async function standdownWait(nonce: string | undefined, account: string | undefined, timeoutArg: string | undefined): Promise<void> {
  if (!isStanddownNonce(nonce)) {
    emit({ ok: false, error: "bad-nonce" });
    process.exitCode = 2;
    return;
  }
  const timeoutMs = timeoutArg && /^\d{1,7}$/.test(timeoutArg) ? Math.min(Number(timeoutArg), STANDDOWN_CLI_WAIT_MS) : STANDDOWN_CLI_WAIT_MS;
  let lastTick = 0;
  const result = await waitForStanddownResult(merrymenHome(), nonce, timeoutMs, (p) => {
    for (const line of p.lines) progress(line);
    // A heartbeat of our own every ~15 s, so a quiet worker does not look like a hung CLI.
    const tick = Math.floor(p.elapsedMs / 15_000);
    if (p.lines.length === 0 && tick > lastTick) {
      lastTick = tick;
      progress(`still waiting for the worker's stand-down… ${Math.round(p.elapsedMs / 1000)}s`);
    }
  });
  if (result === null) {
    emit({ ok: true, result: null, waitedMs: timeoutMs });
    return;
  }
  const venue = account && /^0x[0-9a-fA-F]{40}$/.test(account) ? await readVenue(account) : null;
  const lines = standdownLines(result);
  emit({
    ok: true,
    result: {
      outcome: result.outcome,
      closed: lines.closed,
      residual: lines.residual,
      failedSteps: result.failedSteps,
      ingested: result.ingested,
    },
    custody: killCustodyText(result, venue),
  });
}

/** `status <account>` — the worker's own report (agents.perps), read-only; no network. */
async function status(account: string | undefined): Promise<void> {
  if (!account || !/^0x[0-9a-fA-F]{40}$/.test(account)) {
    emit({ ok: false, error: "bad-account" });
    return;
  }
  const lines = perpsReportLines(await readLedgerPerpsReport(homePaths.db(), account));
  emit({ ok: true, lines });
}

/**
 * `doctor` — is this machine able to run live perps, and what does the venue
 * say? Each line is a separate fact; one failing does not hide the others.
 */
async function doctor(): Promise<void> {
  const out: CliLine[] = [];
  const home = merrymenHome();
  const grant = readGrant() as { smartAccount?: string } | null;
  const perp = grantPerpOf(grant);

  // 1. The signer: the pinned WASM and wasm_exec hashes, then the known-answer
  // test against live mainnet transactions. Offline, ~50 ms. A failure here
  // means live perps stay unarmed — paper never loads it.
  try {
    const { instantiateSigner, LIGHTER_SIGNER_ARTIFACT } = await import("./perps/signer");
    await instantiateSigner();
    out.push({ level: "ok", text: `Lighter signer ${LIGHTER_SIGNER_ARTIFACT.release}: both files match their pinned hashes and the known-answer test passes (offline)` });
  } catch (e) {
    const reason = (e as { reason?: string }).reason;
    out.push({
      level: "bad",
      text: `Lighter signer unusable${reason ? ` (${reason})` : ""}: ${e instanceof Error ? e.message.slice(0, 160) : String(e)} — live perps stay unarmed; paper is unaffected`,
    });
  }

  // 2. The venue answers at all (public, tiny).
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 6_000);
    const res = await fetch(`${LIGHTER_ROUTE_V1.apiBase}/api/v1/withdrawalDelay`, { signal: ctl.signal, redirect: "error" }).finally(() => clearTimeout(t));
    const body = (await res.json().catch(() => null)) as { seconds?: unknown } | null;
    const sec = typeof body?.seconds === "number" ? body.seconds : null;
    res.ok
      ? out.push({ level: "ok", text: `Lighter reachable${sec !== null ? ` (withdrawal delay about ${Math.max(1, Math.ceil(sec / 60))} min right now)` : ""}` })
      : out.push({ level: "bad", text: `Lighter answered HTTP ${res.status}${res.status === 429 || res.status === 405 ? " — rate-limited" : ""}` });
  } catch {
    out.push({ level: "bad", text: `Lighter unreachable (${LIGHTER_ROUTE_V1.apiBase})` });
  }

  if (!grant?.smartAccount || !/^0x[0-9a-fA-F]{40}$/.test(grant.smartAccount)) {
    out.push({ level: "dim", text: "perps: no grant, so no Lighter account to check" });
    emit({ ok: true, lines: out });
    return;
  }
  if (perp === null) {
    out.push({ level: "dim", text: "perps: this grant does not carry the perps permission (paper perps need none)" });
  } else {
    // 3. The private key for the sealed public key is on this machine (never read here).
    const { perpKeyFileFor } = await import("./perps/keystore");
    existsSync(perpKeyFileFor(home, perp.apiPublicKey))
      ? out.push({ level: "ok", text: "Lighter API key: the private key for the grant's sealed public key is on this machine (0600)" })
      : out.push({ level: "bad", text: "Lighter API key: no key file for the grant's sealed public key in perp-keys/ — live perps cannot sign" });
  }

  // 4. Account index, the key at index 16 against the sealed key, and a public read.
  const venue = await readVenue(grant.smartAccount);
  const rotations = readOwnerRotations(home);
  if (venue.kind === "none") {
    out.push({ level: "dim", text: "Lighter account: none yet (the first deposit creates it)" });
  } else if (venue.kind === "unreadable") {
    out.push({ level: "warn", text: `Lighter account: could not be read (${venue.why}) — unknown, not none` });
  } else if (venue.kind === "account") {
    out.push({ level: "ok", text: `Lighter account ${venue.accountIndex} (on chain: addressToAccountIndex)` });
    const k = venue.keySlot;
    const sealed = perp ? validatePerpPubKey(perp.apiPublicKey) : null;
    if (!k.read) {
      out.push({ level: "warn", text: `key at index ${LIGHTER_ROUTE_V1.apiKeyIndex}: could not be read (${k.why})` });
    } else if (k.value.state === "empty") {
      out.push({ level: "warn", text: `key at index ${LIGHTER_ROUTE_V1.apiKeyIndex}: none registered yet — the worker registers the sealed key once there is cross collateral` });
    } else if (sealed !== null && k.value.publicKey === sealed) {
      out.push({ level: "ok", text: `key at index ${LIGHTER_ROUTE_V1.apiKeyIndex}: the grant's sealed key is registered` });
    } else {
      const there = k.value.publicKey;
      const mine = rotations?.find((r) => r.ownerRotatedPubKey === there && r.smartAccount === grant.smartAccount!.toLowerCase());
      out.push(
        mine
          ? { level: "warn", text: `key at index ${LIGHTER_ROUTE_V1.apiKeyIndex}: the throwaway \`merrymen recover\` put there on ${new Date(mine.at).toISOString().slice(0, 10)} — the agent's key is revoked at the venue` }
          : {
              level: "bad",
              text: `key at index ${LIGHTER_ROUTE_V1.apiKeyIndex}: a DIFFERENT key (${there.slice(0, 10)}…) than ${perp ? "the grant's sealed one" : "any this machine recorded"} — if you did not rotate it with \`merrymen recover\`, treat the agent's key as compromised`,
            },
      );
    }
    if (rotations === null) out.push({ level: "warn", text: "perp-owner-rotations.json exists but cannot be read" });
    if (!venue.account.read) {
      out.push({ level: "warn", text: `Lighter exposure: ${venue.account.why} — unknown, not zero` });
    } else {
      const a = venue.account.value;
      out.push({
        level: "text",
        text: `Lighter exposure (public read): ${a.positions.length} open position(s), ${a.orders} order(s), ${fmt(a.collateralMicro)} cross collateral${a.isolatedMarginMicro > 0n ? `, ${fmt(a.isolatedMarginMicro)} isolated margin` : ""}`,
      });
    }
    if (venue.pendingMicro.read && venue.pendingMicro.value > 0n) {
      out.push({ level: "warn", text: `${fmt(venue.pendingMicro.value)} waiting on the Lighter contract to be claimed (\`merrymen recover\` can claim it)` });
    }
  }

  // 5. What the worker last reported.
  out.push(...perpsReportLines(await readLedgerPerpsReport(homePaths.db(), grant.smartAccount)));
  emit({ ok: true, lines: out });
}

async function main() {
  const [mode, a, b, c] = process.argv.slice(2);
  try {
    if (mode === "standdown-request") standdownRequest();
    else if (mode === "standdown-wait") await standdownWait(a, b, c);
    else if (mode === "status") await status(a);
    else if (mode === "doctor") await doctor();
    else {
      emit({ ok: false, error: "bad-mode" });
      process.exitCode = 2;
    }
  } catch (e) {
    emit({ ok: false, error: e instanceof Error ? e.message : String(e) });
    process.exitCode = 1;
  }
  // FLUSH, THEN LEAVE. The signer's Go runtime and viem's transports may keep
  // handles open; the result line is already written, and the empty write's
  // callback runs only once everything before it has left the pipe.
  await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
  process.exit(process.exitCode ?? 0);
}

void main();
