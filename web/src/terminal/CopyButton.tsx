"use client";
import { useEffect, useState } from "react";

/**
 * An address as a reader can check it at a glance: its first and last characters, never its middle. Only for showing.
 * Whatever is copied, linked or signed is always the whole address.
 */
export function shortAddress(address: string, lead = 4, tail = 4): string {
  return address.length > lead + tail + 1 ? `${address.slice(0, lead)}…${address.slice(-tail)}` : address;
}

/**
 * COPY, WITH A WAY OUT.
 *
 * The clipboard is missing on plain http and can refuse (a denied permission, a page that lost focus). The button
 * then says so, and its caller keeps the whole text on screen to select by hand. It never claims a copy that did not
 * happen: an address pasted from a stale clipboard into a deposit is money sent to the wrong place.
 *
 * What it says goes back to its label after two seconds. `said` lets a caller word the three states its own way.
 */
export function CopyButton({ text, label, className, title, said = {} }: {
  text: string; label: string; className?: string; title?: string;
  said?: { copied?: string; failed?: string };
}) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 2_000);
    return () => clearTimeout(timer);
  }, [state]);
  const copy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(text);
      setState("copied");
    } catch { setState("failed"); }
  };
  return <button type="button" className={className} title={title} onClick={() => void copy()}>
    <span aria-live="polite">{state === "copied" ? said.copied ?? "Copied" : state === "failed" ? said.failed ?? "Not copied. Select it instead" : label}</span>
  </button>;
}
