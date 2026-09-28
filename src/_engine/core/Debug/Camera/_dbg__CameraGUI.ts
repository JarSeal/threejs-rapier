import * as THREE from 'three/webgpu';
import { Pane, type ButtonApi } from 'tweakpane';
import { getECSWorld, ECSWorld, getEntityIdByAppId, getStableAppId } from '../../ECS';
import { ComponentType } from '../../ECS/ECSCoreComponents';
import { CMP } from '../../../utils/CMP';
import {
  createDebuggerTab,
  debuggerListCMP,
  updateDebuggerTab,
  type DebuggerListItem,
} from '../../../debug/DebuggerGUI';
import {
  addOnCloseToWindow,
  closeDraggableWindow,
  getDraggableWindow,
  openDraggableWindow,
  registerDraggableWindowContentFn,
  registerDraggableWindowSceneTargetResolver,
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
import { lwarn } from '../../../utils/Logger';
import {
  _recordOrCoalesceUndoRedoAction,
  _recordUndoRedoAction,
  _registerUndoRedoActionHandler,
} from '../_dbg__UndoRedo';

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
const CAMERAS_TAB_ID = 'camerasControls';

// Undo/redo

/** Edit window fields recorded to the (per-scene) undo/redo history. */
const UNDOABLE_CAM_KEYS = [
  'position',
  'responsiveAspect',
  'referenceAspect',
  'fov',
  'frustumSize',
  'near',
  'far',
] as const;
type UndoableCamKey = (typeof UNDOABLE_CAM_KEYS)[number];
type UndoableCamValues = { [K in UndoableCamKey]: NonNullable<CamEntityDebugState[K]> };
type CamUndoPayload<K extends UndoableCamKey> = {
  appId: string;
  prev: UndoableCamValues[K];
  next: UndoableCamValues[K];
};

const UNDOABLE_CAM_LABELS: Record<UndoableCamKey, string> = {
  position: 'position',
  responsiveAspect: 'responsive aspect',
  referenceAspect: 'reference aspect',
  fov: 'fov',
  frustumSize: 'frustum size',
  near: 'near',
  far: 'far',
};

/** Continuous (slider) fields: a drag is merged into one history entry. */
const COALESCED_CAM_KEYS: ReadonlySet<UndoableCamKey> = new Set([
  'referenceAspect',
  'fov',
  'frustumSize',
  'near',
  'far',
]);

/** Finds the camera by app id at undo/redo time (never a captured reference). */
const resolveCamera = (appId: string) => {
  const world = getECSWorld();
  const entityId = getEntityIdByAppId(appId, world);
  const camera =
    entityId !== undefined ? world.getComponent(entityId, ComponentType.OBJECT3D)?.value : null;
  const settings =
    entityId !== undefined ? world.getComponent(entityId, ComponentType.CAMERA_SETTINGS) : null;
  if (entityId === undefined || !(camera instanceof THREE.Camera) || !settings) {
    lwarn(`Undo/redo: camera "${appId}" no longer exists, skipping.`);
    return null;
  }
  return {
    world,
    entityId,
    camera: camera as THREE.PerspectiveCamera | THREE.OrthographicCamera,
    settings,
  };
};

type ResolvedCamera = NonNullable<ReturnType<typeof resolveCamera>>;

/** Applies a value the same way the edit window's own control does. */
const applyCamField: {
  [K in UndoableCamKey]: (cam: ResolvedCamera, value: UndoableCamValues[K]) => void;
} = {
  position: ({ world, entityId }, value) => world.setTransform(entityId, { pos: value }),
  responsiveAspect: ({ camera, settings }, value) => {
    settings.responsiveAspect = value;
    applyCameraProjection(camera, settings, getWindowSize().aspect);
  },
  referenceAspect: ({ camera, settings }, value) => {
    settings.referenceAspect = value;
    applyCameraProjection(camera, settings, getWindowSize().aspect);
  },
  // Goes through settings.fov in both modes: applyCameraProjection derives the live fov from it.
  fov: ({ camera, settings }, value) => {
    settings.fov = value;
    applyCameraProjection(camera, settings, getWindowSize().aspect);
  },
  frustumSize: ({ camera, settings }, value) => {
    settings.frustumSize = value;
    applyCameraProjection(camera, settings, getWindowSize().aspect);
  },
  near: ({ camera }, value) => {
    camera.near = value;
    camera.updateProjectionMatrix();
  },
  far: ({ camera }, value) => {
    camera.far = value;
    camera.updateProjectionMatrix();
  },
};

const setCamField = <K extends UndoableCamKey>(
  key: K,
  appId: string,
  value: UndoableCamValues[K]
) => {
  const cam = resolveCamera(appId);
  if (!cam) return;
  applyCamField[key](cam, value);
  saveCameraToLS(cam.entityId, key, value);
  updateCamerasDebuggerGUI('WINDOW');
};

const registerCamUndoHandler = <K extends UndoableCamKey>(key: K) => {
  _registerUndoRedoActionHandler<CamUndoPayload<K>>(`camera.${key}`, {
    undo: ({ appId, prev }) => setCamField(key, appId, prev),
    redo: ({ appId, next }) => setCamField(key, appId, next),
  });
};
for (const key of UNDOABLE_CAM_KEYS) registerCamUndoHandler(key);

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

  // Tweakpane has already written the new value when 'change' fires, so the previous value
  // of each recorded field is kept here. Generated app ids can't be found again after a
  // reload, so only cameras with a stable app id are recorded.
  const stableAppId = getStableAppId(entityId, world);
  const committed: UndoableCamValues = {
    position: {
      x: transform?.position.x ?? 0,
      y: transform?.position.y ?? 0,
      z: transform?.position.z ?? 0,
    },
    responsiveAspect: settings.responsiveAspect,
    referenceAspect: settings.referenceAspect,
    fov: settings.fov,
    frustumSize: settings.frustumSize,
    near: camera.near,
    far: camera.far,
  };
  const record = <K extends UndoableCamKey>(key: K, next: UndoableCamValues[K]) => {
    const prev = committed[key];
    committed[key] = next;
    if (!stableAppId || JSON.stringify(prev) === JSON.stringify(next)) return;
    const actionType = `camera.${key}`;
    const label = `Camera ${stableAppId}: ${UNDOABLE_CAM_LABELS[key]}`;
    const payload: CamUndoPayload<K> = { appId: stableAppId, prev, next };
    if (COALESCED_CAM_KEYS.has(key)) {
      _recordOrCoalesceUndoRedoAction(actionType, label, payload, `${stableAppId}.${key}`);
    } else {
      _recordUndoRedoAction(actionType, label, payload);
    }
  };

  // Helper Toggle (Direct binding to the Three.js Helper object)
  const helperComp = world.getComponent(entityId, ComponentType.DEBUG_CAMERA_HELPER);
  if (helperComp) {
    const helperProxy = { visible: helperComp.value.visible };
    pane.addBinding(helperProxy, 'visible', { label: 'Show Helper' }).on('change', (e) => {
      setCameraHelperVisible(entityId, world, e.value);
      if (clearLSBtn) clearLSBtn.disabled = false;
      updateDebuggerTab(CAMERAS_TAB_ID);
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
      const position = {
        x: transform.position.x,
        y: transform.position.y,
        z: transform.position.z,
      };
      save('position', position);
      record('position', position);
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
      record('responsiveAspect', ev.value);
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
      record('referenceAspect', ev.value);
    });

  if (settings.type === 'PERSPECTIVE') {
    // The slider edits the authored settings.fov (the base value at the reference aspect in
    // responsive mode), not the live camera.fov: applyCameraProjection derives the live fov
    // from settings.fov, so a direct camera.fov edit would revert on the next resize.
    const fovProxy = { fov: settings.fov };
    lensFolder
      .addBinding(fovProxy, 'fov', {
        min: 1,
        max: 170,
        step: 1,
        label: settings.responsiveAspect ? 'Fov (base, @ ref aspect)' : 'Fov',
      })
      .on('change', (ev) => {
        settings.fov = ev.value;
        applyCameraProjection(camera, settings, getWindowSize().aspect);
        save('fov', settings.fov);
        record('fov', settings.fov);
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
        record('frustumSize', settings.frustumSize);
      });
  }

  lensFolder.addBinding(camera, 'near', { min: 0.001, step: 0.01 }).on('change', () => {
    camera.updateProjectionMatrix();
    save('near', camera.near);
    record('near', camera.near);
  });
  lensFolder.addBinding(camera, 'far', { min: 1, step: 1 }).on('change', () => {
    camera.updateProjectionMatrix();
    save('far', camera.far);
    record('far', camera.far);
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

  // The content is built before the window state is open: refresh the list selection after it.
  // The onClose is set here too, because a window restored from LS has none.
  queueMicrotask(() => {
    addOnCloseToWindow(EDIT_CAMERA_WIN_ID, () => updateDebuggerTab(CAMERAS_TAB_ID));
    updateDebuggerTab(CAMERAS_TAB_ID);
  });
  return container;
};

/** Sets a camera's helper visibility and its saved preference (edit window and list toggle). */
const setCameraHelperVisible = (entityId: number, world: ECSWorld, show: boolean) => {
  const helperComp = world.getComponent(entityId, ComponentType.DEBUG_CAMERA_HELPER);
  if (!helperComp) return;
  helperComp.value.visible = show;
  if (show) {
    const objComp = world.getComponent(entityId, ComponentType.OBJECT3D);
    if (objComp) objComp.value.updateMatrixWorld(true);
    helperComp.value.update();
  }
  saveCameraToLS(entityId, 'helperVisible', show);
  updateOnScreenTools('SWITCH');
};

/** Finds a list row's camera (the row id is the app id, or the entity id without one). */
const resolveCameraListItem = (itemId: string) => {
  const world = getECSWorld();
  const entityId =
    getEntityIdByAppId(itemId, world) ?? (/^\d+$/.test(itemId) ? Number(itemId) : undefined);
  return entityId !== undefined && world.isAlive(entityId) ? { world, entityId } : null;
};

const openEditCameraWindow = (itemId: string) => {
  const target = resolveCameraListItem(itemId);
  const appId = target ? target.world.getComponent(target.entityId, ComponentType.APP_ID)?.id : '';
  openDraggableWindow({
    id: EDIT_CAMERA_WIN_ID,
    title: `Edit Camera: ${appId}`,
    isDebugWindow: true,
    content: createEditCameraContent,
    data: { id: appId, winId: EDIT_CAMERA_WIN_ID },
    closeOnSceneChange: true,
    saveToLS: true,
    onClose: () => updateDebuggerTab(CAMERAS_TAB_ID),
  });
};

/** List toggle: the same path as the edit window's Show Helper input. */
const toggleCameraHelper = (itemId: string, next: boolean) => {
  const target = resolveCameraListItem(itemId);
  if (!target) return;
  setCameraHelperVisible(target.entityId, target.world, next);
  updateCamerasDebuggerGUI('WINDOW');
};

const getCamerasListData = (world: ECSWorld): DebuggerListItem[] => {
  const storage = world.getStorage(ComponentType.TAG_IS_CAMERA);
  const activeId = getActiveCameraId();
  const items: DebuggerListItem[] = [];
  for (const [entityId] of storage) {
    if (world.hasComponent(entityId, ComponentType.DEBUG_TAG_IS_DEBUG_CAMERA)) continue;

    const appId = world.getComponent(entityId, ComponentType.APP_ID)?.id;
    const debugData = world.getComponent(entityId, ComponentType.DEBUG_DATA);
    const isMainCam = world.getComponent(entityId, ComponentType.TAG_IS_MAIN_CAMERA);
    const helperComp = world.getComponent(entityId, ComponentType.DEBUG_CAMERA_HELPER);
    const itemId = appId || String(entityId);
    const badge = [activeId === entityId ? '*' : '', isMainCam ? '(Main)' : '']
      .filter(Boolean)
      .join(' ');
    items.push({
      itemId,
      title: debugData?.name || `[${itemId}]`,
      titlePlaceholder: !debugData?.name,
      subTitle: `[${appId}] [${entityId}]`,
      ...(badge ? { badge } : {}),
      toggleValues: [helperComp ? helperComp.value.visible : null],
    });
  }
  return items;
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
  createDebuggerTab({
    id: CAMERAS_TAB_ID,
    title: 'Camera Controls',
    icon: 'camera',
    // The tab's LS data is scene-scoped (module-owned), so both clear buttons are custom
    clearLSButton: false,
    headerButtons: () => {
      const clearTabBtn = createClearTabLSButton({
        hasData: () => {
          const current = lsGetItem(LS_KEY, {}) as CamDebugLSData;
          return Object.values(current).some((s) => !isDefaultDebugCamProps(s.debugCam));
        },
        watchKey: LS_KEY,
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
        watchKey: LS_KEY,
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
      return [clearTabBtn, clearListBtn];
    },
    content: () => [
      debuggerListCMP({
        id: 'cameras',
        data: () => getCamerasListData(getECSWorld()),
        selectedItemId: () => {
          const winState = getDraggableWindow(EDIT_CAMERA_WIN_ID);
          return winState?.isOpen ? (winState.data?.id as string | undefined) : null;
        },
        perItemConfig: {
          onClick: openEditCameraWindow,
          toggles: [{ icon: 'cameraReels', title: 'Show helper', fn: toggleCameraHelper }],
        },
      }),
    ],
  });
  cameraDebuggerGUIInitiated = true;
};

export const updateCamerasDebuggerGUI = (only?: 'LIST' | 'WINDOW') => {
  if (only !== 'WINDOW') updateDebuggerTab(CAMERAS_TAB_ID);
  const winState = getDraggableWindow(EDIT_CAMERA_WIN_ID);
  if (only !== 'LIST' && winState?.isOpen) updateDraggableWindow(EDIT_CAMERA_WIN_ID);
};

export const getDebugCamProps = (sceneId: string) => {
  const saved = lsGetItem(LS_KEY, {}) as CameraDebugLSData;
  const keys = Object.keys(saved);
  if (!keys.includes(sceneId)) {
    saved[sceneId] = { debugCam: { ...DEFAULT_DEBUG_CAM_PROPS }, cams: {} };
  }
  return saved[sceneId].debugCam;
};

/**
 * Returns a camera's saved debugger state.
 * @param appId (string) the camera's app id
 * @param sceneId (string) scene whose data to read, defaults to the current scene
 */
export const loadCameraDebugData = (
  appId?: string,
  sceneId: string | null = getCurrentSceneId()
): CamEntityDebugState | undefined => {
  if (!appId) return;
  const currentData = lsGetItem(LS_KEY, {}) as CamDebugLSData;
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
// Kept open on a scene change when the next scene has a camera with the same appId
registerDraggableWindowSceneTargetResolver(EDIT_CAMERA_WIN_ID, (data) => {
  const entityId = getEntityIdByAppId(String(data?.id));
  return Boolean(entityId && getECSWorld().isAlive(entityId));
});
