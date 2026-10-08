import { build } from "esbuild";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";

const dir = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(dir, "browser.ts");

// `--outfile <path>` writes only that file (a partner's own assets, or a test);
// without it the build also refreshes the copy hosted web serves.
const flag = process.argv.indexOf("--outfile");
if (flag !== -1 && !process.argv[flag + 1]) throw new Error("--outfile needs a path");
const outfile = flag === -1 ? path.join(dir, "dist", "browser.js") : path.resolve(process.argv[flag + 1]);

// The contract version is declared once, in browser.ts, which exports it.
const api = /^export const PARTNER_API_VERSION = "([^"]+)";$/m.exec(await readFile(entry, "utf8"))?.[1];
if (!api) throw new Error("sdk/browser.ts must declare PARTNER_API_VERSION as a string literal");

/**
 * THE BUILD STAMP. The bundle includes the dashboard's signer, so the contract
 * version alone cannot tell two builds apart. Build once with a placeholder,
 * fingerprint those bytes, then write the fingerprint where the placeholder
 * was: the same sources always get the same SDK_VERSION, and a change to
 * anything bundled gets a new one.
 */
const PLACEHOLDER = "merrymen-sdk-build-placeholder";
const { outputFiles: [bundle] } = await build({
  entryPoints: [entry],
  outfile,
  write: false,
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
  define: { __MERRYMEN_SDK_BUILD__: JSON.stringify(PLACEHOLDER) },
});
if (!bundle.text.includes(PLACEHOLDER)) throw new Error("The build stamp did not reach the bundle; SDK_VERSION would not identify this build");
const id = createHash("sha256").update(bundle.contents).digest("hex").slice(0, 12);
const version = `${api}+${id}`;
await mkdir(path.dirname(outfile), { recursive: true });
await writeFile(outfile, `/* merrymen-browser ${version} */\n${bundle.text.replaceAll(PLACEHOLDER, id)}`);

// A browser module partners can import without installing the full dashboard.
if (flag === -1) {
  const publicDir = path.join(dir, "..", "web", "public", "sdk");
  await mkdir(publicDir, { recursive: true });
  await copyFile(outfile, path.join(publicDir, "merrymen-browser.js"));
}
console.log(`merrymen browser SDK ${version} -> ${path.relative(process.cwd(), outfile)}`);
