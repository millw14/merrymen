package dev.merrymen.app.net

import android.annotation.SuppressLint
import android.content.Intent
import android.app.Activity
import android.content.Context
import android.content.ContextWrapper
import android.os.Message
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceError
import android.webkit.WebResourceResponse
import android.graphics.Bitmap
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.key
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.platform.LocalContext
import java.util.UUID
import androidx.compose.ui.Alignment
import androidx.compose.ui.unit.dp
import dev.merrymen.app.ui.MerryColors
import dev.merrymen.app.ui.Notice
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
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.repeatOnLifecycle
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
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

  /** False when the platform could not read its store; do not acknowledge that snapshot. */
  suspend fun harvestChecked(origin: String): Boolean { harvest(origin); return true }

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
  override suspend fun harvest(origin: String) { harvestChecked(origin) }

  override suspend fun harvestChecked(origin: String): Boolean {
    val url = origin.toHttpUrlOrNull() ?: return false
    // Wrap a successful read: null cookies means signed out, while a null
    // wrapper means the platform failed and cannot vouch for any deletion.
    val snapshot = web("read") { WebCookieSnapshot(CookieManager.getInstance().getCookie(origin)) } ?: return false
    val cookies = harvestedWebCookies(snapshot.raw, url)
    withContext(Dispatchers.IO) { jar.saveFromResponse(url, cookies) }
    return true
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

private data class WebCookieSnapshot(val raw: String?)

/** A successful browser logout expires only this host's native session copy. */
internal fun harvestedWebCookies(raw: String?, url: HttpUrl): List<Cookie> {
  val read = WebAuth.webCookies(raw.orEmpty(), url)
  if (read.any { it.name == "mm_session" && it.value.isNotEmpty() }) return read
  return read.filterNot { it.name == "mm_session" } + Cookie.Builder()
    .name("mm_session").value("").hostOnlyDomain(url.host).path("/").expiresAt(1).build()
}

private class PopupWebView(val view: WebView) {
  private var released = false
  fun release() {
    if (released) return
    released = true
    (view.parent as? ViewGroup)?.removeView(view)
    view.stopLoading()
    view.webViewClient = WebViewClient()
    view.webChromeClient = WebChromeClient()
    view.destroy()
  }
}

private fun Context.hostActivity(): Activity? = when (this) {
  is Activity -> this
  is ContextWrapper -> baseContext.takeUnless { it === this }?.hostActivity()
  else -> null
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
  seed: suspend () -> Unit,
  onCookies: suspend () -> Boolean,
  modifier: Modifier = Modifier,
  externalOAuth: Boolean = false,
  authContextCurrent: () -> Boolean = { true },
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
  var seeded by remember(origin) { mutableStateOf(false) }
  val authFlowId = rememberSaveable(origin, url) { UUID.randomUUID().toString() }
  val hostActivity = LocalContext.current.hostActivity()
  val currentAuthContext by rememberUpdatedState(authContextCurrent)
  DisposableEffect(authFlowId) {
    onDispose {
      // Rotation recreates the view but retains the flow id and Privy's DOM
      // storage. Leaving the screen abandons its pending external approval.
      if (hostActivity?.isChangingConfigurations != true) AndroidOAuthReturns.cancelFlow(authFlowId)
    }
  }
  val currentOnCookies by rememberUpdatedState(onCookies)
  val lifecycle = LocalLifecycleOwner.current.lifecycle
  LaunchedEffect(origin) {
    seed()
    seeded = true
  }
  // Privy sets mm_session from fetch(), without a document navigation. Read
  // only this entry's original origin, only while visible, and await adoption
  // so no two snapshots race each other. No cookie value is logged or sent to
  // JavaScript. Disposal stops observation; an adoption already changing
  // credentials finishes its bounded identity check in Repository.
  LaunchedEffect(origin, seeded, lifecycle) {
    if (!seeded) return@LaunchedEffect
    val changes = WebSessionChanges()
    lifecycle.repeatOnLifecycle(Lifecycle.State.RESUMED) {
      while (isActive) {
        val snapshot = runCatching { WebCookieSnapshot(CookieManager.getInstance().getCookie(origin)) }.getOrNull()
        var retry = false
        if (snapshot != null && changes.needsAdoption(snapshot.raw)) {
          if (currentOnCookies()) changes.adopted(snapshot.raw) else retry = true
        }
        delay(if (retry) 2_000 else 750)
      }
    }
  }
  var attempt by remember(url, origin) { mutableStateOf(0) }
  Box(modifier.fillMaxSize().background(MerryColors.bg)) {
    if (!seeded) {
      LinearProgressIndicator(color = MerryColors.mint, modifier = Modifier.fillMaxWidth())
    } else key(url, origin, attempt) {
      var loading by remember { mutableStateOf(true) }
      var failure by remember { mutableStateOf<String?>(null) }
      var linkNotice by remember { mutableStateOf<String?>(null) }
      var webView by remember { mutableStateOf<WebView?>(null) }
      var popup by remember { mutableStateOf<PopupWebView?>(null) }
      var popupHost by remember { mutableStateOf("Opening page…") }
      var canGoBack by remember { mutableStateOf(false) }
      var active by remember { mutableStateOf(true) }
      var externalUrl by rememberSaveable(authFlowId) { mutableStateOf<String?>(null) }
      var continueEmbedded by remember { mutableStateOf(false) }
      val returned by AndroidOAuthReturns.delivery.collectAsState()
      LaunchedEffect(returned, webView) {
        if (returned?.flowId != authFlowId || webView == null) return@LaunchedEffect
        if (!active || !currentAuthContext()) {
          AndroidOAuthReturns.cancelFlow(authFlowId)
          return@LaunchedEffect
        }
        AndroidOAuthReturns.take(authFlowId)?.let { resume ->
          externalUrl = null
          webView?.loadUrl(resume)
        }
      }
      fun closePopup() {
        val closing = popup
        popup = null
        // An attached popup is released by AndroidView; one opened and handed
        // to Telegram before the next frame has no view holder to release it.
        if (closing?.view?.parent == null) closing?.release()
      }
      DisposableEffect(Unit) { onDispose { active = false; popup?.release() } }
      BackHandler(enabled = popup != null || canGoBack) {
        val child = popup?.view
        if (child != null) {
          if (child.canGoBack()) child.goBack() else closePopup()
        } else webView?.goBack()
      }

      fun configure(view: WebView) {
        // WebView treats WRAP_CONTENT height as a zero CSS viewport, even when
        // Compose measures a fixed height. Declare this before attachment so
        // viewport units and hosted sign-in dialogs use the visible height.
        // Chromium AwLayoutSizer.updateLayoutSettings checks the raw params.
        view.layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        view.setBackgroundColor(android.graphics.Color.rgb(14, 15, 12))
        view.settings.javaScriptEnabled = true
        view.settings.domStorageEnabled = true
        view.settings.userAgentString += " $ANDROID_AUTH_USER_AGENT"
        // Keep popup-based OAuth and Telegram's about:blank placeholder from
        // replacing the settings page that owns their pending request.
        view.settings.setSupportMultipleWindows(true)
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, true)
        view.webViewClient = object : WebViewClient() {
          override fun shouldOverrideUrlLoading(source: WebView?, request: WebResourceRequest?): Boolean {
            if (!active || request == null) return true
            if (externalOAuth && !continueEmbedded && request.isForMainFrame && currentAuthContext() &&
              AndroidOAuthReturns.begin(authFlowId, source?.url, request.url.toString())
            ) {
              if (openExternalX(view.context, request.url.toString())) {
                externalUrl = request.url.toString()
                loading = false
                return true
              }
              // No suitable app/browser: retain the original in-app flow.
              AndroidOAuthReturns.cancelFlow(authFlowId)
            }
            return when (webLinkTarget(request.url.toString(), request.isForMainFrame)) {
              WebLinkTarget.Embedded -> false
              WebLinkTarget.Telegram -> {
                val opened = runCatching {
                  view.context.startActivity(Intent(Intent.ACTION_VIEW, request.url).addCategory(Intent.CATEGORY_BROWSABLE))
                }.isSuccess
                if (!opened) linkNotice = "Couldn't open Telegram. Install Telegram or a browser, then try the link again."
                if (popup?.view === source) closePopup()
                true
              }
              WebLinkTarget.Blocked -> {
                if (request.isForMainFrame) linkNotice = "This type of link can't be opened here. Continue on this page or use a supported sign-in option."
                true
              }
            }
          }
          override fun onPageStarted(source: WebView?, nextUrl: String?, favicon: Bitmap?) {
            if (!active) return
            if (popup?.view === source) {
              popupHost = nextUrl?.toHttpUrlOrNull()?.host ?: "Opening page…"
            } else {
              loading = true
              failure = null
            }
          }
          override fun doUpdateVisitedHistory(source: WebView?, visitedUrl: String?, isReload: Boolean) {
            if (active && popup?.view !== source) canGoBack = source?.canGoBack() == true
          }
          override fun onPageFinished(source: WebView?, finishedUrl: String?) {
            if (active && popup?.view !== source) {
              loading = false
              canGoBack = source?.canGoBack() == true
            }
            // Cookie changes are observed independently of document loads:
            // a fetch-based sign-in and an OAuth popup both update the same jar.
          }
          override fun onReceivedError(source: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
            if (!active || request?.isForMainFrame != true) return
            if (popup?.view === source) {
              closePopup()
              linkNotice = "Couldn't open that page. Check your connection and try again."
            } else {
              loading = false
              failure = "Check your connection, then reopen this page. If you submitted a change, check its status before submitting again."
            }
          }
          override fun onReceivedHttpError(source: WebView?, request: WebResourceRequest?, response: WebResourceResponse?) {
            if (!active || request?.isForMainFrame != true) return
            if (popup?.view === source) {
              closePopup()
              linkNotice = "That page couldn't load. Close it and try again shortly."
            } else {
              loading = false
              failure = "The server could not open this page. Try again shortly."
            }
          }
        }
        view.webChromeClient = object : WebChromeClient() {
          override fun onCreateWindow(source: WebView?, isDialog: Boolean, isUserGesture: Boolean, resultMsg: Message?): Boolean {
            if (!active || !isUserGesture || popup != null) return false
            val transport = resultMsg?.obj as? WebView.WebViewTransport ?: return false
            val child = PopupWebView(WebView(view.context))
            configure(child.view)
            popupHost = "Opening page…"
            popup = child
            transport.webView = child.view
            resultMsg.sendToTarget()
            return true
          }
          override fun onCloseWindow(window: WebView?) {
            if (active && popup?.view === window) closePopup()
          }
        }
      }
      AndroidView(
        modifier = Modifier.fillMaxSize(),
        factory = { ctx ->
          WebView(ctx).apply {
            webView = this
            configure(this)
            // Never reset a redirect or in-page navigation on recomposition.
            loadUrl(url)
          }
        },
        onRelease = { view ->
          active = false
          popup?.release()
          webView = null
          view.stopLoading()
          view.webViewClient = WebViewClient()
          view.webChromeClient = WebChromeClient()
          view.destroy()
        },
      )
      popup?.let { child ->
        key(child) {
          Column(Modifier.fillMaxSize().background(MerryColors.bg)) {
            Row(Modifier.fillMaxWidth().padding(horizontal = 12.dp), verticalAlignment = Alignment.CenterVertically) {
              Text(popupHost, color = MerryColors.tx2, modifier = Modifier.weight(1f), maxLines = 1)
              TextButton(onClick = ::closePopup) { Text("Close", color = MerryColors.tx) }
            }
            AndroidView(factory = { child.view }, modifier = Modifier.fillMaxWidth().weight(1f), onRelease = { child.release() })
          }
        }
      }
      linkNotice?.let { message ->
        Notice(
          title = "Link unavailable", body = message,
          actionLabel = "Dismiss", onAction = { linkNotice = null },
          modifier = Modifier.align(Alignment.BottomCenter).padding(16.dp),
        )
      }
      externalUrl?.let { authorization ->
        Notice(
          title = "Finish signing in",
          body = "Approve with X or your browser, then return to Merrymen. You can also finish here.",
          actionLabel = "Continue in Merrymen",
          onAction = {
            AndroidOAuthReturns.cancelFlow(authFlowId)
            externalUrl = null
            continueEmbedded = true
            webView?.loadUrl(authorization)
          },
          modifier = Modifier.align(Alignment.BottomCenter).padding(16.dp),
        )
      }
      if (loading) LinearProgressIndicator(
        color = MerryColors.mint, modifier = Modifier.fillMaxWidth().align(Alignment.TopCenter),
      )
      failure?.let { message ->
        Box(Modifier.fillMaxSize().background(MerryColors.bg).padding(24.dp), contentAlignment = Alignment.Center) {
          Notice(
            title = "Couldn't load the page", body = message,
            actionLabel = "Reopen page", onAction = { attempt += 1 },
          )
        }
      }
    }
  }
}
