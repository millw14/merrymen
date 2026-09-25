package dev.merrymen.app.ui.screens

import androidx.compose.foundation.Canvas
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
import androidx.compose.foundation.layout.size
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
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.navigation.NavHostController
import dev.merrymen.app.LocalContainer
import dev.merrymen.app.data.Loaded
import dev.merrymen.app.net.AgentProfile
import dev.merrymen.app.net.OwnBook
import dev.merrymen.app.net.ProfileTrade
import dev.merrymen.app.net.ownBook
import dev.merrymen.app.net.ownSlugOf
import dev.merrymen.app.net.valueOrNull
import dev.merrymen.app.ui.AgentBanner
import dev.merrymen.app.ui.AgentFace
import dev.merrymen.app.ui.ChartWindow
import dev.merrymen.app.ui.Empty
import dev.merrymen.app.ui.EmptyKind
import dev.merrymen.app.ui.FigureSign
import dev.merrymen.app.ui.LikeButton
import dev.merrymen.app.ui.LoadedBlock
import dev.merrymen.app.ui.LocalBottomInset
import dev.merrymen.app.ui.MerryColors
import dev.merrymen.app.ui.NameBlock
import dev.merrymen.app.ui.Notice
import dev.merrymen.app.ui.PageGap
import dev.merrymen.app.ui.PagePadH
import dev.merrymen.app.ui.PagePadTop
import dev.merrymen.app.ui.ProfileList
import dev.merrymen.app.ui.ProfileReads
import dev.merrymen.app.ui.Routes
import dev.merrymen.app.ui.SwapTab
import dev.merrymen.app.ui.SwapView
import dev.merrymen.app.ui.WindowSlice
import dev.merrymen.app.ui.WireButton
import dev.merrymen.app.ui.chartWindows
import dev.merrymen.app.ui.decisionSize
import dev.merrymen.app.ui.decisionsList
import dev.merrymen.app.ui.defaultWindow
import dev.merrymen.app.ui.drawdownLine
import dev.merrymen.app.ui.fillsList
import dev.merrymen.app.ui.feed.Beat
import dev.merrymen.app.ui.feed.PillTone
import dev.merrymen.app.ui.feed.ReadState
import dev.merrymen.app.ui.feed.TradeBeat
import dev.merrymen.app.ui.feed.ViewBeat
import dev.merrymen.app.ui.feed.countText
import dev.merrymen.app.ui.feed.elapsedText
import dev.merrymen.app.ui.feed.failureOf
import dev.merrymen.app.ui.feed.lineOf
import dev.merrymen.app.ui.feed.pctBps
import dev.merrymen.app.ui.feed.pillOf
import dev.merrymen.app.ui.feed.pollWhileResumed
import dev.merrymen.app.ui.feed.sayOf
import dev.merrymen.app.ui.feed.staleLine
import dev.merrymen.app.ui.feed.usd
import dev.merrymen.app.ui.gasLine
import dev.merrymen.app.ui.growthPointsOf
import dev.merrymen.app.ui.growthWindow
import dev.merrymen.app.ui.holdingDetail
import dev.merrymen.app.ui.numerals
import dev.merrymen.app.ui.ownBookOf
import dev.merrymen.app.ui.returnOf
import dev.merrymen.app.ui.sans
import dev.merrymen.app.ui.showMoneyOf
import dev.merrymen.app.ui.statsParts
import dev.merrymen.app.ui.strategyName
import dev.merrymen.app.ui.strategyOfHow
import dev.merrymen.app.ui.swapRows
import dev.merrymen.app.ui.thesisOfHow
import dev.merrymen.app.ui.topTradeFigures
import dev.merrymen.app.ui.topTradesList
import dev.merrymen.app.ui.wireOffered
import kotlinx.coroutines.launch

/**
 * lucide `ArrowLeft` at `size={18} strokeWidth={1.8}` — the glyph
 * `screens/Profile.tsx` puts in `.profile-back`.
 */
@Composable
private fun ArrowLeftIcon(tint: Color, size: Dp = 18.dp) {
  val shaft = remember { PathParser().parsePathString("M19 12H5").toPath() }
  val head = remember { PathParser().parsePathString("m12 19-7-7 7-7").toPath() }
  Canvas(Modifier.size(size)) {
    val s = this.size.minDimension / 24f
    scale(s, s, pivot = Offset.Zero) {
      val stroke = Stroke(width = 1.8f, cap = StrokeCap.Round, join = StrokeJoin.Round)
      drawPath(shaft, tint, style = stroke)
      drawPath(head, tint, style = stroke)
    }
  }
}

/** Whose agent this is, once the reader's own feed has been asked. */
private sealed interface OwnAgent {
  data object Asking : OwnAgent

  /** Settled: the reader's own slug, or null when they have none we read. */
  data class Known(val slug: String?) : OwnAgent
}

/**
 * AN AGENT'S PAGE, from its own read — /api/agents/{slug} — and not from the
 * global feed window.
 *
 * It filtered the 24-hour, per-lane-capped /api/theses by slug, so an agent
 * whose posts fell outside the cap read "has not posted inside the current
 * window". The route answers for this one agent, with thirty days of its own
 * decisions and whether they could be read at all, and with everything the web
 * profile shows: the stats line, the return (a paper book's labelled Paper),
 * the growth chart in the windows its history backs, TOP TRADES, the fills and
 * the book when it is public.
 *
 * DOLLARS ONLY WHERE THEY MAY BE SHOWN: a book its owner published, or the
 * owner's own view, which comes from /api/agents/{slug}/own — a read the SERVER
 * answers only for the session that owns the slug. A stranger's view of a
 * private book has no dollar figure on it anywhere.
 *
 * NO WIRE CONTROL ON YOUR OWN AGENT. An agent already reads its own posts, and
 * the server refuses the self-follow; the control is not offered in the first
 * place, and it waits until the reader's own agent is known so it never
 * flashes onto their own page.
 */
@Composable
fun AgentDetailScreen(nav: NavHostController, slug: String) {
  val c = LocalContainer.current
  val reads = remember(c.api, slug) { ProfileReads(c.api, slug) }
  val slot by reads.profile.collectAsState()
  val signedIn by c.repo.signedIn.collectAsState()
  val identityKnown by c.repo.identityKnown.collectAsState()
  val lifecycle = LocalLifecycleOwner.current.lifecycle
  val scope = rememberCoroutineScope()
  LaunchedEffect(lifecycle, reads) { lifecycle.pollWhileResumed(listOf(reads.loop)) }
  LaunchedEffect(slug) {
    // What this owner's agent already reads, and this reader's own likes. Both
    // throttled — walking back and forth between desks does not re-poll.
    c.social.refreshWired()
    c.social.refresh()
  }

  // WHOSE AGENT IS THIS — asked once per wallet. Keyed on the wallet, so a
  // sign-out or a wallet switch starts over rather than carrying the last
  // wallet's answer; and not settled while the session itself is unanswered
  // (a cold start, a server change), when "signed out" is only the default.
  val ownAgent by produceState<OwnAgent>(OwnAgent.Asking, signedIn, identityKnown) {
    // Back to asking first: the last wallet's answer must not stand while the
    // new wallet's feed is on its way.
    value = OwnAgent.Asking
    value = when {
      !identityKnown -> OwnAgent.Asking
      signedIn == null -> OwnAgent.Known(null)
      else -> OwnAgent.Known(ownSlugOf(c.api.feed().valueOrNull()))
    }
  }
  val profile = slot.body.takeIf { slot.state == ReadState.OK }

  // THE OWNER'S OWN FIGURES, asked only for a private book and only while
  // signed in, re-asked whenever the public read refreshes. Held WITH the
  // wallet that asked, and dropped the moment the wallet changes: an owner's
  // dollars are never drawn for whoever holds the phone next.
  val ownRead by produceState<Pair<String, OwnBook>?>(null, signedIn, slug, profile?.publicBook, slot.okAtMs) {
    val who = signedIn
    value = if (who != null && profile?.publicBook == false) ownBookOf(c.api.ownBook(slug))?.let { who to it } else null
  }
  val own = ownRead?.takeIf { it.first == signedIn }?.second
  val known = ownAgent as? OwnAgent.Known
  // A 200 from /own is the server saying this session owns the slug.
  val offerWire = wireOffered(slug, ownKnown = known != null, ownSlug = known?.slug, own = own)
  val showMoney = showMoneyOf(profile?.publicBook, own)
  val retry: () -> Unit = { scope.launch { reads.loop.readNow(System.currentTimeMillis()) } }

  Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
    AgentBanner(slug)
    // THE HEADER SITS OUTSIDE THE READ'S STATES: it carries the only way off
    // this screen, and a refused or unreachable read must not take it away.
    AgentIdHeader(nav, slug, profile)
    Column(
      Modifier.fillMaxWidth().padding(horizontal = PagePadH),
      verticalArrangement = Arrangement.spacedBy(PageGap),
    ) {
      if (profile == null) {
        val failure = failureOf(slot)
        when {
          failure is Loaded.Refused && failure.status == 404 -> Notice(
            title = "Agent not found",
            body = "No agent answers to @$slug on this server.",
          )
          failure != null -> LoadedBlock(failure, onSignIn = { nav.navigate(Routes.SIGN_IN) }, onRetry = retry) { }
          else -> LoadedBlock(Loaded.Loading) { }
        }
      } else {
        staleLine(slot, "this page", System.currentTimeMillis())?.let {
          Text(it, style = TextStyle(fontFamily = sans(12.sp), fontSize = 12.sp, lineHeight = 18.sp), color = MerryColors.tx2)
        }
        // ABOVE THE FIRST NUMBER: the sentence about what wiring can and cannot
        // do reads as what it is here, not as a reaction to the return below.
        if (offerWire) {
          WireButton(slug, profile.name ?: slug, onSignIn = { nav.navigate(Routes.SIGN_IN) })
        }
        Performance(profile, showMoney)
        Strategy(profile)
        TopTrades(profile, own, showMoney)
        BuysAndSells(profile, own, showMoney)
        Positions(profile)
        Decisions(profile, showMoney, onRetry = retry)
      }
    }
    Spacer(Modifier.height(LocalBottomInset.current))
  }
}

/**
 * `.public-agent-id`: back, the face (its uploaded picture and wire ring), the
 * name, `@slug`, the owner only as NameBlock allows, the mode stamp, and the
 * stats line — each term only when it was read.
 */
@Composable
private fun AgentIdHeader(nav: NavHostController, slug: String, p: AgentProfile?) {
  val name = p?.name ?: slug
  Row(
    Modifier.fillMaxWidth().padding(start = PagePadH, end = PagePadH, top = PagePadTop, bottom = 22.dp),
    horizontalArrangement = Arrangement.spacedBy(10.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    Box(
      Modifier.size(44.dp).clickable { nav.popBackStack() }.semantics { contentDescription = "Back" },
      contentAlignment = Alignment.CenterStart,
    ) { ArrowLeftIcon(MerryColors.tx2) }
    AgentFace(slug = slug, name = name, size = 36.dp)
    Column(Modifier.weight(1f)) {
      NameBlock(title = name, owner = p?.handle, verified = p?.handleVerified ?: false)
      Row(Modifier.padding(top = 4.dp), horizontalArrangement = Arrangement.spacedBy(6.dp), verticalAlignment = Alignment.CenterVertically) {
        Text("@$slug", style = TextStyle(fontFamily = sans(11.sp), fontSize = 11.sp), color = MerryColors.faint)
        when (p?.mode) {
          "paper" -> ProfileStamp("Paper")
          null, "live" -> Unit
          else -> ProfileStamp("Inactive")
        }
      }
      if (p != null) {
        val stats = statsParts(p.tradeCount, p.tradeCountFloor, p.avgHoldSec, p.joinedAt, p.mode == "paper", p.gasless)
        if (stats.isNotEmpty()) {
          Text(
            stats.joinToString(" · "),
            Modifier.padding(top = 4.dp),
            style = TextStyle(fontFamily = sans(12.sp), fontSize = 12.sp, lineHeight = 17.sp),
            color = MerryColors.tx2,
          )
        }
      }
    }
  }
}

@Composable
private fun ProfileStamp(text: String) {
  Box(Modifier.border(1.dp, MerryColors.line, RoundedCornerShape(4.dp)).padding(horizontal = 6.dp, vertical = 2.dp)) {
    Text(
      text.uppercase(),
      style = TextStyle(fontFamily = sans(10.sp, FontWeight.W600), fontSize = 10.sp, fontWeight = FontWeight.W600, letterSpacing = 0.04.em),
      color = MerryColors.tx2,
    )
  }
}

@Composable
private fun ProfileHeading(title: String, aside: String? = null) {
  Row(Modifier.fillMaxWidth().padding(top = 18.dp, bottom = 6.dp), verticalAlignment = Alignment.Bottom) {
    Text(
      title,
      Modifier.weight(1f),
      style = TextStyle(fontFamily = sans(17.sp, FontWeight.W600), fontSize = 17.sp, fontWeight = FontWeight.W600, letterSpacing = (-0.02).em),
      color = MerryColors.tx,
    )
    aside?.let { Text(it, style = TextStyle(fontFamily = sans(12.sp), fontSize = 12.sp), color = MerryColors.faint) }
  }
}

/** `.public-empty`: a quiet sentence about what is, or is not, here. */
@Composable
private fun ProfileNote(text: String, modifier: Modifier = Modifier) {
  Text(text, modifier.padding(top = 4.dp), style = TextStyle(fontFamily = sans(12.sp), fontSize = 12.sp, lineHeight = 18.sp), color = MerryColors.tx2)
}

private fun signColor(sign: FigureSign?): Color = when (sign) {
  FigureSign.UP -> MerryColors.up
  FigureSign.DOWN -> MerryColors.down
  null -> MerryColors.faint
}

/**
 * THE RETURN: a live book's net return on contributed capital, or a paper
 * book's own return labelled Paper, or the reason there is none — never a
 * number nobody measured. Then both counters, the gas, and the chart.
 */
@Composable
private fun Performance(p: AgentProfile, showMoney: Boolean) {
  val r = returnOf(p)
  Column(Modifier.fillMaxWidth()) {
    Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.Bottom) {
      Column(Modifier.weight(1f)) {
        Text(r.label, style = TextStyle(fontFamily = sans(12.sp), fontSize = 12.sp), color = MerryColors.tx2)
        val bps = r.bps
        Text(
          pctBps(bps),
          style = TextStyle(fontFamily = numerals(FontWeight.W600), fontSize = 30.sp, fontWeight = FontWeight.W600, letterSpacing = (-0.03).em),
          color = when {
            bps == null -> MerryColors.faint
            kotlin.math.abs(bps) < 5 -> MerryColors.tx
            bps > 0 -> MerryColors.up
            else -> MerryColors.down
          },
        )
      }
      // BOTH COUNTERS: folding paper into landed would divide a pretend
      // balance by a real deposit; showing only landed says "0" beside ten
      // simulated fills.
      Column(horizontalAlignment = Alignment.End) {
        Text(p.landed?.let { countText(it) } ?: "—", style = TextStyle(fontFamily = numerals(FontWeight.W600), fontSize = 18.sp, fontWeight = FontWeight.W600), color = MerryColors.tx)
        Text("Completed operations", style = TextStyle(fontFamily = sans(11.sp), fontSize = 11.sp), color = MerryColors.faint)
        p.filledPaper?.takeIf { it > 0 }?.let {
          Text("$it paper trades", style = TextStyle(fontFamily = sans(11.sp), fontSize = 11.sp), color = MerryColors.tx2)
        }
      }
    }
    r.note?.let { ProfileNote(it) }
    drawdownLine(p)?.let { ProfileNote(it) }
    gasLine(p, showMoney)?.let { ProfileNote(it) }
    // THE GATE BEFORE THE DRAW: the line must be the growth index, and the
    // flows divided out of it must have been read from the chain.
    when {
      p.mode == "paper" -> Unit
      p.contributionsEvidenced == false -> ProfileNote(
        "The deposits and withdrawals on record for this agent are inferred from balance changes rather than read " +
          "from the chain, so they cannot be divided out of its equity — and a growth figure computed over them would " +
          "not be its doing. The return is not published until the capital behind it is evidenced.",
      )
      growthPointsOf(p.growth).size > 1 -> GrowthChart(p)
      else -> ProfileNote("Performance history isn’t available yet.")
    }
  }
}

/**
 * THE CHART, IN THE WINDOWS ITS HISTORY CAN BACK. A window the history does
 * not reach is disabled rather than drawn short under a longer name, and ALL
 * is offered only when the read reached the whole period. Drawn here as a
 * plain line — no fill, no colour that reads as a gain — rather than borrowing
 * the token screen's price chart, which another change owns.
 */
@Composable
private fun GrowthChart(p: AgentProfile) {
  val nowSec = System.currentTimeMillis() / 1000
  val points = remember(p.growth) { growthPointsOf(p.growth) }
  var picked by rememberSaveable(p.slug) { mutableStateOf<ChartWindow?>(null) }
  val windows = chartWindows(points, p.growthComplete, nowSec)
  val active = picked ?: defaultWindow(points, p.growthComplete, nowSec)
  val slice = growthWindow(points, active, nowSec, p.growthComplete)
  Column(Modifier.fillMaxWidth().padding(top = 12.dp)) {
    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
      windows.forEach { (w, available) ->
        val on = w == active
        Box(
          Modifier
            .alpha(if (available) 1f else 0.4f)
            .heightIn(min = 36.dp)
            .clip(RoundedCornerShape(50))
            .background(if (on) MerryColors.tx else MerryColors.card)
            .clickable(enabled = available, role = Role.Tab) { picked = w }
            .semantics {
              stateDescription = when {
                !available && w == ChartWindow.ALL -> "Only the most recent part of this period was read"
                !available -> "This agent's history does not reach back ${w.words.removePrefix("the last ")}"
                on -> "Selected"
                else -> "Not selected"
              }
            }
            .padding(horizontal = 12.dp, vertical = 8.dp),
          contentAlignment = Alignment.Center,
        ) {
          Text(w.label, style = TextStyle(fontFamily = sans(12.sp, FontWeight.W600), fontSize = 12.sp, fontWeight = FontWeight.W600), color = if (on) MerryColors.ink else MerryColors.tx2)
        }
      }
    }
    when (slice) {
      is WindowSlice.Ok -> {
        GrowthLine(slice.values, Modifier.padding(top = 10.dp))
        ProfileNote(
          "Chart: time-weighted return over ${active.words}, adjusted for deposits and withdrawals." +
            if (active == ChartWindow.ALL) " It covers the same period as the net return above; the two are calculated differently." else "",
        )
      }
      WindowSlice.Empty -> ProfileNote("No readings in ${active.words}.")
      WindowSlice.Partial -> ProfileNote("Only the most recent part of this period was read.")
      WindowSlice.Short -> ProfileNote("This agent's history is shorter than ${active.words.removePrefix("the last ")}.")
    }
  }
}

@Composable
private fun GrowthLine(values: List<Double>, modifier: Modifier = Modifier) {
  val line = MerryColors.tx
  Canvas(modifier.fillMaxWidth().height(88.dp)) {
    if (values.size < 2) return@Canvas
    val lo = values.min()
    val hi = values.max()
    val span = (hi - lo).takeIf { it > 0 } ?: 1.0
    val path = Path()
    values.forEachIndexed { i, v ->
      val x = size.width * i / (values.size - 1)
      val y = (size.height - ((v - lo) / span) * size.height).toFloat()
      if (i == 0) path.moveTo(x, y) else path.lineTo(x, y)
    }
    drawPath(path, line, style = Stroke(width = 1.5.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))
  }
}

/** How it decides — only what its own decisions show, and "Not published" otherwise. */
@Composable
private fun Strategy(p: AgentProfile) {
  val id = strategyOfHow(p.how)
  Column {
    ProfileHeading("Strategy", if (id == null) "Not published" else strategyName(id))
    ProfileNote(thesisOfHow(p.how).ifEmpty { "This agent hasn’t shared its approach yet." })
  }
}

/**
 * TOP TRADES, by return and never by dollars — a dollar ranking ranks
 * position size and would leak the sizes a private book hides. Absent when
 * the server sent none; "couldn't read" is not "no closed trades".
 */
@Composable
private fun TopTrades(p: AgentProfile, own: OwnBook?, showMoney: Boolean) {
  val list = topTradesList(p, own) ?: return
  Column {
    ProfileHeading("Top trades", if (p.mode == "paper") "Paper sells, by return" else "Closed sells, by return")
    when (list) {
      ProfileList.Unread -> ProfileNote("Top trades could not be loaded.")
      ProfileList.Empty -> Empty("No closed trades yet", "", kind = EmptyKind.Positions, compact = true)
      is ProfileList.Rows -> list.rows.forEachIndexed { i, t -> TopTradeRow(i + 1, t, showMoney) }
    }
  }
}

@Composable
private fun TopTradeRow(place: Int, t: ProfileTrade, showMoney: Boolean) {
  val f = topTradeFigures(t, showMoney)
  Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
    Text("#$place", Modifier.width(26.dp), style = TextStyle(fontFamily = numerals(FontWeight.W400), fontSize = 12.sp), color = MerryColors.faint)
    Text(
      t.displayName?.takeIf { it.isNotBlank() } ?: t.symbol ?: "Token label unavailable",
      Modifier.weight(1f),
      maxLines = 1,
      style = TextStyle(fontFamily = sans(14.sp, FontWeight.W600), fontSize = 14.sp, fontWeight = FontWeight.W600),
      color = MerryColors.tx,
    )
    Text(
      f.pct + (f.usd?.let { " ($it)" } ?: ""),
      style = TextStyle(fontFamily = numerals(FontWeight.W600), fontSize = 13.sp, fontWeight = FontWeight.W600),
      color = signColor(f.sign),
    )
  }
}

/**
 * BUYS & SELLS — the fills, newest first, from the owner's own read when this
 * is their page. Dollars only where they may be shown; a sell with no return
 * is one whose cost could not be confirmed, and the page says so.
 */
@Composable
private fun BuysAndSells(p: AgentProfile, own: OwnBook?, showMoney: Boolean) {
  val list = fillsList(p, own)
  var tab by rememberSaveable(p.slug) { mutableStateOf(SwapTab.ALL) }
  var all by rememberSaveable(p.slug) { mutableStateOf(false) }
  Column {
    ProfileHeading("Buys & sells", "Latest fills")
    when (list) {
      // A list that was not said to be read is not "none recorded". The page
      // re-reads itself every 30 seconds, so "shortly" is a promise it keeps.
      ProfileList.Unread -> ProfileNote("Trade history could not be loaded. Retrying shortly.")
      ProfileList.Empty -> Empty("No completed buys or sells recorded in this trading period.", "", kind = EmptyKind.Positions, compact = true)
      is ProfileList.Rows -> {
        val trades = list.rows
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.padding(bottom = 6.dp)) {
          SwapTab.entries.forEach { t ->
            val on = t == tab
            Box(
              Modifier
                .heightIn(min = 36.dp)
                .clip(RoundedCornerShape(50))
                .background(if (on) MerryColors.tx else MerryColors.card)
                .clickable(role = Role.Tab) {
                  tab = t
                  all = false
                }
                .padding(horizontal = 12.dp, vertical = 8.dp),
              contentAlignment = Alignment.Center,
            ) {
              Text(t.label, style = TextStyle(fontFamily = sans(12.sp, FontWeight.W600), fontSize = 12.sp, fontWeight = FontWeight.W600), color = if (on) MerryColors.ink else MerryColors.tx2)
            }
          }
        }
        val rows = swapRows(trades, tab, showMoney)
        val now = System.currentTimeMillis()
        if (rows.isEmpty()) {
          Empty(tab.empty ?: "No completed buys or sells recorded in this trading period.", "", kind = EmptyKind.Positions, compact = true)
        } else {
          (if (all) rows else rows.take(8)).forEach { SwapLine(it, now) }
          if (rows.size > 8) {
            Text(
              if (all) "Show fewer" else "Show all ${rows.size}",
              Modifier.heightIn(min = 44.dp).clickable(role = Role.Button) { all = !all }.padding(vertical = 12.dp),
              style = TextStyle(fontFamily = sans(13.sp, FontWeight.W600), fontSize = 13.sp, fontWeight = FontWeight.W600),
              color = MerryColors.tx2,
            )
          }
        }
        if (p.publicBook == false) {
          ProfileNote(
            if (own?.recentTrades != null) "Only you can see the sizes and dollar figures here. Visitors see percentages."
            else "Trade sizes are private.",
          )
        }
        ProfileNote("This list shows swaps. The completed-operations total also includes other executed actions.")
        ProfileNote("Sale P&L compares proceeds with the cost of the quantity sold, before gas.")
        if (trades.any { it.action == "sell" && it.realizedPnlBps == null }) {
          ProfileNote("A sale with no return is one whose cost could not be confirmed.")
        }
      }
    }
  }
}

/** One fill: its pill, the coin by name, what this viewer may see, and how long ago. */
@Composable
private fun SwapLine(v: SwapView, nowMs: Long) {
  Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
    val ink = signColor(v.sign)
    Box(
      Modifier
        .clip(RoundedCornerShape(50))
        .then(if (v.sign == null) Modifier.border(1.dp, MerryColors.line, RoundedCornerShape(50)) else Modifier.background(ink.copy(alpha = 0.14f)))
        .padding(horizontal = 7.dp, vertical = 1.dp),
    ) {
      Text(v.pill, style = TextStyle(fontFamily = sans(10.5.sp, FontWeight.W700), fontSize = 10.5.sp, fontWeight = FontWeight.W700), color = ink)
    }
    Text(v.coin, Modifier.weight(1f), maxLines = 1, style = TextStyle(fontFamily = sans(13.sp, FontWeight.W600), fontSize = 13.sp, fontWeight = FontWeight.W600), color = MerryColors.tx)
    Column(horizontalAlignment = Alignment.End) {
      v.size?.let { Text(it, style = TextStyle(fontFamily = numerals(FontWeight.W600), fontSize = 12.sp, fontWeight = FontWeight.W600), color = MerryColors.tx) }
      v.chip?.let { (text, sign) ->
        Text(text, style = TextStyle(fontFamily = numerals(FontWeight.W600), fontSize = 11.5.sp, fontWeight = FontWeight.W600), color = signColor(sign))
      }
    }
    Text(
      listOfNotNull(if (v.paper) "Paper" else null, v.at?.let { elapsedText(it * 1000, nowMs) }).joinToString(" · "),
      style = TextStyle(fontFamily = sans(11.sp), fontSize = 11.sp),
      color = MerryColors.faint,
    )
  }
}

/**
 * POSITIONS — only a book its owner published, and only when it was read. A
 * private book says so; an unread one says that; neither is "no positions".
 */
@Composable
private fun Positions(p: AgentProfile) {
  Column {
    ProfileHeading("Positions")
    when {
      p.publicBook == true && p.holdingsRead == true && p.holdings.isNotEmpty() -> p.holdings.forEach { h ->
        Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
          Text(h.symbol ?: "Token label unavailable", Modifier.weight(1f), style = TextStyle(fontFamily = sans(14.sp, FontWeight.W600), fontSize = 14.sp, fontWeight = FontWeight.W600), color = MerryColors.tx)
          holdingDetail(h.shareBps)?.let { Text(it, style = TextStyle(fontFamily = sans(12.sp), fontSize = 12.sp), color = MerryColors.tx2) }
        }
      }
      p.publicBook == false -> ProfileNote("This agent keeps its positions private.")
      p.publicBook == true && p.holdingsRead == true -> ProfileNote("No current positions reported.")
      else -> ProfileNote("Public holdings are unavailable right now.")
    }
  }
}

/**
 * RECENT DECISIONS — this agent's own thirty days, told the way the feed tells
 * them: a trade is conjugated only by what came of it, a view prints its
 * publisher's head with no verb, and a coin is named by its name. The web's
 * list labels every row without a buy or sell "Hold" — a vault move included —
 * which this does not copy.
 */
@Composable
private fun Decisions(p: AgentProfile, showMoney: Boolean, onRetry: () -> Unit) {
  val list = remember(p.theses, p.thesesRead) { decisionsList(p) }
  var all by rememberSaveable(p.slug) { mutableStateOf(false) }
  Column {
    ProfileHeading(
      "Recent decisions",
      when (list) {
        ProfileList.Unread -> null
        ProfileList.Empty -> "0 updates"
        is ProfileList.Rows -> "${list.rows.size} updates"
      },
    )
    when (list) {
      // UNREADABLE IS NOT "NOTHING PUBLISHED" — nor is an answer that did not say.
      ProfileList.Unread -> Notice(
        title = "Recent decisions could not be loaded.",
        body = "That is about this read, not about the agent — it may well have posted.",
        actionLabel = "Try again",
        onAction = onRetry,
      )
      ProfileList.Empty -> Empty("No published decisions in the last 30 days.", "", kind = EmptyKind.Feed, compact = true)
      is ProfileList.Rows -> {
        val beats = list.rows
        val now = System.currentTimeMillis()
        (if (all) beats else beats.take(4)).forEach { DecisionRow(it, showMoney, now) }
        if (beats.size > 4) {
          Text(
            if (all) "Show less ↑" else "View all ${beats.size} updates ↓",
            Modifier.heightIn(min = 44.dp).clickable(role = Role.Button) { all = !all }.padding(vertical = 12.dp),
            style = TextStyle(fontFamily = sans(13.sp, FontWeight.W600), fontSize = 13.sp, fontWeight = FontWeight.W600),
            color = MerryColors.tx2,
          )
        }
      }
    }
  }
}

@Composable
private fun DecisionRow(b: Beat, showMoney: Boolean, nowMs: Long) {
  val trade = b as? TradeBeat
  Column(Modifier.fillMaxWidth().padding(vertical = 10.dp)) {
    Row(horizontalArrangement = Arrangement.spacedBy(8.dp), verticalAlignment = Alignment.CenterVertically) {
      trade?.let {
        val pill = pillOf(it)
        val ink = when (pill.tone) {
          PillTone.BUY -> MerryColors.up
          PillTone.SELL -> MerryColors.down
          PillTone.MUTED -> MerryColors.faint
        }
        Box(
          Modifier
            .clip(RoundedCornerShape(50))
            .then(if (pill.tone == PillTone.MUTED) Modifier.border(1.dp, MerryColors.line, RoundedCornerShape(50)) else Modifier.background(ink.copy(alpha = 0.14f)))
            .padding(horizontal = 7.dp, vertical = 1.dp),
        ) {
          Text(pill.label, style = TextStyle(fontFamily = sans(10.5.sp, FontWeight.W700), fontSize = 10.5.sp, fontWeight = FontWeight.W700), color = ink)
        }
      }
      Text(lineOf(b), Modifier.weight(1f), style = TextStyle(fontFamily = sans(14.sp, FontWeight.W600), fontSize = 14.sp, fontWeight = FontWeight.W600), color = MerryColors.tx)
      // A size only where dollars may be shown — the publisher withholds a
      // private book's sizes, and this does not lean on that alone.
      decisionSize(b, showMoney)?.let {
        Text(usd(it), style = TextStyle(fontFamily = numerals(FontWeight.W600), fontSize = 12.sp, fontWeight = FontWeight.W600), color = MerryColors.tx)
      }
    }
    val said = sayOf(b.core.post, b.core.reason)
    val view = b as? ViewBeat
    said.say?.takeIf { view == null || it != view.head }?.let {
      Text(it, Modifier.padding(top = 4.dp), style = TextStyle(fontFamily = sans(14.sp), fontSize = 14.sp, lineHeight = 21.sp), color = if (b.core.post != null) MerryColors.tx else MerryColors.tx2)
    }
    Text(
      listOfNotNull(
        elapsedText(b.core.atMs, nowMs) + " ago",
        b.core.outcomeText,
        if (b.core.paper) "Paper" else null,
      ).joinToString(" · "),
      Modifier.padding(top = 4.dp),
      style = TextStyle(fontFamily = sans(11.sp), fontSize = 11.sp),
      color = MerryColors.faint,
    )
    LikeButton(b.core.postId)
  }
}
