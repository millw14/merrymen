package dev.merrymen.app.groupchat

import dev.merrymen.app.data.GC_RESUME_AFTER_MS
import dev.merrymen.app.data.GcReader
import dev.merrymen.app.data.GroupChatRoom
import dev.merrymen.app.data.ScrollEnds
import dev.merrymen.app.net.Fixtures
import dev.merrymen.app.net.apiFor
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * THE ROOM OPENS ON ITS NEWEST LINE, and stays there until the reader scrolls
 * away.
 *
 * The emulator pass, signed out on app.merrymen.dev: the room opened at its
 * OLDEST loaded line under "60 new messages ↓" — on the first open, on every
 * reopen, after Try again, and when a follower rotated the phone. Played here
 * the way the screen plays it: the room read through the real client from the
 * captured pages, and each reading the screen takes handed to [GcReader] in
 * the order the screen takes them.
 */
class GroupChatReaderTest {
  private lateinit var server: MockWebServer
  private val room = RoomServer()
  private var clock = 1_790_294_830_000L

  @Before fun start() {
    server = MockWebServer()
    server.dispatcher = room
    server.start()
    room.answer = { r ->
      val p = r.path ?: ""
      when {
        p == "/api/groupchat?limit=60" -> json(Fixtures.text("probe-groupchat_limit_60.json"))
        p.startsWith("/api/groupchat?since=") -> json(Fixtures.text("probe-groupchat_since_2808.json"))
        p == "/api/groupchat/me" -> json(Fixtures.text("probe-groupchat_me-signedout.json"))
        else -> MockResponse().setResponseCode(599)
      }
    }
  }

  @After fun stop() = server.shutdown()

  private fun roomOn(scope: CoroutineScope) =
    GroupChatRoom(apiFor(server), scope, now = { clock }, pause = { awaitCancellation() })

  /**
   * THE SCREEN OPENING: the list is drawn at its top, the first reading of
   * "is a scroll in progress" comes then (false, and not at the bottom), and
   * then the log is shown.
   */
  private fun opened(reader: GcReader, epoch: Int, newestId: Long): Pair<GcReader, Boolean> {
    val ends = ScrollEnds()
    var r = reader
    if (ends.ended(false)) r = r.scrollEnded(atBottom = false, newestId = newestId)
    return r.logShown(epoch, newestId, hasRows = true)
  }

  @Test fun theRoomOpensOnItsNewestLineWithNothingCountedAsNew() = runBlocking {
    val r = roomOn(this)
    r.pollNow()
    val s = r.state.value
    assertEquals(60, s.messages.size)

    val (reader, scroll) = opened(GcReader(), s.epoch, s.messages.last().id)

    assertTrue("the newest line is put in view", scroll)
    assertTrue(reader.following)
    assertEquals("no pill: the reader has not missed anything", 0, reader.unseen(s.messages, null))
  }

  /**
   * A ROTATION: the saved reader comes back following, and the list comes
   * back where it was — which on the wider, shorter screen is mid-log. Its
   * first reading is not the reader scrolling there.
   */
  @Test fun aFollowerWhoRotatesIsStillOnTheNewestLine() = runBlocking {
    val r = roomOn(this)
    r.pollNow()
    val first = r.state.value
    val (following, _) = opened(GcReader(), first.epoch, first.messages.last().id)

    r.pollNow() // lines arrive while the reader follows
    val s = r.state.value
    assertTrue("the poll brought newer lines", s.messages.last().id > first.messages.last().id)
    val (kept, _) = following.logShown(s.epoch, s.messages.last().id, hasRows = true)

    // Recreated: the same saved values, a new screen.
    val (afterTurn, scroll) = opened(kept.copy(), s.epoch, s.messages.last().id)

    assertTrue(scroll)
    assertTrue(afterTurn.following)
    assertEquals(0, afterTurn.unseen(s.messages, null))
  }

  /** Only a scroll that ENDS away from the bottom stops the following, and then the pill counts what lands. */
  @Test fun aReaderWhoScrollsAwayIsLeftThereAndToldWhatIsNew() = runBlocking {
    val r = roomOn(this)
    r.pollNow()
    val first = r.state.value
    var (reader, _) = opened(GcReader(), first.epoch, first.messages.last().id)

    val ends = ScrollEnds()
    assertFalse(ends.ended(false))
    assertFalse("a drag under way is not an end", ends.ended(true))
    assertTrue(ends.ended(false))
    reader = reader.scrollEnded(atBottom = false, newestId = first.messages.last().id)
    assertFalse(reader.following)

    r.pollNow()
    val s = r.state.value
    val (after, scroll) = reader.logShown(s.epoch, s.messages.last().id, hasRows = true)
    assertFalse("a reader reading back is not moved", scroll)
    val arrived = s.messages.count { it.id > first.messages.last().id }
    assertTrue(arrived > 0)
    assertEquals(arrived, after.unseen(s.messages, null))
    // Their own lines are never news to them.
    val mine = s.messages.last { it.id > first.messages.last().id }
    val mineCounted = after.unseen(s.messages.map { if (it.id == mine.id) it.copy(author = "owner", slug = "me") else it }, "me")
    assertEquals(arrived - 1, mineCounted)

    // Back at the bottom: following again, nothing counted.
    val back = after.scrollEnded(atBottom = true, newestId = s.messages.last().id)
    assertTrue(back.following)
    assertEquals(0, back.unseen(s.messages, null))
    // …and leaving again counts only what lands after.
    assertEquals(0, back.scrollEnded(atBottom = false, newestId = s.messages.last().id).unseen(s.messages, null))
  }

  /**
   * A LOG THE ROOM REPLACED — the screen back after a long absence — is a
   * fresh start at the newest line, even for a reader who had scrolled away.
   */
  @Test fun aReplacedLogStartsAgainAtTheNewestLine() = runBlocking {
    val r = roomOn(this)
    r.pollNow()
    val first = r.state.value
    val (opened, _) = opened(GcReader(), first.epoch, first.messages.last().id)
    val away = opened.scrollEnded(atBottom = false, newestId = first.messages.last().id)

    clock += GC_RESUME_AFTER_MS + 1
    val poll = launch { r.follow() }
    withTimeout(5_000) { while (r.state.value.epoch == first.epoch) delay(10) }
    poll.cancelAndJoin()
    val s = r.state.value

    val (reader, scroll) = away.logShown(s.epoch, s.messages.last().id, hasRows = true)
    assertTrue(scroll)
    assertTrue(reader.following)
    assertEquals(0, reader.unseen(s.messages, null))
  }
}
