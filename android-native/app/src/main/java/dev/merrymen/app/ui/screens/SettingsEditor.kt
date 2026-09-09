package dev.merrymen.app.ui.screens

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import dev.merrymen.app.net.SettingsEnvelope
import dev.merrymen.app.ui.Pill
import dev.merrymen.app.ui.SectionCard
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject

/**
 * A REAL SETTINGS EDITOR, and the correction that made it possible.
 *
 * This screen used to be a read-only blob with a "edit on the web" handoff,
 * because I believed a native form would silently unset every field it did not
 * render. That was wrong, and the mistake is worth writing down: the PUT
 * handler reads each field with `if ("name" in body)`, so it is a PATCH.
 * Omitted fields are LEFT ALONE. Sending a subset is the correct thing to do.
 *
 * What would be genuinely wrong is echoing a field back unread — above all a
 * secret, since GET returns `{set, hint}` and never the value, so replaying it
 * would overwrite a real key with a mask. So this editor sends exactly the keys
 * the owner touched, and no others: `edits` starts empty and only a control
 * that was moved puts anything in it.
 *
 * ABSENT IS NOT EMPTY when READING, either. `SettingsEnvelope.raw` falls back
 * from `values` to `defaults`, because a field the owner never edited is not
 * unset — the default applies. Reading it as empty is exactly how approving one
 * coin once replaced a whole default basket.
 */

/** The numeric bounds the server enforces, mirrored so the UI can say them. */
private val RANGES: Map<String, Pair<Double, Double>> = mapOf(
  "buyPerTickUsdg" to (1.0 to 100_000.0),
  "slippageBps" to (1.0 to 5_000.0),
  "maxImpactBps" to (0.0 to 10_000.0),
  "takeProfitBps" to (0.0 to 1_000_000.0),
  "strategistStopLossBps" to (0.0 to 10_000.0),
  "llmMaxActionUsdg" to (1.0 to 100_000.0),
  "tickSeconds" to (15.0 to 3_600.0),
  "paperStartUsdg" to (1.0 to 10_000_000.0),
)

private data class NumField(val key: String, val label: String, val help: String)

private val NUMBERS = listOf(
  NumField("buyPerTickUsdg", "Size per trade (USDG)", "What it puts to work each time it trades."),
  NumField("slippageBps", "Max slippage (bps)", "Refuse a fill worse than this far off the quote."),
  NumField("maxImpactBps", "Max price impact (bps)", "Refuse a trade that would move the price more than this. 0 turns the guard off."),
  NumField("takeProfitBps", "Take profit (bps)", "Sell a leg once it is this far ahead of what it cost. 0 disables it — and it is the default strategy's only exit."),
  NumField("strategistStopLossBps", "Stop loss (bps)", "0 is off. A tight floor on a small ticket pays the chain to churn."),
  NumField("llmMaxActionUsdg", "Strategist ceiling (USDG)", "The most one model-proposed action may spend."),
)

private data class BoolField(val key: String, val label: String, val help: String)

private val SWITCHES = listOf(
  BoolField("paperTradingEnabled", "Practice fills", "Fall back to simulated fills when it cannot trade for real."),
  BoolField("deskEnabled", "Let it research first", "It can pull depth and read back its own past decisions before deciding. Costs more model calls."),
  BoolField("scoutEnabled", "Scout new coins", ""),
  BoolField("discoveryEnabled", "Discovery feed", ""),
  BoolField("telegramEnabled", "Telegram bot", ""),
  BoolField("telegramControlEnabled", "Telegram may change things", "Off means it can answer questions but not act."),
  BoolField("telegramTransferEnabled", "Telegram may transfer", "Separate from control, and off by default."),
)

@Composable
fun SettingsForm(
  env: SettingsEnvelope,
  edits: MutableMap<String, JsonElement>,
  circleLocked: Set<String>,
  onChanged: () -> Unit,
) {
  // The value to SHOW: an edit if one was made, else the stored value, else the
  // default. Never a blank that reads as "unset".
  fun showStr(key: String): String =
    (edits[key] as? JsonPrimitive)?.content ?: env.str(key) ?: ""

  fun showNum(key: String): String =
    (edits[key] as? JsonPrimitive)?.content
      ?: env.num(key)?.let { if (it % 1.0 == 0.0) it.toLong().toString() else it.toString() }
      ?: ""

  fun showBool(key: String): Boolean =
    (edits[key] as? JsonPrimitive)?.content?.toBooleanStrictOrNull() ?: env.bool(key) ?: false

  fun showList(key: String): List<String> =
    (edits[key] as? kotlinx.serialization.json.JsonArray)
      ?.mapNotNull { (it as? JsonPrimitive)?.content } ?: env.list(key)

  SectionCard("Your agent") {
    OutlinedTextField(
      value = showStr("agentName"),
      onValueChange = { edits["agentName"] = JsonPrimitive(it); onChanged() },
      label = { Text("Name") },
      singleLine = true,
      modifier = Modifier.fillMaxWidth(),
    )
  }

  SectionCard("Strategy") {
    val current = showStr("strategy")
    Row(
      Modifier.horizontalScroll(rememberScrollState()),
      horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
      env.strategies.builtin.forEach { name ->
        Pill(name, current == name) { edits["strategy"] = JsonPrimitive(name); onChanged() }
      }
    }
    // THE LOCK IS STATED AT THE POINT OF CHOICE, which is the whole complaint
    // that started this: an owner could pick a holder-only strategy and find
    // out it never ran only by reading a JSON endpoint.
    if (current in circleLocked) {
      Text(
        "This is a Merry Circle strategy. It only runs while you hold enough " +
          "\$MERRYMEN — picking it now means the agent stays idle until you do.",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.error,
      )
    }
  }

  SectionCard("Basket") {
    val basket = showList("basketSymbols").toMutableSet()
    Text(
      "What it may trade. Tapping a symbol adds or removes it.",
      style = MaterialTheme.typography.bodySmall,
    )
    // Chips wrap by hand rather than with a FlowRow, which is still
    // experimental in this Compose version and would be a warning-as-error risk
    // for a purely cosmetic gain.
    env.knownSymbols.chunked(4).forEach { row ->
      Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        row.forEach { sym ->
          Pill(sym, sym in basket) {
            if (sym in basket) basket.remove(sym) else basket.add(sym)
            edits["basketSymbols"] = buildJsonArray { basket.forEach { add(JsonPrimitive(it)) } }
            onChanged()
          }
        }
      }
    }
  }

  SectionCard("Numbers") {
    NUMBERS.forEach { f ->
      val bounds = RANGES[f.key]
      OutlinedTextField(
        value = showNum(f.key),
        onValueChange = { raw ->
          // Stored as a NUMBER, not a string: the server's validator checks the
          // type, and a quoted number is rejected as the wrong shape.
          val n = raw.trim().toDoubleOrNull()
          if (raw.isBlank()) edits.remove(f.key) else if (n != null) edits[f.key] = JsonPrimitive(n)
          onChanged()
        },
        label = { Text(f.label) },
        supportingText = {
          Text(
            f.help + (bounds?.let { " (${it.first.toLong()}–${it.second.toLong()})" } ?: ""),
            style = MaterialTheme.typography.bodySmall,
          )
        },
        singleLine = true,
        isError = showNum(f.key).toDoubleOrNull()?.let { v ->
          bounds != null && (v < bounds.first || v > bounds.second)
        } == true,
        modifier = Modifier.fillMaxWidth(),
      )
    }
  }

  SectionCard("Switches") {
    SWITCHES.forEach { f ->
      Row(
        Modifier.fillMaxWidth().padding(vertical = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
      ) {
        Column(Modifier.weight(1f)) {
          Text(f.label, style = MaterialTheme.typography.bodyMedium)
          if (f.help.isNotBlank()) {
            Text(f.help, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
          }
        }
        Switch(
          checked = showBool(f.key),
          onCheckedChange = { edits[f.key] = JsonPrimitive(it); onChanged() },
        )
      }
    }
  }
}

/** The patch: exactly what was touched, and nothing else. */
fun patchOf(edits: Map<String, JsonElement>): JsonElement =
  buildJsonObject { edits.forEach { (k, v) -> put(k, v) } }
