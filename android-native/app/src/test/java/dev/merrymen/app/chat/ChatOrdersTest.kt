package dev.merrymen.app.chat

import dev.merrymen.app.chat.ChatRig.Companion.A
import dev.merrymen.app.chat.ChatRig.Companion.json
import dev.merrymen.app.data.receiptText
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * AN ORDER CONFIRMED IN CHAT IS FOLLOWED BY THE THREAD, NOT THE SCREEN.
 *
 * Chat-confirmed orders were never followed at all. Now the thread places the
 * order, says "placed, not filled", follows it in the app's scope, and the
 * worker's answer lands as a templated receipt — with the dot lit when Chat is
 * not on screen, and resumed after a cold start from the deadline it kept.
 */
class ChatOrdersTest {
  private val rig = ChatRig()
  private val id = "e".repeat(32)

  @After fun stop() = rig.close()

  private fun proposeBuy(amount: Int) = rig.route("POST /api/chat") {
    json("""{"reply":"I can do that.","command":{"id":"buy","args":{"symbol":"NVDA","usdgAmount":$amount}}}""")
  }

  @Test fun aConfirmedBuyIsPlacedFollowedAndItsReceiptLandsWhileChatIsClosed() {
    proposeBuy(5)
    rig.route("POST /api/orders") { json("""{"id":"$id","queued":true,"expiresAt":1000495000,"expiresInMs":495000}""") }
    var polls = 0
    rig.route("GET /api/orders") {
      if (++polls < 3) json("""{"id":"$id","state":"queued"}""")
      else json("""{"id":"$id","state":"done","result":"Bought NVDA.","receipt":{"status":"filled","side":"buy","symbol":"NVDA","usdgActual":5}}""")
    }
    val chat = rig.thread()
    rig.signIn(A)
    waitFor("A") { chat.thread.value.key == A }
    chat.setOpen(true)
    runBlocking { chat.sendNow("buy $5 of nvda", null) }
    chat.setOpen(false)
    chat.confirm { _, _ -> }
    waitFor("the receipt") { chat.thread.value.messages.any { it.order?.outcome == true } }

    val lines = chat.thread.value.messages
    val placing = lines.first { it.order?.id == id && !it.order!!.outcome }
    assertTrue(placing.text.startsWith("Placed it — Spend \$5.00 buying NVDA."))
    assertEquals(1_000_000_000L, placing.order!!.serverPlacedAt)
    val answer = lines.last()
    assertEquals("Bought NVDA.", answer.text)
    assertEquals("[Buy] \$5.00 NVDA · Filled", receiptText(answer.order!!.receipt!!))
    assertEquals("the dot: the answer landed while Chat was closed", 1, chat.unread.value)
    assertTrue("nothing left to follow", chat.thread.value.orders.isEmpty())
    assertNull("the card is gone once placed", chat.card.value)
    assertEquals(1, rig.writes().count { it.path == "/api/orders" })
  }

  @Test fun anOrderPastThePerTradeCapIsRefusedOnTheCardAndNeverSent() {
    proposeBuy(50)
    val chat = rig.thread()
    rig.signIn(A)
    waitFor("A") { chat.thread.value.key == A }
    chat.setOpen(true)
    runBlocking { chat.sendNow("buy $50 of nvda", null) }
    waitFor("the cap read") { chat.snapshot.value?.grants != null }
    chat.confirm { _, _ -> }
    waitFor("the refusal") { chat.thread.value.messages.last().text.contains("per-trade cap") }
    assertTrue(rig.writes().none { it.path == "/api/orders" })
  }

  @Test fun aChatSnipeFindsTheCoinAndPutsItOnACardBeforeBuyingIt() {
    rig.route("POST /api/chat") {
      json("""{"reply":"Going after it.","command":{"id":"snipe","args":{"query":"cash cat","usdgAmount":5}}}""")
    }
    rig.route("POST /api/snipe") {
      json(
        """{"outcome":"resolved","target":{"symbol":"CASHCAT","address":"0x1da81ca017949efbe07972776580d04592ba9b63","short":"0x1da8…9b63"},
           "usdgAmount":5,"matchedOn":"name","say":"CASHCAT at 0x1da8…9b63. Placing $5.00."}""",
      )
    }
    rig.route("POST /api/orders") { json("""{"id":"$id","queued":true,"expiresInMs":495000}""") }
    rig.route("GET /api/orders") { json("""{"id":"$id","state":"queued"}""") }
    val chat = rig.thread()
    rig.signIn(A)
    waitFor("A") { chat.thread.value.key == A }
    runBlocking { chat.sendNow("ape into cash cat with 5", null) }
    chat.confirm { _, _ -> }
    waitFor("the found coin's card") { chat.card.value?.found != null }
    val card = chat.card.value!!
    assertEquals("buy", card.command.id)
    assertEquals("0x1da81ca017949efbe07972776580d04592ba9b63", card.found!!.address)
    assertTrue("the lookup placed nothing", rig.writes().none { it.path == "/api/orders" })
    assertTrue(chat.thread.value.messages.last().text.startsWith("Found it — CASHCAT at 0x1da8…9b63 — matched on its name"))

    chat.confirm { _, _ -> }
    waitFor("the order") { rig.writes().any { it.path == "/api/orders" } }
    waitFor("placed") { chat.thread.value.messages.any { it.text.startsWith("CASHCAT at 0x1da8…9b63. Placed, not filled") } }
  }

  @Test fun aColdStartResumesTheFollowAndAsksEvenPastTheDeadline() {
    rig.dir.mkdirs()
    File(rig.dir, "thread-$A.json").writeText(
      """{"v":2,"messages":[{"id":"agent-1","role":"agent","at":1,"text":"Placed it.","order":{"id":"$id"}}],
         "orders":[{"id":"$id","until":5}]}""",
    )
    rig.route("GET /api/orders") { json("""{"id":"$id","state":"expired"}""") }
    val chat = rig.thread()
    rig.signIn(A)
    waitFor("the answer") { chat.thread.value.messages.size == 2 }
    assertEquals(
      "That order expired before my worker picked it up, so nothing was sent. Ask again if you still want it.",
      chat.thread.value.messages.last().text,
    )
    assertEquals(1, rig.seen.count { it.path == "/api/orders?id=$id" })
  }
}
