package dev.merrymen.app.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavHostController
import dev.merrymen.app.LocalContainer
import dev.merrymen.app.data.Loaded
import dev.merrymen.app.data.toLoaded
import dev.merrymen.app.net.ApiResult
import dev.merrymen.app.net.MerrymenApi
import dev.merrymen.app.net.TelegramStatus
import dev.merrymen.app.net.TelegramTest
import dev.merrymen.app.net.said
import dev.merrymen.app.ui.LoadedBlock
import dev.merrymen.app.ui.LocalBottomInset
import dev.merrymen.app.ui.MerryColors
import dev.merrymen.app.ui.Notice
import dev.merrymen.app.ui.PagePadH
import dev.merrymen.app.ui.Routes
import dev.merrymen.app.ui.TelegramRow
import dev.merrymen.app.ui.sans
import dev.merrymen.app.ui.telegramRowOf
import dev.merrymen.app.ui.telegramStartUrl
import dev.merrymen.app.ui.telegramStripValue
import kotlinx.coroutines.launch

/** `.rv` — forms.css:85: `font-size: 14px; overflow-wrap: anywhere`. */
private val ValueText = TextStyle(
  fontFamily = sans(14.sp),
  fontSize = 14.sp,
  fontWeight = FontWeight.W400,
  lineHeight = 20.sp,
)

/**
 * What "Test the bot" answered, in the web's own words (Settings.tsx
 * testTelegram): "✓ connected as @name" or "✗ " and the route's reason.
 */
internal fun telegramTestLine(r: ApiResult<TelegramTest>): String = when (r) {
  is ApiResult.Ok ->
    if (r.value.ok) "✓ connected as @" + (r.value.username ?: "your bot")
    else "✗ " + (r.value.reason?.takeIf { it.isNotBlank() } ?: "failed")
  is ApiResult.Refused -> if (r.status == 401) "Sign in to test your bot." else "✗ " + r.message
  is ApiResult.Unreachable -> r.said
}

/**
 * READ THE OWNER'S BOT, AFTER ASKING WHO THE OWNER IS.
 *
 * GET /api/telegram answers an ended session from the house defaults — "no
 * token", with a 200 — and, unlike the feed's `source` or the settings'
 * `owner`, nothing in that answer says it is nobody's. So while this app holds
 * an address on a server that has sessions, the session route is asked first
 * ([askWhoIsSignedIn]); a session that ended turns repo.signedIn to null, and
 * the screen draws its sign-in notice instead of "not set up" over a bot that
 * may well exist.
 */
internal suspend fun readTelegramFor(
  api: MerrymenApi,
  signedIn: String?,
  hosted: Boolean?,
  askWhoIsSignedIn: suspend () -> Unit,
): Loaded<TelegramStatus> {
  if (signedIn != null && hosted != false) askWhoIsSignedIn()
  return api.telegram().toLoaded()
}

/**
 * AN ANDROID-ONLY SCREEN, styled from the form vocabulary rather than invented.
 *
 * The web keeps the bot inside the settings form, and its link code used to
 * live in a different closed drawer from the instruction that needs it — two
 * beta testers stopped exactly there. So this page puts the status, the code,
 * an "Open Telegram" that carries the code into the chat, and a test of the
 * SAVED token in one place. Its words are agent-status.ts's: an unread bridge
 * is "checking…", never "not connected".
 *
 * ONLY A SIGNED-IN OWNER'S BOT. Signed out, the route answers from the house
 * defaults — "no token" — which is nobody's bot; it is not drawn as the
 * reader's.
 */
@Composable
fun TelegramScreen(nav: NavHostController) {
  val c = LocalContainer.current
  val signedIn by c.repo.signedIn.collectAsState()
  val hosted by c.repo.hosted.collectAsState()
  val identityKnown by c.repo.identityKnown.collectAsState()
  val canOfferSignIn by c.repo.canOfferSignIn.collectAsState()
  var state by remember(signedIn) { mutableStateOf<Loaded<TelegramStatus>>(Loaded.Loading) }
  var test by remember(signedIn) { mutableStateOf<String?>(null) }
  var testing by remember { mutableStateOf(false) }
  val scope = rememberCoroutineScope()
  val uri = LocalUriHandler.current
  val mayRead = signedIn != null || hosted == false
  suspend fun load() { state = readTelegramFor(c.api, signedIn, c.repo.hosted.value) { c.repo.refreshIdentity() } }
  LaunchedEffect(signedIn, mayRead) { if (mayRead) load() }

  Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
    Header("Telegram", nav)
    Column(Modifier.fillMaxWidth().padding(horizontal = PagePadH)) {
      SignedInNotice(Modifier.padding(top = 16.dp))
      if (!mayRead) {
        Spacer(Modifier.height(24.dp))
        if (!identityKnown) {
          NoteLine("Checking who you are.")
        } else {
          Notice(
            title = "Sign in to see your bot",
            body = "Your Telegram bot belongs to your agent, so it shows once you are signed in.",
            actionLabel = if (canOfferSignIn) "Sign in" else null,
            onAction = if (canOfferSignIn) ({ nav.navigate(Routes.SIGN_IN) }) else null,
          )
        }
        return@Column
      }
      LoadedBlock(
        state,
        onSignIn = if (canOfferSignIn) ({ nav.navigate(Routes.SIGN_IN) }) else null,
        onRetry = { scope.launch { load() } },
      ) { t ->
        val row = telegramRowOf(t)
        PanelSectionHeading("Connection")
        Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
          Text(
            text = telegramStripValue(row).replaceFirstChar { it.uppercase() },
            style = ValueText,
            color = MerryColors.tx,
          )
          // The state sentence, kept verbatim. Every on/off control in the web's
          // settings carries one of these beside it (forms.css:45).
          HintLine(if (t.enabled) "The bot is listening" else "Telegram is off")
          if (!t.control) HintLine("Control commands are turned off for this bot.")
        }

        PanelSectionHeading("Claim your bot")
        Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
          when {
            t.linkCode != null -> {
              Text("Send this to your bot:", style = KeyText, color = MerryColors.tx2)
              Text("/link ${t.linkCode}", style = ValueText, color = MerryColors.tx)
              telegramStartUrl(t.botUsername, t.linkCode)?.let { url ->
                TelegramAction("Open Telegram →") { runCatching { uri.openUri(url) } }
              }
              HintLine("Anyone who has this code can control your agent — do not share or screenshot it.")
            }
            !t.hasToken -> {
              HintLine("Create a bot with @BotFather and add its token on the web. Your link code appears here once a token is saved.")
              TelegramAction("Add the token on the web →") { nav.navigate(Routes.web("/settings#telegram", "Settings")) }
            }
            // A WAIT, not an absence: the worker mints the code on its next
            // pass with this token set.
            else -> HintLine("No link code yet. Your agent mints one on its next pass with this token set — check back shortly.")
          }
        }

        if (row is TelegramRow.Linked || t.ownerId != null) {
          PanelSectionHeading("Linked")
          Text("Owner chat ${t.ownerId}", style = ValueText, color = MerryColors.tx)
        }

        // TESTS THE SAVED TOKEN: no token is sent, so the route asks Telegram
        // about the one this owner saved (and says "no token set" if none).
        PanelSectionHeading("Test")
        Column(verticalArrangement = Arrangement.spacedBy(9.dp)) {
          TelegramAction(if (testing) "Testing…" else "Test the bot") {
            if (testing) return@TelegramAction
            testing = true
            test = null
            scope.launch {
              test = telegramTestLine(c.api.telegramTest(null))
              testing = false
              load()
            }
          }
          test?.let { Text(it, style = ValueText, color = if (it.startsWith("✓")) MerryColors.up else MerryColors.tx2) }
        }
      }
    }
    Spacer(Modifier.height(LocalBottomInset.current))
  }
}

@Composable
private fun TelegramAction(label: String, onClick: () -> Unit) {
  Box(Modifier.heightIn(min = 44.dp).clickable(role = Role.Button, onClick = onClick), contentAlignment = Alignment.CenterStart) {
    Text(label, style = TextStyle(fontFamily = sans(14.sp, FontWeight.W600), fontSize = 14.sp, fontWeight = FontWeight.W600), color = MerryColors.tx)
  }
}
