import { chromium } from 'playwright';
const times = process.argv.slice(2).map(Number);
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
p.on('pageerror', e => console.log('ERR', e.message));
p.on('console', m => console.log('LOG', m.text()));
await p.goto('file://' + process.cwd() + '/film.html');
await p.evaluate(() => window.ready);
for (const t of times) { await p.evaluate(t => render(t), t); await p.screenshot({ path: `st_${t}.jpg`, quality: 70, type: 'jpeg' }); }
await b.close();
