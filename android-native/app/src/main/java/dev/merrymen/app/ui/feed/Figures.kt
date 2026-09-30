package dev.merrymen.app.ui.feed

import java.math.BigDecimal
import java.math.RoundingMode
import java.util.Locale
import kotlin.math.abs

/**
 * THE HOUSE NUMBER FORMATS, as `web/src/lib/format.ts` writes them, for the
 * feed, the board and the agent page.
 *
 * Pure Kotlin on purpose: every figure these three screens print goes through
 * here, and a JVM test can run it. The locale is pinned to US English because
 * the web's `displayLocale()` defaults to en-US and this app's words are
 * English; a figure in one convention beside prose in another is the thing the
 * web's own comment on `displayLocale` says it stopped.
 */

/** "we never got an answer" — the one glyph for an unread figure. */
const val DASH = "—"

/** U+2212, the house minus. A hyphen in a column of figures reads as a dash. */
const val MINUS = "−"

/**
 * `pctBps` (format.ts:329): basis points as a percent to one place, with the
 * house sign in front of an UNSIGNED body, so no string is ever signed twice.
 * Under half a tenth reads "0.0%" with no sign — a green "+0.0%" would claim a
 * gain the number does not show.
 */
fun pctBps(bps: Double?): String {
  if (bps == null || !bps.isFinite()) return DASH
  val points = bps / 100.0
  if (abs(points) < 0.05) return percentBody(0.0)
  return (if (points > 0) "+" else MINUS) + percentBody(abs(points))
}

/** An unsigned percent at one place, grouped the way `Intl` groups it ("1,234.5%"). */
private fun percentBody(points: Double): String =
  String.format(Locale.US, "%,.1f%%", BigDecimal(points).setScale(1, RoundingMode.HALF_UP).toDouble())

/**
 * `usd` (format.ts:130): "$1,234.56". A negative keeps the locale's own sign,
 * as `Intl` does; every caller that prints a signed figure passes the absolute
 * value and prefixes the house sign itself.
 */
fun usd(n: Double?): String {
  if (n == null || !n.isFinite()) return DASH
  val body = String.format(Locale.US, "%,.2f", BigDecimal(abs(n)).setScale(2, RoundingMode.HALF_UP).toDouble())
  return (if (n < 0 && body != "0.00") "-" else "") + "$" + body
}

/**
 * `compactUsd` (format.ts:119): "$3.5M", "$604.4K", "$912" — `Intl`'s compact
 * notation with at most one decimal and none forced. A figure that rounds up
 * into the next unit is printed in that unit ("$1M", never "$1000K").
 */
fun compactUsd(n: Double?): String {
  if (n == null || !n.isFinite()) return DASH
  val sign = if (n < 0) "-" else ""
  var v = abs(n)
  val units = listOf("", "K", "M", "B", "T")
  var u = 0
  while (u < units.lastIndex && v >= 1000.0) {
    v /= 1000.0
    u++
  }
  var r = BigDecimal(v).setScale(if (u == 0) 0 else 1, RoundingMode.HALF_UP)
  if (u < units.lastIndex && r >= BigDecimal(1000)) {
    u++
    r = BigDecimal(v / 1000.0).setScale(1, RoundingMode.HALF_UP)
  }
  val text = r.stripTrailingZeros().toPlainString()
  return "$sign$" + text + units[u]
}

/** `count` (format.ts:292): a grouped integer, "5,000". */
fun countText(n: Int?): String = if (n == null) DASH else String.format(Locale.US, "%,d", n)

/**
 * `elapsed` (clock.ts): "12s", "4m", "3h" under 48 hours, then "2d". BOTH
 * ARGUMENTS ARE MILLISECONDS, and the names say so because the unit was the
 * web's whole `20688d` bug. A future moment reads as 0s rather than as a
 * negative age.
 */
fun elapsedText(atMs: Long, nowMs: Long): String {
  val s = ((nowMs - atMs) / 1000).coerceAtLeast(0L)
  if (s < 60) return "${s}s"
  val m = s / 60
  if (m < 60) return "${m}m"
  val h = m / 60
  if (h < 48) return "${h}h"
  return "${h / 24}d"
}

/**
 * `timeAgo` (lib/time.ts), for "we last read 2m ago": "just now" under a
 * minute, then minutes, hours and days. Seconds in, like the web's.
 */
fun agoWords(epochSec: Long, nowSec: Long): String {
  val secs = nowSec - epochSec
  if (secs < 60) return "just now"
  val mins = secs / 60
  if (mins < 60) return "${mins}m ago"
  val hours = mins / 60
  if (hours < 24) return "${hours}h ago"
  return "${hours / 24}d ago"
}

/**
 * `holdWords` (lib/hold-time.ts): "45s", "3h 20m", "2d 4h". NULL IN, NULL OUT
 * — never "0s" for an average nobody measured.
 */
fun holdWords(sec: Double?): String? {
  if (sec == null || !sec.isFinite() || sec < 0) return null
  val s = Math.round(sec)
  if (s < 60) return "${s}s"
  val m = s / 60
  if (m < 60) return "${m}m"
  val h = m / 60
  if (h < 24) return if (m % 60 != 0L) "${h}h ${m % 60}m" else "${h}h"
  val d = h / 24
  return if (h % 24 != 0L) "${d}d ${h % 24}h" else "${d}d"
}

/** A figure the server sent, or null — never a coerced 0 from a missing one. */
internal fun Double?.readOrNull(): Double? = this?.takeIf { it.isFinite() }
