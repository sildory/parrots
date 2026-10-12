// src/hand.js: оператор с ковшом. Носик ковша (из него сыплются зёрна) ведётся по ключам,
// ковш поворачивается вокруг носика, рукав тянется от плеча, которое всегда выше запястья и за кадром.
import * as THREE from 'three';
import { spline, track } from './util.js';

// Носик ковша: [время, [x, y, z]]. Во время сыпки совпадает с точкой появления зёрен в getBake
// (x миски, y 0.34, z 0.10), поэтому стол не «вынимает» зёрна из воздуха.
const LIP = spline([
  [0.0, [1.05, 1.30, 0.20]],
  [1.0, [0.62, 0.66, 0.14]],
  [1.5, [0.30, 0.42, 0.10]],
  [1.58, [0.24, 0.34, 0.10]],   // равные ключи у концов сыпки: сплайн стоит на месте, пока сыплются зёрна
  [1.6, [0.24, 0.34, 0.10]],
  [3.9, [0.24, 0.34, 0.10]],
  [3.92, [0.24, 0.34, 0.10]],
  [4.8, [0.36, 0.56, 0.14]],
  [5.5, [0.56, 1.30, 0.10]],
  [7.9, [-0.10, 1.30, 0.00]],
  [8.4, [-0.24, 0.40, 0.10]],
  [8.53, [-0.24, 0.34, 0.10]],
  [8.55, [-0.24, 0.34, 0.10]],
  [9.0, [-0.24, 0.34, 0.10]],
  [9.02, [-0.24, 0.34, 0.10]],
  [9.4, [-0.30, 0.56, 0.12]],
  [10.2, [-0.56, 1.30, 0.00]],
  [30, [-0.56, 1.30, 0.00]],
]);

// Наклон ковша, рад: 0 — ровно, 1.1 — сыплет. Переход сглажен (track)
const TILT = track([
  [0.0, 0.0], [1.5, 0.15], [1.6, 0.0], [1.75, 1.1], [3.9, 1.1], [4.1, 0.0],
  [8.5, 0.0], [8.65, 1.1], [8.85, 1.1], [9.05, 0.0], [30, 0.0],
]);

const WRIST = new THREE.Vector3(-0.20, 0.09, 0.03);    // запястье в системе ковша (носик — начало)
const HANDLE_A = new THREE.Vector3(-0.06, -0.01, 0);   // ручка выходит из-под чаши
const SHOULDER = new THREE.Vector3(0.20, 0.60, -0.40); // плечо относительно запястья: сверху и сзади, за кадром
const UP = new THREE.Vector3(0, 1, 0);

export function createOperator() {
  const root = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({ color: 0xe2a77c, roughness: 0.55 });
  const sleeveMat = new THREE.MeshStandardMaterial({ color: 0x3f6f96, roughness: 0.85 });
  const steel = new THREE.MeshStandardMaterial({ color: 0xc9ced6, roughness: 0.25, metalness: 0.9 });
  const wood = new THREE.MeshStandardMaterial({ color: 0x6b4226, roughness: 0.6 });
  const shadowed = (m) => {
    m.castShadow = true;
    m.receiveShadow = true;
    return m;
  };

  // Рукав: цилиндр вдоль оси Y, верх (+Y) — плечо, низ — запястье
  const sleeve = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.052, 0.040, 1, 20), sleeveMat));
  root.add(sleeve);

  // Ковш: начало системы — носик; чаша лежит позади него, ручка ведёт к запястью
  const scoop = new THREE.Group();
  root.add(scoop);
  const cupPts = [[0, 0], [0.030, 0], [0.034, 0.02], [0.031, 0.02], [0.027, 0.005], [0, 0.005]]
    .map(([x, y]) => new THREE.Vector2(x, y));
  const cup = shadowed(new THREE.Mesh(new THREE.LatheGeometry(cupPts, 40), steel));
  cup.position.set(-0.032, -0.02, 0);
  scoop.add(cup);

  const d = WRIST.clone().sub(HANDLE_A);
  const handle = shadowed(new THREE.Mesh(new THREE.CylinderGeometry(0.0075, 0.0085, d.length(), 14), wood));
  handle.position.copy(HANDLE_A).add(WRIST).multiplyScalar(0.5);
  handle.quaternion.setFromUnitVectors(UP, d.clone().normalize());
  scoop.add(handle);

  // Кисть: ладонь и большой палец у конца ручки
  const palm = shadowed(new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), skin));
  palm.scale.set(0.030, 0.024, 0.026);
  palm.position.copy(WRIST).add(new THREE.Vector3(0.006, 0.004, 0.0));
  scoop.add(palm);
  const thumb = shadowed(new THREE.Mesh(new THREE.CapsuleGeometry(0.008, 0.026, 4, 10), skin));
  thumb.position.copy(WRIST).add(new THREE.Vector3(-0.002, 0.018, 0.016));
  thumb.rotation.set(0, 0, 0.9);
  scoop.add(thumb);

  const W = new THREE.Vector3();
  const S = new THREE.Vector3();
  const dir = new THREE.Vector3();

  // Положение ковша и рукава в момент t. Запястье — в мировых координатах, плечо — выше и сзади
  function update(t) {
    const lip = LIP(t);
    scoop.position.set(lip[0], lip[1], lip[2]);
    scoop.rotation.set(0, 0, -TILT(t));
    scoop.updateMatrixWorld(true);
    W.copy(WRIST).applyMatrix4(scoop.matrixWorld);
    S.copy(W).add(SHOULDER);
    dir.subVectors(S, W);
    const len = dir.length();
    sleeve.position.copy(W).add(S).multiplyScalar(0.5);
    sleeve.quaternion.setFromUnitVectors(UP, dir.normalize());
    sleeve.scale.set(1, len, 1);
  }

  return { root, scoop, update };
}
