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
import dev.merrymen.app.ui.PagePadH
import dev.merrymen.app.ui.PagePadTop
import dev.merrymen.app.ui.sans
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
    WebHeader("Sign in", nav)
    val o = origin
    if (o == null) {
      // A LINE, NOT THE 264dp BLANK CARD. `.blank` is the designed empty state
      // for "we looked and there is nothing"; a momentary read of a local
      // setting is the web's `.hosted-note` register — a status line saying
      // which part of the page has not arrived yet.
      NoteLine(
        "Reading your server setting.",
        Modifier.padding(horizontal = PagePadH, vertical = 12.dp),
      )
    } else {
      WebFlow(
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
