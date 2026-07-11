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
import { CONTROL_KINDS, type Command } from "./interpreter";

export interface PendingTransfer {
  to: `0x${string}`;
  usdg: number;
  expiresAt: number; // unix seconds
}

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
  getPending(): PendingTransfer | null;
  setPending(p: PendingTransfer): void;
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
  help(): string;
  now?: () => number;
}

const CONFIRM_TTL_SEC = 90;

export async function executeCommand(cmd: Command, deps: CommandDeps): Promise<string> {
  // Gate state-changing commands behind the control switch.
  if (CONTROL_KINDS.has(cmd.kind) && !deps.controlEnabled) {
    return "🔒 control commands are turned off. Turn on “control” for Telegram in the dashboard to pause, switch strategy, trade, or kill.";
  }
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
      deps.setPending({ to: cmd.to, usdg, expiresAt: now() + CONFIRM_TTL_SEC });
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
        return "⌛ that confirmation expired — start the transfer again.";
      }
      deps.clearPending();
      return await deps.transfer(p.to, p.usdg);
    }
    case "cancel": {
      const had = deps.getPending() !== null;
      deps.clearPending();
      return had ? "🚫 cancelled — nothing moved." : "nothing pending to cancel.";
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
