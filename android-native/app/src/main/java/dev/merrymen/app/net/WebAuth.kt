package dev.merrymen.app.net

import android.annotation.SuppressLint
import android.webkit.CookieManager
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.Modifier
import androidx.compose.ui.viewinterop.AndroidView
import okhttp3.Cookie
import okhttp3.HttpUrl.Companion.toHttpUrl

/**
 * SIGNING IN WITHOUT EVER HOLDING A KEY.
 *
 * This is the one architectural decision in the app, so it is written down here
 * rather than discovered later.
 *
 * The API is cookie-authenticated. Getting the cookie means signing a challenge:
 * GET /api/auth/challenge returns an EIP-191 message naming the origin and a
 * single-use nonce, you sign it with the OWNER key, and POST /api/auth/verify
 * hands back `mm_session`. So authentication costs a signature, and a signature
 * costs a private key.
 *
 * THIS APP DOES NOT HOLD ONE, AND SHOULD NOT. The owner key is the key that
 * signs the permission wall itself — it is the sudo validator on the smart
 * account, not the session key that signs trades. The Expo client keeps a
 * 12-word mnemonic in the platform keystore and is built around guarding it;
 * the web client never has one at all, because Privy holds it behind the user's
 * login. Re-implementing BIP-39, secure-element custody and ERC-4337 grant
 * signing in a third client would triple the surface on which somebody's whole
 * account can be lost, to save one screen.
 *
 * SO THE KEY STAYS WHERE IT ALREADY LIVES, and the WebView borrows it. The user
 * signs in against the real web app, inside this app, using whatever wallet or
 * Privy login they already use. The signature happens in that page. What comes
 * back out is only the cookie — which is what this client needs and all it
 * needs.
 *
 * The bridge below is the whole trick: a WebView's cookie jar and OkHttp's are
 * separate, so a cookie set in the page is invisible to the API layer until it
 * is copied across. Everything else about the app is then an ordinary REST
 * client.
 *
 * WHAT THIS COSTS, stated plainly rather than discovered by a user: the four
 * operations that need the OWNER key — arming or re-signing a grant, changing
 * sealed trading limits, the recovery sweep, and proving a holder wallet — open
 * the web app's own screen for that action instead of being reimplemented here.
 * They are signature ceremonies; they belong where the key is.
 */
object WebAuth {

  /** Where the web app's sign-in lives. Deep-linked rather than reimplemented. */
  fun signInUrl(origin: String) = "$origin/home"

  /** The screens that must be delegated, because they end in a signature. */
  fun grantUrl(origin: String) = "$origin/grant"
  fun resignUrl(origin: String) = "$origin/grant#resign"
  fun limitsUrl(origin: String) = "$origin/limits"
  fun withdrawUrl(origin: String) = "$origin/withdraw"
  fun depositUrl(origin: String) = "$origin/deposit"
  fun createUrl(origin: String) = "$origin/create"

  /**
   * Copy the page's cookies into OkHttp's jar.
   *
   * `mm_session` and `mm_gate` are BOTH httpOnly, so no page script can read
   * them — but CookieManager, being the platform's own store, can. That is the
   * only reason this works, and it is also why the copy has to happen here in
   * native code rather than through injected JavaScript.
   */
  fun harvest(origin: String, jar: PersistentCookieJar) {
    val raw = CookieManager.getInstance().getCookie(origin) ?: return
    val url = runCatching { origin.toHttpUrl() }.getOrNull() ?: return
    val cookies = raw.split(';').mapNotNull { part ->
      val trimmed = part.trim()
      val eq = trimmed.indexOf('=')
      if (eq <= 0) return@mapNotNull null
      Cookie.Builder()
        .name(trimmed.substring(0, eq))
        .value(trimmed.substring(eq + 1))
        .domain(url.host)
        .path("/")
        .build()
    }
    if (cookies.isNotEmpty()) jar.saveFromResponse(url, cookies)
  }

  /**
   * SEED THE WEBVIEW WITH WHAT THE APP ALREADY KNOWS — the reverse of harvest.
   *
   * The WebView's cookie store and OkHttp's jar are separate, and the sign-in
   * page is BEHIND THE SITE GATE. The app has already opened that gate (its jar
   * holds `mm_gate`), but the WebView does not — so loading the sign-in URL
   * showed the gate's "enter your password" page inside the sign-in screen, and
   * a reader who typed the site password once was asked for it again before they
   * could even reach the wallet login. Copying the jar's cookies into
   * CookieManager before the first load lets the WebView through the same door
   * the app is already through. `Secure` because the origin is https; the
   * platform store keeps httpOnly cookies like `mm_gate` faithfully.
   */
  fun seed(origin: String, jar: PersistentCookieJar) {
    val url = runCatching { origin.toHttpUrl() }.getOrNull() ?: return
    val cm = CookieManager.getInstance()
    cm.setAcceptCookie(true)
    for (c in jar.loadForRequest(url)) {
      cm.setCookie(origin, "${c.name}=${c.value}; Path=/; Secure")
    }
    cm.flush()
  }

  /** Sign-out has to clear BOTH jars, or the next sign-in silently reuses one. */
  fun forget(jar: PersistentCookieJar) {
    jar.clear()
    CookieManager.getInstance().removeAllCookies(null)
    CookieManager.getInstance().flush()
  }
}

/**
 * The delegated-signature surface: the real web app, in a WebView, with its
 * cookies handed back to the native client on every page settle.
 *
 * JavaScript is enabled because the thing being delegated IS a JavaScript
 * signing flow; DOM storage because Privy's session needs it. No JavaScript
 * INTERFACE is registered — nothing in the page can call into the app, which
 * keeps the bridge one-directional: cookies out, no code in.
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun WebFlow(
  url: String,
  origin: String,
  jar: PersistentCookieJar,
  onCookies: () -> Unit,
  modifier: Modifier = Modifier,
) {
  DisposableEffect(Unit) {
    CookieManager.getInstance().setAcceptCookie(true)
    // Hand the WebView the gate (and any session) cookie the app already holds,
    // so the sign-in page is not itself gated behind the site password.
    WebAuth.seed(origin, jar)
    onDispose { CookieManager.getInstance().flush() }
  }
  AndroidView(
    modifier = modifier.fillMaxSize(),
    factory = { ctx ->
      WebView(ctx).apply {
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)
        webViewClient = object : WebViewClient() {
          override fun onPageFinished(view: WebView?, finishedUrl: String?) {
            super.onPageFinished(view, finishedUrl)
            CookieManager.getInstance().flush()
            WebAuth.harvest(origin, jar)
            onCookies()
          }
        }
        loadUrl(url)
      }
    },
    update = { if (it.url != url) it.loadUrl(url) },
  )
}
