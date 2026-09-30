"use client";

/**
 * The current Merrymen mark (the redesigned terminal's LogoMark) with the
 * wordmark, for the standalone connect, consent, approval and Connected apps
 * pages. One source for the shape: the mark is imported, never redrawn here.
 */
import { LogoMark } from "@/terminal/ui";

export function BrandLockup() {
  return (
    <a href="/" className="connect-brand mcp-brand" aria-label="Merrymen home">
      <LogoMark size={20} />
      <span className="mcp-wordmark">merrymen</span>
    </a>
  );
}
