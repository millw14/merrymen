package dev.merrymen.app.net

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.doubleOrNull

/**
 * A COIN'S POOL EVIDENCE — the recent public trades behind its price.
 *
 * GET /api/tokens/{address}?activity=1 attaches `evidence` to a coin's
 * document (MerrymenApi.token's `activity`), in the shape
 * worker/src/venues/pool-evidence.ts writes: `{poolId, token, candles,
 * trades: {failed, failure?, observedAt?, data: [{id, tx, time, side, usd,
 * priceUsd}]}}`. Only the trades are read here; the 5-minute candles are the
 * worker's, and the chart has its own bars.
 *
 * `failed` DEFAULTS TO TRUE. The server always sends it; a trades object that
 * somehow arrives without it has not told us it read anything, and "no trades
 * were returned" about a read nobody confirmed is evidence of absence made out
 * of an absence of evidence — the exact line pool-evidence.ts draws.
 */
@Serializable
data class PoolTrade(
  val id: String? = null,
  val tx: String? = null,
  /** Unix SECONDS of the block. */
  val time: Double? = null,
  /** "buy" | "sell", from the token's side of the swap. */
  val side: String? = null,
  val usd: Double? = null,
  val priceUsd: Double? = null,
)

@Serializable
data class PoolTradesRead(
  val failed: Boolean = true,
  val failure: String? = null,
  /** Unix MILLISECONDS the sample was taken. Absent on a failure. */
  val observedAt: Long? = null,
  val data: List<PoolTrade> = emptyList(),
)

@Serializable
data class PoolEvidence(
  val poolId: String? = null,
  val token: String? = null,
  val trades: PoolTradesRead? = null,
)

/**
 * This file's own reader: the same settings as MerrymenApi.json (unknown keys
 * ignored, nulls never coerced into a default figure), so the evidence is read
 * by the rules every other answer is.
 */
private val evidenceJson = Json {
  ignoreUnknownKeys = true
  explicitNulls = false
  isLenient = true
  coerceInputValues = false
}

/**
 * The evidence on a token document, or null when there is none to read — not
 * sent (a stock, or `activity` not asked), JSON null (the server's own read
 * failed), or a shape this build cannot read. All three render the same way,
 * "temporarily unavailable", and none of them as "no trades".
 */
fun poolEvidenceOf(e: JsonElement?): PoolEvidence? {
  if (e == null || e is JsonNull || e !is JsonObject) return null
  return try {
    evidenceJson.decodeFromJsonElement(PoolEvidence.serializer(), e)
  } catch (x: IllegalArgumentException) {
    android.util.Log.w("MarketWire", "could not decode pool evidence: " + (x.message ?: "").substringBefore("JSON input").trim())
    null
  }
}

/**
 * ONE WINDOW OF A POOL'S TAPE, as the index reported it on the coin row
 * (DiscoveryCoin.buckets: `{m5, h1, h6, h24}` of `{changePct, volumeUsd,
 * buys, sells, buyers, sellers}`). Every figure is null when the index omitted
 * it — never zero, which would be a measurement of a quiet window.
 */
data class TapeWindow(
  val key: String,
  val label: String,
  val seconds: Long,
  val volumeUsd: Double?,
  val buys: Long?,
  val sells: Long?,
)

private val TAPE = listOf(
  Triple("m5", "5m", 300L),
  Triple("h1", "1h", 3_600L),
  Triple("h6", "6h", 21_600L),
  Triple("h24", "24h", 86_400L),
)

/** The four windows in order, each with whatever the index said about it. */
fun tapeWindows(buckets: JsonElement?): List<TapeWindow> {
  val o = buckets as? JsonObject
  return TAPE.map { (key, label, seconds) ->
    val b = o?.get(key) as? JsonObject
    TapeWindow(
      key = key,
      label = label,
      seconds = seconds,
      volumeUsd = b.num("volumeUsd"),
      buys = b.whole("buys"),
      sells = b.whole("sells"),
    )
  }
}

private fun JsonObject?.num(k: String): Double? =
  (this?.get(k) as? JsonPrimitive)?.takeIf { !it.isString }?.doubleOrNull?.takeIf { it.isFinite() }

private fun JsonObject?.whole(k: String): Long? =
  (this?.get(k) as? JsonPrimitive)?.takeIf { !it.isString }?.longOrNull?.takeIf { it >= 0 }
