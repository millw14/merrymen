package dev.merrymen.app.feed

import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import dev.merrymen.app.net.Fixtures
import dev.merrymen.app.net.answer
import dev.merrymen.app.net.apiFor
import dev.merrymen.app.ui.feed.DISCOVERIES_EVERY_MS
import dev.merrymen.app.ui.feed.FeedReads
import dev.merrymen.app.ui.feed.ReadFailure
import dev.merrymen.app.ui.feed.ReadLoop
import dev.merrymen.app.ui.feed.ReadState
import dev.merrymen.app.ui.feed.THESES_EVERY_MS
import dev.merrymen.app.ui.feed.nextReadIn
import dev.merrymen.app.ui.feed.pollWhileResumed
import dev.merrymen.app.ui.feed.staleLine
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * WHAT A READ LEAVES ON SCREEN, and WHEN THE FEED READS AT ALL.
 *
 * An unreadable ledger is not an empty feed; a failed refresh does not blank
 * rows that were read a moment ago, and says how old they are; and the
 * ten-second poll runs only while the screen is resumed.
 */
class FeedReadsTest {
  private lateinit var server: MockWebServer

  @Before fun start() {
    server = MockWebServer()
    server.start()
  }

  @After fun stop() = server.shutdown()

  /** No silent retry: a dropped connection is one failed read, as the test says. */
  private fun api() = apiFor(server, OkHttpClient.Builder().retryOnConnectionFailure(false).build())

  @Test fun anUnreadableLedgerIsNotAnEmptyFeed() = runBlocking {
    val reads = FeedReads(api())
    server.answer("""{"source":"none","theses":[],"tradesComplete":false}""")
    reads.thesesLoop.readNow(0)
    assertEquals(ReadState.UNREADABLE, reads.theses.value.state)
    assertEquals(ReadFailure.Ledger, reads.theses.value.failure)
  }

  @Test fun aFailedRefreshKeepsTheRowsAndSaysHowOldTheyAre() = runBlocking {
    var clock = 1_000_000L
    val reads = FeedReads(api()) { clock }
    server.answer(Fixtures.text("probe-theses.json"))
    reads.thesesLoop.readNow(clock)
    assertEquals(80, reads.theses.value.body!!.theses.size)
    assertNull(staleLine(reads.theses.value, "the feed", clock))

    clock += 125_000
    server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
    reads.thesesLoop.readNow(clock)
    val slot = reads.theses.value
    assertEquals(ReadState.OK, slot.state)
    assertEquals(80, slot.body!!.theses.size)
    assertEquals(
      "Can't reach merrymen right now — showing the feed as we last read it 2m ago.",
      staleLine(slot, "the feed", clock),
    )

    // A later "source: none" is not allowed to blank them either.
    server.answer("""{"source":"none","theses":[]}""")
    reads.thesesLoop.readNow(clock)
    assertEquals(80, reads.theses.value.body!!.theses.size)
    assertTrue(staleLine(reads.theses.value, "the feed", clock)!!.startsWith("merrymen couldn't read its ledger just now"))

    // And the next good read clears the line.
    server.answer(Fixtures.text("probe-theses.json"))
    reads.thesesLoop.readNow(clock)
    assertNull(staleLine(reads.theses.value, "the feed", clock))
  }

  @Test fun anUnreadableAnswerIsNotCalledUnreachable() = runBlocking {
    var clock = 5_000_000L
    val reads = FeedReads(api()) { clock }
    server.answer(Fixtures.text("probe-theses.json"))
    reads.thesesLoop.readNow(clock)
    server.answer("<!DOCTYPE html><html></html>", type = "text/html")
    reads.thesesLoop.readNow(clock)
    assertTrue(staleLine(reads.theses.value, "the feed", clock)!!.startsWith("Couldn't read merrymen's answer"))
  }

  @Test fun failuresBackOffAndNeverAskFasterThanHealthyOnceSettled() {
    assertEquals(10_000L, nextReadIn(0, THESES_EVERY_MS))
    assertEquals(5_000L, nextReadIn(1, THESES_EVERY_MS))
    assertEquals(15_000L, nextReadIn(2, THESES_EVERY_MS))
    assertEquals(60_000L, nextReadIn(3, THESES_EVERY_MS))
    assertEquals(60_000L, nextReadIn(9, THESES_EVERY_MS))
    // A two-minute read settled into an outage still waits two minutes.
    assertEquals(120_000L, nextReadIn(5, 120_000))
  }

  @OptIn(ExperimentalCoroutinesApi::class)
  @Test fun thePollRunsOnlyWhileTheScreenIsResumed() {
    val main = StandardTestDispatcher()
    Dispatchers.setMain(main)
    try {
      runTest(main) {
        val owner = object : LifecycleOwner {
          val registry = LifecycleRegistry.createUnsafe(this)
          override val lifecycle: Lifecycle get() = registry
        }
        var reads = 0
        val loop = ReadLoop(THESES_EVERY_MS) {
          reads++
          true
        }
        owner.registry.currentState = Lifecycle.State.RESUMED
        val job = launch { owner.lifecycle.pollWhileResumed(listOf(loop)) { testScheduler.currentTime } }
        runCurrent()
        assertEquals("it reads at once", 1, reads)
        advanceTimeBy(30_001)
        assertEquals("then every ten seconds", 4, reads)

        // Another tab, or the app in the background: not one more request.
        owner.registry.currentState = Lifecycle.State.STARTED
        runCurrent()
        advanceTimeBy(120_000)
        assertEquals(4, reads)

        // Back again after its cadence has passed: it reads at once.
        owner.registry.currentState = Lifecycle.State.RESUMED
        runCurrent()
        assertEquals(5, reads)
        job.cancel()
      }
    } finally {
      Dispatchers.resetMain()
    }
  }

  /**
   * The app backgrounded while the first read was still on the network: it
   * answered nothing, and coming back must read at once — not sit on the
   * spinner for the rest of a cadence as though it had.
   */
  @OptIn(ExperimentalCoroutinesApi::class)
  @Test fun aReadCutOffByAPauseIsNotTakenForAHealthyOne() {
    val main = StandardTestDispatcher()
    Dispatchers.setMain(main)
    try {
      runTest(main) {
        val owner = object : LifecycleOwner {
          val registry = LifecycleRegistry.createUnsafe(this)
          override val lifecycle: Lifecycle get() = registry
        }
        var started = 0
        var answered = 0
        val loop = ReadLoop(DISCOVERIES_EVERY_MS) {
          started++
          delay(2_000) // the network
          answered++
          true
        }
        owner.registry.currentState = Lifecycle.State.RESUMED
        val job = launch { owner.lifecycle.pollWhileResumed(listOf(loop)) { testScheduler.currentTime } }
        runCurrent()
        advanceTimeBy(500)
        owner.registry.currentState = Lifecycle.State.STARTED // backgrounded mid-read
        runCurrent()
        advanceTimeBy(500)
        assertEquals(1, started)
        assertEquals("the read never came back", 0, answered)
        assertNull(loop.lastRunAtMs)

        owner.registry.currentState = Lifecycle.State.RESUMED
        runCurrent()
        assertEquals("it sets off again the moment the screen is back", 2, started)
        advanceTimeBy(2_001)
        assertEquals(1, answered)
        job.cancel()
      }
    } finally {
      Dispatchers.resetMain()
    }
  }

  @OptIn(ExperimentalCoroutinesApi::class)
  @Test fun comingBackInsideTheCadenceWaitsOutTheRest() {
    val main = StandardTestDispatcher()
    Dispatchers.setMain(main)
    try {
      runTest(main) {
        val owner = object : LifecycleOwner {
          val registry = LifecycleRegistry.createUnsafe(this)
          override val lifecycle: Lifecycle get() = registry
        }
        var reads = 0
        val loop = ReadLoop(120_000) {
          reads++
          true
        }
        owner.registry.currentState = Lifecycle.State.RESUMED
        val job = launch { owner.lifecycle.pollWhileResumed(listOf(loop)) { testScheduler.currentTime } }
        runCurrent()
        assertEquals(1, reads)
        owner.registry.currentState = Lifecycle.State.STARTED
        runCurrent()
        advanceTimeBy(30_000)
        owner.registry.currentState = Lifecycle.State.RESUMED
        runCurrent()
        assertEquals("the index read is not re-asked 30s after it answered", 1, reads)
        advanceTimeBy(90_001)
        assertEquals(2, reads)
        job.cancel()
      }
    } finally {
      Dispatchers.resetMain()
    }
  }
}
