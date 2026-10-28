package dev.merrymen.app.net

import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.verify.domain.DomainVerificationManager
import android.content.pm.verify.domain.DomainVerificationUserState
import android.net.Uri
import android.os.Build
import androidx.browser.customtabs.CustomTabsIntent
import java.security.MessageDigest
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.Serializable
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

internal const val ANDROID_AUTH_ORIGIN = "https://app.merrymen.dev"
internal const val ANDROID_AUTH_PATH = "/auth/android"
internal const val ANDROID_AUTH_URL = ANDROID_AUTH_ORIGIN + ANDROID_AUTH_PATH
internal const val ANDROID_AUTH_USER_AGENT = "MerrymenAndroid/1"

@Serializable
internal data class AndroidOAuthAvailability(val enabled: Boolean = false)

internal suspend fun MerrymenApi.androidOAuthAvailability(): ApiResult<AndroidOAuthAvailability> =
  getJson("/api/auth/android")

/** External login is offered only when Android can route our HTTPS return to this app. */
internal fun hasVerifiedAndroidAuthLink(context: Context, origin: String): Boolean {
  if (origin != ANDROID_AUTH_ORIGIN) return false
  return runCatching {
    if (Build.VERSION.SDK_INT >= 31) {
      val manager = context.getSystemService(DomainVerificationManager::class.java)
      val state = manager?.getDomainVerificationUserState(context.packageName)
      state?.isLinkHandlingAllowed == true &&
        state.hostToStateMap["app.merrymen.dev"] == DomainVerificationUserState.DOMAIN_STATE_VERIFIED
    } else {
      val intent = Intent(Intent.ACTION_VIEW, Uri.parse(ANDROID_AUTH_URL)).addCategory(Intent.CATEGORY_BROWSABLE)
      context.packageManager.resolveActivity(intent, PackageManager.MATCH_DEFAULT_ONLY)?.activityInfo?.packageName == context.packageName
    }
  }.getOrDefault(false)
}

/** Use only X's HTTPS OAuth URL. Android chooses a supported app; otherwise use the browser's session. */
internal fun openExternalX(context: Context, url: String): Boolean {
  if (xOAuthState(url) == null) return false
  val uri = Uri.parse(url)
  if (Build.VERSION.SDK_INT >= 30 && runCatching {
      context.startActivity(Intent(Intent.ACTION_VIEW, uri)
        .addCategory(Intent.CATEGORY_BROWSABLE).addFlags(Intent.FLAG_ACTIVITY_REQUIRE_NON_BROWSER))
    }.isSuccess) return true
  return runCatching { CustomTabsIntent.Builder().build().launchUrl(context, uri) }.isSuccess
}

/** The actual Privy 3.46 flow uses this HTTPS endpoint and the same state in its return. */
internal fun xOAuthState(raw: String): String? {
  val url = raw.toHttpUrlOrNull() ?: return null
  if (!url.isHttps || url.port != 443 || url.host !in setOf("x.com", "twitter.com") ||
    url.encodedPath != "/i/oauth2/authorize" || url.username.isNotEmpty() || url.password.isNotEmpty() || url.fragment != null
  ) return null
  val required = setOf("response_type", "client_id", "redirect_uri", "scope", "state", "code_challenge", "code_challenge_method")
  if (required.any { url.queryParameterValues(it).size != 1 }) return null
  if (url.queryParameter("response_type") != "code" || url.queryParameter("code_challenge_method") != "S256" ||
    url.queryParameter("redirect_uri") != "https://auth.privy.io/api/v1/oauth/callback" ||
    url.queryParameter("client_id").isNullOrBlank() || url.queryParameter("code_challenge").isNullOrBlank()
  ) return null
  return url.queryParameter("state")?.takeIf { it.length in 16..512 && it.all { c -> c.code in 33..126 } }
}

internal data class AndroidOAuthReturn(val flowId: String, val url: String)

/**
 * An OAuth redirect is an input to Privy's saved PKCE flow, never an identity.
 * Keep it only in memory, for one visible sign-in and one matching state. A
 * process restart, sign-out, server change, abandoned screen or expired attempt
 * requires a fresh login. No cookie, access token or private key crosses a URL.
 */
internal class AndroidOAuthExchange(private val clockMs: () -> Long = { System.nanoTime() / 1_000_000 }) {
  private data class Pending(val flowId: String, val state: String, val at: Long)
  private var pending: Pending? = null
  private val returned = MutableStateFlow<AndroidOAuthReturn?>(null)
  val delivery: StateFlow<AndroidOAuthReturn?> = returned

  @Synchronized fun begin(flowId: String, source: String?, authorization: String): Boolean {
    // The dedicated page declares the fixed callback. The old /home fallback
    // must stay embedded: opening it externally would return to another jar.
    if (source != ANDROID_AUTH_URL) return false
    val state = xOAuthState(authorization) ?: return false
    returned.value = null
    pending = Pending(flowId, state, clockMs())
    return true
  }

  @Synchronized fun accept(raw: String?): Boolean {
    val p = pending ?: return false
    if (clockMs() - p.at !in 0..600_000) { cancel(); return false }
    val url = raw?.toHttpUrlOrNull() ?: return false
    if (url.scheme != "https" || url.host != "app.merrymen.dev" || url.port != 443 ||
      url.encodedPath != ANDROID_AUTH_PATH || url.username.isNotEmpty() || url.password.isNotEmpty() || url.fragment != null
    ) return false
    val keys = setOf("privy_oauth_code", "privy_oauth_state", "privy_oauth_provider")
    if (url.queryParameterNames != keys || keys.any { url.queryParameterValues(it).size != 1 }) return false
    val state = url.queryParameter("privy_oauth_state") ?: return false
    val code = url.queryParameter("privy_oauth_code") ?: return false
    if (url.queryParameter("privy_oauth_provider") != "twitter" || state.length !in 16..512 || code.length !in 1..4096 ||
      code.any { it.code !in 33..126 } || !MessageDigest.isEqual(state.toByteArray(), p.state.toByteArray())
    ) return false
    // Rebuild only the three SDK inputs on the known original origin/path.
    val resume = ANDROID_AUTH_URL.toHttpUrlOrNull()!!.newBuilder()
      .addQueryParameter("privy_oauth_code", code)
      .addQueryParameter("privy_oauth_state", state)
      .addQueryParameter("privy_oauth_provider", "twitter").build().toString()
    pending = null
    returned.value = AndroidOAuthReturn(p.flowId, resume)
    return true
  }

  @Synchronized fun take(flowId: String): String? {
    val value = returned.value?.takeIf { it.flowId == flowId } ?: return null
    returned.value = null
    return value.url
  }

  @Synchronized fun cancelFlow(flowId: String) {
    if (pending?.flowId == flowId) pending = null
    if (returned.value?.flowId == flowId) returned.value = null
  }

  @Synchronized fun cancel() { pending = null; returned.value = null }
}

internal val AndroidOAuthReturns = AndroidOAuthExchange()
