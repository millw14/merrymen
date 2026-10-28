package dev.merrymen.app.account

import dev.merrymen.app.data.Loaded
import dev.merrymen.app.net.MerrymenApi
import dev.merrymen.app.net.OriginSource
import dev.merrymen.app.net.origin
import dev.merrymen.app.ui.screens.OwnReads
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/** Real HTTP reads prove overlap, cancellation and owner boundaries without timing benchmarks. */
class HomeLoadingTest {
  private lateinit var server: MockWebServer
  private lateinit var api: MerrymenApi
  private val release = CountDownLatch(1)

  @Before fun start() {
    server = MockWebServer().apply { start() }
    // Match AppGraph: a cancelled connection can mark localhost's first route
    // unusable, so the next GET must recover on an alternate fresh connection.
    // The shared client itself still does not retry writes.
    api = MerrymenApi(
      OkHttpClient.Builder().retryOnConnectionFailure(false).build(),
      OriginSource { server.origin() },
      recoverReads = true,
    )
  }

  @After fun stop() {
    release.countDown()
    server.shutdown()
  }

  private fun json(body: String) = MockResponse().setHeader("content-type", "application/json").setBody(body)

  private suspend fun waitFor(condition: () -> Boolean) {
    withTimeout(5_000) { while (!condition()) delay(10) }
  }

  private suspend fun OwnReads.refresh(withStrip: Boolean = false, afterChange: Boolean = false, isCurrent: () -> Boolean = { true }) =
    load(api, "0xabc", true, withStrip, nowMs = { 1_000L }, afterChange = afterChange, isCurrent = isCurrent, askWhoIsSignedIn = {})

  @Test fun aSlowFeedDoesNotHoldBackTheAccountStatusOrStrip() = runBlocking {
    val stripArrived = AtomicInteger()
    server.dispatcher = object : Dispatcher() {
      override fun dispatch(request: RecordedRequest): MockResponse = when (request.path) {
        "/api/feed" -> {
          release.await(5, TimeUnit.SECONDS)
          json("""{"source":"sqlite","equity":[{"equity_usdg":120.5}]}""")
        }
        "/api/grants" -> json("""{"exists":true,"mode":"live","liveBlocker":"no-gas"}""")
        "/api/telegram", "/api/settings" -> {
          stripArrived.incrementAndGet()
          release.await(5, TimeUnit.SECONDS)
          json("{}")
        }
        else -> MockResponse().setResponseCode(404)
      }
    }
    val reads = OwnReads()
    val read = launch { reads.refresh(withStrip = true) }
    try {
      waitFor { stripArrived.get() == 2 }
      assertEquals("no-gas", (reads.grants as Loaded.Value).value.liveBlocker)
      assertEquals("feed is still out while both strip reads have left", Loaded.Loading, reads.feed)
      assertFalse(read.isCompleted)
    } finally {
      release.countDown()
    }
    read.join()
    assertEquals(120.5, (reads.feed as Loaded.Value).value.equityNow!!, 1e-9)
    assertEquals(4, server.requestCount)
    assertTrue(reads.telegram != null && reads.settings != null)
  }

  @Test fun aSlowAccountStatusDoesNotHideTheBook() = runBlocking {
    server.dispatcher = object : Dispatcher() {
      override fun dispatch(request: RecordedRequest): MockResponse = when (request.path) {
        "/api/feed" -> json("""{"source":"sqlite"}""")
        "/api/grants" -> {
          release.await(5, TimeUnit.SECONDS)
          json("""{"exists":true}""")
        }
        else -> MockResponse().setResponseCode(404)
      }
    }
    val reads = OwnReads()
    val read = launch { reads.refresh() }
    try {
      waitFor { reads.feed is Loaded.Value }
      assertEquals(Loaded.Loading, reads.grants)
      assertFalse(read.isCompleted)
    } finally {
      release.countDown()
    }
    read.join()
  }

  private fun holdBothReads() {
    server.dispatcher = object : Dispatcher() {
      override fun dispatch(request: RecordedRequest): MockResponse {
        release.await(5, TimeUnit.SECONDS)
        return when (request.path) {
          "/api/feed" -> json("""{"source":"sqlite"}""")
          "/api/grants" -> json("""{"exists":true}""")
          else -> MockResponse().setResponseCode(404)
        }
      }
    }
  }

  @Test fun aPullDuringTheForegroundPollJoinsItsRead() = runBlocking {
    holdBothReads()
    val reads = OwnReads()
    val poll = launch { reads.refresh() }
    waitFor { server.requestCount == 2 }
    // Undispatched reaches the held refresh gate before it returns to us.
    val pull = launch(start = CoroutineStart.UNDISPATCHED) { reads.refresh() }
    assertFalse(pull.isCompleted)
    release.countDown()
    poll.join()
    pull.join()
    assertEquals("one feed and one account read", 2, server.requestCount)
    assertTrue(reads.feed is Loaded.Value && reads.grants is Loaded.Value)
  }

  @Test fun aCompletedEditRequestsFreshEvidenceAfterTheExistingPoll() = runBlocking {
    val saved = AtomicBoolean(false)
    server.dispatcher = object : Dispatcher() {
      override fun dispatch(request: RecordedRequest): MockResponse {
        val name = if (saved.get()) "After" else "Before"
        release.await(5, TimeUnit.SECONDS)
        return when (request.path) {
          "/api/feed" -> json("""{"source":"sqlite","agent":{"name":"$name","nameSource":"settings"}}""")
          "/api/grants" -> json("""{"exists":true}""")
          else -> MockResponse().setResponseCode(404)
        }
      }
    }
    val reads = OwnReads()
    val poll = launch { reads.refresh() }
    waitFor { server.requestCount == 2 }
    saved.set(true)
    val afterEdit = launch(start = CoroutineStart.UNDISPATCHED) { reads.refresh(afterChange = true) }
    assertFalse(afterEdit.isCompleted)
    release.countDown()
    poll.join()
    afterEdit.join()
    assertEquals("a fresh feed and account read after the edit", 4, server.requestCount)
    assertEquals("After", (reads.feed as Loaded.Value).value.agent?.name)
  }

  @Test fun anOldWalletsLateAnswersCannotPopulateTheCurrentScreen() = runBlocking {
    holdBothReads()
    val current = AtomicBoolean(true)
    val reads = OwnReads()
    val read = launch { reads.refresh(withStrip = true, isCurrent = { current.get() }) }
    waitFor { server.requestCount == 2 }
    current.set(false)
    release.countDown()
    read.join()
    assertEquals(Loaded.Loading, reads.feed)
    assertEquals(Loaded.Loading, reads.grants)
    assertNull(reads.readFor)
    assertNull(reads.telegram)
    assertNull(reads.settings)
    assertEquals("no optional reads after the wallet changed", 2, server.requestCount)
  }

  @Test fun aServerChangeDropsTheAnswersAndStopsTheStripReads() = runBlocking {
    holdBothReads()
    val reads = OwnReads()
    val read = launch { reads.refresh(withStrip = true) }
    waitFor { server.requestCount == 2 }
    api.servers.leave()
    api.servers.arrive()
    release.countDown()
    read.join()
    assertEquals(Loaded.Loading, reads.feed)
    assertEquals(Loaded.Loading, reads.grants)
    assertEquals(2, server.requestCount)
  }

  @Test fun leavingTheScreenCancelsBothReadsAndAllowsANewRefresh() = runBlocking {
    holdBothReads()
    val reads = OwnReads()
    val abandoned = launch { reads.refresh() }
    waitFor { server.requestCount == 2 }
    abandoned.cancelAndJoin()
    waitFor { api.http.dispatcher.runningCallsCount() == 0 }
    release.countDown()
    reads.refresh()
    assertTrue("refresh must recover: feed=${reads.feed}, grants=${reads.grants}", reads.feed is Loaded.Value && reads.grants is Loaded.Value)
    assertEquals(4, server.requestCount)
  }
}
