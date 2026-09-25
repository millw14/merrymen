package dev.merrymen.app.feed

import dev.merrymen.app.net.ApiResult
import dev.merrymen.app.net.Fixtures
import dev.merrymen.app.net.MerrymenApi
import dev.merrymen.app.net.answer
import dev.merrymen.app.net.apiFor
import kotlinx.coroutines.runBlocking
import okhttp3.mockwebserver.MockWebServer

/**
 * A PRODUCTION CAPTURE, THROUGH THE REAL CLIENT: served by a MockWebServer and
 * decoded by the same MerrymenApi the app runs, so a test over it is a test
 * over what the phone would have made of that answer.
 */
fun <T> served(fixture: String, call: suspend (MerrymenApi) -> ApiResult<T>): T {
  val server = MockWebServer()
  server.start()
  try {
    server.answer(Fixtures.text(fixture))
    val r = runBlocking { call(apiFor(server)) }
    return (r as? ApiResult.Ok)?.value ?: error("$fixture did not decode: $r")
  } finally {
    server.shutdown()
  }
}
