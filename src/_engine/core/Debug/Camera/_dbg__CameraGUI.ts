import * as THREE from 'three/webgpu';
import { Pane, type ButtonApi } from 'tweakpane';
import { getECSWorld, ECSWorld, getEntityIdByAppId } from '../../ECS';
import { ComponentType } from '../../ECS/ECSCoreComponents';
import { CMP, getCmpById, TCMP } from '../../../utils/CMP';
import { getSvgIcon } from '../../UI/icons/SvgIcon';
import { createDebuggerTab, createNewDebuggerContainer } from '../../../debug/DebuggerGUI';
import {
  closeDraggableWindow,
  getDraggableWindow,
  openDraggableWindow,
  registerDraggableWindowContentFn,
  updateDraggableWindow,
} from '../../UI/DraggableWindow';
import { getCurrentSceneId } from '../../Scene';
import { lsGetItem, lsRemoveItem, lsSetItem } from '../../../utils/LocalAndSessionStorage';
import {
  confirmClearScope,
  createClearListLSButton,
  createClearTabLSButton,
} from '../_dbg__ClearLSButtons';
import {
  getActiveCameraId,
  getAllCamerasAsArray,
  CameraDebugLSData,
  DebugCamLSProps,
  applyCameraProjection,
} from '../../CameraManager';
import { getWindowSize } from '../../../utils/Window';
import { DEFAULT_DEBUG_CAM_PROPS } from './_dbg__DebugCamera';
import { updateOnScreenTools } from '../../../debug/OnScreenTools';

export interface CamEntityDebugState {
  helperVisible?: boolean;
  position?: { x: number; y: number; z: number };
  fov?: number;
  near?: number;
  far?: number;
  frustumSize?: number;
  responsiveAspect?: boolean;
  referenceAspect?: number;
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

  if (!objComp || !(objComp.value instanceof THREE.Camera) || !settings) return CMP();

  const camera = objComp.value as THREE.PerspectiveCamera | THREE.OrthographicCamera;
  const container = CMP({ onRemoveCmp: () => pane.dispose() });
  const pane = new Pane({ container: container.elem });

  const uiState = loadCameraDebugData(appId);

  // Re-enables the Clear local storage button as soon as any field writes new
  // LS data, since a single click earlier in this window's life should not
  // permanently disable it (`clearLSBtn` is assigned once the button below is
  // created; every earlier save just becomes a no-op until then).
  let clearLSBtn: ButtonApi | undefined = undefined;
  const save = <K extends keyof CamEntityDebugState>(key: K, value: CamEntityDebugState[K]) => {
    saveCameraToLS(entityId, key, value);
    if (clearLSBtn) clearLSBtn.disabled = false;
  };

  // Helper Toggle (Direct binding to the Three.js Helper object)
  const helperComp = world.getComponent(entityId, ComponentType.DEBUG_CAMERA_HELPER);
  if (helperComp) {
    const helperProxy = { visible: helperComp.value.visible };
    pane.addBinding(helperProxy, 'visible', { label: 'Show Helper' }).on('change', (e) => {
      const show = e.value;
      helperComp.value.visible = show;
      if (show) {
        const objComp = world.getComponent(entityId, ComponentType.OBJECT3D);
        if (objComp) objComp.value.updateMatrixWorld(true);
        helperComp.value.update();
      }
      save('helperVisible', show);
      updateOnScreenTools('SWITCH');
    });
  }

  // Symbol Toggle (Binding to the ECS userVisible flag)
  // const symbolComp = world.getComponent(entityId, ComponentType.DEBUG_SYMBOL);
  // if (symbolComp && lightChars.hasSymbol) {
  //   symbolComp.value.visible = prefs.symbol;
  //   pane.addBinding(symbolComp, 'userVisible', { label: 'Show Symbol' }).on('change', (e) => {
  //     const show = e.value;
  //     saveLightToLS(entityId, 'symbolVisible', show);
  //   });
  // }

  // Footer Info
  container.add({
    class: ['winNotRightPaddedContent', 'winFlexContent'],
    html: () => `<div>
      <div><span class="winSmallLabel">Ent. ID:</span> ${entityId}</div>
      <div><span class="winSmallLabel">App ID:</span> ${appId || 'None'}</div>
      <div><span class="winSmallLabel">Type:</span> ${settings.type}</div>
    </div>`,
  });
  container.add({
    class: ['winNotRightPaddedContent', 'winFlexContent'],
    html: () => `<div>
      <div><span class="winSmallLabel">Name:</span> ${debugData?.name || ''}</div>
    </div>`,
  });
  container.add({
    class: ['winNotRightPaddedContent', 'winFlexContent'],
    html: () => `<div>
      <div><span class="winSmallLabel">Description:</span> ${debugData?.description || ''}</div>
    </div>`,
  });

  // Position Sync
  if (transform) {
    pane.addBinding(transform, 'position', { label: 'Position' }).on('change', (ev) => {
      if (!ev.last) return;
      world.setTransform(entityId, { pos: transform.position });
      save('position', { ...transform.position });
    });
  }

  // Lens Settings
  const lensFolder = pane
    .addFolder({ title: 'Lens Settings', expanded: uiState?._lensSettingsOpen || false })
    .on('fold', (ev) => save('_lensSettingsOpen', ev.expanded));

  // Responsive aspect compensation (Hor+): keeps the horizontal FOV/world-width roughly
  // constant across aspect ratios, at the cost of the base fov/frustumSize (below) becoming
  // the "authored at referenceAspect" value rather than the literal live one.
  const responsiveProxy = {
    responsiveAspect: settings.responsiveAspect,
    referenceAspect: settings.referenceAspect,
  };
  lensFolder
    .addBinding(responsiveProxy, 'responsiveAspect', { label: 'Responsive Aspect' })
    .on('change', (ev) => {
      settings.responsiveAspect = ev.value;
      applyCameraProjection(camera, settings, getWindowSize().aspect);
      save('responsiveAspect', ev.value);
      // Without this one iteration timeout, Tweakpane will crash (maybe fix at one point)
      setTimeout(() => {
        updateCamerasDebuggerGUI('WINDOW'); // rebuild so the fov/frustumSize label reflects the new mode
      }, 0);
    });
  lensFolder
    .addBinding(responsiveProxy, 'referenceAspect', {
      label: 'Reference Aspect',
      min: 0.1,
      step: 0.01,
    })
    .on('change', (ev) => {
      settings.referenceAspect = ev.value;
      applyCameraProjection(camera, settings, getWindowSize().aspect);
      save('referenceAspect', ev.value);
    });

  if (settings.type === 'PERSPECTIVE') {
    lensFolder
      .addBinding(camera as THREE.PerspectiveCamera, 'fov', {
        min: 1,
        max: 170,
        step: 1,
        label: settings.responsiveAspect ? 'Fov (base, @ ref aspect)' : 'Fov',
      })
      .on('change', () => {
        const liveFov = (camera as THREE.PerspectiveCamera).fov;
        if (settings.responsiveAspect) {
          // The slider edits the authored base value; re-derive the live fov for the
          // current aspect immediately so the edit doesn't silently revert on next resize.
          settings.fov = liveFov;
          applyCameraProjection(camera, settings, getWindowSize().aspect);
        } else {
          camera.updateProjectionMatrix();
        }
        save('fov', settings.responsiveAspect ? settings.fov : liveFov);
      });
  } else {
    const frustumProxy = { frustumSize: settings.frustumSize };
    lensFolder
      .addBinding(frustumProxy, 'frustumSize', {
        min: 0.1,
        step: 0.1,
        label: settings.responsiveAspect ? 'Frustum Size (base, @ ref aspect)' : 'Frustum Size',
      })
      .on('change', (ev) => {
        settings.frustumSize = ev.value;
        applyCameraProjection(camera, settings, getWindowSize().aspect);
        save('frustumSize', settings.frustumSize);
      });
  }

  lensFolder.addBinding(camera, 'near', { min: 0.001, step: 0.01 }).on('change', () => {
    camera.updateProjectionMatrix();
    save('near', camera.near);
  });
  lensFolder.addBinding(camera, 'far', { min: 1, step: 1 }).on('change', () => {
    camera.updateProjectionMatrix();
    save('far', camera.far);
  });

  clearLSBtn = pane.addButton({
    title: 'Clear local storage',
    disabled: !loadCameraDebugData(appId),
  });
  clearLSBtn.on('click', () => {
    if (!appId) return;
    clearCameraFromLS(appId);
    clearLSBtn.disabled = true;
  });

  pane
    .addButton({
      title: 'Delete camera',
      disabled: getAllCamerasAsArray().length <= 1,
    })
    .on('click', () => {
      closeDraggableWindow(EDIT_CAMERA_WIN_ID);
      world.deleteEntity(entityId);
      // deleteEntity fires disposeCamera's onDeleteEntity hook (which already
      // refreshes this list) before clearing the entity's component storages,
      // so that refresh still sees the entity in TAG_IS_CAMERA. Refresh again
      // now that deletion has fully completed.
      updateCamerasDebuggerGUI('LIST');
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
          saveToLS: true,
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

const isDefaultDebugCamProps = (props: CamSceneDebugState['debugCam']) =>
  JSON.stringify(props) === JSON.stringify(DEFAULT_DEBUG_CAM_PROPS);

/** Scene entries always carry both `cams` and `debugCam` together; once neither
 * holds anything meaningful, drop the entry so `hasData` checks (which only look
 * at key/field presence) don't report stale data forever. */
const pruneEmptyCamScene = (data: CamDebugLSData, sceneId: string) => {
  const scene = data[sceneId];
  if (!scene) return;
  const camsEmpty = !scene.cams || Object.keys(scene.cams).length === 0;
  if (camsEmpty && isDefaultDebugCamProps(scene.debugCam)) delete data[sceneId];
};

const writeCamLSOrRemove = (data: CamDebugLSData) => {
  if (Object.keys(data).length === 0) lsRemoveItem(LS_KEY);
  else lsSetItem(LS_KEY, data);
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
      const clearTabBtn = createClearTabLSButton({
        hasData: () => {
          const current = lsGetItem(LS_KEY, {}) as CamDebugLSData;
          return Object.values(current).some((s) => !isDefaultDebugCamProps(s.debugCam));
        },
        onClear: () => {
          const current = lsGetItem(LS_KEY, {}) as CamDebugLSData;
          const sceneIdsWithData = Object.keys(current).filter(
            (id) => !isDefaultDebugCamProps(current[id].debugCam)
          );
          const applyClear = (sceneIds: string[]) => {
            for (const sceneId of sceneIds) {
              current[sceneId].debugCam = { ...DEFAULT_DEBUG_CAM_PROPS };
              pruneEmptyCamScene(current, sceneId);
            }
            writeCamLSOrRemove(current);
            clearTabBtn.update();
          };
          if (sceneIdsWithData.length > 1) {
            confirmClearScope({
              onClearAllScenes: () => applyClear(sceneIdsWithData),
              onClearThisScene: () => {
                const sceneId = getCurrentSceneId();
                if (sceneId) applyClear([sceneId]);
              },
            });
          } else {
            applyClear(sceneIdsWithData);
          }
        },
      });
      const clearListBtn = createClearListLSButton({
        hasData: () => {
          const current = lsGetItem(LS_KEY, {}) as CamDebugLSData;
          return Object.values(current).some((s) => s.cams && Object.keys(s.cams).length > 0);
        },
        onClear: () => {
          const current = lsGetItem(LS_KEY, {}) as CamDebugLSData;
          const sceneIdsWithData = Object.keys(current).filter(
            (id) => current[id].cams && Object.keys(current[id].cams).length > 0
          );
          const applyClear = (sceneIds: string[]) => {
            for (const sceneId of sceneIds) {
              current[sceneId].cams = {};
              pruneEmptyCamScene(current, sceneId);
            }
            writeCamLSOrRemove(current);
            clearListBtn.update();
          };
          if (sceneIdsWithData.length > 1) {
            confirmClearScope({
              onClearAllScenes: () => applyClear(sceneIdsWithData),
              onClearThisScene: () => {
                const sceneId = getCurrentSceneId();
                if (sceneId) applyClear([sceneId]);
              },
            });
          } else {
            applyClear(sceneIdsWithData);
          }
        },
      });
      const container = createNewDebuggerContainer('debuggerCams', `${icon} Camera Controls`, [
        clearTabBtn,
        clearListBtn,
      ]);
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

export const clearCameraFromLS = (appId: string) => {
  const sceneId = getCurrentSceneId();
  const currentData = lsGetItem(LS_KEY, {}) as CamDebugLSData;
  if (!sceneId || !currentData[sceneId]?.cams?.[appId]) return;
  delete currentData[sceneId].cams[appId];
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
