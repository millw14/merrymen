package dev.merrymen.app.market

import dev.merrymen.app.data.Loaded
import dev.merrymen.app.net.ApiResult
import dev.merrymen.app.net.CANT_REACH
import dev.merrymen.app.net.CandleRead
import dev.merrymen.app.net.Fixtures
import dev.merrymen.app.net.TokenDetail
import dev.merrymen.app.net.UNREADABLE_ANSWER
import dev.merrymen.app.net.answer
import dev.merrymen.app.net.apiFor
import dev.merrymen.app.ui.Bar
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * A STALE SERIES IS NEVER CAPTIONED AS LIVE, and an empty chart says whose
 * fault it is.
 *
 * The documents are the captured coin, edited the way read-candles.ts edits a
 * kept read (`{...previous, stale: true, refusedAt}`), and served through the
 * real client so `stale` is decoded, not assumed.
 */
class TokenCaptionTest {
  private val coin = "0x1da81ca017949efbe07972776580d04592ba9b63"

  private fun serve(body: String): TokenDetail = runBlocking {
    val server = MockWebServer()
    server.start()
    try {
      server.answer(body)
      when (val r = apiFor(server).token(coin, "1h")) {
        is ApiResult.Ok -> r.value
        else -> { fail("expected Ok, got $r"); error("unreachable") }
      }
    } finally {
      server.shutdown()
    }
  }

  private fun staleCapture(): String =
    Fixtures.text("probe-token-coin.json")
      .replace("\"state\":\"ok\",\"reason\":null,", "\"state\":\"ok\",\"reason\":null,\"stale\":true,\"refusedAt\":1790290500000,")

  @Test fun aStaleReadIsNotStillFormingAndSaysItIsNotLive() {
    val doc = serve(staleCapture())
    val candles = doc.candles!!
    assertTrue("stale decoded", candles.stale)
    assertEquals(1790290500000L, candles.refusedAt)
    val bars = completeBars(candles)
    // The captured newest bar was 3,199s into its hour — a live read would
    // call it forming. A kept read may not.
    val now = bars.last().time + 10
    assertFalse(newestForming(bars, candles, now))
    val caption = chartCaption(bars.size, candles, newestForming(bars, candles, now))
    assertFalse(caption, caption.contains("forming"))
    val note = staleNote(candles)
    assertNotNull(note)
    assertTrue(note!!.contains("not live"))
  }

  @Test fun theSameReadLiveIsFormingAndHasNoStaleNote() {
    val doc = serve(Fixtures.text("probe-token-coin.json"))
    val candles = doc.candles!!
    assertFalse(candles.stale)
    val bars = completeBars(candles)
    assertTrue(newestForming(bars, candles, bars.last().time + 10))
    assertTrue(chartCaption(bars.size, candles, true).endsWith("The newest bar is still forming, so it is drawn faint."))
    assertNull(staleNote(candles))
  }

  @Test fun aStockBarFromYesterdayIsNotForming() {
    // A stock's document carries no candle read; the newest bar's own age on
    // this clock decides. Friday's close is not still forming on Saturday.
    val bars = (0 until 5).map { Bar(1_790_000_000L + it * 60, 1.0, 1.0, 1.0, 1.0) }
    assertFalse(newestForming(bars, null, bars.last().time + 86_400))
    assertTrue(newestForming(bars, null, bars.last().time + 30))
  }

  @Test fun aRefusalIsWordedByItsReason() {
    fun refused(reason: String?) = CandleRead(state = "refused", reason = reason)
    assertTrue(chartEmptySentence(refused("rate-limited"), true, "1D", "QUANTA").contains("rate-limited"))
    assertTrue(chartEmptySentence(refused("unreadable"), true, "1D", "QUANTA").contains("couldn't read"))
    assertTrue(chartEmptySentence(refused("unreachable"), true, "1D", "QUANTA").contains("couldn't reach"))
    // Every refusal says it is ours, never the token's.
    listOf("rate-limited", "unreadable", "unreachable").forEach {
      val s = chartEmptySentence(refused(it), true, "1D", null)
      assertFalse(s, s.contains("No price history"))
    }
    // A coin whose document carried no candle read at all is us, not an empty pool.
    assertTrue(chartEmptySentence(null, true, "1D", null).contains("couldn't reach"))
  }

  @Test fun theFactsAboutThePoolAreTheirOwnSentences() {
    assertTrue(chartEmptySentence(CandleRead(state = "mismatch"), true, "1D", "QUANTA").contains("as QUANTA"))
    assertEquals(
      "Nothing has traded in this window. Try a longer timeframe.",
      chartEmptySentence(CandleRead(state = "none"), true, "1H", null),
    )
    assertEquals(
      "No price history has printed on this pool yet.",
      chartEmptySentence(CandleRead(state = "none"), true, "1D", null),
    )
    assertEquals("No bars for that span.", chartEmptySentence(null, false, "1D", "AAPL"))
  }

  /**
   * A COIN WITH NO CANDLE READ is one of two things, and the document's
   * `market.read` says which. The route asks for candles only for a coin the
   * index described, so the captured coin is edited the way read-token-market
   * answers the other two cases: `coin: null`, `candles: null`, and `read`
   * set to "absent" (the index answered without it) or "unread" (it could
   * not be asked).
   */
  @Test fun aCoinTheIndexAnsweredWithoutIsNotCalledAnOutage() {
    fun without(read: String): String {
      val doc = Json.parseToJsonElement(Fixtures.text("probe-token-coin.json")).jsonObject
      val market = JsonObject(doc.getValue("market").jsonObject + mapOf("read" to JsonPrimitive(read), "coin" to JsonNull))
      return JsonObject(doc + mapOf("market" to market, "candles" to JsonNull, "evidence" to JsonNull)).toString()
    }
    val absent = serve(without("absent"))
    assertNull(absent.candles)
    assertEquals("absent", absent.market.read)
    val said = chartEmptySentence(absent.candles, true, "1D", null, absent.market.read)
    assertFalse("the index answered: not our outage", said.contains("couldn't reach"))
    assertFalse("and not a claim about the index or the token", said.contains("No price history"))
    assertTrue(said, said.contains("isn't among the pools we read"))

    val unread = serve(without("unread"))
    assertTrue(chartEmptySentence(unread.candles, true, "1D", null, unread.market.read).contains("couldn't reach"))
  }

  /**
   * A STOCK'S BARS through the real client: an answer merrymen sent and this
   * app could not read stays `unreadable` to the sentence under the chart,
   * which says so in the contract's words rather than "couldn't reach".
   */
  @Test fun aStockChartIsSaidTheWayItFailed() = runBlocking {
    val server = MockWebServer()
    server.start()
    try {
      // One attempt per call, so a dropped connection is that call's answer
      // and not a silent second try that takes the next queued response.
      val api = apiFor(server, OkHttpClient.Builder().retryOnConnectionFailure(false).build())

      server.answer("<html>not json</html>", type = "text/html")
      val unreadable = api.stockBarsRead("AAPL", "1D", 1.0)
      assertTrue("$unreadable", unreadable is Loaded.Unreachable && unreadable.unreadable)
      val u = chartReadFailure(unreadable)!!
      assertTrue(u, u.startsWith(UNREADABLE_ANSWER))
      assertFalse(u, u.contains("Can't reach"))
      assertTrue(u.endsWith("That's our chart read failing, not a price."))
      assertTrue(chartReadRetries(unreadable))

      server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
      val lost = api.stockBarsRead("AAPL", "1D", 1.0)
      assertTrue("$lost", lost is Loaded.Unreachable && !lost.unreadable)
      val l = chartReadFailure(lost)!!
      assertTrue(l, l.startsWith("$CANT_REACH: "))
      assertTrue(l, l.contains(". That's our chart read failing, not a price."))

      server.answer("""{"error":"boom"}""", code = 503)
      val failed = api.stockBarsRead("AAPL", "1D", 1.0)
      assertEquals(
        "merrymen answered with an error (503). Try again in a moment. That's our chart read failing, not a price.",
        chartReadFailure(failed),
      )
      assertTrue(chartReadRetries(failed))

      server.answer("""{"error":"Unknown symbol"}""", code = 404)
      val no = api.stockBarsRead("ZZZZ", "1D", 1.0)
      assertEquals("The chart venue said no (404). That's our chart read failing, not a price.", chartReadFailure(no))
      assertFalse("asking again gets the same answer", chartReadRetries(no))

      // A good answer: a bar with a null in it is dropped, the rest scaled.
      server.answer(
        """{"chart":{"result":[{"timestamp":[1790290000,1790290060,1790290120],""" +
          """"indicators":{"quote":[{"open":[1,null,3],"high":[1,2,3],"low":[1,2,3],"close":[1,2,3]}]}}]}}""",
      )
      val ok = api.stockBarsRead("AAPL", "1D", 2.0)
      assertEquals(listOf(Bar(1790290000, 2.0, 2.0, 2.0, 2.0), Bar(1790290120, 6.0, 6.0, 6.0, 6.0)), (ok as Loaded.Value<List<Bar>>).value)
      assertNull(chartReadFailure(ok))
    } finally {
      server.shutdown()
    }
  }

  @Test fun theCaptionClosesEveryClause() {
    val c = CandleRead(state = "ok", label = "hourly", gaps = 3, interval = 3_600)
    assertEquals(
      "28 bars, hourly. 3 periods published nothing and are left out rather than drawn across.",
      chartCaption(28, c, forming = false),
    )
    assertEquals("1 bar.", chartCaption(1, null, forming = false))
  }
}
