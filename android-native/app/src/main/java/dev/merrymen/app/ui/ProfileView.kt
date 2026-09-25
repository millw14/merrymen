package dev.merrymen.app.ui

import dev.merrymen.app.net.AgentProfile
import dev.merrymen.app.net.ApiResult
import dev.merrymen.app.net.Feed
import dev.merrymen.app.net.GrowthPoint
import dev.merrymen.app.net.HowItTrades
import dev.merrymen.app.net.MerrymenApi
import dev.merrymen.app.net.OwnBook
import dev.merrymen.app.net.ProfileTrade
import dev.merrymen.app.net.agentProfile
import dev.merrymen.app.net.ownSlugOf
import dev.merrymen.app.ui.feed.Beat
import dev.merrymen.app.ui.feed.MINUS
import dev.merrymen.app.ui.feed.PROFILE_EVERY_MS
import dev.merrymen.app.ui.feed.ReadLoop
import dev.merrymen.app.ui.feed.Slot
import dev.merrymen.app.ui.feed.beatsOf
import dev.merrymen.app.ui.feed.countText
import dev.merrymen.app.ui.feed.dealSizeOf
import dev.merrymen.app.ui.feed.holdWords
import dev.merrymen.app.ui.feed.pctBps
import dev.merrymen.app.ui.feed.usd
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.abs

/**
 * WHAT AN AGENT'S PUBLIC PAGE SAYS, decided where a test can run it — the port
 * of `web/src/terminal/profile-view.ts` and the money rules of `swaps.ts`.
 *
 * ONE RULE FOR EVERY DOLLAR ON THE PAGE: dollars show only when the owner
 * published the book, or on the owner's own view (/own answered). The server
 * already withholds a private book's sizes and P&L; every function here that
 * could print a dollar takes [showMoney] and refuses one it was handed anyway,
 * so a stranger's page does not rest on one server line.
 */

// ── how it trades ───────────────────────────────────────────────────────────

/** The rulebooks a page may name (strategy.ts `STRATEGY_IDS`). */
private val STRATEGY_IDS = setOf("steady-basket", "weekend-gap", "even-keel", "dip-hunter", "trencher", "llm-strategist", "custom")

/** Which rulebook the page may SAY the agent runs, or null when it may not say. */
fun strategyOfHow(how: HowItTrades?): String? {
  if (how == null) return null
  val id = if (how.kind == "model") "llm-strategist" else how.name?.takeIf { it in STRATEGY_IDS }
  return id?.takeIf { it != "custom" }
}

/** `strategyName` (strategy.ts). */
fun strategyName(id: String): String = when (id) {
  "steady-basket" -> "Steady basket"
  "weekend-gap" -> "Weekend gap"
  "even-keel" -> "Even keel"
  "dip-hunter" -> "Dip hunter"
  "trencher" -> "Trencher"
  "llm-strategist" -> "Strategist"
  else -> "Its own rules"
}

/**
 * `thesisOfHow` (profile-view.ts): one sentence on the approach, only what each
 * rulebook actually does. Empty when nothing was published — the page then
 * says the agent has not shared its approach, rather than guessing one.
 */
fun thesisOfHow(how: HowItTrades?): String {
  val id = strategyOfHow(how) ?: return ""
  if (how?.kind == "model") {
    return "Reads the market and decides each trade with ${how.model ?: "a language model"}" +
      (how.provider?.let { " via $it" } ?: "") + "."
  }
  return when (id) {
    "steady-basket" -> "Buys a little of a chosen basket on a schedule, rather than all at once."
    "weekend-gap" -> "Buys stock tokens while their market is closed and sells when it reopens."
    "even-keel" -> "Keeps its basket evenly weighted, trimming whatever grows to dominate it."
    "dip-hunter" -> "Waits for a pullback in the names it follows before it buys."
    "trencher" -> "Trades newly launched coins through a risk filter, and leaves the moment one condition breaks."
    else -> ""
  }
}

// ── the chart ───────────────────────────────────────────────────────────────

enum class ChartWindow(val label: String, val sec: Long?, val words: String) {
  DAY("24H", 86_400L, "the last 24 hours"),
  WEEK("7D", 7 * 86_400L, "the last 7 days"),
  MONTH("30D", 30 * 86_400L, "the last 30 days"),
  ALL("ALL", null, "this whole trading period"),
}

sealed interface WindowSlice {
  data class Ok(val values: List<Double>, val from: Long) : WindowSlice

  /** The history does not reach back the whole window. */
  data object Short : WindowSlice

  /** Nothing was read inside the window. */
  data object Empty : WindowSlice

  /** ALL, from a read that was capped — not the whole period. */
  data object Partial : WindowSlice
}

/** The points a chart may use: each with a time and a finite value, oldest first as sent. */
fun growthPointsOf(raw: List<GrowthPoint>?): List<Pair<Long, Double>> =
  raw.orEmpty().mapNotNull { p -> val at = p.at ?: return@mapNotNull null; val g = p.g?.takeIf { it.isFinite() } ?: return@mapNotNull null; at to g }

/**
 * `growthWindow` (profile-view.ts): the index over one window, from the last
 * reading AT OR BEFORE its start — the baseline the change is measured from.
 * A history that does not reach that far is refused, never relabelled: a "24H"
 * drawn over nine hours is a nine-hour change with a day's name on it.
 */
fun growthWindow(points: List<Pair<Long, Double>>, win: ChartWindow, nowSec: Long, complete: Boolean?): WindowSlice {
  val sec = win.sec
  if (sec == null) {
    if (complete == false) return WindowSlice.Partial
    return if (points.size >= 2) WindowSlice.Ok(points.map { it.second }, points[0].first) else WindowSlice.Empty
  }
  val start = nowSec - sec
  var base = -1
  for (i in points.indices) {
    if (points[i].first <= start) base = i else break
  }
  if (base < 0) return WindowSlice.Short
  val inWindow = points.subList(base, points.size)
  return if (inWindow.size >= 2) WindowSlice.Ok(inWindow.map { it.second }, points[base].first) else WindowSlice.Empty
}

/** Whether each window can be offered: not when the history is short, nor ALL over a capped read. */
fun chartWindows(points: List<Pair<Long, Double>>, complete: Boolean?, nowSec: Long): List<Pair<ChartWindow, Boolean>> =
  ChartWindow.entries.map { w ->
    val s = growthWindow(points, w, nowSec, complete)
    w to (s !is WindowSlice.Short && s !is WindowSlice.Partial)
  }

/** ALL whenever the read reached the whole period — the span the headline measures — else the longest it backs. */
fun defaultWindow(points: List<Pair<Long, Double>>, complete: Boolean?, nowSec: Long): ChartWindow {
  val ok = chartWindows(points, complete, nowSec).filter { it.second }.map { it.first }
  return if (ChartWindow.ALL in ok) ChartWindow.ALL else ok.lastOrNull() ?: ChartWindow.ALL
}

// ── the stats line ──────────────────────────────────────────────────────────

/**
 * `statsParts` (profile-view.ts): "12 paper trades · avg hold 3h 20m · Joined
 * Sep 14, 2026". EACH TERM ONLY WHEN IT WAS READ: no round trip is no average
 * hold (never "0s"), an unread join date is left out, a capped count says "+",
 * and "Gasless" appears only when measured on every landed operation — never
 * for a paper book, whose trades cost nobody gas.
 */
fun statsParts(
  tradeCount: Int?,
  tradeCountFloor: Boolean?,
  avgHoldSec: Double?,
  joinedAt: Long?,
  paper: Boolean,
  gasless: Boolean?,
  zone: ZoneId = ZoneId.systemDefault(),
): List<String> {
  val out = ArrayList<String>()
  if (tradeCount != null) {
    val floor = tradeCountFloor == true
    out.add("${countText(tradeCount)}${if (floor) "+" else ""} ${if (paper) "paper " else ""}trade${if (tradeCount == 1 && !floor) "" else "s"}")
  }
  holdWords(avgHoldSec)?.let { out.add("avg hold $it") }
  if (joinedAt != null && joinedAt > 0) {
    out.add("Joined " + DateTimeFormatter.ofPattern("MMM d, yyyy", Locale.US).withZone(zone).format(Instant.ofEpochSecond(joinedAt)))
  }
  if (gasless == true && !paper) out.add("Gasless: every trade sponsored")
  return out
}

// ── money ───────────────────────────────────────────────────────────────────

/**
 * DOLLARS ON THIS PAGE: a published book, or the owner's own view. One rule for
 * every figure on it — TOP TRADES, the fills, the sizes, the gas.
 */
fun showMoneyOf(publicBook: Boolean?, own: OwnBook?): Boolean = publicBook == true || own != null

enum class FigureSign { UP, DOWN }

/** "+12.3%" and, where dollars may be shown, "(+$4.10)". */
data class TradeFigures(val pct: String, val usd: String?, val sign: FigureSign)

private fun signedUsd(d: Double): String = (if (d >= 0) "+" else MINUS) + usd(abs(d))

/**
 * `topTradeFigures` (profile-view.ts): a top trade's return always; its dollars
 * only when the server sent them AND this viewer may see dollars.
 */
fun topTradeFigures(t: ProfileTrade, showMoney: Boolean): TradeFigures {
  val bps = t.realizedPnlBps
  val dollars = t.realizedPnlUsdg?.takeIf { showMoney && it.isFinite() }
  return TradeFigures(pctBps(bps), dollars?.let { signedUsd(it) }, if ((bps ?: 0.0) < 0) FigureSign.DOWN else FigureSign.UP)
}

/**
 * `pnlChip` (swaps.ts): on a SELL only — a buy realizes nothing. Its return
 * when read, its dollars only where dollars may be shown; null when there is
 * nothing read to put on it.
 */
fun pnlChip(t: ProfileTrade, showMoney: Boolean): Pair<String, FigureSign>? {
  if (t.action != "sell") return null
  val bps = t.realizedPnlBps?.takeIf { it.isFinite() }
  val dollars = t.realizedPnlUsdg?.takeIf { showMoney && it.isFinite() }
  val usdText = dollars?.let { signedUsd(it) }
  if (bps == null) return usdText?.let { it to if (dollars < 0) FigureSign.DOWN else FigureSign.UP }
  return (pctBps(bps) + (usdText?.let { " · $it" } ?: "")) to if (bps < 0) FigureSign.DOWN else FigureSign.UP
}

/** `sizeText` (swaps.ts): a size only where dollars may be shown, and never a measured zero. */
fun sizeText(t: ProfileTrade, showMoney: Boolean): String? =
  t.sizeUsdg?.takeIf { showMoney && it.isFinite() && it > 0 }?.let { usd(it) }

/**
 * THE GAS LINE under a live return. "No gas came out of this return" when every
 * landed operation was sponsored (measured). Otherwise the priced gas — its
 * DOLLARS only where dollars may be shown. The web prints the figure on every
 * public page; this is stricter, because a stranger's view of a private book
 * carries no dollar figure at all, and the sentence stays true without it.
 */
fun gasLine(p: AgentProfile, showMoney: Boolean): String? {
  if (p.mode == "paper") return null
  val shown = p.pnlBps ?: return null
  if (!shown.isFinite()) return null
  if (p.gasless == true) return "No gas came out of this return: every trade was sponsored."
  val gas = p.gas ?: return null
  val priced = gas.usdg?.takeIf { it.isFinite() }
  val lead = if (showMoney && priced != null) "Net of ${usd(priced)} in priced gas." else "Net of the gas it paid, where that gas could be priced."
  val unpriced = gas.unpricedTrades?.takeIf { it > 0 }?.let { " $it trades had gas we could not price; this is not the full cost." } ?: ""
  return lead + unpriced
}

// ── the return ──────────────────────────────────────────────────────────────

/** `unrankedLabel` (rank-pnl.ts), as a sentence. */
fun unrankedSentence(why: String?): String = when (why) {
  "paper" -> "Paper trading."
  "inactive" -> "Inactive."
  "no-deposit" -> "No deposit on record."
  "never-filled" -> "Nothing has filled yet."
  "contributions-unevidenced" -> "Deposit history unavailable."
  "quality-unknown" -> "Return unavailable."
  else -> "Return unavailable."
}

/** The headline figure: a paper book's own return, labelled Paper; a live one's ranked return. */
data class ReturnView(val label: String, val bps: Double?, val note: String?)

fun returnOf(p: AgentProfile): ReturnView {
  val paper = p.mode == "paper"
  val bps = (if (paper) p.paperPnlBps else p.pnlBps)?.takeIf { it.isFinite() }
  val note = when {
    bps == null && paper -> "Paper return is unavailable until the recorded balance, holdings and fills can be reconciled."
    bps == null -> unrankedSentence(p.unrankedWhy)
    paper -> "Change in paper equity since the first recorded valuation of this paper period."
    else -> null
  }
  return ReturnView(if (paper) "Paper return" else "Net return on contributed capital", bps, note)
}

/**
 * THE DEEPEST DROP, SAID AS THE FLOOR IT IS. read-agent measures it over the
 * hourly closes of the growth index, so a trough that opened and recovered
 * inside one hour is not in it: the real drop was at least this deep, never
 * "exactly". Only beside a ranked live return — the server sends none for an
 * unranked book, and a paper book's index is not the one it was measured on.
 */
fun drawdownLine(p: AgentProfile): String? {
  if (p.mode == "paper") return null
  if (p.pnlBps?.takeIf { it.isFinite() } == null) return null
  val bps = p.maxDdBps?.takeIf { it.isFinite() && it >= 0 } ?: return null
  if (bps == 0.0) return "No drop from a peak on the hourly closes; a dip that recovered within the hour would not show."
  return "Largest drop from a peak: at least ${pctBps(bps).removePrefix("+")}, measured on hourly closes — a dip that recovered within the hour is not counted."
}

// ── what the page may say about each list ───────────────────────────────────

/**
 * ONE LIST ON THE PAGE, as the read left it. UNREAD IS NOT EMPTY: a list the
 * server could not read, or did not say it read, is "could not be loaded" —
 * never "no closed trades" or "nothing published", which are claims about the
 * agent.
 */
sealed interface ProfileList<out T> {
  data object Unread : ProfileList<Nothing>

  data object Empty : ProfileList<Nothing>

  data class Rows<T>(val rows: List<T>) : ProfileList<T>
}

private fun <T> listRead(rows: List<T>?, read: Boolean): ProfileList<T> = when {
  rows == null || !read -> ProfileList.Unread
  rows.isEmpty() -> ProfileList.Empty
  else -> ProfileList.Rows(rows)
}

/**
 * TOP TRADES: the owner's own read when there is one (it carries the dollars),
 * else the public one. Null when the server sent no list at all — a server
 * from before TOP TRADES — and the section is then not drawn, as the web's is
 * not.
 */
fun topTradesList(p: AgentProfile, own: OwnBook?): ProfileList<ProfileTrade>? {
  own?.topTrades?.let { return listRead(it, true) }
  if (p.topTrades == null && p.topTradesRead == null) return null
  return listRead(p.topTrades, p.topTradesRead == true)
}

/**
 * BUYS & SELLS: the owner's own read, else the public one. A list the server
 * did not send is unread, not "Loading…": the page's read has landed, and
 * nothing more is coming until the next one.
 */
fun fillsList(p: AgentProfile, own: OwnBook?): ProfileList<ProfileTrade> {
  own?.recentTrades?.let { return listRead(it, true) }
  return listRead(p.recentTrades, p.activityRead == true)
}

/** RECENT DECISIONS, from the agent's own thirty days — unread unless the route said it read them. */
fun decisionsList(p: AgentProfile): ProfileList<Beat> = listRead(beatsOf(p.theses), p.thesesRead == true)

// ── whose page this is ──────────────────────────────────────────────────────

/**
 * WHETHER THE WIRE CONTROL IS OFFERED. Not on the reader's own agent: it
 * already reads its own posts, and the server refuses the self-follow (M16).
 * Not while we are still finding out whose agent the reader has, so it never
 * flashes onto their own page and vanishes. Their own agent is the one their
 * feed names ([ownSlugOf], settled by [ownAgentOf]), or the one whose /own the
 * server answered for this session.
 */
fun wireOffered(slug: String, ownKnown: Boolean, ownSlug: String?, own: OwnBook?): Boolean =
  ownKnown && own == null && ownSlug?.equals(slug, ignoreCase = true) != true

/** Whose agent the reader has, as far as this page can tell. */
sealed interface OwnAgent {
  /** Not settled, so the wire control is held back. */
  data object Asking : OwnAgent

  /** Settled: the reader's own slug, or null when they have none. */
  data class Known(val slug: String?) : OwnAgent
}

/**
 * THE READER'S OWN AGENT, from the session and — signed in — their /api/feed.
 *
 * A FEED THAT COULD NOT BE READ SETTLES NOTHING. It used to settle on "no
 * agent" and so offered the wire everywhere, the owner's own page included,
 * because a failed read looked like a reader with none. It stays [OwnAgent.Asking]
 * until a read answers; the control waits rather than guesses. [feed] is only
 * asked for when the session is known and signed in.
 */
suspend fun ownAgentOf(identityKnown: Boolean, signedIn: String?, feed: suspend () -> ApiResult<Feed>): OwnAgent = when {
  // A cold start or a server change: "signed out" is only the default yet.
  !identityKnown -> OwnAgent.Asking
  signedIn == null -> OwnAgent.Known(null)
  else -> when (val r = feed()) {
    is ApiResult.Ok -> OwnAgent.Known(ownSlugOf(r.value))
    else -> OwnAgent.Asking
  }
}

// ── the reads ───────────────────────────────────────────────────────────────

/**
 * THE PAGE'S OWN READ, every 30 seconds while it is on screen (App.tsx). A
 * refresh that fails after a good read leaves the page up and says so.
 */
class ProfileReads(private val api: MerrymenApi, val slug: String, private val now: () -> Long = System::currentTimeMillis) {
  private val _profile = MutableStateFlow(Slot<AgentProfile>())
  val profile: StateFlow<Slot<AgentProfile>> = _profile.asStateFlow()

  val loop = ReadLoop(PROFILE_EVERY_MS) {
    _profile.value = _profile.value.after(api.agentProfile(slug), now())
    _profile.value.fresh
  }
}

/**
 * THE OWNER'S OWN FIGURES, or null — on any failure, and for anyone the server
 * says is not the owner (a 404, the same answer an unknown slug gets). A list
 * the server could not read comes back null rather than empty.
 */
fun ownBookOf(r: ApiResult<OwnBook>): OwnBook? {
  val book = (r as? ApiResult.Ok)?.value ?: return null
  return OwnBook(
    recentTrades = book.recentTrades?.takeIf { book.activityRead == true },
    activityRead = book.activityRead,
    topTrades = book.topTrades?.takeIf { book.topTradesRead == true },
    topTradesRead = book.topTradesRead,
  )
}

// ── the fills ───────────────────────────────────────────────────────────────

enum class SwapTab(val label: String, val empty: String?) {
  ALL("All", null),
  BUYS("Buys", "No buys in this list."),
  SELLS("Sells", "No sells in this list."),
}

/**
 * One fill as the Buys & sells list prints it (swaps.ts, SwapsTable.tsx): a Buy
 * or Sell pill (a muted Swap when nothing recorded which way it went), the coin
 * BY ITS NAME when it has one — a Trencher id is "TA151B4A9E1B" and tells a
 * reader nothing — and the figures this viewer may see.
 */
data class SwapView(
  val id: String,
  val pill: String,
  val sign: FigureSign?,
  val coin: String,
  val size: String?,
  val chip: Pair<String, FigureSign>?,
  val paper: Boolean,
  val at: Long?,
)

fun swapViewOf(t: ProfileTrade, showMoney: Boolean, index: Int = 0): SwapView = SwapView(
  id = t.id ?: "row-$index",
  pill = when (t.action) {
    "buy" -> "Buy"
    "sell" -> "Sell"
    else -> "Swap"
  },
  sign = when (t.action) {
    "buy" -> FigureSign.UP
    "sell" -> FigureSign.DOWN
    else -> null
  },
  coin = t.displayName?.trim()?.takeIf { it.isNotEmpty() } ?: t.symbol ?: "Token label unavailable",
  size = sizeText(t, showMoney),
  chip = pnlChip(t, showMoney),
  paper = t.paper,
  at = t.at,
)

/** The rows one tab shows, newest first. */
fun swapRows(trades: List<ProfileTrade>, tab: SwapTab, showMoney: Boolean): List<SwapView> =
  trades.withIndex()
    .filter { (_, t) -> tab == SwapTab.ALL || t.action == (if (tab == SwapTab.BUYS) "buy" else "sell") }
    .sortedByDescending { it.value.at ?: Long.MIN_VALUE }
    .map { (i, t) -> swapViewOf(t, showMoney, i) }

/** A holding's line: its share of the book, never a second dollar figure. Null share prints no share. */
fun holdingDetail(shareBps: Double?): String? = shareBps?.takeIf { it.isFinite() }?.let {
  val pct = it / 100.0
  (if (pct == Math.rint(pct)) pct.toLong().toString() else String.format(Locale.US, "%.1f", pct)) + "% allocation"
}

/**
 * A decision's size on the agent page — only where dollars may be shown. The
 * publisher already withholds a private book's sizes; the page does not rest
 * on that alone.
 */
fun decisionSize(b: Beat, showMoney: Boolean): Double? =
  if (showMoney) dealSizeOf(b) else null
