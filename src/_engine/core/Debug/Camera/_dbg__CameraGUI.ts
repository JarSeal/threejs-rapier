import * as THREE from 'three/webgpu';
import { Pane } from 'tweakpane';
import { getECSWorld, ECSWorld, getEntityIdByAppId } from '../../ECS';
import { ComponentType } from '../../ECS/ECSCoreComponents';
import { CMP, getCmpById, TCMP } from '../../../utils/CMP';
import { getSvgIcon } from '../../UI/icons/SvgIcon';
import { createDebuggerTab, createNewDebuggerContainer } from '../../../debug/DebuggerGUI';
import {
  getDraggableWindow,
  openDraggableWindow,
  registerDraggableWindowContentFn,
  updateDraggableWindow,
} from '../../UI/DraggableWindow';
import { getCurrentSceneId } from '../../Scene';
import { lsGetItem, lsSetItem } from '../../../utils/LocalAndSessionStorage';
import { getActiveCameraId, CameraDebugLSData, DebugCamLSProps } from '../../_CameraManager';
import { DEFAULT_DEBUG_CAM_PROPS } from './_dbg__DebugCamera';

export interface CamEntityDebugState {
  helperVisible?: boolean;
  position?: { x: number; y: number; z: number };
  fov?: number;
  near?: number;
  far?: number;
  _lensSettingsOpen?: boolean;
}

export interface CamSceneDebugState {
  cams: Record<string, CamEntityDebugState>;
  debugCam: {
    enabled: boolean;
    far: number;
    fov: number;
    latestAppCameraId: string | null;
    near: number;
    position: { x: number; y: number; z: number };
    target: { x: number; y: number; z: number };
    zoom: number;
  };
}

/** The structure of 'AEK_debugCams' in LocalStorage */
export interface CamDebugLSData {
  [sceneId: string]: CamSceneDebugState;
}

export const EDIT_CAMERA_WIN_ID = 'cameraEditorWindow';
export const LS_KEY = 'AEK_debugCams';
const DEBUGGER_CAMS_LIST_ID = 'debuggerCamerasList';
let debuggerListCmp: TCMP | null = null;

/** Content for the Edit Camera Draggable Window */
export const createEditCameraContent = (data?: { [key: string]: unknown }) => {
  const d = data as { id: string; winId: string };
  const world = getECSWorld();
  const entityId = getEntityIdByAppId(d.id);

  if (!entityId || !world.isAlive(entityId)) return CMP({ text: 'Camera not found' });

  const objComp = world.getComponent(entityId, ComponentType.OBJECT3D);
  const settings = world.getComponent(entityId, ComponentType.CAMERA_SETTINGS);
  const transform = world.getComponent(entityId, ComponentType.TRANSFORM);
  const appId = world.getComponent(entityId, ComponentType.APP_ID)?.id;
  const debugData = world.getComponent(entityId, ComponentType.DEBUG_DATA);

  if (!objComp || !settings) return CMP();

  const camera = objComp.value as THREE.PerspectiveCamera | THREE.OrthographicCamera;
  const container = CMP({ onRemoveCmp: () => pane.dispose() });
  const pane = new Pane({ container: container.elem });

  const uiState = loadCameraDebugData(appId);

  // Header
  container.add({
    class: ['winNotRightPaddedContent', 'winFlexContent'],
    html: () => `<div>
      <div><span class="winSmallLabel">AppID:</span> ${d.id}</div>
      <div><span class="winSmallLabel">Type:</span> ${settings.type}</div>
      <div><span class="winSmallLabel">Name:</span> ${debugData?.name || ''}</div>
    </div>`,
  });

  // Position Sync
  if (transform) {
    pane.addBinding(transform, 'position', { label: 'Position' }).on('change', (ev) => {
      if (!ev.last) return;
      world.setTransform(entityId, { pos: transform.position });
      saveCameraToLS(entityId, 'position', { ...transform.position });
    });
  }

  // Lens Settings
  const lensFolder = pane
    .addFolder({ title: 'Lens Settings', expanded: uiState?._lensSettingsOpen || false })
    .on('fold', (ev) => saveCameraToLS(entityId, '_lensSettingsOpen', ev.expanded));
  if (settings.type === 'PERSPECTIVE') {
    lensFolder
      .addBinding(camera as THREE.PerspectiveCamera, 'fov', { min: 1, max: 170, step: 1 })
      .on('change', () => {
        camera.updateProjectionMatrix();
        saveCameraToLS(entityId, 'fov', (camera as THREE.PerspectiveCamera).fov);
      });
  }

  lensFolder.addBinding(camera, 'near', { min: 0.001, step: 0.01 }).on('change', () => {
    camera.updateProjectionMatrix();
    saveCameraToLS(entityId, 'near', camera.near);
  });
  lensFolder.addBinding(camera, 'far', { min: 1, step: 1 }).on('change', () => {
    camera.updateProjectionMatrix();
    saveCameraToLS(entityId, 'far', camera.far);
  });

  if (d.id) updateDebuggerCamerasListSelectedClass(d.id);
  return container;
};

const createCameraList = (world: ECSWorld) => {
  const storage = world.getStorage(ComponentType.TAG_IS_CAMERA);
  let html = '<ul class="ulList">';

  for (const [entityId] of storage) {
    if (world.hasComponent(entityId, ComponentType.DEBUG_TAG_IS_DEBUG_CAMERA)) continue;

    const appId = world.getComponent(entityId, ComponentType.APP_ID)?.id;
    const appOrEntityId = appId || entityId;
    const debugData = world.getComponent(entityId, ComponentType.DEBUG_DATA);
    const activeId = getActiveCameraId();
    const isActiveCam = activeId === entityId;
    const isMainCam = world.getComponent(entityId, ComponentType.TAG_IS_MAIN_CAMERA);

    const button = CMP({
      onClick: () => {
        openDraggableWindow({
          id: EDIT_CAMERA_WIN_ID,
          title: `Edit Camera: ${appId}`,
          isDebugWindow: true,
          content: createEditCameraContent,
          data: { id: appId, winId: EDIT_CAMERA_WIN_ID },
          closeOnSceneChange: true,
          onClose: () => updateDebuggerCamerasListSelectedClass(null),
        });
      },
      html: `<button class="listItemWithId">
        <span class="itemId">[${appId}] [${entityId}]</span>${isActiveCam ? '* ' : ''}${isMainCam ? '<span>(Main)</span> ' : ''}
        <h4${!debugData?.name ? ` style="font-style:italic"` : ''}>${debugData?.name || `[${appOrEntityId}]`}</h4>
      </button>`,
    });
    html += `<li data-id="${appOrEntityId}">${button}</li>`;
  }
  return html + '</ul>';
};

let cameraDebuggerGUIInitiated = false;
export const initCameraDebuggerGUI = () => {
  if (cameraDebuggerGUIInitiated) return;
  const icon = getSvgIcon('camera');
  createDebuggerTab({
    id: 'camerasControls',
    buttonText: icon,
    title: 'Camera Controls',
    orderNr: 11,
    container: () => {
      const container = createNewDebuggerContainer('debuggerCams', `${icon} Camera Controls`);
      debuggerListCmp = CMP({
        id: DEBUGGER_CAMS_LIST_ID,
        html: () => createCameraList(getECSWorld()),
      });
      container.add(debuggerListCmp);
      return container;
    },
  });
  cameraDebuggerGUIInitiated = true;
};

export const updateCamerasDebuggerGUI = (only?: 'LIST' | 'WINDOW') => {
  if (only !== 'WINDOW') debuggerListCmp?.update();
  const winState = getDraggableWindow(EDIT_CAMERA_WIN_ID);
  if (only !== 'LIST' && winState?.isOpen) updateDraggableWindow(EDIT_CAMERA_WIN_ID);
};

export const updateDebuggerCamerasListSelectedClass = (id: string | null) => {
  const ulElem = getCmpById(DEBUGGER_CAMS_LIST_ID)?.elem;
  if (!ulElem) return;
  for (const child of ulElem.children) {
    child.classList.remove('selected');
    if (child.getAttribute('data-id') === id) child.classList.add('selected');
  }
};

export const getDebugCamProps = (sceneId: string) => {
  const saved = lsGetItem(LS_KEY, {}) as CameraDebugLSData;
  const keys = Object.keys(saved);
  if (!keys.includes(sceneId)) {
    saved[sceneId] = { debugCam: { ...DEFAULT_DEBUG_CAM_PROPS }, cams: {} };
  }
  return saved[sceneId].debugCam;
};

export const loadCameraDebugData = (appId?: string): CamEntityDebugState | undefined => {
  if (!appId) return;
  const currentData = lsGetItem(LS_KEY, {}) as CamDebugLSData;
  const sceneId = getCurrentSceneId();
  if (
    !sceneId ||
    !currentData ||
    !currentData[sceneId] ||
    !currentData[sceneId].cams ||
    !currentData[sceneId].cams[appId]
  ) {
    return;
  }
  return currentData[sceneId].cams[appId];
};

export const saveCameraToLS = <K extends keyof CamEntityDebugState>(
  entityId: number,
  key: K,
  value: CamEntityDebugState[K]
) => {
  const sceneId = getCurrentSceneId();
  const appIdComp = getECSWorld().getComponent(entityId, ComponentType.APP_ID);
  if (!sceneId || !appIdComp?.isFixed) return;
  const currentData = lsGetItem(LS_KEY, {}) as CamDebugLSData;
  if (!currentData[sceneId]) currentData[sceneId] = { cams: {}, debugCam: DEFAULT_DEBUG_CAM_PROPS };
  const appId = appIdComp.id;
  if (!currentData[sceneId].cams[appId]) {
    currentData[sceneId].cams[appId] = { helperVisible: false };
  }
  currentData[sceneId].cams[appId][key] = value;
  lsSetItem(LS_KEY, currentData);
};

export const saveDebugCameraToLS = (debugCamProps: Partial<DebugCamLSProps>) => {
  const sceneId = getCurrentSceneId();
  if (!sceneId) return;
  const currentData = lsGetItem(LS_KEY, {}) as CameraDebugLSData;
  if (!currentData[sceneId]) currentData[sceneId] = { cams: {}, debugCam: DEFAULT_DEBUG_CAM_PROPS };
  currentData[sceneId].debugCam = { ...currentData[sceneId].debugCam, ...debugCamProps };
  lsSetItem(LS_KEY, currentData);
};

registerDraggableWindowContentFn(EDIT_CAMERA_WIN_ID, createEditCameraContent);
