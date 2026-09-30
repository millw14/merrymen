package dev.merrymen.app.chat

import dev.merrymen.app.net.Feed
import dev.merrymen.app.net.Fixtures
import dev.merrymen.app.net.GrantView
import dev.merrymen.app.net.SettingsEnvelope
import dev.merrymen.app.ui.autonomyLabel
import dev.merrymen.app.ui.chatStateOf
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * WHAT THE AGENT IS TOLD ABOUT ITS OWN MONEY.
 *
 * The server's prompt says reading paperTradingEnabled as the mode is "the one
 * mistake here that costs real money", and the phone sent only that. These
 * hold the state to the web's chatStateOf over real captures: the settings
 * fixture is production's own signed-out answer (values empty, defaults full).
 */
class ChatStateTest {
  private val json = Json { ignoreUnknownKeys = true; explicitNulls = false; isLenient = true }
  private val settings = json.decodeFromString<SettingsEnvelope>(Fixtures.text("probe-settings-signedout.json"))
  private val now = 1_790_000_000_000L

  private val feed = json.decodeFromString<Feed>(
    """{"source":"sqlite","agent":{"slug":"shogun","name":"Shogun","strategy":"steady-basket","nameSource":"settings"},
      "positions":[
        {"symbol":"NVDA","value_usdg":12.5,"price_stale":0,"cost_usdg":10.0,"cost_from_quote":false,"stop_floor_bps":1800,"stop_floor_why":"thin book"},
        {"symbol":"CASHCAT","value_usdg":4.0,"price_stale":0,"cost_usdg":5.0,"cost_from_quote":true},
        {"symbol":"TSLA","value_usdg":9.0,"price_stale":1}
      ],
      "equity":[{"equity_usdg":30.0,"cash_usdg":2.0},{"equity_usdg":40.0,"cash_usdg":14.5,"vault_usdg":0.0}],
      "trades":[
        {"status":"landed","fill_side":"buy","symbol":"NVDA","amount_usdg":10.0,"created_at":"2026-09-20 10:00:00"},
        {"status":"rejected","action":"buy","symbol":"CASHCAT","amount_usdg":5.0,"reject_rule":"per-trade-cap","created_at":"2026-09-24 09:00:00"},
        {"status":"submitted","buy_token":"0x322F0929c4625eD5bAd873c95208D54E1c003b2d","amount_usdg":3.0,"created_at":"2026-09-22 09:00:00"}
      ]}""",
  )

  private val paper = json.decodeFromString<GrantView>(
    """{"exists":true,"mode":"paper","liveBlocker":"live-not-enabled","grant":{"caps":{"perTradeUsdg":20,"dailyUsdg":100}}}""",
  )

  private fun state(f: Feed? = feed, s: SettingsEnvelope? = settings, g: GrantView? = paper) = chatStateOf(f, s, g, now)

  @Test fun theModeIsSentAndComesFromTheDefaultsWhenTheOwnerNeverSetIt() {
    val st = state()
    assertEquals("liveTradingEnabled is present, from defaults", JsonPrimitive(false), st["liveTradingEnabled"])
    assertEquals(JsonPrimitive(true), st["paperTradingEnabled"])
    assertEquals(JsonPrimitive("PAPER"), st["workerStatus"])
    assertEquals(JsonPrimitive("live-not-enabled"), st["liveBlocker"])
  }

  @Test fun theOwnersOwnValueWinsAndAnUnreadSettingsReadIsNullNotADefault() {
    val live = settings.copy(values = JsonObject(mapOf("liveTradingEnabled" to JsonPrimitive(true))))
    assertEquals(JsonPrimitive(true), state(s = live)["liveTradingEnabled"])
    val unread = state(s = null)
    for (k in listOf("liveTradingEnabled", "paperTradingEnabled", "basketSymbols", "stopLossBps", "takeProfitBps")) {
      assertEquals("$k with settings unread", JsonNull, unread[k])
    }
  }

  @Test fun theBasketIsTheArrayOrNullNeverAGuessedEmptyList() {
    assertEquals(listOf("QQQ", "NVDA", "TSLA"), state()["basketSymbols"]!!.jsonArray.map { it.jsonPrimitive.content })
    val emptied = settings.copy(values = JsonObject(mapOf("basketSymbols" to JsonArray(emptyList()))))
    assertEquals("an owner's saved empty basket is kept", JsonArray(emptyList()), state(s = emptied)["basketSymbols"])
    val noDefaults = settings.copy(defaults = JsonObject(emptyMap()))
    assertEquals("absent everywhere is null", JsonNull, state(s = noDefaults)["basketSymbols"])
  }

  @Test fun movesAreNewestFirstWithTheirTimesAndTheRuleInWords() {
    val moves = state()["moves"]!!.jsonArray.map { it.jsonObject }
    assertEquals(listOf("CASHCAT", "TSLA", "NVDA"), moves.map { it["symbol"]!!.jsonPrimitive.content })
    assertEquals(1_790_240_400L, moves[0]["at"]!!.jsonPrimitive.content.toLong())
    assertEquals("refused", moves[0]["outcome"]!!.jsonPrimitive.content)
    assertEquals("past the per-trade cap", moves[0]["outcomeText"]!!.jsonPrimitive.content)
    assertEquals("a submitted trade is pending, never landed", "pending", moves[1]["outcome"]!!.jsonPrimitive.content)
    assertEquals("the stock pair names a row the ledger did not", "buy", moves[1]["action"]!!.jsonPrimitive.content)
    assertEquals(JsonPrimitive(3), state()["movesShown"])
    assertEquals(JsonPrimitive(3), state()["movesTotal"])
  }

  @Test fun aCostBookedFromTheQuoteHasNoReturnAndAnUnknownCostIsNull() {
    val pos = state()["positions"]!!.jsonArray.map { it.jsonObject }.associateBy { it["symbol"]!!.jsonPrimitive.content }
    assertEquals(JsonPrimitive(25.0), pos.getValue("NVDA")["unrealisedPct"])
    assertEquals(JsonPrimitive(true), pos.getValue("NVDA")["costConfirmed"])
    assertEquals(JsonPrimitive(1800), pos.getValue("NVDA")["stopLossBps"])
    assertEquals(JsonNull, pos.getValue("CASHCAT")["unrealisedPct"])
    assertEquals(JsonPrimitive(false), pos.getValue("CASHCAT")["costConfirmed"])
    assertEquals(JsonNull, pos.getValue("TSLA")["costUsd"])
    assertEquals(JsonNull, pos.getValue("TSLA")["costConfirmed"])
    assertEquals(JsonPrimitive(true), pos.getValue("TSLA")["priceStale"])
  }

  @Test fun cashCapsAndTheStopComeFromWhereTheyLive() {
    val st = state()
    assertEquals(JsonPrimitive(14.5), st["cashUsd"])
    assertEquals(JsonPrimitive(40.0), st["equity"])
    assertEquals(JsonPrimitive(20.0), st["perTrade"])
    assertEquals(JsonPrimitive(100.0), st["perDay"])
    assertEquals(JsonPrimitive(false), st["stopped"])
    assertEquals("the default stop is a level of zero, sent as a number", JsonPrimitive(0.0), st["stopLossBps"])
  }

  @Test fun aFeedThatWasNotReadIsNotAnEmptyBook() {
    // Production's own signed-out /api/feed: source "none", the fallback name.
    val unread = json.decodeFromString<Feed>(Fixtures.text("probe-feed-signedout.json"))
    val st = state(f = unread, g = null)
    assertEquals("not 'no positions'", JsonNull, st["positions"])
    assertEquals(JsonNull, st["moves"])
    assertEquals("not the fallback Robin", JsonNull, st["name"])
    assertEquals(JsonPrimitive("Unknown"), st["workerStatus"])
    assertEquals(JsonNull, st["stopped"])
  }

  @Test fun theWorkerStatusIsTheAutonomyLabel() {
    fun g(s: String) = json.decodeFromString<GrantView>(s)
    assertEquals("LIVE", autonomyLabel(g("""{"exists":true,"mode":"live"}"""), now))
    assertEquals("BLOCKED", autonomyLabel(g("""{"exists":true,"mode":"paper","liveBlocker":"dead-policy"}"""), now))
    assertEquals(
      "a verdict about a key already replaced",
      "CHECKING",
      autonomyLabel(g("""{"exists":true,"mode":"paper","liveBlocker":"dead-policy","workerAliveAt":100,"grant":{"grantedAt":200}}"""), now),
    )
    assertEquals("BLOCKED", autonomyLabel(g("""{"exists":true,"mode":"live","grant":{"expiresAt":1}}"""), now))
    assertEquals("IDLE", autonomyLabel(g("""{"exists":true,"liveBlocker":"no-gas"}"""), now))
    assertEquals(null, autonomyLabel(g("""{"exists":false}"""), now))
    assertTrue(state().toString().contains("\"workerStatus\":\"PAPER\""))
  }
}
