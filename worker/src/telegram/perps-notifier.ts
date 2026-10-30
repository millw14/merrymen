/** Paper attention only: owner-bound worker evidence, durable claim before DM. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { writeFileAtomicSync } from "../atomic-write";
import { ensureHome, merrymenHome } from "../home";
import { esc, sendMessage } from "./api";
import { botIdOf, type StateRef } from "./state";
import { perpsAttention, type TelegramPerpsPort, type TelegramPerpsSnapshot } from "./perps";


type Config = {telegramEnabled: boolean; telegramBotToken: string | null | undefined; telegramNotifyEnabled?: boolean};
export function startPerpsNotifier(deps: {perps: TelegramPerpsPort; getCfg(): Config; stateRef: StateRef; now?: () => number; home?: string}): {stop(): void} {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const home = deps.home ?? merrymenHome();
  const file = join(home, "telegram-perps-notices.json");
  const pass = async () => {
    const cfg = deps.getCfg(), owner = deps.stateRef.get().ownerId;
    const bot = cfg.telegramBotToken && botIdOf(cfg.telegramBotToken);
    if (!cfg.telegramEnabled || !cfg.telegramNotifyEnabled || !cfg.telegramBotToken || !bot || owner === null || owner <= 0) return;
    let snapshot: TelegramPerpsSnapshot;
    try { snapshot = await deps.perps.read(); } catch { snapshot = {state: "unread"}; }
    const lines = perpsAttention(snapshot, now());
    const account = snapshot.state === "ready" ? snapshot.account.toLowerCase() : snapshot.state;
    const key = createHash("sha256").update(JSON.stringify({bot, owner, account, lines})).digest("hex");
    let last: unknown = null;
    try { last = JSON.parse(readFileSync(file, "utf8")); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") return; }
    if (last && typeof last === "object" && (last as {key?: unknown}).key === key) return;
    // The read awaited external state: don't deliver to an old link or token.
    const current = deps.getCfg();
    if (stopped || deps.stateRef.get().ownerId !== owner || !current.telegramEnabled || !current.telegramNotifyEnabled || current.telegramBotToken !== cfg.telegramBotToken) return;
    if (!deps.home) ensureHome();
    // A crash after this claim may lose a notice; it cannot replay it. Failure
    // to save is a refusal to send, never a best-effort dedupe update.
    writeFileAtomicSync(file, JSON.stringify({v: 1, key}), 0o600, {durable: true});
    if (lines.length) await sendMessage({token: cfg.telegramBotToken}, owner, "<b>Perps · paper practice attention</b>\nSimulated book, separate from Spot.\n" + lines.map(esc).join("\n\n"), {disablePreview: true});
  };
  const loop = async () => {
    try { await pass(); } catch { /* no unredacted upstream details or false success */ }
    if (!stopped) timer = setTimeout(loop, 30_000);
  };
  void loop();
  return {stop() {stopped = true; if (timer) clearTimeout(timer);}};
}
