import puppeteer from 'puppeteer';
import { mkdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const framesDir = path.join(__dirname, 'frames-reels');
const ffmpeg = 'C:\\Users\\DELL\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffmpeg.exe';

if (existsSync(framesDir)) await rm(framesDir, { recursive: true });
await mkdir(framesDir);

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox']
});

const page = await browser.newPage();
await page.setViewport({ width: 1080, height: 1920, deviceScaleFactor: 1 });

const htmlPath = path.join(__dirname, 'randsense-reels-ad.html');
await page.goto(`file:///${htmlPath.replace(/\\/g, '/')}`, { waitUntil: 'domcontentloaded' });

// Ensure safe zone overlay is hidden for recording
await page.evaluate(() => {
  const toggle = document.getElementById('safe-toggle');
  if (toggle) toggle.checked = false;
});

// Pause animations
await page.evaluate(() => {
  document.getAnimations({ subtree: true }).forEach(a => {
    a.pause();
    a.currentTime = 0;
  });
});

const fps = 30;
const duration = 22;
const totalFrames = Math.ceil(duration * fps);

console.log(`Capturing ${totalFrames} frames at ${fps}fps...`);
for (let i = 0; i <= totalFrames; i++) {
  const timeMs = (i / fps) * 1000;
  await page.evaluate((t) => {
    document.getAnimations({ subtree: true }).forEach(a => { a.currentTime = t; });
  }, timeMs);
  await new Promise(r => setTimeout(r, 25));
  const frameNum = String(i).padStart(5, '0');
  await page.screenshot({ path: path.join(framesDir, `frame_${frameNum}.png`), type: 'png' });
  if (i % 60 === 0) console.log(`  ${(timeMs/1000).toFixed(1)}s / ${duration}s`);
}

await browser.close();
console.log('Frames captured!');

// Encode MP4
const output = path.join(__dirname, 'randsense-reels-ad.mp4');
execSync(`"${ffmpeg}" -y -framerate ${fps} -i "${framesDir}\\frame_%05d.png" -c:v libx264 -pix_fmt yuv420p -preset slow -crf 18 -movflags +faststart "${output}"`, { stdio: 'pipe' });
console.log(`Video saved: ${output}`);
