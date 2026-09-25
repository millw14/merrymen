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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.Cookie
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull

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
   * `mm_session` is httpOnly, so no page script can read it — but
   * CookieManager, being the platform's own store, can. That is the only reason
   * this works, and it is also why the copy has to happen here in native code
   * rather than through injected JavaScript.
   */
  fun harvest(origin: String, jar: PersistentCookieJar) {
    val url = origin.toHttpUrlOrNull() ?: return
    val raw = CookieManager.getInstance().getCookie(origin) ?: return
    val cookies = webCookies(raw, url)
    if (cookies.isNotEmpty()) jar.saveFromResponse(url, cookies)
  }

  /**
   * THE PAGE'S `name=value; name=value` LINE as cookies for [url]'s host alone.
   *
   * Host-only, because CookieManager's line does not say which were domain
   * cookies, and the narrower reading is the one that cannot send a session to
   * a sibling host. A name in [RETIRED_COOKIES] is skipped: an install from
   * 0.1.0 seeded mm_gate into the WebView, and copying it back here put the old
   * site password on every API request again after one page load, undoing the
   * start that had just dropped it.
   */
  fun webCookies(raw: String, url: HttpUrl): List<Cookie> = raw.split(';').mapNotNull { part ->
    val trimmed = part.trim()
    val eq = trimmed.indexOf('=')
    if (eq <= 0) return@mapNotNull null
    val name = trimmed.substring(0, eq)
    if (name in RETIRED_COOKIES) return@mapNotNull null
    runCatching {
      Cookie.Builder().name(name).value(trimmed.substring(eq + 1)).hostOnlyDomain(url.host).path("/").build()
    }.getOrNull()
  }

  /**
   * Cookies nothing reads any more, and that must not come back from the
   * WebView. mm_gate's VALUE was the retired shared site password
   * (server-side removal 46c852d1).
   */
  val RETIRED_COOKIES: Set<String> = setOf("mm_gate")

  /**
   * Expire cookie [name] in the WebView's own store for [origin]. The
   * platform has no delete-one call; a Max-Age of 0 on the same name and path
   * is the delete. False when [origin] is not a web address, so nothing was
   * expired and nobody may record that it was.
   */
  fun expire(origin: String, name: String): Boolean {
    val url = origin.toHttpUrlOrNull() ?: return false
    val cm = CookieManager.getInstance()
    cm.setCookie(origin, "$name=; Max-Age=0; Path=/" + if (url.isHttps) "; Secure" else "")
    cm.flush()
    return true
  }

  /**
   * SEED THE WEBVIEW WITH WHAT THE APP ALREADY KNOWS — the reverse of harvest.
   *
   * The WebView's cookie store and OkHttp's jar are separate, and they can
   * drift: CookieManager writes to disk lazily, so a process death can cost it a
   * cookie the jar kept. A handoff page (the grant, the limits, a deposit) that
   * opened signed out would ask the owner to sign in a second time before it
   * could act for them. Copying the jar's cookies into CookieManager before the
   * first load hands the page the session the app is already using. `Secure`
   * because the origin is https; the platform store keeps httpOnly cookies like
   * `mm_session` faithfully.
   */
  fun seed(origin: String, jar: PersistentCookieJar) {
    val url = origin.toHttpUrlOrNull() ?: return
    val cm = CookieManager.getInstance()
    cm.setAcceptCookie(true)
    // Only what the jar would send to this origin: it is scoped by host now,
    // so another server's session never lands in this server's page.
    for (c in jar.loadForRequest(url)) {
      cm.setCookie(origin, "${c.name}=${c.value}; Path=/" + if (url.isHttps) "; Secure" else "")
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
 * THE TWO COOKIE STORES THIS APP KEEPS IN STEP — OkHttp's jar and the
 * WebView's — as the things Repository does to them.
 *
 * An interface so Repository runs on the JVM: CookieManager is the platform's,
 * and a unit test records what was asked of it instead. [DeviceCookies] is the
 * real one.
 */
interface CookieStores {
  /** Copy the WebView's cookies for [origin] into the jar, as after a sign-in. */
  suspend fun harvest(origin: String)

  /** Forget cookie [name] in the jar, whichever host set it. No platform call: cheap on every start. */
  suspend fun dropFromJar(name: String)

  /**
   * Expire cookie [name] in the WebView's store for [origin]. True only when
   * it was done. Wakes the WebView on the main thread and flushes to disk, so
   * it is not something a cold start does every time; see Repository.bootstrap.
   */
  suspend fun expireInWebView(origin: String, name: String): Boolean

  /** Forget every cookie in both stores: a sign-out. */
  suspend fun forgetAll()
}

/**
 * The real pair. The jar reads and writes DataStore with runBlocking, so its
 * side runs on IO; CookieManager is the WebView's, so its side runs on Main.
 *
 * EVERY PLATFORM CALL IS CAUGHT. CookieManager.getInstance() throws when the
 * WebView package is missing or mid-update, and [expireInWebView] runs on a
 * cold start: a start that died there would be a crash on launch, for a cookie
 * nothing reads. A refusal is reported as not done, so it is tried again.
 */
class DeviceCookies(private val jar: PersistentCookieJar) : CookieStores {
  override suspend fun harvest(origin: String) {
    val url = origin.toHttpUrlOrNull() ?: return
    val raw = web("read") { CookieManager.getInstance().getCookie(origin) } ?: return
    val cookies = WebAuth.webCookies(raw, url)
    if (cookies.isNotEmpty()) withContext(Dispatchers.IO) { jar.saveFromResponse(url, cookies) }
  }

  override suspend fun dropFromJar(name: String) {
    withContext(Dispatchers.IO) { jar.drop(name) }
  }

  override suspend fun expireInWebView(origin: String, name: String): Boolean =
    web("expire $name") { WebAuth.expire(origin, name) } == true

  override suspend fun forgetAll() {
    withContext(Dispatchers.IO) { jar.clear() }
    web("forget") {
      CookieManager.getInstance().removeAllCookies(null)
      CookieManager.getInstance().flush()
    }
  }

  private suspend fun <T> web(what: String, block: () -> T): T? = withContext(Dispatchers.Main) {
    try {
      block()
    } catch (e: RuntimeException) {
      android.util.Log.w("WebAuth", "the WebView cookie store refused: $what", e)
      null
    }
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
  // AN ADDRESS THAT IS NOT ONE gets a sentence, not a WebView error page. An
  // older build could store a Server with no scheme; loading "app.merrymen.dev/home"
  // shows the platform's own "webpage not available", which says nothing about
  // the setting that caused it.
  if (origin.toHttpUrlOrNull() == null) {
    dev.merrymen.app.ui.Notice(
      title = "This server address isn't a web address",
      body = "\"$origin\" can't be opened. Set the Server in Settings to something like https://app.merrymen.dev.",
      modifier = modifier,
    )
    return
  }
  DisposableEffect(Unit) {
    CookieManager.getInstance().setAcceptCookie(true)
    // Hand the WebView any session cookie the app already holds, so a handoff
    // page opens signed in as the same wallet the app is.
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
