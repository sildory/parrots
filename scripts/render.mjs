// scripts/render.mjs: рендер кадров страницы (Chromium через Playwright), кодирование частей и склейка со звуком.
// Запуск:
//   node scripts/render.mjs                                  весь ролик: кадры 0–719, часть full, склейка со звуком
//   node scripts/render.mjs --from 0 --to 120 --part part-00 диапазон кадров в часть (так работают шарды в CI)
//   node scripts/render.mjs --join                           склейка всех частей out/parts/part-*.mp4 со звуком
// Параметры: --samples N (подкадров на кадр, по умолчанию 4), --scale X (1 — 1080×1920, 0.5 — предпросмотр),
// --keep (не удалять PNG после кодирования). Свой Chromium: переменная CHROME_PATH, доп. флаги: CHROME_ARGS.
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DURATION, FPS } from '../src/config.js';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined && !args[i + 1].startsWith('--') ? args[i + 1] : def;
};
const flag = (name) => args.includes(`--${name}`);

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const TOTAL = Math.round(DURATION * FPS);                 // 720 кадров
const PART_GIVEN = args.includes('--part');
const PART = opt('part', 'full');
const FROM = Number(opt('from', 0));
const TO = Number(opt('to', TOTAL));
const SAMPLES = Number(opt('samples', 4));
const SCALE = Number(opt('scale', 1));
const W = Math.round(1080 * SCALE);
const H = Math.round(1920 * SCALE);
const KEEP = flag('keep');
const FRAMES_DIR = join(ROOT, 'out', 'frames', PART);
const PARTS_DIR = join(ROOT, 'out', 'parts');
const AUDIO = join(ROOT, 'out', 'audio.wav');
const VIDEO = join(ROOT, 'out', 'video.mp4');

// Запуск внешней программы; при ошибке — понятное исключение с выводом программы
function run(bin, argv) {
  const r = spawnSync(bin, argv, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${bin} ${argv.join(' ')}\n${r.stderr}`);
  return r.stdout;
}
const frameCount = (file) => Number(run('ffprobe', [
  '-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames',
  '-of', 'csv=p=0', file,
]).trim());

// Статический сервер для страницы: index.html, src/, node_modules/ (three.js по importmap)
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.json': 'application/json', '.css': 'text/css', '.wav': 'audio/wav', '.png': 'image/png',
};
function startServer() {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      try {
        const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        const file = normalize(join(ROOT, pathname === '/' ? 'index.html' : pathname));
        if (!file.startsWith(ROOT)) throw new Error('вне проекта');
        const body = await readFile(file);
        res.writeHead(200, { 'Content-Type': MIME[extname(file)] ?? 'application/octet-stream' });
        res.end(body);
      } catch {
        res.writeHead(404).end();
      }
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// Рендер кадров в PNG. Уже готовые кадры пропускаются: прерванный рендер продолжается с места остановки
async function renderFrames() {
  const { chromium } = await import('playwright');   // подключаем только для рендера: склейке он не нужен
  mkdirSync(FRAMES_DIR, { recursive: true });
  const server = await startServer();
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROME_PATH || undefined,
    args: [
      '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
      '--no-sandbox', '--disable-dev-shm-usage',
      ...(process.env.CHROME_ARGS ? process.env.CHROME_ARGS.split(' ') : []),
    ],
  });
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    page.on('pageerror', (e) => console.error('ошибка страницы:', e.message));
    page.on('console', (m) => { if (m.type() === 'error') console.error('консоль:', m.text()); });
    const url = `http://127.0.0.1:${server.address().port}/index.html?scale=${SCALE}&samples=${SAMPLES}`;
    const t0 = Date.now();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.ready === true || !!window.renderError, null, { timeout: 30 * 60e3 });
    const error = await page.evaluate(() => window.renderError || null);
    if (error) throw new Error(`сцена не поднялась: ${error}`);
    console.log(`сцена готова за ${((Date.now() - t0) / 1000).toFixed(1)} с; кадры ${FROM}–${TO - 1}, подкадров ${SAMPLES}, ${W}×${H}`);

    const start = Date.now();
    let done = 0;
    for (let f = FROM; f < TO; f++) {
      const file = join(FRAMES_DIR, `f_${String(f).padStart(5, '0')}.png`);
      if (existsSync(file)) { done += 1; continue; }
      const ts = Date.now();
      await page.evaluate(([i, s]) => window.renderFrame(i, s), [f, SAMPLES]);
      await page.screenshot({ path: `${file}.tmp`, type: 'png' });
      renameSync(`${file}.tmp`, file);
      done += 1;
      const perFrame = (Date.now() - start) / done;
      const left = ((TO - FROM - done) * perFrame) / 60000;
      console.log(`кадр ${f}: ${((Date.now() - ts) / 1000).toFixed(1)} с, осталось ~${left.toFixed(0)} мин`);
    }
  } finally {
    await browser.close();
    server.close();
  }
}

// Кодирование кадров диапазона в часть: H.264, CRF 16, yuv420p, 24 к/с
function encodePart() {
  mkdirSync(PARTS_DIR, { recursive: true });
  const out = join(PARTS_DIR, `${PART}.mp4`);
  run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-framerate', String(FPS), '-start_number', String(FROM), '-i', join(FRAMES_DIR, 'f_%05d.png'),
    '-frames:v', String(TO - FROM),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out,
  ]);
  const n = frameCount(out);
  if (n !== TO - FROM) throw new Error(`${PART}.mp4: ${n} кадров вместо ${TO - FROM}`);
  if (!KEEP) rmSync(FRAMES_DIR, { recursive: true, force: true });
  console.log(`часть ${PART}: ${n} кадров → ${out}`);
}

// Склейка частей без пересжатия видео и добавление звука: 720 кадров = 30 с
function joinParts() {
  if (!existsSync(AUDIO)) {
    console.log('звука нет: запускаю node scripts/audio.mjs');
    run('node', [join(ROOT, 'scripts', 'audio.mjs')]);
  }
  const parts = readdirSync(PARTS_DIR).filter((f) => /^part-\d+\.mp4$/.test(f) || f === 'full.mp4').sort();
  if (parts.length === 0) throw new Error('нет частей в out/parts');
  const list = join(PARTS_DIR, 'list.txt');
  writeFileSync(list, parts.map((p) => `file '${p}'`).join('\n') + '\n');
  run('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', list, '-i', AUDIO,
    '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k',
    '-shortest', '-movflags', '+faststart', VIDEO,
  ]);
  const n = frameCount(VIDEO);
  console.log(`видео: ${VIDEO}, кадров ${n} (${(n / FPS).toFixed(2)} с)`);
  if (n !== TOTAL) throw new Error(`в видео ${n} кадров вместо ${TOTAL}: проверьте, что все части на месте`);
}

if (flag('join')) {
  joinParts();
} else {
  await renderFrames();
  encodePart();
  if (!PART_GIVEN) joinParts();
}
