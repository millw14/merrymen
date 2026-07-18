/**
 * Command disposer — takes a typed Command and injected capabilities, performs
 * the side effect, and returns the chat reply. This is the "code disposes" half:
 * control commands are gated by `controlEnabled`, `/cap` is clamped to the signed
 * grant (tighten only), and trades are handed to `trade()` which routes through
 * the same policy wall + on-chain session key as autonomous trading.
 *
 * Transfers are double-gated: the dashboard toggle must be on AND the grant must
 * carry the transfer permission — and even then a transfer only ever becomes a
 * PENDING action here. Nothing moves until the user sends /confirm after seeing
 * the full recipient address echoed back. Nothing here can exceed the grant.
 */

import { esc } from "./api";
import { CONTROL_KINDS, PC_CAP_OF, PC_KINDS, type Command } from "./interpreter";
import { resolveInRoot, shellAllowed, type PcActions } from "./pc";
import { WALLET_TEXT } from "./reads";

/** A vetted action awaiting the user's explicit /confirm. Widened from the
 * original transfer-only store so a pending PC action and a pending transfer
 * share one per-chat slot (the latest ask wins). */
export type PendingAction =
  | { kind: "transfer"; to: `0x${string}`; usdg: number; expiresAt: number }
  | { kind: "shell"; cmd: string; expiresAt: number }
  | { kind: "getfile"; path: string; expiresAt: number }
  | { kind: "type"; text: string; expiresAt: number }
  | { kind: "hotkey"; combo: string; expiresAt: number }
  | { kind: "power"; action: "sleep" | "shutdown"; expiresAt: number };

export interface CommandDeps {
  controlEnabled: boolean;
  /** Current chat per-action ceiling (telegramMaxActionUsdg). */
  maxActionUsdg: number;
  /** On-chain per-trade ceiling for clamping /cap; undefined when no grant armed. */
  grantPerTradeUsdg?: number;
  /** Dashboard toggle: may Telegram move funds out at all? */
  transferEnabled: boolean;
  /** Does the armed grant carry the on-chain transfer permission? */
  grantHasTransfer: boolean;
  reads: {
    status(): string;
    positions(): string;
    pnl(): string;
    trades(): string;
    report(): string | Promise<string>;
    why(): string | Promise<string>;
    brag(): string | Promise<string>;
  };
  setStrategy(name: string): { ok: boolean; reason?: string };
  setCap(usdg: number): void;
  setPaused(paused: boolean): void;
  kill(): { ok: boolean; reason?: string };
  link(code: string): { ok: boolean; reason?: string };
  /** Build a bounded TradeIntent and route it through processIntent → policy wall. */
  trade(side: "buy" | "sell", symbol: string, usdg: number): Promise<string>;
  /** Build a bounded transfer intent and route it through processIntent → policy wall. */
  transfer(to: `0x${string}`, usdg: number): Promise<string>;
  /** Pending-confirm store, bound to this chat by the service. */
  getPending(): PendingAction | null;
  setPending(p: PendingAction): void;
  clearPending(): void;
  /** Price alerts, persisted by the service. */
  addAlert(symbol: string, op: ">" | "<", price: number): string;
  listAlerts(): string;
  removeAlert(id: number): string;
  /** Soul: identity + owner memory (soul.ts via the service). */
  setName(name: string): { ok: boolean; name?: string; reason?: string };
  remember(fact: string): boolean;
  soulInfo(): string;
  forgetOwner(): void;
  // ── PC control (all gated: master switch + per-capability) ───────────────
  pcControlEnabled: boolean;
  capabilities: Set<string>;
  filesRoot?: string;
  shellAllowlist: string[];
  pc: PcActions;
  pcStatus(): string;
  // reminders (ungated pings) & watchers (gated under "watchers")
  addReminder(when: string, text: string): string;
  listReminders(): string;
  removeReminder(id: number): string;
  addWatcher(spec: string): string;
  listWatchers(): string;
  removeWatcher(id: number): string;
  help(): string;
  now?: () => number;
}

const CONFIRM_TTL_SEC = 90;

/** Refuse a PC command when the master switch is off or its capability isn't
 * enabled. Returns the refusal string, or null when the command may proceed.
 * "pc" (status) is always allowed. Reminders (not in PC_CAP_OF) aren't gated. */
function pcRefusal(cmd: Command, deps: CommandDeps): string | null {
  if (!PC_KINDS.has(cmd.kind) || cmd.kind === "pc") return null;
  if (!deps.pcControlEnabled) {
    return "🔒 PC control is off. Turn on “remote control” for Telegram in the dashboard first.";
  }
  const group = PC_CAP_OF[cmd.kind];
  if (group && !deps.capabilities.has(group)) {
    return `🔒 the “${group}” capability is off — enable it in the dashboard to use that.`;
  }
  return null;
}

export async function executeCommand(cmd: Command, deps: CommandDeps): Promise<string> {
  // Gate trading state-changing commands behind the trading-control switch.
  if (CONTROL_KINDS.has(cmd.kind) && !deps.controlEnabled) {
    return "🔒 control commands are turned off. Turn on “control” for Telegram in the dashboard to pause, switch strategy, trade, or kill.";
  }
  // Gate PC commands behind the master switch + per-capability allowlist.
  const refusal = pcRefusal(cmd, deps);
  if (refusal) return refusal;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

  switch (cmd.kind) {
    case "link": {
      const r = deps.link(cmd.code); // call once — link mutates state
      return r.ok
        ? "🏹 you're linked — you now command this merryman. Try /status."
        : `couldn't link: ${r.reason ?? "bad or expired code"}`;
    }
    case "help":
      return deps.help();
    // Static signpost — no state, no gating: it only tells you where the
    // dashboard is. Safe to answer even unlinked/read-only.
    case "wallet":
      return WALLET_TEXT;
    case "status":
      return deps.reads.status();
    case "positions":
      return deps.reads.positions();
    case "pnl":
      return deps.reads.pnl();
    case "trades":
      return deps.reads.trades();
    case "report":
      return await deps.reads.report();
    case "why":
      return await deps.reads.why();
    case "brag":
      return await deps.reads.brag();
    case "pause":
      deps.setPaused(true);
      return "⏸ paused — the band holds position. /resume to ride again.";
    case "resume":
      deps.setPaused(false);
      return "▶️ resumed — the band rides on the next tick.";
    case "strategy": {
      const r = deps.setStrategy(cmd.name);
      return r.ok ? `🎯 strategy set to ${esc(cmd.name)}. Applies on the next tick.` : `can't switch: ${esc(r.reason ?? "unknown")}`;
    }
    case "cap": {
      const ceiling = deps.grantPerTradeUsdg;
      let usdg = cmd.usdg;
      let note = "";
      if (ceiling !== undefined && usdg > ceiling) {
        usdg = ceiling;
        note = ` (clamped to your on-chain per-trade cap of ${ceiling} USDG — raise that by re-signing a grant in the dashboard)`;
      }
      deps.setCap(usdg);
      return `🧢 chat per-action ceiling set to ${usdg} USDG${note}.`;
    }
    case "buy":
    case "sell": {
      let usdg = cmd.usdg;
      let note = "";
      if (usdg > deps.maxActionUsdg) {
        usdg = deps.maxActionUsdg;
        note = ` (trimmed to your ${deps.maxActionUsdg} USDG chat ceiling)`;
      }
      const reply = await deps.trade(cmd.kind, cmd.symbol, usdg);
      return reply + note;
    }
    case "transfer": {
      if (!deps.transferEnabled) {
        return "🔒 transfers from chat are off. Turn on “allow transfers” for Telegram in the dashboard first.";
      }
      if (!deps.grantHasTransfer) {
        return "🧱 your permission wall predates transfers — discard the grant and re-create your wallet at /grant to add the (capped) transfer permission.";
      }
      let usdg = cmd.usdg;
      let note = "";
      if (usdg > deps.maxActionUsdg) {
        usdg = deps.maxActionUsdg;
        note = ` (trimmed to your ${deps.maxActionUsdg} USDG chat ceiling)`;
      }
      deps.setPending({ kind: "transfer", to: cmd.to, usdg, expiresAt: now() + CONFIRM_TTL_SEC });
      return [
        `⚠️ <b>confirm transfer</b>${note}`,
        `send <b>${usdg} USDG</b> to`,
        `<code>${esc(cmd.to)}</code>`,
        ``,
        `Check that address carefully — this leaves the wall. /confirm to send (${CONFIRM_TTL_SEC}s) or /cancel.`,
      ].join("\n");
    }
    case "confirm": {
      const p = deps.getPending();
      if (!p) return "nothing pending to confirm.";
      if (now() > p.expiresAt) {
        deps.clearPending();
        return "⌛ that confirmation expired — ask again.";
      }
      // Re-vet at confirm time: the owner may have disabled the toggle/capability
      // during the 90s window. Don't fire a parked action against a now-closed gate.
      if (p.kind === "transfer") {
        if (!deps.transferEnabled || !deps.grantHasTransfer) {
          deps.clearPending();
          return "🔒 transfers were turned off before you confirmed — nothing moved.";
        }
      } else {
        const refusal = pcRefusal({ kind: p.kind } as Command, deps);
        if (refusal) {
          deps.clearPending();
          return refusal;
        }
      }
      deps.clearPending();
      switch (p.kind) {
        case "transfer":
          return await deps.transfer(p.to, p.usdg);
        case "shell":
          return await deps.pc.runShell(p.cmd);
        case "getfile":
          return await deps.pc.getFile(p.path);
        case "type":
          return await deps.pc.typeText(p.text);
        case "hotkey":
          return await deps.pc.hotkey(p.combo);
        case "power":
          return await deps.pc.power(p.action);
      }
    }
    case "cancel": {
      const had = deps.getPending() !== null;
      deps.clearPending();
      return had ? "🚫 cancelled — nothing done." : "nothing pending to cancel.";
    }
    case "alert":
      return deps.addAlert(cmd.symbol, cmd.op, cmd.price);
    case "alerts":
      return deps.listAlerts();
    case "unalert":
      return deps.removeAlert(cmd.id);
    case "name": {
      const r = deps.setName(cmd.name);
      return r.ok
        ? `🏹 ${esc(r.name!)} it is — that's my name now, and I'll wear it proudly. Sworn to you.`
        : `can't take that name: ${esc(r.reason ?? "invalid")}`;
    }
    case "remember":
      return deps.remember(cmd.fact)
        ? "📝 noted — I'll carry that with me."
        : "I couldn't keep that one (too long, or it looked like an address/key — I never store those).";
    case "soul":
      return deps.soulInfo();
    case "forget":
      deps.forgetOwner();
      return "🍂 done — I've let go of what I knew about you. We start fresh from here.";
    // ── PC control: direct (already capability-gated above) ──────────────────
    case "screenshot":
      return await deps.pc.screenshot();
    case "look":
      return await deps.pc.look(cmd.question);
    case "open":
      return await deps.pc.open(cmd.target);
    case "sysinfo":
      return await deps.pc.sysinfo();
    case "volume":
      return await deps.pc.volume(cmd.spec);
    case "media":
      return await deps.pc.media(cmd.key);
    case "notify":
      return await deps.pc.notify(cmd.text);
    case "lock":
      return await deps.pc.lock();
    case "ls":
      return await deps.pc.ls(cmd.path);
    case "clipget":
      return await deps.pc.clipGet();
    case "clipset":
      return await deps.pc.clipSet(cmd.text);
    case "pc":
      return deps.pcStatus();
    // ── PC control: dangerous → park for /confirm (vetted at park time) ──────
    case "shell": {
      if (!shellAllowed(cmd.cmd, deps.shellAllowlist)) {
        return `🔒 “${esc(cmd.cmd)}” isn't in your shell allowlist (or it chains/redirects). Add exact commands in the dashboard.`;
      }
      deps.setPending({ kind: "shell", cmd: cmd.cmd, expiresAt: now() + CONFIRM_TTL_SEC });
      return `⚠️ <b>confirm run</b>\n<code>${esc(cmd.cmd)}</code>\n\n/confirm to run (${CONFIRM_TTL_SEC}s) or /cancel.`;
    }
    case "getfile": {
      const res = resolveInRoot(deps.filesRoot, cmd.path);
      if (!res.ok) return `🔒 ${esc(res.reason)}`;
      deps.setPending({ kind: "getfile", path: cmd.path, expiresAt: now() + CONFIRM_TTL_SEC });
      return `⚠️ <b>confirm send file</b>\n<code>${esc(cmd.path)}</code> will be sent to this chat.\n\n/confirm (${CONFIRM_TTL_SEC}s) or /cancel.`;
    }
    case "type": {
      deps.setPending({ kind: "type", text: cmd.text, expiresAt: now() + CONFIRM_TTL_SEC });
      return `⚠️ <b>confirm type</b> into your active window:\n<code>${esc(cmd.text)}</code>\n\n/confirm (${CONFIRM_TTL_SEC}s) or /cancel.`;
    }
    case "hotkey": {
      deps.setPending({ kind: "hotkey", combo: cmd.combo, expiresAt: now() + CONFIRM_TTL_SEC });
      return `⚠️ <b>confirm hotkey</b> <code>${esc(cmd.combo)}</code>\n\n/confirm (${CONFIRM_TTL_SEC}s) or /cancel.`;
    }
    case "power": {
      deps.setPending({ kind: "power", action: cmd.action, expiresAt: now() + CONFIRM_TTL_SEC });
      return `⚠️ <b>confirm ${cmd.action}</b> — this will ${cmd.action} your machine.\n\n/confirm (${CONFIRM_TTL_SEC}s) or /cancel.`;
    }
    // ── reminders (ungated) & watchers (gated above under "watchers") ────────
    case "remind":
      return deps.addReminder(cmd.when, cmd.text);
    case "reminders":
      return deps.listReminders();
    case "unremind":
      return deps.removeReminder(cmd.id);
    case "watch":
      return deps.addWatcher(cmd.spec);
    case "watchers":
      return deps.listWatchers();
    case "unwatch":
      return deps.removeWatcher(cmd.id);
    case "kill": {
      const r = deps.kill();
      return r.ok
        ? "🛑 KILL SWITCH — grant destroyed, the band stands down on the next tick. Re-grant in the dashboard to ride again."
        : `nothing to kill: ${r.reason ?? "no grant"}`;
    }
    case "chat":
      return cmd.reply;
    case "unknown":
      return esc(cmd.text);
  }
}
