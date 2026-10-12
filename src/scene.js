// src/scene.js: сцена. Камера — вертикальный кадр 9:16, угол обзора 60° по вертикали, стол, пол, стена,
// миски, зёрна, попугаи и оператор. Все положения берутся из getBake() и poseFor(), здесь ничего не пересчитывается.
import * as THREE from 'three';
import { WORLD, BOWL, SEED } from './config.js';
import { spline, noise, mulberry32 } from './util.js';
import { poseFor } from './choreo.js';
import { createParrot } from './parrot.js';
import { createOperator } from './hand.js';

const BOWL_Z = WORLD.bowlZ;
const CUT = 27.2;          // монтажный переход: крупный план на левого попугая
const SHAKE = 0.002;       // ручная дрожь камеры, м
const SEED_N = 800;        // 640 справа и 160 слева
const PALETTE = ['#c8924f', '#8a5a2b', '#2e2822', '#e6d6a8', '#b98033', '#d9b26a'];

// Камера: ключи [время, [x, y, z]]. Кадр A — общий план стола, кадр B — крупный план в финале
const POS_A = spline([
  [0.0, [0.00, 0.42, 1.45]],
  [1.6, [0.05, 0.40, 1.36]],
  [3.9, [0.04, 0.40, 1.40]],
  [5.9, [0.00, 0.40, 1.42]],
  [9.0, [-0.02, 0.38, 1.42]],
  [10.4, [-0.02, 0.34, 1.25]],
  [12.9, [0.00, 0.40, 1.42]],
  [16.4, [0.06, 0.40, 1.46]],
  [18.6, [0.14, 0.40, 1.60]],
  [21.0, [0.14, 0.40, 1.60]],
  [23.3, [0.10, 0.40, 1.62]],
  [26.9, [0.12, 0.62, 1.70]],
]);
const TGT_A = spline([
  [0.0, [0.00, 0.02, 0.00]],
  [1.6, [0.12, 0.04, 0.00]],
  [3.9, [0.12, 0.03, 0.00]],
  [5.9, [0.06, 0.03, 0.00]],
  [9.0, [-0.02, 0.03, 0.00]],
  [10.4, [-0.04, 0.06, 0.00]],
  [12.9, [0.02, 0.03, 0.00]],
  [16.4, [0.10, 0.02, 0.00]],
  [18.6, [0.14, 0.02, 0.00]],
  [21.0, [0.14, 0.03, 0.00]],
  [23.3, [0.12, 0.12, 0.00]],
  [26.9, [0.30, 0.85, -0.10]],
]);
const POS_B = spline([[CUT, [-0.12, 0.26, 0.98]], [30, [-0.12, 0.26, 0.92]]]);
const TGT_B = spline([[CUT, [-0.24, 0.15, 0.00]], [30, [-0.24, 0.15, 0.00]]]);

// Миска: тот же профиль, что в физике, вращение вокруг оси y, основание в y = 0
function bowlGeometry() {
  const { rBase: RB, rRim: RR, height: H, wall: WALL, floor: FT } = BOWL;
  const pts = [[0, 0], [RB, 0], [RR, H], [RR - WALL, H], [RB - WALL, FT], [0, FT]]
    .map(([x, y]) => new THREE.Vector2(x, y));
  return new THREE.LatheGeometry(pts, 72);
}

// Древесина: полосы с волнистым рисунком, нарисованные на холсте (без внешних файлов)
function woodDraw(base, seed) {
  return (g, s) => {
    const rnd = mulberry32(seed);
    g.fillStyle = base;
    g.fillRect(0, 0, s, s);
    for (let i = 0; i < 140; i++) {
      const y0 = rnd() * s;
      const amp = 3 + rnd() * 9;
      const f = ((1 + Math.floor(rnd() * 3)) * 2 * Math.PI) / s;     // целое число периодов: без шва по x
      const ph = rnd() * 6;
      g.strokeStyle = `rgba(70,38,16,${0.04 + rnd() * 0.12})`;
      g.lineWidth = 0.8 + rnd() * 2.4;
      g.beginPath();
      for (let x = 0; x <= s; x += 4) {
        const y = y0 + amp * Math.sin(x * f + ph);
        if (x === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
    }
  };
}

function woodTexture(base, seed, repeat) {
  const cv = document.createElement('canvas');
  cv.width = 512;
  cv.height = 512;
  woodDraw(base, seed)(cv.getContext('2d'), 512);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = 8;
  return tex;
}

// Зёрна: один InstancedMesh; цвет и поворот у каждого зерна свои, размер — от SEED.r
function createSeeds() {
  const mesh = new THREE.InstancedMesh(
    new THREE.SphereGeometry(1, 10, 8),
    new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0 }),
    SEED_N,
  );
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;                 // границы инстансов меняются каждый кадр
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const rnd = mulberry32(99);
  const color = new THREE.Color();
  const quats = [];
  const sizes = [];
  for (let i = 0; i < SEED_N; i++) {
    mesh.setColorAt(i, color.set(PALETTE[Math.floor(rnd() * PALETTE.length)]));
    quats.push(new THREE.Quaternion().setFromEuler(new THREE.Euler(rnd() * 6.28, rnd() * 6.28, rnd() * 6.28)));
    sizes.push(SEED.r * (0.9 + 0.2 * rnd()));
  }
  mesh.instanceColor.needsUpdate = true;
  return { mesh, quats, sizes };
}

const P = new THREE.Vector3();
const SC = new THREE.Vector3();
const M = new THREE.Matrix4();
const seedPos = new Float32Array(3 * SEED_N);
const seedAlive = new Uint8Array(SEED_N);

function updateSeeds(seeds, bake, t) {
  bake.seeds(t, seedPos, seedAlive);
  for (let i = 0; i < SEED_N; i++) {
    if (seedAlive[i]) {
      P.set(seedPos[3 * i], seedPos[3 * i + 1], seedPos[3 * i + 2]);
      const k = seeds.sizes[i];
      SC.set(k, 0.75 * k, 1.25 * k);
    } else {
      P.set(0, 0, 0);
      SC.set(0, 0, 0);            // скрытое зерно: нулевой масштаб
    }
    M.compose(P, seeds.quats[i], SC);
    seeds.mesh.setMatrixAt(i, M);
  }
  seeds.mesh.instanceMatrix.needsUpdate = true;
}

// Камера: положение и взгляд по ключам, плюс ручная дрожь
function setCamera(camera, t) {
  const p = t < CUT ? POS_A(t) : POS_B(t);
  const q = t < CUT ? TGT_A(t) : TGT_B(t);
  camera.position.set(
    p[0] + SHAKE * noise(t * 1.7, 1),
    p[1] + SHAKE * noise(t * 1.3, 2),
    p[2] + SHAKE * noise(t * 2.1, 3),
  );
  camera.lookAt(
    q[0] + SHAKE * noise(t * 1.1, 4),
    q[1] + SHAKE * noise(t * 1.5, 5),
    q[2],
  );
}

export function createWorld(bake) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xf1e4cf);
  const camera = new THREE.PerspectiveCamera(60, 9 / 16, 0.05, 20);

  // Свет: общий, ключевой с тенями слева-сверху, контровой справа-сзади для контура
  const hemi = new THREE.HemisphereLight(0xfff3e0, 0x7a5a40, 0.9);
  const key = new THREE.DirectionalLight(0xfff0dc, 2.3);
  key.position.set(-0.7, 1.4, 1.1);
  key.target.position.set(0, -0.2, 0);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -0.9, right: 0.9, top: 0.9, bottom: -0.9, near: 0.5, far: 4 });
  key.shadow.camera.updateProjectionMatrix();
  key.shadow.bias = -0.0004;
  key.shadow.normalBias = 0.01;
  const rim = new THREE.DirectionalLight(0xcde6ff, 0.9);
  rim.position.set(1.0, 0.8, -1.2);

  // Стол: столешница, четыре ножки, пол и стена за попугаями
  const table = new THREE.Mesh(
    new THREE.BoxGeometry(2 * WORLD.table.x, 0.04, 2 * WORLD.table.z),
    new THREE.MeshStandardMaterial({ map: woodTexture('#d9a066', 7, 1), roughness: 0.55 }),
  );
  table.position.y = -0.02;
  table.castShadow = true;
  table.receiveShadow = true;
  const legs = new THREE.Group();
  const legGeo = new THREE.CylinderGeometry(0.022, 0.026, 0.72, 16);
  const legMat = new THREE.MeshStandardMaterial({ color: 0x5b3a22, roughness: 0.6 });
  for (const [x, z] of [[-0.46, -0.29], [0.46, -0.29], [-0.46, 0.29], [0.46, 0.29]]) {
    const leg = new THREE.Mesh(legGeo, legMat);
    leg.position.set(x, WORLD.floorY + 0.36, z);   // от пола до столешницы: центр на середине высоты
    leg.castShadow = true;
    legs.add(leg);
  }
  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(10, 10),
    new THREE.MeshStandardMaterial({ map: woodTexture('#b07d52', 11, 3), roughness: 0.8 }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = WORLD.floorY;
  floor.receiveShadow = true;
  const wall = new THREE.Mesh(
    new THREE.PlaneGeometry(10, 4),
    new THREE.MeshStandardMaterial({ color: 0xf1e4cf, roughness: 0.95 }),
  );
  wall.position.set(0, 1.0, -0.95);
  wall.receiveShadow = true;

  // Миски: правая двигается по данным физики, левая стоит на месте
  const bowlGeo = bowlGeometry();
  const bowlR = new THREE.Mesh(
    bowlGeo,
    new THREE.MeshStandardMaterial({ color: 0xff7a3d, roughness: 0.28, side: THREE.DoubleSide }),
  );
  const bowlL = new THREE.Mesh(
    bowlGeo,
    new THREE.MeshStandardMaterial({ color: 0xeef4ff, roughness: 0.3, side: THREE.DoubleSide }),
  );
  bowlL.position.set(WORLD.bowlX.left, 0, BOWL_Z);
  for (const m of [bowlR, bowlL]) {
    m.castShadow = true;
    m.receiveShadow = true;
  }

  const seeds = createSeeds();
  const parrotR = createParrot('right');
  const parrotL = createParrot('left');
  const operator = createOperator();

  scene.add(
    hemi, key, key.target, rim, table, legs, floor, wall,
    bowlR, bowlL, seeds.mesh, parrotR.root, parrotL.root, operator.root,
  );

  // Всё состояние кадра в момент t: камера, миски, зёрна, попугаи, оператор
  function update(t) {
    setCamera(camera, t);
    const b = bake.bowl(t);
    bowlR.position.set(b.x, b.y, BOWL_Z);
    bowlR.rotation.z = b.th;
    updateSeeds(seeds, bake, t);
    parrotR.apply(poseFor('right', t, { bowlX: bake.bowlX }));
    parrotL.apply(poseFor('left', t, { bowlX: bake.bowlX }));
    operator.update(t);
  }

  return { scene, camera, update, parts: { bowlR, bowlL, seeds, parrotR, parrotL, operator } };
}
