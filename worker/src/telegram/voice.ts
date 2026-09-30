/**
 * Voice-note transcription via an OpenAI-compatible /audio/transcriptions
 * endpoint. Anthropic models don't accept audio, so voice needs a small
 * speech-to-text hop — the user configures their own key + base (default
 * OpenAI; any Whisper-compatible server works). Bare fetch, no SDK. Never
 * throws — a failure returns a reason and the caller degrades gracefully.
 */

import { deadline, orAbort } from "./api";

/**
 * How long each hop may take: fetching the note from Telegram, then the
 * transcription call. This runs inside the strictly serial poll loop, so a
 * hop that never answered held every later message, the owner's /kill
 * included, for as long as the process lived: the failure api.ts bounds every
 * bot method against.
 */
const VOICE_HOP_TIMEOUT_MS = 60_000;

export async function transcribeVoice(
  fileUrl: string,
  opts: { key: string; base: string; model?: string },
): Promise<{ text: string | null; reason?: string }> {
  const late = `timed out after ${VOICE_HOP_TIMEOUT_MS / 1000}s`;
  let bytes: Uint8Array<ArrayBuffer>;
  const dl = deadline(VOICE_HOP_TIMEOUT_MS);
  try {
    const audio = await orAbort(fetch(fileUrl, { signal: dl.signal }), dl.signal);
    if (!audio.ok) return { text: null, reason: `couldn't download the voice note (HTTP ${audio.status})` };
    bytes = new Uint8Array(await orAbort(audio.arrayBuffer(), dl.signal));
  } catch (e) {
    if (dl.signal.aborted) return { text: null, reason: `couldn't download the voice note: ${late}` };
    return { text: null, reason: e instanceof Error ? e.message : String(e) };
  } finally {
    dl.disarm();
  }

  const tx = deadline(VOICE_HOP_TIMEOUT_MS);
  try {
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: "audio/ogg" }), "voice.ogg");
    form.append("model", opts.model ?? "whisper-1");
    form.append("response_format", "json");

    const base = opts.base.replace(/\/+$/, "");
    const res = await orAbort(
      fetch(`${base}/audio/transcriptions`, {
        method: "POST",
        headers: { authorization: `Bearer ${opts.key}` },
        body: form,
        signal: tx.signal,
      }),
      tx.signal,
    );
    const body = (await orAbort(res.json(), tx.signal).catch(() => null)) as { text?: string; error?: { message?: string } } | null;
    if (tx.signal.aborted) return { text: null, reason: `transcription ${late}` };
    if (!res.ok) return { text: null, reason: body?.error?.message ?? `transcription HTTP ${res.status}` };
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    return text ? { text } : { text: null, reason: "empty transcription" };
  } catch (e) {
    if (tx.signal.aborted) return { text: null, reason: `transcription ${late}` };
    return { text: null, reason: e instanceof Error ? e.message : String(e) };
  } finally {
    tx.disarm();
  }
}
