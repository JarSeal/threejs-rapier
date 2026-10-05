// THROWAWAY p083 test views (Phases 1-3) — remove in Phase 4.
// Browser console (yarn dev, ?isDebug=true):
//   const tv = await import('/app/_tmp_testView.ts'); await tv.enter('testViewA'); … await tv.exit();
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
import { createViewCamera } from '../_engine/core/Debug/Editors/_dbg__ViewCamera';
import type { SvgIconKey } from '../_engine/core/UI/icons/SvgIcon';
import { llog } from '../_engine/utils/Logger';
import { getRenderer } from '../_engine/core/Renderer';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

/** A studio environment PMREM, as p084 plans (needs the renderer, so built on first enter). */
const createRoomEnv = () => {
  const pmrem = new THREE.PMREMGenerator(getRenderer() as THREE.WebGPURenderer);
  return pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
};

const createTestView = (
  id: string,
  title: string,
  icon: SvgIconKey,
  color: number,
  withEnv = false
) => {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x203040);
  const cube = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1, 1),
    new THREE.MeshStandardNodeMaterial({ color, roughness: 0.4 })
  );
  scene.add(cube);
  scene.add(new THREE.AxesHelper(1.5));
  scene.add(new THREE.AmbientLight(0xffffff, 0.4));
  const sun = new THREE.DirectionalLight(0xffffff, 2);
  sun.position.set(3, 5, 2);
  scene.add(sun);

  const viewCam = createViewCamera({
    viewId: id,
    defaultPose: { position: { x: 2.5, y: 2, z: 3.5 }, target: { x: 0, y: 0, z: 0 }, fov: 50 },
    near: 0.1,
    far: 100,
  });

  registerView({
    id,
    title,
    icon,
    scene,
    getCamera: () => viewCam.camera,
    getCameraRig: () => viewCam.rig,
    onEnter: () => {
      if (withEnv && !scene.environment) scene.environment = createRoomEnv();
      viewCam.onEnter();
      llog(`[${id}] enter, elapsed`, getElapsedTime());
    },
    onExit: () => {
      viewCam.onExit();
      llog(`[${id}] exit, elapsed`, getElapsedTime());
    },
    mainUpdate: () => viewCam.mainUpdate(),
    update: (delta) => {
      cube.rotation.y += delta;
      cube.rotation.x += delta * 0.4;
    },
  });
  return viewCam;
};

export const cams = {
  testViewA: createTestView('testViewA', 'Test view A', 'geometry', 0xff8844),
  testViewB: createTestView('testViewB', 'Test view B', 'texture', 0x44aaff, true),
};

export const enter = (id: keyof typeof cams = 'testViewA') => setActiveView(id);
export const exit = () => setActiveView(RUNTIME_VIEW_ID);
export const play = (value?: boolean) => toggleViewPlay(value);
export const setKey = (id: keyof typeof cams, key: string | null) => cams[id].setPoseKey(key);
export const pose = (id: keyof typeof cams) => cams[id].getPose();
export const info = () => ({
  view: getActiveViewId(),
  viewPlaying: isViewPlaying(),
  elapsed: getElapsedTime(),
  loop: getReadOnlyLoopState(),
});
