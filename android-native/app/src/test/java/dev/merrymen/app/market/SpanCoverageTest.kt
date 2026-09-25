package dev.merrymen.app.market

import dev.merrymen.app.net.Fixtures
import dev.merrymen.app.net.TokenDetail
import dev.merrymen.app.ui.Bar
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
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

    val day = heroChange(trimToSpan(all, SPAN_SECONDS["1D"]), all, "1D", true, doc.candles!!.interval, false, now)
    assertEquals("28 hourly bars reach back past a day", "1D", day!!.label)

    val week = heroChange(trimToSpan(all, SPAN_SECONDS["5D"]), all, "5D", true, doc.candles!!.interval, false, now)
    assertTrue(week!!.label, week.label.startsWith("since first trade "))
    assertTrue(week.label, week.label.endsWith("h ago"))
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
