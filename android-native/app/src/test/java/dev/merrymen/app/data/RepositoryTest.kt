package dev.merrymen.app.data

import dev.merrymen.app.net.Http
import dev.merrymen.app.net.MemoryCookies
import dev.merrymen.app.net.MemoryStore
import dev.merrymen.app.net.MerrymenApi
import dev.merrymen.app.net.OriginCheck
import dev.merrymen.app.net.PersistentCookieJar
import dev.merrymen.app.net.answer
import dev.merrymen.app.net.origin
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.Cookie
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.IOException
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.ProxySelector
import java.net.SocketAddress
import java.net.URI
import java.util.concurrent.TimeUnit

/**
 * WHEN A WALLET'S STATE GOES, through the real Repository.
 *
 * IdentityTest holds the fold. This holds the wiring around it — the part that
 * could be reverted with every Identity test still green: sign-out running the
 * hooks and emptying both cookie stores, a start dropping the retired password
 * and its cookie, and a Server change ending the turn. The API, the client and
 * the cookie jar are the production classes; only DataStore and the WebView's
 * CookieManager are stood in for (MemoryStore, MemoryCookies).
 */
class RepositoryTest {
  private lateinit var server: MockWebServer
  private lateinit var store: MemoryStore
  private lateinit var jar: PersistentCookieJar
  private lateinit var cookies: MemoryCookies
  private lateinit var repo: Repository

  @Before fun start() {
    server = MockWebServer()
    server.start()
    store = MemoryStore(server.origin())
    jar = PersistentCookieJar(store)
    cookies = MemoryCookies(jar)
    val http = Http.client(jar, debug = false).newBuilder().proxySelector(EmulatorHost).build()
    repo = Repository(MerrymenApi(http, store), store, cookies)
  }

  /**
   * ANOTHER HOST, ON THIS MACHINE. Cookies are scoped by host and not by port,
   * so a second MockWebServer on localhost would share the first one's
   * cookies — as two servers on one laptop do. The emulator reaches a laptop
   * at 10.0.2.2, which the Server field accepts over http; this sends that
   * host to the MockWebServer on the same port.
   */
  private object EmulatorHost : ProxySelector() {
    override fun select(uri: URI): List<Proxy> =
      if (uri.host == "10.0.2.2") listOf(Proxy(Proxy.Type.HTTP, InetSocketAddress("localhost", uri.port)))
      else listOf(Proxy.NO_PROXY)

    override fun connectFailed(uri: URI?, sa: SocketAddress?, ioe: IOException?) = Unit
  }

  private fun MockWebServer.asEmulatorHost() = "http://10.0.2.2:$port"

  @After fun stop() = server.shutdown()

  private fun MockWebServer.session(address: String?, hosted: Boolean = true, cookie: String? = null) {
    val who = if (address == null) "null" else "\"$address\""
    enqueue(
      MockResponse().setHeader("content-type", "application/json")
        .apply { if (cookie != null) setHeader("Set-Cookie", cookie) }
        .setBody("""{"hosted":$hosted,"address":$who}"""),
    )
  }

  private fun sentCookies(server: MockWebServer): String? = server.takeRequest(5, TimeUnit.SECONDS)!!.getHeader("Cookie")

  /** Signs 0xAAA in on [server], with the session cookie that server set. */
  private suspend fun signedInAsA() {
    server.session("0xAAA", cookie = "mm_session=abc; Path=/; HttpOnly")
    repo.refreshIdentity()
    server.takeRequest()
    assertEquals("0xAAA", repo.signedIn.value)
  }

  // ── sign-out ─────────────────────────────────────────────────────────────

  @Test fun signOutRunsEveryHookAndEmptiesBothStores() = runBlocking {
    signedInAsA()
    cookies.web["mm_session"] = "abc"
    val ran = mutableListOf<String>()
    repo.addForgetHook { ran += "likes" }
    repo.addForgetHook { error("could not delete the thread file") }
    repo.addForgetHook { ran += "thread" }
    server.answer("{}")

    repo.signOut()

    val logout = server.takeRequest()
    assertEquals("POST /api/auth/logout", logout.method + " " + logout.path)
    assertEquals("mm_session=abc", logout.getHeader("Cookie"))
    assertEquals("every hook, the ones after a failure too", listOf("likes", "thread"), ran)
    assertNull(repo.signedIn.value)
    assertTrue(jar.loadForRequest("${server.origin()}/".toHttpUrl()).isEmpty())
    assertTrue(cookies.web.isEmpty())
    assertEquals(1, store.sessionsCleared)
  }

  @Test fun hooksRunOffTheCallersThread() = runBlocking {
    signedInAsA()
    val caller = Thread.currentThread()
    var ranOn: Thread? = null
    repo.addForgetHook { ranOn = Thread.currentThread() }
    server.answer("{}")
    repo.signOut()
    // Deleting a thread file in a hook must not block whichever thread asked
    // for the sign-out — in the app, that is the main thread.
    assertTrue(ranOn != null && ranOn !== caller)
  }

  @Test fun aHookThatCallsBackIntoIdentityFailsInsteadOfFreezingTheApp() = runBlocking {
    signedInAsA()
    var after = false
    repo.addForgetHook { repo.refreshIdentity() }
    repo.addForgetHook { after = true }
    server.answer("{}") // logout
    server.session("0xAAA") // what the hook's read would be told, if it were sent
    // Without the guard this waits for the turn it is part of, forever.
    withTimeout(10_000) { repo.signOut() }
    assertTrue(after)
    assertNull(repo.signedIn.value)
    assertEquals("the hook's read was refused before it was sent", 2, server.requestCount)
  }

  // Refused at the lock, the next four were refused too late: the logout had
  // gone, both cookie stores were wiped or the new server stored, and only then
  // did identity say no — a wallet published with no session behind it, or the
  // old server's verdict standing against a new one. Each is refused now before
  // it does anything, and the hooks after it still run.

  /** Sign 0xAAA out with [offender] as a forget hook; true if the hook after it ran. */
  private suspend fun signOutWithHook(offender: ForgetHook): Boolean {
    signedInAsA()
    var after = false
    repo.addForgetHook(offender)
    repo.addForgetHook { after = true }
    server.answer("{}") // the one logout
    server.answer("{}") // what a second one would be told
    withTimeout(10_000) { repo.signOut() }
    assertNull(repo.signedIn.value)
    return after
  }

  @Test fun aHookThatSignsOutIsRefusedBeforeItPostsOrWipes() = runBlocking {
    assertTrue(signOutWithHook { repo.signOut() })
    assertEquals("the session read and ONE logout", 2, server.requestCount)
    assertEquals(1, store.sessionsCleared)
  }

  @Test fun aHookThatMovesServerIsRefusedBeforeItStoresOne() = runBlocking {
    assertTrue(signOutWithHook { repo.setOrigin("https://staging.merrymen.dev") })
    assertEquals(server.origin(), store.originNow())
  }

  @Test fun aHookThatAdoptsTheWebSessionIsRefusedBeforeItHarvests() = runBlocking {
    // The WebView store is emptied before the hooks run; anything in it now
    // was put there after, and must not be copied into an emptied jar.
    assertTrue(signOutWithHook { cookies.web["mm_session"] = "stale"; repo.adoptWebSession() })
    assertTrue(jar.loadForRequest("${server.origin()}/".toHttpUrl()).isEmpty())
  }

  @Test fun aHookThatRestartsIsRefusedBeforeItDropsAnything() = runBlocking {
    store.gatePassword = "still here"
    assertTrue(signOutWithHook { repo.bootstrap() })
    assertEquals("no start ran from inside the turn", "still here", store.gatePassword)
    assertEquals("the session read and the logout; no version asked", 2, server.requestCount)
  }

  // ── a cold start ─────────────────────────────────────────────────────────

  @Test fun bootstrapDropsTheRetiredPasswordAndItsCookieFromBothStores() = runBlocking {
    // What a 0.1.0 install left behind: the password in prefs, and mm_gate —
    // whose value WAS the password — in the jar and in the WebView.
    store.gatePassword = "beta-password"
    store.cookieBlob = "mm_gate=beta-password\nmm_session=abc"
    cookies.web["mm_gate"] = "beta-password"
    cookies.web["mm_session"] = "abc"
    server.answer("""{"version":"0.21.0"}""")
    server.session("0xAAA")

    assertEquals(Loaded.Value(Unit), repo.bootstrap())

    assertNull(store.gatePassword)
    assertFalse(cookies.web.containsKey("mm_gate"))
    assertEquals("the first request carries the session and not the password", "mm_session=abc", sentCookies(server))
    assertEquals("mm_session=abc", sentCookies(server))

    // A WebView that still holds it hands it back on the next page; the
    // hand-back refuses it.
    cookies.web["mm_gate"] = "beta-password"
    server.session("0xAAA")
    repo.adoptWebSession()
    assertEquals("mm_session=abc", sentCookies(server))
    assertFalse(store.cookieBlob!!.contains("mm_gate"))
  }

  @Test fun theWebViewIsWokenForTheRetiredCookieOnceNotOnEveryStart() = runBlocking {
    cookies.web["mm_gate"] = "beta-password"
    server.answer("""{"version":"0.21.0"}""")
    server.session(null)
    repo.bootstrap()
    assertEquals(1, cookies.webExpiries)
    assertFalse(cookies.web.containsKey("mm_gate"))
    assertTrue(store.webViewGateExpired)

    // Every later start: the jar's side still runs, and the WebView is left
    // alone — waking it cost the main thread on every cold start before Home.
    val here = "${server.origin()}/".toHttpUrl()
    jar.saveFromResponse(here, listOf(Cookie.parse(here, "mm_gate=beta-password; Path=/")!!))
    server.answer("""{"version":"0.21.0"}""")
    server.session(null)
    repo.bootstrap()
    assertEquals("a later start does not open the WebView's store", 1, cookies.webExpiries)
    assertTrue(jar.loadForRequest(here).none { it.name == "mm_gate" })
  }

  @Test fun aWebViewThatRefusedIsAskedAgainOnTheNextStart() = runBlocking {
    cookies.web["mm_gate"] = "beta-password"
    cookies.webRefuses = true // missing, or mid-update
    server.answer("""{"version":"0.21.0"}""")
    server.session(null)
    repo.bootstrap()
    assertFalse("nothing was done, so nothing is recorded", store.webViewGateExpired)

    cookies.webRefuses = false
    server.answer("""{"version":"0.21.0"}""")
    server.session(null)
    repo.bootstrap()
    assertEquals(2, cookies.webExpiries)
    assertFalse(cookies.web.containsKey("mm_gate"))
    assertTrue(store.webViewGateExpired)
  }

  @Test fun anOwnerWhoFixesASchemelessServerIsStillSignedIn() = runBlocking {
    // An older build saved "localhost:<port>" with no scheme while its owner
    // was signed in; the session blob is from before, with no host in it.
    store.originState.value = "localhost:${server.port}"
    store.cookieBlob = "mm_session=abc"
    assertTrue(repo.bootstrap() is Loaded.Unreachable)
    assertEquals("the start left the session on disk", "mm_session=abc", store.cookieBlob)

    assertEquals(OriginCheck.Ok(server.origin()), repo.setOrigin(server.origin()))
    server.session("0xAAA")
    repo.refreshIdentity()
    assertEquals("mm_session=abc", sentCookies(server))
    assertEquals("0xAAA", repo.signedIn.value)
  }

  @Test fun aStartAgainstAnAddressThatIsNotOneIsAnAnswerNotACrash() = runBlocking {
    store.originState.value = "app.merrymen.dev" // stored by an older build
    val r = repo.bootstrap()
    assertTrue(r is Loaded.Unreachable)
    assertFalse(repo.identityKnown.value)
  }

  // ── the Server field ─────────────────────────────────────────────────────

  @Test fun aRefusedAddressSavesNothingAndEndsNoTurn() = runBlocking {
    signedInAsA()
    var forgets = 0
    repo.addForgetHook { forgets++ }
    val r = repo.setOrigin("app.merrymen.dev")
    assertTrue(r is OriginCheck.Refused)
    assertTrue((r as OriginCheck.Refused).why.contains("https://"))
    assertEquals(server.origin(), store.originNow())
    assertEquals(0, forgets)
    assertEquals("0xAAA", repo.signedIn.value)
  }

  @Test fun anotherServerEndsTheTurnAndGetsNoCookie() = runBlocking {
    signedInAsA()
    var forgets = 0
    repo.addForgetHook { forgets++ }
    val other = MockWebServer().apply { start() }
    try {
      assertEquals(OriginCheck.Ok(other.asEmulatorHost()), repo.setOrigin(other.asEmulatorHost()))
      assertEquals(1, forgets)
      assertNull(repo.signedIn.value)
      assertFalse("the new server has not been asked yet", repo.identityKnown.value)
      assertNull("nor said whether it is hosted", repo.hosted.value)

      // The first request to the new host: the old host's session stays home.
      other.session(null, hosted = false)
      repo.refreshIdentity()
      assertNull("no credential crosses to another host", sentCookies(other))
      assertEquals(false, repo.hosted.value)
      assertFalse("self-hosted offers no sign-in", repo.canOfferSignIn.value)

      // And back: the old host still gets its own cookie, and the wallet.
      repo.setOrigin(server.origin())
      server.session("0xAAA")
      repo.refreshIdentity()
      assertEquals("mm_session=abc", sentCookies(server))
      assertEquals("0xAAA", repo.signedIn.value)
    } finally {
      other.shutdown()
    }
  }

  @Test fun theSameServerTypedAgainIsNotATurnEnd() = runBlocking {
    signedInAsA()
    var forgets = 0
    repo.addForgetHook { forgets++ }
    repo.setOrigin(server.origin() + "/")
    repo.setOrigin("  HTTP://LOCALHOST:${server.port}  ")
    assertEquals(0, forgets)
    assertEquals("0xAAA", repo.signedIn.value)
    assertTrue(repo.identityKnown.value)
  }

  @Test fun anAnswerThatLeftBeforeTheServerChangedIsDropped() = runBlocking {
    signedInAsA()
    val other = MockWebServer().apply { start() }
    try {
      // The old server's answer is slow; the owner changes server meanwhile.
      server.enqueue(
        MockResponse().setHeader("content-type", "application/json")
          .setBody("""{"hosted":true,"address":"0xAAA"}""").setHeadersDelay(700, TimeUnit.MILLISECONDS),
      )
      val slow = launch(Dispatchers.IO) { repo.refreshIdentity() }
      server.takeRequest(5, TimeUnit.SECONDS)
      repo.setOrigin(other.asEmulatorHost())
      slow.join()
      // Folding it in would show 0xAAA signed in against a server that never
      // said so.
      assertNull(repo.signedIn.value)
      assertFalse(repo.identityKnown.value)
    } finally {
      other.shutdown()
    }
  }
}
