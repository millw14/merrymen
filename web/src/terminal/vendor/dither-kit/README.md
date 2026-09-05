# Dither Kit painting engine

Source: https://tripwire.sh/r/core.json — registry version 0.1.0, author ripgrim.
Retrieved 2026-09-04. Documentation: https://www.tripwire.sh/dither-kit

The palette and ordered-dither painting primitives are vendored from the official
registry. The AreaVariant type is declared locally to avoid importing the full
chart context. DitherChart.tsx adapts this engine to the app’s CSS, accessibility,
and existing data without requiring a Tailwind/shadcn migration.

## Licence status — UNRESOLVED, AND THAT IS A DECISION SOMEBODY HAS TO MAKE

**No licence has been established for this code.** The registry entry it was
retrieved from does not publish one, the vendored files carry no header, and
there is no LICENSE beside them. Meanwhile `package.json` declares this whole
repository MIT and `files` ships `web/`, so every `npm publish` distributes
these two files under a licence nobody has granted.

That is recorded here rather than quietly accepted, because it is the kind of
thing that is cheap to fix now and expensive to discover later. The options, in
the order they are worth trying:

1. **Ask the author.** ripgrim publishes the registry; an explicit MIT (or any)
   grant, saved into this directory as `LICENSE`, ends the question.
2. **Reimplement.** `dither-paint.ts` is a 4×4 Bayer threshold loop and
   `palette.ts` is a colour table — both are textbook, and an independent
   implementation carries no provenance at all. About 220 lines.
3. **Exclude from the published package.** Add these files to
   `package.json#files` as a negation. The hosted app keeps working; only the
   npm tarball loses the chart.

Until one of those happens, treat this directory as third-party code of unknown
licence and do not copy it elsewhere.
