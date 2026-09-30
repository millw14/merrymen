import { chromium } from 'playwright';
import { spawn } from 'child_process';
const [,, a, b, out, fpsS] = process.argv; const fps = +fpsS;
const FF = process.env.FF;
const br = await chromium.launch();
const p = await br.newPage({ viewport: { width: 1920, height: 1080 } });
p.on('pageerror', e => console.log('ERR', e.message));
await p.goto('file://' + process.cwd() + '/film.html');
await p.evaluate(() => window.ready);
const ff = spawn(FF, ['-loglevel','error','-y','-f','image2pipe','-framerate',String(fps),'-c:v','mjpeg','-i','-','-c:v','libx264','-preset','medium','-crf','15','-pix_fmt','yuv420p','-r',String(fps),out], { stdio: ['pipe','inherit','inherit'] });
for (let f = +a; f < +b; f++) {
  await p.evaluate(t => render(t), f / fps);
  const buf = await p.screenshot({ type: 'jpeg', quality: 95 });
  if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r));
}
ff.stdin.end(); await new Promise(r => ff.on('close', r)); await br.close();
