package dev.merrymen.app.market

import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.LifecycleRegistry
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test

/**
 * A REFRESH LOOP STOPS WHEN THE SCREEN IS NOT ON TOP.
 *
 * Driven through a real LifecycleRegistry and the real repeatOnLifecycle, on
 * a clock the test owns: resumed, it reads on its cadence; paused, not one
 * request however long it waits; resumed again, it reads at once.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class RefreshLoopTest {
  private val main = StandardTestDispatcher()

  @Before fun mainIsTheTestClock() = Dispatchers.setMain(main)

  @After fun reset() = Dispatchers.resetMain()

  private class Screen : LifecycleOwner {
    val registry = LifecycleRegistry.createUnsafe(this)
    override val lifecycle: Lifecycle get() = registry
  }

  @Test fun theLoopRunsOnlyWhileResumed() = runTest(main) {
    val screen = Screen()
    screen.registry.currentState = Lifecycle.State.CREATED
    var passes = 0
    val job = launch { whileResumed(screen) { refreshLoop(30_000) { passes++; true } } }
    runCurrent()
    assertEquals("created is not resumed", 0, passes)

    screen.registry.currentState = Lifecycle.State.RESUMED
    runCurrent()
    assertEquals("resumed reads at once", 1, passes)
    advanceTimeBy(30_001)
    runCurrent()
    assertEquals("then on its cadence", 2, passes)

    // Another screen on top, or the app in the background.
    screen.registry.currentState = Lifecycle.State.STARTED
    runCurrent()
    advanceTimeBy(600_000)
    runCurrent()
    assertEquals("paused: not one read in ten minutes", 2, passes)

    screen.registry.currentState = Lifecycle.State.RESUMED
    runCurrent()
    assertEquals("back on top: a read at once", 3, passes)
    job.cancel()
  }

  @Test fun aFailingReadBacksOffAndNeverStormsFasterThanItsCadence() {
    assertEquals(30_000, nextReadIn(0, 30_000))
    assertEquals(5_000, nextReadIn(1, 30_000))
    assertEquals(15_000, nextReadIn(2, 30_000))
    assertEquals(60_000, nextReadIn(3, 30_000))
    assertEquals(60_000, nextReadIn(9, 30_000))
    // Settled into an outage, a two-minute read stays a two-minute read.
    assertEquals(120_000, nextReadIn(3, 120_000))
  }

  @Test fun theLoopWaitsLongerAfterFailures() = runTest(main) {
    var passes = 0
    val job = launch { refreshLoop(30_000) { passes++; false } }
    runCurrent()
    assertEquals(1, passes)
    advanceTimeBy(5_001)
    runCurrent()
    assertEquals("a blip is retried after five seconds", 2, passes)
    advanceTimeBy(15_001)
    runCurrent()
    assertEquals(3, passes)
    advanceTimeBy(59_000)
    runCurrent()
    assertEquals("an outage is not stormed", 3, passes)
    job.cancel()
  }
}
