import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hash = p => crypto.createHash('sha256').update(fs.readFileSync(path.resolve(root, p), 'utf8').replaceAll('\r\n', '\n')).digest('hex');
const manifestPath = path.join(root, 'ios-native/Signing/sources.json');
if (process.argv.includes('--check')) {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  for (const [p, expected] of Object.entries(manifest)) {
    if (hash(p) !== expected) throw new Error(`Wallet source changed: ${p}. Regenerate and verify the native wallet bundle.`);
  }
  console.log('Shared wallet bundle and recorded source hashes match.');
  process.exit(0);
}
const dependencyRoot = process.env.MERRYMEN_IOS_DEPENDENCY_ROOT || root;
const require = createRequire(path.join(dependencyRoot, 'package.json'));
const { build } = require('esbuild');
const result = await build({
  absWorkingDir: root, entryPoints: ['ios-native/Signing/engine.ts'],
  bundle: true, platform: 'browser', target: 'es2020', format: 'iife', globalName: 'WalletEngine',
  outfile: path.join(root, 'ios-native/Resources/WalletEngine.js'),
  tsconfig: path.join(root, 'web/tsconfig.json'),
  nodePaths: [path.join(dependencyRoot, 'node_modules')],
  define: { 'process.env.NEXT_PUBLIC_TRENCHER_FACTORY': 'undefined', 'process.env.NEXT_PUBLIC_TRENCHER_FACTORY_CODE_HASH': 'undefined' },
  metafile: true, legalComments: 'eof', minify: true,
});
const sources = Object.keys(result.metafile.inputs).filter(p => !p.includes('node_modules') && fs.existsSync(path.resolve(root, p))).sort();
sources.push('package-lock.json', 'ios-native/Signing/build.mjs', 'ios-native/Resources/WalletEngine.js');
const manifest = Object.fromEntries(sources.sort().map(p => [p.replaceAll('\\', '/'), hash(p)]));
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Bundled ${sources.length} shared source files; native signing integration still requires acceptance testing.`);
