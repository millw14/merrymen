package dev.merrymen.app.market

import dev.merrymen.app.net.Fixtures
import dev.merrymen.app.net.TokenDetail
import dev.merrymen.app.ui.Bar
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The app's own decoding rules: unknown keys ignored, nulls never a default. */
private val relaxed = Json { ignoreUnknownKeys = true; explicitNulls = false }

/**
 * NO SPAN LABEL OVER A SERIES THAT DOES NOT COVER THE SPAN.
 *
 * The change under a token's price used to be printed with whatever span was
 * tapped, so a nine-hour-old pool on 1D read as a day's move. heroChange is
 * run here over the captured coin and over series built to the hour.
 */
class SpanCoverageTest {
  private val hour = 3_600L
  private fun bar(t: Long, o: Double = 1.0, c: Double = 1.0) = Bar(t, o, maxOf(o, c), minOf(o, c), c)

  /** Hourly bars from [start], [n] of them, the price stepping up by 0.1 each hour. */
  private fun hourly(start: Long, n: Int): List<Bar> =
    (0 until n).map { i -> bar(start + i * hour, o = 1.0 + i * 0.1, c = 1.1 + i * 0.1) }

  @Test fun aNineHourPoolOn1DSaysSinceFirstTradeNot1D() {
    val start = 1_790_000_000L
    val bars = hourly(start, 9) // 00:00 … 08:00, nine bars
    val now = start + 9 * hour
    val drawn = trimToSpan(bars, SPAN_SECONDS["1D"])
    val change = heroChange(drawn, bars, "1D", coin = true, interval = hour, stale = false, nowSec = now)
    assertNotNull(change)
    assertEquals("since first trade 9h ago", change!!.label)
    assertTrue("never the span it does not cover", !change.label.contains("1D"))
    // The figure runs from the first bar's open, the pool's first price.
    assertEquals((bars.last().close - 1.0) / 1.0 * 100, change.pct, 1e-9)
  }

  @Test fun theCapturedCoinCovers1DButNot5D() {
    val doc = relaxed.decodeFromString(TokenDetail.serializer(), Fixtures.text("probe-token-coin.json"))
    val all = completeBars(doc.candles)
    assertEquals(28, all.size)
    val now = all.last().time + (doc.candles!!.lastBarAgeSec ?: 0)
    val poolAge = (doc.market.coin!!.ageDays!! * 86_400).toLong() // 1.1498 days: 27.6h

    val day = heroChange(trimToSpan(all, SPAN_SECONDS["1D"]), all, "1D", true, doc.candles!!.interval, false, now, poolAge)
    assertEquals("28 hourly bars reach back past a day, and up to now", "1D", day!!.label)

    val week = heroChange(trimToSpan(all, SPAN_SECONDS["5D"]), all, "5D", true, doc.candles!!.interval, false, now, poolAge)
    assertEquals("since first trade 27h ago", week!!.label)
  }

  /**
   * A POOL THAT WENT QUIET. The span is trimmed back from the newest bar, as
   * the web trims it, so the chart of a pool last traded 17.8 hours ago is
   * that pool's last hour of trading — the VPLT probe of 2026-09-25, whose
   * five drawn bars gave −53.47% "1H" although nothing traded in the hour.
   */
  @Test fun aQuietPoolIsNotGivenTheSpanItDidNotTradeIn() {
    val q = 900L // 15-minute bars, as 1H and 4H ask for
    val start = 1_790_000_000L
    val bars = (0 until 8).map { i -> bar(start + i * q, o = 2.0 - i * 0.15, c = 1.85 - i * 0.15) }
    val last = bars.last()
    val drawn = trimToSpan(bars, SPAN_SECONDS["1H"])
    val quiet = last.time + 64_000 // 17.8h after the newest bar opened

    val change = heroChange(drawn, bars, "1H", coin = true, interval = q, stale = false, nowSec = quiet)!!
    assertFalse(change.label, change.label.contains("1H"))
    // The least age the last trade can have: the end of its bar, 17.5h ago.
    assertEquals("over the hour before the last trade, 17h ago", change.label)

    // The same bars read while the newest is still open: the span is the span.
    val live = heroChange(drawn, bars, "1H", coin = true, interval = q, stale = false, nowSec = last.time + 60)!!
    assertEquals("1H", live.label)
    assertEquals("the figure itself is unchanged, only what it is said to cover", live.pct, change.pct, 1e-9)

    // The tolerance is one closed bar: a newest bar that closed less than a bar ago still reaches now.
    assertEquals("1H", heroChange(drawn, bars, "1H", true, q, false, last.time + 2 * q - 1)!!.label)
    assertTrue(heroChange(drawn, bars, "1H", true, q, false, last.time + 2 * q)!!.label.startsWith("over the hour"))

    // And on the day: thirty hourly bars reach back a day from the newest, not from now.
    val hours = hourly(start, 30)
    val day = heroChange(trimToSpan(hours, SPAN_SECONDS["1D"]), hours, "1D", true, hour, false, hours.last().time + 5 * hour)!!
    assertEquals("over the day before the last trade, 4h ago", day.label)
    // Stale and quiet: both are said.
    val staleQuiet = heroChange(trimToSpan(hours, SPAN_SECONDS["1D"]), hours, "1D", true, hour, true, hours.last().time + 5 * hour)!!
    assertEquals("over the day before the last trade, 4h ago · as of the last read", staleQuiet.label)
  }

  @Test fun theCaptionSaysWhenAQuietChartsNewestBarOpened() {
    val q = 900L
    val bars = (0 until 4).map { bar(1_790_000_000L + it * q) }
    val quiet = quietForSec(bars, q, bars.last().time + 64_000)
    assertEquals(64_000L, quiet)
    assertEquals("4 bars. The newest bar opened 17h ago.", chartCaption(4, null, forming = false, quietForSec = quiet))
    assertNull("a series that reaches now says nothing of the kind", quietForSec(bars, q, bars.last().time + 60))
  }

  /**
   * DAILY BARS ARE STAMPED AT UTC MIDNIGHT. A pool made at 22:00 and read at
   * 01:00 has one daily bar, opened at the midnight before it existed — 25
   * hours back from a pool three hours old. The live probe of 0x4e0c… on
   * 2026-09-25 read "since 25h ago" off a pool whose ageDays was 0.50.
   */
  @Test fun aPoolMadeLateInTheDayIsNotGivenADayItDidNotHave() {
    val midnight = 1_790_208_000L // 2026-09-24T00:00:00Z
    val made = midnight + 22 * hour
    val now = midnight + 25 * hour // 01:00 the next day
    val bars = listOf(bar(midnight, o = 1.0, c = 1.4))
    val poolAge = now - made // three hours

    val all = heroChange(bars, bars, "ALL", coin = true, interval = 86_400, stale = false, nowSec = now, poolAgeSec = poolAge)!!
    assertEquals("since 3h ago", all.label)
    val month = heroChange(trimToSpan(bars, SPAN_SECONDS["1M"]), bars, "1M", true, 86_400, false, now, poolAge)!!
    assertEquals("since first trade 3h ago", month.label)

    // Without the pool's age a one-bar-wide guess is not printed at all.
    assertEquals("", heroChange(bars, bars, "ALL", true, 86_400, false, now)!!.label)
    assertEquals("since first trade", heroChange(bars, bars, "1M", true, 86_400, false, now)!!.label)
    // And a stale read with no datable start still says it is the last read.
    assertEquals("as of the last read", heroChange(bars, bars, "ALL", true, 86_400, true, now)!!.label)
  }

  @Test fun aQuietStartIsStillCoveredAndPricedFromTheLastTradeBeforeIt() {
    val end = 1_790_100_000L
    // A bar thirty hours back, then nothing until nine hours back: the pool is
    // older than the day, it just printed nothing at the day's start.
    val early = bar(end - 30 * hour, o = 2.0, c = 2.5)
    val recent = hourly(end - 8 * hour, 9)
    val all = listOf(early) + recent
    val drawn = trimToSpan(all, SPAN_SECONDS["1D"])
    assertEquals(9, drawn.size)
    val change = heroChange(drawn, all, "1D", coin = true, interval = hour, stale = false, nowSec = end + 60)!!
    assertEquals("1D", change.label)
    // Nothing traded between, so the price at the day's start was 2.5.
    assertEquals((drawn.last().close - 2.5) / 2.5 * 100, change.pct, 1e-9)
  }

  @Test fun halfABarOfToleranceAtTheCut() {
    val end = 1_790_200_000L
    val first = end - 24 * hour + hour / 2 // exactly half a bar past the cut
    val bars = listOf(bar(first), bar(end))
    val change = heroChange(bars, bars, "1D", coin = true, interval = hour, stale = false, nowSec = end)!!
    assertEquals("1D", change.label)
    val late = listOf(bar(first + 1), bar(end))
    val short = heroChange(late, late, "1D", coin = true, interval = hour, stale = false, nowSec = end)!!
    assertTrue(short.label.startsWith("since first trade"))
  }

  @Test fun allClaimsNoSpan() {
    val start = 1_789_000_000L
    val bars = (0 until 10).map { bar(start + it * 86_400L) }
    val change = heroChange(bars, bars, "ALL", coin = true, interval = 86_400, stale = false, nowSec = start + 10 * 86_400L)!!
    assertEquals("since 10d ago", change.label)
  }

  @Test fun aStockKeepsTheVenuesSpan() {
    // Yahoo's 1D range is one session, not twenty-four hours, and that is what
    // the button names on a stock.
    val start = 1_790_300_000L
    val bars = (0 until 390).map { bar(start + it * 60L) }
    val change = heroChange(bars, bars, "1D", coin = false, interval = 0, stale = false, nowSec = start + 390 * 60)!!
    assertEquals("1D", change.label)
  }

  @Test fun aStaleSeriesSaysItIsAsOfTheLastRead() {
    val start = 1_790_000_000L
    val bars = hourly(start, 30)
    val drawn = trimToSpan(bars, SPAN_SECONDS["1D"])
    val change = heroChange(drawn, bars, "1D", coin = true, interval = hour, stale = true, nowSec = start + 30 * hour)!!
    assertEquals("1D · as of the last read", change.label)
  }

  @Test fun noBarsOrNoPriceIsNoChangeAtAll() {
    assertNull(heroChange(emptyList(), emptyList(), "1D", true, hour, false, 0))
    val zero = listOf(Bar(1, 0.0, 0.0, 0.0, 0.0), Bar(2, 0.0, 1.0, 0.0, 1.0))
    assertNull("a zero base is not +∞%", heroChange(zero, zero, "ALL", true, hour, false, 3))
  }
}
