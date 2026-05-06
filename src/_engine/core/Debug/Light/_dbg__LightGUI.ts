import * as THREE from 'three/webgpu';
import { Pane } from 'tweakpane';
import { getECSWorld, ECSWorld, getEntityIdByAppId } from '../../ECS';
import { ComponentType } from '../../ECS/ECSCoreComponents';
import { CMP, TCMP } from '../../../utils/CMP';
import { getSvgIcon } from '../../UI/icons/SvgIcon';
import { createDebuggerTab, createNewDebuggerContainer } from '../../../debug/DebuggerGUI';
import {
  getDraggableWindow,
  openDraggableWindow,
  registerDraggableWindowCmp,
  updateDraggableWindow,
} from '../../UI/DraggableWindow';
import { setTransform } from '../../../utils/ECSHelpers';
import { setLightEnabled } from '../../_LightManager';
import { getCurrentSceneId } from '../../Scene';
import { lsGetItem, lsSetItem } from '../../../utils/LocalAndSessionStorage';
import { getActiveCameraId } from '../../_CameraManager';

export interface LightEntityDebugState {
  helperVisible: boolean;
  symbolVisible: boolean;
  intensity?: number;
  color?: number;
}

export interface LightSceneDebugState {
  globalHelpersVisible: boolean;
  /** Map of fixed appId to light-specific debug state */
  lights: Record<string, LightEntityDebugState>;
}

/** The structure of 'AEK_debugLights' in LocalStorage */
export interface LightDebugLSData {
  [sceneId: string]: LightSceneDebugState;
}

export const EDIT_LIGHT_WIN_ID = 'lightEditorWindow';
const LS_LIGHTS_KEY = 'AEK_debugLights';
export let globalHelpersVisible = false;
let debuggerListCmp: TCMP | null = null;
let initLoadDone = false;

const reconcileDebugVisuals = (
  entityId: number,
  world: ECSWorld,
  dataOverride?: LightDebugLSData
) => {
  const isEnabled = !world.isDisabled(entityId);
  const isCurrentActiveCam = entityId === getActiveCameraId();

  const { helper: helperPref, symbol: symbolPref } = getLightDebugVisibilityPref(
    entityId,
    world,
    dataOverride
  );

  const helperComp = world.getComponent(entityId, ComponentType.DEBUG_LIGHT_HELPER);
  if (helperComp) {
    helperComp.value.visible = isEnabled && helperPref;
  }

  const symbolComp = world.getComponent(entityId, ComponentType.DEBUG_SYMBOL);
  if (symbolComp) {
    // Keep the internal component flag in sync with the preference
    symbolComp.userVisible = symbolPref;
    symbolComp.value.visible = isEnabled && symbolPref && !isCurrentActiveCam;
  }

  if (!initLoadDone) {
    const appId = world.getComponent(entityId, ComponentType.APP_ID)?.id;
    if (!appId) return;
    const data = getDraggableWindow(EDIT_LIGHT_WIN_ID)?.data;
    if (data && data?.id === appId) {
      console.log('DATA', data);
      registerDraggableWindowCmp(EDIT_LIGHT_WIN_ID, {
        content: () => createEditLightContent(data),
      });
      initLoadDone = true;
    }
  }
};

export const getLightDebugVisibilityPref = (
  entityId: number,
  world: ECSWorld,
  dataOverride?: LightDebugLSData
) => {
  const sceneId = getCurrentSceneId();
  const appId = world.getComponent(entityId, ComponentType.APP_ID)?.id;
  if (!sceneId || !appId) return { helper: globalHelpersVisible, symbol: globalHelpersVisible };

  const data = dataOverride || (lsGetItem(LS_LIGHTS_KEY, {}) as LightDebugLSData);
  const saved = data[sceneId]?.lights?.[appId];

  if (!saved) {
    return {
      helper: globalHelpersVisible,
      symbol: true,
    };
  }

  return {
    helper: Boolean(saved.helperVisible),
    symbol: saved.symbolVisible !== undefined ? Boolean(saved.symbolVisible) : true,
  };
};

export const setLightDebugPreference = async (
  entityId: number,
  world: ECSWorld,
  key: 'helperVisible' | 'symbolVisible',
  value: boolean
) => {
  const sceneId = getCurrentSceneId();
  const appId = world.getComponent(entityId, ComponentType.APP_ID)?.id;
  if (!sceneId || !appId) return;

  const data = lsGetItem('AEK_debugLights', {}) as LightDebugLSData;
  if (!data[sceneId]) data[sceneId] = { lights: {}, globalHelpersVisible };
  if (!data[sceneId].lights[appId]) {
    data[sceneId].lights[appId] = {
      helperVisible: globalHelpersVisible,
      symbolVisible: globalHelpersVisible,
    };
  }

  data[sceneId].lights[appId][key] = value;
  lsSetItem('AEK_debugLights', data);

  if (key === 'symbolVisible') {
    reconcileDebugVisuals(entityId, world);
  } else {
    reconcileDebugVisuals(entityId, world);
  }
};

const getLightTypeShorthand = (world: ECSWorld, entityId: number) => {
  if (world.hasComponent(entityId, ComponentType.TAG_IS_POINT_LIGHT)) return 'PL';
  if (world.hasComponent(entityId, ComponentType.TAG_IS_DIRECTIONAL_LIGHT)) return 'DL';
  if (world.hasComponent(entityId, ComponentType.TAG_IS_SPOT_LIGHT)) return 'SL';
  if (world.hasComponent(entityId, ComponentType.TAG_IS_AMBIENT_LIGHT)) return 'AL';
  if (world.hasComponent(entityId, ComponentType.TAG_IS_HEMISPHERE_LIGHT)) return 'HL';
  return '??';
};

/** Logic for the Edit Light Draggable Window */
export const createEditLightContent = (data?: { [key: string]: unknown }) => {
  const d = data as { id: string; winId: string };
  const world = getECSWorld();
  const entityId = getEntityIdByAppId(d.id);
  if (!entityId) return CMP();

  if (!world.isAlive(entityId)) return CMP({ text: 'Entity no longer exists' });

  const objComp = world.getComponent(entityId, ComponentType.OBJECT3D);
  const transform = world.getComponent(entityId, ComponentType.TRANSFORM);
  const appId = world.getComponent(entityId, ComponentType.APP_ID)?.id;
  const debugData = world.getComponent(entityId, ComponentType.DEBUG_DATA);

  if (!objComp || !(objComp.value instanceof THREE.Light)) return CMP();
  const prefs = getLightDebugVisibilityPref(entityId, world);

  const light = objComp.value;
  const container = CMP({ onRemoveCmp: () => pane.dispose() });
  const pane = new Pane({ container: container.elem });

  // Header Info
  container.add({
    class: ['winNotRightPaddedContent', 'winFlexContent'],
    html: () => `<div>
      <div><span class="winSmallLabel">ID:</span> ${entityId}</div>
      <div><span class="winSmallLabel">AppID:</span> ${appId || 'None'}</div>
      <div><span class="winSmallLabel">Type:</span> ${light.type}</div>
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

  // Tweakpane Bindings
  pane.addBinding(light, 'visible', { label: 'Enabled' }).on('change', (e) => {
    // ev.value will be true or false based on the checkbox
    setLightEnabled(entityId, e.value, world);
  });

  // Helper Toggle (Direct binding to the Three.js Helper object)
  const helperComp = world.getComponent(entityId, ComponentType.DEBUG_LIGHT_HELPER);
  if (helperComp) {
    helperComp.value.visible = prefs.helper;
    pane.addBinding(helperComp.value, 'visible', { label: 'Show Helper' }).on('change', (e) => {
      const show = e.value;
      const currentData = lsGetItem(LS_LIGHTS_KEY, {}) as LightDebugLSData;
      const sceneId = getCurrentSceneId();
      if (!sceneId || !appId) return;
      if (!currentData[sceneId]) {
        currentData[sceneId] = { lights: {}, globalHelpersVisible: false };
      }
      if (!currentData[sceneId].lights[appId]) {
        currentData[sceneId].lights[appId] = {
          helperVisible: show,
          symbolVisible: true,
        };
      } else {
        currentData[sceneId].lights[appId].helperVisible = show;
      }
      lsSetItem(LS_LIGHTS_KEY, currentData);
    });
  }

  // Symbol Toggle (Binding to the ECS userVisible flag)
  const symbolComp = world.getComponent(entityId, ComponentType.DEBUG_SYMBOL);
  if (symbolComp) {
    symbolComp.value.visible = prefs.symbol;
    pane.addBinding(symbolComp, 'userVisible', { label: 'Show Symbol' }).on('change', (e) => {
      const show = e.value;
      const currentData = lsGetItem(LS_LIGHTS_KEY, {}) as LightDebugLSData;
      const sceneId = getCurrentSceneId();
      if (!sceneId || !appId) return;
      if (!currentData[sceneId]) {
        currentData[sceneId] = { lights: {}, globalHelpersVisible: false };
      }
      if (!currentData[sceneId].lights[appId]) {
        currentData[sceneId].lights[appId] = {
          helperVisible: false,
          symbolVisible: show,
        };
      } else {
        currentData[sceneId].lights[appId].symbolVisible = show;
      }
      lsSetItem(LS_LIGHTS_KEY, currentData);
    });
  }

  pane.addBinding(light, 'intensity', { label: 'Intensity', min: 0, step: 0.1 });

  if ('color' in light) {
    pane.addBinding(light, 'color', { label: 'Color', view: 'color' });
  }

  // Sync Position to ECS Transform
  if (transform) {
    pane
      .addBinding(transform, 'position', {
        label: 'Position',
      })
      .on('change', (e) => {
        // Only trigger if the change came from the UI (manual dragging)
        // to avoid the double-trigger from setTransform calls.
        if (!e.last) return;

        setTransform(entityId, { pos: transform.position });

        const helper = world.getComponent(entityId, ComponentType.DEBUG_LIGHT_HELPER);
        if (helper && 'update' in helper.value) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (helper.value as any).update();
        }
      });
  }

  // Shadow Logic
  if (light.castShadow !== undefined) {
    pane.addBinding(light, 'castShadow', { label: 'Cast Shadow' });
  }

  return container;
};

/** Creates the Tab in the Debug Drawer */
export const initLightDebuggerGUI = () => {
  const icon = getSvgIcon('lightBulb');
  createDebuggerTab({
    id: 'lightsControls',
    buttonText: icon,
    title: 'Light controls',
    orderNr: 10,
    container: () => {
      const container = createNewDebuggerContainer('debuggerLights', `${icon} Light Controls`);
      debuggerListCmp = CMP({
        id: 'debuggerLightsList',
        html: () => createLightsDebuggerList(getECSWorld()),
      });
      container.add(debuggerListCmp);
      return container;
    },
  });
};

const createLightsDebuggerList = (world: ECSWorld) => {
  const storage = world.getStorage(ComponentType.TAG_IS_LIGHT);
  let html = '<ul class="ulList">';

  for (const [entityId] of storage) {
    const appId = world.getComponent(entityId, ComponentType.APP_ID)?.id;
    const appOrEntityId = appId || entityId;
    const debugData = world.getComponent(entityId, ComponentType.DEBUG_DATA);
    const typeShorthand = getLightTypeShorthand(world, entityId);

    const button = CMP({
      onClick: () => {
        openDraggableWindow({
          id: EDIT_LIGHT_WIN_ID,
          title: `Edit Light: ${debugData?.name || `[${appOrEntityId}]`}`,
          isDebugWindow: true,
          content: createEditLightContent,
          data: { id: appId, winId: EDIT_LIGHT_WIN_ID },
          closeOnSceneChange: true,
          saveToLS: true,
        });
      },
      html: `<button class="listItemWithId">
        <span class="itemId">[${appId}] [${entityId}]</span>
        <span>${typeShorthand}</span>
        <h4${!debugData?.name ? ` style="font-style:italic"` : ''}>${debugData?.name || appOrEntityId}</h4>
      </button>`,
    });

    html += `<li>${button}</li>`;
  }

  if (storage.size === 0) html += `<li class="emptyState">No ECS lights found.</li>`;
  html += '</ul>';
  return html;
};

export const updateLightsDebuggerGUI = () => {
  if (debuggerListCmp) debuggerListCmp.update();
};

export const _toggleAllLightHelpers = (show?: boolean) => {
  const world = getECSWorld();
  const sceneId = getCurrentSceneId();
  if (!sceneId) return;

  const storage = world.getStorage(ComponentType.TAG_IS_LIGHT);
  const currentData = lsGetItem(LS_LIGHTS_KEY, {}) as LightDebugLSData;

  if (!currentData[sceneId]) {
    currentData[sceneId] = { lights: {}, globalHelpersVisible: false };
  }

  const targetState = show !== undefined ? show : !globalHelpersVisible;
  globalHelpersVisible = targetState;
  currentData[sceneId].globalHelpersVisible = globalHelpersVisible;

  for (const [entityId] of storage) {
    const appIdComp = world.getComponent(entityId, ComponentType.APP_ID);

    if (appIdComp?.isFixed) {
      if (!currentData[sceneId].lights[appIdComp.id]) {
        currentData[sceneId].lights[appIdComp.id] = {
          helperVisible: targetState,
          symbolVisible: true,
        };
      } else {
        currentData[sceneId].lights[appIdComp.id].helperVisible = targetState;
      }
    }

    reconcileDebugVisuals(entityId, world, currentData);
  }

  updateDraggableWindow(EDIT_LIGHT_WIN_ID);

  lsSetItem(LS_LIGHTS_KEY, currentData);
};

export const syncDebugVisualsFromLS = (sceneId: string, world: ECSWorld) => {
  const currentData = lsGetItem(LS_LIGHTS_KEY, {}) as LightDebugLSData;
  globalHelpersVisible = Boolean(currentData[sceneId]?.globalHelpersVisible);

  // Sync Helpers
  const helperStorage = world.getStorage(ComponentType.DEBUG_LIGHT_HELPER);
  for (const [entityId] of helperStorage) {
    reconcileDebugVisuals(entityId, world, currentData);
  }

  // Sync Symbols
  const symbolStorage = world.getStorage(ComponentType.DEBUG_SYMBOL);
  for (const [entityId] of symbolStorage) {
    reconcileDebugVisuals(entityId, world, currentData);
  }
};

ECSWorld.registerComponentHooks(ComponentType.DISABLED, {
  onAddComponent: (id, w) => reconcileDebugVisuals(id, w),
  onRemoveComponent: (id, w) => reconcileDebugVisuals(id, w),
});

// Run reconciler when a debug component is first attached to an entity
ECSWorld.registerComponentHooks(ComponentType.DEBUG_SYMBOL, {
  onAddComponent: (id, w) => reconcileDebugVisuals(id, w),
});
ECSWorld.registerComponentHooks(ComponentType.DEBUG_LIGHT_HELPER, {
  onAddComponent: (id, w) => reconcileDebugVisuals(id, w),
});
