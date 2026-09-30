import { parsePerpsReport, perpsBlockerText, type PerpsReport } from "../../../packages/core/src/index";
import { esc } from "./api";

const money = (raw: string | null): string => {
  if (raw === null) return "not read";
  const v = BigInt(raw), magnitude = v < 0n ? -v : v;
  return `${v < 0n ? "−" : ""}${magnitude / 1_000_000n}.${((magnitude % 1_000_000n) / 10_000n).toString().padStart(2, "0")} USDG`;
};

/** Fresh worker report only. Missing/unread/stale venue values are never zeros. */
export function formatPerps(raw: PerpsReport | null, nowMs = Date.now()): string {
  const r = parsePerpsReport(raw);
  if (!r) return "⚠️ Perpetuals could not be read. Lighter may still hold leveraged positions; check the dashboard.";
  const paper = r.mode === "paper";
  const lines = [`<b>Perpetuals · ${paper ? "paper practice" : "Lighter"}</b>`];
  if (r.blocker) {
    const why = perpsBlockerText(r.blocker);
    const remedy = r.blocker === "perps-entries-halted" && r.entriesHalted === false ? null : why.remedy;
    lines.push(esc(why.what + (remedy ? ` ${remedy}` : "")));
  }
  if (r.incident) lines.push("⚠️ Unknown venue activity: entries remain halted until the incident is resolved with key rotation.");
  // A failed read retains the previous read's timestamp. The figures say
  // whether this read succeeded; a timestamp alone cannot establish a flat book.
  const unread = r.collateralMicro === null || r.venueReadAt === null;
  if (unread) lines.push(`⚠️ ${paper ? "Practice book" : "Lighter"} could not be read — the current book is unknown.`);
  if (r.venueReadAt !== null && nowMs - r.venueReadAt > 15 * 60_000) lines.push("⚠️ This is an older reading; positions may have changed.");
  // The worker counts unrenderable holdings as stops missing, including
  // foreign markets or ledger rows whose market precision could not be read.
  const unlisted = Math.max(0, r.stopsMissing - r.positions.filter(p => p.stopTrigger === null).length);
  if (unlisted > 0) lines.push(`⚠️ ${unlisted} recorded position(s) could not be listed.`);
  if (!r.positions.length && !unread && unlisted === 0) lines.push("No open positions at that reading.");
  for (const p of r.positions) {
    lines.push(`• <b>${esc(p.market)}</b> ${p.side} · ${esc(p.baseAmount)} · ${p.leverage === null ? "leverage not read" : `${p.leverage}x`}`);
    lines.push(`  entry ${esc(p.entryPrice)} · mark ${esc(p.markPrice ?? "not read")} · margin ${money(p.marginMicro)}`);
    lines.push(`  liquidation ${esc(p.liqPrice ?? "not read")} · stop ${esc(p.stopTrigger ?? "not seen")} · P&amp;L ${money(p.unrealizedMicro)} · funding ${money(p.fundingMicro)}`);
  }
  lines.push(`${paper ? "Paper collateral" : "Collateral at Lighter"}: ${money(r.collateralMicro)} · in transit ${money(r.inTransitMicro)}`);
  if (r.stopsMissing > 0) lines.push(`⚠️ ${r.stopsMissing} position(s) have no stop seen resting.`);
  lines.push("/close MKT-PERP closes one position. /flatten asks to close all and halt new entries. Neither opens a position.");
  return lines.join("\n");
}

export async function readPerpsText(read?: () => Promise<PerpsReport | null>): Promise<string> {
  try { return formatPerps(read ? await read() : null); }
  catch { return formatPerps(null); }
}
