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
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Text
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.material3.pulltorefresh.PullToRefreshDefaults
import androidx.compose.material3.pulltorefresh.rememberPullToRefreshState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.vector.PathParser
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
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
import dev.merrymen.app.data.toLoaded
import dev.merrymen.app.net.ApiResult
import dev.merrymen.app.net.Feed
import dev.merrymen.app.net.GrantView
import dev.merrymen.app.net.MerrymenApi
import dev.merrymen.app.net.SettingsEnvelope
import dev.merrymen.app.net.TelegramStatus
import dev.merrymen.app.net.TierView
import dev.merrymen.app.ui.AgentFace
import dev.merrymen.app.ui.BlockerFix
import dev.merrymen.app.ui.BottomInsetSpacer
import dev.merrymen.app.ui.LoadedBlock
import dev.merrymen.app.ui.MerryColors
import dev.merrymen.app.ui.Notice
import dev.merrymen.app.ui.OwnBook
import dev.merrymen.app.ui.PagePadH
import dev.merrymen.app.ui.PageTitle
import dev.merrymen.app.ui.Routes
import dev.merrymen.app.ui.ownAgentName
import dev.merrymen.app.ui.ownBookOf
import dev.merrymen.app.ui.pnlLineOf
import dev.merrymen.app.ui.positionLinesOf
import dev.merrymen.app.ui.sans
import dev.merrymen.app.ui.sessionNeedsAsking
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** lucide `Search`, size 22 on Home's heading row (`terminal.css:742-748`). */
@Composable
private fun SearchGlyph(tint: Color, size: Dp = 22.dp) {
  Canvas(Modifier.size(size)) {
    val s = this.size.minDimension / ICON_VIEW
    val handle = PathParser().parsePathString("m21 21-4.3-4.3").toPath()
    scale(s, s, pivot = Offset.Zero) {
      drawCircle(tint, radius = 8f, center = Offset(11f, 11f), style = Stroke(width = 2f))
      drawPath(handle, tint, style = Stroke(width = 2f, cap = StrokeCap.Round))
    }
  }
}

/** lucide `MessagesSquare`, 22 at stroke 1.8 — Home.tsx's way into the group chat. */
@Composable
private fun GroupChatGlyph(tint: Color) = StrokeGlyph(
  "M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z",
  "M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1",
  tint = tint,
  size = 22.dp,
  stroke = 1.8f,
)

/**
 * `.tag` — `terminal.css:1703`: 12px, weight 500, `letter-spacing: .03em`,
 * `line-height: 1`, `--tx-2` on #1c1d16, `padding: 3px 6px 2px`, radius 2px.
 *
 * NOTE THE ASYMMETRIC VERTICAL PADDING and the 2px radius: this is a squared-off
 * label, not a pill. The pill shape in this product means "a filter you can
 * press", and a strategy name is not one.
 */
@Composable
private fun Tag(text: String, modifier: Modifier = Modifier) {
  Text(
    text = text,
    modifier = modifier
      .clip(RoundedCornerShape(2.dp))
      .background(TabTagGround)
      .padding(start = 6.dp, end = 6.dp, top = 3.dp, bottom = 2.dp),
    style = TextStyle(
      fontFamily = sans(12.sp, FontWeight.W500),
      fontSize = 12.sp,
      fontWeight = FontWeight.W500,
      letterSpacing = 0.03.em,
      lineHeight = 12.sp,
    ),
    color = MerryColors.tx2,
  )
}

/**
 * THE OWNER'S READS, HELD FOR ONE WALLET — the feed, the account status, and
 * the two reads behind the Telegram/Trencher strip.
 *
 * [readFor] is who was signed in when the feed was read, which is who every
 * write from these screens is made for (a name, a picture). A refresh that
 * fails after a good read keeps the figures on screen but says so, with their
 * age ([feedFailure]); a refusal (a session that ended) replaces them, because
 * a book the server would no longer send is not the reader's to keep looking at.
 *
 * A FEED ANSWERED FOR NOBODY WHILE THIS APP HOLDS AN ADDRESS IS A QUESTION,
 * asked before the answer is published: [askWhoIsSignedIn] (the repository's
 * refreshIdentity) runs first — see [sessionNeedsAsking] — so an ended session
 * turns into the sign-in, not into "Couldn't read your book" over an account
 * whose ledger is fine.
 */
internal class OwnReads {
  var feed by mutableStateOf<Loaded<Feed>>(Loaded.Loading)
  var feedAtMs by mutableStateOf<Long?>(null)
  var feedFailure by mutableStateOf<ApiResult<*>?>(null)
  var grants by mutableStateOf<Loaded<GrantView>>(Loaded.Loading)
  var grantsAtMs by mutableStateOf<Long?>(null)
  var grantsFailure by mutableStateOf<ApiResult<*>?>(null)
  var telegram by mutableStateOf<TelegramStatus?>(null)
  var settings by mutableStateOf<SettingsEnvelope?>(null)
  var readFor by mutableStateOf<String?>(null)

  suspend fun load(
    api: MerrymenApi,
    signedIn: String?,
    hosted: Boolean?,
    withStrip: Boolean,
    nowMs: () -> Long,
    // No default, on purpose: a screen that forgot to pass the repository's
    // refreshIdentity would still compile, and an ended session would go back
    // to "Couldn't read your book" with no Sign in. Every caller says how.
    askWhoIsSignedIn: suspend () -> Unit,
  ) {
    val f = api.feed()
    if (sessionNeedsAsking(f, (f as? ApiResult.Ok)?.value?.source == "none", signedIn, hosted)) askWhoIsSignedIn()
    val keep = feed is Loaded.Value && (f is ApiResult.Unreachable || (f is ApiResult.Refused && f.status >= 500))
    if (keep) {
      feedFailure = f
    } else {
      feed = f.toLoaded()
      feedFailure = null
      if (f is ApiResult.Ok) {
        feedAtMs = nowMs()
        readFor = signedIn
      }
    }
    // THE ACCOUNT STATUS KEEPS THE FEED'S RULE: a refresh with no answer, or a
    // 5xx, keeps the last good read and records that it failed, so the page can
    // say how old it is (accountStatusLine); a refusal replaces it. It used to
    // keep the old read in silence, and a first read that failed took the
    // blocker, the mode and the balances off the page without a word — an
    // agent that could not trade looked like one with nothing wrong.
    val g = api.grants()
    val keepG = grants is Loaded.Value && (g is ApiResult.Unreachable || (g is ApiResult.Refused && g.status >= 500))
    if (keepG) {
      grantsFailure = g
    } else {
      grants = g.toLoaded()
      grantsFailure = null
      if (g is ApiResult.Ok) grantsAtMs = nowMs()
    }
    // THE STRIP ONLY FOR AN AGENT THAT EXISTS: no bot to connect and no
    // strategy to run otherwise. Best effort — a failed read stays "checking…".
    val exists = (grants as? Loaded.Value)?.value?.exists == true
    if (withStrip && exists) {
      (api.telegram() as? ApiResult.Ok)?.value?.let { telegram = it }
      (api.settings() as? ApiResult.Ok)?.value?.let { settings = it }
    }
  }
}

/** How often the account refreshes while its screen is in front: the web shell's own pass. */
private const val ACCOUNT_REFRESH_MS = 60_000L

/**
 * HOME — one scrolling column, no cards, no dividers, no surface fills.
 *
 * `polish.css:65`: `.home-page { display:flex; flex-direction:column; gap:28px }`,
 * inside the body's own `padding: 16px 20px …` (`polish.css:87`) with the top
 * raised to 20px by `polish.css:177-180`. Every block here sits directly on
 * `--bg`.
 *
 * WHOSE BOOK THIS IS COMES FIRST. /api/feed answers a signed-out reader, and a
 * ledger it could not open, with the house fallback — "Robin", a steady
 * basket — and this screen used to draw that as the reader's own agent over
 * "Nothing held right now.". [ownBookOf] decides: signed out gets the empty
 * hero and a sign-in (only where there is one), an unreadable book says so and
 * offers a retry, and only a book the server read gets figures.
 *
 * THE READS: /api/feed and /api/grants on open, every 60 seconds while this
 * screen is RESUMED, and on a pull; /api/tier once; /api/telegram and
 * /api/settings for the strip when there is an agent. All of it is keyed on
 * repo.signedIn, so a wallet switch starts from nothing rather than showing
 * one wallet's book under another's session.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun HomeScreen(nav: NavHostController) {
  val c = LocalContainer.current
  val signedIn by c.repo.signedIn.collectAsState()
  val hosted by c.repo.hosted.collectAsState()
  val canOfferSignIn by c.repo.canOfferSignIn.collectAsState()
  val reads = remember(signedIn) { OwnReads() }
  var tier by remember(signedIn) { mutableStateOf<Loaded<TierView>>(Loaded.Loading) }
  var nowMs by remember { mutableLongStateOf(System.currentTimeMillis()) }
  var refreshing by remember { mutableStateOf(false) }
  val scope = rememberCoroutineScope()
  val lifecycle = LocalLifecycleOwner.current.lifecycle

  suspend fun load() {
    reads.load(c.api, signedIn, c.repo.hosted.value, withStrip = true, nowMs = { System.currentTimeMillis() }) {
      c.repo.refreshIdentity()
    }
    nowMs = System.currentTimeMillis()
  }

  LaunchedEffect(signedIn) { tier = c.api.tier().toLoaded() }
  // EVERY 60s WHILE IN FRONT, and never in the background: repeatOnLifecycle
  // stops the loop when the screen is paused and starts it (with a read) when
  // it is back.
  LaunchedEffect(signedIn, lifecycle) {
    lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
      while (true) {
        load()
        delay(ACCOUNT_REFRESH_MS)
      }
    }
  }

  val book = ownBookOf(reads.feed, signedIn, hosted, canOfferSignIn)
  val pull = rememberPullToRefreshState()
  PullToRefreshBox(
    isRefreshing = refreshing,
    onRefresh = {
      scope.launch {
        refreshing = true
        load()
        refreshing = false
      }
    },
    state = pull,
    modifier = Modifier.fillMaxSize(),
    indicator = {
      PullToRefreshDefaults.Indicator(
        state = pull,
        isRefreshing = refreshing,
        modifier = Modifier.align(Alignment.TopCenter),
        containerColor = MerryColors.card,
        color = MerryColors.tx,
      )
    },
  ) {
    Column(
      Modifier
        .fillMaxSize()
        .verticalScroll(rememberScrollState())
        .padding(horizontal = PagePadH)
        // `.body:has(> .home-page) { padding-top: 20px }` — polish.css:180 wins
        // over the shorthand's 16px on source order at equal specificity.
        .padding(top = 20.dp),
    ) {
      // `.home-heading` — flex, space-between, margin-bottom 18px.
      Row(
        Modifier.fillMaxWidth().padding(bottom = 18.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically,
      ) {
        PageTitle("Home")
        Row(verticalAlignment = Alignment.CenterVertically) {
          // THE WAY INTO THE GROUP CHAT, only where there is one: the room is
          // hosted-only (self-hosted answers 404), and it is never shown while
          // the server has not said which it is.
          if (hosted == true) {
            // `.icon-btn` — terminal.css:742-748: a 40x40 box holding a 22px glyph.
            Box(
              Modifier
                .size(40.dp)
                .clickable(role = Role.Button) { nav.navigate(Routes.GROUPCHAT) }
                .semantics { contentDescription = "Group chat" },
              contentAlignment = Alignment.Center,
            ) { GroupChatGlyph(MerryColors.tx) }
          }
          Box(
            Modifier
              .size(40.dp)
              .clickable(role = Role.Button) { nav.navigate(Routes.SEARCH) }
              .semantics { contentDescription = "Search tokens or agents" },
            contentAlignment = Alignment.Center,
          ) { SearchGlyph(MerryColors.tx) }
        }
      }

      SignedInNotice(Modifier.padding(bottom = 20.dp))
      CircleLockBanner(tier, nav)

      when (book) {
        OwnBook.Loading -> LoadedBlock(Loaded.Loading) { _: Unit -> }
        is OwnBook.Failed -> LoadedBlock(
          book.state,
          onSignIn = if (canOfferSignIn) ({ nav.navigate(Routes.SIGN_IN) }) else null,
          onRetry = { scope.launch { load() } },
        ) { _: Unit -> }
        is OwnBook.SignedOut -> NoBookHero(
          title = "Your agent starts here",
          body = "Sign in to see your agent's balance, positions and trades here.",
          action = if (book.canSignIn) "Sign in" else null,
          onAction = { nav.navigate(Routes.SIGN_IN) },
        )
        OwnBook.Unreadable -> Notice(
          title = "Couldn't read your book just now",
          body = "merrymen answered, but your agent's ledger could not be read — that's our read failing, " +
            "not a fact about your account. Nothing here is a balance of zero.",
          actionLabel = "Try again",
          onAction = { scope.launch { load() } },
        )
        is OwnBook.Mine -> {
          val g = (reads.grants as? Loaded.Value)?.value
          if (g != null && !g.exists) {
            // SIGNED IN, NO AGENT YET. The feed still answers (with the name
            // and strategy they configured), but there is no book behind it,
            // and a "$—" hero would describe an account that does not exist.
            NoBookHero(
              title = "Your agent starts here",
              body = "Create an agent to manage your portfolio and follow its trades here.",
              action = "Create an agent",
              onAction = { nav.navigate(Routes.web("/create", "Create an agent")) },
            )
          } else {
            OwnHome(book.feed, reads, nowMs, hosted, nav) { scope.launch { load() } }
          }
        }
      }
      HomeGo(nav)
      BottomInsetSpacer()
    }
  }
}

/**
 * `.hero.empty` — Home.tsx:126-128, "This one trades.", and what to do next.
 * Claims nothing about an account: it is the screen for one nobody has read.
 */
@Composable
private fun NoBookHero(title: String, body: String, action: String?, onAction: () -> Unit) {
  Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(20.dp)) {
    Prose(text = "This one trades.", size = 22.sp, lineHeight = 26.4.sp, color = MerryColors.tx, weight = FontWeight.W700)
    Notice(title = title, body = body, actionLabel = action, onAction = if (action != null) onAction else null)
  }
}

/** Where a blocker's fix goes: the web ceremony for money and signatures, Settings for the Live switch. */
internal fun fixRoute(fix: BlockerFix): String = when (fix) {
  BlockerFix.Deposit -> Routes.web("/deposit", "Add funds")
  BlockerFix.Resign -> Routes.web("/grant#resign", "Wallet & permissions")
  BlockerFix.StartLive -> Routes.SETTINGS
}

/**
 * A BOOK THE SERVER READ, top to bottom: what is stopping it, who it is and
 * what it is worth, what it made where that can be said, what the worker is
 * warning about, Telegram and Trencher, what it holds, what is in the account
 * on chain, and everything it did.
 */
@Composable
private fun OwnHome(feed: Feed, reads: OwnReads, nowMs: Long, hosted: Boolean?, nav: NavHostController, onChanged: () -> Unit) {
  val c = LocalContainer.current
  val agent = feed.agent
  val g = (reads.grants as? Loaded.Value)?.value
  Column(Modifier.fillMaxWidth()) {
    staleLine(reads.feedFailure, reads.feedAtMs, nowMs)?.let {
      Prose(it, 13.sp, 18.85.sp, MerryColors.tx2, modifier = Modifier.padding(bottom = 16.dp))
    }
    // THE BLOCKER IS PINNED ABOVE EVERYTHING (Agent.tsx): it is short, and it is
    // the one thing on this screen that must not be scrolled past. When the
    // status could not be read, that is said in its place.
    AccountStatusNote(reads, nowMs, onRetry = onChanged, modifier = Modifier.padding(bottom = 16.dp))
    AccountBlockerPanel(reads.grants, onFix = { nav.navigate(fixRoute(it)) }, modifier = Modifier.padding(bottom = 28.dp))

    // `polish.css:90-94` — `.hero-who { gap:12px }`, the face at 40x40, the
    // name at 18px, and the balance at 56px.
    val name = ownAgentName(agent) ?: "Your agent"
    Row(
      Modifier.fillMaxWidth(),
      horizontalArrangement = Arrangement.spacedBy(12.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      // The app's one face: the owner's picture where there is one (at the
      // version the You tab just uploaded), else the seeded initials.
      AgentFace(slug = agent?.slug, name = name, size = 40.dp)
      Column(Modifier.weight(1f)) {
        Text(
          text = name,
          style = TextStyle(
            fontFamily = sans(18.sp, FontWeight.W600),
            fontSize = 18.sp,
            fontWeight = FontWeight.W600,
            letterSpacing = (-0.02).em,
          ),
          color = MerryColors.tx,
        )
        AccountModeLine(reads.grants, nowMs, Modifier.padding(top = 6.dp))
      }
    }
    AccountNameChip(c.api, agent, reads.readFor, hosted, onNamed = onChanged, modifier = Modifier.padding(top = 12.dp))

    // `.home-balance-label` — polish.css:68: 14px `--tx-2`, 20px above, 8px below.
    Prose(
      text = "Portfolio balance",
      size = 14.sp,
      lineHeight = 18.9.sp,
      color = MerryColors.tx2,
      modifier = Modifier.padding(top = 20.dp, bottom = 8.dp),
    )
    PixelBalance(feed.equityNow)
    // THE RETURN, ONLY WHERE EVERY TERM OF IT IS EVIDENCE — see pnlLineOf.
    // Nothing at all otherwise: "Daily change unavailable" stays the honest
    // line for the day, and no line is the honest line for all time.
    pnlLineOf(feed, g?.mode)?.let { p ->
      Prose(p.text, 14.sp, 21.sp, if (p.usd < 0) MerryColors.down else MerryColors.up, weight = FontWeight.W500, modifier = Modifier.padding(top = 8.dp))
    }

    // The strategy is a fact about the RAIL — a `.tag`, never a tinted pill.
    agent?.strategy?.takeIf { it.isNotBlank() }?.let {
      Row(Modifier.padding(top = 12.dp)) { Tag(it) }
    }
    if (agent?.basket?.isNotEmpty() == true) {
      Prose(
        text = "Trading " + agent.basket.joinToString(", "),
        size = 13.sp,
        lineHeight = 18.85.sp,
        color = MerryColors.tx2,
        modifier = Modifier.padding(top = 8.dp),
      )
    }

    // THE WORKER'S OWN WARNING, which for a long time rendered nowhere at all.
    feed.events.firstOrNull { it.level == "warn" || it.level == "err" || it.level == "error" }
      ?.message?.let {
        Notice(title = "From your agent", body = it, modifier = Modifier.padding(top = 28.dp))
      }

    if (g?.exists == true) {
      AccountStrip(
        telegram = reads.telegram,
        settings = reads.settings,
        mode = g.mode,
        onSettings = { nav.navigate(Routes.SETTINGS) },
        onTelegram = { nav.navigate(Routes.TELEGRAM) },
        modifier = Modifier.padding(top = 28.dp),
      )
    }

    AccountPositions(positionLinesOf(feed.positions), Modifier.padding(top = 28.dp))
    AccountBalances(reads.grants, feed, Modifier.padding(top = 28.dp))
    AccountTape(feed, nowMs, Modifier.padding(top = 28.dp))
  }
}

/**
 * The navigation this screen already carried, in the terminal's own chip row.
 *
 * `.hosted-account-links a/button` — `polish.css:48-49`, which sits OUTSIDE every
 * media query and is therefore live on a phone: `min-height: 44px; padding: 8px
 * 12px; border: 1px solid var(--line); border-radius: 12px; color: var(--tx);
 * font-size: 12px`.
 *
 * The web's Home has no such block. These links are kept because deleting
 * working navigation is not a restyle; the chip row is the closest live
 * vocabulary the sheet has for "a handful of places to go".
 */
@Composable
private fun HomeGo(nav: NavHostController) {
  Column(Modifier.fillMaxWidth().padding(top = 28.dp)) {
    TabSectionHeading("Go", Modifier.padding(bottom = 12.dp))
    // Two rows of two rather than a flow, so the wrap point is authored rather
    // than left to whatever the longest label happens to be.
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      LinkChip("Markets", Modifier.weight(1f)) { nav.navigate(Routes.MARKETS) }
      LinkChip("Leaderboard", Modifier.weight(1f)) { nav.navigate(Routes.LEADERBOARD) }
    }
    Spacer(Modifier.height(8.dp))
    Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
      LinkChip("Trade", Modifier.weight(1f)) { nav.navigate(Routes.TRADE) }
      LinkChip("Settings", Modifier.weight(1f)) { nav.navigate(Routes.SETTINGS) }
    }
  }
}

@Composable
private fun LinkChip(label: String, modifier: Modifier = Modifier, onClick: () -> Unit) {
  val shape = RoundedCornerShape(12.dp)
  Box(
    modifier
      .heightIn(min = 44.dp)
      .clip(shape)
      .border(1.dp, MerryColors.line, shape)
      .clickable(role = Role.Button, onClick = onClick)
      .padding(horizontal = 12.dp, vertical = 8.dp),
    contentAlignment = Alignment.Center,
  ) {
    Text(
      text = label,
      style = TextStyle(
        fontFamily = sans(12.sp, FontWeight.W600),
        fontSize = 12.sp,
        fontWeight = FontWeight.W600,
      ),
      color = MerryColors.tx,
    )
  }
}

/**
 * The eye-catching warning a tester asked for.
 *
 * "The app should warn more eye-catching when someone has chosen a holder-only
 * strategy and don't have access to it. For me it's being tricky to figure that
 * out, I had to go to /api/circle to check that and that's not good for
 * normies."
 *
 * Three arms, because there are three answers: unreadable is OUR failure and
 * must never render as "you don't hold enough", and signed-out is a door. The
 * copy and the branch conditions are untouched by the restyle; only the 28dp of
 * clearance under it is new, so it sits in the page rhythm rather than against
 * the block below.
 */
@Composable
private fun CircleLockBanner(tier: Loaded<TierView>, nav: NavHostController) {
  val t = (tier as? Loaded.Value)?.value ?: return
  when {
    t.why == "unreadable" -> Notice(
      title = "Couldn't read your \$MERRYMEN balance",
      body = "That's our chain read failing, not your wallet. It should clear on its own.",
      modifier = Modifier.padding(bottom = 28.dp),
    )
    t.why == "ok" && !t.bonusStrategies -> Notice(
      title = "Holder-only strategies are locked",
      body = "even-keel and dip-hunter run only while you hold ${t.needTokens} \$MERRYMEN" +
        // NULL TOKENS IS "—", NOT "0". A self-hosted origin (and any read that
        // did not resolve a balance) sends no token count; `?: 0` printed "you
        // hold 0", a confident zero the sibling screens never allow. Omit the
        // clause entirely when the balance is unknown.
        (t.tokens?.let { " — you hold $it. Adding cash won't change it." } ?: "."),
      actionLabel = "See the Circle",
      onAction = { nav.navigate(Routes.CIRCLE) },
      modifier = Modifier.padding(bottom = 28.dp),
    )
  }
}
