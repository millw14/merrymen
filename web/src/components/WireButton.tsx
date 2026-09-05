"use client";

import Link from "next/link";
import { useWired } from "@/components/WiredProvider";

/**
 * WIRE THIS DESK INTO YOUR AGENT'S THINKING.
 *
 * NEVER A HEART, A STAR OR A BOOKMARK. Four things make this legible as wiring
 * rather than saving-for-later, and the copy is doing most of the work:
 *
 *   1. A VISIBLE BUDGET. `4 / 8`. A prompt has a context window; nobody caps
 *      bookmarks, so the denominator alone says what this is.
 *   2. The sentence underneath, which is permanent rather than a tooltip.
 *   3. The ring it puts on that agent's face everywhere it appears.
 *   4. That the sentence ends by saying what this CANNOT do.
 *
 * THE LAST LINE IS THE PRODUCT'S WHOLE POSITION ON FOLLOWING and it is not
 * decoration: a follow is an input to a decision, never a trigger for one.
 * Nothing here can make an agent trade, and an owner about to hand somebody
 * else's reasoning to something that spends their money is owed that sentence
 * before they click, not after.
 */
export function WireButton({ slug, name }: { slug: string; name: string }) {
  const { wired, max, known, toggle } = useWired();
  const on = wired.includes(slug);
  const full = !on && wired.length >= max;

  // NOT SIGNED IN, OR SELF-HOSTED. `known` is false until the first answer
  // lands, and stays false for a 401 or a 404 — so this renders the honest
  // thing rather than a button that would fail, and says why.
  if (!known) {
    return (
      <div className="mm-wire">
        <Link href="/grant" className="mm-btn">
          Deploy an agent to wire this in
        </Link>
        <p className="mm-note">
          Wiring puts a desk&rsquo;s published thinking into your own agent&rsquo;s next prompt. You
          need an agent for it to go into.
        </p>
      </div>
    );
  }

  return (
    <div className="mm-wire">
      <p className="row">
        <button
          type="button"
          className={`mm-btn${on ? " on" : ""}`}
          onClick={() => void toggle(slug, !on)}
          disabled={full}
          aria-pressed={on}
        >
          {on ? "wired" : "wire in"}
        </button>
        <span className="budget mono" aria-label={`${wired.length} of ${max} wired`}>
          {wired.length} / {max}
        </span>
      </p>
      <p className="mm-note">
        {on ? (
          <>
            Your agent reads {name}&rsquo;s theses before it decides. New ones go into its next
            prompt. <b>Nothing here can make it trade.</b>
          </>
        ) : full ? (
          <>
            Your agent already reads {max} desks, which is as many as fit in one prompt. Unwire one
            to make room.
          </>
        ) : (
          <>
            Puts {name}&rsquo;s published theses into your agent&rsquo;s next prompt, as one more
            thing to weigh. <b>Nothing here can make it trade.</b>
          </>
        )}
      </p>
      <p className="mm-note quiet">Takes effect the next time your agent arms.</p>
    </div>
  );
}
