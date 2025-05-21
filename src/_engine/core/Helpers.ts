import * as THREE from 'three/webgpu';
import { getLight } from './Light';
import { isDebugEnvironment } from './Config';
import { getDebugMeshIcon } from './UI/icons/DebugMeshIcons';
import { getRootScene } from './Scene';
import { getDebugToolsState } from '../debug/DebugTools';

type LightHelper = THREE.DirectionalLightHelper | THREE.PointLightHelper;

let axesHelper: THREE.AxesHelper | null = null;
let gridHelper: THREE.GridHelper | null = null;
let polarGridHelper: THREE.PolarGridHelper | null = null;
let lightHelpers: LightHelper[] = [];
let cameraHelpers: THREE.CameraHelper[] = [];

// Axes helper
export const createAxesHelper = (size?: number) => {
  const rootScene = getRootScene();
  if (!rootScene) return;
  if (axesHelper) {
    axesHelper.removeFromParent();
    axesHelper.dispose();
  }
  if (!size) size = getDebugToolsState().helpers.axesHelperSize;
  axesHelper = new THREE.AxesHelper(size);
  rootScene.add(axesHelper);
};
export const toggleAxesHelperVisibility = (show: boolean) => {
  if (axesHelper) axesHelper.visible = show;
};

// Grid helper
export const createGridHelper = (gridSize: number, gridDivisionsSize: number) => {
  const rootScene = getRootScene();
  if (!rootScene) return;
  if (gridHelper) {
    gridHelper.removeFromParent();
    gridHelper.dispose();
  }
  gridHelper = new THREE.GridHelper(gridSize, gridDivisionsSize);
  rootScene.add(gridHelper);
};
export const toggleGridHelperVisibility = (show: boolean) => {
  if (gridHelper) gridHelper.visible = show;
};

// Polar grid helper
export const createPolarGridHelper = (
  radius: number,
  sectors: number,
  rings: number,
  divisions: number
) => {
  const rootScene = getRootScene();
  if (!rootScene) return;
  if (polarGridHelper) {
    polarGridHelper.removeFromParent();
    polarGridHelper.dispose();
  }
  polarGridHelper = new THREE.PolarGridHelper(radius, sectors, rings, divisions);
  rootScene.add(polarGridHelper);
};
export const togglePolarGridHelperVisibility = (show: boolean) => {
  if (polarGridHelper) polarGridHelper.visible = show;
};

// Light and camera helpers
const addToLightHelpers = (helper: LightHelper) => {
  const foundHelper = lightHelpers.find((h) => h.userData.id === helper.userData.id);
  if (foundHelper) return;
  lightHelpers.push(helper);
};

const removeFromLightHelpers = (helper: LightHelper) => {
  lightHelpers = lightHelpers.filter((h) => h.userData.id !== helper.userData.id);
};

const addToCameraHelpers = (helper: THREE.CameraHelper, isLightHelper?: boolean) => {
  const foundHelper = cameraHelpers.find((h) => h.userData.id === helper.userData.id);
  if (foundHelper) return;
  if (isLightHelper) helper.userData.isLightHelper = true;
  cameraHelpers.push(helper);
};

const removeFromCameraHelpers = (helper: THREE.CameraHelper) => {
  cameraHelpers = cameraHelpers.filter((h) => h.userData.id !== helper.userData.id);
};

export const getAllLightHelpers = () => lightHelpers;
export const getAllCameraHelpers = () => cameraHelpers;

export const toggleLightHelper = (id: string, show: boolean) => {
  const light = getLight(id);
  if (!light || !isDebugEnvironment()) return;

  // Light found in scene
  if (!show && light.userData.helperCreated) {
    // Hide helper
    const cameraHelper = light.children.find(
      (child) => child.type === 'CameraHelper'
    ) as THREE.CameraHelper;
    if (cameraHelper) {
      cameraHelper.visible = false;
      removeFromCameraHelpers(cameraHelper);
    }
    const lightHelper = light.children.find(
      (child) => child.type === 'DirectionalLightHelper' || child.type === 'PointLightHelper'
    ) as LightHelper;
    if (lightHelper) {
      lightHelper.visible = false;
      removeFromLightHelpers(lightHelper);
    }
  } else if (show && light.userData.helperCreated) {
    // Show helper
    if (light.castShadow) {
      const cameraHelper = light.children.find(
        (child) => child.type === 'CameraHelper'
      ) as THREE.CameraHelper;
      if (cameraHelper) {
        cameraHelper.visible = true;
        addToCameraHelpers(cameraHelper, true);
      }
    }
    const lightHelper = light.children.find(
      (child) => child.type === 'DirectionalLightHelper' || child.type === 'PointLightHelper'
    ) as LightHelper;
    if (lightHelper) {
      lightHelper.visible = true;
      addToLightHelpers(lightHelper);
    }
  } else {
    // Create helper and then show helper
    const type = light.userData.type;
    if (type === 'DIRECTIONAL') {
      if (light.castShadow && light.shadow?.camera) {
        const cameraHelper = new THREE.CameraHelper(light.shadow.camera);
        addToCameraHelpers(cameraHelper, true);
        light.add(cameraHelper);
        cameraHelper.update();
      }

      const l = light as THREE.DirectionalLight;
      const lightHelper = new THREE.DirectionalLightHelper(l);
      const iconMesh = getDebugMeshIcon('DIRECTIONAL');
      lightHelper.add(iconMesh);
      lightHelper.userData.id = `${l.userData.id}__helper`;
      addToLightHelpers(lightHelper);
      l.add(lightHelper);
      lightHelper.update();
      iconMesh.lookAt(l.target.position);
      l.target.userData.id = `${l.userData.id}__helperTarget`;
      lightHelper.update();
    } else if (type === 'POINT') {
      const lightHelper = new THREE.PointLightHelper(light as THREE.PointLight);
      lightHelper.userData.id = `${light.userData.id}__helper`;
      const iconMesh = getDebugMeshIcon('POINT');
      lightHelper.add(iconMesh);
      addToLightHelpers(lightHelper);
      light.add(lightHelper);
      lightHelper.update();
    } else if (type === 'SPOT') {
      // @TODO: add spotlight helper
    }
    light.userData.showHelper = true;
    light.userData.helperCreated = true;
  }
};

export const updateHelpers = () => {
  for (let i = 0; i < cameraHelpers.length; i++) {
    cameraHelpers[i]?.update();
  }

  for (let i = 0; i < lightHelpers.length; i++) {
    // @NOTE: There is a bug with (at least) directional light that the helper does not update in some cases, this setTimeout fixes it (dirty fix)
    setTimeout(() => lightHelpers[i]?.update(), 0);
  }
};
