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
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import androidx.navigation.NavHostController
import dev.merrymen.app.LocalContainer
import dev.merrymen.app.data.Loaded
import dev.merrymen.app.data.toLoaded
import dev.merrymen.app.net.ChatBody
import dev.merrymen.app.net.ChatTurnWire
import dev.merrymen.app.net.Feed
import dev.merrymen.app.net.Thesis
import dev.merrymen.app.net.TierView
import dev.merrymen.app.ui.Bps
import dev.merrymen.app.ui.Empty
import dev.merrymen.app.ui.LoadedBlock
import dev.merrymen.app.ui.Money
import dev.merrymen.app.ui.NameBlock
import dev.merrymen.app.ui.Notice
import dev.merrymen.app.ui.Pill
import dev.merrymen.app.ui.Routes
import dev.merrymen.app.ui.SectionCard
import dev.merrymen.app.ui.toneOf
import dev.merrymen.app.ui.verbOf
import kotlinx.coroutines.launch

@Composable
private fun ScreenTitle(text: String, trailing: (@Composable () -> Unit)? = null) {
  Row(
    Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.SpaceBetween,
  ) {
    Text(text, style = MaterialTheme.typography.headlineSmall)
    trailing?.invoke()
  }
}

// ── HOME ────────────────────────────────────────────────────────────────────

@Composable
fun HomeScreen(nav: NavHostController) {
  val c = LocalContainer.current
  var feed by remember { mutableStateOf<Loaded<Feed>>(Loaded.Loading) }
  var tier by remember { mutableStateOf<Loaded<TierView>>(Loaded.Loading) }
  val scope = rememberCoroutineScope()

  suspend fun load() {
    feed = c.api.feed().toLoaded()
    tier = c.api.tier().toLoaded()
  }
  LaunchedEffect(Unit) { load() }

  Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
    ScreenTitle("merrymen") {
      TextButton(onClick = { nav.navigate(Routes.SEARCH) }) { Text("Search") }
    }

    CircleLockBanner(tier, nav)

    LoadedBlock(
      feed,
      onSignIn = { nav.navigate(Routes.SIGN_IN) },
      onRetry = { scope.launch { load() } },
    ) { f ->
      SectionCard("Your agent") {
        Text(f.agent?.name ?: "No agent yet", style = MaterialTheme.typography.titleMedium)
        Row(verticalAlignment = Alignment.CenterVertically) {
          Text("Portfolio  ", style = MaterialTheme.typography.bodySmall)
          Money(f.equityNow, bold = true)
        }
        // The mode chip is a fact about the RAIL, not a performance claim.
        f.agent?.strategy?.let { Text(it, style = MaterialTheme.typography.labelSmall) }
        if (f.agent?.basket?.isNotEmpty() == true) {
          Text("Trading " + f.agent.basket.joinToString(", "), style = MaterialTheme.typography.bodySmall)
        }
      }

      // THE WORKER'S OWN WARNING, which for a long time rendered nowhere at all.
      f.events.firstOrNull { it.level == "warn" || it.level == "err" || it.level == "error" }
        ?.message?.let { Notice(title = "From your agent", body = it) }

      SectionCard("Positions") {
        if (f.positions.isEmpty()) {
          Text("Nothing held right now.", style = MaterialTheme.typography.bodySmall)
        } else {
          f.positions.forEach { p ->
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
              Column {
                Text(p.symbol, style = MaterialTheme.typography.bodyMedium)
                if (p.priceStale) {
                  Text(
                    "price stale — last good mark",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                  )
                }
              }
              Money(p.valueUsdg)
            }
          }
        }
      }

      SectionCard("Go") {
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
          TextButton(onClick = { nav.navigate(Routes.MARKETS) }) { Text("Markets") }
          TextButton(onClick = { nav.navigate(Routes.LEADERBOARD) }) { Text("Leaderboard") }
          TextButton(onClick = { nav.navigate(Routes.SETTINGS) }) { Text("Settings") }
        }
      }
    }
    Spacer(Modifier.height(24.dp))
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
 * must never render as "you don't hold enough", and signed-out is a door.
 */
@Composable
private fun CircleLockBanner(tier: Loaded<TierView>, nav: NavHostController) {
  val t = (tier as? Loaded.Value)?.value ?: return
  when {
    t.why == "unreadable" -> Notice(
      title = "Couldn't read your \$MERRYMEN balance",
      body = "That's our chain read failing, not your wallet. It should clear on its own.",
    )
    t.why == "ok" && !t.bonusStrategies -> Notice(
      title = "Holder-only strategies are locked",
      body = "even-keel and dip-hunter run only while you hold ${t.needTokens} \$MERRYMEN — " +
        "you hold ${t.tokens ?: 0}. Adding cash won't change it.",
      actionLabel = "See the Circle",
      onAction = { nav.navigate(Routes.CIRCLE) },
    )
  }
}

// ── FEED ────────────────────────────────────────────────────────────────────

@Composable
fun FeedScreen(nav: NavHostController) {
  val c = LocalContainer.current
  var page by remember { mutableStateOf<Loaded<List<Thesis>>>(Loaded.Loading) }
  var filter by remember { mutableStateOf("All") }
  val scope = rememberCoroutineScope()

  suspend fun load() { page = c.api.theses().toLoaded().let { s ->
    when (s) {
      is Loaded.Value -> Loaded.Value(s.value.theses)
      is Loaded.Refused -> s
      is Loaded.Unreachable -> s
      else -> Loaded.Loading
    }
  } }
  LaunchedEffect(Unit) { load() }

  Column(Modifier.fillMaxSize()) {
    ScreenTitle("Feed")
    Row(
      Modifier.fillMaxWidth().padding(horizontal = 16.dp),
      horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      listOf("All", "Trades", "Theses").forEach { f ->
        Pill(f, filter == f) { filter = f }
      }
    }
    Spacer(Modifier.height(8.dp))
    LoadedBlock(page, onSignIn = { nav.navigate(Routes.SIGN_IN) }, onRetry = { scope.launch { load() } }) { rows ->
      val shown = rows.filter {
        when (filter) {
          "Trades" -> it.action == "buy" || it.action == "sell"
          "Theses" -> it.action == null || it.action == "hold" || it.outcome == "view"
          else -> true
        }
      }
      if (shown.isEmpty()) {
        Empty("Nothing here yet", "When agents trade or publish a view, it lands here.")
      } else {
        LazyColumn(Modifier.fillMaxSize()) {
          items(shown) { t -> ThesisRow(t) { t.slug?.let { nav.navigate(Routes.agent(it)) } } }
        }
      }
    }
  }
}

@Composable
private fun ThesisRow(t: Thesis, onOpen: () -> Unit) {
  SectionCard(modifier = Modifier.clickable(onClick = onOpen)) {
    Row(verticalAlignment = Alignment.CenterVertically) {
      NameBlock(
        title = t.name ?: t.handle ?: "an agent",
        owner = t.handle,
        verified = t.handleVerified,
      )
      Spacer(Modifier.width(6.dp))
      // The verb carries the outcome. "tried to buy", never "bought", for a
      // trade the wall turned back.
      Text(
        verbOf(t.action, t.outcome, t.shadow),
        style = MaterialTheme.typography.bodyMedium,
        color = toneOf(t.action, t.outcome),
      )
      t.symbol?.let {
        Spacer(Modifier.width(6.dp))
        Text(it, style = MaterialTheme.typography.bodyMedium)
      }
    }
    if (t.paper) {
      Text("paper — simulated, not real money", style = MaterialTheme.typography.labelSmall)
    }
    t.outcomeText?.takeIf { t.outcome == "refused" || t.outcome == "reverted" || t.outcome == "dropped" }?.let {
      Text("— $it", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    (t.reason ?: t.head).takeIf { it.isNotBlank() }?.let {
      Text(it, style = MaterialTheme.typography.bodySmall)
    }
  }
}

// ── CHAT ────────────────────────────────────────────────────────────────────

@Composable
fun ChatScreen(nav: NavHostController) {
  val c = LocalContainer.current
  val turns = remember { mutableStateListOf<ChatTurnWire>() }
  var draft by remember { mutableStateOf("") }
  var sending by remember { mutableStateOf(false) }
  var error by remember { mutableStateOf<String?>(null) }
  val scope = rememberCoroutineScope()

  Column(Modifier.fillMaxSize()) {
    ScreenTitle("Chat")
    error?.let { Notice("Couldn't send that", it) }
    LazyColumn(Modifier.weight(1f)) {
      items(turns) { turn ->
        SectionCard(title = if (turn.role == "user") "You" else "Your agent") {
          Text(turn.content, style = MaterialTheme.typography.bodyMedium)
        }
      }
    }
    Row(
      Modifier.fillMaxWidth().padding(12.dp),
      verticalAlignment = Alignment.CenterVertically,
      horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      OutlinedTextField(
        value = draft,
        onValueChange = { draft = it },
        modifier = Modifier.weight(1f),
        placeholder = { Text("Ask your agent") },
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Send),
        singleLine = false,
      )
      Button(
        enabled = draft.isNotBlank() && !sending,
        onClick = {
          val msg = draft.trim()
          draft = ""
          sending = true
          error = null
          turns.add(ChatTurnWire("user", msg))
          scope.launch {
            when (val r = c.api.chat(ChatBody(message = msg, history = turns.toList())).toLoaded()) {
              is Loaded.Value -> {
                // `reply: null` with a `why` is the server declining to speak,
                // not an empty answer. Say which.
                val text = r.value.reply
                if (text.isNullOrBlank()) error = r.value.why ?: "no reply"
                else turns.add(ChatTurnWire("assistant", text))
              }
              is Loaded.Refused -> error = r.message
              is Loaded.Unreachable -> error = "couldn't reach merrymen: " + r.cause
              else -> Unit
            }
            sending = false
          }
        },
      ) { Text(if (sending) "…" else "Send") }
    }
  }
}

// ── ALPHA ───────────────────────────────────────────────────────────────────

@Composable
fun AlphaScreen(nav: NavHostController) {
  val c = LocalContainer.current
  var state by remember { mutableStateOf<Loaded<dev.merrymen.app.net.AlphaView>>(Loaded.Loading) }
  val scope = rememberCoroutineScope()
  suspend fun load() { state = c.api.alpha().toLoaded() }
  LaunchedEffect(Unit) { load() }

  Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
    ScreenTitle("Alpha")
    LoadedBlock(state, onSignIn = { nav.navigate(Routes.SIGN_IN) }, onRetry = { scope.launch { load() } }) { a ->
      if (a.locked) {
        // THE BODY IS NOT HERE TO HIDE. The server omits `picks` entirely when
        // locked; there is nothing to blur, which is the point.
        Notice(
          title = "An edge for holders",
          body = when (a.why) {
            "sign-in" -> "Sign in to see whether your wallet qualifies."
            "unreachable" -> "Couldn't verify your holdings — that's our read failing, not your wallet."
            else -> "Alpha opens at ${a.needTokens ?: 100_000} ${a.symbol ?: "\$MERRYMEN"}." +
              (a.tokens?.let { " You hold $it." } ?: "")
          },
          actionLabel = if (a.why == "sign-in") "Sign in" else "See the Circle",
          onAction = {
            if (a.why == "sign-in") nav.navigate(Routes.SIGN_IN) else nav.navigate(Routes.CIRCLE)
          },
        )
      } else if (a.pickRows.isEmpty()) {
        Empty("Nothing vetted yet", "Nothing has cleared the screen recently. That is not the same as nothing looking good.")
      } else {
        a.pickRows.forEach { pick ->
          SectionCard { Text(pick.toString(), style = MaterialTheme.typography.bodySmall) }
        }
      }
    }
  }
}

// ── PROFILE ─────────────────────────────────────────────────────────────────

@Composable
fun ProfileScreen(nav: NavHostController) {
  val c = LocalContainer.current
  val signedIn by c.repo.signedIn.collectAsState()
  var feed by remember { mutableStateOf<Loaded<Feed>>(Loaded.Loading) }
  val scope = rememberCoroutineScope()
  LaunchedEffect(Unit) { feed = c.api.feed().toLoaded() }

  Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
    ScreenTitle("You")
    if (signedIn == null) {
      Notice(
        title = "Not signed in",
        body = "Signing in proves you control your owner key. It moves no funds and grants no permissions.",
        actionLabel = "Sign in",
        onAction = { nav.navigate(Routes.SIGN_IN) },
      )
    }

    SectionCard("Your account") {
      LoadedBlock(feed) { f ->
        Text(f.agent?.name ?: "No agent yet", style = MaterialTheme.typography.titleMedium)
        f.agent?.owner?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
        Row(verticalAlignment = Alignment.CenterVertically) {
          Text("24h  ", style = MaterialTheme.typography.bodySmall)
          Bps(null)
        }
      }
    }

    SectionCard("Controls") {
      TextButton(onClick = { nav.navigate(Routes.SETTINGS) }) { Text("Settings") }
      TextButton(onClick = { nav.navigate(Routes.TELEGRAM) }) { Text("Telegram") }
      TextButton(onClick = { nav.navigate(Routes.CIRCLE) }) { Text("The Merry Circle") }
    }

    // EVERY ONE OF THESE ENDS IN A SIGNATURE, so every one is a handoff to the
    // web app rather than a native reimplementation of key custody.
    SectionCard("Wallet & permissions") {
      Text(
        "These need your owner key, so they open the merrymen web app inside this one. " +
          "This app never holds a key.",
        style = MaterialTheme.typography.bodySmall,
      )
      TextButton(onClick = { nav.navigate(Routes.web("/grant", "Wallet & permissions")) }) { Text("Wallet & permissions") }
      TextButton(onClick = { nav.navigate(Routes.web("/limits", "Trading limits")) }) { Text("Trading limits") }
      TextButton(onClick = { nav.navigate(Routes.web("/deposit", "Add funds")) }) { Text("Add funds") }
      TextButton(onClick = { nav.navigate(Routes.web("/withdraw", "Withdraw")) }) { Text("Withdraw") }
      TextButton(onClick = { nav.navigate(Routes.web("/create", "Create an agent")) }) { Text("Create an agent") }
    }

    if (signedIn != null) {
      SectionCard("Session") {
        TextButton(onClick = { scope.launch { c.repo.signOut() } }) { Text("Sign out") }
      }
    }
    Spacer(Modifier.height(24.dp))
  }
}
