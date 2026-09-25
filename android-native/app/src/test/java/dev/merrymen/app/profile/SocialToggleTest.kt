package dev.merrymen.app.profile

import dev.merrymen.app.data.SELF_WIRE
import dev.merrymen.app.data.Social
import dev.merrymen.app.data.WireNote
import dev.merrymen.app.data.WiredState
import dev.merrymen.app.net.answer
import dev.merrymen.app.net.apiFor
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
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
    // The optimistic list is kept, but it is not a fact: no face wears the
    // ring while the control beside it says it could not confirm.
    assertTrue(w.has("desk000000000000"))
    assertFalse("no ring on a change nobody confirmed", w.rings("desk000000000000"))
    assertFalse("nor on the rest of a list we no longer know", w.rings("other0000000000a"))
  }

  @Test fun aFaceWearsTheRingOnlyOnAKnownAnswer() = runBlocking {
    assertTrue("the list read at the start is known", social.wired.value.rings("other0000000000a"))
    // The session lapsed: the server now calls this reader signed out, and
    // the last wallet's rings must not stay on every face.
    server.answer("""{"error":"unauthorized"}""", code = 401)
    social.refreshWired(force = true)
    val w = social.wired.value
    assertFalse(w.known)
    assertTrue("the list itself is kept", w.has("other0000000000a"))
    assertFalse(w.rings("other0000000000a"))
  }

  /**
   * THE READER LEFT THE PAGE WITH THE WRITE ON ITS WAY. The server refused it
   * (the reader's own agent), and that answer still lands: the ring snaps
   * back, the control is free again, and the refusal is kept for that desk.
   */
  @Test fun aWriteWhoseCallerLeftStillSettlesAndSaysWhy() = runBlocking {
    server.enqueue(
      MockResponse().setHeader("content-type", "application/json")
        .setBody("""{"wired":["other0000000000a"],"max":8,"refused":"self"}""")
        .setHeadersDelay(800, TimeUnit.MILLISECONDS),
    )
    val page = launch(Dispatchers.Default) { social.toggleWire("mine000000000000", true) }
    assertEquals("POST", server.takeRequest(2, TimeUnit.SECONDS)?.method)
    delay(100)
    page.cancelAndJoin()
    val w = social.wired.value
    assertFalse("the control is free again", w.busy)
    assertFalse("the refused ring came off", w.has("mine000000000000"))
    assertEquals(listOf("other0000000000a"), w.wired)
    assertEquals(WireNote("mine000000000000", SELF_WIRE), social.wireNote.value)

    // And the next tap, on any desk, is sent.
    server.answer("""{"wired":["desk000000000000","other0000000000a"],"max":8}""")
    assertNull(social.toggleWire("desk000000000000", true))
    assertEquals("POST", server.takeRequest(2, TimeUnit.SECONDS)?.method)
    assertTrue(social.wired.value.has("desk000000000000"))
    assertNull("a new write clears the last one's note", social.wireNote.value)
  }

  /** The same, with the answer lost after the reader left: it is still looked up. */
  @Test fun aLostAnswerWhoseCallerLeftIsStillLookedUp() = runBlocking {
    val patient = Social(
      apiFor(
        server,
        OkHttpClient.Builder().retryOnConnectionFailure(false).readTimeout(700, TimeUnit.MILLISECONDS).build(),
      ),
    )
    server.answer("""{"wired":["other0000000000a"],"max":8}""")
    patient.refreshWired(force = true)
    server.takeRequest()
    // The POST reaches the server and no answer ever comes back.
    server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.NO_RESPONSE))
    server.answer("""{"wired":["desk000000000000","other0000000000a"],"max":8}""")
    val page = launch(Dispatchers.Default) { patient.toggleWire("desk000000000000", true) }
    assertEquals("POST", server.takeRequest(2, TimeUnit.SECONDS)?.method)
    page.cancelAndJoin()
    assertEquals("the lost answer was looked up", "GET", server.takeRequest(2, TimeUnit.SECONDS)?.method)
    val w = patient.wired.value
    assertTrue(w.known)
    assertTrue("it went through, and the ring says so", w.rings("desk000000000000"))
    assertFalse(w.busy)
  }

  /**
   * A screen entry reads the list while a write is on its way. That answer
   * may be from before the write or after it, so it is not applied: it
   * neither releases the one-write guard nor takes the ring off mid-write.
   */
  @Test fun aListReadThatOverlapsAWriteNeitherReleasesItNorUndoesIt() = runBlocking {
    server.enqueue(
      MockResponse().setHeader("content-type", "application/json")
        .setBody("""{"wired":["desk000000000000","other0000000000a"],"max":8}""")
        .setHeadersDelay(800, TimeUnit.MILLISECONDS),
    )
    server.answer("""{"wired":[],"max":8}""") // the refresh, served before the write landed
    server.answer("""{"wired":[],"max":8}""") // were a second write ever sent
    val first = async(Dispatchers.Default) { social.toggleWire("desk000000000000", true) }
    assertEquals("POST", server.takeRequest(2, TimeUnit.SECONDS)?.method)
    social.refreshWired(force = true)
    assertEquals("GET", server.takeRequest(2, TimeUnit.SECONDS)?.method)
    val mid = social.wired.value
    assertTrue("still a write on its way", mid.busy)
    assertTrue("the optimistic ring stands until the write answers", mid.has("desk000000000000"))
    assertNull(social.toggleWire("desk000000000000", false))
    assertNull(first.await())
    assertEquals("one write, one read — no second write", 3, server.requestCount)
    assertEquals(listOf("desk000000000000", "other0000000000a"), social.wired.value.wired)
    assertFalse(social.wired.value.busy)
  }

  /** Signed out with a write on its way: its answer is the last wallet's, and is dropped. */
  @Test fun aSignOutMidWriteKeepsTheLastWalletsAnswerOff() = runBlocking {
    server.enqueue(
      MockResponse().setHeader("content-type", "application/json")
        .setBody("""{"wired":["other0000000000a"],"max":8,"refused":"self"}""")
        .setHeadersDelay(500, TimeUnit.MILLISECONDS),
    )
    val write = async(Dispatchers.Default) { social.toggleWire("mine000000000000", true) }
    assertEquals("POST", server.takeRequest(2, TimeUnit.SECONDS)?.method)
    social.forget()
    assertNull(write.await())
    assertEquals(WiredState(), social.wired.value)
    assertNull(social.wireNote.value)
  }

  /**
   * A like whose row scrolled out of the feed mid-write: the server refused
   * it, and the heart and the +1 still come off.
   */
  @Test fun aLikeWhoseRowScrolledAwayIsStillSettled() = runBlocking {
    server.answer("""{"liked":[],"signedIn":true,"read":true}""")
    social.refreshMine(force = true)
    server.takeRequest(2, TimeUnit.SECONDS)
    server.enqueue(
      MockResponse().setHeader("content-type", "application/json")
        .setBody("""{"liked":[],"signedIn":true,"read":true,"max":1,"refused":"at-capacity"}""")
        .setHeadersDelay(800, TimeUnit.MILLISECONDS),
    )
    val row = launch(Dispatchers.Default) { social.toggleLike("post-1", true) }
    assertEquals("POST", server.takeRequest(2, TimeUnit.SECONDS)?.method)
    row.cancelAndJoin()
    assertFalse("post-1" in social.likes.value.mine)
    assertEquals(0, social.likes.value.counts["post-1"] ?: 0)
  }

  /** A like's answer that lands after a sign-out does not fill hearts for whoever is next. */
  @Test fun aLikeAnswerAfterASignOutIsTheLastWalletsAndIsDropped() = runBlocking {
    server.answer("""{"liked":[],"signedIn":true,"read":true}""")
    social.refreshMine(force = true)
    server.takeRequest(2, TimeUnit.SECONDS)
    server.enqueue(
      MockResponse().setHeader("content-type", "application/json")
        .setBody("""{"liked":["post-1","post-9"],"signedIn":true,"read":true}""")
        .setHeadersDelay(500, TimeUnit.MILLISECONDS),
    )
    val row = async(Dispatchers.Default) { social.toggleLike("post-1", true) }
    assertEquals("POST", server.takeRequest(2, TimeUnit.SECONDS)?.method)
    social.forget()
    assertNull(row.await())
    val l = social.likes.value
    assertTrue("none of the last wallet's likes", l.mine.isEmpty())
    assertFalse(l.signedIn)
  }

  /**
   * THE NEXT WALLET SIGNED IN WHILE THE LAST ONE'S LIKE WAS ON ITS WAY. Its
   * own likes, read in between, are what stay: the late answer used to wipe
   * them and mark the reader signed out, so every heart said "Sign in".
   */
  @Test fun aLateLikeAnswerLeavesTheNextWalletsLikesAlone() = runBlocking {
    server.answer("""{"liked":[],"signedIn":true,"read":true}""")
    social.refreshMine(force = true)
    server.takeRequest(2, TimeUnit.SECONDS)
    server.enqueue(
      MockResponse().setHeader("content-type", "application/json")
        .setBody("""{"liked":["post-1","post-9"],"signedIn":true,"read":true}""")
        .setHeadersDelay(800, TimeUnit.MILLISECONDS),
    )
    val row = async(Dispatchers.Default) { social.toggleLike("post-1", true) }
    assertEquals("POST", server.takeRequest(2, TimeUnit.SECONDS)?.method)
    social.forget()
    // Wallet B signs in and reads its own likes before A's answer lands.
    server.answer("""{"liked":["post-7","post-8"],"signedIn":true,"read":true}""")
    social.refreshMine(force = true)
    assertEquals(setOf("post-7", "post-8"), social.likes.value.mine)

    assertNull("A's answer is A's, and says nothing to B", row.await())
    val l = social.likes.value
    assertEquals("B's likes stand", setOf("post-7", "post-8"), l.mine)
    assertTrue("and B is still signed in", l.signedIn)
    assertTrue(l.canLike)
  }

  /**
   * THE LAST WALLET'S WIRE WRITE DOES NOT HOLD THE NEXT WALLET'S CONTROL. Its
   * first read of its list is applied, its own tap is sent, and the late
   * answer changes nothing of B's.
   */
  @Test fun aWireWriteOnItsWayDoesNotHoldTheNextWalletsControl() = runBlocking {
    server.enqueue(
      MockResponse().setHeader("content-type", "application/json")
        .setBody("""{"wired":["adesk00000000000","other0000000000a"],"max":8}""")
        .setHeadersDelay(1_000, TimeUnit.MILLISECONDS),
    )
    val a = async(Dispatchers.Default) { social.toggleWire("adesk00000000000", true) }
    assertEquals("POST", server.takeRequest(2, TimeUnit.SECONDS)?.method)
    social.forget()

    server.answer("""{"wired":["bdesk00000000000"],"max":8}""")
    social.refreshWired(force = true)
    assertEquals("GET", server.takeRequest(2, TimeUnit.SECONDS)?.method)
    assertEquals("B's first read is applied", WiredState(listOf("bdesk00000000000"), 8, known = true), social.wired.value)

    server.answer("""{"wired":["bdesk00000000000","cdesk00000000000"],"max":8}""")
    assertNull(social.toggleWire("cdesk00000000000", true))
    assertEquals("B's tap was sent", "POST", server.takeRequest(2, TimeUnit.SECONDS)?.method)

    assertNull(a.await())
    assertEquals(listOf("bdesk00000000000", "cdesk00000000000"), social.wired.value.wired)
    assertFalse(social.wired.value.busy)
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
