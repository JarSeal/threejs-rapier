import * as THREE from 'three/webgpu';
import { createRenderer } from './core/Renderer';
import { addSceneAppLooper, addSceneMainLooper, createScene } from './core/Scene';
import { createCamera } from './core/Camera';
import { createGeometry } from './core/Geometry';
import { createMaterial } from './core/Material';
import { loadTexture, getTexture, loadTextures } from './core/Texture';
import { llog } from './utils/Logger';
import { createLight } from './core/Light';
import { importModelAsync } from './core/ImportModel';
import { createMesh } from './core/Mesh';
import { addToGroup, createGroup } from './core/Group';
import { getTransformValue, initMainLoop } from './core/MainLoop';
import './styles/index.scss';
import { loadConfig } from './core/Config';
import { addSkyBox } from './core/SkyBox';

loadConfig();

// Init scene, camera, and renderer
const scene = createScene('testScene1', {
  isCurrentScene: true,
  // background: new THREE.Color(0x222222),
});
const camera = createCamera('mainCam', { isCurrentCamera: true, fov: 90 });
camera.position.z = 5;
camera.position.x = 2.5;
camera.position.y = 1;
createRenderer({
  antialias: true,
  forceWebGL: false,
  toneMapping: THREE.ACESFilmicToneMapping,
  toneMappingExposure: 0.7,
  outputColorSpace: THREE.SRGBColorSpace,
  alpha: true,
});

// App specific
// const envTexture = await loadTextureAsync({
//   id: 'equiRectId',
//   fileName: '/testTextures/equi_grass_and_forest_4k.jpg',
// });
// await addSkyBox({
//   type: 'EQUIRECTANGULAR',
//   params: {
//     // file: envTexture,
//     file: '/testTextures/kloofendal_48d_partly_cloudy_skyandground_8k.png',
//     // file: '/testTextures/kloofendal_48d_partly_cloudy_puresky_4k.hdr',
//     // file: '/testTextures/kloofendal_48d_partly_cloudy_puresky_2k.hdr',
//     // file: '/testTextures/evening_road_01_puresky_8k.hdr',
//     // file: '/testTextures/pizzo_pernice_puresky_8k.hdr',
//     textureId: 'equiRectId',
//     isEnvMap: false,
//     // colorSpace: THREE.SRGBColorSpace,
//     colorSpace: THREE.LinearSRGBColorSpace,
//     // colorSpace: THREE.NoColorSpace,
//   },
// });

const map01 = [
  '/cubemap01_positive_x.png',
  '/cubemap01_negative_x.png',
  '/cubemap01_negative_y.png',
  '/cubemap01_positive_y.png',
  '/cubemap01_positive_z.png',
  '/cubemap01_negative_z.png',
];
const map02 = [
  '/cubemap02_positive_x.png',
  '/cubemap02_negative_x.png',
  '/cubemap02_negative_y.png',
  '/cubemap02_positive_y.png',
  '/cubemap02_positive_z.png',
  '/cubemap02_negative_z.png',
];
await addSkyBox({
  type: 'CUBETEXTURE',
  params: {
    fileNames: map01,
    path: '/testTextures',
    textureId: 'cubeTextureId',
  },
});

const geometry1 = createGeometry({ id: 'sphere1', type: 'SPHERE' });
const material1 = createMaterial({
  id: 'sphere1Material',
  type: 'BASIC',
  params: { color: 0xff0000, wireframe: true },
});
const sphere = createMesh({ id: 'sphereMesh1', geo: geometry1, mat: material1 });
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
const box = createMesh({ id: 'boxMesh1', geo: geometry2, mat: material2 });
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
  id: 'importedMesh1',
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

  addSceneAppLooper(() => {
    importedBox.rotation.y += getTransformValue(0.2);
    importedBox.rotation.z -= getTransformValue(0.14);
  });
}

addSceneMainLooper(() => {
  sphere.rotation.z -= getTransformValue(0.1);
  sphere.rotation.y += getTransformValue(0.1);
});

addSceneAppLooper(() => {
  box.rotation.y -= getTransformValue(2);
  box.rotation.z -= getTransformValue(2);
});

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
  params: { color: '#ffffff', intensity: 0.8 },
});
scene.add(ambient);

const hemisphere = createLight({
  id: 'hemisphereLight',
  type: 'HEMISPHERE',
  params: {
    skyColor: 0x220000,
    groundColor: 0x225599,
    intensity: 1.5,
  },
});
scene.add(hemisphere);

// Start loop
initMainLoop();
