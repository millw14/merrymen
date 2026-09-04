import { beatsOf, lanesOf } from "./beat";
import { useNow } from "./clock";
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
  const now = useNow(1000);
  const lanes = lanesOf(beatsOf(posts, agents), now);
  if (lanes.length === 0) return null;
  return <Wire lanes={lanes} tokens={tokens} now={now} solo onToken={onToken} onAgent={onAgent} />;
}
