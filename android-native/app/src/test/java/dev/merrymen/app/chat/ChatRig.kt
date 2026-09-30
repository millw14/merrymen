package dev.merrymen.app.chat

import dev.merrymen.app.data.ChatThread
import dev.merrymen.app.data.FileThreadStore
import dev.merrymen.app.data.Repository
import dev.merrymen.app.net.Http
import dev.merrymen.app.net.MemoryCookies
import dev.merrymen.app.net.MemoryStore
import dev.merrymen.app.net.MerrymenApi
import dev.merrymen.app.net.PersistentCookieJar
import dev.merrymen.app.net.origin
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.runBlocking
import okhttp3.Dns
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import java.io.File
import java.net.InetAddress
import java.nio.file.Files
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList

/** One request as the server saw it, body read once. */
data class Seen(val method: String, val path: String, val body: String)

/**
 * THE REAL THREAD, THE REAL REPOSITORY, A FAKE SERVER.
 *
 * Routes answer by "METHOD /path" (the query is ignored for matching, kept in
 * [Seen.path]); the session route answers with [address], so a test signs a
 * wallet in, switches it, or signs it out by changing that and asking the
 * Repository again — the same fold the app runs. The clock moves only when the
 * follow loop pauses, and the thread's disk is a directory of its own.
 */
class ChatRig : AutoCloseable {
  val server = MockWebServer()
  val seen = CopyOnWriteArrayList<Seen>()
  val routes = ConcurrentHashMap<String, (Seen) -> MockResponse>()
  @Volatile var address: String? = null
  /** The session route's connection is cut before it answers: a phone with no network, for that route alone. */
  @Volatile var sessionDown = false
  @Volatile var now = 1_000_000L
  val failures = CopyOnWriteArrayList<Throwable>()
  val dir: File = Files.createTempDirectory("chat-thread").toFile()

  init {
    server.dispatcher = object : Dispatcher() {
      override fun dispatch(request: RecordedRequest): MockResponse {
        val s = Seen(request.method.orEmpty(), request.path.orEmpty(), request.body.readUtf8())
        seen += s
        val path = s.path.substringBefore("?")
        if (path == "/api/auth/session") {
          if (sessionDown) return MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)
          val who = address?.let { "\"$it\"" } ?: "null"
          return json("""{"hosted":true,"address":$who}""")
        }
        if (path == "/api/auth/logout") return json("{}")
        val route = routes["${s.method} $path"] ?: return json("""{"error":"no route in this test"}""", 404)
        return route(s)
      }
    }
    // On the one address the client below resolves "localhost" to; see [api].
    server.start(LOOPBACK, 0)
    defaults()
  }

  val store = MemoryStore(server.origin())
  val jar = PersistentCookieJar(store)
  /**
   * The app's client, but one that never sends a request a second time on its
   * own. The integrated app writes through a client with
   * retryOnConnectionFailure(false) (the foundation's writeHttp): left on, OkHttp
   * could quietly re-send a POST whose connection this rig cuts, and a test of
   * "a lost placement is looked up, never sent again" would be measuring
   * OkHttp's retry rather than the code under test.
   *
   * "localhost" is pinned to the one address the server listens on. The JVM
   * resolves it to 127.0.0.1 AND ::1; a cut POST marks its route failed, the
   * next call then tries ::1 first, where nobody listens, and without the retry
   * it never falls back — the look-up after a lost placement failed for that
   * reason alone. The app's reads keep OkHttp's retry, so they fall back there.
   */
  val api = MerrymenApi(
    Http.client(jar, debug = false).newBuilder()
      .retryOnConnectionFailure(false)
      .dns(
        object : Dns {
          override fun lookup(hostname: String): List<InetAddress> =
            if (hostname == "localhost") listOf(LOOPBACK) else Dns.SYSTEM.lookup(hostname)
        },
      )
      .build(),
    store,
  )
  /** The Repository the app runs. A cold start replaces it: a new process has a fresh Identity. */
  var repo = Repository(api, store, MemoryCookies(jar))
    private set
  val scope = CoroutineScope(SupervisorJob() + Dispatchers.Unconfined + CoroutineExceptionHandler { _, e -> failures += e })

  fun thread(repository: Repository = repo): ChatThread =
    ChatThread(api, repository, scope, FileThreadStore(dir), clock = { now }, pause = { now += it }, io = Dispatchers.Unconfined)

  /**
   * A NEW PROCESS: a fresh Repository (no wallet known, no hooks run) and a
   * fresh thread over the same disk. Sign in again with [signIn].
   */
  fun coldStart(): ChatThread {
    repo = Repository(api, store, MemoryCookies(jar))
    return thread()
  }

  fun route(key: String, answer: (Seen) -> MockResponse) {
    routes[key] = answer
  }

  fun signIn(who: String?) = runBlocking {
    address = who
    repo.refreshIdentity()
  }

  /** The requests that were writes: anything but a GET. */
  fun writes() = seen.filter { it.method != "GET" }

  private fun defaults() {
    route("GET /api/feed") { json(FEED) }
    route("GET /api/grants") { json(GRANTS) }
    route("GET /api/settings") { json(SETTINGS) }
    route("GET /api/orders/ceiling") { json("""{"ceilingUsdg":25}""") }
  }

  override fun close() {
    server.shutdown()
    dir.deleteRecursively()
    // Work in the app scope that threw was only logged there; here it fails the test.
    check(failures.isEmpty()) { "app-scoped work failed: " + failures.joinToString() }
  }

  companion object {
    val LOOPBACK: InetAddress = InetAddress.getByName("127.0.0.1")

    const val A = "0x00000000000000000000000000000000000000aa"
    const val B = "0x00000000000000000000000000000000000000bb"

    fun json(body: String, code: Int = 200): MockResponse =
      MockResponse().setResponseCode(code).setHeader("content-type", "application/json").setBody(body)

    fun sse(vararg events: Pair<String, String>): MockResponse =
      MockResponse().setHeader("content-type", "text/event-stream")
        .setBody(events.joinToString("") { (n, d) -> "event: $n\ndata: $d\n\n" })

    val FEED = """{"source":"sqlite","agent":{"slug":"shogun","name":"Shogun","strategy":"steady-basket","nameSource":"settings"},
      "positions":[{"symbol":"NVDA","value_usdg":12.5,"price_stale":0,"cost_usdg":10.0,"cost_from_quote":false}],
      "equity":[{"equity_usdg":40.0,"cash_usdg":27.5,"vault_usdg":0.0,"at":"2026-09-24 11:00:00"}],
      "trades":[{"kind":"swap","status":"landed","fill_side":"buy","symbol":"NVDA","amount_usdg":10.0,"created_at":"2026-09-24 10:00:00"}]}"""

    val GRANTS = """{"exists":true,"mode":"paper","liveBlocker":"live-not-enabled","grant":{"caps":{"perTradeUsdg":20,"dailyUsdg":100}}}"""

    val SETTINGS = """{"values":{"basketSymbols":["NVDA","TSLA"]},"defaults":{"liveTradingEnabled":false,"paperTradingEnabled":true},
      "owner":"$A"}"""
  }
}

/** Wait for a condition the app scope reaches on its own threads. */
fun waitFor(what: String, timeoutMs: Long = 5_000, ok: () -> Boolean) {
  val until = System.currentTimeMillis() + timeoutMs
  while (!ok()) {
    if (System.currentTimeMillis() > until) throw AssertionError("timed out waiting for: $what")
    Thread.sleep(10)
  }
}
