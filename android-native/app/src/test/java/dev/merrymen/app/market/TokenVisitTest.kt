package dev.merrymen.app.market

import dev.merrymen.app.data.Loaded
import dev.merrymen.app.net.Fixtures
import dev.merrymen.app.net.apiFor
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

/**
 * ONE VISIT, ONE ?activity=1.
 *
 * The emulator pass, on PEAR's page: turning the phone logged GET
 * /api/tokens/…?window=1h&activity=1 again, and turning it back a third time,
 * because the reads lived in the screen's composition and a rotation rebuilds
 * it. The visit now outlives the composition; a recreated screen calls
 * [TokenVisit.open] again, as here, and nothing is asked.
 */
class TokenVisitTest {
  private val coin = "0x1da81ca017949efbe07972776580d04592ba9b63"
  private lateinit var server: MockWebServer
  private val asked = CopyOnWriteArrayList<String>()
  @Volatile private var failFirst = false

  @Before fun start() {
    server = MockWebServer()
    server.dispatcher = object : Dispatcher() {
      override fun dispatch(request: RecordedRequest): MockResponse {
        val p = request.path ?: ""
        asked += p
        if (failFirst && asked.size == 1) return MockResponse().setResponseCode(503).setBody("""{"error":"down"}""")
        // The captured coin document answers every span; with activity=1 it carries the pool's trades.
        return if (p.startsWith("/api/tokens/$coin?window=")) {
          MockResponse().setHeader("content-type", "application/json").setBody(Fixtures.text("probe-token-coin.json"))
        } else {
          MockResponse().setResponseCode(404)
        }
      }
    }
    server.start()
  }

  @After fun stop() = server.shutdown()

  private fun visitOn(scope: CoroutineScope) = TokenVisit(apiFor(server), coin, scope)

  private suspend fun TokenVisit.readFinished(): TokenView =
    withTimeout(5_000) { view.first { it.detail !is Loaded.Loading && (it.detail !is Loaded.Value || it.bars !is Loaded.Loading) } }

  private fun activityCalls() = asked.count { it.endsWith("&activity=1") }

  @Test fun aRecreatedPageAsksNothingAgain() = runBlocking {
    val visit = visitOn(this)
    visit.open()
    val v = visit.readFinished()
    assertTrue(v.detail is Loaded.Value)
    assertTrue("the pool's trades were read", v.activity is ActivityRead.Read)
    assertEquals(listOf("/api/tokens/$coin?window=1h&activity=1"), asked)

    // A rotation: the page is composed again and opens the same visit.
    visit.open()
    visit.open()
    assertEquals("nothing went back to loading", v, visit.view.value)
    visit.readFinished()
    assertEquals("one read for the whole visit", 1, asked.size)
  }

  /** The span the reader picked survives too, and picking it again asks nothing. */
  @Test fun aSpanChangeReadsBarsOnceAndNotThePoolsTrades() = runBlocking {
    val visit = visitOn(this)
    visit.open()
    visit.readFinished()

    visit.show("1H")
    val v = visit.readFinished()
    assertEquals("1H", v.window)
    assertEquals("/api/tokens/$coin?window=15m", asked.last())
    visit.open() // the page recreated on 1H
    visit.show("1H")
    assertEquals("nothing went back to loading", v, visit.view.value)
    visit.readFinished()
    assertEquals(2, asked.size)
    assertEquals(1, activityCalls())
  }

  /** A new visit — the page opened again — is a new first read. */
  @Test fun aNewVisitAsksForThePoolsTradesAgain() = runBlocking {
    val first = visitOn(this)
    first.open()
    first.readFinished()
    val second = visitOn(this)
    second.open()
    second.readFinished()
    assertEquals(2, activityCalls())
  }

  /** A first read that failed never settled the trades: Try again asks for them. */
  @Test fun tryAgainAfterAFailedFirstReadAsksForTheTradesThen() = runBlocking {
    failFirst = true
    val visit = visitOn(this)
    visit.open()
    val failed = visit.readFinished()
    assertTrue(failed.detail is Loaded.Refused)
    assertEquals(ActivityRead.Unasked, failed.activity)

    visit.retry()
    // The refusal stays on screen until the new answer replaces it.
    val v = withTimeout(5_000) { visit.view.first { it.detail is Loaded.Value && it.bars !is Loaded.Loading } }
    assertTrue(v.activity is ActivityRead.Read)
    assertEquals(2, activityCalls())
  }
}
