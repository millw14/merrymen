package dev.merrymen.app.net

import java.io.IOException
import java.util.Locale
import kotlin.coroutines.resume
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.serialization.Serializable
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * THE OWNER'S OWN PICTURES — the one write on the You tab that is not a
 * settings field.
 *
 * An image cannot ride PUT /api/settings: that blob is sealed under the money
 * key and handed to every worker on every read, so the web uploads to its own
 * route and reports its own result (AgentImageField.tsx). This is that route,
 * PUT and DELETE /api/agent-image/me/{avatar|banner}, hosted only — a
 * self-hosted install answers 404.
 *
 * NO SLUG IN THE PATH, AND THAT IS THE AUTHORISATION: whose picture it is comes
 * from the session cookie. So "never the wrong owner" cannot be a field in the
 * body the way it is for a settings save; it is a question asked of the session
 * route immediately before the bytes go — see [uploadOwnAgentImage].
 */

/** avatar or banner — the two images the route takes, with the server's own byte limits (lib/agent-image.ts). */
enum class AgentImageKind(val wire: String, val maxBytes: Long, val noun: String) {
  Avatar("avatar", 5L * 1024 * 1024, "picture"),
  Banner("banner", 8L * 1024 * 1024, "banner"),
}

/** The three formats the server decodes, as the web's file input offers them. */
val AGENT_IMAGE_TYPES = setOf("image/png", "image/jpeg", "image/webp")

/**
 * WHY A PICKED FILE WILL NOT BE SENT, or null when it may be.
 *
 * Checked before a byte leaves the phone. The server refuses the same things
 * and stays the authority — it re-decodes everything — but a 7 MB upload that
 * was always going to be refused costs the owner their data to find out.
 */
fun agentImageProblem(kind: AgentImageKind, mime: String?, size: Long): String? = when {
  mime == null || mime.lowercase(Locale.ROOT) !in AGENT_IMAGE_TYPES ->
    "Use a PNG, JPEG or WebP — other files are not accepted."
  size <= 0 -> "That file is empty."
  size > kind.maxBytes ->
    "That ${kind.noun} is too large — the limit is 5 MB for a picture and 8 MB for a banner."
  else -> null
}

/** What the route answers on success: `{ok, version}`, the version being the served image's cache-buster. */
@Serializable
data class AgentImageSaved(val ok: Boolean? = null, val version: String? = null)

/**
 * The raw file as the body. A ByteArray body, so OkHttp sends a Content-Length:
 * the route refuses an upload whose length it is not told (411) rather than
 * reading an unknown amount to find out.
 *
 * SENT ONCE: callAt puts every write on the API's write client, which never
 * resends one whose answer was cut off. Measured on this route before that
 * client existed: a PUT whose connection dropped after the request reached
 * the server arrived TWICE. The write is idempotent, so a repeat would do no
 * harm; the rule holds anyway, because "a lost answer is looked up, never
 * resent" is only true if nothing underneath resends it.
 */
suspend fun MerrymenApi.putAgentImage(kind: AgentImageKind, bytes: ByteArray, mime: String): ApiResult<AgentImageSaved> =
  decoded(callAt("/api/agent-image/me/" + kind.wire) { put(bytes.toRequestBody(mime.toMediaTypeOrNull())) })

/** Remove one. Removing a picture that is not there is not an error — the owner's intent holds either way. */
suspend fun MerrymenApi.deleteAgentImage(kind: AgentImageKind): ApiResult<AgentImageSaved> =
  sendJson("/api/agent-image/me/" + kind.wire, "DELETE", null)

/** What became of an upload or a removal. */
sealed interface ImageWrite {
  /** The server stored it (or removed it). [version] is the new cache-buster; null after a removal. */
  data class Done(val version: String?) : ImageWrite

  /** The server said no, and nothing changed. */
  data class Refused(val why: String) : ImageWrite

  /** Nothing was sent: the file was not one the server takes, or the session is not the owner's. */
  data class NotSent(val why: String) : ImageWrite

  /**
   * The request went and no answer came back. It may have landed; the owner is
   * told so and asked to look, and it is not sent again on its own.
   */
  data class Unknown(val why: String) : ImageWrite
}

/**
 * IS THE SESSION STILL THE WALLET THIS PAGE WAS READ FOR — asked of the server,
 * not of this app's memory, right before a write that names nobody.
 *
 * [readFor] is the address the You tab loaded its book under. A wallet signed in
 * through the WebView since then would have the picture land on ITS agent while
 * the page on screen shows the first one's. Null when it may go; a sentence
 * saying why nothing was sent otherwise. A session route that cannot be asked
 * is not a yes.
 */
suspend fun MerrymenApi.sessionIsStill(readFor: String?, what: String): String? {
  if (readFor.isNullOrBlank()) return "Sign in to change your agent's $what."
  return when (val s = session()) {
    is ApiResult.Ok -> when {
      s.value.address == null -> "You're signed out now, so nothing was sent. Sign in and try again."
      !s.value.address.equals(readFor, ignoreCase = true) ->
        "You're signed in as a different wallet than this page was loaded for, so nothing was sent. " +
          "Reload and try again."
      else -> null
    }
    is ApiResult.Refused ->
      if (s.status == 401) "You're signed out now, so nothing was sent. Sign in and try again."
      else "Couldn't confirm who is signed in, so nothing was sent. Try again in a moment."
    is ApiResult.Unreachable -> "Couldn't confirm who is signed in, so nothing was sent. Try again in a moment."
  }
}

/**
 * UPLOAD A PICTURE FOR THE OWNER'S OWN AGENT: check the file, check the
 * session is still [readFor], then send the bytes once.
 *
 * The checks run in that order so a file that was never going to be taken is
 * refused before the network is touched at all. There is a window between the
 * session answer and the PUT; it is the width of one request, where before
 * this the window was however long the page had been open.
 */
suspend fun MerrymenApi.uploadOwnAgentImage(
  kind: AgentImageKind,
  bytes: ByteArray,
  mime: String?,
  readFor: String?,
): ImageWrite {
  agentImageProblem(kind, mime, bytes.size.toLong())?.let { return ImageWrite.NotSent(it) }
  sessionIsStill(readFor, kind.noun)?.let { return ImageWrite.NotSent(it) }
  return imageWriteOf(kind, putAgentImage(kind, bytes, mime!!.lowercase(Locale.ROOT)))
}

/** Remove the owner's own picture, behind the same session check as an upload. */
suspend fun MerrymenApi.removeOwnAgentImage(kind: AgentImageKind, readFor: String?): ImageWrite {
  sessionIsStill(readFor, kind.noun)?.let { return ImageWrite.NotSent(it) }
  return when (val r = imageWriteOf(kind, deleteAgentImage(kind))) {
    is ImageWrite.Done -> ImageWrite.Done(null)
    else -> r
  }
}

/**
 * THE ROUTE'S ANSWER, IN WORDS FOR THE OWNER. The route's own sentence where it
 * wrote one for a 4xx ("use a PNG, JPEG or WebP — SVGs and animations are not
 * accepted" is the owner's to act on, "processing unavailable" is not), fixed
 * words where the status alone says it, and never a body.
 */
internal fun imageWriteOf(kind: AgentImageKind, r: ApiResult<AgentImageSaved>): ImageWrite = when (r) {
  is ApiResult.Ok -> ImageWrite.Done(r.value.version?.takeIf { it.isNotBlank() })
  // Refused on the phone, not by the server: the Server changed under it.
  is ApiResult.Refused -> if (r.status == NOT_SENT) ImageWrite.NotSent(r.message) else ImageWrite.Refused(
    when {
      r.status == 401 -> "Sign in to change your agent's ${kind.noun}."
      r.status == 404 -> "Pictures are not available on this server."
      r.status == 413 -> "That ${kind.noun} is too large — the limit is 5 MB for a picture and 8 MB for a banner."
      r.status >= 500 -> r.message
      r.message.startsWith("HTTP ") -> "That file could not be read as an image."
      else -> r.message.replaceFirstChar { it.uppercase(Locale.ROOT) }.let { if (it.endsWith(".")) it else "$it." }
    },
  )
  is ApiResult.Unreachable -> ImageWrite.Unknown(
    "Couldn't tell whether the ${kind.noun} was saved — ${if (r.unreadable) "the answer could not be read" else "the answer was lost"}. " +
      "Look again in a minute before trying again.",
  )
}

/** The most bytes a preview read will hold: the larger of the two upload limits, plus headroom. */
private const val PREVIEW_CAP = 10L * 1024 * 1024

/**
 * THE SERVED IMAGE, AS BYTES, for the You tab's preview — or Ok(null) when the
 * agent has none (the read route answers 404, and "no picture" is not an
 * error: most agents have none and the feed draws a seeded face).
 *
 * [version] is the upload's cache-buster, so the picture just saved is the one
 * shown rather than whatever an HTTP cache kept.
 */
suspend fun MerrymenApi.agentImageBytes(slug: String, kind: AgentImageKind, version: String?): ApiResult<ByteArray?> {
  val path = "/api/agent-image/" + java.net.URLEncoder.encode(slug, "UTF-8") + "/" + kind.wire +
    (version?.let { "?v=" + java.net.URLEncoder.encode(it, "UTF-8") } ?: "")
  val at = aim(path) ?: return ApiResult.Unreachable(NOT_A_WEB_ADDRESS)
  val req = Request.Builder().url(at.url).header("accept", "image/*").get().build()
  return suspendCancellableCoroutine { cont ->
    val call = http.newCall(req)
    cont.invokeOnCancellation { call.cancel() }
    val callback = object : okhttp3.Callback {
      override fun onFailure(call: okhttp3.Call, e: IOException) {
        cont.resume(ApiResult.Unreachable(noAnswerCause(e)))
      }

      override fun onResponse(call: okhttp3.Call, response: okhttp3.Response) {
        response.use { r ->
          val result: ApiResult<ByteArray?> = when {
            r.code == 404 -> ApiResult.Ok(null)
            !r.isSuccessful -> ApiResult.Refused(r.code, "HTTP ${r.code}")
            (r.body?.contentLength() ?: 0L) > PREVIEW_CAP -> ApiResult.Unreachable(UNREADABLE_ANSWER, unreadable = true)
            else -> try {
              val bytes = r.body?.bytes()
              if (bytes == null || bytes.size > PREVIEW_CAP) {
                ApiResult.Unreachable(UNREADABLE_ANSWER, unreadable = true)
              } else {
                ApiResult.Ok(bytes)
              }
            } catch (e: IOException) {
              ApiResult.Unreachable(noAnswerCause(e))
            }
          }
          cont.resume(result)
        }
      }
    }
    // Only to the server this preview was asked of (MerrymenApi.aim).
    if (!servers.sendIf(at.turn) { call.enqueue(callback) }) cont.resume(ApiResult.Unreachable(SERVER_CHANGED_READ))
  }
}
