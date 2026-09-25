package dev.merrymen.app.market

import dev.merrymen.app.net.ApiResult
import dev.merrymen.app.net.DiscoveryCoin
import dev.merrymen.app.net.Fixtures
import dev.merrymen.app.net.PoolEvidence
import dev.merrymen.app.net.PoolTrade
import dev.merrymen.app.net.PoolTradesRead
import dev.merrymen.app.net.TokenDetail
import dev.merrymen.app.net.apiFor
import dev.merrymen.app.net.poolEvidenceOf
import dev.merrymen.app.net.tapeWindows
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

private val appJson = Json { ignoreUnknownKeys = true; explicitNulls = false }

/**
 * A COIN'S MARKET ACTIVITY: the public pool trades behind its price, read off
 * the captured ?activity=1 document through the real client.
 */
class TokenActivityTest {
  private val coin = "0x1da81ca017949efbe07972776580d04592ba9b63"

  /** The document as the screen gets it: the real client, the captured answer, activity asked for. */
  private fun capturedDoc(): TokenDetail = runBlocking {
    val server = MockWebServer()
    server.dispatcher = object : Dispatcher() {
      override fun dispatch(request: RecordedRequest): MockResponse =
        if (request.path == "/api/tokens/$coin?window=1h&activity=1") {
          MockResponse().setBody(Fixtures.text("probe-token-coin.json"))
        } else {
          // Asked without activity=1: no evidence rides on the answer.
          MockResponse().setResponseCode(404)
        }
    }
    server.start()
    try {
      when (val r = apiFor(server).token(coin, "1h", activity = true)) {
        is ApiResult.Ok -> r.value
        else -> { fail("expected Ok, got $r"); error("unreachable") }
      }
    } finally {
      server.shutdown()
    }
  }

  @Test fun theCapturedTradesDecodeNewestFirstWithExplorerLinks() {
    val doc = capturedDoc()
    val e = poolEvidenceOf(doc.evidence)!!
    val observed = e.trades!!.observedAt!!
    assertEquals(1790290399016L, observed)
    assertEquals(300, e.trades!!.data.size)

    val v = tradesView(e, nowMs = observed + 30_000)
    v as TradesView.Rows
    assertEquals("a fresh sample is a snapshot", false, v.older)
    assertEquals(TRADES_SHOWN, v.rows.size)
    assertEquals(v.rows.map { it.timeSec }.sortedDescending(), v.rows.map { it.timeSec })
    val first = v.rows.first()
    assertEquals(false, first.buy)
    assertEquals(1790290324L, first.timeSec)
    assertEquals(
      "https://robinhoodchain.blockscout.com/tx/0xb680fff8fc15bc9a1809677461a7098df0692b6c081c0a8efc2cc338d84deec0",
      first.txUrl,
    )
  }

  @Test fun anOldSampleIsSaidToBeOld() {
    val e = poolEvidenceOf(capturedDoc().evidence)!!
    val v = tradesView(e, nowMs = e.trades!!.observedAt!! + 10 * 60_000) as TradesView.Rows
    assertTrue(v.older)
    // A sample with no time is never "a snapshot" of now.
    val noTime = tradesView(e.copy(trades = e.trades!!.copy(observedAt = null)), nowMs = 0) as TradesView.Rows
    assertTrue(noTime.older)
    assertNull(noTime.observedAtMs)
  }

  @Test fun aFailedOrMissingReadIsUnavailableNeverNoTrades() {
    assertEquals(TradesView.Unavailable, tradesView(null, 0))
    assertEquals(TradesView.Unavailable, tradesView(PoolEvidence(trades = null), 0))
    assertEquals(
      TradesView.Unavailable,
      tradesView(PoolEvidence(trades = PoolTradesRead(failed = true, failure = "budget")), 0),
    )
    // JSON null and a shape this build cannot read are both "no evidence".
    assertNull(poolEvidenceOf(JsonNull))
    assertNull(poolEvidenceOf(JsonPrimitive("nope")))
    assertNull(poolEvidenceOf(Json.parseToJsonElement("""{"trades":{"failed":false,"data":"x"}}""")))
    // A trades object that never said `failed` has not said it read anything.
    val unsaid = poolEvidenceOf(Json.parseToJsonElement("""{"trades":{"observedAt":1,"data":[]}}"""))
    assertEquals(TradesView.Unavailable, tradesView(unsaid, 2))
  }

  @Test fun anAnsweredEmptySampleIsItsOwnSentence() {
    val e = PoolEvidence(trades = PoolTradesRead(failed = false, observedAt = 1_000, data = emptyList()))
    assertEquals(TradesView.NoneInSample(1_000, false), tradesView(e, 2_000))
  }

  @Test fun onlyAHashBecomesALinkAndAnUnsidedTradeIsDropped() {
    assertNull(explorerTxUrl("javascript:alert(1)"))
    assertNull(explorerTxUrl("https://evil.example/0x" + "1".repeat(64)))
    assertNull(explorerTxUrl("0x" + "1".repeat(63)))
    assertEquals(EXPLORER_TX + "0x" + "a".repeat(64), explorerTxUrl("0x" + "a".repeat(64)))

    val e = PoolEvidence(
      trades = PoolTradesRead(
        failed = false,
        observedAt = 1_000,
        data = listOf(
          PoolTrade(id = "a", tx = "not-a-hash", time = 10.0, side = "buy", usd = 5.0),
          PoolTrade(id = "b", tx = "0x" + "2".repeat(64), time = 11.0, side = "transfer", usd = 5.0),
          PoolTrade(id = "c", tx = "0x" + "3".repeat(64), time = null, side = "sell", usd = 5.0),
        ),
      ),
    )
    val v = tradesView(e, 1_000) as TradesView.Rows
    assertEquals(listOf("a"), v.rows.map { it.id })
    assertNull("drawn, but not a link", v.rows.single().txUrl)
  }

  @Test fun theTapeIsTheIndexsAndAnOmittedWindowIsNoFigure() {
    val doc = capturedDoc()
    val coin = doc.market.coin!!
    val tape = tapeWindows(coin.buckets)
    assertEquals(listOf("5m", "1h", "6h", "24h"), tape.map { it.label })
    assertEquals(3069222.66678589, tape[3].volumeUsd!!, 1e-6)
    assertEquals(8812L, tape[3].buys)
    assertEquals(9242L, tape[3].sells)

    // The index left out 6h entirely and gave 1h without counts.
    val partial = Json.parseToJsonElement(
      """{"m5":{"volumeUsd":1.5,"buys":1,"sells":0},"h1":{"volumeUsd":20,"buys":null,"sells":null},"h24":{"volumeUsd":null}}""",
    )
    val t = tapeWindows(partial)
    assertNull(t[2].volumeUsd)
    assertNull(t[2].buys)
    assertEquals("—", fmtCompactUsd(t[2].volumeUsd))
    assertEquals("—", fmtCount(t[1].buys))
    assertEquals("0", fmtCount(t[0].sells))
    assertNull(t[3].volumeUsd)
  }

  @Test fun aWindowLongerThanThePoolSaysHowOldThePoolIs() {
    val tape = tapeWindows(capturedDoc().market.coin!!.buckets)
    val nineHours = 9.0 / 24.0
    assertEquals("24h · pool 9h old", tapeLabel(tape[3], nineHours))
    assertEquals("6h", tapeLabel(tape[2], nineHours))
    // The captured pool is 1.15 days old: every window is covered.
    assertEquals(listOf("5m", "1h", "6h", "24h"), tape.map { tapeLabel(it, 1.15) })
    assertEquals("an unknown age is not youth", "24h", tapeLabel(tape[3], null))
  }

  @Test fun theDocumentWithoutActivityCarriesNoEvidence() {
    val doc = appJson.decodeFromString(
      TokenDetail.serializer(),
      Fixtures.text("probe-token-stock.json"),
    )
    assertNull(poolEvidenceOf(doc.evidence))
    assertTrue(Json.parseToJsonElement(Fixtures.text("probe-token-coin.json")).jsonObject.containsKey("evidence"))
    assertEquals(null, DiscoveryCoin().buckets)
  }
}
