package dev.merrymen.app.chat

import dev.merrymen.app.chat.ChatRig.Companion.A
import dev.merrymen.app.chat.ChatRig.Companion.B
import dev.merrymen.app.chat.ChatRig.Companion.json
import dev.merrymen.app.chat.ChatRig.Companion.sse
import dev.merrymen.app.data.MAX_LINES
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/**
 * THE THREAD OUTLIVES THE SCREEN AND NEVER OUTLIVES ITS WALLET.
 *
 * The real ChatThread over the real Repository, against a fake server: what
 * is kept on disk comes back after a cold start for the same wallet, is gone
 * for the next one — including after a cold start the forget hooks never saw
 * — and a streamed reply lands in the thread exactly once.
 */
class ChatThreadTest {
  private val rig = ChatRig()

  @After fun stop() = rig.close()

  private fun file(key: String) = File(rig.dir, "thread-$key.json")

  @Test fun aReplyIsKeptAndComesBackAfterAColdStart() {
    rig.route("POST /api/chat") { json("""{"reply":"Hello, I'm Shogun."}""") }
    val chat = rig.thread()
    rig.signIn(A)
    waitFor("A's thread") { chat.thread.value.key == A }
    runBlocking { chat.sendNow("hi", null) }
    assertEquals(listOf("hi", "Hello, I'm Shogun."), chat.thread.value.messages.map { it.text })
    waitFor("the file") { file(A).isFile }

    // A cold start: a new process, a new thread, the same wallet.
    val again = rig.coldStart()
    rig.signIn(A)
    waitFor("A's thread again") { again.thread.value.key == A && again.thread.value.messages.size == 2 }
    assertEquals(listOf("owner", "agent"), again.thread.value.messages.map { it.role })
  }

  @Test fun anotherWalletAfterAColdStartSeesNothingOfTheFirstAndItIsDeleted() {
    rig.route("POST /api/chat") { json("""{"reply":"Your NVDA is up."}""") }
    val chat = rig.thread()
    rig.signIn(A)
    waitFor("A") { chat.thread.value.key == A }
    runBlocking { chat.sendNow("how am I doing?", null) }
    waitFor("A's file") { file(A).isFile }

    // Cold start: no forget hook ever runs for A, and B is who answers.
    val cold = rig.coldStart()
    rig.signIn(B)
    waitFor("B's thread") { cold.thread.value.key == B }
    assertTrue("B sees none of A's words", cold.thread.value.messages.isEmpty())
    assertFalse("and A's thread is not left on the phone for B to find", file(A).exists())
  }

  @Test fun aWalletSwitchForgetsTheLeavingOwnersThread() {
    rig.route("POST /api/chat") { json("""{"reply":"ok"}""") }
    val chat = rig.thread()
    rig.signIn(A)
    waitFor("A") { chat.thread.value.key == A }
    runBlocking { chat.sendNow("hi", null) }
    waitFor("A's file") { file(A).isFile }

    rig.signIn(B)
    waitFor("B") { chat.thread.value.key == B }
    assertTrue(chat.thread.value.messages.isEmpty())
    assertFalse(file(A).exists())
  }

  @Test fun theThreadRegistersItsOwnForgetHookAndItRunsBeforeTheNextWalletIsPublished() {
    rig.route("POST /api/chat") { json("""{"reply":"ok"}""") }
    val chat = rig.thread()
    rig.signIn(A)
    waitFor("A") { chat.thread.value.key == A }
    runBlocking { chat.sendNow("hi", null) }
    // Registered after the thread's, so it runs after it: by then the thread
    // must already hold nobody's words.
    var keyDuringTurnEnd: String? = "unset"
    rig.repo.addForgetHook { keyDuringTurnEnd = chat.thread.value.key }
    runBlocking { rig.repo.signOut() }
    assertNull(keyDuringTurnEnd)
    assertTrue(chat.thread.value.messages.isEmpty())
    assertFalse(file(A).exists())
  }

  @Test fun theThreadKeepsTheNewestEightyLines() {
    var n = 0
    rig.route("POST /api/chat") { json("""{"reply":"answer ${++n}"}""") }
    val chat = rig.thread()
    rig.signIn(A)
    waitFor("A") { chat.thread.value.key == A }
    runBlocking { repeat(45) { chat.sendNow("question $it", null) } }
    val lines = chat.thread.value.messages
    assertEquals(MAX_LINES, lines.size)
    assertEquals("answer 45", lines.last().text)
    assertEquals("question 5", lines.first().text)
    val cold = rig.coldStart()
    rig.signIn(A)
    waitFor("kept 80") { cold.thread.value.key == A && cold.thread.value.messages.size == MAX_LINES }
  }

  @Test fun aStreamedReplyLandsOnceAndOnlyDoneRaisesACard() {
    rig.route("POST /api/chat") {
      sse(
        "text" to """{"t":"Buying "}""",
        "text" to """{"t":"NVDA <<CMD buy"}""",
        "done" to """{"reply":"Buying NVDA","command":{"id":"buy","args":{"symbol":"NVDA","usdgAmount":5}}}""",
        "done" to """{"reply":"a second answer"}""",
      )
    }
    val chat = rig.thread()
    rig.signIn(A)
    waitFor("A") { chat.thread.value.key == A }
    runBlocking { chat.sendNow("buy nvda", null) }
    assertEquals(listOf("buy nvda", "Buying NVDA"), chat.thread.value.messages.map { it.text })
    assertEquals("buy", chat.card.value!!.command.id)
    assertNull("the bubble is settled into the line", chat.streaming.value)
    assertEquals(A, chat.card.value!!.scope.owner)
  }

  @Test fun somethingArrivingWhileChatIsClosedLightsTheDot() {
    rig.route("POST /api/chat") { json("""{"reply":"here"}""") }
    val chat = rig.thread()
    rig.signIn(A)
    waitFor("A") { chat.thread.value.key == A }
    chat.setOpen(false)
    runBlocking { chat.sendNow("hi", null) }
    assertEquals(1, chat.unread.value)
    chat.setOpen(true)
    assertEquals(0, chat.unread.value)
    runBlocking { chat.sendNow("again", null) }
    assertEquals("read on screen, nothing new", 0, chat.unread.value)
  }

  @Test fun aScreenDrawsTheThreadOnlyForTheSessionAsItStandsNow() {
    rig.route("POST /api/chat") { json("""{"reply":"ok"}""") }
    val chat = rig.thread()
    rig.signIn(A)
    waitFor("A") { chat.thread.value.key == A }
    runBlocking { chat.sendNow("hi", null) }
    val t = chat.thread.value
    assertEquals(2, t.linesFor(true, A.uppercase().replace("0X", "0x")).size)
    assertTrue("a lapsed session draws nothing", t.linesFor(true, null).isEmpty())
    assertTrue("the next wallet, before the thread catches up, draws nothing", t.linesFor(true, B).isEmpty())
    assertTrue("not yet known", t.linesFor(null, A).isEmpty())
  }

  @Test fun aSignedOutReaderHasNoThreadAndSendsNothing() {
    val chat = rig.thread()
    rig.signIn(null)
    assertNull(chat.thread.value.key)
    assertFalse(runBlocking { chat.sendNow("hello?", null) })
    assertTrue(rig.writes().isEmpty())
  }

  @Test fun aKeptFileThatIsNotAThreadIsAnEmptyThreadNotACrash() {
    rig.dir.mkdirs()
    file(A).writeText("""{"messages":[{"id":"x","role":"hacker","text":"hi"},{"id":"y","role":"agent","text":"real","at":1,"order":{"id":"../x"}}],"orders":[{"id":"nope","until":1}]}""")
    val chat = rig.thread()
    rig.signIn(A)
    waitFor("A") { chat.thread.value.key == A }
    assertEquals(listOf("real"), chat.thread.value.messages.map { it.text })
    assertNull("an order id that is not a hash is dropped", chat.thread.value.messages.single().order)
    assertTrue(chat.thread.value.orders.isEmpty())
    file(A).writeText("not json at all {")
    val cold = rig.coldStart()
    rig.signIn(A)
    waitFor("A again") { cold.thread.value.key == A }
    assertTrue(cold.thread.value.messages.isEmpty())
  }
}
