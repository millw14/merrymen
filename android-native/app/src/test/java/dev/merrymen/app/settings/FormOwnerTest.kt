package dev.merrymen.app.settings

import dev.merrymen.app.chat.ChatRig.Companion.json
import dev.merrymen.app.chat.Seen
import dev.merrymen.app.data.FormOwner
import dev.merrymen.app.data.Repository
import dev.merrymen.app.data.formOwnerOf
import dev.merrymen.app.net.ApiResult
import dev.merrymen.app.net.Http
import dev.merrymen.app.net.MemoryCookies
import dev.merrymen.app.net.MemoryStore
import dev.merrymen.app.net.MerrymenApi
import dev.merrymen.app.net.PersistentCookieJar
import dev.merrymen.app.net.SERVER_CHANGED_SENTENCE
import dev.merrymen.app.net.ServerBound
import dev.merrymen.app.net.origin
import dev.merrymen.app.net.settingsRead
import dev.merrymen.app.ui.SettingsDraft
import dev.merrymen.app.ui.SettingsSaveOutcome
import dev.merrymen.app.ui.saveSettingsDraft
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

/**
 * A FORM BELONGS TO ONE SERVER AS WELL AS ONE WALLET.
 *
 * Settings kept its draft keyed on the signed-in wallet alone. Between two
 * self-hosted servers that is null on both sides, so a Server change kept the
 * old server's unsaved edits — Live trading ticked, the public book half
 * consented to — over the new server's values, and Save applied them there.
 * The screen now keys every piece of unsaved state on [FormOwner] and binds
 * its save to the form's server; these hold the rule it keys on, through the
 * real Repository against two MockWebServers.
 */
class FormOwnerTest {
  private class SelfHosted : AutoCloseable {
    val server = MockWebServer()
    val seen = CopyOnWriteArrayList<Seen>()

    init {
      server.dispatcher = object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse {
          val s = Seen(request.method.orEmpty(), request.path.orEmpty(), request.body.readUtf8())
          seen += s
          return when ("${s.method} ${s.path.substringBefore("?")}") {
            "GET /api/auth/session" -> json("""{"hosted":false,"address":null}""")
            "GET /api/settings" -> json("""{"values":{"liveTradingEnabled":false},"defaults":{"liveTradingEnabled":false}}""")
            "PUT /api/settings" -> json("""{"ok":true}""")
            else -> json("""{"error":"no route in this test"}""", 404)
          }
        }
      }
      server.start()
    }

    fun writes() = seen.filter { it.method != "GET" }

    override fun close() = server.shutdown()
  }

  private val a = SelfHosted()
  private val b = SelfHosted()
  private val store = MemoryStore(a.server.origin())
  private val jar = PersistentCookieJar(store)
  private val api = MerrymenApi(Http.client(jar, debug = false), store)
  private val repo = Repository(api, store, MemoryCookies(jar))

  @After fun stop() {
    a.close()
    b.close()
  }

  private fun formNow(): FormOwner = formOwnerOf(repo.serverTurn.value, repo.signedIn.value)

  @Test fun anotherServerIsAnotherFormWithNobodySignedInOnEitherSide() = runBlocking {
    repo.refreshIdentity()
    assertNull(repo.signedIn.value)
    assertEquals(false, repo.hosted.value)
    val onA = formNow()

    repo.setOrigin(b.server.origin())
    repo.refreshIdentity()
    assertNull("still nobody signed in — the key signedIn alone never moved", repo.signedIn.value)
    assertEquals(false, repo.hosted.value)
    assertNotEquals("A's draft does not carry over to B", onA, formNow())

    // The same server, typed differently, is the same form: nothing is thrown away.
    val onB = formNow()
    repo.setOrigin(b.server.origin() + "/")
    assertEquals(onB, formNow())
  }

  @Test fun theFormMovesOnceWhenTheNewServerCanBeRead() = runBlocking {
    repo.refreshIdentity()
    val onA = formNow()
    var whileMoving: FormOwner? = null
    // A hook runs in the middle of the change, before the new address is stored.
    repo.addForgetHook { whileMoving = formOwnerOf(repo.serverTurn.value, null) }
    repo.setOrigin(b.server.origin())
    assertEquals("not a form of its own while the change is under way", onA, whileMoving)
    assertNotEquals(onA, formNow())
  }

  @Test fun aDraftMadeOnTheOldServerIsNotSavedOnTheNewOne() = runBlocking {
    repo.refreshIdentity()
    val form = formNow()
    val env = (api.settingsRead() as ApiResult.Ok).value.env
    val draft = SettingsDraft().setBool("liveTradingEnabled", true)

    repo.setOrigin(b.server.origin())
    repo.refreshIdentity()
    // Save, bound to the server the form was read from, as SettingsScreen binds it.
    val save = withContext(ServerBound(form.serverTurn)) { api.saveSettingsDraft(draft, env, repo.signedIn.value) }

    assertEquals(SettingsSaveOutcome.Failed("Nothing was saved. $SERVER_CHANGED_SENTENCE"), save.outcome)
    assertTrue("B's settings were not touched", b.writes().isEmpty())
    assertTrue("nor A's", a.writes().isEmpty())
  }
}
