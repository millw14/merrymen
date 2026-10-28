package dev.merrymen.app.ui

import dev.merrymen.app.net.BookPerformance
import dev.merrymen.app.ui.feed.usd
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

/** The same valuation/evidence rules as the web's agent-performance.ts. */
data class PublicPerformanceView(
  val book: String?,
  val bps: Double?,
  val state: String?,
  val estimated: Boolean,
  val value: String?,
  val pnl: String?,
  val note: String?,
)

fun valuationTime(at: Long?): String? = at?.takeIf { it >= 0 && it < 100_000_000_000L }?.let {
  DateTimeFormatter.ofPattern("d MMM yyyy, HH:mm").withZone(ZoneId.systemDefault()).format(Instant.ofEpochSecond(it))
}

fun publicPerformance(
  p: BookPerformance?, mode: String?, rankedBps: Double?, legacyPaperBps: Double?,
  notRunning: Boolean = false, nowSec: Long = System.currentTimeMillis() / 1000,
): PublicPerformanceView {
  fun finite(n: Double?) = n?.takeIf { it.isFinite() }
  val book = if (p == null) mode?.takeIf { it == "paper" || it == "live" } else p.book?.takeIf { it == "paper" || it == "live" }
  // A current server's explicit unknown never falls back to an old legacy return.
  val bps = if (p == null) finite(if (mode == "paper") legacyPaperBps else rankedBps)
    else if (p.underReview) null else finite(p.pnlBps)
  val counted = p?.fills != null && p.fills >= 0 && p.fillsAtMark != null && p.fillsAtMark in 0..p.fills
  val fills = p?.fills?.takeIf { counted }
  val atMark = p?.fillsAtMark?.takeIf { counted }
  val live = book == "live" || (book == null && mode == "live")
  val state = when {
    p?.underReview == true -> "Return under review"
    p == null || finite(rankedBps) != null || (bps != null && bps != 0.0) -> null
    fills == 0 && live && p.funded == true -> "Funded · no trades yet"
    fills == 0 && live && p.funded == false -> "No deposit yet"
    fills == 0 -> "No trades yet"
    fills != null && fills > 0 && atMark == 0 -> "Awaiting first valuation"
    else -> null
  }
  val estimated = p?.pnlEstimated == true && !p.underReview
  val notes = buildList {
    if (notRunning) add("Not running")
    val at = valuationTime(p?.equityAt)
    if (at != null && (notRunning || nowSec - p!!.equityAt!! > 20 * 60)) add("Last valued $at")
    if (p?.held == true) add("Latest value awaits reconciliation; return uses the last measured valuation.")
    if (p?.valuation == "awaiting" && state == null) add("A newer trade is awaiting valuation.")
    if (p?.gasComplete == false) add(if (estimated) "Approximate: some gas costs are not recorded yet." else "Some gas costs are not recorded yet.")
  }
  val equity = if (p?.publicBook == true) finite(p.equityUsdg) else null
  val pnl = if (p?.publicBook == true && !p.underReview && state == null) finite(p.pnlUsdg) else null
  return PublicPerformanceView(
    book, bps, state, estimated,
    if (p == null) null else if (!p.publicBook) "Private" else equity?.let { usd(it) } ?: "Unavailable",
    pnl?.let { (if (estimated) "≈ " else "") + (if (it > 0) "+" else if (it < 0) "−" else "") + usd(kotlin.math.abs(it)) },
    notes.takeIf { it.isNotEmpty() }?.joinToString(" · "),
  )
}
