/**
 * WHAT A MERRYMAN IS WEARING, AS PLAIN DATA.
 *
 * The character is the face of an agent, so the outfit has to be three things
 * at once: something an owner picks in the wardrobe, something every OTHER
 * agent on the board has without anyone picking it, and something the renderer
 * can draw without trusting a single field of it.
 *
 * - The catalog below is the whole vocabulary. An id that is not in it is not
 *   an outfit, it is noise, and `parseOutfit` replaces it with the default for
 *   that slot rather than handing the renderer a string it has never seen.
 * - `seededOutfit` gives every agent a stable look from its public slug — the
 *   same rule the 2D face follows (lib/agent-avatar.ts): a board where faces
 *   change between visits is a board nobody learns to read.
 *
 * No three.js in here. It is imported by the wardrobe UI, the tests and the
 * share card, none of which should pull a WebGL library to read a colour.
 */

export type Choice = { id: string; label: string };
export type Swatch = Choice & { hex: string };

export const HATS = [
  { id: "feather", label: "Feathered cap" },
  { id: "hood", label: "Hood" },
  { id: "crown", label: "Crown" },
  { id: "wizard", label: "Wizard hat" },
  { id: "beanie", label: "Beanie" },
  { id: "tophat", label: "Top hat" },
  { id: "viking", label: "Horned helm" },
  { id: "bandana", label: "Bandana" },
  { id: "halo", label: "Halo" },
  { id: "none", label: "No hat" },
] as const satisfies readonly Choice[];

export const STYLES = [
  { id: "tunic", label: "Tunic" },
  { id: "armor", label: "Armour" },
  { id: "robe", label: "Robe" },
  { id: "hoodie", label: "Hoodie" },
  { id: "suit", label: "Suit" },
] as const satisfies readonly Choice[];

export const CAPES = [
  { id: "none", label: "No cape" },
  { id: "short", label: "Short cape" },
  { id: "long", label: "Long cape" },
] as const satisfies readonly Choice[];

export const HELD = [
  { id: "bow", label: "Longbow" },
  { id: "sword", label: "Sword" },
  { id: "staff", label: "Staff" },
  { id: "lantern", label: "Lantern" },
  { id: "coinbag", label: "Coin bag" },
  { id: "mug", label: "Mug" },
  { id: "shield", label: "Shield" },
  { id: "none", label: "Empty hands" },
] as const satisfies readonly Choice[];

export const BACKS = [
  { id: "quiver", label: "Quiver" },
  { id: "backpack", label: "Backpack" },
  { id: "wings", label: "Wings" },
  { id: "none", label: "Nothing" },
] as const satisfies readonly Choice[];

export const BEARDS = [
  { id: "none", label: "Clean shaven" },
  { id: "stubble", label: "Stubble" },
  { id: "full", label: "Full beard" },
  { id: "mustache", label: "Moustache" },
  { id: "goatee", label: "Goatee" },
] as const satisfies readonly Choice[];

export const EYEWEAR = [
  { id: "none", label: "None" },
  { id: "round", label: "Round glasses" },
  { id: "shades", label: "Shades" },
  { id: "monocle", label: "Monocle" },
  { id: "visor", label: "Visor" },
] as const satisfies readonly Choice[];

export const AURAS = [
  { id: "fireflies", label: "Fireflies" },
  { id: "sparkles", label: "Sparkles" },
  { id: "leaves", label: "Leaves" },
  { id: "embers", label: "Embers" },
  { id: "coins", label: "Coins" },
  { id: "none", label: "None" },
] as const satisfies readonly Choice[];

export const PETS = [
  { id: "none", label: "No pet" },
  { id: "fox", label: "Fox" },
  { id: "owl", label: "Owl" },
  { id: "frog", label: "Frog" },
] as const satisfies readonly Choice[];

export const CLOTH: readonly Swatch[] = [
  { id: "forest", label: "Forest", hex: "#2f7d4a" },
  { id: "moss", label: "Moss", hex: "#7a9a3a" },
  { id: "crimson", label: "Crimson", hex: "#b3333b" },
  { id: "royal", label: "Royal", hex: "#3157b8" },
  { id: "midnight", label: "Midnight", hex: "#23284a" },
  { id: "gold", label: "Gold", hex: "#d6a332" },
  { id: "plum", label: "Plum", hex: "#7b3f8f" },
  { id: "charcoal", label: "Charcoal", hex: "#3a3d42" },
  { id: "sand", label: "Sand", hex: "#cdb48a" },
  { id: "snow", label: "Snow", hex: "#e8e6e0" },
  { id: "teal", label: "Teal", hex: "#1f8f8a" },
  { id: "tangerine", label: "Tangerine", hex: "#e07a2e" },
];

export const SKIN: readonly Swatch[] = [
  { id: "porcelain", label: "Porcelain", hex: "#f6dcc8" },
  { id: "peach", label: "Peach", hex: "#efc3a0" },
  { id: "honey", label: "Honey", hex: "#d9a273" },
  { id: "caramel", label: "Caramel", hex: "#b77c4f" },
  { id: "umber", label: "Umber", hex: "#8a5534" },
  { id: "cocoa", label: "Cocoa", hex: "#5e3a24" },
  { id: "moss", label: "Goblin", hex: "#8fb46a" },
  { id: "sky", label: "Sprite", hex: "#8fb8e0" },
];

export const HAIR: readonly Swatch[] = [
  { id: "chestnut", label: "Chestnut", hex: "#6b3e22" },
  { id: "black", label: "Black", hex: "#1f1a17" },
  { id: "blonde", label: "Blonde", hex: "#d9b45a" },
  { id: "ginger", label: "Ginger", hex: "#c2552a" },
  { id: "silver", label: "Silver", hex: "#c9c9cf" },
  { id: "mint", label: "Mint", hex: "#5fd4a8" },
  { id: "rose", label: "Rose", hex: "#e07aa8" },
];

export const LEATHER: readonly Swatch[] = [
  { id: "brown", label: "Brown", hex: "#5a3a22" },
  { id: "tan", label: "Tan", hex: "#9a6a3c" },
  { id: "black", label: "Black", hex: "#222222" },
  { id: "oxblood", label: "Oxblood", hex: "#5c1e22" },
  { id: "moss", label: "Moss", hex: "#3d4a26" },
];

export const EYES: readonly Swatch[] = [
  { id: "ink", label: "Ink", hex: "#1a1a1f" },
  { id: "hazel", label: "Hazel", hex: "#6b4a1f" },
  { id: "emerald", label: "Emerald", hex: "#1f7a4a" },
  { id: "ocean", label: "Ocean", hex: "#1f4f8a" },
  { id: "amber", label: "Amber", hex: "#c27a1a" },
];

type Ids<T extends readonly Choice[]> = T[number]["id"];

export type Outfit = {
  v: 1;
  hat: Ids<typeof HATS>;
  style: Ids<typeof STYLES>;
  cape: Ids<typeof CAPES>;
  held: Ids<typeof HELD>;
  back: Ids<typeof BACKS>;
  beard: Ids<typeof BEARDS>;
  eyewear: Ids<typeof EYEWEAR>;
  aura: Ids<typeof AURAS>;
  pet: Ids<typeof PETS>;
  cloth: string;
  trim: string;
  hatColor: string;
  skin: string;
  hair: string;
  leather: string;
  eyes: string;
};

/** The classic: a green tunic, a feathered cap and a longbow. */
export const DEFAULT_OUTFIT: Outfit = {
  v: 1,
  hat: "feather",
  style: "tunic",
  cape: "none",
  held: "bow",
  back: "quiver",
  beard: "none",
  eyewear: "none",
  aura: "fireflies",
  pet: "none",
  cloth: "forest",
  trim: "gold",
  hatColor: "forest",
  skin: "peach",
  hair: "chestnut",
  leather: "brown",
  eyes: "ink",
};

/** Every slot the wardrobe offers, in the order its tabs show them. */
export const SLOTS = {
  hat: HATS,
  style: STYLES,
  cape: CAPES,
  held: HELD,
  back: BACKS,
  beard: BEARDS,
  eyewear: EYEWEAR,
  aura: AURAS,
  pet: PETS,
} as const;

export const COLOR_SLOTS = {
  cloth: CLOTH,
  trim: CLOTH,
  hatColor: CLOTH,
  skin: SKIN,
  hair: HAIR,
  leather: LEATHER,
  eyes: EYES,
} as const;

export type ShapeSlot = keyof typeof SLOTS;
export type ColorSlot = keyof typeof COLOR_SLOTS;

const has = (list: readonly Choice[], id: unknown): id is string =>
  typeof id === "string" && list.some((c) => c.id === id);

/**
 * AN OUTFIT FROM ANYTHING. localStorage is user-writable and a future server
 * field will be too, so every slot is checked against the catalog and anything
 * unrecognised falls back to the default for that slot alone — one bad field
 * does not cost the owner the rest of their look.
 */
export function parseOutfit(raw: unknown): Outfit {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const out = { ...DEFAULT_OUTFIT } as Record<string, unknown>;
  for (const [slot, list] of Object.entries(SLOTS)) if (has(list, o[slot])) out[slot] = o[slot];
  for (const [slot, list] of Object.entries(COLOR_SLOTS)) if (has(list, o[slot])) out[slot] = o[slot];
  return out as Outfit;
}

/** The hex for a colour slot, never undefined: the catalog's first entry backs a bad id. */
export function hexOf(slot: ColorSlot, id: string): string {
  const list = COLOR_SLOTS[slot];
  return (list.find((c) => c.id === id) ?? list[0]!).hex;
}

/** A small deterministic PRNG (mulberry32), seeded from a string hash. */
export function rngOf(seed: string): () => number {
  let h = 1779033703 ^ seed.length;
  for (let i = 0; i < seed.length; i++) {
    h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T extends { id: string }>(r: () => number, list: readonly T[]): T["id"] =>
  list[Math.floor(r() * list.length) % list.length]!.id;

/**
 * EVERY AGENT HAS A MERRYMAN, whether or not its owner ever opened the
 * wardrobe. Seeded on the slug (or the name, for a row without one — see
 * faceSeed), so the same agent looks the same on every screen and every visit.
 *
 * Weighted toward the classic look: most of Sherwood wears a hat and carries
 * something, and a board of bare-headed empty-handed figures reads as a bug.
 */
export function seededOutfit(seed: string): Outfit {
  const r = rngOf(`merryman:${seed}`);
  const hat = r() < 0.35 ? "feather" : pick(r, HATS.filter((h) => h.id !== "none"));
  const held = r() < 0.4 ? "bow" : pick(r, HELD);
  return parseOutfit({
    hat,
    style: r() < 0.55 ? "tunic" : pick(r, STYLES),
    cape: r() < 0.6 ? "none" : pick(r, CAPES),
    held,
    back: held === "bow" ? "quiver" : pick(r, BACKS),
    beard: r() < 0.5 ? "none" : pick(r, BEARDS),
    eyewear: r() < 0.75 ? "none" : pick(r, EYEWEAR),
    aura: r() < 0.5 ? "fireflies" : pick(r, AURAS),
    pet: r() < 0.8 ? "none" : pick(r, PETS),
    cloth: pick(r, CLOTH),
    trim: pick(r, CLOTH),
    hatColor: pick(r, CLOTH),
    skin: pick(r, SKIN),
    hair: pick(r, HAIR),
    leather: pick(r, LEATHER),
    eyes: pick(r, EYES),
  });
}

/** A fully random look, for the wardrobe's dice button. */
export function randomOutfit(r: () => number = Math.random): Outfit {
  const out: Record<string, unknown> = { v: 1 };
  for (const [slot, list] of Object.entries(SLOTS)) out[slot] = pick(r, list as readonly Choice[]);
  for (const [slot, list] of Object.entries(COLOR_SLOTS)) out[slot] = pick(r, list);
  return parseOutfit(out);
}

/** A stable key for caching a rendered portrait of this exact look. */
export function outfitKey(o: Outfit): string {
  return [o.hat, o.style, o.cape, o.held, o.back, o.beard, o.eyewear, o.aura, o.pet, o.cloth, o.trim, o.hatColor, o.skin, o.hair, o.leather, o.eyes].join(".");
}

export const SLOT_LABELS: Record<ShapeSlot | ColorSlot, string> = {
  hat: "Hat",
  style: "Outfit",
  cape: "Cape",
  held: "In hand",
  back: "On back",
  beard: "Beard",
  eyewear: "Eyewear",
  aura: "Aura",
  pet: "Pet",
  cloth: "Outfit colour",
  trim: "Trim colour",
  hatColor: "Hat colour",
  skin: "Skin",
  hair: "Hair",
  leather: "Boots and belt",
  eyes: "Eyes",
};
