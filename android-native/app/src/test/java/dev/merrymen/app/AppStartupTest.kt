package dev.merrymen.app

import dev.merrymen.app.data.Loaded
import dev.merrymen.app.net.CookieStores
import dev.merrymen.app.net.Http
import dev.merrymen.app.net.MemoryCookies
import dev.merrymen.app.net.MemoryStore
import dev.merrymen.app.net.PersistentCookieJar
import dev.merrymen.app.net.origin
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class AppStartupTest {
  private fun json(body: String) = MockResponse().setHeader("content-type", "application/json").setBody(body)

  @Test fun publicScreensWaitForCookieMigrationButNotNetwork() = runBlocking {
    val server = MockWebServer().apply { start() }
    val network = CountDownLatch(1)
    val scope = newAppScope(Dispatchers.Default)
    val migrated = CompletableDeferred<Unit>()
    val releaseMigration = CompletableDeferred<Unit>()
    try {
      server.dispatcher = object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse {
          network.await(5, TimeUnit.SECONDS)
          return if (request.path == "/api/version") json("""{"version":"test"}""")
          else json("""{"hosted":true,"address":null}""")
        }
      }
      val store = MemoryStore(server.origin()).apply {
        gatePassword = "retired"
        cookieBlob = "mm_gate=retired\nmm_session=kept"
      }
      val jar = PersistentCookieJar(store)
      val memory = MemoryCookies(jar)
      val cookies = object : CookieStores by memory {
        override suspend fun expireInWebView(origin: String, name: String): Boolean {
          migrated.complete(Unit)
          releaseMigration.await()
          return memory.expireInWebView(origin, name)
        }
      }
      val app = AppGraph(Http.client(jar, debug = false), store, cookies, scope)
      val ready = async { app.locallyReady() }
      withTimeout(2_000) { migrated.await() }
      assertFalse("no public screen before legacy cookies have an origin", ready.isCompleted)
      assertEquals("no network before migration", 0, server.requestCount)
      releaseMigration.complete(Unit)
      withTimeout(2_000) { ready.await() }
      assertFalse("public browsing does not pretend the account is known", app.repo.identityKnown.value)
      val first = server.takeRequest(2, TimeUnit.SECONDS)!!
      val second = server.takeRequest(2, TimeUnit.SECONDS)!!
      assertEquals(setOf("/api/version", "/api/auth/session"), setOf(first.path, second.path))
      assertEquals("mm_session=kept", first.getHeader("Cookie"))
      assertEquals("mm_session=kept", second.getHeader("Cookie"))
      network.countDown()
      assertEquals(Loaded.Value(Unit), app.started())
    } finally {
      releaseMigration.complete(Unit)
      network.countDown()
      scope.cancel()
      server.shutdown()
    }
  }

  @Test fun aSlowVersionDoesNotDelayIdentityOrRepeatStartup() = runBlocking {
    val server = MockWebServer().apply { start() }
    val version = CountDownLatch(1)
    val scope = newAppScope(Dispatchers.Default)
    try {
      server.dispatcher = object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse = when (request.path) {
          "/api/version" -> { version.await(5, TimeUnit.SECONDS); json("""{"version":"test"}""") }
          else -> json("""{"hosted":true,"address":"0xAAA"}""")
        }
      }
      val store = MemoryStore(server.origin())
      val jar = PersistentCookieJar(store)
      val app = AppGraph(Http.client(jar, debug = false), store, MemoryCookies(jar), scope)
      withTimeout(2_000) { app.locallyReady(); app.repo.identityKnown.first { it } }
      assertEquals("0xAAA", app.repo.signedIn.value)
      app.locallyReady() // A recreated Activity joins the same local preparation.
      version.countDown()
      assertEquals(Loaded.Value(Unit), app.started())
      assertEquals(2, server.requestCount)
    } finally {
      version.countDown()
      scope.cancel()
      server.shutdown()
    }
  }

  @Test fun foregroundRetryJoinsTheStartupIdentityRead() = runBlocking {
    val server = MockWebServer().apply { start() }
    val session = CountDownLatch(1)
    val arrived = CompletableDeferred<Unit>()
    val scope = newAppScope(Dispatchers.Default)
    try {
      server.dispatcher = object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse {
          if (request.path == "/api/version") return json("""{"version":"test"}""")
          arrived.complete(Unit)
          session.await(5, TimeUnit.SECONDS)
          return json("""{"hosted":true,"address":"0xAAA"}""")
        }
      }
      val store = MemoryStore(server.origin())
      val jar = PersistentCookieJar(store)
      val app = AppGraph(Http.client(jar, debug = false), store, MemoryCookies(jar), scope)
      app.locallyReady()
      withTimeout(2_000) { arrived.await() }
      val paths = setOf(server.takeRequest(2, TimeUnit.SECONDS)?.path, server.takeRequest(2, TimeUnit.SECONDS)?.path)
      assertEquals(setOf("/api/version", "/api/auth/session"), paths)
      val retry = async(start = CoroutineStart.UNDISPATCHED) { app.repo.refreshIdentity() }
      assertFalse(retry.isCompleted)
      assertEquals("one version and one in-flight session", 2, server.requestCount)
      session.countDown()
      withTimeout(2_000) { retry.await(); app.started() }
      assertEquals("retry used the confirmed answer", "0xAAA", app.repo.signedIn.value)
      assertEquals(2, server.requestCount)
    } finally {
      session.countDown()
      scope.cancel()
      server.shutdown()
    }
  }

  @Test fun aLateStartupSessionCannotUndoSignOut() = runBlocking {
    val server = MockWebServer().apply { start() }
    val session = CountDownLatch(1)
    val arrived = CompletableDeferred<Unit>()
    val scope = newAppScope(Dispatchers.Default)
    try {
      server.dispatcher = object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse = when (request.path) {
          "/api/auth/session" -> {
            arrived.complete(Unit)
            session.await(5, TimeUnit.SECONDS)
            json("""{"hosted":true,"address":"0xAAA"}""")
          }
          "/api/version" -> json("""{"version":"test"}""")
          else -> json("{}")
        }
      }
      val store = MemoryStore(server.origin())
      val jar = PersistentCookieJar(store)
      val app = AppGraph(Http.client(jar, debug = false), store, MemoryCookies(jar), scope)
      app.locallyReady()
      withTimeout(2_000) { arrived.await() }
      app.repo.signOut()
      session.countDown()
      app.started()
      assertNull(app.repo.signedIn.value)
      assertFalse("the pre-logout read cannot confirm this session", app.repo.identityKnown.value)
    } finally {
      session.countDown()
      scope.cancel()
      server.shutdown()
    }
  }

  @Test fun aNewServerDoesNotWaitForOrAcceptTheOldStartupSession() = runBlocking {
    val first = MockWebServer().apply { start() }
    val second = MockWebServer().apply { start() }
    val oldSession = CountDownLatch(1)
    val arrived = CompletableDeferred<Unit>()
    val scope = newAppScope(Dispatchers.Default)
    try {
      first.dispatcher = object : Dispatcher() {
        override fun dispatch(request: RecordedRequest): MockResponse {
          if (request.path == "/api/version") return json("""{"version":"test"}""")
          arrived.complete(Unit)
          oldSession.await(5, TimeUnit.SECONDS)
          return json("""{"hosted":true,"address":"0xAAA"}""")
        }
      }
      second.enqueue(json("""{"hosted":true,"address":"0xBBB"}"""))
      val store = MemoryStore(first.origin())
      val jar = PersistentCookieJar(store)
      val app = AppGraph(Http.client(jar, debug = false), store, MemoryCookies(jar), scope)
      app.locallyReady()
      withTimeout(2_000) { arrived.await() }
      app.repo.setOrigin(second.origin())
      withTimeout(2_000) { app.repo.refreshIdentity() }
      assertEquals("0xBBB", app.repo.signedIn.value)
      oldSession.countDown()
      app.started()
      assertEquals("old server cannot republish A", "0xBBB", app.repo.signedIn.value)
      assertEquals(second.origin(), app.repo.originNow())
    } finally {
      oldSession.countDown()
      scope.cancel()
      first.shutdown()
      second.shutdown()
    }
  }
}
