package dev.merrymen.app.data

import dev.merrymen.app.net.Feed
import dev.merrymen.app.ui.ChatMove
import dev.merrymen.app.ui.chatMoves
import dev.merrymen.app.ui.jsNumber
import kotlin.math.abs

/**
 * THE AGENT'S OWN FILLS, IN THE CONVERSATION — a port of the web's
 * terminal/chat-thread.ts mergeFills, capThread and absorbFill.
 *
 * The agent trades when nobody is talking to it, and none of that reached the
 * thread: an owner asked "did you buy anything?" of a chat that had never
 * shown them a fill. Every landed buy or sell on the owner's tape that is
 * NEWER than the thread's watermark becomes one `event` line, templated from
 * the ledger's own fields ("$5.00 CASHCAT · Filled") — never a model's words.
 *
 * The hard part is ONE TRADE, ONE LINE. A chat order already says "Filled" in
 * its receipt, so its fill joins that receipt instead of repeating it, in
 * either order of arrival; the next read of the same tape adds nothing; a
 * line trimmed off the top of a full thread is not brought back as news; and
 * a line keyed before the tape carried the trade's hash keeps its place once
 * it does. Each rule is one the web found by showing a trade twice.
 */

/** How far a buy's fill may be from its answer when its size agrees and the order's life is only known on this phone's clock. */
private const val SAME_TRADE_MS = 30 * 60_000L

/** How far the order's life may be missed by, for a join by time: two servers' clocks, and the answer's trip back. */
private const val CLOCK_SKEW_MS = 2 * 60_000L

private val TX = Regex("^0x[0-9a-fA-F]{64}$")
private val FIELD_KEY_AT = Regex("^t:(\\d+(?:\\.\\d+)?):")

/**
 * THE OWNER'S TAPE AS THE THREAD MAY SEE IT — or null when it was not READ.
 *
 * Never an empty stand-in: the first tape the thread sees sets its watermark
 * (everything on it is history), so an empty list handed over for a read that
 * failed would set the watermark to nothing, and the next read that worked
 * would pour every fill on the tape into the conversation as news. With no
 * agent there is no tape at all. [feed] is a read that ANSWERED (source not
 * "none"); [agentExists] is the grants' `exists`, null when they were not read.
 */
fun chatTape(agentExists: Boolean?, feed: Feed?): List<ChatMove>? =
  if (agentExists == true && feed != null && feed.source != "none") chatMoves(feed) else null

/** The newest trade time on a tape — the watermark a first look starts from. 0 for none. */
fun newestAt(moves: List<ChatMove>): Long = moves.fold(0L) { max, m -> if (m.at > max) m.at else max }

/** The chain hash a row carries, lowercased, or null. */
private fun txOf(m: ChatMove): String? = m.txHash?.takeIf { TX.matches(it) }?.lowercase()

/** The ledger fields that make a row one row — the key before a row had a hash. */
private fun fieldKeyOf(m: ChatMove): String? {
  if (m.action != "buy" && m.action != "sell") return null
  val size = m.sizeUsdg?.let(::jsNumber).orEmpty()
  return "t:${m.at}:${m.action}:${m.symbol.orEmpty().uppercase()}:$size:${if (m.paper) "p" else "l"}"
}

/**
 * WHICH TRADE THIS IS, so the thread can hold it exactly once: the chain hash
 * when the tape carries one, else the fields that make a ledger row one row.
 * Null for anything that is not a buy or a sell — a hold is not a fill.
 */
fun tradeKeyOf(m: ChatMove): String? = txOf(m)?.let { "tx:$it" } ?: fieldKeyOf(m)

/**
 * A LANDED BUY OR SELL, FOR REAL MONEY. Not a paper one: the tape books a paper
 * trade as "landed", and a paper agent trading every tick would turn the
 * eighty-line thread into a practice log with an unread dot for each — and
 * "Filled" on a surface that reads as money. The worker's receipt refuses to
 * call a paper trade filled for the same reason.
 */
private fun isFill(m: ChatMove) = m.outcome == "landed" && !m.paper && (m.action == "buy" || m.action == "sell")

/** The template for one of the agent's own fills: "$5.00 CASHCAT · Filled". The side goes on the pill. */
fun fillParts(m: ChatMove): Pair<String?, String> {
  val what = listOfNotNull(m.sizeUsdg?.takeIf { it.isFinite() }?.let(::usdCents), m.symbol ?: UNLABELLED).joinToString(" ")
  val side = m.action?.takeIf { it == "buy" || it == "sell" }
  return side to "$what · Filled${if (m.paper) " on paper" else ""}"
}

/**
 * WHEN THE ORDER A RECEIPT ANSWERS WAS ALIVE, on the LEDGER's clock where the
 * thread can tell.
 *
 * A line's `at` is THIS PHONE's clock and a fill's is the worker's; a phone
 * minutes off made one chat trade two lines when the two were compared. So
 * the placing line keeps the server's own placement time, the gap between it
 * and the line's own `at` is this phone's offset, and the order's life is from
 * the server's placement to the answer moved by that offset. [anchored] is
 * false when the placing line has no server time: the life is then this
 * phone's own reading, or half an hour before the answer.
 */
private data class OrderLife(val from: Long, val to: Long, val anchored: Boolean)

private fun lifeOf(messages: List<ChatLine>, line: ChatLine): OrderLife? {
  val at = line.at ?: return null
  val id = line.order?.id
  val placing = if (id == null) {
    null
  } else {
    messages.firstOrNull { it !== line && it.order != null && it.order.id == id && it.order.receipt == null && it.at != null }
  }
  val server = placing?.order?.serverPlacedAt
  if (placing != null && server != null) return OrderLife(server, at + (server - placing.at!!), anchored = true)
  return OrderLife(placing?.at ?: (at - SAME_TRADE_MS), at, anchored = false)
}

/** How far a fill is from the answer that describes it, on the clock the life is read on. */
private fun gap(life: OrderLife?, fill: ChatMove): Long = if (life == null) 0 else abs(fill.at * 1000 - life.to)

/**
 * IS THIS FILL THE TRADE THAT CHAT ORDER'S RECEIPT DESCRIBES?
 *
 * The chain hash decides when both sides carry one, and nothing else does.
 * Otherwise side and coin must agree, and so must a BUY's size — what was
 * spent is one figure on both sides. A SELL's is not: the tape carries the
 * order's size and the receipt the cash the fill returned (or nothing), so a
 * sell is matched on side, coin and TIME, the time being the order's own life
 * give or take [CLOCK_SKEW_MS] — the agent's own earlier or later sell of the
 * coin is never taken for it.
 */
private fun sameTrade(message: ChatLine, fill: ChatMove, life: OrderLife?): Boolean {
  val r = message.order?.receipt ?: return false
  if (r.status != "filled" || message.tradeKey != null) return false
  if (r.side != fill.action) return false
  if (r.symbol == null || fill.symbol == null || !r.symbol.equals(fill.symbol, ignoreCase = true)) return false
  val tx = txOf(fill)
  if (r.txHash != null && tx != null) return r.txHash.lowercase() == tx
  val sized = r.side == "buy" && r.usdgActual != null && fill.sizeUsdg != null
  if (sized && abs(r.usdgActual!! - fill.sizeUsdg!!) >= 0.005) return false
  if (life == null) return true
  val at = fill.at * 1000
  if (sized && !life.anchored) return abs(at - life.to) <= SAME_TRADE_MS
  return at >= life.from - CLOCK_SKEW_MS && at <= life.to + CLOCK_SKEW_MS
}

/** A receipt that said "filled" and has not been joined to its fill yet. */
private fun awaitsFill(m: ChatLine) = m.order?.receipt?.status == "filled" && m.tradeKey == null

/**
 * THE AGENT'S OWN FILLS, JOINED INTO THE THREAD BY TRADE.
 *
 * Every landed buy or sell newer than [since] (epoch seconds, the tape's clock)
 * becomes one `event` line, once. A chat order's fill joins its receipt — each
 * receipt taking the matching fill NEAREST its answer, and a fill one receipt
 * took being no other's (two sells of one coin can both hold the first fill in
 * their lives; claimed twice, the second sell was shown twice). A line keyed
 * before the tape carried its trade's hash is read under its new key.
 *
 * `trade` is never stored — only the key — so a thread read back from disk
 * gets its trades back here from whatever the tape still holds.
 *
 * Returns the SAME list when nothing changed, so a caller can tell. It does
 * not trim: [capThread] does, for every change, and moves the watermark.
 */
fun mergeFills(messages: List<ChatLine>, moves: List<ChatMove>, since: Long): List<ChatLine> {
  var out = messages
  fun replace(i: Int, next: ChatLine) {
    if (out === messages) out = messages.toMutableList()
    (out as MutableList<ChatLine>)[i] = next
  }
  val byKey = LinkedHashMap<String, ChatMove>()
  // A row's key from before its tape carried the hash → its key now.
  val renamed = HashMap<String, String>()
  for (m in moves) {
    val key = if (isFill(m)) tradeKeyOf(m) else null
    if (key == null) continue
    byKey[key] = m
    val older = fieldKeyOf(m)
    if (older != null && older != key) renamed[older] = key
  }
  fun current(key: String?) = key?.let { renamed[it] ?: it }
  // The trade back onto lines the thread already has — only where it is missing.
  out.forEachIndexed { i, line ->
    val t = current(line.tradeKey)?.let { byKey[it] }
    if (t != null && line.trade == null) replace(i, line.copy(trade = t))
  }
  val known = out.mapNotNull { current(it.tradeKey) }.toSet()
  val fresh = byKey.entries.filter { it.key !in known && it.value.at > since }.sortedBy { it.value.at }
  val joined = HashSet<String>()
  for (i in out.indices) {
    val line = out[i]
    if (!awaitsFill(line)) continue
    val life = lifeOf(out, line)
    var best: Map.Entry<String, ChatMove>? = null
    for (entry in fresh) {
      if (entry.key in joined || !sameTrade(line, entry.value, life)) continue
      if (best == null || gap(life, entry.value) < gap(life, best.value)) best = entry
    }
    if (best != null) {
      replace(i, line.copy(tradeKey = best.key, trade = best.value))
      joined += best.key
    }
  }
  for ((key, fill) in fresh) {
    if (key in joined) continue
    val (side, text) = fillParts(fill)
    if (out === messages) out = messages.toMutableList()
    (out as MutableList<ChatLine>) += ChatLine(
      id = "fill-$key", role = "event", at = fill.at * 1000, text = text, side = side, tradeKey = key, trade = fill,
    )
  }
  return out
}

/**
 * When the trade a line is about happened, on the tape's clock — or null for a
 * line about no trade: the trade's own time when it is loaded, else the one a
 * `t:` key was built from, else the line's own (a receipt comes after its fill).
 */
private fun tradeAtOf(m: ChatLine): Long? {
  if (m.tradeKey == null) return null
  m.trade?.let { return it.at }
  FIELD_KEY_AT.find(m.tradeKey)?.let { return it.groupValues[1].toDouble().toLong() }
  return m.at?.let { it / 1000 }
}

/**
 * THE NEWEST [MAX_LINES] LINES — AND A WATERMARK THAT REMEMBERS WHAT WENT.
 *
 * A busy agent's oldest lines are its fills, and the tape can still hold those
 * trades after the thread has trimmed them: trimmed and forgotten, the next
 * read found them missing and newer than the watermark and put them back at
 * the BOTTOM of the thread as if they had just happened. So the watermark
 * moves past every trade a trim removes. A watermark the tape never set stays
 * unset, so first sight of the tape is still first sight. The same list and
 * watermark come back when there is nothing to trim.
 */
fun capThread(messages: List<ChatLine>, since: Long?): Pair<List<ChatLine>, Long?> {
  val over = messages.size - MAX_LINES
  if (over <= 0) return messages to since
  if (since == null) return messages.drop(over) to null
  var s: Long = since
  for (m in messages.subList(0, over)) {
    val at = tradeAtOf(m)
    if (at != null && at > s) s = at
  }
  return messages.drop(over) to s
}

/**
 * THE OTHER ORDER OF ARRIVAL: the tape showed the fill before the order's
 * poll heard back. The receipt line [id] then takes the fill's key and trade,
 * and the fill's own line goes — one trade, one line, whichever came first.
 * Every fact must agree exactly as when the fill arrives second, and of
 * several that do it takes the one nearest the answer.
 */
fun absorbFill(messages: List<ChatLine>, id: String): List<ChatLine> {
  val at = messages.indexOfFirst { it.id == id }
  if (at < 0) return messages
  val receiptLine = messages[at]
  val life = lifeOf(messages, receiptLine)
  var fillAt = -1
  messages.forEachIndexed { i, m ->
    val trade = m.trade
    if (m.role != "event" || m.order != null || m.tradeKey == null || trade == null || !sameTrade(receiptLine, trade, life)) {
      return@forEachIndexed
    }
    if (fillAt < 0 || gap(life, trade) < gap(life, messages[fillAt].trade!!)) fillAt = i
  }
  if (fillAt < 0) return messages
  val fill = messages[fillAt]
  return messages
    .mapIndexed { i, m -> if (i == at) m.copy(tradeKey = fill.tradeKey, trade = fill.trade) else m }
    .filterIndexed { i, _ -> i != fillAt }
}
