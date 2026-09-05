# Dither Kit painting engine

Source: https://tripwire.sh/r/core.json — registry version 0.1.0, author ripgrim.
Retrieved 2026-09-04. Documentation: https://www.tripwire.sh/dither-kit

The palette and ordered-dither painting primitives are vendored from the official
registry. The AreaVariant type is declared locally to avoid importing the full
chart context. DitherChart.tsx adapts this engine to the app’s CSS, accessibility,
and existing data without requiring a Tailwind/shadcn migration.
