/**
 * Command disposer — takes a typed Command and injected capabilities, performs
 * the side effect, and returns the chat reply. This is the "code disposes" half:
 * control commands are gated by `controlEnabled`, `/cap` is clamped to the signed
 * grant (tighten only), and trades are handed to `trade()` which routes through
 * the same policy wall + on-chain session key as autonomous trading. Nothing here
 * can exceed the grant.
 */

import { CONTROL_KINDS, type Command } from "./interpreter";

export interface CommandDeps {
  controlEnabled: boolean;
  /** Current chat per-action ceiling (telegramMaxActionUsdg). */
  maxActionUsdg: number;
  /** On-chain per-trade ceiling for clamping /cap; undefined when no grant armed. */
  grantPerTradeUsdg?: number;
  reads: {
    status(): string;
    positions(): string;
    pnl(): string;
    trades(): string;
  };
  setStrategy(name: string): { ok: boolean; reason?: string };
  setCap(usdg: number): void;
  setPaused(paused: boolean): void;
  kill(): { ok: boolean; reason?: string };
  link(code: string): { ok: boolean; reason?: string };
  /** Build a bounded TradeIntent and route it through processIntent → policy wall. */
  trade(side: "buy" | "sell", symbol: string, usdg: number): Promise<string>;
  help(): string;
}

export async function executeCommand(cmd: Command, deps: CommandDeps): Promise<string> {
  // Gate state-changing commands behind the control switch.
  if (CONTROL_KINDS.has(cmd.kind) && !deps.controlEnabled) {
    return "🔒 control commands are turned off. Turn on “control” for Telegram in the dashboard to pause, switch strategy, trade, or kill.";
  }

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
    case "pause":
      deps.setPaused(true);
      return "⏸ paused — the band holds position. /resume to ride again.";
    case "resume":
      deps.setPaused(false);
      return "▶️ resumed — the band rides on the next tick.";
    case "strategy": {
      const r = deps.setStrategy(cmd.name);
      return r.ok ? `🎯 strategy set to ${cmd.name}. Applies on the next tick.` : `can't switch: ${r.reason}`;
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
    case "kill": {
      const r = deps.kill();
      return r.ok
        ? "🛑 KILL SWITCH — grant destroyed, the band stands down on the next tick. Re-grant in the dashboard to ride again."
        : `nothing to kill: ${r.reason ?? "no grant"}`;
    }
    case "chat":
      return cmd.reply;
    case "unknown":
      return cmd.text;
  }
}
