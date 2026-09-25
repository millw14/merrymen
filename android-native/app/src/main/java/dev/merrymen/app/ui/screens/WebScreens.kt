package dev.merrymen.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
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
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.navigation.NavHostController
import dev.merrymen.app.LocalContainer
import dev.merrymen.app.net.WebAuth
import dev.merrymen.app.net.WebFlow
import dev.merrymen.app.ui.MerryColors
import dev.merrymen.app.ui.Notice
import dev.merrymen.app.ui.PagePadH
import dev.merrymen.app.ui.PagePadTop
import dev.merrymen.app.ui.Routes
import dev.merrymen.app.ui.sans
import dev.merrymen.app.ui.shortAddress
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch

/**
 * The compact header for a screen whose body is the WEB APP ITSELF.
 *
 * A 34sp native title above a WebView that renders the same page's own heading
 * says the name twice in two different type scales. These screens exist only to
 * hold a signature ceremony (see [SignInScreen]), so the native chrome is a way
 * back and a label, at `.back`'s own 15px/600.
 */
@Composable
private fun WebHeader(title: String, nav: NavHostController) {
  Row(
    Modifier
      .fillMaxWidth()
      .padding(start = PagePadH, end = PagePadH, top = PagePadTop, bottom = 8.dp),
    horizontalArrangement = Arrangement.spacedBy(10.dp),
    verticalAlignment = Alignment.CenterVertically,
  ) {
    BackControl({ nav.popBackStack() })
    Text(
      text = title,
      style = TextStyle(
        fontFamily = sans(15.sp, FontWeight.W600),
        fontSize = 15.sp,
        fontWeight = FontWeight.W600,
      ),
      color = MerryColors.tx,
    )
  }
}

/**
 * "SIGNED IN AS 0x12…AB", ONCE, WHERE THE OWNER LANDS.
 *
 * The sign-in page closes itself when the session changes (see [SignInScreen]),
 * and a page that vanishes without a word leaves the owner wondering whether it
 * worked. So the address it came back with is held here for a moment and said
 * by whichever of the account screens composes next. It expires: a sign-in
 * that returned to a screen which does not show it is not announced minutes
 * later somewhere else.
 */
internal object SignInFlash {
  private data class Flash(val address: String, val atMs: Long)

  private val flash = MutableStateFlow<Flash?>(null)

  /** How long an unseen announcement stays true. */
  private const val FRESH_MS = 10_000L

  fun signedIn(address: String, nowMs: Long = System.currentTimeMillis()) {
    flash.value = Flash(address, nowMs)
  }

  /** The address, if it was set recently enough to still be news; it is then spent. */
  fun take(nowMs: Long = System.currentTimeMillis()): String? {
    val f = flash.value ?: return null
    flash.value = null
    return if (nowMs - f.atMs <= FRESH_MS) f.address else null
  }
}

/** The transient line itself, for the screens a sign-in can return to. Four seconds, then gone. */
@Composable
internal fun SignedInNotice(modifier: Modifier = Modifier) {
  var address by remember { mutableStateOf<String?>(null) }
  LaunchedEffect(Unit) {
    address = SignInFlash.take()
    if (address != null) {
      delay(4_000)
      address = null
    }
  }
  address?.let { a ->
    Notice(title = "Signed in as " + (shortAddress(a) ?: a), body = "This app now reads and acts for that wallet.", modifier = modifier)
  }
}

/**
 * Whether a sign-in has happened since the page opened: the session now names
 * an address, and not the one it named when the page was opened. A wallet
 * SWITCH counts — the WebView signed a different wallet in — and so does a
 * first sign-in; the same address still being there does not.
 */
internal fun signInLanded(before: String?, now: String?): Boolean =
  now != null && !now.equals(before, ignoreCase = true)

/**
 * Sign-in is the web app's own SIWE flow, in a WebView, because it ends in a
 * signature from the owner key — and this app deliberately does not hold one.
 * What crosses back is the session cookie and nothing else. See WebAuth.
 *
 * IT CLOSES ITSELF. It watches repo.signedIn, and the moment a harvest brings a
 * session back for an address other than the one it opened with, it goes back
 * where the owner came from (Home, when that was the welcome page) and says who
 * they are signed in as. It used to leave the owner staring at the web page,
 * wondering whether it had worked.
 *
 * AND IT OPENS ONLY WHERE A SIGN-IN EXISTS. A self-hosted server answers the
 * session route with {hosted:false} and has no sign-in at all; loading the web
 * sign-in there would send the owner through a door that goes nowhere. While
 * the server has not said which it is, the page asks it once and says so.
 */
@Composable
fun SignInScreen(nav: NavHostController) {
  val c = LocalContainer.current
  val signedIn by c.repo.signedIn.collectAsState()
  val hosted by c.repo.hosted.collectAsState()
  val before = remember { c.repo.signedIn.value }
  var origin by remember { mutableStateOf<String?>(null) }
  var asked by remember { mutableStateOf(false) }
  val scope = rememberCoroutineScope()
  LaunchedEffect(Unit) {
    origin = c.repo.originNow()
    if (c.repo.hosted.value == null) c.repo.refreshIdentity()
    asked = true
  }

  LaunchedEffect(signedIn) {
    val now = signedIn
    if (!signInLanded(before, now) || now == null) return@LaunchedEffect
    SignInFlash.signedIn(now)
    val back = nav.previousBackStackEntry?.destination?.route
    if (back == null || back == Routes.WELCOME) {
      nav.navigate(Routes.HOME) {
        // From the welcome page, the welcome page goes too: it is a door, and
        // the owner is through it.
        popUpTo(if (back == Routes.WELCOME) Routes.WELCOME else Routes.SIGN_IN) { inclusive = true }
        launchSingleTop = true
      }
    } else {
      nav.popBackStack()
    }
  }

  Column(Modifier.fillMaxSize()) {
    WebHeader("Sign in", nav)
    val o = origin
    val pad = Modifier.padding(horizontal = PagePadH, vertical = 12.dp)
    when {
      // A LINE, NOT THE 264dp BLANK CARD: a momentary read of a local setting.
      o == null -> NoteLine("Reading your server setting.", pad)
      hosted == false -> Notice(
        title = "This server has no sign-in",
        body = "It runs one owner's agent, so every screen here already acts for it. There is no wallet to sign in with.",
        modifier = pad,
      )
      hosted == null && !asked -> NoteLine("Checking whether this server has sign-in.", pad)
      hosted == null -> Notice(
        title = "Can't tell whether this server has sign-in",
        body = "The session check did not answer, so nothing was opened. That's this app failing to get an answer, not a fact about your account.",
        actionLabel = "Try again",
        onAction = { scope.launch { c.repo.refreshIdentity() } },
        modifier = pad,
      )
      else -> WebFlow(
        url = WebAuth.signInUrl(o),
        origin = o,
        jar = c.cookieJar,
        onCookies = { scope.launch { c.repo.adoptWebSession() } },
        modifier = Modifier.fillMaxSize(),
      )
    }
  }
}

@Composable
fun WebFlowScreen(nav: NavHostController, path: String, title: String) {
  val c = LocalContainer.current
  var origin by remember { mutableStateOf<String?>(null) }
  val scope = rememberCoroutineScope()
  LaunchedEffect(Unit) { origin = c.repo.originNow() }

  Column(Modifier.fillMaxSize()) {
    WebHeader(title.ifBlank { "merrymen" }, nav)
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
