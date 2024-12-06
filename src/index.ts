import * as THREE from 'three';
import { createRenderer } from './core/Renderer';
import { createScene, getCurrentScene } from './core/Scene';
import { createCamera, getCurrentCamera } from './core/Camera';
import { createGeometry } from './core/Geometry';
import { createMaterial } from './core/Material';
import { createTexture, loadTextures } from './core/Texture';
import { llog } from './utils/Logger';
import { createLight } from './core/Light';
import { initStats } from './debug/Stats';
import { initDebugGUI } from './debug/DebuggerGUI';
import './styles/index.scss';

export const GUI_CONTAINER_ID = 'guiContainer';

export const loopState = {
  masterPlay: true,
  appPlay: true,
  isMasterPlaying: false,
  isAppPlaying: false,
};

const scene = createScene('testScene1', {
  isCurrentScene: true,
  background: new THREE.Color(0x222222),
});
const camera = createCamera('mainCam', { isCurrentCamera: true });
camera.position.z = 5;
camera.position.x = 2.5;
camera.position.y = 1;

const renderer = createRenderer({ antialias: true, forceWebGL: false });

const geometry1 = createGeometry({ id: 'sphere1', type: 'SPHERE' });
const material1 = createMaterial({
  id: 'sphere1Material',
  type: 'BASIC',
  params: { color: 0xff0000, wireframe: true },
});
const sphere = new THREE.Mesh(geometry1, material1);
scene.add(sphere);

camera.lookAt(sphere.position);

const geometry2 = createGeometry({ id: 'box1', type: 'BOX' });
const material2 = createMaterial({
  id: 'box1Material',
  type: 'PHONG',
  params: {
    map: createTexture({
      id: 'box1Texture',
      fileName: '/testTextures/Poliigon_MetalRust_7642_BaseColor.jpg',
    }),
  },
});
const box = new THREE.Mesh(geometry2, material2);
box.position.set(2, 0, 0);
scene.add(box);

// Batch load textures example
const updateLoadStatusFn = (
  loadedTextures: { [id: string]: THREE.Texture },
  loadedCount: number,
  totalCount: number
) => {
  llog(`Loaded textures: ${loadedCount}/${totalCount}`, loadedTextures);
};
loadTextures(
  [
    { fileName: '/testTextures/Poliigon_MetalRust_7642_BaseColor.jpg' },
    { fileName: '/testTextures/Poliigon_MetalRust_7642_AmbientOcclusion.jpg' },
    { fileName: '/testTextures/Poliigon_MetalRust_7642_Metallic.jpg' },
  ],
  updateLoadStatusFn
);

const point = createLight({
  id: 'pointLight',
  type: 'POINT',
  params: { color: 0xffffff, intensity: 5, distance: 3 },
});
point.position.set(1, 2, 1);
scene.add(point);

const ambient = createLight({
  id: 'ambientLight',
  type: 'AMBIENT',
  params: { color: '#ffffff', intensity: 0.13 },
});
scene.add(ambient);

const hemisphere = createLight({
  id: 'hemisphereLight',
  type: 'HEMISPHERE',
  params: {
    skyColor: 0x220000,
    groundColor: 0x225599,
    intensity: 1,
  },
});
scene.add(hemisphere);

// Stats
const stats = initStats({ trackGPU: true, trackCPT: true, horizontal: false });

// GUI
initDebugGUI();

const animate = () => {
  if (loopState.masterPlay) {
    requestAnimationFrame(animate);
    loopState.isMasterPlaying = true;
  } else {
    loopState.isMasterPlaying = false;
    return;
  }
  if (loopState.appPlay) {
    loopState.isAppPlaying = true;
    // @TODO: add gamePlay loop here
    sphere.rotation.z -= 0.001;
    sphere.rotation.y += 0.001;
    box.rotation.y -= 0.001;
    box.rotation.z -= 0.001;
  } else {
    loopState.isAppPlaying = false;
  }
  renderer.renderAsync(getCurrentScene(), getCurrentCamera());
  stats.update();
};

if (loopState.masterPlay) {
  animate();
}

export const toggleMainPlay = (value?: boolean) => {
  if (value !== undefined) {
    loopState.masterPlay = value;
  } else {
    loopState.masterPlay = !loopState.masterPlay;
  }
  if (loopState.masterPlay && !loopState.isMasterPlaying) animate();
};

export const toggleGamePlay = (value?: boolean) => {
  if (value !== undefined) {
    loopState.appPlay = value;
    return;
  }
  loopState.appPlay = !loopState.appPlay;
};
