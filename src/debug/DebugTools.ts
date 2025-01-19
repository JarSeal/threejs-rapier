import * as THREE from 'three/webgpu';
import { ShaderNodeObject, uniform } from 'three/tsl';
import { OrbitControls } from 'three/examples/jsm/Addons.js';
import { createCamera, getAllCameras, getCurrentCameraId, setCurrentCamera } from '../core/Camera';
import { getRenderer } from '../core/Renderer';
import { lsGetItem, lsSetItem } from '../utils/LocalAndSessionStorage';
import { createNewDebuggerGUI, setDebuggerTabAndContainer } from './DebuggerGUI';
import { createMesh } from '../core/Mesh';
import { createGeometry } from '../core/Geometry';
import { createMaterial } from '../core/Material';
import { getCurrentScene } from '../core/Scene';
import { createGroup } from '../core/Group';

const LS_KEY = 'debugTools';
const ENV_MIRROR_BALL_MESH_ID = 'envMirrorBallMesh';
export const DEBUG_CAMERA_ID = '_debugCamera';
let envBallColorNode: ShaderNodeObject<THREE.PMREMNode> | null = null;
let envBallRoughnessNode: ShaderNodeObject<THREE.UniformNode<number>> = uniform(0);
let envRoughnessNode: ShaderNodeObject<THREE.UniformNode<number>> = uniform(0);
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
    envRoughness: number;
    ballRoughness: number;
    ballRoughnessIsTheSameAsEnvRoughness: boolean;
  };
} = {
  useDebugCamera: false,
  latestAppCameraId: null,
  camera: {
    fov: 25,
    near: 0.001,
    far: 1000,
    position: [0, 0, 10],
    target: [0, 0, 0],
  },
  env: {
    envRoughness: 0,
    ballRoughness: 0,
    ballRoughnessIsTheSameAsEnvRoughness: false,
  },
};

/**
 * Initializes the debug tools (only for debug environments).
 */
export const initDebugTools = () => {
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

  setDebuggerTabAndContainer({
    id: 'debugToolsControls',
    buttonText: 'TOOLS',
    title: 'Debug tools controls',
    orderNr: 6,
    container: () => {
      const { container, debugGui } = createNewDebuggerGUI('debugTools', 'Debug Tools Controls');
      debugGui
        .add(debugToolsState, 'useDebugCamera')
        .name('Use debug camera')
        .onChange((value: boolean) => {
          if (value) {
            setDebugToolsVisibility(true);
          } else {
            setDebugToolsVisibility(false);
          }
          lsSetItem(LS_KEY, debugToolsState);
        });
      const envFolder = debugGui.addFolder('Equirectangular sky box');
      envFolder
        .add(debugToolsState.env, 'envRoughness', 0, 1, 0.001)
        .name('Sky box roughness')
        .onChange((value: number) => {
          envRoughnessNode.value = value;
          lsSetItem(LS_KEY, debugToolsState);
        });
      envFolder
        .add(debugToolsState.env, 'ballRoughness', 0, 1, 0.001)
        .name('Debug ball roughness')
        .onChange((value: number) => {
          envBallRoughnessNode.value = value;
          lsSetItem(LS_KEY, debugToolsState);
        });
      // envFolder.add (debugToolsState.env, 'ballRoughnessIsTheSameAsEnvRoughness').name('Use same values');
      return container;
    },
  });
};

const createOnScreenTools = (debugCamera: THREE.PerspectiveCamera) => {
  const viewBoundsMin = new THREE.Vector2();
  const viewBoundsMax = new THREE.Vector2();
  debugCamera.getViewBounds(0.5, viewBoundsMin, viewBoundsMax);

  // Tool group
  const toolGroup = createGroup({ id: 'debugToolsGroup' });

  // Environment mirror ball
  const mesh = createMesh({
    id: ENV_MIRROR_BALL_MESH_ID,
    geo: createGeometry({
      id: 'envMirrorBallGeo',
      type: 'SPHERE',
      params: { radius: 0.007, widthSegments: 64, heightSegments: 64 },
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
  mesh.renderOrder = 999999;
  mesh.position.y += 0.008;
  mesh.position.x += 0.008;
  mesh.visible = Boolean(envBallColorNode);
  toolGroup.add(mesh);

  // Add toolgroup to mesh and debugCamera to scene
  debugCamera.add(toolGroup);
  toolGroup.position.set(viewBoundsMin.x + 0.002, viewBoundsMin.y + 0.002, -0.5);
  getCurrentScene().add(debugCamera);
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
 * @param colorNode
 * @param ballRough
 * @param envRough
 * @returns
 */
export const setDebugEnvBallMaterial = (
  colorNode?: ShaderNodeObject<THREE.PMREMNode>,
  ballRoughness?: ShaderNodeObject<THREE.UniformNode<number>>,
  envRoughness?: ShaderNodeObject<THREE.UniformNode<number>>
) => {
  envBallColorNode = colorNode || null;
  envBallRoughnessNode = ballRoughness !== undefined ? ballRoughness : uniform(0);
  envRoughnessNode = envRoughness !== undefined ? envRoughness : uniform(0);
  debugToolsState.env.ballRoughness = envBallRoughnessNode.value;
  debugToolsState.env.envRoughness = envRoughnessNode.value;
  // const savedDebugToolsState = lsGetItem(LS_KEY, debugToolsState);
  // savedDebugToolsState.env.ballRoughness = envBallRoughnessNode.value;
  // savedDebugToolsState.env.envRoughness = envRoughnessNode.value;
  // lsSetItem(LS_KEY, savedDebugToolsState);
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
