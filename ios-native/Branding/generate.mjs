import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const hash = v => crypto.createHash('sha256').update(v).digest('hex');
const web = read('web/src/terminal/ui.tsx').split('export function LogoMark(')[1]?.split('</svg>')[0];
const rects = source => [...source.matchAll(/<rect\s[^>]+\/>/g)].map(m => m[0].replace(/\s+/g, ' ')).join('\n');
if (!web) throw new Error('The canonical web LogoMark could not be found.');
const mark = rects(web);
if (!mark || mark !== rects(read('site/components/Logo.tsx'))) throw new Error('App and website logo geometry differ. Review the brand source before exporting.');
const settings = { geometry: hash(mark), accent: '#a5ce1f', background: '#070806', version: 1 };
const outputs = ['ios-native/Resources/Assets.xcassets/Brand.imageset/Brand.png', 'ios-native/Resources/Assets.xcassets/TabMark.imageset/TabMark.png', 'ios-native/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon.png'];
const manifestFile = path.join(root, 'ios-native/Branding/manifest.json');
if (process.argv.includes('--check')) {
  const saved = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (JSON.stringify(saved.source) !== JSON.stringify(settings)) throw new Error('The current web logo changed. Regenerate the native brand assets.');
  for (const output of outputs) if (saved.files[output] !== hash(fs.readFileSync(path.join(root, output)))) throw new Error(`Native logo does not match the recorded export: ${output}`);
  console.log('Native header, feed-tab and app-icon assets match the current web/site striped logo.');
  process.exit(0);
}
const require = createRequire(path.join(root, 'package.json'));
const sharp = require('sharp');
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 940 630" width="940" height="630"><g fill="${settings.accent}">${mark}</g></svg>`;
fs.mkdirSync(path.dirname(path.join(root, outputs[1])), { recursive: true });
await sharp(Buffer.from(svg)).png().toFile(path.join(root, outputs[0]));
await sharp(Buffer.from(svg)).resize(72, 48, { fit: 'contain', background: '#00000000' }).png().toFile(path.join(root, outputs[1]));
const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-100 -255 1140 1140" width="1024" height="1024"><rect x="-100" y="-255" width="1140" height="1140" fill="${settings.background}"/><g fill="${settings.accent}">${mark}</g></svg>`;
await sharp(Buffer.from(icon)).removeAlpha().png().toFile(path.join(root, outputs[2]));
fs.writeFileSync(manifestFile, JSON.stringify({ source: settings, files: Object.fromEntries(outputs.map(p => [p, hash(fs.readFileSync(path.join(root, p)))])) }, null, 2) + '\n');
console.log('Exported native brand assets from the exact current web/site logo geometry.');
