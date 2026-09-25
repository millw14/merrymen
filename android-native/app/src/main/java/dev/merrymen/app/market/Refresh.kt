package dev.merrymen.app.market

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.delay

/**
 * A READ ON ITS OWN CLOCK, AND ONLY WHILE SOMEBODY IS LOOKING.
 *
 * The web runs each public read on the cadence of the thing it reads
 * (web/src/terminal/refresh-loop.ts): the market every 30 seconds, the
 * launchpad sweep every two minutes — the server's own memo lives that long,
 * so asking sooner is asking for the same bytes — and it pauses them while the
 * tab is hidden. The phone's equivalent of hidden is "not RESUMED": another
 * screen on top, the app in the background, the display off. A loop that kept
 * polling there would spend the owner's battery and data on a screen nobody
 * can see, and every open Markets screen would be a request every 30 seconds
 * for as long as the process lived.
 */

/** The backoff after a failed pass: a blip is retried fast, an outage is not stormed. */
private val RETRY_AFTER_MS = longArrayOf(5_000, 15_000, 60_000)

/**
 * HOW LONG UNTIL THE NEXT PASS, given how many have failed in a row.
 *
 * `nextReadIn` in refresh-loop.ts, ported: 5s, 15s, 60s after one, two, three
 * failures — and once settled into an outage, never FASTER than the read's
 * healthy cadence. A two-minute read held at a minute during an outage answers
 * a failure with more requests than success earns.
 */
fun nextReadIn(failuresInARow: Int, everyMs: Long): Long {
  if (failuresInARow <= 0) return everyMs
  val settled = failuresInARow >= RETRY_AFTER_MS.size
  val step = RETRY_AFTER_MS[minOf(failuresInARow, RETRY_AFTER_MS.size) - 1]
  return if (settled) maxOf(step, everyMs) else step
}

/**
 * Run [pass] now and then on its cadence, for ever — or until the caller's
 * coroutine is cancelled, which is how it stops. [pass] answers whether it
 * read; a false stretches the next wait by [nextReadIn].
 */
suspend fun refreshLoop(everyMs: Long, pass: suspend () -> Boolean) {
  var failures = 0
  while (true) {
    failures = if (pass()) 0 else failures + 1
    delay(nextReadIn(failures, everyMs))
  }
}

/**
 * [block] while [owner] is RESUMED: started on every resume, CANCELLED on every
 * pause. repeatOnLifecycle is what does the stopping, so a loop inside cannot
 * outlive the screen being visible, and it starts again, at once, on return.
 */
suspend fun whileResumed(owner: LifecycleOwner, block: suspend CoroutineScope.() -> Unit) {
  owner.lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED, block)
}

/**
 * The composable form: [block] runs while this screen is RESUMED, restarted
 * when [key] changes (a sign-in, an address). Everything that refreshes on a
 * timer on the market screens goes through here.
 */
@Composable
fun WhileResumed(key: Any?, block: suspend CoroutineScope.() -> Unit) {
  val owner = LocalLifecycleOwner.current
  LaunchedEffect(owner, key) { whileResumed(owner, block) }
}
