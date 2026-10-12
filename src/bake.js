// src/bake.js, часть 1 из 3: миска как твёрдое тело в плоскости XY.
// Опоры — точки дна и края: стол (y = 0 при |x| ≤ TX) или пол (y = floorY) за краем стола.
// Импульсы накапливаются по итерациям, трение Кулона. Чистый JS без three.js.

import { T, WORLD, BOWL, SIM_HZ, DURATION } from './config.js';
import { clamp, bump } from './util.js';

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
