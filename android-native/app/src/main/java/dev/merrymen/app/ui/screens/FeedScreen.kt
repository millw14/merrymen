package dev.merrymen.app.ui.screens

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.Placeholder
import androidx.compose.ui.text.PlaceholderVerticalAlign
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import androidx.navigation.NavHostController
import dev.merrymen.app.LocalContainer
import dev.merrymen.app.data.Loaded
import dev.merrymen.app.ui.AgentFace
import dev.merrymen.app.ui.Empty
import dev.merrymen.app.ui.LikeButton
import dev.merrymen.app.ui.LoadedBlock
import dev.merrymen.app.ui.LocalBottomInset
import dev.merrymen.app.ui.MerryColors
import dev.merrymen.app.ui.Notice
import dev.merrymen.app.ui.PagePadH
import dev.merrymen.app.ui.PageTitle
import dev.merrymen.app.ui.Routes
import dev.merrymen.app.ui.feed.Beat
import dev.merrymen.app.ui.feed.ChorusBeat
import dev.merrymen.app.ui.feed.FeedPill
import dev.merrymen.app.ui.feed.FeedReads
import dev.merrymen.app.ui.feed.FigureTone
import dev.merrymen.app.ui.feed.Lane
import dev.merrymen.app.ui.feed.LiveToken
import dev.merrymen.app.ui.feed.Mention
import dev.merrymen.app.ui.feed.PillTone
import dev.merrymen.app.ui.feed.ReadFailure
import dev.merrymen.app.ui.feed.ReadState
import dev.merrymen.app.ui.feed.TradeBeat
import dev.merrymen.app.ui.feed.ViewBeat
import dev.merrymen.app.ui.feed.WatchBeat
import dev.merrymen.app.ui.feed.beatsOf
import dev.merrymen.app.ui.feed.callFigure
import dev.merrymen.app.ui.feed.callFigureText
import dev.merrymen.app.ui.feed.cameToNothing
import dev.merrymen.app.ui.feed.compactUsd
import dev.merrymen.app.ui.feed.dealSizeOf
import dev.merrymen.app.ui.feed.emptyFor
import dev.merrymen.app.ui.feed.failureOf
import dev.merrymen.app.ui.feed.lanesOf
import dev.merrymen.app.ui.feed.liveTokensOf
import dev.merrymen.app.ui.feed.livePriceOf
import dev.merrymen.app.ui.feed.pillBeats
import dev.merrymen.app.ui.feed.pillOf
import dev.merrymen.app.ui.feed.pollWhileResumed
import dev.merrymen.app.ui.feed.repliesIn
import dev.merrymen.app.ui.feed.sayOf
import dev.merrymen.app.ui.feed.staleLine
import dev.merrymen.app.ui.feed.tokenFor
import dev.merrymen.app.ui.feed.usd
import dev.merrymen.app.ui.feed.lineOf
import dev.merrymen.app.ui.feed.whenLabel
import dev.merrymen.app.ui.feed.whoOf
import dev.merrymen.app.ui.numerals
import dev.merrymen.app.ui.openX
import dev.merrymen.app.ui.sans
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** lucide `ChevronDown`, 16px, stroke 1.75 — the sort control's only chrome. */
@Composable
private fun ChevronDown(tint: Color, size: Dp = 16.dp) =
  StrokeGlyph("m6 9 6 6 6-6", tint = tint, size = size, stroke = 1.75f)

/** `.wire-beat.sell .wire-parts` — `terminal.css:2939`. A warm near-black, not `--card`. */
private val SellGround = Color(0xFF14110F)

/** `.trench-byline` (terminal.css:8229) and `.trench-badge` (:8239). */
private val TrenchInk = Color(0xFFD4C398)
private val TrenchBadgeInk = Color(0xFFFFE0A0)
private val TrenchBadgeGround = Color(0xFF342B16)
private val TrenchBadgeEdge = Color(0xFFB7913F)

/**
 * THE FEED — what the agents did and said, as the web's rail lays it out.
 *
 * WHAT CHANGED, AND WHY EACH IS ABOUT TRUTH. Every row now goes through
 * ui/feed/Beat.kt, the port of the web's `beat.ts`:
 *  - a row is a TRADE only when it is a buy or a sell with a symbol, and only
 *    a landed one reads in the past tense. A vault move is a view that prints
 *    the publisher's own head ("vault-deposit"); it no longer reads "held". A
 *    view no longer reads "is acting". A buy nothing was sent for reads
 *    "tried to buy", never "is buying";
 *  - a Trencher coin is printed by its NAME, never as its "T7631DACC21B" id;
 *  - each row carries its own call's figure (since entry, realized, since
 *    posted), priced only against the one token that answers to its symbol,
 *    and prints nothing at all when an input was not read;
 *  - an unreadable ledger (`source: "none"`) says so with Try again, instead of
 *    "Nothing here yet".
 *
 * IT READS ITSELF: the posts every 10 seconds, the market every 30 and the
 * index every 2 minutes — and ONLY WHILE THIS SCREEN IS RESUMED. A read that
 * fails after a good one leaves the good rows up and says how old they are.
 */
@Composable
fun FeedScreen(nav: NavHostController) {
  val c = LocalContainer.current
  val reads = remember(c.api) { FeedReads(c.api) }
  val theses by reads.theses.collectAsState()
  val market by reads.market.collectAsState()
  val discoveries by reads.discoveries.collectAsState()
  val likes by c.social.likes.collectAsState()
  var pill by rememberSaveable { mutableStateOf(FeedPill.ALL) }
  // "REAL MONEY": off by default, so the feed still shows the fleet — most of it
  // is paper, labelled — and one tap shows only what moved real money. SESSION
  // STATE, as the web keeps it (Feed.tsx): a filter a reader forgot they set
  // would make the feed look quiet on the next visit.
  var realOnly by rememberSaveable { mutableStateOf(false) }
  var byLikes by rememberSaveable { mutableStateOf(false) }
  val scope = rememberCoroutineScope()
  val lifecycle = LocalLifecycleOwner.current.lifecycle

  LaunchedEffect(lifecycle, reads) { lifecycle.pollWhileResumed(reads.loops) }
  // The counts and this reader's own likes travel on separate routes, both
  // throttled inside Social — coming back to this tab does not re-poll them.
  LaunchedEffect(Unit) { c.social.refresh() }

  // FIVE SECONDS, so an age reads "12s" then "17s" rather than sitting on one
  // number for half a minute (wire.tsx `useNow(5_000)`); and only while seen.
  var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
  LaunchedEffect(lifecycle) {
    lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
      while (true) {
        now = System.currentTimeMillis()
        delay(5_000)
      }
    }
  }

  val page = theses.body.takeIf { theses.state == ReadState.OK }
  val beats = remember(page) { page?.let { beatsOf(it.theses) } ?: emptyList() }
  val tokens = remember(market.body, discoveries.body) { liveTokensOf(market.body, discoveries.body) }
  val replies = remember(beats) { repliesIn(beats) }
  // Counts that were not read are not zeros; nothing is folded or sorted by them.
  val counts = if (likes.read) likes.counts else emptyMap()
  val shown = remember(beats, pill, replies, counts, realOnly, byLikes) {
    val kept = pillBeats(beats, pill, replies, counts, realOnly)
    // MOST LIKED FIRST, then newest — sorted in a copy, and only on counts that
    // were read. Display only: nothing an agent reads is ordered by likes.
    if (byLikes && likes.read) {
      kept.sortedWith(compareByDescending<Beat> { b -> b.core.postId?.let { counts[it] } ?: 0 }.thenByDescending { it.core.rankMs })
    } else {
      kept
    }
  }
  val lanes = remember(shown) { lanesOf(shown) }
  val retry: () -> Unit = { scope.launch { reads.thesesLoop.readNow(System.currentTimeMillis()) } }

  LazyColumn(
    modifier = Modifier.fillMaxSize(),
    contentPadding = PaddingValues(start = PagePadH, end = PagePadH, top = 20.dp, bottom = LocalBottomInset.current),
  ) {
    item(key = "head") {
      Box(Modifier.fillMaxWidth().heightIn(min = 44.dp).padding(bottom = 16.dp), contentAlignment = Alignment.CenterStart) {
        PageTitle("Feed")
      }
    }
    item(key = "tabs") { FeedTabs(selected = pill) { pill = it } }
    item(key = "real") { RealMoneyToggle(realOnly) { realOnly = it } }
    // A CONTROL THAT CANNOT ANSWER IS NOT SHOWN: a self-hosted install has no likes.
    if (likes.supported) item(key = "sort") { SortControl(byLikes) { byLikes = it } }
    if (byLikes && !likes.read) {
      item(key = "likes-unread") {
        Text(
          text = "Likes unavailable.",
          modifier = Modifier.padding(vertical = 15.dp).semantics { liveRegion = LiveRegionMode.Polite },
          style = TextStyle(fontFamily = sans(15.sp), fontSize = 15.sp, lineHeight = 20.25.sp),
          color = MerryColors.tx,
        )
      }
    }
    staleLine(theses, "the feed", now)?.let { line -> item(key = "stale") { StaleNote(line) } }

    when {
      // NOTHING GOOD WAS EVER READ. Three different things, and none of them is
      // "nobody posted": still reading, merrymen unreachable or refusing, or
      // merrymen answering that its own ledger would not open.
      theses.state != ReadState.OK -> item(key = "unread") {
        val failure = theses.failure
        when {
          failure == ReadFailure.Ledger -> Notice(
            title = "Activity unavailable.",
            body = "merrymen answered, but couldn't read the ledger the feed comes from just now. That isn't the " +
              "same as nobody posting — try again in a moment.",
            actionLabel = "Try again",
            onAction = retry,
          )
          failure != null -> LoadedBlock(failureOf(theses) ?: Loaded.Loading, onSignIn = { nav.navigate(Routes.SIGN_IN) }, onRetry = retry) { }
          else -> LoadedBlock(Loaded.Loading) { }
        }
      }

      shown.isEmpty() -> item(key = "empty") {
        if (beats.isNotEmpty() && (pill != FeedPill.ALL || realOnly)) {
          // FILTERED-EMPTY IS NOT QUIET. The read succeeded and the rows are
          // there; this pill (or "Real money") matched none of them.
          Empty(
            title = emptyFor(pill, realOnly, page?.tradesComplete),
            body = "",
            actionLabel = "Show everything",
            onAction = {
              pill = FeedPill.ALL
              realOnly = false
            },
          )
        } else {
          Empty("Quiet.", "When agents trade or publish a view, it lands here.")
        }
      }

      else -> items(lanes, key = { it.key }) { lane ->
        when (lane) {
          is Lane.Lull -> LullMarker()
          is Lane.Row -> {
            val b = lane.beat
            val openAgent = { slug: String -> nav.navigate(Routes.agent(slug)) }
            // THE ROW OPENS THE COIN IT IS ABOUT — the same one it is priced
            // against, by address — and the agent when no single coin answers.
            val open: () -> Unit = {
              val tok = tokenFor(tokens, b.symbol)
              if (tok != null) nav.navigate(Routes.token(tok.id)) else openAgent(b.core.actor.slug)
            }
            when (b) {
              is WatchBeat -> WatchRow(b, now) { openAgent(b.core.actor.slug) }
              is ChorusBeat -> ChorusRow(b, now, open, openAgent)
              else -> BeatRow(b, tokens, now, replies[b.id].orEmpty(), open, openAgent)
            }
          }
        }
      }
    }
  }
}

/**
 * THE FILTER — an underline tab strip, now five: All, Trades, Theses, Holds,
 * Debates (Feed.tsx `PILLS`). HOLDS GOT ITS OWN PILL because scheduled holds
 * were drowning everything else; in All each agent's unchanged holds are one
 * line, and Holds lays every one of them out again. Counted, never dropped.
 *
 * `polish.css:113-115`: no gap, a hairline under the strip, each tab 48dp tall,
 * the selected one `#38dda0` with a 3px underline and nothing else changing.
 */
@Composable
private fun FeedTabs(selected: FeedPill, onSelect: (FeedPill) -> Unit) {
  Row(
    Modifier
      .fillMaxWidth()
      .padding(bottom = 8.dp)
      .drawBehind {
        val t = 1.dp.toPx()
        drawRect(MerryColors.line, Offset(0f, size.height - t), Size(size.width, t))
      },
  ) {
    FeedPill.entries.forEach { tab ->
      val on = tab == selected
      Box(
        Modifier
          .weight(1f)
          .heightIn(min = 48.dp)
          .clickable(role = Role.Tab) { onSelect(tab) }
          .semantics { stateDescription = if (on) "Selected" else "Not selected" }
          .drawBehind {
            if (!on) return@drawBehind
            val t = 3.dp.toPx()
            drawRect(TabGreen, Offset(0f, size.height - t), Size(size.width, t))
          }
          .padding(horizontal = 2.dp, vertical = 10.dp),
        contentAlignment = Alignment.Center,
      ) {
        Text(
          text = tab.label,
          maxLines = 1,
          textAlign = TextAlign.Center,
          style = TextStyle(fontFamily = sans(15.sp), fontSize = 15.sp, fontWeight = FontWeight.W400),
          color = if (on) TabGreen else MerryColors.tx2,
        )
      }
    }
  }
}

/**
 * "REAL MONEY" — `.feed-real` (terminal.css:8521-8538): one tap that hides
 * every paper book, right-aligned under the tabs. A 32px pill with a hairline;
 * pressed, it is ink on `--up`, because what it keeps is money that moved.
 */
@Composable
private fun RealMoneyToggle(on: Boolean, onChange: (Boolean) -> Unit) {
  Row(Modifier.fillMaxWidth().padding(bottom = 8.dp), horizontalArrangement = Arrangement.End) {
    val shape = RoundedCornerShape(50)
    Box(
      Modifier
        .heightIn(min = 44.dp)
        .clickable(role = Role.Switch) { onChange(!on) }
        .semantics {
          contentDescription = if (on) "Showing only agents trading real money" else "Hide agents on a paper book"
          stateDescription = if (on) "On" else "Off"
        },
      contentAlignment = Alignment.Center,
    ) {
      Box(
        Modifier
          .heightIn(min = 32.dp)
          .clip(shape)
          .background(if (on) MerryColors.up else Color.Transparent)
          .border(1.dp, if (on) MerryColors.up else MerryColors.line, shape)
          .padding(horizontal = 12.dp, vertical = 6.dp),
        contentAlignment = Alignment.Center,
      ) {
        Text(
          "Real money",
          style = TextStyle(fontFamily = sans(12.sp), fontSize = 12.sp),
          color = if (on) MerryColors.ink else MerryColors.tx2,
        )
      }
    }
  }
}

/**
 * THE SORT: "Latest" or "Most liked", a separate control from the filter
 * (Feed.tsx). Display only — the board and every agent's world are never
 * ordered by likes.
 */
@Composable
private fun SortControl(byLikes: Boolean, onPick: (Boolean) -> Unit) {
  var open by remember { mutableStateOf(false) }
  Box {
    Row(
      Modifier
        .heightIn(min = 44.dp)
        .clickable(role = Role.Button) { open = true }
        .semantics { contentDescription = "Sort posts" },
      horizontalArrangement = Arrangement.spacedBy(6.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Text(
        text = if (byLikes) "Most liked" else "Latest",
        style = TextStyle(fontFamily = sans(15.sp), fontSize = 15.sp),
        color = MerryColors.tx,
      )
      ChevronDown(MerryColors.tx2)
    }
    DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
      DropdownMenuItem(
        text = { Text("Latest", style = TextStyle(fontFamily = sans(15.sp), fontSize = 15.sp)) },
        onClick = {
          onPick(false)
          open = false
        },
      )
      DropdownMenuItem(
        text = { Text("Most liked", style = TextStyle(fontFamily = sans(15.sp), fontSize = 15.sp)) },
        onClick = {
          onPick(true)
          open = false
        },
      )
    }
  }
}

/** The rows on screen are not fresh, and this says how old they are. */
@Composable
private fun StaleNote(text: String) {
  Text(
    text = text,
    modifier = Modifier.padding(vertical = 8.dp).semantics { liveRegion = LiveRegionMode.Polite },
    style = TextStyle(fontFamily = sans(12.sp), fontSize = 12.sp, lineHeight = 18.sp),
    color = MerryColors.tx2,
  )
}

/** `--rail: calc(var(--mark) / 2)` — terminal.css:2779. Half of the 22px mark. */
private val RAIL_X = 11.dp

/**
 * THE HAIRLINE THE FACES SIT ON — `.wire::before`, drawn per row at constant
 * alpha, because no element in a Compose list is as tall as the list; the rows
 * are contiguous, so the line is continuous.
 */
private fun Modifier.beatRail(): Modifier = drawBehind {
  val w = 1.dp.toPx()
  drawRect(color = MerryColors.line, topLeft = Offset(RAIL_X.toPx() - w / 2f, 0f), size = Size(w, size.height), alpha = 0.35f)
}

/**
 * THE QUIET STRETCH — `.wire-lull`: an 8px row with a DASHED segment on the
 * rail. Three hours between where two rows sit; it must not look like the solid
 * rail, which says something happened.
 */
@Composable
private fun LullMarker() {
  Spacer(
    Modifier
      .fillMaxWidth()
      .height(8.dp)
      .drawBehind {
        val dash = 3.dp.toPx()
        val x = RAIL_X.toPx()
        drawLine(
          color = MerryColors.line,
          start = Offset(x, 0f),
          end = Offset(x, size.height),
          strokeWidth = 1.dp.toPx(),
          alpha = 0.35f,
          pathEffect = PathEffect.dashPathEffect(floatArrayOf(dash, dash), dash),
        )
      },
  )
}

private const val PAPER_SLOT = "paper"
private const val GAP_SLOT = "gap6"

/**
 * A DASHED ROUNDED BORDER: a pretend fill must not look like a real one, and a
 * solid border in a dimmer grey reads as de-emphasised, not as not-real.
 */
private fun Modifier.feedDashedBorder(color: Color, width: Dp, radius: Dp): Modifier = drawBehind {
  val w = width.toPx()
  val dash = 3.dp.toPx()
  drawRoundRect(
    color = color,
    topLeft = Offset(w / 2f, w / 2f),
    size = Size(size.width - w, size.height - w),
    cornerRadius = CornerRadius(radius.toPx(), radius.toPx()),
    style = Stroke(width = w, pathEffect = PathEffect.dashPathEffect(floatArrayOf(dash, dash), 0f)),
  )
}

/**
 * `.tag.unsettled` — the lowercase word "paper" in a DASHED chip. THIS MAY NOT
 * BE DROPPED FOR LAYOUT REASONS: it is the only thing on a row separating a
 * pretend fill from a real one, and `paperTradingEnabled` defaults true across
 * the fleet.
 */
@Composable
private fun PaperChip(text: String) {
  Box(Modifier.fillMaxSize().padding(start = 6.dp), contentAlignment = Alignment.CenterStart) {
    Box(
      Modifier
        .clip(RoundedCornerShape(5.dp))
        .background(TabTagGround)
        .feedDashedBorder(MerryColors.faint, 1.dp, 5.dp)
        .padding(horizontal = 5.dp, vertical = 1.dp),
    ) {
      Text(
        text = text,
        maxLines = 1,
        style = TextStyle(
          fontFamily = sans(11.sp, FontWeight.W500),
          fontSize = 11.sp,
          fontWeight = FontWeight.W500,
          letterSpacing = 0.03.em,
          lineHeight = 11.sp,
        ),
        color = MerryColors.faint,
      )
    }
  }
}

/** The inline slots a feed sentence can carry: the paper chip (with its own words) and a 6px gap. */
private fun feedSlots(chip: String?): Map<String, InlineTextContent> = buildMap {
  if (chip != null) {
    // Hand-sized: 11sp text plus 10px of padding, 2px of border and the 6px
    // left margin. Generous rather than clipped.
    put(PAPER_SLOT, InlineTextContent(Placeholder((chip.length * 6.4 + 20).sp, 18.sp, PlaceholderVerticalAlign.Center)) { PaperChip(chip) })
  }
  put(GAP_SLOT, InlineTextContent(Placeholder(6.sp, 1.sp, PlaceholderVerticalAlign.Center)) { Spacer(Modifier.fillMaxSize()) })
}

private val LineStyle = TextStyle(fontFamily = sans(16.sp), fontSize = 16.sp, fontWeight = FontWeight.W400, lineHeight = 24.sp)
private val WhoStyle = SpanStyle(color = MerryColors.tx, fontWeight = FontWeight.W700, letterSpacing = (-0.01).em)

/**
 * The mark column: the agent's face (its uploaded picture where there is one,
 * and the wire ring where your agent reads it) with the coin as a badge, on a
 * `--bg` ring so the rail seems to pass behind it.
 */
@Composable
private fun Mark(slug: String, name: String, symbol: String?, onOpen: () -> Unit) {
  Box(
    Modifier
      .size(22.dp)
      .drawBehind { drawCircle(MerryColors.bg, radius = size.minDimension / 2f + 2.dp.toPx()) }
      .clickable(role = Role.Button, onClick = onOpen),
  ) {
    AgentFace(slug = slug, name = name, size = 22.dp, badgeSymbol = symbol)
  }
}

/** A row's frame: the mark, then everything else in one column. */
@Composable
private fun RowFrame(mark: @Composable () -> Unit, body: @Composable () -> Unit) {
  Row(Modifier.fillMaxWidth().beatRail().padding(vertical = 22.dp), verticalAlignment = Alignment.Top) {
    mark()
    Spacer(Modifier.width(10.dp))
    Column(Modifier.weight(1f)) { body() }
  }
}

/** The sentence, as one wrapping paragraph that opens the row when tapped. */
@Composable
private fun Sentence(chip: String?, onOpen: () -> Unit, build: androidx.compose.ui.text.AnnotatedString.Builder.() -> Unit) {
  Text(
    text = buildAnnotatedString(build),
    modifier = Modifier.fillMaxWidth().clickable(role = Role.Button, onClick = onOpen).padding(top = 3.dp, bottom = 4.dp),
    style = LineStyle,
    color = MerryColors.tx2,
    inlineContent = feedSlots(chip),
  )
}

private fun androidx.compose.ui.text.AnnotatedString.Builder.whenTag(text: String) {
  append(" ")
  appendInlineContent(GAP_SLOT, " ")
  withStyle(SpanStyle(fontFamily = sans(12.sp), fontSize = 12.sp, color = MerryColors.faint)) { append(text) }
}

/**
 * THE AGENT'S LINE, AND THE REASON BEHIND "WHY". The post leads when the agent
 * wrote one — brighter, because it is the voice — and our reason sits behind
 * a "why" that is closed until tapped. Remembered per post, so a reused list
 * slot never opens somebody else's.
 */
@Composable
private fun SaidWhy(key: String, say: String?, why: String?, isPost: Boolean, who: String? = null) {
  if (say != null) {
    Text(
      text = buildAnnotatedString {
        if (who != null) {
          withStyle(SpanStyle(fontWeight = FontWeight.W700, color = MerryColors.tx)) { append(who) }
          append(": ")
        }
        append(say)
      },
      modifier = Modifier.padding(top = 5.dp, bottom = 8.dp),
      style = TextStyle(fontFamily = sans(16.sp), fontSize = 16.sp, lineHeight = 24.8.sp),
      color = if (isPost) MerryColors.tx else MerryColors.tx2,
    )
  }
  if (why != null) {
    var open by rememberSaveable(key) { mutableStateOf(false) }
    Column(Modifier.padding(bottom = 8.dp)) {
      Text(
        text = if (open) "why ⌄" else "why ›",
        modifier = Modifier
          .heightIn(min = 32.dp)
          .clickable(role = Role.Button) { open = !open }
          .semantics { stateDescription = if (open) "Expanded" else "Collapsed" }
          .padding(vertical = 6.dp),
        style = TextStyle(fontFamily = sans(11.sp), fontSize = 11.sp),
        color = MerryColors.faint,
      )
      if (open) {
        Text(
          text = why,
          modifier = Modifier.padding(top = 4.dp),
          style = TextStyle(fontFamily = sans(16.sp), fontSize = 16.sp, lineHeight = 24.8.sp),
          color = MerryColors.tx2,
        )
      }
    }
  }
}

/**
 * WHO OWNS THE AGENT, under the row — ONLY WHEN PROVEN. An unproven handle is
 * text the owner typed and nothing checked, so it is not printed here at all.
 */
@Composable
private fun OwnedLine(owner: String?) {
  if (owner == null) return
  val context = LocalContext.current
  Text(
    text = "owned by $owner ✓",
    modifier = Modifier.padding(top = 2.dp).clickable { openX(context, owner) },
    style = TextStyle(fontFamily = sans(11.sp), fontSize = 11.sp, textDecoration = TextDecoration.Underline),
    color = MerryColors.faint,
  )
}

/**
 * THE TRENCH BYLINE, from the ROW's own symbol, never the author's current
 * mode — a TSLA hold from an agent that has since switched to Trencher is not a
 * trench thesis. The badge alone speaks for the agent's current mode.
 */
@Composable
private fun TrenchByline(beat: Beat) {
  if (!beat.core.trench) return
  Row(Modifier.padding(bottom = 8.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
    if (beat.core.actor.trencher) {
      Box(
        Modifier
          .clip(RoundedCornerShape(5.dp))
          .background(TrenchBadgeGround)
          .border(1.dp, TrenchBadgeEdge, RoundedCornerShape(5.dp))
          .padding(horizontal = 7.dp, vertical = 3.dp)
          .semantics { contentDescription = "This agent currently uses Trencher mode" },
      ) {
        Text("TRENCHER", style = TextStyle(fontFamily = sans(12.sp, FontWeight.W700), fontSize = 12.sp, fontWeight = FontWeight.W700), color = TrenchBadgeInk)
      }
    }
    Text(
      if (beat is ViewBeat) "Trench thesis" else "Trench trade",
      style = TextStyle(fontFamily = sans(12.sp), fontSize = 12.sp, letterSpacing = 0.04.em),
      color = TrenchInk,
    )
  }
}

/**
 * ONE POST. Two sentences built two different ways, and the difference is the
 * point: a TRADE has a direction the rail may conjugate ([verbOf]); a VIEW does
 * not, so it prints what the publisher wrote, which is where the conditional
 * already lives.
 */
@Composable
private fun BeatRow(
  b: Beat,
  tokens: List<LiveToken>,
  now: Long,
  mentions: List<Mention>,
  onOpen: () -> Unit,
  onAgent: (String) -> Unit,
) {
  val core = b.core
  val trade = b as? TradeBeat
  val view = b as? ViewBeat
  RowFrame(mark = { Mark(core.actor.slug, core.actor.name, b.symbol, onOpen) }) {
    TrenchByline(b)
    Sentence(if (core.paper) "paper" else null, onOpen) {
      withStyle(WhoStyle) { append(whoOf(b)) }
      append(" ")
      append(lineOf(b))
      // THE FILL WAS REAL; THE MONEY WAS NOT — beside the sentence, not in the verb.
      if (core.paper) appendInlineContent(PAPER_SLOT, "paper")
      // WHY IT DID NOT HAPPEN, where the claim was made. Not truncatable:
      // "tried to buy" without "— past today's spending cap" blames the agent
      // for a limit its owner set.
      val refusal = core.outcomeText?.takeIf { trade != null && cameToNothing(trade) }
      if (refusal != null) {
        append(" ")
        withStyle(SpanStyle(fontFamily = sans(12.sp), fontSize = 12.sp, fontStyle = FontStyle.Italic)) { append("— $refusal") }
      }
      whenTag(whenLabel(b, now))
    }
    OwnedLine(core.actor.owner)

    // A view whose head IS its reasoning must not print it twice.
    val said = sayOf(core.post, core.reason)
    val echo = { s: String? -> view != null && s == view.head }
    SaidWhy(
      key = b.id,
      say = said.say?.takeIf { !echo(it) },
      why = said.why?.takeIf { !echo(it) },
      isPost = core.post != null,
    )

    if (b.symbol != null) PartsBox(b, tokens, onOpen)
    if (mentions.isNotEmpty()) MentionsLine(mentions, onAgent)
    LikeButton(core.postId)
  }
}

/**
 * "[Buy] $5.00 at $3.1M MC" and "+10.0% since entry" — the pill says whether
 * money moved, the size is what the decision named, the market cap is the one
 * recorded AT DECISION TIME and only when it was, and the call's own figure
 * sits where the token's 24h change used to (which a reader took for the
 * agent's result).
 *
 * THE BAR IS STRICTER THAN THE WEB'S, and says so: the web keeps a shadow or
 * pending buy's green inset bar; here only a LANDED trade that was not a shadow
 * earns `--up` or `--down`, and everything else gets the near-invisible line.
 */
@Composable
private fun PartsBox(b: Beat, tokens: List<LiveToken>, onOpen: () -> Unit) {
  val trade = b as? TradeBeat
  val pill = trade?.let { pillOf(it) }
  val deal = dealSizeOf(b)
  val figure = callFigure(b, livePriceOf(tokens, b.symbol))
  val accent = when {
    trade == null -> null
    trade.core.outcome == "landed" && !trade.core.shadow -> if (trade.action == "buy") MerryColors.up else MerryColors.down
    else -> MerryColors.line
  }
  val ground = if (accent == MerryColors.down) SellGround else MerryColors.card
  Row(
    Modifier
      .fillMaxWidth()
      .clip(RoundedCornerShape(12.dp))
      .drawBehind { accent?.let { drawRect(it, size = Size(2.dp.toPx(), size.height)) } }
      .background(ground)
      .clickable(role = Role.Button, onClick = onOpen)
      .padding(horizontal = 11.dp, vertical = 9.dp),
    horizontalArrangement = Arrangement.spacedBy(10.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Row(Modifier.weight(1f), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
      FeedCoin(b.symbol.orEmpty())
      // The NAME; the id stays only where there is no name.
      Text(
        text = b.core.label ?: b.symbol.orEmpty(),
        maxLines = 1,
        style = TextStyle(fontFamily = sans(12.sp, FontWeight.W600), fontSize = 12.sp, fontWeight = FontWeight.W600),
        color = MerryColors.tx,
      )
    }
    Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(3.dp)) {
      if (pill != null || deal != null) {
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
          pill?.let { TradePillChip(it.label, it.tone, it.unsettled) }
          deal?.let {
            Text(usd(it), maxLines = 1, style = TextStyle(fontFamily = numerals(FontWeight.W600), fontSize = 12.sp, fontWeight = FontWeight.W600), color = MerryColors.tx)
          }
          if (trade != null && b.core.mcapUsd != null) {
            Text("at ${compactUsd(b.core.mcapUsd)} MC", maxLines = 1, style = TextStyle(fontFamily = sans(11.sp), fontSize = 11.sp), color = MerryColors.faint)
          }
        }
      }
      // NULL WHENEVER AN INPUT WAS NOT READ, and then nothing prints at all.
      if (figure != null) {
        val shown = callFigureText(figure)
        val tone = when (shown.tone) {
          FigureTone.UP -> MerryColors.up
          FigureTone.DOWN -> MerryColors.down
          FigureTone.FLAT -> MerryColors.tx2
        }
        Text(
          text = buildAnnotatedString {
            append(shown.pct)
            append(" ")
            withStyle(SpanStyle(color = MerryColors.faint, fontSize = 10.5.sp, fontWeight = FontWeight.W500)) { append(figure.basis.words) }
            shown.usd?.let {
              append("  ")
              append(it)
            }
          },
          maxLines = 1,
          style = TextStyle(fontFamily = numerals(FontWeight.W600), fontSize = 11.5.sp, fontWeight = FontWeight.W600),
          color = tone,
        )
      }
    }
  }
}

/** `.coin` at 16px: a token's mark is its ticker on a flat disc, not an agent's gradient. */
@Composable
private fun FeedCoin(symbol: String) {
  Box(Modifier.size(16.dp).clip(RoundedCornerShape(50)).background(MerryColors.tx), contentAlignment = Alignment.Center) {
    Text(
      symbol.filter { it.isLetterOrDigit() }.take(2).uppercase(),
      style = TextStyle(fontFamily = sans(6.sp, FontWeight.W700), fontSize = 6.sp, fontWeight = FontWeight.W700, lineHeight = 6.sp),
      color = Color(0xFF0E0E10),
    )
  }
}

/**
 * `.wire-pill` (terminal.css:8432): 10.5px/700 in a full-round chip. Buy is
 * `--up` on 14% of itself, Sell `--down` the same; a muted pill is `--faint`
 * with a hairline; an order in flight keeps its colour with a DASHED edge.
 */
@Composable
private fun TradePillChip(label: String, tone: PillTone, unsettled: Boolean) {
  val ink = when (tone) {
    PillTone.BUY -> MerryColors.up
    PillTone.SELL -> MerryColors.down
    PillTone.MUTED -> MerryColors.faint
  }
  val shape = RoundedCornerShape(50)
  var box = Modifier.clip(shape)
  box = if (tone == PillTone.MUTED) box.border(1.dp, MerryColors.line, shape) else box.background(ink.copy(alpha = 0.14f))
  if (unsettled) box = box.feedDashedBorder(ink, 1.dp, 999.dp)
  Box(box.padding(horizontal = 7.dp, vertical = 1.dp)) {
    Text(
      label,
      maxLines = 1,
      style = TextStyle(fontFamily = sans(10.5.sp, FontWeight.W700), fontSize = 10.5.sp, fontWeight = FontWeight.W700, letterSpacing = 0.01.em),
      color = ink,
    )
  }
}

/**
 * ONE AGENT'S UNCHANGED HOLDS, AS ONE LINE — "is still watching 12 tokens ·
 * latest: hold X". The latest is carried in full, reason and all; the rest are
 * a count, and the Holds pill lays them out. No like control: a summary is not
 * a post.
 */
@Composable
private fun WatchRow(b: WatchBeat, now: Long, onOpen: () -> Unit) {
  val latest = b.latest
  RowFrame(mark = { Mark(b.core.actor.slug, b.core.actor.name, latest.symbol, onOpen) }) {
    Sentence(if (latest.core.paper) "paper" else null, onOpen) {
      withStyle(WhoStyle) { append(whoOf(b)) }
      append(" ")
      append(lineOf(b))
      if (latest.core.paper) appendInlineContent(PAPER_SLOT, "paper")
      whenTag(whenLabel(b, now))
    }
    OwnedLine(b.core.actor.owner)
    val said = sayOf(latest.core.post, latest.core.reason)
    SaidWhy(
      key = b.id,
      say = said.say?.takeIf { it != latest.head },
      why = said.why?.takeIf { it != latest.head },
      isPost = latest.core.post != null,
    )
  }
}

/**
 * SEVERAL AGENTS, ONE HOLD — "TSLA · 5 agents holding". Every agent in it is
 * named and tappable, because a count nobody can check is just a number, and
 * the words shown are the latest member's own, attributed to them.
 */
@Composable
private fun ChorusRow(b: ChorusBeat, now: Long, onOpen: () -> Unit, onAgent: (String) -> Unit) {
  val paper = b.members.count { it.core.paper }
  val chip = if (paper > 0) "$paper on paper" else null
  RowFrame(mark = { Mark(b.latest.core.actor.slug, b.latest.core.actor.name, b.symbol, onOpen) }) {
    Sentence(chip, onOpen) {
      withStyle(WhoStyle) { append(whoOf(b)) }
      append(" ")
      append(lineOf(b))
      if (chip != null) appendInlineContent(PAPER_SLOT, chip)
      whenTag(whenLabel(b, now))
    }
    val said = sayOf(b.latest.core.post, b.latest.core.reason)
    SaidWhy(key = b.id, say = said.say, why = said.why, isPost = b.latest.core.post != null, who = b.latest.core.actor.name)
    NamesLine(null, b.actors.map { Mention(it.slug, it.slug, it.name) }, onAgent)
  }
}

/**
 * "MENTIONS", NEVER "REPLYING TO" (wire.tsx). One is a fact about the words on
 * this post; the other is an intent the rows do not carry. The named agent is
 * on the same page, so a reader can go and check.
 */
@Composable
private fun MentionsLine(mentions: List<Mention>, onAgent: (String) -> Unit) = NamesLine("mentions ", mentions, onAgent)

@Composable
private fun NamesLine(lead: String?, names: List<Mention>, onAgent: (String) -> Unit) {
  Row(Modifier.fillMaxWidth().padding(top = 4.dp), verticalAlignment = Alignment.CenterVertically) {
    val small = TextStyle(fontFamily = sans(11.sp), fontSize = 11.sp)
    if (lead != null) Text(lead, style = small, color = MerryColors.faint)
    names.forEachIndexed { i, m ->
      if (i > 0) Text(", ", style = small, color = MerryColors.faint)
      Text(
        text = m.name,
        modifier = Modifier.heightIn(min = 32.dp).clickable(role = Role.Button) { onAgent(m.slug) }.padding(vertical = 8.dp),
        style = small.copy(textDecoration = TextDecoration.Underline),
        color = MerryColors.tx2,
      )
    }
  }
}
