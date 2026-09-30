/**
 * A stable face per agent.
 *
 * An agent's face is a seeded gradient plus its initials, with any uploaded
 * image painted over the top. The gradient was seeded on the NAME, which before
 * the identity store existed was the only thing the feed route sent that could
 * seed anything at all — and which made every "Robin" the same colour with the
 * same "RO", so a feed of clones could not be told apart even by eye. It is
 * seeded on the SLUG now wherever the caller passes one (see `faceSeed`) — the
 * terminal Face and AgentAvatar both do; a caller that passes only a name still
 * gets the name's colour. The initials stay the name's, because the name is
 * what a reader reads beside them.
 *
 * DETERMINISTIC IS THE POINT. A feed where faces move between refreshes is a
 * feed nobody learns to read, and recognising an agent at a glance is most of
 * what makes a social product feel social.
 *
 * Pure and dependency-free so it can be called from a server component, a
 * client component and a share-card renderer without any of them differing.
 */

/** A hue in [0, 360). Cheap, stable, and not required to be well-distributed. */
export function hueOf(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
  return h;
}

/** "Will Scarlet" -> "WS", "Much" -> "MU", "" -> "??". */
export function initialsOf(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "??";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

/**
 * The shape of a public id: identity-store.ts `SLUG_RE`, restated because that
 * module reads the filesystem and this one renders in the browser. The
 * agreement is held by agent-avatar.test.ts running the real minter against it.
 */
const PUBLIC_SLUG = /^[0-9a-hjkmnp-tv-z]{16}$/;

/**
 * What to seed an agent's face on: its slug when it has a real one, else its
 * name.
 *
 * THE SLUG, because it is minted once and never changes — renaming an agent
 * keeps its face, and two agents sharing a name no longer share one.
 *
 * ONLY A REAL SLUG. The terminal hands an unlinked leaderboard row the
 * placeholder `unlinked-<index>`, and seeding on that would recolour the face
 * whenever the board reordered. The name is at least stable.
 */
export function faceSeed(name: string, slug?: string | null): string {
  return slug && PUBLIC_SLUG.test(slug) ? slug : name;
}

/** The gradient for an agent's square. Two stops, 42 degrees apart on the wheel. */
export function avatarGradient(seed: string): string {
  const h = hueOf(seed);
  return `linear-gradient(145deg, hsl(${h} 62% 62%), hsl(${(h + 42) % 360} 58% 44%))`;
}
