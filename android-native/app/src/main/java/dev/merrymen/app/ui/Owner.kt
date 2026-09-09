package dev.merrymen.app.ui

import android.content.ActivityNotFoundException
import android.content.Context
import android.net.Uri
import androidx.browser.customtabs.CustomTabsIntent
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.style.TextDecoration

/**
 * X'S OWN RULE, RE-APPLIED HERE RATHER THAN TRUSTED FROM THE WIRE.
 *
 * The mirror of `web/src/lib/x-handle.ts`, and it exists for the same reason:
 * `agents.x_handle` is whatever the owner typed, and the SELF-HOSTED write path
 * applies no shape check at all — only a `.trim()` — while the lines around it
 * validate addresses. So arbitrary text can sit in that column and reach this
 * client. A handle that fails this is rendered as text and never as a link.
 */
private val HANDLE = Regex("^@?([A-Za-z0-9_]{1,15})$")

fun normaliseXHandle(raw: String?): String? =
  raw?.trim()?.let { HANDLE.find(it)?.groupValues?.get(1) }

fun xProfileUrl(raw: String?): String? = normaliseXHandle(raw)?.let { "https://x.com/$it" }

fun xHandleTag(raw: String?): String? = normaliseXHandle(raw)?.let { "@$it" }

/** A wallet address, shortened for a line of prose. Plain text, never a link. */
fun shortAddress(raw: String?): String? {
  val a = raw?.trim() ?: return null
  if (!Regex("^0x[0-9a-fA-F]{4,}$").matches(a)) return null
  return if (a.length > 12) a.take(6) + "…" + a.takeLast(4) else a
}

/**
 * OPEN X IN THE USER'S OWN BROWSER, NOT IN OUR WEBVIEW.
 *
 * The WebView in this app exists for one thing: signature ceremonies against
 * OUR origin, whose cookies are then harvested into the API client. Loading a
 * third-party site in it would put somebody else's page inside a component
 * built to read cookies out, which is the wrong shape entirely. A Custom Tab
 * is the user's browser, with the user's session and none of ours.
 *
 * DRIVE THE INTENT AND CATCH, rather than asking whether it can be handled
 * first. That is the lesson already written down in the Expo client's wallet
 * handoff: a capability query is unreliable — on Android 11+ it needs package
 * visibility, and a null answer looks identical to "no browser" — so the honest
 * check is to try it and handle the failure.
 */
fun openX(context: Context, handle: String?): Boolean {
  val url = xProfileUrl(handle) ?: return false
  return try {
    CustomTabsIntent.Builder().setShowTitle(true).build().launchUrl(context, Uri.parse(url))
    true
  } catch (_: ActivityNotFoundException) {
    // No browser at all. Rare, and not worth a crash — the caller keeps the
    // handle on screen as text, which is still readable and copyable.
    false
  }
}

/**
 * A NAME, AND UNDERNEATH IT WHO OWNS THE AGENT.
 *
 * The same three renderings as the web's NameBlock, for the same reasons:
 * a PROVEN handle is a link; an unproven handle or an address is plain text,
 * because nothing checked it and a link would make merrymen vouch for an
 * association it never made; and an absent owner gets no line at all rather
 * than an invented placeholder.
 */
@Composable
fun NameBlock(
  title: String,
  owner: String?,
  verified: Boolean = false,
  modifier: Modifier = Modifier,
) {
  val context = LocalContext.current
  val linkable = verified && xProfileUrl(owner) != null
  Column(modifier) {
    Text(title, style = MaterialTheme.typography.titleMedium)
    when {
      owner.isNullOrBlank() -> Unit
      linkable -> Text(
        // The tick is the whole difference between a checked claim and an
        // unchecked one; without it the reader cannot tell them apart.
        text = "owned by ${xHandleTag(owner)} ✓",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.primary,
        textDecoration = TextDecoration.Underline,
        modifier = Modifier.clickable { openX(context, owner) },
      )
      else -> Text(
        "owned by ${shortAddress(owner) ?: xHandleTag(owner) ?: owner}",
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
      )
    }
  }
}
