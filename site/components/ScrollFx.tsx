"use client";

import { useEffect } from "react";

/**
 * The site's motion layer — all original. One mounted instance wires up:
 *   • scroll-reveal   — [data-reveal] elements fade / rise / wipe in as they enter view
 *   • nav state       — the header gains .scrolled once the page moves
 *   • magnetic        — [data-magnetic] wrappers drift toward the cursor
 * Everything is gated behind prefers-reduced-motion and a .fx-ready class, so
 * with JS off or motion reduced the page renders fully visible and static.
 */
export function ScrollFx() {
  useEffect(() => {
    const root = document.documentElement;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;

    root.classList.add("fx-ready");

    // ── scroll-reveal ────────────────────────────────────────────────────
    const revealEls = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]"));
    let io: IntersectionObserver | null = null;
    if ("IntersectionObserver" in window) {
      io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (e.isIntersecting) {
              e.target.classList.add("is-in");
              io?.unobserve(e.target);
            }
          }
        },
        { rootMargin: "0px 0px -10% 0px", threshold: 0.12 },
      );
      revealEls.forEach((el) => io!.observe(el));
    } else {
      // no observer support — just show everything
      revealEls.forEach((el) => el.classList.add("is-in"));
    }

    // ── nav scrolled state ───────────────────────────────────────────────
    const nav = document.querySelector(".nav");
    const onScroll = () => nav?.classList.toggle("scrolled", window.scrollY > 6);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });

    // ── magnetic wrappers ────────────────────────────────────────────────
    const mags = Array.from(document.querySelectorAll<HTMLElement>("[data-magnetic]"));
    const magCleanups: Array<() => void> = [];
    for (const el of mags) {
      const strength = 0.3;
      const cap = 12; // px — never drift further than this
      let raf = 0;
      const clamp = (v: number) => Math.max(-cap, Math.min(cap, v));
      const onMove = (ev: PointerEvent) => {
        const r = el.getBoundingClientRect();
        const dx = clamp((ev.clientX - (r.left + r.width / 2)) * strength);
        const dy = clamp((ev.clientY - (r.top + r.height / 2)) * strength);
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          el.style.transform = `translate(${dx.toFixed(2)}px, ${dy.toFixed(2)}px)`;
        });
      };
      const onLeave = () => {
        if (raf) cancelAnimationFrame(raf);
        el.style.transform = "";
      };
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerleave", onLeave);
      magCleanups.push(() => {
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerleave", onLeave);
      });
    }

    return () => {
      io?.disconnect();
      window.removeEventListener("scroll", onScroll);
      magCleanups.forEach((c) => c());
    };
  }, []);

  return null;
}
