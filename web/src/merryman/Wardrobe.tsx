"use client";
/**
 * THE WARDROBE: DRESS YOUR MERRYMAN.
 *
 * One stage, five drawers. Every change is drawn immediately and the merryman
 * reacts to it — tips the new hat, twirls in the new cape, looses an arrow from
 * the new bow — because a dressing room where the model stands still is a form.
 * Nothing is saved until Save; "Surprise me" rolls a whole look.
 *
 * Used standalone at /wardrobe and embedded as the first step of creating an
 * agent (`embedded`), where Save is the step's Continue.
 */
import { Dices, RotateCcw, Sparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { EMOTES } from "./clips";
import { Merryman, MerrymanPortrait, type Cue } from "./Merryman";
import {
  AURAS, BACKS, BEARDS, CAPES, CLOTH, EYES, EYEWEAR, HAIR, HATS, HELD, LEATHER, PETS, SKIN, STYLES,
  SLOT_LABELS, outfitKey, parseOutfit, randomOutfit, type Choice, type ColorSlot, type Outfit, type ShapeSlot, type Swatch,
} from "./outfit";

/**
 * LOOKS TO TRY: whole outfits, one tap each, for somebody who would rather
 * pick than build. Fixed rather than random, so the row is the same every
 * visit and a favourite can be found again.
 */
const LOOKS: { name: string; outfit: Outfit }[] = [
  { name: "Robin", outfit: parseOutfit({ hat: "feather", style: "tunic", cape: "none", held: "bow", back: "quiver", cloth: "forest", trim: "gold", hatColor: "forest", skin: "peach", hair: "chestnut", aura: "fireflies" }) },
  { name: "The King", outfit: parseOutfit({ hat: "crown", style: "robe", cape: "long", held: "staff", back: "none", cloth: "royal", trim: "gold", skin: "porcelain", hair: "silver", beard: "full", aura: "sparkles" }) },
  { name: "Night Owl", outfit: parseOutfit({ hat: "hood", style: "hoodie", cape: "none", held: "lantern", back: "backpack", cloth: "midnight", trim: "teal", hatColor: "midnight", skin: "umber", hair: "black", eyewear: "visor", pet: "owl", aura: "embers" }) },
  { name: "The Banker", outfit: parseOutfit({ hat: "tophat", style: "suit", cape: "none", held: "coinbag", back: "none", cloth: "charcoal", trim: "crimson", skin: "honey", hair: "black", beard: "mustache", eyewear: "monocle", aura: "coins" }) },
  { name: "Sir Shield", outfit: parseOutfit({ hat: "viking", style: "armor", cape: "short", held: "shield", back: "none", cloth: "crimson", trim: "crimson", skin: "caramel", hair: "ginger", beard: "goatee", aura: "none" }) },
  { name: "The Wizard", outfit: parseOutfit({ hat: "wizard", style: "robe", cape: "none", held: "staff", back: "none", cloth: "plum", trim: "gold", hatColor: "plum", skin: "sky", hair: "silver", beard: "full", pet: "frog", aura: "sparkles" }) },
];
import { useOutfit } from "./wardrobe-store";

type Drawer = "look" | "face" | "colours" | "extras" | "moves";
const DRAWERS: { id: Drawer; label: string }[] = [
  { id: "look", label: "Look" },
  { id: "face", label: "Face" },
  { id: "colours", label: "Colours" },
  { id: "extras", label: "Extras" },
  { id: "moves", label: "Moves" },
];

const SHAPES: Record<Exclude<Drawer, "colours" | "moves">, [ShapeSlot, readonly Choice[]][]> = {
  look: [["hat", HATS], ["style", STYLES], ["cape", CAPES], ["held", HELD], ["back", BACKS]],
  face: [["beard", BEARDS], ["eyewear", EYEWEAR]],
  extras: [["aura", AURAS], ["pet", PETS]],
};
const COLOURS: Record<"face" | "colours", [ColorSlot, readonly Swatch[]][]> = {
  face: [["skin", SKIN], ["hair", HAIR], ["eyes", EYES]],
  colours: [["cloth", CLOTH], ["trim", CLOTH], ["hatColor", CLOTH], ["leather", LEATHER]],
};

/** How he shows off the thing you just picked. */
function reactionTo(slot: ShapeSlot | ColorSlot, value: string): string {
  if (slot === "hat") return value === "none" ? "scratchHead" : "hatTip";
  if (slot === "held") return value === "bow" ? "shoot" : value === "coinbag" ? "coinToss" : value === "sword" || value === "shield" ? "flex" : "thumbsUp";
  if (slot === "style" || slot === "cape" || slot === "back") return "spin";
  if (slot === "beard") return "nodYes";
  if (slot === "eyewear") return "thumbsUp";
  if (slot === "aura") return "celebrate";
  if (slot === "pet") return value === "none" ? "shrug" : "wave";
  return "hop";
}

export function Wardrobe({
  id,
  seed,
  name,
  embedded = false,
  saveLabel = "Save look",
  onSaved,
}: {
  /** Whose wardrobe: an agent slug, or DRAFT before the agent exists. */
  id: string;
  seed: string;
  name: string;
  embedded?: boolean;
  saveLabel?: string;
  onSaved?: (o: Outfit) => void;
}) {
  const stored = useOutfit(id, seed);
  const [draft, setDraft] = useState<Outfit>(stored.outfit);
  const [drawer, setDrawer] = useState<Drawer>("look");
  const [cue, setCue] = useState<Cue | null>(null);
  const [saved, setSaved] = useState<"idle" | "saved" | "failed">("idle");
  const storedKey = outfitKey(stored.outfit);
  // A save from another tab, or the first read of storage after hydration.
  useEffect(() => { setDraft(stored.outfit); }, [storedKey]);
  const dirty = outfitKey(draft) !== storedKey || !stored.custom;
  const play = (clip: string) => setCue({ key: `${clip}:${Date.now()}`, clip });

  const set = (slot: ShapeSlot | ColorSlot, value: string) => {
    setDraft((d) => ({ ...d, [slot]: value }));
    setSaved("idle");
    play(reactionTo(slot, value));
  };
  const surprise = () => {
    setDraft(randomOutfit());
    setSaved("idle");
    play("backflip");
  };
  const reset = () => {
    setDraft(stored.outfit);
    setSaved("idle");
    play("shrug");
  };
  const save = () => {
    const ok = stored.save(draft);
    setSaved(ok ? "saved" : "failed");
    play(ok ? "celebrate" : "facepalm");
    if (ok) onSaved?.(draft);
  };

  const bubble = saved === "saved" ? `Lookin' sharp! ${name} loves it.` : saved === "failed" ? "Couldn't save in this browser — the look still works here." : null;
  const moves = useMemo(() => EMOTES.filter((c) => c.id !== "model"), []);

  return (
    <section className={`mm-wardrobe${embedded ? " is-embedded" : ""}`} aria-label={`Dress ${name}`}>
      <div className="mm-wardrobe-stage">
        <Merryman outfit={draft} base="model" cue={cue} label={`${name}, your merryman`} bubble={bubble} bubbleTone={saved === "failed" ? "warn" : "good"} />
        <p className="mm-wardrobe-hint">Drag to spin him. Tap him to say hi.</p>
      </div>
      <div className="mm-wardrobe-panel">
        {!embedded && (
          <header className="mm-wardrobe-head">
            <h1>Dress {name}</h1>
            <p>Pick a look. Your merryman wears it everywhere: on Home, in chat and on the leaderboard in this browser.</p>
          </header>
        )}
        <div className="mm-looks" aria-label="Looks to try">
          {LOOKS.map((l) => (
            <button key={l.name} type="button" className={outfitKey(l.outfit) === outfitKey(draft) ? "on" : ""} aria-pressed={outfitKey(l.outfit) === outfitKey(draft)} onClick={() => { setDraft(l.outfit); setSaved("idle"); play("spin"); }}>
              <MerrymanPortrait outfit={l.outfit} size={56} />
              <span>{l.name}</span>
            </button>
          ))}
        </div>
        <div className="mm-drawers" role="tablist" aria-label="Wardrobe sections">
          {DRAWERS.map((d) => (
            <button key={d.id} type="button" role="tab" aria-selected={drawer === d.id} className={drawer === d.id ? "on" : ""} onClick={() => setDrawer(d.id)}>
              {d.label}
            </button>
          ))}
        </div>
        <div className="mm-drawer" role="tabpanel">
          {drawer === "moves" ? (
            <div className="mm-moves">
              <p className="mm-slot-label">Tap a move. He knows {moves.length} of them.</p>
              <div className="mm-move-grid">
                {moves.map((c) => (
                  <button key={c.id} type="button" className={c.loop ? "is-loop" : ""} onClick={() => play(c.id)}>
                    {c.label}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <>
              {drawer !== "colours" && SHAPES[drawer].map(([slot, list]) => (
                <fieldset key={slot} className="mm-slot">
                  <legend className="mm-slot-label">{SLOT_LABELS[slot]}</legend>
                  <div className="mm-chips">
                    {list.map((c) => (
                      <button key={c.id} type="button" aria-pressed={draft[slot] === c.id} className={draft[slot] === c.id ? "on" : ""} onClick={() => set(slot, c.id)}>
                        {c.label}
                      </button>
                    ))}
                  </div>
                </fieldset>
              ))}
              {(drawer === "face" || drawer === "colours") && COLOURS[drawer].map(([slot, list]) => (
                <fieldset key={slot} className="mm-slot">
                  <legend className="mm-slot-label">{SLOT_LABELS[slot]}</legend>
                  <div className="mm-swatches">
                    {list.map((c) => (
                      <button key={c.id} type="button" title={c.label} aria-label={c.label} aria-pressed={draft[slot] === c.id} className={draft[slot] === c.id ? "on" : ""} style={{ ["--sw" as string]: c.hex }} onClick={() => set(slot, c.id)} />
                    ))}
                  </div>
                </fieldset>
              ))}
            </>
          )}
        </div>
        <div className="mm-wardrobe-actions">
          <button type="button" className="mm-btn ghost" onClick={surprise}><Dices size={16} aria-hidden /> Surprise me</button>
          <button type="button" className="mm-btn ghost" onClick={reset} disabled={!dirty}><RotateCcw size={16} aria-hidden /> Undo</button>
          <button type="button" className="mm-btn primary" onClick={save} disabled={!dirty}><Sparkles size={16} aria-hidden /> {saveLabel}</button>
        </div>
      </div>
    </section>
  );
}
