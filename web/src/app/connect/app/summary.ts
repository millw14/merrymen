/**
 * The consent screen's one-glance summary, as pure functions so they can be
 * tested without a browser: which boxes the page starts with ticked, and what
 * the owner is about to allow, grouped under a verb ("See", "Do", "Suggest,
 * only with your approval") in words rather than a list of twelve permissions.
 *
 * The summary is a reading of the ticked boxes, never a separate choice: what
 * is sent on Allow is still exactly the ticked boxes.
 */

export type ScopeLevel = "read" | "write" | "sensitive" | "staff";

export interface SummaryScope {
  id: string;
  level: ScopeLevel;
  /** The scope's short lowercase phrase (scopes.ts), read after its group's label. */
  phrase: string;
  needsAgent: boolean;
}

export interface SummaryGroup {
  level: ScopeLevel;
  label: string;
  /** The group's phrases as one list: "a, b and c". */
  text: string;
}

const GROUPS: ReadonlyArray<{ level: ScopeLevel; label: string }> = [
  { level: "read", label: "See" },
  { level: "write", label: "Do" },
  { level: "sensitive", label: "Suggest, only with your approval" },
  { level: "staff", label: "Staff tools" },
];

/**
 * A sensitive scope whose actions are not ALL proposals is split: the part
 * that happens at once is listed under "Do", and only the rest under "only
 * with your approval". social:write follows and unfollows agents with no
 * approval page, and only its posts wait for the owner (the full list's
 * scopeBadge says the same); listing all of it under "only with your
 * approval" would promise an approval that never comes.
 */
const SPLIT: Readonly<Record<string, { atOnce: string; approved: string }>> = {
  "social:write": { atOnce: "following public agents", approved: "draft posts" },
};

/**
 * "a", "a and b", "a, b and c". When a phrase has its own "and" ("your
 * portfolio and trades"), "and" cannot also join the list without blurring
 * where one item ends, so the items are separated by semicolons instead.
 */
export function joinPhrases(list: readonly string[]): string {
  if (list.length <= 1) return list[0] ?? "";
  if (list.some((p) => / and /.test(p))) return list.join("; ");
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

/**
 * What the ticked boxes allow, one group per level in a fixed order, empty
 * groups left out. A permission that needs an agent counts only when an agent
 * is ticked too: the checklist disables it without one, and the server grants
 * it as nothing (decideRequest drops agent scopes when no agent is shared).
 */
export function accessSummary(scopes: readonly SummaryScope[], selected: ReadonlySet<string>, anyAgent: boolean): SummaryGroup[] {
  const phrases = new Map<ScopeLevel, string[]>(GROUPS.map((g) => [g.level, []]));
  const atOnce: string[] = [];
  for (const s of scopes) {
    if (!selected.has(s.id) || (s.needsAgent && !anyAgent)) continue;
    const split = s.level === "sensitive" ? SPLIT[s.id] : undefined;
    if (split) {
      atOnce.push(split.atOnce);
      phrases.get("sensitive")!.push(split.approved);
    } else {
      phrases.get(s.level)?.push(s.phrase);
    }
  }
  phrases.get("write")!.push(...atOnce);
  return GROUPS.filter((g) => phrases.get(g.level)!.length > 0)
    .map((g) => ({ level: g.level, label: g.label, text: joinPhrases(phrases.get(g.level)!) }));
}

export interface SelectionView {
  scopes: ReadonlyArray<{ id: string; needsAgent: boolean; defaultOn: boolean }>;
  agents: ReadonlyArray<{ slug: string }>;
  /** The owner's active connection with this app, cut down by the server (ConsentView.previous). */
  previous?: { scopes: readonly string[]; agentSlugs: readonly string[] } | null;
}

export interface Selection {
  scopes: Set<string>;
  agents: Set<string>;
  /** The page started from the owner's current connection, not the defaults. */
  fromPrevious: boolean;
}

/**
 * Which boxes the page starts with ticked.
 *
 * A reconnect starts from what the owner's current connection with this app
 * holds, because approving overwrites that connection: starting from the
 * defaults would silently drop a sensitive permission the owner ticked
 * before. Otherwise the defaults: every default-on permission, every agent.
 *
 * The previous choice is used only when it still grants something. A
 * connection made without the owner's only agent (they left it unshared, or
 * connected before it existed) keeps it unshared, but its default agent
 * permissions start ticked too: they grant nothing without the agent (the
 * summary leaves them out and the server drops them), and ticking the card's
 * Share box is then all it takes to add the agent with the usual access.
 */
export function initialSelection(view: SelectionView): Selection {
  const defaults: Selection = {
    scopes: new Set(view.scopes.filter((s) => s.defaultOn).map((s) => s.id)),
    agents: new Set(view.agents.map((a) => a.slug)),
    fromPrevious: false,
  };
  const previous = view.previous;
  if (!previous) return defaults;
  // The server already cut these down; checked again so an unexpected id can never be ticked.
  const offered = new Map(view.scopes.map((s) => [s.id, s]));
  const owned = new Set(view.agents.map((a) => a.slug));
  const scopes = previous.scopes.filter((id) => offered.has(id));
  const agents = previous.agentSlugs.filter((slug) => owned.has(slug));
  if (!scopes.some((id) => agents.length > 0 || !offered.get(id)!.needsAgent)) return defaults;
  if (view.agents.length === 1 && agents.length === 0) {
    const agentDefaults = view.scopes.filter((s) => s.defaultOn && s.needsAgent).map((s) => s.id);
    return { scopes: new Set([...scopes, ...agentDefaults]), agents: new Set(), fromPrevious: true };
  }
  return { scopes: new Set(scopes), agents: new Set(agents), fromPrevious: true };
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

/**
 * The small line under the summary when the page started from the current
 * connection, shown only while the ticked boxes are still exactly that
 * (after a change it would no longer be true). `partial` means the current
 * connection holds a permission this request does not offer, so approving
 * removes it and "same access" would not be true either.
 */
export function previousNote(start: Selection, current: { scopes: ReadonlySet<string>; agents: ReadonlySet<string> }, partial: boolean, appName: string): string | null {
  if (!start.fromPrevious || !sameSet(current.scopes, start.scopes) || !sameSet(current.agents, start.agents)) return null;
  return partial ? `Same access as your current connection, except what ${appName} no longer asks for.` : "Same access as your current connection.";
}
