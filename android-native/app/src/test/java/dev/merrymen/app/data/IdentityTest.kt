package dev.merrymen.app.data

import dev.merrymen.app.net.ApiResult
import dev.merrymen.app.net.Fixtures
import dev.merrymen.app.net.SessionView
import dev.merrymen.app.net.answer
import dev.merrymen.app.net.apiFor
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * WHO THE APP ACTS FOR, and the one moment each wallet's state must go.
 */
class IdentityTest {
  private fun ok(hosted: Boolean?, address: String?) = ApiResult.Ok(SessionView(hosted, address))

  /** Records every forget, with the address that was still published when it ran. */
  private class Spy(private val id: Identity) : ForgetHook {
    val seen = mutableListOf<String?>()
    override suspend fun forget() {
      seen += id.signedIn.value
    }
  }

  // ── when a sign-in offer is true ─────────────────────────────────────────

  @Test fun theProductionSessionOffersSignIn() = runBlocking {
    // The live hosted answer, signed out, through the real client.
    val server = MockWebServer().apply { start() }
    try {
      server.answer(Fixtures.text("probe-auth_session.json"))
      val id = Identity()
      id.answered(apiFor(server).session())
      assertEquals(true, id.hosted.value)
      assertTrue(id.identityKnown.value)
      assertTrue(id.canOfferSignIn.value)
    } finally {
      server.shutdown()
    }
  }

  @Test fun selfHostedNeverOffersSignIn() = runBlocking {
    val id = Identity()
    id.answered(ok(hosted = false, address = null))
    assertTrue(id.identityKnown.value)
    assertNull(id.signedIn.value)
    assertFalse("self-hosted has no sign-in to offer", id.canOfferSignIn.value)
  }

  @Test fun signedInIsNoOffer() = runBlocking {
    val id = Identity()
    id.answered(ok(true, "0xA"))
    assertFalse(id.canOfferSignIn.value)
  }

  @Test fun notYetAskedIsNoOffer() {
    val id = Identity()
    assertNull(id.hosted.value)
    assertFalse(id.identityKnown.value)
    assertFalse(id.canOfferSignIn.value)
  }

  @Test fun unreachableChangesNothingAnd401IsSignedOut() = runBlocking {
    val id = Identity()
    id.answered(ok(true, "0xA"))
    id.answered(ApiResult.Unreachable("timeout"))
    assertEquals("0xA", id.signedIn.value)
    id.answered(ApiResult.Refused(503, "the server had a problem (HTTP 503)"))
    assertEquals("not knowing is not signed out", "0xA", id.signedIn.value)
    id.answered(ApiResult.Refused(401, "not signed in"))
    assertNull(id.signedIn.value)
    assertEquals("a 401 says nothing about hosting", true, id.hosted.value)
    assertTrue(id.canOfferSignIn.value)
  }

  // ── when a wallet's state goes ───────────────────────────────────────────

  @Test fun aSwitchForgetsBeforeTheNewAddressIsPublished() = runBlocking {
    val id = Identity()
    val spy = Spy(id).also { id.addForgetHook(it) }
    id.answered(ok(true, "0xAAA"))
    id.answered(ok(true, "0xaaa")) // the same wallet, checksummed differently
    assertTrue("the first answer and a re-read are not switches", spy.seen.isEmpty())
    id.answered(ok(true, "0xBBB"))
    // One forget, and while it ran the OLD wallet was still the one published.
    assertEquals(listOf<String?>("0xaaa"), spy.seen)
    assertEquals("0xBBB", id.signedIn.value)
  }

  @Test fun aSwitchThroughSignedOutStillForgets() = runBlocking {
    // A's session expires, then B signs in: A -> null -> B. Measured against
    // the previous answer this is null -> B and would hand B A's state.
    val id = Identity()
    val spy = Spy(id).also { id.addForgetHook(it) }
    id.answered(ok(true, "0xAAA"))
    id.answered(ok(true, null))
    assertTrue(spy.seen.isEmpty())
    id.answered(ok(true, "0xAAA"))
    assertTrue("the same wallet coming back keeps its state", spy.seen.isEmpty())
    id.answered(ok(true, null))
    id.answered(ok(true, "0xBBB"))
    assertEquals(1, spy.seen.size)
  }

  @Test fun signOutForgetsAndTheNextWalletStartsClean() = runBlocking {
    val id = Identity()
    val spy = Spy(id).also { id.addForgetHook(it) }
    id.answered(ok(true, "0xAAA"))
    id.signedOut()
    assertEquals(1, spy.seen.size)
    assertNull(id.signedIn.value)
    // Nothing is held after a sign-out, so the next sign-in is not a switch.
    id.answered(ok(true, "0xBBB"))
    assertEquals(1, spy.seen.size)
  }

  @Test fun oneFailingHookDoesNotKeepTheOthersState() = runBlocking {
    val id = Identity()
    var second = false
    id.addForgetHook { error("could not delete the thread file") }
    id.addForgetHook { second = true }
    id.answered(ok(true, "0xAAA"))
    id.signedOut()
    assertTrue(second)
  }
}
