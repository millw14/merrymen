/**
 * Send a closed position to the owner as a picture.
 *
 * WHY A FILE AND NOT A BUFFER: `sendPhoto` takes a path, because that is what
 * the multipart helper in api.ts was built for (screenshots from the PC tools
 * are already on disk). The card is generated in memory, so it is written to a
 * temp file, sent, and removed — in a `finally`, so a failed send does not leave
 * an image of someone's trade sitting in the system temp directory.
 *
 * NOTHING HERE MAY THROW INTO THE CALLER. The notifier's job is to tell the
 * owner what their agent did; a card is the nicest way to say it and never the
 * only way. If the template is missing, or the image library will not load on
 * this host, the caption has already gone out as text and the picture is simply
 * absent. A trade must never be hidden because a JPEG could not be drawn.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { pnlCaption, renderPnlCard, type PnlCardData } from "../pnl-card";
import { sendPhoto, type TelegramOpts } from "./api";

export interface PnlPhotoResult {
  sent: boolean;
  /** Why it did not go, for the operator log. Never shown to the owner. */
  reason?: string;
}

/**
 * Render the card and send it. Returns rather than throws.
 *
 * @param caption Overrides the derived caption. Pass "" for no caption at all,
 *   which is what the caller does when the receipt above it already said this.
 */
export async function sendPnlPhoto(
  opts: TelegramOpts,
  chatId: number,
  data: PnlCardData,
  caption?: string,
): Promise<PnlPhotoResult> {
  let dir: string | null = null;
  try {
    const png = await renderPnlCard(data);
    dir = await mkdtemp(path.join(tmpdir(), "merrymen-pnl-"));
    // Named after the token, so a saved card is identifiable in a downloads
    // folder. Anything outside [A-Za-z0-9] is dropped: the symbol comes off a
    // chain and must never be able to steer a filesystem path.
    const safe = data.symbol.replace(/[^A-Za-z0-9]/g, "").slice(0, 24) || "position";
    const file = path.join(dir, `${safe}-pnl.png`);
    await writeFile(file, png);
    const sent = await sendPhoto(opts, chatId, file, caption ?? pnlCaption(data));
    return sent.ok ? { sent: true } : { sent: false, reason: sent.reason ?? "telegram refused the photo" };
  } catch (e) {
    return { sent: false, reason: e instanceof Error ? e.message : String(e) };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
