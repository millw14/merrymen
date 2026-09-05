import { beatsOf, lanesOf } from "./beat";
import type { LiveAgent, LiveToken, Thesis } from "./live";
import { Wire } from "./wire";

/** The one renderer for "an agent did a thing". Profile and Agent share it. */
export function MoveWire({
  posts,
  agents,
  tokens,
  onToken,
  onAgent,
}: {
  posts: Thesis[];
  agents: LiveAgent[];
  tokens: LiveToken[];
  onToken?: (id: string) => void;
  onAgent?: (slug: string) => void;
}) {
  const lanes = lanesOf(beatsOf(posts, agents));
  if (lanes.length === 0) return null;
  return <Wire lanes={lanes} tokens={tokens} onToken={onToken} onAgent={onAgent} />;
}
