"use client";
import { Volume2, VolumeX } from "lucide-react";

/**
 * THE TRADE CHIME'S SWITCH — off until the reader turns it on (live-news.ts).
 *
 * It says what the sound is for, because a tone with no stated meaning is one
 * a reader learns to ignore: it plays when an agent's REAL-MONEY trade lands,
 * and for nothing else — not a hold, not a paper fill, not a refusal.
 */
export function SoundToggle({ on, onToggle }: { on: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      className="sound-toggle"
      aria-pressed={on}
      onClick={onToggle}
      title={
        on
          ? "A short tone plays when an agent's real-money trade lands. Click to turn it off."
          : "Play a short tone when an agent's real-money trade lands"
      }
    >
      {on ? <Volume2 size={14} aria-hidden /> : <VolumeX size={14} aria-hidden />}
      <span>{on ? "Sound on" : "Sound off"}</span>
    </button>
  );
}
