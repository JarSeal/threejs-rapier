import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/examples/jsm/Addons.js';
import { createCamera, getCurrentCameraId, setCurrentCamera } from '../core/Camera';
import { getRenderer } from '../core/Renderer';
import { lsGetItem, lsSetItem } from '../utils/LocalAndSessionStorage';
import { createNewDebuggerGUI, setDebuggerTabAndContainer } from './DebuggerGUI';
import { createMesh } from '../core/Mesh';
import { createGeometry } from '../core/Geometry';
import { createMaterial } from '../core/Material';
import { getCurrentScene } from '../core/Scene';
import { createGroup } from '../core/Group';

const LS_KEY = 'debugTools';
export const DEBUG_CAMERA_ID = '_debugCamera';
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
    rotation: number[];
    target: number[];
  };
} = {
  useDebugCamera: false,
  latestAppCameraId: null,
  camera: {
    fov: 45,
    near: 0.001,
    far: 1000,
    position: [0, 0, 10],
    rotation: [0, 0, 0],
    target: [0, 0, 0],
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
  debugCamera.position.z = 10;

  createOnScreenTools(debugCamera);

  const renderer = getRenderer();
  if (!renderer) throw new Error('Renderer not found in createDebugToolsDebugGUI');
  orbitControls = new OrbitControls(debugCamera, renderer.domElement);
  orbitControls.addEventListener('end', () => {
    console.log('CHANGE HAPPENED');
    // @TODO: save position, rotation, and target to the debugToolsState and to LS
  });
  // controls.update();
  // controls.connect();
  // controls.enabled = true;
  // controls.update();

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
            debugToolsState.latestAppCameraId = getCurrentCameraId();
            setCurrentCamera(DEBUG_CAMERA_ID);
          } else if (debugToolsState.latestAppCameraId) {
            setCurrentCamera(debugToolsState.latestAppCameraId);
          }
          lsSetItem(LS_KEY, debugToolsState);
        });
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
    id: 'envMirrorBallMesh',
    geo: createGeometry({
      id: 'envMirrorBallGeo',
      type: 'SPHERE',
      params: { radius: 0.007, widthSegments: 64, heightSegments: 64 },
    }),
    mat: createMaterial({
      id: 'envMirrorBallMat',
      type: 'BASICNODEMATERIAL',
      params: { depthTest: false },
    }),
  });
  mesh.renderOrder = 9999;
  mesh.position.y += 0.009;
  mesh.position.x += 0.009;
  toolGroup.add(mesh);

  // Add toolgroup to mesh and debugCamera to scene
  debugCamera.add(toolGroup);
  toolGroup.position.set(viewBoundsMin.x + 0.01, viewBoundsMin.y + 0.01, -0.5);
  getCurrentScene().add(debugCamera);
};
