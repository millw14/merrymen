/**
 * THE CHAT REPLY, A PIECE AT A TIME — and the one rule that makes that safe.
 *
 * /api/chat used to answer once, after the whole reply was written, so an
 * owner stared at "thinking…" for the length of the slowest completion. It now
 * streams over SSE. The danger in streaming is specific to this chat: a reply
 * may END with a proposal, `<<CMD id {args}>>`, and a proposal is read only
 * when it is the very last thing the reply does (chat-commands.ts — that
 * anchor is a security control). A stream is by definition a reply that has
 * not ended yet. So:
 *
 *   - everything from the FIRST `<<` is held back until the reply is complete,
 *     and the complete text goes through splitCommand exactly as before — the
 *     end-anchor is checked on the whole reply, never on a prefix;
 *   - no partial marker ever reaches a screen, not even the `<` that might
 *     become one;
 *   - reasoning a model leaks inline (`<think>…</think>`) never shows either.
 *
 * Shared by the server, which sends only the safe prefix, and the browser,
 * which applies the same rule again to whatever arrives. Two gates, neither
 * relying on the other — the same shape as the marker defence itself. No
 * imports, so the browser bundle can carry it.
 */

/** A finished reasoning block, in either spelling models use. */
const THINK_BLOCK = /<\|?think\|?>[\s\S]*?<\/\|?think\|?>/gi;
/** A reasoning block that has opened and not yet closed. */
const THINK_OPEN = /<\|?think\|?>/i;

/**
 * The part of a reply-so-far that may be shown.
 *
 * GROWS ONLY BY APPENDING as the reply grows, so what is already on screen is
 * never rewritten — which is what lets the server send it as appended pieces.
 * When the reply completes, the caller replaces the whole of it with
 * splitCommand's reply, which is the only text that is ever final.
 */
export function streamSafe(raw: string): string {
  let s = raw.replace(THINK_BLOCK, "");
  const open = s.search(THINK_OPEN);
  if (open >= 0) s = s.slice(0, open);
  // From the first `<<` on, nothing shows until the end: it may be a proposal
  // still being written, or a quoted marker that the complete reply scrubs.
  const marker = s.indexOf("<<");
  if (marker >= 0) s = s.slice(0, marker);
  // A `<` with no `>` after it may still become `<<` — or the start of a
  // reasoning tag — on the very next character. Held until it cannot.
  const lt = s.lastIndexOf("<");
  if (lt >= 0 && s.indexOf(">", lt) < 0) s = s.slice(0, lt);
  return s.replace(/^\s+/, "");
}

/** One server-sent event, framed. */
export function sseEvent(name: "text" | "done" | "error", data: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** What a finished stream said. The same shape the unstreamed route answers with. */
export interface StreamedReply {
  reply: string | null;
  command?: { id: string; args: Record<string, string | number | boolean> };
  /** "cut-off" when the stream ended with no `done` — half an answer is not an answer. */
  why?: string;
  /** For a model failure: which kind, as the server classified it, and whose. */
  kind?: string;
  provider?: string;
  detail?: string;
}

/**
 * Read /api/chat's event stream, telling `onText` what may be shown so far.
 *
 * THE FINAL REPLY IS `done`'s, never the concatenated pieces: the server ran
 * splitCommand on the whole text, and the command it found (or did not) is
 * decided there. A stream that ends without `done` was cut off, and is
 * returned as a failure rather than as the half that arrived — half a sentence
 * about somebody's money may be the half before "but not until…".
 */
export async function readReplyStream(
  body: ReadableStream<Uint8Array>,
  onText: (visible: string) => void,
): Promise<StreamedReply> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let shown = "";
  const handle = (block: string): StreamedReply | null => {
    let name = "message";
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (!line || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") name = value;
      else if (field === "data") data.push(value);
    }
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(data.join("\n")) as Record<string, unknown>;
    } catch {
      return null; // a keep-alive, or noise — never rendered
    }
    if (!payload || typeof payload !== "object") return null;
    if (name === "text" && typeof payload.t === "string") {
      text += payload.t;
      const visible = streamSafe(text);
      if (visible !== shown) {
        shown = visible;
        onText(visible);
      }
      return null;
    }
    if (name === "done") {
      const reply = typeof payload.reply === "string" && payload.reply ? payload.reply : null;
      const command = payload.command as StreamedReply["command"] | undefined;
      return { reply, ...(command && typeof command.id === "string" ? { command } : {}) };
    }
    if (name === "error") {
      const text = (k: string) => (typeof payload[k] === "string" && payload[k] ? { [k]: payload[k] as string } : {});
      return {
        reply: null,
        why: typeof payload.why === "string" ? payload.why : "llm-error",
        ...text("kind"),
        ...text("provider"),
        ...text("detail"),
      };
    }
    return null;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buffer += decoder.decode(value, { stream: true });
      if (done) buffer += decoder.decode();
      // Events end at a blank line, in either line-ending convention.
      let cut: RegExpExecArray | null;
      while ((cut = /\r?\n\r?\n/.exec(buffer))) {
        const block = buffer.slice(0, cut.index);
        buffer = buffer.slice(cut.index + cut[0].length);
        const out = handle(block);
        if (out) return out;
      }
      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
  return { reply: null, why: "cut-off" };
}
