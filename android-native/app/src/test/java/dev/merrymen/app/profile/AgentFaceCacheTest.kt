package dev.merrymen.app.profile

import dev.merrymen.app.net.MerrymenApi
import dev.merrymen.app.net.agentImage
import dev.merrymen.app.net.apiFor
import dev.merrymen.app.ui.AgentFaces
import dev.merrymen.app.ui.FaceCache
import dev.merrymen.app.ui.FaceKey
import dev.merrymen.app.ui.FaceKind
import dev.merrymen.app.ui.FaceLoader
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * THE PICTURE CACHE, over the real client and a MockWebServer standing in for
 * /api/agent-image. The "bitmap" is the body as a String, so the rules — ETag
 * revalidation, the 304 path, the remembered 404, the bound, and never one
 * agent's face for another — run without Android.
 */
class AgentFaceCacheTest {
  private lateinit var server: MockWebServer
  private lateinit var api: MerrymenApi
  private var clock = 1_000_000L
  private val seen = CopyOnWriteArrayList<RecordedRequest>()

  /** slug -> (etag, body); absent is a 404, as the route answers for no upload. */
  private val pictures = mutableMapOf("a1b2c3d4e5f6g7h8" to ("\"e1\"" to "FACE-A"))

  @Before fun start() {
    server = MockWebServer()
    server.dispatcher = object : Dispatcher() {
      override fun dispatch(request: RecordedRequest): MockResponse {
        seen.add(request)
        val slug = request.requestUrl!!.pathSegments[2]
        val (etag, body) = pictures[slug] ?: return MockResponse().setResponseCode(404).setBody("""{"error":"not found"}""")
        if (request.getHeader("If-None-Match") == etag) return MockResponse().setResponseCode(304).setHeader("ETag", etag)
        return MockResponse().setHeader("Content-Type", "image/webp").setHeader("ETag", etag).setBody(Buffer().writeUtf8(body))
      }
    }
    server.start()
    api = apiFor(server)
  }

  @After fun stop() = server.shutdown()

  private val cache = FaceCache<String>(maxEntries = 50, maxWeight = 1_000, weigh = { it.length }, now = { clock })
  private val loader = FaceLoader(cache) { _, bytes -> String(bytes) }

  private fun key(slug: String, version: String? = null) = FaceKey(server.url("/").toString(), slug, FaceKind.AVATAR, version)

  private fun load(slug: String, version: String? = null): String? = runBlocking {
    val k = key(slug, version)
    loader.load(k) { etag -> api.agentImage(slug, "avatar", etag, version) }
  }

  @Test fun anUnchangedPictureCostsA304AndTheSameBytes() {
    val first = load("a1b2c3d4e5f6g7h8")
    assertEquals("FACE-A", first)
    assertNull("the first ask has nothing to revalidate", seen[0].getHeader("If-None-Match"))

    // Inside the route's own minute of freshness: nobody is asked.
    clock += 30_000
    assertSame(first, load("a1b2c3d4e5f6g7h8"))
    assertEquals(1, seen.size)

    // Past it: revalidated with ITS OWN ETag, and the 304 reuses the held bytes.
    clock += 61_000
    assertSame(first, load("a1b2c3d4e5f6g7h8"))
    assertEquals(2, seen.size)
    assertEquals("\"e1\"", seen[1].getHeader("If-None-Match"))
  }

  @Test fun aNewPictureReplacesTheOldOneOnRevalidation() {
    load("a1b2c3d4e5f6g7h8")
    pictures["a1b2c3d4e5f6g7h8"] = "\"e2\"" to "FACE-A2"
    clock += 61_000
    assertEquals("FACE-A2", load("a1b2c3d4e5f6g7h8"))
  }

  @Test fun noUploadIsRememberedForTenMinutesThenAskedAgain() {
    assertNull(load("zzzzzzzzzzzzzzzz"))
    clock += 9 * 60_000
    assertNull(load("zzzzzzzzzzzzzzzz"))
    assertEquals("a 404 is not re-asked on every scroll", 1, seen.size)
    clock += 2 * 60_000
    assertNull(load("zzzzzzzzzzzzzzzz"))
    assertEquals(2, seen.size)
  }

  @Test fun oneAgentsFaceIsNeverAnothers() {
    assertEquals("FACE-A", load("a1b2c3d4e5f6g7h8"))
    // Another agent with no upload: its own 404, not agent A's picture, and
    // its request carries no ETag of A's.
    assertNull(load("b1b2c3d4e5f6g7h8"))
    assertNull(seen.last().getHeader("If-None-Match"))
    // The same slug on another server is another picture.
    val elsewhere = FaceKey("https://staging.merrymen.dev", "a1b2c3d4e5f6g7h8", FaceKind.AVATAR, null)
    assertNull(cache.peek(elsewhere.id))
    // And an upload's version is its own entry, asked for by that version.
    assertEquals("FACE-A", load("a1b2c3d4e5f6g7h8", version = "v2"))
    assertEquals("v2", seen.last().requestUrl!!.queryParameter("v"))
  }

  @Test fun aFailedReadIsNotRememberedAsNoPicture() {
    server.dispatcher = object : Dispatcher() {
      override fun dispatch(request: RecordedRequest): MockResponse {
        seen.add(request)
        return MockResponse().setResponseCode(502).setBody("<html>bad gateway</html>")
      }
    }
    assertNull(load("a1b2c3d4e5f6g7h8"))
    assertNull(load("a1b2c3d4e5f6g7h8"))
    assertEquals("an outage says nothing about the agent, so it is asked again", 2, seen.size)
  }

  @Test fun anErrorPageIsNotAPicture() {
    server.dispatcher = object : Dispatcher() {
      override fun dispatch(request: RecordedRequest): MockResponse =
        MockResponse().setHeader("Content-Type", "text/html").setBody("<html>proxy</html>")
    }
    assertNull(load("a1b2c3d4e5f6g7h8"))
  }

  @Test fun theCacheIsBoundedByEntriesAndByWeight() {
    val small = FaceCache<String>(maxEntries = 3, maxWeight = 100, weigh = { it.length }, now = { clock })
    for (i in 0 until 10) small.putImage("k$i", null, "x")
    assertEquals(3, small.size)
    // The least recently used went first.
    assertNull(small.peek("k0"))
    assertEquals("x", small.peek("k9"))

    val heavy = FaceCache<String>(maxEntries = 100, maxWeight = 10, weigh = { it.length }, now = { clock })
    heavy.putImage("a", null, "12345")
    heavy.putImage("b", null, "12345")
    heavy.peek("a")
    heavy.putImage("c", null, "12345")
    assertTrue(heavy.weight <= 10)
    assertNull("b was least recently used", heavy.peek("b"))
    assertEquals("12345", heavy.peek("a"))
    // Misses are bounded too: a feed of faceless agents cannot grow it forever.
    for (i in 0 until 1_000) heavy.putMissing("m$i")
    assertTrue(heavy.size <= 100)
  }

  @Test fun tenRowsOfOneAgentAskOnce() = runBlocking {
    server.dispatcher = object : Dispatcher() {
      override fun dispatch(request: RecordedRequest): MockResponse {
        seen.add(request)
        return MockResponse().setHeader("Content-Type", "image/webp").setHeader("ETag", "\"e1\"")
          .setBody("FACE-A").setHeadersDelay(200, TimeUnit.MILLISECONDS)
      }
    }
    val k = key("a1b2c3d4e5f6g7h8")
    val all = (0 until 10).map { async { loader.load(k) { etag -> api.agentImage("a1b2c3d4e5f6g7h8", "avatar", etag, null) } } }.awaitAll()
    assertTrue(all.all { it == "FACE-A" })
    assertEquals(1, seen.size)
  }

  /**
   * A fast scroll takes the row that asked first out of the list mid-request.
   * The row still waiting on the same picture must not be handed that row's
   * nothing — it asks for itself, and gets the agent's face.
   */
  @Test fun aRowThatScrolledAwayMidAskLeavesTheOthersToAsk() = runBlocking {
    val k = key("a1b2c3d4e5f6g7h8")
    val asks = AtomicInteger(0)
    val firstAsk = CompletableDeferred<Unit>()
    val leader = launch {
      loader.load(k) {
        asks.incrementAndGet()
        firstAsk.complete(Unit)
        awaitCancellation() // the network, until the row is gone
      }
    }
    firstAsk.await()
    val waiter = async { loader.load(k) { etag -> asks.incrementAndGet(); api.agentImage("a1b2c3d4e5f6g7h8", "avatar", etag, null) } }
    yield() // the waiter is now waiting on the first row's turn
    leader.cancelAndJoin()
    assertEquals("the row still on screen shows the agent's own face", "FACE-A", waiter.await())
    assertEquals("the first ask died with its row, so the waiter asked", 2, asks.get())
    assertEquals("FACE-A", cache.peek(k.id))
  }

  @Test fun anUploadIsAskedForByItsVersionAndARemovalIsNeverAskedAbout() = runBlocking {
    val slug = "p1b2c3d4e5f6g7h8"
    val before = AgentFaces.revision.value
    AgentFaces.publish(slug, FaceKind.AVATAR, "v7")
    // Every face on screen is told, so the one just uploaded shows now.
    assertTrue(AgentFaces.revision.value > before)
    assertNull(AgentFaces.load(api, slug, FaceKind.AVATAR))
    assertEquals("/api/agent-image/$slug/avatar?v=v7", seen.single().path)
    val removed = AgentFaces.revision.value
    AgentFaces.publish(slug, FaceKind.AVATAR, null)
    assertTrue(AgentFaces.revision.value > removed)
    assertNull(AgentFaces.load(api, slug, FaceKind.AVATAR))
    assertNull(AgentFaces.peek(slug, FaceKind.AVATAR))
    assertEquals("a removed picture is not asked for", 1, seen.size)
    // The banner is its own picture: removing the face does not remove it.
    assertNull(AgentFaces.load(api, slug, FaceKind.BANNER))
    assertEquals("/api/agent-image/$slug/banner", seen.last().path)
  }

  @Test fun aSlugOfAnyOtherShapeIsNeverAskedAbout() = runBlocking {
    assertNull(AgentFaces.load(api, "../../api/feed", FaceKind.AVATAR))
    assertNull(AgentFaces.load(api, null, FaceKind.AVATAR))
    assertEquals(0, seen.size)
  }
}
