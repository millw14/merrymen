package dev.merrymen.app.net

import java.net.URI
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

internal enum class WebLinkTarget { Embedded, Telegram, Blocked }

/** Only Telegram's public links leave the WebView. Never interpret intent:// payloads. */
internal fun webLinkTarget(raw: String, mainFrame: Boolean = true): WebLinkTarget {
  if (raw == "about:blank") return WebLinkTarget.Embedded
  val web = raw.toHttpUrlOrNull()
  if (web != null) {
    if (web.username.isNotEmpty() || web.password.isNotEmpty()) return WebLinkTarget.Blocked
    return if (mainFrame && web.isHttps && web.port == 443 && web.host in setOf("t.me", "telegram.me")) {
      WebLinkTarget.Telegram
    } else WebLinkTarget.Embedded
  }
  val uri = runCatching { URI(raw) }.getOrNull() ?: return WebLinkTarget.Blocked
  return if (mainFrame && uri.scheme.equals("tg", ignoreCase = true) && uri.host == "resolve" &&
    uri.rawUserInfo == null && uri.port == -1 && uri.rawPath.orEmpty().isEmpty()
  ) WebLinkTarget.Telegram else WebLinkTarget.Blocked
}

/** A null snapshot means a successful empty read; a platform failure must not call this. */
internal class WebSessionChanges {
  private var observed = false
  private var previous: String? = null

  private fun session(raw: String?): String? = raw.orEmpty().split(';').firstNotNullOfOrNull { part ->
      val pair = part.trim().split('=', limit = 2)
      pair.getOrNull(1)?.takeIf { pair[0] == "mm_session" && it.isNotEmpty() }
    }

  fun needsAdoption(raw: String?): Boolean = !observed || session(raw) != previous

  /** Only a confirmed identity answer acknowledges this snapshot. */
  fun adopted(raw: String?) {
    observed = true
    previous = session(raw)
  }
}
