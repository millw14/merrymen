package dev.merrymen.app.data

import android.content.Context
import dev.merrymen.app.net.Asked
import dev.merrymen.app.net.ChatBody
import dev.merrymen.app.net.ChatCommand
import dev.merrymen.app.net.ChatTurnWire
import dev.merrymen.app.net.Feed
import dev.merrymen.app.net.GrantView
import dev.merrymen.app.net.MerrymenApi
import dev.merrymen.app.net.ORDER_ID
import dev.merrymen.app.net.OrderReceipt
import dev.merrymen.app.net.SettingsEnvelope
import dev.merrymen.app.net.SnipeTarget
import dev.merrymen.app.net.askAgent
import dev.merrymen.app.net.orderCeiling
import dev.merrymen.app.net.perTradeUsdg
import dev.merrymen.app.net.pollOrder
import dev.merrymen.app.net.receiptOf
import dev.merrymen.app.net.valueOrNull
import dev.merrymen.app.ui.COMMANDS
import dev.merrymen.app.ui.ChatMove
import dev.merrymen.app.ui.MONEY_PAPER
import dev.merrymen.app.ui.PAPER_MOVED
import dev.merrymen.app.ui.Via
import dev.merrymen.app.ui.asksAmount
import dev.merrymen.app.ui.chatStateOf
import dev.merrymen.app.ui.failureLine
import dev.merrymen.app.ui.moneyLineFor
import dev.merrymen.app.ui.retryHelps
import dev.merrymen.app.ui.runConfirmedCard
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.Transient
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import java.io.File
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference

// ── the thread's lines ──────────────────────────────────────────────────────

/**
 * The order a line is about, and — once the worker answered — its receipt.
 * The line that PLACED it also keeps [serverPlacedAt], the server's own epoch
 * ms for the placement. [outcome] marks the line that carries the answer, so
 * a screen that placed the order can find what became of it.
 */
@Serializable
data class LineOrder(
  val id: String,
  val receipt: OrderReceipt? = null,
  val serverPlacedAt: Long? = null,
  val outcome: Boolean = false,
)

/**
 * ONE LINE OF THE CONVERSATION (the web's account.ts ChatMessage).
 *
 * `owner` is what they typed or confirmed; `agent` is the agent's words — a
 * model's reply, or the worker's own sentence about an order it ran; `event`
 * is something that HAPPENED, templated from ledger fields. [failed] marks a
 * failure said in the agent's voice by THIS APP, which is kept out of what the
 * model is told it said. [retry] is the question to put again, this session
 * only: it is never written to disk.
 */
@Serializable
data class ChatLine(
  val id: String,
  val role: String,
  /** Epoch ms on this phone's clock; null for a line from before times were kept. */
  val at: Long?,
  val text: String,
  val side: String? = null,
  val order: LineOrder? = null,
  val failed: String? = null,
  @Transient val retry: String? = null,
  /** The trade this line is about, once the tape showed it — the join that keeps one trade to one line (ChatFills). */
  val tradeKey: String? = null,
  /** That trade as the tape last read it. Never written to disk: a thread read back gets it again from the tape. */
  @Transient val trade: ChatMove? = null,
)

/** An order still being followed, and when to stop asking — on this phone's clock. */
@Serializable
data class KeptOrder(val id: String, val until: Long)

/**
 * Whose thread is in hand, and what is in it. [key] null is "nobody's": nothing
 * is shown or kept. [since] is the watermark below which the agent's own fills
 * are history rather than news (epoch seconds, the tape's clock), null until
 * the tape has been read once for this thread.
 */
data class ThreadState(
  val key: String?,
  val messages: List<ChatLine>,
  val orders: List<KeptOrder>,
  val since: Long? = null,
) {
  /**
   * THE LINES A SCREEN MAY DRAW for the session as it stands NOW — none unless
   * this thread is that session's. The forget hooks do not run when a session
   * merely lapses, and the thread catches up with a new wallet a moment after
   * the session does; in both gaps the last owner's words must not be drawn.
   */
  fun linesFor(hosted: Boolean?, address: String?): List<ChatLine> {
    val now = chatKeyFor(hosted, address)
    return if (now != null && key == now) messages else emptyList()
  }
}

/** How many lines are kept. Two per exchange, so forty exchanges. */
const val MAX_LINES = 80

/**
 * WHOSE CONVERSATION THIS IS, or null when there must be none.
 *
 * The signed-in address, lowercased, on a hosted server; "self" on a
 * self-hosted one, which has one operator and no sign-in. Hosted and signed
 * out, or not yet asked, is null: a visitor with no wallet has no agent to
 * have talked to, and an anonymous bucket would be the one shared key this
 * whole store exists to avoid. An address that is not an address is null too,
 * because the key names a file.
 */
fun chatKeyFor(hosted: Boolean?, address: String?): String? = when {
  hosted == false -> "self"
  hosted == true && address != null -> address.lowercase().takeIf { ADDRESS.matches(it) }
  else -> null
}

/** The wallet a key belongs to, for the `owner` every write carries; null self-hosted. */
fun ownerOfKey(key: String?): String? = key?.takeIf { ADDRESS.matches(it) }

private val ADDRESS = Regex("^0x[0-9a-f]{40}$")

// ── where a thread is kept ──────────────────────────────────────────────────

/**
 * ONE THREAD PER KEY, on this device only. Never uploaded, never shared: this
 * is one phone remembering what it already displayed. An interface so a JVM
 * test can keep it in a directory of its own.
 */
interface ThreadStore {
  fun load(key: String): String?
  fun save(key: String, raw: String)
  fun delete(key: String)
  /** Delete every kept thread but [key]'s — all of them when null. */
  fun deleteAllBut(key: String?)
}

/** The app's store: a file per key in its own directory under filesDir. */
class FileThreadStore(private val dir: File) : ThreadStore {
  private fun fileOf(key: String) = File(dir, "thread-$key.json")

  override fun load(key: String): String? = try {
    fileOf(key).takeIf { it.isFile }?.readText()
  } catch (e: IOException) {
    null
  }

  override fun save(key: String, raw: String) {
    try {
      dir.mkdirs()
      // Written beside and moved over, so a process killed mid-write leaves the
      // last whole thread rather than half of one.
      val tmp = File(dir, "thread-$key.json.tmp")
      tmp.writeText(raw)
      if (!tmp.renameTo(fileOf(key))) {
        fileOf(key).delete()
        tmp.renameTo(fileOf(key))
      }
    } catch (e: IOException) {
      android.util.Log.w("ChatThread", "could not keep the thread", e)
    }
  }

  override fun delete(key: String) {
    fileOf(key).delete()
  }

  override fun deleteAllBut(key: String?) {
    dir.listFiles()?.forEach { f ->
      if (f.name.startsWith("thread-") && (key == null || f.name != fileOf(key).name)) f.delete()
    }
  }
}

@Serializable
internal data class KeptFile(
  val v: Int = 2,
  val messages: List<ChatLine> = emptyList(),
  val orders: List<KeptOrder> = emptyList(),
  val since: Long? = null,
)

private val keptJson = Json {
  ignoreUnknownKeys = true
  explicitNulls = false
}

private val ROLES = setOf("owner", "agent", "event")
private val FAILURES = setOf("signed-out", "no-llm", "llm-error", "unreadable", "network", "timeout", "cut-off", "server", "no-address")

/**
 * A kept thread, SHAPE-CHECKED line by line rather than trusted: it is shown
 * as the agent's own words, and a receipt as a fact about somebody's money. A
 * line that fails its checks is dropped; a file that will not parse is an
 * empty thread, never a crash.
 */
internal fun decodeThread(raw: String?): KeptFile {
  if (raw.isNullOrBlank()) return KeptFile()
  val root = try {
    keptJson.parseToJsonElement(raw) as? JsonObject
  } catch (e: IllegalArgumentException) {
    null
  } ?: return KeptFile()
  val lines = (root["messages"] as? JsonArray).orEmpty().mapNotNull { el ->
    val line = try {
      keptJson.decodeFromJsonElement(ChatLine.serializer(), el)
    } catch (e: IllegalArgumentException) {
      return@mapNotNull null
    }
    if (line.id.isEmpty() || line.id.length > 200 || line.role !in ROLES) return@mapNotNull null
    // A receipt goes through the route's own field checks again: it is printed
    // as a fact about money, and this file is only as trustworthy as the disk.
    val order = line.order?.takeIf { ORDER_ID.matches(it.id) }?.let { o ->
      o.copy(
        receipt = o.receipt?.let { r -> receiptOf(keptJson.encodeToJsonElement(OrderReceipt.serializer(), r)) },
        serverPlacedAt = o.serverPlacedAt?.takeIf { it > 0 },
      )
    }
    line.copy(
      text = line.text.take(8_000),
      side = line.side?.takeIf { it == "buy" || it == "sell" },
      order = order,
      failed = line.failed?.takeIf { it in FAILURES },
      tradeKey = line.tradeKey?.takeIf { it.isNotEmpty() && it.length <= 200 },
    )
  }
  val orders = (root["orders"] as? JsonArray).orEmpty().mapNotNull { el ->
    try {
      keptJson.decodeFromJsonElement(KeptOrder.serializer(), el).takeIf { ORDER_ID.matches(it.id) }
    } catch (e: IllegalArgumentException) {
      null
    }
  }
  val since = (root["since"] as? kotlinx.serialization.json.JsonPrimitive)?.takeIf { !it.isString }
    ?.content?.toDoubleOrNull()?.takeIf { it.isFinite() && it >= 0 }?.toLong()
  return KeptFile(messages = lines.takeLast(MAX_LINES), orders = orders, since = since)
}

// ── confirming ──────────────────────────────────────────────────────────────

/**
 * WHAT A CONFIRMED CARD MAY DO, BOUND TO THE OWNER WHO WAS SHOWN IT.
 *
 * Captured when the card is made. Once that owner has gone from this phone
 * each of these is a no-op, so a confirm still in flight when another wallet
 * signs in cannot write "placed it" into the next owner's thread, follow the
 * previous owner's order there, or clear the next owner's card.
 */
interface ConfirmScope {
  /**
   * The wallet this acts for, lowercased — sent with EVERY write that acts, so
   * the route refuses (409) a session another wallet took over unseen. Null
   * only self-hosted: one operator, no sign-in, nobody to name.
   */
  val owner: String?

  /**
   * May a request that ACTS still go out? Only while the owner who was shown
   * the card has been the owner here the whole time: false from the moment it
   * changes, and still false if they come back. A request carries the session
   * the phone holds when it LEAVES, so this is asked before anything is sent.
   */
  fun alive(): Boolean

  fun say(role: String, text: String, order: LineOrder? = null)
  fun followOrder(id: String, expiresInMs: Long?)
  fun clearCard()
  /**
   * Put a second card up for the same owner — the coin a snipe found, to be
   * confirmed before it is bought. True when the owner will see it on a card:
   * the chat's, or the Trade screen's own next card (that screen draws it from
   * the look-up's answer; this scope leaves the chat's card alone). False when
   * the chat's card up is no longer the one being carried out (a newer question
   * cleared it or raised its own): nothing is swapped in under the owner's thumb.
   */
  fun propose(command: ChatCommand, found: SnipeTarget): Boolean
  fun refreshSettings()
}

/**
 * THE ONE THING THE AGENT HAS ASKED PERMISSION TO DO.
 *
 * HELD IN MEMORY AND NEVER WRITTEN TO DISK — the web's rule, and the plan's
 * "persist pending cards" is not followed here on purpose: a card restored
 * after a cold start would be an offer to act made by nobody, about a moment
 * that has passed. It lives until the next message, a decline, or the owner
 * changing, and runs only from a tap.
 */
data class PendingCard(val command: ChatCommand, val scope: ConfirmScope, val found: SnipeTarget? = null)

/**
 * What the chat knows about the book when it asks: each read's last good
 * answer, or null.
 *
 * [settingsKept] says the latest settings read failed and [settings] is an
 * earlier read's. That is still the best picture of the book for the model,
 * but it is no promise about the owner's switches NOW: Live trading may have
 * been turned on since, and a card must not say "paper" on it (moneyLineFor).
 */
data class ChatSnapshot(
  val feed: Feed?,
  val grants: GrantView?,
  val settings: SettingsEnvelope?,
  val settingsKept: Boolean = false,
)

/**
 * THE ONE CHAT THREAD, FOR THE WHOLE APP.
 *
 * The conversation has to outlive the Chat screen: a reply still streaming when
 * the owner switches tab, an order placed from chat or the Trade screen whose
 * outcome lands minutes later, a thread that survives the app being killed. So
 * it lives here, app-scoped, held by AppContainer as `container.chat`, and the
 * screens only draw it.
 *
 * KEPT PER WALLET, FORGOTTEN WHEN THE WALLET GOES. The thread is stored under
 * [chatKeyFor] — the signed-in address — in its own file. Its forget hook
 * deletes the leaving owner's file on sign-out, a wallet switch or a server
 * change. The hooks do NOT run on a cold start or when a session merely
 * expires, so the key itself follows repo.signedIn: whatever key the session
 * answers with is the only thread loaded, the previous key's file is deleted
 * when the key changes (the web's rule), and on loading one key every other
 * kept thread is deleted — so a wallet that signs in on a phone another wallet
 * used before, after a cold start the hooks never saw, finds its own empty
 * thread and nothing of the other's. A screen still renders only when
 * [ThreadState.key] matches the key the session gives NOW.
 *
 * WHAT IS KEPT: the lines, capped at [MAX_LINES], and the orders still being
 * followed with their give-up moment, so a cold start resumes the wait. NOT
 * kept: a card (see [PendingCard]) or a Retry chip.
 *
 * The forget hook keeps the HOOK RULES (see ForgetHook): it runs on IO, touches
 * only this thread's state, and never calls back into the Repository.
 */
class ChatThread internal constructor(
  private val api: MerrymenApi,
  private val repo: Repository,
  /** Outlives every screen; work that must finish after the Chat tab closes runs here. */
  private val appScope: CoroutineScope,
  private val store: ThreadStore,
  private val clock: () -> Long = System::currentTimeMillis,
  private val pause: suspend (Long) -> Unit = { delay(it) },
  private val io: CoroutineDispatcher = Dispatchers.IO,
) {
  constructor(context: Context, api: MerrymenApi, repo: Repository, appScope: CoroutineScope) :
    this(api, repo, appScope, FileThreadStore(File(context.filesDir, "chat")))

  private val state = MutableStateFlow(ThreadState(null, emptyList(), emptyList()))

  /** The thread in hand. Render it only when its key is the key the session gives now. */
  val thread: StateFlow<ThreadState> = state.asStateFlow()

  private val _unread = MutableStateFlow(0)
  /** Replies and order outcomes that landed while Chat was not on screen. 0 draws no dot. */
  val unread: StateFlow<Int> = _unread.asStateFlow()

  private val _sending = MutableStateFlow(false)
  /** A reply is on its way — the typing bubble. */
  val sending: StateFlow<Boolean> = _sending.asStateFlow()

  private val _streaming = MutableStateFlow<String?>(null)
  /** What of that reply may be shown so far (never a piece of a marker), or null before its first words. */
  val streaming: StateFlow<String?> = _streaming.asStateFlow()

  private val _card = MutableStateFlow<PendingCard?>(null)
  val card: StateFlow<PendingCard?> = _card.asStateFlow()

  private val _confirming = MutableStateFlow(false)
  /** The card is being carried out. Held here beside the card, so a tab switch cannot re-arm it. */
  val confirming: StateFlow<Boolean> = _confirming.asStateFlow()

  private val _draft = MutableStateFlow("")
  /** What the owner is typing. Kept here so a failed send can hand the words back. */
  val draft: StateFlow<String> = _draft.asStateFlow()

  private val _snapshot = MutableStateFlow<ChatSnapshot?>(null)
  val snapshot: StateFlow<ChatSnapshot?> = _snapshot.asStateFlow()

  private val _ceiling = MutableStateFlow<Double?>(null)
  /** The chat-order ceiling as last read, or null — and then no chip offers an amount. */
  val ceiling: StateFlow<Double?> = _ceiling.asStateFlow()

  @Volatile private var open = false
  @Volatile private var lastKey: String? = null
  /** Moves on every change of owner, there and back included; see [ConfirmScope.alive]. */
  private val ownerTurn = AtomicLong(0)
  /** Guards the disk: a save reads the thread inside it, so the last save always writes the newest. */
  private val diskLock = Mutex()
  /** The key saves may write under. Null after forget, so a save still queued cannot bring a file back. */
  @Volatile private var diskKey: String? = null
  private val following: MutableSet<String> = ConcurrentHashMap.newKeySet()
  /**
   * THE ONE SEND IN FLIGHT, and whose: a token holding the coroutine that
   * sends it. Cleared by [switchTo] and [forget], which also cancel that
   * coroutine: a reply still coming for the last wallet held the next one's
   * composer — the typing bubble under the new agent's name for up to the chat
   * client's two minutes, and a Send dropped without a word. A send finishing
   * after that frees the guard only if it is still its own, so it cannot free
   * or clear the send of the owner who came after it.
   */
  private val sendingNow = AtomicReference<SendHold?>(null)
  private class SendHold(val job: Job?)
  private val confirmHold = AtomicReference<Any?>(null)
  private val ceilingRead = AtomicLong(0)
  private val seq = AtomicLong(0)
  /** Numbers every snapshot read as it STARTS; see [readSnapshot]. */
  private val snapshotRead = AtomicLong(0)
  /** Guards [snapshotShown], [good] and [_snapshot] together, so a read lands whole or not at all. */
  private val snapshotLock = Any()
  /** The number of the read [_snapshot] holds. Only a read started after it may replace it. */
  private var snapshotShown = 0L
  @Volatile private var good: Pair<String, ChatSnapshot>? = null

  init {
    repo.addForgetHook { forget() }
    appScope.launch {
      combine(repo.signedIn, repo.hosted) { address, hosted -> chatKeyFor(hosted, address) }
        .distinctUntilChanged()
        .collect { switchTo(it) }
    }
  }

  /** The key the session gives right now — read directly, never through the collector's lag. */
  private fun keyNow(): String? = chatKeyFor(repo.hosted.value, repo.signedIn.value)

  private suspend fun switchTo(key: String?) {
    val previous = lastKey
    lastKey = key
    ownerTurn.incrementAndGet()
    confirmHold.set(null)
    dropSend()
    _card.value = null
    _confirming.value = false
    _streaming.value = null
    _unread.value = 0
    dropSnapshot()
    _ceiling.value = null
    _draft.value = ""
    val kept = withContext(io) {
      diskLock.withLock {
        // The leaving owner's thread is DELETED, not hidden — the web's rule —
        // and so is any other wallet's a cold start left behind.
        if (previous != null && previous != key) store.delete(previous)
        // Only once a key is KNOWN: at a cold start the key is null until the
        // session answers, and clearing then would delete the thread about to
        // be loaded.
        if (key != null) store.deleteAllBut(key)
        diskKey = key
        if (key == null) KeptFile() else decodeThread(store.load(key))
      }
    }
    if (lastKey != key) return
    state.value = ThreadState(key, kept.messages, kept.orders, kept.since)
    if (key != null && kept.orders.isNotEmpty()) {
      // Read the book before the first answer can land, so a receipt finds the
      // fill the tape may already show (absorbFill needs the trade in hand).
      appScope.launch { readSnapshot(key) }
      kept.orders.forEach { startFollow(key, it) }
    }
  }

  /** Drop the current wallet's thread. A forget hook: runs on sign-out, a wallet switch and a server change. */
  suspend fun forget() {
    val key = state.value.key ?: lastKey
    ownerTurn.incrementAndGet()
    confirmHold.set(null)
    dropSend()
    state.value = ThreadState(null, emptyList(), emptyList())
    _card.value = null
    _confirming.value = false
    _streaming.value = null
    _unread.value = 0
    dropSnapshot()
    _ceiling.value = null
    _draft.value = ""
    diskLock.withLock {
      diskKey = null
      if (key != null) store.delete(key)
    }
  }

  /**
   * THE SEND IN FLIGHT BELONGS TO THE OWNER WHO IS LEAVING: cancelled, which
   * now cancels its HTTP call too (askAgent), and the guard and the typing
   * bubble freed for whoever comes next. Its reply would have been dropped
   * anyway ([sendNow] keeps only a reply for the key it asked under).
   */
  private fun dropSend() {
    sendingNow.getAndSet(null)?.job?.cancel()
    _sending.value = false
  }

  /** The Chat screen is showing (or not). What lands while it is not counts toward the dot. */
  fun setOpen(showing: Boolean) {
    open = showing
    if (showing) {
      _unread.value = 0
      val key = state.value.key ?: return
      appScope.launch { readSnapshot(key) }
      appScope.launch { readCeiling(key) }
    }
  }

  fun setDraft(text: String) {
    _draft.value = text
  }

  fun dismissCard() {
    _card.value = null
  }

  /** Empty this owner's thread. */
  fun clearThread() {
    val key = state.value.key ?: return
    update(key) { it.copy(messages = emptyList(), orders = emptyList(), since = null) }
    _card.value = null
    _streaming.value = null
  }

  private fun arrived() {
    if (!open) _unread.update { it + 1 }
  }

  private fun lineId(prefix: String) = "$prefix-${clock().toString(36)}-${seq.getAndIncrement().toString(36)}"

  /**
   * Change THIS owner's thread — never whoever is in hand by the time an answer
   * lands. Every change goes through here, so every change is capped and kept.
   */
  private fun update(key: String, fn: (ThreadState) -> ThreadState): Boolean {
    var changed = false
    state.update { t ->
      val next = if (t.key == key) fn(t) else t
      changed = next !== t
      if (!changed) {
        t
      } else {
        // Capped here, for every change — and the watermark moves past any
        // trade the trim removes, so the tape cannot bring it back as news.
        val (messages, since) = capThread(next.messages, next.since)
        next.copy(messages = messages, since = since)
      }
    }
    if (changed) keep()
    return changed
  }

  private fun keep() {
    appScope.launch(io) {
      diskLock.withLock {
        val t = state.value
        val key = t.key ?: return@withLock
        if (key != diskKey) return@withLock
        if (t.messages.isEmpty() && t.orders.isEmpty() && t.since == null) {
          store.delete(key)
        } else {
          val file = KeptFile(messages = t.messages, orders = t.orders, since = t.since)
          store.save(key, keptJson.encodeToString(KeptFile.serializer(), file))
        }
      }
    }
  }

  private fun append(key: String, line: ChatLine) = update(key) { it.copy(messages = it.messages + line) }

  // ── what the chat knows ──────────────────────────────────────────────────

  /**
   * Settings, feed and grants, read together. Each keeps its LAST GOOD answer
   * for this owner when a read fails; one never read is null, and the chat
   * state then says it could not be read rather than handing the model a
   * default dressed as the owner's choice. A feed that answers source "none"
   * was not read.
   *
   * THE NEWEST READ THAT HAS LANDED IS THE ONE SHOWN — by when it STARTED, not
   * when it finished. The three answers are awaited together, and any one can
   * wait behind a rate-limit backoff for up to the 30s read timeout, so a read
   * whose settings answered "Live trading off" before the owner switched it on
   * could land after a read that saw it on, and take it back: a buy card
   * already on screen, correctly "treat this as real money", turned into
   * "Paper … no real order goes out" while the next tick could spend real USDG.
   * So a read replaces [_snapshot] only when it started after the read in it.
   *
   * Not the ceiling's rule ([readCeiling]: only the newest STARTED may land).
   * Under that, the read the question itself made could be thrown away because
   * a later one — a follow's, a resume's — was still out, and the card would
   * be drawn from whatever landed before the question, older still. Here the
   * card is always drawn from a read at least as new as the question's.
   *
   * The caller gets what it read either way: the model's picture of the book
   * for this question is this read's.
   */
  internal suspend fun readSnapshot(key: String): ChatSnapshot {
    val n = snapshotRead.incrementAndGet()
    val fresh = coroutineScope {
      val feed = async { api.feed().valueOrNull()?.takeIf { it.source != "none" } }
      val grants = async { api.grants().valueOrNull() }
      val settings = async { api.settings().valueOrNull() }
      ChatSnapshot(feed.await(), grants.await(), settings.await())
    }
    return synchronized(snapshotLock) {
      val last = good?.takeIf { it.first == key }?.second
      val merged = ChatSnapshot(
        feed = fresh.feed ?: last?.feed,
        grants = fresh.grants ?: last?.grants,
        settings = fresh.settings ?: last?.settings,
        settingsKept = fresh.settings == null && last?.settings != null,
      )
      if (n > snapshotShown && keyNow() == key && state.value.key == key) {
        snapshotShown = n
        good = key to merged
        _snapshot.value = merged
        // Only a feed that ANSWERED is a tape; a failed read is not an empty one.
        // Taken under the same lock, so tapes come in the order their reads
        // started and only from a read that landed: the first look is never an
        // older tape than one the thread has already taken.
        chatTape(merged.grants?.exists, fresh.feed)?.let { mergeTape(key, it) }
      }
      merged
    }
  }

  /**
   * The owner changed: what was read for the last one is gone, and no read
   * started before this moment may land after it — not for somebody else, and
   * not for the same wallet coming back, whose switches may have moved since.
   */
  private fun dropSnapshot() = synchronized(snapshotLock) {
    snapshotShown = snapshotRead.get()
    good = null
    _snapshot.value = null
  }

  /**
   * THE AGENT'S OWN FILLS INTO THIS OWNER'S THREAD (ChatFills.mergeFills). The
   * first tape the thread sees is history, so it sets the watermark and adds
   * nothing; after that each new landed fill is one line, and one landing
   * while Chat is not on screen lights the dot.
   */
  private fun mergeTape(key: String, moves: List<ChatMove>) {
    var added = false
    update(key) { t ->
      val since = t.since ?: newestAt(moves)
      val merged = mergeFills(t.messages, moves, since)
      added = merged.any { m -> m.role == "event" && t.messages.none { it.id == m.id } }
      if (merged === t.messages && since == t.since) t else t.copy(messages = merged, since = since)
    }
    if (added) arrived()
  }

  /**
   * THE CEILING, READ AGAIN — withdrawn while it is read, and after a read that
   * failed: no amount is offered against a limit that is being, or could not
   * be, read. Only the newest read may set it.
   */
  internal suspend fun readCeiling(key: String) {
    val read = ceilingRead.incrementAndGet()
    _ceiling.value = null
    val v = api.orderCeiling()
    if (v != null && state.value.key == key && ceilingRead.get() == read) _ceiling.value = v
  }

  // ── sending ──────────────────────────────────────────────────────────────

  /** Send in the app's scope, so leaving the screen mid-reply does not lose the reply. */
  fun send(question: String) {
    appScope.launch { sendNow(question, null) }
  }

  /** Ask again the question a failed line carries. */
  fun retry(lineId: String) {
    val m = state.value.messages.firstOrNull { it.id == lineId } ?: return
    val q = m.retry ?: return
    appScope.launch { sendNow(q, lineId) }
  }

  /**
   * ONE MESSAGE AND WHAT BECAME OF IT.
   *
   * The owner's line appears at once, the reply streams into the typing
   * bubble, and a failure is said in the agent's voice (failureLine), with a
   * Retry where asking again can work and the words handed back to the draft.
   * The model is told what was said BEFORE this line, failures left out.
   */
  internal suspend fun sendNow(question: String, retryOf: String?): Boolean {
    val q = question.trim()
    if (q.isEmpty()) return false
    val key = state.value.key ?: return false
    if (keyNow() != key) return false
    val hold = SendHold(currentCoroutineContext()[Job])
    if (!sendingNow.compareAndSet(null, hold)) return false
    _sending.value = true
    _streaming.value = null
    _card.value = null
    try {
      val kept = state.value.messages
      // SENDING THE FAILED QUESTION AGAIN IS A RETRY, however it was sent.
      val again = retryOf ?: kept.lastOrNull()?.takeIf { it.retry == q }?.id
      val history = if (again != null) historyBeforeRetry(kept, again, q) else historyFor(kept)
      if (again != null) {
        update(key) { t -> t.copy(messages = t.messages.filter { it.id != again }) }
      } else {
        append(key, ChatLine(lineId("owner"), "owner", clock(), q))
      }
      _draft.update { d -> if (d.trim() == q) "" else d }
      val snap = readSnapshot(key)
      val stateJson = chatStateOf(snap.feed, snap.settings, snap.grants, clock())
      val out = api.askAgent(ChatBody(message = q, state = stateJson.toString(), history = history)) { visible ->
        if (state.value.key == key) _streaming.value = visible
      }
      if (state.value.key != key) return false
      when (out) {
        is Asked.Replied -> {
          append(key, ChatLine(lineId("agent"), "agent", clock(), out.reply))
          if (asksAmount(out.reply)) appScope.launch { readCeiling(key) }
          // ONLY `done` MAY RAISE A CARD, and only for the owner who asked.
          _card.value = out.command?.let { PendingCard(it, Scope(key, ownerTurn.get(), chatCard = true)) }
        }
        is Asked.Failed -> {
          val line = failureLine(out.failure, out.status, out.kind, out.provider)
          val retry = if (retryHelps(out.failure, out.kind)) q else null
          append(key, ChatLine(lineId("agent"), "agent", clock(), line, failed = out.failure, retry = retry))
          _draft.update { d -> if (d.isNotBlank()) d else q }
        }
      }
      arrived()
      return out is Asked.Replied
    } finally {
      if (sendingNow.compareAndSet(hold, null)) {
        _sending.value = false
        _streaming.value = null
      }
    }
  }

  // ── cards ────────────────────────────────────────────────────────────────

  /**
   * A SCOPE FOR A CARD ANOTHER SCREEN MAKES — the Trade screen's — bound to the
   * owner here now. Its orders are said in this thread and followed here like a
   * chat order, so the receipt lands in the conversation whichever screen the
   * owner is on; it never touches the chat's own card.
   */
  fun cardScope(): ConfirmScope? {
    val key = state.value.key ?: return null
    if (keyNow() != key) return null
    return Scope(key, ownerTurn.get(), chatCard = false)
  }

  /**
   * CARRY OUT THE CARD ONCE. A second tap while one is in flight does nothing,
   * from whichever screen it came — the hold lives beside the card, not in a
   * screen, so a tab switch mid-POST cannot bring the same card back ready.
   * [onNavigate] gets a web path and its page's title for a navigate card.
   */
  fun confirm(onNavigate: (String, String) -> Unit) {
    val card = _card.value ?: return
    val hold = Any()
    if (!confirmHold.compareAndSet(null, hold)) return
    _confirming.value = true
    appScope.launch {
      try {
        if (!paperStillHolds(card)) return@launch
        // The limits as last read: an order past one is refused before it is sent.
        runConfirmedCard(api, card, _snapshot.value?.grants?.perTradeUsdg, _ceiling.value, onNavigate)
      } finally {
        if (confirmHold.compareAndSet(hold, null)) _confirming.value = false
      }
    }
  }

  /**
   * PAPER IS CHECKED AGAIN AT THE TAP, NOT ONLY WHEN THE CARD WAS DRAWN.
   *
   * An order card saying "Paper … no real order goes out" was drawn from the
   * last read, and an open Chat reads again only when it is asked something,
   * comes back on screen, or a card acts. Live trading switched on from the web
   * or Telegram while the card sits there changes nothing on it, and the worker
   * decides paper or live at the tick that picks the order up — so the owner
   * would confirm a card that called real USDG simulated. So a Paper order card
   * reads the book again first, and the order goes only if that read, and what
   * the screen now shows, still say Paper. Anything else — Live trading on, the
   * rail live, the settings unread — sends nothing: the card stays up, redrawn
   * from that read, the thread says why, and a second tap confirms what the
   * card now says. Any other line already said "treat this as real money",
   * which is what the owner confirmed, so it asks for no read.
   */
  private suspend fun paperStillHolds(card: PendingCard): Boolean {
    if (COMMANDS[card.command.id]?.via != Via.ORDER) return true
    if (moneyLineFor(_snapshot.value) != MONEY_PAPER) return true
    // No thread in hand: runConfirmedCard finds the scope dead and sends nothing.
    val key = state.value.key ?: return true
    val now = readSnapshot(key)
    if (moneyLineFor(now) == MONEY_PAPER && moneyLineFor(_snapshot.value) == MONEY_PAPER) return true
    card.scope.say("agent", PAPER_MOVED)
    return false
  }

  /**
   * One owner's scope. [chatCard] is whether it belongs to the chat's card: only
   * then may it clear or replace that card. A Trade-screen scope says its lines
   * in the thread, marked as confirmed there, and leaves the chat's card alone.
   *
   * AND ONLY ITS OWN CARD. The composer stays open while a card is carried
   * out, and a question sent meanwhile clears the card and raises its reply's.
   * A confirm still running (a snipe look-up can take 15s) then cleared that
   * newer card, or swapped it for "Found it — buy $X of COIN" with Yes in the
   * same place, between the owner reading it and tapping. So a scope touches
   * the card only while the card up is the one it was made for.
   */
  private inner class Scope(val key: String, val turn: Long, val chatCard: Boolean) : ConfirmScope {
    override val owner: String? = ownerOfKey(key)
    override fun alive() = ownerTurn.get() == turn && keyNow() == key && state.value.key == key
    private fun theirs() = state.value.key == key && keyNow() == key
    override fun say(role: String, text: String, order: LineOrder?) {
      val said = if (!chatCard && role == "owner" && text == "✓ Confirmed") "✓ Confirmed on the Trade screen" else text
      if (theirs()) append(key, ChatLine(lineId(role), role, clock(), said, order = order))
    }
    override fun followOrder(id: String, expiresInMs: Long?) {
      if (theirs()) follow(key, id, expiresInMs)
    }
    override fun clearCard() {
      if (chatCard && theirs()) _card.update { if (it?.scope === this) null else it }
    }
    override fun propose(command: ChatCommand, found: SnipeTarget): Boolean {
      if (!chatCard) return true
      if (!alive()) return false
      var put = false
      _card.update { now ->
        put = now?.scope === this
        if (put) PendingCard(command, this, found) else now
      }
      return put
    }
    override fun refreshSettings() {
      if (!theirs()) return
      appScope.launch { readSnapshot(key) }
      appScope.launch { readCeiling(key) }
    }
  }

  // ── orders, followed here and not by a screen ────────────────────────────

  private fun follow(key: String, id: String, expiresInMs: Long?) {
    if (!ORDER_ID.matches(id)) return
    val order = KeptOrder(id, OrderFollow.followDeadline(expiresInMs, clock()))
    update(key) { t -> if (t.orders.any { it.id == id }) t else t.copy(orders = t.orders + order) }
    startFollow(key, state.value.orders.firstOrNull { it.id == id } ?: order)
  }

  /** Every kept order is followed exactly once per owner, the ones a cold start brought back included. */
  private fun startFollow(key: String, order: KeptOrder) {
    val tag = "$key|${order.id}"
    if (!following.add(tag)) return
    appScope.launch {
      try {
        OrderFollow.followUntil(
          id = order.id,
          giveUpAt = order.until,
          poll = { api.pollOrder(it) },
          sleep = pause,
          now = clock,
          // Not "is the screen open": "is this still this owner's thread".
          alive = { state.value.key == key },
          say = { line, poll ->
            // THE WORKER'S WORDS, and its receipt when it wrote one — both read
            // off the ledger. Nothing here infers an outcome.
            val answer = ChatLine(
              lineId("order"), "agent", clock(), line,
              order = LineOrder(order.id, receipt = poll?.receipt, outcome = true),
            )
            val landed = update(key) { t ->
              t.copy(
                orders = t.orders.filter { it.id != order.id },
                // The tape may have shown the fill first: the receipt takes it
                // over, so one trade stays one line.
                messages = absorbFill(t.messages + answer, answer.id),
              )
            }
            // Only an answer that landed in THIS owner's thread lights the dot.
            if (landed) {
              arrived()
              if (poll != null) appScope.launch { readSnapshot(key) }
            }
          },
        )
      } finally {
        following.remove(tag)
      }
    }
  }
}

// ── what the model is told was said ─────────────────────────────────────────

/**
 * THE LAST EIGHT LINES, as the model hears them: the owner's as theirs, the
 * agent's as its own, an event or a receipt as the templated line it is. A
 * failure said in the agent's voice is THIS APP's, not the model's — telling
 * the model it said "I couldn't reach you" would put words in its mouth about
 * a network it never saw — so it is left out.
 */
fun historyFor(messages: List<ChatLine>): List<ChatTurnWire> =
  messages
    .filter { it.text.isNotEmpty() && it.failed == null }
    .map { m ->
      val receipt = m.order?.receipt
      ChatTurnWire(
        role = if (m.role == "owner") "user" else "assistant",
        content = when {
          m.role == "event" && (m.side == "buy" || m.side == "sell") ->
            "[${if (m.side == "buy") "Buy" else "Sell"}] ${m.text}"
          receipt != null -> "${receiptText(receipt)} — ${m.text}"
          else -> m.text
        },
      )
    }
    .takeLast(8)

/**
 * What the model hears as said BEFORE a question put again: the failed answer
 * and the owner's line it answered are left out, so the model does not read
 * the question asked twice in a row. Whatever else arrived meanwhile stays.
 */
fun historyBeforeRetry(messages: List<ChatLine>, failedId: String, question: String): List<ChatTurnWire> {
  val failedAt = messages.indexOfFirst { it.id == failedId }
  var askedAt = -1
  for (i in (if (failedAt < 0) messages.size else failedAt) - 1 downTo 0) {
    val m = messages[i]
    if (m.role == "owner" && m.text.trim() == question) {
      askedAt = i
      break
    }
  }
  return historyFor(messages.filterIndexed { i, _ -> i != failedAt && i != askedAt })
}
