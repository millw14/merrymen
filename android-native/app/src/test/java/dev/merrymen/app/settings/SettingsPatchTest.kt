package dev.merrymen.app.settings

import dev.merrymen.app.net.ApiResult
import dev.merrymen.app.net.Fixtures
import dev.merrymen.app.net.MerrymenApi
import dev.merrymen.app.net.SettingsEnvelope
import dev.merrymen.app.net.answer
import dev.merrymen.app.net.apiFor
import dev.merrymen.app.net.providerKey
import dev.merrymen.app.net.putSettingsOnce
import dev.merrymen.app.net.secretStatus
import dev.merrymen.app.net.settingsRead
import dev.merrymen.app.net.valueOrNull
import dev.merrymen.app.ui.LIVE_OFF_UNIT
import dev.merrymen.app.ui.LIVE_ON_UNIT
import dev.merrymen.app.ui.LiveTradingNote
import dev.merrymen.app.ui.PUBLIC_BOOK_ON
import dev.merrymen.app.ui.SETTINGS_RANGES
import dev.merrymen.app.ui.SettingsDraft
import dev.merrymen.app.ui.SettingsSaveOutcome
import dev.merrymen.app.ui.SettingsShown
import dev.merrymen.app.ui.SettingsSubmission
import dev.merrymen.app.ui.liveTradingNote
import dev.merrymen.app.ui.outOfRange
import dev.merrymen.app.ui.saveSettingsDraft
import dev.merrymen.app.ui.settingsSaveOutcome
import dev.merrymen.app.ui.settleUnknownSave
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

/**
 * M06, M15 and P05: WHAT A SETTINGS SAVE MAY SEND, AND WHAT IT IS REPORTED AS.
 *
 * Every save below goes through the real client to a MockWebServer and the
 * test reads the body that arrived — so "only touched keys", "a JSON boolean",
 * "a JSON number" and "the owner the form was read for" are facts about the
 * request, not about a map in memory.
 */
class SettingsPatchTest {
  private lateinit var server: MockWebServer
  private lateinit var api: MerrymenApi
  private lateinit var signedOut: SettingsEnvelope

  @Before fun start() {
    server = MockWebServer()
    server.start()
    api = apiFor(server, OkHttpClient.Builder().retryOnConnectionFailure(false).build())
    signedOut = LENIENT.decodeFromString(SettingsEnvelope.serializer(), Fixtures.text("probe-settings-signedout.json"))
  }

  @After fun stop() = server.shutdown()

  /** A signed-in owner's envelope: the captured defaults, stored values on top, and an owner. */
  private fun env(owner: String? = OWNER, values: String = "{}"): SettingsEnvelope =
    signedOut.copy(owner = owner, values = Json.parseToJsonElement(values))

  /** Save [draft] for [e] the way the Settings screen does, and return the body that reached the server. */
  private fun sent(draft: SettingsDraft, e: SettingsEnvelope, answer: String = """{"ok":true,"appliesWithin":"one worker tick"}"""): JsonObject = runBlocking {
    server.answer(answer)
    val save = api.saveSettingsDraft(draft, e, signedInNow = e.owner?.takeIf { it.isNotEmpty() })
    if (save.sent == null) error("nothing was sent: $save")
    Json.parseToJsonElement(server.takeRequest().body.readUtf8()).jsonObject
  }

  // ── only what was touched ────────────────────────────────────────────────

  @Test fun anUntouchedFormSendsNothingAndCannotBeSaved() {
    val d = SettingsDraft()
    assertFalse(d.dirty)
    assertTrue(d.submission() is SettingsSubmission.Blocked)
  }

  @Test fun anUntouchedLiveSwitchIsAbsentFromThePut() {
    val body = sent(SettingsDraft().setText("assetMode", "stocks"), env())
    assertEquals(setOf("assetMode", "owner"), body.keys)
    assertFalse(body.containsKey("liveTradingEnabled"))
  }

  @Test fun aTouchedLiveSwitchSendsAJsonBoolean() {
    val body = sent(SettingsDraft().setBool("liveTradingEnabled", true), env())
    val v = body["liveTradingEnabled"]!!.jsonPrimitive
    assertFalse("a boolean, not the string \"true\"", v.isString)
    assertEquals(true, v.booleanOrNull)
  }

  // ── the owner travels with the form ──────────────────────────────────────

  @Test fun theOwnerTheFormWasReadForIsEchoed() {
    assertEquals(OWNER, sent(SettingsDraft().setBool("publicBook", false), env())["owner"]!!.jsonPrimitive.content)
  }

  @Test fun aFormReadSignedOutEchoesTheEmptyOwner() {
    // "" is a claim — nobody — which the route refuses for whichever wallet
    // signs in before the save goes out.
    val body = sent(SettingsDraft().setText("assetMode", "all"), env(owner = ""))
    assertEquals("", body["owner"]!!.jsonPrimitive.content)
    assertTrue(body["owner"]!!.jsonPrimitive.isString)
  }

  @Test fun selfHostedSendsNoOwnerAtAll() {
    assertFalse(sent(SettingsDraft().setText("assetMode", "all"), env(owner = null)).containsKey("owner"))
  }

  @Test fun theCapturedSignedOutReadCarriesTheEmptyOwner() = runBlocking {
    server.answer(Fixtures.text("probe-settings-signedout.json"))
    val read = api.settingsRead().valueOrNull()!!
    assertEquals("", read.env.owner)
    assertEquals(emptyList<String>(), read.env.officialCoins)
    // Keys are status only: the default provider is groq, and nothing is set.
    val (provider, key) = read.keys.providerKey(read.env)
    assertEquals("Groq", provider)
    assertEquals("not set", secretStatus(key))
  }

  // ── numbers ──────────────────────────────────────────────────────────────

  @Test fun numbersGoAsJsonNumbersNeverAsText() {
    val d = SettingsDraft()
      .setNumber("classPerEntryUsdg", "2.5")
      .setNumber("classMaxPositions", "12", integer = true)
      .setNumber("classMaxHoldSec", "3600", integer = true)
    val body = sent(d, env())
    assertFalse(body["classPerEntryUsdg"]!!.jsonPrimitive.isString)
    assertEquals(2.5, body["classPerEntryUsdg"]!!.jsonPrimitive.content.toDouble(), 0.0)
    assertEquals("12", body["classMaxPositions"]!!.jsonPrimitive.content)
    assertEquals("3600", body["classMaxHoldSec"]!!.jsonPrimitive.content)
  }

  @Test fun aNumberThisFormCannotReadBlocksTheSaveAndSaysWhich() {
    // "25,5" is two numbers in two locales; the route would read the string
    // with its own rules. It is not sent as typed, and it is not dropped.
    val d = SettingsDraft().setText("assetMode", "crypto").setNumber("classPerEntryUsdg", "25,5")
    val blocked = d.submission() as SettingsSubmission.Blocked
    assertEquals(listOf("class per entry: not a number this form can read — use digits, and a point for decimals"), blocked.why)
    assertTrue(d.dirty)
    assertNotNull(SettingsDraft().setNumber("classMaxPositions", "2.5", integer = true).unreadable["classMaxPositions"])
    // Fixing it lets the save go.
    assertTrue(d.setNumber("classPerEntryUsdg", "25.5").submission() is SettingsSubmission.Ready)
    // A box emptied on the way to a new figure is untouched, not "clear to default".
    assertFalse(SettingsDraft().setNumber("classPerEntryUsdg", "  ").edits.containsKey("classPerEntryUsdg"))
  }

  @Test fun theClassRangesAreTheServers() {
    assertEquals(0.0..1_000_000.0, SETTINGS_RANGES["classPerEntryUsdg"])
    assertEquals(0.0..1_000.0, SETTINGS_RANGES["classMaxPositions"])
    assertEquals(60.0..2_592_000.0, SETTINGS_RANGES["classMaxHoldSec"])
    assertEquals(0.0..10_000_000.0, SETTINGS_RANGES["classMinDepthUsdg"])
    assertEquals("Must be between 60 and 2,592,000.", outOfRange("classMaxHoldSec", 30.0))
    assertNull(outOfRange("classMaxHoldSec", 21_600.0))
    assertNull("an unread value is not judged", outOfRange("classMaxHoldSec", null))
  }

  // ── consent ──────────────────────────────────────────────────────────────

  @Test fun publishingTheBookNeedsTheSecondStep() {
    val asked = SettingsDraft().askPublicBook()
    assertTrue(asked.publicBookAsked)
    assertFalse("asking sends nothing", asked.edits.containsKey("publicBook"))
    assertFalse("and alone cannot be saved", asked.dirty)
    assertFalse(asked.cancelPublicBook().edits.containsKey("publicBook"))
    val confirmed = asked.confirmPublicBook()
    assertEquals(true, sent(confirmed, env())["publicBook"]!!.jsonPrimitive.booleanOrNull)
    // Taking the book out of public view needs no confirmation.
    assertEquals(false, sent(SettingsDraft().publicBookOff(), env())["publicBook"]!!.jsonPrimitive.booleanOrNull)
    assertTrue(PUBLIC_BOOK_ON.contains("trade sizes and dollar P&L"))
  }

  @Test fun theLiveSwitchCarriesTheWebsSentencesTheMomentItDiffersFromWhatIsSaved() {
    val savedOff = env(values = """{"liveTradingEnabled":false}""")
    assertNull(liveTradingNote(SettingsShown(savedOff, SettingsDraft())))
    val on = SettingsShown(savedOff, SettingsDraft().setBool("liveTradingEnabled", true))
    assertEquals(LiveTradingNote.SpendsRealMoney, liveTradingNote(on))
    assertEquals("This spends real money.", LiveTradingNote.SpendsRealMoney.lead)
    assertTrue(on.bool("liveTradingEnabled"))

    val savedOn = env(values = """{"liveTradingEnabled":true}""")
    assertEquals(
      LiveTradingNote.LeavesRealPositions,
      liveTradingNote(SettingsShown(savedOn, SettingsDraft().setBool("liveTradingEnabled", false))),
    )
    // Read from the DEFAULTS when nothing is stored: off, and saying so.
    assertFalse(SettingsShown(env(), SettingsDraft()).bool("liveTradingEnabled"))
    assertEquals("ON — real orders, real money, within your signed caps", LIVE_ON_UNIT)
    assertEquals("OFF — Paper mode: practising with simulated money at live prices", LIVE_OFF_UNIT)
  }

  @Test fun theDefaultOnPlatformCoinsReadAsOn() {
    // officialCoinsEnabled defaults ON; nothing stored must not draw it unticked.
    assertTrue(SettingsShown(env(), SettingsDraft()).bool("officialCoinsEnabled"))
  }

  // ── what a save came to ──────────────────────────────────────────────────

  @Test fun ignoredKeysAreSurfacedAsNotSaved() = runBlocking {
    server.answer("""{"ok":true,"appliesWithin":"one worker tick","ignored":["publicBook"]}""")
    val o = settingsSaveOutcome(api.putSettingsOnce(JsonObject(mapOf("publicBook" to JsonPrimitive(true))), OWNER))
    assertEquals(SettingsSaveOutcome.Saved("one worker tick", listOf("publicBook")), o)
  }

  @Test fun aCleanSaveSaysWhenItApplies() = runBlocking {
    server.answer("""{"ok":true,"appliesWithin":"one worker tick"}""")
    assertEquals(SettingsSaveOutcome.Saved("one worker tick", emptyList()), settingsSaveOutcome(api.putSettingsOnce(JsonObject(mapOf("assetMode" to JsonPrimitive("all"))), OWNER)))
  }

  @Test fun aChangedOwnerIsRefusedAndSaidSo() = runBlocking {
    server.answer("""{"errors":["this browser is signed in with a different wallet now than the one that confirmed this, so nothing was changed. Sign back in with that wallet and ask again."]}""", code = 409)
    assertEquals(SettingsSaveOutcome.OwnerChanged, settingsSaveOutcome(api.putSettingsOnce(JsonObject(mapOf("assetMode" to JsonPrimitive("all"))), OWNER)))
  }

  @Test fun theServersRefusalsAreOneLineEach() = runBlocking {
    server.answer("""{"errors":["classMaxHoldSec: must be a number between 60 and 2592000","name: 1-24 characters"]}""", code = 400)
    val o = settingsSaveOutcome(api.putSettingsOnce(JsonObject(mapOf("classMaxHoldSec" to JsonPrimitive(5))), OWNER))
    assertEquals(SettingsSaveOutcome.Rejected(listOf("classMaxHoldSec: must be a number between 60 and 2592000", "name: 1-24 characters")), o)
  }

  @Test fun anOkThatDoesNotSayOkIsNotSaved() {
    assertTrue(settingsSaveOutcome(ApiResult.Ok(dev.merrymen.app.net.SettingsSaved(ok = null))) is SettingsSaveOutcome.Unknown)
  }

  @Test fun aLostAnswerIsUnknownAndIsLookedUpNotResent() = runBlocking {
    val patch = JsonObject(mapOf("assetMode" to JsonPrimitive("crypto"), "classMaxPositions" to JsonPrimitive(12L)))
    // THE SHARED CLIENT'S OWN SETTING — it retries on a connection failure,
    // and resends a write whose answer was cut off on a reused connection. The
    // form has always read the settings first, so the save rides that
    // connection, as it does on the phone.
    val retrying = apiFor(server, OkHttpClient.Builder().retryOnConnectionFailure(true).build())
    server.answer(Fixtures.text("probe-settings-signedout.json"))
    retrying.settingsRead()
    server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
    val o = settingsSaveOutcome(retrying.putSettingsOnce(patch, OWNER))
    if (o !is SettingsSaveOutcome.Unknown) fail("a lost answer read as $o")
    assertEquals("the read and one save — never a second save underneath", 2, server.requestCount)

    // The read-back: one key landed, one did not.
    val fresh = env(values = """{"assetMode":"crypto","classMaxPositions":3}""")
    val found = settleUnknownSave(patch, fresh, OWNER)
    assertEquals(listOf("assetMode"), found.saved)
    assertEquals(listOf("classMaxPositions"), found.notSaved)
    assertFalse(found.ownerChanged)
    // 12 and 12.0 are one value.
    assertEquals(listOf("classMaxPositions"), settleUnknownSave(patch, env(values = """{"classMaxPositions":12.0}"""), OWNER).saved)
    // Another wallet's read-back concludes nothing.
    assertTrue(settleUnknownSave(patch, env(owner = "0x9990000000000000000000000000000000000009"), OWNER).ownerChanged)
    // The draft keeps only what did not save.
    val kept = SettingsDraft().setText("assetMode", "crypto").setNumber("classMaxPositions", "12", integer = true).without(found.saved)
    assertEquals(setOf("classMaxPositions"), kept.edits.keys)
  }

  @Test fun aSessionTheAppKnowsIsAnotherWalletsSendsNothing() = runBlocking {
    val save = api.saveSettingsDraft(SettingsDraft().setBool("liveTradingEnabled", true), env(), signedInNow = "0x9990000000000000000000000000000000000009")
    assertEquals(SettingsSaveOutcome.OwnerChanged, save.outcome)
    assertNull(save.sent)
    assertEquals(0, server.requestCount)
    // The same wallet, cased differently, is the same wallet.
    server.answer("""{"ok":true}""")
    assertEquals(SettingsSaveOutcome.Saved(null, emptyList()), api.saveSettingsDraft(SettingsDraft().setText("assetMode", "all"), env(), OWNER.uppercase().replace("0X", "0x")).outcome)
  }

  @Test fun aBlockedDraftIsNotSent() = runBlocking {
    val save = api.saveSettingsDraft(SettingsDraft().setNumber("slippageBps", "1,5", integer = true), env(), OWNER)
    assertNull(save.outcome)
    assertTrue(save.blocked.single().startsWith("max slippage:"))
    assertEquals(0, server.requestCount)
  }

  private companion object {
    const val OWNER = "0xabc0000000000000000000000000000000000001"
    val LENIENT = Json { ignoreUnknownKeys = true }
  }
}
