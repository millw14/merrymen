import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { copyFile, mkdir } from "node:fs/promises";

const dir = path.dirname(fileURLToPath(import.meta.url));
await build({
  entryPoints: [path.join(dir, "browser.ts")],
  outfile: path.join(dir, "dist", "browser.js"),
  bundle: true,
  platform: "browser",
  format: "esm",
  target: ["es2022"],
  treeShaking: true,
  minify: true,
  sourcemap: false,
  tsconfig: path.join(dir, "..", "tsconfig.json"),
  legalComments: "eof",
  logLevel: "info",
});

// A browser module partners can import without installing the full dashboard.
const publicDir = path.join(dir, "..", "web", "public", "sdk");
await mkdir(publicDir, { recursive: true });
await copyFile(path.join(dir, "dist", "browser.js"), path.join(publicDir, "merrymen-browser.js"));
