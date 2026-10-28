/**
 * /why's answer (service.ts reads.why), from the evidence readWhyEvidence
 * built: HTML it already escaped, with the receipt's `• tx: <code>…</code>`
 * line when the trade has one.
 *
 * The model reads that evidence with addresses and 64-hex runs redacted
 * (redactAddresses: a hash can carry an address, or be a private key), so
 * what it says never holds the owner's tx hash. The owner still gets it:
 * - when narrateWhy answers its own input (the model failed, or said
 *   nothing), the owner's own evidence, unredacted, exactly what /why sends
 *   with no model at all;
 * - otherwise the narration, with the code-built receipt line under it, as the
 *   daily digest sends its report under its narration.
 */
import type { LlmCreds } from "../llm";
import { escModel } from "./api";
import { narrateWhy } from "./interpreter";
import { redactAddresses } from "./reads";

export async function whyAnswer(
  ev: { text: string; hasTrade: boolean },
  llm: LlmCreds | null,
  narrate: (evidence: string, creds: LlmCreds) => Promise<string> = narrateWhy,
): Promise<string> {
  if (!ev.hasTrade || !llm) return ev.text;
  // Model text, sent as HTML: escaped, or a "<" in it (or in a
  // decision's reason it quotes) makes Telegram refuse the message.
  // Addresses redacted: the evidence quotes event lines (reads.ts).
  const plain = redactAddresses(
    ev.text.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"),
  );
  const said = await narrate(plain, llm);
  if (said === plain) return ev.text;
  // Already escaped by readWhyEvidence ("• tx: <code>…</code>"): safe to send as is.
  const tx = ev.text.split("\n").filter((line) => line.startsWith("• tx: "));
  const narrated = escModel(said);
  return tx.length ? `${narrated}\n\n${tx.join("\n")}` : narrated;
}
