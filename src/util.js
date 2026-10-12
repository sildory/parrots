// Общие утилиты: ключевые кадры, сплайны, шум, генератор случайных чисел.
// Без зависимостей: работает и в браузере, и в Node (для звука).

export const clamp = (x, a = 0, b = 1) => (x < a ? a : x > b ? b : x);

export const smooth = (x) => {
  const u = clamp(x);
  return u * u * (3 - 2 * u);
};

export const lerp = (a, b, u) => a + (b - a) * u;

// Импульс 0 → 1 → 0 на отрезке [0, w]
export const bump = (x, w) => (x < 0 || x > w ? 0 : Math.sin((Math.PI * x) / w) ** 2);

const mix = (a, b, u) =>
  Array.isArray(a) ? a.map((v, i) => v + (b[i] - v) * u) : a + (b - a) * u;

// Ступенчатый трек: keys = [[t, value], ...], между ключами smoothstep.
// Одинаковые t дают мгновенный скачок (для резких реакций).
export function track(keys) {
  return (t) => {
    if (t <= keys[0][0]) return keys[0][1];
    for (let i = 0; i < keys.length - 1; i++) {
      const [t0, v0] = keys[i];
      const [t1, v1] = keys[i + 1];
      if (t <= t1) return mix(v0, v1, smooth((t - t0) / Math.max(1e-9, t1 - t0)));
    }
    return keys[keys.length - 1][1];
  };
}

const cr = (p0, p1, p2, p3, u) => {
  const u2 = u * u, u3 = u2 * u;
  return 0.5 * (2 * p1 + (p2 - p0) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (3 * p1 - p0 - 3 * p2 + p3) * u3);
};

// Catmull-Rom по ключам [[t, value], ...]: для камеры и руки, без остановок на ключах.
export function spline(keys) {
  const n = keys.length;
  return (t) => {
    if (t <= keys[0][0]) return keys[0][1];
    if (t >= keys[n - 1][0]) return keys[n - 1][1];
    let i = 0;
    while (t > keys[i + 1][0]) i++;
    const t0 = keys[i][0], t1 = keys[i + 1][0];
    const p1 = keys[i][1], p2 = keys[i + 1][1];
    const p0 = keys[Math.max(0, i - 1)][1], p3 = keys[Math.min(n - 1, i + 2)][1];
    const u = (t - t0) / (t1 - t0);
    if (Array.isArray(p1)) return p1.map((_, k) => cr(p0[k], p1[k], p2[k], p3[k], u));
    return cr(p0, p1, p2, p3, u);
  };
}

const hash = (n) => {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

// Гладкий 1D-шум в диапазоне [-1, 1]: ручная тряска камеры, дрожание рук
export function noise(t, seed = 0) {
  const i = Math.floor(t), f = t - i, u = f * f * (3 - 2 * f);
  const a = hash(i + seed * 57.3), b = hash(i + 1 + seed * 57.3);
  return (a + (b - a) * u) * 2 - 1;
}

// Детерминированный генератор случайных чисел [0, 1)
export function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
