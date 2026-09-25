package dev.merrymen.app.account

import dev.merrymen.app.net.AgentImageKind
import dev.merrymen.app.net.ImageWrite
import dev.merrymen.app.net.MerrymenApi
import dev.merrymen.app.net.agentImageProblem
import dev.merrymen.app.net.answer
import dev.merrymen.app.net.apiFor
import dev.merrymen.app.net.removeOwnAgentImage
import dev.merrymen.app.net.uploadOwnAgentImage
import kotlinx.coroutines.runBlocking
import okhttp3.OkHttpClient
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.SocketPolicy
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

/**
 * P11: A PICTURE GOES ONLY WHERE IT WAS MEANT TO, ONLY WHEN THE SERVER WOULD
 * TAKE IT, AND A LOST ANSWER IS SAID AS ONE.
 *
 * The route takes no owner in its path or body — the session cookie is the
 * owner — so the app asks the session route who is signed in immediately
 * before sending, and sends nothing when it is not the wallet the page was
 * read for. Every case runs the real client against a MockWebServer and looks
 * at what actually reached it.
 */
class AgentImageUploadTest {
  private lateinit var server: MockWebServer
  private lateinit var api: MerrymenApi
  private val owner = "0xAbC0000000000000000000000000000000000001"
  private val png = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 1, 2, 3)

  @Before fun start() {
    server = MockWebServer()
    server.start()
    api = apiFor(server)
  }

  @After fun stop() = server.shutdown()

  private fun session(address: String?) =
    server.answer("""{"hosted":true,"address":${address?.let { "\"$it\"" } ?: "null"}}""")

  @Test fun theBytesGoWithTheirLengthAndTypeWhenTheSessionIsStillTheOwners() = runBlocking {
    session(owner.lowercase())
    server.answer("""{"ok":true,"version":"a1b2c3d4e5f6"}""")
    val w = api.uploadOwnAgentImage(AgentImageKind.Avatar, png, "image/png", owner)
    assertEquals(ImageWrite.Done("a1b2c3d4e5f6"), w)
    assertEquals("/api/auth/session", server.takeRequest().path)
    val put = server.takeRequest()
    assertEquals("PUT", put.method)
    assertEquals("/api/agent-image/me/avatar", put.path)
    // A ByteArray body, so the route is told the length it checks before reading.
    assertEquals(png.size.toString(), put.getHeader("Content-Length"))
    assertTrue(put.getHeader("Content-Type")!!.startsWith("image/png"))
    assertArrayEquals(png, put.body.readByteArray())
  }

  @Test fun anotherWalletSignedInSinceMeansNothingIsSent() = runBlocking {
    session("0x9990000000000000000000000000000000000009")
    val w = api.uploadOwnAgentImage(AgentImageKind.Banner, png, "image/png", owner)
    assertTrue(w is ImageWrite.NotSent)
    assertTrue((w as ImageWrite.NotSent).why.contains("different wallet"))
    assertEquals(1, server.requestCount)
  }

  @Test fun aSessionThatCannotBeConfirmedIsNotAYes() = runBlocking {
    server.answer("{}", code = 503)
    val w = api.uploadOwnAgentImage(AgentImageKind.Avatar, png, "image/png", owner)
    assertTrue(w is ImageWrite.NotSent)
    assertTrue((w as ImageWrite.NotSent).why.startsWith("Couldn't confirm who is signed in"))
    session(null)
    assertTrue(api.uploadOwnAgentImage(AgentImageKind.Avatar, png, "image/png", owner) is ImageWrite.NotSent)
    // Two session asks, and not one upload.
    assertEquals(2, server.requestCount)
  }

  @Test fun aFileTheServerWouldRefuseNeverTouchesTheNetwork() = runBlocking {
    val gif = api.uploadOwnAgentImage(AgentImageKind.Avatar, png, "image/gif", owner)
    assertTrue(gif is ImageWrite.NotSent)
    val big = api.uploadOwnAgentImage(AgentImageKind.Avatar, ByteArray((5 * 1024 * 1024) + 1), "image/jpeg", owner)
    assertEquals(ImageWrite.NotSent("That picture is too large — the limit is 5 MB for a picture and 8 MB for a banner."), big)
    val empty = api.uploadOwnAgentImage(AgentImageKind.Banner, ByteArray(0), "image/webp", owner)
    assertTrue(empty is ImageWrite.NotSent)
    assertEquals(0, server.requestCount)
  }

  @Test fun theLimitsAreTheServers() {
    assertNull(agentImageProblem(AgentImageKind.Avatar, "image/png", 5L * 1024 * 1024))
    assertNotNull(agentImageProblem(AgentImageKind.Avatar, "image/png", 5L * 1024 * 1024 + 1))
    assertNull(agentImageProblem(AgentImageKind.Banner, "IMAGE/WEBP", 8L * 1024 * 1024))
    assertNotNull(agentImageProblem(AgentImageKind.Banner, "image/svg+xml", 10))
    assertNotNull(agentImageProblem(AgentImageKind.Banner, null, 10))
  }

  @Test fun refusalsAreSaidInWords() = runBlocking {
    session(owner)
    server.answer("""{"error":"that image is too large"}""", code = 413)
    assertEquals(
      ImageWrite.Refused("That picture is too large — the limit is 5 MB for a picture and 8 MB for a banner."),
      api.uploadOwnAgentImage(AgentImageKind.Avatar, png, "image/png", owner),
    )
    session(owner)
    server.answer("""{"error":"use a PNG, JPEG or WebP — SVGs and animations are not accepted"}""", code = 415)
    assertEquals(
      ImageWrite.Refused("Use a PNG, JPEG or WebP — SVGs and animations are not accepted."),
      api.uploadOwnAgentImage(AgentImageKind.Avatar, png, "image/png", owner),
    )
    session(owner)
    server.answer("""{"error":"not found"}""", code = 404)
    assertEquals(ImageWrite.Refused("Pictures are not available on this server."), api.uploadOwnAgentImage(AgentImageKind.Avatar, png, "image/png", owner))
    session(owner)
    server.answer("<html>oops</html>", code = 400, type = "text/html")
    assertEquals(ImageWrite.Refused("That file could not be read as an image."), api.uploadOwnAgentImage(AgentImageKind.Avatar, png, "image/png", owner))
  }

  @Test fun aLostAnswerIsUnknownAndIsNotSentAgain() = runBlocking {
    // The shared client's setting, which resends a write whose answer was cut off.
    val api = apiFor(server, OkHttpClient.Builder().retryOnConnectionFailure(true).build())
    session(owner)
    server.enqueue(MockResponse().setSocketPolicy(SocketPolicy.DISCONNECT_AFTER_REQUEST))
    val w = api.uploadOwnAgentImage(AgentImageKind.Banner, png, "image/png", owner)
    assertTrue(w is ImageWrite.Unknown)
    assertTrue((w as ImageWrite.Unknown).why.contains("Couldn't tell whether the banner was saved"))
    // The session ask and the one PUT — no retry behind the owner's back.
    assertEquals(2, server.requestCount)
  }

  @Test fun removalIsBehindTheSameSessionCheck() = runBlocking {
    session("0x9990000000000000000000000000000000000009")
    assertTrue(api.removeOwnAgentImage(AgentImageKind.Avatar, owner) is ImageWrite.NotSent)
    assertEquals(1, server.requestCount)
    session(owner)
    server.answer("""{"ok":true}""")
    assertEquals(ImageWrite.Done(null), api.removeOwnAgentImage(AgentImageKind.Avatar, owner))
    server.takeRequest()
    server.takeRequest()
    val del = server.takeRequest()
    assertEquals("DELETE", del.method)
    assertEquals("/api/agent-image/me/avatar", del.path)
  }
}
