// src/sampling.js: подкадры для одного кадра видео. Выдержка — SHUTTER кадра, центрированная на его времени;
// проекция смещается на субпиксель по последовательности Халтона (сглаживание краёв без MSAA).
// Чистый JS: проверяется в Node без браузера.
import { FPS, SHUTTER } from './config.js';

// Радикально-инверсная последовательность Халтона: равномерно заполняет отрезок [0, 1)
export function halton(i, base) {
  let f = 1, r = 0;
  for (let n = i; n > 0; n = Math.floor(n / base)) {
    f /= base;
    r += f * (n % base);
  }
  return r;
}

// Подкадры кадра f: моменты времени, смещения (в пикселях, от -0.5 до 0.5) и номер для веса усреднения
export function frameSamples(f, samples) {
  const out = [];
  for (let k = 0; k < samples; k++) {
    const u = (k + 0.5) / samples - 0.5;               // от -0.5 до 0.5 долей выдержки
    const t = (f + SHUTTER * u) / FPS;
    const idx = f * samples + k + 1;                    // глобальный номер подкадра: последовательность не повторяется
    out.push({
      t: Math.max(0, t),
      jx: halton(idx, 2) - 0.5,
      jy: halton(idx, 3) - 0.5,
      n: k + 1,
    });
  }
  return out;
}
