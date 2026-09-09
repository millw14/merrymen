package dev.merrymen.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
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
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.navigation.NavHostController
import dev.merrymen.app.LocalContainer
import dev.merrymen.app.data.Loaded
import dev.merrymen.app.data.toLoaded
import dev.merrymen.app.net.ProposalsView
import dev.merrymen.app.ui.Acted
import dev.merrymen.app.ui.LoadedBlock
import dev.merrymen.app.ui.Money
import dev.merrymen.app.ui.Notice
import dev.merrymen.app.ui.Pill
import dev.merrymen.app.ui.RISK_PROFILES
import dev.merrymen.app.ui.Routes
import dev.merrymen.app.ui.SectionCard
import dev.merrymen.app.ui.applyRisk
import dev.merrymen.app.ui.approveProposals
import dev.merrymen.app.ui.placeOrder
import dev.merrymen.app.ui.snipe
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

@Composable
private fun Head(title: String, nav: NavHostController) {
  Row(
    Modifier.fillMaxWidth().padding(horizontal = 16.dp, vertical = 12.dp),
    verticalAlignment = Alignment.CenterVertically,
    horizontalArrangement = Arrangement.SpaceBetween,
  ) {
    Text(title, style = MaterialTheme.typography.headlineSmall)
    TextButton(onClick = { nav.popBackStack() }) { Text("Back") }
  }
}

// ── PROPOSALS ───────────────────────────────────────────────────────────────

/**
 * Coins the scout has vetted, and the one-tap approval.
 *
 * WHAT APPROVING ACTUALLY DOES is said on the card rather than discovered: it
 * adds the coin to what the agent watches AND to what it may trade, and it
 * still cannot buy until the owner re-signs — because the permission is sealed
 * into the key, not into settings. `covered` is shown for the same reason: a
 * re-sign re-authorises the WHOLE list, not just the coin just added, and the
 * owner is entitled to know that before they sign.
 */
@Composable
fun ProposalsScreen(nav: NavHostController) {
  val c = LocalContainer.current
  var state by remember { mutableStateOf<Loaded<ProposalsView>>(Loaded.Loading) }
  var busy by remember { mutableStateOf(false) }
  var note by remember { mutableStateOf<String?>(null) }
  val scope = rememberCoroutineScope()

  suspend fun load() { state = c.api.proposals().toLoaded() }
  LaunchedEffect(Unit) { load() }

  Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
    Head("Coins to consider", nav)
    note?.let { Notice("Watchlist", it) }
    LoadedBlock(state, onSignIn = { nav.navigate(Routes.SIGN_IN) }, onRetry = { scope.launch { load() } }) { v ->
      if (v.proposals.isEmpty()) {
        // FIVE REASONS FOR AN EMPTY LIST, and they are not the same sentence.
        Notice(
          title = when (v.why) {
            "signed-out" -> "Sign in to see these"
            "no-grant" -> "No agent yet"
            "all-covered" -> "Nothing new"
            "unreadable" -> "Couldn't read the scout"
            else -> "Nothing vetted yet"
          },
          body = when (v.why) {
            "signed-out" -> "These are scoped to your agent's signature."
            "no-grant" -> "Create an agent first — there is nothing to widen yet."
            "all-covered" -> "Everything the scout liked is already covered by your key."
            "unreadable" -> "That is our read failing, not an empty shortlist."
            else -> "Nothing has cleared the screen recently. That is not the same as nothing looking good."
          },
          actionLabel = if (v.why == "signed-out") "Sign in" else null,
          onAction = { nav.navigate(Routes.SIGN_IN) },
        )
      } else {
        SectionCard("Before you approve") {
          Text(
            "Approving adds a coin to what your agent watches and may trade. It still cannot " +
              "buy until you re-sign — and re-signing re-authorises all ${v.covered} tokens your " +
              "key already covers, not just this one.",
            style = MaterialTheme.typography.bodySmall,
          )
          Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(enabled = !busy, onClick = {
              busy = true
              scope.launch {
                val r = approveProposals(c.repo, v.proposals)
                note = when (r) { is Acted.Ok -> r.line; is Acted.Failed -> r.line; else -> null }
                busy = false
                load()
              }
            }) { Text("Add all ${v.proposals.size}") }
            TextButton(onClick = { nav.navigate(Routes.web("/grant#resign", "Re-sign")) }) {
              Text("Re-sign my permission")
            }
          }
        }
        v.proposals.forEach { p ->
          SectionCard(p.symbol) {
            p.reason?.let { Text(it, style = MaterialTheme.typography.bodySmall) }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
              Text("Price", style = MaterialTheme.typography.bodySmall)
              Money(p.priceUsd)
            }
            if (p.onCurve) {
              Text(
                "Still on its launch curve — there is no pool, so an ordinary swap cannot reach it.",
                style = MaterialTheme.typography.bodySmall,
              )
            }
            if (p.watched) Text("Already watched, but not covered by your key.", style = MaterialTheme.typography.bodySmall)
            Button(enabled = !busy, onClick = {
              busy = true
              scope.launch {
                val r = approveProposals(c.repo, listOf(p))
                note = when (r) { is Acted.Ok -> r.line; is Acted.Failed -> r.line; else -> null }
                busy = false
                load()
              }
            }) { Text("Add ${p.symbol}") }
          }
        }
      }
    }
  }
}

// ── TRADE ───────────────────────────────────────────────────────────────────

/**
 * Place a buy or a sell, or go after a coin by name.
 *
 * "Queued" is not "filled" and this screen never says otherwise: the worker
 * claims the order on its next tick and the wall decides. So it polls and
 * reports what actually became of it.
 */
@Composable
fun TradeScreen(nav: NavHostController) {
  val c = LocalContainer.current
  var symbol by remember { mutableStateOf("") }
  var amount by remember { mutableStateOf("") }
  var query by remember { mutableStateOf("") }
  var busy by remember { mutableStateOf(false) }
  var note by remember { mutableStateOf<String?>(null) }
  var followed by remember { mutableStateOf<String?>(null) }
  val scope = rememberCoroutineScope()

  /** Poll until the worker has answered, then say what it said. */
  suspend fun follow(id: String?) {
    if (id == null) return
    repeat(20) {
      delay(3_000)
      val st = c.api.orderStatus(id)
      if (st is dev.merrymen.app.net.ApiResult.Ok) {
        val s = st.value
        if (s.state == "done") { followed = s.result ?: "Done."; return }
        followed = "Still with your agent (${s.state})…"
      }
    }
    // A TIMEOUT IS NOT A FAILURE AND NOT A FILL. Say only what is true.
    followed = "Still waiting on your agent. It will show on your feed when it lands."
  }

  Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
    Head("Trade", nav)
    note?.let { Notice("Your order", it) }
    followed?.let { Notice("Outcome", it) }

    SectionCard("Buy or sell a symbol") {
      OutlinedTextField(
        value = symbol,
        onValueChange = { symbol = it.uppercase() },
        label = { Text("Symbol") },
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
      )
      OutlinedTextField(
        value = amount,
        onValueChange = { amount = it },
        label = { Text("Amount (USDG)") },
        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal),
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
      )
      Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        listOf("buy", "sell").forEach { side ->
          Button(
            enabled = !busy && symbol.isNotBlank() && (amount.toDoubleOrNull() ?: 0.0) > 0,
            onClick = {
              busy = true; followed = null
              scope.launch {
                val (r, id) = placeOrder(c.repo, side, symbol, amount.toDouble())
                note = when (r) { is Acted.Ok -> r.line; is Acted.Failed -> r.line; else -> null }
                busy = false
                follow(id)
              }
            },
          ) { Text(side.replaceFirstChar { it.uppercase() }) }
        }
      }
      Text(
        "Your key's per-trade and per-day caps still decide whether it goes through. " +
          "A sell clamps down to the position; a bonding-curve coin must be sold whole.",
        style = MaterialTheme.typography.bodySmall,
      )
    }

    SectionCard("Go after a coin by name") {
      OutlinedTextField(
        value = query,
        onValueChange = { query = it },
        label = { Text("Name or ticker") },
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
      )
      Button(
        enabled = !busy && query.isNotBlank() && (amount.toDoubleOrNull() ?: 0.0) > 0,
        onClick = {
          busy = true; followed = null
          scope.launch {
            val (r, id) = snipe(c.repo, query, amount.toDouble())
            note = when (r) {
              is Acted.Ok -> r.line
              is Acted.Failed -> r.line
              // TWO COINS WITH ONE NAME IS A QUESTION, NOT A PICK.
              is Acted.Ambiguous -> r.line + " — " + r.candidates.joinToString(", ")
              is Acted.NeedsSignature -> r.line
            }
            busy = false
            follow(id)
          }
        },
      ) { Text("Find it and buy") }
      Text(
        "If more than one coin answers to that name it asks rather than guesses, and if your " +
          "key doesn't cover it yet it says so instead of failing.",
        style = MaterialTheme.typography.bodySmall,
      )
    }
  }
}

// ── RISK ────────────────────────────────────────────────────────────────────

/**
 * One tap for sizing and both exit rules.
 *
 * AND WHAT IT CANNOT REACH, said on the screen: the per-trade and per-day caps
 * live in the signature and are enforced on-chain. No settings write moves
 * them — only a new signature does — and a risk control that quietly implied
 * otherwise would be the most expensive kind of wrong.
 */
@Composable
fun RiskScreen(nav: NavHostController) {
  val c = LocalContainer.current
  var current by remember { mutableStateOf<String?>(null) }
  var busy by remember { mutableStateOf(false) }
  var note by remember { mutableStateOf<String?>(null) }
  val scope = rememberCoroutineScope()

  Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
    Head("How much risk?", nav)
    note?.let { Notice("Risk", it) }
    RISK_PROFILES.forEach { p ->
      SectionCard(p.name) {
        Text(p.blurb, style = MaterialTheme.typography.bodySmall)
        Text(
          "Sells at ${p.stopLossBps / 100}% down or ${p.takeProfitBps / 100}% up · " +
            "$${p.buyPerTickUsdg} a trade · slippage ${p.slippageBps / 100.0}%",
          style = MaterialTheme.typography.bodySmall,
        )
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
          Pill(if (current == p.level) "Selected" else "Choose", current == p.level) {
            busy = true
            scope.launch {
              val r = applyRisk(c.repo, p.level)
              note = when (r) { is Acted.Ok -> r.line; is Acted.Failed -> r.line; else -> null }
              if (r is Acted.Ok) current = p.level
              busy = false
            }
          }
        }
      }
    }
    SectionCard("What this does not touch") {
      Text(
        "Your per-trade and per-day caps are sealed into your key and enforced on-chain. " +
          "Nothing on this screen can move them — only a new signature can.",
        style = MaterialTheme.typography.bodySmall,
      )
      TextButton(onClick = { nav.navigate(Routes.web("/grant#resign", "Signed limits")) }) {
        Text("Edit signed limits")
      }
    }
  }
}
