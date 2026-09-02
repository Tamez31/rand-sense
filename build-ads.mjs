import puppeteer from 'puppeteer';
import { writeFile, readFile, mkdir, readdir, rm } from 'fs/promises';
import { existsSync } from 'fs';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const adsDir = 'C:\\Users\\DELL\\Desktop\\RandSense Project Folder\\Ads\\New';
const ffmpeg = 'C:\\Users\\DELL\\AppData\\Local\\Microsoft\\WinGet\\Links\\ffmpeg.exe';

const tracks = [
  { name: 'Cosmonkey', duration: 21, audio: `${adsDir}\\Cosmonkey_trimmed.mp4` },
  { name: 'Let_it_all_work_out', duration: 18, audio: `${adsDir}\\Let_it_all_work_out_trimmed.mp4` },
  { name: 'Lippy', duration: 15, audio: `${adsDir}\\Lippy_trimmed.mp4` },
];

// Base timings for 16s version (in seconds)
// Scene 1: 0-3, Scene 2: 3-8, Scene 3: 8-13, Scene 4: 13-16
function generateHTML(totalDuration) {
  const r = totalDuration / 16; // ratio

  // Scene boundaries
  const s1End = 3 * r;
  const s2Start = s1End + 0.2 * r;
  const s2End = 8 * r;
  const s3Start = s2End + 0.2 * r;
  const s3End = 13 * r;
  const s4Start = s3End;

  return `<title>RandSense Ad</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  :root {
    --forest: #0D3B1E;
    --forest-deep: #072714;
    --mint: #7EEAA8;
    --gold: #D4A843;
    --white: #FFFFFF;
    --white-60: rgba(255,255,255,0.6);
    --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
    --ease-in-out: cubic-bezier(0.65, 0, 0.35, 1);
  }
  body { background: #000; display: flex; align-items: center; justify-content: center; min-height: 100vh; overflow: hidden; }
  .viewport {
    width: 1080px; height: 1920px; background: var(--forest);
    position: relative; overflow: hidden;
    font-family: "Inter", "Segoe UI", system-ui, -apple-system, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .viewport::before {
    content: ''; position: absolute; inset: 0;
    background: radial-gradient(ellipse at 50% 30%, rgba(126,234,168,0.06) 0%, transparent 60%);
    pointer-events: none; z-index: 0;
  }

  /* Scene 1 */
  .scene-1 {
    position: absolute; inset: 0; display: flex; flex-direction: column;
    align-items: center; justify-content: center; z-index: 10; opacity: 0;
    animation: scene1-in 0.6s var(--ease-out) ${0.2*r}s forwards,
               scene1-out 0.5s var(--ease-in-out) ${s1End - 0.2}s forwards;
  }
  .logo-icon {
    width: 220px; height: 220px; background: var(--forest-deep); border-radius: 48px;
    display: flex; align-items: center; justify-content: center; margin-bottom: 48px;
    opacity: 0; transform: scale(0.7);
    animation: pop-in 0.7s var(--ease-out) ${0.3*r}s forwards;
    box-shadow: 0 8px 40px rgba(0,0,0,0.3);
  }
  .logo-icon span { font-size: 120px; font-weight: 700; color: var(--white); letter-spacing: -2px; }
  .wordmark {
    font-size: 130px; font-weight: 700; letter-spacing: -4px; opacity: 0;
    transform: translateY(20px);
    animation: slide-fade-in 0.6s var(--ease-out) ${0.7*r}s forwards;
  }
  .wordmark .rand { color: var(--white); }
  .wordmark .sense { color: var(--mint); }
  .tagline-intro {
    font-size: 40px; font-weight: 500; color: var(--white-60);
    letter-spacing: 4px; text-transform: uppercase; margin-top: 24px;
    opacity: 0; transform: translateY(14px);
    animation: slide-fade-in 0.5s var(--ease-out) ${1.1*r}s forwards;
  }

  /* Scene 2 */
  .scene-2 {
    position: absolute; inset: 0; display: flex; flex-direction: column;
    align-items: center; justify-content: center; z-index: 9; opacity: 0;
    animation: scene-fade-in 0.5s var(--ease-out) ${s2Start}s forwards,
               scene-fade-out 0.5s var(--ease-in-out) ${s2End - 0.4}s forwards;
  }
  .headline-container { text-align: center; padding: 0 80px; }
  .headline-word {
    display: inline-block; font-size: 148px; font-weight: 700; color: var(--white);
    letter-spacing: -4px; line-height: 1.1; opacity: 0; transform: translateY(40px);
  }
  .headline-word:nth-child(1) { animation: word-in 0.5s var(--ease-out) ${s2Start + 0.3}s forwards; }
  .headline-word:nth-child(2) { animation: word-in 0.5s var(--ease-out) ${s2Start + 0.45}s forwards; }
  .headline-word:nth-child(3) { animation: word-in 0.5s var(--ease-out) ${s2Start + 0.6}s forwards; }
  .headline-word:nth-child(4) { animation: word-in 0.5s var(--ease-out) ${s2Start + 0.75}s forwards; }
  .headline-accent {
    display: block; width: 100px; height: 5px; background: var(--mint);
    border-radius: 2px; margin: 40px auto 0; opacity: 0; transform: scaleX(0);
    animation: bar-in 0.6s var(--ease-out) ${s2Start + 1.1}s forwards;
  }
  .scene-2 .sub-text {
    font-size: 48px; font-weight: 400; color: var(--white-60); margin-top: 40px;
    opacity: 0; transform: translateY(16px);
    animation: slide-fade-in 0.5s var(--ease-out) ${s2Start + 1.4}s forwards;
  }

  /* Scene 3 */
  .scene-3 {
    position: absolute; inset: 0; display: flex; flex-direction: column;
    align-items: center; justify-content: center; z-index: 8; opacity: 0;
    animation: scene-fade-in 0.5s var(--ease-out) ${s3Start}s forwards,
               scene-fade-out 0.5s var(--ease-in-out) ${s3End - 0.4}s forwards;
  }
  .cta-icon {
    width: 120px; height: 120px; border-radius: 50%; background: #25D366;
    display: flex; align-items: center; justify-content: center; margin-bottom: 48px;
    opacity: 0; transform: scale(0.6);
    animation: pop-in 0.6s var(--ease-out) ${s3Start + 0.3}s forwards;
    box-shadow: 0 4px 24px rgba(37,211,102,0.3);
  }
  .cta-icon svg { width: 60px; height: 60px; fill: var(--white); }
  .cta-text {
    font-size: 64px; font-weight: 500; color: var(--white); text-align: center;
    line-height: 1.35; padding: 0 80px; opacity: 0; transform: translateY(24px);
    animation: slide-fade-in 0.6s var(--ease-out) ${s3Start + 0.7}s forwards;
  }
  .phone-number {
    font-size: 88px; font-weight: 700; color: var(--gold); margin-top: 56px;
    letter-spacing: 2px; font-variant-numeric: tabular-nums;
    opacity: 0; transform: translateY(20px) scale(0.95);
    animation: slide-fade-in 0.6s var(--ease-out) ${s3Start + 1.4}s forwards,
               pulse-glow 2s var(--ease-in-out) ${s3Start + 2.0}s 2;
  }

  /* Scene 4 */
  .scene-4 {
    position: absolute; inset: 0; display: flex; flex-direction: column;
    align-items: center; justify-content: center; z-index: 7; opacity: 0;
    animation: scene-fade-in 0.6s var(--ease-out) ${s4Start}s forwards;
  }
  .closing-logo {
    width: 180px; height: 180px; background: var(--forest-deep); border-radius: 40px;
    display: flex; align-items: center; justify-content: center; margin-bottom: 40px;
    opacity: 0; transform: scale(0.7);
    animation: pop-in 0.6s var(--ease-out) ${s4Start + 0.3}s forwards;
    box-shadow: 0 6px 30px rgba(0,0,0,0.25);
  }
  .closing-logo span { font-size: 96px; font-weight: 700; color: var(--white); letter-spacing: -1px; }
  .closing-tagline {
    font-size: 76px; font-weight: 600; color: var(--white); text-align: center;
    opacity: 0; transform: translateY(16px);
    animation: slide-fade-in 0.6s var(--ease-out) ${s4Start + 0.6}s forwards;
  }
  .closing-tagline em { font-style: normal; color: var(--mint); }
  .closing-wordmark {
    font-size: 44px; font-weight: 700; letter-spacing: -1px; margin-top: 28px;
    opacity: 0;
    animation: fade-in 0.5s var(--ease-out) ${s4Start + 1.0}s forwards;
  }
  .closing-wordmark .rand { color: var(--white); }
  .closing-wordmark .sense { color: var(--mint); }

  /* Watermark */
  .watermark {
    position: absolute; bottom: 60px; right: 60px; display: flex;
    align-items: center; gap: 12px; z-index: 20; opacity: 0;
    animation: fade-in 0.5s var(--ease-out) ${s2Start + 0.2}s forwards,
               fade-out 0.4s var(--ease-in-out) ${s3End - 0.2}s forwards;
  }
  .watermark-icon {
    width: 48px; height: 48px; background: var(--forest-deep); border-radius: 12px;
    display: flex; align-items: center; justify-content: center;
  }
  .watermark-icon span { font-size: 26px; font-weight: 700; color: var(--white); }
  .watermark-text { font-size: 22px; font-weight: 600; letter-spacing: -0.5px; }
  .watermark-text .rand { color: var(--white); }
  .watermark-text .sense { color: var(--mint); }

  @keyframes scene1-in { to { opacity: 1; } }
  @keyframes scene1-out { to { opacity: 0; transform: scale(0.96); } }
  @keyframes scene-fade-in { from { opacity: 0; } to { opacity: 1; } }
  @keyframes scene-fade-out { to { opacity: 0; } }
  @keyframes pop-in { to { opacity: 1; transform: scale(1); } }
  @keyframes slide-fade-in { to { opacity: 1; transform: translateY(0) scale(1); } }
  @keyframes word-in { to { opacity: 1; transform: translateY(0); } }
  @keyframes bar-in { to { opacity: 1; transform: scaleX(1); } }
  @keyframes fade-in { to { opacity: 1; } }
  @keyframes fade-out { to { opacity: 0; } }
  @keyframes pulse-glow {
    0%, 100% { transform: scale(1); text-shadow: 0 0 0 transparent; }
    50% { transform: scale(1.04); text-shadow: 0 0 30px rgba(212,168,67,0.4); }
  }
</style>

<div class="viewport" id="viewport">
  <div class="scene-1">
    <div class="logo-icon"><span>R</span></div>
    <div class="wordmark"><span class="rand">Rand</span><span class="sense">Sense</span></div>
    <div class="tagline-intro">Making CENTS of it all</div>
  </div>
  <div class="scene-2">
    <div class="headline-container">
      <span class="headline-word">TAX&nbsp;</span>
      <span class="headline-word">SEASON&nbsp;</span>
      <span class="headline-word">IS&nbsp;</span>
      <span class="headline-word">HERE</span>
      <span class="headline-accent"></span>
    </div>
    <div class="sub-text">Don't get caught off guard</div>
  </div>
  <div class="scene-3">
    <div class="cta-icon">
      <svg viewBox="0 0 24 24"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M12 0C5.373 0 0 5.373 0 12c0 2.625.846 5.059 2.284 7.034L.789 23.492a.5.5 0 00.612.616l4.524-1.467A11.955 11.955 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 22c-2.137 0-4.146-.651-5.807-1.867l-.405-.293-2.684.87.893-2.632-.316-.42A9.935 9.935 0 012 12C2 6.477 6.477 2 12 2s10 4.477 10 10-4.477 10-10 10z"/></svg>
    </div>
    <div class="cta-text">Drop me a WhatsApp<br>and let us get you<br>up to date</div>
    <div class="phone-number">076 140 8717</div>
  </div>
  <div class="scene-4">
    <div class="closing-logo"><span>R</span></div>
    <div class="closing-tagline">Make <em>CENTS</em> of it all</div>
    <div class="closing-wordmark"><span class="rand">Rand</span><span class="sense">Sense</span></div>
  </div>
  <div class="watermark">
    <div class="watermark-icon"><span>R</span></div>
    <div class="watermark-text"><span class="rand">Rand</span><span class="sense">Sense</span></div>
  </div>
</div>`;
}

async function buildAd(track) {
  console.log(`\n=== Building ${track.name} (${track.duration}s) ===`);

  // Generate HTML
  const html = generateHTML(track.duration);
  const htmlPath = path.join(__dirname, `ad-${track.name}.html`);
  await writeFile(htmlPath, html);

  // Capture frames
  const framesDir = path.join(__dirname, `frames-${track.name}`);
  if (existsSync(framesDir)) await rm(framesDir, { recursive: true });
  await mkdir(framesDir);

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1080, height: 1920, deviceScaleFactor: 1 });

  const fileUrl = `file:///${htmlPath.replace(/\\/g, '/')}`;
  await page.goto(fileUrl, { waitUntil: 'domcontentloaded' });

  // Pause animations
  await page.evaluate(() => {
    document.getAnimations({ subtree: true }).forEach(a => {
      a.pause();
      a.currentTime = 0;
    });
  });

  const fps = 30;
  const totalFrames = Math.ceil(track.duration * fps);

  console.log(`  Capturing ${totalFrames} frames...`);
  for (let i = 0; i <= totalFrames; i++) {
    const timeMs = (i / fps) * 1000;
    await page.evaluate((t) => {
      document.getAnimations({ subtree: true }).forEach(a => { a.currentTime = t; });
    }, timeMs);
    await new Promise(r => setTimeout(r, 25));
    const frameNum = String(i).padStart(5, '0');
    await page.screenshot({ path: path.join(framesDir, `frame_${frameNum}.png`), type: 'png' });
    if (i % 60 === 0) console.log(`  ${(timeMs/1000).toFixed(1)}s / ${track.duration}s`);
  }

  await browser.close();
  console.log('  Frames captured');

  // Encode: merge video frames with audio from trimmed track
  const silentMp4 = path.join(__dirname, `${track.name}_silent.mp4`);
  const outputMp4 = path.join(adsDir, `RandSense_${track.name}.mp4`);

  // Create silent video from frames
  execSync(`"${ffmpeg}" -y -framerate ${fps} -i "${framesDir}\\frame_%05d.png" -c:v libx264 -pix_fmt yuv420p -preset slow -crf 18 -movflags +faststart "${silentMp4}"`, { stdio: 'pipe' });

  // Merge with audio from the trimmed track
  execSync(`"${ffmpeg}" -y -i "${silentMp4}" -i "${track.audio}" -c:v copy -c:a aac -b:a 192k -map 0:v:0 -map 1:a:0 -shortest -movflags +faststart "${outputMp4}"`, { stdio: 'pipe' });

  console.log(`  ✓ Saved: ${outputMp4}`);

  // Cleanup silent intermediate
  await rm(silentMp4, { force: true });
}

for (const track of tracks) {
  await buildAd(track);
}

console.log('\n=== All 3 ads complete! ===');
