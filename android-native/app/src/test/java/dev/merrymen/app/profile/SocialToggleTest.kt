package dev.merrymen.app.profile

import dev.merrymen.app.data.SELF_WIRE
import dev.merrymen.app.data.Social
import dev.merrymen.app.net.answer
import dev.merrymen.app.net.apiFor
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.TimeUnit

/**
 * WIRING AND LIKING, against the real client and the real Social store.
 *
 * The server's answer is the state; a refusal is said, never swallowed; and a
 * write whose answer was lost is LOOKED UP — never reported as a failure it
 * may not have been, and never sent twice.
 */
class SocialToggleTest {
  private lateinit var server: MockWebServer
  private lateinit var social: Social

  @Before fun start() {
    server = MockWebServer()
    server.start()
    // No silent retry: a dropped connection is one lost answer, as a phone on
    // a bad network sees it.
    social = Social(apiFor(server, OkHttpClient.Builder().retryOnConnectionFailure(false).build()))
    server.answer("""{"wired":["other0000000000a"],"max":8}""")
    runBlocking { social.refreshWired(force = true) }
    server.takeRequest()
  }

  @After fun stop() = server.shutdown()

  private fun lost() = server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))

  @Test fun wiringYourOwnAgentIsRefusedOutLoudAndRolledBack() = runBlocking {
    server.answer("""{"wired":["other0000000000a"],"max":8,"refused":"self"}""")
    val said = social.toggleWire("mine000000000000", true)
    assertEquals(SELF_WIRE, said)
    assertEquals("Your agent already reads its own posts.", said)
    val w = social.wired.value
    assertTrue(w.known)
    assertFalse("the ring snaps back to what was stored", w.has("mine000000000000"))
    assertEquals(listOf("other0000000000a"), w.wired)
    assertFalse(w.busy)
  }

  @Test fun theCapIsSaidAndTheListIsWhatWasStored() = runBlocking {
    server.answer("""{"wired":["other0000000000a"],"max":1,"refused":"at-capacity"}""")
    val said = social.toggleWire("desk000000000000", true)!!
    assertTrue(said.startsWith("Your agent already reads 1 desks"))
    assertFalse(social.wired.value.has("desk000000000000"))
  }

  @Test fun aReasonThisBuildDoesNotKnowIsStillARefusal() = runBlocking {
    server.answer("""{"wired":["other0000000000a"],"max":8,"refused":"something-new"}""")
    assertEquals("merrymen didn't make that change, so nothing changed.", social.toggleWire("desk000000000000", true))
    assertFalse(social.wired.value.has("desk000000000000"))
  }

  @Test fun aStoredFollowIsAQuietSuccess() = runBlocking {
    server.answer("""{"wired":["desk000000000000","other0000000000a"],"max":8}""")
    assertNull(social.toggleWire("desk000000000000", true))
    assertTrue(social.wired.value.has("desk000000000000"))
  }

  @Test fun aLostAnswerIsLookedUpAndItWentThrough() = runBlocking {
    lost()
    server.answer("""{"wired":["desk000000000000","other0000000000a"],"max":8}""")
    assertNull(social.toggleWire("desk000000000000", true))
    assertTrue(social.wired.value.has("desk000000000000"))
    // One write, then one read — never the write again.
    assertEquals("POST", server.takeRequest(2, TimeUnit.SECONDS)?.method)
    assertEquals("the answer was looked up", "GET", server.takeRequest(2, TimeUnit.SECONDS)?.method)
    assertEquals(2, server.requestCount - 1)
  }

  @Test fun aLostAnswerIsLookedUpAndItDidNot() = runBlocking {
    lost()
    server.answer("""{"wired":["other0000000000a"],"max":8}""")
    assertEquals("merrymen didn't answer, and that change wasn't saved. Try again.", social.toggleWire("desk000000000000", true))
    assertFalse(social.wired.value.has("desk000000000000"))
    assertTrue(social.wired.value.known)
  }

  @Test fun whenTheLookUpFailsTooItSaysItDoesNotKnow() = runBlocking {
    lost()
    lost()
    assertNull(social.toggleWire("desk000000000000", true))
    val w = social.wired.value
    assertFalse("not known is not 'follows nobody'", w.known)
    assertTrue(w.why!!.startsWith("We couldn't confirm whether that change was saved. Can't reach merrymen right now"))
    assertFalse(w.busy)
  }

  @Test fun aSecondTapWhileOneIsOnItsWayIsIgnored() = runBlocking {
    server.enqueue(
      MockResponse().setHeader("content-type", "application/json")
        .setBody("""{"wired":["desk000000000000","other0000000000a"],"max":8}""")
        .setHeadersDelay(300, TimeUnit.MILLISECONDS),
    )
    // A second answer is queued so that, were a second write ever sent, it would
    // be counted below rather than wait forever for a reply.
    server.answer("""{"wired":["other0000000000a"],"max":8}""")
    val first = async { social.toggleWire("desk000000000000", true) }
    val second = async { social.toggleWire("desk000000000000", false) }
    assertNull(first.await())
    assertNull(second.await())
    assertEquals("only one write left the phone", 2, server.requestCount)
    assertTrue(social.wired.value.has("desk000000000000"))
  }

  @Test fun aLostLikeIsLookedUpNotRolledBackOnAGuess() = runBlocking {
    server.answer("""{"liked":[],"signedIn":true,"read":true}""")
    social.refreshMine(force = true)
    lost()
    server.answer("""{"liked":["post-1"],"signedIn":true,"read":true}""")
    assertNull(social.toggleLike("post-1", true))
    assertTrue("post-1" in social.likes.value.mine)

    lost()
    server.answer("""{"liked":["post-1"],"signedIn":true,"read":true}""")
    assertEquals("merrymen didn't answer, and that wasn't saved. Try again.", social.toggleLike("post-2", true))
    assertFalse("post-2" in social.likes.value.mine)
  }
}
