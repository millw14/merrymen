"use client";
/**
 * THE MERRYMAN AS THE TOP OF A SCREEN: stage, name, one plain status word, and
 * whatever the screen wants under him (a balance, two buttons).
 *
 * The stage is NOT inside a button. The figure takes taps and drags of its
 * own, and a canvas nested in a <button> is both invalid and a trap for a
 * keyboard user; the screen's own controls sit beside it.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Merryman, type Cue } from "./Merryman";
import { latestAt, newestReaction, type Mood, type Move, type Tone } from "./mood";
import type { Outfit } from "./outfit";

/**
 * A one-shot and a bubble for each NEW landed trade on the owner's tape.
 * The first reading only sets the clock — see mood.ts `newestReaction`.
 */
export function useReactions(moves: readonly Move[] | null | undefined): { cue: Cue | null; bubble: string | null; tone: Tone } {
  const seen = useRef<number | null>(null);
  const [state, setState] = useState<{ cue: Cue | null; bubble: string | null; tone: Tone }>({ cue: null, bubble: null, tone: "calm" });
  useEffect(() => {
    if (!moves) return;
    const hit = newestReaction(moves, seen.current);
    seen.current = Math.max(seen.current ?? 0, latestAt(moves));
    if (!hit) return;
    setState({ cue: { key: hit.at, clip: hit.reaction.clip }, bubble: hit.reaction.bubble, tone: hit.reaction.tone });
    const clear = setTimeout(() => setState((s) => ({ ...s, bubble: null })), 6000);
    return () => clearTimeout(clear);
  }, [moves]);
  return state;
}

export function MerrymanHero({
  outfit,
  mood,
  name,
  moves,
  cue,
  className = "",
  children,
  onTap,
}: {
  outfit: Outfit;
  mood: Mood;
  name: string;
  /** The owner's own tape, for trade reactions. Absent for a visitor. */
  moves?: readonly Move[] | null;
  /** An extra one-shot from the screen (a greeting, a dress-up). */
  cue?: Cue | null;
  className?: string;
  children?: ReactNode;
  onTap?: () => void;
}) {
  const reaction = useReactions(moves);
  const bubble = reaction.bubble ?? mood.bubble;
  const tone = reaction.bubble ? reaction.tone : mood.tone;
  // Whichever one-shot arrived last plays: a trade reaction or the screen's own.
  const [shown, setShown] = useState<Cue | null>(null);
  useEffect(() => { if (reaction.cue) setShown(reaction.cue); }, [reaction.cue?.key]);
  useEffect(() => { if (cue) setShown(cue); }, [cue?.key]);
  return (
    <section className={`mm-hero tone-${mood.tone} ${className}`} aria-label={`${name}, ${mood.word}`}>
      <div className="mm-hero-stage">
        <Merryman outfit={outfit} base={mood.clip} cue={shown} bubble={bubble} bubbleTone={tone} label={`${name}, your merryman: ${mood.word}`} onTap={onTap} />
        <span className={`mm-chip tone-${mood.tone}`}><i aria-hidden /> {mood.word}</span>
      </div>
      {children ? <div className="mm-hero-body">{children}</div> : null}
    </section>
  );
}
