import * as THREE from 'three/webgpu';
import { getWindowSize } from '../utils/Window';
import { llog, lwarn } from '../utils/Logger';
import { DEBUG_CAMERA_ID, handleCameraSwitch, isUsingDebugCamera } from '../debug/DebugTools';
import { CMP, TCMP } from '../utils/CMP';
import { Pane } from 'tweakpane';
import {
  addOnCloseToWindow,
  closeDraggableWindow,
  getDraggableWindow,
  openDraggableWindow,
  updateDraggableWindow,
} from './UI/DraggableWindow';
import { getSvgIcon } from './UI/icons/SvgIcon';
import { createDebuggerTab, createNewDebuggerContainer } from '../debug/DebuggerGUI';
import { isDebugEnvironment } from './Config';
import { toggleCameraHelper } from './Helpers';
import { getRootScene } from './Scene';
import { lsGetItem, lsSetItem } from '../utils/LocalAndSessionStorage';
import { updateOnScreenTools } from '../debug/OnScreenTools';

const LS_KEY = 'debugCameras';
const cameras: { [id: string]: THREE.PerspectiveCamera } = {};
let currentCamera: THREE.PerspectiveCamera | null = null;
let currentCameraId: string | null = null;
let clearLSButton: TCMP | null = null;

/**
 * Creates a perspective camera.
 * @param id camera id
 * @param opts optional camera configuration options: { isCurrentCamera?: boolean; fov?: number; near?: number; far?: number }
 * @returns THREE.PerspectiveCamera
 */
export const createCamera = (
  // @TODO: add ortographic camera type and change this to createPerspectiveCamera
  id: string,
  // @TODO: change opts to params
  opts?: { name?: string; isCurrentCamera?: boolean; fov?: number; near?: number; far?: number }
) => {
  if (cameras[id]) {
    // Use the existing camera and set options
    const c = cameras[id];
    if (opts?.fov) c.fov = opts.fov;
    if (opts?.near) c.near = opts.near;
    if (opts?.far) c.far = opts.far;
    if (opts?.isCurrentCamera && !isUsingDebugCamera()) {
      setCurrentCamera(id);
    }
    mergeCameraDataFromLS(id);
    toggleCameraHelper(id, Boolean(c.userData.showHelper));
    c.updateProjectionMatrix();
    return c;
  }

  const fov = opts?.fov !== undefined ? opts.fov : 45;
  const near = opts?.near || 0.1;
  const far = opts?.far || 1000;

  const windowSize = getWindowSize();
  const camera = new THREE.PerspectiveCamera(fov, windowSize.aspect, near, far);

  cameras[id] = camera;
  camera.userData.id = id;
  camera.userData.type = 'PERSPECTIVE';
  if (opts?.name) camera.userData.name = opts.name;

  if (opts?.isCurrentCamera && !isUsingDebugCamera()) {
    setCurrentCamera(id);
  }

  const rootScene = getRootScene();
  if (rootScene) rootScene.add(camera);

  mergeCameraDataFromLS(id);
  toggleCameraHelper(id, Boolean(camera.userData.showHelper));
  camera.updateProjectionMatrix();

  return camera;
};

/**
 * Returns a camera with an id.
 * @param id camera id
 * @returns THREE.PerspectiveCamera or null
 */
export const getCamera = (id: string) => {
  const camera = cameras[id];
  if (!camera) lwarn(`Could not find camera with id "${id}" in getCamera(id).`);
  return camera || null;
};

/**
 * Deletes a camera with an id.
 * @param id camera id
 */
export const deleteCamera = (id: string) => {
  const camera = cameras[id];
  if (!camera) {
    lwarn(`Could not find camera with id "${id}" in deleteCamera(id).`);
    return;
  }

  delete cameras[id];
};

/**
 * Sets a new current camera to be used in scene.
 * @param id camera id
 * @returns THREE.PerspectiveCamera
 */
export const setCurrentCamera = (id: string, doNotHandleDebugCameraSwitch?: boolean) => {
  if (currentCameraId === id) return currentCamera;
  const nextCamera = id ? cameras[id] : null;
  if (!nextCamera) {
    lwarn(`Could not find camera with id "${id}" in setCurrentCamera(id).`);
    return currentCamera;
  }
  currentCameraId = id;
  currentCamera = nextCamera;

  if (isDebugEnvironment() && !doNotHandleDebugCameraSwitch) {
    handleCameraSwitch(nextCamera.userData.id, undefined, true);
  }

  return nextCamera;
};

/**
 * Return the current camera.
 * @returns THREE.PerspectiveCamera or null
 */
export const getCurrentCamera = () => currentCamera as THREE.PerspectiveCamera;

/**
 * Return the current camera id.
 * @returns string or null
 */
export const getCurrentCameraId = () => currentCameraId;

/**
 * Returns all cameras.
 * @returns object: { [id: string]: THREE.PerspectiveCamera }
 */
export const getAllCameras = () => cameras;

/**
 * Returns all cameras as an array.
 * @returns array of THREE.PerspectiveCamera
 */
export const getAllCamerasAsArray = () => {
  const keys = Object.keys(cameras);
  const camerasArr = [];
  for (let i = 0; i < keys.length; i++) {
    camerasArr.push(cameras[keys[i]]);
  }
  return camerasArr;
};

/**
 * Checks, with a camera id, whether a camera exists or not
 * @param id (string) camera id
 * @returns boolean
 */
export const doesCameraExist = (id: string) => Boolean(cameras[id]);

// Debugger stuff for cameras
// *************************

const getCameraTypeShorthand = (type: string) => {
  switch (type) {
    case 'PERSPECTIVE':
      return 'PC';
    case 'ORTOGRAPHIC':
      return 'OC';
    default:
      return '??';
  }
};

let debuggerListCmp: TCMP | null = null;
let debuggerWindowCmp: TCMP | null = null;
let debuggerWindowPane: Pane | null = null;
const WIN_ID = 'cameraEditorWindow';

export const createEditCameraContent = (data?: { [key: string]: unknown }) => {
  const d = data as { id: string; winId: string };
  const camera = cameras[d.id];
  if (debuggerWindowPane) {
    debuggerWindowPane.dispose();
    debuggerWindowPane = null;
  }
  if (debuggerWindowCmp) debuggerWindowCmp.remove();
  if (!camera) return CMP();

  addOnCloseToWindow(WIN_ID, () => {
    updateDebuggerCamerasListSelectedClass('');
  });
  updateDebuggerCamerasListSelectedClass(d.id);

  debuggerWindowCmp = CMP({
    onRemoveCmp: () => (debuggerWindowPane = null),
  });

  const type = camera.userData.type;
  if (!type) return debuggerWindowCmp;

  debuggerWindowPane = new Pane({ container: debuggerWindowCmp.elem });

  const isCurCam = camera.userData.id === getCurrentCameraId();
  const useCamBtnClasses = ['winSmallIconButton'];
  if (isCurCam) useCamBtnClasses.push('current');
  const useCameraButton = CMP({
    class: useCamBtnClasses,
    html: () =>
      `<button title="${isCurCam ? 'This is the current camera being used' : 'Switch to use this camera'}">${getSvgIcon('camera')}</button>`,
    attr: isCurCam ? { disabled: 'true' } : {},
    onClick: () => handleCameraSwitch(camera.userData.id),
  });
  const copyCodeButton = CMP({
    class: 'winSmallIconButton',
    html: () => `<button title="Copy camera creation script">${getSvgIcon('fileCode')}</button>`,
    onClick: () => {
      let paramsString = '';
      if (type === 'PERSPECTIVE') {
        paramsString = `{${camera.userData.name ? `\n    name: '${camera.userData.name}',` : ''}
    isCurrentCamera: false,
    fov: ${camera.fov},
    near: ${camera.near},
    far: ${camera.far},
  }`;
      } else if (type === 'ORTOGRAPHIC') {
        // @TODO: add ortographic camera paramsString
        paramsString = `{}`;
      }
      const createScript = `createCamera(
  '${camera.userData.id}',
  ${paramsString}
);`;
      llog(createScript);
      navigator.clipboard.writeText(createScript);
      // @TODO: add toast that the script has been copied
    },
  });
  const logButton = CMP({
    class: 'winSmallIconButton',
    html: () =>
      `<button title="Console.log / print this camera to browser console">${getSvgIcon('fileAsterix')}</button>`,
    onClick: () => {
      llog('CAMERA:***************', camera, '**********************');
    },
  });
  const cameraState = lsGetItem(LS_KEY, {})[camera.userData.id];
  const lsIsEmpty =
    !cameraState ||
    (cameraState && Object.keys(cameraState).length === 1 && cameraState.saveToLS === false);
  clearLSButton = CMP({
    class: 'winSmallIconButton',
    html: () =>
      `<button title="Clear Local Storage params for this light">${getSvgIcon('databaseX')}</button>`,
    attr: lsIsEmpty ? { disabled: 'true' } : {},
    onClick: () => {
      const state = lsGetItem(LS_KEY, {});
      delete state[camera.userData.id];
      lsSetItem(LS_KEY, state);
      updateCamerasDebuggerGUI('WINDOW');
      // @TODO: add toast to tell that the Local Storage has been cleared for this light
    },
  });
  const deleteButton = CMP({
    class: ['winSmallIconButton', 'dangerColor'],
    html: () =>
      `<button title="Remove camera (only for this browser load, does not delete camera permanently)">${getSvgIcon('thrash')}</button>`,
    onClick: () => {
      deleteCamera(d.id);
      updateCamerasDebuggerGUI('LIST');
      closeDraggableWindow(WIN_ID);
    },
  });

  debuggerWindowCmp.add({
    prepend: true,
    class: ['winNotRightPaddedContent', 'winFlexContent'],
    html: () => `<div>
<div>
  <div><span class="winSmallLabel">Type:</span> ${camera.userData.type || ''} (${getCameraTypeShorthand(camera.userData.type)})</div>
  <div><span class="winSmallLabel">Name:</span> ${camera.userData.name || ''}</div>
  <div><span class="winSmallLabel">Id:</span> ${camera.userData.id}</div>
</div>
<div style="text-align:right">${useCameraButton}${copyCodeButton}${logButton}${clearLSButton}${deleteButton}</div>
</div>`,
  });

  // Shared bindings
  if (camera.userData.id) {
    if (camera.userData.saveToLS === undefined) camera.userData.saveToLS = false;
    debuggerWindowPane
      .addBinding(camera.userData, 'saveToLS', { label: 'Save to LS' })
      .on('change', (e) => {
        camera.userData.saveToLS = e.value;
        saveCameraToLS(camera.userData.id);
      });
    debuggerWindowPane.addBlade({ view: 'separator' });
  }

  if (camera.userData.showHelper === undefined) camera.userData.showHelper = false;
  debuggerWindowPane
    .addBinding(camera.userData, 'showHelper', { label: 'Show helper' })
    .on('change', (e) => {
      toggleCameraHelper(camera.userData.id, e.value);
      saveCameraToLS(camera.userData.id);
    });
  debuggerWindowPane.addBinding(camera, 'position', { label: 'Position' }).on('change', () => {
    camera.updateProjectionMatrix();
    saveCameraToLS(camera.userData.id);
  });

  if (type === 'PERSPECTIVE') {
    const c = camera as THREE.PerspectiveCamera;
    debuggerWindowPane
      .addBinding(c, 'fov', { label: 'Field of view (FOV)', step: 1, min: 1, max: 180 })
      .on('change', () => {
        c.updateProjectionMatrix();
        saveCameraToLS(c.userData.id);
      });
    debuggerWindowPane.addBinding(c, 'near', { label: 'Camera near' }).on('change', () => {
      c.updateProjectionMatrix();
      saveCameraToLS(c.userData.id);
    });
    debuggerWindowPane.addBinding(c, 'far', { label: 'Camera far' }).on('change', () => {
      c.updateProjectionMatrix();
      saveCameraToLS(c.userData.id);
    });
    return debuggerWindowCmp;
  }

  if (type === 'ORTOGRAPHIC') {
    // const c = camera as THREE.OrtographicCamera;
    // @TODO: add ortographic camera fields
    return debuggerWindowCmp;
  }

  return debuggerWindowCmp;
};

const createCameraDebuggerList = () => {
  const keys = Object.keys(cameras);
  let html = '<ul class="ulList">';

  for (let i = 0; i < keys.length; i++) {
    const camera = cameras[keys[i]];
    // Do not show the debug camera on the list
    if (camera.userData.id === DEBUG_CAMERA_ID) continue;

    const button = CMP({
      onClick: () => {
        const winState = getDraggableWindow(WIN_ID);
        if (winState?.isOpen && winState?.data?.id === keys[i]) {
          closeDraggableWindow(WIN_ID);
          return;
        }
        openDraggableWindow({
          id: WIN_ID,
          position: { x: 110, y: 60 },
          size: { w: 400, h: 400 },
          saveToLS: true,
          title: `Edit camera: ${camera.userData.name || `[${camera.userData.id}]`}`,
          isDebugWindow: true,
          content: createEditCameraContent,
          data: { id: camera.userData.id, WIN_ID },
          closeOnSceneChange: true,
        });
        updateDebuggerCamerasListSelectedClass(keys[i]);
      },
      html: `<button class="listItemWithId">
  <span class="itemId">[${camera.userData.id}]</span>
  <span title="${camera.userData.type}">${getCameraTypeShorthand(camera.userData.type)}</span>
  <h4>${camera.userData.name || `[${camera.userData.id}]`}</h4>
</button>`,
    });

    html += `<li data-id="${keys[i]}">${button}</li>`;
  }

  if (!keys.length) html += `<li class="emptyState">No cameras registered..</li>`;

  html += '</ul>';
  return html;
};

export const createCamerasDebuggerGUI = () => {
  const icon = getSvgIcon('camera');
  createDebuggerTab({
    id: 'camerasControls',
    buttonText: icon,
    title: 'Camera controls',
    orderNr: 11,
    container: () => {
      const container = createNewDebuggerContainer('debuggerCameras', `${icon} Camera Controls`);
      debuggerListCmp = CMP({ id: 'debuggerCamerasList', html: createCameraDebuggerList });
      container.add(debuggerListCmp);
      const winState = getDraggableWindow(WIN_ID);
      if (winState?.isOpen && winState.data?.id) {
        const id = (winState.data as { id: string }).id;
        updateDebuggerCamerasListSelectedClass(id);
      }
      return container;
    },
  });
};

export const updateCamerasDebuggerGUI = (only?: 'LIST' | 'WINDOW') => {
  if (!isDebugEnvironment()) return;
  if (only !== 'WINDOW') debuggerListCmp?.update({ html: createCameraDebuggerList });
  if (only === 'LIST') return;
  const winState = getDraggableWindow(WIN_ID);
  if (winState) updateDraggableWindow(WIN_ID);
};

export const updateDebuggerCamerasListSelectedClass = (id: string) => {
  const ulElem = debuggerListCmp?.elem;
  if (!ulElem) return;

  for (const child of ulElem.children) {
    const elemId = child.getAttribute('data-id');
    if (elemId === id) {
      child.classList.add('selected');
      continue;
    }
    child.classList.remove('selected');
  }
};

export const mergeCameraDataFromLS = (id: string | undefined) => {
  if (!isDebugEnvironment() || !id) return;

  const curState = lsGetItem(LS_KEY, {});
  if (!id || !curState[id]) return;

  const state = curState[id];
  const camera = cameras[id];

  if (state.saveToLS !== undefined) camera.userData.saveToLS = state.saveToLS;
  if (state.showHelper !== undefined) camera.userData.showHelper = state.showHelper;
  if (state.position) camera.position.set(state.position.x, state.position.y, state.position.z);
  if (state.cameraNear !== undefined) camera.near = state.cameraNear;
  if (state.cameraFar !== undefined) camera.far = state.cameraFar;
};

export const saveCameraToLS = (id: string | undefined) => {
  if (!isDebugEnvironment || !id) return;

  const camera = getCamera(id);
  if (!camera?.userData.id) return;

  const curState = lsGetItem(LS_KEY, {});
  if (!curState[id]) {
    if (!camera?.userData.saveToLS) return;
    curState[id] = {};
  }

  curState[id].saveToLS = camera.userData.saveToLS;
  curState[id].showHelper = camera.userData.showHelper;
  curState[id].position = { x: camera.position.x, y: camera.position.y, z: camera.position.z };
  curState[id].fov = camera.userData.fov;
  curState[id].cameraNear = camera.near;
  curState[id].cameraFar = camera.far;

  lsSetItem(LS_KEY, curState);
  clearLSButton?.removeAttr('disabled');
};
