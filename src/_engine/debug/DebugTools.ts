import * as THREE from 'three/webgpu';
import { ShaderNodeObject, uniform } from 'three/tsl';
import { OrbitControls } from 'three/examples/jsm/Addons.js';
import { ListBladeApi } from 'tweakpane';
import { BladeController, FolderApi, View } from '@tweakpane/core';
import { createCamera, getAllCameras, getCurrentCameraId, setCurrentCamera } from '../core/Camera';
import { getRenderer } from '../core/Renderer';
import { lsGetItem, lsSetItem } from '../utils/LocalAndSessionStorage';
import { createNewDebuggerPane, createDebuggerTab } from './DebuggerGUI';
import { createMesh } from '../core/Mesh';
import { createGeometry } from '../core/Geometry';
import { createMaterial, deleteMaterial } from '../core/Material';
import { getCurrentSceneId, getRootScene } from '../core/Scene';
import { getEnvMapRoughnessBg } from '../core/SkyBox';
import { getConfig, isDebugEnvironment } from '../core/Config';
import { debugSceneListing, type DebugScene } from './DebugSceneListing';
import { isCurrentlyLoading, loadScene } from '../core/SceneLoader';
import { lerror } from '../utils/Logger';

const LS_KEY = 'debugTools';
const ENV_MIRROR_BALL_MESH_ID = 'envMirrorBallMesh';
export const DEBUG_CAMERA_ID = '_debugCamera';
let envBallMesh: THREE.Mesh | null = null;
let envBallColorNode: ShaderNodeObject<THREE.PMREMNode> | null = null;
let envBallRoughnessNode: ShaderNodeObject<THREE.UniformNode<number>> = uniform(0);
let envBallFolder: FolderApi | null = null;
let debugCamera: THREE.PerspectiveCamera | null = null;
let orbitControls: OrbitControls | null = null;
let scenesDropDown: ListBladeApi<BladeController<View>>;
let debugToolsState: {
  useDebugCamera: boolean;
  latestAppCameraId: null | string;
  camera: {
    fov: number;
    near: number;
    far: number;
    position: number[];
    target: number[];
  };
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
} = {
  useDebugCamera: false,
  latestAppCameraId: null,
  camera: {
    fov: 60,
    near: 0.001,
    far: 1000,
    position: [0, 0, 10],
    target: [0, 0, 0],
  },
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

  debugCamera = createCamera(DEBUG_CAMERA_ID, {
    isCurrentCamera: debugToolsState.useDebugCamera,
    fov: debugToolsState.camera.fov,
    near: debugToolsState.camera.near,
    far: debugToolsState.camera.far,
  });
  // @TODO: add this as debug camera (and also add to createCamera)
  // const horizontalFov = 90;
  // debugCamera.fov =
  //   (Math.atan(Math.tan(((horizontalFov / 2) * Math.PI) / 180) / debugCamera.aspect) * 2 * 180) /
  //   Math.PI;
  if (!debugCamera)
    throw new Error('Error while creating debug camera in createDebugToolsDebugGUI');
  debugCamera.position.set(
    debugToolsState.camera.position[0],
    debugToolsState.camera.position[1],
    debugToolsState.camera.position[2]
  );
  debugCamera.lookAt(
    new THREE.Vector3(
      debugToolsState.camera.target[0],
      debugToolsState.camera.target[1],
      debugToolsState.camera.target[2]
    )
  );

  createOnScreenTools(debugCamera);

  const renderer = getRenderer();
  if (!renderer) throw new Error('Renderer not found in createDebugToolsDebugGUI');
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
    debugToolsState.camera.position = position;
    debugToolsState.camera.target = target;
    lsSetItem(LS_KEY, debugToolsState);
  });
  orbitControls.enabled = debugToolsState.useDebugCamera;

  createDebuggerTab({
    id: 'debugToolsControls',
    buttonText: 'TOOLS',
    title: 'Debug tools controls',
    orderNr: 6,
    container: () => {
      const { container, debugGUI } = createNewDebuggerPane('debugTools', 'Debug Tools Controls');

      debugGUI
        .addBinding(debugToolsState, 'useDebugCamera', { label: 'Use debug camera' })
        .on('change', (e) => {
          setDebugToolsVisibility(e.value);
          lsSetItem(LS_KEY, debugToolsState);
        });
      debugGUI
        .addBinding(debugToolsState.camera, 'fov', {
          label: 'Debug camera FOV',
          step: 1,
          min: 1,
          max: 180,
        })
        .on('change', (e) => {
          if (!debugCamera) return;
          debugCamera.fov = e.value;
          debugCamera.updateProjectionMatrix();
          lsSetItem(LS_KEY, debugToolsState);
        });
      debugGUI
        .addBinding(debugToolsState.camera, 'near', {
          label: 'Debug camera near',
          step: 0.01,
          min: 0.01,
        })
        .on('change', (e) => {
          if (!debugCamera) return;
          debugCamera.near = e.value;
          debugCamera.updateProjectionMatrix();
          lsSetItem(LS_KEY, debugToolsState);
        });
      debugGUI
        .addBinding(debugToolsState.camera, 'far', {
          label: 'Debug camera far',
          step: 0.01,
          min: 0.02,
        })
        .on('change', (e) => {
          if (!debugCamera) return;
          debugCamera.far = e.value;
          debugCamera.updateProjectionMatrix();
          lsSetItem(LS_KEY, debugToolsState);
        });

      // Env ball
      envBallFolder = debugGUI
        .addFolder({
          title: 'Environment ball',
          expanded: debugToolsState.env.envBallFolderExpanded,
          hidden: !Boolean(envBallColorNode),
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
        options: debugSceneListing.map((s) => ({ value: s.id, text: s.text || s.id })), // @TODO: add app scene name here
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

      return container;
    },
  });
};

// On screen tools (eg. env ball)
const createOnScreenTools = (debugCamera: THREE.PerspectiveCamera) => {
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

const setDebugToolsVisibility = (show: boolean) => {
  if (show) {
    debugToolsState.latestAppCameraId = getCurrentCameraId();
    if (orbitControls) orbitControls.enabled = true;
    if (debugCamera) {
      if (debugCamera.children[0]) debugCamera.children[0].visible = true;
      debugCamera.position.set(
        debugToolsState.camera.position[0],
        debugToolsState.camera.position[1],
        debugToolsState.camera.position[2]
      );
      debugCamera.lookAt(
        new THREE.Vector3(
          debugToolsState.camera.target[0],
          debugToolsState.camera.target[1],
          debugToolsState.camera.target[2]
        )
      );
    }
    setCurrentCamera(DEBUG_CAMERA_ID);
    return;
  }

  if (orbitControls) orbitControls.enabled = false;
  if (debugCamera?.children[0]) debugCamera.children[0].visible = false;
  setCurrentCamera(debugToolsState.latestAppCameraId || Object.keys(getAllCameras())[0]);
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
export const changeDebugEnvBallRoughness = (value: number) => (envBallRoughnessNode.value = value);

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
