package dev.merrymen.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.LocalContentColor
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.clip
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import dev.merrymen.app.LocalContainer
import dev.merrymen.app.ui.screens.AgentDetailScreen
import dev.merrymen.app.ui.screens.AlphaScreen
import dev.merrymen.app.ui.screens.ChatScreen
import dev.merrymen.app.ui.screens.CircleScreen
import dev.merrymen.app.ui.screens.FeedScreen
import dev.merrymen.app.ui.screens.HomeScreen
import dev.merrymen.app.ui.screens.LeaderboardScreen
import dev.merrymen.app.ui.screens.MarketsScreen
import dev.merrymen.app.ui.screens.ProfileScreen
import dev.merrymen.app.ui.screens.ProposalsScreen
import dev.merrymen.app.ui.screens.RiskScreen
import dev.merrymen.app.ui.screens.TradeScreen
import dev.merrymen.app.ui.screens.SearchScreen
import dev.merrymen.app.ui.screens.SettingsScreen
import dev.merrymen.app.ui.screens.SignInScreen
import dev.merrymen.app.ui.screens.WelcomeScreen
import dev.merrymen.app.ui.screens.TelegramScreen
import dev.merrymen.app.ui.screens.TokenDetailScreen
import dev.merrymen.app.ui.screens.WebFlowScreen

/**
 * THE MAP.
 *
 * Five tabs, matching the web terminal's, plus the routed panels it reaches by
 * URL. The tab IDs are deliberately the same words the web app uses (home,
 * feed, chat, alpha, profile) so a bug report about "the alpha tab" means one
 * thing across both clients.
 *
 * WHAT IS A ROUTE HERE AND WHAT IS A WEB HANDOFF. Anything that ends in a
 * SIGNATURE — arming a grant, re-signing limits, withdrawing, creating an agent
 * — opens the web app's own screen inside a WebView, because that is where the
 * owner key lives. Everything else is native. See WebAuth for why.
 */
object Routes {
  const val HOME = "home"
  const val FEED = "feed"
  const val CHAT = "chat"
  const val ALPHA = "alpha"
  const val PROFILE = "profile"

  const val MARKETS = "markets"
  const val SEARCH = "search"
  const val SETTINGS = "settings"
  const val TELEGRAM = "telegram"
  const val CIRCLE = "circle"
  const val LEADERBOARD = "leaderboard"
  const val SIGN_IN = "sign-in"
  const val WELCOME = "welcome"
  const val PROPOSALS = "proposals"
  const val TRADE = "trade"
  const val RISK = "risk"

  const val TOKEN = "token/{address}"
  fun token(address: String) = "token/$address"
  const val AGENT = "agent/{slug}"
  fun agent(slug: String) = "agent/$slug"

  /** A delegated signature ceremony, by web path. */
  const val WEB = "web?path={path}&title={title}"
  fun web(path: String, title: String) =
    "web?path=" + java.net.URLEncoder.encode(path, "UTF-8") +
      "&title=" + java.net.URLEncoder.encode(title, "UTF-8")
}

private data class Tab(val route: String, val label: String)

private val TABS = listOf(
  Tab(Routes.HOME, "Home"),
  Tab(Routes.CHAT, "Chat"),
  Tab(Routes.FEED, "Feed"),
  Tab(Routes.ALPHA, "Alpha"),
  Tab(Routes.PROFILE, "You"),
)

@Composable
fun Shell() {
  val nav = rememberNavController()
  val container = LocalContainer.current

  // WHICH SCREEN OPENS is decided before the NavHost composes, so the reader
  // never sees Home flash behind the welcome page. Null means "not decided yet"
  // and holds the graph back; the Box's own background covers that instant.
  var start by remember { mutableStateOf<String?>(null) }
  LaunchedEffect(Unit) {
    val welcomed = container.session.welcomedNow()
    // The door first, then identity. While the site gate is on, every other
    // route answers 401 regardless of the session — see Repository.bootstrap.
    container.repo.bootstrap()
    val signed = container.repo.signedIn.value != null
    // A signed-in reader has plainly been past the welcome before; only a fresh
    // install that has neither been welcomed nor signed in starts at the page.
    start = if (welcomed || signed) Routes.HOME else Routes.WELCOME
  }

  val entry by nav.currentBackStackEntryAsState()
  val current = entry?.destination?.route
  val onTab = TABS.any { it.route == current }

  // NOT A Scaffold BOTTOM BAR. The web's `.tabbar` is `position: fixed` and the
  // page scrolls UNDER it, so the bar overlays the content rather than taking a
  // slice of the layout. A Scaffold bottomBar would shorten every screen by the
  // bar's height and change where everything sits.
  Box(Modifier.fillMaxSize().background(MerryColors.bg)) {
    // Provided once: while the site gate is shut EVERY screen is refused, and
    // every one of them needs the same way out — the password field in
    // Settings, not a wallet signature. See LoadedBlock.
    // `LocalContentColor` MUST BE PROVIDED HERE, and dropping the Scaffold is
    // what stopped it being. Material's `Text` falls back to
    // `LocalContentColor.current` when no colour is passed, and that local is
    // supplied by `Surface` — which `Scaffold` used to wrap the content in. With
    // no Surface it defaults to BLACK, so on a near-black ground every Text that
    // did not name a colour vanished while every Text that did stayed lit. On
    // the device that read as a half-rendered screen, not as a missing default.
    CompositionLocalProvider(
      LocalOpenSettings provides { nav.navigate(Routes.SETTINGS) },
      LocalContentColor provides MerryColors.tx,
      LocalBottomInset provides BOTTOM_INSET,
    ) {
      // THE STATUS BAR IS THE ONE THING THE WEB DOES NOT HAVE TO THINK ABOUT.
      // `.app`'s `padding: 18px 18px …` sits inside a browser viewport that
      // starts below the system UI; here the window is edge-to-edge, so without
      // this the page title renders behind the clock. Dropping the Scaffold is
      // what removed it — the Scaffold had been applying the inset invisibly.
      // The welcome page is EDGE-TO-EDGE art and owns its own insets, so it does
      // not get the status-bar padding every other screen needs to keep its
      // title out from behind the clock. Applying both would inset its top
      // twice.
      val edgeToEdge = current == Routes.WELCOME
      Box(Modifier.fillMaxSize().then(if (edgeToEdge) Modifier else Modifier.statusBarsPadding())) {
        // Held back until the start screen is decided, so Home never flashes
        // behind the welcome page; the Box's own background covers that instant.
        start?.let { s ->
          NavHost(navController = nav, startDestination = s) { graph(nav) }
        }
      }
    }
    if (onTab) {
      TabBar(current) { route ->
        nav.navigate(route) {
          popUpTo(Routes.HOME) { saveState = true }
          launchSingleTop = true
          restoreState = true
        }
      }
    }
  }
}

/**
 * THE BAR: a floating pill, not a full-width bar, and icon-only.
 *
 * TWO STYLESHEETS DECIDE THIS AND THE SECOND ONE WINS. `terminal.css`'s
 * `.tabbar` gives the base — fixed, centred, 52px tall, `rgb(18 19 15 / 0.92)`,
 * a `rgb(255 255 255 / 0.1)` hairline, 26px radius, `backdrop-filter: blur(18px)`,
 * five equal columns — and then `polish.css` overrides its geometry inside
 * `@media (max-width: 1099px)`, which is every phone. It wins twice over: it is
 * later, and `.terminal-host .tabbar` (0,2,0) outranks `:where(.terminal-host)
 * .tabbar` (0,1,0). Reading only terminal.css gives a bar that is 402px wide
 * with no selected state — which is what this first shipped as.
 *
 * So the mobile numbers, from `polish.css:4-18`:
 *   width: min(300px, calc(100% - 40px));  height: 52px;  padding: 3px
 *   bottom: max(10px, env(safe-area-inset-bottom))
 *   .tab { min-height: 44px; border-radius: 24px }
 *   .tab.on { background: var(--line) }
 *
 * THERE IS A SELECTED PILL AFTER ALL, and it is `--line` #24261e at 24px — a
 * quiet inset, not Material's `secondaryContainer` capsule. The purple one was
 * Material's default showing through an unmapped colour slot; deleting it
 * outright would have been the opposite error.
 *
 * THERE ARE NO LABELS. The web puts the label in `aria-label` only — the CSS
 * styles nothing but `svg`. The Android bar had five captions under five
 * Material glyphs, which is a different design, not a smaller one. The labels
 * survive as `contentDescription`, which is exactly where the web keeps them.
 *
 * `backdrop-filter: blur(18px)` HAS NO CLEAN COMPOSE EQUIVALENT. `Modifier.blur`
 * blurs the composable itself, not what is behind it; a real backdrop blur wants
 * a RenderEffect on API 31+ and this app ships to 26. The 0.92 alpha carries most
 * of the effect, and that is what is here — stated rather than silently dropped.
 */
@Composable
private fun TabBar(current: String?, onSelect: (String) -> Unit) {
  Box(
    Modifier
      .fillMaxSize()
      // `bottom: max(10px, env(safe-area-inset-bottom))` — the max() is the
      // gesture bar, which is exactly what navigationBarsPadding supplies.
      .navigationBarsPadding()
      .padding(horizontal = 20.dp, vertical = 10.dp),
    contentAlignment = Alignment.BottomCenter,
  ) {
    Row(
      Modifier
        // width: min(300px, calc(100% - 40px)) — the 40 is the 20 either side above.
        .widthIn(max = 300.dp)
        .fillMaxWidth()
        .height(52.dp)
        .background(MerryColors.card.copy(alpha = 0.92f), RoundedCornerShape(26.dp))
        .border(1.dp, Color.White.copy(alpha = 0.10f), RoundedCornerShape(26.dp))
        .padding(3.dp),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      TABS.forEach { tab ->
        val on = current == tab.route
        val tint = if (on) MerryColors.tx else MerryColors.faint
        Box(
          Modifier
            .weight(1f)
            .fillMaxHeight()
            .clip(RoundedCornerShape(24.dp))
            .background(if (on) MerryColors.line else Color.Transparent)
            .clickable(
              interactionSource = remember { MutableInteractionSource() },
              // No ripple: the web has none, and a Material ripple inside a
              // 24dp pill draws a rectangle through the corners.
              indication = null,
            ) { onSelect(tab.route) }
            .semantics { contentDescription = tab.label },
          contentAlignment = Alignment.Center,
        ) {
          when (tab.route) {
            Routes.HOME -> HomeIcon(tint)
            Routes.CHAT -> ChatIcon(tint)
            // The mark, in the middle. `svg.logo-mark { width: 28px; height: 19px }`
            Routes.FEED -> LogoMark(height = 19.dp, tint = tint)
            Routes.ALPHA -> AlphaIcon(tint)
            else -> YouIcon(tint)
          }
        }
      }
    }
  }
}

private fun NavGraphBuilder.graph(nav: NavHostController) {
  composable(Routes.HOME) { HomeScreen(nav) }
  composable(Routes.FEED) { FeedScreen(nav) }
  composable(Routes.CHAT) { ChatScreen(nav) }
  composable(Routes.ALPHA) { AlphaScreen(nav) }
  composable(Routes.PROFILE) { ProfileScreen(nav) }

  composable(Routes.MARKETS) { MarketsScreen(nav) }
  composable(Routes.SEARCH) { SearchScreen(nav) }
  composable(Routes.SETTINGS) { SettingsScreen(nav) }
  composable(Routes.TELEGRAM) { TelegramScreen(nav) }
  composable(Routes.CIRCLE) { CircleScreen(nav) }
  composable(Routes.LEADERBOARD) { LeaderboardScreen(nav) }
  composable(Routes.SIGN_IN) { SignInScreen(nav) }
  composable(Routes.WELCOME) { WelcomeScreen(nav) }
  composable(Routes.PROPOSALS) { ProposalsScreen(nav) }
  composable(Routes.TRADE) { TradeScreen(nav) }
  composable(Routes.RISK) { RiskScreen(nav) }

  composable(Routes.TOKEN) { back ->
    TokenDetailScreen(nav, back.arguments?.getString("address").orEmpty())
  }
  composable(Routes.AGENT) { back ->
    AgentDetailScreen(nav, back.arguments?.getString("slug").orEmpty())
  }
  composable(Routes.WEB) { back ->
    WebFlowScreen(
      nav = nav,
      path = back.arguments?.getString("path").orEmpty(),
      title = back.arguments?.getString("title").orEmpty(),
    )
  }
}
