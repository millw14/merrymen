package dev.merrymen.app.net

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * THE THREE STATES, AND WHAT THE WRITES PUT ON THE WIRE.
 *
 * `ApiResult` is the one place every screen learns whether it has a value, a
 * refusal the server explained, or no answer at all, so its edges are tested
 * against a real socket rather than assumed.
 */
class ApiResultTest {
  private lateinit var server: MockWebServer
  private lateinit var api: MerrymenApi

  @Before fun start() {
    server = MockWebServer()
    server.start()
    api = apiFor(server)
  }

  @After fun stop() = server.shutdown()

  private fun sentBody(): JsonObject =
    api.json.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject

  // ── refusals ──────────────────────────────────────────────────────────────

  @Test fun aValidationListIsJoinedOneLineEach() = runBlocking {
    server.answer("""{"errors":["slippageBps: must be a number between 1 and 1000","name: too long"]}""", 400)
    assertEquals(
      ApiResult.Refused(400, "slippageBps: must be a number between 1 and 1000\nname: too long"),
      api.settings(),
    )
  }

  @Test fun aSignedOutRefusalKeepsItsStatusAndSentence() = runBlocking {
    server.answer("""{"error":"not signed in"}""", 401)
    assertEquals(ApiResult.Refused(401, "not signed in"), api.feed())
  }

  @Test fun aRateLimitCarriesItsRetryAfter() = runBlocking {
    server.enqueue(
      okhttp3.mockwebserver.MockResponse().setResponseCode(429).setHeader("Retry-After", "7")
        .setHeader("content-type", "application/json")
        .setBody("""{"error":"You're posting fast. Wait a few seconds and try again."}"""),
    )
    val r = api.getJson<kotlinx.serialization.json.JsonElement>("/api/groupchat")
    assertEquals(ApiResult.Refused(429, "You're posting fast. Wait a few seconds and try again.", 7), r)
    // Absent is null, never a guessed wait.
    server.answer("""{"error":"not signed in"}""", 401)
    assertEquals(null, (api.feed() as ApiResult.Refused).retryAfterSec)
  }

  @Test fun noAnswerIsUnreachableNotRefused() = runBlocking {
    server.shutdown()
    assertTrue(api.version() is ApiResult.Unreachable)
  }

  // ── what the writes send ──────────────────────────────────────────────────

  @Test fun patchSettingsMergesTheOwnerTheFormWasReadFor() = runBlocking {
    server.answer("""{"ok":true,"appliesWithin":"one worker tick","ignored":["notAKey"]}""")
    val saved = api.patchSettings(JsonObject(mapOf("slippageBps" to JsonPrimitive(50))), owner = "0xabc")
    val body = sentBody()
    assertEquals(JsonPrimitive("0xabc"), body["owner"])
    assertEquals(JsonPrimitive(50), body["slippageBps"])
    // The success shape is its own type now, and `ignored` survives the decode.
    val v = (saved as ApiResult.Ok).value
    assertEquals(listOf("notAKey"), v.ignored)
    assertEquals("one worker tick", v.appliesWithin)
    assertTrue(v.errors.isEmpty())
  }

  @Test fun aFormReadSignedOutSendsAnEmptyOwnerNotNone() = runBlocking {
    // "" is the server's "read for nobody" and saves for nobody; dropping it
    // would let the save land on whoever is signed in now.
    server.answer("""{"ok":true}""")
    api.patchSettings(JsonObject(mapOf("assetMode" to JsonPrimitive("stocks"))), owner = "")
    assertEquals(JsonPrimitive(""), sentBody()["owner"])
  }

  @Test fun noOwnerMeansNoOwnerKey() = runBlocking {
    server.answer("""{"ok":true}""")
    api.patchSettings(JsonObject(mapOf("assetMode" to JsonPrimitive("all"))))
    assertFalse(sentBody().containsKey("owner"))
  }

  @Test fun anOrderCarriesItsOwnerOnlyWhenGiven() = runBlocking {
    server.answer("""{"id":"o1","queued":true,"expiresAt":1790285000000,"expiresInMs":495000}""")
    val placed = api.order("buy", "NVDA", 5.0, owner = "0xabc")
    val body = sentBody()
    assertEquals(JsonPrimitive("0xabc"), body["owner"])
    assertEquals(JsonPrimitive(5.0), body["usdgAmount"])
    assertEquals(495_000L, (placed as ApiResult.Ok).value.expiresInMs)

    server.answer("""{"id":"o2","queued":true}""")
    api.order("sell", "NVDA", 1.0)
    assertFalse(sentBody().containsKey("owner"))
  }

  @Test fun aSnipeCarriesItsOwner() = runBlocking {
    server.answer("""{"outcome":"ambiguous","candidates":[],"total":0}""")
    api.snipe("chump", 2.0, owner = "0xabc")
    assertEquals(JsonPrimitive("0xabc"), sentBody()["owner"])
  }

  @Test fun orderStateCarriesTheWorkersReceipt() = runBlocking {
    server.answer(
      """{"id":"o1","state":"done","result":"filled","at":1,"expiresAt":2,
         "receipt":{"status":"filled","side":"buy","symbol":"CASHCAT","token":null,
                    "usdgActual":5.0,"txHash":null,"rejectRule":null}}""",
    )
    val s = (api.orderStatus("o1") as ApiResult.Ok).value
    assertEquals("filled", s.receipt?.status)
    assertEquals(5.0, s.receipt?.usdgActual)
    assertEquals(2L, s.expiresAt)
  }

  @Test fun tokenAsksForActivityOnlyWhenTold() = runBlocking {
    server.answer("""{}""")
    api.token("0xabc", "1h")
    assertEquals("/api/tokens/0xabc?window=1h", server.takeRequest().path)
    server.answer("""{"evidence":{"trades":{"data":[]}}}""")
    val d = api.token("0xabc", "15m", activity = true)
    assertEquals("/api/tokens/0xabc?window=15m&activity=1", server.takeRequest().path)
    assertTrue((d as ApiResult.Ok).value.evidence is JsonObject)
  }

  @Test fun grantCapsAreReadOnlyWhenTheyAreNumbers() = runBlocking {
    server.answer(
      """{"exists":true,"mode":"paper","liveBlocker":null,"workerAliveAt":1790284000000,
         "balances":{"ethWei":null,"cashUsdg":"12.5","vaultUsdg":"0"},
         "grant":{"caps":{"perTradeUsdg":5,"dailyUsdg":"50"}}}""",
    )
    val g = (api.grants() as ApiResult.Ok).value
    assertEquals(5.0, g.perTradeUsdg)
    // A string cap is one nobody can vouch for: unread, not 50.
    assertEquals(null, g.dailyUsdg)
    assertEquals(null, g.balances?.ethWei)
    assertEquals("0", g.balances?.vaultUsdg)
    assertEquals("paper", g.mode)
  }
}
