package dev.merrymen.app.orders

import dev.merrymen.app.data.OrderFollow
import dev.merrymen.app.data.receiptText
import dev.merrymen.app.net.OrderPoll
import dev.merrymen.app.net.OrderReceipt
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * THE FOLLOW'S TIMING, ON A FAKE CLOCK.
 *
 * The bug was a fixed seven-minute guess against a window the server sets per
 * order; at the hosted tick an unclaimed order is only "expired" after 8m15s
 * plus two minutes of grace. These run the real loop with a clock that moves
 * only when the loop sleeps, so eleven minutes pass in a millisecond and every
 * poll's moment is recorded.
 */
class OrderFollowTest {
  private class Run(var now: Long = 0L) {
    val asked = mutableListOf<Long>()
    val said = mutableListOf<Pair<String, OrderPoll?>>()
    var alive = true
  }

  private fun follow(
    run: Run,
    giveUpAt: Long,
    answer: (Long) -> OrderPoll?,
  ) = runBlocking {
    OrderFollow.followUntil(
      id = "a".repeat(32),
      giveUpAt = giveUpAt,
      poll = { run.asked += run.now; answer(run.now) },
      sleep = { run.now += it },
      now = { run.now },
      alive = { run.alive },
      say = { line, poll -> run.said += line to poll },
    )
  }

  private val queued = OrderPoll(state = "queued", result = null, receipt = null)

  @Test fun theHostedWindowIsWaitedOutPastTenMinutesAndEndsByElevenFifteen() {
    val run = Run()
    // POST at the hosted 240s tick answers expiresInMs = 2 ticks + 15s = 495s.
    val until = OrderFollow.followDeadline(495_000, now = run.now)
    assertEquals("window + 2 min grace + 1 min slack", 675_000L, until)
    follow(run, until) { queued }
    assertTrue("still asking at ten minutes — the old follow had quit at seven", run.asked.any { it >= 10 * 60_000L })
    assertTrue("never asks past 11m15s", run.asked.last() <= 675_000L)
    assertEquals(1, run.said.size)
    assertTrue(run.said[0].first.startsWith("That order is still waiting for my worker"))
    assertNull("nothing unanswered passes for a receipt", run.said[0].second)
  }

  @Test fun expiredIsTerminalAndSaysNothingWasSent() {
    val run = Run()
    follow(run, OrderFollow.followDeadline(495_000, 0)) { t ->
      if (t < 60_000) queued else OrderPoll("expired", null, null)
    }
    assertEquals(
      "That order expired before my worker picked it up, so nothing was sent. Ask again if you still want it.",
      run.said.single().first,
    )
    assertEquals("stopped at the first terminal answer", 60_000L, run.asked.last())
  }

  @Test fun doneWithNoResultIsTerminalRatherThanALoop() {
    val run = Run()
    follow(run, OrderFollow.followDeadline(495_000, 0)) { OrderPoll("done", "   ", null) }
    assertEquals(1, run.asked.size)
    assertEquals(
      "My worker closed that order without saying how it went. Check your trades before asking again.",
      run.said.single().first,
    )
  }

  @Test fun doneWithAResultRepeatsTheWorkersWordsAndCarriesTheReceipt() {
    val run = Run()
    val receipt = OrderReceipt(status = "filled", side = "buy", symbol = "CASHCAT", usdgActual = 5.0)
    follow(run, OrderFollow.followDeadline(495_000, 0)) { OrderPoll("done", "Bought CASHCAT.", receipt) }
    assertEquals("Bought CASHCAT.", run.said.single().first)
    assertEquals("[Buy] \$5.00 CASHCAT · Filled", receiptText(run.said.single().second!!.receipt!!))
  }

  @Test fun noWindowWaitsSixteenMinutes() {
    val run = Run()
    val until = OrderFollow.followDeadline(null, now = 0)
    assertEquals(16 * 60_000L, until)
    follow(run, until) { OrderPoll("running", null, null) }
    assertTrue(run.asked.any { it >= 15 * 60_000L })
    assertTrue(run.said.single().first.startsWith("My worker has that order and has not answered yet"))
  }

  @Test fun aFailedOrThrowingPollIsNotAnOutcome() {
    val run = Run()
    // null is what a 503 or a dropped poll reads as; a throw is a poll that broke.
    follow(run, OrderFollow.followDeadline(495_000, 0)) { t ->
      when {
        t < 30_000 -> null
        t < 60_000 -> throw IllegalStateException("poll broke")
        else -> OrderPoll("done", "Refused: past the per-trade cap.", null)
      }
    }
    assertEquals("Refused: past the per-trade cap.", run.said.single().first)
  }

  @Test fun onlyUnreadPollsEndInTheUnknownLine() {
    val run = Run()
    follow(run, OrderFollow.followDeadline(0, 0)) { null }
    assertTrue(run.said.single().first.startsWith("I could not get an answer about that order"))
  }

  @Test fun aFollowResumedPastItsDeadlineStillAsksOnce() {
    val run = Run(now = 3_600_000)
    follow(run, giveUpAt = 60_000) { OrderPoll("done", "Sold TSLA.", null) }
    assertEquals(1, run.asked.size)
    assertEquals("Sold TSLA.", run.said.single().first)
  }

  @Test fun anotherOwnersThreadHearsNothing() {
    val run = Run()
    follow(run, OrderFollow.followDeadline(495_000, 0)) { t ->
      if (t >= 20_000) run.alive = false
      queued
    }
    assertTrue("the follow stops without a word once the owner changed", run.said.isEmpty())
  }

  @Test fun theServersPlacementTimeIsTheDifferenceOfItsTwoFigures() {
    assertEquals(1_000_000L, OrderFollow.serverPlacedAt(1_495_000, 495_000))
    assertNull(OrderFollow.serverPlacedAt(null, 495_000))
    assertNull(OrderFollow.serverPlacedAt(1_495_000, -1))
    assertNull(OrderFollow.followWindowMs(-5))
  }
}
