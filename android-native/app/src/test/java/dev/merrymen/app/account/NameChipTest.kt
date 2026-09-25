package dev.merrymen.app.account

import dev.merrymen.app.net.AgentGlance
import dev.merrymen.app.net.Feed
import dev.merrymen.app.net.Fixtures
import dev.merrymen.app.net.answer
import dev.merrymen.app.net.apiFor
import dev.merrymen.app.net.valueOrNull
import dev.merrymen.app.ui.NameSave
import dev.merrymen.app.ui.offersNameChip
import dev.merrymen.app.ui.saveOwnAgentName
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.SocketPolicy
import org.junit.Assert.assertEquals
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * P11: "NAME YOUR AGENT" IS OFFERED ONLY FOR THE HOUSE NAME THAT WAS READ AS THE NAME.
 *
 * The fallback is the dangerous case: the feed answers "Robin" when it could
 * not read the name at all, so an agent its owner called "Shogun" would be
 * offered a rename, and one tap would overwrite it.
 */
class NameChipTest {
  private fun agent(name: String?, source: String?) = AgentGlance(name = name, nameSource = source, slug = "q4sxmmxay96ew2vq")

  @Test fun theCapturedFallbackRobinIsNeverOffered() = runBlocking {
    val server = MockWebServer()
    server.start()
    try {
      server.answer(Fixtures.text("probe-feed-signedout.json"))
      val feed: Feed = apiFor(server).feed().valueOrNull()!!
      assertFalse(offersNameChip(feed.agent, keptHere = false))
    } finally {
      server.shutdown()
    }
  }

  @Test fun aRobinReadFromTheLedgerOrSettingsIsOffered() {
    assertTrue(offersNameChip(agent("Robin", "ledger"), keptHere = false))
    assertTrue(offersNameChip(agent("Robin", "settings"), keptHere = false))
  }

  // ── saving the name ─────────────────────────────────────────────────────

  private fun <T> withServer(block: suspend (MockWebServer, dev.merrymen.app.net.MerrymenApi) -> T): T = runBlocking {
    val server = MockWebServer()
    server.start()
    try {
      // The shared client's setting: it resends a write whose answer was cut
      // off. The name must be sent once anyway.
      block(server, apiFor(server, okhttp3.OkHttpClient.Builder().retryOnConnectionFailure(true).build()))
    } finally {
      server.shutdown()
    }
  }

  @Test fun theNameIsSavedForTheWalletThePageWasReadFor() = withServer { server, api ->
    server.answer("""{"ok":true,"appliesWithin":"one worker tick"}""")
    assertEquals(NameSave.Named("Little John"), api.saveOwnAgentName("  Little John ", "0xabc", hosted = true))
    val body = Json.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
    assertEquals("Little John", body["agentName"]!!.jsonPrimitive.content)
    assertEquals("0xabc", body["owner"]!!.jsonPrimitive.content)
  }

  @Test fun hostedWithoutKnowingWhoseNothingIsSent() = withServer { server, api ->
    assertTrue(api.saveOwnAgentName("Shogun", null, hosted = true) is NameSave.Said)
    assertTrue(api.saveOwnAgentName("Shogun", null, hosted = null) is NameSave.Said)
    assertEquals(0, server.requestCount)
  }

  @Test fun selfHostedSendsNoOwner() = withServer { server, api ->
    server.answer("""{"ok":true}""")
    assertEquals(NameSave.Named("Shogun"), api.saveOwnAgentName("Shogun", null, hosted = false))
    assertFalse(Json.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject.containsKey("owner"))
  }

  @Test fun theRoutesRuleIsShownVerbatimAndAnIgnoredNameIsNotNamed() = withServer { server, api ->
    server.answer("""{"errors":["name: 1-24 characters, starting with a letter"]}""", code = 400)
    assertEquals(NameSave.Said("name: 1-24 characters, starting with a letter"), api.saveOwnAgentName("007", "0xabc", hosted = true))
    server.answer("""{"ok":true,"ignored":["agentName"]}""")
    assertEquals(NameSave.Said("This server didn't take the name, so nothing changed."), api.saveOwnAgentName("Shogun", "0xabc", hosted = true))
  }

  @Test fun aLostAnswerIsLookedUpInTheFeed() = withServer { server, api ->
    server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
    server.answer("""{"source":"sqlite","agent":{"name":"Shogun","nameSource":"settings"}}""")
    assertEquals(NameSave.Named("Shogun"), api.saveOwnAgentName("Shogun", "0xabc", hosted = true))
    server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
    server.answer("""{"source":"sqlite","agent":{"name":"Robin","nameSource":"ledger"}}""")
    assertTrue(api.saveOwnAgentName("Shogun", "0xabc", hosted = true) is NameSave.Said)
    // Two saves and two look-ups: nothing was sent a second time.
    assertEquals(4, server.requestCount)
  }

  @Test fun anythingElseIsNot() {
    assertFalse("fallback", offersNameChip(agent("Robin", "fallback"), keptHere = false))
    assertFalse("unsaid source", offersNameChip(agent("Robin", null), keptHere = false))
    assertFalse("a chosen name", offersNameChip(agent("Shogun", "settings"), keptHere = false))
    assertFalse("kept on this device", offersNameChip(agent("Robin", "ledger"), keptHere = true))
    assertFalse("no agent", offersNameChip(null, keptHere = false))
  }
}
