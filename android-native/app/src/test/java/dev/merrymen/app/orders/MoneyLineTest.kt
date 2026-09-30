package dev.merrymen.app.orders

import dev.merrymen.app.chat.ChatRig
import dev.merrymen.app.chat.ChatRig.Companion.A
import dev.merrymen.app.chat.ChatRig.Companion.FEED
import dev.merrymen.app.chat.ChatRig.Companion.json
import dev.merrymen.app.chat.waitFor
import dev.merrymen.app.net.GrantView
import dev.merrymen.app.net.SettingsEnvelope
import dev.merrymen.app.ui.MONEY_LIVE
import dev.merrymen.app.ui.MONEY_LIVE_ON
import dev.merrymen.app.ui.MONEY_PAPER
import dev.merrymen.app.ui.MONEY_UNKNOWN
import dev.merrymen.app.ui.PAPER_MOVED
import dev.merrymen.app.ui.liveConsentOf
import dev.merrymen.app.ui.moneyLine
import dev.merrymen.app.ui.moneyLineFor
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

/**
 * A CARD SAYS PAPER ONLY WHEN PAPER CANNOT TURN INTO REAL MONEY ON ITS OWN.
 *
 * The card used to say "no real order goes out" whenever the worker's last
 * heartbeat said paper. The worker decides again when it picks the order up,
 * so an owner who had just said "go live", or whose agent was on paper only
 * until a deposit landed, confirmed a card that called real USDG simulated.
 * Paper is now said only when the worker's verdict and the owner's own setting
 * both say Live trading is off.
 */
class MoneyLineTest {
  private val rig = ChatRig()

  @After fun stop() = rig.close()

  private fun grants(mode: String?, blocker: String?) = GrantView(exists = true, mode = mode, liveBlocker = blocker)

  private fun settings(saved: JsonElement? = null, default: Boolean? = false, owner: String? = A) = SettingsEnvelope(
    values = JsonObject(if (saved == null) emptyMap() else mapOf("liveTradingEnabled" to saved)),
    defaults = JsonObject(if (default == null) emptyMap() else mapOf("liveTradingEnabled" to JsonPrimitive(default))),
    owner = owner,
  )

  @Test fun paperIsSaidWhenTheWorkerAndTheOwnersSettingBothSayLiveTradingIsOff() {
    val off = grants("paper", "live-not-enabled")
    assertEquals("never chosen: the default is the answer", MONEY_PAPER, moneyLine(off, settings()))
    assertEquals("chosen off", MONEY_PAPER, moneyLine(off, settings(saved = JsonPrimitive(false), default = null)))
    assertEquals("a null saved value is a choice nobody made", MONEY_PAPER, moneyLine(off, settings(saved = JsonNull)))
  }

  /**
   * SELF-HOSTED NEVER SAYS PAPER. Its /api/grants reads the worker's heartbeat
   * FILE, which carries the mode and never the blocker (web/src/app/api/grants/
   * route.ts sets liveBlocker only from the ledger row, read when there is no
   * file), so the worker's half of "Live trading is off" never arrives — and
   * self-hosted is where the house's live-intent stand-down runs. Its settings
   * read still answers: naming no owner is not a read made signed out.
   */
  @Test fun selfHostedPaperIsNeverVouchedFor() {
    val selfHosted = grants("paper", null)
    assertEquals(false, liveConsentOf(settings(owner = null)))
    assertEquals(MONEY_UNKNOWN, moneyLine(selfHosted, settings(owner = null)))
    assertEquals(MONEY_LIVE_ON, moneyLine(selfHosted, settings(saved = JsonPrimitive(true), owner = null)))
  }

  @Test fun paperWithLiveTradingOnIsSaidAsRealMoney() {
    // The heartbeat has not caught up with a "go live" the owner just confirmed.
    val stale = grants("paper", "live-not-enabled")
    assertEquals(MONEY_LIVE_ON, moneyLine(stale, settings(saved = JsonPrimitive(true))))
    // On paper only because it was unfunded; a deposit is all the next tick needs.
    val broke = grants("paper", "no-cash")
    assertEquals(MONEY_LIVE_ON, moneyLine(broke, settings(saved = JsonPrimitive(true))))
    assertTrue(MONEY_LIVE_ON.startsWith("Treat this as real money"))
  }

  @Test fun anythingNotVouchedForIsTreatedAsReal() {
    val off = grants("paper", "live-not-enabled")
    assertEquals("settings unread", MONEY_UNKNOWN, moneyLine(off, null))
    assertEquals("a read made signed out answers for nobody", MONEY_UNKNOWN, moneyLine(off, settings(owner = "")))
    assertEquals("a saved value that is not a boolean", MONEY_UNKNOWN, moneyLine(off, settings(saved = JsonPrimitive("false"))))
    assertEquals("no default and nothing saved", MONEY_UNKNOWN, moneyLine(off, settings(default = null)))
    // The owner's setting says off, but the worker's verdict is not the consent
    // one: it has not yet seen the gate in force.
    assertEquals(MONEY_UNKNOWN, moneyLine(grants("paper", "no-cash"), settings()))
    assertEquals(MONEY_UNKNOWN, moneyLine(grants("paper", null), settings()))
    assertEquals("idle", MONEY_UNKNOWN, moneyLine(grants("idle", "live-not-enabled"), settings()))
    assertEquals("the worker never said", MONEY_UNKNOWN, moneyLine(grants(null, null), settings()))
    assertEquals("grants unread", MONEY_UNKNOWN, moneyLine(null, settings()))
  }

  @Test fun liveIsRealMoneyWhateverElseWasRead() {
    assertEquals(MONEY_LIVE, moneyLine(grants("live", null), null))
    // Just switched off: the next tick is paper, and saying real money errs safe.
    assertEquals(MONEY_LIVE, moneyLine(grants("live", null), settings()))
  }

  @Test fun consentIsTheSavedValueElseTheDefault() {
    assertEquals(false, liveConsentOf(settings()))
    assertEquals(true, liveConsentOf(settings(saved = JsonPrimitive(true), default = false)))
    assertEquals(false, liveConsentOf(settings(saved = JsonPrimitive(false), default = true)))
    assertNull(liveConsentOf(settings(saved = JsonPrimitive(1))))
    assertNull(liveConsentOf(null))
  }

  // ── the chat's card, over the real thread ──────────────────────────────────

  @Test fun afterGoLiveTheNextOrderCardIsNotPaperThoughTheHeartbeatStillIs() {
    val live = AtomicBoolean(false)
    rig.route("GET /api/settings") {
      json("""{"values":{"liveTradingEnabled":${live.get()}},"defaults":{"liveTradingEnabled":false},"owner":"$A"}""")
    }
    rig.route("PUT /api/settings") {
      live.set(true)
      json("""{"ok":true}""")
    }
    val reply = AtomicReference("""{"reply":"Going live?","command":{"id":"go-live","args":{}}}""")
    rig.route("POST /api/chat") { json(reply.get()) }
    val chat = rig.thread()
    rig.signIn(A)
    waitFor("A") { chat.thread.value.key == A }
    runBlocking { chat.sendNow("go live", null) }
    assertEquals("before the switch, paper is true", MONEY_PAPER, moneyLineFor(chat.snapshot.value))

    chat.confirm { _, _ -> }
    waitFor("the switch said done") { chat.thread.value.messages.last().text.startsWith("Done") }
    waitFor("the settings read again") { liveConsentOf(chat.snapshot.value?.settings) == true }

    reply.set("""{"reply":"Shall I?","command":{"id":"buy","args":{"symbol":"NVDA","usdgAmount":5}}}""")
    runBlocking { chat.sendNow("buy $5 of nvda", null) }
    assertNotNull(chat.card.value)
    val snap = chat.snapshot.value!!
    assertEquals("the heartbeat has not caught up", "paper", snap.grants!!.mode)
    assertEquals(MONEY_LIVE_ON, moneyLineFor(snap))
  }

  @Test fun settingsLeftFromAnEarlierReadNeverVouchForPaper() {
    rig.route("POST /api/chat") {
      json("""{"reply":"Shall I?","command":{"id":"buy","args":{"symbol":"NVDA","usdgAmount":5}}}""")
    }
    val chat = rig.thread()
    rig.signIn(A)
    waitFor("A") { chat.thread.value.key == A }
    runBlocking { chat.sendNow("buy $5 of nvda", null) }
    assertEquals(MONEY_PAPER, moneyLineFor(chat.snapshot.value))

    // Live trading may have been switched on since: the read that would say so failed.
    rig.route("GET /api/settings") { json("""{"error":"merrymen had a problem"}""", 500) }
    runBlocking { chat.sendNow("buy $5 of nvda", null) }
    val snap = chat.snapshot.value!!
    assertTrue(snap.settingsKept)
    assertNotNull("the model still gets the book as last read", snap.settings)
    assertEquals(MONEY_UNKNOWN, moneyLineFor(snap))
  }

  // ── the tap ──────────────────────────────────────────────────────────────

  private val switchedOn = AtomicBoolean(false)

  /** A buy card drawn while Live trading is off, as the rig's heartbeat has it: paper. */
  private fun paperCard(): dev.merrymen.app.data.ChatThread {
    rig.route("GET /api/settings") {
      json("""{"values":{"liveTradingEnabled":${switchedOn.get()}},"defaults":{"liveTradingEnabled":false},"owner":"$A"}""")
    }
    rig.route("POST /api/chat") {
      json("""{"reply":"Shall I?","command":{"id":"buy","args":{"symbol":"NVDA","usdgAmount":5}}}""")
    }
    val id = "f".repeat(32)
    rig.route("POST /api/orders") { json("""{"id":"$id","queued":true,"expiresInMs":495000}""") }
    rig.route("GET /api/orders") { json("""{"id":"$id","state":"done","result":"Bought NVDA."}""") }
    val chat = rig.thread()
    rig.signIn(A)
    waitFor("A") { chat.thread.value.key == A }
    chat.setOpen(true)
    runBlocking { chat.sendNow("buy $5 of nvda", null) }
    assertNotNull(chat.card.value)
    assertEquals("drawn while Live trading was off", MONEY_PAPER, moneyLineFor(chat.snapshot.value))
    return chat
  }

  /**
   * A PAPER CARD IS CHECKED AGAIN AT THE TAP. Live trading goes on elsewhere
   * (the web, Telegram) while the card sits on an open Chat, which reads
   * nothing. The tap reads the book again, places nothing, says why, and the
   * card now says real money; the owner's second tap confirms THAT, and places.
   */
  @Test fun aPaperCardTappedAfterLiveTradingWentOnPlacesNothingUntilConfirmedAgain() {
    val chat = paperCard()
    switchedOn.set(true)
    chat.confirm { _, _ -> }
    waitFor("the tap settled") { !chat.confirming.value }
    assertTrue("no order went out", rig.writes().none { it.path == "/api/orders" })
    assertNotNull("the card is still up", chat.card.value)
    assertEquals("and says what is true now", MONEY_LIVE_ON, moneyLineFor(chat.snapshot.value))
    assertEquals("and the thread says why", PAPER_MOVED, chat.thread.value.messages.last().text)

    chat.confirm { _, _ -> }
    waitFor("the second tap placed it") { rig.writes().any { it.path == "/api/orders" } }
    waitFor("and it settled") { !chat.confirming.value }
    assertEquals(1, rig.writes().count { it.path == "/api/orders" })
  }

  /** A settings read that fails at the tap vouches for nothing: nothing is sent, and the card says so. */
  @Test fun aPaperCardWhoseSettingsCannotBeReadAtTheTapPlacesNothing() {
    val chat = paperCard()
    rig.route("GET /api/settings") { json("""{"error":"merrymen had a problem"}""", 500) }
    chat.confirm { _, _ -> }
    waitFor("the tap settled") { !chat.confirming.value }
    assertTrue(rig.writes().none { it.path == "/api/orders" })
    assertEquals(MONEY_UNKNOWN, moneyLineFor(chat.snapshot.value))
    assertEquals(PAPER_MOVED, chat.thread.value.messages.last().text)
  }

  /** Still off at the tap: the check costs one read, and the order goes on the first tap. */
  @Test fun aPaperCardThatIsStillPaperAtTheTapPlaces() {
    val chat = paperCard()
    val before = rig.seen.size
    chat.confirm { _, _ -> }
    waitFor("placed") { rig.writes().any { it.path == "/api/orders" } }
    waitFor("and it settled") { !chat.confirming.value }
    val untilPlaced = rig.seen.drop(before).takeWhile { !(it.method == "POST" && it.path == "/api/orders") }
    assertEquals("read again at the tap, once, before the order", 1, untilPlaced.count { it.path == "/api/settings" })
    assertTrue(chat.thread.value.messages.none { it.text == PAPER_MOVED })
  }

  // ── reads that land out of order ─────────────────────────────────────────

  /** Each feed read takes the next gate, in the order it reaches the server, and waits on it. */
  private val feedGates = ConcurrentLinkedQueue<CountDownLatch>()
  /** How many feed reads have taken a gate — are out and held. */
  private val heldFeeds = AtomicInteger(0)
  private val liveOn = AtomicBoolean(false)
  /** What each settings read answered for liveTradingEnabled, in order. */
  private val answered = CopyOnWriteArrayList<Boolean>()

  private fun slowFeedsAndASwitch() {
    rig.route("GET /api/feed") {
      val gate = feedGates.poll()
      if (gate != null) {
        heldFeeds.incrementAndGet()
        gate.await(20, TimeUnit.SECONDS)
      }
      json(FEED)
    }
    rig.route("GET /api/settings") {
      val on = liveOn.get()
      answered += on
      json("""{"values":{"liveTradingEnabled":$on},"defaults":{"liveTradingEnabled":false},"owner":"$A"}""")
    }
    rig.route("PUT /api/settings") {
      liveOn.set(true)
      json("""{"ok":true}""")
    }
  }

  /**
   * A READ THAT STARTED BEFORE "GO LIVE" DOES NOT TAKE THE CARD BACK TO PAPER.
   * Its settings answered "off" at once; its feed sat behind a backoff until
   * after the owner switched Live trading on and a buy card was drawn. It
   * finished last, and it used to be what the thread showed: the card on
   * screen turned from "treat this as real money" to "no real order goes out".
   */
  @Test fun aReadStartedBeforeGoLiveThatLandsLastLeavesTheCardRealMoney() {
    slowFeedsAndASwitch()
    val reply = AtomicReference("""{"reply":"Going live?","command":{"id":"go-live","args":{}}}""")
    rig.route("POST /api/chat") { json(reply.get()) }
    val chat = rig.thread()
    rig.signIn(A)
    waitFor("A") { chat.thread.value.key == A }
    runBlocking { chat.sendNow("go live", null) }
    assertNotNull(chat.card.value)

    // A read goes out — Chat coming back on screen, say — and is slow.
    val gate = CountDownLatch(1)
    feedGates += gate
    val before = answered.size
    val stale = rig.scope.async { chat.readSnapshot(A) }
    waitFor("its settings said off and its feed is held") { heldFeeds.get() == 1 && answered.size > before }
    assertEquals(false, answered.last())

    // The owner confirms "go live" while it is out, then asks for a buy.
    chat.confirm { _, _ -> }
    waitFor("the switch said done") { chat.thread.value.messages.last().text.startsWith("Done") }
    waitFor("the settings read again") { liveConsentOf(chat.snapshot.value?.settings) == true }
    reply.set("""{"reply":"Shall I?","command":{"id":"buy","args":{"symbol":"NVDA","usdgAmount":5}}}""")
    runBlocking { chat.sendNow("buy $5 of nvda", null) }
    assertNotNull(chat.card.value)
    assertEquals("the card as drawn", MONEY_LIVE_ON, moneyLineFor(chat.snapshot.value))

    gate.countDown()
    val old = runBlocking { stale.await() }
    assertEquals("the slow read did say off", false, liveConsentOf(old.settings))
    assertTrue("Live trading is on", liveOn.get())
    assertEquals("the card on screen still says real money", MONEY_LIVE_ON, moneyLineFor(chat.snapshot.value))
  }

  /**
   * AND THE QUESTION'S OWN READ IS NEVER THROWN AWAY FOR A LATER ONE STILL OUT.
   * Keeping only the newest read STARTED (the ceiling's rule) would drop it
   * while a follow's read was pending, and the card would be drawn from the
   * read before the question — one that said Live trading was off.
   */
  @Test fun theCardIsDrawnFromAReadNoOlderThanTheQuestion() {
    slowFeedsAndASwitch()
    rig.route("POST /api/chat") {
      json("""{"reply":"Shall I?","command":{"id":"buy","args":{"symbol":"NVDA","usdgAmount":5}}}""")
    }
    val chat = rig.thread()
    rig.signIn(A)
    waitFor("A") { chat.thread.value.key == A }
    runBlocking { chat.readSnapshot(A) }
    assertEquals("the last read said off", MONEY_PAPER, moneyLineFor(chat.snapshot.value))

    // Live trading goes on, on the web. The question's read goes out, then a
    // later one; both are slow, and the question's answers first.
    liveOn.set(true)
    val first = CountDownLatch(1)
    val second = CountDownLatch(1)
    feedGates += first
    val asked = rig.scope.async { chat.sendNow("buy $5 of nvda", null) }
    waitFor("the question's read is out") { heldFeeds.get() == 1 }
    feedGates += second
    val later = rig.scope.async { chat.readSnapshot(A) }
    waitFor("a later read is out") { heldFeeds.get() == 2 }

    first.countDown()
    assertTrue(runBlocking { asked.await() })
    assertNotNull(chat.card.value)
    assertEquals("drawn from the question's read", MONEY_LIVE_ON, moneyLineFor(chat.snapshot.value))
    second.countDown()
    runBlocking { later.await() }
    assertEquals(MONEY_LIVE_ON, moneyLineFor(chat.snapshot.value))
  }
}
