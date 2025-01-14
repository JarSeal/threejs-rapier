import * as THREE from 'three';
import { createRenderer } from './core/Renderer';
import { createScene, getCurrentScene } from './core/Scene';
import { createCamera, getCurrentCamera } from './core/Camera';
import { createGeometry } from './core/Geometry';
import { createMaterial } from './core/Material';
import { loadTexture, getTexture, loadTextures } from './core/Texture';
import { llog } from './utils/Logger';
import { createLight } from './core/Light';
import { initStats } from './debug/Stats';
import {
  createDebugGui,
  createNewDebuggerGUI,
  setDebuggerTabAndContainer,
} from './debug/DebuggerGUI';
import './styles/index.scss';
import { createHudContainer } from './core/HUD';
import { importModelAsync } from './core/ImportModel';
import { createMesh } from './core/Mesh';
import { addToGroup, createGroup } from './core/Group';

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
const sphere = createMesh({ geo: geometry1, mat: material1 });
scene.add(sphere);

camera.lookAt(sphere.position);

const geometry2 = createGeometry({ id: 'box1', type: 'BOX' });
const material2 = createMaterial({
  id: 'box1Material',
  type: 'PHONG',
  params: {
    map: loadTexture({
      id: 'box1Texture',
      fileName: '/testTextures/Poliigon_MetalRust_7642_BaseColor.jpg',
    }),
  },
});
const box = createMesh({ geo: geometry2, mat: material2 });
box.position.set(2, 0, 0);
scene.add(box);

// Group example
const group = createGroup({ id: 'myGroup' });
const groupBox1 = createMesh({
  geo: createGeometry<THREE.BoxGeometry>({
    type: 'BOX',
    params: { width: 0.2, height: 0.2, depth: 0.2 },
  }),
  mat: createMaterial({ type: 'BASIC', params: { color: '#f0cc00' } }),
});
groupBox1.position.set(-0.2, 0, 0);
const groupBox2 = createMesh({
  geo: createGeometry<THREE.BoxGeometry>({
    type: 'BOX',
    params: { width: 0.2, height: 0.2, depth: 0.2 },
  }),
  mat: createMaterial({ type: 'BASIC', params: { color: '#ff00c0' } }),
});
groupBox2.position.set(0.2, 0, 0);
addToGroup(group, [groupBox1, groupBox2]);
group.position.y = 1.4;
scene.add(group);

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

const importedBox = await importModelAsync<THREE.Mesh>({
  fileName: '/testModels/box01.glb',
  throwOnError: true,
});
if (importedBox) {
  importedBox.position.set(-2, 0, 0);
  const material = createMaterial({
    id: 'importedBox01Material',
    type: 'PHONG',
    params: {
      map: getTexture('box1Texture'),
    },
  });
  importedBox.material = material;
  scene.add(importedBox);
}

const point = createLight({
  id: 'pointLight',
  type: 'POINT',
  params: { color: 0xffffff, intensity: 5, distance: 5 },
});
point.position.set(0, 2, 0);
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

// HUD and Debug GUI
createHudContainer();
createDebugGui();

// Stats
const stats = initStats();

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
    sphere.rotation.z -= 0.001; // REMOVE
    sphere.rotation.y += 0.001; // REMOVE
    box.rotation.y -= 0.001; // REMOVE
    box.rotation.z -= 0.001; //REMOVE
    if (importedBox) {
      importedBox.rotation.y -= 0.0014; // REMOVE
      importedBox.rotation.z -= 0.0014; // REMOVE
    }
  } else {
    loopState.isAppPlaying = false;
  }
  renderer.renderAsync(getCurrentScene(), getCurrentCamera());
  stats?.update();
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

setDebuggerTabAndContainer({
  id: 'loopControls',
  buttonText: 'LOOP',
  title: 'Loop controls',
  orderNr: 4,
  container: () => {
    const { container, debugGui } = createNewDebuggerGUI('Loop', 'Loop Controls');
    debugGui
      .add(loopState, 'masterPlay')
      .name('Master loop')
      .onChange((value: boolean) => {
        if (value) requestAnimationFrame(animate);
      });
    debugGui.add(loopState, 'appPlay').name('App loop');
    // @TODO: add forced max FPS debugger
    return container;
  },
});
