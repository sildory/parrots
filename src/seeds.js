// src/seeds.js: зёрна как сферы радиуса SEED.r. Position-based dynamics: контакты зёрен
// между собой, со столом и полом, со стенкой миски (расстояние до профиля вращения).
// Трение Кулона в позиционной форме. Не зависит от three.js: вызывается из bake.js.

import { WORLD, BOWL, SEED } from './config.js';
import { clamp } from './util.js';

const G = 9.81;
const R = SEED.r;
const TX = WORLD.table.x;
const TZ = WORLD.table.z;
const FLOOR = WORLD.floorY;
const MU = 0.45;                  // трение Кулона
const ITER = 4;                   // проходов контактов на подшаг
const EVT_MIN = 0.6;              // м/с: более слабые удары звука не дают
const HASH = 4096;
const CELL = 2.5 * R;             // ячейка хеша с запасом: пары ищутся по предсказанию
const BOUND2 = (0.1 + R) ** 2;    // вне этого радиуса от центра миски зерно её точно не касается
const { rBase: RB, rRim: RR, height: H, wall: WALL, floor: FT } = BOWL;

// Профиль стенки миски (ρ от оси, y от дна): сегменты [ax, ay, bx, by]
const SEGS = [
  [0, 0, RB, 0],
  [RB, 0, RR, H],
  [RR, H, RR - WALL, H],
  [RR - WALL, H, RB - WALL, FT],
  [RB - WALL, FT, 0, FT],
];

// Замкнутый контур сечения материала миски (дно и стенка): для знака расстояния
const PX = [0, RB, RR, RR - WALL, RB - WALL, 0];
const PY = [0, 0, H, H, FT, FT];

const Q = { d: 0, nx: 0, ny: 0, nz: 0 };   // результат sdf: расстояние со знаком и нормаль, без аллокаций

// Состояние n зёрен. spawnAt/eatenAt — моменты появления и исчезновения.
// ev — плоский список событий ударов: [t, скорость, тип], тип 0 — стол, 1 — пол, 2 — миска
export function makeSeeds(n) {
  const f = () => new Float64Array(n);
  return {
    n,
    x: f(), y: f(), z: f(), vx: f(), vy: f(), vz: f(),
    px: f(), py: f(), pz: f(),
    on: new Uint8Array(n),
    spawnAt: f().fill(Infinity),
    eatenAt: f().fill(Infinity),
    head: new Int32Array(HASH),
    next: new Int32Array(n),
    stamp: new Int32Array(HASH),
    stampId: 0,
    pairs: new Int32Array(80 * n),
    ev: [],
  };
}

export function spawn(S, i, t, x, y, z, vy0 = 0) {
  S.x[i] = S.px[i] = x;
  S.y[i] = S.py[i] = y;
  S.z[i] = S.pz[i] = z;
  S.vx[i] = S.vz[i] = 0;
  S.vy[i] = vy0;
  S.on[i] = 1;
  S.spawnAt[i] = t;
}

// Появление в случайной точке диска радиуса rad над (sx, sy, sz), где нет других зёрен ближе 2.2R.
// Возвращает false, если свободного места нет: тогда вызывающий повторит попытку на следующем подшаге
export function spawnFree(S, i, t, sx, sy, sz, rnd, rad, vy0 = 0) {
  for (let tries = 0; tries < 40; tries++) {
    const a = 2 * Math.PI * rnd(), rr = rad * Math.sqrt(rnd());
    const x = sx + rr * Math.cos(a), z = sz + rr * Math.sin(a), y = sy + 0.02 * rnd();
    let ok = true;
    for (let j = 0; j < S.n && ok; j++) {
      if (!S.on[j]) continue;
      const dx = S.x[j] - x, dy = S.y[j] - y, dz = S.z[j] - z;
      if (dx * dx + dy * dy + dz * dz < (2.2 * R) ** 2) ok = false;
    }
    if (ok) {
      spawn(S, i, t, x, y, z, vy0);
      return true;
    }
  }
  return false;
}

// Съесть k ближайших зёрен диапазона [a, b) к точке: зерно выходит из симуляции
export function eatNear(S, a, b, x0, y0, z0, k, t) {
  const cand = [];
  for (let i = a; i < b; i++) {
    if (!S.on[i]) continue;
    const dx = S.x[i] - x0, dy = S.y[i] - y0, dz = S.z[i] - z0;
    cand.push([dx * dx + dy * dy + dz * dz, i]);
  }
  cand.sort((p, q) => p[0] - q[0]);
  const m = Math.min(k, cand.length);
  for (let j = 0; j < m; j++) {
    S.on[cand[j][1]] = 0;
    S.eatenAt[cand[j][1]] = t;
  }
  return m;
}

// Расстояние от точки до стенки миски (для проверок). b — поза миски, как в stepSeeds
export function bowlGap(b, x, y, z) {
  b.c = Math.cos(b.th);
  b.s = Math.sin(b.th);
  sdf(b, x, y, z);
  return Q.d;
}

const cellKey = (ix, iy, iz) => ((ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791)) & (HASH - 1);

// Пары соседей по предсказанным позициям: пишутся в S.pairs парами чисел, возвращается их количество
function buildPairs(S) {
  const { n, px, py, pz, on, head, next, stamp, pairs } = S;
  const inv = 1 / CELL;
  head.fill(-1);
  for (let i = 0; i < n; i++) {
    if (!on[i]) continue;
    const k = cellKey(Math.floor(px[i] * inv), Math.floor(py[i] * inv), Math.floor(pz[i] * inv));
    next[i] = head[k];
    head[k] = i;
  }
  let np = 0;
  const lim = CELL * CELL;
  for (let i = 0; i < n; i++) {
    if (!on[i]) continue;
    const ix = Math.floor(px[i] * inv), iy = Math.floor(py[i] * inv), iz = Math.floor(pz[i] * inv);
    const st = ++S.stampId;
    for (let ox = -1; ox <= 1; ox++) {
      for (let oy = -1; oy <= 1; oy++) {
        for (let oz = -1; oz <= 1; oz++) {
          const k = cellKey(ix + ox, iy + oy, iz + oz);
          if (stamp[k] === st) continue;          // корзина уже просмотрена для этого зерна
          stamp[k] = st;
          for (let j = head[k]; j !== -1; j = next[j]) {
            if (j <= i) continue;
            const dx = px[i] - px[j], dy = py[i] - py[j], dz = pz[i] - pz[j];
            if (dx * dx + dy * dy + dz * dz < lim) {
              pairs[np++] = i;
              pairs[np++] = j;
            }
          }
        }
      }
    }
  }
  return np;
}

// Зерно–зерно: взаимная коррекция на половину проникновения и трение по относительному смещению
function solvePairs(S, np) {
  const { px, py, pz, x, y, z, pairs } = S;
  for (let k = 0; k < np; k += 2) {
    const i = pairs[k], j = pairs[k + 1];
    const dx = px[i] - px[j], dy = py[i] - py[j], dz = pz[i] - pz[j];
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (d >= 2 * R || d < 1e-12) continue;
    const nx = dx / d, ny = dy / d, nz = dz / d;
    const c = 0.5 * (2 * R - d);
    px[i] += nx * c; py[i] += ny * c; pz[i] += nz * c;
    px[j] -= nx * c; py[j] -= ny * c; pz[j] -= nz * c;
    const rx = px[i] - x[i] - px[j] + x[j];
    const ry = py[i] - y[i] - py[j] + y[j];
    const rz = pz[i] - z[i] - pz[j] + z[j];
    const dn = rx * nx + ry * ny + rz * nz;
    const tx = rx - dn * nx, ty = ry - dn * ny, tz = rz - dn * nz;
    const mt = Math.sqrt(tx * tx + ty * ty + tz * tz);
    if (mt < 1e-15) continue;
    const f = 0.5 * (mt <= 2 * MU * c ? 1 : (2 * MU * c) / mt);
    px[i] -= tx * f; py[i] -= ty * f; pz[i] -= tz * f;
    px[j] += tx * f; py[j] += ty * f; pz[j] += tz * f;
  }
}

// Стол — блок от пола до столешницы. Зерно, оказавшееся внутри блока (например, сбоку и ниже столешницы),
// выталкивается к ближайшей грани: наверх или наружу. Вне блока опора — столешница или пол
function solveStatic(S, i, t, dt, it) {
  const px = S.px[i], py = S.py[i], pz = S.pz[i];
  const inFoot = Math.abs(px) < TX && Math.abs(pz) < TZ;
  if (inFoot && py < 0) {
    const mY = R - py, mX = TX + R - Math.abs(px), mZ = TZ + R - Math.abs(pz);
    if (mY <= mX && mY <= mZ) S.py[i] = R;
    else if (mX <= mZ) S.px[i] = (px >= 0 ? 1 : -1) * (TX + R);
    else S.pz[i] = (pz >= 0 ? 1 : -1) * (TZ + R);
    return;
  }
  const c = (inFoot ? 0 : FLOOR) + R - py;
  if (c <= 0) return;
  if (it === 0) {
    const vn = (py - S.y[i]) / dt;
    if (vn < -EVT_MIN) S.ev.push(t, -vn, inFoot ? 0 : 1);
  }
  S.py[i] += c;
  const dx = S.px[i] - S.x[i], dz = S.pz[i] - S.z[i];
  const dm = Math.sqrt(dx * dx + dz * dz), lim = MU * c;
  if (dm <= lim) {
    S.px[i] = S.x[i];
    S.pz[i] = S.z[i];
  } else {
    const f = lim / dm;
    S.px[i] -= dx * f;
    S.pz[i] -= dz * f;
  }
}

// Расстояние до стенки и нормаль в мировых координатах (в Q). Миска — тело вращения вокруг своей оси,
// ось лежит в плоскости XY и поворачивается вместе с миской; b.c и b.s — cos и sin её угла
function sdf(b, x, y, z) {
  const dx = x - b.ox, dy = y - b.oy, dz = z - b.oz;
  const lx = b.c * dx + b.s * dy;         // горизонталь в системе миски
  const ly = b.c * dy - b.s * dx;         // ось миски
  const rho = Math.sqrt(lx * lx + dz * dz);
  let best = Infinity, qr = 0, qy = 0;
  for (let s = 0; s < 5; s++) {
    const sg = SEGS[s];
    const ex = sg[2] - sg[0], ey = sg[3] - sg[1];
    const u = clamp(((rho - sg[0]) * ex + (ly - sg[1]) * ey) / (ex * ex + ey * ey));
    const cr = sg[0] + u * ex, cy = sg[1] + u * ey;
    const d = Math.sqrt((rho - cr) * (rho - cr) + (ly - cy) * (ly - cy));
    if (d < best) { best = d; qr = cr; qy = cy; }
  }
  // Знак: внутри материала стенки или дна расстояние отрицательно, градиент всегда смотрит наружу
  let inside = false;
  for (let k = 0, m = 5; k < 6; m = k, k++) {
    const xi = PX[k], yi = PY[k], xj = PX[m], yj = PY[m];
    if ((yi > ly) !== (yj > ly) && rho < xi + ((ly - yi) * (xj - xi)) / (yj - yi)) inside = !inside;
  }
  const sg = inside ? -1 : 1;
  let nrK = 0, nyK = sg;
  if (best > 1e-12) {
    nrK = (sg * (rho - qr)) / best;
    nyK = (sg * (ly - qy)) / best;
  }
  let nlx = 0, nlz = 0;
  if (rho > 1e-9) {
    nlx = (nrK * lx) / rho;
    nlz = (nrK * dz) / rho;
  }
  Q.d = sg * best;
  Q.nx = b.c * nlx - b.s * nyK;
  Q.ny = b.s * nlx + b.c * nyK;
  Q.nz = nlz;
}

// Стенка миски: зерно выталкивается по нормали; трение относительно движения стенки в точке контакта
function solveBowl(S, i, b, t, dt, it) {
  const px = S.px[i], py = S.py[i], pz = S.pz[i];
  const ex = px - b.cx, ey = py - b.cy, ez = pz - b.oz;
  if (ex * ex + ey * ey + ez * ez > BOUND2) return;
  sdf(b, px, py, pz);
  const c = R - Q.d;
  if (c <= 0) return;
  const nx = Q.nx, ny = Q.ny, nz = Q.nz;
  const qx = px - nx * Q.d, qy = py - ny * Q.d;          // точка стенки под зерном
  const vcx = b.vx - b.w * (qy - b.cy);                  // скорость стенки в этой точке
  const vcy = b.vy + b.w * (qx - b.cx);
  if (it === 0) {
    const vn = ((px - S.x[i]) / dt - vcx) * nx + ((py - S.y[i]) / dt - vcy) * ny + ((pz - S.z[i]) / dt) * nz;
    if (vn < -EVT_MIN) S.ev.push(t, -vn, 2);
  }
  const qpx = px + nx * c, qpy = py + ny * c, qpz = pz + nz * c;
  const rx = qpx - S.x[i] - vcx * dt;                    // смещение зерна минус смещение стенки
  const ry = qpy - S.y[i] - vcy * dt;
  const rz = qpz - S.z[i];
  const dn = rx * nx + ry * ny + rz * nz;
  const tx = rx - dn * nx, ty = ry - dn * ny, tz = rz - dn * nz;
  const mt = Math.sqrt(tx * tx + ty * ty + tz * tz);
  const lim = MU * c;
  const f = mt <= lim ? 1 : mt > 0 ? lim / mt : 0;
  S.px[i] = qpx - tx * f;
  S.py[i] = qpy - ty * f;
  S.pz[i] = qpz - tz * f;
}

// Один подшаг: предсказание, пары, контакты (ITER проходов), скорости из смещений
export function stepSeeds(S, dt, t, bowls) {
  const { n, x, y, z, vx, vy, vz, px, py, pz, on } = S;
  for (const b of bowls) {
    b.c = Math.cos(b.th);
    b.s = Math.sin(b.th);
  }
  for (let i = 0; i < n; i++) {
    if (!on[i]) continue;
    vy[i] -= G * dt;
    px[i] = x[i] + vx[i] * dt;
    py[i] = y[i] + vy[i] * dt;
    pz[i] = z[i] + vz[i] * dt;
  }
  const np = buildPairs(S);
  for (let it = 0; it < ITER; it++) {
    solvePairs(S, np);
    for (let i = 0; i < n; i++) {
      if (!on[i]) continue;
      solveStatic(S, i, t, dt, it);
      for (const b of bowls) solveBowl(S, i, b, t, dt, it);
    }
  }
  for (let i = 0; i < n; i++) {
    if (!on[i]) continue;
    vx[i] = (px[i] - x[i]) / dt;
    vy[i] = (py[i] - y[i]) / dt;
    vz[i] = (pz[i] - z[i]) / dt;
    x[i] = px[i];
    y[i] = py[i];
    z[i] = pz[i];
  }
}
