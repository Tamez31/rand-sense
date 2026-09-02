import puppeteer from 'puppeteer';
import { writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const framesDir = path.join(__dirname, 'frames');
if (!existsSync(framesDir)) await mkdir(framesDir);

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox']
});

const page = await browser.newPage();
await page.setViewport({ width: 1080, height: 1920, deviceScaleFactor: 1 });

const adPath = path.join(__dirname, 'randsense-ad.html');
const fileUrl = `file:///${adPath.replace(/\\/g, '/')}`;

// Pause all animations initially so we can step through them
await page.goto(fileUrl, { waitUntil: 'domcontentloaded' });

// Pause animations at the start
await page.evaluate(() => {
  document.getAnimations({ subtree: true }).forEach(a => {
    a.pause();
    a.currentTime = 0;
  });
});

const fps = 30;
const durationMs = 16500;
const totalFrames = Math.ceil(durationMs / 1000 * fps);

console.log(`Capturing ${totalFrames} frames at ${fps}fps...`);

for (let i = 0; i <= totalFrames; i++) {
  const timeMs = (i / fps) * 1000;

  // Seek all animations to this time
  await page.evaluate((t) => {
    document.getAnimations({ subtree: true }).forEach(a => {
      a.currentTime = t;
    });
  }, timeMs);

  // Small delay to let paint settle
  await new Promise(r => setTimeout(r, 30));

  const frameNum = String(i).padStart(5, '0');
  await page.screenshot({
    path: path.join(framesDir, `frame_${frameNum}.png`),
    type: 'png'
  });

  if (i % 30 === 0) {
    console.log(`  ${(timeMs/1000).toFixed(1)}s / 16.5s (frame ${i}/${totalFrames})`);
  }
}

console.log('All frames captured!');
await browser.close();

// Now stitch frames into a video using canvas + WebM via a simple node approach
// Since we don't have ffmpeg, we'll create a script to do it in browser
console.log('\nFrames saved to ./frames/');
console.log('Now run the stitcher to create the video.');
