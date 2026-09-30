package dev.merrymen.app.feed

import dev.merrymen.app.net.ApiResult
import dev.merrymen.app.net.Feed
import dev.merrymen.app.net.Fixtures
import dev.merrymen.app.net.LeaderRow
import dev.merrymen.app.net.Leaderboard
import dev.merrymen.app.net.answer
import dev.merrymen.app.net.apiFor
import dev.merrymen.app.net.ownSlugOf
import dev.merrymen.app.ui.screens.BoardTone
import dev.merrymen.app.ui.screens.boardLines
import dev.merrymen.app.ui.screens.boardTradeLine
import dev.merrymen.app.ui.screens.retiredLine
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * THE BOARD LISTS EVERYONE, over the captured /api/leaderboard (30 rows, 25 of
 * them paper, 43 accounts retired). The phone used to print every paper agent
 * as "unranked" and drop its paper return.
 */
class LeaderboardTest {
  private val board: Leaderboard = served("probe-leaderboard.json") { it.leaderboard() }
  private val lines = boardLines(board, mine = null)

  @Test fun everyAgentIsListedAndNoneIsCalledUnranked() {
    assertEquals(30, lines.size)
    assertTrue(lines.none { it.figure == "unranked" })
  }

  @Test fun paperAgentsAreStampedPaperAndShowTheirPaperReturn() {
    val paper = lines.filter { it.row.mode == "paper" }
    assertEquals(25, paper.size)
    assertTrue(paper.all { it.stamp == "Paper" })
    // A paper return that was read is printed as a percentage, labelled by the stamp...
    val glucagon = paper.single { it.row.name == "glucagon" }
    assertEquals("+71.5%", glucagon.figure)
    assertEquals(BoardTone.UP, glucagon.tone)
    assertEquals("0.0%", paper.first { it.row.paperPnlBps == 0 }.figure)
    // ...and one that was not read says why, never a number.
    val unread = paper.filter { it.row.paperPnlBps == null }
    assertTrue(unread.isNotEmpty())
    assertTrue(unread.all { it.figure == "paper trading" && it.tone == BoardTone.FAINT })
    // No paper agent is ever in the race.
    assertTrue(paper.all { it.rank == null })
  }

  @Test fun onlyLiveReturnsRankInOrder() {
    val ranked = lines.filter { it.rank != null }
    assertEquals(listOf("shogun", "Vector", "Gary", "SirSendIt"), ranked.map { it.row.name })
    assertEquals(listOf(1, 2, 3, 4), ranked.map { it.rank })
    assertEquals("+18.2%", ranked[0].figure)
    assertEquals("−10.5%", ranked[3].figure)
    assertEquals(BoardTone.DOWN, ranked[3].tone)
    // A flat return is not a gain.
    assertEquals(BoardTone.FLAT, ranked[2].tone)
    // A live agent that never filled has no position and says why.
    val never = lines.single { it.row.unrankedWhy == "never-filled" }
    assertNull(never.rank)
    assertEquals("never filled", never.figure)
  }

  @Test fun tradeCountsKeepLandedAndPaperApart() {
    assertEquals("55 trades", lines.single { it.row.name == "shogun" }.trades)
    assertEquals("4250 paper trades", lines.single { it.row.slug == "04gecqs9sk41edaf" }.trades)
    assertEquals("1 paper trade", lines.single { it.row.name == "glucagon" }.trades)
    assertEquals("2 on paper", lines.single { it.row.unrankedWhy == "never-filled" }.trades)
    // A count the board did not send is not printed as a zero.
    assertNull(boardTradeLine(LeaderRow(mode = "paper", filledPaper = null)))
    assertNull(boardTradeLine(LeaderRow(mode = "live", landed = null, filledPaper = null)))
    assertEquals("No trades yet", boardTradeLine(LeaderRow(mode = "live", landed = 0, filledPaper = 0)))
  }

  @Test fun theRetiredCountIsSaidOnlyWhenTheServerSentOne() {
    assertEquals("Retired accounts (43)", retiredLine(board))
    assertNull(retiredLine(board.copy(retired = null)))
    assertNull(retiredLine(board.copy(retired = 0)))
  }

  @Test fun theReadersOwnRowIsMarkedOnlyFromAnAgentTheFeedActuallyRead() {
    val mine = boardLines(board, mine = "8SS5EKT83WXRZH5W")
    assertEquals(1, mine.count { it.you })
    assertTrue(mine.single { it.you }.row.slug == "8ss5ekt83wxrzh5w")
    // The signed-out feed names the house fallback, which is nobody's agent —
    // and carries no slug, so nobody is marked.
    val signedOut: Feed = served("probe-feed-signedout.json") { it.feed() }
    assertNull(ownSlugOf(signedOut))
    assertFalse(boardLines(board, ownSlugOf(signedOut)).any { it.you })
  }

  /**
   * Signed in, with settings the server could not read: the NAME is the
   * fallback, but the slug is the reader's own (it comes from the identity
   * store), and their row is still theirs.
   */
  @Test fun aFallbackNameDoesNotUnmarkTheReadersOwnRow() {
    val server = MockWebServer()
    server.start()
    try {
      server.answer(
        Fixtures.text("probe-feed-signedout.json")
          .replace("\"nameSource\":\"fallback\",\"slug\":null", "\"nameSource\":\"fallback\",\"slug\":\"8ss5ekt83wxrzh5w\""),
      )
      val feed = (runBlocking { apiFor(server).feed() } as ApiResult.Ok).value
      assertEquals("fallback", feed.agent?.nameSource)
      assertEquals("8ss5ekt83wxrzh5w", ownSlugOf(feed))
      assertEquals("8ss5ekt83wxrzh5w", boardLines(board, ownSlugOf(feed)).single { it.you }.row.slug)
    } finally {
      server.shutdown()
    }
  }
}
