package dev.merrymen.app.ui.screens

import android.content.ActivityNotFoundException
import android.content.Context
import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.unit.sp
import dev.merrymen.app.ui.MerryColors
import dev.merrymen.app.ui.sans

private const val TERMS_URL = "https://merrymen.dev/terms"
private const val PRIVACY_URL = "https://merrymen.dev/privacy"
internal const val ACCOUNT_DELETION_URL = "$PRIVACY_URL#your-choices"

/** Public pages use the reader's browser, never the signing WebView or its cookies. */
internal fun openInBrowser(context: Context, url: String): String? = try {
  CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(context, Uri.parse(url))
  null
} catch (_: ActivityNotFoundException) {
  "No browser is available to open this link."
} catch (_: SecurityException) {
  "This device did not allow the browser to open this link."
}

@Composable
internal fun PolicyLinks() {
  Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
    PolicyLink("Terms of Use", TERMS_URL, Modifier.weight(1f))
    PolicyLink("Privacy Policy", PRIVACY_URL, Modifier.weight(1f))
  }
}

/** TextButton supplies a labelled, keyboard-accessible target with a 48dp touch area. */
@Composable
internal fun PolicyLink(label: String, url: String, modifier: Modifier = Modifier) {
  val context = LocalContext.current
  var failure by remember(url) { mutableStateOf<String?>(null) }
  Column(modifier) {
    TextButton(onClick = { failure = openInBrowser(context, url) }, modifier = Modifier.fillMaxWidth()) {
      Text(
        label,
        color = MerryColors.tx2,
        style = TextStyle(fontFamily = sans(14.sp), fontSize = 14.sp),
        textDecoration = TextDecoration.Underline,
      )
    }
    failure?.let { message ->
      SelectionContainer {
        NoteLine(
          "$message\n$url",
          Modifier.semantics { liveRegion = LiveRegionMode.Polite },
        )
      }
    }
  }
}
