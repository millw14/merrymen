package dev.merrymen.app.account

import dev.merrymen.app.ui.screens.SignInFlash
import dev.merrymen.app.ui.screens.signInLanded
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * P14: WHEN THE SIGN-IN PAGE CLOSES ITSELF, and how long its "Signed in as"
 * stays news.
 */
class SignInReturnTest {
  @Test fun theSignInPageClosesOnANewSessionAndOnASwitch() {
    assertTrue("first sign-in", signInLanded(before = null, now = "0xabc"))
    assertTrue("a wallet switch in the WebView", signInLanded(before = "0xabc", now = "0xdef"))
    assertFalse("the same wallet, however it is cased", signInLanded(before = "0xABC", now = "0xabc"))
    assertFalse("still signed out", signInLanded(before = null, now = null))
    assertFalse("signed out since", signInLanded(before = "0xabc", now = null))
  }

  @Test fun signedInAsIsSaidOnceAndOnlyWhileItIsNews() {
    SignInFlash.signedIn("0xabc", nowMs = 1_000)
    assertEquals("0xabc", SignInFlash.take(nowMs = 5_000))
    assertNull("spent", SignInFlash.take(nowMs = 5_001))
    SignInFlash.signedIn("0xdef", nowMs = 1_000)
    assertNull("a return nobody saw is not announced a minute later", SignInFlash.take(nowMs = 61_000))
  }
}
