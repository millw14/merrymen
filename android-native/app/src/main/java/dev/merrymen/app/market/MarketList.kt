package dev.merrymen.app.market

import dev.merrymen.app.data.Loaded
import dev.merrymen.app.net.DiscoveryCoin
import dev.merrymen.app.net.Discoveries
import dev.merrymen.app.net.TokensPage
import java.util.Locale

/**
 * THE MARKETS LIST: every listed stock and ETF, and the launchpad coins the
 * index is carrying, as the web's `liveOf` joins them (web/src/terminal/live.ts).
 *
 * TWO READS, TWO CLOCKS. /api/market is the registry and the venue's prices,
 * read every 30 seconds; /api/discoveries is the launchpad sweep, read every
 * two minutes because the server's memo lives that long. Either can fail while
 * the other answers, and a failure of one must never read as the other's
 * rows being all there is — so each read's state travels with the list.
 */
data class MarketRow(
  /** The lowercased address — the key both reads agree on. */
  val id: String,
  /** As the read spelled it, for the token route. Null for a registry row with no address. */
  val address: String?,
  val symbol: String,
  val name: String?,
  /** A launchpad coin (from the index) rather than a registered stock or ETF. */
  val coin: Boolean,
  val priceUsd: Double?,
  /**
   * THE 24-HOUR CHANGE, ONLY WHEN A DAY WAS MEASURED. Null for every stock
   * (/api/market sends no change) and for a coin the index gave no figure, a
   * coin with no known age, or a pool younger than a day — see [coinChange24h].
   */
  val change24hPct: Double?,
  /** Younger than a day: the row says "new pool" where a 24h figure would go. */
  val newPool: Boolean,
  /** Only a halt the chain ASSERTED. Null (unread) is not a halt and not "trading". */
  val halted: Boolean,
  /** The registry's 24h volume; stocks only, null when it could not read one. */
  val volume24hUsd: Double?,
)

/**
 * A COIN'S 24-HOUR CHANGE, OR NULL WHEN THERE IS NO SUCH THING.
 *
 * The index reports `change24hPct` for a pool that is four hours old — the
 * captured sweep has FOOMS at +1,647% on an age of 0.18 days — and that figure
 * is a change since launch wearing a day's name. The doNotDo list names
 * exactly this: "a '24h' change on a 9-hour-old pool". So it is shown only
 * when the pool is known to be at least a day old. An unknown age is not
 * assumed to be old enough.
 */
fun coinChange24h(c: DiscoveryCoin): Double? {
  val chg = c.change24hPct?.takeIf { it.isFinite() } ?: return null
  val age = c.ageDays?.takeIf { it.isFinite() } ?: return null
  return if (age >= 1.0) chg else null
}

/** Younger than a day, as the index measured the pool's age. */
fun isNewPool(c: DiscoveryCoin): Boolean = c.ageDays?.let { it.isFinite() && it < 1.0 } == true

/**
 * The ticker the web derives for a pool row: the first word of the index's
 * pool name, "QUANTA / WETH" → "QUANTA" (live.ts `r.name.split(/[\s/]/)[0]`).
 */
fun coinSymbolOf(c: DiscoveryCoin): String {
  val name = c.name?.trim().orEmpty()
  val first = name.split(Regex("[\\s/]")).firstOrNull { it.isNotEmpty() } ?: name
  return first.uppercase(Locale.ROOT).ifEmpty { "TOKEN" }
}

/**
 * The two reads, joined — registry first, in its order, then the index's rows
 * in theirs (graduated first, then by move; the server sorts).
 *
 * A POOL NEVER TURNS A REGISTERED STOCK INTO A MEMECOIN. The index carries
 * pools for listed stocks too (META / USDG, SPY / WETH in the capture), and
 * live.ts refuses to let one replace the registry's row: the registry's name,
 * price and halt stand, and no launchpad figure is attached to a stock.
 */
fun marketRows(market: TokensPage?, disc: Discoveries?): List<MarketRow> {
  val rows = LinkedHashMap<String, MarketRow>()
  for (t in market?.tokens.orEmpty()) {
    val id = t.address?.lowercase(Locale.ROOT) ?: "symbol:" + t.symbol.uppercase(Locale.ROOT)
    rows[id] = MarketRow(
      id = id,
      address = t.address,
      symbol = t.symbol,
      name = t.name,
      coin = t.kind == "memecoin",
      priceUsd = t.priceUsd?.takeIf { it.isFinite() },
      change24hPct = null,
      newPool = false,
      halted = t.paused == true,
      volume24hUsd = t.volume24hUsd?.takeIf { it.isFinite() },
    )
  }
  for (c in disc?.rows.orEmpty()) {
    val address = c.token?.takeIf { it.isNotBlank() } ?: continue
    val id = address.lowercase(Locale.ROOT)
    val listed = rows[id]
    if (listed != null && !listed.coin) continue
    rows[id] = MarketRow(
      id = id,
      address = address,
      symbol = coinSymbolOf(c),
      name = c.name,
      coin = true,
      priceUsd = c.priceUsd?.takeIf { it.isFinite() },
      change24hPct = coinChange24h(c),
      newPool = isNewPool(c),
      halted = false,
      volume24hUsd = null,
    )
  }
  return rows.values.toList()
}

/**
 * WHAT THE LIST MUST SAY ABOUT ITSELF, so a short list is not read as a
 * small market. [marketStale] and [discStale] are a refresh that failed after
 * a good read: the rows on screen are the last ones read, and that is said.
 */
fun marketCaveats(
  market: Loaded<TokensPage>,
  disc: Loaded<Discoveries>,
  marketStale: Boolean = false,
  discStale: Boolean = false,
): List<String> {
  val out = ArrayList<String>(4)
  if (market is Loaded.Refused || market is Loaded.Unreachable) {
    out += "Couldn't read the listed stocks and ETFs just now — only the launchpad coins are shown. That's our read failing, not the list."
  } else if (marketStale) {
    out += "Couldn't refresh stock prices just now — these are from the last read."
  }
  when (disc) {
    is Loaded.Refused, is Loaded.Unreachable ->
      out += "Couldn't read the launchpad index just now, so no coins are listed. That's our read failing, not an empty launchpad."
    is Loaded.Value -> {
      val d = disc.value
      if (d.indexUnreachable) {
        out += "The index didn't answer, so no coins are listed. That's our read failing, not an empty launchpad."
      } else {
        if (d.truncated) out += "The coins below are a prefix of the market, not all of it — the index cut the sweep short."
        if (d.degraded) out += "This read of the launchpad was degraded — it will refresh."
      }
      if (discStale) out += "Couldn't refresh the launchpad just now — the coins are from the last read."
    }
    else -> Unit
  }
  return out
}
