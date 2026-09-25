package dev.merrymen.app.orders

import dev.merrymen.app.chat.ChatRig
import dev.merrymen.app.chat.ChatRig.Companion.A
import dev.merrymen.app.chat.ChatRig.Companion.json
import dev.merrymen.app.chat.waitFor
import dev.merrymen.app.net.GrantView
import dev.merrymen.app.net.SettingsEnvelope
import dev.merrymen.app.ui.MONEY_LIVE
import dev.merrymen.app.ui.MONEY_LIVE_ON
import dev.merrymen.app.ui.MONEY_PAPER
import dev.merrymen.app.ui.MONEY_UNKNOWN
import dev.merrymen.app.ui.liveConsentOf
import dev.merrymen.app.ui.moneyLine
import dev.merrymen.app.ui.moneyLineFor
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
import java.util.concurrent.atomic.AtomicBoolean
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
    assertEquals("self-hosted names no owner and still answers", MONEY_PAPER, moneyLine(off, settings(owner = null)))
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
}
