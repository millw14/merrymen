package dev.merrymen.app.chat

import dev.merrymen.app.chat.ChatRig.Companion.A
import dev.merrymen.app.data.Loaded
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

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
}
