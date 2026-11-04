/**
 * THE MERRYMAN AS A FLAT PICTURE.
 *
 * Three jobs: the first paint before three.js arrives (so the hero is never an
 * empty box), the whole character on a device without WebGL, and the small
 * face in a list, where a canvas per row would run the browser out of WebGL
 * contexts. Same outfit, same colours, drawn in SVG — it renders on the server
 * and in node tests.
 */
import { hexOf, type Outfit } from "./outfit";

export function MerrymanFlat({ outfit, size = 120, bust = false, className, title }: { outfit: Outfit; size?: number; bust?: boolean; className?: string; title?: string }) {
  const skin = hexOf("skin", outfit.skin);
  const cloth = outfit.style === "armor" ? "#b9c2cc" : hexOf("cloth", outfit.cloth);
  const trim = hexOf("trim", outfit.trim);
  const hat = hexOf("hatColor", outfit.hatColor);
  const hair = hexOf("hair", outfit.hair);
  const leather = hexOf("leather", outfit.leather);
  const ink = "#151216";
  const view = bust ? "18 6 84 84" : "0 0 120 150";
  return (
    <svg className={className} width={size} height={bust ? size : size * 1.25} viewBox={view} role={title ? "img" : undefined} aria-hidden={title ? undefined : true}>
      {title ? <title>{title}</title> : null}
      <g stroke={ink} strokeWidth={2.2} strokeLinejoin="round">
        {!bust && (
          <>
            <ellipse cx="60" cy="144" rx="30" ry="5" fill="rgba(0,0,0,.35)" stroke="none" />
            <rect x="46" y="112" width="11" height="26" rx="5" fill={leather} />
            <rect x="63" y="112" width="11" height="26" rx="5" fill={leather} />
            <path d={outfit.style === "robe" ? "M34 136 L44 78 H76 L86 136 Z" : "M36 118 L44 78 H76 L84 118 Z"} fill={cloth} />
            <rect x="42" y="96" width="36" height="7" rx="3" fill={leather} />
            <rect x="56" y="95" width="8" height="9" rx="2" fill="#e3b341" />
            <rect x="30" y="80" width="12" height="30" rx="6" fill={cloth} />
            <rect x="78" y="80" width="12" height="30" rx="6" fill={cloth} />
            <circle cx="36" cy="112" r="6" fill={skin} />
            <circle cx="84" cy="112" r="6" fill={skin} />
          </>
        )}
        <circle cx="60" cy="52" r="27" fill={skin} />
        <path d="M34 46 Q60 20 86 46 Q80 30 60 28 Q40 30 34 46 Z" fill={hair} />
        {outfit.beard === "full" && <path d="M38 58 Q60 92 82 58 Q78 74 60 76 Q42 74 38 58 Z" fill={hair} />}
        {outfit.beard === "mustache" && <path d="M50 64 Q60 58 70 64" fill="none" stroke={hair} strokeWidth={4} strokeLinecap="round" />}
      </g>
      <circle cx="51" cy="52" r="4" fill={ink} />
      <circle cx="69" cy="52" r="4" fill={ink} />
      <circle cx="52.5" cy="50.5" r="1.3" fill="#fff" />
      <circle cx="70.5" cy="50.5" r="1.3" fill="#fff" />
      <path d="M52 64 Q60 70 68 64" fill="none" stroke={ink} strokeWidth={2.4} strokeLinecap="round" />
      <circle cx="44" cy="60" r="4" fill="#ff7c8a" opacity=".35" />
      <circle cx="76" cy="60" r="4" fill="#ff7c8a" opacity=".35" />
      <g stroke={ink} strokeWidth={2.2} strokeLinejoin="round">
        {outfit.hat === "feather" && (
          <>
            <path d="M30 40 Q60 6 92 34 L84 40 Q60 30 30 40 Z" fill={hat} />
            <path d="M78 26 Q96 4 104 8 Q92 18 82 32 Z" fill={trim} />
          </>
        )}
        {outfit.hat === "hood" && <path d="M28 60 Q26 16 60 16 Q94 16 92 60 Q88 32 60 30 Q32 32 28 60 Z" fill={hat} />}
        {outfit.hat === "crown" && <path d="M40 30 L44 14 L52 24 L60 10 L68 24 L76 14 L80 30 Z" fill="#e3b341" />}
        {outfit.hat === "wizard" && <path d="M26 36 H94 L70 30 L58 0 L48 30 Z" fill={hat} />}
        {outfit.hat === "beanie" && <path d="M32 42 Q32 16 60 16 Q88 16 88 42 Z" fill={hat} />}
        {outfit.hat === "tophat" && <path d="M30 32 H90 V36 H30 Z M44 32 V6 H76 V32 Z" fill="#1c1b22" />}
        {outfit.hat === "viking" && (
          <>
            <path d="M32 40 Q32 18 60 18 Q88 18 88 40 Z" fill="#b9c2cc" />
            <path d="M32 34 Q18 26 20 8 Q28 24 38 28 Z M88 34 Q102 26 100 8 Q92 24 82 28 Z" fill="#efe6cf" />
          </>
        )}
        {outfit.hat === "bandana" && <path d="M33 38 Q60 26 87 38 L87 44 Q60 32 33 44 Z" fill={hat} />}
        {outfit.hat === "halo" && <ellipse cx="60" cy="14" rx="18" ry="5" fill="none" stroke="#ffd34a" strokeWidth={4} />}
      </g>
      {outfit.eyewear === "shades" && <path d="M42 48 H58 V56 H42 Z M62 48 H78 V56 H62 Z" fill="#141418" />}
      {outfit.eyewear === "round" && (
        <g fill="none" stroke="#e3b341" strokeWidth={2}>
          <circle cx="51" cy="52" r="7" />
          <circle cx="69" cy="52" r="7" />
        </g>
      )}
      {outfit.eyewear === "visor" && <rect x="36" y="46" width="48" height="10" rx="5" fill="#26f0c8" opacity=".8" />}
    </svg>
  );
}
