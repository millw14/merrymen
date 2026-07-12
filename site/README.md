# merrymen.dev — marketing + docs site

Standalone Next.js (App Router) site for merrymen. Independent of the CLI/dashboard
package — it is **not** shipped to npm and has its own dependencies.

Pages: `/` (landing), `/docs`, `/terms`, `/privacy`. Original design; fonts are
Inter + JetBrains Mono (both SIL OFL, self-hosted via `next/font`).

## Develop

```bash
cd site
npm install
npm run dev      # http://localhost:3000
npm run build    # production build
```

## Deploy to Vercel

This folder deploys on its own. In the Vercel project settings set the
**Root Directory** to `site` — Vercel auto-detects Next.js and builds it.

- CLI: `cd site && npx vercel` (first run links/creates the project), then
  `npx vercel --prod` to promote.
- Dashboard: New Project → import the `millw14/merrymen` repo → set Root
  Directory = `site` → Deploy.

Set your real domain in `app/layout.tsx` (`metadataBase`) once you have one, so
Open Graph URLs resolve correctly.
