package dev.merrymen.app.account

import dev.merrymen.app.data.Repository
import dev.merrymen.app.net.Fixtures
import dev.merrymen.app.net.Http
import dev.merrymen.app.net.MemoryCookies
import dev.merrymen.app.net.MemoryStore
import dev.merrymen.app.net.MerrymenApi
import dev.merrymen.app.net.PersistentCookieJar
import dev.merrymen.app.net.answer
import dev.merrymen.app.net.origin
import dev.merrymen.app.ui.AccountControls
import dev.merrymen.app.ui.SignInPage
import dev.merrymen.app.ui.accountControlsOf
import dev.merrymen.app.ui.signInPageOf
import dev.merrymen.app.ui.stopArmedNote
import dev.merrymen.app.ui.stopAllAgents
import dev.merrymen.app.ui.welcomeOffersSignIn
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * M17: EVERY SIGN-IN OFFER, SIGN-OUT AND STOP ON D'S SCREENS IS TRUE WHERE IT
 * IS SHOWN.
 *
 * Each case starts from what a real server's session route answers, through
 * the real Repository, and asks the same functions the screens draw from:
 * You's banner, Stop and Sign out ([accountControlsOf]), the sign-in page
 * ([signInPageOf]) and the welcome page's doors ([welcomeOffersSignIn]). The
 * repository's own canOfferSignIn is A's and is tested there; this is what D
 * does with it.
 */
class AccountControlsTest {
  private lateinit var server: MockWebServer

  @Before fun start() {
    server = MockWebServer()
    server.start()
  }

  @After fun stop() = server.shutdown()

  /** The repository after the session route answered [body] (or did not answer, when null). */
  private fun repoAfter(body: String?): Repository = runBlocking {
    if (body == null) {
      // No answer, however many times the shared client tries.
      server.dispatcher = object : Dispatcher() {
        override fun dispatch(request: RecordedRequest) = MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST)
      }
    } else {
      server.answer(body)
    }
    val store = MemoryStore(server.origin())
    val jar = PersistentCookieJar(store)
    val repo = Repository(MerrymenApi(Http.client(jar, debug = false), store), store, MemoryCookies(jar))
    repo.refreshIdentity()
    repo
  }

  private fun controls(repo: Repository): AccountControls =
    accountControlsOf(repo.signedIn.value, repo.hosted.value, repo.canOfferSignIn.value)

  @Test fun hostedAndSignedOutOffersSignInAndNothingElse() {
    val repo = repoAfter(Fixtures.text("probe-auth_session.json"))
    assertEquals(AccountControls(signInBanner = true, stop = false, signOut = false), controls(repo))
    assertEquals(SignInPage.Open, signInPageOf(originRead = true, hosted = repo.hosted.value, asked = true))
    assertTrue(welcomeOffersSignIn(repo.hosted.value))
  }

  @Test fun hostedAndSignedInOffersStopAndSignOutButNoSignIn() {
    val repo = repoAfter("""{"hosted":true,"address":"0xabc0000000000000000000000000000000000001"}""")
    assertEquals(AccountControls(signInBanner = false, stop = true, signOut = true), controls(repo))
  }

  @Test fun selfHostedHasNoSignInAnywhereButKeepsItsStop() {
    // The self-hosted session route's own answer: no sign-in exists, and the
    // one operator's DELETE /api/grants needs no session.
    val repo = repoAfter("""{"hosted":false,"address":null}""")
    assertEquals(AccountControls(signInBanner = false, stop = true, signOut = false), controls(repo))
    assertEquals(SignInPage.NoSignIn, signInPageOf(originRead = true, hosted = repo.hosted.value, asked = true))
    assertFalse(welcomeOffersSignIn(repo.hosted.value))
  }

  @Test fun theArmedStopWarnsOfDeletedMemoryOnlyWhereTheStopDeletesIt() {
    // Hosted, removing the grant deletes the agent's memory, and re-signing
    // does not bring it back. The self-hosted worker only halts.
    val hosted = repoAfter("""{"hosted":true,"address":"0xabc0000000000000000000000000000000000001"}""")
    assertTrue(stopArmedNote(hosted.signedIn.value).contains("deletes agent memory, which re-signing does not bring back"))
    val selfHosted = repoAfter("""{"hosted":false,"address":null}""")
    assertFalse(stopArmedNote(selfHosted.signedIn.value).contains("memory"))
  }

  @Test fun stopNamesEveryWalletAndDoesNotPromiseAnOnChainRevocation() {
    for (owner in listOf("0x1111111111111111111111111111111111111111", null)) {
      val note = stopArmedNote(owner)
      assertTrue(note.contains("Spot, Perps and Solana"))
      assertTrue(note.contains("does not close positions"))
      assertTrue(note.contains("withdraw assets"))
    }
    assertTrue(stopArmedNote("0x1111111111111111111111111111111111111111").contains("revoke permissions on-chain"))
  }

  @Test fun aLostLoginWideStopReplyCannotBeConfirmedByAnAbsentSpotGrant() = runBlocking {
    val store = MemoryStore(server.origin())
    val api = MerrymenApi(Http.client(PersistentCookieJar(store), debug = false), store)
    server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
    server.answer("""{"exists":false}""") // The old UI read only Spot and falsely said stopped.
    val note = stopAllAgents(api, "0x1111111111111111111111111111111111111111") { true }
    assertTrue(note.contains("Could not confirm whether all agents stopped"))
    assertFalse(note.contains("Stop request accepted"))
    assertEquals(1, server.requestCount) // No retry and no misleading Spot-only reconciliation.
    val request = server.takeRequest()
    assertEquals("DELETE", request.method)
    assertEquals("/api/grants", request.path)
    assertTrue(request.body.readUtf8().contains("\"expectedTenant\":\"0x1111111111111111111111111111111111111111\""))
  }

  @Test fun aReadableResponseMustActuallyConfirmTheStop() = runBlocking {
    val store = MemoryStore(server.origin())
    val api = MerrymenApi(Http.client(PersistentCookieJar(store), debug = false), store)
    server.answer("""{"exists":false}""")
    val note = stopAllAgents(api, "0x1111111111111111111111111111111111111111") { true }
    assertTrue(note.contains("could not be confirmed")); assertFalse(note.contains("Stop request accepted"))
    assertEquals(1, server.requestCount)
  }

  @Test fun aChangedLoginCannotSendOrDisplayThePreviousStop() = runBlocking {
    val store = MemoryStore(server.origin())
    val api = MerrymenApi(Http.client(PersistentCookieJar(store), debug = false), store)
    assertTrue(stopAllAgents(api, "0x1111111111111111111111111111111111111111") { false }.contains("changed"))
    assertEquals(0, server.requestCount)
    server.answer("""{"ok":true}""")
    var checks = 0
    val note = stopAllAgents(api, "0x1111111111111111111111111111111111111111") { ++checks == 1 }
    assertTrue(note.contains("changed")); assertFalse(note.contains("Stop request accepted"))
    assertEquals(1, server.requestCount)
  }

  @Test fun aStopReviewCannotReviveWhenSessionReadsReturnToTheSameOwner() = runBlocking {
    val owner = "0x1111111111111111111111111111111111111111"
    val ownerSession = """{"hosted":true,"address":"$owner"}"""
    for (intermediate in listOf("null", "\"0x2222222222222222222222222222222222222222\"")) {
      val repo = repoAfter(ownerSession)
      val reviewed = requireNotNull(repo.reviewStop(owner, repo.serverTurn.value, repo.confirmationVersion.value))
      server.answer(ownerSession); repo.refreshIdentity()
      assertTrue(repo.holdsStop(reviewed)) // An ordinary same-owner refresh keeps consent.
      server.answer("""{"hosted":true,"address":$intermediate}"""); repo.refreshIdentity()
      server.answer(ownerSession); repo.refreshIdentity()
      assertEquals(owner, repo.signedIn.value)
      assertFalse(repo.holdsStop(reviewed))
      val before = server.requestCount
      assertTrue(stopAllAgents(repo.api, reviewed.owner) { repo.holdsStop(reviewed) }.contains("changed"))
      assertEquals(before, server.requestCount) // No DELETE from the old confirmation.
    }
  }

  @Test fun aLateStopReplyCannotReviveAfterSignOutAndBackIntoTheSameOwner() = runBlocking {
    val owner = "0x1111111111111111111111111111111111111111"
    val repo = repoAfter("""{"hosted":true,"address":"$owner"}""")
    val reviewed = requireNotNull(repo.reviewStop(owner, repo.serverTurn.value, repo.confirmationVersion.value))
    val sent = CountDownLatch(1)
    val release = CountDownLatch(1)
    server.dispatcher = object : Dispatcher() {
      override fun dispatch(request: RecordedRequest): MockResponse {
        if (request.method == "DELETE") {
          sent.countDown()
          check(release.await(10, TimeUnit.SECONDS))
        }
        return MockResponse().setBody(if (request.path == "/api/auth/session") """{"hosted":true,"address":"$owner"}""" else """{"ok":true}""")
      }
    }
    val pending = async(Dispatchers.IO) { stopAllAgents(repo.api, reviewed.owner) { repo.holdsStop(reviewed) } }
    try {
      assertTrue(sent.await(5, TimeUnit.SECONDS))
      repo.signOut(); repo.refreshIdentity()
      assertEquals(owner, repo.signedIn.value)
      assertFalse(repo.holdsStop(reviewed))
    } finally { release.countDown() }
    val note = pending.await()
    assertTrue(note.contains("changed")); assertFalse(note.contains("Stop request accepted"))
    assertEquals(4, server.requestCount) // Session, one DELETE, logout, new session.
  }

  @Test fun aStopReviewCannotMoveBetweenServersForTheSameOwner() = runBlocking {
    val owner = "0x1111111111111111111111111111111111111111"
    val repo = repoAfter("""{"hosted":true,"address":"$owner"}""")
    val reviewed = requireNotNull(repo.reviewStop(owner, repo.serverTurn.value, repo.confirmationVersion.value))
    repo.api.servers.leave(); repo.api.servers.arrive()
    assertFalse(repo.holdsStop(reviewed))
    val before = server.requestCount
    assertTrue(stopAllAgents(repo.api, reviewed.owner) { repo.holdsStop(reviewed) }.contains("changed"))
    assertEquals(before, server.requestCount)
  }

  @Test fun aServerThatHasNotSaidOpensNothing() {
    val repo = repoAfter(null)
    assertEquals(null, repo.hosted.value)
    assertEquals(AccountControls(signInBanner = false, stop = false, signOut = false), controls(repo))
    // Asking, then "can't tell" with Try again — never the web sign-in.
    assertEquals(SignInPage.Asking, signInPageOf(originRead = true, hosted = null, asked = false))
    assertEquals(SignInPage.CannotTell, signInPageOf(originRead = true, hosted = null, asked = true))
    // The welcome doors stay while unknown, so the page draws before the network.
    assertTrue(welcomeOffersSignIn(null))
  }

  @Test fun theSignInPageWaitsForTheServerAddressFirst() {
    for (hosted in listOf(true, false, null)) {
      assertEquals(SignInPage.ReadingOrigin, signInPageOf(originRead = false, hosted = hosted, asked = true))
    }
  }
}
