package dev.merrymen.app.data

import dev.merrymen.app.net.ApiResult
import dev.merrymen.app.net.GcLine
import dev.merrymen.app.net.GcMe
import dev.merrymen.app.net.GcPage
import dev.merrymen.app.net.GcPresence
import dev.merrymen.app.net.GcRoom
import dev.merrymen.app.net.MerrymenApi
import dev.merrymen.app.net.groupChatHide
import dev.merrymen.app.net.groupChatMe
import dev.merrymen.app.net.groupChatPage
import dev.merrymen.app.net.groupChatPost
import dev.merrymen.app.net.groupChatSetMuted
import dev.merrymen.app.net.groupChatSetZone
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale
import java.util.UUID
import java.util.WeakHashMap
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

/**
 * THE GROUP CHAT, ONCE PER APP — the room's state, its poll, and the owner's
 * writes. A port of web/src/terminal/groupchat.ts, whose rules it keeps.
 *
 * ONE ROOM FOR THE PROCESS, not one per screen (see [GroupChatRooms]). Leaving
 * the screen must not blank it: coming back draws what was already read while
 * the next poll is in flight. And the owner's writes run on the app's scope,
 * not the screen's, so a line sent just before the back button still lands —
 * and its answer is still heard — rather than being cancelled mid-request into
 * an outcome nobody knows.
 *
 * THE POLL RUNS ONLY WHILE THE SCREEN IS RESUMED. [follow] is a loop the
 * screen runs inside repeatOnLifecycle(RESUMED): every 3s, backing off while
 * the room cannot be read, and cancelled the moment the screen is not on top.
 *
 * WHAT THIS CANNOT DO: reach trading. It is presentation over a public GET and
 * two owner routes; the room's tables are fenced from every trading path on
 * the server (docs/groupchat.md, rule 1).
 */

/** Newest lines on arrival, and each "load earlier" page. */
const val GC_PAGE = 60

/** A poll's page. A full one means we are behind and the next follows at once. */
const val GC_POLL_LIMIT = 100

/**
 * HOW FAR BACK EACH POLL RE-ASKS, in ids. Ids are handed out in insert order
 * but committed in whatever order the writers finish, so a poll can see 101
 * before 100 is visible; re-asking a little behind the cursor and deduping by
 * id loses nothing.
 */
const val GC_OVERLAP = 16

const val GC_VISIBLE_MS = 3_000L

/** A presence summary older than this was written by a conductor that has stopped. */
const val GC_ROOM_STALE_MS = 3 * 60_000L

/** The owner-line ceiling the server's gate enforces (OWNER_LINE_MAX). */
const val GC_COMPOSER_MAX = 500

/** How many lines a following reader keeps before the oldest are let go. */
const val GC_KEEP_LINES = 400

/** Reopened after this long, the screen starts again from the newest page. */
const val GC_RESUME_AFTER_MS = 5 * 60_000L

private const val RUN_GAP_MS = 5 * 60_000L
private const val ME_STALE_MS = 60_000L
private const val MAX_CATCH_UP = 5
private const val MAX_EARLIER_HOPS = 5

/**
 * FOUR ANSWERS, and only one of them is about the room. UNREAD: nothing back
 * yet. UNREADABLE: we asked and could not be told. UNSUPPORTED: this server has
 * no room (404). OK: the room answered — including "nothing has been said".
 */
enum class RoomStatus { UNREAD, UNREADABLE, OK, UNSUPPORTED }

enum class MeState { UNREAD, OK, UNREADABLE }

/**
 * An owner line on its way, drawn as sent before it is.
 *
 * [clientId] is minted ONCE for the line and every attempt to send it reuses
 * it, so the server's idempotence key makes a resend return the stored line
 * instead of storing a second. [after] is the cursor when it was sent: its echo
 * is always newer, so an older identical "gm" is never mistaken for it.
 * [unconfirmed]: the answer to the send was lost, so whether it posted is
 * unknown until the room shows it or a resend is answered.
 */
data class PendingLine(
  val clientId: String,
  val body: String,
  val replyTo: Long?,
  val at: Long,
  val after: Long,
  val unconfirmed: Boolean = false,
)

data class GroupChatState(
  val status: RoomStatus = RoomStatus.UNREAD,
  /** Ascending by id, deduped, without the lines taken back. */
  val messages: List<GcLine> = emptyList(),
  val pending: List<PendingLine> = emptyList(),
  /** The highest id the server has shown us. Only ever moves forward. */
  val cursor: Long = 0,
  /** The oldest loaded line is the start of what the room keeps. */
  val start: Boolean = false,
  val room: GcRoom? = null,
  /** The summary's writer was heard from within [GC_ROOM_STALE_MS], as of the last poll. */
  val roomFresh: Boolean = false,
  /** A read after the first failed: what is on screen is older than it looks. */
  val failing: Boolean = false,
  val loadingEarlier: Boolean = false,
  val earlierFailed: Boolean = false,
  val me: GcMe? = null,
  val meState: MeState = MeState.UNREAD,
  /** id → the client id its optimistic line was drawn under, so it keeps its place. */
  val keys: Map<Long, String> = emptyMap(),
  /** Lines taken back, as far as this app knows. A copy arriving later is dropped. */
  val gone: Set<Long> = emptySet(),
  /** A send is in flight. One at a time. */
  val posting: Boolean = false,
  /** Epoch ms before which the server asked us not to post again (429 Retry-After). */
  val sendableAtMs: Long = 0,
  /** Bumped when the log was REPLACED rather than added to. */
  val epoch: Int = 0,
)

/** What became of a send. */
sealed interface SendResult {
  data object Sent : SendResult

  /** Refused, here or by the server. The line was not posted: the words go back in the box. */
  data class Refused(val error: String) : SendResult

  /**
   * The answer was lost. The line stays on screen, marked; "Send again" reuses
   * its key and cannot post it twice. Never reported as a failure.
   */
  data class Unconfirmed(val error: String) : SendResult
}

/** Counters the store keeps for itself; replaced whole by [GroupChatRoom.forget]. */
private data class Book(
  val loaded: Boolean = false,
  val failures: Int = 0,
  val catchUp: Int = 0,
  val lastPullAt: Long = 0,
  val meAt: Long = 0,
  val roomSeenAt: Long = 0,
  val following: Boolean = true,
  val replaceNext: Boolean = false,
)

class GroupChatRoom(
  private val api: MerrymenApi,
  /** Where writes run: the app's scope, so a send outlives the screen that made it. */
  private val scope: CoroutineScope,
  private val now: () -> Long = System::currentTimeMillis,
  private val newClientId: () -> String = { UUID.randomUUID().toString() },
  /** The wait between polls. A test drives the cadence through it; the app waits for real. */
  private val pause: suspend (Long) -> Unit = { delay(it) },
) {
  private val _state = MutableStateFlow(GroupChatState())
  val state: StateFlow<GroupChatState> = _state.asStateFlow()

  private val book = AtomicReference(Book())

  /**
   * Bumped by [forget]. A read or write still in flight from before a turn end
   * (sign-out, another server) must not write its answer into the room that
   * replaced it.
   */
  private val generation = AtomicLong(0)

  private val pollLock = Mutex()
  private val meLock = Mutex()
  private val earlierLock = Mutex()

  // ── reading ────────────────────────────────────────────────────────────────

  /**
   * THE POLL, for as long as the caller's coroutine lives — which is as long as
   * the screen is RESUMED. Gone long enough that what is held is history, it
   * starts over from the newest page; and every open asks /me again, because a
   * sign-in happens in the app with no reload.
   */
  suspend fun follow() {
    val b = book.get()
    if (b.loaded && b.lastPullAt > 0 && now() - b.lastPullAt > GC_RESUME_AFTER_MS) {
      book.updateAndGet { it.copy(loaded = false, replaceNext = true) }
    }
    coroutineScope {
      launch { pullMe(force = true) }
      while (true) {
        val behind = pollNow()
        pause(nextDelayMs(behind))
      }
    }
  }

  /** How long until the next poll: at once when behind, backing off while failing. */
  fun nextDelayMs(behind: Boolean): Long {
    val b = book.get()
    if (behind && b.catchUp <= MAX_CATCH_UP) return 0
    if (b.failures <= 0) return GC_VISIBLE_MS
    return minOf(30_000L, GC_VISIBLE_MS * (1L shl minOf(b.failures - 1, 4)))
  }

  /**
   * Read now. Answers whether the room has more waiting (a full page). A poll
   * already in flight is not doubled: this one returns and that one answers.
   */
  suspend fun pollNow(): Boolean {
    if (_state.value.status == RoomStatus.UNSUPPORTED) return false
    if (!pollLock.tryLock()) return false
    try {
      val gen = generation.get()
      val behind = if (book.get().loaded) pullSince(gen) else pullLatest(gen)
      if (gen == generation.get()) {
        val t = now()
        book.updateAndGet { it.copy(lastPullAt = t, catchUp = if (behind) it.catchUp + 1 else 0) }
        // Every poll, failed or not: a summary nobody has rewritten for minutes
        // turns stale by the clock alone, and that flip is the news.
        val seen = book.get().roomSeenAt
        _state.update { it.copy(roomFresh = roomIsFresh(it.room, seen, t)) }
      }
      return behind
    } finally {
      pollLock.unlock()
    }
  }

  private fun failed() {
    book.updateAndGet { it.copy(failures = it.failures + 1) }
    _state.update { if (it.status == RoomStatus.OK) it.copy(failing = true) else it.copy(status = RoomStatus.UNREADABLE) }
  }

  private fun noteRoom(page: GcPage) {
    val at = page.room?.updatedAtMs ?: return
    book.updateAndGet { it.copy(roomSeenAt = maxOf(it.roomSeenAt, at)) }
  }

  private suspend fun pullLatest(gen: Long): Boolean {
    val r = api.groupChatPage("?limit=$GC_PAGE")
    if (gen != generation.get()) return false
    val page = when (r) {
      is ApiResult.Refused -> {
        if (r.status == 404) _state.update { it.copy(status = RoomStatus.UNSUPPORTED) } else failed()
        return false
      }
      is ApiResult.Unreachable -> { failed(); return false }
      is ApiResult.Ok -> r.value ?: run { failed(); return false }
    }
    val replace = book.get().replaceNext
    book.updateAndGet { it.copy(failures = 0, loaded = true, replaceNext = false) }
    noteRoom(page)
    _state.update { s ->
      val gone = s.gone + page.gone
      val incoming = page.messages.filter { it.id !in gone }
      val (pending, keys0) = absorbEchoes(s.pending, s.keys, incoming, s.me?.slug)
      val messages: List<GcLine>
      val keys: Map<Long, String>
      if (replace) {
        messages = incoming.distinctBy { it.id }.sortedBy { it.id }
        val ids = messages.mapTo(HashSet()) { it.id }
        keys = keys0.filterKeys { it in ids }
      } else {
        messages = mergeLines(s.messages, incoming).filter { it.id !in gone }
        keys = keys0.filterKeys { it !in gone }
      }
      val top = page.messages.maxOfOrNull { it.id } ?: 0
      s.copy(
        status = RoomStatus.OK,
        failing = false,
        messages = messages,
        pending = pending,
        keys = keys,
        gone = gone,
        cursor = maxOf(s.cursor, page.cursor, top),
        // No `start` on a newest page: a short page is the whole room.
        start = page.start ?: (page.messages.size < GC_PAGE),
        room = page.room ?: s.room,
        epoch = if (replace) s.epoch + 1 else s.epoch,
        earlierFailed = if (replace) false else s.earlierFailed,
      )
    }
    return false
  }

  private suspend fun pullSince(gen: Long): Boolean {
    val since = maxOf(0, _state.value.cursor - GC_OVERLAP)
    val r = api.groupChatPage("?since=$since&limit=$GC_POLL_LIMIT")
    if (gen != generation.get()) return false
    val page = when (r) {
      is ApiResult.Refused -> {
        if (r.status == 404) _state.update { it.copy(status = RoomStatus.UNSUPPORTED) } else failed()
        return false
      }
      is ApiResult.Unreachable -> { failed(); return false }
      is ApiResult.Ok -> r.value ?: run { failed(); return false }
    }
    book.updateAndGet { it.copy(failures = 0) }
    noteRoom(page)
    val following = book.get().following
    _state.update { s ->
      // Taken back since this reader fetched them: every open screen drops
      // them, not only the one whose owner pressed remove.
      val gone = s.gone + page.gone
      val incoming = page.messages.filter { it.id !in gone }
      val (pending, keys0) = absorbEchoes(s.pending, s.keys, incoming, s.me?.slug)
      var messages = mergeLines(s.messages, incoming).filter { it.id !in gone }
      var keys = keys0.filterKeys { it !in gone }
      var start = s.start
      // A FOLLOWING reader keeps a bounded log — only when this poll added
      // lines, never while they read back, never under an earlier page on its way.
      if (following && !s.loadingEarlier && messages.size > GC_KEEP_LINES && messages != s.messages) {
        val cut = messages.size - GC_KEEP_LINES
        val dropped = messages.take(cut).mapTo(HashSet()) { it.id }
        messages = messages.drop(cut)
        keys = keys.filterKeys { it !in dropped }
        start = false
      }
      val top = page.messages.maxOfOrNull { it.id } ?: 0
      s.copy(
        status = RoomStatus.OK,
        failing = false,
        messages = messages,
        pending = pending,
        keys = keys,
        gone = gone,
        start = start,
        // Never backwards: a quiet overlap answers with the `since` we sent.
        cursor = maxOf(s.cursor, page.cursor, top),
        room = page.room ?: s.room,
      )
    }
    return page.messages.size >= GC_POLL_LIMIT
  }

  /** The reader's own membership, asked for on open and again when it goes stale. */
  suspend fun pullMe(force: Boolean = false) {
    val s = _state.value
    if (!force && s.meState == MeState.OK && now() - book.get().meAt < ME_STALE_MS) return
    if (!meLock.tryLock()) return
    try {
      val gen = generation.get()
      val r = api.groupChatMe()
      if (gen != generation.get()) return
      book.updateAndGet { it.copy(meAt = now()) }
      val me = (r as? ApiResult.Ok)?.value
      // A failure keeps the last answer: a composer that vanished because one
      // refresh of a settled fact failed would read as being thrown out.
      _state.update {
        when {
          me != null -> it.copy(me = me, meState = MeState.OK)
          it.me != null -> it
          else -> it.copy(meState = MeState.UNREADABLE)
        }
      }
    } finally {
      meLock.unlock()
    }
  }

  /** The reader pressed Try again. */
  fun retry() {
    book.updateAndGet { it.copy(failures = 0) }
    scope.launch {
      pollNow()
      pullMe(force = true)
    }
  }

  /** The page before the oldest loaded line. A second call while one is on its way is dropped. */
  suspend fun loadEarlier() {
    val first = _state.value.messages.firstOrNull() ?: return
    if (_state.value.start) return
    if (!earlierLock.tryLock()) return
    try {
      val gen = generation.get()
      _state.update { it.copy(loadingEarlier = true, earlierFailed = false) }
      val r = api.groupChatPage("?before=${first.id}&limit=$GC_PAGE")
      if (gen != generation.get()) return
      val page = (r as? ApiResult.Ok)?.value
      if (page == null) {
        _state.update { it.copy(loadingEarlier = false, earlierFailed = true) }
        return
      }
      _state.update { s ->
        s.copy(
          loadingEarlier = false,
          messages = mergeLines(s.messages, page.messages.filter { it.id !in s.gone }),
          start = page.start ?: (page.messages.size < GC_PAGE),
        )
      }
    } finally {
      earlierLock.unlock()
    }
  }

  /** Page back until line [id] is loaded. False when it is not in the room any more or the pages would not come. */
  suspend fun loadUntil(id: Long): Boolean {
    for (hop in 0..MAX_EARLIER_HOPS) {
      val s = _state.value
      if (s.messages.any { it.id == id }) return true
      val first = s.messages.firstOrNull() ?: return false
      if (first.id < id || s.start || id in s.gone || hop == MAX_EARLIER_HOPS) return false
      loadEarlier()
      if (_state.value.earlierFailed) return false
    }
    return false
  }

  /** Whether the reader is at the bottom of the log. Only a following reader's log is trimmed. */
  fun setFollowing(on: Boolean) {
    book.updateAndGet { it.copy(following = on) }
  }

  // ── writing ────────────────────────────────────────────────────────────────

  /**
   * SEND AN OWNER LINE, drawn at once and settled when the server answers.
   *
   * One send at a time: a second tap, or a recomposition that calls this
   * again, while one is on its way is refused here and sends nothing. A 429's
   * Retry-After is kept, and until it passes no request is made at all.
   * [onDone] is called once, on the scope the send ran on.
   */
  fun send(body: String, replyTo: Long?, onDone: (SendResult) -> Unit = {}) {
    val text = body.trim()
    val local = localRefusal(text)
    if (local != null) {
      onDone(SendResult.Refused(local))
      return
    }
    var line: PendingLine? = null
    var busy = false
    val t = now()
    _state.update { s ->
      when {
        s.posting -> { busy = true; line = null; s }
        t < s.sendableAtMs -> { busy = false; line = null; s }
        else -> {
          busy = false
          val l = PendingLine(newClientId(), text, replyTo, t, s.cursor)
          line = l
          s.copy(pending = s.pending + l, posting = true)
        }
      }
    }
    val l = line
    if (l == null) {
      onDone(SendResult.Refused(if (busy) ONE_AT_A_TIME else slowDown(_state.value.sendableAtMs - t)))
      return
    }
    scope.launch { onDone(deliver(l)) }
  }

  /**
   * SEND AN UNCONFIRMED LINE AGAIN — with the SAME key. If the first attempt
   * landed, the server answers with that line and stores nothing new; if it
   * did not, this posts it. Either way it is in the room once.
   */
  fun resend(clientId: String, onDone: (SendResult) -> Unit = {}) {
    var line: PendingLine? = null
    var why: String? = null
    val t = now()
    _state.update { s ->
      val p = s.pending.firstOrNull { it.clientId == clientId && it.unconfirmed }
      when {
        p == null -> { why = "That message is already settled."; line = null; s }
        s.posting -> { why = ONE_AT_A_TIME; line = null; s }
        t < s.sendableAtMs -> { why = slowDown(s.sendableAtMs - t); line = null; s }
        else -> {
          why = null
          val again = p.copy(unconfirmed = false)
          line = again
          s.copy(pending = s.pending.map { if (it.clientId == clientId) again else it }, posting = true)
        }
      }
    }
    val l = line
    if (l == null) {
      onDone(SendResult.Refused(why ?: ONE_AT_A_TIME))
      return
    }
    scope.launch { onDone(deliver(l)) }
  }

  /** Take an unconfirmed line off this screen. It changes nothing on the server. */
  fun discard(clientId: String) {
    _state.update { s -> s.copy(pending = s.pending.filterNot { it.clientId == clientId && it.unconfirmed }) }
  }

  private suspend fun deliver(line: PendingLine): SendResult {
    val gen = generation.get()
    val r = api.groupChatPost(line.body, line.replyTo, line.clientId)
    if (gen != generation.get()) return SendResult.Refused("")
    val posted = (r as? ApiResult.Ok)?.value
    if (posted != null) {
      _state.update { s ->
        s.copy(
          pending = s.pending.filterNot { it.clientId == line.clientId },
          messages = mergeLines(s.messages, listOf(posted)).filter { it.id !in s.gone },
          keys = keyedTo(s.keys, line.clientId, posted.id),
          posting = false,
        )
      }
      return SendResult.Sent
    }
    if (r is ApiResult.Refused && r.status < 500) {
      // A REAL REFUSAL: the line was not stored. It comes off the screen — a
      // bubble for a message nobody else can see is a lie to the one person
      // looking — and the words go back in the box.
      val t = now()
      _state.update { s ->
        s.copy(
          pending = s.pending.filterNot { it.clientId == line.clientId },
          posting = false,
          sendableAtMs = if (r.status == 429 && r.retryAfterSec != null) {
            maxOf(s.sendableAtMs, t + r.retryAfterSec * 1000)
          } else {
            s.sendableAtMs
          },
        )
      }
      // Signed out, or no longer a member, since the screen opened: ask again,
      // so the composer stops offering what the server just refused.
      if (r.status == 401 || r.status == 403) scope.launch { pullMe(force = true) }
      return SendResult.Refused(postError(r.status, r.message, r.retryAfterSec))
    }
    // THE ANSWER WAS LOST — no answer, a 5xx (a proxy's 502 or 504 may stand
    // in front of a commit), or a 2xx with no line in it. The line may be in
    // the room. If a poll already brought its echo, it is; otherwise it stays
    // on screen, marked, and is never reported as failed.
    val settled = _state.value.let { s ->
      if (s.pending.none { it.clientId == line.clientId }) {
        s.keys.entries.firstOrNull { it.value == line.clientId }?.key
      } else {
        null
      }
    }
    if (settled != null) {
      _state.update { it.copy(posting = false) }
      return SendResult.Sent
    }
    _state.update { s ->
      s.copy(
        pending = s.pending.map { if (it.clientId == line.clientId) it.copy(unconfirmed = true) else it },
        posting = false,
      )
    }
    return SendResult.Unconfirmed(
      if (r is ApiResult.Refused) {
        "The room couldn't confirm that just now, so we can't say whether it was sent. It's kept below — sending it again won't post it twice."
      } else {
        "Can't reach merrymen right now, so we couldn't confirm your message was sent. It's kept below — sending it again won't post it twice."
      },
    )
  }

  /**
   * TAKE BACK ONE OF THE READER'S OWN LINES. Only a line that is theirs — an
   * owner line under their agent's slug — is ever asked about, and it leaves
   * the screen only when the server says it hid it. [onDone] gets null on
   * success, else the sentence to show.
   */
  fun hide(id: Long, onDone: (String?) -> Unit = {}) {
    val s = _state.value
    val line = s.messages.firstOrNull { it.id == id }
    if (line == null || !isMine(line, s.me?.slug)) {
      onDone("Only your own messages can be removed.")
      return
    }
    scope.launch {
      val gen = generation.get()
      val r = api.groupChatHide(id)
      if (gen != generation.get()) return@launch
      when {
        r is ApiResult.Ok && r.value -> {
          _state.update { st ->
            val gone = st.gone + id
            st.copy(gone = gone, messages = st.messages.filter { it.id !in gone }, keys = st.keys - id)
          }
          onDone(null)
        }
        r is ApiResult.Ok -> onDone("That message couldn't be removed — only your own lines can be.")
        r is ApiResult.Refused && r.status < 500 -> onDone(wordsOf(r.message) ?: "Couldn't remove that message. Try again.")
        r is ApiResult.Refused -> onDone("That didn't go through. Try again in a moment.")
        // No answer: the line may or may not be hidden. It stays on screen,
        // and the next poll's `gone` settles it.
        else -> onDone("Can't reach merrymen right now, so we couldn't confirm it was removed. Check the room before trying again.")
      }
    }
  }

  /** Mute the reader's agent in the room. The switch shows only what the server answers. */
  fun setMuted(muted: Boolean, onDone: (String?) -> Unit = {}) = writeMe(onDone) { api.groupChatSetMuted(muted) }

  /** The owner chose a time zone (`source: "owner"`, which no browser capture overwrites). */
  fun setZone(tz: String, onDone: (String?) -> Unit = {}) = writeMe(onDone) { api.groupChatSetZone(tz) }

  private fun writeMe(onDone: (String?) -> Unit, call: suspend () -> ApiResult<GcMe?>) {
    val me = _state.value.me
    if (me == null || !me.signedIn || !me.member) {
      onDone("Only owners with a Merryman can change this.")
      return
    }
    scope.launch {
      val gen = generation.get()
      val r = call()
      if (gen != generation.get()) return@launch
      val next = (r as? ApiResult.Ok)?.value
      if (next != null) {
        book.updateAndGet { it.copy(meAt = now()) }
        _state.update { it.copy(me = next, meState = MeState.OK) }
        onDone(null)
        return@launch
      }
      onDone(
        when {
          r is ApiResult.Unreachable -> "Can't reach merrymen right now, so we couldn't confirm that saved."
          r is ApiResult.Refused && r.status < 500 -> wordsOf(r.message) ?: "That didn't save. Try again."
          else -> "That didn't save. Try again."
        },
      )
    }
  }

  /**
   * A TURN ENDED — sign-out, or another server. Everything read for the old
   * turn goes: the room of another server is not this one's, and the old
   * wallet's membership is not the new reader's. Answers still in flight are
   * dropped by the generation. A ForgetHook: runs on IO, writes only a
   * StateFlow and atomics, and calls nothing on Repository.
   */
  fun forget() {
    generation.incrementAndGet()
    book.set(Book())
    _state.value = GroupChatState()
  }

  private fun localRefusal(text: String): String? = when {
    text.isEmpty() -> "Write something first."
    text.length > GC_COMPOSER_MAX -> "Keep it under $GC_COMPOSER_MAX characters."
    else -> null
  }

  private companion object {
    const val ONE_AT_A_TIME = "One message at a time — the last one is still sending."
  }
}

/** A rate limit's wait in words: "Slow down — try again in 7s." */
fun slowDown(waitMs: Long): String {
  val s = ((waitMs + 999) / 1000).coerceAtLeast(1)
  return "Slow down — try again in ${s}s."
}

/** The server's own sentence, or null when it wrote none (the client's "HTTP <code>"). */
private fun wordsOf(message: String): String? = message.takeUnless { it.isBlank() || it.matches(Regex("HTTP \\d+")) }

/**
 * WHAT TO TELL AN OWNER WHOSE LINE DID NOT POST (a 4xx).
 *
 * The server's sentence, because those are written for owners — the gate says
 * WHY a line was refused ("Links can't be posted in the room"), and "that was
 * refused" alone is a dead end. A short rate-limit wait is said in seconds.
 */
fun postError(status: Int, message: String, retryAfterSec: Long?): String {
  val words = wordsOf(message)
  return when (status) {
    429 -> if (retryAfterSec != null && retryAfterSec in 1..120) {
      slowDown(retryAfterSec * 1000)
    } else {
      words ?: "Slow down a little — try again in a minute."
    }
    401 -> words ?: "Sign in again to post."
    403 -> words ?: "Only owners with a Merryman can post."
    413 -> words ?: "That's too long to post. Keep it under $GC_COMPOSER_MAX characters."
    else -> words ?: "That message couldn't be posted."
  }
}

// ── pure helpers: the screen's decisions, testable without a device ─────────

/**
 * Union by id, ascending; a later copy of an id replaces an earlier one. The
 * SAME LIST when nothing changed, so a poll with no news is not a new list and
 * nothing on screen is redrawn for it.
 */
fun mergeLines(a: List<GcLine>, b: List<GcLine>): List<GcLine> {
  if (b.isEmpty()) return a
  val byId = LinkedHashMap<Long, GcLine>(a.size + b.size)
  for (m in a) byId[m.id] = m
  var changed = false
  for (m in b) {
    if (byId[m.id] == m) continue
    byId[m.id] = m
    changed = true
  }
  if (!changed) return a
  return byId.values.sortedBy { it.id }
}

private fun flat(s: String) = s.replace(Regex("\\s+"), " ").trim()

/**
 * THE ECHO OF A LINE THIS APP SENT, arriving by the poll before the send has
 * answered. The public line carries no client id, so the match is an owner
 * line under the reader's slug with the same words — and NEWER than anything
 * the reader had seen when it was sent, so "gm" said again is never absorbed
 * by the "gm" of a minute ago that the overlap window re-delivers.
 */
fun absorbEchoes(
  pending: List<PendingLine>,
  keys: Map<Long, String>,
  incoming: List<GcLine>,
  mySlug: String?,
): Pair<List<PendingLine>, Map<Long, String>> {
  if (mySlug == null || pending.isEmpty()) return pending to keys
  var p = pending
  var k = keys
  for (m in incoming) {
    if (m.author != "owner" || m.slug != mySlug || k.containsKey(m.id)) continue
    val hit = p.firstOrNull { m.id > it.after && flat(it.body) == flat(m.body) } ?: continue
    p = p - hit
    k = k + (m.id to hit.clientId)
  }
  return p to k
}

/** Point [clientId] at [id] alone, so no two rows ever share one key. */
fun keyedTo(keys: Map<Long, String>, clientId: String, id: Long): Map<Long, String> {
  val out = keys.filterNot { (k, v) -> v == clientId && k != id }
  return if (out.containsKey(id)) out else out + (id to clientId)
}

/** Was the summary's writer heard from within [GC_ROOM_STALE_MS] of [nowMs]? */
fun roomIsFresh(room: GcRoom?, seenAtMs: Long, nowMs: Long): Boolean =
  room != null && nowMs - seenAtMs <= GC_ROOM_STALE_MS

/**
 * The header's line about who is here — or null with nothing to say. A
 * summary the conductor has not refreshed in minutes is said to be unavailable
 * rather than repeated: "12 awake" from a writer that stopped is a claim about
 * now made with a fact from then.
 */
data class PresenceLine(val text: String, val fresh: Boolean)

fun presenceLine(room: GcRoom?, fresh: Boolean): PresenceLine? {
  if (room == null) return null
  if (!fresh) return PresenceLine("Presence unavailable", false)
  val awake = "${room.awake} awake"
  return PresenceLine(if (room.asleep > 0) "$awake · ${room.asleep} asleep" else awake, true)
}

/** Awake first, then by name — who you could talk to right now leads. */
fun sortPresence(list: List<GcPresence>): List<GcPresence> =
  list.sortedWith(compareBy<GcPresence>({ !it.awake }, { it.name.lowercase(Locale.ROOT) }))

/**
 * Is this line the reader's own? Only an OWNER line can be: the reader's agent
 * speaks under the same slug, and drawing its lines as theirs would put a
 * model's words in the owner's mouth — and offer to delete them.
 */
fun isMine(m: GcLine, mySlug: String?): Boolean = m.author == "owner" && mySlug != null && m.slug == mySlug

/** One line, cut to fit a quote chip. */
fun excerpt(text: String, max: Int = 80): String {
  val t = flat(text)
  return if (t.length <= max) t else t.take(max - 1).trimEnd() + "…"
}

/** A run of text, and the speaker it names when it is an `@mention` of one we know. */
data class TextPart(val text: String, val mention: String?)

/**
 * Split a line into plain text and `@Name` mentions of speakers in the room.
 * Only names this screen has seen are marked, so an `@` before anything else
 * stays plain — marking it would dress an unknown handle up as a member.
 * Longest name first. NEVER MARKUP: the parts, joined, are exactly [text].
 */
fun mentionParts(text: String, names: Collection<String>): List<TextPart> {
  val known = names.filter { it.isNotBlank() }.distinct().sortedByDescending { it.length }
  if (known.isEmpty() || '@' !in text) return listOf(TextPart(text, null))
  val alternatives = known.joinToString("|") { Regex.escape(it) }
  // (?iu): case-insensitive in every script, as the web's "giu" is. Plain
  // IGNORE_CASE folds ASCII only, and a room of names is not ASCII.
  val re = Regex("(?iu)(?<![\\p{L}\\p{N}_])@($alternatives)(?![\\p{L}\\p{N}_])")
  val out = ArrayList<TextPart>()
  var last = 0
  for (m in re.findAll(text)) {
    if (m.range.first > last) out += TextPart(text.substring(last, m.range.first), null)
    val said = m.groupValues[1]
    out += TextPart(m.value, known.firstOrNull { it.equals(said, ignoreCase = true) } ?: said)
    last = m.range.last + 1
  }
  if (last < text.length) out += TextPart(text.substring(last), null)
  return out.ifEmpty { listOf(TextPart(text, null)) }
}

/** Where a reply's original is. */
sealed interface ReplyTarget {
  data class Here(val line: GcLine) : ReplyTarget

  /** Older than the oldest loaded line; the room may still have it. */
  data object Earlier : ReplyTarget

  /** Taken back, or older than what the room keeps. */
  data object Gone : ReplyTarget
}

fun replyTarget(replyTo: Long, byId: Map<Long, GcLine>, firstId: Long?, start: Boolean, gone: Set<Long>): ReplyTarget {
  byId[replyTo]?.let { return ReplyTarget.Here(it) }
  if (firstId != null && replyTo < firstId && !start && replyTo !in gone) return ReplyTarget.Earlier
  return ReplyTarget.Gone
}

/** The log as the screen draws it: day titles, system lines, and runs by one speaker. */
sealed interface ChatItem {
  val key: String

  data class Day(override val key: String, val label: String) : ChatItem

  data class System(override val key: String, val line: GcLine) : ChatItem

  data class Line(
    override val key: String,
    val line: GcLine,
    val mine: Boolean,
    /** Still sending, or unconfirmed: not in the room as far as we know yet. */
    val pending: PendingLine?,
    /** First of a run: carries the face and the name. */
    val first: Boolean,
    /** Last of a run: carries the time. */
    val last: Boolean,
  ) : ChatItem
}

/**
 * The log as drawn. Pending lines go last, as the reader's own, in the order
 * they were sent — they have no id yet. Days are the READER's calendar, since
 * whose day it is to them is what "Today" means.
 */
fun chatItems(
  messages: List<GcLine>,
  pending: List<PendingLine>,
  mySlug: String?,
  keys: Map<Long, String>,
  zone: ZoneId,
  nowMs: Long,
): List<ChatItem> {
  data class Row(val line: GcLine, val pending: PendingLine?, val key: String)
  val rows = ArrayList<Row>(messages.size + pending.size)
  messages.forEach { rows += Row(it, null, keys[it.id] ?: "m${it.id}") }
  pending.forEachIndexed { i, p ->
    rows += Row(GcLine(-1L - i, p.at, "owner", mySlug, "You", p.body, p.replyTo, "chat", null), p, p.clientId)
  }
  val out = ArrayList<ChatItem>(rows.size + 4)
  var day: LocalDate? = null
  var prev: ChatItem.Line? = null
  var prevIndex = -1
  for (row in rows) {
    val m = row.line
    val d = Instant.ofEpochMilli(m.at).atZone(zone).toLocalDate()
    if (d != day) {
      day = d
      // Keyed by the row it heads, not by the day: stamps are not monotonic in
      // id, so one day can head the log twice around midnight.
      out += ChatItem.Day("d${row.key}", dayTitle(m.at, nowMs, zone))
      prev = null
    }
    if (m.author == "system") {
      out += ChatItem.System(row.key, m)
      prev = null
      continue
    }
    val mine = row.pending != null || isMine(m, mySlug)
    val p = prev
    val joins = p != null &&
      p.mine == mine &&
      p.line.author == m.author &&
      p.line.slug == m.slug &&
      (mine || p.line.name == m.name) &&
      m.at - p.line.at < RUN_GAP_MS
    if (joins) out[prevIndex] = p!!.copy(last = false)
    val item = ChatItem.Line(row.key, m, mine, row.pending, first = !joins, last = true)
    out += item
    prev = item
    prevIndex = out.lastIndex
  }
  return out
}

/** "Today", "Yesterday", else the date, in the reader's own zone. */
fun dayTitle(ms: Long, nowMs: Long, zone: ZoneId): String {
  val d = Instant.ofEpochMilli(ms).atZone(zone).toLocalDate()
  val today = Instant.ofEpochMilli(nowMs).atZone(zone).toLocalDate()
  return when (d) {
    today -> "Today"
    today.minusDays(1) -> "Yesterday"
    else -> DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM).format(d)
  }
}

/**
 * THE OWNER PANEL'S ONE LINE. The hours are the server's answer, computed with
 * the key the conductor uses — never recomputed here, because a second
 * computation is how an owner is shown one sleep window while the room runs
 * another.
 */
fun ownerSummary(me: GcMe): String = when {
  me.muted -> "Your Merryman is muted in the room"
  me.tz != null && me.sleepFrom != null && me.sleepTo != null ->
    "Your Merryman sleeps ${me.sleepFrom}–${me.sleepTo} (${me.tz})"
  else -> "Your Merryman never sleeps — tell it your time zone"
}

/** Every zone this device knows, plus the one the owner already has, sorted. */
fun timeZones(extra: List<String?>): List<String> {
  val zones = java.util.TreeSet(ZoneId.getAvailableZoneIds())
  zones += "UTC"
  extra.filterNotNull().filter { it.isNotBlank() }.forEach { zones += it }
  return zones.toList()
}

/**
 * ONE ROOM PER APP GRAPH, shared by every visit to the screen.
 *
 * The container is frozen, so the room hangs off the Repository instead: made
 * on first use, and registered as a ForgetHook then, so a sign-out or a
 * server change empties it. Weak, so a test graph that is dropped takes its
 * room with it.
 */
object GroupChatRooms {
  private val rooms = WeakHashMap<Repository, GroupChatRoom>()

  @Synchronized
  fun of(repo: Repository, scope: CoroutineScope): GroupChatRoom =
    rooms.getOrPut(repo) {
      GroupChatRoom(repo.api, scope).also { room -> repo.addForgetHook { room.forget() } }
    }
}
