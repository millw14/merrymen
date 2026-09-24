package dev.merrymen.app.net

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
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
 * EVERY CAPTURED PRODUCTION ANSWER, THROUGH THE REAL CLIENT.
 *
 * Each fixture is served from the path it was captured on and read back with
 * the method a screen calls, so this covers the URL, the decode and the model
 * together. It asserts the facts the screens are about to be built on — the
 * signed-out feed is source "none" with a fallback name, 25 of 30 board rows
 * are paper, a Trencher T-id carries its coin's name — because a model that
 * decodes but drops those fields is the bug that `ignoreUnknownKeys` turns into
 * silence.
 */
class DecodeFixturesTest {
  private lateinit var server: MockWebServer
  private lateinit var api: MerrymenApi

  /** Route → (fixture, status). The ceiling was captured signed out, as its 401. */
  private val routes = mapOf(
    "/api/version" to ("probe-version.json" to 200),
    "/api/auth/session" to ("probe-auth_session.json" to 200),
    "/api/feed" to ("probe-feed-signedout.json" to 200),
    "/api/theses" to ("probe-theses.json" to 200),
    "/api/leaderboard" to ("probe-leaderboard.json" to 200),
    "/api/market" to ("probe-market.json" to 200),
    "/api/alpha" to ("probe-alpha-signedout.json" to 200),
    "/api/agents/q4sxmmxay96ew2vq" to ("probe-agent.json" to 200),
    "/api/groupchat?limit=2" to ("probe-groupchat_limit_2.json" to 200),
    "/api/orders/ceiling" to ("probe-orders_ceiling.json" to 401),
  )

  @Before fun start() {
    server = MockWebServer()
    server.dispatcher = object : Dispatcher() {
      override fun dispatch(request: RecordedRequest): MockResponse {
        val (file, code) = routes[request.path] ?: return MockResponse().setResponseCode(599)
        return MockResponse().setResponseCode(code).setHeader("content-type", "application/json")
          .setBody(Fixtures.text(file))
      }
    }
    server.start()
    api = apiFor(server)
  }

  @After fun stop() = server.shutdown()

  private fun <T> ok(r: ApiResult<T>): T = when (r) {
    is ApiResult.Ok -> r.value
    else -> { fail("expected Ok, got $r"); error("unreachable") }
  }

  @Test fun everyFixtureHasARoute() {
    // A fixture copied in and never decoded is a check nobody runs.
    assertEquals(Fixtures.names().toSet(), routes.values.map { it.first }.toSet())
  }

  @Test fun version() = runBlocking {
    assertEquals("0.21.0", ok(api.version()).version)
  }

  @Test fun session() = runBlocking {
    val s = ok(api.session())
    assertEquals(true, s.hosted)
    assertNull(s.address)
  }

  @Test fun signedOutFeedIsUnreadableNotAnAccount() = runBlocking {
    val f = ok(api.feed())
    assertEquals("none", f.source)
    assertEquals("Robin", f.agent?.name)
    assertEquals("fallback", f.agent?.nameSource)
    assertNull(f.agent?.slug)
    assertEquals(listOf("QQQ", "NVDA", "TSLA"), f.agent?.basket)
    assertTrue(f.trades.isEmpty())
    assertEquals(0, f.landed)
    assertNull("an unknown contribution is null, never 0", f.netContributionsUsdg)
    assertNull(f.contributionsKnown)
    assertEquals(0, f.gasUnpricedTrades)
  }

  @Test fun theses() = runBlocking {
    val page = ok(api.theses())
    assertEquals("sqlite", page.source)
    assertEquals(false, page.tradesComplete)
    assertEquals(80, page.theses.size)
    // The rows the old verbs mislabel: vault moves (no action, landed) and views.
    assertEquals(9, page.theses.count { it.action == null && it.outcome == "landed" })
    assertEquals(38, page.theses.count { it.outcome == "view" })
    // A Trencher id arrives with the coin's name beside it.
    val chump = page.theses.first { it.symbol == "T7631DACC21B" }
    assertEquals("CHUMP", chump.displayName)
    // The new per-call fields decode where the server sent them.
    assertTrue(page.theses.all { it.said != null && it.firstAt != null })
    assertTrue(page.theses.any { it.entryPriceUsd != null })
    assertTrue(page.theses.any { it.markUsd != null })
    assertTrue(page.theses.any { it.post != null })
    assertTrue(page.theses.all { it.trencher != null })
  }

  @Test fun leaderboardCarriesPaperRows() = runBlocking {
    val b = ok(api.leaderboard())
    assertEquals("sqlite", b.source)
    assertEquals(43, b.retired)
    assertEquals(30, b.agents.size)
    val paper = b.agents.filter { it.mode == "paper" }
    assertEquals(25, paper.size)
    assertTrue(paper.all { it.unrankedWhy == "paper" && it.pnlBps == null })
    assertEquals(17, paper.count { it.paperPnlBps != null })
    assertTrue(b.agents.all { it.filledPaper != null })
  }

  @Test fun market() = runBlocking {
    val m = ok(api.market())
    assertEquals(25, m.tokens.size)
    assertEquals("AAPL", m.tokens.first().symbol)
  }

  @Test fun lockedAlphaCarriesItsPerks() = runBlocking {
    val a = ok(api.alpha())
    assertTrue(a.locked)
    assertEquals("sign-in", a.why)
    assertEquals(4, a.pickCount)
    assertEquals(4, a.need?.perks?.size)
    assertNull(a.tier)
    assertNull("locked says nothing about research", a.researched)
  }

  @Test fun agentProfileAndItsTheses() = runBlocking {
    val raw = ok(api.agent("q4sxmmxay96ew2vq")) as JsonObject
    // The per-agent route's own theses decode with the same Thesis model.
    val theses = api.json.decodeFromJsonElement(ListSerializer(Thesis.serializer()), raw.getValue("theses"))
    assertEquals(4, theses.size)
    assertTrue(theses.all { it.slug == "q4sxmmxay96ew2vq" })
  }

  @Test fun anEndpointAddedAsAnExtensionReadsThroughTheSamePlumbing() = runBlocking {
    // How a later branch adds a route: getJson from outside MerrymenApi.kt.
    val room = ok(api.getJson<JsonElement>("/api/groupchat?limit=2")) as JsonObject
    assertEquals("\"db\"", room.getValue("source").toString())
    val ceiling = api.getJson<JsonElement>("/api/orders/ceiling")
    assertEquals(ApiResult.Refused(401, "not signed in"), ceiling)
  }

  @Test fun anUnknownPathIsNotOk() = runBlocking {
    // The dispatcher's own guard: a URL typo must not pass for a decode.
    assertFalse(api.getJson<JsonElement>("/api/nope") is ApiResult.Ok)
  }
}
