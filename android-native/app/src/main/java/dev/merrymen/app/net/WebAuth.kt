package dev.merrymen.app.net

import android.annotation.SuppressLint
import android.webkit.CookieManager
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
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
   * could act for them. Copying the session into CookieManager before the first
   * load hands the page the session the app is already using. What is copied,
   * and with which attributes, is [seedLines], given what the jar holds for
   * [origin] ([held]) and [rewriteSame]. True when a session was handed over,
   * which is what Repository.seedWebView records.
   */
  fun seed(origin: String, held: List<Cookie>, rewriteSame: Boolean = false): Boolean {
    val url = origin.toHttpUrlOrNull() ?: return false
    val cm = CookieManager.getInstance()
    cm.setAcceptCookie(true)
    val lines = seedLines(held, cm.getCookie(origin), url, System.currentTimeMillis(), rewriteSame)
    for (line in lines) cm.setCookie(origin, line)
    cm.flush()
    return lines.isNotEmpty()
  }

  /**
   * THE SESSION, AS THE SERVER SETS IT: the Set-Cookie lines [seed] hands
   * CookieManager, from the cookies the jar [held] for [url] and the WebView's
   * own line for it ([webRaw]).
   *
   * HttpOnly AND SameSite=Strict, ALWAYS. The server sets mm_session httpOnly
   * so that no script on the page can read it (web/src/lib/auth.ts
   * sessionCookieOptions), and CookieManager lets native code overwrite an
   * httpOnly cookie with one that is not. This used to write "name=value;
   * Path=/" on every handoff, which replaced the server's copy with one
   * `document.cookie` could read: any script running in the page (an XSS, a
   * compromised bundled SDK) could then take the session that places orders
   * and turns Live trading on. The jar cannot say which cookies were httpOnly
   * (the WebView's line never did), so the attributes come from what the
   * server is known to set, not from the jar.
   *
   * ONLY THE SESSION. A cookie the page's own script sets (mm_locale, the
   * language, written through `document.cookie`) belongs to the page; seeded
   * httpOnly, the script that owns it could no longer read or change it, and
   * no handoff needs it. A session the WebView already holds with the same
   * value is left exactly as the server set it, expiry included. The age is
   * the jar's when it knows one; a copy harvested from the WebView carries
   * none, so it is a session cookie there, and the next handoff seeds it again.
   *
   * [rewriteSame] WRITES IT EVEN THEN, and is for one handoff per install
   * (Repository.seedWebView). The old "name=value; Path=/" copy is still in
   * the WebView's store on a phone upgraded from a build that wrote it, and
   * its value is the jar's, because the jar harvested it from there. The
   * same-value skip therefore kept the copy a script can read until the owner
   * next signed in, since only a sign-in makes the server set the cookie again.
   */
  fun seedLines(held: List<Cookie>, webRaw: String?, url: HttpUrl, nowMs: Long, rewriteSame: Boolean = false): List<String> {
    val inWeb = webRaw.orEmpty().split(';').mapNotNull { part ->
      val t = part.trim()
      val eq = t.indexOf('=')
      if (eq <= 0) null else t.substring(0, eq) to t.substring(eq + 1)
    }.toMap()
    return held.filter { it.name in SESSION_COOKIES && (rewriteSame || inWeb[it.name] != it.value) }.map { c ->
      buildString {
        append(c.name).append('=').append(c.value)
        append("; Path=/; HttpOnly; SameSite=Strict")
        if (url.isHttps) append("; Secure")
        if (c.persistent) append("; Max-Age=").append(((c.expiresAt - nowMs) / 1000).coerceAtLeast(1))
      }
    }
  }

  /** The server's own httpOnly session cookie: the one thing a handoff hands over. */
  val SESSION_COOKIES: Set<String> = setOf("mm_session")

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

  /**
   * Hand the WebView the session the jar holds for [origin], before a web
   * page loads ([WebAuth.seedLines]; [rewriteSame] as there). True only when
   * a session was handed over: false when the jar held none for [origin], and
   * false when the WebView's store refused.
   */
  suspend fun seedWebView(origin: String, rewriteSame: Boolean): Boolean

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

  override suspend fun seedWebView(origin: String, rewriteSame: Boolean): Boolean {
    val url = origin.toHttpUrlOrNull() ?: return false
    // Only what the jar would send to this origin: it is scoped by host now,
    // so another server's session never lands in this server's page.
    val held = withContext(Dispatchers.IO) { jar.loadForRequest(url) }
    return web("seed") { WebAuth.seed(origin, held, rewriteSame) } == true
  }

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
 *
 * [seed] hands the WebView the session the app already holds
 * (Repository.seedWebView), and the page is not loaded until it has returned.
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun WebFlow(
  url: String,
  origin: String,
  jar: PersistentCookieJar,
  seed: suspend () -> Unit,
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
    onDispose { CookieManager.getInstance().flush() }
  }
  // Hand the WebView the session the app already holds, httpOnly as the
  // server set it, so a handoff page opens signed in as the same wallet the
  // app is (WebAuth.seedLines). THE PAGE WAITS FOR IT. The seed reads a
  // stored flag first (Repository.seedWebView), and a page loaded alongside
  // it could run its scripts while an older build's copy, the one a script
  // can read, was still in the store.
  var seeded by remember(origin) { mutableStateOf(false) }
  LaunchedEffect(origin) {
    seed()
    seeded = true
  }
  if (!seeded) return
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
