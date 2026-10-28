"use client";
import NextLink from "next/link";
import type { ComponentProps, MouseEvent } from "react";
import { goTo, isScreenPath } from "./navigate";

/**
 * next/link, EXCEPT THAT A LINK INTO THE TERMINAL IS INSTANT.
 *
 * A drop-in: the same props, the same element. For a path the terminal renders
 * (navigate.ts) it is a plain anchor whose click enters the screen in place;
 * for anything else it is next/link, prefetch and all. The anchor keeps every
 * way a reader opens a link somewhere else — a modifier key, a middle click, a
 * target — and runs the caller's own onClick first, so a menu that closes
 * itself on a click still does.
 */
export default function Link(props: ComponentProps<typeof NextLink>) {
  const { href, onClick, ...rest } = props;
  if (typeof href !== "string" || !isScreenPath(href)) return <NextLink {...props} />;
  const click = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = event.currentTarget.getAttribute("target");
    if (target && target !== "_self") return;
    event.preventDefault();
    goTo(href);
  };
  // next/link's own props have no meaning on a plain anchor.
  const { prefetch: _prefetch, replace: _replace, scroll: _scroll, shallow: _shallow, locale: _locale, legacyBehavior: _legacy, passHref: _pass, ...anchor } = rest as ComponentProps<typeof NextLink> & Record<string, unknown>;
  return <a href={href} onClick={click} {...(anchor as object)} />;
}
