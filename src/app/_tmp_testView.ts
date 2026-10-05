// THROWAWAY p083 Phase 1 test view — not to be committed.
// Browser console (yarn dev, ?isDebug=true):
//   const tv = await import('/app/_tmp_testView.ts'); await tv.enter(); … await tv.exit();
import * as THREE from 'three/webgpu';
import {
  getActiveViewId,
  registerView,
  RUNTIME_VIEW_ID,
  setActiveView,
  toggleViewPlay,
  isViewPlaying,
} from '../_engine/core/ViewManager';
import { getElapsedTime, getReadOnlyLoopState } from '../_engine/core/MainLoop';
import { llog } from '../_engine/utils/Logger';

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x203040);
const camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100);
camera.position.set(2.5, 2, 3.5);
camera.lookAt(0, 0, 0);
const cube = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshStandardNodeMaterial({ color: 0xff8844, roughness: 0.4 })
);
scene.add(cube);
scene.add(new THREE.AmbientLight(0xffffff, 0.4));
const sun = new THREE.DirectionalLight(0xffffff, 2);
sun.position.set(3, 5, 2);
scene.add(sun);

registerView({
  id: 'testView',
  title: 'Test view',
  icon: 'geometry',
  scene,
  getCamera: () => camera,
  onEnter: () => llog('[testView] enter, elapsed', getElapsedTime()),
  onExit: () => llog('[testView] exit, elapsed', getElapsedTime()),
  mainUpdate: () => {
    const aspect = window.innerWidth / window.innerHeight;
    if (camera.aspect !== aspect) {
      camera.aspect = aspect;
      camera.updateProjectionMatrix();
    }
  },
  update: (delta) => {
    cube.rotation.y += delta;
    cube.rotation.x += delta * 0.4;
  },
});

export const enter = () => setActiveView('testView');
export const exit = () => setActiveView(RUNTIME_VIEW_ID);
export const play = (value?: boolean) => toggleViewPlay(value);
export const info = () => ({
  view: getActiveViewId(),
  viewPlaying: isViewPlaying(),
  elapsed: getElapsedTime(),
  loop: getReadOnlyLoopState(),
});
