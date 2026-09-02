import puppeteer from 'puppeteer';
import { readdir, readFile, writeFile } from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const framesDir = path.join(__dirname, 'frames');

// Read all frame files sorted
const files = (await readdir(framesDir))
  .filter(f => f.endsWith('.png'))
  .sort();

console.log(`Found ${files.length} frames`);

// Convert frames to base64 data URIs
console.log('Loading frames into memory...');
const frameDataURIs = [];
for (const file of files) {
  const buf = await readFile(path.join(framesDir, file));
  frameDataURIs.push('data:image/png;base64,' + buf.toString('base64'));
}
console.log('All frames loaded');

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--enable-features=WebCodecs']
});

const page = await browser.newPage();

// Set up a page that will encode the video
await page.setContent(`
  <html><body>
  <canvas id="c" width="1080" height="1920"></canvas>
  <script>
    window.encodeVideo = async function(frameDataURIs, fps) {
      const canvas = document.getElementById('c');
      const ctx = canvas.getContext('2d');
      const stream = canvas.captureStream(0); // 0 = manual frame push

      const chunks = [];
      let mimeType = 'video/webm;codecs=vp8';
      if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9')) {
        mimeType = 'video/webm;codecs=vp9';
      }

      const recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: 10000000
      });

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      return new Promise(async (resolve) => {
        recorder.onstop = async () => {
          const blob = new Blob(chunks, { type: mimeType });
          const buf = await blob.arrayBuffer();
          const arr = new Uint8Array(buf);
          // Convert to base64
          let binary = '';
          const chunkSize = 32768;
          for (let i = 0; i < arr.length; i += chunkSize) {
            binary += String.fromCharCode.apply(null, arr.subarray(i, i + chunkSize));
          }
          resolve(btoa(binary));
        };

        recorder.start();

        const frameDelay = 1000 / fps;

        for (let i = 0; i < frameDataURIs.length; i++) {
          const img = new Image();
          img.src = frameDataURIs[i];
          await new Promise(r => { img.onload = r; });
          ctx.drawImage(img, 0, 0, 1080, 1920);

          // Request a frame from the capture stream
          if (stream.getVideoTracks()[0].requestFrame) {
            stream.getVideoTracks()[0].requestFrame();
          }

          // Wait for frame duration
          await new Promise(r => setTimeout(r, frameDelay));

          if (i % 50 === 0) {
            document.title = 'frame_' + i + '_of_' + frameDataURIs.length;
          }
        }

        // Small delay then stop
        await new Promise(r => setTimeout(r, 200));
        recorder.stop();
      });
    };
  </script>
  </body></html>
`, { waitUntil: 'domcontentloaded' });

console.log('Encoding video in browser (this takes ~20s)...');

// Pass frames in batches to avoid argument size limits
// First, inject frames array
await page.evaluate(() => { window._frames = []; });

const batchSize = 50;
for (let i = 0; i < frameDataURIs.length; i += batchSize) {
  const batch = frameDataURIs.slice(i, i + batchSize);
  await page.evaluate((b) => { window._frames.push(...b); }, batch);
  console.log(`  Uploaded ${Math.min(i + batchSize, frameDataURIs.length)}/${frameDataURIs.length} frames`);
}

// Run the encoder
const b64 = await page.evaluate(async () => {
  return await window.encodeVideo(window._frames, 30);
}, { timeout: 120000 });

console.log('Encoding complete, writing file...');

const videoBuffer = Buffer.from(b64, 'base64');
const outputPath = path.join(__dirname, 'randsense-ad.webm');
await writeFile(outputPath, videoBuffer);
console.log(`Video saved: ${outputPath} (${(videoBuffer.length / 1024 / 1024).toFixed(1)} MB)`);

await browser.close();
