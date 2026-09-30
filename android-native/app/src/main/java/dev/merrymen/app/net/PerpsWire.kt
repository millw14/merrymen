package dev.merrymen.app.net

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull

/**
 * THE AGENT'S PERPS REPORT, AS THE WORKER WROTE IT — core `PerpsReport`
 * (packages/core/src/perps.ts), carried on GET /api/grants as `perps`.
 *
 * The phone only ever READS it. Money is micro-USDG as a decimal integer
 * STRING, because a float loses cents at scale and a bigint does not survive
 * JSON; every nullable field means "not said", never zero.
 *
 * PARSED BY HAND, NOT BY THE SERIALIZER, and strictly: this is core's
 * whitelist parser (parsePerpsReport) rule for rule. The app's Json config
 * ignores unknown keys and is lenient, which is right for a feed and wrong
 * here — a wrong type ANYWHERE refuses the whole report, one malformed
 * position included, because dropping just that position would draw a book
 * with a leveraged position missing from it. A refused report is null, and
 * null is UNREAD, never empty (ui/PerpsStatus.kt).
 */
data class PerpsReport(
  /** The perps RAIL: off | paper | live | refuse. */
  val mode: String,
  val blocker: String?,
  /** Epoch MILLISECONDS of the venue (or paper book) read. */
  val venueReadAt: Long?,
  val protectAt: Long?,
  val accountIndex: Long?,
  val positions: List<PerpsReportPosition>,
  val openNotionalMicro: String?,
  val collateralMicro: String?,
  val inTransitMicro: String?,
  val minLiqDistanceBps: Double?,
  val stopsMissing: Int,
  val incident: Boolean,
)

/** One position. Prices are the venue's own decimal strings, kept exact. */
data class PerpsReportPosition(
  val market: String,
  val side: String,
  val baseAmount: String,
  val entryPrice: String,
  val markPrice: String?,
  val leverage: Double?,
  val marginMicro: String,
  val liqPrice: String?,
  val unrealizedMicro: String?,
  val stopTrigger: String?,
  val fundingMicro: String?,
)

/** core GRANT_PERP_LIGHTER: the grant's perps marker. */
const val GRANT_PERP_LIGHTER = "perp-lighter-v1"

/**
 * core PERP_BLOCKERS. A blocker this list lacks refuses the whole report —
 * the fail-closed side (unread, never none) — and PerpsStatusTest holds the
 * list against core so a new one is added here the day it is added there.
 */
val PERP_BLOCKERS: List<String> = listOf(
  "perps-off",
  "perps-live-off",
  "account-not-live",
  "perps-not-granted",
  "perps-cap-below-min",
  "perps-awaiting-deposit",
  "perps-key-pending",
  "perps-key-mismatch",
  "perps-venue-unreachable",
  "perps-no-collateral",
  "perps-grant-expiring",
  "perps-unknown-activity",
  "perps-entries-halted",
  "breaker-tripped",
)

private val REPORT_MODES = setOf("off", "paper", "live", "refuse")
private val INT_STRING = Regex("^-?\\d{1,40}$")
private val POS_DECIMAL = Regex("^\\d{1,30}(\\.\\d{1,30})?$")
private val NONZERO_DIGIT = Regex("[1-9]")
private val PERP_KEY_SHAPE = Regex("^[A-Z0-9]{1,24}-PERP$")
private const val MAX_SAFE_INTEGER = 9_007_199_254_740_991.0

/** A nullable field that was read: [value] null is "not said". */
private class Said<T>(val value: T?)

/**
 * A nullable field's verdict: absent or null is said-as-nothing; present and
 * of the right shape is its value; present and wrong is null, which refuses
 * the whole report.
 */
private fun <T> opt(v: JsonElement?, ok: (JsonElement) -> T?): Said<T>? {
  if (v == null || v is JsonNull) return Said(null)
  return ok(v)?.let { Said(it) }
}

private fun JsonElement.str(): String? = (this as? JsonPrimitive)?.takeIf { it.isString }?.content

/** A JSON NUMBER — a string of digits is not one, and neither is null. */
private fun JsonElement.num(): Double? =
  (this as? JsonPrimitive)?.takeIf { !it.isString && this !is JsonNull }?.doubleOrNull?.takeIf { it.isFinite() }

private fun JsonElement.flag(): Boolean? = (this as? JsonPrimitive)?.takeIf { !it.isString && this !is JsonNull }?.booleanOrNull

private fun safeInteger(v: JsonElement): Long? {
  val d = v.num() ?: return null
  return if (d == Math.floor(d) && kotlin.math.abs(d) <= MAX_SAFE_INTEGER) d.toLong() else null
}

private fun intString(v: JsonElement): String? = v.str()?.takeIf { INT_STRING.matches(it) }

private fun positiveDecimal(v: JsonElement): String? =
  v.str()?.takeIf { POS_DECIMAL.matches(it) && NONZERO_DIGIT.containsMatchIn(it) }

private fun position(raw: JsonElement): PerpsReportPosition? {
  val o = raw as? JsonObject ?: return null
  // Shape, not membership: a market this build does not list is still
  // exposure, and showing it beats hiding it behind "unread".
  val market = o["market"]?.str()?.takeIf { PERP_KEY_SHAPE.matches(it) } ?: return null
  val side = o["side"]?.str()?.takeIf { it == "long" || it == "short" } ?: return null
  val base = o["baseAmount"]?.let(::positiveDecimal) ?: return null
  val entry = o["entryPrice"]?.let(::positiveDecimal) ?: return null
  val margin = o["marginMicro"]?.let(::intString) ?: return null
  val mark = opt(o["markPrice"], ::positiveDecimal) ?: return null
  val leverage = opt(o["leverage"]) { it.num()?.takeIf { l -> l > 0 } } ?: return null
  val liq = opt(o["liqPrice"], ::positiveDecimal) ?: return null
  val unrealized = opt(o["unrealizedMicro"], ::intString) ?: return null
  val stop = opt(o["stopTrigger"], ::positiveDecimal) ?: return null
  val funding = opt(o["fundingMicro"], ::intString) ?: return null
  return PerpsReportPosition(
    market = market,
    side = side,
    baseAmount = base,
    entryPrice = entry,
    markPrice = mark.value,
    leverage = leverage.value,
    marginMicro = margin,
    liqPrice = liq.value,
    unrealizedMicro = unrealized.value,
    stopTrigger = stop.value,
    fundingMicro = funding.value,
  )
}

/** Strict whitelist parse of a report, or null (= unread). core parsePerpsReport. */
fun perpsReportOf(raw: JsonElement?): PerpsReport? {
  val o = raw as? JsonObject ?: return null
  if (o["v"]?.num() != 1.0) return null
  val mode = o["mode"]?.str()?.takeIf { it in REPORT_MODES } ?: return null
  val rawPositions = o["positions"] as? JsonArray ?: return null
  val stopsMissing = o["stopsMissing"]?.let(::safeInteger)?.takeIf { it >= 0 } ?: return null
  val incident = o["incident"]?.flag() ?: return null
  val blocker = opt(o["blocker"]) { it.str()?.takeIf { b -> b in PERP_BLOCKERS } } ?: return null
  val venueReadAt = opt(o["venueReadAt"]) { safeInteger(it)?.takeIf { t -> t >= 0 } } ?: return null
  val protectAt = opt(o["protectAt"]) { safeInteger(it)?.takeIf { t -> t >= 0 } } ?: return null
  val accountIndex = opt(o["accountIndex"]) { safeInteger(it)?.takeIf { i -> i > 0 } } ?: return null
  val openNotional = opt(o["openNotionalMicro"], ::intString) ?: return null
  val collateral = opt(o["collateralMicro"], ::intString) ?: return null
  val transit = opt(o["inTransitMicro"], ::intString) ?: return null
  val minLiq = opt(o["minLiqDistanceBps"]) { it.num() } ?: return null
  val positions = rawPositions.map { position(it) ?: return null }
  return PerpsReport(
    mode = mode,
    blocker = blocker.value,
    venueReadAt = venueReadAt.value,
    protectAt = protectAt.value,
    accountIndex = accountIndex.value,
    positions = positions,
    openNotionalMicro = openNotional.value,
    collateralMicro = collateral.value,
    inTransitMicro = transit.value,
    minLiqDistanceBps = minLiq.value,
    stopsMissing = stopsMissing.coerceAtMost(Int.MAX_VALUE.toLong()).toInt(),
    incident = incident,
  )
}
