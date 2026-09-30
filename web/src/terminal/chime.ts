/**
 * A SHORT TONE WHEN A REAL-MONEY TRADE LANDS — opt-in, off by default.
 *
 * The preference is the reader's and lives in their browser. localStorage
 * throws in private windows, with site data blocked and in some previews, so
 * every touch of it is caught, and anything but an explicit "on" is off.
 *
 * WebAudio, synthesised, so there is no sound file to fetch. Browsers start an
 * AudioContext suspended until the reader has interacted with the page, so the
 * context is created and resumed from the toggle's own click (`unlockAudio`),
 * and after a reload with the sound already on, from the page's gestures
 * (live-news.ts useSoundPref) — until then nothing plays, and nothing fails
 * loudly either.
 */
import type { Thesis } from "./live";

export const SOUND_KEY = "merrymen.sound";

type StorageSource = () => Storage | null | undefined;

export function readSoundOn(storage: StorageSource): boolean {
  try {
    return storage()?.getItem(SOUND_KEY) === "on";
  } catch {
    return false;
  }
}

/** True when the choice was saved; false when storage would not take it. */
export function writeSoundOn(on: boolean, storage: StorageSource): boolean {
  try {
    const s = storage();
    if (!s) return false;
    if (on) s.setItem(SOUND_KEY, "on");
    else s.removeItem(SOUND_KEY);
    return true;
  } catch {
    return false;
  }
}

/**
 * One blip: a buy rises a fifth, a sell falls one. Under a fifth of a second,
 * quiet, and ramped in and out so it does not click.
 */
export function blip(ctx: AudioContext, side: "buy" | "sell"): void {
  const t0 = ctx.currentTime;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  const [from, to] = side === "buy" ? [660, 990] : [990, 660];
  osc.frequency.setValueAtTime(from, t0);
  osc.frequency.exponentialRampToValueAtTime(to, t0 + 0.09);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(0.12, t0 + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.16);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + 0.18);
}

/** One tone per batch of arrivals, for the newest of them. */
export function chimeSide(news: readonly Thesis[]): "buy" | "sell" | null {
  let newest: Thesis | null = null;
  for (const t of news) if (!newest || (t.at ?? 0) >= (newest.at ?? 0)) newest = t;
  return newest?.action === "buy" || newest?.action === "sell" ? newest.action : null;
}

let context: AudioContext | null = null;

/** For a test that installs its own AudioContext: forget the one already made. */
export function forgetAudioForTest(): void {
  context = null;
}

/**
 * THE ONLY PLACE A CONTEXT IS MADE, and only from a click or a key press — the
 * one moment a browser lets audio start. Resolves true once it is running.
 *
 * A context made anywhere else starts suspended, and its clock stands still
 * until a gesture resumes it; see playChime for what that did to the tone.
 */
export function unlockAudio(): Promise<boolean> {
  if (!context) {
    const Ctor =
      (globalThis as { AudioContext?: typeof AudioContext }).AudioContext ??
      (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return Promise.resolve(false);
    try {
      context = new Ctor();
    } catch {
      return Promise.resolve(false);
    }
  }
  const ctx = context;
  const running = () => (ctx.state as string) === "running";
  if (running()) return Promise.resolve(true);
  try {
    return ctx.resume().then(running, () => false);
  } catch {
    return Promise.resolve(false);
  }
}

/**
 * Play the tone for `side` NOW, or not at all; never throws. True when it played.
 *
 * NOTHING IS SCHEDULED ON A CONTEXT THAT IS NOT RUNNING. A suspended context’s
 * clock is frozen at the moment it stopped, so a blip scheduled on it waited
 * there and played the moment the reader next clicked — minutes after the
 * trade, as if one had just landed, and on top of every other one queued behind
 * it. After a reload with the sound on, a fill before the first click is
 * therefore silent; the tab title still counts it.
 *
 * BUT A STOPPED CONTEXT IS ASKED TO START AGAIN, for the fill after this one.
 * The browser suspends or interrupts a context that was running (iOS
 * backgrounding the page, an output device changing), and a reader who is only
 * watching makes no gesture to restart it. Once the page has had activation a
 * resume needs no gesture, so the next fill sounds; this one, missed, stays
 * missed. Nothing is scheduled here, so nothing can play late.
 */
export function playChime(side: "buy" | "sell"): boolean {
  const ctx = context;
  if (!ctx) return false;
  if ((ctx.state as string) !== "running") {
    try {
      void ctx.resume().catch(() => {});
    } catch {
      /* A context that cannot resume is simply not running. */
    }
    return false;
  }
  try {
    blip(ctx, side);
    return true;
  } catch {
    /* A tone is a nicety; a page that stopped over one would not be. */
    return false;
  }
}
