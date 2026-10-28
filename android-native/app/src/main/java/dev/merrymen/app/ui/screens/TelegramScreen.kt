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
import androidx.compose.runtime.DisposableEffect
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
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleEventObserver
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.navigation.NavHostController
import dev.merrymen.app.LocalContainer
import dev.merrymen.app.data.Loaded
import dev.merrymen.app.data.toLoaded
import dev.merrymen.app.net.ApiResult
import dev.merrymen.app.net.MerrymenApi
import dev.merrymen.app.net.ServerBound
import dev.merrymen.app.net.TelegramConnection
import dev.merrymen.app.net.TelegramTest
import dev.merrymen.app.net.connectionMessage
import dev.merrymen.app.net.said
import dev.merrymen.app.net.sessionIsStill
import dev.merrymen.app.net.telegramChatUrl
import dev.merrymen.app.net.telegramConnection
import dev.merrymen.app.ui.LoadedBlock
import dev.merrymen.app.ui.LocalBottomInset
import dev.merrymen.app.ui.MerryColors
import dev.merrymen.app.ui.Notice
import dev.merrymen.app.ui.PagePadH
import dev.merrymen.app.ui.Routes
import dev.merrymen.app.ui.currentFormOwner
import dev.merrymen.app.ui.sans
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private val ValueText = TextStyle(
  fontFamily = sans(14.sp),
  fontSize = 14.sp,
  fontWeight = FontWeight.W400,
  lineHeight = 20.sp,
)

/** getMe verifies a token, not whether any worker is receiving its messages. */
internal fun telegramTestLine(r: ApiResult<TelegramTest>): String = when (r) {
  is ApiResult.Ok ->
    if (r.value.ok) "✓ Token verified for " + (r.value.username?.let { "@$it" } ?: "your bot")
    else "✗ " + (r.value.reason?.takeIf { it.isNotBlank() } ?: "failed")
  is ApiResult.Refused -> if (r.status == 401) "Sign in to test your bot." else "✗ " + r.message
  is ApiResult.Unreachable -> r.said
}

/** Refresh identity first; owner-scoped reads refuse a session that changes in between. */
internal suspend fun readTelegramFor(
  api: MerrymenApi,
  signedIn: String?,
  hosted: Boolean?,
  askWhoIsSignedIn: suspend () -> Unit,
): Loaded<TelegramConnection> {
  if (signedIn != null && hosted != false) askWhoIsSignedIn()
  return api.telegramConnection(if (hosted == false) null else signedIn).toLoaded()
}

/**
 * Quick native status and chat access. Bot creation and connection settings use
 * the signed-in web flow, including its durable setup and confirmation checks.
 * No managed token or creation challenge is persisted in the Android UI.
 */
@Composable
fun TelegramScreen(nav: NavHostController) {
  val c = LocalContainer.current
  val signedIn by c.repo.signedIn.collectAsState()
  val hosted by c.repo.hosted.collectAsState()
  val identityKnown by c.repo.identityKnown.collectAsState()
  val canOfferSignIn by c.repo.canOfferSignIn.collectAsState()
  val form = currentFormOwner(c.repo)
  var state by remember(form) { mutableStateOf<Loaded<TelegramConnection>>(Loaded.Loading) }
  var test by remember(form) { mutableStateOf<String?>(null) }
  var testing by remember(form) { mutableStateOf(false) }
  var refreshing by remember(form) { mutableStateOf(false) }
  var openError by remember(form) { mutableStateOf<String?>(null) }
  val scope = rememberCoroutineScope()
  val uri = LocalUriHandler.current
  val lifecycle = LocalLifecycleOwner.current.lifecycle
  var resumed by remember(lifecycle) { mutableStateOf(lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) }
  val mayRead = signedIn != null || hosted == false

  suspend fun load() {
    if (!mayRead || refreshing) return
    refreshing = true
    try {
      state = withContext(ServerBound(form.serverTurn)) {
        readTelegramFor(c.api, signedIn, hosted) { c.repo.refreshIdentity() }
      }
    } finally {
      refreshing = false
    }
  }

  // Returning from Telegram or connection settings immediately reconciles the
  // native view. A paused screen does not poll or consume mobile data.
  DisposableEffect(lifecycle) {
    val observer = LifecycleEventObserver { _, event ->
      if (event == Lifecycle.Event.ON_RESUME) resumed = true
      if (event == Lifecycle.Event.ON_PAUSE) resumed = false
    }
    lifecycle.addObserver(observer)
    onDispose { lifecycle.removeObserver(observer) }
  }
  LaunchedEffect(form, mayRead, resumed) { if (mayRead && resumed) load() }

  fun settings() { nav.navigate(Routes.web("/settings#telegram", "Telegram setup")) }
  fun openChat(url: String) {
    openError = if (runCatching { uri.openUri(url) }.isFailure) "Couldn't open Telegram. Install Telegram or try again." else null
  }

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
            title = "Sign in to connect Telegram",
            body = "Set up your agent's bot and keep the conversation with you.",
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
        val message = t.connectionMessage()
        val chatUrl = if (t.hasToken && !t.botElsewhere) {
          if (t.ownerId != null) telegramChatUrl(t.botUsername)
          else t.linkCode?.let { telegramChatUrl(t.botUsername, it) }
        } else null
        Spacer(Modifier.height(20.dp))
        Notice(
          title = message.title,
          body = message.detail,
          actionLabel = if (chatUrl != null) "Open my bot" else if (t.hasToken) "Manage connection" else "Set up Telegram",
          onAction = { if (chatUrl != null) openChat(chatUrl) else settings() },
        )
        if (t.hasToken) {
          t.botUsername?.let { Text("@$it", style = ValueText, color = MerryColors.tx, modifier = Modifier.padding(top = 16.dp)) }
          if (chatUrl != null) TelegramAction("Manage connection") { settings() }
          if (!t.control) HintLine("Your bot can answer questions. Control commands are turned off.")
        } else {
          HintLine("Guided setup keeps the bot token private. Existing bots can be connected in the same screen.")
        }
        openError?.let { HintLine(it) }

        if (t.tradingHeld != null && t.listening?.state != "held") {
          Spacer(Modifier.height(16.dp))
          Notice(title = "Trading paused for recovery", body = "Your agent reports: ${t.tradingHeld}. Check Home for its current status.")
        }

        // Show a credential only when this unlinked bot actually needs it.
        // The primary action carries it privately into Telegram's Start link.
        if (t.hasToken && !t.botElsewhere && t.ownerId == null && t.linkCode != null) {
          PanelSectionHeading("Link your chat")
          HintLine("Tap Start after opening your bot. If needed, send this in your private chat:")
          Text("/link ${t.linkCode}", style = ValueText, color = MerryColors.tx, modifier = Modifier.padding(vertical = 8.dp))
          HintLine("Keep this code private. It gives access to your agent's Telegram commands.")
        }

        if (t.hasToken && t.ownerId != null && !t.botElsewhere) {
          PanelSectionHeading("Group conversations")
          HintLine(when {
            t.canJoinGroups == false -> "Groups are disabled for this bot. Enable groups in @BotFather to add it to a group."
            t.canReadAllGroupMessages == true -> "Your bot can hear group messages. Manage allowed chats in connection settings."
            t.canReadAllGroupMessages == false -> "Your bot hears commands and replies in groups. Change privacy mode in @BotFather to let it follow the whole conversation."
            else -> "Manage allowed chats in connection settings. Group privacy settings are controlled in @BotFather."
          })
        }

        PanelSectionHeading("Connection check")
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
          TelegramAction(if (refreshing) "Refreshing…" else "Refresh status", enabled = !refreshing) {
            scope.launch { load() }
          }
          if (t.hasToken) {
            TelegramAction(if (testing) "Checking token…" else "Check saved token", enabled = !testing) {
              testing = true
              test = null
              scope.launch(ServerBound(form.serverTurn)) {
                try {
                  val problem = if (hosted == false) null else c.api.sessionIsStill(signedIn, "Telegram connection")
                  test = problem ?: telegramTestLine(c.api.telegramTest(null))
                  load()
                } finally {
                  testing = false
                }
              }
            }
            test?.let { Text(it, style = ValueText, color = if (it.startsWith("✓")) MerryColors.up else MerryColors.tx2) }
            HintLine("A valid token confirms the bot exists. The listening status above comes from your agent.")
          }
        }
      }
    }
    Spacer(Modifier.height(LocalBottomInset.current))
  }
}

@Composable
private fun TelegramAction(label: String, enabled: Boolean = true, onClick: () -> Unit) {
  Box(
    Modifier.fillMaxWidth().heightIn(min = 48.dp).clickable(enabled = enabled, role = Role.Button, onClick = onClick),
    contentAlignment = Alignment.CenterStart,
  ) {
    Text(label, style = TextStyle(fontFamily = sans(14.sp, FontWeight.W600), fontSize = 14.sp, fontWeight = FontWeight.W600), color = if (enabled) MerryColors.tx else MerryColors.tx2)
  }
}
