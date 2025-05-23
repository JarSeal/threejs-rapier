import * as THREE from 'three/webgpu';
import { getLight, saveLightToLS, updateLightsDebuggerGUI } from './Light';
import { isDebugEnvironment } from './Config';
import { getDebugMeshIcon } from './UI/icons/DebugMeshIcons';
import { getRootScene } from './Scene';
import { DEBUG_CAMERA_ID, getDebugToolsState } from '../debug/DebugTools';
import { getCamera, saveCameraToLS, updateCamerasDebuggerGUI } from './Camera';

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
  if (axesHelper) {
    axesHelper.visible = show;
    return;
  }
  if (!show) return;
  createAxesHelper();
};

// Grid helper
export const createGridHelper = (
  gridSize: number,
  gridDivisionsSize: number,
  centerLineColor: number,
  gridColor: number
) => {
  const rootScene = getRootScene();
  if (!rootScene) return;
  if (gridHelper) {
    gridHelper.removeFromParent();
    gridHelper.dispose();
  }
  gridHelper = new THREE.GridHelper(gridSize, gridDivisionsSize, centerLineColor, gridColor);
  rootScene.add(gridHelper);
};
export const toggleGridHelperVisibility = (show: boolean) => {
  if (gridHelper) {
    gridHelper.visible = show;
    return;
  }
  if (!show) return;
  const debugToolsState = getDebugToolsState();
  createGridHelper(
    debugToolsState.helpers.gridSize,
    debugToolsState.helpers.gridDivisionsSize,
    debugToolsState.helpers.gridColorCenterLine,
    debugToolsState.helpers.gridColorGrid
  );
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
  if (polarGridHelper) {
    polarGridHelper.visible = show;
    return;
  }
  if (!show) return;
  const debugToolsState = getDebugToolsState();
  createPolarGridHelper(
    debugToolsState.helpers.polarGridRadius,
    debugToolsState.helpers.polarGridSectors,
    debugToolsState.helpers.polarGridRings,
    debugToolsState.helpers.polarGridDivisions
  );
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

export const toggleLightHelper = (id: string, show: boolean, doNotUpdateDebuggerGUI?: boolean) => {
  const light = getLight(id);
  if (
    !light ||
    !isDebugEnvironment() ||
    light.userData.type === 'AMBIENT' ||
    light.userData.type === 'HEMISPHERE'
  ) {
    return;
  }

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
    light.userData.showHelper = false;
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
    light.userData.showHelper = true;
  } else if (show) {
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
  saveLightToLS(id);
  if (!doNotUpdateDebuggerGUI) updateLightsDebuggerGUI();
};

export const toggleCameraHelper = (id: string, show: boolean) => {
  const camera = getCamera(id);
  if (!camera || !isDebugEnvironment() || camera.userData.id === DEBUG_CAMERA_ID) {
    return;
  }

  if (!show && camera.userData.helperCreated) {
    // Hide helper
    const cameraHelper = camera.children.find(
      (child) => child.type === 'CameraHelper'
    ) as THREE.CameraHelper;
    if (cameraHelper) {
      cameraHelper.visible = false;
      removeFromCameraHelpers(cameraHelper);
    }
    camera.userData.showHelper = false;
  } else if (show && camera.userData.helperCreated) {
    // Show helper
    const cameraHelper = camera.children.find(
      (child) => child.type === 'CameraHelper'
    ) as THREE.CameraHelper;
    if (cameraHelper) {
      cameraHelper.visible = true;
      addToCameraHelpers(cameraHelper);
    }
    camera.userData.showHelper = true;
  } else if (show) {
    // Create helper and then show helper
    const type = camera.userData.type;
    if (type === 'PERSPECTIVE') {
      const cameraHelper = new THREE.CameraHelper(camera);
      cameraHelper.userData.id = `${camera.userData.id}__helper`;
      const iconMesh = getDebugMeshIcon('CAMERA');
      cameraHelper.add(iconMesh);
      addToCameraHelpers(cameraHelper);
      camera.add(cameraHelper);
      cameraHelper.update();
    }
    camera.userData.showHelper = true;
    camera.userData.helperCreated = true;
  }
  saveCameraToLS(id);
  updateCamerasDebuggerGUI();
};

export const updateHelpers = () => {
  for (let i = 0; i < cameraHelpers.length; i++) {
    cameraHelpers[i]?.update();
  }

  for (let i = 0; i < lightHelpers.length; i++) {
    // @NOTE: There is a bug with (at least) directional light that the helper does not update in some cases, this setTimeout fixes it (dirty fix)
    setTimeout(() => {
      lightHelpers[i]?.update();
      if (
        lightHelpers[i]?.parent?.userData.showHelper &&
        lightHelpers[i].type === 'DirectionalLightHelper'
      ) {
        const child = lightHelpers[i].children.find((child) => child.userData.isHelperIcon);
        if (child) {
          const target = (lightHelpers[i].parent as THREE.DirectionalLight).target;
          if (target) child.lookAt(target.position);
        }
      }
    }, 0);
  }
};
