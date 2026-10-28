import { StringDecoder } from "node:string_decoder";
import { redactUrls } from "./redact-urls";

/**
 * Split a byte stream into whole lines, so a URL is never redacted in two
 * halves. A `data` chunk ends wherever the pipe's buffer did, and the second
 * half of a split URL has no scheme for `redactUrls` to find.
 *
 * `push` returns the complete lines in this chunk, redacted; the remainder is
 * held for the next. `flush` returns what is left when the stream ends.
 * An unfinished line longer than `maxHeld` is released (redacted and marked
 * truncated), then its remainder is discarded through the next newline. That
 * remainder may be the tail of a URL whose scheme was in the released prefix.
 */
export function lineRedactor(maxHeld = 64 * 1024): { push(chunk: Buffer | string): string[]; flush(): string[] } {
  let held = "";
  let discarding = false;
  // A multi-byte character split across chunks is held too, not garbled.
  const decoder = new StringDecoder("utf8");
  return {
    push(chunk) {
      let text = typeof chunk === "string" ? chunk : decoder.write(chunk);
      if (discarding) {
        const end = text.indexOf("\n");
        if (end < 0) return [];
        text = text.slice(end + 1);
        discarding = false;
      }
      held += text;
      const parts = held.split(/\r?\n/);
      held = parts.pop() ?? "";
      if (held.length > maxHeld) {
        parts.push(`${held} [truncated]`);
        held = "";
        discarding = true;
      }
      return parts.map(redactUrls);
    },
    flush() {
      const rest = held + decoder.end();
      held = "";
      if (discarding) {
        discarding = false;
        return [];
      }
      return rest ? [redactUrls(rest)] : [];
    },
  };
}

type Write = NodeJS.WriteStream["write"];
const GUARDED = Symbol.for("merrymen.redactUrls.guarded");

/**
 * Route everything this process writes to stdout and stderr through
 * `redactUrls` (keyed URLs and Lighter key material) — `console.*` of an
 * error object included, since console
 * formats it (stack, `url: '…'`, metaMessages, cause chain) to a string and
 * then calls the stream's `write`.
 *
 * Installed once at each production entry point, before anything can fail.
 * Idempotent. A Buffer is decoded only when it may hold a URL or a key, and
 * written untouched when nothing in it changed.
 */
export function guardStdio(streams: NodeJS.WriteStream[] = [process.stdout, process.stderr]): void {
  for (const stream of streams) {
    const s = stream as NodeJS.WriteStream & { [GUARDED]?: true };
    if (s[GUARDED]) continue;
    const write = s.write.bind(s) as (...a: unknown[]) => boolean;
    s.write = ((chunk: unknown, ...rest: unknown[]) => {
      if (typeof chunk === "string") return write(redactUrls(chunk), ...rest);
      const bytes = chunk instanceof Uint8Array ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength) : null;
      // A URL, or a run long enough to be a Lighter key (redactLighterSecrets).
      if (bytes && (bytes.includes("://") || bytes.length >= 80)) {
        const text = bytes.toString("utf8");
        const safe = redactUrls(text);
        if (safe !== text) {
          // The encoding argument described the bytes; the text is UTF-8 now.
          const cb = rest.find((a) => typeof a === "function");
          return cb ? write(safe, "utf8", cb) : write(safe, "utf8");
        }
      }
      return write(chunk, ...rest);
    }) as Write;
    s[GUARDED] = true;
  }
}
