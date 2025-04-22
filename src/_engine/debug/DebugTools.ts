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
import { debugSceneListing, type DebugScene } from './DebugSceneListing';
import { isCurrentlyLoading, loadScene } from '../core/SceneLoader';
import { lerror, llog } from '../utils/Logger';

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
  };
  loggingActions: {
    loggingFolderExpanded: boolean;
  };
  debugCamera: { [sceneId: string]: DebugCameraState };
};
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
  },
  loggingActions: {
    loggingFolderExpanded: false,
  },
  debugCamera: {},
};

/**
 * Initializes the debug tools (only for debug environments).
 */
export const initDebugTools = () => {
  if (!isDebugEnvironment()) return;
  createDebugToolsDebugGUI();
  const debugSceneListingConfig = getConfig().debugScenes || [];
  if (debugSceneListingConfig?.length) {
    addScenesToSceneListing(debugSceneListingConfig);
  }
};

// Debug GUI for sky box
const createDebugToolsDebugGUI = () => {
  const savedDebugToolsState = lsGetItem(LS_KEY, debugToolsState);
  debugToolsState = { ...debugToolsState, ...savedDebugToolsState };

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

  createDebuggerTab({
    id: 'debugToolsControls',
    buttonText: 'TOOLS',
    title: 'Debug tools controls',
    orderNr: 6,
    container: () => {
      const { container, debugGUI } = createNewDebuggerPane('debugTools', 'Debug Tools Controls');
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
 * @returns debugToolsState {@link debugToolsState}
 */
export const getDebugToolsState = () => debugToolsState;

/**
 * Adds a scene or scenes to the debugToolsState scenes listing
 * @param scenes (SceneListing | SceneListing[]) either an object or an array of objects ({@link SceneListing})
 */
export const addScenesToSceneListing = (scenes: DebugScene | DebugScene[]) => {
  if (Array.isArray(scenes)) {
    for (let i = 0; i < scenes.length; i++) {
      const foundScene = debugSceneListing.find((scene) => scene.id === scenes[i].id);
      if (!foundScene) debugSceneListing.push(scenes[i]);
    }
    reloadSceneListingBlade();
    return;
  }
  const foundScene = debugSceneListing.find((scene) => scene.id === scenes.id);
  if (!foundScene) debugSceneListing.push(scenes);
  reloadSceneListingBlade();
};

/**
 * Removes a scene or scenes from the scene listing
 * @param sceneIds (string | string[]) a single or multiple sceneIds that need to be remove from scene listing
 */
export const removeScenesFromSceneListing = (sceneIds: string | string[]) => {
  if (Array.isArray(sceneIds)) {
    const indexes: number[] = [];
    for (let i = 0; i < debugSceneListing.length; i++) {
      if (sceneIds.includes(debugSceneListing[i].id)) {
        indexes.push(i);
      }
    }
    for (let i = 0; i < indexes.length; i++) {
      debugSceneListing.splice(indexes[i], 1);
    }
    reloadSceneListingBlade();
    return;
  }
  let index: number | null = null;
  for (let i = 0; i < debugSceneListing.length; i++) {
    if (sceneIds.includes(debugSceneListing[i].id)) {
      index = i;
    }
  }
  if (index !== null) debugSceneListing.splice(index, 1);
  reloadSceneListingBlade();
};

// For reloading the scenes listing in debugging
const reloadSceneListingBlade = () => {
  if (scenesDropDown) {
    scenesDropDown.importState({
      ...scenesDropDown.exportState(),
      options: debugSceneListing.map((s) => ({ value: s.id, text: s.text || s.id })),
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
      title: 'Scenes and debug scenes',
      expanded: debugToolsState.scenesListing.scenesFolderExpanded,
    })
    .on('fold', (state) => {
      debugToolsState.scenesListing.scenesFolderExpanded = state.expanded;
      lsSetItem(LS_KEY, debugToolsState);
    });
  scenesDropDown = scenesFolder.addBlade({
    view: 'list',
    label: 'Scenes',
    options: debugSceneListing.map((s) => ({ value: s.id, text: s.text || s.id })),
    value: getCurrentSceneId(),
  }) as ListBladeApi<BladeController<View>>;
  scenesDropDown.on('change', (e) => {
    const value = String(e.value);
    if (value === getCurrentSceneId()) return;
    const nextScene = debugSceneListing.find((s) => s.id === value);
    if (!isCurrentlyLoading() && nextScene) {
      loadScene({ nextSceneFn: nextScene.fn });
      // @TODO: save current scene id to debugToolsState and to localStorage
      return;
    }
    if (!isCurrentlyLoading) {
      lerror(`Could not find scene with id '${value}' in scenes dropdown debugger.`);
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
    rendererOptions: ['RENDER OPTIONS:*******', getRendererOptions(), '**********************'],
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

  debugGUI.refresh();
};
