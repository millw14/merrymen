package dev.merrymen.app.data

import dev.merrymen.app.net.ApiResult
import dev.merrymen.app.net.MerrymenApi
import dev.merrymen.app.net.said
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/**
 * LIKES AND FOLLOWS, ONCE PER APP — not once per screen.
 *
 * Mirrors `web/src/terminal/likes.ts` and `components/WiredProvider.tsx`, which
 * are module-scoped for a reason this client has in a sharper form: the feed,
 * an agent's desk and a search result can all be on the back stack at once, and
 * per-screen state would mean several polls of the same routes and — worse —
 * SEVERAL ANSWERS, a heart filled on one screen and empty on another for the
 * same post, because each copy kept its own optimistic set.
 *
 * THE FENCE THIS SITS BEHIND. `worker/src/follow-store.ts` states the rule and
 * `web/src/lib/like-fence.test.ts` pins it: a like count is the one number in
 * this product a sybil can mint, so display it, never sort an agent's world by
 * it, and NEVER let an agent read it. Nothing here reaches an agent — this is a
 * presentation store in a client, the counts route is session-free, and the
 * object a desk reads carries no post id at all. Keep it that way: the moment a
 * number here can move a decision, minting wallets becomes a way to move
 * somebody else's money.
 *
 * THE THREE FLAGS ARE NOT ONE FLAG. "Signed out", "the store would not answer"
 * and "this install has no likes" have three different remedies and only one of
 * them is about the reader. Collapsing them is how the web client came to tell
 * a reader who had signed in five minutes ago to go and sign in.
 */
data class LikesState(
  /** post id → wallets. Meaningless unless `read`; see `countOf`. */
  val counts: Map<String, Int> = emptyMap(),
  /** Post ids this reader has liked. */
  val mine: Set<String> = emptySet(),
  /** Whether the COUNTS were read. False is not "nobody liked this". */
  val read: Boolean = false,
  /** Whether the session answer says signed in. Never inferred from a 200. */
  val signedIn: Boolean = false,
  /** Whether THIS reader's own likes could be read. Separate from `signedIn`. */
  val mineRead: Boolean = true,
  /** False on a self-hosted install, where the route 404s. Not a signed-out reader. */
  val supported: Boolean = true,
) {
  /**
   * The number to show, or NULL for "we could not ask".
   *
   * Absent-once-read is a real zero: the route answers for every post in the
   * window, zero included. Absent-while-unread is not a number at all, and a 0
   * rendered there would be a claim nobody made.
   */
  fun countOf(postId: String): Int? = if (!read) null else counts[postId] ?: 0

  /**
   * Whether a like can be stored right now.
   *
   * Signed in AND readable: offering the control while the store is down would
   * accept a tap that cannot be kept.
   */
  val canLike: Boolean get() = supported && signedIn && mineRead
}

/** What the owner's agent reads, and how much room is left in its prompt. */
data class WiredState(
  val wired: List<String> = emptyList(),
  /** The cap, so a control can render a budget rather than a bare count. */
  val max: Int = 8,
  /** False until the first answer lands — "not yet known" is NOT "follows nobody". */
  val known: Boolean = false,
  /** Why it is not known, in the reader's words. Null once it is. */
  val why: String? = null,
  /**
   * Not known BECAUSE you are signed out — as opposed to self-hosted (404) or
   * unreachable. Only this case earns a "Sign in" button; the others get the
   * `why` sentence and nothing to tap, since signing in would not help.
   */
  val signedOut: Boolean = false,
  /**
   * A write is on its way, so the control shows itself disabled. For DRAWING
   * only: the one-write-at-a-time rule itself is kept inside [Social], where a
   * read that replaces this whole state cannot release it.
   */
  val busy: Boolean = false,
) {
  fun has(slug: String): Boolean = slug in wired
  val full: Boolean get() = wired.size >= max

  /**
   * WHETHER A FACE WEARS THE WIRE RING: only on an answer that is KNOWN. The
   * list is kept through a lost answer — the optimistic change after a failed
   * look-up, the last wallet's list after a 401 — and a ring drawn from it
   * would state as a fact that your agent reads this desk while the control
   * beside it says it could not confirm that.
   */
  fun rings(slug: String): Boolean = known && slug in wired
}

/**
 * What the last wire write had to say, and WHICH DESK it was about — held by
 * the store rather than the button, because the write outlives the page that
 * asked for it: a refusal that lands after the reader has gone back is still
 * said, on that desk's page, when they return.
 */
data class WireNote(val slug: String, val text: String)

/**
 * What POST /api/follow's `refused: "self"` means, in the reader's words. An
 * agent ALREADY reads its own published theses — the orchestrator puts them in
 * its peer file as `own` — so wiring it into itself would spend one of its
 * prompt slots on a copy of something it has.
 */
const val SELF_WIRE = "Your agent already reads its own posts."

/**
 * One fetch, one poll, one truth.
 *
 * Held by AppContainer, so every screen sees the same answer and a like cast on
 * the feed is already filled in when the reader opens that agent's desk.
 */
class Social(private val api: MerrymenApi) {
  private val _likes = MutableStateFlow(LikesState())
  val likes: StateFlow<LikesState> = _likes.asStateFlow()

  private val _wired = MutableStateFlow(WiredState())
  val wired: StateFlow<WiredState> = _wired.asStateFlow()

  private val _wireNote = MutableStateFlow<WireNote?>(null)
  val wireNote: StateFlow<WireNote?> = _wireNote.asStateFlow()

  /**
   * ONE WIRE WRITE AT A TIME, kept here and not in [WiredState.busy]: a list
   * read replaces the published state wholesale, and when the guard lived in
   * it, a screen entry that refreshed mid-write released it and let a second
   * POST go out with the first still on its way.
   */
  private val writer = AtomicReference<Any?>(null)

  /** Bumped as each wire write starts, so a list read can tell it overlapped one. */
  private val writes = AtomicLong(0)

  /**
   * Bumped by [forget]. An answer that belongs to the wallet before a sign-out
   * is never applied to the one after it.
   */
  private val wallet = AtomicLong(0)

  /**
   * WHOSE STATE THIS IS, CHECKED AND WRITTEN AS ONE. forget() runs on IO (a
   * forget hook) and the toggles on Main, so "is this still the wallet the
   * write was made for?" and the write that follows must not have a sign-out
   * between them. Every write of a per-wallet fact after a network answer, and
   * forget() itself, take this lock.
   */
  private val walletLock = Any()

  /** Apply [change] to the likes only while [at] is still the wallet. */
  private fun likesFor(at: Long, change: (LikesState) -> LikesState): Boolean = synchronized(walletLock) {
    if (wallet.get() != at) return false
    _likes.value = change(_likes.value)
    true
  }

  /** Apply [change] to the wired state only while [at] is still the wallet. */
  private fun wiredFor(at: Long, change: (WiredState) -> WiredState): Boolean = synchronized(walletLock) {
    if (wallet.get() != at) return false
    _wired.value = change(_wired.value)
    true
  }

  /**
   * When the per-caller reads last ran.
   *
   * THROTTLED, because the trigger is a screen coming back into view and that
   * is not a rare event on a phone: every tab tap, every back press, every
   * rotation. The web learned the same thing about `visibilitychange`.
   */
  private var lastMineAt = 0L
  private var lastWiredAt = 0L

  private companion object {
    const val MIN_GAP_MS = 30_000L
    /** How stale the shared counts may get before another screen re-asks. */
    const val COUNTS_GAP_MS = 60_000L
  }

  private var lastCountsAt = 0L

  /** Everything a feed needs, throttled so a back press does not re-poll. */
  suspend fun refresh(force: Boolean = false) {
    refreshCounts(force)
    refreshMine(force)
  }

  suspend fun refreshCounts(force: Boolean = false) {
    val now = System.currentTimeMillis()
    if (!force && now - lastCountsAt < COUNTS_GAP_MS) return
    lastCountsAt = now
    when (val r = api.likeCounts()) {
      // The ROUTE'S OWN FLAG, not the request succeeding: it answers 200 with
      // `read: false` when the store would not open.
      is ApiResult.Ok -> _likes.value = _likes.value.copy(counts = r.value.counts, read = r.value.read)
      // A failure here leaves the last good counts standing and says nothing
      // new. Blanking them to zero would be the empty-vs-unavailable bug.
      else -> Unit
    }
  }

  suspend fun refreshMine(force: Boolean = false) {
    val now = System.currentTimeMillis()
    if (!force && now - lastMineAt < MIN_GAP_MS) return
    lastMineAt = now
    // An answer read for the wallet before a sign-out is that wallet's likes.
    val at = wallet.get()
    when (val r = api.likes()) {
      is ApiResult.Ok ->
        if (!r.value.read) {
          // The SESSION was read; the STORE was not. `signedIn` is deliberately
          // untouched — reporting this as signed-out is a false claim about the
          // reader, with a remedy that cannot work.
          likesFor(at) { it.copy(mineRead = false) }
        } else {
          likesFor(at) {
            it.copy(
              mine = r.value.liked.toSet(),
              signedIn = r.value.signedIn,
              mineRead = true,
            )
          }
        }
      is ApiResult.Refused ->
        // 404 is the hosted-only surface saying this install has no likes at
        // all. Not an error, and not a signed-out reader.
        if (r.status == 404) likesFor(at) { it.copy(supported = false) }
        else if (r.status == 401) likesFor(at) { it.copy(signedIn = false, mineRead = true) }
        else likesFor(at) { it.copy(mineRead = false) }
      is ApiResult.Unreachable -> likesFor(at) { it.copy(mineRead = false) }
    }
  }

  /**
   * Cast or withdraw a like.
   *
   * Optimistic on BOTH halves and rolled back together — a heart that fills
   * while the number stays put reads as a broken button. Returns null when it
   * was stored, or the reason it was not.
   *
   * THE WRITE IS SETTLED EVEN IF THE ROW IS GONE. The heart lives on a feed
   * row, and a row scrolled out of a LazyColumn cancels the scope its tap was
   * launched in; cancelled mid-write, the answer — a refusal, or a lost one
   * that needs looking up — was dropped and the optimistic heart and +1 stood
   * as though stored. So the write and whatever it takes to settle it run to
   * the end, bounded by the client's own timeouts.
   */
  suspend fun toggleLike(postId: String, on: Boolean): String? = withContext(NonCancellable) {
    val at = wallet.get()
    val said = likeWrite(postId, on, at)
    // Signed out, or into another wallet, while it was on its way: what it has
    // to say is about the last wallet's likes. The new reader's state was
    // never written (likeWrite checks [at] before each write), so it is left
    // exactly as it is — wiping it here threw away likes the new wallet had
    // just read, and told a signed-in reader to sign in.
    if (wallet.get() == at) said else null
  }

  /**
   * One like write for the wallet [at]. THE HEART IS THAT WALLET'S, THE COUNT
   * IS EVERYBODY'S: every change to `mine`, `signedIn` or `mineRead` is made
   * only while [at] is still the wallet ([likesFor]), and the count's own
   * optimistic step comes back whoever is signed in by the time the answer
   * lands, since forget() keeps the counts.
   */
  private suspend fun likeWrite(postId: String, on: Boolean, at: Long): String? {
    val step = if (on) 1 else -1
    fun counted(s: LikesState, delta: Int) = s.counts + (postId to maxOf(0, (s.counts[postId] ?: 0) + delta))
    val stepped = likesFor(at) { s ->
      s.copy(mine = if (on) s.mine + postId else s.mine - postId, counts = counted(s, step))
    }
    /** The server kept nothing: the count's step comes off, and [mine] is this wallet's new set when it is still theirs. */
    fun undo(mine: (LikesState) -> Set<String>, alsoMineRead: Boolean = false) = synchronized(walletLock) {
      // From the state as it stands now, not `before` wholesale: a counts poll
      // may have landed in between and its answer is newer than ours.
      val s = _likes.value
      val counts = if (stepped) counted(s, -step) else s.counts
      _likes.value = if (wallet.get() == at) {
        s.copy(mine = mine(s), counts = counts, mineRead = if (alsoMineRead) true else s.mineRead)
      } else {
        s.copy(counts = counts)
      }
    }
    fun rollBack() = undo({ s -> if (on) s.mine - postId else s.mine + postId })
    return when (val r = api.like(postId, on)) {
      is ApiResult.Ok -> {
        // A 200 THAT SAYS IT DID NOT WRITE IS A FAILURE. `read: false` comes
        // back with an empty `liked`, and trusting it would erase every like
        // this reader has as well as leaving the optimistic +1 standing.
        if (!r.value.read) {
          rollBack()
          "We could not save that just now."
        } else if (r.value.refused != null) {
          // REFUSED IS A ROLL-BACK, TOO. The server did not store the like, so
          // the optimistic +1 must come off the count — reconciling `mine` from
          // the server's `liked` (which does not contain this post) fixed the
          // heart but left the number one too high, a like nobody cast standing
          // on screen until the next counts poll. At-capacity is only reachable
          // on an `on = true` like, so this always undoes a +1; the delta-from-
          // current form keeps a poll that landed in between correct.
          undo({ r.value.liked.toSet() }, alsoMineRead = true)
          if (r.value.refused == "at-capacity") {
            "You have liked as many posts as we keep (${r.value.max}). Unlike one to make room."
          } else {
            "That was not saved: " + r.value.refused
          }
        } else {
          likesFor(at) { it.copy(mine = r.value.liked.toSet(), mineRead = true) }
          null
        }
      }
      is ApiResult.Refused -> {
        rollBack()
        if (r.status == 401) {
          likesFor(at) { it.copy(signedIn = false) }
          "Sign in to like posts."
        } else {
          r.message
        }
      }
      // A LOST ANSWER TO A WRITE IS UNKNOWN. The like may have been stored
      // and the answer lost on the way back, so it is looked up rather than
      // rolled back on a guess — and never simply sent again. Not for a
      // wallet that has gone: the look-up would read the NEXT session's
      // likes, and the count's step stays until the next counts poll.
      is ApiResult.Unreachable -> if (wallet.get() != at) null else when (val look = api.likes()) {
        is ApiResult.Ok -> if (look.value.read) {
          val stored = postId in look.value.liked
          if (stored == on) {
            likesFor(at) { it.copy(mine = look.value.liked.toSet(), mineRead = true) }
            null
          } else {
            // The optimistic step comes off the count only when the store
            // says it did not happen.
            undo({ look.value.liked.toSet() }, alsoMineRead = true)
            "merrymen didn't answer, and that wasn't saved. Try again."
          }
        } else {
          lookupFailed(r)
        }
        else -> lookupFailed(r)
      }
    }
  }

  /**
   * The write's answer was lost AND the look-up failed: we do not know. The
   * optimistic heart stays, the next read of the reader's likes is not
   * throttled, and the reader is told exactly that.
   */
  private fun lookupFailed(lost: ApiResult.Unreachable): String {
    lastMineAt = 0L
    return "We couldn't confirm that was saved. " + lost.said
  }

  /**
   * What this owner's agent currently reads.
   *
   * AN ANSWER THAT OVERLAPPED A WRITE IS NOT APPLIED. The GET may have been
   * served before the POST landed or after it, and nothing in the answer says
   * which; applied, it dropped the optimistic ring mid-write and could land
   * after the write's own answer with the list from before it. The write's
   * answer carries the whole stored list, so it — or, when that was lost, its
   * look-up — is what settles the state.
   */
  suspend fun refreshWired(force: Boolean = false) {
    val now = System.currentTimeMillis()
    if (!force && now - lastWiredAt < MIN_GAP_MS) return
    lastWiredAt = now
    // A write is "overlapping" only while it is THIS wallet's: forget() frees
    // the guard, so a write the last wallet left on its way cannot throw away
    // the new wallet's first read of its list.
    val quietAtStart = writer.get() == null
    val writesAtStart = writes.get()
    val walletAtStart = wallet.get()
    val r = api.following()
    if (!quietAtStart || writer.get() != null || writes.get() != writesAtStart) return
    when (r) {
      is ApiResult.Ok -> wiredFor(walletAtStart) { WiredState(r.value.wired, r.value.max, known = true) }
      // `known` STAYS FALSE for every one of these, so nothing claims the
      // viewer follows nobody. It claims not to know, which is the truth.
      is ApiResult.Refused -> wiredFor(walletAtStart) {
        it.copy(
          known = false,
          signedOut = r.status == 401,
          why = when (r.status) {
            401 -> "Sign in to wire other desks into your agent."
            404 -> "Wiring is part of the hosted service."
            else -> r.message
          },
        )
      }
      // `said`, not "Couldn't reach" by hand: an answer this app could not
      // read is not an unreachable server.
      is ApiResult.Unreachable -> wiredFor(walletAtStart) { it.copy(known = false, why = r.said) }
    }
  }

  /**
   * Wire a desk in, or cut it loose. Returns null when it was stored, or the
   * sentence saying why not.
   *
   * THE SERVER'S ANSWER IS THE STATE. A 200 carries the list it actually
   * stored, so a refusal with a reason — the cap, or wiring your own agent
   * into itself — snaps the ring back to that list AND says why. The self
   * refusal used to fall through as a success: the ring flicked on, snapped
   * off, and nothing on screen said a word.
   *
   * A LOST ANSWER IS UNKNOWN, NOT A FAILURE. The follow may have been stored
   * and the answer lost on the way back, so the list is read again rather than
   * the write being retried or the ring left where the optimism put it. If that
   * read fails too, the control says it does not know (`known = false`) until
   * the next read settles it.
   *
   * ONE WRITE AT A TIME, as the web's toggle is: a second tap while one is on
   * its way is ignored, so two answers can never land out of order.
   *
   * THE WRITE OUTLIVES THE PAGE THAT ASKED FOR IT. The tap is launched in the
   * wire control's own scope, which is cancelled when the reader leaves the
   * page — or when the control is withdrawn because /own just said this is
   * their agent. Cancelled mid-write, the server's answer (a refusal
   * included) was thrown away, the lost-answer look-up never ran, and the
   * busy flag was never lowered: the optimistic ring stood on that face
   * everywhere and every wire control in the app ignored taps until a list
   * read happened to land. So the write, its look-up and the lowering of the
   * flag run to the end whatever happens to the caller, and what it had to
   * say is kept in [wireNote] for that desk's page.
   */
  suspend fun toggleWire(slug: String, on: Boolean): String? = withContext(NonCancellable) {
    val me = Any()
    if (!writer.compareAndSet(null, me)) return@withContext null
    writes.incrementAndGet()
    val walletAtStart = wallet.get()
    try {
      val before = _wired.value
      val started = wiredFor(walletAtStart) { s ->
        _wireNote.value = null
        s.copy(
          busy = true,
          wired = if (on) (listOf(slug) + s.wired).distinct() else s.wired.filter { it != slug },
        )
      }
      // Signed out between the tap and here: nothing is sent for a wallet that has gone.
      if (!started) return@withContext null
      val (after, said) = when (val r = api.follow(slug, on)) {
        is ApiResult.Ok -> WiredState(r.value.wired, r.value.max, known = true) to when (r.value.refused) {
          null -> null
          "at-capacity" ->
            "Your agent already reads ${r.value.max} desks, which is as many as fit in one prompt. " +
              "Unwire one to make room."
          "self" -> SELF_WIRE
          // A reason this build does not know is still a refusal: the list
          // above is what was stored, and the reader is told nothing changed.
          else -> "merrymen didn't make that change, so nothing changed."
        }
        is ApiResult.Refused ->
          before to if (r.status == 401) "Sign in to wire other desks into your agent." else r.message
        // Not looked up for a wallet that has gone: the read would be the
        // next session's list.
        is ApiResult.Unreachable -> if (wallet.get() != walletAtStart) before to null else lookUpWire(slug, on, r)
      }
      // Signed out (or into another wallet) while this was on its way: the
      // answer describes the last wallet's agent, and is nobody's business now.
      val landed = wiredFor(walletAtStart) {
        _wireNote.value = said?.let { WireNote(slug, it) }
        after
      }
      if (landed) said else null
    } finally {
      writer.compareAndSet(me, null)
      wiredFor(walletAtStart) { it.copy(busy = false) }
    }
  }

  /** After a lost answer: read what is stored, and say which way it went. */
  private suspend fun lookUpWire(slug: String, on: Boolean, lost: ApiResult.Unreachable): Pair<WiredState, String?> =
    when (val look = api.following()) {
      is ApiResult.Ok -> WiredState(look.value.wired, look.value.max, known = true) to
        if ((slug in look.value.wired) == on) null else "merrymen didn't answer, and that change wasn't saved. Try again."
      else -> {
        lastWiredAt = 0L
        // The list stays where the optimism put it, but NOT KNOWN — so it draws
        // no ring (see WiredState.rings) and the control says it could not
        // confirm, until the next read settles it.
        _wired.value.copy(known = false, signedOut = false, why = "We couldn't confirm whether that change was saved. " + lost.said) to null
      }
    }

  /** Sign-out clears both, because both are per-wallet facts. */
  fun forget() = synchronized(walletLock) {
    wallet.incrementAndGet()
    forgetLikes()
    _wired.value = WiredState()
    _wireNote.value = null
    lastWiredAt = 0L
    // The one-write guard is per wallet too: a write the last wallet left on
    // its way no longer holds the new wallet's control, or its first read.
    writer.set(null)
  }

  /** The per-wallet half of the likes; the counts are everybody's and stay. */
  private fun forgetLikes() {
    _likes.value = LikesState(counts = _likes.value.counts, read = _likes.value.read)
    lastMineAt = 0L
  }
}
