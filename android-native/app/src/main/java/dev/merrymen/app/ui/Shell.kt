package dev.merrymen.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.draw.clip
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.Dp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import androidx.navigation.NavGraphBuilder
import androidx.navigation.NavHostController
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import dev.merrymen.app.LocalContainer
import kotlinx.coroutines.flow.collectLatest
import dev.merrymen.app.ui.screens.AgentDetailScreen
import dev.merrymen.app.ui.screens.AlphaScreen
import dev.merrymen.app.ui.screens.ChatScreen
import dev.merrymen.app.ui.screens.CircleScreen
import dev.merrymen.app.ui.screens.FeedScreen
import dev.merrymen.app.ui.screens.GroupChatScreen
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
  /** The fleet room — every hosted Merryman in one chat. Hosted only. */
  const val GROUPCHAT = "groupchat"

  const val TOKEN = "token/{address}"
  fun token(address: String) = "token/$address"
  const val AGENT = "agent/{slug}"
  fun agent(slug: String) = "agent/$slug"

  /** A delegated signature ceremony, by web path. */
  const val WEB = "web?path={path}&title={title}"
  fun web(path: String, title: String) = "web?path=" + arg(path) + "&title=" + arg(title)

  /**
   * ONE ROUTE ARGUMENT, ENCODED THE WAY NAVIGATION DECODES IT.
   *
   * URLEncoder is a FORM encoder: it writes a space as '+'. Navigation reads a
   * query argument back with Uri.decode, which only undoes %XX and leaves '+'
   * alone — so every web screen's title came out as "Trading+limits" and
   * "Wallet+&+permissions". A '+' the caller actually wrote is already "%2B"
   * by this point, so every '+' left is a space and "%20" says so in the form
   * both ends read.
   */
  internal fun arg(value: String): String = java.net.URLEncoder.encode(value, "UTF-8").replace("+", "%20")
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
  //
  // DECIDED ONCE, NOT ONCE PER ACTIVITY. A rotation recreates the Activity and
  // this composable with it; with `remember` the graph was held back again on
  // every turn of the phone until the start had been asked for again. Saved,
  // the graph composes at once with the back stack it had.
  var start by rememberSaveable { mutableStateOf<String?>(null) }
  var localReady by remember { mutableStateOf(false) }
  LaunchedEffect(Unit) {
    // This also runs after process restoration: a saved route must never
    // bypass credential migration. Server checks continue in the app scope.
    container.locallyReady()
    localReady = true
    if (start == null) start = if (container.session.welcomedNow()) Routes.HOME else Routes.WELCOME
  }

  // UNTIL SOMEBODY SAYS WHO IS SIGNED IN, KEEP ASKING — while the app is in
  // front. bootstrap asks once; a start that reached nothing left identity
  // unknown for the life of the process, and every screen that waits on it
  // with it (Repository.askUntilKnown). A Server change makes it unknown
  // again, and this starts over.
  val lifecycle = LocalLifecycleOwner.current.lifecycle
  LaunchedEffect(lifecycle) {
    container.locallyReady()
    lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
      container.repo.identityKnown.collectLatest { known -> if (!known) container.repo.askUntilKnown() }
    }
  }

  val entry by nav.currentBackStackEntryAsState()
  val current = entry?.destination?.route
  val onTab = TABS.any { it.route == current }
  val density = LocalDensity.current
  val keyboardOpen = WindowInsets.ime.getBottom(density) > 0
  val barHeight = maxOf(64.dp, 48.dp + with(density) { 14.sp.toDp() })
  val bottomClearance = if (keyboardOpen) 12.dp else
    maxOf(BOTTOM_INSET, barHeight + 30.dp) + WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
  val chatUnread by container.chat.unread.collectAsState()

  // NOT A Scaffold BOTTOM BAR. The web's `.tabbar` is `position: fixed` and the
  // page scrolls UNDER it, so the bar overlays the content rather than taking a
  // slice of the layout. A Scaffold bottomBar would shorten every screen by the
  // bar's height and change where everything sits.
  Box(Modifier.fillMaxSize().background(MerryColors.bg)) {
    // `LocalContentColor` MUST BE PROVIDED HERE, and dropping the Scaffold is
    // what stopped it being. Material's `Text` falls back to
    // `LocalContentColor.current` when no colour is passed, and that local is
    // supplied by `Surface` — which `Scaffold` used to wrap the content in. With
    // no Surface it defaults to BLACK, so on a near-black ground every Text that
    // did not name a colour vanished while every Text that did stayed lit. On
    // the device that read as a half-rendered screen, not as a missing default.
    CompositionLocalProvider(
      LocalContentColor provides MerryColors.tx,
      LocalBottomInset provides bottomClearance,
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
        val startRoute = start
        if (startRoute != null && localReady) {
          NavHost(navController = nav, startDestination = startRoute) { graph(nav) }
        } else {
          Column(
            Modifier.align(Alignment.Center),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(16.dp),
          ) {
            CircularProgressIndicator(color = MerryColors.mint, modifier = Modifier.size(28.dp))
            Text("Opening Merrymen…", color = MerryColors.tx2)
          }
        }
      }
    }
    if (onTab && !keyboardOpen) {
      TabBar(current, chatUnread, barHeight) { route ->
        nav.navigate(route) {
          popUpTo(Routes.HOME) { saveState = true }
          launchSingleTop = true
          restoreState = true
        }
      }
    }
  }
}

/** Labeled, touch-sized destinations with a selected state and unread feedback. */
@Composable
private fun TabBar(current: String?, chatUnread: Int, height: Dp, onSelect: (String) -> Unit) {
  // Large text needs both a taller line box and more of a compact phone's width.
  val sidePadding = if (LocalDensity.current.fontScale > 1.3f) 8.dp else 20.dp
  Box(
    Modifier
      .fillMaxSize()
      // `bottom: max(10px, env(safe-area-inset-bottom))` — the max() is the
      // gesture bar, which is exactly what navigationBarsPadding supplies.
      .navigationBarsPadding()
      .padding(horizontal = sidePadding, vertical = 10.dp),
    contentAlignment = Alignment.BottomCenter,
  ) {
    Row(
      Modifier
        // Use the available phone width so labels and touch targets have room.
        .widthIn(max = 380.dp)
        .fillMaxWidth()
        .height(height)
        .background(MerryColors.card.copy(alpha = 0.92f), RoundedCornerShape(26.dp))
        .border(1.dp, Color.White.copy(alpha = 0.10f), RoundedCornerShape(26.dp))
        .padding(3.dp)
        .selectableGroup(),
      verticalAlignment = Alignment.CenterVertically,
    ) {
      TABS.forEach { tab ->
        val on = current == tab.route
        val tint = if (on) MerryColors.tx else MerryColors.faint
        val dot = tab.route == Routes.CHAT && chatUnread > 0
        Box(
          Modifier
            .weight(1f)
            .fillMaxHeight()
            .clip(RoundedCornerShape(24.dp))
            .background(if (on) MerryColors.line else Color.Transparent)
            .selectable(selected = on, role = Role.Tab, onClick = { onSelect(tab.route) })
            .semantics(mergeDescendants = true) {
              contentDescription = tab.label
              if (dot) stateDescription = "New messages"
            },
          contentAlignment = Alignment.Center,
        ) {
          Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(3.dp),
          ) {
            Box(Modifier.height(22.dp), contentAlignment = Alignment.Center) {
              when (tab.route) {
                Routes.HOME -> HomeIcon(tint)
                Routes.CHAT -> ChatIcon(tint)
                Routes.FEED -> LogoMark(height = 19.dp, tint = tint)
                Routes.ALPHA -> AlphaIcon(tint)
                else -> YouIcon(tint)
              }
            }
            Text(
              tab.label, color = tint, fontSize = 11.sp, lineHeight = 14.sp, letterSpacing = 0.sp,
              fontWeight = if (on) FontWeight.SemiBold else FontWeight.Normal,
              maxLines = 1, modifier = Modifier.clearAndSetSemantics { },
            )
          }
          if (dot) UnreadDot(Modifier.align(Alignment.TopCenter))
        }
      }
    }
  }
}

/**
 * THE CHAT TAB'S UNREAD DOT — `chat.css:74-83`: an 8px `--lime` circle, 12px
 * from the tab's top and 16px right of its centre, ringed 2px in the bar's own
 * ground so it reads as sitting ON the bar rather than in the icon.
 *
 * It is drawn from ChatThread.unread and nothing else. Something arrived that
 * the owner has not seen; it says no more than that, and never a count.
 */
@Composable
private fun UnreadDot(modifier: Modifier) {
  Box(
    modifier
      // Centre at +12 so the 8dp dot's right edge sits at centre + 16.
      .offset(x = 12.dp, y = 10.dp)
      .size(12.dp)
      .background(MerryColors.card, CircleShape)
      .padding(2.dp)
      .background(MerryColors.lime, CircleShape),
  )
}

private fun NavGraphBuilder.graph(nav: NavHostController) {
  composable(Routes.HOME) { HomeScreen(nav) }
  composable(Routes.FEED) { FeedScreen(nav) }
  composable(Routes.CHAT) { AccountRoute(nav) { ChatScreen(nav) } }
  composable(Routes.ALPHA) { AccountRoute(nav) { AlphaScreen(nav) } }
  composable(Routes.PROFILE) { AccountRoute(nav) { ProfileScreen(nav) } }

  composable(Routes.MARKETS) { MarketsScreen(nav) }
  composable(Routes.SEARCH) { SearchScreen(nav) }
  // The device's server address must remain editable while that server is down.
  composable(Routes.SETTINGS) { SettingsScreen(nav) }
  composable(Routes.TELEGRAM) { AccountRoute(nav) { TelegramScreen(nav) } }
  composable(Routes.CIRCLE) { AccountRoute(nav) { CircleScreen(nav) } }
  composable(Routes.LEADERBOARD) { LeaderboardScreen(nav) }
  composable(Routes.SIGN_IN) { SignInScreen(nav) }
  composable(Routes.WELCOME) { WelcomeScreen(nav) }
  composable(Routes.PROPOSALS) { AccountRoute(nav) { ProposalsScreen(nav) } }
  composable(Routes.TRADE) { AccountRoute(nav) { TradeScreen(nav) } }
  composable(Routes.RISK) { AccountRoute(nav) { RiskScreen(nav) } }
  composable(Routes.GROUPCHAT) { AccountRoute(nav) { GroupChatScreen(nav) } }

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

/** Public browsing is usable while the session is being checked. Private
 * screens do not compose or start their requests until that check answers. */
@Composable
private fun AccountRoute(nav: NavHostController, content: @Composable () -> Unit) {
  val repo = LocalContainer.current.repo
  val known by repo.identityKnown.collectAsState()
  val turn by repo.serverTurn.collectAsState()
  if (known && turn % 2L == 0L) {
    content()
  } else {
    Column(
      Modifier.fillMaxSize().padding(horizontal = 24.dp),
      verticalArrangement = Arrangement.Center,
      horizontalAlignment = Alignment.CenterHorizontally,
    ) {
      CircularProgressIndicator(color = MerryColors.mint, modifier = Modifier.size(28.dp))
      Text("Checking your account…", Modifier.padding(top = 16.dp), color = MerryColors.tx)
      Text("You can explore agents and activity while we reconnect.", Modifier.padding(top = 8.dp), color = MerryColors.tx2)
      TextButton(onClick = { nav.navigate(Routes.HOME) { launchSingleTop = true } }) {
        Text("Explore Merrymen", color = MerryColors.mint)
      }
      TextButton(onClick = { nav.navigate(Routes.SETTINGS) { launchSingleTop = true } }) {
        Text("Connection settings", color = MerryColors.tx2)
      }
    }
  }
}
