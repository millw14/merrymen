"use client";

import { useSyncExternalStore } from "react";
import { bannerSrc, faceSrc } from "./live";

type Kind = "avatar" | "banner";
const revisions = new Map<string, string | null>();
const listeners = new Set<() => void>();
const imageKey = (slug: string, kind: Kind) => `${slug.toLowerCase()}:${kind}`;
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/** Publish only successful server writes, updating every already-mounted image. */
export function publishAgentImage(slug: string, kind: Kind, version: string | null): void {
  revisions.set(imageKey(slug, kind), version);
  for (const listener of listeners) listener();
}

export function useAgentImageSrc(slug: string | null, kind: Kind): string | null {
  const revision = useSyncExternalStore(subscribe, () => slug ? revisions.get(imageKey(slug, kind)) : undefined, () => undefined);
  const base = kind === "avatar" ? faceSrc(slug) : bannerSrc(slug);
  return revision === null ? null : base && revision ? `${base}?v=${encodeURIComponent(revision)}` : base;
}
