package dev.merrymen.app.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Chat
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Podcasts
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
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

private data class Tab(val route: String, val label: String, val icon: ImageVector)

private val TABS = listOf(
  Tab(Routes.HOME, "Home", Icons.Filled.Home),
  Tab(Routes.CHAT, "Chat", Icons.Filled.Chat),
  Tab(Routes.FEED, "Feed", Icons.Filled.Podcasts),
  Tab(Routes.ALPHA, "Alpha", Icons.Filled.AutoAwesome),
  Tab(Routes.PROFILE, "You", Icons.Filled.Person),
)

@Composable
fun Shell() {
  val nav = rememberNavController()
  val container = LocalContainer.current

  // The door first, then identity. While the site gate is on, every other route
  // answers 401 regardless of the session — see Repository.bootstrap.
  LaunchedEffect(Unit) { container.repo.bootstrap() }

  val entry by nav.currentBackStackEntryAsState()
  val current = entry?.destination?.route
  val onTab = TABS.any { it.route == current }

  Scaffold(
    bottomBar = {
      if (onTab) {
        NavigationBar(containerColor = MaterialTheme.colorScheme.surface) {
          TABS.forEach { tab ->
            NavigationBarItem(
              selected = current == tab.route,
              onClick = {
                nav.navigate(tab.route) {
                  popUpTo(Routes.HOME) { saveState = true }
                  launchSingleTop = true
                  restoreState = true
                }
              },
              icon = { Icon(tab.icon, contentDescription = tab.label) },
              label = { Text(tab.label, style = MaterialTheme.typography.labelSmall) },
            )
          }
        }
      }
    },
  ) { pad ->
    Box(Modifier.fillMaxSize().padding(pad)) {
      // Provided once: while the site gate is shut EVERY screen is refused, and
      // every one of them needs the same way out — the password field in
      // Settings, not a wallet signature. See LoadedBlock.
      CompositionLocalProvider(LocalOpenSettings provides { nav.navigate(Routes.SETTINGS) }) {
        NavHost(navController = nav, startDestination = Routes.HOME) { graph(nav) }
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
