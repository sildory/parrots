// src/choreo.js
// Хореография: для попугая side ('right' | 'left') и момента t возвращает позу,
// которую читает parrot.js (поля описаны в шапке parrot.js).
// Модуль не зависит от three.js и DOM, поэтому audio.mjs может импортировать из него CUES.
//
// Соглашения:
// • Сценарий — список [время, {канал: значение}]: канал приходит к значению к этому времени
//   (переход занимает EASE секунд перед ключом) и стоит до следующего ключа этого канала.
// • headYaw > 0 — поворот головы к +X, то есть вправо для зрителя.
// • flapHz постоянен: parrot.js считает фазу как 2π·hz·t, поэтому смена частоты дёргает крылья.

import { T, WORLD, PECKS, blinkTimes } from './config.js';
import { clamp, smooth, lerp, bump, spline, noise } from './util.js';

const EASE = 0.4;
const FLAP_HZ = 4.2;

const R0 = { x: WORLD.parrotX.right, z: WORLD.parrotZ };
const L0 = { x: WORLD.parrotX.left, z: WORLD.parrotZ };

// ── Служебные функции ─────────────────────────────────────────────

// Короткие импульсы: колокола шириной w в моментах times; сумма ограничена 1, умножена на a
const pulses = (t, times, w, a = 1) => {
  let s = 0;
  for (const c of times) s += bump(t - c, w);
  return Math.min(1, s) * a;
};

// Моменты от from до to с шагом step
const every = (from, to, step) => {
  const out = [];
  for (let t = from; t < to; t += step) out.push(t);
  return out;
};

// Один канал: держит значение, между ключами плавно переходит
function channel(arr) {
  return (t) => {
    let prev = arr[0][1];
    for (const [tk, vk] of arr) {
      const a = tk - EASE;
      if (t < a) return prev;
      if (t <= tk) return lerp(prev, vk, smooth((t - a) / EASE));
      prev = vk;
    }
    return prev;
  };
}

// Сценарий: [[t, {канал: значение}], ...] → функция t → {канал: значение}
function timeline(keys) {
  const chans = {};
  for (const [t, obj] of keys) {
    for (const k in obj) (chans[k] ??= []).push([t, obj[k]]);
  }
  const fns = Object.entries(chans).map(([k, arr]) => [k, channel(arr)]);
  return (t) => {
    const out = {};
    for (const [k, f] of fns) out[k] = f(t);
    return out;
  };
}

// Прыжки: парабола высоты h на отрезке [t0, t0 + d].
// prep — присед перед толчком, land — амортизация после приземления, air — доля полёта
function hopState(hops, t, start) {
  let x = start.x, z = start.z, y = 0, air = 0, prep = 0, land = 0;
  for (const h of hops) {
    prep += bump(t - (h.t0 - 0.12), 0.12);
    land += bump(t - (h.t0 + h.d), 0.2);
    if (t >= h.t0 + h.d) {
      x = h.to[0];
      z = h.to[1];
    } else if (t >= h.t0) {
      const u = (t - h.t0) / h.d;
      const [fx, fz] = h.from ?? [x, z];
      x = lerp(fx, h.to[0], u);
      z = lerp(fz, h.to[1], u);
      y = 4 * h.h * u * (1 - u);
      air = Math.sin(Math.PI * u);
    }
  }
  return { x, z, y, air, prep: Math.min(1, prep), land: Math.min(1, land) };
}

// ── Точки прыжков и толчка ────────────────────────────────────────

const PUSH_DX = 0.14;             // левый стоит слева от миски на этом расстоянии
const PUSH_Z = 0.14;              // и чуть ближе к камере, чем соперник
const PUSH_T0 = T.nudge - 0.25;   // начинает толкать чуть раньше первого толчка
const PUSH_T1 = T.shove + 0.4;    // после этого миска катится сама, и левый её не держит
const LEAVE_T = T.shove + 1.4;    // момент, когда левый отрывается от миски

// Правый на месте: три радостных подпрыгивания и встряска перед едой
const HOP_R = [0.2, 0.7, 1.2, 4.6].map((t0) => ({ t0, d: 0.36, h: 0.03, to: [R0.x, R0.z] }));

// Левый: к центру стола, к миске соперника, победный круг перед камерой, домой
const HOP_L = [
  { t0: T.hopsStart, d: 0.62, h: 0.13, to: [-0.02, 0.02] },
  { t0: 13.9, d: 0.55, h: 0.16, to: [WORLD.bowlX.right - PUSH_DX, PUSH_Z] },
  { t0: LEAVE_T, d: 0.6, h: 0.12, to: [0, 0.26] },
  { t0: 19.5, d: 0.75, h: 0.14, to: [L0.x, L0.z] },
];

// Точка толчка: левый держится слева от миски, пока она сдвигается
const pushX = (t, bowlX) => bowlX(clamp(t, PUSH_T0, PUSH_T1)) - PUSH_DX;

// Третий прыжок стартует из точки толчка, поэтому его начало зависит от положения миски
const leftHops = (bowlX) =>
  HOP_L.map((h, i) => (i === 2 ? { ...h, from: [pushX(h.t0, bowlX), PUSH_Z] } : h));

// ── Моменты звуков и движений (общие с audio.mjs) ─────────────────

const BLINK = { right: blinkTimes(11), left: blinkTimes(22) };
const CHIRP_R = [0.3, 0.6, 0.9, 1.2, 1.5, 1.8, 2.1, 2.5, 2.9, 3.3, 3.6, 4.0, 4.3];
const SQUAWK_L = [...every(11.6, T.hopsStart, 0.35), T.nudge, T.shove, T.shove + 1.5];
const SQUAWK_R = [T.nudge + 0.05, T.shove, ...every(19.6, T.flyOff, 0.45)];
const STOMP_R = every(19.9, T.flyOff, 0.5);
const JABS_L = [14.8, 15.1, 15.4, 15.7];

// ── Сценарии ──────────────────────────────────────────────────────

// Правый: радость → полная миска → клюёт → раздражён соперником → шок → ярость
const RIGHT = timeline([
  [0, {
    crest: 0.3, puff: 0.2, ruffle: 0, brow: 0, pupil: 1.2, lidTop: 0, lidBot: 0.6,
    gx: 0, gy: 0.2, wingLift: 0.4, flapAmp: 0.1, headPitch: -0.1, headYaw: 0,
    shake: 0, crouch: 0, tailFan: 0.5, wag: 0.3, follow: 0,
  }],
  [0.7, { crest: 1, wingLift: 1.0, flapAmp: 0.35 }],
  [1.5, { wingLift: 0.6, flapAmp: 0.12 }],
  [T.pourFull[0] + 0.1, {                         // ковш с зерном: глаза круглые
    pupil: 1.45, lidBot: 0.2, gx: 0.6, gy: 0.35, headPitch: -0.25, headYaw: 0.25,
    wingLift: 0.7, flapAmp: 0.1, puff: 0.2,
  }],
  [T.pourFull[1], { pupil: 1.3, puff: 0.35, ruffle: 0.2, headYaw: 0.1, gx: 0.2, gy: 0.2 }],
  [4.7, { headPitch: -0.05, ruffle: 0.6, wag: 0.4 }],                       // довольная встряска
  [5.4, { ruffle: 0.1, puff: 0.12, lidBot: 0.5, wag: 0.2, wingLift: 0.15, flapAmp: 0 }],
  [T.eatStart, {                                  // клюёт из полной миски
    headPitch: 0.55, crouch: 0.5, headYaw: 0, gx: 0, gy: -0.55, pupil: 1.0, lidTop: 0.05,
    lidBot: 0.45, crest: 0.85, tailFan: 0.3, wag: 0.12, puff: 0.1,
  }],
  [13.1, {                                        // заметил соперника
    headYaw: -1.0, headPitch: 0.15, gx: -0.9, gy: 0.1, lidTop: 0.25, brow: 0.45, lidBot: 0,
    crouch: 0.25, crest: 0.6, wag: 0.1,
  }],
  [13.8, { shake: 0.12, headPitch: 0.3, wingLift: 0.35, ruffle: 0.25 }],   // мотает головой
  [T.nudge, {                                     // первый толчок миски: шок
    shake: 0, headYaw: 0, headPitch: -0.2, brow: 0.9, crest: 1, puff: 0.6, ruffle: 0.5,
    pupil: 1.4, lidTop: 0, wingLift: 1.2, flapAmp: 0.6, gx: 0, gy: 0.2, follow: 0,
  }],
  [T.nudge + 0.65, { wingLift: 0.6, flapAmp: 0.2, ruffle: 0.3, pupil: 1.2 }],
  [T.shove + 0.1, { follow: 1, headPitch: 0.5 }],  // провожает миску взглядом
  [19.5, {                                        // ярость
    follow: 0, headPitch: -0.25, headYaw: -0.8, gx: -1, gy: 0.1, brow: 1, crest: 1,
    puff: 0.55, ruffle: 0.7, pupil: 0.6, lidTop: 0, lidBot: 0, wingLift: 0.55,
    flapAmp: 0.25, tailFan: 1, wag: 0.25, crouch: 0.3,
  }],
  [T.flyOff - 0.05, { crouch: 1 }],               // присед перед взлётом
]);

// Левый: скука → ковш и миска → недоумение → злость → прыжки к сопернику → толчки → триумф
const LEFT = timeline([
  [0, {
    crest: 0.05, puff: 0, ruffle: 0, brow: 0, pupil: 1, lidTop: 0.35, lidBot: 0,
    gx: 0.3, gy: 0, wingLift: 0.1, flapAmp: 0, headPitch: 0.1, headYaw: 0.35, headRoll: 0,
    crouch: 0.1, lean: 0, yaw: 0, tailFan: 0.3, wag: 0,
  }],
  [3.0, { headYaw: 0.2, gx: 0.25 }],
  [6.5, { headYaw: 0.4, gx: 0.2 }],
  [T.pourQuarter[0], {                            // ковш над миской: поднял голову
    headPitch: -0.15, gy: 0.5, gx: 0, headYaw: 0.1, lidTop: 0.12, pupil: 1.2, crest: 0.45,
  }],
  [9.1, { headPitch: 0.85, gy: -0.6, lidTop: 0.2, pupil: 1.0, crest: 0.3 }],   // смотрит в свою миску
  [T.stare, { headPitch: 0.25, headYaw: 0.9, gx: 1.0, gy: 0, lidTop: 0.12 }],  // на соседа
  [10.4, {                                        // в камеру: что?!
    headPitch: 0, headYaw: 0, gx: 0, headRoll: 0.25, pupil: 0.8, lidTop: 0, crest: 0.2,
  }],
  [11.1, { headPitch: 0.6, gy: -0.4, headRoll: 0.1, lidTop: 0.25 }],          // ещё раз в миску
  [T.angry + 0.4, {                               // злость
    headPitch: 0.25, gy: 0, headRoll: 0, lidTop: 0.15, headYaw: 0.6, gx: 0.9, crest: 1,
    ruffle: 0.9, puff: 0.6, brow: 1, pupil: 0.55, wingLift: 0.4, flapAmp: 0.15,
    crouch: 0.35, tailFan: 0.8, wag: 0.15,
  }],
  [12.75, { yaw: 1.2 }],                          // разворачивается к миске соперника
  [14.6, {                                        // на краю миски: машет крыльями сопернику в лицо
    yaw: 1.571, headYaw: 0.5, headPitch: 0.35, gx: 0.6, gy: -0.1, wingLift: 1.1,
    flapAmp: 0.7, lean: 0.2, crouch: 0.3,
  }],
  [PUSH_T0, {                                     // упор в миску
    wingLift: 0.9, flapAmp: 0.3, lean: 0.25, crouch: 0.35, gx: 0.8, headPitch: 0.35, headYaw: 0.2,
  }],
  [LEAVE_T - 0.1, {                               // триумф: грудь колесом, полуприкрытые глаза
    yaw: 0, lean: 0, crouch: 0.1, crest: 1, puff: 0.45, ruffle: 0.2, brow: 0, pupil: 1.0,
    lidTop: 0.4, lidBot: 0.5, gx: 0, gy: 0.1, wingLift: 0.9, flapAmp: 0.4, headPitch: -0.1,
    headYaw: 0, tailFan: 0.7, wag: 0.25,
  }],
  [20.6, { wingLift: 0.12, flapAmp: 0, puff: 0.3, headPitch: 0, headRoll: -0.08, tailFan: 0.5, wag: 0.2 }],
  [23.6, { headYaw: 0.9, gx: 0.8, gy: 0.3 }],    // провожает взглядом улетающего соперника
  [27.3, { headYaw: 0, gx: 0, gy: 0, headRoll: -0.04, lidTop: 0.1, lidBot: 0.55 }],  // смотрит в камеру
]);
// ── Вспомогательные импульсы и константы части 2 ──────────────────

const PECK_W = 0.12;                  // длительность одного клевка, с
const TRY_R = [13.5, 14.3, 15.5];     // правый пытается клюнуть, но его отвлекают
const FLY0 = T.flyOff + 0.25;         // отрыв от стола после приседа
const FLY1 = 26.9;                    // к этому моменту правый уже за краем кадра
const SQUAWK_FLY = FLY0 + 0.25;       // яростный крик на взлёте
const FINAL_BLINK = 28.4;             // медленное подмигивание левого в финале
const BLINK_L = BLINK.left.filter((b) => b < 27); // случайные моргания после 27 с не нужны: финал задан явно

// Колокол с пиком ровно в момент c (pulses из части 1 пикует на c + w/2)
const around = (t, times, w, a = 1) => {
  let s = 0;
  for (const c of times) s += bump(t - c + w / 2, w);
  return Math.min(1, s) * a;
};

// Смешивание двух поз: числа и взгляд интерполируются, остальные поля берутся из b
const mixPose = (a, b, m) => {
  const out = { ...a };
  for (const k in b) {
    const va = a[k];
    const vb = b[k];
    if (k === 'gaze') out.gaze = { x: lerp(va.x, vb.x, m), y: lerp(va.y, vb.y, m) };
    else if (typeof va === 'number' && typeof vb === 'number') out[k] = lerp(va, vb, m);
    else out[k] = vb;
  }
  return out;
};

// ── Позы ──────────────────────────────────────────────────────────

// Правый: радость, клевки, попытки под тычками, шок от толчков, топот и подъём крыльев перед взлётом
function rightPose(t, bx) {
  const c = RIGHT(t);
  const hop = hopState(HOP_R, t, R0);
  const dip = around(t, PECKS, PECK_W);                 // клевки из миски
  const tryDip = around(t, TRY_R, 0.16, 0.6);           // неудачные попытки
  const chirp = around(t, CHIRP_R, 0.22, 0.6);          // щебет
  const blink = around(t, BLINK.right, 0.2);
  const shock = around(t, [T.nudge, T.shove], 0.3);     // толчки миски
  const flinch = around(t, JABS_L, 0.3);                // тычки соперника
  const stomp = around(t, STOMP_R, 0.25);               // топот
  const takeoff = smooth((t - T.flyOff) / 0.25);        // подъём крыльев перед взлётом
  const trackYaw = clamp(Math.atan2(bx(t) - R0.x, WORLD.bowlZ - R0.z), -1.1, 1.1);
  const idle = (k) => noise(t * 0.7, 10 + k);

  return {
    t,
    visible: true,
    x: R0.x,
    y: hop.y,
    z: R0.z,
    yaw: 0,
    crouch: clamp(c.crouch + 0.35 * hop.prep + 0.3 * hop.land + 0.12 * stomp + 0.05 * dip),
    lean: 0,
    puff: c.puff,
    headPitch: c.headPitch + 0.4 * dip + 0.25 * tryDip - 0.1 * shock + 0.03 * idle(0),
    headYaw: lerp(c.headYaw, trackYaw, c.follow) + c.shake * Math.sin(2 * Math.PI * 5.5 * t)
      - 0.2 * flinch + 0.04 * idle(1),
    headRoll: (c.headRoll ?? 0) + 0.03 * idle(2),
    beak: Math.max(0.35 * dip, 0.6 * chirp, 0.3 * tryDip),
    lidTop: Math.max(c.lidTop, blink),
    lidBot: c.lidBot,
    brow: c.brow,
    pupil: c.pupil,
    gaze: { x: c.gx, y: c.gy },
    crest: clamp(c.crest + 0.2 * shock),
    ruffle: clamp(c.ruffle + 0.3 * shock + 0.2 * flinch),
    wingLift: lerp(c.wingLift, 1.2, takeoff) + 0.1 * flinch,
    flapAmp: lerp(c.flapAmp, 0.4, takeoff) + 0.2 * flinch,
    flapHz: FLAP_HZ,
    wingSweep: 0,
    wingFan: 0,
    tailAngle: 0.9,
    tailWag: c.wag * Math.sin(2 * Math.PI * 2.4 * t),
    tailFan: c.tailFan,
    tuck: 0.5 * hop.air,
  };
}

// Левый: недоумение, злость, прыжки к сопернику, толчки, триумф
function leftPose(t, bx) {
  const c = LEFT(t);
  const hop = hopState(leftHops(bx), t, L0);
  const pushing = t >= PUSH_T0 && t < LEAVE_T;          // держит миску на расстоянии толчка
  const lunge = around(t, [T.nudge, T.shove], 0.5);     // упор в миску
  const jab = around(t, JABS_L, 0.22);                  // тычки клювом
  const squawk = around(t, SQUAWK_L, 0.3);              // крики
  const blink = Math.max(around(t, BLINK_L, 0.2), around(t, [FINAL_BLINK], 0.45));
  const idle = (k) => noise(t * 0.6, 30 + k);

  return {
    t,
    visible: true,
    x: pushing ? pushX(t, bx) : hop.x,
    y: hop.y,
    z: hop.z,
    yaw: c.yaw,
    crouch: clamp(c.crouch + 0.3 * hop.prep + 0.25 * hop.land + 0.1 * lunge),
    lean: c.lean + 0.14 * lunge,
    puff: c.puff,
    headPitch: c.headPitch + 0.3 * jab + 0.03 * idle(0),
    headYaw: c.headYaw + 0.04 * idle(1),
    headRoll: c.headRoll + 0.02 * idle(2),
    beak: Math.max(0.85 * squawk, 0.4 * jab),
    lidTop: Math.max(c.lidTop, blink),
    lidBot: c.lidBot,
    brow: c.brow,
    pupil: c.pupil,
    gaze: { x: c.gx, y: c.gy },
    crest: c.crest,
    ruffle: c.ruffle,
    wingLift: c.wingLift,
    flapAmp: c.flapAmp + 0.15 * lunge,
    flapHz: FLAP_HZ,
    wingSweep: 0,
    wingFan: 0,
    tailAngle: 0.9,
    tailWag: c.wag * Math.sin(2 * Math.PI * 3 * t),
    tailFan: c.tailFan,
    tuck: 0.6 * hop.air,
  };
}

// Полёт правого: присед → отрыв → дуга вправо и вверх, за край кадра к FLY1
function flightPose(t) {
  const u = clamp((t - FLY0) / (FLY1 - FLY0));
  const k = u * u;          // разгон от старта
  const s = smooth(u);
  return {
    t,
    x: lerp(R0.x, 1.9, k),
    y: 2.1 * k,
    z: R0.z - 0.3 * u,
    yaw: 1.4 * s,           // боком к зрителю, в сторону полёта
    crouch: 0,
    lean: lerp(-0.6, -1.45, s),   // нос задирается вверх
    puff: 0.15,
    headPitch: -0.2,
    headYaw: -0.3,
    headRoll: 0,
    beak: around(t, [SQUAWK_FLY], 0.5),
    lidTop: 0,
    lidBot: 0,
    brow: 1,
    pupil: 0.6,
    gaze: { x: -1, y: 0.2 },      // косится назад, на соперника
    crest: 1,
    ruffle: 0.7,
    wingLift: 1.0,
    flapAmp: 1.0,
    flapHz: FLAP_HZ,
    wingSweep: -0.2,
    wingFan: 0.7,
    tailAngle: 1.5,
    tailWag: 0.2 * Math.sin(2 * Math.PI * 3 * t),
    tailFan: 1,
    tuck: 0.8,
  };
}

// ── Публичный API ─────────────────────────────────────────────────

// Поза попугая side ('right' | 'left') в момент t. bowlX(t) — x-координата миски правого
export function poseFor(side, t, { bowlX } = {}) {
  const bx = bowlX ?? (() => WORLD.bowlX.right);
  if (side === 'left') return leftPose(t, bx);
  const base = rightPose(t, bx);
  if (t < T.flyOff) return base;
  const out = mixPose(base, flightPose(t), smooth((t - FLY0) / 0.2));
  out.visible = t < FLY1 + 0.05;
  return out;
}

// Отметки для звука (audio.mjs), в секундах. Поля *Window — пары [начало, конец]
export const CUES = {
  pourFullWindow: T.pourFull,
  pourQuarterWindow: T.pourQuarter,
  eatWindow: [T.eatStart, T.eatEnd],
  peck: PECKS,
  tryPeck: TRY_R,
  chirpRight: CHIRP_R,
  squawkLeft: SQUAWK_L,
  squawkRight: SQUAWK_R,
  angry: [T.angry],
  jab: JABS_L,
  push: [T.nudge, T.shove],
  stomp: STOMP_R,
  hopRight: HOP_R.map((h) => h.t0),
  landRight: HOP_R.map((h) => h.t0 + h.d),
  hopLeft: HOP_L.map((h) => h.t0),
  landLeft: HOP_L.map((h) => h.t0 + h.d),
  takeoff: [SQUAWK_FLY],
  flightWindow: [FLY0, FLY1],
};
