import * as THREE from 'three/webgpu';
import { ShaderNodeObject, uniform } from 'three/tsl';
import { OrbitControls } from 'three/examples/jsm/Addons.js';
import { ListBladeApi, Pane } from 'tweakpane';
import { BladeController, FolderApi, View } from '@tweakpane/core';
import { createCamera, getAllCameras, getCurrentCameraId, setCurrentCamera } from '../core/Camera';
import { getRenderer, getRendererOptions } from '../core/Renderer';
import { lsGetItem, lsSetItem } from '../utils/LocalAndSessionStorage';
import { createNewDebuggerPane, createDebuggerTab } from './DebuggerGUI';
import { createMesh } from '../core/Mesh';
import { createGeometry } from '../core/Geometry';
import { createMaterial, deleteMaterial } from '../core/Material';
import { getCurrentSceneId, getRootScene, getScene } from '../core/Scene';
import { getEnvMapRoughnessBg } from '../core/SkyBox';
import { getConfig, getCurrentEnvironment, getEnvs, isDebugEnvironment } from '../core/Config';
import { debuggerSceneListing, type DebugScene } from './debugScenes/debuggerSceneListing';
import { isCurrentlyLoading, loadScene } from '../core/SceneLoader';
import { lerror, llog } from '../utils/Logger';
import { DEBUGGER_SCENE_LOADER_ID } from './DebuggerSceneLoader';
import { openDraggableWindow } from '../core/UI/DraggableWindow';
import { openDialog } from '../core/UI/DialogWindow';
import { getSvgIcon } from '../core/UI/icons/SvgIcon';
import {
  createAxesHelper,
  createGridHelper,
  createPolarGridHelper,
  getAllCameraHelpers,
  getAllLightHelpers,
  toggleAxesHelperVisibility,
  toggleGridHelperVisibility,
  toggleLightHelper,
  togglePolarGridHelperVisibility,
} from '../core/Helpers';
import { getAllLights } from '../core/Light';

const LS_KEY = 'debugTools';
const ENV_MIRROR_BALL_MESH_ID = 'envMirrorBallMesh';
export const DEBUG_CAMERA_ID = '_debugCamera';
const DEFAULT_DEBUG_CAM_PARAMS: DebugCameraState = {
  enabled: false,
  latestAppCameraId: null,
  fov: 60,
  near: 0.001,
  far: 1000,
  position: [0, 0, 10],
  target: [0, 0, 0],
};
const getDefaultDebugCamParams = () => ({ ...DEFAULT_DEBUG_CAM_PARAMS }) as DebugCameraState;
let envBallMesh: THREE.Mesh | null = null;
let envBallColorNode: ShaderNodeObject<THREE.PMREMNode> | null = null;
let envBallRoughnessNode: ShaderNodeObject<THREE.UniformNode<number>> = uniform(0);
let envBallFolder: FolderApi | null = null;
let debugCamera: THREE.PerspectiveCamera | null = null;
let curSceneDebugCamParams = getDefaultDebugCamParams();
let orbitControls: OrbitControls | null = null;
let scenesDropDown: ListBladeApi<BladeController<View>>;
let sceneStarterDropDown: ListBladeApi<BladeController<View>>;
let toolsDebugGUI: Pane | null = null;

type DebugCameraState = {
  enabled: boolean;
  latestAppCameraId: null | string;
  fov: number;
  near: number;
  far: number;
  position: number[];
  target: number[];
};

type DebugToolsState = {
  env: {
    envBallFolderExpanded: boolean;
    envBallVisible: boolean;
    separateBallValues: boolean;
    ballRoughness: number;
    ballDefaultRoughness: number;
  };
  scenesListing: {
    scenesFolderExpanded: boolean;
    useDebugStartScene: boolean;
    debugStartScene: string;
    useDebuggerSceneLoader: boolean;
  };
  loggingActions: {
    loggingFolderExpanded: boolean;
  };
  debugCamera: { [sceneId: string]: DebugCameraState };
  helpers: {
    helpersFolderExpanded: boolean;
    showAxesHelper: boolean;
    axesHelperSize: number;
    showGridHelper: boolean;
    gridSize: number;
    gridDivisionsSize: number;
    gridColorCenterLine: number;
    gridColorGrid: number;
    showPolarGridHelper: boolean;
    polarGridRadius: number;
    polarGridSectors: number;
    polarGridRings: number;
    polarGridDivisions: number;
  };
};

let firstDebugToolsStateLoaded = false;
let debugToolsState: DebugToolsState = {
  env: {
    envBallFolderExpanded: false,
    envBallVisible: false,
    separateBallValues: false,
    ballRoughness: 0,
    ballDefaultRoughness: 0,
  },
  scenesListing: {
    scenesFolderExpanded: false,
    useDebugStartScene: false,
    debugStartScene: '',
    useDebuggerSceneLoader: false,
  },
  loggingActions: {
    loggingFolderExpanded: false,
  },
  debugCamera: {},
  helpers: {
    helpersFolderExpanded: false,
    showAxesHelper: false,
    axesHelperSize: 1,
    showGridHelper: false,
    gridSize: 100,
    gridDivisionsSize: 100,
    gridColorCenterLine: 0x888888,
    gridColorGrid: 0x444444,
    showPolarGridHelper: false,
    polarGridRadius: 10,
    polarGridSectors: 16,
    polarGridRings: 8,
    polarGridDivisions: 16,
  },
};

/**
 * Initializes the debug tools (only for debug environments).
 */
export const initDebugTools = () => {
  if (!isDebugEnvironment()) return;
  createDebugToolsDebugGUI();
  const debuggerSceneListingConfig = getConfig().debugScenes || [];
  if (debuggerSceneListingConfig?.length) {
    addScenesToSceneListing(debuggerSceneListingConfig);
  }
};

// Debug GUI for sky box
const createDebugToolsDebugGUI = () => {
  const savedDebugToolsState = lsGetItem(LS_KEY, debugToolsState);
  debugToolsState = { ...debugToolsState, ...savedDebugToolsState };
  firstDebugToolsStateLoaded = true;

  const currentSceneId = getCurrentSceneId();
  if (currentSceneId) {
    curSceneDebugCamParams =
      debugToolsState.debugCamera[currentSceneId] || getDefaultDebugCamParams();
  }

  debugCamera = createCamera(DEBUG_CAMERA_ID, {
    isCurrentCamera: curSceneDebugCamParams.enabled,
    fov: curSceneDebugCamParams.fov,
    near: curSceneDebugCamParams.near,
    far: curSceneDebugCamParams.far,
  });
  // @MAYBE: add this as debug camera (and also add to createCamera)
  // const horizontalFov = 90;
  // debugCamera.fov =
  //   (Math.atan(Math.tan(((horizontalFov / 2) * Math.PI) / 180) / debugCamera.aspect) * 2 * 180) /
  //   Math.PI;
  if (!debugCamera) {
    const msg = 'Error while creating debug camera in createDebugToolsDebugGUI';
    lerror(msg);
    throw new Error(msg);
  }

  createOnScreenTools(debugCamera);

  const renderer = getRenderer();
  if (!renderer) {
    const msg = 'Renderer not found in createDebugToolsDebugGUI';
    lerror(msg);
    throw new Error(msg);
  }
  orbitControls = new OrbitControls(debugCamera, renderer.domElement);
  orbitControls.addEventListener('end', () => {
    const position = [
      debugCamera?.position.x || 0,
      debugCamera?.position.y || 0,
      debugCamera?.position.z || 0,
    ];
    const target = [
      orbitControls?.target.x || 0,
      orbitControls?.target.y || 0,
      orbitControls?.target.z || 0,
    ];
    curSceneDebugCamParams.position = position;
    curSceneDebugCamParams.target = target;
    lsSetItem(LS_KEY, debugToolsState);
  });
  orbitControls.enabled = curSceneDebugCamParams.enabled;

  toggleAxesHelperVisibility(debugToolsState.helpers.showAxesHelper);
  toggleGridHelperVisibility(debugToolsState.helpers.showGridHelper);
  togglePolarGridHelperVisibility(debugToolsState.helpers.showPolarGridHelper);

  const icon = getSvgIcon('tools');
  createDebuggerTab({
    id: 'debugToolsControls',
    buttonText: icon,
    title: 'Debug tools controls',
    orderNr: 6,
    container: () => {
      const { container, debugGUI } = createNewDebuggerPane(
        'debugTools',
        `${icon} Debug Tools Controls`
      );
      toolsDebugGUI = debugGUI;
      buildDebugGUI();

      return container;
    },
  });
};

// On screen tools (eg. env ball)
const createOnScreenTools = (debugCamera: THREE.PerspectiveCamera) => {
  debugCamera.position.set(
    curSceneDebugCamParams.position[0],
    curSceneDebugCamParams.position[1],
    curSceneDebugCamParams.position[2]
  );
  debugCamera.lookAt(
    new THREE.Vector3(
      curSceneDebugCamParams.target[0],
      curSceneDebugCamParams.target[1],
      curSceneDebugCamParams.target[2]
    )
  );

  const viewBoundsMin = new THREE.Vector2();
  const viewBoundsMax = new THREE.Vector2();
  debugCamera.getViewBounds(1, viewBoundsMin, viewBoundsMax);

  // Tool group
  // const toolGroup = createGroup({ id: 'debugToolsGroup' });
  const toolGroup = createMesh({
    id: 'debugToolsGroup',
    geo: createGeometry({
      id: 'debugToolsGroupGep',
      type: 'BOX',
      params: {
        width: viewBoundsMax.x - viewBoundsMin.x,
        height: viewBoundsMax.y - viewBoundsMin.y,
        depth: 2,
      },
    }),
    mat: createMaterial({
      id: 'debugToolsGroupMat',
      type: 'BASIC',
      params: {
        transparent: true,
        opacity: 0,
      },
    }),
  });

  // Environment mirror ball
  envBallRoughnessNode.value = debugToolsState.env.separateBallValues
    ? debugToolsState.env.ballRoughness
    : getEnvMapRoughnessBg()?.value || debugToolsState.env.ballDefaultRoughness;
  envBallMesh = createMesh({
    id: ENV_MIRROR_BALL_MESH_ID,
    geo: createGeometry({
      id: 'envMirrorBallGeo',
      type: 'SPHERE',
      params: { radius: 0.13, widthSegments: 64, heightSegments: 64 },
    }),
    mat: createMaterial({
      id: 'envMirrorBallMat',
      type: 'BASICNODEMATERIAL',
      params: {
        depthTest: false,
        ...(envBallColorNode ? { colorNode: envBallColorNode } : {}),
      },
    }),
  });
  toolGroup.add(envBallMesh);
  envBallMesh.visible = Boolean(envBallColorNode && debugToolsState.env.envBallVisible);

  envBallMesh.position.x = 0;
  envBallMesh.position.y = 0;
  envBallMesh.position.z = 1;
  envBallMesh.renderOrder = 999999;

  // Add toolgroup to mesh and debugCamera to scene
  debugCamera.add(toolGroup);
  toolGroup.position.set(0, 0, -2.5);
  toolGroup.lookAt(debugCamera.position);

  getRootScene()?.add(debugCamera);
};

/**
 * Sets the debug tools visibility (on screen tools and debug tools)
 * @param show (boolean) whether to show the debug tools (and use debug camera) or not
 * @param refreshPane (boolean) optional value to determine whether the debug pane should be refreshed or not
 * @returns
 */
export const setDebugToolsVisibility = (show: boolean, refreshPane?: boolean) => {
  const currentSceneId = getCurrentSceneId();
  if (!currentSceneId) {
    const msg = 'Could not find current scene id in setDebugToolsVisibility';
    lerror(msg);
    throw new Error(msg);
  }
  if (currentSceneId) {
    curSceneDebugCamParams =
      debugToolsState.debugCamera[currentSceneId] || getDefaultDebugCamParams();
  }

  if (show) {
    const currentCameraId = getCurrentCameraId();
    if (currentCameraId !== DEBUG_CAMERA_ID) {
      curSceneDebugCamParams.latestAppCameraId = currentCameraId;
    }
    if (orbitControls) orbitControls.enabled = true;
    if (debugCamera) {
      if (debugCamera.children[0]) debugCamera.children[0].visible = true;
      debugCamera.position.set(
        curSceneDebugCamParams.position[0],
        curSceneDebugCamParams.position[1],
        curSceneDebugCamParams.position[2]
      );
      debugCamera.lookAt(
        new THREE.Vector3(
          curSceneDebugCamParams.target[0],
          curSceneDebugCamParams.target[1],
          curSceneDebugCamParams.target[2]
        )
      );
    }
    setCurrentCamera(DEBUG_CAMERA_ID);
    if (refreshPane) buildDebugGUI();
    return;
  }

  if (orbitControls) orbitControls.enabled = false;
  if (debugCamera?.children[0]) debugCamera.children[0].visible = false;
  setCurrentCamera(
    debugToolsState.debugCamera[currentSceneId].latestAppCameraId || Object.keys(getAllCameras())[0]
  );
  if (refreshPane) buildDebugGUI();
};

/**
 * Adds a new colorNode to the environment debug ball (in the bottom left corner when using the debug camera).
 * @param colorNode ShaderNodeObject<THREE.PMREMNode> to use in the env ball material
 * @param ballRough ShaderNodeObject<THREE.UniformNode<number>> to control the env ball roughness
 */
export const setDebugEnvBallMaterial = (
  colorNode?: ShaderNodeObject<THREE.PMREMNode>,
  ballRoughness?: ShaderNodeObject<THREE.UniformNode<number>>
) => {
  if (!isDebugEnvironment()) return;
  envBallColorNode = colorNode || null;
  envBallRoughnessNode = ballRoughness !== undefined ? ballRoughness : uniform(0);
  if (debugToolsState.env.separateBallValues) {
    envBallRoughnessNode.value = debugToolsState.env.ballRoughness;
  }

  if (debugToolsState.env.envBallVisible) {
    if (envBallMesh) envBallMesh.visible = true;
  } else {
    if (envBallMesh) envBallMesh.visible = false;
  }

  if (colorNode && envBallFolder) envBallFolder.hidden = false;
  if (!colorNode && envBallFolder) envBallFolder.hidden = true;

  if (!colorNode && !ballRoughness) {
    // Disable the env ball and env ball tools
    if (envBallMesh) envBallMesh.visible = false;
    debugToolsState.env.envBallVisible = false;
    return;
  }

  if (!envBallMesh || !debugCamera) return;
  const matId = `${ENV_MIRROR_BALL_MESH_ID}-material`;
  deleteMaterial(matId);
  envBallMesh.material = createMaterial({
    id: matId,
    type: 'BASICNODEMATERIAL',
    params: { colorNode },
  });
};

/**
 * Change the env map ball roughness
 * @param value roughness value (0.0 - 1.0)
 */
export const changeDebugEnvBallRoughness = (value: number) => {
  if (!debugToolsState.env.separateBallValues) {
    envBallRoughnessNode.value = value;
    debugToolsState.env.ballRoughness = value;
    lsSetItem(LS_KEY, debugToolsState);
  }
};

/**
 * Getter for the debugToolsState object
 * @param loadFromLS (boolean) optional flag to get the debugToolsState from the LS
 * @returns debugToolsState {@link debugToolsState}
 */
export const getDebugToolsState = (loadFromLS?: boolean) => {
  if (!firstDebugToolsStateLoaded && loadFromLS) {
    const savedDebugToolsState = lsGetItem(LS_KEY, debugToolsState);
    debugToolsState = { ...debugToolsState, ...savedDebugToolsState };
  }
  return debugToolsState;
};

/**
 * Adds a scene or scenes to the debugToolsState scenes listing
 * @param scenes (SceneListing | SceneListing[]) either an object or an array of objects ({@link SceneListing})
 */
export const addScenesToSceneListing = (scenes: DebugScene | DebugScene[]) => {
  if (Array.isArray(scenes)) {
    for (let i = 0; i < scenes.length; i++) {
      const foundScene = debuggerSceneListing.find((scene) => scene.id === scenes[i].id);
      if (!foundScene) debuggerSceneListing.push(scenes[i]);
    }
    reloadSceneListingBlade();
    return;
  }
  const foundScene = debuggerSceneListing.find((scene) => scene.id === scenes.id);
  if (!foundScene) debuggerSceneListing.push(scenes);
  reloadSceneListingBlade();
};

/**
 * Removes a scene or scenes from the scene listing
 * @param sceneIds (string | string[]) a single or multiple sceneIds that need to be remove from scene listing
 */
export const removeScenesFromSceneListing = (sceneIds: string | string[]) => {
  if (Array.isArray(sceneIds)) {
    const indexes: number[] = [];
    for (let i = 0; i < debuggerSceneListing.length; i++) {
      if (sceneIds.includes(debuggerSceneListing[i].id)) {
        indexes.push(i);
      }
    }
    for (let i = 0; i < indexes.length; i++) {
      debuggerSceneListing.splice(indexes[i], 1);
    }
    reloadSceneListingBlade();
    return;
  }
  let index: number | null = null;
  for (let i = 0; i < debuggerSceneListing.length; i++) {
    if (sceneIds.includes(debuggerSceneListing[i].id)) {
      index = i;
    }
  }
  if (index !== null) debuggerSceneListing.splice(index, 1);
  reloadSceneListingBlade();
};

const getSceneStarterDropDownOptions = () => [
  { value: '', text: '---NOT-SET---' },
  ...debuggerSceneListing.map((s) => ({ value: s.id, text: s.text || s.id })),
];

// For reloading the scenes listing in debugging
const reloadSceneListingBlade = () => {
  if (scenesDropDown) {
    scenesDropDown.importState({
      ...scenesDropDown.exportState(),
      options: debuggerSceneListing.map((s) => ({ value: s.id, text: s.text || s.id })),
    });
  }
  if (sceneStarterDropDown) {
    sceneStarterDropDown.importState({
      ...sceneStarterDropDown.exportState(),
      options: getSceneStarterDropDownOptions(),
    });
  }
};

/**
 * TODO jsDoc
 * @returns boolean
 */
export const isUsingDebugCamera = () => isDebugEnvironment() && curSceneDebugCamParams.enabled;

/**
 * Add scene to debug tools states
 * @param sceneId (string)
 */
export const addSceneToDebugtools = (sceneId: string) => {
  if (!isDebugEnvironment()) return;
  const foundScene = getScene(sceneId);
  if (!foundScene || debugToolsState.debugCamera[sceneId]) return;

  debugToolsState.debugCamera[sceneId] = getDefaultDebugCamParams();
};

const buildDebugGUI = () => {
  const debugGUI = toolsDebugGUI;
  const currentSceneId = getCurrentSceneId();
  if (!debugGUI || !currentSceneId) return;
  if (!debugToolsState.debugCamera[currentSceneId]) {
    debugToolsState.debugCamera[currentSceneId] = getDefaultDebugCamParams();
  }
  curSceneDebugCamParams = debugToolsState.debugCamera[currentSceneId];

  const blades = debugGUI?.children || [];
  for (let i = 0; i < blades.length; i++) {
    blades[i].dispose();
  }

  debugGUI
    .addBinding(curSceneDebugCamParams, 'enabled', {
      label: 'Use debug camera',
    })
    .on('change', (e) => {
      const currentSceneId = getCurrentSceneId();
      if (!currentSceneId) return;
      if (!debugToolsState.debugCamera[currentSceneId]) {
        debugToolsState.debugCamera[currentSceneId] = getDefaultDebugCamParams();
      }
      debugToolsState.debugCamera[currentSceneId].enabled = e.value;
      curSceneDebugCamParams = debugToolsState.debugCamera[currentSceneId];
      if (envBallFolder) envBallFolder.hidden = !e.value;
      lsSetItem(LS_KEY, debugToolsState);
      setDebugToolsVisibility(e.value);
    });
  debugGUI
    .addBinding(curSceneDebugCamParams, 'fov', {
      label: 'Debug camera FOV',
      step: 1,
      min: 1,
      max: 180,
    })
    .on('change', (e) => {
      if (!debugCamera) return;
      debugCamera.fov = e.value;
      debugCamera.updateProjectionMatrix();
      const currentSceneId = getCurrentSceneId();
      if (!currentSceneId) return;
      if (!debugToolsState.debugCamera[currentSceneId]) {
        debugToolsState.debugCamera[currentSceneId] = getDefaultDebugCamParams();
      }
      debugToolsState.debugCamera[currentSceneId].fov = e.value;
      curSceneDebugCamParams = debugToolsState.debugCamera[currentSceneId];
      lsSetItem(LS_KEY, debugToolsState);
    });
  debugGUI
    .addBinding(curSceneDebugCamParams, 'near', {
      label: 'Debug camera near',
      step: 0.01,
      min: 0.01,
    })
    .on('change', (e) => {
      if (!debugCamera) return;
      debugCamera.near = e.value;
      debugCamera.updateProjectionMatrix();
      const currentSceneId = getCurrentSceneId();
      if (!currentSceneId) return;
      if (!debugToolsState.debugCamera[currentSceneId]) {
        debugToolsState.debugCamera[currentSceneId] = getDefaultDebugCamParams();
      }
      debugToolsState.debugCamera[currentSceneId].near = e.value;
      curSceneDebugCamParams = debugToolsState.debugCamera[currentSceneId];
      lsSetItem(LS_KEY, debugToolsState);
    });
  debugGUI
    .addBinding(curSceneDebugCamParams, 'far', {
      label: 'Debug camera far',
      step: 0.01,
      min: 0.02,
    })
    .on('change', (e) => {
      if (!debugCamera) return;
      debugCamera.far = e.value;
      debugCamera.updateProjectionMatrix();
      const currentSceneId = getCurrentSceneId();
      if (!currentSceneId) return;
      if (!debugToolsState.debugCamera[currentSceneId]) {
        debugToolsState.debugCamera[currentSceneId] = getDefaultDebugCamParams();
      }
      debugToolsState.debugCamera[currentSceneId].far = e.value;
      curSceneDebugCamParams = debugToolsState.debugCamera[currentSceneId];
      lsSetItem(LS_KEY, debugToolsState);
    });

  // Env ball
  envBallFolder = debugGUI
    .addFolder({
      title: 'Environment ball',
      expanded: debugToolsState.env.envBallFolderExpanded,
      hidden:
        !Boolean(envBallColorNode) ||
        !debugToolsState.debugCamera[getCurrentSceneId() || '']?.enabled,
    })
    .on('fold', (state) => {
      debugToolsState.env.envBallFolderExpanded = state.expanded;
      lsSetItem(LS_KEY, debugToolsState);
    });
  envBallFolder
    .addBinding(debugToolsState.env, 'envBallVisible', {
      label: 'Show env ball',
    })
    .on('change', (e) => {
      lsSetItem(LS_KEY, debugToolsState);
      if (!Boolean(envBallColorNode)) return;
      if (envBallMesh) envBallMesh.visible = e.value;
    });
  envBallFolder
    .addBinding(debugToolsState.env, 'separateBallValues', {
      label: 'Separate env ball values',
    })
    .on('change', (e) => {
      envBallRoughnessNode.value = e.value
        ? debugToolsState.env.ballRoughness
        : getEnvMapRoughnessBg()?.value !== undefined
          ? getEnvMapRoughnessBg().value
          : debugToolsState.env.ballDefaultRoughness;
      ballRoughnesGUI.disabled = !e.value;
      lsSetItem(LS_KEY, debugToolsState);
    });
  const ballRoughnesGUI = envBallFolder
    .addBinding(debugToolsState.env, 'ballRoughness', {
      label: 'Env ball roughness',
      step: 0.001,
      min: 0,
      max: 1,
      disabled: !debugToolsState.env.separateBallValues,
    })
    .on('change', (e) => {
      envBallRoughnessNode.value = e.value;
      lsSetItem(LS_KEY, debugToolsState);
    });

  // Scene listing
  const scenesFolder = debugGUI
    .addFolder({
      title: 'Change scene and debug start scene',
      expanded: debugToolsState.scenesListing.scenesFolderExpanded,
    })
    .on('fold', (state) => {
      debugToolsState.scenesListing.scenesFolderExpanded = state.expanded;
      lsSetItem(LS_KEY, debugToolsState);
    });
  scenesDropDown = scenesFolder.addBlade({
    view: 'list',
    label: 'Change scene',
    options: debuggerSceneListing.map((s) => ({ value: s.id, text: s.text || s.id })),
    value: getCurrentSceneId(),
  }) as ListBladeApi<BladeController<View>>;
  scenesDropDown.on('change', (e) => {
    const value = String(e.value);
    if (value === getCurrentSceneId()) return;
    const nextScene = debuggerSceneListing.find((s) => s.id === value);
    if (!isCurrentlyLoading() && nextScene) {
      lsSetItem(LS_KEY, debugToolsState);
      loadScene({ nextSceneFn: nextScene.fn, loaderId: DEBUGGER_SCENE_LOADER_ID });
      return;
    }
    if (!isCurrentlyLoading) {
      lerror(`Could not find scene with id '${value}' in scenes dropdown debugger.`);
    }
  });
  scenesFolder
    .addBinding(debugToolsState.scenesListing, 'useDebugStartScene', {
      label: 'Use debug start scene',
    })
    .on('change', (e) => {
      sceneStarterDropDown.disabled = !e.value;
      useDebuggerSceneLoader.disabled = !e.value;
      lsSetItem(LS_KEY, debugToolsState);
    });
  sceneStarterDropDown = scenesFolder.addBlade({
    view: 'list',
    label: 'Start scene to load',
    options: getSceneStarterDropDownOptions(),
    value: debugToolsState.scenesListing.debugStartScene || '',
    disabled: !debugToolsState.scenesListing.useDebugStartScene,
  }) as ListBladeApi<BladeController<View>>;
  sceneStarterDropDown.on('change', (e) => {
    debugToolsState.scenesListing.debugStartScene = String(e.value);
    lsSetItem(LS_KEY, debugToolsState);
  });
  const useDebuggerSceneLoader = scenesFolder
    .addBinding(debugToolsState.scenesListing, 'useDebuggerSceneLoader', {
      label: 'Use debugger scene loader',
      disabled: !debugToolsState.scenesListing.useDebugStartScene,
    })
    .on('change', () => {
      lsSetItem(LS_KEY, debugToolsState);
    });

  // Helpers
  const helpersFolder = debugGUI
    .addFolder({
      title: 'Helpers',
      expanded: debugToolsState.helpers.helpersFolderExpanded,
    })
    .on('fold', (state) => {
      debugToolsState.helpers.helpersFolderExpanded = state.expanded;
      lsSetItem(LS_KEY, debugToolsState);
    });
  helpersFolder // AXES HELPER
    .addBinding(debugToolsState.helpers, 'showAxesHelper', { label: 'Show axes helper' })
    .on('change', (e) => {
      toggleAxesHelperVisibility(e.value);
      lsSetItem(LS_KEY, debugToolsState);
    });
  helpersFolder
    .addBinding(debugToolsState.helpers, 'axesHelperSize', {
      label: 'Axes helper size',
      min: 0.1,
      step: 0.1,
    })
    .on('change', (e) => {
      createAxesHelper(Number(e.value));
      lsSetItem(LS_KEY, debugToolsState);
    });
  helpersFolder.addBlade({ view: 'separator' });
  helpersFolder // GRID HELPER
    .addBinding(debugToolsState.helpers, 'showGridHelper', { label: 'Show grid helper' })
    .on('change', (e) => {
      toggleGridHelperVisibility(e.value);
      lsSetItem(LS_KEY, debugToolsState);
    });
  helpersFolder
    .addBinding(debugToolsState.helpers, 'gridSize', { label: 'Grid size', min: 0.01, step: 0.01 })
    .on('change', (e) => {
      createGridHelper(
        Number(e.value),
        debugToolsState.helpers.gridDivisionsSize,
        debugToolsState.helpers.gridColorCenterLine,
        debugToolsState.helpers.gridColorGrid
      );
      lsSetItem(LS_KEY, debugToolsState);
    });
  helpersFolder
    .addBinding(debugToolsState.helpers, 'gridDivisionsSize', {
      label: "Grid division's size",
      min: 0.01,
      step: 0.01,
    })
    .on('change', (e) => {
      createGridHelper(
        debugToolsState.helpers.gridSize,
        Number(e.value),
        debugToolsState.helpers.gridColorCenterLine,
        debugToolsState.helpers.gridColorGrid
      );
      lsSetItem(LS_KEY, debugToolsState);
    });
  helpersFolder
    .addBinding(debugToolsState.helpers, 'gridColorCenterLine', {
      label: "Grid's center line color",
      color: { type: 'float' },
    })
    .on('change', (e) => {
      createGridHelper(
        debugToolsState.helpers.gridSize,
        debugToolsState.helpers.gridDivisionsSize,
        Number(e.value),
        debugToolsState.helpers.gridColorGrid
      );
      lsSetItem(LS_KEY, debugToolsState);
    });
  helpersFolder
    .addBinding(debugToolsState.helpers, 'gridColorGrid', {
      label: "Grid's color",
      color: { type: 'float' },
    })
    .on('change', (e) => {
      createGridHelper(
        debugToolsState.helpers.gridSize,
        debugToolsState.helpers.gridDivisionsSize,
        debugToolsState.helpers.gridColorCenterLine,
        Number(e.value)
      );
      lsSetItem(LS_KEY, debugToolsState);
    });
  helpersFolder.addBlade({ view: 'separator' });
  helpersFolder // POLAR GRID HELPER
    .addBinding(debugToolsState.helpers, 'showPolarGridHelper', { label: 'Show polar grid helper' })
    .on('change', (e) => {
      togglePolarGridHelperVisibility(e.value);
      lsSetItem(LS_KEY, debugToolsState);
    });
  helpersFolder
    .addBinding(debugToolsState.helpers, 'polarGridRadius', {
      label: 'Polar grid radius  ',
      min: 0.01,
      step: 0.01,
    })
    .on('change', (e) => {
      createPolarGridHelper(
        Number(e.value),
        debugToolsState.helpers.polarGridSectors,
        debugToolsState.helpers.polarGridRings,
        debugToolsState.helpers.polarGridDivisions
      );
      lsSetItem(LS_KEY, debugToolsState);
    });
  helpersFolder
    .addBinding(debugToolsState.helpers, 'polarGridSectors', {
      label: 'Polar grid sectors',
      min: 1,
      step: 1,
    })
    .on('change', (e) => {
      createPolarGridHelper(
        debugToolsState.helpers.polarGridRadius,
        Number(e.value),
        debugToolsState.helpers.polarGridRings,
        debugToolsState.helpers.polarGridDivisions
      );
      lsSetItem(LS_KEY, debugToolsState);
    });
  helpersFolder
    .addBinding(debugToolsState.helpers, 'polarGridRings', {
      label: 'Polar grid rings',
      min: 0,
      step: 1,
    })
    .on('change', (e) => {
      createPolarGridHelper(
        debugToolsState.helpers.polarGridRadius,
        debugToolsState.helpers.polarGridSectors,
        Number(e.value),
        debugToolsState.helpers.polarGridDivisions
      );
      lsSetItem(LS_KEY, debugToolsState);
    });
  helpersFolder
    .addBinding(debugToolsState.helpers, 'polarGridDivisions', {
      label: 'Polar grid divisions',
      min: 0,
      step: 1,
    })
    .on('change', (e) => {
      createPolarGridHelper(
        debugToolsState.helpers.polarGridRadius,
        debugToolsState.helpers.polarGridSectors,
        debugToolsState.helpers.polarGridRings,
        Number(e.value)
      );
      lsSetItem(LS_KEY, debugToolsState);
    });
  helpersFolder.addBlade({ view: 'separator' });
  helpersFolder.addButton({ title: 'Hide / show all light helpers' }).on('click', () => {
    const lightHelpers = getAllLightHelpers();
    let allNotVisible = true;
    for (let i = 0; i < lightHelpers.length; i++) {
      if (lightHelpers[i].visible) {
        allNotVisible = false;
        break;
      }
    }
    const allLights = getAllLights();
    const allLightKeys = Object.keys(allLights);
    for (let i = 0; i < allLightKeys.length; i++) {
      const l = allLights[allLightKeys[i]];
      const id = l.userData.id;
      if (!id) continue;
      toggleLightHelper(id, allNotVisible);
    }
  });
  helpersFolder.addButton({ title: 'Hide / show all camera helpers' }).on('click', () => {
    const cameraHelpers = getAllCameraHelpers();
    let allNotVisible = true;
    for (let i = 0; i < cameraHelpers.length; i++) {
      if (cameraHelpers[i].visible && !cameraHelpers[i].userData.isLightHelper) {
        allNotVisible = false;
        break;
      }
    }
    const allCameras = getAllCameras();
    const allCameraKeys = Object.keys(allCameras);
    for (let i = 0; i < allCameraKeys.length; i++) {
      const l = allCameras[allCameraKeys[i]];
      const id = l.userData.id;
      if (!id) continue;
      // @TODO: finish this...
      // toggleCameraHelper(id, allNotVisible);
    }
  });

  // Logging actions
  const loggingFolder = debugGUI
    .addFolder({
      title: 'Logging actions ',
      expanded: debugToolsState.loggingActions.loggingFolderExpanded,
    })
    .on('fold', (state) => {
      debugToolsState.loggingActions.loggingFolderExpanded = state.expanded;
      lsSetItem(LS_KEY, debugToolsState);
    });
  const getLogActionList = () => ({
    environmentVariables: [
      'ENV VARIABLES:********\n',
      `Current environment: ${getCurrentEnvironment()}`,
      getEnvs(),
      '**********************',
    ],
    renderer: [
      'RENDER OPTIONS:*******',
      getRendererOptions(),
      '**********************',
      'RENDERER:*******',
      getRenderer(),
      '**********************',
    ],
    rootScene: ['ROOT SCENE:***********', getRootScene(), '**********************'],
    cameras: [
      'CAMERAS***************\n',
      `current camera id: ${getCurrentCameraId()}`,
      getAllCameras(),
      '**********************',
    ],
  });
  const getLogActionListItem = (key: string) => {
    const logActionList = getLogActionList();
    return logActionList[key as keyof typeof logActionList];
  };
  loggingFolder.addButton({ title: 'ALL' }).on('click', () => {
    const logActionList = getLogActionList();
    const keys = Object.keys(logActionList);
    for (let i = 0; i < keys.length; i++) {
      llog(...logActionList[keys[i] as keyof typeof logActionList]);
    }
  });
  const logActionList = getLogActionList();
  const logActionKeys = Object.keys(logActionList);
  for (let i = 0; i < logActionKeys.length; i++) {
    const key = logActionKeys[i] as keyof typeof logActionList;
    loggingFolder.addButton({ title: key }).on('click', () => {
      llog(...getLogActionListItem(key));
    });
  }

  // @TODO: REMOVE THESE!
  loggingFolder.addButton({ title: 'OPEN DRAGGABLE WINDOW' }).on('click', () => {
    openDraggableWindow({
      id: 'myFirstDraggableTest',
      closeIfOpen: true,
      position: { x: 400, y: 400 },
      size: { w: 200, h: 100 },
      saveToLS: true,
      title: 'My draggable window',
      isDebugWindow: true,
      disableHoriResize: false,
      disableVertResize: false,
      disableDragging: false,
      resetPosition: true,
    });
  });
  loggingFolder.addButton({ title: 'OPEN DIALOG WINDOW' }).on('click', () => {
    openDialog({
      id: 'myFirstDialogTest',
      saveToLS: true,
      title: 'My dialog window',
      // isDebugWindow: true,
      backDropClickClosesWindow: true,
    });
  });

  debugGUI.refresh();
};
