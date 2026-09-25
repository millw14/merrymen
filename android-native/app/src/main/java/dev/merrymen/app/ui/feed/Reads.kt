package dev.merrymen.app.ui.feed

import androidx.lifecycle.Lifecycle
import androidx.lifecycle.repeatOnLifecycle
import dev.merrymen.app.data.Loaded
import dev.merrymen.app.data.toLoaded
import dev.merrymen.app.net.ApiResult
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/**
 * HOW THE FEED, THE BOARD AND AN AGENT'S PAGE STAY FRESH — and what they say
 * when a read fails after a good one. Ported from `web/src/terminal/refresh-loop.ts`
 * and `live.ts withRead`.
 */

/** The feed is the one read a person watches for something to happen. */
const val THESES_EVERY_MS = 10_000L

/** The market's own TTL. */
const val MARKET_EVERY_MS = 30_000L

/** A ranking does not move by the second. */
const val BOARD_EVERY_MS = 60_000L

/** The server memoises the index read this long; asking sooner is asking for the same bytes. */
const val DISCOVERIES_EVERY_MS = 120_000L

/** The web's profile re-read. */
const val PROFILE_EVERY_MS = 30_000L

private val RETRY_AFTER_MS = longArrayOf(5_000L, 15_000L, 60_000L)

/**
 * `nextReadIn` (refresh-loop.ts): a healthy read waits its own cadence; after
 * failures in a row it retries at 5s, 15s, then 60s — and ONCE SETTLED INTO AN
 * OUTAGE never asks faster than it would when healthy, because answering a
 * failure with more requests than success earns is the retry storm this repo
 * has already paid for once.
 */
fun nextReadIn(failuresInARow: Int, everyMs: Long): Long {
  if (failuresInARow <= 0) return everyMs
  val settled = failuresInARow >= RETRY_AFTER_MS.size
  val step = RETRY_AFTER_MS[minOf(failuresInARow, RETRY_AFTER_MS.size) - 1]
  return if (settled) maxOf(step, everyMs) else step
}

/**
 * ONE READ ON ITS OWN CLOCK. [read] answers true when the read came back
 * readable. Reads are serialised: a Retry tapped while the timer's read is in
 * flight waits for it, so an older answer can never land after a newer one.
 */
class ReadLoop(val everyMs: Long, private val read: suspend () -> Boolean) {
  private val one = Mutex()

  /** Failures in a row; 0 after a success. */
  var failures: Int = 0
    private set

  /**
   * When the last read that CAME BACK was started, on the loop's clock. Null
   * until one has.
   *
   * Stamped when the answer lands, never when the read sets off. A read cut
   * off by the screen leaving RESUMED — the app backgrounded, a dialog up
   * during the first read — answered nothing; stamped as it set off, and
   * counting no failure, it passed for a healthy read a moment ago, and on
   * return the feed sat on its spinner for up to ten seconds and its rows
   * went unpriced for up to two minutes.
   */
  var lastRunAtMs: Long? = null
    private set

  /** Read now — a Retry, or the timer. */
  suspend fun readNow(nowMs: Long): Boolean = one.withLock {
    val ok = try {
      read()
    } catch (e: CancellationException) {
      throw e
    } catch (e: Exception) {
      // A read that threw is a failed read, and the loop keeps its schedule.
      false
    }
    lastRunAtMs = nowMs
    failures = if (ok) 0 else failures + 1
    ok
  }
}

/**
 * Run every loop until cancelled. A loop that ran healthily less than its
 * cadence ago — the screen was paused and came back — waits out the rest
 * rather than re-reading at once; one that last failed reads immediately.
 */
suspend fun runReadLoops(loops: List<ReadLoop>, now: () -> Long) = coroutineScope {
  for (loop in loops) {
    launch {
      val last = loop.lastRunAtMs
      if (last != null && loop.failures == 0) {
        val wait = last + loop.everyMs - now()
        if (wait > 0) delay(wait)
      }
      while (isActive) {
        loop.readNow(now())
        delay(nextReadIn(loop.failures, loop.everyMs))
      }
    }
  }
}

/**
 * THE POLL RUNS ONLY WHILE THE SCREEN IS RESUMED. A feed polled every ten
 * seconds from behind another tab, or with the app in the background, is a
 * phone spending its battery and the server's capacity on a list nobody is
 * looking at. `repeatOnLifecycle` cancels the loops when the screen drops below
 * RESUMED and starts them again when it comes back.
 */
suspend fun Lifecycle.pollWhileResumed(loops: List<ReadLoop>, now: () -> Long = System::currentTimeMillis) =
  repeatOnLifecycle(Lifecycle.State.RESUMED) { runReadLoops(loops, now) }

// ── what a read left on screen ──────────────────────────────────────────────

enum class ReadState {
  /** Nothing has come back yet. */
  UNREAD,

  /** A readable answer is on screen. */
  OK,

  /**
   * merrymen answered, and said it could not read its own ledger
   * (`source: "none"`). NOT "nobody posted" — read-theses.ts sends exactly this
   * shape when the database would not open.
   */
  UNREADABLE,
}

/** Why the newest read did not replace what is on screen. */
sealed interface ReadFailure {
  /** A refusal or no answer — the words come from `noticeFor`. */
  data class Answer(val loaded: Loaded<*>) : ReadFailure

  /** It answered `source: "none"`. */
  data object Ledger : ReadFailure
}

/**
 * ONE READ'S ANSWER, AND WHAT A FAILED ONE DOES TO WHAT IS ON SCREEN
 * (`withRead`, live.ts).
 *
 * A readable answer replaces the last one. A FAILED ANSWER AFTER A GOOD ONE
 * leaves the good one on screen, still marked read, and records the failure so
 * the screen can say "showing what we last read 2m ago" — the rows stay, and
 * nothing pretends they are fresh. With nothing good ever read, the failure is
 * what is shown.
 */
data class Slot<T>(
  val body: T? = null,
  val state: ReadState = ReadState.UNREAD,
  /** When the body on screen was read, epoch ms. Null until one was. */
  val okAtMs: Long? = null,
  /** The newest read failed, and this is how. Null after a success. */
  val failure: ReadFailure? = null,
) {
  /** The newest read came back readable. */
  val fresh: Boolean get() = state == ReadState.OK && failure == null

  fun after(r: ApiResult<T>, nowMs: Long, ledgerUnreadable: (T) -> Boolean = { false }): Slot<T> = when (r) {
    is ApiResult.Ok ->
      if (!ledgerUnreadable(r.value)) {
        Slot(r.value, ReadState.OK, nowMs, null)
      } else if (state == ReadState.OK) {
        copy(failure = ReadFailure.Ledger)
      } else {
        Slot(r.value, ReadState.UNREADABLE, null, ReadFailure.Ledger)
      }
    // Through toLoaded(), so an unreadable answer keeps its flag and is not
    // later called "couldn't reach".
    is ApiResult.Refused -> copy(failure = ReadFailure.Answer(r.toLoaded()))
    is ApiResult.Unreachable -> copy(failure = ReadFailure.Answer(r.toLoaded()))
  }
}
