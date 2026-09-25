package dev.merrymen.app.feed

import dev.merrymen.app.net.Thesis
import dev.merrymen.app.net.ThesesPage
import dev.merrymen.app.ui.feed.Beat
import dev.merrymen.app.ui.feed.ChorusBeat
import dev.merrymen.app.ui.feed.FeedPill
import dev.merrymen.app.ui.feed.IN_FLIGHT_TEXT
import dev.merrymen.app.ui.feed.PillTone
import dev.merrymen.app.ui.feed.REASON_MAX
import dev.merrymen.app.ui.feed.TradeBeat
import dev.merrymen.app.ui.feed.ViewBeat
import dev.merrymen.app.ui.feed.WatchBeat
import dev.merrymen.app.ui.feed.beatsOf
import dev.merrymen.app.ui.feed.emptyFor
import dev.merrymen.app.ui.feed.lanesOf
import dev.merrymen.app.ui.feed.lineOf
import dev.merrymen.app.ui.feed.pillBeats
import dev.merrymen.app.ui.feed.pillOf
import dev.merrymen.app.ui.feed.repliesIn
import dev.merrymen.app.ui.feed.verbOf
import dev.merrymen.app.ui.feed.whenLabel
import dev.merrymen.app.ui.feed.whoOf
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/**
 * WHAT EVERY FEED ROW SAYS HAPPENED, over the production capture of 2026-09-24
 * (80 posts: 31 landed buys, 9 vault moves, 11 bare views, 29 holds).
 *
 * Every assertion is over [lineOf] and [whoOf], the exact words the Feed
 * screen draws after the agent's name — so "no sentence says held" is a claim
 * about the screen, not about a helper nobody calls.
 */
class BeatTest {
  private val page: ThesesPage = served("probe-theses.json") { it.theses() }
  private val beats = beatsOf(page.theses)

  /** Every sentence a reader could see, in every pill, with and without Real money. */
  private fun everySentence(list: List<Beat>): List<String> {
    val replies = repliesIn(list)
    return FeedPill.entries.flatMap { pill ->
      listOf(false, true).flatMap { real ->
        pillBeats(list, pill, replies, emptyMap(), real).map { "${whoOf(it)} ${lineOf(it)}" }
      }
    }
  }

  @Test fun noSentenceSaysHeldOrIsActing() {
    val said = everySentence(beats)
    assertTrue(said.isNotEmpty())
    for (s in said) {
      assertFalse("'$s' claims a hold happened", Regex("\\bheld\\b").containsMatchIn(s))
      assertFalse("'$s' is the old catch-all", s.contains("is acting"))
    }
  }

  @Test fun onlyABuyOrASellWithASymbolIsATrade() {
    val trades = beats.filterIsInstance<TradeBeat>()
    assertEquals(31, trades.size)
    assertTrue(trades.all { it.action == "buy" || it.action == "sell" })
    // Everything else is a view, and a view borrows no verb: its words are
    // the publisher's head.
    val views = beats.filterIsInstance<ViewBeat>()
    assertEquals(page.theses.size, trades.size + views.size)
    for (v in views) assertEquals(v.head, lineOf(v))
  }

  @Test fun aVaultMoveIsAViewThatSaysWhatItWas() {
    val vault = beats.filterIsInstance<ViewBeat>().filter { it.head.startsWith("vault-") }
    assertEquals(9, vault.size)
    for (v in vault) {
      assertFalse(v.hold)
      assertTrue(lineOf(v) == "vault-deposit" || lineOf(v) == "vault-withdraw")
    }
    // And it is not a trade, so the Trades pill never counts a vault move.
    val trades = pillBeats(beats, FeedPill.TRADES, emptyMap(), emptyMap(), false)
    assertTrue(trades.none { it is ViewBeat })
  }

  @Test fun aTrencherCoinIsPrintedByItsNameNotItsId() {
    val chump = beats.single { it.symbol == "T7631DACC21B" } as ViewBeat
    assertEquals("CHUMP", chump.core.label)
    assertEquals("hold CHUMP", lineOf(chump))
    assertTrue(chump.core.trench)
    for (s in everySentence(beats)) assertFalse("'$s' prints a T-id", Regex("T[0-9A-F]{11}").containsMatchIn(s))
  }

  @Test fun aLandedBuyIsBoughtAndItsPillIsABuy() {
    val buy = beats.filterIsInstance<TradeBeat>().first { it.core.actor.name == "Myla" }
    assertEquals("bought TSLA", lineOf(buy))
    val pill = pillOf(buy)
    assertEquals("Buy", pill.label)
    assertEquals(PillTone.BUY, pill.tone)
    assertFalse(pill.unsettled)
  }

  // ── the arms production did not happen to carry that day ─────────────────

  private val robin = page.theses.first { it.action == "buy" }

  private fun trade(outcome: String, text: String?, shadow: Boolean = false): TradeBeat =
    beatsOf(listOf(robin.copy(outcome = outcome, outcomeText = text, shadow = shadow))).single() as TradeBeat

  @Test fun aPendingDecisionNothingWasSentForIsATry() {
    val b = trade("pending", "no trade came of it")
    assertEquals("tried to buy", verbOf(b))
    assertEquals("Tried", pillOf(b).label)
    assertEquals(PillTone.MUTED, pillOf(b).tone)
    // Not money that moved, so not in Trades.
    assertTrue(pillBeats(listOf(b), FeedPill.TRADES, emptyMap(), emptyMap(), false).isEmpty())
  }

  @Test fun onlyAnOrderActuallySentIsBuying() {
    val b = trade("pending", IN_FLIGHT_TEXT)
    assertEquals("is buying", verbOf(b))
    assertEquals(PillTone.BUY, pillOf(b).tone)
    assertTrue("an order in flight wears an unsettled edge", pillOf(b).unsettled)
    assertEquals(1, pillBeats(listOf(b), FeedPill.TRADES, emptyMap(), emptyMap(), false).size)
  }

  @Test fun refusedRevertedAndDroppedAreTries() {
    for (o in listOf("refused", "reverted", "dropped")) {
      val b = trade(o, "past today's spending cap")
      assertEquals("tried to buy", verbOf(b))
      assertEquals("Tried", pillOf(b).label)
    }
  }

  @Test fun aShadowCallWouldBuyAndIsNeverATrade() {
    val b = trade("landed", "landed", shadow = true)
    assertEquals("would buy", verbOf(b))
    assertEquals("Would buy", pillOf(b).label)
    assertEquals(PillTone.MUTED, pillOf(b).tone)
    assertTrue(pillBeats(listOf(b), FeedPill.TRADES, emptyMap(), emptyMap(), false).isEmpty())
  }

  @Test fun aPostAboutATradeThatDidNotHappenIsNotLedWith() {
    val refused = beatsOf(listOf(robin.copy(outcome = "refused", post = "just loaded up"))).single()
    assertNull(refused.core.post)
    val landed = beatsOf(listOf(robin.copy(post = "just loaded up"))).single()
    assertEquals("just loaded up", landed.core.post)
  }

  // ── repeats, holds and the Real money toggle ──────────────────────────────

  @Test fun anUnchangedRepeatSaysTimesAndSinceAndSitsWhereItBegan() {
    val base = page.theses.first { it.action == "hold" }
    val at = base.at!!
    val repeat = beatsOf(listOf(base.copy(said = 24, unchangedSince = at - 7200))).single()
    assertEquals((at - 7200) * 1000, repeat.core.rankMs)
    assertEquals("×24 · since 2h", whenLabel(repeat, at * 1000))
    // A repeat that CHANGED in between has no "since": it sits at its own time.
    val changed = beatsOf(listOf(base.copy(said = 24, unchangedSince = null))).single()
    assertEquals(at * 1000, changed.core.rankMs)
    assertEquals("0s", whenLabel(changed, at * 1000))
  }

  @Test fun aRepeatedRefusalSitsWhereItBeganButALandedTradeNever() {
    val at = robin.at!!
    val refusal = beatsOf(listOf(robin.copy(outcome = "refused", said = 30, unchangedSince = at - 3600))).single()
    assertEquals((at - 3600) * 1000, refusal.core.rankMs)
    val landed = beatsOf(listOf(robin.copy(said = 30, unchangedSince = at - 3600))).single()
    assertEquals(at * 1000, landed.core.rankMs)
  }

  @Test fun allShowsAtMostThreeFreshHoldsPerAgentAndCountsTheRest() {
    val hold = page.theses.first { it.action == "hold" && it.symbol == "COIN" }
    val many = (0 until 6).map { i ->
      hold.copy(symbol = "S$i", head = "hold S$i", reason = "view $i", at = hold.at!! - i, postId = "p$i", moreNames = false)
    }
    val all = pillBeats(beatsOf(many), FeedPill.ALL, emptyMap(), emptyMap(), false)
    assertEquals(3, all.count { it is ViewBeat })
    val watch = all.filterIsInstance<WatchBeat>().single()
    assertEquals(3, watch.count)
    assertEquals("is still watching 3 tokens · latest: hold S3", lineOf(watch))
    // The Holds pill lays every one of them out.
    assertEquals(6, pillBeats(beatsOf(many), FeedPill.HOLDS, emptyMap(), emptyMap(), false).size)
    // A read that did not carry all of an agent's names makes the count a floor.
    val truncated = many.map { it.copy(moreNames = true) }
    val floor = pillBeats(beatsOf(truncated), FeedPill.ALL, emptyMap(), emptyMap(), false).filterIsInstance<WatchBeat>().single()
    assertEquals("is still watching at least 3 tokens · latest: hold S3", lineOf(floor))
  }

  @Test fun theSameHoldFromManyAgentsIsOneChorusNamingEveryOne() {
    val all = pillBeats(beats, FeedPill.ALL, repliesIn(beats), emptyMap(), false)
    val tsla = all.filterIsInstance<ChorusBeat>().first { it.symbol == "TSLA" }
    assertTrue(tsla.actors.size >= 2)
    assertEquals(tsla.actors.size, tsla.actors.map { it.slug }.toSet().size)
    assertEquals("TSLA · ${tsla.actors.size} agents holding", "${whoOf(tsla)} ${lineOf(tsla)}")
  }

  @Test fun realMoneyHidesEveryPaperRowBeforeAnythingIsCounted() {
    for (pill in FeedPill.entries) {
      val shown = pillBeats(beats, pill, repliesIn(beats), emptyMap(), realOnly = true)
      for (b in shown) {
        assertFalse("${whoOf(b)} ${lineOf(b)} is on paper", b.core.paper)
        if (b is ChorusBeat) assertTrue(b.members.none { it.core.paper })
      }
    }
    // The capture's one real-money trade survives it.
    assertEquals(1, pillBeats(beats, FeedPill.TRADES, emptyMap(), emptyMap(), true).size)
  }

  @Test fun anEmptyTradesPillOverAPartialReadDoesNotClaimTheWindow() {
    assertEquals("No trades in this window.", emptyFor(FeedPill.TRADES, false, tradesComplete = true))
    assertEquals(false, page.tradesComplete)
    assertEquals("No trades among the posts this read reached.", emptyFor(FeedPill.TRADES, false, page.tradesComplete))
    assertEquals("No real-money posts in this window.", emptyFor(FeedPill.ALL, true))
  }

  @Test fun keysAreUniqueSoTheListCannotCrash() {
    val twins = page.theses.take(5) + page.theses.take(5)
    val keys = lanesOf(beatsOf(twins)).map { it.key }
    assertEquals(keys.size, keys.toSet().size)
    val all = lanesOf(pillBeats(beats, FeedPill.ALL, repliesIn(beats), emptyMap(), false)).map { it.key }
    assertEquals(all.size, all.toSet().size)
  }

  @Test fun aRowWithNoSlugOrNoTimeIsNotAPost() {
    assertTrue(beatsOf(listOf(robin.copy(slug = null))).isEmpty())
    assertTrue(beatsOf(listOf(robin.copy(at = null))).isEmpty())
    val wordless = Thesis(slug = "abc", name = "x", at = 1L, head = "", reason = "  ")
    assertTrue(beatsOf(listOf(wordless)).isEmpty())
  }

  @Test fun anUnprovenHandleIsNeverTheOwner() {
    val proven = beatsOf(listOf(robin.copy(handle = "much_miller", handleVerified = true))).single()
    assertEquals("@much_miller", proven.core.actor.owner)
    val typed = beatsOf(listOf(robin.copy(handle = "much_miller", handleVerified = false))).single()
    assertNull(typed.core.actor.owner)
    assertNotNull(proven.core.actor.name)
  }

  /**
   * THE PUBLISHER'S SENTENCE AND CAP, held to the worker's source. Skipped
   * where the worker is not checked out beside the app.
   */
  @Test fun theInFlightSentenceAndTheReasonCapAreTheWorkers() {
    val policy = File("../../worker/src/thesis-policy.ts")
    assumeTrue("worker source not beside the app", policy.exists())
    val src = policy.readText()
    assertTrue(src.contains("export const IN_FLIGHT_TEXT = \"$IN_FLIGHT_TEXT\";"))
    assertTrue(src.contains("export const REASON_MAX = $REASON_MAX;"))
  }
}
