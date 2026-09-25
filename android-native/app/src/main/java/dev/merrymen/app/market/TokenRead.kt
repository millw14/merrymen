package dev.merrymen.app.market

import dev.merrymen.app.net.CandleRead
import dev.merrymen.app.ui.Bar
import dev.merrymen.app.ui.barInterval

/**
 * WHAT THE TOKEN CHART MAY SAY ABOUT THE BARS IT DRAWS.
 *
 * Two lies this file exists to stop, both measured against the live route.
 *
 * A STALE SERIES DRAWN AS LIVE. read-candles.ts keeps the last good bars when
 * the index refuses, and serves them with `state: "ok"` and `stale: true`,
 * saying the caption must say so ("serving an old series silently would trade
 * an honest blank for a quiet lie about the price"). The screen ignored
 * `stale` and captioned the newest of those bars as "still forming".
 *
 * A SPAN LABEL OVER A SERIES THAT DOES NOT COVER IT. The change under the
 * price is worked out from the first drawn bar and was labelled with the span
 * the reader picked — so a pool nine hours old showed "+340% 1D", a day's
 * change that nobody measured. The web still prints the span unconditionally
 * (Token.tsx `{pctPts(winPct)} {span}`); this is the doNotDo rule "a '24h'
 * change on a 9-hour-old pool", applied here first.
 */

/** How much history each span claims. ALL claims none, so it is not here. */
val SPAN_SECONDS: Map<String, Long> = mapOf(
  "1H" to 3_600L,
  "4H" to 14_400L,
  "1D" to 86_400L,
  "5D" to 432_000L,
  "1M" to 2_592_000L,
)

/**
 * A pool's bars, off the token document: complete bars only, oldest first.
 *
 * An INCOMPLETE BAR IS DROPPED, the same rule the venue's nulls get: a gap is
 * drawn as a gap, never as a bar to zero.
 */
fun completeBars(candles: CandleRead?): List<Bar> =
  candles?.candles.orEmpty().mapNotNull { k ->
    val t = k.t ?: return@mapNotNull null
    val o = k.o ?: return@mapNotNull null
    val h = k.h ?: return@mapNotNull null
    val l = k.l ?: return@mapNotNull null
    val c = k.c ?: return@mapNotNull null
    Bar(t, o, h, l, c)
  }.sortedBy { it.time }

/** The last [seconds] of [bars], measured back from the newest. Null trims nothing. */
fun trimToSpan(bars: List<Bar>, seconds: Long?): List<Bar> {
  if (seconds == null || bars.isEmpty()) return bars
  val end = bars.last().time
  return bars.filter { it.time >= end - seconds }
}

/** The change under the price, and the words that say what it is a change OVER. */
data class HeroChange(val pct: Double, val dollars: Double, val label: String)

/**
 * THE CHANGE UNDER THE PRICE, LABELLED ONLY WITH WHAT IT COVERS.
 *
 * [drawn] is what the chart shows; [all] is every complete bar the read
 * returned, before the span was trimmed off (for a stock the two are the same
 * list). The span label is printed only when the data reaches back to the
 * span's start:
 *
 *  - the first drawn bar is within half a bar of `last - span` — the series
 *    covers the span, and the change runs from that bar's open;
 *  - or an earlier bar exists before the cut — the pool is older than the
 *    span and simply printed nothing at its start, so the price AT the start
 *    is that earlier bar's close (nothing traded in between), and the change
 *    runs from there;
 *  - otherwise the whole answer begins inside the span: the pool is younger
 *    than it. The index returns up to 300 bars and every span but ALL is well
 *    under 300 of its own bars, so an answer that does not reach back is all
 *    the history there is — the line says "since first trade 9h ago".
 *
 * ALL claims no span, so it says "since <age> ago" and nothing more. A STOCK
 * keeps the span label: its range is the venue's own (Yahoo's `range` for
 * 1D/5D/1M/ALL, the VENUE_CUT tail for 1H/4H), which is what the button names.
 *
 * A stale read keeps its figure but says it is as of the last read. Null when
 * there is no change to state: no bars, or a base price that is not positive.
 */
fun heroChange(
  drawn: List<Bar>,
  all: List<Bar>,
  window: String,
  coin: Boolean,
  interval: Long,
  stale: Boolean,
  nowSec: Long,
): HeroChange? {
  val first = drawn.firstOrNull() ?: return null
  val last = drawn.last()
  var base = first.open
  val label: String = when {
    !coin -> window
    window == "ALL" || SPAN_SECONDS[window] == null -> "since ${ageWords(nowSec - first.time)} ago"
    else -> {
      val cut = last.time - SPAN_SECONDS.getValue(window)
      val size = if (interval > 0) interval else barInterval(all)
      val before = all.lastOrNull { it.time < first.time }
      when {
        first.time <= cut + size / 2 -> window
        before != null -> {
          base = before.close
          window
        }
        else -> "since first trade ${ageWords(nowSec - first.time)} ago"
      }
    }
  }
  if (!(base > 0.0) || !base.isFinite() || !last.close.isFinite()) return null
  val pct = (last.close - base) / base * 100.0
  return HeroChange(
    pct = pct,
    dollars = last.close - base,
    label = if (stale) "$label · as of the last read" else label,
  )
}

/**
 * IS THE NEWEST DRAWN BAR STILL FORMING — never for a stale read.
 *
 * A stale series is the last good read, kept through a refusal; its newest bar
 * stopped forming when the read did, and calling it "still forming" is the
 * caption describing a live chart. For a live read the route's own
 * `lastBarAgeSec` against the bar size decides, and without it (a stock, whose
 * bars carry no read) the newest bar's age on this clock does — a Friday
 * close is not still forming on Saturday.
 */
fun newestForming(drawn: List<Bar>, candles: CandleRead?, nowSec: Long): Boolean {
  if (candles?.stale == true) return false
  val last = drawn.lastOrNull() ?: return false
  val size = candles?.interval?.takeIf { it > 0 } ?: barInterval(drawn)
  if (size <= 0) return false
  val age = candles?.lastBarAgeSec ?: (nowSec - last.time)
  return age in 0 until size
}

/**
 * The one sentence a stale series must carry, above the chart — or null. The
 * web's words (Token.tsx), and the part the plan asked to be said outright:
 * these bars are not live.
 */
fun staleNote(candles: CandleRead?): String? =
  if (candles?.stale == true) {
    "Showing the last prices we could read — the index isn't answering right now, so these bars are not live."
  } else {
    null
  }

/**
 * THE CAPTION UNDER A DRAWN CHART. Each clause closes itself, so a series with
 * no label and no gaps cannot run two sentences together.
 */
fun chartCaption(drawnCount: Int, candles: CandleRead?, forming: Boolean): String = buildString {
  append(drawnCount)
  append(if (drawnCount == 1) " bar" else " bars")
  candles?.label?.takeIf { it.isNotBlank() }?.let { append(", ").append(it) }
  append(".")
  val gaps = candles?.gaps ?: 0
  if (gaps > 0) {
    append(" ")
    append(gaps)
    append(" periods published nothing and are left out rather than drawn across.")
  }
  if (forming) append(" The newest bar is still forming, so it is drawn faint.")
}

/**
 * WHY THERE IS NO CHART, one sentence per state, in the web's words
 * (Token.tsx). `refused` is OUR read failing and is worded by its reason;
 * `none` and `mismatch` are facts about the pool. A coin whose document came
 * back with no candle read at all is us again, never an empty pool.
 */
fun chartEmptySentence(candles: CandleRead?, coin: Boolean, window: String, symbol: String?): String {
  if (!coin) return "No bars for that span."
  val state = candles?.state ?: "refused"
  val reason = if (candles == null) "unreachable" else candles.reason
  return when (state) {
    "refused" -> when (reason) {
      "rate-limited" ->
        "We're being rate-limited by the price index right now. That's our outage, not this token's — the chart should be back within a minute."
      "unreadable" -> "The price index answered with something we couldn't read. That's ours to fix."
      else -> "We couldn't reach the price index just now. That's our outage, not this token's."
    }
    "mismatch" ->
      "This pool's price history is quoted for the other side of the pair, so we won't chart it as ${symbol ?: "this token"}."
    "none" ->
      if (window == "1H" || window == "4H") {
        "Nothing has traded in this window. Try a longer timeframe."
      } else {
        "No price history has printed on this pool yet."
      }
    else -> "No bars for that span."
  }
}
