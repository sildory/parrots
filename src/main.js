// src/main.js: точка входа для рендера. Страница поднимает сцену и отдаёт window.renderFrame(f, samples).
// Каждый кадр — среднее подкадров: выдержка SHUTTER кадра (размытие движения) и смещение на субпиксель
// (сглаживание краёв). Подкадры копятся в полуплавающих буферах, на экран выводятся с тон-маппингом.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { DURATION, FPS } from './config.js';
import { getBake } from './bake.js';
import { createWorld } from './scene.js';
import { frameSamples } from './sampling.js';

const params = new URLSearchParams(location.search);
const SCALE = Number(params.get('scale') || 1);          // 1 — 1080×1920; меньше — для предпросмотра
const W = Math.round(1080 * SCALE);
const H = Math.round(1920 * SCALE);
const SAMPLES = Number(params.get('samples') || 4);      // подкадров на кадр: больше — плавнее размытие

window.addEventListener('error', (e) => {
  window.renderError = String(e.message);
});

// Рендерер: без MSAA (сглаживание дают смещения проекции), тени PCF, тон-маппинг ACES, выход в sRGB
const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(W, H, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

// Виньетка, как у телефона: затемнение по краям. Это часть страницы, поэтому попадает в скриншот
const vignette = document.createElement('div');
vignette.style.cssText = 'position:fixed;inset:0;pointer-events:none;'
  + 'background:radial-gradient(ellipse at 50% 45%, rgba(0,0,0,0) 62%, rgba(0,0,0,0.28) 100%)';
document.body.appendChild(vignette);

const world = createWorld(getBake());
const { scene, camera } = world;

// Окружение для отражений: комната из RoomEnvironment, без внешних файлов
const pmrem = new THREE.PMREMGenerator(renderer);
scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.45;
pmrem.dispose();

// Буферы накопления: выборка подкадра и два буфера для бегущего среднего (ping-pong)
const rtSample = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, depthBuffer: true });
let accRead = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, depthBuffer: false });
let accWrite = new THREE.WebGLRenderTarget(W, H, { type: THREE.HalfFloatType, depthBuffer: false });

// Полноэкранный квад и ортокамера для проходов накопления и вывода
const quadCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
quadCam.position.set(0, 0, 1);
const quadGeo = new THREE.PlaneGeometry(2, 2);
const accMat = new THREE.ShaderMaterial({
  uniforms: {
    tSample: { value: rtSample.texture },
    tPrev: { value: null },
    uW: { value: 1 },
  },
  vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
  fragmentShader: 'uniform sampler2D tSample; uniform sampler2D tPrev; uniform float uW; varying vec2 vUv;'
    + ' void main() { gl_FragColor = mix(texture2D(tPrev, vUv), texture2D(tSample, vUv), uW); }',
  depthTest: false,
  depthWrite: false,
});
const accScene = new THREE.Scene();
accScene.add(new THREE.Mesh(quadGeo, accMat));
const outMat = new THREE.MeshBasicMaterial({ map: null });   // тон-маппинг и sRGB применяются при выводе на экран
const outScene = new THREE.Scene();
outScene.add(new THREE.Mesh(quadGeo, outMat));

// Кадр f: подкадры → бегущее среднее → экран. Промис завершается, когда кадр нарисован
async function renderFrame(f, samples = SAMPLES) {
  for (const s of frameSamples(f, samples)) {
    world.update(s.t);
    camera.setViewOffset(W, H, s.jx, s.jy, W, H);
    renderer.setRenderTarget(rtSample);
    renderer.render(scene, camera);
    accMat.uniforms.tPrev.value = accRead.texture;
    accMat.uniforms.uW.value = 1 / s.n;
    renderer.setRenderTarget(accWrite);
    renderer.render(accScene, quadCam);
    [accRead, accWrite] = [accWrite, accRead];
  }
  camera.clearViewOffset();
  outMat.map = accRead.texture;
  renderer.setRenderTarget(null);
  renderer.render(outScene, quadCam);
  return f;
}

window.renderFrame = renderFrame;
window.frameCount = Math.round(DURATION * FPS);
window.ready = true;
