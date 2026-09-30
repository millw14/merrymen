import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import vm from 'node:vm';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'package.json'));
const { buildSync } = require('esbuild');
const result = buildSync({ absWorkingDir: root, stdin: { contents: 'export { EN } from "./web/src/lib/messages/en"; export { CATALOGUES } from "./web/src/lib/messages";', resolveDir: root }, bundle: true, platform: 'node', format: 'cjs', write: false });
const context = { module: { exports: {} } }; vm.runInNewContext(result.outputFiles[0].text, context);
const { EN, CATALOGUES } = context.module.exports;
const native = JSON.parse(fs.readFileSync(path.join(root, 'ios-native/Signing/native-copy.json'), 'utf8'));
const outputs = { 'Messages.json': JSON.stringify({ en: EN, ...CATALOGUES }, null, 2) + '\n' };
for (const locale of Object.keys(native)) {
  const translated = CATALOGUES[locale] ?? EN;
  const table = {};
  for (const [key, english] of Object.entries(EN)) {
    const ns = key.split('.')[0];
    const required = [ns, ...(['tour','create','settings','strip'].includes(ns) ? ['mode'] : [])];
    const complete = required.every(scope => Object.keys(EN).filter(k => k.startsWith(scope + '.')).every(k => Boolean(translated[k])));
    table[english] = complete ? translated[key] ?? english : english;
  }
  for (const key of Object.keys(native.en)) {
    if (!native[locale][key]) throw new Error(`Missing native translation: ${locale}/${key}`);
    table[key] = native[locale][key];
  }
  outputs[`${locale}.lproj/Localizable.strings`] = Object.entries(table).sort(([a],[b]) => a.localeCompare(b)).map(([key,value]) => `${JSON.stringify(key)} = ${JSON.stringify(value)};`).join('\n') + '\n';
}
for (const [relative, text] of Object.entries(outputs)) {
  const file = path.join(root, 'ios-native/Resources', relative);
  if (process.argv.includes('--check')) {
    if (!fs.existsSync(file) || fs.readFileSync(file,'utf8').replaceAll('\r\n','\n') !== text) throw new Error(`Language resources are stale: ${relative}`);
  } else { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); }
}
console.log(`Verified ${Object.keys(native).length} native languages against the web catalogue, including its namespace fallback rules.`);
