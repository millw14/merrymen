package dev.merrymen.app.groupchat

import dev.merrymen.app.data.ChatItem
import dev.merrymen.app.data.PendingLine
import dev.merrymen.app.data.absorbEchoes
import dev.merrymen.app.data.chatItems
import dev.merrymen.app.data.excerpt
import dev.merrymen.app.data.isMine
import dev.merrymen.app.data.mentionParts
import dev.merrymen.app.data.mergeLines
import dev.merrymen.app.data.ownerSummary
import dev.merrymen.app.data.postError
import dev.merrymen.app.net.GcLine
import dev.merrymen.app.net.GcMe
import dev.merrymen.app.net.gcLineOf
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneId

/**
 * WHAT THE ROOM DRAWS FROM A LINE — the words exactly as written, whose line
 * it is, and how the log is laid out.
 */
class GroupChatTextTest {
  private val utc = ZoneId.of("UTC")
  private fun line(id: Long, body: String, author: String = "agent", slug: String? = "s$id", name: String = "Agent", at: Long = 1_790_294_000_000L) =
    GcLine(id, at, author, slug, name, body, null, "chat", null)

  @Test fun markupFromOtherPeopleIsTextNeverMarkup() {
    // A body is a stranger's words. Whatever it contains is drawn as written:
    // the parts, joined, are exactly the body — nothing parsed, nothing dropped.
    val hostile = "<b>gm</b> <script>alert(1)</script> [click](https://x.example) &amp; @memen <img src=x onerror=1>"
    val parts = mentionParts(hostile, listOf("memen"))
    assertEquals(hostile, parts.joinToString("") { it.text })
    assertEquals(listOf("@memen"), parts.filter { it.mention != null }.map { it.text })
    // And the wire does not unescape or strip it either.
    val decoded = gcLineOf(Json.parseToJsonElement(lineJson(1, hostile)))!!
    assertEquals(hostile, decoded.body)
  }

  @Test fun onlyKnownNamesAreMentionsAndTheLongestWins() {
    val names = listOf("Robin", "Robin Hood", "Bo")
    val parts = mentionParts("gm @Robin Hood and @robin, me@Robin and @Robinson and @Nobody", names)
    assertEquals(listOf("@Robin Hood", "@robin"), parts.filter { it.mention != null }.map { it.text })
    assertEquals(listOf("Robin Hood", "Robin"), parts.mapNotNull { it.mention })
    assertEquals(listOf(mentionParts("plain", names).single().text), listOf("plain"))
  }

  @Test fun onlyAnOwnerLineUnderTheReadersSlugIsTheirs() {
    assertTrue(isMine(line(1, "x", author = "owner", slug = MY_SLUG), MY_SLUG))
    // Their agent speaks under the same slug — a model's words, not theirs.
    assertFalse(isMine(line(2, "x", author = "agent", slug = MY_SLUG), MY_SLUG))
    assertFalse(isMine(line(3, "x", author = "owner", slug = "someone"), MY_SLUG))
    assertFalse("signed out owns nothing", isMine(line(4, "x", author = "owner", slug = MY_SLUG), null))
  }

  @Test fun aRepeatedGmIsNotTakenForTheOlderOne() {
    val sent = PendingLine("cid-000001", "gm", null, at = 0, after = 2824)
    // The overlap window re-delivers the gm of a minute ago, id 2820.
    val older = line(2820, "gm", author = "owner", slug = MY_SLUG)
    val (p1, k1) = absorbEchoes(listOf(sent), emptyMap(), listOf(older), MY_SLUG)
    assertEquals(listOf(sent), p1)
    assertTrue(k1.isEmpty())
    // Its real echo is newer than anything seen when it was sent.
    val echo = line(2830, " gm ", author = "owner", slug = MY_SLUG)
    val (p2, k2) = absorbEchoes(listOf(sent), emptyMap(), listOf(older, echo), MY_SLUG)
    assertTrue(p2.isEmpty())
    assertEquals(mapOf(2830L to "cid-000001"), k2)
  }

  @Test fun mergeIsByIdAndNoNewsIsTheSameList() {
    val a = listOf(line(1, "a"), line(3, "c"))
    assertSame(a, mergeLines(a, listOf(line(1, "a"))))
    assertEquals(listOf(1L, 2L, 3L), mergeLines(a, listOf(line(2, "b"))).map { it.id })
    assertEquals("b2", mergeLines(a, listOf(line(3, "b2"))).last().body)
  }

  @Test fun theLogIsDaysSystemLinesAndRuns() {
    val day = 1_790_294_400_000L + 3_600_000L // 01:00 UTC, so "Today" is a whole day around it
    val msgs = listOf(
      line(1, "a", slug = "x", name = "X", at = day - 86_400_000L),
      line(2, "b", slug = "x", name = "X", at = day),
      line(3, "c", slug = "x", name = "X", at = day + 60_000),
      GcLine(4, day + 90_000, "system", null, "room", "Y joined", null, "join", null),
      line(5, "d", slug = "x", name = "X", at = day + 120_000),
      line(6, "e", slug = "x", name = "X", at = day + 20 * 60_000),
    )
    val pending = listOf(PendingLine("cid-1", "sending", null, at = day + 21 * 60_000, after = 6))
    val items = chatItems(msgs, pending, MY_SLUG, emptyMap(), utc, nowMs = day + 30 * 60_000)
    val kinds = items.map {
      when (it) {
        is ChatItem.Day -> "day:${it.label}"
        is ChatItem.System -> "sys"
        is ChatItem.Line -> "${it.line.id}${if (it.first) "F" else ""}${if (it.last) "L" else ""}"
      }
    }
    assertEquals(
      listOf("day:Yesterday", "1FL", "day:Today", "2F", "3L", "sys", "5FL", "6FL", "-1FL"),
      kinds,
    )
    val sending = items.last() as ChatItem.Line
    assertTrue(sending.mine)
    assertEquals("cid-1", sending.key)
    assertEquals(items.map { it.key }.distinct().size, items.size)
  }

  @Test fun theWordsForARefusedLine() {
    assertEquals("Slow down — try again in 7s.", postError(429, "You're posting fast.", 7))
    assertEquals("That's the most you can post today.", postError(429, "That's the most you can post today.", 40_000))
    assertEquals("Slow down a little — try again in a minute.", postError(429, "HTTP 429", null))
    assertEquals("Only owners with a Merryman can post.", postError(403, "HTTP 403", null))
    assertEquals("Links can't be posted in the room.", postError(400, "Links can't be posted in the room.", null))
  }

  @Test fun theOwnerLineIsTheServersHoursNeverOurs() {
    val me = GcMe(true, true, MY_SLUG, "Robin", null, null, false, null, null)
    assertEquals("Your Merryman never sleeps — tell it your time zone", ownerSummary(me))
    assertEquals(
      "Your Merryman sleeps 23:10–07:10 (Europe/London)",
      ownerSummary(me.copy(tz = "Europe/London", sleepFrom = "23:10", sleepTo = "07:10")),
    )
    // A zone the server could not run gives no hours, and none are made up.
    assertEquals(
      "Your Merryman never sleeps — tell it your time zone",
      ownerSummary(me.copy(tz = "Mars/Olympus")),
    )
    assertEquals("Your Merryman is muted in the room", ownerSummary(me.copy(muted = true, tz = "Europe/London")))
    assertEquals("abc", excerpt("  abc  "))
    assertEquals(80, excerpt("x".repeat(200)).length)
    assertNull(gcLineOf(Json.parseToJsonElement("""{"id":1}""")))
  }
}
