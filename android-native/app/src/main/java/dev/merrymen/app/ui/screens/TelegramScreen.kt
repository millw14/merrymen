package dev.merrymen.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavHostController
import dev.merrymen.app.LocalContainer
import dev.merrymen.app.data.Loaded
import dev.merrymen.app.data.toLoaded
import dev.merrymen.app.net.TelegramStatus
import dev.merrymen.app.ui.LoadedBlock
import dev.merrymen.app.ui.LocalBottomInset
import dev.merrymen.app.ui.MerryColors
import dev.merrymen.app.ui.PagePadH
import dev.merrymen.app.ui.Routes
import dev.merrymen.app.ui.sans
import kotlinx.coroutines.launch

/** `.rv` — forms.css:85: `font-size: 14px; overflow-wrap: anywhere`. */
private val ValueText = TextStyle(
  fontFamily = sans(14.sp),
  fontSize = 14.sp,
  fontWeight = FontWeight.W400,
  lineHeight = 20.sp,
)

/**
 * AN ANDROID-ONLY SCREEN, styled from the form vocabulary rather than invented.
 *
 * The web has no Telegram screen: `screens/Settings.tsx` exposes the bot as a
 * handful of fields inside the settings form and nothing else. So this page
 * borrows that page's furniture — `.mm-section` headings, `.rk`/`.rv` key and
 * value lines, `.mm-hint` for the caveat — instead of drawing a card style the
 * product does not have.
 */
@Composable
fun TelegramScreen(nav: NavHostController) {
  val c = LocalContainer.current
  var state by remember { mutableStateOf<Loaded<TelegramStatus>>(Loaded.Loading) }
  val scope = rememberCoroutineScope()
  suspend fun load() { state = c.api.telegram().toLoaded() }
  LaunchedEffect(Unit) { load() }

  Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
    Header("Telegram", nav)
    Column(Modifier.fillMaxWidth().padding(horizontal = PagePadH)) {
      LoadedBlock(
        state,
        onSignIn = { nav.navigate(Routes.SIGN_IN) },
        onRetry = { scope.launch { load() } },
      ) { t ->
        PanelSectionHeading("Connection")
        Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
          Text(
            text = when {
              !t.connected -> "Not connected"
              // "Connected as @null" states a username. "Connected" is the whole
              // truth when the server did not send one.
              t.botUsername.isNullOrBlank() -> "Connected"
              else -> "Connected as @${t.botUsername}"
            },
            style = ValueText,
            color = MerryColors.tx,
          )
          // The state sentence, kept verbatim. Every on/off control in the web's
          // settings carries one of these beside it (forms.css:45) precisely so
          // the reader never has to infer what the current position means.
          HintLine(if (t.enabled) "The bot is listening" else "Telegram is off")
          if (!t.control) HintLine("Control commands are turned off for this bot.")
        }

        PanelSectionHeading("Claim your bot")
        Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
          if (t.linkCode != null) {
            Text("Send this to your bot:", style = KeyText, color = MerryColors.tx2)
            Text("/link ${t.linkCode}", style = ValueText, color = MerryColors.tx)
            HintLine(
              "The code rotates once it is used. Anyone who has it can command this agent, " +
                "so treat it like a password.",
            )
          } else if (!t.hasToken) {
            HintLine("Add a bot token first — create one with @BotFather.")
          } else {
            // Not "no code": the worker mints it on boot, so this is a wait.
            HintLine("No code yet. Your agent mints one when it next starts with this token set.")
          }
        }

        if (t.ownerId != null) {
          PanelSectionHeading("Linked")
          Text("Owner chat ${t.ownerId}", style = ValueText, color = MerryColors.tx)
        }
      }
    }
    Spacer(Modifier.height(LocalBottomInset.current))
  }
}
