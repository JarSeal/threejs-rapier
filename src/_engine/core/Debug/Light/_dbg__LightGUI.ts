import * as THREE from 'three/webgpu';
import { ListBladeApi, Pane } from 'tweakpane';
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
import { setTransform } from '../../../utils/ECSHelpers';
import { setLightEnabled, ShadowQuality } from '../../_LightManager';
import { getCurrentSceneId, getRootScene } from '../../Scene';
import { lsGetItem, lsSetItem } from '../../../utils/LocalAndSessionStorage';
import { getActiveCameraId } from '../../_CameraManager';
import { getLightCharacteristics } from '../../../utils/helpers';
import { BladeController, View } from '@tweakpane/core';
import { FOUR_PX_TO_8K_LIST } from '../../../utils/constants';
import { getRendererOptions } from '../../Renderer';

export interface LightEntityDebugState {
  enabled: boolean;
  helperVisible: boolean;
  symbolVisible: boolean;
  color?: number;
  groundColor?: number;
  intensity?: number;
  distance?: number;
  angle?: number;
  penumbra?: number;
  decay?: number;
  position?: { x: number; y: number; z: number };
  targetPos?: { x: number; y: number; z: number };
  castShadow?: boolean;
  shadowPreset?: ShadowQuality;
  shadowBias?: number;
  shadowNormalBias?: number;
  shadowMapSize?: [number, number];
  shadowCameraNearFar?: [number, number];
  shadowCameraFrustum?: [number, number, number, number]; // Left, Right, Top, Bottom
  shadowBlurSamples?: number;
  shadowRadius?: number;
  shadowIntensity?: number;
  _shadowFolderOpen?: boolean;
  _shadowCameraFolderOpen?: boolean;
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
const DEBUGGER_LIGHTS_LIST_ID = 'debuggerLightsList';
export let globalHelpersVisible = false;
let debuggerListCmp: TCMP | null = null;

const reconcileDebugVisuals = (
  entityId: number,
  world: ECSWorld,
  dataOverride?: LightDebugLSData
) => {
  const objComp = world.getComponent(entityId, ComponentType.OBJECT3D);
  const light = objComp?.value as THREE.Light;

  if (!light) return;

  // Combine ECS status with the actual Three.js visibility property.
  // This handles initialization and "first load" cases where components might not be synced yet.
  const isEnabled = light.visible && !world.isDisabled(entityId);

  const isCurrentActiveCam = entityId === getActiveCameraId();

  // 3. Get user preferences
  const { helper: helperPref, symbol: symbolPref } = getLightDebugVisibilityPref(
    entityId,
    world,
    dataOverride
  );

  // Sync Helper
  const helperComp = world.getComponent(entityId, ComponentType.DEBUG_LIGHT_HELPER);
  if (helperComp) {
    // Helper only shows if: (Light is physically ON) AND (User wants to see helpers)
    helperComp.value.visible = isEnabled && helperPref;

    if (helperComp.camHelper) {
      // Shadow lines only show if: (Light is ON) AND (User wants helpers) AND (Casts Shadows)
      helperComp.camHelper.visible = light.castShadow && isEnabled && helperPref;
    }
  }

  // Sync Symbol
  const symbolComp = world.getComponent(entityId, ComponentType.DEBUG_SYMBOL);
  if (symbolComp) {
    symbolComp.userVisible = symbolPref;
    symbolComp.value.visible = isEnabled && symbolPref && !isCurrentActiveCam;
  }
};

export const getLightDebugVisibilityPref = (
  entityId: number,
  world: ECSWorld,
  dataOverride?: LightDebugLSData
) => {
  const sceneId = getCurrentSceneId();
  const appId = world.getComponent(entityId, ComponentType.APP_ID)?.id;
  const isDisabled = world.getComponent(entityId, ComponentType.DISABLED);
  const showHelper = !isDisabled ? globalHelpersVisible : false;
  if (!sceneId || !appId) return { helper: showHelper, symbol: true };

  const data = dataOverride || (lsGetItem(LS_LIGHTS_KEY, {}) as LightDebugLSData);
  const saved = data[sceneId]?.lights?.[appId];

  if (!saved) {
    return {
      helper: showHelper,
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
      enabled: true,
      helperVisible: globalHelpersVisible,
      symbolVisible: true,
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

  const lightChars = getLightCharacteristics(light);

  const uiState = loadLightDebugData(appId);

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
    const value = e.value;
    setLightEnabled(entityId, value, world);
    saveLightToLS(entityId, 'enabled', value);
  });

  // Helper Toggle (Direct binding to the Three.js Helper object)
  const helperComp = world.getComponent(entityId, ComponentType.DEBUG_LIGHT_HELPER);
  if (helperComp && lightChars.hasHelper) {
    const helperProxy = { visible: prefs.helper };
    pane.addBinding(helperProxy, 'visible', { label: 'Show Helper' }).on('change', (e) => {
      const show = e.value;
      saveLightToLS(entityId, 'helperVisible', show);
      setLightDebugPreference(entityId, world, 'helperVisible', show);
    });
  }

  // Symbol Toggle (Binding to the ECS userVisible flag)
  const symbolComp = world.getComponent(entityId, ComponentType.DEBUG_SYMBOL);
  if (symbolComp && lightChars.hasSymbol) {
    symbolComp.value.visible = prefs.symbol;
    pane.addBinding(symbolComp, 'userVisible', { label: 'Show Symbol' }).on('change', (e) => {
      const show = e.value;
      saveLightToLS(entityId, 'symbolVisible', show);
    });
  }

  // Color
  if ('color' in light) {
    if (lightChars.isHemisphereLight) {
      const hemi = light as THREE.HemisphereLight;
      const colorProxy = {
        sky: hemi.color.getHex(),
        ground: hemi.groundColor.getHex(),
      };
      pane
        .addBinding(colorProxy, 'sky', {
          label: 'Sky Color',
          view: 'color',
        })
        .on('change', (ev) => {
          hemi.color.setHex(ev.value);
          saveLightToLS(entityId, 'color', ev.value);
        });
      pane
        .addBinding(colorProxy, 'ground', {
          label: 'Ground Color',
          view: 'color',
        })
        .on('change', (ev) => {
          hemi.groundColor.setHex(ev.value);
          saveLightToLS(entityId, 'groundColor', ev.value);
        });
    } else {
      const colorProxy = { hex: light.color.getHex() };
      pane
        .addBinding(colorProxy, 'hex', {
          label: 'Color',
          view: 'color',
        })
        .on('change', (ev) => {
          light.color.setHex(ev.value);
          saveLightToLS(entityId, 'color', ev.value);
        });
    }
  }

  // Intensity
  pane
    .addBinding(light, 'intensity', { label: 'Intensity', min: 0, step: 0.01 })
    .on('change', (ev) => saveLightToLS(entityId, 'intensity', ev.value));

  // Distance
  if (lightChars.hasDistance) {
    const l = light as THREE.PointLight | THREE.SpotLight;
    pane
      .addBinding(l, 'distance', { label: 'Distance', min: 0, step: 0.01 })
      .on('change', (ev) => saveLightToLS(entityId, 'distance', ev.value));
  }

  // Decay
  if (lightChars.hasDecay) {
    const l = light as THREE.PointLight | THREE.SpotLight;
    pane
      .addBinding(l, 'decay', { label: 'Decay', min: 0, step: 0.01 })
      .on('change', (ev) => saveLightToLS(entityId, 'decay', ev.value));
  }

  // Sync Position to ECS Transform
  if (transform && lightChars.hasPosition) {
    pane
      .addBinding(transform, 'position', {
        label: 'Position',
      })
      .on('change', (e) => {
        // Only trigger if the change came from the UI (manual dragging)
        // to avoid the double-trigger from setTransform calls.
        if (!e.last) return;
        world.setTransform(entityId, { pos: transform.position });
        const helper = world.getComponent(entityId, ComponentType.DEBUG_LIGHT_HELPER);
        if (helper && 'update' in helper.value) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (helper.value as any).update();
        }
        saveLightToLS(entityId, 'position', transform.position);
      });
  }

  // Target position
  const targetLink = world.getComponent(entityId, ComponentType.TARGET_LINK);
  if (targetLink && lightChars.hasTarget) {
    const targetEntityId = targetLink.targetId;
    const targetTransform = world.getComponent(targetEntityId, ComponentType.TRANSFORM);
    if (targetTransform) {
      pane
        .addBinding(targetTransform, 'position', {
          label: 'Target Position',
        })
        .on('change', (e) => {
          if (!e.last) return;
          setTransform(targetEntityId, { pos: targetTransform.position });
          saveLightToLS(entityId, 'targetPos', targetTransform.position);
        });
    }
  }

  // Shadows
  if (light.castShadow !== undefined && lightChars.canCastShadows) {
    const l = light as THREE.PointLight | THREE.SpotLight | THREE.DirectionalLight;
    const renderOptions = getRendererOptions();
    const isVSM = renderOptions.shadowMapType === THREE.VSMShadowMap;

    pane.addBinding(light, 'castShadow', { label: 'Cast Shadow' }).on('change', (ev) => {
      reconcileDebugVisuals(entityId, world);
      // We need to wait a cycle for the pane to be updated
      setTimeout(() => updateDraggableWindow(EDIT_LIGHT_WIN_ID), 0);
      saveLightToLS(entityId, 'castShadow', ev.value);
    });

    const shadowFolder = pane
      .addFolder({ title: 'Shadow', expanded: uiState?._shadowFolderOpen || false })
      .on('fold', (ev) => saveLightToLS(entityId, '_shadowFolderOpen', ev.expanded));

    shadowFolder
      .addBinding(l.shadow, 'bias', {
        label: 'Shadow Bias',
        step: 0.00001,
        disabled: !l.castShadow,
      })
      .on('change', (ev) => saveLightToLS(entityId, 'shadowBias', ev.value));

    shadowFolder
      .addBinding(l.shadow, 'normalBias', {
        label: 'Normal Bias',
        step: 0.00001,
        disabled: !l.castShadow,
      })
      .on('change', (ev) => saveLightToLS(entityId, 'shadowNormalBias', ev.value));

    shadowFolder
      .addBinding(l.shadow, 'intensity', {
        label: 'Shadow Intensity',
        min: 0,
        max: 10,
        step: 0.001,
        disabled: !l.castShadow,
      })
      .on('change', (ev) => saveLightToLS(entityId, 'shadowIntensity', ev.value));

    // --- VSM SPECIFIC PARAMETERS ---
    shadowFolder
      .addBinding(l.shadow, 'blurSamples', {
        label: 'Blur Samples (VSM only)',
        min: 0,
        max: 64,
        step: 1,
        disabled: !isVSM || !l.castShadow,
      })
      .on('change', (ev) => saveLightToLS(entityId, 'shadowBlurSamples', ev.value));

    shadowFolder
      .addBinding(l.shadow, 'radius', {
        label: 'Shadow Radius (VSM only)',
        min: 0,
        disabled: !isVSM || !l.castShadow,
      })
      .on('change', (ev) => saveLightToLS(entityId, 'shadowRadius', ev.value));

    const widthBlade = shadowFolder.addBlade({
      view: 'list',
      label: 'Shadow map width',
      value: l.shadow.mapSize.width || 512,
      options: FOUR_PX_TO_8K_LIST,
      disabled: !l.castShadow,
    }) as ListBladeApi<BladeController<View>>;

    const heightBlade = shadowFolder.addBlade({
      view: 'list',
      label: 'Shadow map height',
      value: l.shadow.mapSize.height || 512,
      options: FOUR_PX_TO_8K_LIST,
      disabled: !l.castShadow,
    }) as ListBladeApi<BladeController<View>>;

    widthBlade.on('change', (e) => {
      const value = Number(e.value);

      l.shadow.mapSize.width = value;

      // Sync the Perspective Camera aspect ratio to the texture resolution
      if (l.shadow.camera instanceof THREE.PerspectiveCamera) {
        const height = l.shadow.mapSize.height || 512;
        l.shadow.camera.aspect = value / height;
        l.shadow.camera.updateProjectionMatrix();
      }

      refreshLightShadows(l, entityId, world);

      saveLightToLS(entityId, 'shadowMapSize', [value, l.shadow.mapSize.height]);
    });

    heightBlade.on('change', (e) => {
      const value = Number(e.value);

      l.shadow.mapSize.height = value;

      // Sync the Perspective Camera aspect ratio to the texture resolution
      if (l.shadow.camera instanceof THREE.PerspectiveCamera) {
        const width = l.shadow.mapSize.width || 512;
        l.shadow.camera.aspect = width / value;
        l.shadow.camera.updateProjectionMatrix();
      }

      refreshLightShadows(l, entityId, world);

      saveLightToLS(entityId, 'shadowMapSize', [l.shadow.mapSize.width, value]);
    });

    const camFolder = shadowFolder
      .addFolder({
        title: 'Shadow Camera',
        expanded: uiState?._shadowCameraFolderOpen || false,
      })
      .on('fold', (ev) => saveLightToLS(entityId, '_shadowCameraFolderOpen', ev.expanded));

    // Universal near/far
    camFolder
      .addBinding(l.shadow.camera, 'near', { label: 'Near', step: 0.01, disabled: !l.castShadow })
      .on('change', (ev) => {
        l.shadow.camera.updateProjectionMatrix();
        const helper = world.getComponent(entityId, ComponentType.DEBUG_LIGHT_HELPER);
        if (helper?.camHelper) helper.camHelper.update();
        saveLightToLS(entityId, 'shadowCameraNearFar', [ev.value, l.shadow.camera.far]);
      });
    camFolder
      .addBinding(l.shadow.camera, 'far', {
        label: `Far${l.type === 'SpotLight' ? ` (tied to distance)` : ''}`,
        step: 1,
        disabled: !l.castShadow,
      })
      .on('change', (ev) => {
        l.shadow.camera.updateProjectionMatrix();
        const helper = world.getComponent(entityId, ComponentType.DEBUG_LIGHT_HELPER);
        if (helper?.camHelper) helper.camHelper.update();
        saveLightToLS(entityId, 'shadowCameraNearFar', [l.shadow.camera.near, ev.value]);
      });

    // Orthographic specific (Directional Light only)
    if (l.shadow.camera instanceof THREE.OrthographicCamera) {
      const ortho = l.shadow.camera;
      const step = 0.01;

      camFolder
        .addBinding(ortho, 'left', { label: 'Left', step, disabled: !l.castShadow })
        .on('change', (ev) => {
          ortho.updateProjectionMatrix();
          const helper = world.getComponent(entityId, ComponentType.DEBUG_LIGHT_HELPER);
          if (helper?.camHelper) helper.camHelper.update();
          const cam = l.shadow.camera as THREE.OrthographicCamera;
          saveLightToLS(entityId, 'shadowCameraFrustum', [
            ev.value,
            cam.right,
            cam.top,
            cam.bottom,
          ]);
        });
      camFolder
        .addBinding(ortho, 'right', { label: 'Right', step, disabled: !l.castShadow })
        .on('change', (ev) => {
          ortho.updateProjectionMatrix();
          const helper = world.getComponent(entityId, ComponentType.DEBUG_LIGHT_HELPER);
          if (helper?.camHelper) helper.camHelper.update();
          const cam = l.shadow.camera as THREE.OrthographicCamera;
          saveLightToLS(entityId, 'shadowCameraFrustum', [cam.left, ev.value, cam.top, cam.bottom]);
        });
      camFolder
        .addBinding(ortho, 'top', { label: 'Top', step, disabled: !l.castShadow })
        .on('change', (ev) => {
          ortho.updateProjectionMatrix();
          const helper = world.getComponent(entityId, ComponentType.DEBUG_LIGHT_HELPER);
          if (helper?.camHelper) helper.camHelper.update();
          const cam = l.shadow.camera as THREE.OrthographicCamera;
          saveLightToLS(entityId, 'shadowCameraFrustum', [
            cam.left,
            cam.right,
            ev.value,
            cam.bottom,
          ]);
        });
      camFolder
        .addBinding(ortho, 'bottom', { label: 'Bottom', step, disabled: !l.castShadow })
        .on('change', (ev) => {
          ortho.updateProjectionMatrix();
          const helper = world.getComponent(entityId, ComponentType.DEBUG_LIGHT_HELPER);
          if (helper?.camHelper) helper.camHelper.update();
          const cam = l.shadow.camera as THREE.OrthographicCamera;
          saveLightToLS(entityId, 'shadowCameraFrustum', [cam.left, cam.right, cam.top, ev.value]);
        });
    }
  }

  if (appId || entityId) updateDebuggerLightsListSelectedClass(appId || String(entityId));

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
        id: DEBUGGER_LIGHTS_LIST_ID,
        html: () => createLightsDebuggerList(getECSWorld()),
      });
      container.add(debuggerListCmp);
      const winState = getDraggableWindow(EDIT_LIGHT_WIN_ID);
      if (winState?.isOpen && winState.data?.id) {
        const id = (winState.data as { id: string }).id;
        updateDebuggerLightsListSelectedClass(id);
      }
      return container;
    },
  });
};

registerDraggableWindowContentFn(EDIT_LIGHT_WIN_ID, createEditLightContent);

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
          onClose: () => updateDebuggerLightsListSelectedClass(null),
        });
        updateDebuggerLightsListSelectedClass(String(appOrEntityId));
      },
      html: `<button class="listItemWithId">
        <span class="itemId">[${appId}] [${entityId}]</span>
        <span>${typeShorthand}</span>
        <h4${!debugData?.name ? ` style="font-style:italic"` : ''}>${debugData?.name || `[${appOrEntityId}]`}</h4>
      </button>`,
    });

    html += `<li data-id="${appOrEntityId}">${button}</li>`;
  }

  if (storage.size === 0) html += `<li class="emptyState">No ECS lights found.</li>`;
  html += '</ul>';
  return html;
};

export const updateDebuggerLightsListSelectedClass = (id: string | null) => {
  const debuggerListCmp = getCmpById(DEBUGGER_LIGHTS_LIST_ID);
  const ulElem = debuggerListCmp?.elem;
  if (!ulElem) return;
  for (const child of ulElem.children) {
    child.classList.remove('selected');
    if (id === null) continue;
    const elemId = child.getAttribute('data-id');
    if (elemId === id) {
      child.classList.add('selected');
    }
  }
};

export const updateLightsDebuggerGUI = (only?: 'LIST' | 'WINDOW') => {
  if (only !== 'WINDOW') debuggerListCmp?.update();
  const winState = getDraggableWindow(EDIT_LIGHT_WIN_ID);
  const lightId = winState?.data?.id as string;
  if (lightId) updateDebuggerLightsListSelectedClass(lightId);
  if (only === 'LIST') return;
  if (winState?.isOpen) updateDraggableWindow(EDIT_LIGHT_WIN_ID);
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

  // Determine the target state
  const targetState = show !== undefined ? show : !globalHelpersVisible;
  globalHelpersVisible = targetState;
  currentData[sceneId].globalHelpersVisible = globalHelpersVisible;

  // Update the in-memory data object (Ignoring Symbols)
  for (const [entityId] of storage) {
    const appIdComp = world.getComponent(entityId, ComponentType.APP_ID);
    if (appIdComp?.isFixed) {
      if (!currentData[sceneId].lights[appIdComp.id]) {
        currentData[sceneId].lights[appIdComp.id] = {
          enabled: true, // Default is true
          helperVisible: targetState,
          symbolVisible: true, // Default is true
        };
      } else {
        currentData[sceneId].lights[appIdComp.id].helperVisible = targetState;
      }
    }

    // Reconcile the 3D scene using the updated data
    reconcileDebugVisuals(entityId, world, currentData);
  }

  lsSetItem(LS_LIGHTS_KEY, currentData);

  updateDraggableWindow(EDIT_LIGHT_WIN_ID);
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

const refreshLightShadows = async (light: THREE.Light, entityId: number, world: ECSWorld) => {
  const rootScene = getRootScene();
  if (!rootScene) return;

  // Finalize Projection for the new Light
  // We must ensure the shadow camera knows about the new MapSize aspect ratio
  const l = light as THREE.SpotLight | THREE.DirectionalLight;
  if (l.shadow) {
    const { width, height } = l.shadow.mapSize;
    const aspect = width / height;

    if (l.shadow.camera instanceof THREE.PerspectiveCamera) {
      // For SpotLights: Sync aspect ratio
      l.shadow.camera.aspect = aspect;
    } else if (l.shadow.camera instanceof THREE.OrthographicCamera) {
      // For DirectionalLights: Ensure bounds match the resolution aspect
      // If you don't do this, rectangular pixels stretch and look "bigger"
      const halfW = (l.shadow.camera.right - l.shadow.camera.left) / 2;
      const center = (l.shadow.camera.right + l.shadow.camera.left) / 2;
      // Adjust horizontal bounds based on aspect if you want square shadow pixels
      l.shadow.camera.left = center - halfW * aspect;
      l.shadow.camera.right = center + halfW * aspect;
    }
    l.shadow.camera.updateProjectionMatrix();
  }

  // Clone the light with these finalized settings
  const newLight = light.clone(true) as THREE.Light;

  // Preserve references
  if (light instanceof THREE.DirectionalLight || light instanceof THREE.SpotLight) {
    (newLight as THREE.DirectionalLight | THREE.SpotLight).target = light.target;
  }

  // Clean up old visuals and dispose
  const oldHelperComp = world.getComponent(entityId, ComponentType.DEBUG_LIGHT_HELPER);
  if (oldHelperComp) {
    oldHelperComp.value.removeFromParent();
    oldHelperComp.camHelper?.removeFromParent();
  }

  light.removeFromParent();
  light.dispose();
  rootScene.add(newLight);

  // Update ECS
  const objComp = world.getComponent(entityId, ComponentType.OBJECT3D);
  if (objComp) {
    objComp.value = newLight;
    objComp._lastVersion = -1; // Force immediate transform sync
  }

  // Re-link Symbol
  const symbolComp = world.getComponent(entityId, ComponentType.DEBUG_SYMBOL);
  if (symbolComp) {
    symbolComp.value.matrix = newLight.matrixWorld;
    symbolComp.value.matrixAutoUpdate = false;
  }

  // Re-attach Helpers
  const { attachLightHelpers } = await import('./_dbg__LightHelpers');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  attachLightHelpers(entityId, newLight as any, world, rootScene);

  // The helper geometry needs to be rebuilt based on the new projection
  const newHelperComp = world.getComponent(entityId, ComponentType.DEBUG_LIGHT_HELPER);
  if (newHelperComp?.camHelper) {
    newHelperComp.camHelper.update(); // Sync lines to new camera bounds
  }

  reconcileDebugVisuals(entityId, world);
  updateLightsDebuggerGUI();
};

export const loadLightDebugData = (appId?: string): LightEntityDebugState | undefined => {
  if (!appId) return;
  const currentData = lsGetItem(LS_LIGHTS_KEY, {}) as LightDebugLSData;
  const sceneId = getCurrentSceneId();
  if (
    !sceneId ||
    !currentData ||
    !currentData[sceneId] ||
    !currentData[sceneId].lights ||
    !currentData[sceneId].lights[appId]
  ) {
    return;
  }
  return currentData[sceneId].lights[appId];
};

/** * Helper for saving specific light debug properties to LocalStorage.
 * @param K - A generic extending the keys of the debug state.
 * @param value - Automatically typed based on the key provided.
 */
const saveLightToLS = <K extends keyof LightEntityDebugState>(
  entityId: number,
  key: K,
  value: LightEntityDebugState[K]
) => {
  const world = getECSWorld();
  const sceneId = getCurrentSceneId();
  const appIdComp = world.getComponent(entityId, ComponentType.APP_ID);
  if (!sceneId || !appIdComp?.isFixed) return;
  const currentData = lsGetItem(LS_LIGHTS_KEY, {}) as LightDebugLSData;
  if (!currentData[sceneId]) currentData[sceneId] = { lights: {}, globalHelpersVisible: false };
  const appId = appIdComp.id;
  if (!currentData[sceneId].lights[appId]) {
    currentData[sceneId].lights[appId] = {
      enabled: true,
      helperVisible: false,
      symbolVisible: true,
    };
  }
  currentData[sceneId].lights[appId][key] = value;
  lsSetItem(LS_LIGHTS_KEY, currentData);
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
