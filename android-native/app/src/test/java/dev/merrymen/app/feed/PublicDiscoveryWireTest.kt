package dev.merrymen.app.feed

import dev.merrymen.app.net.ApiResult
import dev.merrymen.app.net.agentDirectory
import dev.merrymen.app.net.answer
import dev.merrymen.app.net.apiFor
import dev.merrymen.app.ui.feed.FeedReads
import dev.merrymen.app.ui.feed.ReadState
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class PublicDiscoveryWireTest {
  @Test fun directoryKeepsAgentsDiscoverableWithoutInventingUnreadPerformance() = runBlocking {
    val server = MockWebServer()
    server.start()
    try {
      server.answer("""{"source":"sqlite","directory":true,"fetchedAt":2000000000000,"retired":130,
        "agents":[{"slug":"desk","name":"Desk","mode":"paper","notRunning":true,
        "pnlBps":null,"paperPnlBps":null,"maxDdBps":null,"landed":null,"filledPaper":null,"refused":null,"unrankedWhy":"not-read"}]}""")
      val result = apiFor(server).agentDirectory()
      assertTrue(result is ApiResult.Ok)
      val board = (result as ApiResult.Ok).value
      assertEquals("/api/leaderboard?view=directory", server.takeRequest().path)
      assertTrue(board.directory)
      assertEquals(2000000000000L, board.fetchedAt)
      assertEquals(130, board.retired)
      assertEquals("desk", board.agents.single().slug)
      assertTrue(board.agents.single().notRunning)
      assertNull(board.agents.single().landed)
      assertNull(board.agents.single().paperPnlBps)
    } finally { server.shutdown() }
  }

  @Test fun activityUsesLeanReadAndKeepsOutcomesAndUnreadFiguresDistinct() = runBlocking {
    val server = MockWebServer()
    server.start()
    try {
      server.answer("""{"source":"sqlite","figuresIncluded":false,"tradesComplete":false,
        "theses":[{"slug":"desk","head":"sell TSLA","action":"sell","symbol":"TSLA",
        "outcome":"landed","postId":"stable-post","entryPriceUsd":null,"realizedPct":null,"realizedUsd":null}]}""")
      val reads = FeedReads(apiFor(server)) { 1000L }
      reads.thesesLoop.readNow(1000)
      assertEquals("/api/theses?view=activity", server.takeRequest().path)
      assertEquals(ReadState.OK, reads.theses.value.state)
      val page = reads.theses.value.body!!
      assertEquals(false, page.figuresIncluded)
      assertEquals(false, page.tradesComplete)
      assertEquals("landed", page.theses.single().outcome)
      assertEquals("stable-post", page.theses.single().postId)
      assertNull(page.theses.single().realizedPct)
    } finally { server.shutdown() }
  }

  @Test fun olderServerWhichIgnoresDirectoryOptionStillDecodesItsFullBoard() = runBlocking {
    val server = MockWebServer()
    server.start()
    try {
      server.answer("""{"source":"sqlite","agents":[{"slug":"desk","pnlBps":100,"landed":4}]}""")
      val board = (apiFor(server).agentDirectory() as ApiResult.Ok).value
      assertFalse(board.directory)
      assertEquals(100, board.agents.single().pnlBps)
    } finally { server.shutdown() }
  }
}
