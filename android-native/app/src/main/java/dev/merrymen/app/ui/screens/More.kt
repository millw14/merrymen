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
import androidx.compose.runtime.mutableStateMapOf
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
import dev.merrymen.app.ui.LikeButton
import dev.merrymen.app.ui.LoadedBlock
import dev.merrymen.app.ui.Money
import dev.merrymen.app.ui.NameBlock
import dev.merrymen.app.ui.Notice
import dev.merrymen.app.ui.Routes
import dev.merrymen.app.ui.SectionCard
import dev.merrymen.app.ui.WireButton
import kotlinx.coroutines.launch

@Composable
internal fun Header(title: String, nav: NavHostController) {
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
  suspend fun load() { state = c.api.market().toLoaded() }
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
                  // HALT IS NULLABLE ON PURPOSE: the server may only assert it
                  // when the chain answered, so unknown stays quiet.
                  if (t.paused == true) Text("trading halted", style = MaterialTheme.typography.labelSmall)
                }
                Column(horizontalAlignment = Alignment.End) {
                  Money(t.priceUsd)
                  // 24h VOLUME, NOT A 24h CHANGE. /api/market sends no change
                  // figure, so the arrow that used to sit here was an em dash on
                  // every row for every token, for ever.
                  t.volume24hUsd?.let {
                    Text(
                      "24h vol",
                      style = MaterialTheme.typography.labelSmall,
                      color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Money(it)
                  }
                }
              }
            }
          }
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
      if (r.hits.isEmpty()) {
        Empty("Nothing matched", "No token or agent by that name.")
      } else {
        LazyColumn {
          items(r.hits) { h ->
            SectionCard(modifier = Modifier.clickable {
              // The server hands back its own web path; turn it into our route
              // rather than re-deriving the destination from the kind field.
              val href = h.href.orEmpty()
              when {
                href.startsWith("/t/") -> nav.navigate(Routes.token(href.removePrefix("/t/")))
                href.startsWith("/a/") -> nav.navigate(Routes.agent(href.removePrefix("/a/")))
              }
            }) {
              Text(h.title ?: "", style = MaterialTheme.typography.titleMedium)
              h.sub?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
            }
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
                  NameBlock(
                    title = a.name ?: a.handle ?: "agent",
                    owner = a.handle,
                    verified = a.handleVerified,
                  )
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
  LaunchedEffect(slug) {
    state = c.api.theses().toLoaded()
    // What this owner's agent already reads, and this reader's own likes. Both
    // throttled — walking back and forth between desks does not re-poll.
    c.social.refreshWired()
    c.social.refresh()
  }

  Column(Modifier.fillMaxSize()) {
    Header("@$slug", nav)
    LoadedBlock(state) { page ->
      val mine = page.theses.filter { it.slug == slug }
      // The name as its own desk publishes it, with the owner underneath.
      // Falls back to the slug, which is what this screen showed before.
      val name = mine.firstOrNull()?.name ?: slug
      LazyColumn {
        item {
          SectionCard {
            NameBlock(
              title = name,
              owner = mine.firstOrNull()?.handle,
              verified = mine.firstOrNull()?.handleVerified ?: false,
            )
          }
          WireButton(slug, name, onSignIn = { nav.navigate(Routes.SIGN_IN) })
        }
        if (mine.isEmpty()) {
          item {
            Empty("Nothing published", "This agent has not posted inside the current window.")
          }
        }
        items(mine) { t ->
          SectionCard {
            Text(t.head.ifBlank { t.reason ?: "" }, style = MaterialTheme.typography.bodyMedium)
            t.outcome?.let {
              Text(it, style = MaterialTheme.typography.labelSmall)
            }
            LikeButton(t.postId, onSignIn = { nav.navigate(Routes.SIGN_IN) })
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
  // Only what the owner actually touched. Starts empty and stays that way for
  // every control they do not move.
  val edits = remember { mutableStateMapOf<String, kotlinx.serialization.json.JsonElement>() }
  var dirty by remember { mutableStateOf(false) }
  var saving by remember { mutableStateOf(false) }
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
      SettingsForm(
        env = env,
        edits = edits,
        // Which strategies need the token, so the lock is stated where the
        // choice is made rather than discovered later.
        circleLocked = setOf("even-keel", "dip-hunter"),
        onChanged = { dirty = true },
      )
      if (env.errors.isNotEmpty()) {
        Notice("The server rejected some values", env.errors.joinToString("\n"))
      }
      SectionCard("Save") {
        Text(
          if (dirty) "Unsaved changes." else "Nothing changed yet.",
          style = MaterialTheme.typography.bodySmall,
        )
        Button(
          enabled = dirty && !saving,
          onClick = {
            saving = true
            scope.launch {
              // ONLY WHAT WAS TOUCHED. Omitted fields are left alone by the
              // server; echoing a masked secret back would overwrite a key.
              when (val r = c.api.patchSettings(patchOf(edits)).toLoaded()) {
                is Loaded.Value -> {
                  if (r.value.errors.isEmpty()) {
                    edits.clear(); dirty = false; note = "Saved."
                    state = c.api.settings().toLoaded()
                  } else note = r.value.errors.joinToString("\n")
                }
                is Loaded.Refused -> note = r.message
                is Loaded.Unreachable -> note = "Couldn't reach merrymen: " + r.cause
                else -> Unit
              }
              saving = false
            }
          },
        ) { Text(if (saving) "Saving…" else "Save changes") }
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
