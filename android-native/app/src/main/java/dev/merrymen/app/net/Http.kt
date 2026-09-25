package dev.merrymen.app.net

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.Cookie
import okhttp3.CookieJar
import okhttp3.HttpUrl
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import okhttp3.Interceptor
import okhttp3.MediaType
import okhttp3.OkHttpClient
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import okhttp3.logging.HttpLoggingInterceptor
import okio.BufferedSink
import java.util.concurrent.TimeUnit

/**
 * WHERE THE JAR KEEPS ITS COOKIES BETWEEN LAUNCHES — one opaque string.
 *
 * An interface so the jar runs on the JVM: [Session] implements it over
 * DataStore, and a unit test implements it over a field. [originNow] is asked
 * once, only to place cookies an older build stored without saying which host
 * they came from.
 */
interface CookieBlob : OriginSource {
  suspend fun cookiesRaw(): String?
  suspend fun setCookiesRaw(value: String)
}

/**
 * A cookie as stored: every attribute OkHttp parsed, so a reloaded cookie
 * matches exactly the requests the original did. Written from a parsed
 * [Cookie] and rebuilt with [Cookie.Builder] — no attribute string is ever
 * parsed by hand here.
 */
@Serializable
private data class StoredCookie(
  val name: String,
  val value: String,
  val expiresAt: Long,
  val domain: String,
  val path: String = "/",
  val secure: Boolean = false,
  val httpOnly: Boolean = false,
  val hostOnly: Boolean = true,
) {
  fun toCookie(): Cookie = Cookie.Builder().name(name).value(value).expiresAt(expiresAt).path(path)
    .apply { if (hostOnly) hostOnlyDomain(domain) else domain(domain) }
    .apply { if (secure) secure() }
    .apply { if (httpOnly) httpOnly() }
    .build()

  companion object {
    fun of(c: Cookie) = StoredCookie(c.name, c.value, c.expiresAt, c.domain, c.path, c.secure, c.httpOnly, c.hostOnly)
  }
}

private val cookieJson = Json { ignoreUnknownKeys = true }

/**
 * A COOKIE JAR THAT SURVIVES A COLD START — and sends each cookie only where
 * it came from.
 *
 * OkHttp's default jar is `CookieJar.NO_COOKIES` — it drops everything — and
 * this API is cookie-authenticated: an HMAC-signed httpOnly session cookie for
 * the account. Without persistence the app re-authenticates on every process
 * death, which for a trading client means the portfolio is empty every time
 * the user comes back to it.
 *
 * SCOPED TO THE HOST THAT SET IT, by OkHttp's own [Cookie.matches]. This jar
 * used to answer every request with every cookie it held, whatever the host.
 * The Server field in Settings takes any address, so an owner who pointed the
 * app at another server — a typo, a laptop, somebody's "staging" link — sent
 * their hosted mm_session to it on the very first request: a bearer
 * credential for their trading account, handed to whoever runs that host. Now
 * a cookie goes back to the host (and path, and scheme if Secure) it was set
 * for, and nowhere else, so changing the server simply stops sending it.
 *
 * Stored as JSON of the parsed attributes (see [StoredCookie]). A blob an older
 * build wrote — `name=value` lines, no host — is read once as host-only cookies
 * of the origin stored at the time, which is where they came from, and
 * rewritten in the new form straight away.
 *
 * Keyed by name, domain and path, the way a browser keys them: two servers can
 * each set an mm_session without one overwriting the other.
 */
class PersistentCookieJar(private val store: CookieBlob) : CookieJar {

  private val memory = mutableMapOf<String, Cookie>()

  @Volatile private var loaded = false

  private fun key(c: Cookie) = c.name + "\u0000" + c.domain + "\u0000" + c.path

  private fun loadOnce() {
    if (loaded) return
    synchronized(this) {
      if (loaded) return
      val raw = runBlocking { store.cookiesRaw() }.orEmpty().trim()
      val now = System.currentTimeMillis()
      val isLegacy = raw.isNotEmpty() && !raw.startsWith("[")
      val cookies = if (isLegacy) {
        legacy(raw)
      } else {
        runCatching { cookieJson.decodeFromString<List<StoredCookie>>(raw.ifEmpty { "[]" }) }.getOrDefault(emptyList())
          .mapNotNull { runCatching { it.toCookie() }.getOrNull() }
      }
      cookies.filter { it.expiresAt > now }.forEach { memory[key(it)] = it }
      // REWRITTEN AT ONCE, not on the next change. A legacy blob says nothing
      // about its host, so left on disk it would be placed on whatever origin
      // is stored at the NEXT launch — after a Server change, the new one.
      if (isLegacy) persist()
      loaded = true
    }
  }

  /** `name=value` lines from 0.1.0, placed on the host they were stored against. */
  private fun legacy(raw: String): List<Cookie> {
    if (raw.isEmpty()) return emptyList()
    val host = runBlocking { store.originNow() }.toHttpUrlOrNull()?.host ?: return emptyList()
    return raw.split('\n').mapNotNull { line ->
      val eq = line.indexOf('=')
      if (eq <= 0) return@mapNotNull null
      runCatching {
        Cookie.Builder().name(line.substring(0, eq).trim()).value(line.substring(eq + 1).trim())
          .hostOnlyDomain(host).path("/").build()
      }.getOrNull()
    }
  }

  override fun saveFromResponse(url: HttpUrl, cookies: List<Cookie>) {
    loadOnce()
    synchronized(this) {
      var changed = false
      val now = System.currentTimeMillis()
      for (c in cookies) {
        // An expiry in the past is a delete instruction, not a cookie.
        if (c.expiresAt <= now) {
          if (memory.remove(key(c)) != null) changed = true
        } else {
          memory[key(c)] = c
          changed = true
        }
      }
      if (changed) persist()
    }
  }

  override fun loadForRequest(url: HttpUrl): List<Cookie> {
    loadOnce()
    synchronized(this) {
      val now = System.currentTimeMillis()
      return memory.values.filter { it.expiresAt > now && it.matches(url) }
    }
  }

  fun clear() {
    loadOnce()
    synchronized(this) {
      memory.clear()
      persist()
    }
  }

  /**
   * Forget every cookie called [name], whichever host set it, in memory and on
   * disk. Goes through the jar rather than editing the stored blob, because the
   * jar holds its own copy once loaded and would write a deleted cookie
   * straight back.
   */
  fun drop(name: String) {
    loadOnce()
    synchronized(this) {
      if (memory.values.removeAll { it.name == name }) persist()
    }
  }

  private fun persist() {
    val blob = cookieJson.encodeToString(memory.values.map { StoredCookie.of(it) })
    runBlocking { store.setCookiesRaw(blob) }
  }
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
    val asked = chain.request()
    val req = asked.newBuilder()
      .header("user-agent", "merrymen-android/${dev.merrymen.app.BuildConfig.VERSION_NAME}")
      // JSON UNLESS THE CALL ASKED FOR SOMETHING ELSE. /api/chat streams when a
      // request accepts text/event-stream, and overwriting that here would
      // silently turn every streamed read back into a single late JSON answer.
      .apply { if (asked.header("accept") == null) header("accept", "application/json") }
      .build()
    return chain.proceed(req)
  }
}

/**
 * WHICH CALLS WERE MADE, IN A DEBUG BUILD ONLY — and nothing about who made them.
 *
 * An emulator run has to be able to prove a negative: that a cold start sends
 * no request to a route that was removed, that "Not now" on a confirm card
 * placed nothing. `adb logcat -s OkHttp` shows it, because this logs the
 * request line and the status and nothing else.
 *
 * BASIC, AND ONLY BASIC. The next level up logs headers, and the headers are
 * where the session cookie travels: a bearer credential for somebody's trading
 * account does not belong in a log that every bug report and every
 * `adb logcat` collects. The two cookie headers are redacted as well, so
 * raising the level by accident still cannot print one. A release build never
 * adds this at all. HttpLoggingTest holds both lines.
 *
 * [sink] is where the lines go: logcat in the app, a list in a test.
 */
internal fun debugCallLog(
  sink: (String) -> Unit = { line -> android.util.Log.i("OkHttp", line) },
): HttpLoggingInterceptor =
  HttpLoggingInterceptor { line -> sink(line) }.apply {
    level = HttpLoggingInterceptor.Level.BASIC
    redactHeader("Cookie")
    redactHeader("Set-Cookie")
  }

/** Anything but GET and HEAD: a request that may DO something, so it must happen at most once. */
internal fun isWrite(method: String): Boolean = method != "GET" && method != "HEAD"

/**
 * A WRITE IS SENT ONCE. OkHttp does not get to send it again on its own.
 *
 * OkHttp re-sends a request by itself in more cases than a stale connection:
 * a 408, a 421, an auth challenge, and a 503 that says `Retry-After: 0` — that
 * last one even with retryOnConnectionFailure off. For an order, a snipe, a
 * confirm or a settings save, every one of those is a second copy of the
 * owner's decision sent behind their back, and a gateway's 503 can arrive
 * AFTER the route already placed the order.
 *
 * A body marked one-shot is the one thing OkHttp promises never to transmit
 * twice ([RequestBody.isOneShot]): the failure or the answer comes back
 * instead, and the caller reads it as UNKNOWN and looks it up. So every write
 * through the app's client gets one here — including one a screen built by
 * hand on `http.newCall`, and one on a client derived with
 * retryOnConnectionFailure turned back on. A write with no body gets an empty
 * one, which is what OkHttp's own `delete()` sends. Reads are left alone; a
 * GET the transport repeats does nothing twice.
 *
 * Installed LAST among the application interceptors, so nothing after it can
 * swap the body back for a repeatable one.
 */
class SendWritesOnce : Interceptor {
  override fun intercept(chain: Interceptor.Chain): Response {
    val asked = chain.request()
    val body = asked.body
    if (!isWrite(asked.method) || body?.isOneShot() == true) return chain.proceed(asked)
    val once = OnceBody(body ?: ByteArray(0).toRequestBody(null))
    return chain.proceed(asked.newBuilder().method(asked.method, once).build())
  }

  private class OnceBody(private val inner: RequestBody) : RequestBody() {
    override fun contentType(): MediaType? = inner.contentType()
    override fun contentLength(): Long = inner.contentLength()
    override fun isDuplex(): Boolean = inner.isDuplex()
    override fun isOneShot(): Boolean = true
    override fun writeTo(sink: BufferedSink) = inner.writeTo(sink)
  }
}

/**
 * THIS CLIENT, FIT TO CARRY A WRITE: no transport retry, and [SendWritesOnce]
 * last. Itself when it already is — the app's client is — so the common case
 * builds nothing; otherwise a derivative sharing its pool, jar and headers.
 */
internal fun OkHttpClient.forWrites(): OkHttpClient =
  if (!retryOnConnectionFailure && interceptors.lastOrNull() is SendWritesOnce) {
    this
  } else {
    newBuilder().retryOnConnectionFailure(false)
      .apply { if (interceptors().lastOrNull() !is SendWritesOnce) addInterceptor(SendWritesOnce()) }
      .build()
  }

object Http {
  /**
   * The app's one client. [debug] is BuildConfig.DEBUG in the app; a test
   * passes false to see what a release build is made of.
   */
  fun client(jar: CookieJar, debug: Boolean = dev.merrymen.app.BuildConfig.DEBUG): OkHttpClient =
    OkHttpClient.Builder()
      .cookieJar(jar)
      .addInterceptor(MerrymenHeaders())
      .apply { if (debug) addInterceptor(debugCallLog()) }
      .addInterceptor(SendWritesOnce())
      // A TRADING CLIENT WAITS, IT DOES NOT HANG. The chain reads behind these
      // routes are metered and can queue behind a rate-limit backoff, so a
      // three-second timeout would report "offline" for a server that is merely
      // being careful. Thirty is long enough to be honest and short enough that
      // a dead network still ends.
      .connectTimeout(15, TimeUnit.SECONDS)
      .readTimeout(30, TimeUnit.SECONDS)
      .writeTimeout(30, TimeUnit.SECONDS)
      // NO TRANSPORT RETRY ON THE SHARED CLIENT. With it on, OkHttp silently
      // re-sent a request whose answer was cut off on a reused connection: an
      // agent-picture PUT reached the server twice in a test, and an order is
      // a POST that would go the same way. A lost answer to a write is UNKNOWN and is looked up; it is
      // never sent again by the transport. Everything built from this client
      // (chatHttp, writeHttp, a route's own timeouts) inherits the off, and
      // [SendWritesOnce] holds even where somebody turns it back on. Reads get
      // the recovery back where it is provably a read: MerrymenApi hands only a
      // GET or HEAD to its private read client.
      .retryOnConnectionFailure(false)
      .build()
}
