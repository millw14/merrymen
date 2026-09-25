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
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
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
    reads.load(api, "0xabc", withStrip = false) { 1_000L }
    assertEquals(120.5, (reads.feed as Loaded.Value).value.equityNow!!, 1e-9)
    assertEquals("0xabc", reads.readFor)

    server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AT_START))
    server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AT_START))
    reads.load(api, "0xabc", withStrip = false) { 2_000L }
    // The figures stay — with their age said — rather than flapping to an error.
    assertEquals(120.5, (reads.feed as Loaded.Value).value.equityNow!!, 1e-9)
    assertTrue(reads.feedFailure is ApiResult.Unreachable)
    assertEquals(1_000L, reads.feedAtMs)
  }

  @Test fun aRefreshTheServerRefusesReplacesTheBook() = runBlocking {
    val reads = OwnReads()
    server.answer("""{"source":"sqlite","equity":[{"equity_usdg":120.5}]}""")
    server.answer("""{"exists":true}""")
    reads.load(api, "0xabc", withStrip = false) { 1_000L }
    server.answer("""{"error":"not signed in"}""", code = 401)
    server.answer("""{"exists":false}""")
    reads.load(api, "0xabc", withStrip = false) { 2_000L }
    // A session that ended does not keep a book on screen the server would no
    // longer send.
    val f = reads.feed
    if (f !is Loaded.Refused) fail("expected the 401 to replace the book, got $f")
    assertNull(reads.feedFailure)
  }
}
