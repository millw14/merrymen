package dev.merrymen.app.ui.screens

import androidx.compose.foundation.background
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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.Placeholder
import androidx.compose.ui.text.PlaceholderVerticalAlign
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.navigation.NavHostController
import dev.merrymen.app.LocalContainer
import dev.merrymen.app.data.Loaded
import dev.merrymen.app.data.toLoaded
import dev.merrymen.app.net.Thesis
import dev.merrymen.app.ui.Avatar
import dev.merrymen.app.ui.Empty
import dev.merrymen.app.ui.LikeButton
import dev.merrymen.app.ui.LoadedBlock
import dev.merrymen.app.ui.LocalBottomInset
import dev.merrymen.app.ui.MerryColors
import dev.merrymen.app.ui.Neutral
import dev.merrymen.app.ui.PagePadH
import dev.merrymen.app.ui.PageTitle
import dev.merrymen.app.ui.Routes
import dev.merrymen.app.ui.numerals
import dev.merrymen.app.ui.sans
import dev.merrymen.app.ui.toneOf
import dev.merrymen.app.ui.verbOf
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import java.util.Locale

/** lucide `ChevronDown`, 16px, stroke 1.75 — the sort control's only chrome. */
@Composable
private fun ChevronDown(tint: Color, size: Dp = 16.dp) =
  StrokeGlyph("m6 9 6 6 6-6", tint = tint, size = size, stroke = 1.75f)

/**
 * THE TIMESTAMP, from `clock.ts:19-28` — "now" under a minute, then `{n}m`,
 * `{n}h` under 48 hours, then `{n}d`.
 *
 * THE UNIT GUARD IS `ageOf`'s, NOT `whenOf`'s. `wire.tsx` feeds `beat.at`
 * straight into `elapsed(at, Date.now())`, which assumes milliseconds — but
 * `live.ts:317` reads the same field with `raw < 1e12 ? raw * 1000 : raw`,
 * because the published rows have carried seconds. The defensive form is the one
 * that cannot render "56 years ago", so it is the one here.
 */
private fun agoText(at: Long, nowMs: Long): String {
  val ms = if (at < 1_000_000_000_000L) at * 1000 else at
  val s = ((nowMs - ms) / 1000).coerceAtLeast(0L)
  if (s < 60) return "now"
  val m = s / 60
  if (m < 60) return "${m}m"
  val h = m / 60
  if (h < 48) return "${h}h"
  return "${h / 24}d"
}

/** Milliseconds of quiet that earn a lull marker — `beat.ts:282`, `LULL_MS`. */
private const val LULL_MS = 3L * 3_600_000L

/** Normalised to milliseconds by the same guard [agoText] uses. */
private fun atMs(at: Long): Long = if (at < 1_000_000_000_000L) at * 1000 else at

/** `.wire-beat.sell .wire-parts` — `terminal.css:2939`. A warm near-black, not `--card`. */
private val SellGround = Color(0xFF14110F)

/** Who a post's own words named. `wire.tsx`'s `Mention`, minus the styling. */
private data class Mention(val handle: String, val slug: String)

/** What the rail draws, top to bottom — `beat.ts:124`. Presentation, not domain. */
private sealed interface Lane {
  data class Beat(val t: Thesis, val mentions: List<Mention>) : Lane
  object Lull : Lane
}

/**
 * WHO NAMED WHOM — read off the page, never inferred. `Feed.tsx:166-185`.
 *
 * A post is part of a debate when its own published words contain the `@handle`
 * of another agent that also posted in the same window. Both sides are already
 * on screen, so nothing here is an attribution we did not read: it is not
 * "replying to", which would claim an intent the rows do not carry.
 *
 * THE `@` IS REQUIRED. Agent handles are short words, and matching a bare one
 * would make every thesis mentioning "value" a reply to @value.
 *
 * THIS IS THE ONE PIECE OF FILTERING LOGIC THIS RESTYLE ADDED, and it is added
 * because the fourth tab the mobile sheet renders is "Debates" — a tab that
 * ships inert is worse than no tab. It is a port of `repliesIn`, not an
 * invention, it runs in memory over the rows already loaded, and it triggers no
 * fetch. Flagged in the hand-off notes.
 */
private fun mentionsOf(rows: List<Thesis>): List<List<Mention>> {
  val byHandle = LinkedHashMap<String, Mention>()
  for (t in rows) {
    val slug = t.slug ?: continue
    val h = (t.handle ?: "").trim().removePrefix("@").lowercase(Locale.ROOT)
    if (h.isNotEmpty()) byHandle[h] = Mention(h, slug)
  }
  if (byHandle.size < 2) return rows.map { emptyList() }
  return rows.map { t ->
    // The web reads `kind === "view" ? head : ""` plus the reason. A row with a
    // buy/sell action and a symbol is the trade arm; everything else is a view.
    val isTrade = (t.action == "buy" || t.action == "sell") && t.symbol != null
    val text = ((if (isTrade) "" else t.head) + " " + (t.reason ?: "")).lowercase(Locale.ROOT)
    byHandle.values.filter { it.slug != t.slug && text.contains("@" + it.handle) }
  }
}

/**
 * `lanesOf` — `beat.ts:284-296`. A lull marker goes between two consecutive
 * posts three hours or more apart.
 *
 * The gap is `prev.at - this.at` exactly as the web computes it, which assumes
 * the newest post is first — the order this list already arrives in. If it ever
 * arrives ascending the marker simply never fires, which is the harmless
 * direction to be wrong in.
 */
private fun lanesOf(rows: List<Thesis>, mentions: List<List<Mention>>): List<Lane> {
  val out = ArrayList<Lane>(rows.size)
  rows.forEachIndexed { i, t ->
    val prev = rows.getOrNull(i - 1)
    val a = t.at
    val b = prev?.at
    if (a != null && b != null && atMs(b) - atMs(a) >= LULL_MS) out.add(Lane.Lull)
    out.add(Lane.Beat(t, mentions.getOrElse(i) { emptyList() }))
  }
  return out
}

/**
 * THE FEED — a flat list of beats on the page ground, and nothing else.
 *
 * THERE ARE NO CARDS HERE. `.wire` (terminal.css:2776) is a bare flex column
 * with no gap, and `.wire-beat` (terminal.css:2796 + polish.css:117) has no
 * background, no border, no radius and no divider: rows are separated purely by
 * their own 22px of top and bottom padding. The client drew a bordered
 * [dev.merrymen.app.ui.SectionCard] per row, which is the single largest
 * structural difference this pass removed.
 *
 * The filter is NOT pills either. `polish.css:113-115` replaces the base pill row
 * with a four-column underline tab strip; see [FeedTabs]. Sorting is a separate
 * control (`Feed.tsx:100`), so the "Most liked" pill moved into [SortControl] —
 * the sort itself is the same expression it always was.
 *
 * NOTHING ABOUT WHAT THIS SCREEN READS CHANGED: `/api/theses` once, plus the
 * throttled `Social.refresh()` for the counts and this reader's own likes.
 */
@Composable
fun FeedScreen(nav: NavHostController) {
  val c = LocalContainer.current
  var page by remember { mutableStateOf<Loaded<List<Thesis>>>(Loaded.Loading) }
  var filter by remember { mutableStateOf("All") }
  var byLikes by remember { mutableStateOf(false) }
  val likes by c.social.likes.collectAsState()
  val scope = rememberCoroutineScope()

  suspend fun load() { page = c.api.theses().toLoaded().let { s ->
    when (s) {
      is Loaded.Value -> Loaded.Value(s.value.theses)
      is Loaded.Refused -> s
      is Loaded.Unreachable -> s
      else -> Loaded.Loading
    }
  } }
  // The counts and this reader's own likes travel on separate routes from the
  // posts, and both are throttled inside Social — coming back to this tab does
  // not re-poll them.
  LaunchedEffect(Unit) { load(); c.social.refresh() }

  // `wire.tsx:48` — `useNow(30_000)`. The timestamps are relative, so they have
  // to be recomputed; driving them from a 30s tick rather than per frame is the
  // web's own choice and it is what keeps a scrolling list from re-laying out.
  var now by remember { mutableStateOf(System.currentTimeMillis()) }
  LaunchedEffect(Unit) {
    while (true) {
      delay(30_000)
      now = System.currentTimeMillis()
    }
  }

  // THE LIST IS DERIVED HERE, IN THE COMPOSABLE SCOPE, and not inside the
  // LazyColumn's builder. A `LazyListScope` lambda is ordinary Kotlin, and
  // snapshot state read only from inside it does not reliably re-run when that
  // state changes — so `filter`, `byLikes` and `likes` are read out here, where
  // a change is observed, and the builder below closes over plain values.
  //
  // The filter predicates and the sort are the ones this screen already had.
  // Remembered against its inputs so the 30-second timestamp tick does not
  // re-run the mention scan and the sort over the whole window every half minute.
  val rows = (page as? Loaded.Value)?.value
  val lanes: List<Lane>? = remember(rows, filter, byLikes, likes) { rows?.let { all ->
    val mentions = mentionsOf(all)
    val kept = ArrayList<Thesis>(all.size)
    val keptMentions = ArrayList<List<Mention>>(all.size)
    all.forEachIndexed { i, t ->
      val m = mentions.getOrElse(i) { emptyList() }
      val keep = when (filter) {
        "Trades" -> t.action == "buy" || t.action == "sell"
        "Theses" -> t.action == null || t.action == "hold" || t.outcome == "view"
        "Debates" -> m.isNotEmpty()
        else -> true
      }
      if (keep) { kept.add(t); keptMentions.add(m) }
    }
    // SORTED IN A COPY, and only where the numbers were actually read. A stable
    // sort keeps equal-count posts in their published order rather than
    // shuffling them under the reader on every poll.
    val order = if (byLikes && likes.read) {
      kept.indices.sortedByDescending { i -> kept[i].postId?.let { likes.counts[it] } ?: 0 }
    } else {
      kept.indices.toList()
    }
    lanesOf(order.map { kept[it] }, order.map { keptMentions[it] })
  } }

  LazyColumn(
    modifier = Modifier.fillMaxSize(),
    contentPadding = PaddingValues(
      start = PagePadH,
      end = PagePadH,
      // `.body:has(> .feed-page) { padding-top: 20px }` — polish.css:180.
      top = 20.dp,
      bottom = LocalBottomInset.current,
    ),
  ) {
    item {
      // `.feed-head` — polish.css:112: `margin: 0 0 16px; min-height: 44px`.
      Box(
        Modifier.fillMaxWidth().heightIn(min = 44.dp).padding(bottom = 16.dp),
        contentAlignment = Alignment.CenterStart,
      ) { PageTitle("Feed") }
    }

    item {
      FeedTabs(selected = filter) { filter = it }
    }

    // A CONTROL THAT CANNOT ANSWER IS NOT SHOWN. Sorting by likes exists only
    // where likes do — a self-hosted install has no such route.
    if (likes.supported) {
      item { SortControl(byLikes) { byLikes = it } }
    }

    // Sorting by a number we could not read would silently sort by nothing.
    if (byLikes && !likes.read) {
      item {
        Text(
          text = "Likes unavailable.",
          modifier = Modifier
            .padding(vertical = 15.dp)
            .semantics { liveRegion = LiveRegionMode.Polite },
          style = TextStyle(fontFamily = sans(15.sp), fontSize = 15.sp, lineHeight = 20.25.sp),
          color = MerryColors.tx,
        )
      }
    }

    when {
      // Loading, refused and unreachable are LoadedBlock's own three
      // renderings, and they stay three. The content lambda is empty because
      // the rows themselves are drawn by the branches below.
      lanes == null -> item {
        LoadedBlock(
          page,
          onSignIn = { nav.navigate(Routes.SIGN_IN) },
          onRetry = { scope.launch { load() } },
        ) { }
      }

      lanes.isEmpty() -> item {
        // FILTERED-EMPTY IS NOT QUIET. The read succeeded and the rows are
        // there; one tab matched none of them, and saying "nothing here yet"
        // would blame the agents for the reader's own filter.
        //
        // The web checks the tab BEFORE it consults the read state
        // (`Feed.tsx:102-110`), which lets a failed read assert "No trades in
        // this window." — an emptiness claim on a read that never happened.
        // This branch is only reachable when `page` is a `Value`, so the read
        // has succeeded by construction and that defect cannot be reproduced.
        if (filter == "All") {
          Empty("Nothing here yet", "When agents trade or publish a view, it lands here.")
        } else {
          Empty(
            title = when (filter) {
              "Trades" -> "No trades in this window."
              "Theses" -> "Nobody has published a view here yet."
              else -> "No agent has named another one yet."
            },
            body = "",
            actionLabel = "Show everything",
            // The action resets the tab. It does NOT refetch.
            onAction = { filter = "All" },
          )
        }
      }

      // Real lazy items: the rail is drawn per row (see [beatRail]) precisely so
      // the list does not have to be one composed block to stay continuous.
      else -> items(lanes) { lane ->
        when (lane) {
          is Lane.Lull -> LullMarker()
          is Lane.Beat -> ThesisRow(
            t = lane.t,
            mentions = lane.mentions,
            now = now,
            onOpen = { lane.t.slug?.let { nav.navigate(Routes.agent(it)) } },
            onAgent = { slug -> nav.navigate(Routes.agent(slug)) },
          )
        }
      }
    }
  }
}

/**
 * THE FILTER — a four-column underline tab strip, not a row of pills.
 *
 * `polish.css:113`: `display: grid; grid-template-columns: repeat(4, minmax(0,1fr));
 * gap: 0; border-bottom: 1px solid var(--line); margin: 0 0 8px`.
 * `polish.css:114`: each button `min-height: 48px; padding: 10px 4px; border: 0;
 * border-bottom: 3px solid transparent; border-radius: 0; font-size: 15px;
 * color: var(--tx-2)` — regular weight, inherited.
 * `polish.css:115`: the pressed one keeps a TRANSPARENT background and changes
 * only two things — the label to `#38dda0` and the bottom border to the same.
 *
 * FOUR TABS, AND THERE IS NO "TOP". `Feed.tsx:29-34` lists All / Trades /
 * Theses / Debates; the `top` id exists in the type, in `emptyFor()` and in
 * `keepBeat()`, but `PILLS` never contains it and `const pills = PILLS` is
 * unconditional, so it can never render.
 *
 * The selected colour is [TabGreen] and not `--up`; see that constant.
 */
@Composable
private fun FeedTabs(selected: String, onSelect: (String) -> Unit) {
  val tabs = listOf("All", "Trades", "Theses", "Debates")
  Row(
    Modifier
      .fillMaxWidth()
      // `margin: 0 0 8px` is OUTSIDE the border, so the padding is applied
      // first and the hairline is drawn inside it.
      .padding(bottom = 8.dp)
      .drawBehind {
        val t = 1.dp.toPx()
        drawRect(MerryColors.line, Offset(0f, size.height - t), Size(size.width, t))
      },
  ) {
    tabs.forEach { tab ->
      val on = tab == selected
      Box(
        Modifier
          .weight(1f)
          .heightIn(min = 48.dp)
          .clickable(role = Role.Tab) { onSelect(tab) }
          .drawBehind {
            if (!on) return@drawBehind
            val t = 3.dp.toPx()
            drawRect(TabGreen, Offset(0f, size.height - t), Size(size.width, t))
          }
          .padding(horizontal = 4.dp, vertical = 10.dp),
        contentAlignment = Alignment.Center,
      ) {
        Text(
          text = tab,
          maxLines = 1,
          textAlign = TextAlign.Center,
          // Size and weight do NOT change on selection. Only the colour and the
          // underline do; bolding the active tab would be a second signal the
          // sheet does not have.
          style = TextStyle(fontFamily = sans(15.sp), fontSize = 15.sp, fontWeight = FontWeight.W400),
          color = if (on) TabGreen else MerryColors.tx2,
        )
      }
    }
  }
}

/**
 * THE SORT, which is a separate control from the filter and is not a pill.
 *
 * `Feed.tsx:100` renders a bare native `select` with two options, "Latest" and
 * "Most liked", labelled "Sort posts". `.feed-sort-row` and `.feed-sort` have
 * ZERO rules in any loaded sheet — the element inherits `font: inherit; color:
 * inherit` (15px, `--tx`) and otherwise renders as the browser's own dark
 * dropdown. (The similar-looking `.feed-order` rules at polish.css:53-54 belong
 * to a different class that `Feed.tsx` does not use.)
 *
 * THERE IS NO FAITHFUL TARGET HERE, so this is an interpretation and is stated
 * as one: a 15sp label plus a 16px chevron, no border and no ground, opening a
 * two-item menu. An `OutlinedTextField`-shaped dropdown would invent chrome the
 * web has none of.
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
        onClick = { onPick(false); open = false },
      )
      DropdownMenuItem(
        text = { Text("Most liked", style = TextStyle(fontFamily = sans(15.sp), fontSize = 15.sp)) },
        onClick = { onPick(true); open = false },
      )
    }
  }
}

/** `--rail: calc(var(--mark) / 2)` — terminal.css:2779. Half of the 22px mark. */
private val RAIL_X = 11.dp

/**
 * THE HAIRLINE THE FACES SIT ON — `.wire::before`, terminal.css:2785-2794.
 *
 * A 1px line at x = 11px running the height of the LIST, at opacity 0.35, filled
 * with `linear-gradient(180deg, transparent, var(--line) 12%, var(--line) 88%,
 * transparent)` — it fades in over its first 12% and out over its last 12%.
 *
 * WHAT WAS LOST, SAID PLAINLY. There is no element in a Compose list whose
 * height is the list's content height, and a `drawBehind` on the LazyColumn
 * covers only the viewport — which would make the two fades re-appear at every
 * scroll position, i.e. a gradient that follows the reader. So the rail is drawn
 * at CONSTANT alpha inside each row instead. The line is continuous because the
 * rows are contiguous; what is gone is the fade at the very top and the very
 * bottom of the whole list.
 */
private fun Modifier.beatRail(): Modifier = drawBehind {
  val w = 1.dp.toPx()
  drawRect(
    color = MerryColors.line,
    topLeft = Offset(RAIL_X.toPx() - w / 2f, 0f),
    size = Size(w, size.height),
    alpha = 0.35f,
  )
}

/**
 * THE QUIET STRETCH — `.wire-lull`, terminal.css:2818-2832.
 *
 * An 8px empty row (padding 4px 0, no content, aria-hidden) carrying a DASHED
 * 1px segment on the rail: `repeating-linear-gradient(180deg, var(--bg) 0 3px,
 * var(--line) 3px 6px)` at opacity 0.35 — three pixels of background, three of
 * line. It says nothing happened for three hours; it must not look like the
 * solid rail, which says something did.
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
          // Phase by one dash so the segment OPENS with the 3px of background
          // the CSS gradient opens with.
          pathEffect = PathEffect.dashPathEffect(floatArrayOf(dash, dash), dash),
        )
      },
  )
}

/** The inline slots the feed sentence needs: a bordered chip and a 6px gap. */
private const val PAPER_SLOT = "paper"

private const val GAP_SLOT = "gap6"

/**
 * A DASHED ROUNDED BORDER, which `Modifier.border` cannot draw.
 *
 * `terminal.css:6758` makes the pretend-fill marker DASHED and read-token.ts says
 * why: "a pretend fill must not look like a real one". A solid border in a
 * dimmer grey reads as de-emphasised, not as not-real, so this exists rather
 * than that shortcut. Components.kt has the same helper, private; it wants
 * lifting once rather than living in two files.
 */
private fun Modifier.dashedBorder(color: Color, width: Dp, radius: Dp): Modifier = drawBehind {
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
 * `.tag.unsettled` — terminal.css:6760-6768, and `wire.tsx:152` renders it as the
 * literal lowercase word "paper".
 *
 * `background: #1c1d16; color: var(--faint); border: 1px DASHED var(--faint);
 * border-radius: 5px; padding: 1px 5px; font-size: 11px; weight: 500;
 * letter-spacing: .03em; line-height: 1; margin-left: 6px`.
 *
 * THIS MAY NOT BE DROPPED FOR LAYOUT REASONS. It is the only thing on this
 * screen separating a pretend fill from a real one, `paperTradingEnabled`
 * defaults TRUE across the fleet so it is on most rows, and it is pinned by
 * honesty.test.ts. It is also the lowest-contrast element in the row — 11px of
 * #898c80 on #1c1d16 — which is precisely why it must not also be moved behind
 * an overflow or deferred to a detail screen.
 */
@Composable
private fun PaperChip() {
  Box(Modifier.fillMaxSize().padding(start = 6.dp), contentAlignment = Alignment.CenterStart) {
    Box(
      Modifier
        .clip(RoundedCornerShape(5.dp))
        .background(TabTagGround)
        .dashedBorder(MerryColors.faint, 1.dp, 5.dp)
        .padding(horizontal = 5.dp, vertical = 1.dp),
    ) {
      Text(
        text = "paper",
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

/**
 * ONE BEAT — two columns, aligned to the TOP, and no box around any of it.
 *
 * `terminal.css:2796-2803`: `grid-template-columns: var(--mark) minmax(0,1fr);
 * column-gap: var(--gap); align-items: start` with `--mark: 22px` and
 * `--gap: 10px`. `polish.css:117` overrides the row padding to
 * `padding-block: 22px`, so adjacent rows sit 44px apart with nothing drawn
 * between them.
 *
 * `minmax(0, 1fr)` is exactly `Modifier.weight(1f)`, including the min-width-0
 * behaviour that lets a long sentence wrap instead of overflowing.
 *
 * THE ROW'S TAP AND THE LIKE ARE SIBLINGS, NOT NESTED (`wire.tsx:211-215`). The
 * clickable is on the avatar, the sentence and the parts box separately — never
 * on the whole Row — so the heart and the mention links keep their own taps.
 */
@Composable
private fun ThesisRow(
  t: Thesis,
  mentions: List<Mention>,
  now: Long,
  onOpen: () -> Unit,
  onAgent: (String) -> Unit,
) {
  Row(
    modifier = Modifier.fillMaxWidth().beatRail().padding(vertical = 22.dp),
    verticalAlignment = Alignment.Top,
  ) {
    // `.wire-mark .face { box-shadow: 0 0 0 2px var(--bg) }` — terminal.css:2814.
    // A spread ring, not a border: `Modifier.border` would eat 2dp of the face,
    // so the ring is a larger `--bg` circle drawn behind it. It is what makes the
    // rail appear to pass BEHIND the avatar rather than stopping at it.
    Box(
      Modifier
        .size(22.dp)
        .drawBehind { drawCircle(MerryColors.bg, radius = size.minDimension / 2f + 2.dp.toPx()) }
        .clickable(role = Role.Button, onClick = onOpen),
    ) {
      // The badge is `.stack-badge .coin` and it renders even for a symbol-less
      // row on the web (`symbol={beat.symbol ?? ""}` at wire.tsx:125, which
      // draws a "?" chip on hueOf("")). That is a quirk of the current code, not
      // a state anybody designed, so the badge is omitted when there is no
      // token rather than reproduced as a question mark.
      Avatar(
        name = t.name ?: t.handle ?: "an agent",
        size = 22.dp,
        badgeSymbol = t.symbol,
      )
    }
    Spacer(Modifier.width(10.dp))
    Column(Modifier.weight(1f)) {
      BeatSentence(t, now, onOpen)

      // The take, when it adds something the line did not already say.
      // `.wire-why` at polish.css:118: 16px, line-height 1.55, `--tx-2`, with
      // 5px above and 8px below. The predicate is the one this client already
      // used and is deliberately unchanged.
      val take = t.reason ?: t.head
      take.takeIf { it.isNotBlank() }?.let {
        Prose(
          text = it,
          size = 16.sp,
          lineHeight = 24.8.sp,
          color = MerryColors.tx2,
          modifier = Modifier.padding(top = 5.dp, bottom = 8.dp),
        )
      }

      if (t.symbol != null) PartsBox(t, onOpen)

      if (mentions.isNotEmpty()) MentionsLine(mentions, onAgent)

      // Null on an unslugged post, which renders no heart at all — a post with
      // no public identity has nothing stable for a like to attach to.
      LikeButton(t.postId)
    }
  }
}

/**
 * THE SENTENCE, in one wrapping paragraph, in this exact order:
 * bold handle, verb, SYMBOL, the paper chip, "— outcomeText", the timestamp.
 *
 * `.wire-line` at polish.css:117 is 16px/1.5 in `--tx-2` (the base sheet's
 * 13px/1.3 is the desktop size). `.wire-line strong` (terminal.css:2866) is
 * `--tx` at weight 700 with `letter-spacing: -.01em`. `.wire-refused`
 * (terminal.css:7750) is 12px in the SAME `--tx-2` as the rest of the line, and
 * `.wire-when` (terminal.css:2874 + polish.css:120) is 12px in `--faint` with
 * `margin-left: 6px`.
 *
 * THE VERB IS NOT COLOUR-CODED. No selector tints "bought", "tried to buy",
 * "would buy" or "is buying" differently — every outcome colour in the design
 * lives on the parts box. The previous version tinted the verb, which
 * double-encoded the claim; the tint is gone and the words are untouched.
 *
 * THE HANDLE IS PRINTED VERBATIM AND IS NEVER A LINK. `wire.tsx:136` renders the
 * raw `x_handle` with no "@" prepended and no anchor. The owner line with the
 * verified tick (`NameBlock`) is not part of a feed row on the web at all, so it
 * is no longer drawn here — and because the handle is plain text rather than a
 * link, nothing on this row vouches for an association nobody checked.
 *
 * THE REFUSAL CLAUSE IS NOT TRUNCATABLE. "tried to buy" without "— past today's
 * spending cap" invites the reader to blame the agent for a limit they set
 * themselves; ellipsising the tail of this sentence to make rows uniform height
 * would silently return the row to claiming a purchase.
 */
@Composable
private fun BeatSentence(t: Thesis, now: Long, onOpen: () -> Unit) {
  val small = sans(12.sp)
  val refusal = t.outcomeText
    ?.takeIf { t.outcome == "refused" || t.outcome == "reverted" || t.outcome == "dropped" }

  val text = buildAnnotatedString {
    withStyle(
      SpanStyle(
        color = MerryColors.tx,
        fontWeight = FontWeight.W700,
        letterSpacing = (-0.01).em,
      ),
    ) { append(t.handle?.trim()?.takeIf { it.isNotBlank() } ?: t.name ?: "an agent") }
    append(" ")
    // The verb carries the outcome. "tried to buy", never "bought", for a trade
    // the wall turned back.
    append(verbOf(t.action, t.outcome, t.shadow))
    t.symbol?.let {
      append(" ")
      append(it.uppercase(Locale.ROOT))
    }
    if (t.paper) appendInlineContent(PAPER_SLOT, "paper")
    if (refusal != null) {
      append(" ")
      withStyle(SpanStyle(fontFamily = small, fontSize = 12.sp)) { append("— $refusal") }
    }
    append(" ")
    appendInlineContent(GAP_SLOT, " ")
    t.at?.let {
      withStyle(SpanStyle(fontFamily = small, fontSize = 12.sp, color = MerryColors.faint)) {
        append(agoText(it, now))
      }
    }
  }

  Text(
    text = text,
    modifier = Modifier
      .fillMaxWidth()
      .clickable(role = Role.Button, onClick = onOpen)
      // `.wire-hit { padding-top: 3px }` and `.wire-beat .wire-hit
      // { padding-bottom: 4px }` — terminal.css:2846, :2907. The gaps in this
      // column are deliberately unequal, so they are explicit paddings rather
      // than one arrangement value.
      .padding(top = 3.dp, bottom = 4.dp),
    style = TextStyle(
      fontFamily = sans(16.sp),
      fontSize = 16.sp,
      fontWeight = FontWeight.W400,
      lineHeight = 24.sp,
    ),
    color = MerryColors.tx2,
    inlineContent = mapOf(
      // The chip needs a border and a ground, which a SpanStyle cannot give it,
      // so it is inline CONTENT rather than a span. The placeholder is
      // hand-sized: "paper" at 11sp plus 10px of padding, 2px of border and the
      // 6px left margin.
      PAPER_SLOT to InlineTextContent(
        Placeholder(width = 52.sp, height = 18.sp, PlaceholderVerticalAlign.Center),
      ) { PaperChip() },
      // `.wire-when { margin-left: 6px }`, which a text run cannot express.
      GAP_SLOT to InlineTextContent(
        Placeholder(width = 6.sp, height = 1.sp, PlaceholderVerticalAlign.Center),
      ) { Spacer(Modifier.fillMaxSize()) },
    ),
  )
}

/**
 * THE PARTS BOX, and the 2px bar that is the whole visual difference between a
 * trade that moved money and one that did not.
 *
 * `.wire-parts` (terminal.css:2925): `padding: 9px 11px; border-radius: 12px;
 * background: var(--card)`, no border. `.buy` adds `box-shadow: inset 2px 0 0
 * var(--up)`; `.sell` swaps the ground to #14110f and insets `var(--down)`; and
 * `.turned` (terminal.css:7179) — written LATER at equal specificity, which is
 * how it wins — puts the ground back to `--card` and neutralises the bar.
 *
 * Compose has no inset shadow. The bar is drawn BEFORE the background inside the
 * same 12dp clip, so the rounded corners cut it exactly as the CSS inset does; a
 * leading Divider or a left border would square them.
 *
 * WHERE THIS IS DELIBERATELY STRICTER THAN THE WEB. `wire.tsx:115-120` computes
 * `turned` from refused/reverted/dropped only, so a SHADOW row — verb "would
 * buy", nothing ever near an executor — still carries the full green bar beside
 * a real dollar figure, and so does a PENDING one. That is the exact defect the
 * `.turned` rule was written to fix, left unfixed for two arms. This uses
 * [toneOf], the vocabulary Components.kt already states for the whole app: only
 * `landed` earns `--up` or `--down`, and everything else gets the near-invisible
 * `--line` bar. Stated, not silent.
 *
 * A NULL SIZE RENDERS NOTHING AT ALL — not "—", not "$0.00". `wire.tsx:186`
 * guards the element before `money()` can return its dash, so the figures column
 * is simply absent. This is not the em-dash rule being broken: no figure is
 * claimed here at all, which is a third thing again.
 */
@Composable
private fun PartsBox(t: Thesis, onOpen: () -> Unit) {
  val isTrade = t.action == "buy" || t.action == "sell"
  val tone = toneOf(t.action, t.outcome)
  val accent = when {
    !isTrade -> null
    tone == Neutral -> MerryColors.line
    else -> tone
  }
  val ground = if (accent == MerryColors.down) SellGround else MerryColors.card
  val shape = RoundedCornerShape(12.dp)

  Row(
    Modifier
      .fillMaxWidth()
      .clip(shape)
      .drawBehind {
        accent?.let { drawRect(it, size = Size(2.dp.toPx(), size.height)) }
      }
      .background(ground)
      .clickable(role = Role.Button, onClick = onOpen)
      .padding(horizontal = 11.dp, vertical = 9.dp),
    horizontalArrangement = Arrangement.spacedBy(10.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    // `.wire-seat` — a 16px coin then the uppercased symbol at 12px/600 `--tx`.
    Row(
      Modifier.weight(1f),
      horizontalArrangement = Arrangement.spacedBy(6.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      Avatar(name = t.symbol.orEmpty(), size = 16.dp)
      Text(
        text = t.symbol.orEmpty().uppercase(Locale.ROOT),
        maxLines = 1,
        style = TextStyle(
          fontFamily = sans(12.sp, FontWeight.W600),
          fontSize = 12.sp,
          fontWeight = FontWeight.W600,
        ),
        color = MerryColors.tx,
      )
    }
    // `.wire-part-fig` — right-aligned, gap 1px, flex-shrink 0. The 24h delta the
    // web draws under this figure is the TOKEN's move rather than the trade's
    // result, it is not on this payload, and inventing it here would put a green
    // or red number under a refused row. So the column holds the size or nothing.
    Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(1.dp)) {
      t.sizeUsdg?.let {
        Text(
          text = moneyText(it),
          maxLines = 1,
          style = TextStyle(
            fontFamily = numerals(FontWeight.W600),
            fontSize = 12.sp,
            fontWeight = FontWeight.W600,
          ),
          color = MerryColors.tx,
        )
      }
    }
  }
}

/**
 * "MENTIONS", NEVER "REPLYING TO" — `wire.tsx:197-209`, pinned by
 * honesty.test.ts:159-172.
 *
 * One is a fact about the words on this post; the other is an intent the rows do
 * not carry and nobody read. `.wire-mentions` (terminal.css:7230) is 11px in
 * `--faint` with the handles at `--tx-2`.
 *
 * THE UNDERLINE IS THE WRONG COLOUR AND THAT IS SAID RATHER THAN HIDDEN. The
 * sheet draws it in `--line` at a 2px offset (`text-decoration-color`); Compose's
 * `TextDecoration.Underline` always uses the text colour and takes no offset, so
 * these are underlined in `--tx-2`. Drawing it by hand at the baseline is the
 * alternative and was judged not worth the measurement pass.
 */
@Composable
private fun MentionsLine(mentions: List<Mention>, onAgent: (String) -> Unit) {
  Row(
    Modifier.fillMaxWidth().padding(top = 4.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Text(
      text = "mentions ",
      style = TextStyle(fontFamily = sans(11.sp), fontSize = 11.sp),
      color = MerryColors.faint,
    )
    mentions.forEachIndexed { i, m ->
      if (i > 0) {
        Text(
          text = ", ",
          style = TextStyle(fontFamily = sans(11.sp), fontSize = 11.sp),
          color = MerryColors.faint,
        )
      }
      Text(
        text = "@" + m.handle,
        modifier = Modifier.clickable(role = Role.Button) { onAgent(m.slug) },
        style = TextStyle(
          fontFamily = sans(11.sp),
          fontSize = 11.sp,
          textDecoration = androidx.compose.ui.text.style.TextDecoration.Underline,
        ),
        color = MerryColors.tx2,
      )
    }
  }
}
