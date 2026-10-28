package dev.merrymen.app.profile

import dev.merrymen.app.net.answer
import dev.merrymen.app.net.apiFor
import dev.merrymen.app.ui.ProfileReads
import dev.merrymen.app.ui.feed.ReadState
import dev.merrymen.app.ui.feed.ReadFailure
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test

class ProfileProgressiveReadsTest {
  @Test fun anOlderServersExplicitActivityFailureNeverBecomesAnEmptySuccessfulRead() = runBlocking {
    val server = MockWebServer(); server.start()
    try {
      val reads = ProfileReads(apiFor(server), "desk") { 1000L }
      // Before progressive endpoints, ?view was ignored and activity failure
      // lived on the full profile as thesesRead:false, without a source key.
      val unread = """{"slug":"desk","name":"Desk","mode":"paper","theses":[],"thesesRead":false}"""
      server.answer(unread)
      assertFalse(reads.activityLoop.readNow(1000))
      assertEquals(ReadState.UNREADABLE, reads.activity.value.state)
      assertEquals(ReadFailure.Ledger, reads.activity.value.failure)

      server.answer("""{"slug":"desk","name":"Desk","theses":[{"slug":"desk","head":"A view","postId":"older-post"}],"thesesRead":true}""")
      assertTrue(reads.activityLoop.readNow(2000))
      assertEquals(ReadState.OK, reads.activity.value.state)
      assertEquals("older-post", reads.activity.value.body!!.theses.single().postId)
      assertNull(reads.activity.value.failure)

      server.answer(unread)
      assertFalse(reads.activityLoop.readNow(3000))
      assertEquals(ReadState.OK, reads.activity.value.state)
      assertEquals("older-post", reads.activity.value.body!!.theses.single().postId)
      assertEquals(ReadFailure.Ledger, reads.activity.value.failure)
      assertEquals(3, server.requestCount)
    } finally { server.shutdown() }
  }

  @Test fun openingAnAgentLoadsIdentityAndActivityWithoutRequestingHistoricalDetails() = runBlocking {
    val server = MockWebServer(); server.start()
    try {
      val reads = ProfileReads(apiFor(server), "desk") { 1000L }
      server.answer("""{"summary":true,"slug":"desk","name":"Desk","mode":"paper","joinedAt":100}""")
      server.answer("""{"source":"sqlite","theses":[{"slug":"desk","head":"A view","postId":"stable"}],"figuresIncluded":false}""")
      reads.loops(false).forEach { it.readNow(1000) }
      assertEquals("/api/agents/desk?view=summary", server.takeRequest().path)
      assertEquals("/api/agents/desk?view=activity", server.takeRequest().path)
      assertEquals(2, server.requestCount)
      assertEquals(ReadState.OK, reads.summary.value.state)
      assertEquals("Desk", reads.summary.value.body!!.name)
      assertNull(reads.summary.value.body!!.landed)
      assertEquals("stable", reads.activity.value.body!!.theses.single().postId)
      assertEquals(ReadState.UNREAD, reads.profile.value.state)

      server.answer("""{"error":"History unavailable"}""", code = 503)
      reads.loop.readNow(2000)
      assertEquals("/api/agents/desk?view=details", server.takeRequest().path)
      assertNotNull(reads.profile.value.failure)
      assertEquals("Desk", reads.summary.value.body!!.name)
      assertEquals(1, reads.activity.value.body!!.theses.size)
      assertEquals(3, reads.loops(true).size)
    } finally { server.shutdown() }
  }
}
