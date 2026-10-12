// Единый источник правды: тайминг сюжета, геометрия мира и миски.
// Сцена, физика и звук читают эти значения, поэтому всё синхронно.
import { mulberry32 } from './util.js';

export const FPS = 24;
export const DURATION = 30;   // сек → 720 кадров
export const SIM_HZ = 120;    // шаг физики зёрен и миски (кратен FPS)
export const SHUTTER = 0.5;   // «180°»: выдержка полкадра даёт естественное размытие движения
export const GRAVITY = 9.81;

// Сюжетные отметки, секунды
export const T = {
  pourFull: [1.6, 3.9],       // полная миска правому
  pourQuarter: [8.55, 8.92],  // четверть миски левому
  eatStart: 5.9,              // правый начинает клевать
  eatEnd: 12.9,
  stare: 9.6,                 // левый замирает в недоумении
  angry: 11.5,                // левый звереет
  hopsStart: 12.8,            // левый прыгает к сопернику
  nudge: 16.45,               // первый толчок миски
  shove: 17.3,                // решающий толчок
  flyOff: 23.3,               // правый в ярости улетает
};

// Мир, метры. Y вверх, камера смотрит в −Z, столешница на y = 0.
export const WORLD = {
  floorY: -0.76,
  table: { x: 0.5, z: 0.35 },           // полуразмеры столешницы
  bowlZ: 0.10,
  bowlX: { left: -0.24, right: 0.24 },
  parrotX: { left: -0.24, right: 0.24 },
  parrotZ: -0.02,
  seeds: { full: 640, quarter: 160 },   // полная и четверть миски
};

// Миска (профиль вращения), метры
export const BOWL = {
  rBase: 0.055,  // внешний радиус дна
  rRim: 0.088,   // внешний радиус у края
  height: 0.05,
  wall: 0.007,   // толщина стенки
  floor: 0.008,  // толщина дна
  mu: 0.3,       // трение о столешницу
};

export const SEED = { r: 0.0055 };  // радиус коллизии зерна

// Клевки правого попугая: общие для анимации головы и для удаления зёрен
export const PECKS = (() => {
  const rnd = mulberry32(7);
  const out = [];
  for (let t = T.eatStart; t < T.eatEnd; t += 0.135 + (rnd() - 0.5) * 0.03) out.push(t);
  return out;
})();

// Моргания: детерминированные времена по seed
export function blinkTimes(seed) {
  const rnd = mulberry32(seed);
  const out = [];
  for (let t = 1.2 + rnd() * 2; t < DURATION; t += 2.2 + rnd() * 2.6) out.push(t);
  return out;
}
