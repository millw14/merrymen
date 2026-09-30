/**
 * A NAME FOR AN AGENT NOBODY NAMED.
 *
 * Every agent used to start as "Robin" — the soul's default, the ledger
 * column's default, the feed's fallback — so the public surfaces filled with
 * clones: the same word, the same initials tile, the same three refusal rows
 * that were really three different agents. An owner who never reached the name
 * field had no way to know their agent was indistinguishable from a dozen
 * others.
 *
 * SEEDED ON THE SLUG, NOT ON ANYTHING THE OWNER TYPED. The slug is the one
 * public id that is minted once and never changes (identity-store.ts), so the
 * same agent gets the same suggestion on every screen and every visit, and the
 * web tier can compute it without a round trip. Two processes that agree on the
 * slug agree on the name.
 *
 * A SUGGESTION AND A FIRST NAME, NEVER A RENAME. The grants route writes it
 * only for a brand-new agent that arrived with no name at all; an existing
 * "Robin" keeps its name until its owner taps the chip that offers this one.
 * Renaming somebody's agent behind their back would be its own kind of
 * identity bug.
 *
 * The words are woodland and Sherwood, and deliberately say nothing about
 * money: no Gold, no Lucky, no Whale, no Bull. A name sits next to an agent's
 * figures on a page that ranks people, and a name that implies a result is a
 * claim nobody measured. Product words (Scout, Snipe, Shadow, Steady) are out
 * too — each one already means something on this screen.
 *
 * PURE and dependency-free, so the grants route, the Agent screen and a test
 * all run the identical function.
 */

/**
 * The stock name an agent carries until somebody names it.
 *
 * ONE DEFINITION: the worker soul re-exports this as DEFAULT_NAME, and the
 * Agent screen compares against it to decide whether to offer a name. If the
 * two drifted, the chip would either vanish for every unnamed agent or nag
 * every named one.
 */
export const DEFAULT_AGENT_NAME = "Robin";

/**
 * A NAME IS WRITTEN IN THE OWNER'S OWN ALPHABET.
 *
 * ONE DEFINITION, for the soul (worker/src/soul.ts, which imports it by
 * relative path) and for every web writer (lib/agent-name-rule.ts re-exports
 * it). It used to be two byte-identical copies held together by a test that
 * read the soul's source, and when the copies disagreed the worker won and
 * silently kept the old name while the settings save had said it succeeded.
 *
 * This was `[A-Za-z0-9]`, which refused José, Müller, Łukasz, Робин, 小红,
 * रोबिन and رَوبِن — and refused them at the END of the create wizard, in the
 * same request that carried the strategy, the caps and the paper/live choice,
 * so one accent discarded the whole form. The message said "letters and
 * numbers", which is worse than unhelpful: é IS a letter, so a reader who
 * complied failed again.
 *
 * `\p{M}` is not decoration. Devanagari, Thai, Bengali, Tamil and vowelled
 * Arabic carry combining marks that NFC does not compose away, so a rule of
 * letters-and-numbers alone still refuses रोबिन and โรบิน. U+200C and U+200D
 * are admitted for the same reason: Persian and several Indic orthographies
 * need them inside a single word.
 *
 * Everything else stays excluded, which keeps out the thing that actually
 * matters — `\p{Cf}` bidi overrides, whose whole purpose is to make text
 * display as something other than what it is.
 *
 * AT LEAST ONE LETTER, which is the lookahead. A name renders beside an
 * agent's return on a page that ranks people, and "99.5" or "1000" there reads
 * as a figure nobody measured. Digits are still welcome inside a name that has
 * a letter — "R2", "Agent 47". This is the rule for a name somebody is
 * CHOOSING NOW (chat /name, the settings form, the wizard, partner
 * enrollment). A name already stored is held to STORED_AGENT_NAME_RE instead.
 */
export const AGENT_NAME_RE = /^(?=\P{L}*\p{L})[\p{L}\p{N}][\p{L}\p{N}\p{M}\p{Join_Control} '.-]{0,23}$/u;

/**
 * THE RULE A NAME WAS STORED UNDER — everything above except the letter.
 *
 * Agents were named "007" before the letter rule existed, and the owner's rule
 * is that an existing agent is not renamed. Read back through AGENT_NAME_RE,
 * "007" comes out as the default: the reconcile would refuse the configured
 * "007" and tell the owner the agent "is still called Robin", which is false,
 * and the first re-arm — every restart is one — would write "Robin" onto the
 * roster while the owner's own feed and the Brain persona still said 007. So
 * reading the identity file, carrying a name settings already holds into it,
 * and re-saving a settings form that still carries it all use this; only a
 * name typed now meets the letter rule.
 *
 * Everything else still applies to a stored name: a bidi override, a leading
 * mark or twenty-five characters are refused however they were stored.
 */
export const STORED_AGENT_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}\p{M}\p{Join_Control} '.-]{0,23}$/u;

/**
 * THE SHAPE A NAME IS STORED IN, on both sides of the reconcile.
 *
 * NFC, because a decomposed "José" and a precomposed one are the same name and
 * only one of them is 4 characters; and whitespace collapsed, because a name
 * stored with a double space by one tier and collapsed by the other would never
 * compare equal — `cfg.agentName !== getName()` true forever, an identity-file
 * rewrite on every reconcile, silently, because the write itself succeeds.
 */
export function normalizeAgentName(raw: string): string {
  return raw.normalize("NFC").trim().replace(/\s+/g, " ");
}

const ADJECTIVES = [
  "Amber", "Ashen", "Autumn", "Birch", "Blue", "Bold", "Brindle", "Brisk",
  "Bronze", "Calm", "Cedar", "Clever", "Cobalt", "Copper", "Crimson", "Dapple",
  "Dawn", "Dusky", "Ember", "Evening", "Fallow", "Fennel", "Flint", "Frosty",
  "Gentle", "Granite", "Green", "Grey", "Hazel", "Heather", "Honey", "Hushed",
  "Indigo", "Iron", "Jolly", "Juniper", "Keen", "Larch", "Linden", "Lone",
  "Maple", "Marsh", "Meadow", "Merry", "Midnight", "Misty", "Morning", "Mossy",
  "Nimble", "Northern", "Ochre", "Olive", "Pale", "Pine", "Plum", "Quick",
  "Quiet", "Rainy", "Restless", "Rowan", "Ruddy", "Russet", "Rusty", "Sable",
  "Saffron", "Scarlet", "Silver", "Sly", "Smoky", "Snowy", "Sorrel", "Stormy",
  "Sunny", "Swift", "Tawny", "Thistle", "Umber", "Velvet", "Wandering", "Wild",
  "Windy", "Winter", "Wry",
] as const;

const NOUNS = [
  "Archer", "Badger", "Bard", "Bittern", "Bowman", "Brook", "Crane", "Crow",
  "Curlew", "Dormouse", "Drake", "Falcon", "Ferret", "Finch", "Fletcher", "Forester",
  "Fox", "Friar", "Glen", "Goshawk", "Grouse", "Hare", "Harrier", "Hart",
  "Hawk", "Hedgehog", "Heron", "Hound", "Jackdaw", "Jay", "Kestrel", "Kingfisher",
  "Kite", "Lark", "Linnet", "Lynx", "Magpie", "Mallard", "Marten", "Merlin",
  "Minstrel", "Mole", "Moth", "Newt", "Nightjar", "Otter", "Owl", "Pedlar",
  "Pike", "Piper", "Plover", "Quail", "Rambler", "Raven", "Rook", "Shrike",
  "Siskin", "Skylark", "Sparrow", "Squire", "Stag", "Starling", "Stoat", "Swallow",
  "Tanner", "Teal", "Thrush", "Tinker", "Vole", "Wagtail", "Warbler", "Weasel",
  "Wolf", "Woodpecker", "Wren", "Yeoman",
] as const;

/** Read-only view of the word lists, for tests that run every combination. */
export const GENERATED_NAME_PARTS: { readonly adjectives: readonly string[]; readonly nouns: readonly string[] } = {
  adjectives: ADJECTIVES,
  nouns: NOUNS,
};

/**
 * FNV-1a, 32-bit, then murmur3's finaliser. Not cryptographic and not trying
 * to be: nobody gains anything by steering their own suggestion, and a slug is
 * already 80 random bits. The finaliser just keeps nearby slugs from landing on
 * nearby names.
 */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/**
 * "Amber Heron" for one slug, forever. Null when there is no slug to seed on.
 *
 * NULL RATHER THAN A FALLBACK: a blank seed would hand every slug-less caller
 * the same generated name, which is the clone this exists to end.
 *
 * Every combination is two words of letters, at most 20 characters, so it
 * passes the soul's name rule in both of its copies — identity.test.ts runs
 * every one of them through both.
 */
export function agentNameForSlug(slug: string): string | null {
  const seed = slug.trim().toLowerCase();
  if (!seed) return null;
  const h = hash(seed);
  // Mixed radix: the adjective is the low digit and the noun the next one, so
  // every (adjective, noun) pair owns its own slice of the hash and the whole
  // grid is reachable rather than one list's worth of it.
  const adjective = ADJECTIVES[h % ADJECTIVES.length]!;
  const noun = NOUNS[Math.floor(h / ADJECTIVES.length) % NOUNS.length]!;
  return `${adjective} ${noun}`;
}
