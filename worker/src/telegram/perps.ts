/** Owner-DM Perps views and the paper-exit port. No signing or venue calls. */
import { parsePerpsReport, perpsBlockerText, type PerpKey, type PerpsReport } from "../../../packages/core/src/index";
import { esc } from "./api";

export type TelegramPerpsSnapshot =
  | { state: "absent" | "unread" }
  | { state: "ready"; account: `0x${string}`; report: PerpsReport | null; grantExpiresAt: number | null };

export interface TelegramPerpsPort {
  /** The login's Perps wallet only, never the Spot account or another tenant. */
  read(): Promise<TelegramPerpsSnapshot>;
  /** Durable owner-order queue; the worker rechecks account, expiry and paper admission. */
  exit(input: {
    action: "close" | "flatten";
    market?: PerpKey;
    expectedAccount: `0x${string}`;
    requestId: string;
    askedAtSec: number;
  }): Promise<string>;
}

export const PERPS_OWNER_ONLY = "Only my linked owner can read or close their practice perpetuals in a private DM. Nothing was sent.";
export const PERPS_UNREAD = "⚠️ Your practice perpetual book could not be read. Its positions are unknown, not zero. Check the Perps desk.";
export const PERPS_ABSENT = "No Perps wallet is set up for this login. Paper perpetuals have a separate wallet and book from Spot.";

export function perpMoney(raw: string | null): string {
  if (raw === null) return "not read";
  const value = BigInt(raw), abs = value < 0n ? -value : value;
  return `${value < 0n ? "−" : ""}${abs / 1_000_000n}.${((abs % 1_000_000n) / 10_000n).toString().padStart(2, "0")} simulated USDG`;
}

/** A worker report is evidence, not a fresh venue read or a promise of a fill. */
export function formatPerps(snapshot: TelegramPerpsSnapshot, nowSec = Math.floor(Date.now() / 1000), view: "full" | "pnl" = "full"): string {
  if (snapshot.state === "absent") return PERPS_ABSENT;
  if (snapshot.state !== "ready") return PERPS_UNREAD;
  const r = parsePerpsReport(snapshot.report);
  if (!r || r.mode === "live" || r.accountIndex !== null) return PERPS_UNREAD;
  const lines = ["<b>Perps · paper practice</b>", "Simulated money. Separate from Spot; nothing signed."];
  const unread = r.collateralMicro === null || r.venueReadAt === null;
  const stale = r.venueReadAt !== null && (r.venueReadAt > nowSec * 1000 || nowSec * 1000 - r.venueReadAt > 120_000);
  if (unread) lines.push("⚠️ The current practice book could not be read; positions and balances are unknown.");
  else if (stale) lines.push("⚠️ This is an older or unverified reading; positions may have changed.");
  if (snapshot.grantExpiresAt !== null && snapshot.grantExpiresAt <= nowSec) lines.push("⚠️ The Perps permission has expired. Renew it on the Perps desk; do not assume the protective loop is running.");
  if (r.blocker) {
    const why = perpsBlockerText(r.blocker);
    lines.push(esc(why.what + (why.remedy ? ` ${why.remedy}` : "")));
  }
  if (r.entriesHalted === true) lines.push("New practice entries are paused by Close all. Only a practice reset clears that halt.");
  const unlisted = Math.max(0, r.stopsMissing - r.positions.filter(p => p.stopTrigger === null).length);
  if (unlisted > 0) lines.push(`⚠️ ${unlisted} recorded position(s) could not be listed.`);
  if (!r.positions.length && !unread && !stale && unlisted === 0) lines.push("No open positions at that reading.");
  for (const p of r.positions) {
    lines.push(`• <b>${esc(p.market)}</b> ${p.side} · ${esc(p.baseAmount)}`);
    if (view === "full") lines.push(`  entry ${esc(p.entryPrice)} · mark ${esc(p.markPrice ?? "not read")} · stop ${esc(p.stopTrigger ?? "not seen")}`);
    lines.push(`  unrealized P&amp;L ${perpMoney(p.unrealizedMicro)} · funding ${perpMoney(p.fundingMicro)}`);
  }
  lines.push(`Paper collateral: ${perpMoney(r.collateralMicro)}`);
  if (r.stopsMissing > 0) lines.push(`⚠️ ${r.stopsMissing} practice position(s) have no stop seen resting.`);
  lines.push("/close BTC-PERP requests one practice exit. /flatten asks to close all practice positions and pause new entries. Neither opens a position.");
  return lines.join("\n");
}

export async function readPerpsText(port?: TelegramPerpsPort, nowSec?: number, view?: "full" | "pnl"): Promise<string> {
  if (!port) return PERPS_UNREAD;
  try { return formatPerps(await port.read(), nowSec, view); }
  catch { return PERPS_UNREAD; }
}

/** Bounded identity shared by bot seats and the durable parent queue. */
export function telegramPerpsRequestId(botId: string | null, updateId: number | undefined): string | null {
  if (!botId || !/^[1-9][0-9]*$/.test(botId) || !Number.isSafeInteger(updateId) || updateId! < 0) return null;
  const id = `tg-perps-${botId}-${updateId}`;
  return id.length <= 128 ? id : null;
}

export function usablePerpsAccount(snapshot: TelegramPerpsSnapshot, nowSec: number): snapshot is Extract<TelegramPerpsSnapshot, {state: "ready"}> {
  return snapshot.state === "ready" && /^0x[0-9a-f]{40}$/i.test(snapshot.account)
    && Number.isSafeInteger(snapshot.grantExpiresAt) && snapshot.grantExpiresAt! > nowSec;
}

export function validPerpsRequest(input: {requestId: string; askedAtSec: number}, nowSec: number): boolean {
  return /^tg-perps-[1-9][0-9]*-[0-9]+$/.test(input.requestId) && input.requestId.length <= 128
    && Number.isSafeInteger(input.askedAtSec) && input.askedAtSec > 0 && input.askedAtSec <= nowSec + 30 && nowSec - input.askedAtSec <= 90;
}

export async function requestPerpsExit(port: TelegramPerpsPort, input: Parameters<TelegramPerpsPort["exit"]>[0], nowSec: number): Promise<string> {
  if (!validPerpsRequest(input, nowSec)) {
    return "That practice exit has no current Telegram request to act on. Ask again in your private DM; nothing was sent.";
  }
  try { return await port.exit(input); }
  catch { return "The practice exit could not be confirmed. Check the Perps desk before asking again; it may already be queued."; }
}

export function perpsAttention(snapshot: TelegramPerpsSnapshot, nowSec: number): string[] {
  if (snapshot.state === "absent") return [];
  if (snapshot.state !== "ready") return ["The practice perpetual book could not be read. Positions are unknown, not zero. Check the Perps desk."];
  const lines: string[] = [];
  if (Number.isSafeInteger(snapshot.grantExpiresAt)) {
    if (snapshot.grantExpiresAt! <= nowSec) lines.push("The Perps permission has expired. Renew it on the Perps desk; do not assume the protective loop is running.");
    else if (snapshot.grantExpiresAt! - nowSec <= 86_400) lines.push("The Perps permission expires within 24 hours. Review renewal on the Perps desk.");
  }
  const r = parsePerpsReport(snapshot.report);
  if (!r || r.mode === "live" || r.accountIndex !== null || r.venueReadAt === null || r.collateralMicro === null) {
    return [...lines, "The practice perpetual book could not be read. Positions are unknown, not zero. Check the Perps desk."];
  }
  if (r.venueReadAt > nowSec * 1000 || nowSec * 1000 - r.venueReadAt > 120_000) lines.push("The practice book's latest reading is old or unverified. Its positions may have changed; check the Perps desk.");
  if (r.stopsMissing > 0) lines.push(`${r.stopsMissing} practice position(s) have no protective stop seen resting at the last reading. Check the Perps desk.`);
  if (r.blocker) { const b = perpsBlockerText(r.blocker); lines.push(b.what + (b.remedy ? ` ${b.remedy}` : "")); }
  if (r.entriesHalted) lines.push("Close all has halted new practice entries. Only a practice reset clears that halt.");
  return lines;
}
