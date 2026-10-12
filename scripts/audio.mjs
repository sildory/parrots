// scripts/audio.mjs: звук ролика. Синтез в JS без внешних файлов. Моменты берутся из CUES (хореография),
// T (сюжет) и событий getBake (физика), поэтому звук совпадает с картинкой. Выход: out/audio.wav,
// 48 кГц, 16 бит, стерео, 30 с.
import { mkdirSync, writeFileSync } from 'node:fs';
import { DURATION, T } from '../src/config.js';
import { CUES } from '../src/choreo.js';
import { getBake } from '../src/bake.js';
import { mulberry32 } from '../src/util.js';

const SR = 48000;
const N = Math.round(DURATION * SR);
const L = new Float32Array(N);
const R = new Float32Array(N);
const PR = 0.32;                       // панорама правого попугая: −1 лево, +1 право
const PL = -0.32;                      // панорама левого
const bake = getBake();
const rnd = mulberry32(2026);          // вариации высоты и панорамы, детерминированные
let seedCounter = 1;
const sd = () => (seedCounter += 1) * 7919;
let placed = 0;

const len = (dur) => Math.max(1, Math.round(dur * SR));
const norm = (b, amp) => {
  let peak = 0;
  for (let i = 0; i < b.length; i++) peak = Math.max(peak, Math.abs(b[i]));
  if (peak > 0) for (let i = 0; i < b.length; i++) b[i] *= amp / peak;
  return b;
};

// ── Фильтры: биквады RBJ ──────────────────────────────────────────
function coef(type, f, q) {
  const w = (2 * Math.PI * Math.min(f, SR * 0.45)) / SR;
  const cs = Math.cos(w), al = Math.sin(w) / (2 * q);
  let b0, b1, b2;
  if (type === 'bp') { b0 = al; b1 = 0; b2 = -al; }
  else if (type === 'lp') { b0 = (1 - cs) / 2; b1 = 1 - cs; b2 = (1 - cs) / 2; }
  else { b0 = (1 + cs) / 2; b1 = -(1 + cs); b2 = (1 + cs) / 2; }
  const a0 = 1 + al;
  return [b0 / a0, b1 / a0, b2 / a0, (-2 * cs) / a0, (1 - al) / a0];
}
function run(x, cOf) {
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0, c = null;
  for (let i = 0; i < x.length; i++) {
    if (!c || i % 64 === 0) c = cOf(i);
    const v = c[0] * x[i] + c[1] * x1 + c[2] * x2 - c[3] * y1 - c[4] * y2;
    y[i] = v; x2 = x1; x1 = x[i]; y2 = y1; y1 = v;
  }
  return y;
}
const filt = (x, type, f, q) => { const c = coef(type, f, q); return run(x, () => c); };
const sweep = (x, fOf, q) => run(x, (i) => coef('bp', fOf(i / SR), q));

// ── Генераторы: каждый возвращает буфер с пиковым уровнем amp ─────
// Щелчок: узкая полоса шума с быстрым спадом (клевок, зерно о миску)
function tick(seed, { dur = 0.03, f = 2500, q = 4, amp = 1, tau = 0.005 } = {}) {
  const r = mulberry32(seed), n = len(dur), b = new Float32Array(n);
  for (let i = 0; i < n; i++) b[i] = (r() * 2 - 1) * Math.exp(-i / SR / tau);
  return norm(filt(b, 'bp', f, q), amp);
}

// Удар с падающим тоном: лапка по столу, шаг, пинок миски
function thump(seed, { dur = 0.2, f0 = 150, f1 = 60, amp = 1, tau = 0.04 } = {}) {
  const r = mulberry32(seed), n = len(dur), b = new Float32Array(n), click = len(0.004);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    ph += (2 * Math.PI * (f1 + (f0 - f1) * Math.exp(-t / (tau * 0.6)))) / SR;
    b[i] = Math.sin(ph) * Math.exp(-t / tau);
    if (i < click) b[i] += (r() * 2 - 1) * (1 - i / click) * 0.6;
  }
  return norm(b, amp);
}

// Звон керамики: несколько модальных тонов с разным затуханием
function ring(dur, base, ratios, decays, amp) {
  const n = len(dur), b = new Float32Array(n);
  ratios.forEach((k, j) => {
    const w = (2 * Math.PI * base * k) / SR, d = SR * decays[j];
    for (let i = 0; i < n; i++) b[i] += (Math.sin(w * i) * Math.exp(-i / d)) / (j + 1);
  });
  return norm(b, amp);
}

// Чириканье: свип частоты, лёгкая вибрация, вторая гармоника
function chirp(seed, { dur = 0.12, f0 = 3500, f1 = 5000, amp = 0.2, vib = 0.03 } = {}) {
  const n = len(dur), b = new Float32Array(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const f = f0 + (f1 - f0) * (t / dur) + vib * f0 * Math.sin(2 * Math.PI * 28 * t);
    ph += (2 * Math.PI * f) / SR;
    b[i] = (Math.sin(ph) + 0.25 * Math.sin(2 * ph)) * Math.min(1, t / 0.004) * Math.exp(-t / (dur * 0.55));
  }
  return norm(b, amp);
}

// Крик и ворчание: пилообразный тон из девяти гармоник, дрожь частоты, формантная полоса
function squeak(seed, { dur = 0.4, f0 = 800, f1 = 550, amp = 0.3, rough = 0.5 } = {}) {
  const r = mulberry32(seed), n = len(dur), b = new Float32Array(n);
  let ph = 0, jit = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    jit = 0.98 * jit + 0.02 * (r() * 2 - 1);
    ph += (2 * Math.PI * (f0 + (f1 - f0) * (t / dur)) * (1 + rough * 0.2 * jit)) / SR;
    let s = 0;
    for (let k = 1; k <= 9; k++) s += Math.sin(k * ph) / k;
    b[i] = s * Math.min(1, t / 0.012) * Math.min(1, (dur - t) / 0.08);
  }
  const form = filt(b, 'bp', 1600, 0.9);
  for (let i = 0; i < n; i++) b[i] = 0.5 * b[i] + 0.5 * form[i];
  return norm(b, amp);
}

// Свист крыльев: полосовой шум, полоса которого плывёт, и модуляция взмахами
function whoosh(seed, { dur = 0.15, fLo = 900, fHi = 1700, amp = 0.2, flapHz = 10, depth = 0.7 } = {}) {
  const r = mulberry32(seed), n = len(dur), w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = r() * 2 - 1;
  const s = sweep(w, (t) => fLo + (fHi - fLo) * (t / dur), 1.4);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const flap = 1 - depth + depth * (0.5 + 0.5 * Math.sin(2 * Math.PI * flapHz * t));
    s[i] *= flap * Math.min(1, t / 0.02) * Math.min(1, (dur - t) / 0.03);
  }
  return norm(s, amp);
}

// Поток зёрен: зернистый шум с неровной громкостью и плавными фейдами
function stream(seed, dur, amp) {
  const r = mulberry32(seed), n = len(dur), w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = r() * 2 - 1;
  const s = filt(filt(w, 'bp', 4200, 0.6), 'hp', 1500, 0.7);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const grain = 0.7 + 0.3 * Math.sin(2 * Math.PI * 7 * t) + 0.4 * (r() - 0.5);
    s[i] *= grain * Math.min(1, t / 0.12) * Math.min(1, (dur - t) / 0.2);
  }
  return norm(s, amp);
}

// Комната: тихий низкий шум, без звонкости
function room(seed, dur, amp) {
  const r = mulberry32(seed), n = len(dur), b = new Float32Array(n);
  let x = 0;
  for (let i = 0; i < n; i++) { x = 0.998 * (x + 0.02 * (r() * 2 - 1)); b[i] = x; }
  return norm(b, amp);
}

// Скрежет миски по столу: полоса 1.4 кГц, громкость по скорости, которую даёт физика миски
const SPD_HZ = 200;
const spd = new Float32Array(Math.ceil(DURATION * SPD_HZ) + 2);
for (let k = 0; k < spd.length; k++) {
  const t = k / SPD_HZ, a = bake.bowl(t), b = bake.bowl(t + 0.005);
  spd[k] = Math.hypot(b.x - a.x, b.y - a.y) / 0.005;
}
function scrape(seed, t0, t1, amp) {
  const r = mulberry32(seed), n = len(t1 - t0), w = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = r() * 2 - 1;
  const s = norm(filt(filt(w, 'bp', 1400, 1.2), 'hp', 700, 0.7), 1);
  for (let i = 0; i < n; i++) {
    const v = spd[Math.min(spd.length - 1, Math.round((t0 + i / SR) * SPD_HZ))];
    s[i] *= amp * Math.min(1, v / 0.3);
  }
  return s;
}

// ── Размещение: момент, панорама (равная мощность) и громкость ────
function place(t0, buf, pan, gain = 1) {
  const s0 = Math.round(t0 * SR);
  const a = Math.cos(((pan + 1) * Math.PI) / 4) * gain;
  const b = Math.sin(((pan + 1) * Math.PI) / 4) * gain;
  for (let i = 0; i < buf.length && s0 + i < N; i++) {
    const k = s0 + i;
    if (k < 0) continue;
    L[k] += buf[i] * a;
    R[k] += buf[i] * b;
  }
  placed += 1;
}
const bowlPan = (t) => Math.max(-0.8, Math.min(0.8, bake.bowlX(t) / 0.9));

// ── Сцена: звуки по времени ──────────────────────────────────────
place(0, room(sd(), DURATION, 0.004), 0);

// Правый ковш: поток зёрен, ложка звенит при наклоне и возврате
place(T.pourFull[0], stream(sd(), T.pourFull[1] - T.pourFull[0], 0.12), PR);
place(T.pourFull[0] - 0.02, ring(0.45, 2600, [1, 2.76, 5.4], [0.25, 0.1, 0.05], 0.07), PR);
place(T.pourFull[1], ring(0.45, 2600, [1, 2.76, 5.4], [0.25, 0.1, 0.05], 0.06), PR);

// Левый ковш: поток зёрен и звон ложки
place(T.pourQuarter[0], stream(sd(), T.pourQuarter[1] - T.pourQuarter[0], 0.09), PL);
place(T.pourQuarter[0] - 0.02, ring(0.45, 2600, [1, 2.76, 5.4], [0.25, 0.1, 0.05], 0.05), PL);
place(T.pourQuarter[1], ring(0.45, 2600, [1, 2.76, 5.4], [0.25, 0.1, 0.05], 0.05), PL);

// Удары зёрен о миску во время сыпки: панорама по стороне, громкость по скорости
for (const [t, v, type] of bake.events) {
  if (type !== 2) continue;
  const left = t >= T.pourQuarter[0] - 0.05 && t <= T.pourQuarter[1] + 0.2;
  place(t, tick(sd(), { dur: 0.02, f: 3000 + 1500 * rnd(), q: 2.5, amp: 0.2, tau: 0.0035 }),
    left ? PL : PR, 0.4 + 0.6 * Math.min(1, v / 2));
}

// Радость правого: щебет на прыжках, трепет крыльев, лапки по столу
for (const t of CUES.chirpRight) {
  place(t, chirp(sd(), { dur: 0.13, f0: 3300 + 400 * rnd(), f1: 4700 + 400 * rnd(), amp: 0.2 }), PR + 0.1 * (rnd() - 0.5));
}
for (const t of CUES.hopRight) place(t, whoosh(sd(), { dur: 0.3, fLo: 1100, fHi: 1700, amp: 0.07, flapHz: 10, depth: 0.8 }), PR);
for (const t of CUES.landRight) place(t, thump(sd(), { dur: 0.09, f0: 170, f1: 80, amp: 0.15, tau: 0.02 }), PR);

// Клевки: щёлк клюва о миску и хруст зерна
for (const t of CUES.peck) {
  place(t, tick(sd(), { dur: 0.03, f: 2000 + 600 * rnd(), q: 3, amp: 0.22, tau: 0.004 }), PR);
  place(t, tick(sd(), { dur: 0.02, f: 3800, q: 2, amp: 0.06, tau: 0.003 }), PR);
}
for (const t of CUES.tryPeck) place(t, tick(sd(), { dur: 0.03, f: 2100, q: 3, amp: 0.2, tau: 0.004 }), PR);

// Левый: недоумение, ворчание, злость, прыжки и тычки
place(T.stare, chirp(sd(), { dur: 0.25, f0: 1100, f1: 800, amp: 0.16, vib: 0.02 }), PL);
place(10.4, chirp(sd(), { dur: 0.22, f0: 1500, f1: 2100, amp: 0.2, vib: 0.02 }), PL);
place(T.angry, squeak(sd(), { dur: 0.7, f0: 260, f1: 200, amp: 0.26, rough: 0.8 }), PL);
for (const t of CUES.squawkLeft) place(t, squeak(sd(), { dur: 0.38, f0: 720 + 60 * rnd(), f1: 520, amp: 0.3, rough: 0.6 }), PL);
for (const t of CUES.landLeft) place(t, thump(sd(), { dur: 0.12, f0: 150, f1: 70, amp: 0.2, tau: 0.03 }), PL);
for (const t of CUES.jab) place(t, whoosh(sd(), { dur: 0.16, fLo: 900, fHi: 1700, amp: 0.18, flapHz: 12, depth: 0.7 }), PL);

// Толчки: упор левого в миску и скрежет миски по столу
for (const t of CUES.push) place(t, thump(sd(), { dur: 0.22, f0: 95, f1: 45, amp: 0.3, tau: 0.05 }), PL);
place(T.nudge - 0.2, scrape(sd(), T.nudge - 0.2, 17.9, 0.12), bowlPan(T.nudge));

// Шок и ярость правого: крики, топот, стук
CUES.squawkRight.forEach((t, k) => {
  place(t, squeak(sd(), { dur: 0.36, f0: 980 + 60 * rnd(), f1: 700, amp: k < 2 ? 0.42 : 0.32, rough: 0.7 }), PR);
});
for (const t of CUES.stomp) {
  place(t, thump(sd(), { dur: 0.18, f0: 115, f1: 55, amp: 0.26, tau: 0.05 }), PR);
  place(t, tick(sd(), { dur: 0.02, f: 900, q: 2, amp: 0.1, tau: 0.004 }), PR);
}

// Падение миски: звон керамики и глухой удар о пол; осыпь зёрен на столе и полу
for (const [t, v, type] of bake.events) {
  if (type === 3) {
    place(t, ring(1.2, 1150, [1, 2.7, 4.8, 6.6], [0.5, 0.3, 0.15, 0.08], 0.35 * Math.min(1, v / 3.5)), bowlPan(t));
    place(t, thump(sd(), { dur: 0.25, f0: 120, f1: 45, amp: 0.4 * Math.min(1, v / 3.5), tau: 0.05 }), bowlPan(t));
  } else if (type === 0) {
    place(t, tick(sd(), { dur: 0.02, f: 2600 + 800 * rnd(), q: 2, amp: 0.05 * Math.min(1, v / 3), tau: 0.003 }), 0.2 + 0.6 * rnd());
  } else if (type === 1) {
    place(t, tick(sd(), { dur: 0.02, f: 1400 + 600 * rnd(), q: 2, amp: 0.03 * Math.min(1, v / 3), tau: 0.003 }), 0.2 + 0.6 * rnd());
  }
}
place(T.shove + 0.6, stream(sd(), 2.0, 0.05), 0.3);

// Взлёт: крик и свист крыльев, который уходит вправо
place(CUES.takeoff[0], squeak(sd(), { dur: 0.6, f0: 1100, f1: 780, amp: 0.45, rough: 0.9 }), PR);
place(CUES.flightWindow[0], whoosh(sd(), {
  dur: CUES.flightWindow[1] - CUES.flightWindow[0], fLo: 1300, fHi: 450, amp: 0.22, flapHz: 4.2, depth: 0.55,
}), 0.5);

// Финал: торжество левого
place(20.6, chirp(sd(), { dur: 0.22, f0: 2600, f1: 3100, amp: 0.18 }), PL);
place(27.3, chirp(sd(), { dur: 0.22, f0: 2800, f1: 3500, amp: 0.2 }), PL);
place(27.6, chirp(sd(), { dur: 0.25, f0: 3000, f1: 3400, amp: 0.18 }), PL);

// ── Общая комната: гребёнчатые и проходные фильтры (Шрёдер) ──────
function comb(x, D, fb, damp) {
  const buf = new Float32Array(D), y = new Float32Array(x.length);
  let idx = 0, store = 0;
  for (let i = 0; i < x.length; i++) {
    const out = buf[idx];
    store = out * (1 - damp) + store * damp;
    buf[idx] = x[i] + store * fb;
    idx = (idx + 1) % D;
    y[i] = out;
  }
  return y;
}
function allpass(x, D) {
  const buf = new Float32Array(D), y = new Float32Array(x.length);
  let idx = 0;
  for (let i = 0; i < x.length; i++) {
    const bo = buf[idx];
    y[i] = -x[i] + bo;
    buf[idx] = x[i] + bo * 0.5;
    idx = (idx + 1) % D;
  }
  return y;
}
function reverb(x, offset) {
  const k = 48 / 44.1;
  const sum = new Float32Array(x.length);
  for (const d of [1116, 1188, 1277, 1356]) {
    const c = comb(x, Math.round((d + offset) * k), 0.84, 0.25);
    for (let i = 0; i < x.length; i++) sum[i] += c[i] * 0.25;
  }
  let z = sum;
  for (const d of [556, 441]) z = allpass(z, Math.round((d + offset) * k));
  return z;
}
const wetL = reverb(L, 0), wetR = reverb(R, 23);
for (let i = 0; i < N; i++) { L[i] += 0.16 * wetL[i]; R[i] += 0.16 * wetR[i]; }

// ── Мастер: срез гула ниже 60 Гц, пик −1.9 дБFS без ограничения ─────
for (const ch of [L, R]) ch.set(filt(ch, 'hp', 60, 0.7));
let peak = 0, sq = 0;
for (let i = 0; i < N; i++) {
  peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  sq += L[i] * L[i] + R[i] * R[i];
}
const g = peak > 0 ? 0.8 / peak : 1;
for (let i = 0; i < N; i++) { L[i] *= g; R[i] *= g; }

// ── WAV: 16 бит PCM, стерео, 48 кГц ──────────────────────────────
function wav(l, r) {
  const data = l.length * 4, buf = Buffer.alloc(44 + data);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + data, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(data, 40);
  for (let i = 0; i < l.length; i++) {
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, l[i])) * 32767), 44 + i * 4);
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, r[i])) * 32767), 46 + i * 4);
  }
  return buf;
}
mkdirSync(new URL('../out/', import.meta.url), { recursive: true });
writeFileSync(new URL('../out/audio.wav', import.meta.url), wav(L, R));

const rms = Math.sqrt(sq / (2 * N));
console.log(`звук: ${(N / SR).toFixed(2)} с, событий ${placed}, пик −1.9 дБFS, RMS ${(20 * Math.log10(rms * g)).toFixed(1)} дБFS`);
