// src/bake.js, часть 1 из 3: миска как твёрдое тело в плоскости XY.
// Опоры — точки дна и края: стол (y = 0 при |x| ≤ TX) или пол (y = floorY) за краем стола.
// Импульсы накапливаются по итерациям, трение Кулона. Чистый JS без three.js.

import { T, WORLD, BOWL, SIM_HZ, DURATION, PECKS } from './config.js';
import { clamp, bump, lerp, mulberry32 } from './util.js';
import { makeSeeds, spawnFree, stepSeeds, eatNear } from './seeds.js';

export const G = 9.81;
export const SUB = 3;                              // подшагов физики на такт SIM_HZ
export const DT = 1 / (SIM_HZ * SUB);              // 1/360 с
export const NSTEP = Math.round(DURATION * SIM_HZ * SUB);

const FLOOR = WORLD.floorY;
const TX = WORLD.table.x;                          // край стола: x = TX
const { rBase: RB, rRim: RR, height: H, wall: WALL, floor: FT, mu: MU } = BOWL;
const REST = 0.25;                                 // упругость удара о стол и пол
const HC = 0.022;                                  // высота центра масс над дном
const INERTIA = 0.0021;                            // момент инерции, масса миски нормирована к 1

// Стенка миски в плоскости симметрии: (ρ от оси, y от дна). Ось ρ = 0 границей не считается
export const CROSS = [[0, 0], [RB, 0], [RR, H], [RR - WALL, H], [RB - WALL, FT], [0, FT]];

// Опоры миски в системе центра масс: точки дна и края по обе стороны
const SUPPORT = [[-RB, 0], [-0.6 * RB, 0], [-0.2 * RB, 0], [0.2 * RB, 0], [0.6 * RB, 0], [RB, 0], [-RR, H], [RR, H]]
  .map(([x, y]) => [x, y - HC]);
const NP = SUPPORT.length;

// Толчки левого: [момент, импульс на единицу массы]. Импульс с запасом на трение за время толчка
const PUSH_W = 0.12;
const PUSHES = [[T.nudge, 0.85], [T.shove, 1.40]];
export const pushForce = (t) => {
  let f = 0;
  for (const [tp, imp] of PUSHES) f += ((2 * imp) / PUSH_W) * bump(t - tp, PUSH_W);
  return f;
};

// Миска: центр масс (cx, cy), угол th (> 0 — верх уходит к +X), скорости.
// hit — скорость удара о пол за подшаг (для звука); accN/accT — накопленные импульсы опор, bn — отскок
export const makeBowl = (x0) => ({
  cx: x0, cy: HC, th: 0, vx: 0, vy: 0, w: 0, hit: 0,
  accN: new Float64Array(NP), accT: new Float64Array(NP), bn: new Float64Array(NP),
});

// Центр основания: там миска касается стола, когда стоит ровно
export const baseX = (b) => b.cx + HC * Math.sin(b.th);
export const baseY = (b) => b.cy - HC * Math.cos(b.th);

// Шаг миски: гравитация, толчок, контакты опор, интеграция
// Шаг миски: гравитация, толчок, контакты опор, интеграция. Опора — точка дна или края.
// Нормаль контакта: над столом и за его краем — вверх; внутри блока стола (сбоку и ниже столешницы)
// — к ближайшей грани. Так миска не «подхватывается» снизу, когда её край проходит у кромки стола.
export function stepBowl(b, f) {
  b.vx += f * DT;
  b.vy -= G * DT;
  const c = Math.cos(b.th), s = Math.sin(b.th);
  b.accN.fill(0);
  b.accT.fill(0);
  for (let it = 0; it < 4; it++) {
    for (let p = 0; p < NP; p++) {
      const [sx, sy] = SUPPORT[p];
      const rx = c * sx - s * sy, ry = s * sx + c * sy;     // опора относительно центра масс
      const wx = b.cx + rx, wy = b.cy + ry;                  // опора в мире
      const inFoot = Math.abs(wx) < TX;
      let nx = 0, ny = 1, pen;
      if (!inFoot) pen = FLOOR - wy;                         // за краем стола — пол
      else if (wy >= 0) pen = -wy;                           // над столешницей
      else if (TX - Math.abs(wx) < -wy) {                    // внутри блока: ближайшая грань — сбоку
        nx = wx >= 0 ? 1 : -1;
        ny = 0;
        pen = TX - Math.abs(wx);
      } else pen = -wy;                                      // внутри блока: ближайшая грань — сверху
      const vpx = b.vx - b.w * ry, vpy = b.vy + b.w * rx;   // скорость опоры
      const vn = vpx * nx + vpy * ny;
      if (it === 0) {
        b.bn[p] = ny === 1 && vn < -0.3 ? -REST * vn : 0;   // отскок только от пола и столешницы
        if (!inFoot && pen >= vn * DT && vn < -0.3) b.hit = Math.max(b.hit, -vn);
      }
      if (pen < vn * DT) continue;                           // не касается и не коснётся за подшаг
      const rn = rx * ny - ry * nx;                          // r × n: плечо нормального импульса
      const rt = rx * nx + ry * ny;                          // r · n: плечо касательного импульса
      const target = Math.max(pen > 0 ? (0.5 * pen) / DT : 0, b.bn[p]);
      const nNew = Math.max(0, b.accN[p] + (target - vn) / (1 + (rn * rn) / INERTIA));
      const dn = nNew - b.accN[p];
      b.accN[p] = nNew;
      b.vx += dn * nx;
      b.vy += dn * ny;
      b.w += (rn * dn) / INERTIA;
      // трение Кулона вдоль касательной t = (-ny, nx)
      const vt = -ny * (b.vx - b.w * ry) + nx * (b.vy + b.w * rx);
      const tNew = clamp(b.accT[p] - vt / (1 + (rt * rt) / INERTIA), -MU * nNew, MU * nNew);
      const dtn = tNew - b.accT[p];
      b.accT[p] = tNew;
      b.vx -= ny * dtn;
      b.vy += nx * dtn;
      b.w += (rt * dtn) / INERTIA;
    }
  }
  b.cx += b.vx * DT;
  b.cy += b.vy * DT;
  b.th += b.w * DT;
}
// ── Общий расчёт миски и зёрен (getBake) ──────────────────────────

const SEEDS_N = 800;                          // 640 справа и 160 слева
const END_S = 21.5;                           // к этому времени зёрна и миска стоят
const NEND = Math.round(END_S / DT);          // шагов физики до конца расчёта
const NREC = NEND / SUB + 1;                  // записей позиций зёрен с частотой SIM_HZ
let cache = null;

// Миска, засыпка, клевки и опрокидывание считаются один раз. Возвращает функции для сцены и звука
export function getBake() {
  if (cache) return cache;
  const bR = makeBowl(WORLD.bowlX.right);
  const bL = makeBowl(WORLD.bowlX.left);                       // левая миска стоит на месте
  const vR = { ox: 0, oy: 0, oz: WORLD.bowlZ, cx: 0, cy: 0, th: 0, vx: 0, vy: 0, w: 0, c: 1, s: 0 };
  const vL = { ox: baseX(bL), oy: baseY(bL), oz: WORLD.bowlZ, cx: bL.cx, cy: bL.cy, th: 0, vx: 0, vy: 0, w: 0, c: 1, s: 0 };
  const S = makeSeeds(SEEDS_N);
  const rnd = mulberry32(5);
  const queue = [];                                            // порядок появления: сначала правый ковш
  for (let k = 0; k < 640; k++) {
    queue.push({ t: T.pourFull[0] + ((k + 0.5) * (T.pourFull[1] - T.pourFull[0])) / 640, i: k, x: WORLD.bowlX.right });
  }
  for (let k = 0; k < 160; k++) {
    queue.push({ t: T.pourQuarter[0] + ((k + 0.5) * (T.pourQuarter[1] - T.pourQuarter[0])) / 160, i: 640 + k, x: WORLD.bowlX.left });
  }
  const rec = new Float32Array(NREC * SEEDS_N * 3);
  const bx = new Float64Array(NEND + 1), by = new Float64Array(NEND + 1), bth = new Float64Array(NEND + 1);
  const bowlEv = [];
  const saveRec = (r) => {
    const o = r * SEEDS_N * 3;
    for (let i = 0; i < SEEDS_N; i++) {
      rec[o + 3 * i] = S.x[i];
      rec[o + 3 * i + 1] = S.y[i];
      rec[o + 3 * i + 2] = S.z[i];
    }
  };
  saveRec(0);
  bx[0] = baseX(bR); by[0] = baseY(bR); bth[0] = bR.th;
  let qi = 0, pi = 0;
  for (let k = 0; k < NEND; k++) {
    const t = k * DT;
    bR.hit = 0;
    stepBowl(bR, pushForce(t));
    if (bR.hit > 0.3) bowlEv.push([t + DT, bR.hit, 3]);        // удар миски о пол
    while (qi < queue.length && queue[qi].t <= t) {
      const q = queue[qi];
      if (!spawnFree(S, q.i, t, q.x, 0.34, WORLD.bowlZ, rnd, 0.022, -1.2)) break;
      qi++;
    }
    while (pi < PECKS.length && PECKS[pi] <= t) {
      eatNear(S, 0, 640, baseX(bR), 0.045, WORLD.bowlZ - 0.025, 4, t);
      pi++;
    }
    vR.ox = baseX(bR); vR.oy = baseY(bR); vR.cx = bR.cx; vR.cy = bR.cy;
    vR.th = bR.th; vR.vx = bR.vx; vR.vy = bR.vy; vR.w = bR.w;
    stepSeeds(S, DT, t, [vR, vL]);
    bx[k + 1] = baseX(bR); by[k + 1] = baseY(bR); bth[k + 1] = bR.th;
    if ((k + 1) % SUB === 0) saveRec((k + 1) / SUB);
  }
  // Первая запись, где зерно уже есть: до неё позицию не интерполируем (иначе оно «прилетает» из нуля)
  const first = new Float64Array(SEEDS_N);
  for (let i = 0; i < SEEDS_N; i++) first[i] = Math.ceil(S.spawnAt[i] * SIM_HZ - 1e-9);
  const events = [];
  for (let k = 0; k < S.ev.length; k += 3) events.push([S.ev[k], S.ev[k + 1], S.ev[k + 2]]);
  for (const e of bowlEv) events.push(e);
  events.sort((a, b) => a[0] - b[0]);

  const bowl = (t) => {
    const idx = clamp(t / DT, 0, NEND);
    const i0 = Math.floor(idx), i1 = Math.min(i0 + 1, NEND), u = idx - i0;
    return { x: lerp(bx[i0], bx[i1], u), y: lerp(by[i0], by[i1], u), th: lerp(bth[i0], bth[i1], u) };
  };
  // Позиции зёрен в момент t в out (3N чисел); alive[i] = 1, если зерно сейчас на сцене. Возвращает их число
  const seeds = (t, out, alive) => {
    const r = clamp(t * SIM_HZ, 0, NREC - 1);
    const r0 = Math.floor(r), r1 = Math.min(r0 + 1, NREC - 1), f = r - r0;
    let count = 0;
    for (let i = 0; i < SEEDS_N; i++) {
      const on = t >= S.spawnAt[i] && t < S.eatenAt[i];
      alive[i] = on ? 1 : 0;
      if (!on) continue;
      count++;
      let a = r0, b = r1, u = f;
      if (a < first[i]) { a = first[i]; b = a; u = 0; }
      const oa = (a * SEEDS_N + i) * 3, ob = (b * SEEDS_N + i) * 3;
      for (let k = 0; k < 3; k++) out[3 * i + k] = rec[oa + k] + (rec[ob + k] - rec[oa + k]) * u;
    }
    return count;
  };
  cache = { bowl, bowlX: (t) => bowl(t).x, seeds, events, N: SEEDS_N, spawnAt: S.spawnAt, eatenAt: S.eatenAt, endS: END_S };
  return cache;
}
