package dev.merrymen.app.orders

import dev.merrymen.app.chat.ChatRig
import dev.merrymen.app.chat.ChatRig.Companion.A
import dev.merrymen.app.chat.ChatRig.Companion.json
import dev.merrymen.app.ui.COMMANDS
import dev.merrymen.app.ui.LIMIT_UNREAD
import dev.merrymen.app.ui.LimitCheck
import dev.merrymen.app.ui.Placed
import dev.merrymen.app.ui.TradeDesk
import dev.merrymen.app.ui.TradeOpen
import dev.merrymen.app.ui.TradeStep
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * THE TRADE SCREEN PLACES NOTHING WITHOUT A CARD.
 *
 * It used to POST /api/orders on the tap of Buy, and "Find it and buy" bought
 * the coin the lookup matched without showing it. TradeDesk is the screen's
 * flow without the screen: opening a card only READS, the card's sentence is
 * the registry's, an amount past a limit the phone read is refused on the
 * card, and a snipe's lookup leads to a second card naming the coin.
 */
class TradeConfirmTest {
  private val rig = ChatRig()
  private val id = "d".repeat(32)
  private val scope = FakeScope(A)
  private val desk = TradeDesk(rig.api) { scope }

  @After fun stop() = rig.close()

  private fun grants(perTrade: Int) =
    rig.route("GET /api/grants") { json("""{"exists":true,"mode":"live","grant":{"caps":{"perTradeUsdg":$perTrade,"dailyUsdg":100}}}""") }

  private fun open(kind: String, subject: String, usdg: Double) =
    runBlocking { (desk.open(kind, subject, usdg) as TradeOpen.Card).card }

  @Test fun openingACardReadsAndNeverWrites() {
    grants(20)
    val card = open("buy", "nvda", 5.0)
    assertTrue("nothing but reads before the confirm", rig.writes().isEmpty())
    assertEquals(setOf("/api/orders/ceiling", "/api/grants"), rig.seen.map { it.path }.toSet())
    assertEquals(COMMANDS.getValue("buy").say(mapOf("symbol" to "NVDA", "usdgAmount" to "5.0")), card.sentence)
    assertEquals("Spend \$5.00 buying NVDA. I'll place it — my key's limits still decide whether it goes through.", card.sentence)
    assertTrue("it says real money", card.money.startsWith("Real money"))
    assertEquals(LimitCheck.Within, card.limit)
  }

  @Test fun theSealedCapBlocksTenWhenItIsFive() {
    grants(5)
    val card = open("buy", "NVDA", 10.0)
    val over = card.limit as LimitCheck.Over
    assertTrue(over.line.contains("\$5.00 per-trade cap"))
    assertFalse(card.canConfirm)
    val step = runBlocking { desk.confirm(card) }
    assertTrue(step is TradeStep.Said)
    assertTrue("refused here: nothing posted", rig.writes().isEmpty())
  }

  @Test fun theChatCeilingBlocksASellButTheBuyCapDoesNot() {
    grants(5)
    assertEquals("a sell to cash is not held to the per-trade cap", LimitCheck.Within, open("sell", "NVDA", 10.0).limit)
    rig.route("GET /api/orders/ceiling") { json("""{"ceilingUsdg":8}""") }
    val over = open("sell", "NVDA", 10.0).limit as LimitCheck.Over
    assertTrue(over.line.contains("\$8.00 limit"))
  }

  @Test fun anUnreadLimitIsSaidAndLeftToTheServer() {
    grants(20)
    rig.route("GET /api/orders/ceiling") { json("""{"error":"not signed in"}""", 401) }
    val card = open("buy", "NVDA", 5.0)
    assertEquals(LimitCheck.Unread(LIMIT_UNREAD), card.limit)
    assertTrue(card.canConfirm)
  }

  @Test fun confirmingPlacesOnceForTheOwnerOfTheCard() {
    grants(20)
    rig.route("POST /api/orders") { json("""{"id":"$id","queued":true,"expiresInMs":495000}""") }
    val card = open("buy", "NVDA", 5.0)
    val step = runBlocking { desk.confirm(card) } as TradeStep.Done
    assertEquals(id, (step.placed as Placed.Queued).id)
    val body = Json.parseToJsonElement(rig.writes().single().body).jsonObject
    assertEquals(JsonPrimitive(A), body["owner"])
    assertEquals(JsonPrimitive("NVDA"), body["symbol"])
    assertEquals(listOf(id to 495_000L), scope.followed)
  }

  @Test fun aSnipeShowsTheCoinItFoundBeforeBuyingIt() {
    grants(20)
    rig.route("POST /api/snipe") {
      json(
        """{"outcome":"resolved","target":{"symbol":"CASHCAT","address":"0x1da81ca017949efbe07972776580d04592ba9b63","short":"0x1da8…9b63"},
           "usdgAmount":5,"matchedOn":"name","say":"CASHCAT at 0x1da8…9b63 — matched on its name, not its ticker. Placing $5.00."}""",
      )
    }
    rig.route("POST /api/orders") { json("""{"id":"$id","queued":true,"expiresInMs":495000}""") }
    val first = open("snipe", "cash cat", 5.0)
    assertEquals(COMMANDS.getValue("snipe").say(mapOf("query" to "cash cat", "usdgAmount" to "5.0")), first.sentence)
    val next = (runBlocking { desk.confirm(first) } as TradeStep.Next).card
    assertEquals("the lookup placed nothing", listOf("/api/snipe"), rig.writes().map { it.path })
    assertEquals("CASHCAT", next.found!!.symbol)
    assertEquals("0x1da81ca017949efbe07972776580d04592ba9b63", next.found!!.address)
    assertEquals("buy", next.kind)
    assertTrue(next.sentence.startsWith("Spend \$5.00 buying CASHCAT."))
    runBlocking { desk.confirm(next) }
    assertEquals(listOf("/api/snipe", "/api/orders"), rig.writes().map { it.path })
  }

  @Test fun anAmbiguousNameIsAQuestionNotAPick() {
    grants(20)
    rig.route("POST /api/snipe") {
      json("""{"outcome":"ambiguous","candidates":[],"say":"2 different coins answer to “NEON” — tell me which address: 0xaaaa…1111, 0xbbbb…2222"}""")
    }
    val step = runBlocking { desk.confirm(open("snipe", "neon", 5.0)) } as TradeStep.Said
    assertTrue(step.line.contains("0xaaaa…1111, 0xbbbb…2222"))
    assertTrue(rig.writes().none { it.path == "/api/orders" })
  }

  @Test fun signedOutThereIsNoCardToConfirm() {
    val nobody = TradeDesk(rig.api) { null }
    assertTrue(runBlocking { nobody.open("buy", "NVDA", 5.0) } is TradeOpen.No)
    assertTrue(rig.seen.isEmpty())
  }
}
