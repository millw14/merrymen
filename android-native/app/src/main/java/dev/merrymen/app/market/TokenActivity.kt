package dev.merrymen.app.market

import dev.merrymen.app.net.PoolEvidence
import dev.merrymen.app.net.TapeWindow

/**
 * THE TOKEN PAGE'S "MARKET ACTIVITY" — web/src/terminal/TokenActivity.tsx, as
 * decisions a JVM test can run.
 *
 * Public pool trades are not an agent's fills, and a sample is not a total:
 * nothing here adds the trades up into a volume or a flow. The only figures
 * are the index's own tape windows, each shown only as far as the index gave
 * it, and the trades themselves.
 */

/** The block explorer the web links a pool trade to (TokenActivity.tsx). */
const val EXPLORER_TX = "https://robinhoodchain.blockscout.com/tx/"

private val TX_HASH = Regex("^0x[0-9a-fA-F]{64}$")

/**
 * The explorer page for one transaction — or null for anything that is not a
 * 32-byte hash. The hash came from a third party's index through our server;
 * a URL is only ever built around a value of the one shape a hash has, so no
 * string the index returns can turn a tap into a trip somewhere else.
 */
fun explorerTxUrl(tx: String?): String? = tx?.takeIf { TX_HASH.matches(it) }?.let { EXPLORER_TX + it }

/** One public trade as the table draws it. */
data class PoolTradeRow(
  val id: String,
  val buy: Boolean,
  val usd: Double?,
  val priceUsd: Double?,
  /** Unix seconds. */
  val timeSec: Long,
  val txUrl: String?,
)

/** A sample older than this is an "older snapshot" (TokenActivity.tsx: 120000). */
const val TRADES_FRESH_MS = 120_000L

/** How many trades the table shows — the web's `slice(0, 12)`. */
const val TRADES_SHOWN = 12

/** What the trades part of the panel can say. */
sealed interface TradesView {
  /** Not read, not readable, or the read failed: "temporarily unavailable" — never "no trades". */
  data object Unavailable : TradesView

  /** The read answered with no trades in its sample. */
  data class NoneInSample(val observedAtMs: Long?, val older: Boolean) : TradesView

  data class Rows(val observedAtMs: Long?, val older: Boolean, val rows: List<PoolTradeRow>) : TradesView
}

/**
 * The trades part of the panel, from the document's evidence.
 *
 * A row that does not say which side it was, or when, is dropped rather than
 * guessed: a trade drawn as a buy that was a sell is worse than one not drawn.
 */
fun tradesView(e: PoolEvidence?, nowMs: Long): TradesView {
  val t = e?.trades ?: return TradesView.Unavailable
  if (t.failed) return TradesView.Unavailable
  val observed = t.observedAt?.takeIf { it > 0 }
  val older = observed == null || nowMs - observed > TRADES_FRESH_MS
  val rows = t.data.mapNotNull { p ->
    val side = p.side
    if (side != "buy" && side != "sell") return@mapNotNull null
    val time = p.time?.takeIf { it.isFinite() && it > 0 } ?: return@mapNotNull null
    PoolTradeRow(
      id = p.id ?: (p.tx + ":" + time),
      buy = side == "buy",
      usd = p.usd?.takeIf { it.isFinite() && it >= 0 },
      priceUsd = p.priceUsd?.takeIf { it.isFinite() && it >= 0 },
      timeSec = time.toLong(),
      txUrl = explorerTxUrl(p.tx),
    )
  }.sortedByDescending { it.timeSec }.take(TRADES_SHOWN)
  return if (rows.isEmpty()) TradesView.NoneInSample(observed, older) else TradesView.Rows(observed, older, rows)
}

/**
 * A tape window's label, qualified when the pool is younger than the window.
 *
 * The volume and counts the index gives for "24h" on a nine-hour-old pool are
 * true totals — nothing traded before it existed — but printed under "24h"
 * they read as a full day's rate. So the row says how old the pool is. An
 * unknown age adds nothing: it is not evidence of youth.
 */
fun tapeLabel(w: TapeWindow, ageDays: Double?): String =
  poolAgeNote(ageDays, w.seconds)?.let { "${w.label} · $it" } ?: w.label

/** "pool 9h old" when the pool is younger than [windowSec], else null (including an unknown age). */
fun poolAgeNote(ageDays: Double?, windowSec: Long): String? {
  val ageSec = ageDays?.takeIf { it.isFinite() && it >= 0 }?.let { (it * 86_400).toLong() } ?: return null
  return if (ageSec < windowSec) "pool ${ageWords(ageSec)} old" else null
}
