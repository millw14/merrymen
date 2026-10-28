package dev.merrymen.app.feed

import dev.merrymen.app.net.AgentProfile
import dev.merrymen.app.net.BookPerformance
import dev.merrymen.app.net.LeaderRow
import dev.merrymen.app.net.Leaderboard
import dev.merrymen.app.net.ApiResult
import dev.merrymen.app.net.answer
import dev.merrymen.app.net.apiFor
import dev.merrymen.app.ui.publicPerformance
import dev.merrymen.app.ui.returnOf
import dev.merrymen.app.ui.drawdownLine
import dev.merrymen.app.ui.gasLine
import dev.merrymen.app.ui.screens.boardLines
import dev.merrymen.app.ui.screens.boardTradeLine
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.*
import org.junit.Test

class PublicPerformanceTest {
  @Test fun aCurrentServersUnknownReturnNeverFallsBackToLegacyFigures() {
    val p = BookPerformance(book = "paper", pnlBps = null)
    val view = returnOf(AgentProfile(mode = "paper", paperPnlBps = 1200.0, performance = p))
    assertNull(view.bps)
    assertEquals("Return unavailable", view.state)
    assertEquals("Return unavailable", boardLines(Leaderboard(agents = listOf(LeaderRow(mode = "paper", paperPnlBps = 1200, performance = p))), null).single().figure)
    val live = boardLines(Leaderboard(agents = listOf(LeaderRow(mode = "live", pnlBps = 1200, performance = p.copy(book = "live")))), null).single()
    assertNull("a legacy eligible return cannot rank a modern unread return", live.rank)
    assertEquals("Return unavailable", live.figure)
  }

  @Test fun returnsUnderReviewAndUnpublishedDollarsStayHiddenEvenIfCarriedOnTheWire() {
    val p = BookPerformance(book = "live", pnlBps = 250.5, pnlUsdg = 50.0, equityUsdg = 1000.0,
      publicBook = false, underReview = true, gasComplete = true)
    val view = publicPerformance(p, "live", 250.0, null)
    assertEquals("Return under review", view.state)
    assertNull(view.bps)
    assertEquals("Private", view.value)
    assertNull(view.pnl)
    val row = boardLines(Leaderboard(agents = listOf(LeaderRow(mode = "live", pnlBps = 250, performance = p))), null).single()
    assertNull(row.rank)
    assertEquals("Return under review", row.figure)
    val profile = AgentProfile(mode = "live", pnlBps = 250.0, maxDdBps = 50.0, gasless = true, performance = p)
    assertNull(gasLine(profile, true))
    assertNull(drawdownLine(profile))
    assertNull(drawdownLine(profile.copy(performance = p.copy(underReview = false, pnlBps = null))))
  }

  @Test fun noTradesAndAnUnvaluedTradeAreNotFlatPerformance() {
    val empty = BookPerformance(book = "paper", pnlBps = 0.0, fills = 0, fillsAtMark = 0)
    assertEquals("No trades yet", publicPerformance(empty, "paper", null, null).state)
    val waiting = empty.copy(fills = 1, fillsAtMark = 0, valuation = "awaiting")
    assertEquals("Awaiting first valuation", publicPerformance(waiting, "paper", null, null).state)
    val realReturn = waiting.copy(pnlBps = 150.25)
    assertNull(publicPerformance(realReturn, "paper", null, null).state)
    assertTrue(publicPerformance(realReturn, "paper", null, null).note!!.contains("awaiting valuation"))
    assertNull(publicPerformance(empty.copy(fills = 0, fillsAtMark = 2), "paper", null, null).state)
  }

  @Test fun approximateAndRetainedPaperReturnsStayOutsideLiveRankings() {
    val p = BookPerformance(book = "paper", pnlBps = 125.5, pnlEstimated = true,
      gasComplete = false, equityAt = 1000, held = true)
    val row = boardLines(Leaderboard(agents = listOf(LeaderRow(mode = "live", pnlBps = 500, performance = p, notRunning = true))), null).single()
    assertNull(row.rank)
    assertEquals("Not running", row.stamp)
    assertTrue(row.figure.startsWith("≈ "))
    assertTrue(row.note!!.contains("Last valued"))
    assertTrue(row.note!!.contains("Approximate"))
    assertEquals("Paper return", returnOf(AgentProfile(mode = "live", pnlBps = 500.0, performance = p)).label)
  }

  @Test fun currentWireDecodesDistinctTradeCountsAndRetiredAccounts() = runBlocking {
    val server = MockWebServer(); server.start()
    try {
      server.answer("""{"source":"sqlite","agents":[{"slug":"desk","mode":"live","landed":2,"liveFills":1,
        "filledPaper":4,"paperFills":1,"performance":{"book":"live","pnlBps":12.75,"pnlAt":1000,"equityAt":1001,
        "publicBook":false,"gasComplete":false,"pnlEstimated":true,"fills":1,"fillsAtMark":1,"underReview":false}}],
        "retired":1,"retiredAgents":[{"name":"Past desk","book":"paper","pnlBps":12.75,"estimated":true,"trades":3,"lastValuedAt":1000}]}""")
      val b = (apiFor(server).leaderboard() as ApiResult.Ok).value
      assertEquals("1 trade", boardTradeLine(b.agents.single()))
      assertEquals(12.75, b.agents.single().performance!!.pnlBps!!, 0.0)
      assertEquals(1, b.retiredAgents.size)
      assertEquals(3, b.retiredAgents.single().trades)
      assertTrue(b.retiredAgents.single().estimated)
    } finally { server.shutdown() }
  }
}
