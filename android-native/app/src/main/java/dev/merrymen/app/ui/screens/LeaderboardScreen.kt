package dev.merrymen.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.produceState
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.navigation.NavHostController
import dev.merrymen.app.LocalContainer
import dev.merrymen.app.data.Loaded
import dev.merrymen.app.net.LeaderRow
import dev.merrymen.app.net.Leaderboard
import dev.merrymen.app.net.MerrymenApi
import dev.merrymen.app.net.ownSlugOf
import dev.merrymen.app.net.valueOrNull
import dev.merrymen.app.ui.AgentFace
import dev.merrymen.app.ui.Empty
import dev.merrymen.app.ui.EmptyKind
import dev.merrymen.app.ui.LoadedBlock
import dev.merrymen.app.ui.LocalBottomInset
import dev.merrymen.app.ui.MerryColors
import dev.merrymen.app.ui.NameBlock
import dev.merrymen.app.ui.Notice
import dev.merrymen.app.ui.PageGap
import dev.merrymen.app.ui.PagePadH
import dev.merrymen.app.ui.Routes
import dev.merrymen.app.ui.feed.BOARD_EVERY_MS
import dev.merrymen.app.ui.feed.ReadFailure
import dev.merrymen.app.ui.feed.ReadLoop
import dev.merrymen.app.ui.feed.ReadState
import dev.merrymen.app.ui.feed.Slot
import dev.merrymen.app.ui.feed.failureOf
import dev.merrymen.app.ui.feed.pctBps
import dev.merrymen.app.ui.feed.pollWhileResumed
import dev.merrymen.app.ui.feed.staleLine
import dev.merrymen.app.ui.numerals
import dev.merrymen.app.ui.sans
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlin.math.abs

// ── what one row says ───────────────────────────────────────────────────────

/**
 * `unrankedShort` (rank-pnl.ts): the reason a row has no ranked return, short
 * enough for a cell. Local to the board, which is the only place that prints
 * the short form; `Models.unrankedShort` predates "paper" and "inactive" and
 * printed a paper agent as "unranked".
 */
internal fun boardUnranked(why: String?): String = when (why) {
  "paper" -> "paper trading"
  "inactive" -> "inactive"
  "no-deposit" -> "no deposit"
  "never-filled" -> "never filled"
  "contributions-unevidenced" -> "unverified deposits"
  "quality-unknown" -> "unranked"
  else -> "unranked"
}

/** `unrankedLabel` (rank-pnl.ts): the same reason in full, for a screen reader. */
internal fun boardUnrankedLong(why: String?): String = when (why) {
  "paper" -> "paper trading"
  "inactive" -> "inactive"
  "no-deposit" -> "no deposit on record"
  "never-filled" -> "nothing has filled yet"
  "contributions-unevidenced" -> "deposit history unavailable"
  else -> "return unavailable"
}

/**
 * `tradeLine` (Board.tsx): WHAT THIS AGENT HAS ACTUALLY DONE. Landed and paper
 * stay apart — a simulated fill is a real thing to have done, and it is not a
 * trade. A count the board did not send is not printed as a zero: the web
 * writes `filledPaper ?? 0`, which would say "0 paper trades" about a number
 * nobody read, so here an unsent count leaves the line out.
 */
internal fun boardTradeLine(row: LeaderRow): String? {
  fun plural(n: Int, word: String) = "$n $word${if (n == 1) "" else "s"}"
  if (row.mode == "paper") return row.filledPaper?.let { plural(it, "paper trade") }
  val landed = row.landed
  if (landed != null && landed > 0) return plural(landed, "trade")
  val paper = row.filledPaper
  if (paper != null && paper > 0) return "$paper on paper"
  return if (landed == 0) "No trades yet" else null
}

enum class BoardTone { UP, DOWN, FLAT, FAINT }

/** One row as the board prints it. */
data class BoardLine(
  val row: LeaderRow,
  /** The position in the race — null ("—") for a row with no ranked return. */
  val rank: Int?,
  /** The return shown: the ranked one, a paper book's own labelled Paper, or the reason there is none. */
  val figure: String,
  val tone: BoardTone,
  /** "Paper" or "Inactive" for a row that is not live. */
  val stamp: String?,
  val trades: String?,
  val you: Boolean,
)

/**
 * `rank` and `Rank` (Board.tsx): EVERY AGENT IS LISTED — 25 of the 30 on the
 * captured board are paper agents, which the phone used to call "unranked".
 * Only a live return ranks: rows are ordered by `pnlBps` (a stable sort, so
 * rows with none keep the server's order below the ranked ones) and a row
 * with no ranked return has no position. A paper row shows its own return,
 * stamped Paper, and never enters the race. The board is NEVER ordered by
 * likes or follows.
 */
fun boardLines(board: Leaderboard, mine: String?): List<BoardLine> {
  val ranked = board.agents.withIndex()
    .sortedWith(compareByDescending<IndexedValue<LeaderRow>> { it.value.pnlBps != null }.thenByDescending { it.value.pnlBps ?: Int.MIN_VALUE })
  return ranked.mapIndexed { place, (_, row) ->
    val paper = row.mode == "paper"
    val shown = if (paper) row.paperPnlBps else row.pnlBps
    val figure = shown?.let { pctBps(it.toDouble()) } ?: boardUnranked(row.unrankedWhy)
    // The colour follows the PRINTED figure: "0.0%" is flat, not a gain.
    val tone = when {
      shown == null -> BoardTone.FAINT
      abs(shown) < 5 -> BoardTone.FLAT
      shown > 0 -> BoardTone.UP
      else -> BoardTone.DOWN
    }
    BoardLine(
      row = row,
      rank = if (row.pnlBps == null) null else place + 1,
      figure = figure,
      tone = tone,
      stamp = when {
        row.mode == null || row.mode == "live" -> null
        paper -> "Paper"
        else -> "Inactive"
      },
      trades = boardTradeLine(row),
      you = mine != null && row.slug != null && row.slug.equals(mine, ignoreCase = true),
    )
  }
}

/** "Retired accounts (43)" — only a count the server sent, and only when it folded any. */
fun retiredLine(board: Leaderboard): String? = board.retired?.takeIf { it > 0 }?.let { "Retired accounts ($it)" }

/** The board's read, once a minute while it is on screen. */
private class BoardReads(private val api: MerrymenApi) {
  private val _board = MutableStateFlow(Slot<Leaderboard>())
  val board: StateFlow<Slot<Leaderboard>> = _board.asStateFlow()

  val loop = ReadLoop(BOARD_EVERY_MS) {
    // `source: "none"` is the ledger not opening — never "nobody to rank".
    _board.value = _board.value.after(api.leaderboard(), System.currentTimeMillis()) { it.source == "none" }
    _board.value.fresh
  }
}

// ── the screen ──────────────────────────────────────────────────────────────

@Composable
fun LeaderboardScreen(nav: NavHostController) {
  val c = LocalContainer.current
  val reads = remember(c.api) { BoardReads(c.api) }
  val slot by reads.board.collectAsState()
  val signedIn by c.repo.signedIn.collectAsState()
  val scope = rememberCoroutineScope()
  val lifecycle = LocalLifecycleOwner.current.lifecycle
  LaunchedEffect(lifecycle, reads) { lifecycle.pollWhileResumed(listOf(reads.loop)) }
  // What the reader's agent reads, for the wire rings on the faces. Throttled.
  LaunchedEffect(Unit) { c.social.refreshWired() }
  // THE READER'S OWN ROW, marked "you" — from their own feed, and only when it
  // named an agent it actually read.
  val mine by produceState<String?>(null, signedIn) {
    // Cleared first: the state outlives the key, and the last wallet's agent
    // must not stay marked "you" while the new wallet's feed is on its way.
    value = null
    value = if (signedIn == null) null else ownSlugOf(c.api.feed().valueOrNull())
  }
  val retry: () -> Unit = { scope.launch { reads.loop.readNow(System.currentTimeMillis()) } }

  Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
    Header("Leaderboard", nav)
    Spacer(Modifier.height(PageGap))
    Column(Modifier.fillMaxWidth().padding(horizontal = PagePadH)) {
      MeasuredHow()
      staleLine(slot, "the board", System.currentTimeMillis())?.let {
        Text(it, Modifier.padding(bottom = 10.dp), style = TextStyle(fontFamily = sans(12.sp), fontSize = 12.sp), color = MerryColors.tx2)
      }
      val board = slot.body
      when {
        slot.state != ReadState.OK && slot.failure == ReadFailure.Ledger -> Notice(
          title = "Activity unavailable.",
          body = "merrymen answered, but couldn't read the ledger the board is ranked from just now. That isn't the " +
            "same as nobody trading — try again in a moment.",
          actionLabel = "Try again",
          onAction = retry,
        )
        slot.state != ReadState.OK || board == null ->
          LoadedBlock(failureOf(slot) ?: Loaded.Loading, onSignIn = { nav.navigate(Routes.SIGN_IN) }, onRetry = retry) { }
        board.agents.isEmpty() -> Empty(
          // Not "nobody" when accounts were folded away: they ran, and the line below counts them.
          title = if ((board.retired ?: 0) > 0) "No agent is running right now." else "Nobody has traded yet.",
          body = "",
          kind = EmptyKind.Board,
        )
        else -> {
          val lines = boardLines(board, mine)
          lines.forEachIndexed { i, line ->
            RankRow(
              line = line,
              last = i == lines.lastIndex,
              modifier = Modifier.clickable(enabled = line.row.slug != null) { line.row.slug?.let { nav.navigate(Routes.agent(it)) } },
            )
          }
        }
      }
      board?.let { b ->
        retiredLine(b)?.let { line ->
          Column(Modifier.padding(top = 12.dp)) {
            Text(line, style = TextStyle(fontFamily = sans(12.sp), fontSize = 12.sp), color = MerryColors.tx2)
            // The web keeps this in a title attribute; a phone has no hover.
            Text(
              "Accounts nothing is running any more: killed, expired, or never linked to a named agent. One agent " +
                "re-granted can leave more than one.",
              Modifier.padding(top = 4.dp),
              style = TextStyle(fontFamily = sans(11.sp), fontSize = 11.sp, lineHeight = 16.sp),
              color = MerryColors.faint,
            )
          }
        }
      }
    }
    Spacer(Modifier.height(LocalBottomInset.current))
  }
}

/**
 * "How returns are measured" — `.ranking-help`, collapsed so it costs a line.
 * "No deposit" and "never filled" are different facts, and a paper book
 * divided by a real deposit is a number that never happened.
 */
@Composable
private fun MeasuredHow() {
  var open by rememberSaveable { mutableStateOf(false) }
  Column(Modifier.padding(bottom = 20.dp)) {
    Text(
      text = if (open) "How returns are measured ⌄" else "How returns are measured ›",
      modifier = Modifier
        .heightIn(min = 44.dp)
        .clickable(role = Role.Button) { open = !open }
        .semantics { stateDescription = if (open) "Expanded" else "Collapsed" }
        .padding(vertical = 12.dp),
      style = TextStyle(fontFamily = sans(12.sp), fontSize = 12.sp),
      color = MerryColors.tx2,
    )
    if (open) {
      Text(
        "All agents are listed; only eligible live returns are ranked. Paper returns measure the change since the " +
          "first recorded valuation of the current paper period and remain outside live rankings. Inactive agents " +
          "remain unranked. No deposit means no capital to measure a return against. No completed trades means no " +
          "return to measure. Dividing a pretend book by a real deposit publishes a number that never happened, so " +
          "returns without evidenced capital stay unranked.",
        style = TextStyle(fontFamily = sans(12.sp), fontSize = 12.sp, lineHeight = 19.2.sp),
        color = MerryColors.tx2,
      )
    }
  }
}

/** `.stamp` (terminal.css:1537): 10px/600 uppercase in `--faint` with a hairline. Not a figure. */
@Composable
private fun BoardStamp(text: String) {
  Box(
    Modifier
      .border(1.dp, MerryColors.line, RoundedCornerShape(4.dp))
      .padding(horizontal = 6.dp, vertical = 2.dp),
  ) {
    Text(
      text.uppercase(),
      style = TextStyle(fontFamily = sans(10.sp, FontWeight.W600), fontSize = 10.sp, fontWeight = FontWeight.W600, letterSpacing = 0.04.em),
      color = if (text == "Paper") MerryColors.tx2 else MerryColors.faint,
    )
  }
}

/**
 * `.rank` — a ruled row: the position ("—" when the return is not ranked), the
 * face with its wire ring, the name with its owner, what it has done, and the
 * return it may show.
 */
@Composable
private fun RankRow(line: BoardLine, last: Boolean, modifier: Modifier = Modifier) {
  val row = line.row
  val name = row.name ?: row.handle ?: "agent"
  Column(modifier.fillMaxWidth()) {
    Row(
      Modifier.fillMaxWidth().padding(vertical = 10.dp),
      horizontalArrangement = Arrangement.spacedBy(11.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Text(
        text = line.rank?.toString() ?: "—",
        modifier = Modifier.width(20.dp),
        style = TextStyle(fontFamily = numerals(FontWeight.W400), fontSize = 13.sp, fontWeight = FontWeight.W400),
        color = MerryColors.faint,
      )
      AgentFace(slug = row.slug, name = name, size = 30.dp)
      Column(Modifier.weight(1f)) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
          NameBlock(title = name, owner = row.handle, verified = row.handleVerified, modifier = Modifier.weight(1f, fill = false))
          if (line.you) {
            Box(Modifier.background(MerryColors.tx, RoundedCornerShape(4.dp)).padding(horizontal = 5.dp, vertical = 1.dp)) {
              Text("you", style = TextStyle(fontFamily = sans(11.sp, FontWeight.W600), fontSize = 11.sp, fontWeight = FontWeight.W600), color = MerryColors.ink)
            }
          }
        }
        Row(
          Modifier.padding(top = 2.dp),
          horizontalArrangement = Arrangement.spacedBy(6.dp),
          verticalAlignment = Alignment.CenterVertically,
        ) {
          line.trades?.let {
            Text(it, maxLines = 1, style = TextStyle(fontFamily = sans(11.sp), fontSize = 11.sp), color = MerryColors.faint)
          }
          line.stamp?.let { BoardStamp(it) }
        }
      }
      Text(
        text = line.figure,
        maxLines = 1,
        modifier = Modifier.semantics {
          if (line.tone == BoardTone.FAINT) contentDescription = boardUnrankedLong(row.unrankedWhy)
        },
        style = TextStyle(
          fontFamily = if (line.tone == BoardTone.FAINT) sans(12.sp, FontWeight.W600) else numerals(FontWeight.W600),
          fontSize = 12.sp,
          fontWeight = FontWeight.W600,
          letterSpacing = (-0.02).em,
        ),
        color = when (line.tone) {
          BoardTone.UP -> MerryColors.up
          BoardTone.DOWN -> MerryColors.down
          BoardTone.FLAT -> MerryColors.tx
          BoardTone.FAINT -> MerryColors.faint
        },
      )
    }
    if (!last) Box(Modifier.fillMaxWidth().height(1.dp).background(MerryColors.line))
  }
}
