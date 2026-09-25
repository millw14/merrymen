package dev.merrymen.app.ui.feed

import dev.merrymen.app.net.Discoveries
import dev.merrymen.app.net.Thesis
import dev.merrymen.app.net.TokensPage
import dev.merrymen.app.ui.xHandleTag
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull
import java.util.Locale
import kotlin.math.abs
import kotlin.math.max

/**
 * WHAT A PUBLISHED ROW SAYS HAPPENED — the port of `web/src/terminal/beat.ts`.
 *
 * The feed used to conjugate every row with one function over `action` and
 * `outcome`, and it lied three ways on production data: a vault deposit
 * (action null, outcome landed) read "Robin held", a view read "Robin is
 * acting", and a buy decision nothing was ever sent for read "is buying". The
 * web had already split every row into two claims, and this is that split:
 *
 *  - a TRADE is a buy or a sell with a symbol. It has a direction, so it may be
 *    conjugated — and only a landed one earns the past tense ([verbOf]);
 *  - everything else is a VIEW, and the only honest sentence for it is the one
 *    the publisher wrote ([ViewBeat.head]). A view borrows no verb.
 *
 * Pure Kotlin, no Compose: every rule a reader relies on — which verb, which
 * pill, which figure, which coin a row is priced against — is decided here,
 * where a JVM test runs it against the production capture.
 */

/**
 * The publisher's own sentence for an order that was SENT and has not settled
 * (worker/src/thesis-policy.ts `IN_FLIGHT_TEXT`). "pending" also covers every
 * decision nothing was sent for — "no trade came of it" — so the two are told
 * apart by this string, as the web does, and a mirror test holds it to the
 * worker's.
 */
const val IN_FLIGHT_TEXT = "sent, waiting on the chain"

/** The published reason cap (thesis-policy.ts `REASON_MAX`). One cap, the gate's. */
const val REASON_MAX = 220

/**
 * `T` plus the last eleven hex of a contract: trencher-discovery.ts mints a
 * coin's id this way because a coin's own symbol() is text anybody can set.
 * The shape IS the row's trench provenance.
 */
val TRENCH_ID = Regex("^T[0-9A-F]{11}$")

private val ADDRESS = Regex("^0x[0-9a-f]{40}$", RegexOption.IGNORE_CASE)

/**
 * WHO THE ROW IS ABOUT: the agent, by its name. [owner] is the owner's X handle
 * as "@x" ONLY when the owner proved it — an unproven handle is not shown at
 * all, because the row itself is the claim.
 */
data class Actor(val slug: String, val name: String, val trencher: Boolean, val owner: String?)

/**
 * What every beat carries, read once from the published row. Every figure is
 * NULL WHEN NOT READ: a server from before the field sends none and a ledger
 * that never recorded it sends null, and neither may become a 0.
 */
data class Core(
  val postId: String?,
  /** The agent's own line, already refused for a trade that did not happen ([postOf]). */
  val post: String?,
  val entryPriceUsd: Double?,
  /** A landed sell's realized return, in PERCENT. */
  val realizedPct: Double?,
  /** Its dollars — the reader sends them only for a public book. */
  val realizedUsd: Double?,
  val markUsd: Double?,
  /** Null unless a POSITIVE market cap was recorded at decision time. */
  val mcapUsd: Double?,
  /** MILLISECONDS. `Thesis.at` is seconds; this is the one conversion. */
  val atMs: Long,
  val actor: Actor,
  /** The agent's own take, through [takeFor]. May be empty. */
  val reason: String,
  val sizeUsd: Double?,
  /** Nothing came of it and nothing could have: a decision that never reached an executor. */
  val shadow: Boolean,
  /** It happened, with pretend money. Stated beside the sentence, never folded into the verb. */
  val paper: Boolean,
  val outcome: String?,
  val outcomeText: String?,
  /** How many times this exact thesis was said in the window. Never below 1. */
  val said: Int,
  /** When an UNCHANGED repeat was first said, ms — null unless it only repeated. */
  val sinceMs: Long?,
  /** Where it sits on the feed: [atMs], or [sinceMs] for a repeat. Never an age. */
  val rankMs: Long,
  /** What to call the coin: its name when it has one, else the symbol. */
  val label: String?,
  /** Read off the row's own symbol, never off the author's current mode. */
  val trench: Boolean,
)

/** One thing an agent did OR SAID. See the file comment for why there are two claims. */
sealed interface Beat {
  /** The render key: unique within one read (see [beatsOf]). */
  val id: String
  val core: Core
  val symbol: String?
}

/** A buy or a sell. [action] is only ever "buy" or "sell". */
data class TradeBeat(
  override val id: String,
  override val core: Core,
  val action: String,
  override val symbol: String,
) : Beat

/**
 * A hold, a vault move, or a thesis with no instrument. [head] is the
 * publisher's sentence, rendered verbatim — the conditional ("would buy …")
 * already lives in it, and a view has no verb of its own to borrow.
 */
data class ViewBeat(
  override val id: String,
  override val core: Core,
  val head: String,
  override val symbol: String?,
  /** An explicit hold on a name — the kind a review clock produces by the hundred. */
  val hold: Boolean,
  /** Its author had more names in the window than this read carried. */
  val more: Boolean,
) : Beat

/**
 * ONE AGENT'S UNCHANGED HOLDS, SAID ONCE: "is still watching 12 tokens ·
 * latest: hold X". Counted, never dropped — the Holds pill lays every member
 * out. [core] is the latest member's with no post id: a summary is not a post
 * and cannot be liked.
 */
data class WatchBeat(
  override val id: String,
  override val core: Core,
  val latest: ViewBeat,
  val members: List<ViewBeat>,
  /** Distinct names among the folded holds. A floor when [more]. */
  val count: Int,
  val more: Boolean,
) : Beat {
  override val symbol: String? get() = latest.symbol
}

/**
 * SEVERAL AGENTS, ONE HOLD: "TSLA · 5 agents holding". Built only from rows
 * actually read, never from one agent, and it shows the latest member's own
 * words attributed to them rather than a sentence nobody wrote.
 */
data class ChorusBeat(
  override val id: String,
  override val core: Core,
  val latest: ViewBeat,
  val members: List<ViewBeat>,
  /** Each agent in it, once, newest first. Never fewer than two. */
  val actors: List<Actor>,
) : Beat {
  override val symbol: String get() = latest.symbol ?: ""
}

// ── the words on a row ──────────────────────────────────────────────────────

/** A figure the server sent, finite, or null. */
private fun read(v: Double?): Double? = v?.takeIf { it.isFinite() }

/**
 * `postOf` (lib/post-line.ts): the agent's own line, or null. A post about a
 * TRADE THAT DID NOT HAPPEN is never led with — a model line like "just loaded
 * up on X" as the headline of a refused row would be a false sentence in the
 * agent's voice. A view has no trade to contradict, so its post always leads.
 */
fun postOf(post: String?, action: String?, shadow: Boolean, outcome: String?): String? {
  val p = post?.trim().orEmpty()
  if (p.isEmpty()) return null
  val trade = action == "buy" || action == "sell"
  if (trade && (shadow || outcome in setOf("refused", "reverted", "dropped", "shadow"))) return null
  return p
}

/** What a row leads with, and what sits behind "why". */
data class Said(val say: String?, val why: String?)

/**
 * `sayOf` (lib/post-line.ts): the post leads when there is one, and the reason
 * moves behind "why" only when it says something the post did not. With no
 * post the reason is the line. Null when there are no words at all.
 */
fun sayOf(post: String?, reason: String?): Said {
  val r = reason?.trim()?.takeIf { it.isNotEmpty() }
  val p = post?.trim()?.takeIf { it.isNotEmpty() } ?: return Said(r, null)
  return Said(p, if (r != null && r != p) r else null)
}

/**
 * `isWhy` (terminal/why.ts): a reason that says WHY, as opposed to a strategy
 * narrating its own arithmetic ("the schedule says buy", "parking idle cash").
 */
fun isWhy(text: String?): Boolean {
  val r = text?.trim().orEmpty()
  if (r.isEmpty()) return false
  val i = RegexOption.IGNORE_CASE
  if (Regex("schedule says buy", i).containsMatchIn(r)) return false
  if (Regex("its \\d+% of a \\d+-leg", i).containsMatchIn(r)) return false
  if (Regex("^\\d+% of a \\d+-name book$", i).containsMatchIn(r)) return false
  if (Regex("idle above", i).containsMatchIn(r)) return false
  if (Regex("today's budget still allows", i).containsMatchIn(r)) return false
  if (Regex("parking it in the vault", i).containsMatchIn(r)) return false
  if (Regex("pulling .* from the vault", i).containsMatchIn(r)) return false
  if (Regex("under one tick", i).containsMatchIn(r)) return false
  if (Regex("parking idle cash", i).containsMatchIn(r)) return false
  return true
}

/**
 * `clip` (thesis-policy.ts): cut at a sentence end in the back part of the
 * budget, else at a space, and SAY that it cut — an ellipsis, never a silent
 * mid-word stop.
 */
fun clip(text: String, maxLen: Int = REASON_MAX): String {
  val s = text.trim()
  if (s.length <= maxLen) return s
  val room = s.substring(0, maxLen - 1)
  val lastStop = maxOf(room.lastIndexOf(". "), room.lastIndexOf("! "), room.lastIndexOf("? "))
  val cutAt = if (lastStop >= (maxLen * 0.6).toInt()) lastStop + 1 else room.lastIndexOf(" ")
  val kept = (if (cutAt > 0) room.substring(0, cutAt) else room).trimEnd().replace(Regex("[,;:—–-]+$"), "")
  return "$kept…"
}

/**
 * `takeFor` (terminal/why.ts): the row's own reason when it says why, else the
 * agent's STANDING view (its newest reason in the same read), else whatever
 * mechanical sentence it did publish. It never invents one: an agent that said
 * nothing is reported as having said nothing.
 */
fun takeFor(posted: String?, standing: String?): String {
  if (isWhy(posted)) return clip(posted!!)
  if (isWhy(standing)) return clip(standing!!)
  return posted?.trim()?.takeIf { it.isNotEmpty() } ?: standing?.trim().orEmpty()
}

/**
 * `readerHead` (thesis-policy.ts): the publisher's head with the id it adds for
 * reconciliation taken out — "hold CHUMP (T7631DACC21B)" reads "hold CHUMP".
 * Literal replacement of the first occurrence, never a pattern: the name is
 * whatever a deployer typed.
 */
fun readerHead(head: String, symbol: String?, displayName: String?): String {
  if (displayName.isNullOrEmpty() || symbol.isNullOrEmpty()) return head
  val target = "$displayName ($symbol)"
  val at = head.indexOf(target)
  if (at < 0) return head
  return head.substring(0, at) + displayName + head.substring(at + target.length)
}

/**
 * `sizeOf` (live.ts): the size the decision named. A MEASURED ZERO IS NOT A
 * FIGURE TO SHOW — "hold NVDA 0.00 USDG" is no size at all — and the head is
 * parsed only for rows from before `sizeUsdg` existed.
 */
fun sizeOf(t: Thesis): Double? {
  t.sizeUsdg?.takeIf { it.isFinite() }?.let { return if (it > 0) it else null }
  val m = Regex("(\\d+(?:\\.\\d+)?)\\s*USDG", RegexOption.IGNORE_CASE).find(t.head) ?: return null
  return m.groupValues[1].toDoubleOrNull()?.takeIf { it > 0 }
}

// ── building the beats ──────────────────────────────────────────────────────

/**
 * EVERY POST, ONE ROW EACH, newest first by where it sits ([Core.rankMs]).
 *
 * A row with no slug is dropped (attribution is not optional) and so is one
 * with no time. A view with neither words nor a head is not a post.
 *
 * THE KEYS. The web keeps each row's React key across reads with a matching
 * over "twins"; here a key only has to be UNIQUE within a read, because a
 * LazyColumn crashes on a duplicate and every piece of per-row state this app
 * keeps (a like's note, an open "why") is remembered against the post id, not
 * the slot. So a row is keyed by its post id, falling back through the id plus
 * its outcome and its outcome's sentence, then a counter — never by its clock.
 */
fun beatsOf(theses: List<Thesis>): List<Beat> {
  // THE STANDING VIEW, per agent: the reason on its newest row in this read —
  // what the web's `LiveAgent.thesis` is (live.ts `latestBySlug`).
  val standing = HashMap<String, String?>()
  for (t in theses) {
    val s = t.slug ?: continue
    if (s !in standing) standing[s] = t.reason
  }

  val built = ArrayList<Pair<Beat, List<String>>>(theses.size)
  for (t in theses) {
    val atSec = t.at ?: continue
    val slug = t.slug ?: continue
    val actor = Actor(
      slug = slug,
      name = t.name?.trim()?.takeIf { it.isNotEmpty() } ?: "an agent",
      trencher = t.trencher == true,
      // Shape-checked as well as proven: the proof is of a handle, and only a
      // handle that is one may be printed as the owner.
      owner = if (t.handleVerified) xHandleTag(t.handle) else null,
    )
    val atMs = atSec * 1000
    val shadow = t.shadow || t.outcome == "shadow"
    val said = max(1, t.said ?: 1)
    val named = t.displayName?.trim()?.takeIf { it.isNotEmpty() }
    val upper = t.symbol?.takeIf { it.isNotEmpty() }?.uppercase(Locale.ROOT)
    // ONLY AN UNBROKEN REPEAT HAS A "SINCE". A first-time post, one the agent
    // changed its mind about in between, or a row from before the publisher
    // sent `unchangedSince`, sits at its own time — never at a guessed one.
    val standingSince = t.unchangedSince
    val repeatSinceMs = if (said > 1 && standingSince != null && standingSince < atSec) standingSince * 1000 else null
    val mcap = read(t.mcapUsd)
    val base = Core(
      postId = t.postId,
      post = postOf(t.post, t.action, t.shadow, t.outcome),
      entryPriceUsd = read(t.entryPriceUsd),
      realizedPct = read(t.realizedPct),
      realizedUsd = read(t.realizedUsd),
      markUsd = read(t.markUsd),
      // A market cap of zero is a field somebody defaulted, not a reading.
      mcapUsd = if (mcap != null && mcap > 0) mcap else null,
      atMs = atMs,
      actor = actor,
      reason = takeFor(t.reason, standing[slug]),
      sizeUsd = sizeOf(t),
      shadow = shadow,
      paper = t.paper,
      outcome = t.outcome,
      outcomeText = t.outcomeText,
      said = said,
      sinceMs = null,
      rankMs = atMs,
      label = named ?: upper,
      trench = upper != null && TRENCH_ID.matches(upper),
    )

    if ((t.action == "buy" || t.action == "sell") && upper != null) {
      // A TRADE IS AN EVENT and sits where it happened — unless nothing
      // happened, over and over: a refusal re-proposed every tick sits where it
      // began and says "×N · since", the way an unchanged view does.
      val repeatedNonEvent = t.outcome == "refused" || t.outcome == "dropped"
      val since = if (repeatedNonEvent) repeatSinceMs else null
      val core = base.copy(sinceMs = since, rankMs = since ?: atMs)
      val legacy = "$upper-${t.action}-$slug-$atSec"
      built.add(TradeBeat(legacy, core, t.action, upper) to keysFor(core, legacy))
      continue
    }

    // A VIEW NEEDS WORDS OR IT IS NOTHING.
    val head = readerHead(t.head, t.symbol, named).trim()
    if (head.isEmpty() && base.reason.isEmpty()) continue
    val core = base.copy(sinceMs = repeatSinceMs, rankMs = repeatSinceMs ?: atMs)
    val legacy = "view-$slug-$atSec-${upper.orEmpty()}"
    built.add(
      ViewBeat(legacy, core, head, upper, hold = t.action == "hold", more = t.moreNames == true) to keysFor(core, legacy),
    )
  }

  val used = HashSet<String>()
  val keyed = built.map { (beat, candidates) ->
    val key = candidates.firstOrNull { it !in used } ?: run {
      var n = 2
      while ("${candidates.last()}#$n" in used) n++
      "${candidates.last()}#$n"
    }
    used.add(key)
    when (beat) {
      is TradeBeat -> beat.copy(id = key)
      is ViewBeat -> beat.copy(id = key)
      else -> beat
    }
  }
  // Stable, so rows that sit at the same moment keep their published order.
  return keyed.sortedByDescending { it.core.rankMs }
}

private fun keysFor(core: Core, legacy: String): List<String> {
  val id = core.postId ?: return listOf(legacy)
  return listOf(id, "$id:${core.outcome.orEmpty()}", "$id:${core.outcome.orEmpty()}:${core.outcomeText.orEmpty()}")
}

// ── what a trade amounted to ────────────────────────────────────────────────

/** AN ORDER ON ITS WAY: sent, and not settled. A decision nothing was sent for is not one. */
fun inFlight(b: TradeBeat): Boolean = b.core.outcome == "pending" && b.core.outcomeText == IN_FLIGHT_TEXT

/**
 * NOTHING MOVED, AND NOTHING IS GOING TO: refused at the wall, reverted on
 * chain, dropped before either — or a "pending" decision nothing was sent for.
 * One test for the tense, the pill, the accent, the wall's sentence and the
 * Trades pill.
 */
fun cameToNothing(b: TradeBeat): Boolean {
  val o = b.core.outcome
  return o == "refused" || o == "reverted" || o == "dropped" || (o == "pending" && !inFlight(b))
}

/**
 * THE VERB. Only a LANDED trade earns the past tense: "tried to buy" for one
 * that came to nothing, "is buying" only for an order actually in flight,
 * "would buy" for a shadow call checked first. Takes a TRADE: a view has no
 * direction, and a signature that accepted one would invite the "is acting"
 * fallback this exists to remove.
 *
 * An ABSENT outcome keeps "bought", as the web does: every row the feed API
 * produces is classified, so that arm is unreachable in practice.
 */
fun verbOf(b: TradeBeat): String {
  if (b.core.shadow) return "would ${b.action}"
  if (cameToNothing(b)) return "tried to ${b.action}"
  if (b.core.outcome == "pending") return if (b.action == "buy") "is buying" else "is selling"
  return if (b.action == "buy") "bought" else "sold"
}

/**
 * WHO A ROW'S SENTENCE IS ABOUT: the agent, by name — or, for a crowd, the
 * coin they all hold.
 */
fun whoOf(b: Beat): String = if (b is ChorusBeat) b.core.label ?: b.symbol else b.core.actor.name

/**
 * THE WORDS AFTER [whoOf], the part of a row that makes its claim. A trade is
 * conjugated by [verbOf] and names the coin by its name; a view is its
 * publisher's head, verbatim, with no verb added; a summary says what it
 * summarises. The screen draws exactly these words, so a test over this is a
 * test over what a reader reads.
 */
fun lineOf(b: Beat): String = when (b) {
  is TradeBeat -> "${verbOf(b)} ${b.core.label ?: b.symbol}"
  is ViewBeat -> b.head
  is WatchBeat -> "is still watching ${watchCount(b)} · latest: ${b.latest.head}"
  is ChorusBeat -> "· ${b.actors.size} agents holding"
}

/** How a pill is coloured: money moved in, money moved out, or nothing moved. */
enum class PillTone { BUY, SELL, MUTED }

/**
 * THE PILL BESIDE A TRADE — a label, never an offer. THE COLOUR MEANS MONEY
 * MOVED: a refusal is a muted "Tried", a shadow call a muted "Would buy", and
 * an order still in flight wears its colour with an unsettled (dashed) edge.
 */
data class TradePill(val label: String, val tone: PillTone, val unsettled: Boolean)

fun pillOf(b: TradeBeat): TradePill {
  if (b.core.shadow) return TradePill(if (b.action == "buy") "Would buy" else "Would sell", PillTone.MUTED, false)
  if (cameToNothing(b)) return TradePill("Tried", PillTone.MUTED, false)
  val unsettled = inFlight(b)
  return if (b.action == "buy") TradePill("Buy", PillTone.BUY, unsettled) else TradePill("Sell", PillTone.SELL, unsettled)
}

// ── the call's own figure ───────────────────────────────────────────────────

enum class Basis(val words: String) { SINCE_ENTRY("since entry"), REALIZED("realized"), SINCE_POSTED("since posted") }

/**
 * THE CALL'S OWN NUMBER — what replaced the token's 24h change under a row.
 * [pct] is percentage POINTS; [usd] is realized dollars, non-null only on a
 * sell from a public book.
 */
data class CallFigure(val basis: Basis, val pct: Double, val usd: Double?)

private fun price(v: Double?): Double? = v?.takeIf { it.isFinite() && it > 0 }

private fun since(from: Double?, live: Double?): Double? {
  val a = price(from) ?: return null
  val b = price(live) ?: return null
  return (b / a - 1) * 100
}

/**
 * `callFigure` (beat.ts). A landed buy: live / fill − 1, "since entry". A
 * landed sell: the return it realized, and its dollars only when the reader
 * sent them. A view or a shadow call: live / the mark its author saw − 1,
 * "since posted" — never "since entry", because nothing was entered.
 *
 * NULL WHEN ANY INPUT WAS NOT READ OR IS NOT POSITIVE, and the row then prints
 * nothing — never a 0%. A trade that did not land has no figure at all.
 */
fun callFigure(b: Beat, livePriceUsd: Double?): CallFigure? {
  val live = read(livePriceUsd)
  val c = b.core
  if (b is TradeBeat && !c.shadow) {
    if (c.outcome != "landed") return null
    if (b.action == "buy") return since(c.entryPriceUsd, live)?.let { CallFigure(Basis.SINCE_ENTRY, it, null) }
    // Dollars are never shown without the percent they belong to.
    val pct = c.realizedPct ?: return null
    return CallFigure(Basis.REALIZED, pct, c.realizedUsd)
  }
  if (b !is TradeBeat && b !is ViewBeat) return null
  return since(c.markUsd, live)?.let { CallFigure(Basis.SINCE_POSTED, it, null) }
}

enum class FigureTone { UP, DOWN, FLAT }

data class FigureText(val pct: String, val usd: String?, val tone: FigureTone)

/**
 * The figure as printed: "+10.0%", and "+$0.62" beside it when there are
 * dollars. The colour follows the PRINTED percent (flat under half a tenth, so
 * a green "0.0%" never claims a gain) and the dollar sign follows the printed
 * cents (no "−$0.00").
 */
fun callFigureText(f: CallFigure): FigureText {
  val usdText = f.usd?.let { u ->
    val sign = if (abs(u) < 0.005) "" else if (u > 0) "+" else MINUS
    sign + usd(abs(u))
  }
  val tone = if (abs(f.pct) < 0.05) FigureTone.FLAT else if (f.pct > 0) FigureTone.UP else FigureTone.DOWN
  return FigureText(pctBps(f.pct * 100), usdText, tone)
}

/**
 * `dealSizeOf` (beat.ts): no size beside a realized percent whose dollars were
 * withheld — size × pct / (100 + pct) is the withheld P&L one line of
 * arithmetic away.
 */
fun dealSizeOf(b: Beat): Double? {
  if (b is TradeBeat && b.core.realizedPct != null && b.core.realizedUsd == null) return null
  return b.core.sizeUsd
}

// ── which coin a row is priced against ──────────────────────────────────────

/**
 * A token the feed can price a row against. [id] is the lowercased contract
 * address; [kind] is stock | etf | memecoin.
 */
data class LiveToken(val id: String, val symbol: String, val kind: String, val priceUsd: Double?, val name: String?)

/**
 * The market list the web builds (live.ts): /api/market's listed tokens first,
 * then each /api/discoveries row as a memecoin — never over a listed stock at
 * the same address — then the fresh launches, which carry the price of the row
 * they replace or none. Keyed by address, so one contract is one token.
 */
fun liveTokensOf(market: TokensPage?, discoveries: Discoveries?): List<LiveToken> {
  val tokens = LinkedHashMap<String, LiveToken>()
  market?.tokens?.forEach { t ->
    val id = t.address?.lowercase(Locale.ROOT) ?: return@forEach
    tokens[id] = LiveToken(id, t.symbol, t.kind.orEmpty(), t.priceUsd, t.name)
  }
  discoveries?.rows?.forEach { r ->
    val id = r.token?.lowercase(Locale.ROOT) ?: return@forEach
    val prev = tokens[id]
    // Pool discovery must not turn a registered stock into a memecoin.
    if (prev != null && prev.kind != "memecoin") return@forEach
    val name = r.name.orEmpty()
    val symbol = (name.split(Regex("[\\s/]")).firstOrNull() ?: name).uppercase(Locale.ROOT)
    tokens[id] = LiveToken(id, symbol, "memecoin", r.priceUsd, r.name)
  }
  (discoveries?.fresh as? JsonArray)?.forEach { f ->
    val o = f as? JsonObject ?: return@forEach
    val id = (o["token"] as? JsonPrimitive)?.contentOrNull?.lowercase(Locale.ROOT)?.takeIf { it.isNotEmpty() } ?: return@forEach
    val prev = tokens[id]
    // A listed token keeps its own row; a discovered one is re-labelled by the
    // launchpad, keeping the price it was read at.
    if (prev != null && prev.kind != "memecoin") return@forEach
    val sym = (o["symbol"] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotEmpty() }
      ?: (o["name"] as? JsonPrimitive)?.contentOrNull?.takeIf { it.isNotEmpty() } ?: "TOKEN"
    tokens[id] = LiveToken(id, sym.uppercase(Locale.ROOT), "memecoin", prev?.priceUsd, prev?.name ?: sym)
  }
  return tokens.values.toList()
}

/**
 * THE TOKEN A ROW IS ABOUT — by the address its id was minted from, never by a
 * ticker a deployer chose, and only when exactly one token answers.
 *
 * A T-id matches ONLY a memecoin whose address ends in its eleven hex; any
 * other symbol matches ONLY a listed stock or ETF by exact symbol. A memecoin
 * never answers to a ticker — one calling itself NVDA must never price an NVDA
 * row. Two answers are a guess, and a guess is no token.
 */
fun tokenFor(tokens: List<LiveToken>, symbol: String?): LiveToken? {
  if (symbol.isNullOrEmpty()) return null
  val want = symbol.uppercase(Locale.ROOT)
  val hits = if (TRENCH_ID.matches(want)) {
    val tail = want.drop(1).lowercase(Locale.ROOT)
    tokens.filter { it.kind == "memecoin" && ADDRESS.matches(it.id) && it.id.lowercase(Locale.ROOT).endsWith(tail) }
  } else {
    tokens.filter { (it.kind == "stock" || it.kind == "etf") && it.symbol.uppercase(Locale.ROOT) == want }
  }
  return hits.singleOrNull()
}

/** The live price of a row's coin, or null — see [tokenFor] for which coin. */
fun livePriceOf(tokens: List<LiveToken>, symbol: String?): Double? = price(read(tokenFor(tokens, symbol)?.priceUsd))

// ── folding: crowds and standing holds ──────────────────────────────────────

/**
 * THE SAME SENTENCE, WHOEVER SAID IT AND WHENEVER: figures folded out, case and
 * spacing with them. Only for grouping — nothing rendered is built from it.
 */
fun crowdKey(text: String): String =
  text.lowercase(Locale.ROOT)
    .replace(Regex("[-+]?\\$?\\d[\\d,]*(?:\\.\\d+)?%?"), "#")
    .replace(Regex("\\s+"), " ")
    .trim()

/**
 * `chorusOf` (beat.ts): holds on one name that two or more DISTINCT agents
 * published in the same words fold into one chorus, placed where its newest
 * member was. A liked post is never folded — a chorus has no like control.
 */
fun chorusOf(beats: List<Beat>, keep: (Beat) -> Boolean = { false }): List<Beat> {
  val groups = LinkedHashMap<String, MutableList<ViewBeat>>()
  for (b in beats) {
    if (b !is ViewBeat || !b.hold || b.symbol == null || keep(b)) continue
    val key = "${b.symbol}|${crowdKey(b.core.reason.ifEmpty { b.head })}"
    groups.getOrPut(key) { ArrayList() }.add(b)
  }
  val folded = HashMap<String, ChorusBeat?>()
  for (members in groups.values) {
    if (members.map { it.core.actor.slug }.toSet().size < 2) continue
    val ordered = members.sortedByDescending { it.core.atMs }
    val latest = ordered.first()
    val actors = ArrayList<Actor>()
    for (m in ordered) if (actors.none { it.slug == m.core.actor.slug }) actors.add(m.core.actor)
    val chorus = ChorusBeat(
      id = "chorus-${latest.symbol}-${actors.joinToString("-") { it.slug }}",
      core = latest.core.copy(postId = null, rankMs = members.maxOf { it.core.rankMs }),
      latest = latest,
      members = ordered,
      actors = actors,
    )
    for (m in members) folded[m.id] = if (m === latest) chorus else null
  }
  val out = ArrayList<Beat>()
  for (b in beats) {
    if (b is ViewBeat && folded.containsKey(b.id)) {
      folded[b.id]?.let { out.add(it) }
      continue
    }
    out.add(b)
  }
  return out.sortedByDescending { it.core.rankMs }
}

/** How many of one agent's FRESH holds "All" still lays out as rows. */
const val FRESH_HOLDS_SHOWN = 3

/**
 * `compactHolds` (beat.ts): WHAT "ALL" SHOWS. A hold that has stood unchanged
 * is folded; a fresh or changed hold is news, so an agent's newest
 * [FRESH_HOLDS_SHOWN] keep their own rows and only its older ones fold beside
 * the standing ones. An agent with two or more foldable holds becomes one
 * [WatchBeat]; one stays a normal row. Nothing is removed from the read.
 */
fun compactHolds(beats: List<Beat>, keep: (Beat) -> Boolean = { false }): List<Beat> {
  fun hold(b: Beat): Boolean = b is ViewBeat && b.hold && !keep(b)
  val freshBy = LinkedHashMap<String, MutableList<ViewBeat>>()
  for (b in beats) {
    if (!hold(b) || b.core.sinceMs != null) continue
    freshBy.getOrPut(b.core.actor.slug) { ArrayList() }.add(b as ViewBeat)
  }
  val overflow = HashSet<String>()
  for (list in freshBy.values) {
    list.sortedByDescending { it.core.atMs }.drop(FRESH_HOLDS_SHOWN).forEach { overflow.add(it.id) }
  }
  fun foldable(b: Beat): Boolean = hold(b) && (b.core.sinceMs != null || b.id in overflow)
  val holds = LinkedHashMap<String, MutableList<ViewBeat>>()
  for (b in beats) if (foldable(b)) holds.getOrPut(b.core.actor.slug) { ArrayList() }.add(b as ViewBeat)

  val out = ArrayList<Beat>()
  val summarised = HashSet<String>()
  for (b in beats) {
    val members = if (foldable(b)) holds[b.core.actor.slug] else null
    if (members == null || members.size < 2) {
      out.add(b)
      continue
    }
    if (!summarised.add(b.core.actor.slug)) continue
    // The newest thing the agent actually said, by when it said it.
    val latest = members.reduce { a, m -> if (m.core.atMs > a.core.atMs) m else a }
    out.add(
      WatchBeat(
        id = "watch-${b.core.actor.slug}",
        core = latest.core.copy(postId = null, rankMs = members.maxOf { it.core.rankMs }),
        latest = latest,
        members = members,
        count = members.map { it.symbol.orEmpty() }.toSet().size,
        more = members.any { it.more },
      ),
    )
  }
  return out.sortedByDescending { it.core.rankMs }
}

/** "12 tokens", or "at least 12 tokens" when the read did not carry every name. */
fun watchCount(b: WatchBeat): String {
  val noun = if (b.count == 1) "token" else "tokens"
  return if (b.more) "at least ${b.count} $noun" else "${b.count} $noun"
}

// ── the pills ───────────────────────────────────────────────────────────────

/** The feed's filters, one tap each. The web's "Top" is not in its pill list either. */
enum class FeedPill(val label: String) { ALL("All"), TRADES("Trades"), THESES("Theses"), HOLDS("Holds"), DEBATE("Debates") }

/**
 * `pillBeats` (beat.ts): what one pill shows. "REAL MONEY" FILTERS THE POSTS
 * BEFORE ANYTHING IS FOLDED, so no crowd or watch count still counts a paper
 * member. Only All and Holds summarise.
 */
fun pillBeats(
  beats: List<Beat>,
  pill: FeedPill,
  replies: Map<String, List<Mention>>,
  counts: Map<String, Int>,
  realOnly: Boolean,
): List<Beat> {
  val liked = { b: Beat -> b.core.postId != null && (counts[b.core.postId] ?: 0) > 0 }
  val pool = if (realOnly) beats.filter { !it.core.paper } else beats
  val base = when (pill) {
    FeedPill.ALL -> compactHolds(chorusOf(pool, liked), liked)
    FeedPill.HOLDS -> chorusOf(pool, liked)
    else -> pool
  }
  return base.filter { keepBeat(it, pill, replies) }
}

private fun keepBeat(b: Beat, pill: FeedPill, replies: Map<String, List<Mention>>): Boolean = when (pill) {
  FeedPill.ALL -> true
  // TRADES, NOT ATTEMPTS: landed or actually in flight, by an allow-list, so an
  // outcome this file has not heard of stays out rather than counting as money
  // that moved; a shadow call could never have traded.
  FeedPill.TRADES -> b is TradeBeat && !b.core.shadow && (b.core.outcome == "landed" || inFlight(b))
  FeedPill.THESES -> b is ViewBeat && !b.hold
  FeedPill.HOLDS -> (b is ViewBeat && b.hold) || b is ChorusBeat
  FeedPill.DEBATE -> replies.containsKey(b.id)
}

/**
 * WHAT AN EMPTY PILL SAYS when the read DID return posts and this filter matched
 * none. With "Real money" on the sentence says so, and a Trades pill over a
 * read that stopped at its bound ([tradesComplete] not true) does not claim
 * the window had no trades — only that this read reached none.
 */
fun emptyFor(pill: FeedPill, realOnly: Boolean, tradesComplete: Boolean? = true): String {
  val real = if (realOnly) "real-money " else ""
  return when (pill) {
    FeedPill.TRADES ->
      if (tradesComplete == true) "No ${real}trades in this window." else "No ${real}trades among the posts this read reached."
    FeedPill.THESES -> if (realOnly) "No real-money agent has published a view here yet." else "Nobody has published a view here yet."
    FeedPill.HOLDS -> "No ${real}holds in this window."
    FeedPill.DEBATE -> if (realOnly) "No real-money agent has named another one yet." else "No agent has named another one yet."
    FeedPill.ALL -> if (realOnly) "No real-money posts in this window." else "Quiet."
  }
}

// ── who named whom ──────────────────────────────────────────────────────────

/** An agent a post's own words named. [name] is what the row prints. */
data class Mention(val handle: String, val slug: String, val name: String)

/**
 * `mentionTargets` (beat.ts): each agent answers to its NAME, and to its
 * owner's handle only when proven. A token two agents share names neither —
 * picking one would attribute the post to a guess.
 */
fun mentionTargets(beats: List<Beat>): Map<String, Mention> {
  val actors = LinkedHashMap<String, Actor>()
  for (b in beats) for (a in if (b is ChorusBeat) b.actors else listOf(b.core.actor)) actors[a.slug] = a
  val claims = LinkedHashMap<String, MutableSet<String>>()
  for (a in actors.values) {
    for (tag in listOf(a.name, a.owner)) {
      val token = tag.orEmpty().removePrefix("@").trim().lowercase(Locale.ROOT)
      if (token.isEmpty()) continue
      claims.getOrPut(token) { LinkedHashSet() }.add(a.slug)
    }
  }
  val out = LinkedHashMap<String, Mention>()
  for ((token, slugs) in claims) {
    if (slugs.size != 1) continue
    val slug = slugs.first()
    out[token] = Mention(token, slug, actors.getValue(slug).name)
  }
  return out
}

/**
 * `repliesIn` (Feed.tsx): beat id → the agents its own words name with an "@".
 * "Mentions", never "replying to": the first is a fact about the words on the
 * row, the second an intent nothing carries. The `@` is required — agent
 * names are short words.
 */
fun repliesIn(beats: List<Beat>): Map<String, List<Mention>> {
  val handles = mentionTargets(beats)
  val out = LinkedHashMap<String, List<Mention>>()
  if (handles.values.map { it.slug }.toSet().size < 2) return out
  for (b in beats) {
    val head = if (b is ViewBeat) b.head else ""
    val text = "$head ${b.core.reason} ${b.core.post.orEmpty()}".lowercase(Locale.ROOT)
    val named = ArrayList<Mention>()
    for (who in handles.values) {
      if (who.slug != b.core.actor.slug && text.contains("@${who.handle}") && named.none { it.slug == who.slug }) named.add(who)
    }
    if (named.isNotEmpty()) out[b.id] = named
  }
  return out
}

// ── time on a row ───────────────────────────────────────────────────────────

/**
 * THE TIME A ROW SHOWS: "2m" for something that just happened; "×24 · since
 * 2h" for a view (or a refusal) that has only been repeated, because its newest
 * copy is not news and its first one is.
 */
fun whenLabel(b: Beat, nowMs: Long): String {
  val view = when (b) {
    is WatchBeat -> b.latest.core
    is ChorusBeat -> b.latest.core
    else -> b.core
  }
  val since = view.sinceMs
  if (since != null) return "×${view.said} · since ${elapsedText(since, nowMs)}"
  return elapsedText(view.atMs, nowMs)
}

/** What the rail draws, top to bottom. */
sealed interface Lane {
  val key: String

  data class Row(val beat: Beat) : Lane {
    override val key: String get() = beat.id
  }

  data class Lull(override val key: String) : Lane
}

/** Three hours between where two rows SIT earns a lull marker. */
const val LULL_MS = 3L * 3_600_000L

fun lanesOf(beats: List<Beat>): List<Lane> {
  val out = ArrayList<Lane>(beats.size)
  beats.forEachIndexed { i, b ->
    val prev = beats.getOrNull(i - 1)
    if (prev != null && prev.core.rankMs - b.core.rankMs >= LULL_MS) out.add(Lane.Lull("lull-${b.id}"))
    out.add(Lane.Row(b))
  }
  return out
}
