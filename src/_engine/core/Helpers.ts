import * as THREE from 'three/webgpu';
import { getLight, saveLightToLS, updateLightsDebuggerGUI } from './Light';
import { isDebugEnvironment } from './Config';
import { getDebugMeshIcon } from './UI/icons/DebugMeshIcons';
import { getCurrentSceneId, getRootScene } from './Scene';
import { DEBUG_CAMERA_ID, getDebugToolsState } from '../debug/DebugTools';
import { getCamera, saveCameraToLS, updateCamerasDebuggerGUI } from './Camera';
import { existsOrThrow } from '../utils/helpers';

type LightHelper = THREE.DirectionalLightHelper | THREE.PointLightHelper;

// Global helpers and won't be deleted on scene change
let axesHelper: THREE.AxesHelper | null = null;
let gridHelper: THREE.GridHelper | null = null;
let polarGridHelper: THREE.PolarGridHelper | null = null;

// Per scene helpers and will be deleted on scene change
const lightHelpers: { [sceneId: string]: LightHelper[] } = {};
const cameraHelpers: { [sceneId: string]: THREE.CameraHelper[] } = {};

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
  const currentSceneId = getCurrentSceneId();
  if (!currentSceneId) return;
  const foundHelper = lightHelpers[currentSceneId]?.find(
    (h) => h.userData.id === helper.userData.id
  );
  if (foundHelper) return;
  if (!lightHelpers[currentSceneId]) lightHelpers[currentSceneId] = [];
  lightHelpers[currentSceneId].push(helper);
};

const removeFromLightHelpers = (helper: LightHelper) => {
  const currentSceneId = getCurrentSceneId();
  if (!currentSceneId) return;
  lightHelpers[currentSceneId] =
    lightHelpers[currentSceneId]?.filter((h) => h.userData.id !== helper.userData.id) || [];
};

const addToCameraHelpers = (helper: THREE.CameraHelper, isLightHelper?: boolean) => {
  const currentSceneId = getCurrentSceneId();
  if (!currentSceneId) return;
  const foundHelper = cameraHelpers[currentSceneId]?.find(
    (h) => h.userData.id === helper.userData.id
  );
  if (foundHelper) return;
  if (isLightHelper) helper.userData.isLightHelper = true;
  if (!cameraHelpers[currentSceneId]) cameraHelpers[currentSceneId] = [];
  cameraHelpers[currentSceneId].push(helper);
};

const removeFromCameraHelpers = (helper: THREE.CameraHelper) => {
  const currentSceneId = getCurrentSceneId();
  if (!currentSceneId) return;
  cameraHelpers[currentSceneId] =
    cameraHelpers[currentSceneId]?.filter((h) => h.userData.id !== helper.userData.id) || [];
};

export const getAllCurSceneLightHelpers = () => {
  const currentSceneId = getCurrentSceneId();
  if (!currentSceneId) return [];
  return lightHelpers[currentSceneId] || [];
};
export const getAllCurSceneCameraHelpers = () => {
  const currentSceneId = getCurrentSceneId();
  if (!currentSceneId) return [];
  return cameraHelpers[currentSceneId] || [];
};

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

  const rootScene = existsOrThrow(getRootScene(), 'Could not find rootScene in toggleCameraHelper');

  if (!show && camera.userData.helperCreated) {
    // Hide helper
    const cameraHelper = rootScene.children.find(
      (child) => child.type === 'CameraHelper' && child.userData.cameraId === id
    ) as THREE.CameraHelper;
    if (cameraHelper) {
      cameraHelper.visible = false;
      removeFromCameraHelpers(cameraHelper);
    }
    camera.userData.showHelper = false;
  } else if (show && camera.userData.helperCreated) {
    // Show helper
    const cameraHelper = rootScene.children.find(
      (child) => child.type === 'CameraHelper' && child.userData.cameraId === id
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
      cameraHelper.userData.cameraId = id;
      cameraHelper.userData.id = `${id}__helper`;
      const iconMesh = getDebugMeshIcon('CAMERA');
      cameraHelper.add(iconMesh);
      addToCameraHelpers(cameraHelper);
      cameraHelper.visible = true;
      rootScene.add(cameraHelper);
      cameraHelper.update();
    }
    camera.userData.showHelper = true;
    camera.userData.helperCreated = true;
  }
  saveCameraToLS(id);
  updateCamerasDebuggerGUI();
};

export const updateHelpers = () => {
  const currentSceneId = getCurrentSceneId();
  if (!currentSceneId) return;

  const camHelpers = cameraHelpers[currentSceneId] || [];
  for (let i = 0; i < camHelpers.length; i++) {
    const helper = camHelpers[i];
    if (!helper) continue;
    helper.update();
  }

  const ligHelpers = lightHelpers[currentSceneId] || [];
  for (let i = 0; i < ligHelpers.length; i++) {
    // @NOTE: There is a bug with (at least) directional light that the helper does not update in some cases, this setTimeout fixes it (dirty fix)
    setTimeout(() => {
      ligHelpers[i]?.update();
      if (
        ligHelpers[i]?.parent?.userData.showHelper &&
        ligHelpers[i].type === 'DirectionalLightHelper'
      ) {
        const child = ligHelpers[i].children.find((child) => child.userData.isHelperIcon);
        if (child) {
          const target = (ligHelpers[i].parent as THREE.DirectionalLight).target;
          if (target) child.lookAt(target.position);
        }
      }
    }, 0);
  }
};

export const deleteAllLightAndCameraHelpers = () => {
  const currentSceneId = getCurrentSceneId();
  if (!currentSceneId) return;

  // Camera helpers
  for (let i = 0; i < cameraHelpers[currentSceneId].length; i++) {
    const helper = cameraHelpers[currentSceneId][i];
    if (!helper) continue;
    if ((!('isLightHelper' in helper) || !helper.isLightHelper) && helper.userData.cameraId) {
      toggleCameraHelper(helper.userData.cameraId, false);
    }
    const cameraId = helper.userData.cameraId;
    helper.removeFromParent();
    helper.dispose;
    if (!cameraId) continue;
    const camera = existsOrThrow(
      getCamera(cameraId),
      `Could not find camera with id '${cameraId}' in deleteLightAndCameraHelpers`
    );
    camera.userData.helperCreated = false;
  }
  cameraHelpers[currentSceneId] = [];

  // Light helpers
  for (let i = 0; i < lightHelpers[currentSceneId].length; i++) {
    const helper = lightHelpers[currentSceneId][i];
    if (!helper) continue;
    const light = helper.parent;
    if (light && 'isLight' in light && light.userData.id) {
      toggleLightHelper(light.userData.id, false);
      light.userData.helperCreated = false;
    }
    helper.removeFromParent();
    helper.dispose();
  }
  lightHelpers[currentSceneId] = [];
};
