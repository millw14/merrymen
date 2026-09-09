package dev.merrymen.app.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import dev.merrymen.app.data.Loaded
import java.util.Locale

/**
 * A FIGURE, OR THE REASON THERE ISN'T ONE.
 *
 * The em dash is not a placeholder for zero. "$0.00" says we asked and the
 * answer was nothing; "—" says we never got an answer. This app renders those
 * differently everywhere, because the product they belong to spent real money
 * learning that collapsing them is how an owner gets told they hold nothing on
 * the strength of a rate limit.
 */
@Composable
fun Money(value: Double?, modifier: Modifier = Modifier, bold: Boolean = false) {
  Text(
    text = value?.let { "$" + String.format(Locale.US, "%,.2f", it) } ?: "—",
    style = MaterialTheme.typography.bodyMedium.merge(MonoNumbers),
    fontWeight = if (bold) FontWeight.SemiBold else FontWeight.Normal,
    color = if (value == null) MaterialTheme.colorScheme.onSurfaceVariant
    else MaterialTheme.colorScheme.onSurface,
    modifier = modifier,
  )
}

/** Basis points, signed, coloured only when money actually moved. */
@Composable
fun Bps(value: Int?, modifier: Modifier = Modifier) {
  val text = value?.let { (if (it >= 0) "+" else "") + String.format(Locale.US, "%.2f", it / 100.0) + "%" } ?: "—"
  Text(
    text = text,
    style = MaterialTheme.typography.bodyMedium.merge(MonoNumbers),
    color = when {
      value == null -> MaterialTheme.colorScheme.onSurfaceVariant
      value > 0 -> Up
      value < 0 -> Down
      else -> MaterialTheme.colorScheme.onSurface
    },
    modifier = modifier,
  )
}

@Composable
fun SectionCard(
  title: String? = null,
  modifier: Modifier = Modifier,
  content: @Composable ColumnScope.() -> Unit,
) {
  Column(
    modifier = modifier
      .fillMaxWidth()
      .padding(horizontal = 16.dp, vertical = 6.dp)
      .background(MaterialTheme.colorScheme.surface, RoundedCornerShape(14.dp))
      .border(1.dp, MaterialTheme.colorScheme.outline, RoundedCornerShape(14.dp))
      .padding(14.dp),
    verticalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    if (title != null) {
      Text(
        title.uppercase(Locale.US),
        style = MaterialTheme.typography.labelSmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    }
    content()
  }
}

/**
 * THE THREE-STATE RENDERER, so no screen has to reinvent the distinction.
 *
 * Refused-with-401 is a door, not an emptiness. Unreachable is our failure, not
 * the account's. Both get a next action, because a dead end with no next action
 * is what sends somebody to a JSON endpoint to work out what happened — which a
 * tester in this beta actually did.
 */
@Composable
fun <T> LoadedBlock(
  state: Loaded<T>,
  onSignIn: (() -> Unit)? = null,
  onRetry: (() -> Unit)? = null,
  content: @Composable (T) -> Unit,
) {
  when (state) {
    is Loaded.Idle -> Unit
    is Loaded.Loading -> Box(Modifier.fillMaxWidth().padding(24.dp), Alignment.Center) {
      CircularProgressIndicator(strokeWidth = 2.dp)
    }
    is Loaded.Value -> content(state.value)
    is Loaded.Refused -> Notice(
      title = if (state.status == 401) "Sign in to see this" else "The server said no",
      body = state.message,
      actionLabel = if (state.status == 401 && onSignIn != null) "Sign in" else null,
      onAction = onSignIn,
    )
    is Loaded.Unreachable -> Notice(
      title = "Couldn't reach merrymen",
      // Deliberately OUR failure, in our words. Not "you are offline" — we do
      // not know that, and telling somebody their connection is broken when the
      // server is down sends them to reset a router.
      body = "That's this app failing to get an answer, not a fact about your account. " + state.cause,
      actionLabel = if (onRetry != null) "Try again" else null,
      onAction = onRetry,
    )
  }
}

@Composable
fun Notice(
  title: String,
  body: String,
  actionLabel: String? = null,
  onAction: (() -> Unit)? = null,
  tone: Color? = null,
) {
  Column(
    Modifier
      .fillMaxWidth()
      .padding(horizontal = 16.dp, vertical = 6.dp)
      .background(MaterialTheme.colorScheme.surfaceVariant, RoundedCornerShape(14.dp))
      .border(1.dp, tone ?: MaterialTheme.colorScheme.outline, RoundedCornerShape(14.dp))
      .padding(14.dp),
    verticalArrangement = Arrangement.spacedBy(6.dp),
  ) {
    Text(title, style = MaterialTheme.typography.titleMedium, color = tone ?: MaterialTheme.colorScheme.onSurface)
    Text(body, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    if (actionLabel != null && onAction != null) {
      TextButton(onClick = onAction) { Text(actionLabel) }
    }
  }
}

@Composable
fun Pill(text: String, selected: Boolean, onClick: () -> Unit) {
  val bg = if (selected) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surface
  val fg = if (selected) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant
  Box(
    Modifier
      .background(bg, RoundedCornerShape(999.dp))
      .border(1.dp, MaterialTheme.colorScheme.outline, RoundedCornerShape(999.dp))
      .clickable(onClick = onClick)
      .padding(horizontal = 14.dp, vertical = 7.dp),
  ) {
    Text(text, style = MaterialTheme.typography.bodySmall, color = fg)
  }
}

@Composable
fun Empty(title: String, body: String, actionLabel: String? = null, onAction: (() -> Unit)? = null) {
  Column(
    Modifier.fillMaxWidth().padding(32.dp),
    horizontalAlignment = Alignment.CenterHorizontally,
    verticalArrangement = Arrangement.spacedBy(8.dp),
  ) {
    Text(title, style = MaterialTheme.typography.titleMedium)
    Text(
      body,
      style = MaterialTheme.typography.bodySmall,
      color = MaterialTheme.colorScheme.onSurfaceVariant,
    )
    if (actionLabel != null && onAction != null) Button(onClick = onAction) { Text(actionLabel) }
  }
}

/**
 * THE VERB FOR WHAT HAPPENED TO A DECISION — the client half of the rule the
 * web feed learned: a refused trade is not a purchase.
 *
 * Past tense is reserved for `landed`. Everything else is named for what it
 * actually was, because "bought" beside a trade the wall turned back is the
 * complaint that started all of this: "in the feed it says I've bought things
 * but nothing shows in my portfolio".
 */
fun verbOf(action: String?, outcome: String?, shadow: Boolean): String {
  val verb = action ?: "act"
  if (shadow || outcome == "shadow") return "would $verb"
  return when (outcome) {
    "refused", "reverted", "dropped" -> if (verb == "hold") "meant to hold" else "tried to $verb"
    "pending" -> if (verb == "hold") "is holding" else "is ${verb}ing"
    "landed" -> when (verb) {
      "buy" -> "bought"
      "sell" -> "sold"
      else -> "held"
    }
    else -> if (verb == "hold") "is holding" else "is ${verb}ing"
  }
}

/** A trade that came to nothing must not wear the colour of one that didn't. */
fun toneOf(action: String?, outcome: String?): Color = when {
  outcome == "refused" || outcome == "reverted" || outcome == "dropped" -> Neutral
  outcome != "landed" -> Neutral
  action == "buy" -> Up
  action == "sell" -> Down
  else -> Neutral
}
