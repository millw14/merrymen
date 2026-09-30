/**
 * THE SELF-HOSTED CLI'S PERPS HELPERS — what `merrymen status`, `doctor`,
 * `kill` and `recover` need from the worker's own modules.
 *
 * cli/bin.mjs carries no dependencies and cannot import TypeScript, so every
 * perps question it asks goes through `perps-cli.ts` (run with tsx, the way
 * `recover` runs recover-cli.ts), and the logic that question needs lives here,
 * importable and testable without spawning anything.
 *
 * NOTHING HERE HOLDS A KEY. The Lighter private key stays in
 * `$MERRYMEN_HOME/perp-keys/` for the worker to load; `doctor` asks only
 * whether the file for the sealed public key exists. The rotation journal
 * below records PUBLIC keys: the throwaway recover put at the key index
 * (whose private key nobody has) and the key it replaced.
 */

import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  LIGHTER_ROUTE_V1,
  custodySentence,
  grantPerp,
  parsePerpsReport,
  perpsBlockerText,
  validatePerpPubKey,
  type PerpExposure,
  type PerpsReport,
} from "../../packages/core/src/index";
import type { RecoverVenue } from "./recover";
import { standdownExposure, standdownStepLine, type StanddownResult } from "./perps/standdown";

// ── lines the CLI renders in its own colours ────────────────────────────────

/** One line for bin.mjs to print with its ok/warn/bad/dim helpers — the house style lives there. */
export interface CliLine {
  level: "ok" | "warn" | "bad" | "dim" | "text";
  text: string;
}

// ── the grant ───────────────────────────────────────────────────────────────

/**
 * The perp block this grant carries, or null. core's grantPerp: the marker,
 * chain 4663, the route's key index and a canonical key — anything less is
 * "no perps", never a partial grant.
 */
export function grantPerpOf(grant: unknown): ReturnType<typeof grantPerp> {
  if (!grant || typeof grant !== "object") return null;
  try {
    return grantPerp(grant as Parameters<typeof grantPerp>[0]);
  } catch {
    return null;
  }
}

// ── the owner-rotation journal ──────────────────────────────────────────────

/**
 * `$MERRYMEN_HOME/perp-owner-rotations.json` — every key change `merrymen
 * recover` made with the owner key.
 *
 * WHY IT EXISTS. After recover puts a throwaway key at the index, the worker
 * must never put the agent's old key back (wall-security.md,
 * owner-key-rotation-undone-by-session-key-or-worker), and must be able to
 * tell the owner's rotation from an attacker's. onboard.ts already takes
 * `ownerRotatedPubKeys` and `retiredPubKeys`, but perp_accounts has no
 * owner-rotated column and recover does not own the worker's ledger (it runs
 * while the worker may be writing it, or on a machine with no ledger at all).
 * So recover writes this journal; the worker does not read it yet — the lead
 * wires it into perp_accounts. Until then the worker sees the throwaway as a
 * FOREIGN key: it never re-registers over it (the safe direction) and raises
 * a venue incident. Verified owner acknowledgement and re-enablement are not
 * wired into the dashboard yet; re-signing alone cannot clear this state.
 *
 * Append-only — the one field ever rewritten is an entry's `seenAtVenue`,
 * filled in after the post-rotation poll (the entry itself is written the
 * moment the receipt lands) — whole-file atomic (temp + fsync + rename), 0600.
 * Public keys only.
 */
export const OWNER_ROTATIONS_FILE = "perp-owner-rotations.json";

export interface OwnerRotation {
  /** lowercase */
  smartAccount: string;
  accountIndex: number;
  apiKeyIndex: number;
  /** The throwaway now asked for at the index — nobody holds its private key. */
  ownerRotatedPubKey: `0x${string}`;
  /** The key it replaced (read just before signing); null when the slot read empty or unread. */
  retiredPubKey: `0x${string}` | null;
  /**
   * EVERY KEY THIS ROTATION RETIRED: the key read at the slot, AND the grant's
   * sealed key — whatever the slot read said. A rotation sent over a slot that
   * could not be read (recover rotates then, because unread may hold a key)
   * used to record `retiredPubKey: null` while the CLI knew the agent's sealed
   * key; a worker trusting this journal (onboard.ts: an owner-rotated key is
   * replaceable by a sealed key that is not retired) would then have put the
   * agent's old key back over the owner's revocation. Absent in a journal
   * written before the field: read as `[retiredPubKey]`.
   */
  retiredPubKeys?: `0x${string}`[];
  userOpHash: string;
  txHash: string;
  /** ms */
  at: number;
  /** The venue showed the throwaway at the index afterwards: true, false (not yet), null (not checked). */
  seenAtVenue: boolean | null;
}

export function ownerRotationsFile(home: string): string {
  return path.join(home, OWNER_ROTATIONS_FILE);
}

function isRotation(x: unknown): x is OwnerRotation {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.smartAccount === "string" &&
    /^0x[0-9a-f]{40}$/.test(r.smartAccount) &&
    typeof r.accountIndex === "number" &&
    Number.isSafeInteger(r.accountIndex) &&
    r.accountIndex > 0 &&
    r.apiKeyIndex === LIGHTER_ROUTE_V1.apiKeyIndex &&
    typeof r.ownerRotatedPubKey === "string" &&
    validatePerpPubKey(r.ownerRotatedPubKey) === r.ownerRotatedPubKey &&
    (r.retiredPubKey === null || (typeof r.retiredPubKey === "string" && validatePerpPubKey(r.retiredPubKey) === r.retiredPubKey)) &&
    (r.retiredPubKeys === undefined ||
      (Array.isArray(r.retiredPubKeys) &&
        r.retiredPubKeys.length <= 8 &&
        r.retiredPubKeys.every((k) => typeof k === "string" && validatePerpPubKey(k) === k))) &&
    typeof r.userOpHash === "string" &&
    typeof r.txHash === "string" &&
    typeof r.at === "number" &&
    Number.isFinite(r.at) &&
    (r.seenAtVenue === null || typeof r.seenAtVenue === "boolean")
  );
}

/**
 * Every recorded rotation, or null when the file exists and cannot be read in
 * full. A journal we cannot read is NOT an empty one: the key it would have
 * named might be exactly the one a caller is about to trust.
 */
export function readOwnerRotations(home: string): OwnerRotation[] | null {
  const file = ownerRotationsFile(home);
  if (!existsSync(file)) return [];
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return null;
    const body = raw as { v?: unknown; rotations?: unknown };
    if (body.v !== 1 || !Array.isArray(body.rotations) || !body.rotations.every(isRotation)) return null;
    return body.rotations as OwnerRotation[];
  } catch {
    return null;
  }
}

/** Every key a rotation retired (retiredPubKeys, or the one retiredPubKey of an older entry). */
export function retiredKeysOf(r: OwnerRotation): `0x${string}`[] {
  if (r.retiredPubKeys !== undefined) return [...r.retiredPubKeys];
  return r.retiredPubKey === null ? [] : [r.retiredPubKey];
}

/**
 * The keys a rotation retires: the one read at the slot and the grant's sealed
 * key, deduplicated, canonical only. The sealed key goes in WHATEVER the slot
 * read said — see OwnerRotation.retiredPubKeys.
 */
export function retiredKeysFor(replaced: string | null, sealed: string | null): `0x${string}`[] {
  const out: `0x${string}`[] = [];
  for (const k of [replaced, sealed]) {
    const v = k === null ? null : validatePerpPubKey(k);
    if (v !== null && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * Append one rotation. Throws when the entry is not one, or when the existing
 * journal cannot be read (rewriting it would drop what it holds). The caller
 * prints the rotation either way, so a failed write loses the file entry, not
 * the owner's knowledge of it.
 */
export function recordOwnerRotation(home: string, entry: OwnerRotation): void {
  const e: OwnerRotation = { ...entry, smartAccount: entry.smartAccount.toLowerCase() };
  if (!isRotation(e)) throw new TypeError("recordOwnerRotation: not a valid rotation entry");
  const existing = readOwnerRotations(home);
  if (existing === null) throw new Error(`${OWNER_ROTATIONS_FILE} exists but cannot be read; refusing to overwrite it`);
  writeRotations(home, [...existing, e]);
}

/**
 * Record what the venue showed after a rotation already in the journal (by its
 * UserOp hash): the entry is written as soon as the receipt lands — before the
 * poll, so a Ctrl-C during the poll cannot lose a rotation that happened —
 * and its `seenAtVenue` is filled in here. The only field ever rewritten.
 * Throws when the journal cannot be read or holds no such entry.
 */
export function markOwnerRotationSeen(home: string, userOpHash: string, seenAtVenue: boolean | null): void {
  const existing = readOwnerRotations(home);
  if (existing === null) throw new Error(`${OWNER_ROTATIONS_FILE} exists but cannot be read; refusing to overwrite it`);
  let found = false;
  const next = existing.map((r) => {
    if (r.userOpHash !== userOpHash) return r;
    found = true;
    return { ...r, seenAtVenue };
  });
  if (!found) throw new Error(`${OWNER_ROTATIONS_FILE} has no rotation ${userOpHash.slice(0, 12)}…`);
  writeRotations(home, next);
}

function writeRotations(home: string, rotations: OwnerRotation[]): void {
  const body = JSON.stringify({ v: 1, rotations }, null, 2);
  const final = ownerRotationsFile(home);
  const tmp = path.join(home, `.${OWNER_ROTATIONS_FILE}.${randomUUID()}.tmp`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeFileSync(fd, body, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tmp, final);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // already gone
    }
    throw err;
  }
}

// ── the worker's perps report, from the ledger ──────────────────────────────

export type LedgerReport =
  /**
   * `accountMode` is the account's own book (agents.mode — "paper" | "live" |
   * "idle"), or null when not read: the report's `mode` is the perps RAIL and
   * reads "off" while a practice position is still held (reportBook).
   */
  | { state: "read"; report: PerpsReport; accountMode?: string | null }
  /** No agents row for this account, or a NULL report: the worker has not said. */
  | { state: "absent" }
  /** Present and unreadable (bad JSON, bad shape, no ledger): unknown, never "no positions". */
  | { state: "unread"; why: string };

/**
 * `agents.perps` for this account, read-only. The web only READS this report
 * and so does the CLI: a report that does not parse is unread (null from
 * parsePerpsReport), and unread is never shown as zero.
 */
export async function readLedgerPerpsReport(dbFile: string, smartAccount: string): Promise<LedgerReport> {
  if (!existsSync(dbFile)) return { state: "unread", why: "no ledger yet" };
  type ReadOnlyDb = { prepare(sql: string): { get(...a: unknown[]): unknown }; close(): void };
  let db: ReadOnlyDb | null = null;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const open = new DatabaseSync(dbFile, { readOnly: true }) as unknown as ReadOnlyDb;
    db = open;
    let row: { perps?: unknown } | undefined;
    try {
      row = open.prepare("SELECT perps FROM agents WHERE lower(smart_account) = lower(?)").get(smartAccount) as { perps?: unknown } | undefined;
    } catch {
      // A ledger from before the column: the worker has never reported perps.
      return { state: "absent" };
    }
    if (!row || row.perps === null || row.perps === undefined) return { state: "absent" };
    if (typeof row.perps !== "string") return { state: "unread", why: "the report is not text" };
    let raw: unknown;
    try {
      raw = JSON.parse(row.perps);
    } catch {
      return { state: "unread", why: "the report is not JSON" };
    }
    const report = parsePerpsReport(raw);
    if (report === null) return { state: "unread", why: "the report does not parse" };
    // The account's own book, on its own query: a ledger without the column
    // costs only this answer (null, "not said"), never the report.
    let accountMode: string | null = null;
    try {
      const m = open.prepare("SELECT mode FROM agents WHERE lower(smart_account) = lower(?)").get(smartAccount) as { mode?: unknown } | undefined;
      accountMode = typeof m?.mode === "string" ? m.mode : null;
    } catch {
      accountMode = null;
    }
    return { state: "read", report, accountMode };
  } catch (e) {
    return { state: "unread", why: e instanceof Error ? e.message : String(e) };
  } finally {
    try {
      (db as ReadOnlyDb | null)?.close();
    } catch {
      // read-only; nothing to lose
    }
  }
}

/** Exact micro-USDG for the owner's eyes: never rounded, so 0.004 is not shown as 0.00. */
function microText(s: string | null): string | null {
  if (s === null) return null;
  const v = BigInt(s);
  const neg = v < 0n;
  const a = neg ? -v : v;
  const whole = a / 1_000_000n;
  const frac = (a % 1_000_000n).toString().padStart(6, "0").replace(/0{1,4}$/, "");
  return `${neg ? "−" : ""}${whole.toLocaleString("en-US")}.${frac} USDG`;
}

function ago(ms: number | null, now: number): string {
  if (ms === null) return "never";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
}

/**
 * WHICH BOOK A REPORT LISTS — the web's perpsBookOf (web/src/lib/perps-view.ts),
 * the same rule, because the CLI cannot import the web: the report's mode when
 * it is paper or live; an account index means a real venue account (the
 * paper book never has one); else the account's own book (agents.mode); else
 * null — not said, which is never printed as real money.
 */
export function reportBook(report: PerpsReport, accountMode: string | null | undefined): "paper" | "live" | null {
  if (report.mode === "paper") return "paper";
  if (report.mode === "live") return "live";
  if (report.accountIndex !== null) return "live";
  if (accountMode === "paper") return "paper";
  if (accountMode === "live") return "live";
  return null;
}

/**
 * The status lines for a report. PAPER IS ALWAYS LABELLED PAPER — a practice
 * position printed like a real one is how an owner believes they have money
 * at risk that they do not (or the reverse). And the book is the account's,
 * not the rail's: practice held while practice perps are off is still paper.
 *
 * UNKNOWN IS NEVER NONE (rule 11). The worker's own marker for "could not
 * read Lighter (or the practice book)" is `collateralMicro === null` (worker
 * perps/view.ts) — NOT a missing `venueReadAt`, which a failed read keeps
 * from the last good one. So an unread report never prints "no open
 * positions", counts what was last held as max(listed, stopsMissing) (an
 * unread read counts every held position as without a seen stop), and never
 * calls the last good read's age the current read.
 */
export function perpsReportLines(r: LedgerReport, now: number = Date.now()): CliLine[] {
  if (r.state === "absent") return [{ level: "dim", text: "perps: the worker has not reported Lighter's state yet — not the same as nothing there" }];
  if (r.state === "unread") return [{ level: "warn", text: `perps: the worker's report could not be read (${r.why}) — what is on Lighter is unknown, not zero` }];
  const p = r.report;
  const out: CliLine[] = [];
  const book = reportBook(p, r.accountMode);
  const paper = book === "paper";
  const unread = p.collateralMicro === null;
  const where = paper ? "the practice book" : "Lighter";
  const rail = p.mode === "off" ? " · perps off" : p.mode === "refuse" ? " · not opening" : "";
  const tag =
    book === "paper"
      ? `📜 paper (practice — no real money)${rail}`
      : book === "live"
        ? `live (real money on Lighter)${rail}`
        : p.mode === "off"
          ? "off · whether what it lists is practice or real money is not stated"
          : "refused · whether what it lists is practice or real money is not stated";
  const readText = unread
    ? `${where} could not be read at the last check${p.venueReadAt !== null ? ` (last good read ${ago(p.venueReadAt, now)})` : ""}`
    : `venue read ${ago(p.venueReadAt, now)}`;
  out.push({ level: p.mode === "refuse" || unread ? "warn" : "text", text: `perps: ${tag}${p.accountIndex !== null ? ` · Lighter account ${p.accountIndex}` : ""} · ${readText}` });
  if (p.blocker) {
    const b = perpsBlockerText(p.blocker);
    out.push({ level: "warn", text: `  ${b.what}${b.remedy ? ` ${b.remedy}` : ""}` });
  }
  if (p.incident) {
    out.push({ level: "bad", text: "  VENUE INCIDENT: Lighter shows activity this agent did not sign — opens are refused. Clear it on the dashboard; rotate the key with `merrymen recover` if it may be compromised." });
  }
  const noun = paper ? "paper position" : "position";
  if (unread) {
    const recorded = Math.max(p.positions.length, p.stopsMissing);
    out.push({
      level: "warn",
      text:
        `  positions: ${where} could not be read — unknown, not none` +
        (recorded > 0 ? ` (${recorded} ${noun}${recorded === 1 ? "" : "s"} held at the last record${p.positions.length < recorded ? `, ${p.positions.length} listed below` : ""})` : ""),
    });
  } else if (p.positions.length === 0) {
    // Only "no positions" when the report itself says so AND it was read.
    out.push({ level: "dim", text: `  no open ${noun}s` });
  }
  for (const pos of p.positions) {
    const bits = [
      `${pos.market} ${pos.side} ${pos.baseAmount} @ ${pos.entryPrice}`,
      pos.markPrice ? `mark ${pos.markPrice}` : "mark unread",
      pos.leverage !== null ? `${pos.leverage}x` : null,
      `margin ${microText(pos.marginMicro)}`,
      pos.liqPrice ? `liq ${pos.liqPrice}` : null,
      pos.stopTrigger ? `stop ${pos.stopTrigger}` : "NO STOP SEEN",
      pos.unrealizedMicro !== null ? `uPnL ${microText(pos.unrealizedMicro)}` : "uPnL unread",
    ].filter(Boolean);
    out.push({ level: pos.stopTrigger ? "text" : "warn", text: `  ${paper ? "📜 " : ""}${bits.join(" · ")}` });
  }
  const money: string[] = [];
  money.push(`collateral ${microText(p.collateralMicro) ?? "unread"}`);
  if (p.openNotionalMicro !== null) money.push(`open notional ${microText(p.openNotionalMicro)}`);
  if (p.inTransitMicro !== null && p.inTransitMicro !== "0") money.push(`in transit ${microText(p.inTransitMicro)}`);
  if (p.minLiqDistanceBps !== null) money.push(`closest liquidation ${(p.minLiqDistanceBps / 100).toFixed(1)}% away`);
  out.push({ level: "dim", text: `  ${paper ? "paper " : ""}${money.join(" · ")}` });
  if (p.stopsMissing > 0) {
    out.push({
      level: "warn",
      text: unread
        ? `  ${p.stopsMissing} position(s) with no stop SEEN — ${where} could not be read, so whether their stops rest is unknown`
        : `  ${p.stopsMissing} position(s) without a resting stop — the protective loop re-places them while the worker runs`,
    });
  }
  return out;
}

// ── kill: the custody text built from the stand-down's result ───────────────

/**
 * The PerpExposure a kill prints, from the worker's stand-down result and a
 * FRESH public read (recover's venue reader) for what the stand-down cannot
 * know: the claimable balance on the contract, other accounts under the
 * address, and the live withdrawal delay. What that read could not see is
 * said in `unread` lines rather than defaulted to zero — the exposure type
 * wants numbers, so an unread pending balance goes in as 0n AND a line.
 */
export function killExposure(result: StanddownResult, venue: RecoverVenue | null): { exposure: PerpExposure; unread: string[] } {
  const unread: string[] = [];
  let pendingWithdrawalsMicro = 0n;
  let otherAccounts: { count: number; valueMicro: bigint | null } | null = null;
  let withdrawalDelaySec: number | null = null;
  if (venue && venue.kind === "account") {
    if (venue.pendingMicro.read) pendingWithdrawalsMicro = venue.pendingMicro.value;
    else unread.push(`Whether USDG is waiting on the Lighter contract could not be read (${venue.pendingMicro.why}).`);
    if (venue.otherAccounts.read && venue.otherAccounts.value.complete) {
      otherAccounts = { count: venue.otherAccounts.value.accounts.filter((a) => a.holds !== false).length, valueMicro: null };
    }
    if (venue.withdrawalDelaySec.read) withdrawalDelaySec = venue.withdrawalDelaySec.value;
  } else {
    unread.push(
      venue && venue.kind === "unreadable"
        ? `After the stand-down, ${venue.why}, so what waits on the Lighter contract to be claimed is unknown.`
        : "Lighter's contract was not read after the stand-down, so what waits on it to be claimed is unknown.",
    );
  }
  return {
    exposure: standdownExposure(result, { pendingWithdrawalsMicro, depositsInTransitMicro: 0n, otherAccounts, withdrawalDelaySec }),
    unread,
  };
}

/** The kill's custody message: custodySentence (rule 13) plus what could not be read, never softened. */
export function killCustodyText(result: StanddownResult, venue: RecoverVenue | null): string {
  const { exposure, unread } = killExposure(result, venue);
  return [custodySentence(exposure), ...unread].join(" ");
}

export { standdownStepLine };
