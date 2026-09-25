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
import dev.merrymen.app.ui.welcomeOffersSignIn
import kotlinx.coroutines.runBlocking
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
