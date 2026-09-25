package dev.merrymen.app.market

import dev.merrymen.app.data.Loaded
import dev.merrymen.app.data.toLoaded
import dev.merrymen.app.net.CandleRead
import dev.merrymen.app.net.MerrymenApi
import dev.merrymen.app.net.PoolEvidence
import dev.merrymen.app.net.TokenDetail
import dev.merrymen.app.net.poolEvidenceOf
import dev.merrymen.app.ui.Bar
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** Where the pool evidence stands for this token. */
sealed interface ActivityRead {
  /** The first read of the token has not answered yet. */
  data object Unasked : ActivityRead

  /** It answered; the evidence it carried, or null when there was none to read. */
  data class Read(val evidence: PoolEvidence?) : ActivityRead
}

/** What one visit to a token page has read: the span shown, the document, its bars and the pool's trades. */
data class TokenView(
  val window: String = "1D",
  val detail: Loaded<TokenDetail> = Loaded.Loading,
  val bars: Loaded<List<Bar>> = Loaded.Loading,
  val activity: ActivityRead = ActivityRead.Unasked,
)

/**
 * The route's bar size for a span, from CHART_WINDOWS in web/src/lib/venue.ts.
 *
 * A SPAN IS NOT A BAR SIZE. "1H" means one hour of history; the coin route's
 * `window` means how wide each bar is, and it accepts exactly four values —
 * anything else silently becomes hourly. So the span picks a bar size, and the
 * span is then applied by TRIMMING the series, never by padding.
 */
internal fun barSizeFor(window: String): String = when (window) {
  "1H", "4H" -> "15m"
  "1M", "ALL" -> "1d"
  else -> "1h"
}

/**
 * A coin's bars, off the token document, trimmed to the span (SPAN_SECONDS;
 * ALL trims nothing). Incomplete bars are dropped by completeBars.
 *
 * `uiMultiplier` is deliberately NOT applied here: it is a stock-contract
 * concept (a corporate action rebasing the on-chain unit), and a curve coin has
 * no such field. Multiplying a coin's bars by a number that does not exist for
 * it is how a chart quietly moves by 1e18.
 */
internal fun coinBars(candles: CandleRead?, window: String): List<Bar> =
  trimToSpan(completeBars(candles), SPAN_SECONDS[window])

/**
 * ONE VISIT TO A TOKEN PAGE, AND WHAT IT HAS READ — kept by the page's own
 * back-stack entry, so a rotation keeps it.
 *
 * The reads used to live in the screen's composition, and a rotation
 * recreates that: every turn of the phone read the token again, and because
 * the pool's trades are asked for on a visit's first read (?activity=1), it
 * asked for them again too — two ?activity=1 calls in one visit, and the span
 * the reader had picked back at 1D. Here a read is asked for only when this
 * visit has not already asked for that span, and it runs on the visit's own
 * scope, so a rotation mid-read neither cancels it nor sends it twice.
 *
 * THE POOL EVIDENCE IS ASKED FOR ONCE PER VISIT, on the first read that
 * answers, the way the web's token-page read does (?activity=1, keyed on the
 * token alone). A span change re-reads the bars, not the pool's trades, and a
 * new visit (the page opened again) asks again.
 */
class TokenVisit(
  private val api: MerrymenApi,
  private val address: String,
  private val scope: CoroutineScope,
) {
  private val _view = MutableStateFlow(TokenView())
  val view: StateFlow<TokenView> = _view.asStateFlow()

  /** Bumped by Try again: a failed read is read again whole, bars included. */
  private var attempt = 0

  /** The span and attempt of the read on screen or on its way; null before the first. */
  private var asked: Pair<String, Int>? = null
  private var reading: Job? = null

  /** The page is on screen: read it, unless this visit already has. A recreated page calls it again and asks nothing. */
  fun open() {
    if (asked == null) read(_view.value.window)
  }

  /** The reader picked a span. The same span asks nothing. */
  fun show(window: String) {
    if (asked != window to attempt) read(window)
  }

  /** Try again: the whole read, again — the pool's trades too while they have never answered. */
  fun retry() {
    attempt++
    read(_view.value.window)
  }

  private fun read(window: String) {
    reading?.cancel()
    asked = window to attempt
    _view.update { it.copy(window = window, bars = Loaded.Loading) }
    reading = scope.launch {
      val ask = _view.value.activity is ActivityRead.Unasked
      val d = api.token(address, barSizeFor(window), activity = ask).toLoaded()
      val t = (d as? Loaded.Value)?.value
      // Only an answered read settles the evidence: a failed one asks again
      // next time. The route attaches evidence to a coin only, so asking costs
      // a stock nothing.
      _view.update {
        it.copy(detail = d, activity = if (ask && t != null) ActivityRead.Read(poolEvidenceOf(t.evidence)) else it.activity)
      }
      val bars = when {
        t == null -> Loaded.Loading
        t.market.kind == "memecoin" -> Loaded.Value(coinBars(t.candles, window))
        else -> {
          // The registry's ticker, not the ledger's: the ledger only knows a
          // symbol for a token some agent already holds, so a stock nobody has
          // bought had no symbol to ask the venue about.
          val sym = t.market.symbol ?: t.market.stock?.symbol ?: t.ledger.symbol
          if (sym == null) Loaded.Value(emptyList())
          else api.stockBarsRead(sym, window, t.market.stock?.uiMultiplier ?: 1.0)
        }
      }
      _view.update { it.copy(bars = bars) }
    }
  }
}
