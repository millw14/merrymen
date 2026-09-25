package dev.merrymen.app.net

import kotlinx.serialization.Serializable

/**
 * GET /api/settings, READ ONCE FOR TWO PURPOSES: the form's envelope, and the
 * status of every key the phone shows but never edits.
 *
 * [SettingsEnvelope] carries three of the masked secrets. The AI provider key
 * the owner actually uses may be any of three (groq, anthropic, or the generic
 * llmApiKey, by provider — Settings.tsx providerKeyField), so this decodes the
 * same body a second time into [SettingsKeys] rather than asking the server
 * twice. Both decodes read the one answer, so the key status and the form can
 * never describe two different moments.
 */

/** One AI provider the server offers, as much of it as a status line needs. */
@Serializable
data class LlmProviderName(val id: String = "", val label: String? = null)

/**
 * THE MASKED KEYS: whether each is set and its last four characters, never the
 * value. The phone shows this status and hands off to the web to change a key.
 */
@Serializable
data class SettingsKeys(
  val bundlerApiKey: SecretView = SecretView(),
  val groqApiKey: SecretView = SecretView(),
  val anthropicApiKey: SecretView = SecretView(),
  val llmApiKey: SecretView = SecretView(),
  val telegramBotToken: SecretView = SecretView(),
  val llmProviders: List<LlmProviderName> = emptyList(),
)

/** Both readings of one answer. */
data class SettingsRead(val env: SettingsEnvelope, val keys: SettingsKeys)

suspend fun MerrymenApi.settingsRead(): ApiResult<SettingsRead> =
  when (val raw = callAt("/api/settings") { get() }) {
    is ApiResult.Ok -> try {
      ApiResult.Ok(
        SettingsRead(
          json.decodeFromString(SettingsEnvelope.serializer(), raw.value),
          json.decodeFromString(SettingsKeys.serializer(), raw.value),
        ),
      )
    } catch (e: IllegalArgumentException) {
      unreadable("SettingsRead", e)
    }
    is ApiResult.Refused -> raw
    is ApiResult.Unreachable -> raw
  }

/**
 * WHICH KEY THE BRAIN IS USING, and its name: the provider stored in the
 * settings (groq when none, the web's default), and the secret field that
 * provider reads (Settings.tsx providerKeyField).
 */
fun SettingsKeys.providerKey(env: SettingsEnvelope): Pair<String, SecretView> {
  val id = env.str("llmProvider")?.takeIf { it.isNotBlank() } ?: "groq"
  val label = llmProviders.firstOrNull { it.id == id }?.label?.takeIf { it.isNotBlank() } ?: id
  val view = when (id) {
    "groq" -> groqApiKey
    "anthropic" -> anthropicApiKey
    else -> llmApiKey
  }
  return label to view
}

/** The web's placeholder for a masked key (Settings.tsx secretPlaceholder), less the invitation to type. */
fun secretStatus(s: SecretView): String = if (s.set) "saved ····" + (s.hint ?: "") else "not set"
