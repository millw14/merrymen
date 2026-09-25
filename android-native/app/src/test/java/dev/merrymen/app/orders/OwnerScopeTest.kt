package dev.merrymen.app.orders

import dev.merrymen.app.chat.ChatRig
import dev.merrymen.app.chat.ChatRig.Companion.A
import dev.merrymen.app.chat.ChatRig.Companion.B
import dev.merrymen.app.chat.ChatRig.Companion.json
import dev.merrymen.app.chat.waitFor
import dev.merrymen.app.data.ConfirmScope
import dev.merrymen.app.data.LineOrder
import dev.merrymen.app.data.PendingCard
import dev.merrymen.app.net.ChatCommand
import dev.merrymen.app.net.SnipeTarget
import dev.merrymen.app.ui.Acted
import dev.merrymen.app.ui.COMMANDS
import dev.merrymen.app.ui.OWNER_CHANGED_LOCAL
import dev.merrymen.app.ui.Placed
import dev.merrymen.app.ui.applyRisk
import dev.merrymen.app.ui.approveProposals
import dev.merrymen.app.ui.placeConfirmedOrder
import dev.merrymen.app.ui.runConfirmedCard
import dev.merrymen.app.ui.runSettingsCard
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** A card's scope with nothing behind it but a list of what it was asked to do. */
class FakeScope(override val owner: String?, var live: Boolean = true) : ConfirmScope {
  val said = mutableListOf<Pair<String, String>>()
  val orders = mutableListOf<LineOrder?>()
  val followed = mutableListOf<Pair<String, Long?>>()
  var cleared = 0
  var proposed: Pair<ChatCommand, SnipeTarget>? = null
  override fun alive() = live
  override fun say(role: String, text: String, order: LineOrder?) {
    said += role to text
    orders += order
  }
  override fun followOrder(id: String, expiresInMs: Long?) {
    followed += id to expiresInMs
  }
  override fun clearCard() {
    cleared++
  }
  override fun propose(command: ChatCommand, found: SnipeTarget) {
    proposed = command to found
  }
  override fun refreshSettings() = Unit
}

/**
 * EVERY WRITE IS FOR THE OWNER WHO CONFIRMED IT.
 *
 * A confirm card, an order, a snipe, a proposal approval and a risk write all
 * name the wallet they were made for, and a change of wallet in between stops
 * them: locally, before anything is sent, when the phone already knows; and at
 * the route (409) when another sign-in happened unseen — and a 409 is said,
 * never retried.
 */
class OwnerScopeTest {
  private val rig = ChatRig()
  private val id = "c".repeat(32)

  @After fun stop() = rig.close()

  private fun bodyOf(method: String, path: String) =
    Json.parseToJsonElement(rig.seen.last { it.method == method && it.path.startsWith(path) }.body).jsonObject

  @Test fun aScopeWhoseOwnerChangedSendsNothingAtAll() = runBlocking {
    val scope = FakeScope(A, live = false)
    val r = placeConfirmedOrder(rig.api, scope, "buy", "NVDA", 5.0) { "placed" }
    assertEquals(Placed.Refused(OWNER_CHANGED_LOCAL), r)
    assertTrue("no request left the phone", rig.seen.isEmpty())
    runSettingsCard(rig.api, scope, COMMANDS.getValue("go-paper"), emptyMap())
    assertTrue(rig.seen.isEmpty())
  }

  @Test fun theOwnerTravelsInTheOrderAndTheSettingsBodies() = runBlocking {
    rig.route("POST /api/orders") { json("""{"id":"$id","queued":true,"expiresAt":1000495000,"expiresInMs":495000}""") }
    rig.route("PUT /api/settings") { json("""{"ok":true}""") }
    val scope = FakeScope(A)
    val r = placeConfirmedOrder(rig.api, scope, "buy", "NVDA", 5.0) { "Placed it." }
    assertEquals(Placed.Queued(id, "Placed it."), r)
    assertEquals(JsonPrimitive(A), bodyOf("POST", "/api/orders")["owner"])
    assertEquals("followed on the window POST gave", listOf(id to 495_000L), scope.followed)
    assertEquals(1_000_000_000L, scope.orders.last()!!.serverPlacedAt)

    runSettingsCard(rig.api, scope, COMMANDS.getValue("go-paper"), emptyMap())
    val put = bodyOf("PUT", "/api/settings")
    assertEquals(JsonPrimitive(A), put["owner"])
    assertEquals(JsonPrimitive(false), put["liveTradingEnabled"])
    assertEquals(JsonPrimitive(true), put["paperTradingEnabled"])
  }

  @Test fun a409IsSaidInTheRoutesWordsAndNeverRetried() = runBlocking {
    rig.route("POST /api/orders") {
      json("""{"error":"this browser is signed in with a different wallet now than the one that confirmed this, so nothing was placed."}""", 409)
    }
    val scope = FakeScope(A)
    val r = placeConfirmedOrder(rig.api, scope, "buy", "NVDA", 5.0) { "placed" }
    assertTrue(r is Placed.Refused)
    assertTrue(r.line.contains("different wallet"))
    assertEquals("one POST, no second try", 1, rig.writes().size)
    assertTrue("nothing followed", scope.followed.isEmpty())
  }

  @Test fun aLostPlacementIsLookedUpOnceForTheOwnerAndNeverSentAgain() = runBlocking {
    rig.route("POST /api/orders") { MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST) }
    rig.route("GET /api/orders") { json("""{"id":"$id","state":"queued"}""") }
    val scope = FakeScope(A)
    val r = placeConfirmedOrder(rig.api, scope, "buy", "NVDA", 5.0) { "placed" }
    assertEquals(Placed.Unknown("I lost the line while placing that, but there is an order open on my key now — I'll tell you how it ends.", id), r)
    assertEquals(1, rig.writes().size)
    assertEquals("/api/orders?owner=$A", rig.seen.last { it.method == "GET" }.path)
    assertEquals("followed with no window: the long wait", listOf(id to null), scope.followed)
    assertEquals("the card goes: tapping again may be a second order", 1, scope.cleared)
  }

  @Test fun aLostPlacementWithNothingOpenIsUnknownNotFailed() = runBlocking {
    rig.route("POST /api/orders") { json("""{"error":"x"}""", 502).setHeader("content-type", "text/html").setBody("<html>bad gateway</html>") }
    rig.route("GET /api/orders") { json("""{"state":"none"}""") }
    val scope = FakeScope(A)
    val r = placeConfirmedOrder(rig.api, scope, "buy", "NVDA", 5.0) { "placed" }
    assertTrue(r is Placed.Unknown)
    assertTrue(r.line.startsWith("I couldn't confirm that order reached my key"))
    assertTrue(scope.said.none { it.second.contains("didn't go through") })
  }

  @Test fun theRoutesOwn503IsARefusalNotALookup() = runBlocking {
    rig.route("POST /api/orders") { json("""{"error":"couldn't queue it — the ledger is unreachable"}""", 503) }
    val r = placeConfirmedOrder(rig.api, FakeScope(A), "buy", "NVDA", 5.0) { "placed" }
    assertEquals(Placed.Refused("That didn't go through: couldn't queue it — the ledger is unreachable"), r)
    assertTrue("no row was written, so nothing is looked up", rig.seen.none { it.method == "GET" })
  }

  @Test fun aChatCardMadeForOneWalletPlacesNothingAfterAnotherSignsIn() {
    rig.route("POST /api/chat") {
      json("""{"reply":"Shall I?","command":{"id":"buy","args":{"symbol":"NVDA","usdgAmount":5}}}""")
    }
    rig.route("POST /api/orders") { json("""{"id":"$id","queued":true,"expiresInMs":495000}""") }
    val chat = rig.thread()
    rig.signIn(A)
    waitFor("A") { chat.thread.value.key == A }
    runBlocking { chat.sendNow("buy nvda", null) }
    val card: PendingCard = chat.card.value!!
    assertEquals(A, card.scope.owner)

    rig.signIn(B)
    waitFor("B") { chat.thread.value.key == B }
    assertEquals("the card went with its owner", null, chat.card.value)
    // Even the old card object, carried out now, sends nothing.
    runBlocking { runConfirmedCard(rig.api, card, 20.0, 25.0) { _, _ -> } }
    assertTrue(rig.seen.none { it.path.startsWith("/api/orders") && it.method == "POST" })
  }

  @Test fun theSameWalletComingBackDoesNotReviveACardMadeBeforeItLeft() {
    rig.route("POST /api/chat") {
      json("""{"reply":"Shall I?","command":{"id":"sell","args":{"symbol":"NVDA","usdgAmount":5}}}""")
    }
    rig.route("POST /api/orders") { json("""{"id":"$id","queued":true,"expiresInMs":495000}""") }
    val chat = rig.thread()
    rig.signIn(A)
    waitFor("A") { chat.thread.value.key == A }
    runBlocking { chat.sendNow("sell nvda", null) }
    val card = chat.card.value!!
    rig.signIn(B)
    waitFor("B") { chat.thread.value.key == B }
    rig.signIn(A)
    waitFor("A again") { chat.thread.value.key == A }
    // A is back, but the owner changed while this card was out: it acts for nobody.
    assertEquals(false, card.scope.alive())
    runBlocking { runConfirmedCard(rig.api, card, 20.0, 25.0) { _, _ -> } }
    assertTrue(rig.seen.none { it.path.startsWith("/api/orders") && it.method == "POST" })
  }

  @Test fun approvingAProposalWritesForTheWalletItReadAndA409SavesNothing() = runBlocking {
    rig.route("PUT /api/settings") { json("""{"errors":["this browser is signed in with a different wallet now"]}""", 409) }
    val r = approveProposals(
      rig.repo,
      listOf(dev.merrymen.app.net.Proposal(token = "0x1da81ca017949efbe07972776580d04592ba9b63", symbol = "CASHCAT")),
    )
    assertEquals(JsonPrimitive(A), bodyOf("PUT", "/api/settings")["owner"])
    assertTrue(r is Acted.Failed)
    assertTrue((r as Acted.Failed).line.startsWith("Your session changed since this was set up — nothing was saved."))
  }

  @Test fun aRiskTapWritesForTheWalletTheScreenRead() = runBlocking {
    rig.route("PUT /api/settings") { json("""{"ok":true}""") }
    val r = applyRisk(rig.repo, "careful", owner = B)
    assertTrue(r is Acted.Ok)
    val put = bodyOf("PUT", "/api/settings")
    assertEquals(JsonPrimitive(B), put["owner"])
    assertEquals(JsonPrimitive(1500), put["strategistStopLossBps"])
    assertTrue("level is not a setting and is never sent", !put.containsKey("level"))

    // The screen's read failed: the settings are read for the owner first.
    rig.seen.clear()
    applyRisk(rig.repo, "bold", owner = null)
    assertEquals("GET", rig.seen.first().method)
    assertEquals(JsonPrimitive(A), bodyOf("PUT", "/api/settings")["owner"])
  }
}
