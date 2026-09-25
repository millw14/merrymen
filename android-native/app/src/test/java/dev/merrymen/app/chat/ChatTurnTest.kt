package dev.merrymen.app.chat

import dev.merrymen.app.chat.ChatRig.Companion.A
import dev.merrymen.app.chat.ChatRig.Companion.B
import dev.merrymen.app.chat.ChatRig.Companion.json
import dev.merrymen.app.chat.ChatRig.Companion.sse
import dev.merrymen.app.data.Loaded
import dev.merrymen.app.net.ChatBody
import dev.merrymen.app.net.askAgent
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.TimeUnit

/**
 * WHOSE TURN IT IS, when the answer to that is late, lost or changing: a cold
 * start that reached nothing, a reply still coming for the last wallet, a
 * confirm still running under a newer card. The real thread over the real
 * Repository, against a fake server.
 */
class ChatTurnTest {
  private val rig = ChatRig()

  @After fun stop() = rig.close()

  /**
   * A COLD START THAT REACHED NOTHING KEEPS ASKING. bootstrap asks who is
   * signed in once, and only after the version read answered; before
   * askUntilKnown, a start in airplane mode never asked again, so the chat
   * never learned its key and a kept order was never followed.
   */
  @Test fun aColdStartThatReachedNothingAsksWhoIsSignedInUntilItHears() {
    rig.address = A
    rig.sessionDown = true
    rig.route("GET /api/version") { MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST) }
    val chat = rig.thread()
    assertTrue(runBlocking { rig.repo.bootstrap() } is Loaded.Unreachable)
    assertFalse(rig.repo.identityKnown.value)

    val waits = mutableListOf<Long>()
    runBlocking {
      rig.repo.askUntilKnown(pause = { ms ->
        waits += ms
        check(waits.size <= 5) { "still asking after ${waits.size} waits" }
        // The network comes back after the second wait.
        if (waits.size == 2) rig.sessionDown = false
      })
    }
    assertTrue(rig.repo.identityKnown.value)
    assertEquals(true, rig.repo.hosted.value)
    assertEquals(A, rig.repo.signedIn.value)
    assertEquals("asked again after each wait, longer each time", listOf(3_000L, 6_000L), waits)
    assertEquals(2, rig.seen.count { it.path.startsWith("/api/auth/session") })
    waitFor("the chat learns whose thread it is") { chat.thread.value.key == A }
  }

  @Test fun onceSomebodyHasAnsweredItAsksNothingMore() {
    rig.signIn(A)
    val before = rig.seen.size
    runBlocking { rig.repo.askUntilKnown(pause = { error("no wait: identity is known") }) }
    assertEquals(before, rig.seen.size)
  }

  /**
   * THE LAST WALLET'S REPLY DOES NOT HOLD THE NEXT ONE'S COMPOSER. A reply
   * still coming for A kept the one-send guard: B's thread showed the typing
   * bubble under B's agent, and B's Send was dropped with nothing said.
   */
  @Test fun aReplyStillComingForTheLastWalletDoesNotHoldTheNextOnesComposer() {
    rig.route("POST /api/chat") { s ->
      if (s.body.contains("\"message\":\"hi from A")) {
        sse("done" to """{"reply":"late answer for A"}""").setHeadersDelay(2, TimeUnit.SECONDS)
      } else {
        json("""{"reply":"Hi B."}""")
      }
    }
    rig.signIn(A)
    val chat = rig.thread()
    waitFor("A's thread") { chat.thread.value.key == A }
    rig.scope.launch(Dispatchers.IO) { chat.sendNow("hi from A", null) }
    waitFor("A's question is on its way") { rig.seen.any { it.path == "/api/chat" } }
    assertTrue(chat.sending.value)

    rig.signIn(B)
    waitFor("B's thread") { chat.thread.value.key == B }
    assertFalse("no typing bubble for A's reply under B's agent", chat.sending.value)
    val sent = runBlocking { chat.sendNow("hello from B", null) }
    assertTrue("B's own message goes", sent)
    assertEquals(listOf("hello from B", "Hi B."), chat.thread.value.messages.map { it.text })

    // A's late answer, when it would have come, lands nowhere and frees nothing of B's.
    Thread.sleep(2_300)
    assertEquals(listOf("hello from B", "Hi B."), chat.thread.value.messages.map { it.text })
    assertFalse(chat.sending.value)
  }

  /**
   * AN ASK THAT IS CANCELLED CANCELS ITS CALL. The old hook ran only after the
   * blocked read returned, so a cancel waited out the server's whole answer.
   */
  @Test fun cancellingAnAskEndsItsRequestAtOnce() {
    rig.route("POST /api/chat") { sse("done" to """{"reply":"slow"}""").setHeadersDelay(4, TimeUnit.SECONDS) }
    val job = rig.scope.launch(Dispatchers.IO) {
      rig.api.askAgent(ChatBody(message = "hi", state = "{}", history = emptyList())) { }
    }
    waitFor("the ask is on the wire") { rig.seen.any { it.path == "/api/chat" } }
    Thread.sleep(200)
    val t0 = System.currentTimeMillis()
    runBlocking {
      job.cancel()
      job.join()
    }
    val took = System.currentTimeMillis() - t0
    assertTrue("the cancel waited for the server's answer ($took ms)", took < 1_500)
  }
}
