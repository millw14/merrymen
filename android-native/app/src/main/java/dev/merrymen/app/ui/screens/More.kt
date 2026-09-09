package dev.merrymen.app.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.navigation.NavHostController
import dev.merrymen.app.LocalContainer
import dev.merrymen.app.data.Loaded
import dev.merrymen.app.data.toLoaded
import dev.merrymen.app.net.CircleView
import dev.merrymen.app.net.Leaderboard
import dev.merrymen.app.net.SearchResults
import dev.merrymen.app.net.SettingsEnvelope
import dev.merrymen.app.net.TelegramStatus
import dev.merrymen.app.net.TokensPage
import dev.merrymen.app.net.WebFlow
import dev.merrymen.app.ui.Bps
import dev.merrymen.app.ui.Empty
import dev.merrymen.app.ui.LoadedBlock
import dev.merrymen.app.ui.Money
import dev.merrymen.app.ui.Notice
import dev.merrymen.app.ui.Routes
import dev.merrymen.app.ui.SectionCard
import kotlinx.coroutines.launch

@Composable
private fun Header(title: String, nav: NavHostController) {
  Row(
    Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.SpaceBetween,
  ) {
    Text(title, style = MaterialTheme.typography.headlineSmall)
    TextButton(onClick = { nav.popBackStack() }) { Text("Back") }
  }
}

// ── MARKETS ─────────────────────────────────────────────────────────────────

@Composable
fun MarketsScreen(nav: NavHostController) {
  val c = LocalContainer.current
  var state by remember { mutableStateOf<Loaded<TokensPage>>(Loaded.Loading) }
  val scope = rememberCoroutineScope()
  suspend fun load() { state = c.api.tokens().toLoaded() }
  LaunchedEffect(Unit) { load() }

  Column(Modifier.fillMaxSize()) {
    Header("Markets", nav)
    LoadedBlock(state, onRetry = { scope.launch { load() } }) { page ->
      if (page.tokens.isEmpty()) {
        Empty("No tokens listed", "Nothing has been registered on this deployment yet.")
      } else {
        LazyColumn {
          items(page.tokens) { t ->
            SectionCard(modifier = Modifier.clickable {
              t.address?.let { nav.navigate(Routes.token(it)) }
            }) {
              Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Column {
                  Text(t.symbol, style = MaterialTheme.typography.titleMedium)
                  t.name?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
                  if (t.stale) Text("price stale", style = MaterialTheme.typography.labelSmall)
                }
                Column(horizontalAlignment = Alignment.End) {
                  Money(t.priceUsd)
                  Bps(t.chg24?.toInt())
                }
              }
            }
          }
        }
      }
    }
  }
}

// ── TOKEN DETAIL ────────────────────────────────────────────────────────────

@Composable
fun TokenDetailScreen(nav: NavHostController, address: String) {
  val c = LocalContainer.current
  var state by remember { mutableStateOf<Loaded<TokensPage>>(Loaded.Loading) }
  LaunchedEffect(address) { state = c.api.tokens().toLoaded() }

  Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
    Header("Token", nav)
    LoadedBlock(state) { page ->
      val t = page.tokens.firstOrNull { it.address.equals(address, ignoreCase = true) }
      if (t == null) {
        Empty("Not listed", "This address is not in the registry on this deployment.")
      } else {
        SectionCard(t.symbol) {
          t.name?.let { Text(it, style = MaterialTheme.typography.bodyMedium) }
          Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("Price", style = MaterialTheme.typography.bodySmall)
            Money(t.priceUsd)
          }
          Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("24h", style = MaterialTheme.typography.bodySmall)
            Bps(t.chg24?.toInt())
          }
          if (t.stale) {
            Text(
              "The feed for this token is stale. The mark is the last good price, not a live one.",
              style = MaterialTheme.typography.bodySmall,
            )
          }
          Text(address, style = MaterialTheme.typography.labelSmall)
        }
      }
    }
  }
}

// ── SEARCH ──────────────────────────────────────────────────────────────────

@Composable
fun SearchScreen(nav: NavHostController) {
  val c = LocalContainer.current
  var q by remember { mutableStateOf("") }
  var state by remember { mutableStateOf<Loaded<SearchResults>>(Loaded.Idle) }
  val scope = rememberCoroutineScope()

  Column(Modifier.fillMaxSize()) {
    Header("Search", nav)
    OutlinedTextField(
      value = q,
      onValueChange = {
        q = it
        scope.launch {
          if (it.isBlank()) state = Loaded.Idle
          else {
            state = Loaded.Loading
            state = c.api.search(it).toLoaded()
          }
        }
      },
      modifier = Modifier.fillMaxWidth().padding(horizontal = 16.dp),
      placeholder = { Text("Search tokens or agents") },
      singleLine = true,
    )
    Spacer(Modifier.height(8.dp))
    LoadedBlock(state) { r ->
      LazyColumn {
        items(r.agents) { a ->
          SectionCard(modifier = Modifier.clickable { a.slug?.let { nav.navigate(Routes.agent(it)) } }) {
            Text(a.name ?: a.handle ?: "agent", style = MaterialTheme.typography.titleMedium)
            Bps(a.pnlBps)
          }
        }
        items(r.tokens) { t ->
          SectionCard(modifier = Modifier.clickable { t.address?.let { nav.navigate(Routes.token(it)) } }) {
            Text(t.symbol, style = MaterialTheme.typography.titleMedium)
            Money(t.priceUsd)
          }
        }
      }
    }
  }
}

// ── LEADERBOARD ─────────────────────────────────────────────────────────────

@Composable
fun LeaderboardScreen(nav: NavHostController) {
  val c = LocalContainer.current
  var state by remember { mutableStateOf<Loaded<Leaderboard>>(Loaded.Loading) }
  val scope = rememberCoroutineScope()
  suspend fun load() { state = c.api.leaderboard().toLoaded() }
  LaunchedEffect(Unit) { load() }

  Column(Modifier.fillMaxSize()) {
    Header("Leaderboard", nav)
    LoadedBlock(state, onRetry = { scope.launch { load() } }) { b ->
      if (b.agents.isEmpty()) {
        // "Nothing to rank" and "we could not rank" are different sentences.
        Empty(
          if (b.why != null) "Couldn't rank right now" else "Nothing to rank yet",
          b.why ?: "No agent has a settled result on this deployment.",
        )
      } else {
        LazyColumn {
          items(b.agents) { a ->
            SectionCard(modifier = Modifier.clickable { a.slug?.let { nav.navigate(Routes.agent(it)) } }) {
              Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                Column {
                  Text(a.name ?: a.handle ?: "agent", style = MaterialTheme.typography.titleMedium)
                  a.trades?.let { Text("$it trades", style = MaterialTheme.typography.bodySmall) }
                }
                Bps(a.pnlBps)
              }
            }
          }
        }
      }
    }
  }
}

// ── AGENT DETAIL ────────────────────────────────────────────────────────────

@Composable
fun AgentDetailScreen(nav: NavHostController, slug: String) {
  val c = LocalContainer.current
  var state by remember { mutableStateOf<Loaded<dev.merrymen.app.net.ThesesPage>>(Loaded.Loading) }
  LaunchedEffect(slug) { state = c.api.theses().toLoaded() }

  Column(Modifier.fillMaxSize()) {
    Header("@$slug", nav)
    LoadedBlock(state) { page ->
      val mine = page.theses.filter { it.slug == slug }
      if (mine.isEmpty()) {
        Empty("Nothing published", "This agent has not posted inside the current window.")
      } else {
        LazyColumn {
          items(mine) { t ->
            SectionCard {
              Text(t.head.ifBlank { t.reason ?: "" }, style = MaterialTheme.typography.bodyMedium)
              t.outcome?.let {
                Text(it, style = MaterialTheme.typography.labelSmall)
              }
            }
          }
        }
      }
    }
  }
}

// ── THE MERRY CIRCLE ────────────────────────────────────────────────────────

@Composable
fun CircleScreen(nav: NavHostController) {
  val c = LocalContainer.current
  var state by remember { mutableStateOf<Loaded<CircleView>>(Loaded.Loading) }
  val scope = rememberCoroutineScope()
  suspend fun load() { state = c.api.circle().toLoaded() }
  LaunchedEffect(Unit) { load() }

  Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
    Header("The Merry Circle", nav)
    LoadedBlock(state, onSignIn = { nav.navigate(Routes.SIGN_IN) }, onRetry = { scope.launch { load() } }) { v ->
      // FOUR ANSWERS, FOUR SENTENCES. `balance` is null for three of them, and
      // rendering 0 for any would send somebody to buy tokens they may hold.
      when (v.why) {
        "sign-in" -> Notice(
          title = "Sign in",
          body = "Sign in to see where your wallet stands.",
          actionLabel = "Sign in",
          onAction = { nav.navigate(Routes.SIGN_IN) },
        )
        "no-wallet" -> Notice("No holder wallet linked", "Your login wallet is used unless you link another.")
        "unreadable" -> Notice(
          "Couldn't read your balance",
          "That's our chain read failing, not your wallet. " + (v.error ?: ""),
        )
        else -> SectionCard("You") {
          Text(v.tier?.name ?: "—", style = MaterialTheme.typography.titleMedium)
          Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
            Text("Holding", style = MaterialTheme.typography.bodySmall)
            Text(v.balance?.toString() ?: "—", style = MaterialTheme.typography.bodyMedium)
          }
          v.next?.let { n ->
            Text(
              "${n.tokensToGo ?: 0} more to reach ${n.name}",
              style = MaterialTheme.typography.bodySmall,
            )
          }
          v.holderAddress?.let { Text(it, style = MaterialTheme.typography.labelSmall) }
        }
      }

      // The tier TABLE is public and renders in every arm — it is what makes
      // the signed-out answer useful rather than empty.
      v.tiers.forEach { t ->
        SectionCard(t.name) {
          Text("${t.minTokens} \$MERRYMEN", style = MaterialTheme.typography.bodySmall)
          if (t.bonusStrategies) Text("Unlocks holder-only strategies", style = MaterialTheme.typography.bodySmall)
          t.perks.forEach { Text("• $it", style = MaterialTheme.typography.bodySmall) }
        }
      }
    }
    Spacer(Modifier.height(24.dp))
  }
}

// ── TELEGRAM ────────────────────────────────────────────────────────────────

@Composable
fun TelegramScreen(nav: NavHostController) {
  val c = LocalContainer.current
  var state by remember { mutableStateOf<Loaded<TelegramStatus>>(Loaded.Loading) }
  val scope = rememberCoroutineScope()
  suspend fun load() { state = c.api.telegram().toLoaded() }
  LaunchedEffect(Unit) { load() }

  Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
    Header("Telegram", nav)
    LoadedBlock(state, onSignIn = { nav.navigate(Routes.SIGN_IN) }, onRetry = { scope.launch { load() } }) { t ->
      SectionCard("Connection") {
        Text(if (t.connected) "Connected as @${t.botUsername}" else "Not connected", style = MaterialTheme.typography.bodyMedium)
        Text(if (t.enabled) "The bot is listening" else "Telegram is off", style = MaterialTheme.typography.bodySmall)
        if (!t.control) {
          Text("Control commands are turned off for this bot.", style = MaterialTheme.typography.bodySmall)
        }
      }
      SectionCard("Claim your bot") {
        if (t.linkCode != null) {
          Text("Send this to your bot:", style = MaterialTheme.typography.bodySmall)
          Text("/link ${t.linkCode}", style = MaterialTheme.typography.titleMedium)
          Text(
            "The code rotates once it is used. Anyone who has it can command this agent, so treat it like a password.",
            style = MaterialTheme.typography.bodySmall,
          )
        } else if (!t.hasToken) {
          Text("Add a bot token first — create one with @BotFather.", style = MaterialTheme.typography.bodySmall)
        } else {
          // Not "no code": the worker mints it on boot, so this is a wait.
          Text(
            "No code yet. Your agent mints one when it next starts with this token set.",
            style = MaterialTheme.typography.bodySmall,
          )
        }
      }
      if (t.ownerId != null) {
        SectionCard("Linked") { Text("Owner chat ${t.ownerId}", style = MaterialTheme.typography.bodySmall) }
      }
    }
  }
}

// ── SETTINGS ────────────────────────────────────────────────────────────────

@Composable
fun SettingsScreen(nav: NavHostController) {
  val c = LocalContainer.current
  var state by remember { mutableStateOf<Loaded<SettingsEnvelope>>(Loaded.Loading) }
  var origin by remember { mutableStateOf("") }
  var gate by remember { mutableStateOf("") }
  var note by remember { mutableStateOf<String?>(null) }
  val scope = rememberCoroutineScope()

  LaunchedEffect(Unit) {
    origin = c.repo.originNow()
    state = c.api.settings().toLoaded()
  }

  Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
    Header("Settings", nav)
    note?.let { Notice("Settings", it) }

    SectionCard("This device") {
      OutlinedTextField(
        value = origin,
        onValueChange = { origin = it },
        label = { Text("Server") },
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
      )
      OutlinedTextField(
        value = gate,
        onValueChange = { gate = it },
        label = { Text("Site password (beta)") },
        visualTransformation = PasswordVisualTransformation(),
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
      )
      Button(onClick = {
        scope.launch {
          c.repo.setOrigin(origin)
          if (gate.isNotBlank()) c.repo.openGate(gate)
          note = "Saved. Reloading."
          state = c.api.settings().toLoaded()
        }
      }) { Text("Save and reconnect") }
    }

    LoadedBlock(state, onSignIn = { nav.navigate(Routes.SIGN_IN) }) { env ->
      SectionCard("Your agent") {
        // THE WHOLE OBJECT IS SHOWN AND SENT BACK WHOLE. Editing a subset here
        // and PUTting only that is how a client silently unsets every field it
        // does not render — the read-modify-write hazard this repo has already
        // paid for twice. Rich per-field editors belong on the web screen until
        // they can be built against the server's own validation.
        Text(
          env.values?.toString()?.take(2000) ?: "No settings stored yet.",
          style = MaterialTheme.typography.bodySmall,
        )
        TextButton(onClick = { nav.navigate(Routes.web("/settings", "Settings")) }) {
          Text("Edit on the web screen")
        }
      }
      if (env.errors.isNotEmpty()) {
        Notice("The server rejected some values", env.errors.joinToString("\n"))
      }
    }

    SectionCard("Practice") {
      Text(
        "Starting over restores the practice stake and clears simulated positions. " +
          "On the live rail the worker refuses it — real trades are never deleted.",
        style = MaterialTheme.typography.bodySmall,
      )
      TextButton(onClick = {
        scope.launch {
          note = when (val r = c.api.paperReset().toLoaded()) {
            is Loaded.Value -> "Queued. Your agent restarts the practice book on its next tick."
            is Loaded.Refused -> r.message
            is Loaded.Unreachable -> "Couldn't reach merrymen: " + r.cause
            else -> null
          }
        }
      }) { Text("Restart the practice book") }
    }
    Spacer(Modifier.height(24.dp))
  }
}

// ── SIGN IN ─────────────────────────────────────────────────────────────────

/**
 * Sign-in is the web app's own SIWE flow, in a WebView, because it ends in a
 * signature from the owner key — and this app deliberately does not hold one.
 * What crosses back is the session cookie and nothing else. See WebAuth.
 */
@Composable
fun SignInScreen(nav: NavHostController) {
  val c = LocalContainer.current
  var origin by remember { mutableStateOf<String?>(null) }
  val scope = rememberCoroutineScope()
  LaunchedEffect(Unit) { origin = c.repo.originNow() }

  Column(Modifier.fillMaxSize()) {
    Header("Sign in", nav)
    val o = origin
    if (o == null) {
      Empty("…", "Reading your server setting.")
    } else {
      WebFlow(
        url = dev.merrymen.app.net.WebAuth.signInUrl(o),
        origin = o,
        jar = c.cookieJar,
        onCookies = { scope.launch { c.repo.adoptWebSession() } },
        modifier = Modifier.fillMaxSize(),
      )
    }
  }
}

// ── DELEGATED SIGNATURE CEREMONIES ──────────────────────────────────────────

@Composable
fun WebFlowScreen(nav: NavHostController, path: String, title: String) {
  val c = LocalContainer.current
  var origin by remember { mutableStateOf<String?>(null) }
  val scope = rememberCoroutineScope()
  LaunchedEffect(Unit) { origin = c.repo.originNow() }

  Column(Modifier.fillMaxSize()) {
    Header(title.ifBlank { "merrymen" }, nav)
    val o = origin
    if (o != null) {
      WebFlow(
        url = o + path,
        origin = o,
        jar = c.cookieJar,
        onCookies = { scope.launch { c.repo.adoptWebSession() } },
        modifier = Modifier.fillMaxSize(),
      )
    }
  }
}
