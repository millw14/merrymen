package dev.merrymen.app.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.navigation.NavHostController
import dev.merrymen.app.LocalContainer
import dev.merrymen.app.ui.AgentFace
import dev.merrymen.app.ui.MerryColors
import dev.merrymen.app.ui.Routes
import dev.merrymen.app.ui.feed.BOARD_EVERY_MS
import dev.merrymen.app.ui.feed.ReadState
import dev.merrymen.app.ui.feed.pollWhileResumed
import dev.merrymen.app.ui.feed.staleLine
import kotlinx.coroutines.launch

@Composable
internal fun HomeDiscovery(nav: NavHostController) {
  val c = LocalContainer.current
  val turn by c.repo.serverTurn.collectAsState()
  val reads = remember(c.publicDirectory, turn) { c.publicDirectory.forTurn(turn) }
  val slot by reads.board.collectAsState()
  val lifecycle = LocalLifecycleOwner.current.lifecycle
  val scope = rememberCoroutineScope()
  LaunchedEffect(reads, lifecycle) {
    if (c.api.servers.holds(turn)) lifecycle.pollWhileResumed(listOf(reads.loop))
  }
  BoxWithConstraints(Modifier.fillMaxWidth()) {
    // Make room for the user's font size instead of splitting short labels.
    val stacked = maxWidth.value / LocalDensity.current.fontScale < 280f
    Column(Modifier.fillMaxWidth().padding(bottom = 24.dp)) {
      if (stacked) {
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(8.dp)) {
          LinkChip("Agents", Modifier.fillMaxWidth()) { nav.navigate(Routes.LEADERBOARD) }
          LinkChip("Activity", Modifier.fillMaxWidth()) { nav.navigate(Routes.FEED) }
          LinkChip("Markets", Modifier.fillMaxWidth()) { nav.navigate(Routes.MARKETS) }
        }
        Column(Modifier.fillMaxWidth().padding(top = 14.dp)) {
          Text("Explore agents", color = MerryColors.tx, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
          TextButton(onClick = { nav.navigate(Routes.LEADERBOARD) }) { Text("View all", color = MerryColors.mint) }
        }
      } else {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
          LinkChip("Agents", Modifier.weight(1f)) { nav.navigate(Routes.LEADERBOARD) }
          LinkChip("Activity", Modifier.weight(1f)) { nav.navigate(Routes.FEED) }
          LinkChip("Markets", Modifier.weight(1f)) { nav.navigate(Routes.MARKETS) }
        }
        Row(
          Modifier.fillMaxWidth().padding(top = 14.dp),
          horizontalArrangement = Arrangement.SpaceBetween,
          verticalAlignment = Alignment.CenterVertically,
        ) {
          Text("Explore agents", color = MerryColors.tx, fontSize = 18.sp, fontWeight = FontWeight.SemiBold)
          TextButton(onClick = { nav.navigate(Routes.LEADERBOARD) }) { Text("View all", color = MerryColors.mint) }
        }
      }
      val board = slot.body
      when {
        board != null && slot.state == ReadState.OK -> {
          if (board.agents.isEmpty()) {
            Text("No public agents to show yet.", color = MerryColors.tx2, fontSize = 14.sp)
          } else {
            // This is discovery, not a ranking: the fast directory deliberately
            // does not read accounting. Do not turn absent figures into returns.
            board.agents.take(3).forEach { agent ->
              val slug = agent.slug
              val name = agent.name ?: slug ?: "Agent"
              Row(
                Modifier.fillMaxWidth()
                  .clickable(enabled = slug != null, role = Role.Button) { slug?.let { nav.navigate(Routes.agent(it)) } }
                  .padding(vertical = 10.dp),
                horizontalArrangement = Arrangement.spacedBy(12.dp),
                verticalAlignment = Alignment.CenterVertically,
              ) {
                AgentFace(slug = slug, name = name, size = 32.dp)
                Column(Modifier.weight(1f)) {
                  Text(name, color = MerryColors.tx, fontSize = 15.sp, fontWeight = FontWeight.SemiBold)
                  agent.handle?.trim()?.removePrefix("@")?.takeIf { agent.handleVerified == true && it.isNotBlank() }?.let {
                    Text("@$it", color = MerryColors.tx2, fontSize = 12.sp)
                  }
                }
                val mode = when {
                  agent.notRunning -> "Not running"
                  agent.mode == "paper" -> "Paper"
                  agent.mode == "live" -> "Live"
                  agent.mode == "idle" -> "Inactive"
                  else -> null
                }
                mode?.let { Text(it, color = MerryColors.tx2, fontSize = 12.sp) }
              }
            }
          }
          val now = System.currentTimeMillis()
          val freshness = staleLine(slot, "agents", now)
            ?: slot.okAtMs?.takeIf { now - it >= BOARD_EVERY_MS }?.let { "Showing the last loaded agents while we refresh." }
          freshness?.let { Text(it, color = MerryColors.tx2, fontSize = 12.sp) }
        }
        slot.failure != null -> {
          Text("Agents couldn’t load just now.", color = MerryColors.tx2, fontSize = 14.sp)
          TextButton(onClick = { scope.launch { reads.loop.readNow(System.currentTimeMillis()) } }) {
            Text("Try again", color = MerryColors.mint)
          }
        }
        else -> Text("Loading agents…", color = MerryColors.tx2, fontSize = 14.sp)
      }
    }
  }
}
