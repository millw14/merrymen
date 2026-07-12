/**
 * Voice-note transcription via an OpenAI-compatible /audio/transcriptions
 * endpoint. Anthropic models don't accept audio, so voice needs a small
 * speech-to-text hop — the user configures their own key + base (default
 * OpenAI; any Whisper-compatible server works). Bare fetch, no SDK. Never
 * throws — a failure returns a reason and the caller degrades gracefully.
 */

export async function transcribeVoice(
  fileUrl: string,
  opts: { key: string; base: string; model?: string },
): Promise<{ text: string | null; reason?: string }> {
  try {
    const audio = await fetch(fileUrl);
    if (!audio.ok) return { text: null, reason: `couldn't download the voice note (HTTP ${audio.status})` };
    const bytes = new Uint8Array(await audio.arrayBuffer());

    const form = new FormData();
    form.append("file", new Blob([bytes], { type: "audio/ogg" }), "voice.ogg");
    form.append("model", opts.model ?? "whisper-1");
    form.append("response_format", "json");

    const base = opts.base.replace(/\/+$/, "");
    const res = await fetch(`${base}/audio/transcriptions`, {
      method: "POST",
      headers: { authorization: `Bearer ${opts.key}` },
      body: form,
    });
    const body = (await res.json().catch(() => null)) as { text?: string; error?: { message?: string } } | null;
    if (!res.ok) return { text: null, reason: body?.error?.message ?? `transcription HTTP ${res.status}` };
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    return text ? { text } : { text: null, reason: "empty transcription" };
  } catch (e) {
    return { text: null, reason: e instanceof Error ? e.message : String(e) };
  }
}
