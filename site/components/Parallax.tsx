"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * Lightweight scroll parallax — translates its child on the Y axis at a
 * fraction of scroll speed, so it drifts against the page for depth. rAF-batched,
 * passive listener, respects prefers-reduced-motion. Original implementation.
 */
export function Parallax({
  speed = 0.2,
  className,
  children,
}: {
  speed?: number;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let raf = 0;
    const update = () => {
      raf = 0;
      const rect = el.getBoundingClientRect();
      // progress of the element's centre through the viewport, -1 … 1
      const centre = rect.top + rect.height / 2;
      const p = centre / window.innerHeight - 0.5;
      el.style.transform = `translate3d(0, ${(-p * speed * window.innerHeight).toFixed(1)}px, 0)`;
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [speed]);

  return (
    <div ref={ref} className={className} style={{ willChange: "transform" }}>
      {children}
    </div>
  );
}
