package dev.merrymen.app.groupchat

import dev.merrymen.app.data.GC_KEEP_LINES
import dev.merrymen.app.data.GroupChatRoom
import dev.merrymen.app.data.GroupChatState
import dev.merrymen.app.data.ReplyTarget
import dev.merrymen.app.data.RoomStatus
import dev.merrymen.app.data.presenceLine
import dev.merrymen.app.data.replyTarget
import dev.merrymen.app.net.apiFor
import dev.merrymen.app.net.gcMeOf
import dev.merrymen.app.net.gcPageOf
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.Json
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * THE ROOM, READ: merge, dedupe, taken-back lines, the cursor and the stale
 * presence rule, over what production answered on 2026-09-25 and through the
 * real client.
 */
class GroupChatTest {
  private lateinit var server: MockWebServer
  private val room = RoomServer()
  private var clock = 1_790_294_830_000L // ten seconds after the capture's presence was written

  @Before fun start() {
    server = MockWebServer()
    server.dispatcher = room
    server.start()
  }

  @After fun stop() = server.shutdown()

  private fun store(scope: kotlinx.coroutines.CoroutineScope, pause: suspend (Long) -> Unit = { delay(it) }) =
    GroupChatRoom(apiFor(server), scope, now = { clock }, pause = pause)

  private fun captured() {
    room.answer = { r ->
      val p = r.path ?: ""
      when {
        p == "/api/groupchat?limit=60" -> json(roomFixture("room-limit60.json"))
        p.startsWith("/api/groupchat?since=") -> json(roomFixture("room-since2808.json"))
        p.startsWith("/api/groupchat?before=2765") -> json(roomFixture("room-before2765.json"))
        p == "/api/groupchat/me" -> json(roomFixture("me-signedout.json"))
        else -> MockResponse().setResponseCode(599)
      }
    }
  }

  @Test fun theCapturedPagesDecode() {
    val page = gcPageOf(Json.parseToJsonElement(roomFixture("room-limit60.json")))!!
    assertEquals(60, page.messages.size)
    assertEquals(2824L, page.cursor)
    assertEquals(3, page.messages.count { it.call != null })
    val call = page.messages.first { it.call != null }.call!!
    assertFalse("a real fill, not paper", call.paper)
    assertEquals(52, page.room!!.awake)
    assertEquals(8, page.room!!.asleep)
    assertEquals(60, page.room!!.presence.size)
    val me = gcMeOf(Json.parseToJsonElement(roomFixture("me-signedout.json")))!!
    assertFalse(me.signedIn)
    assertFalse(me.member)
  }

  @Test fun sourceNoneIsUnreadableNeverAnEmptyRoom() {
    assertNull(gcPageOf(Json.parseToJsonElement("""{"source":"none","messages":[],"cursor":0,"room":null}""")))
    // One malformed line costs that line, not the page.
    val page = gcPageOf(
      Json.parseToJsonElement(
        """{"source":"db","messages":[${lineJson(1, "hi")},{"id":"2","at":1,"author":"agent","name":"x","body":"y"},""" +
          """{"id":3,"at":1,"author":"robot","name":"x","body":"y"}],"cursor":3}""",
      ),
    )!!
    assertEquals(listOf(1L), page.messages.map { it.id })
  }

  @Test fun aFirstReadThenAPollMergeByIdWithoutDuplicatesAndTheCursorOnlyMovesForward() = runBlocking {
    captured()
    val r = store(this)
    r.pollNow()
    var s = r.state.value
    assertEquals(RoomStatus.OK, s.status)
    assertEquals(60, s.messages.size)
    assertEquals(2824L, s.cursor)
    assertFalse(s.start)

    r.pollNow()
    // The poll re-asks sixteen ids behind the cursor, so a line committed late
    // is not lost.
    assertTrue(room.requests.any { it.path == "/api/groupchat?since=2808&limit=100" })
    s = r.state.value
    assertEquals("2765..2825, each once", 61, s.messages.size)
    assertEquals(s.messages.map { it.id }.distinct(), s.messages.map { it.id })
    assertEquals(s.messages.map { it.id }.sorted(), s.messages.map { it.id })
    assertEquals(2825L, s.cursor)

    // A quiet poll answers with the `since` it was sent, behind the cursor.
    room.answer = { json("""{"source":"db","messages":[],"cursor":2809,"room":null}""") }
    r.pollNow()
    assertEquals("never backwards", 2825L, r.state.value.cursor)
    assertEquals(61, r.state.value.messages.size)
  }

  @Test fun aLineTakenBackLeavesAndStaysGone() = runBlocking {
    captured()
    val r = store(this)
    r.pollNow()
    assertTrue(r.state.value.messages.any { it.id == 2810L })
    // The poll says 2810 was taken back — and its own messages still carry it,
    // as a read from just before the hide committed would.
    // The captured poll carries its own (empty) gone list, as every poll does.
    val since = roomFixture("room-since2808.json").replace("\"gone\":[]", "\"gone\":[2810]")
    assertTrue(since.contains("\"gone\":[2810]"))
    room.answer = { json(since) }
    r.pollNow()
    assertFalse(r.state.value.messages.any { it.id == 2810L })
    // A later page that re-delivers it does not put it back.
    room.answer = { json(roomFixture("room-since2808.json")) }
    r.pollNow()
    assertFalse(r.state.value.messages.any { it.id == 2810L })
    assertTrue(2810L in r.state.value.gone)
  }

  @Test fun anUnreadableRoomIsSaidAndAFailedPollKeepsWhatWasRead() = runBlocking {
    room.answer = { json("""{"source":"none","messages":[],"cursor":0,"room":null}""") }
    val r = store(this)
    r.pollNow()
    assertEquals(RoomStatus.UNREADABLE, r.state.value.status)
    assertTrue(r.state.value.messages.isEmpty())

    captured()
    r.pollNow()
    assertEquals(RoomStatus.OK, r.state.value.status)
    room.answer = { MockResponse().setResponseCode(503) }
    r.pollNow()
    val s = r.state.value
    assertEquals("still the room", RoomStatus.OK, s.status)
    assertTrue("and it says it is failing", s.failing)
    assertEquals(60, s.messages.size)
  }

  @Test fun noRoomOnThisServerStopsAsking() = runBlocking {
    room.answer = { MockResponse().setResponseCode(404) }
    val r = store(this)
    r.pollNow()
    assertEquals(RoomStatus.UNSUPPORTED, r.state.value.status)
    val asked = room.requests.size
    r.pollNow()
    r.pollNow()
    assertEquals(asked, room.requests.size)
  }

  @Test fun presenceFromAStoppedConductorIsNotPresence() = runBlocking {
    captured()
    val r = store(this)
    r.pollNow()
    var s = r.state.value
    assertTrue(s.roomFresh)
    assertEquals("52 awake · 8 asleep", presenceLine(s.room, s.roomFresh)!!.text)

    // The conductor stops: the summary keeps coming back unchanged, and three
    // minutes on it is no longer a claim about now.
    clock += 3 * 60_000 + 1
    r.pollNow()
    s = r.state.value
    assertFalse(s.roomFresh)
    val line = presenceLine(s.room, s.roomFresh)!!
    assertEquals("Presence unavailable", line.text)
    assertFalse(line.fresh)
  }

  @Test fun aFollowingReaderKeepsABoundedLog() = runBlocking {
    var next = 1L
    fun lines(n: Int) = (0 until n).map { lineJson(next++, "line") }
    val first = lines(60)
    room.answer = { json(pageJson(first, cursor = 60)) }
    val r = store(this)
    r.pollNow()
    repeat(4) {
      val batch = lines(100)
      val cursor = next - 1
      room.answer = { json(pageJson(batch, cursor = cursor)) }
      r.pollNow()
    }
    val s = r.state.value
    assertEquals(GC_KEEP_LINES, s.messages.size)
    assertEquals(next - 1, s.messages.last().id)
    assertFalse("trimmed, so no longer the start", s.start)

    // A reader scrolled up is never trimmed under them.
    r.setFollowing(false)
    val more = lines(100)
    val cursor = next - 1
    room.answer = { json(pageJson(more, cursor = cursor)) }
    r.pollNow()
    assertEquals(GC_KEEP_LINES + 100, r.state.value.messages.size)
  }

  @Test fun earlierPagesLoadAndAReplysOriginalIsFoundThere() = runBlocking {
    captured()
    val r = store(this)
    r.pollNow()
    var s = r.state.value
    val first = s.messages.first()
    assertEquals(2764L, first.replyTo)
    assertEquals(ReplyTarget.Earlier, replyTarget(2764, s.messages.associateBy { it.id }, first.id, s.start, s.gone))

    assertTrue(r.loadUntil(2764))
    assertTrue(room.requests.any { it.path == "/api/groupchat?before=2765&limit=60" })
    s = r.state.value
    assertEquals(120, s.messages.size)
    val t = replyTarget(2764, s.messages.associateBy { it.id }, s.messages.first().id, s.start, s.gone)
    assertTrue(t is ReplyTarget.Here)
    // A line taken back is gone for good, not "earlier".
    assertEquals(ReplyTarget.Gone, replyTarget(2000, emptyMap(), 2100, false, setOf(2000L)))
  }

  @Test fun theLoopPollsOnItsCadenceBacksOffAndStopsWhenCancelled() = runBlocking {
    captured()
    val pauses = java.util.Collections.synchronizedList(mutableListOf<Long>())
    val r = store(this) { ms ->
      pauses += ms
      delay(5)
    }
    val job = launch { r.follow() }
    withTimeout(5_000) { while (pauses.size < 3) delay(5) }
    assertEquals("3 seconds between healthy polls", 3_000L, pauses[1])
    assertTrue("follow() asks /me as the screen opens", room.count("GET", "/api/groupchat/me") >= 1)

    // Paused (repeatOnLifecycle cancels the loop): not one request more.
    job.cancel()
    job.join()
    val asked = room.requests.size
    delay(200)
    assertEquals(asked, room.requests.size)

    // An outage backs off: 3s, 6s, 12s, 24s, then 30s.
    room.answer = { MockResponse().setResponseCode(503) }
    pauses.clear()
    val failing = launch { r.follow() }
    withTimeout(5_000) { while (pauses.size < 6) delay(5) }
    failing.cancel()
    assertEquals(listOf(3_000L, 6_000L, 12_000L, 24_000L, 30_000L, 30_000L), pauses.take(6))
  }

  @Test fun aTurnEndEmptiesTheRoomAndDropsAnAnswerStillInFlight() = runBlocking {
    captured()
    val r = store(this)
    r.pollNow()
    assertEquals(60, r.state.value.messages.size)
    r.forget()
    assertEquals(GroupChatState(), r.state.value)

    // A read that left before the turn ended and lands after it is dropped.
    val hold = CountDownLatch(1)
    val asked = CompletableDeferred<Unit>()
    room.answer = { req ->
      asked.complete(Unit)
      hold.await(5, TimeUnit.SECONDS)
      json(roomFixture("room-limit60.json")).also { req.path }
    }
    val inFlight = async { r.pollNow() }
    asked.await()
    r.forget()
    hold.countDown()
    inFlight.await()
    assertEquals(GroupChatState(), r.state.value)
    assertNotNull(room.requests.lastOrNull())
  }
}
