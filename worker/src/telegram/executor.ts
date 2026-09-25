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
  | { kind: "power"; action: "sleep" | "shutdown"; expiresAt: number }
  /**
   * The kill switch, parked for confirmation like a transfer.
   *
   * It used to fire on a single message. It destroys the grant file, which for
   * a grant that has never been replaced is the only on-disk copy of the owner
   * key — so a misread instruction was a permanent loss of funds. A transfer of
   * $5 asks first; ending the agent should too.
   */
  | { kind: "kill"; expiresAt: number }
  /**
   * A settings change the owner asked for by text, already parsed and
   * range-checked (settings-chat.ts). Applied only on confirm, and the control
   * switch is checked again then.
   */
  | { kind: "setting"; key: string; value: unknown; expiresAt: number };

/**
 * What a kill actually did, so the reply can say exactly that.
 *
 * `revocation` is present only for a HOSTED kill (kill-request.ts). There the
 * grant lives in the tenant store and this agent only holds a copy of it.
 * `queued`: the copy is gone and the server will remove the stored grant.
 * `failed`: the copy is gone, but the request that stops the server restoring
 * it could not be written.
 */
export interface KillResult {
  ok: boolean;
  reason?: string;
  archived?: string | null;
  revocation?: "queued" | "failed";
}

export interface CommandDeps {
  controlEnabled: boolean;
  /**
   * Hosted fleet (MERRYMEN_HOSTED)? The kill prompt has to say what a kill
   * does HERE. Self-hosted it archives an owner key on the owner's machine.
   * Hosted there is no owner key on the server to archive. Optional: absent
   * means self-hosted, which is what every fixture predating it describes.
   */
  hosted?: boolean;
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
    /** `/wallet` — leads with the account address. Optional so existing hosts and
     *  fixtures that predate it keep the old static signpost. */
    wallet?(): string;
    positions(): string;
    /** Liquidity depth for one ticker — a chain read, so always async. */
    depth(symbol: string): Promise<string>;
    pnl(): string;
    trades(): string | Promise<string>;
    report(): string | Promise<string>;
    why(): string | Promise<string>;
    brag(): string | Promise<string>;
    /** `/settings` — optional so fixtures that predate it still typecheck. */
    settings?(): string;
  };
  /**
   * Settings by text. `proposeSetting` turns the owner's words into either a
   * question (and parks it) or a plain reply; `applySetting` saves a confirmed
   * change. Optional so hosts without them answer honestly instead of failing.
   */
  proposeSetting?(setting: string, value: string): string;
  applySetting?(key: string, value: unknown): string;
  setStrategy(name: string): { ok: boolean; reason?: string };
  setCap(usdg: number): void;
  setPaused(paused: boolean): void;
  /**
   * Destroy the grant. Self-hosted it archives the owner key first, and
   * `archived` names the account kept. Hosted it queues the store removal
   * (`revocation`).
   */
  kill(): KillResult;
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

export const CONFIRM_TTL_SEC = 90;
/**
 * A settings question waits longer than a transfer: nothing leaves the account
 * and the owner may be answering from a phone later. Ten minutes, then it
 * expires and has to be asked again.
 */
export const SETTING_CONFIRM_TTL_SEC = 600;

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
      // Was the static signpost. It now leads with the account ADDRESS, because
      // the question people actually arrive with is "where is my money", and the
      // answer to that is a string they can compare against what MetaMask showed
      // them — not a paragraph about smart accounts.
      return deps.reads.wallet ? deps.reads.wallet() : WALLET_TEXT;
    case "status":
      return deps.reads.status();
    case "positions":
      return deps.reads.positions();
    case "depth":
      return deps.reads.depth(cmd.symbol);
    case "pnl":
      return deps.reads.pnl();
    case "trades":
      return await deps.reads.trades();
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
        // The old text told the owner to DESTROY their grant and re-create the
        // wallet to gain a permission the new wall would not contain either —
        // advice that costs a session key and delivers nothing. Worded to
        // match what checkPolicy says for the same refusal, so the two read
        // alike wherever the owner meets them.
        return "🧱 this wall carries no transfer permission — no withdrawal address was registered when it was signed, so the chain would refuse the send. Move funds with your owner key: `merrymen recover`.";
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
      } else if (p.kind === "setting") {
        if (!deps.controlEnabled) {
          deps.clearPending();
          return "🔒 control was turned off before you confirmed — nothing changed.";
        }
      } else if (p.kind === "kill") {
        // Kill is a control command, not a PC capability — re-vet the control
        // switch rather than running it through pcRefusal, which knows nothing
        // about it and would let it through.
        if (!deps.controlEnabled) {
          deps.clearPending();
          return "🔒 control was turned off before you confirmed — the grant is untouched.";
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
        case "setting":
          return deps.applySetting ? deps.applySetting(p.key, p.value) : "settings can't be changed from chat here — nothing changed.";
        case "kill": {
          const r = deps.kill();
          if (!r.ok) return `nothing to kill: ${r.reason ?? "no grant"}`;
          // HOSTED: say only what THIS agent did. Nothing was archived. The
          // stored grant is deleted by the server a few seconds later, and the
          // server confirms that itself, because only it knows (KILL_DONE_TEXT,
          // kill-request.ts). The request waits in a home a redeploy would
          // discard, so a missing ✅ has to mean something the owner can act on.
          if (r.revocation === "queued") {
            return (
              `🛑 KILL SWITCH — this agent's copy of the key is gone, and the band stands down on the next tick. ` +
              `The server is deleting your stored grant now; you'll get a ✅ in the owner chat when it's done.\n` +
              `No ✅ within a few minutes? Revoke it in the dashboard: You → Wallet &amp; permissions → discard &amp; start over. ` +
              `Your funds stay in your smart account.`
            );
          }
          if (r.revocation === "failed") {
            return (
              `⚠️ KILL SWITCH — only half done. This agent's copy of the key is gone, but I could not record the kill, ` +
              `so the server may hand the key back on its next pass.\n` +
              `Revoke it for good in the dashboard: You → Wallet &amp; permissions → discard &amp; start over.`
            );
          }
          return (
            `🛑 KILL SWITCH — grant destroyed, the band stands down on the next tick.\n` +
            (r.archived
              ? `Owner key archived to <code>~/.merrymen/grants/</code> — <code>merrymen recover</code> can still sweep the funds.`
              : `⚠️ nothing could be archived — if this account held funds, check ~/.merrymen/grants/ before re-granting.`) +
            `\nRe-grant in the dashboard to ride again.`
          );
        }
      }
    }
    case "set":
      return deps.proposeSetting
        ? deps.proposeSetting(cmd.setting, cmd.value)
        : "settings can't be changed from chat on this deployment — use Settings on the dashboard.";
    case "settings":
      return deps.reads.settings ? deps.reads.settings() : "your settings live on the dashboard, under Settings.";
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
      deps.setPending({ kind: "kill", expiresAt: now() + CONFIRM_TTL_SEC });
      if (deps.hosted) {
        // Hosted there is no owner key on the server (the grant store refuses
        // one) and no `merrymen recover` to run on it.
        return (
          `⚠️ <b>confirm kill</b> — this revokes my trading permission and stands the band down.\n` +
          `Your funds stay in your smart account; the server never held your owner key.\n\n` +
          `/confirm to kill (${CONFIRM_TTL_SEC}s) or /cancel.`
        );
      }
      return (
        `⚠️ <b>confirm kill</b> — this destroys the grant and stands the band down.\n` +
        `Your owner key is archived to <code>~/.merrymen/grants/</code> first, so ` +
        `<code>merrymen recover</code> can still sweep the funds.\n\n` +
        `/confirm to kill (${CONFIRM_TTL_SEC}s) or /cancel.`
      );
    }
    case "chat":
      return cmd.reply;
    case "unknown":
      return esc(cmd.text);
    case "agent":
      // Agent tasks are intercepted in service.ts (they run a detached loop that
      // streams its own messages). This branch keeps the switch exhaustive and is
      // not reached in normal flow.
      return "🏹 starting…";
  }
}
