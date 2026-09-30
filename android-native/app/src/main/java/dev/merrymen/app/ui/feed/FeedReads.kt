package dev.merrymen.app.ui.feed

import dev.merrymen.app.data.Loaded
import dev.merrymen.app.net.CANT_REACH
import dev.merrymen.app.net.Discoveries
import dev.merrymen.app.net.MerrymenApi
import dev.merrymen.app.net.ThesesPage
import dev.merrymen.app.net.TokensPage
import dev.merrymen.app.ui.noticeFor
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * THE FEED'S THREE READS, each on its own clock: the posts every 10s, the
 * listed market every 30s, the index every 2 minutes — the web's cadences
 * (refresh-loop.ts), because a trade that landed should be on screen within
 * seconds and a price list does not change faster than the venue's own TTL.
 *
 * The market and index reads exist only to price each row's call ("since
 * entry", "since posted"). When either fails the figures it would have priced
 * are simply not printed — never computed against a price nobody read.
 */
class FeedReads(private val api: MerrymenApi, private val now: () -> Long = System::currentTimeMillis) {
  private val _theses = MutableStateFlow(Slot<ThesesPage>())
  val theses: StateFlow<Slot<ThesesPage>> = _theses.asStateFlow()

  private val _market = MutableStateFlow(Slot<TokensPage>())
  val market: StateFlow<Slot<TokensPage>> = _market.asStateFlow()

  private val _discoveries = MutableStateFlow(Slot<Discoveries>())
  val discoveries: StateFlow<Slot<Discoveries>> = _discoveries.asStateFlow()

  val thesesLoop = ReadLoop(THESES_EVERY_MS) {
    // `source: "none"` is the reader saying it could not open the ledger — not
    // that nobody posted (read-theses.ts).
    _theses.value = _theses.value.after(api.theses(), now()) { it.source == "none" }
    _theses.value.fresh
  }

  val marketLoop = ReadLoop(MARKET_EVERY_MS) {
    _market.value = _market.value.after(api.market(), now())
    _market.value.fresh
  }

  val discoveriesLoop = ReadLoop(DISCOVERIES_EVERY_MS) {
    _discoveries.value = _discoveries.value.after(api.discoveries(), now())
    _discoveries.value.fresh
  }

  val loops: List<ReadLoop> get() = listOf(thesesLoop, marketLoop, discoveriesLoop)
}

/**
 * THE LINE OVER ROWS THAT ARE NO LONGER FRESH: what failed, and how old the
 * rows on screen are — "Can't reach merrymen right now — showing the feed as
 * we last read it 2m ago." Null when the newest read succeeded, or when
 * nothing good was ever read (then the failure itself is what is shown, not
 * a line over nothing).
 */
fun staleLine(slot: Slot<*>, what: String, nowMs: Long): String? {
  val failure = slot.failure ?: return null
  val at = slot.okAtMs ?: return null
  if (slot.state != ReadState.OK) return null
  val lead = when (failure) {
    is ReadFailure.Answer -> noticeFor(failure.loaded, canSignIn = false, canRetry = false)?.title ?: CANT_REACH
    ReadFailure.Ledger -> "merrymen couldn't read its ledger just now"
  }
  return "$lead — showing $what as we last read it ${agoWords(at / 1000, nowMs / 1000)}."
}

/** The notice for a read that never gave anything to show — or null while it is still coming. */
fun failureOf(slot: Slot<*>): Loaded<*>? = (slot.failure as? ReadFailure.Answer)?.loaded
