package dev.merrymen.app.net

import kotlinx.coroutines.runBlocking
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.Interceptor
import okhttp3.OkHttpClient
import okhttp3.Response
import java.util.concurrent.TimeUnit

/**
 * A COOKIE JAR THAT SURVIVES A COLD START.
 *
 * OkHttp's default jar is `CookieJar.NO_COOKIES` — it drops everything — and
 * this API is cookie-authenticated twice over: `mm_gate` for the site notice and
 * an HMAC-signed httpOnly session cookie for the account. Without persistence
 * the app re-authenticates on every process death, which for a trading client
 * means the portfolio is empty every time the user comes back to it.
 *
 * Serialised as `name=value` pairs against the origin's host. Deliberately NOT a
 * full cookie-attribute round trip: these are host-scoped session cookies for
 * one origin, and a hand-rolled attribute parser is a way to get `Secure` or
 * `HttpOnly` subtly wrong. Anything the server sets, we send back to that same
 * host and nowhere else.
 */
class PersistentCookieJar(private val session: Session) : CookieJar {

  private val memory = mutableMapOf<String, Cookie>()

  @Volatile private var loaded = false

  private fun loadOnce() {
    if (loaded) return
    synchronized(this) {
      if (loaded) return
      val raw = runBlocking { session.cookiesRaw() } ?: ""
      val host = runBlocking { session.originNow() }.toHttpHostOrNull()
      if (host != null) {
        raw.split('\n').filter { it.isNotBlank() }.forEach { line ->
          val eq = line.indexOf('=')
          if (eq > 0) {
            val name = line.substring(0, eq)
            val value = line.substring(eq + 1)
            Cookie.Builder().name(name).value(value).domain(host).build().let { memory[name] = it }
          }
        }
      }
      loaded = true
    }
  }

  override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
    loadOnce()
    var changed = false
    for (c in cookies) {
      // An expiry in the past is a delete instruction, not a cookie.
      if (c.expiresAt < System.currentTimeMillis()) {
        if (memory.remove(c.name) != null) changed = true
      } else {
        memory[c.name] = c
        changed = true
      }
    }
    if (changed) persist()
  }

  override fun loadForRequest(url: HttpUrl): List<Cookie> {
    loadOnce()
    return memory.values.toList()
  }

  fun clear() {
    synchronized(this) {
      memory.clear()
      persist()
    }
  }

  private fun persist() {
    val blob = memory.values.joinToString("\n") { "${it.name}=${it.value}" }
    runBlocking { session.setCookiesRaw(blob) }
  }

  private fun String.toHttpHostOrNull(): String? =
    runCatching { HttpUrl.get(this).host() }.getOrNull()
}

/**
 * THE HEADERS A NON-BROWSER MUST AND MUST NOT SEND.
 *
 * The API's middleware refuses a request whose `Sec-Fetch-Site` says cross-site,
 * and hosted it keeps that check while dropping the loopback host allowlist. A
 * plain native client sends NO `Sec-Fetch-Site` and no `Origin`, which the
 * middleware reads as "none" — a top-level navigation or a non-browser client —
 * and allows. So the correct behaviour here is to add nothing.
 *
 * That is worth writing down because the instinct is to "look more like a
 * browser" by adding an Origin header, and that is precisely the header that
 * would get every request refused.
 */
class MerrymenHeaders : Interceptor {
  override fun intercept(chain: Interceptor.Chain): Response {
    val req = chain.request().newBuilder()
      .header("accept", "application/json")
      .header("user-agent", "merrymen-android/${dev.merrymen.app.BuildConfig.VERSION_NAME}")
      .build()
    return chain.proceed(req)
  }
}

object Http {
  fun client(session: Session, jar: PersistentCookieJar): OkHttpClient =
    OkHttpClient.Builder()
      .cookieJar(jar)
      .addInterceptor(MerrymenHeaders())
      // A TRADING CLIENT WAITS, IT DOES NOT HANG. The chain reads behind these
      // routes are metered and can queue behind a rate-limit backoff, so a
      // three-second timeout would report "offline" for a server that is merely
      // being careful. Thirty is long enough to be honest and short enough that
      // a dead network still ends.
      .connectTimeout(15, TimeUnit.SECONDS)
      .readTimeout(30, TimeUnit.SECONDS)
      .writeTimeout(30, TimeUnit.SECONDS)
      .retryOnConnectionFailure(true)
      .build()
}
