package dev.merrymen.app.act

import dev.merrymen.app.AppGraph
import dev.merrymen.app.data.Repository
import dev.merrymen.app.net.Fixtures
import dev.merrymen.app.net.Http
import dev.merrymen.app.net.MemoryCookies
import dev.merrymen.app.net.MemoryStore
import dev.merrymen.app.net.PersistentCookieJar
import dev.merrymen.app.net.answer
import dev.merrymen.app.net.origin
import dev.merrymen.app.ui.screens.TradeClosed
import dev.merrymen.app.ui.screens.tradeClosedOf
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockWebServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Before
import org.junit.Test

/**
 * THE TRADE SCREEN SAYS "SIGN IN" BEFORE ANYTHING IS TYPED.
 *
 * The emulator pass, signed out: the whole form, chips and all, and only after
 * a symbol, an amount and a Buy tap "Sign in to trade — …" with no Sign in
 * button. Read here off the real Repository, as the screen reads it, after the
 * session route answered each way.
 */
class TradeClosedTest {
  private lateinit var server: MockWebServer
  private lateinit var repo: Repository

  @Before fun start() {
    server = MockWebServer()
    server.start()
    val store = MemoryStore(server.origin())
    val jar = PersistentCookieJar(store)
    repo = AppGraph(Http.client(jar, debug = false), store, MemoryCookies(jar)).repo
  }

  @After fun stop() = server.shutdown()

  private fun closed(r: Repository = repo) = tradeClosedOf(r.hosted.value, r.identityKnown.value, r.signedIn.value, r.canOfferSignIn.value)

  @Test fun signedOutOnTheHostedServiceItSaysSignInWithTheButton() = runBlocking {
    // The captured signed-out answer: hosted, nobody.
    server.answer(Fixtures.text("probe-auth_session.json"))
    repo.refreshIdentity()

    assertEquals(
      TradeClosed(
        title = "Sign in to trade",
        body = "An order is placed for the wallet that confirms it, so there is nothing to place until you sign in.",
        signIn = true,
      ),
      closed(),
    )
  }

  @Test fun beforeTheSessionAnswersItClaimsNothing() {
    assertEquals(TradeClosed(title = null, body = "Checking who's signed in…", signIn = false), closed())
  }

  @Test fun anUnansweredSessionIsStillNotSignedOut() = runBlocking {
    // No answer is not "signed out": the notice must not tell a signed-in owner to sign in.
    val gone = MockWebServer().apply { start() }
    val store = MemoryStore(gone.origin())
    gone.shutdown()
    val jar = PersistentCookieJar(store)
    val offline = AppGraph(Http.client(jar, debug = false), store, MemoryCookies(jar)).repo
    offline.refreshIdentity()
    assertEquals(TradeClosed(title = null, body = "Checking who's signed in…", signIn = false), closed(offline))
  }

  @Test fun aSignedInOwnerGetsTheForm() = runBlocking {
    server.answer("""{"hosted":true,"address":"0x00000000000000000000000000000000000000aa"}""")
    repo.refreshIdentity()
    assertNull(closed())
  }

  @Test fun aSelfHostedServerWhereNobodySignsInGetsTheForm() = runBlocking {
    server.answer("""{"hosted":false,"address":null}""")
    repo.refreshIdentity()
    assertNull(closed())
  }
}
