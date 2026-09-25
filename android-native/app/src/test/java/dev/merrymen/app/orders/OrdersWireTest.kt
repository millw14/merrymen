package dev.merrymen.app.orders

import dev.merrymen.app.net.Fixtures
import dev.merrymen.app.net.HTML_PAGE
import dev.merrymen.app.net.MerrymenApi
import dev.merrymen.app.net.OriginSource
import dev.merrymen.app.net.RouteAnswer
import dev.merrymen.app.net.answer
import dev.merrymen.app.net.apiFor
import dev.merrymen.app.net.lookupSnipe
import dev.merrymen.app.net.openOrder
import dev.merrymen.app.net.orderCeiling
import dev.merrymen.app.net.pollOrder
import dev.merrymen.app.net.postOrder
import dev.merrymen.app.net.putSettingsFor
import dev.merrymen.app.net.text
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.TimeUnit

/**
 * A LOST ANSWER IS NOT A REFUSAL, over the real client.
 *
 * The order routes are read by hand (net/OrdersWire.kt) because the one fact
 * that matters — did the ROUTE write this error, or did nobody answer — is
 * erased by the shared call's generic 5xx sentence. These pin each shape the
 * web's routeAnswer tells apart.
 */
class OrdersWireTest {
  private lateinit var server: MockWebServer
  private lateinit var api: MerrymenApi

  @Before fun start() {
    server = MockWebServer()
    server.start()
    api = apiFor(server, OkHttpClient.Builder().readTimeout(2, TimeUnit.SECONDS).build())
  }

  @After fun stop() = server.shutdown()

  private fun sentBody(): JsonObject = Json.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject

  @Test fun theOwnerWhoConfirmedTravelsWithTheOrder() = runBlocking {
    server.answer("""{"id":"${"a".repeat(32)}","queued":true,"expiresAt":1000495000,"expiresInMs":495000}""")
    val r = api.postOrder("buy", "TSLA", 5.0, owner = "0xabc")
    assertEquals(200, (r as RouteAnswer.Said).status)
    assertEquals("a".repeat(32), r.body.text("id"))
    val body = sentBody()
    assertEquals(JsonPrimitive("0xabc"), body["owner"])
    assertEquals(JsonPrimitive("buy"), body["side"])
    assertEquals(JsonPrimitive(5.0), body["usdgAmount"])
  }

  @Test fun noOwnerSendsNoOwnerKey() = runBlocking {
    server.answer("""{"id":"x","queued":true}""")
    api.postOrder("sell", "NVDA", 1.0, owner = null)
    assertFalse(sentBody().containsKey("owner"))
  }

  @Test fun theRoutesOwnRefusalsAreAnswersWithTheirWords() = runBlocking {
    server.answer("""{"error":"this browser is signed in with a different wallet now"}""", code = 409)
    val owner = api.postOrder("buy", "TSLA", 5.0, "0xabc") as RouteAnswer.Said
    assertEquals(409, owner.status)
    assertEquals("this browser is signed in with a different wallet now", owner.body.text("error"))

    // The route's 503 is JSON it wrote: "couldn't queue it" — nothing was written.
    server.answer("""{"error":"couldn't queue it — the ledger is unreachable"}""", code = 503)
    val down = api.postOrder("buy", "TSLA", 5.0, "0xabc") as RouteAnswer.Said
    assertEquals(503, down.status)
    assertFalse(down.ok)
  }

  @Test fun aGatewayPageIsNobodysAnswer() = runBlocking {
    server.answer(HTML_PAGE, code = 502, type = "text/html")
    assertEquals(RouteAnswer.Lost, api.postOrder("buy", "TSLA", 5.0, "0xabc"))
  }

  @Test fun aDroppedConnectionIsNobodysAnswer() = runBlocking {
    server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
    assertEquals(RouteAnswer.Lost, api.postOrder("buy", "TSLA", 5.0, "0xabc"))
  }

  @Test fun aTimeoutIsNobodysAnswer() = runBlocking {
    server.enqueue(
      MockResponse().setHeader("content-type", "application/json").setBody("{}").setHeadersDelay(4, TimeUnit.SECONDS),
    )
    assertEquals(RouteAnswer.Lost, api.postOrder("buy", "TSLA", 5.0, "0xabc"))
  }

  @Test fun aSuccessThatCannotBeReadIsStillASuccessWithNoBody() = runBlocking {
    server.answer(HTML_PAGE, code = 200, type = "text/html")
    val r = api.postOrder("buy", "TSLA", 5.0, "0xabc") as RouteAnswer.Said
    assertTrue(r.ok)
    assertNull("a row exists but nothing about it can be read", r.body)
  }

  @Test fun aStoredAddressThatIsNotAWebAddressSendsNothing() = runBlocking {
    val broken = MerrymenApi(OkHttpClient(), OriginSource { "app.merrymen.dev" })
    assertTrue(broken.postOrder("buy", "TSLA", 5.0, "0xabc") is RouteAnswer.NotSent)
    assertEquals(0, server.requestCount)
  }

  @Test fun theSnipeLookupAndASettingsWriteNameTheOwnerToo() = runBlocking {
    server.answer("""{"outcome":"not-found","say":"nothing"}""")
    api.lookupSnipe("pepe", 20.0, "0xabc")
    val snipe = sentBody()
    assertEquals(JsonPrimitive("pepe"), snipe["query"])
    assertEquals(JsonPrimitive("0xabc"), snipe["owner"])

    server.answer("""{"ok":true}""")
    api.putSettingsFor(JsonObject(mapOf("liveTradingEnabled" to JsonPrimitive(false))), "0xabc")
    val put = server.takeRequest()
    assertEquals("PUT", put.method)
    val body = Json.parseToJsonElement(put.body.readUtf8()).jsonObject
    assertEquals(JsonPrimitive("0xabc"), body["owner"])
    assertEquals(JsonPrimitive(false), body["liveTradingEnabled"])
  }

  // ── the ceiling ─────────────────────────────────────────────────────────

  @Test fun theCeilingIsReadOnlyAsAFiniteNumber() = runBlocking {
    server.answer("""{"ceilingUsdg":25}""")
    assertEquals(25.0, api.orderCeiling()!!, 0.0)
    server.answer("""{"ceilingUsdg":0}""")
    assertEquals("zero is a value: no chat ceiling", 0.0, api.orderCeiling()!!, 0.0)
    server.answer("""{"ceilingUsdg":"25"}""")
    assertNull(api.orderCeiling())
    server.answer("""{"ceilingUsdg":-1}""")
    assertNull(api.orderCeiling())
    server.answer(HTML_PAGE, type = "text/html")
    assertNull(api.orderCeiling())
  }

  @Test fun signedOutTheCeilingIsUnread() = runBlocking {
    // The signed-out production answer: 401 {"error":"not signed in"}.
    server.answer(Fixtures.text("probe-orders_ceiling.json"), code = 401)
    assertNull(api.orderCeiling())
  }

  // ── polls ───────────────────────────────────────────────────────────────

  @Test fun aPollKeepsItsAnswerWhenOneReceiptFieldIsTheWrongShape() = runBlocking {
    server.answer(
      """{"id":"x","state":"done","result":"Bought CASHCAT.",
         "receipt":{"status":"filled","side":"buy","symbol":"CASHCAT","usdgActual":"5","txHash":"nope"}}""",
    )
    val p = api.pollOrder("a".repeat(32))!!
    assertEquals("done", p.state)
    assertEquals("Bought CASHCAT.", p.result)
    assertEquals("filled", p.receipt!!.status)
    assertNull("a figure sent as text is unread, never guessed", p.receipt!!.usdgActual)
    assertNull(p.receipt!!.txHash)
  }

  @Test fun aReceiptSentAsJsonTextIsRead() = runBlocking {
    server.answer("""{"state":"done","result":"x","receipt":"{\"status\":\"refused\",\"rejectRule\":\"per-trade-cap\"}"}""")
    val p = api.pollOrder("a".repeat(32))!!
    assertEquals("refused", p.receipt!!.status)
    assertEquals("per-trade-cap", p.receipt!!.rejectRule)
  }

  @Test fun aReceiptWithNoStatusIsNoReceipt() = runBlocking {
    server.answer("""{"state":"done","result":"x","receipt":{"side":"buy","usdgActual":5}}""")
    assertNull(api.pollOrder("a".repeat(32))!!.receipt)
  }

  @Test fun anUnreadableLedgerIsNoAnswerYet() = runBlocking {
    server.answer("""{"error":"the ledger could not be read"}""", code = 503)
    assertNull(api.pollOrder("a".repeat(32)))
  }

  @Test fun anIdThatIsNotAHashIsNeverPutInAUrl() = runBlocking {
    assertNull(api.pollOrder("../grants"))
    assertEquals(0, server.requestCount)
  }

  @Test fun theOpenOrderIsLookedUpForTheOwnerAndOnlyWhileOpen() = runBlocking {
    val id = "b".repeat(32)
    server.answer("""{"id":"$id","state":"running"}""")
    assertEquals(id, api.openOrder("0xabc"))
    assertEquals("/api/orders?owner=0xabc", server.takeRequest().path)

    server.answer("""{"id":"$id","state":"done","result":"x"}""")
    assertNull("a finished order is not the one this placement made", api.openOrder("0xabc"))
    server.answer("""{"error":"signed in with a different wallet"}""", code = 409)
    assertNull(api.openOrder("0xabc"))
    server.answer("""{"state":"none"}""")
    assertNull(api.openOrder(null))
  }
}
