/** Optional mixed timeline, deterministic across replicas and day boundaries. */
export type TimelineLane = "market" | "hot" | "day" | "question" | "habit" | "thought";
// Twenty slots: market 40%, hot/day 15% each, question/habit/thought 10% each.
export const TIMELINE_ROTATION: readonly TimelineLane[] = ["market", "hot", "market", "day", "market", "thought", "market", "habit", "market", "question", "market", "hot", "market", "day", "market", "thought", "hot", "habit", "question", "day"];

export function timelineLane(tenant: string, day: string, slot: number): TimelineLane {
  let hash = 0;
  for (const c of tenant.toLowerCase()) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  const date = Date.parse(`${day}T00:00:00Z`);
  const ordinal = Number.isFinite(date) ? Math.floor(date / 86_400_000) : 0;
  const index = ((ordinal * 10 + Math.max(0, Math.floor(slot)) + hash) % TIMELINE_ROTATION.length + TIMELINE_ROTATION.length) % TIMELINE_ROTATION.length;
  return TIMELINE_ROTATION[index]!;
}

/** Vetted questions about ideas, never financial choices, holdings or coins. */
export const TIMELINE_QUESTIONS: readonly string[] = [
  "notes everywhere, or a carefully sorted notebook?",
  "does a good explanation need a good metaphor?",
  "which fictional robot has the best sense of humour?",
  "what makes a diagram actually useful?",
  "is an unfinished idea better as a sketch or a paragraph?",
  "how much personality can a cursor have?",
  "can a spreadsheet be oddly comforting?",
  "are footnotes secretly the interesting part?",
  "why do blank notebooks look so full of possibility?",
  "would a robot's autobiography need an index?",
  "when does a doodle become a diagram?",
  "do neat folders make messy thoughts easier?",
  "could a loading bar use a sense of humour?",
  "where does a good analogy stop helping?",
  "should every long explanation come with a sketch?",
  "anyone else think brackets have personality?",
  "tiny details or the overall picture: which catches your attention?",
  "ever wondered what a robot would put in the margins?",
  "perhaps the best interface is a really clear sentence?",
  "plain text has a certain charm, doesn't it?",
  "sometimes the title is harder than the explanation, right?",
  "a glossary with jokes: helpful or distracting?",
  "maybe a good question is its own kind of bookmark?",
  "imagine a dictionary written entirely in diagrams?",
];

export function timelineQuestions(seed: string): string[] {
  let hash = 0;
  for (const c of seed) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  const start = hash % TIMELINE_QUESTIONS.length;
  return [...TIMELINE_QUESTIONS.slice(start), ...TIMELINE_QUESTIONS.slice(0, start)];
}
