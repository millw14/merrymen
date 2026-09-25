package dev.merrymen.app.market

import dev.merrymen.app.data.Loaded
import dev.merrymen.app.data.toLoaded
import dev.merrymen.app.net.ApiResult
import dev.merrymen.app.net.CandleRead
import dev.merrymen.app.net.MerrymenApi
import dev.merrymen.app.net.VenueChart
import dev.merrymen.app.net.map
import dev.merrymen.app.net.said
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
 * change on a 9-hour-old pool", applied here first. The same label is as false
 * at the other end: a span trimmed back from the newest bar of a pool that
 * went quiet yesterday is yesterday's last hour, not the last hour.
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

/**
 * The change under the price, and the words that say what it is a change OVER.
 * [label] may be empty: a change whose start nobody can date is printed with
 * no words after it rather than with words that are not true.
 */
data class HeroChange(val pct: Double, val dollars: Double, val label: String)

/** Each span in a sentence: "over the day before the last trade". */
private val SPAN_WORDS: Map<String, String> = mapOf(
  "1H" to "hour",
  "4H" to "4 hours",
  "1D" to "day",
  "5D" to "5 days",
  "1M" to "month",
)

/**
 * DOES THE SERIES RUN UP TO NOW — is its newest bar still open, or closed less
 * than one bar ago?
 *
 * The chart trims a span back from its NEWEST BAR (the web's bars.ts does the
 * same), so on a pool that has gone quiet the "1H" it draws is the last hour
 * of trading, which may have been yesterday. A span label printed over that
 * says the price moved 53% in the last hour when nothing traded in it — the
 * live probe of VPLT on 2026-09-25 read exactly that, off a newest bar 17.8h
 * old. Measured on this clock against the bar size; an unknown size cannot
 * show it reaches anywhere.
 */
fun reachesNow(last: Bar, size: Long, nowSec: Long): Boolean = size > 0 && nowSec - last.time < 2 * size

/**
 * HOW LONG AGO THE FIRST PRICE IN THE CHANGE WAS SET — or null when the bars
 * cannot say.
 *
 * A bar is stamped with the START of its period, and the first trade in it
 * happened somewhere inside, so the stamp alone dates the trade early by up to
 * a bar. On daily bars that is a day: a pool twelve hours old, whose one bar
 * opened at the previous UTC midnight, read "since 25h ago" — a day of history
 * that does not exist (live probe of 0x4e0c… on 2026-09-25). The pool's own
 * age ([poolAgeSec], the index's `ageDays`, counted from the pool's creation,
 * which no trade in it precedes) bounds it from above. Without that, an age
 * that could be out by more than a quarter of itself is not printed.
 */
fun firstPriceAgeSec(first: Bar, size: Long, nowSec: Long, poolAgeSec: Long?): Long? {
  val fromBar = nowSec - first.time
  if (poolAgeSec != null && poolAgeSec >= 0) return minOf(fromBar, poolAgeSec)
  if (size > 0 && fromBar < 4 * size) return null
  return fromBar
}

/**
 * THE CHANGE UNDER THE PRICE, LABELLED ONLY WITH WHAT IT COVERS.
 *
 * [drawn] is what the chart shows; [all] is every complete bar the read
 * returned, before the span was trimmed off (for a stock the two are the same
 * list). The span label is printed only when the data covers the span at BOTH
 * ends. At the start:
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
 *    the history there is — the line says "since first trade 9h ago". That is
 *    true however long the pool has been quiet: a pool's price only moves on
 *    a trade, so the last close is the price now.
 *
 * And at the end, the newest bar must reach now ([reachesNow]). When it does
 * not, the figure is the move over the span BEFORE THE LAST TRADE, and it says
 * so: "over the hour before the last trade, 17h ago". The age there is the
 * least it can be (the end of the newest bar), so it never dates the trade
 * earlier than it happened.
 *
 * ALL claims no span, so it says "since <age> ago", or nothing when the age
 * cannot be told ([firstPriceAgeSec]). A STOCK keeps the span label: its range
 * is the venue's own (Yahoo's `range` for 1D/5D/1M/ALL, the VENUE_CUT tail for
 * 1H/4H), which is what the button names.
 *
 * A GRADUATED coin traded on its bonding curve before its DEX pool existed,
 * and its bars are the pool's, so "first trade" would date the coin by its
 * pool: a coin a week old whose pool opened 8h ago read "since first trade 8h
 * ago". There the words are "since this pool opened", which is what the
 * series and the pool's age both measure. ALL already says only "since <age>
 * ago", which is true of either, and a pool older than the bars returned
 * would make "since this pool opened" false there.
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
  poolAgeSec: Long? = null,
  graduated: Boolean = false,
): HeroChange? {
  val first = drawn.firstOrNull() ?: return null
  val since = if (graduated) "since this pool opened" else "since first trade"
  val last = drawn.last()
  var base = first.open
  val size = if (interval > 0) interval else barInterval(all)
  val label: String = when {
    !coin -> window
    window == "ALL" || SPAN_SECONDS[window] == null ->
      firstPriceAgeSec(first, size, nowSec, poolAgeSec)?.let { "since ${ageWords(it)} ago" }.orEmpty()
    else -> {
      val cut = last.time - SPAN_SECONDS.getValue(window)
      val before = all.lastOrNull { it.time < first.time }
      val covered = when {
        first.time <= cut + size / 2 -> true
        before != null -> {
          base = before.close
          true
        }
        else -> false
      }
      when {
        !covered ->
          firstPriceAgeSec(first, size, nowSec, poolAgeSec)?.let { "$since ${ageWords(it)} ago" } ?: since
        reachesNow(last, size, nowSec) -> window
        // A STALE series is our last good read, kept while the index refuses:
        // its newest bar can be old because the READ stopped, not the trading,
        // so it is not called the last trade (newestForming draws the same line).
        stale -> "over the ${SPAN_WORDS[window]} to the newest bar read, ${ageWords(nowSec - last.time - size)} ago"
        else -> "over the ${SPAN_WORDS[window]} before the last trade, ${ageWords(nowSec - last.time - size)} ago"
      }
    }
  }
  if (!(base > 0.0) || !base.isFinite() || !last.close.isFinite()) return null
  val pct = (last.close - base) / base * 100.0
  return HeroChange(
    pct = pct,
    dollars = last.close - base,
    label = listOf(label, if (stale) "as of the last read" else "").filter { it.isNotEmpty() }.joinToString(" · "),
  )
}

/**
 * How long ago a COIN's newest drawn bar opened, when the series does not
 * reach now ([reachesNow]) — or null when it does. The caption says it, so a
 * chart of yesterday's last hour is not read as the last hour.
 */
fun quietForSec(drawn: List<Bar>, interval: Long, nowSec: Long): Long? {
  val last = drawn.lastOrNull() ?: return null
  val size = if (interval > 0) interval else barInterval(drawn)
  return if (reachesNow(last, size, nowSec)) null else (nowSec - last.time).coerceAtLeast(0)
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
fun chartCaption(drawnCount: Int, candles: CandleRead?, forming: Boolean, quietForSec: Long? = null): String = buildString {
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
  if (quietForSec != null) append(" The newest bar opened ${ageWords(quietForSec)} ago.")
}

/**
 * WHY THERE IS NO CHART, one sentence per state, in the web's words
 * (Token.tsx). `refused` is OUR read failing and is worded by its reason;
 * `none` and `mismatch` are facts about the pool.
 *
 * A COIN WHOSE DOCUMENT CAME BACK WITH NO CANDLE READ is one of two things,
 * and [marketRead] (the document's `market.read`) says which. The route reads
 * candles only for a coin the index described, so no read means the index
 * either could not be asked (`unread`: our outage) or answered without this
 * token (`absent`). "Absent" is deliberately narrow — the pools we hold are
 * page one of three feeds (read-token-market.ts) — so its sentence is about
 * what we read, never about the index or the token. Anything else is read as
 * ours: failing closed costs a vaguer sentence, not a false one.
 */
fun chartEmptySentence(
  candles: CandleRead?,
  coin: Boolean,
  window: String,
  symbol: String?,
  marketRead: String? = null,
): String {
  if (!coin) return "No bars for that span."
  if (candles == null && marketRead == "absent") {
    return "This token isn't among the pools we read from the index, so there's no price history to chart here. " +
      "That's a limit of what we read, not a fact about this token."
  }
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

/**
 * The cut the stock venue applies to its own answer.
 *
 * Yahoo has no one-hour range, so the proxy asks for a day of one-minute bars
 * and the last hour is taken from the tail. Mirrored from CHART_WINDOWS.
 */
val VENUE_CUT: Map<String, Long> = mapOf("1H" to 3_600L, "4H" to 14_400L)

/**
 * A stock's bars out of the venue proxy's answer.
 *
 * A BAR WITH ANY NULL IN IT IS DROPPED, not interpolated. Yahoo's arrays are
 * nullable at every index — a halted minute is four nulls — and filling them in
 * draws a line through a price that never existed. Then [multiplier]
 * (`uiMultiplier`) is applied, because the on-chain unit is what the rest of
 * the page quotes.
 *
 * ONE TRIM, NOT TWO. The web trims a STOCK series only by the venue's own
 * `cut` (VENUE_CUT), because the range it asked the venue for already matches
 * the span; SPAN_SECONDS is the COIN path's trimmer. Applying both over-clipped
 * 5D/1M so the chart showed fewer sessions than its label — and the change
 * line under the price, computed off the first drawn bar, then read the wrong
 * span. bars.ts trims stocks by cut alone.
 */
fun venueBars(chart: VenueChart, window: String, multiplier: Double): List<Bar> {
  val row = chart.chart?.result?.firstOrNull()
  val q = row?.indicators?.quote?.firstOrNull() ?: return emptyList()
  val ts = row?.timestamp.orEmpty()
  val out = ArrayList<Bar>(ts.size)
  for (i in ts.indices) {
    val o = q.open.getOrNull(i)
    val h = q.high.getOrNull(i)
    val l = q.low.getOrNull(i)
    val c = q.close.getOrNull(i)
    if (o == null || h == null || l == null || c == null) continue
    out.add(Bar(ts[i], o * multiplier, h * multiplier, l * multiplier, c * multiplier))
  }
  return trimToSpan(out, VENUE_CUT[window])
}

/**
 * A STOCK'S BARS, READ — through toLoaded(), so an answer merrymen sent and
 * this app could not read stays `unreadable` all the way to the sentence under
 * the chart. It used to be rebuilt by hand as Loaded.Unreachable(cause), which
 * dropped the flag and captioned an unreadable answer "couldn't reach".
 */
suspend fun MerrymenApi.stockBarsRead(symbol: String, window: String, multiplier: Double): Loaded<List<Bar>> =
  venueChart(symbol, window).map { venueBars(it, window, multiplier) }.toLoaded()

/**
 * WHY A STOCK'S CHART DID NOT COME — null for a value or a read in flight.
 *
 * Every one of these is our read failing, never a price, and each is said the
 * way the contract says it: a 5xx in merrymen's own sentence, a 4xx as the
 * venue refusing, and an answer we did not get through
 * [ApiResult.Unreachable.said] — "Can't reach merrymen right now: <why>" when
 * nothing came back, and the unreadable sentence alone when something did.
 */
fun chartReadFailure(bars: Loaded<*>): String? {
  val ours = "That's our chart read failing, not a price."
  return when (bars) {
    is Loaded.Refused ->
      if (bars.status >= 500) "${sentence(bars.message)} $ours"
      else "The chart venue said no (${bars.status}). $ours"
    is Loaded.Unreachable -> "${sentence(ApiResult.Unreachable(bars.cause, bars.unreadable).said)} $ours"
    else -> null
  }
}

/** Whether Try again can help a failed chart read: a failure of ours, not a venue's 4xx. */
fun chartReadRetries(bars: Loaded<*>): Boolean =
  bars is Loaded.Unreachable || (bars is Loaded.Refused && bars.status >= 500)

/** A cause is OkHttp's words and may not end in a full stop; the next sentence needs one. */
private fun sentence(s: String): String {
  val t = s.trim()
  return if (t.endsWith(".") || t.endsWith("!") || t.endsWith("?")) t else "$t."
}
