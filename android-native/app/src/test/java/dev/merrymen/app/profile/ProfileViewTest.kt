package dev.merrymen.app.profile

import dev.merrymen.app.data.Loaded
import dev.merrymen.app.feed.served
import dev.merrymen.app.net.AgentProfile
import dev.merrymen.app.net.ApiResult
import dev.merrymen.app.net.Fixtures
import dev.merrymen.app.net.GrowthPoint
import dev.merrymen.app.net.HowItTrades
import dev.merrymen.app.net.OwnBook
import dev.merrymen.app.net.ProfileGas
import dev.merrymen.app.net.ProfileTrade
import dev.merrymen.app.net.agentProfile
import dev.merrymen.app.net.answer
import dev.merrymen.app.net.apiFor
import dev.merrymen.app.ui.ChartWindow
import dev.merrymen.app.ui.FigureSign
import dev.merrymen.app.ui.OwnAgent
import dev.merrymen.app.ui.ProfileList
import dev.merrymen.app.ui.ProfileReads
import dev.merrymen.app.ui.SwapTab
import dev.merrymen.app.ui.WindowSlice
import dev.merrymen.app.ui.chartWindows
import dev.merrymen.app.ui.decisionSize
import dev.merrymen.app.ui.decisionsList
import dev.merrymen.app.ui.defaultWindow
import dev.merrymen.app.ui.drawdownLine
import dev.merrymen.app.ui.feed.ReadFailure
import dev.merrymen.app.ui.feed.TradeBeat
import dev.merrymen.app.ui.feed.beatsOf
import dev.merrymen.app.ui.feed.lineOf
import dev.merrymen.app.ui.feed.usd
import dev.merrymen.app.ui.fillsList
import dev.merrymen.app.ui.gasLine
import dev.merrymen.app.ui.growthPointsOf
import dev.merrymen.app.ui.growthWindow
import dev.merrymen.app.ui.ownAgentOf
import dev.merrymen.app.ui.ownBookOf
import dev.merrymen.app.ui.returnOf
import dev.merrymen.app.ui.showMoneyOf
import dev.merrymen.app.ui.statsParts
import dev.merrymen.app.ui.swapRows
import dev.merrymen.app.ui.swapViewOf
import dev.merrymen.app.ui.thesisOfHow
import dev.merrymen.app.ui.topTradeFigures
import dev.merrymen.app.ui.topTradesList
import dev.merrymen.app.ui.wireOffered
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.ZoneOffset

/**
 * WHAT AN AGENT'S PAGE SAYS, over two production captures: a paper agent
 * (probe-agent.json) and a live one with 59 fills, five top trades and a
 * private book (probe-agent-live.json, GET /api/agents/bm74qsj64fygkhjh,
 * signed out, 2026-09-25).
 */
class ProfileViewTest {
  private val paper: AgentProfile = served("probe-agent.json") { it.agentProfile("q4sxmmxay96ew2vq") }
  private val live: AgentProfile = served("probe-agent-live.json") { it.agentProfile("bm74qsj64fygkhjh") }

  @Test fun bothCapturesDecodeWithTheirOwnDecisions() {
    assertEquals("paper", paper.mode)
    assertEquals(false, paper.publicBook)
    assertEquals(true, paper.thesesRead)
    assertEquals(4, paper.theses.size)
    assertEquals(122, growthPointsOf(paper.growth).size)
    assertEquals("live", live.mode)
    assertEquals(59, live.recentTrades!!.size)
    assertEquals(5, live.topTrades!!.size)
    assertEquals(57, live.theses.size)
    assertEquals(1859.0, live.pnlBps!!, 0.0)
  }

  @Test fun aStrangerSeesNoDollarOnAPrivateBook() {
    assertFalse(showMoneyOf(live.publicBook, null))
    // Even when the server hands the page dollars it should not have sent,
    // none of them is printed.
    val leaked = live.recentTrades!!.map { it.copy(sizeUsdg = 50.0, realizedPnlUsdg = 1.23) } +
      live.topTrades!!.map { it.copy(sizeUsdg = 50.0, realizedPnlUsdg = -4.56) }
    val printed = leaked.flatMap { t ->
      val v = swapViewOf(t, showMoney = false)
      val f = topTradeFigures(t, showMoney = false)
      listOfNotNull(v.coin, v.size, v.chip?.first, f.pct, f.usd)
    } + listOfNotNull(gasLine(live, showMoney = false)) +
      beatsOf(live.theses.map { it.copy(sizeUsdg = 25.0) }).mapNotNull { decisionSize(it, showMoney = false)?.let { usd(it) } }
    assertTrue(printed.isNotEmpty())
    // The injected sizes are real sizes: the owner's view would print them.
    assertTrue(beatsOf(live.theses.map { it.copy(sizeUsdg = 25.0) }).any { decisionSize(it, showMoney = true) == 25.0 })
    for (s in printed) assertFalse("'$s' is a dollar on a private book", s.contains("$"))
  }

  @Test fun theOwnersViewAndAPublicBookShowTheirDollars() {
    val own = OwnBook(recentTrades = live.recentTrades, activityRead = true, topTrades = live.topTrades, topTradesRead = true)
    assertTrue(showMoneyOf(false, own))
    assertTrue(showMoneyOf(true, null))
    assertFalse(showMoneyOf(null, null))
    val sell = ProfileTrade(action = "sell", symbol = "WALLET", realizedPnlBps = 283.0, realizedPnlUsdg = 1.5, sizeUsdg = 54.5)
    assertEquals("+2.8% · +$1.50", swapViewOf(sell, showMoney = true).chip!!.first)
    assertEquals("$54.50", swapViewOf(sell, showMoney = true).size)
    assertEquals("+$1.50", topTradeFigures(sell, showMoney = true).usd)
    assertEquals("Net of $0.00 in priced gas.", gasLine(live, showMoney = true))
  }

  @Test fun theTopTradeReturnIsAlwaysShownAndSigned() {
    val figures = live.topTrades!!.map { topTradeFigures(it, showMoney = false) }
    assertEquals(listOf("+7.5%", "+5.5%", "+3.4%", "+2.8%", "+0.5%"), figures.map { it.pct })
    assertTrue(figures.all { it.sign == FigureSign.UP && it.usd == null })
    assertEquals(FigureSign.DOWN, topTradeFigures(ProfileTrade(realizedPnlBps = -2774.0), false).sign)
  }

  @Test fun aTrencherFillIsNamedByItsNameNotItsId() {
    val wallet = live.topTrades!!.first()
    assertEquals("TA151B4A9E1B", wallet.symbol)
    assertEquals("WALLET", swapViewOf(wallet, false).coin)
    // No name and no symbol is said, not guessed.
    assertEquals("Token label unavailable", swapViewOf(ProfileTrade(action = "sell"), false).coin)
  }

  @Test fun onlyASellCarriesAPnlChip() {
    val rows = swapRows(live.recentTrades!!, SwapTab.ALL, showMoney = false)
    assertEquals(59, rows.size)
    assertTrue(rows.filter { it.pill != "Sell" }.all { it.chip == null })
    assertEquals("Swap", rows.first { it.sign == null }.pill)
    assertTrue(swapRows(live.recentTrades!!, SwapTab.SELLS, false).all { it.pill == "Sell" })
    // Newest first.
    val ats = rows.mapNotNull { it.at }
    assertEquals(ats.sortedDescending(), ats)
  }

  @Test fun theDecisionsAreToldTheWayTheFeedTellsThem() {
    val beats = beatsOf(live.theses)
    val tid = Regex("T[0-9A-F]{11}")
    for (b in beats) {
      val line = lineOf(b)
      assertFalse(line, Regex("\\bheld\\b").containsMatchIn(line))
      // Where the coin has a name, the id is never what a reader reads. (Two
      // holds in the capture name coins nobody named; the id is all there is.)
      val named = b.core.label != null && !tid.matches(b.core.label!!)
      if (named) assertFalse(line, tid.containsMatchIn(line))
    }
    // A decision nothing was sent for is a try, never "is buying".
    val pending = beats.filterIsInstance<TradeBeat>().filter { it.core.outcome == "pending" }
    assertEquals(3, pending.size)
    assertTrue(pending.all { lineOf(it).startsWith("tried to") })
  }

  // ── the chart ─────────────────────────────────────────────────────────────

  private fun pts(vararg at: Long) = at.map { GrowthPoint(it, 1.0 + it / 1e9) }

  @Test fun aWindowTheHistoryDoesNotReachIsRefusedNotRelabelled() {
    val now = 1_000_000L
    // Nine hours of history.
    val nine = growthPointsOf(pts(now - 9 * 3600, now - 3600, now))
    assertEquals(WindowSlice.Short, growthWindow(nine, ChartWindow.DAY, now, true))
    assertTrue(growthWindow(nine, ChartWindow.ALL, now, true) is WindowSlice.Ok)
    // A read that hit its cap has no ALL to offer.
    assertEquals(WindowSlice.Partial, growthWindow(nine, ChartWindow.ALL, now, false))
    // Two days: 24H starts at the last reading at or before its start.
    val two = growthPointsOf(pts(now - 2 * 86_400, now - 86_400 - 60, now - 3600, now))
    val day = growthWindow(two, ChartWindow.DAY, now, true) as WindowSlice.Ok
    assertEquals(now - 86_400 - 60, day.from)
    assertEquals(3, day.values.size)
  }

  @Test fun theDefaultIsAllWhenTheWholePeriodWasRead() {
    val points = growthPointsOf(paper.growth)
    val now = points.last().first
    val windows = chartWindows(points, true, now).toMap()
    assertEquals(true, windows[ChartWindow.DAY])
    assertEquals(false, windows[ChartWindow.WEEK])
    assertEquals(false, windows[ChartWindow.MONTH])
    assertEquals(true, windows[ChartWindow.ALL])
    assertEquals(ChartWindow.ALL, defaultWindow(points, true, now))
    // Capped: the longest window the history backs.
    assertEquals(ChartWindow.DAY, defaultWindow(points, false, now))
  }

  // ── the words ─────────────────────────────────────────────────────────────

  @Test fun theStatsLineHasOnlyWhatWasRead() {
    assertEquals(
      listOf("59 trades", "Joined Sep 12, 2026"),
      statsParts(live.tradeCount, live.tradeCountFloor, live.avgHoldSec, live.joinedAt, false, live.gasless, ZoneOffset.UTC),
    )
    assertTrue(statsParts(null, null, null, null, false, false).isEmpty())
    assertEquals(listOf("5,000+ paper trades", "avg hold 3h 20m"), statsParts(5000, true, 12_000.0, null, true, true))
    assertEquals(listOf("1 trade", "Gasless: every trade sponsored"), statsParts(1, false, null, null, false, true))
  }

  @Test fun theReturnIsLabelledAndNeverInvented() {
    val p = returnOf(paper)
    assertEquals("Paper return", p.label)
    assertEquals(0.0, p.bps!!, 0.0)
    val l = returnOf(live)
    assertEquals("Net return on contributed capital", l.label)
    assertNull(l.note)
    val unranked = returnOf(live.copy(pnlBps = null, unrankedWhy = "no-deposit"))
    assertNull(unranked.bps)
    assertEquals("No deposit on record.", unranked.note)
    assertTrue(returnOf(paper.copy(paperPnlBps = null)).note!!.startsWith("Paper return is unavailable"))
  }

  @Test fun theGasLineIsTrueWithoutADollar() {
    assertEquals("No gas came out of this return: every trade was sponsored.", gasLine(live.copy(gasless = true), false))
    assertEquals(
      "Net of the gas it paid, where that gas could be priced. 3 trades had gas we could not price; this is not the full cost.",
      gasLine(live.copy(gas = ProfileGas(1.2, 3)), false),
    )
    assertNull("a paper book pays no gas", gasLine(paper, true))
  }

  @Test fun theApproachIsOnlyWhatWasPublished() {
    assertEquals("", thesisOfHow(null))
    assertEquals("", thesisOfHow(HowItTrades(kind = "strategy", name = "made-up")))
    assertTrue(thesisOfHow(HowItTrades(kind = "strategy", name = "trencher")).startsWith("Trades newly launched coins"))
    assertEquals(
      "Reads the market and decides each trade with gpt-x via groq.",
      thesisOfHow(HowItTrades(kind = "model", provider = "groq", model = "gpt-x")),
    )
  }

  @Test fun theDeepestDropIsSaidAsAFloorAndOnlyBesideARankedReturn() {
    assertEquals(8370.0, live.maxDdBps!!, 0.0)
    val line = drawdownLine(live)!!
    assertTrue(line, line.contains("at least 83.7%"))
    assertTrue(line, line.contains("hourly closes"))
    assertNull("a paper book's index is not the one it was measured on", drawdownLine(paper))
    assertNull("an unranked book has no drop to speak of", drawdownLine(live.copy(pnlBps = null, unrankedWhy = "no-deposit")))
    assertNull("unread is left out, never 0%", drawdownLine(live.copy(maxDdBps = null)))
    assertTrue(drawdownLine(live.copy(maxDdBps = 0.0))!!.startsWith("No drop from a peak"))
  }

  // ── each list: unread is never empty ──────────────────────────────────────

  @Test fun topTradesThatWereNotReadAreNeverNoClosedTrades() {
    assertEquals(5, (topTradesList(live, null) as ProfileList.Rows).rows.size)
    assertEquals(ProfileList.Unread, topTradesList(live.copy(topTradesRead = false), null))
    assertEquals(ProfileList.Unread, topTradesList(live.copy(topTradesRead = null), null))
    assertEquals(ProfileList.Empty, topTradesList(live.copy(topTrades = emptyList(), topTradesRead = true), null))
    assertNull("a server that sent no list draws no section", topTradesList(live.copy(topTrades = null, topTradesRead = null), null))
    // The owner's own read is the answer when there is one.
    val ownEmpty = OwnBook(topTrades = emptyList(), topTradesRead = true)
    assertEquals(ProfileList.Empty, topTradesList(live.copy(topTradesRead = false), ownEmpty))
  }

  @Test fun fillsThatWereNotReadAreNeverNoneRecorded() {
    assertEquals(59, (fillsList(live, null) as ProfileList.Rows).rows.size)
    assertEquals(ProfileList.Unread, fillsList(live.copy(activityRead = false), null))
    assertEquals("a list never sent is unread, not loading", ProfileList.Unread, fillsList(live.copy(recentTrades = null), null))
    assertEquals(ProfileList.Unread, fillsList(live.copy(recentTrades = emptyList(), activityRead = null), null))
    assertEquals(ProfileList.Empty, fillsList(live.copy(recentTrades = emptyList(), activityRead = true), null))
    val own = OwnBook(recentTrades = live.recentTrades!!.take(2), activityRead = true)
    assertEquals(2, (fillsList(live.copy(activityRead = false), own) as ProfileList.Rows).rows.size)
  }

  /** M09: an unreadable ledger is not "nothing published". */
  @Test fun decisionsThatWereNotReadAreNeverNothingPublished() {
    val read = decisionsList(live) as ProfileList.Rows
    assertEquals(beatsOf(live.theses).size, read.rows.size)
    assertTrue(read.rows.isNotEmpty())
    assertEquals(ProfileList.Unread, decisionsList(live.copy(thesesRead = false)))
    assertEquals(ProfileList.Unread, decisionsList(live.copy(thesesRead = null)))
    assertEquals(ProfileList.Empty, decisionsList(live.copy(theses = emptyList(), thesesRead = true)))
  }

  // ── whose page this is ────────────────────────────────────────────────────

  @Test fun theWireIsNotOfferedOnYourOwnAgentNorBeforeWeKnowWhichThatIs() {
    val slug = "bm74qsj64fygkhjh"
    assertFalse("still asking: never flashed onto the owner's own page", wireOffered(slug, ownKnown = false, ownSlug = null, own = null))
    assertTrue("signed out, or no agent we read", wireOffered(slug, ownKnown = true, ownSlug = null, own = null))
    assertTrue("somebody else's agent", wireOffered(slug, ownKnown = true, ownSlug = "q4sxmmxay96ew2vq", own = null))
    assertFalse("the reader's own agent", wireOffered(slug, ownKnown = true, ownSlug = slug.uppercase(), own = null))
    // The server answering /own for this session is it saying the slug is theirs.
    assertFalse(wireOffered(slug, ownKnown = true, ownSlug = null, own = OwnBook()))
  }

  /**
   * THE READER'S OWN AGENT IS THEIR FEED'S SLUG, whatever the NAME came from.
   * Signed in with settings that could not be read, /api/feed names the agent
   * `"fallback"` — and still carries the tenant's real slug, because the slug
   * comes from the identity store, not the settings. A feed that could not be
   * read at all settles nothing, so the wire waits rather than guesses.
   */
  @Test fun theReadersOwnAgentIsTheirFeedsSlugAndAnUnreadFeedSettlesNothing() = runBlocking {
    val server = MockWebServer()
    server.start()
    try {
      val api = apiFor(server)
      val slug = "bm74qsj64fygkhjh"
      server.answer(
        Fixtures.text("probe-feed-signedout.json")
          .replace("\"nameSource\":\"fallback\",\"slug\":null", "\"nameSource\":\"fallback\",\"slug\":\"$slug\""),
      )
      val own = ownAgentOf(identityKnown = true, signedIn = "0x00000000000000000000000000000000000000aa") { api.feed() }
      assertEquals(OwnAgent.Known(slug), own)
      assertFalse("no wire on their own page", wireOffered(slug, ownKnown = true, ownSlug = (own as OwnAgent.Known).slug, own = null))

      repeat(3) { server.answer("""{"error":"upstream"}""", code = 503) }
      val unread = ownAgentOf(identityKnown = true, signedIn = "0x00000000000000000000000000000000000000aa") { api.feed() }
      assertEquals("a failed read is not 'no agent'", OwnAgent.Asking, unread)

      // Signed out is settled without asking; an unanswered session is not.
      assertEquals(OwnAgent.Known(null), ownAgentOf(identityKnown = true, signedIn = null) { error("not asked") })
      assertEquals(OwnAgent.Asking, ownAgentOf(identityKnown = false, signedIn = null) { error("not asked") })
    } finally {
      server.shutdown()
    }
  }

  // ── the reads ─────────────────────────────────────────────────────────────

  @Test fun anUnknownAgentIsNotFoundAndAMalformedIdIsNeverSent() = runBlocking {
    val server = MockWebServer()
    server.start()
    try {
      val reads = ProfileReads(apiFor(server), "zzzzzzzzzzzzzzzz")
      server.answer("""{"error":"Agent not found"}""", code = 404)
      reads.loop.readNow(0)
      val failure = reads.profile.value.failure as ReadFailure.Answer
      assertEquals(Loaded.Refused(404, "Agent not found"), failure.loaded)

      val bad = apiFor(server).agentProfile("../../api/feed")
      assertTrue(bad is ApiResult.Refused && bad.status == 400)
      assertEquals(1, server.requestCount)
    } finally {
      server.shutdown()
    }
  }

  @Test fun theOwnBookIsNullForAnyoneButTheOwnerAndAnUnreadListIsNotEmpty() {
    assertNull(ownBookOf(ApiResult.Refused(404, "Agent not found")))
    assertNull(ownBookOf(ApiResult.Unreachable("timeout")))
    val unread = ownBookOf(ApiResult.Ok(OwnBook(recentTrades = emptyList(), activityRead = false, topTrades = emptyList(), topTradesRead = true)))!!
    assertNull("a list the server could not read is null, not empty", unread.recentTrades)
    assertEquals(emptyList<ProfileTrade>(), unread.topTrades)
  }
}
