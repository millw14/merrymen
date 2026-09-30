/** Read-only owner notifications from booked perps facts; no venue calls or signing. */
import type { DatabaseSync } from "node:sqlite";
import { parsePerpsReport, perpMarketById, type PerpsReport } from "../../../packages/core/src/perps";
import { esc } from "./api";

export interface PerpsNotifyState {
  agent: string;
  owner: number;
  cursor: { at: number; mode: string; trade: string; role: string };
  unreadSince: number | null;
  unreadLevel: number;
  incident: boolean;
  nearLiq: boolean;
  active: boolean;
}
export function parsePerpsNotifyState(raw: unknown): PerpsNotifyState | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as PerpsNotifyState, c = r.cursor;
  if (typeof r.agent !== "string" || !/^0x[0-9a-f]{40}$/i.test(r.agent) || !Number.isSafeInteger(r.owner) || !c || !Number.isSafeInteger(c.at) ||
    typeof c.mode !== "string" || typeof c.trade !== "string" || typeof c.role !== "string" ||
    !(r.unreadSince === null || Number.isSafeInteger(r.unreadSince)) || ![0, 1, 2].includes(r.unreadLevel) ||
    typeof r.incident !== "boolean" || typeof r.nearLiq !== "boolean" || typeof r.active !== "boolean") return null;
  return { agent: r.agent, owner: r.owner, cursor: { at: c.at, mode: c.mode, trade: c.trade, role: c.role },
    unreadSince: r.unreadSince, unreadLevel: r.unreadLevel, incident: r.incident, nearLiq: r.nearLiq, active: r.active };
}
const usd = (raw: string | bigint): string => {
  const n = BigInt(raw), abs = n < 0n ? -n : n;
  return `${n < 0n ? "−" : ""}${abs / 1_000_000n}.${((abs % 1_000_000n) / 10_000n).toString().padStart(2, "0")} USDG`;
};
interface Fill { created_at: number; mode: string; venue_trade_id: string; side_role: string; market_id: number; side: string; quote_micro: string; fee_micro: string; realized_micro: string | null; attribution: string; trade_type: string }
export function perpFillLine(f: Fill): string {
  const market = perpMarketById(f.market_id)?.key ?? `perpetual market ${f.market_id}`;
  const exit = (f.side === "long" && f.side_role === "ask") || (f.side === "short" && f.side_role === "bid");
  const kind = f.attribution === "venue-forced" || f.trade_type !== "trade" ? "Forced fill"
    : f.attribution === "venue-stop" ? "Venue stop / take-profit fill" : "Perpetual fill";
  return `${f.mode === "paper" ? "📜 Paper" : "🏹"} <b>${kind}</b> · ${esc(market)} · ${exit ? "reduced" : "added to"} ${esc(f.side)}\n` +
    `Notional ${usd(f.quote_micro)} · fee ${usd(f.fee_micro)}${f.realized_micro === null ? "" : ` · realized ${usd(f.realized_micro)}`}\n` +
    "This is the booked fill; /perps shows what remains.";
}
function reportOf(db: DatabaseSync | null, agent: string): PerpsReport | null {
  try {
    const row = db?.prepare("SELECT perps, mode FROM agents WHERE lower(smart_account) = ?").get(agent) as { perps: unknown; mode?: string } | undefined;
    const report = parsePerpsReport(typeof row?.perps === "string" ? JSON.parse(row.perps) : row?.perps);
    if (!report) return null;
    const book = report.mode === "paper" || report.mode === "live" ? report.mode
      : report.accountIndex !== null ? "live" : row?.mode === "paper" || row?.mode === "live" ? row.mode : null;
    return book ? { ...report, mode: book } : report;
  } catch { return null; }
}

/**
 * Stable composite cursor, not sqlite rowid (which changes on hosted restore).
 * Only completed seconds are scanned, so an insert later in this second cannot
 * sort behind an already-delivered tie. The cursor advances only after send.
 */
export async function notifyPerps(o: {
  db: DatabaseSync | null; agent: string; owner: number; nowSec: number;
  enabled: boolean; liqBufferPct: number;
  previous: PerpsNotifyState | null | undefined;
  save(next: PerpsNotifyState): void;
  send(line: string): Promise<boolean>;
}): Promise<void> {
  const agent = o.agent.toLowerCase();
  const previous = parsePerpsNotifyState(o.previous);
  const s: PerpsNotifyState = previous?.agent === agent && previous.owner === o.owner ? { ...previous, cursor: { ...previous.cursor } }
    : { agent, owner: o.owner, cursor: { at: o.nowSec - 1, mode: "~", trade: "~", role: "~" }, unreadSince: null, unreadLevel: 0, incident: false, nearLiq: false, active: false };
  const save = () => o.save({ ...s, cursor: { ...s.cursor } });
  const report = reportOf(o.db, agent);
  const exposed = !!report && (report.positions.length > 0 || report.stopsMissing > 0 || report.incident || report.mode === "live" || report.mode === "paper" ||
    (report.collateralMicro !== null && BigInt(report.collateralMicro) !== 0n) || (report.inTransitMicro !== null && BigInt(report.inTransitMicro) !== 0n));
  s.active = exposed || (report === null && (s.active || o.enabled));
  const fresh = report?.venueReadAt != null && report.venueReadAt <= o.nowSec * 1000 && o.nowSec * 1000 - report.venueReadAt < 120_000;
  if (s.active && !fresh) {
    if (s.unreadSince === null) s.unreadSince = report?.venueReadAt != null ? Math.min(o.nowSec, Math.floor(report.venueReadAt / 1000)) : o.nowSec;
    save();
    const elapsed = o.nowSec - s.unreadSince;
    const level = elapsed >= 600 ? 2 : elapsed >= 120 ? 1 : 0;
    if (level > s.unreadLevel && await o.send(`⚠️ ${report?.mode === "paper" ? "The paper perpetual book" : "Lighter"} has not been read successfully for ${level === 2 ? "10" : "2"} minutes. Positions and collateral are unknown, not zero. Check /perps and the dashboard; protective orders already resting may still execute.`)) s.unreadLevel = level;
  } else if (fresh || !s.active) { s.unreadSince = null; s.unreadLevel = 0; }
  if (report?.incident) {
    if (!s.incident && await o.send("⚠️ Unknown perpetual activity was recorded at Lighter. New entries are halted; protective exits continue. Review the incident and rotate the venue key in the dashboard before resuming.")) s.incident = true;
  } else if (report && fresh) s.incident = false;
  if (fresh && report && report.minLiqDistanceBps !== null) {
    const near = report.minLiqDistanceBps <= Math.max(0, o.liqBufferPct) * 100;
    if (near && !s.nearLiq && await o.send(`⚠️ ${report.mode === "paper" ? "Paper perpetual" : "Perpetual"} liquidation warning: the closest position is ${(report.minLiqDistanceBps / 100).toFixed(2)}% from liquidation at the last reading. A stop is not a guarantee. /perps for details; /flatten asks to close all.`)) s.nearLiq = true;
    else if (!near) s.nearLiq = false;
  } else if (fresh && report?.positions.length === 0) s.nearLiq = false;
  save();
  if (!o.db) return;
  let fills: Fill[];
  try {
    fills = o.db.prepare(`SELECT created_at, mode, venue_trade_id, side_role, market_id, side, quote_micro, fee_micro, realized_micro, attribution, trade_type
      FROM perp_fills WHERE agent_id = ? AND created_at < ?
        AND (created_at, mode, venue_trade_id, side_role) > (?, ?, ?, ?)
      ORDER BY created_at, mode, venue_trade_id, side_role LIMIT 20`)
      .all(agent, o.nowSec, s.cursor.at, s.cursor.mode, s.cursor.trade, s.cursor.role) as unknown as Fill[];
  } catch { return; }
  for (const fill of fills) {
    if (!await o.send(perpFillLine(fill))) return;
    s.cursor = { at: fill.created_at, mode: fill.mode, trade: fill.venue_trade_id, role: fill.side_role };
    save();
  }
}

export function perpFundingLine(db: DatabaseSync | null, agent: string | null, nowSec: number): string {
  if (!agent) return "Perpetual funding could not be read.";
  try {
    if (!db) throw new Error("unread");
    const rows = db.prepare("SELECT mode, payment_micro FROM perp_funding WHERE agent_id = ? AND funding_hour > ? AND funding_hour <= ?")
      .all(agent.toLowerCase(), nowSec - 86_400, nowSec) as { mode: string; payment_micro: string }[];
    let live = 0n, paper = 0n;
    for (const r of rows) { if (r.mode === "live") live += BigInt(r.payment_micro); else if (r.mode === "paper") paper += BigInt(r.payment_micro); }
    const report = reportOf(db, agent.toLowerCase());
    return `Booked perpetual funding (last 24h): real ${usd(live)} · paper ${usd(paper)}. Positive received; negative paid.` +
      (!report || report.venueReadAt === null || nowSec * 1000 - report.venueReadAt > 120_000 ? " Venue reads are incomplete; later bookings may change this." : "");
  } catch { return "Perpetual funding could not be read; it is not assumed to be zero."; }
}
