import * as THREE from 'three/webgpu';
import { ShaderNodeObject, uniform } from 'three/tsl';
import { OrbitControls } from 'three/examples/jsm/Addons.js';
import { createCamera, getAllCameras, getCurrentCameraId, setCurrentCamera } from '../core/Camera';
import { getRenderer } from '../core/Renderer';
import { lsGetItem, lsSetItem } from '../utils/LocalAndSessionStorage';
import { createNewDebuggerPane, createDebuggerTab } from './DebuggerGUI';
import { createMesh, getMesh } from '../core/Mesh';
import { createGeometry } from '../core/Geometry';
import { createMaterial } from '../core/Material';
import { getCurrentScene } from '../core/Scene';
import { getEnvMapRoughnessBg } from '../core/SkyBox';
import { isDebugEnvironment } from '../core/Config';

const LS_KEY = 'debugTools';
const ENV_MIRROR_BALL_MESH_ID = 'envMirrorBallMesh';
export const DEBUG_CAMERA_ID = '_debugCamera';
let envBallColorNode: ShaderNodeObject<THREE.PMREMNode> | null = null;
let envBallRoughnessNode: ShaderNodeObject<THREE.UniformNode<number>> = uniform(0);
let debugCamera: THREE.PerspectiveCamera | null = null;
let orbitControls: OrbitControls | null = null;
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
};

/**
 * Initializes the debug tools (only for debug environments).
 */
export const initDebugTools = () => {
  if (!isDebugEnvironment()) return;
  createDebugToolsDebugGUI();
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
      debugGUI.addBlade({ view: 'separator' });
      const envBallFolder = debugGUI
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
          const mesh = getMesh(ENV_MIRROR_BALL_MESH_ID);
          if (mesh) {
            mesh.visible = e.value;
          }
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
  const mesh = createMesh({
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
  envBallRoughnessNode.value = debugToolsState.env.separateBallValues
    ? debugToolsState.env.ballRoughness
    : getEnvMapRoughnessBg()?.value || debugToolsState.env.ballDefaultRoughness;
  toolGroup.add(mesh);
  mesh.visible = Boolean(envBallColorNode && debugToolsState.env.envBallVisible);

  mesh.position.x = 0;
  mesh.position.y = 0;
  mesh.position.z = 1;
  mesh.renderOrder = 999999;

  // Add toolgroup to mesh and debugCamera to scene
  debugCamera.add(toolGroup);
  toolGroup.position.set(0, 0, -2.5);
  toolGroup.lookAt(debugCamera.position);

  getCurrentScene().add(debugCamera);
};

// const createOnScreenTools = (debugCamera: THREE.PerspectiveCamera) => {
//   // This (renderer.setScissorTest) currently only works with WebGL renderer
//   // @TODO: check if fixes have been made in newer versions
//   if (getRendererOptions().currentApiIsWebGPU) return;

//   const renderer = getRenderer();
//   if (!renderer) return;
//   const scene = getCurrentScene();
//   if (!scene) return;
//   const windowSize = getWindowSize();

//   const view = {
//     left: 0,
//     bottom: windowSize.height - 300,
//     width: 300,
//     height: 300,
//     fov: 30,
//   };

//   const envBallCamera = new THREE.PerspectiveCamera(view.fov, windowSize.aspect, 0.1, 10);
//   debugCamera.add(envBallCamera);

//   addSceneMainLooper(
//     async () => {
//       const oldColor = new Color4();
//       renderer.getClearColor(oldColor);
//       const backgroundNode = scene.backgroundNode;
//       const background = scene.background;

//       renderer.setViewport(view.left, view.bottom, view.width, view.height);
//       renderer.setScissor(view.left, view.bottom, view.width, view.height);
//       renderer.setScissorTest(true);

//       // renderer.alpha = true;
//       // renderer.setClearColor(0xffffff, 0.5);

//       scene.backgroundNode = null;
//       scene.background = null;

//       envBallCamera.aspect = view.width / view.height;
//       envBallCamera.updateProjectionMatrix();

//       renderer.renderAsync(scene, envBallCamera).then(() => {
//         renderer.setScissorTest(false);
//         scene.backgroundNode = backgroundNode;
//         scene.background = background;
//         // renderer.alpha = false;
//         // renderer.setClearColor(oldColor, 1);
//       });
//     },
//     undefined,
//     true
//   );
// };

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
  debugToolsState.env.ballRoughness = envBallRoughnessNode.value;
  debugToolsState.env.ballDefaultRoughness = envBallRoughnessNode.value;
  if (!debugCamera) return;
  const children = debugCamera.children[0].children;
  const envBallMesh = children.find(
    (child) => child.userData.id === ENV_MIRROR_BALL_MESH_ID
  ) as THREE.Mesh;
  if (!envBallMesh) return;
  envBallMesh.material = createMaterial({
    id: `${ENV_MIRROR_BALL_MESH_ID}-material`,
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
