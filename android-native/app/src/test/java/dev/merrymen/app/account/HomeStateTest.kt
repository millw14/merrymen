package dev.merrymen.app.account

import dev.merrymen.app.data.Loaded
import dev.merrymen.app.data.Repository
import dev.merrymen.app.data.toLoaded
import dev.merrymen.app.net.ApiResult
import dev.merrymen.app.net.Feed
import dev.merrymen.app.net.Fixtures
import dev.merrymen.app.net.Http
import dev.merrymen.app.net.MemoryCookies
import dev.merrymen.app.net.MemoryStore
import dev.merrymen.app.net.MerrymenApi
import dev.merrymen.app.net.PersistentCookieJar
import dev.merrymen.app.net.answer
import dev.merrymen.app.net.apiFor
import dev.merrymen.app.net.origin
import dev.merrymen.app.ui.BlockerFix
import dev.merrymen.app.ui.OwnBook
import dev.merrymen.app.ui.Routes
import dev.merrymen.app.ui.ownAgentName
import dev.merrymen.app.ui.ownBookOf
import dev.merrymen.app.ui.screens.OwnReads
import dev.merrymen.app.ui.screens.fixRoute
import dev.merrymen.app.ui.screens.readSettingsFor
import dev.merrymen.app.ui.screens.readTelegramFor
import dev.merrymen.app.ui.sessionNeedsAsking
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/**
 * M08 AND M17: HOME AND YOU NEVER PRESENT SOMEBODY ELSE'S — OR NOBODY'S — BOOK
 * AS THE READER'S.
 *
 * Driven over the real client and the captured signed-out production answer,
 * so the fact the screens are built on is the one the server actually sends:
 * source "none", the house fallback name, and a steady basket.
 */
class HomeStateTest {
  private lateinit var server: MockWebServer
  private lateinit var api: MerrymenApi

  @Before fun start() {
    server = MockWebServer()
    server.start()
    // No transport retry, so a dropped connection is one failure the test can count.
    api = apiFor(server, OkHttpClient.Builder().retryOnConnectionFailure(false).build())
  }

  @After fun stop() = server.shutdown()

  private fun signedOutFeed(): Loaded<Feed> = runBlocking {
    server.answer(Fixtures.text("probe-feed-signedout.json"))
    api.feed().toLoaded()
  }

  @Test fun theCapturedSignedOutFeedIsNeverTheReadersBook() {
    val feed = signedOutFeed()
    // The capture is what the fix is about: a 200, with a name, a strategy and
    // a basket — everything a screen needs to draw it as an account.
    val v = (feed as Loaded.Value).value
    assertEquals("none", v.source)
    assertEquals("Robin", v.agent?.name)
    assertEquals("fallback", v.agent?.nameSource)

    // Hosted and signed out: the sign-in hero, with the offer.
    assertEquals(OwnBook.SignedOut(canSignIn = true), ownBookOf(feed, signedIn = null, hosted = true, canOfferSignIn = true))
    // Hosted, signed out, but the session route has not said so yet: the hero
    // without an offer — nothing claimed either way.
    assertEquals(OwnBook.SignedOut(canSignIn = false), ownBookOf(feed, signedIn = null, hosted = null, canOfferSignIn = false))
    // Signed in and still "none": the ledger failed us. Unreadable, not empty.
    assertEquals(OwnBook.Unreadable, ownBookOf(feed, signedIn = "0xAbC0000000000000000000000000000000000001", hosted = true, canOfferSignIn = false))
    // Self-hosted has no sign-in, so "none" can only be the ledger.
    assertEquals(OwnBook.Unreadable, ownBookOf(feed, signedIn = null, hosted = false, canOfferSignIn = false))

    for (signedIn in listOf(null, "0xabc")) for (hosted in listOf(true, false, null)) {
      val book = ownBookOf(feed, signedIn, hosted, hosted == true && signedIn == null)
      assertFalse("a 'none' feed read as a book for signedIn=$signedIn hosted=$hosted", book is OwnBook.Mine)
    }
  }

  @Test fun theFallbackNameIsNeverPresentedAsTheReadersAgent() {
    val agent = (signedOutFeed() as Loaded.Value).value.agent
    assertNull(ownAgentName(agent))
    assertEquals("Shogun", ownAgentName(agent?.copy(name = "Shogun", nameSource = "settings")))
    assertEquals("Robin", ownAgentName(agent?.copy(nameSource = "ledger")))
    // An older server that does not say where the name came from is not a vouch.
    assertNull(ownAgentName(agent?.copy(name = "Shogun", nameSource = null)))
  }

  @Test fun aReadableBookIsTheReaders() {
    val feed = Loaded.Value(Feed(source = "sqlite"))
    assertTrue(ownBookOf(feed, "0xabc", true, false) is OwnBook.Mine)
    assertTrue(ownBookOf(feed, null, false, false) is OwnBook.Mine)
  }

  @Test fun failuresAreFailuresNotBooks() {
    val refused = Loaded.Refused(401, "not signed in")
    assertEquals(OwnBook.Failed(refused), ownBookOf(refused, null, true, true))
    val gone = Loaded.Unreachable("timeout")
    assertEquals(OwnBook.Failed(gone), ownBookOf(gone, "0xabc", true, false))
    assertEquals(OwnBook.Loading, ownBookOf(Loaded.Loading, "0xabc", true, false))
  }

  @Test fun aSelfHostedServerNeverOffersSignIn() = runBlocking {
    // M17, through the real Repository: the self-hosted session route's answer.
    server.answer("""{"hosted":false,"address":null}""")
    val store = MemoryStore(server.origin())
    val jar = PersistentCookieJar(store)
    val repo = Repository(MerrymenApi(Http.client(jar, debug = false), store), store, MemoryCookies(jar))
    repo.refreshIdentity()
    assertEquals(false, repo.hosted.value)
    assertFalse(repo.canOfferSignIn.value)
    // ...and its "none" feed reads as the ledger failing, never as a sign-in prompt.
    val none = Loaded.Value(Feed(source = "none"))
    assertEquals(OwnBook.Unreadable, ownBookOf(none, repo.signedIn.value, repo.hosted.value, repo.canOfferSignIn.value))
  }

  @Test fun theHostedSignedOutAnswerDoesOfferIt() = runBlocking {
    server.answer(Fixtures.text("probe-auth_session.json"))
    val store = MemoryStore(server.origin())
    val jar = PersistentCookieJar(store)
    val repo = Repository(MerrymenApi(Http.client(jar, debug = false), store), store, MemoryCookies(jar))
    repo.refreshIdentity()
    assertTrue(repo.canOfferSignIn.value)
  }

  @Test fun eachBlockerFixGoesWhereItCanBeDone() {
    // Money and signatures are web ceremonies; the Live switch is in Settings.
    assertEquals(Routes.web("/deposit", "Add funds"), fixRoute(BlockerFix.Deposit))
    assertEquals(Routes.web("/grant#resign", "Wallet & permissions"), fixRoute(BlockerFix.Resign))
    assertEquals(Routes.SETTINGS, fixRoute(BlockerFix.StartLive))
  }

  // ── the refresh loop's keep-or-replace rule ──────────────────────────────

  @Test fun aRefreshThatGetsNoAnswerKeepsTheBookAndSaysSo() = runBlocking {
    val reads = OwnReads()
    server.answer("""{"source":"sqlite","equity":[{"equity_usdg":120.5}]}""")
    server.answer("""{"exists":true,"mode":"live"}""")
    reads.load(api, "0xabc", true, withStrip = false, nowMs = { 1_000L })
    assertEquals(120.5, (reads.feed as Loaded.Value).value.equityNow!!, 1e-9)
    assertEquals("0xabc", reads.readFor)

    server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
    server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
    reads.load(api, "0xabc", true, withStrip = false, nowMs = { 2_000L })
    // The figures stay — with their age said — rather than flapping to an error.
    assertEquals(120.5, (reads.feed as Loaded.Value).value.equityNow!!, 1e-9)
    assertTrue(reads.feedFailure is ApiResult.Unreachable)
    // No answer — not an answer this app could not read.
    assertFalse((reads.feedFailure as ApiResult.Unreachable).unreadable)
    assertEquals(1_000L, reads.feedAtMs)
  }

  @Test fun aRefreshTheServerRefusesReplacesTheBook() = runBlocking {
    val reads = OwnReads()
    server.answer("""{"source":"sqlite","equity":[{"equity_usdg":120.5}]}""")
    server.answer("""{"exists":true}""")
    reads.load(api, "0xabc", true, withStrip = false, nowMs = { 1_000L })
    server.answer("""{"error":"not signed in"}""", code = 401)
    server.answer("""{"exists":false}""")
    reads.load(api, "0xabc", true, withStrip = false, nowMs = { 2_000L })
    // A session that ended does not keep a book on screen the server would no
    // longer send.
    val f = reads.feed
    if (f !is Loaded.Refused) fail("expected the 401 to replace the book, got $f")
    assertNull(reads.feedFailure)
  }

  // ── a session that ended while this app still held its address ───────────

  /**
   * THE HOSTED SERVER AS IT ANSWERS AN ENDED SESSION: never a 401. The feed is
   * the captured signed-out answer (source "none"), the grants {exists:false},
   * the settings the captured house defaults with owner "" — all 200s. Only the
   * session route says who is signed in, and [address] is what it says now.
   */
  private class EndedSessionServer(@Volatile var address: String?) : Dispatcher() {
    val sessionAsks = AtomicInteger()

    override fun dispatch(request: RecordedRequest): MockResponse = when (request.path?.substringBefore('?')) {
      "/api/auth/session" -> {
        sessionAsks.incrementAndGet()
        json("""{"hosted":true,"address":${address?.let { "\"$it\"" } ?: "null"}}""")
      }
      "/api/feed" -> json(Fixtures.text("probe-feed-signedout.json"))
      "/api/grants" -> json("""{"exists":false}""")
      "/api/settings" -> json(Fixtures.text("probe-settings-signedout.json"))
      // The house defaults' bridge: "no token" — nothing in it says nobody's.
      "/api/telegram" -> json("""{"enabled":false,"hasToken":false,"connected":false,"botUsername":null,"ownerId":null,"allowlist":[],"linkCode":null,"control":true}""")
      else -> MockResponse().setResponseCode(404)
    }

    private fun json(body: String) = MockResponse().setHeader("content-type", "application/json").setBody(body)
  }

  /** The real repository on [server], holding [OWNER] as the app's signed-in wallet. */
  private fun repoHoldingTheOwner(wire: EndedSessionServer): Repository = runBlocking {
    server.dispatcher = wire
    val store = MemoryStore(server.origin())
    val jar = PersistentCookieJar(store)
    val repo = Repository(MerrymenApi(Http.client(jar, debug = false), store), store, MemoryCookies(jar))
    repo.refreshIdentity()
    assertEquals(OWNER, repo.signedIn.value)
    repo
  }

  @Test fun anEndedSessionIsAskedAboutAndBecomesTheSignIn() = runBlocking {
    val wire = EndedSessionServer(OWNER)
    val repo = repoHoldingTheOwner(wire)
    // The session ends on the server; the app still holds the address.
    wire.address = null
    val reads = OwnReads()
    reads.load(repo.api, repo.signedIn.value, repo.hosted.value, withStrip = false, nowMs = { 1L }) { repo.refreshIdentity() }

    // The "nobody" feed was a question, asked once, before it was drawn...
    assertEquals(2, wire.sessionAsks.get())
    assertNull(repo.signedIn.value)
    assertTrue(repo.canOfferSignIn.value)
    // ...so what the screen draws is the sign-in, not "Couldn't read your book".
    assertEquals(
      OwnBook.SignedOut(canSignIn = true),
      ownBookOf(reads.feed, repo.signedIn.value, repo.hosted.value, repo.canOfferSignIn.value),
    )
  }

  @Test fun aSessionThatStillNamesTheWalletLeavesItAsTheLedgerFailing() = runBlocking {
    val wire = EndedSessionServer(OWNER)
    val repo = repoHoldingTheOwner(wire)
    val reads = OwnReads()
    reads.load(repo.api, repo.signedIn.value, repo.hosted.value, withStrip = false, nowMs = { 1L }) { repo.refreshIdentity() }
    // Asked, and the session is still the owner's: the ledger really failed.
    assertEquals(2, wire.sessionAsks.get())
    assertEquals(OWNER, repo.signedIn.value)
    assertEquals(OwnBook.Unreadable, ownBookOf(reads.feed, repo.signedIn.value, repo.hosted.value, repo.canOfferSignIn.value))
  }

  @Test fun aSettingsReadForNobodyAsksTheSameQuestion() = runBlocking {
    val wire = EndedSessionServer(OWNER)
    val repo = repoHoldingTheOwner(wire)
    wire.address = null
    val read = readSettingsFor(repo.api, repo.signedIn.value, repo.hosted.value) { repo.refreshIdentity() }
    assertEquals("", (read as Loaded.Value).value.env.owner)
    // Settings re-keys on signedIn, and its notice now carries the Sign in.
    assertNull(repo.signedIn.value)
    assertTrue(repo.canOfferSignIn.value)
  }

  @Test fun theBotIsReadOnlyAfterTheSessionIsConfirmed() = runBlocking {
    val wire = EndedSessionServer(OWNER)
    val repo = repoHoldingTheOwner(wire)
    wire.address = null
    readTelegramFor(repo.api, repo.signedIn.value, repo.hosted.value) { repo.refreshIdentity() }
    // The bridge's answer cannot say "nobody", so the question comes first:
    // the screen now draws its sign-in notice, not "not set up".
    assertEquals(2, wire.sessionAsks.get())
    assertNull(repo.signedIn.value)
    assertTrue(repo.canOfferSignIn.value)
    // Signed out already, nothing is asked on the bot's account.
    readTelegramFor(repo.api, repo.signedIn.value, repo.hosted.value) { repo.refreshIdentity() }
    assertEquals(2, wire.sessionAsks.get())
  }

  @Test fun onlyAnAddressHeldOnAServerWithSessionsIsAReasonToAsk() {
    val none = ApiResult.Ok(Feed(source = "none"))
    assertTrue(sessionNeedsAsking(none, answeredForNobody = true, signedIn = OWNER, hosted = true))
    // An older server that does not say whether it is hosted still has sessions to end.
    assertTrue(sessionNeedsAsking(none, answeredForNobody = true, signedIn = OWNER, hosted = null))
    // Nobody held: already the sign-in. Self-hosted: no session to have ended.
    assertFalse(sessionNeedsAsking(none, answeredForNobody = true, signedIn = null, hosted = true))
    assertFalse(sessionNeedsAsking(none, answeredForNobody = true, signedIn = OWNER, hosted = false))
    // A book, a failure to reach, or a server error are not about who is signed in.
    assertFalse(sessionNeedsAsking(ApiResult.Ok(Feed(source = "sqlite")), answeredForNobody = false, signedIn = OWNER, hosted = true))
    assertFalse(sessionNeedsAsking(ApiResult.Unreachable("timeout"), answeredForNobody = false, signedIn = OWNER, hosted = true))
    assertFalse(sessionNeedsAsking(ApiResult.Refused(503, "down"), answeredForNobody = false, signedIn = OWNER, hosted = true))
    assertTrue(sessionNeedsAsking(ApiResult.Refused(401, "sign in"), answeredForNobody = false, signedIn = OWNER, hosted = true))
  }

  private companion object {
    const val OWNER = "0xabc0000000000000000000000000000000000001"
  }
}
