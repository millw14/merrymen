package dev.merrymen.app.market

import dev.merrymen.app.data.Loaded
import dev.merrymen.app.data.toLoaded
import dev.merrymen.app.net.ApiResult
import dev.merrymen.app.net.DiscoveryCoin
import dev.merrymen.app.net.Discoveries
import dev.merrymen.app.net.Fixtures
import dev.merrymen.app.net.TokensPage
import dev.merrymen.app.net.apiFor
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/**
 * THE MARKETS LIST, OVER WHAT PRODUCTION SAID ON 2026-09-24.
 *
 * Both reads are served from their captured files and read through the real
 * client, then joined the way the screen joins them.
 */
class MarketsTest {
  private lateinit var server: MockWebServer
  private lateinit var market: TokensPage
  private lateinit var disc: Discoveries

  @Before fun start() {
    server = MockWebServer()
    server.dispatcher = object : Dispatcher() {
      override fun dispatch(request: RecordedRequest): MockResponse = when (request.path) {
        "/api/market" -> MockResponse().setBody(Fixtures.text("probe-market.json"))
        "/api/discoveries" -> MockResponse().setBody(Fixtures.text("probe-discoveries.json"))
        else -> MockResponse().setResponseCode(404)
      }
    }
    server.start()
    val api = apiFor(server)
    runBlocking {
      market = ok(api.market())
      disc = ok(api.discoveries())
    }
  }

  @After fun stop() = server.shutdown()

  private fun <T> ok(r: ApiResult<T>): T = when (r) {
    is ApiResult.Ok -> r.value
    else -> { fail("expected Ok, got $r"); error("unreachable") }
  }

  @Test fun coinsAreListedBesideTheStocks() {
    val rows = marketRows(market, disc)
    // 25 registered stocks and ETFs, and 87 index rows of which 5 are pools
    // for registered stocks: 25 + 82.
    assertEquals(107, rows.size)
    assertEquals(25, rows.count { !it.coin })
    assertEquals(82, rows.count { it.coin })
    // The registry leads, in its own order.
    assertEquals(market.tokens.map { it.symbol }, rows.take(25).map { it.symbol })
    assertEquals("QUANTA", rows[25].symbol)
    assertEquals(rows.size, rows.map { it.id }.toSet().size)
  }

  @Test fun aPoolNeverTurnsARegisteredStockIntoAMemecoin() {
    val rows = marketRows(market, disc).associateBy { it.id }
    // META / USDG 0.3% is a pool for the registered META.
    val meta = rows.getValue("0xc0d6457c16cc70d6790dd43521c899c87ce02f35")
    assertFalse(meta.coin)
    assertEquals("META", meta.symbol)
    val listed = market.tokens.first { it.address.equals(meta.address, ignoreCase = true) }
    assertEquals(listed.name, meta.name)
    assertEquals(listed.priceUsd, meta.priceUsd)
    assertNull("no launchpad figure is attached to a stock", meta.change24hPct)
    assertFalse(meta.newPool)
  }

  @Test fun aPoolYoungerThanADayHasNo24hChange() {
    val rows = marketRows(market, disc).associateBy { it.id }
    // FOOMS: 0.18 days old, and the index says +1,647% "24h".
    val fooms = rows.getValue("0x749216618ac66ea41ee4cabf5229d83d74f04586")
    assertTrue(fooms.newPool)
    assertNull(fooms.change24hPct)
    assertEquals(17, disc.rows.count { (it.ageDays ?: 99.0) < 1.0 })
    assertEquals(17, rows.values.count { it.newPool })
    assertTrue(rows.values.filter { it.newPool }.all { it.change24hPct == null })

    // A pool older than a day keeps the figure the index measured.
    val quanta = rows.getValue("0x1da81ca017949efbe07972776580d04592ba9b63")
    assertFalse(quanta.newPool)
    assertEquals(3824.305, quanta.change24hPct!!, 1e-9)
  }

  @Test fun anUnknownAgeIsNotAssumedOldEnough() {
    val coin = DiscoveryCoin(token = "0x" + "a".repeat(40), name = "X / WETH", change24hPct = 12.0, ageDays = null)
    assertNull(coinChange24h(coin))
    assertFalse(isNewPool(coin))
    assertEquals(12.0, coinChange24h(coin.copy(ageDays = 1.0))!!, 0.0)
    assertNull(coinChange24h(coin.copy(ageDays = 0.99)))
    assertNull(coinChange24h(coin.copy(ageDays = 3.0, change24hPct = Double.NaN)))
  }

  @Test fun aNullPriceIsADashAndAStockHasNoChange() {
    val rows = marketRows(market, disc)
    val unpriced = rows.filter { it.priceUsd == null }
    assertEquals(1, unpriced.size)
    assertEquals("—", fmtPrice(unpriced.single().priceUsd))
    assertTrue(rows.filter { !it.coin }.all { it.change24hPct == null })
    // Halted only where the chain asserted it: nobody is halted in the capture.
    assertTrue(rows.none { it.halted })
  }

  @Test fun theCaveatsTravelWithTheList() {
    val whole = marketCaveats(Loaded.Value(market), Loaded.Value(disc))
    assertTrue("a whole read says nothing", whole.isEmpty())

    val cut = marketCaveats(Loaded.Value(market), Loaded.Value(disc.copy(truncated = true)))
    assertEquals(1, cut.size)
    assertTrue(cut.single().contains("prefix of the market"))

    val blind = marketCaveats(Loaded.Value(market), Loaded.Value(disc.copy(indexUnreachable = true, rows = emptyList())))
    assertTrue(blind.single().contains("index didn't answer"))
    assertTrue(blind.single().contains("not an empty launchpad"))

    // A failed discoveries read is not an empty launchpad either; the stocks stay.
    val noCoins: Loaded<Discoveries> = ApiResult.Unreachable("timeout").toLoaded()
    val half = marketCaveats(Loaded.Value(market), noCoins)
    assertTrue(half.single().contains("Couldn't read the launchpad index"))
    assertEquals(25, marketRows(market, null).size)

    val stale = marketCaveats(Loaded.Value(market), Loaded.Value(disc), marketStale = true, discStale = true)
    assertEquals(2, stale.size)
    assertTrue(stale.all { it.contains("last read") })
  }

  @Test fun theCoinTickerIsTheWebs() {
    assertEquals("QUANTA", coinSymbolOf(DiscoveryCoin(name = "QUANTA / WETH")))
    assertEquals("HOODCATS", coinSymbolOf(DiscoveryCoin(name = "HOODCATS / WETH 0.25%")))
    assertEquals("TOKEN", coinSymbolOf(DiscoveryCoin(name = null)))
  }
}
