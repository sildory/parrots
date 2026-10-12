// src/parrot.js
// Риг попугая: туловище, шея и голова, клюв с раскрытием, веки и зрачки,
// гребень, крылья с регулируемым размахом, хвост, лапы.
// Поза задаётся объектом pose (его формирует choreo.js), apply(pose) применяет её к ригу.
//
// Контракт позы (все поля необязательны):
//   t                      время, сек: для дыхания и шума
//   visible                показывать попугая
//   x, y, z, yaw           положение корня; y > 0 — прыжок
//   crouch 0..1            приседание: туловище ниже и наклоннее
//   lean                   дополнительный наклон туловища вперёд, рад
//   puff 0..1              надув перьев
//   headPitch              наклон головы, рад (+ вниз)
//   headYaw                поворот головы, рад (+ вправо)
//   headRoll               крен головы, рад
//   beak 0..1              раскрытие клюва
//   lidTop, lidBot 0..1    верхнее веко (1 — закрыто), нижнее (1 — «улыбка»)
//   brow -1..1             злость: верхние веки опускаются к переносице
//   pupil                  размер зрачка, 1 — норма
//   gaze {x, y} -1..1      направление взгляда
//   crest 0..1             подъём гребня
//   ruffle 0..1            ерошение перьев
//   wingLift               размах крыльев, рад (0 — сложены, π/2 — в стороны, π — вверх)
//   flapAmp, flapHz        амплитуда (рад) и частота взмаха (Гц)
//   wingSweep              наклон крыльев вперёд-назад, рад
//   wingFan 0..1           раскрытие маховых перьев
//   tailAngle              угол хвоста, рад: 0 — вниз, ~0.9 — вниз-назад, ~2 — назад-вверх
//   tailWag                виляние хвостом, рад
//   tailFan 0..1           веер хвоста
//   tuck 0..1              поджатие лап в полёте

import * as THREE from 'three';
import { clamp, lerp, noise } from './util.js';

// Палитры: правый — весёлый волнистый (зелёный, жёлтое лицо), левый — хмурый корелла (серый)
const PALETTE = {
  right: {
    dorsal: '#4fae3a', ventral: '#f7e35c', face: '#ffe86a', cheek: '#ff9b2e',
    wing: '#2f9a3a', wingTip: '#2a4fb0', crest: '#ffd64a', crestTip: '#ff9f2a',
    ring: '#f4f1d8', beak: '#f0a43a', feet: '#8b7a66',
  },
  left: {
    dorsal: '#8e97a3', ventral: '#eef0f3', face: '#f7f7f2', cheek: '#ff7a1c',
    wing: '#77818e', wingTip: '#3c4450', crest: '#a7b0bb', crestTip: '#6e7884',
    ring: '#e9e9e4', beak: '#2f3038', feet: '#6f6b67',
  },
};

// Профиль туловища (радиус, высота), снизу вверх
const BODY_PROFILE = [
  [0.0, -0.082], [0.028, -0.072], [0.05, -0.044], [0.062, -0.008],
  [0.067, 0.028], [0.063, 0.062], [0.052, 0.088], [0.034, 0.104], [0.0, 0.11],
].map(([r, y]) => new THREE.Vector2(r, y));

// Перья гребня: [смещение по X, базовый угол веера, длина]
const CREST_LAYOUT = [
  [-0.011, 0.45, 0.05], [-0.0055, 0.2, 0.062], [0, 0, 0.07],
  [0.0055, -0.2, 0.062], [0.011, -0.45, 0.05],
];

// Перья хвоста: [угол веера, длина]
const TAIL_LAYOUT = [[-0.22, 0.095], [-0.11, 0.105], [0, 0.11], [0.11, 0.105], [0.22, 0.095]];

// Перья крыла: [y, z, длина, ширина, веер, слой]; слой: 0 — кроющие, 1 — второстепенные, 2 — маховые
const WING_LAYOUT = [
  ...[0, 1, 2, 3, 4, 5].map((i) => [-0.004 - 0.0096 * i, 0.01, 0.04, 0.021, 0, 0]),
  ...[0, 1, 2, 3, 4].map((i) => [-0.03 - 0.0105 * i, -0.002 - 0.0012 * i, 0.058, 0.019, 0.05, 1]),
  ...[0, 1, 2, 3, 4, 5, 6].map((i) => [-0.058 - 0.0055 * i, -0.01 - 0.0022 * i, 0.06 + 0.002 * i, 0.0125, 0.1 + 0.035 * i, 2]),
];

// Контуры клюва в плоскости (вперёд, вверх)
const UPPER_BEAK = (s) => {
  s.moveTo(-0.004, 0.018);
  s.bezierCurveTo(0.018, 0.024, 0.04, 0.016, 0.047, -0.004);
  s.bezierCurveTo(0.05, -0.013, 0.041, -0.019, 0.033, -0.014);
  s.bezierCurveTo(0.023, -0.01, 0.01, -0.009, -0.004, -0.008);
  s.closePath();
};

const LOWER_BEAK = (s) => {
  s.moveTo(-0.004, -0.004);
  s.bezierCurveTo(0.012, -0.006, 0.031, -0.011, 0.039, -0.022);
  s.bezierCurveTo(0.043, -0.028, 0.034, -0.031, 0.024, -0.027);
  s.bezierCurveTo(0.012, -0.022, 0.002, -0.016, -0.004, -0.012);
  s.closePath();
};

// Перо: лента в плоскости XY, основание в начале координат, кончик вдоль +Y.
// Ширина растёт от основания и скругляется на кончике; цвет — градиент от c0 к c1.
function featherGeometry({ length, width, curl = 0, bend = 0, cup = 0.2, c0, c1, sharp = 0.9, segU = 12, segV = 4 }) {
  const base = new THREE.Color(c0);
  const tip = new THREE.Color(c1);
  const tmp = new THREE.Color();
  const pos = [];
  const col = [];
  const idx = [];
  for (let i = 0; i <= segU; i++) {
    const u = i / segU;
    const w = width * Math.sqrt(Math.sin(Math.PI * Math.pow(u, sharp)));
    const y = u * length;
    const z = curl * u * u * length;
    const x0 = bend * u * u * length;
    tmp.copy(base).lerp(tip, u * u * (3 - 2 * u));
    for (let j = 0; j <= segV; j++) {
      const v = (2 * j) / segV - 1;
      pos.push(x0 + w * v, y, z + cup * w * (1 - v * v));
      col.push(tmp.r, tmp.g, tmp.b);
    }
  }
  for (let i = 0; i < segU; i++) {
    for (let j = 0; j < segV; j++) {
      const a = i * (segV + 1) + j;
      const b = a + segV + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// Текстура туловища: градиент спина → брюшко и ряды «чешуек» перьев
function plumageTexture(dorsal, ventral) {
  const W = 1024;
  const H = 512;
  const cv = document.createElement('canvas');
  cv.width = W;
  cv.height = H;
  const g = cv.getContext('2d');
  // Верх холста соответствует верху туловища (v = 1), низ — брюшку (v = 0)
  const grad = g.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, dorsal);
  grad.addColorStop(0.55, dorsal);
  grad.addColorStop(0.95, ventral);
  grad.addColorStop(1, ventral);
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  // Полукруги в шахматном порядке; копии по краям делают шов бесшовным
  const sx = 32;
  const sy = 16;
  const r = 17;
  for (let row = -1; row * sy < H + sy; row++) {
    for (let col = -1; col * sx < W + sx; col++) {
      const x = col * sx + (row & 1 ? sx / 2 : 0);
      for (const dx of [-W, 0, W]) {
        g.beginPath();
        g.arc(x + dx, row * sy, r, 0, Math.PI);
        g.closePath();
        g.fillStyle = 'rgba(255,255,255,0.1)';
        g.fill();
        g.strokeStyle = 'rgba(0,0,0,0.22)';
        g.lineWidth = 2;
        g.stroke();
      }
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.anisotropy = 4;
  return tex;
}

// Клюв: контур в плоскости (вперёд, вверх) выдавливается по толщине и смотрит вперёд (+Z)
function beakGeometry(draw, depth = 0.008) {
  const s = new THREE.Shape();
  draw(s);
  const g = new THREE.ExtrudeGeometry(s, {
    depth,
    bevelEnabled: true,
    bevelThickness: 0.0015,
    bevelSize: 0.0015,
    bevelSegments: 2,
    curveSegments: 10,
  });
  g.translate(0, 0, -depth / 2);
  g.rotateY(-Math.PI / 2);
  return g;
}

export function createParrot(side) {
  const P = PALETTE[side];
  const seed = side === 'right' ? 1 : 2;

  const solid = (color, rough = 0.6) => new THREE.MeshStandardMaterial({ color, roughness: rough });
  const shadowed = (geo, mat) => {
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  };
  const featherMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, side: THREE.DoubleSide });
  const bodyMat = new THREE.MeshStandardMaterial({ map: plumageTexture(P.dorsal, P.ventral), roughness: 0.62 });
  const faceMat = solid(P.face, 0.62);
  const cheekMat = solid(P.cheek, 0.7);
  const ringMat = solid(P.ring, 0.5);
  const irisMat = solid('#2b1d12', 0.25);
  const pupilMat = solid('#080808', 0.3);
  const glintMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  const beakMat = solid(P.beak, 0.4);
  const legMat = solid(P.feet, 0.8);

  const root = new THREE.Group();

  // Ноги: бедро на высоте голени, голень тянется до стола (длина задаётся в apply)
  const legGeo = new THREE.CylinderGeometry(0.0042, 0.0055, 1, 8);
  legGeo.translate(0, -0.5, 0);
  const toeGeo = new THREE.CapsuleGeometry(0.0026, 0.014, 3, 6);
  toeGeo.rotateX(Math.PI / 2);
  const legs = [-1, 1].map((s) => {
    const hip = new THREE.Group();
    hip.position.x = s * 0.013;
    root.add(hip);
    const shin = shadowed(legGeo, legMat);
    hip.add(shin);
    const foot = new THREE.Group();
    hip.add(foot);
    for (const a of [-0.5, 0, 0.5]) {
      const toe = shadowed(toeGeo, legMat);
      toe.position.set(Math.sin(a) * 0.009, 0.0026, Math.cos(a) * 0.009 + 0.006);
      toe.rotation.y = a;
      foot.add(toe);
    }
    const hallux = shadowed(toeGeo, legMat);
    hallux.position.set(0, 0.0026, -0.007);
    foot.add(hallux);
    return { hip, shin, foot };
  });

  // Туловище и голова
  const body = new THREE.Group();
  root.add(body);
  const bodyMesh = shadowed(new THREE.LatheGeometry(BODY_PROFILE, 44), bodyMat);
  body.add(bodyMesh);

  const neck = new THREE.Group(); // шарнир головы: наклон, поворот, крен
  neck.position.set(0, 0.085, 0.012);
  body.add(neck);
  const skull = new THREE.Group(); // центр черепа
  skull.position.set(0, 0.04, 0);
  neck.add(skull);
  skull.add(shadowed(new THREE.SphereGeometry(0.046, 40, 28), faceMat));

  for (const s of [-1, 1]) {
    const cheek = shadowed(new THREE.SphereGeometry(0.0155, 14, 10), cheekMat);
    cheek.position.set(s * 0.0275, -0.0085, 0.0335);
    cheek.scale.set(1, 0.85, 0.45);
    skull.add(cheek);
  }

  // Глаза: кольцо, радужка, зрачок с бликом и два века
  const eyes = [-1, 1].map((s) => {
    const eye = new THREE.Group();
    eye.position.copy(new THREE.Vector3(s * 0.55, 0.16, 0.82).normalize().multiplyScalar(0.0445));
    eye.rotation.y = s * 0.5;
    skull.add(eye);
    eye.add(shadowed(new THREE.TorusGeometry(0.0106, 0.0027, 8, 22), ringMat));
    eye.add(shadowed(new THREE.SphereGeometry(0.0095, 18, 14), irisMat));

    const pupilRig = new THREE.Group(); // зрачок и блик смещаются вместе: это и есть взгляд
    pupilRig.position.z = 0.0086;
    eye.add(pupilRig);
    const pupil = shadowed(new THREE.SphereGeometry(0.0044, 12, 10), pupilMat);
    pupilRig.add(pupil);
    const glint = new THREE.Mesh(new THREE.SphereGeometry(0.0013, 8, 6), glintMat);
    glint.position.set(0.0016, 0.0016, 0.0046);
    pupilRig.add(glint);

    const tiltTop = new THREE.Group(); // наклон верхнего века: злые брови
    eye.add(tiltTop);
    const lidTop = shadowed(new THREE.SphereGeometry(0.0104, 18, 12, 0, Math.PI * 2, 0, Math.PI / 2), faceMat);
    tiltTop.add(lidTop);
    const lidBot = shadowed(
      new THREE.SphereGeometry(0.0104, 18, 12, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2),
      faceMat,
    );
    eye.add(lidBot);
    return { s, tiltTop, lidTop, lidBot, pupilRig, pupil };
  });

  // Клюв: верхняя половина неподвижна, нижняя открывается вокруг шарнира
  const beak = new THREE.Group();
  beak.position.set(0, -0.004, 0.04);
  skull.add(beak);
  beak.add(shadowed(beakGeometry(UPPER_BEAK), beakMat));
  const lowerPivot = new THREE.Group();
  beak.add(lowerPivot);
  lowerPivot.add(shadowed(beakGeometry(LOWER_BEAK), beakMat));

  // Гребень: один угол поднимает и опускает все перья
  const crest = new THREE.Group();
  crest.position.set(0, 0.03, -0.012);
  skull.add(crest);
  const crestFeathers = CREST_LAYOUT.map(([x, fan, len]) => {
    const f = shadowed(
      featherGeometry({ length: len, width: 0.0165, curl: -0.12, cup: 0.22, c0: P.crest, c1: P.crestTip, sharp: 0.9 }),
      featherMat,
    );
    f.position.x = x;
    f.userData.fan = fan;
    crest.add(f);
    return f;
  });

  // Крылья: плечо → кроющие, второстепенные и маховые перья
  const wings = [-1, 1].map((s) => {
    const pivot = new THREE.Group();
    pivot.position.set(s * 0.06, 0.036, -0.004);
    body.add(pivot);
    const feathers = WING_LAYOUT.map(([y, z, len, wid, fan, layer]) => {
      const geo = featherGeometry({
        length: len,
        width: wid,
        curl: 0.08,
        cup: 0.18,
        c0: P.wing,
        c1: layer === 2 ? P.wingTip : P.wing,
        sharp: 0.85,
      });
      geo.rotateY(Math.PI / 2); // ширина по Z: плоскость крыла — YZ, перо лежит вдоль бока
      geo.rotateZ(Math.PI); // кончик смотрит вниз
      const m = shadowed(geo, featherMat);
      m.position.set(0, y, z);
      m.userData.fan = fan;
      pivot.add(m);
      return m;
    });
    return { s, pivot, feathers };
  });

  // Хвост
  const tail = new THREE.Group();
  tail.position.set(0, -0.072, -0.018);
  body.add(tail);
  const tailFeathers = TAIL_LAYOUT.map(([fan, len]) => {
    const f = shadowed(
      featherGeometry({ length: len, width: 0.024, cup: 0.12, c0: P.wing, c1: P.wingTip, sharp: 0.9 }),
      featherMat,
    );
    f.userData.fan = fan;
    tail.add(f);
    return f;
  });

  // Применение позы к ригу: только трансформации, без логики сюжета
  function apply(p) {
    const t = p.t ?? 0;
    root.visible = p.visible !== false;
    root.position.set(p.x ?? 0, p.y ?? 0, p.z ?? 0);
    root.rotation.set(0, p.yaw ?? 0, 0);

    // Туловище: приседание, наклон, дыхание, надув
    const crouch = clamp(p.crouch ?? 0);
    const breath = Math.sin((2 * Math.PI * t) / 2.3 + seed);
    const tilt = 0.55 + 0.45 * crouch + (p.lean ?? 0) + 0.025 * noise(t * 0.35, seed + 2);
    const bodyY = 0.1 - 0.05 * crouch + 0.002 * breath;
    const puff = clamp(p.puff ?? 0);
    body.position.y = bodyY;
    body.rotation.x = tilt;
    bodyMesh.scale.set(1 + 0.07 * puff, 1 + 0.012 * breath + 0.03 * puff, 1 + 0.07 * puff);

    // Ноги: голень до стола, при прыжке поджимаются
    const legTop = Math.max(0.02, bodyY - 0.03 * Math.cos(tilt));
    for (const L of legs) {
      L.hip.position.y = legTop;
      L.shin.scale.y = legTop;
      L.foot.position.y = -legTop;
      L.hip.rotation.x = -clamp(p.tuck ?? 0) * 0.8;
    }

    // Голова и клюв
    neck.rotation.set(p.headPitch ?? 0, p.headYaw ?? 0, p.headRoll ?? 0, 'YXZ');
    lowerPivot.rotation.x = clamp(p.beak ?? 0) * 0.55;

    // Глаза: веки, зрачок, взгляд, злые брови
    const lidT = clamp(p.lidTop ?? 0);
    const lidB = clamp(p.lidBot ?? 0);
    const gaze = p.gaze ?? { x: 0, y: 0 };
    for (const e of eyes) {
      e.tiltTop.rotation.z = e.s * (p.brow ?? 0) * 0.5;
      e.lidTop.rotation.x = lerp(-1.25, 1.5, lidT);
      e.lidBot.rotation.x = lerp(1.25, -1.45, lidB);
      e.pupilRig.position.set(gaze.x * 0.0026, gaze.y * 0.0026, 0.0086);
      e.pupil.scale.setScalar(p.pupil ?? 1);
    }

    // Гребень и ерошение
    const ruf = clamp(p.ruffle ?? 0);
    crest.rotation.x = lerp(-1.25, 0.15, clamp(p.crest ?? 0));
    crestFeathers.forEach((f, i) => {
      f.rotation.z = f.userData.fan + ruf * 0.22 * noise(t * 6 + i * 1.7, seed + i);
    });

    // Крылья: размах плюс взмах; маховые перья веером
    const fanK = clamp(p.wingFan ?? 0);
    for (const w of wings) {
      const flap = (p.flapAmp ?? 0) * Math.sin(2 * Math.PI * (p.flapHz ?? 0) * t + w.s * 0.3);
      const lift = (p.wingLift ?? 0.12) + flap;
      w.pivot.rotation.set(p.wingSweep ?? 0, 0, w.s * lift, 'XYZ');
      w.feathers.forEach((f, i) => {
        f.rotation.x = f.userData.fan * (1 + 1.5 * fanK) + ruf * 0.1 * noise(t * 7 + i, seed + 5 + w.s);
      });
    }

    // Хвост: угол, виляние, веер
    tail.rotation.set(-Math.PI + (p.tailAngle ?? 0.9), p.tailWag ?? 0, 0, 'YXZ');
    const tailK = 0.6 + 1.2 * clamp(p.tailFan ?? 0.3);
    for (const f of tailFeathers) f.rotation.z = f.userData.fan * tailK;
  }

  return { root, apply };
}
