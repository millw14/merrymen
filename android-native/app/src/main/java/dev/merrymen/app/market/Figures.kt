package dev.merrymen.app.market

import java.math.BigDecimal
import java.math.MathContext
import java.math.RoundingMode
import java.util.Locale
import kotlin.math.abs

/**
 * THE WEB'S NUMBER FORMATS, for the market screens this package serves.
 *
 * Token.kt and AlphaScreen.kt each carry a private copy of some of these,
 * written before this package existed. They are named `fmt…` here so that an
 * import of one never shadows a screen's own private `coinPrice` — an explicit
 * import outranks a declaration in the importing file's package, and two
 * functions of one name that disagree by a digit is how a price prints two
 * ways on one screen.
 *
 * EVERY ONE OF THEM ANSWERS "—" FOR A NULL, and never "$0.00". The dash is the
 * app's word for "we never got an answer"; a zero is a measurement.
 */

/** The em dash, the one glyph this app keeps for its own ignorance. */
const val DASH = "—"

/**
 * `coinPrice` — web/src/terminal/live.ts. Three significant figures below a
 * cent (0.0000028 is "$0.00000280", never "$0.00"), four places below a dollar,
 * two above, grouped from $100.
 */
fun fmtPrice(n: Double?): String {
  if (n == null || !n.isFinite()) return DASH
  if (n == 0.0) return "$0.00"
  val a = abs(n)
  val sign = if (n < 0) "-" else ""
  if (a < 0.01) {
    // BigDecimal(Double), not valueOf: the exact binary value is what the
    // browser rounds from. Plain string, never exponent notation — Intl's
    // currency format does not switch to "2.80e-7", and neither does this.
    return sign + "$" + BigDecimal(a).round(MathContext(3, RoundingMode.HALF_UP)).toPlainString()
  }
  if (a >= 100) return sign + "$" + String.format(Locale.US, "%,.2f", a)
  return sign + "$" + String.format(Locale.US, if (a >= 1) "%.2f" else "%.4f", a)
}

/** `usd` — two places, grouped. For an amount of dollars rather than a price. */
fun fmtMoney(n: Double?): String {
  if (n == null || !n.isFinite()) return DASH
  return (if (n < 0) "-" else "") + "$" + String.format(Locale.US, "%,.2f", abs(n))
}

/**
 * `compactUsd` — web/src/lib/format.ts: Intl's en-US compact currency with at
 * most one decimal and no trailing ".0" ("$84K", "$1.2M", "$912").
 */
fun fmtCompactUsd(n: Double?): String {
  if (n == null || !n.isFinite()) return DASH
  val a = abs(n)
  val sign = if (n < 0) "-" else ""
  val units = listOf("", "K", "M", "B", "T")
  var step = 0
  var v = a
  while (v >= 1000.0 && step < units.lastIndex) {
    v /= 1000.0
    step++
  }
  var r = roundOne(v)
  // Rounding can carry into the next unit — 999,960 is "$1M", never "$1000K",
  // which is what the browser prints too.
  if (r >= 1000.0 && step < units.lastIndex) {
    r = roundOne(r / 1000.0)
    step++
  }
  return sign + "$" + oneDecimal(r) + units[step]
}

private fun roundOne(v: Double): Double = BigDecimal(v).setScale(1, RoundingMode.HALF_EVEN).toDouble()

private fun oneDecimal(v: Double): String {
  val s = String.format(Locale.US, "%.1f", v)
  return if (s.endsWith(".0")) s.dropLast(2) else s
}

/** `pctPts` — a change in percent, signed, two places (none past ±100%). */
fun fmtPctPts(n: Double?): String {
  if (n == null || !n.isFinite()) return DASH
  val places = if (n >= 100 || n <= -100) 0 else 2
  val body = String.format(Locale.US, "%.${places}f", abs(n))
  return (if (n > 0) "+" else if (n < 0) "-" else "") + body + "%"
}

/** `count` — a whole number, grouped. */
fun fmtCount(n: Long?): String = if (n == null) DASH else String.format(Locale.US, "%,d", n)

/**
 * HOW LONG AGO, in the fewest words that stay true: "35m", "9h", "3d".
 *
 * Whole units, rounded DOWN. "since first trade 9h ago" about a pool that is
 * nine hours and fifty minutes old is true; rounding up to 10h would date a
 * trade before it happened.
 */
fun ageWords(seconds: Long): String {
  val s = seconds.coerceAtLeast(0)
  return when {
    s < 60 -> "${s}s"
    s < 3_600 -> "${s / 60}m"
    s < 48 * 3_600 -> "${s / 3_600}h"
    else -> "${s / 86_400}d"
  }
}
