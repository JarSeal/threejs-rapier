import * as THREE from 'three/webgpu';
import { ButtonApi, ListBladeApi, Pane } from 'tweakpane';
import { getECSWorld, ECSWorld, getEntityIdByAppId, getStableAppId } from '../../ECS';
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
import {
  setLightEnabled,
  setLightFrustumCullingEnabled,
  setLightObjectCullingEnabled,
  ShadowQuality,
} from '../../LightManager';
import { getCurrentSceneId, getRootScene } from '../../Scene';
import { lsGetItem, lsRemoveItem, lsSetItem } from '../../../utils/LocalAndSessionStorage';
import {
  confirmClearScope,
  createClearListLSButton,
  createClearTabLSButton,
} from '../_dbg__ClearLSButtons';
import { getActiveCameraId } from '../../CameraManager';
import { getLightCharacteristics } from '../../../utils/helpers';
import { BladeController, View } from '@tweakpane/core';
import { FOUR_PX_TO_8K_LIST } from '../../../utils/constants';
import { getRendererOptions } from '../../Renderer';
import { updateOnScreenTools } from '../../../debug/OnScreenTools';
import { lwarn } from '../../../utils/Logger';
import {
  _recordOrCoalesceUndoRedoAction,
  _recordUndoRedoAction,
  _registerUndoRedoActionHandler,
} from '../_dbg__UndoRedo';

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
  frustumCullingEnabled?: boolean;
  objectCullingEnabled?: boolean;
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
  dataOverride?: LightDebugLSData,
  // `removeComponent` fires onRemoveComponent hooks before the component is
  // actually gone (ECS.ts), so `world.isDisabled()` still reads `true` here
  // when this runs from DISABLED's own onRemoveComponent. That call site
  // passes `false` explicitly since removal means "no longer disabled" by
  // definition; every other caller lets this fall through to the live value.
  isDisabledOverride?: boolean
) => {
  const objComp = world.getComponent(entityId, ComponentType.OBJECT3D);
  const light = objComp?.value as THREE.Light;

  if (!light) return;

  // Combine ECS status with the actual Three.js visibility property.
  // This handles initialization and "first load" cases where components might not be synced yet.
  const isEnabled = light.visible && !(isDisabledOverride ?? world.isDisabled(entityId));

  const isCurrentActiveCam = entityId === getActiveCameraId();

  // Get user preferences
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

  reconcileDebugVisuals(entityId, world);
};

const getLightTypeShorthand = (world: ECSWorld, entityId: number) => {
  if (world.hasComponent(entityId, ComponentType.TAG_IS_POINT_LIGHT)) return 'PL';
  if (world.hasComponent(entityId, ComponentType.TAG_IS_DIRECTIONAL_LIGHT)) return 'DL';
  if (world.hasComponent(entityId, ComponentType.TAG_IS_SPOT_LIGHT)) return 'SL';
  if (world.hasComponent(entityId, ComponentType.TAG_IS_AMBIENT_LIGHT)) return 'AL';
  if (world.hasComponent(entityId, ComponentType.TAG_IS_HEMISPHERE_LIGHT)) return 'HL';
  return '??';
};

// Undo/redo

type LightPos = { x: number; y: number; z: number };
type ShadowLight = THREE.PointLight | THREE.SpotLight | THREE.DirectionalLight;

/** Edit window fields recorded to the (per-scene) undo/redo history, and their values. */
type UndoableLightValues = {
  enabled: boolean;
  color: number;
  groundColor: number;
  intensity: number;
  distance: number;
  decay: number;
  frustumCullingEnabled: boolean;
  objectCullingEnabled: boolean;
  position: LightPos;
  targetPos: LightPos;
  castShadow: boolean;
  shadowBias: number;
  shadowNormalBias: number;
  shadowIntensity: number;
  shadowBlurSamples: number;
  shadowRadius: number;
  shadowMapSize: [number, number];
  shadowCameraNearFar: [number, number];
  shadowCameraFrustum: [number, number, number, number];
};
type UndoableLightKey = keyof UndoableLightValues;
type LightUndoPayload<K extends UndoableLightKey> = {
  appId: string;
  prev: UndoableLightValues[K];
  next: UndoableLightValues[K];
};

const UNDOABLE_LIGHT_LABELS: Record<UndoableLightKey, string> = {
  enabled: 'enabled',
  color: 'color',
  groundColor: 'ground color',
  intensity: 'intensity',
  distance: 'distance',
  decay: 'decay',
  frustumCullingEnabled: 'frustum culling',
  objectCullingEnabled: 'object culling',
  position: 'position',
  targetPos: 'target position',
  castShadow: 'cast shadow',
  shadowBias: 'shadow bias',
  shadowNormalBias: 'shadow normal bias',
  shadowIntensity: 'shadow intensity',
  shadowBlurSamples: 'shadow blur samples',
  shadowRadius: 'shadow radius',
  shadowMapSize: 'shadow map size',
  shadowCameraNearFar: 'shadow camera near/far',
  shadowCameraFrustum: 'shadow camera frustum',
};

/** Continuous (slider/color) fields: a drag is merged into one history entry. */
const COALESCED_LIGHT_KEYS: ReadonlySet<UndoableLightKey> = new Set([
  'color',
  'groundColor',
  'intensity',
  'distance',
  'decay',
  'shadowBias',
  'shadowNormalBias',
  'shadowIntensity',
  'shadowBlurSamples',
  'shadowRadius',
  'shadowCameraNearFar',
  'shadowCameraFrustum',
]);

const toLightPos = (v: LightPos): LightPos => ({ x: v.x, y: v.y, z: v.z });

const getOrthoBounds = (light: ShadowLight): [number, number, number, number] | undefined => {
  const cam = light.shadow.camera;
  return cam instanceof THREE.OrthographicCamera
    ? [cam.left, cam.right, cam.top, cam.bottom]
    : undefined;
};

/** Finds the light by app id at undo/redo time (never a captured reference: changing the
 * shadow map size replaces the light's Three.js object). */
const resolveLight = (appId: string) => {
  const world = getECSWorld();
  const entityId = getEntityIdByAppId(appId, world);
  const light =
    entityId !== undefined ? world.getComponent(entityId, ComponentType.OBJECT3D)?.value : null;
  if (entityId === undefined || !(light instanceof THREE.Light)) {
    lwarn(`Undo/redo: light "${appId}" no longer exists, skipping.`);
    return null;
  }
  return { world, entityId, light };
};
type ResolvedLight = NonNullable<ReturnType<typeof resolveLight>>;

const updateShadowCamHelper = ({ world, entityId }: ResolvedLight) =>
  world.getComponent(entityId, ComponentType.DEBUG_LIGHT_HELPER)?.camHelper?.update();

/** Applies a value the same way the edit window's own control does. */
const applyLightField: {
  [K in UndoableLightKey]: (target: ResolvedLight, value: UndoableLightValues[K]) => void;
} = {
  enabled: ({ world, entityId, light }, value) => {
    light.visible = value;
    setLightEnabled(entityId, value, world);
  },
  // For a hemisphere light `color` is the sky color
  color: ({ light }, value) => light.color.setHex(value),
  groundColor: ({ light }, value) => {
    if (light instanceof THREE.HemisphereLight) light.groundColor.setHex(value);
  },
  intensity: ({ light }, value) => {
    light.intensity = value;
  },
  distance: ({ light }, value) => {
    (light as THREE.PointLight | THREE.SpotLight).distance = value;
  },
  decay: ({ light }, value) => {
    (light as THREE.PointLight | THREE.SpotLight).decay = value;
  },
  frustumCullingEnabled: ({ world, entityId }, value) =>
    setLightFrustumCullingEnabled(entityId, value, world),
  objectCullingEnabled: ({ world, entityId }, value) =>
    setLightObjectCullingEnabled(entityId, value, world),
  position: ({ world, entityId }, value) => {
    world.setTransform(entityId, { pos: value });
    const helper = world.getComponent(entityId, ComponentType.DEBUG_LIGHT_HELPER);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (helper && 'update' in helper.value) (helper.value as any).update();
  },
  // The target entity is found through the light's current TARGET_LINK, so it doesn't
  // need a stable app id of its own.
  targetPos: ({ world, entityId }, value) => {
    const targetLink = world.getComponent(entityId, ComponentType.TARGET_LINK);
    if (targetLink) world.setTransform(targetLink.targetId, { pos: value });
  },
  castShadow: ({ world, entityId, light }, value) => {
    light.castShadow = value;
    reconcileDebugVisuals(entityId, world);
  },
  shadowBias: ({ light }, value) => {
    (light as ShadowLight).shadow.bias = value;
  },
  shadowNormalBias: ({ light }, value) => {
    (light as ShadowLight).shadow.normalBias = value;
  },
  shadowIntensity: ({ light }, value) => {
    (light as ShadowLight).shadow.intensity = value;
  },
  shadowBlurSamples: ({ light }, value) => {
    (light as ShadowLight).shadow.blurSamples = value;
  },
  shadowRadius: ({ light }, value) => {
    (light as ShadowLight).shadow.radius = value;
  },
  shadowMapSize: ({ world, entityId, light }, [width, height]) => {
    const l = light as ShadowLight;
    l.shadow.mapSize.set(width, height);
    refreshLightShadows(l, entityId, world);
  },
  shadowCameraNearFar: (target, [near, far]) => {
    const cam = (target.light as ShadowLight).shadow.camera;
    cam.near = near;
    cam.far = far;
    cam.updateProjectionMatrix();
    updateShadowCamHelper(target);
  },
  shadowCameraFrustum: (target, [left, right, top, bottom]) => {
    const cam = (target.light as ShadowLight).shadow.camera;
    if (!(cam instanceof THREE.OrthographicCamera)) return;
    Object.assign(cam, { left, right, top, bottom });
    cam.updateProjectionMatrix();
    updateShadowCamHelper(target);
  },
};

const setLightField = <K extends UndoableLightKey>(
  key: K,
  appId: string,
  value: UndoableLightValues[K]
) => {
  const target = resolveLight(appId);
  if (!target) return;
  applyLightField[key](target, value);
  saveLightToLS(target.entityId, key, value as LightEntityDebugState[K]);
  // refreshLightShadows rebuilds the window itself once the new light's helpers exist
  if (key !== 'shadowMapSize') updateLightsDebuggerGUI('WINDOW');
};

const registerLightUndoHandler = <K extends UndoableLightKey>(key: K) => {
  _registerUndoRedoActionHandler<LightUndoPayload<K>>(`light.${key}`, {
    undo: ({ appId, prev }) => setLightField(key, appId, prev),
    redo: ({ appId, next }) => setLightField(key, appId, next),
  });
};
for (const key of Object.keys(UNDOABLE_LIGHT_LABELS) as UndoableLightKey[]) {
  registerLightUndoHandler(key);
}

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

  // Re-enables the Clear local storage button as soon as any field writes new
  // LS data (see the equivalent camera-GUI wrapper for why `clearLSBtn` is a
  // `let` assigned later, once the button itself is created).
  let clearLSBtn: ButtonApi | undefined = undefined;
  const save = <K extends keyof LightEntityDebugState>(key: K, value: LightEntityDebugState[K]) => {
    saveLightToLS(entityId, key, value);
    if (clearLSBtn) clearLSBtn.disabled = false;
  };

  // Tweakpane has already written the new value when 'change' fires, so each recorded
  // field's previous value is kept here (set when its control is created). Generated app
  // ids can't be found again after a reload, so only lights with a stable app id are recorded.
  const stableAppId = getStableAppId(entityId, world);
  const committed: Partial<UndoableLightValues> = {};
  const record = <K extends UndoableLightKey>(key: K, next: UndoableLightValues[K]) => {
    const prev = committed[key];
    committed[key] = next;
    if (!stableAppId || prev === undefined || JSON.stringify(prev) === JSON.stringify(next)) {
      return;
    }
    const actionType = `light.${key}`;
    const label = `Light ${stableAppId}: ${UNDOABLE_LIGHT_LABELS[key]}`;
    const payload: LightUndoPayload<K> = { appId: stableAppId, prev, next };
    if (COALESCED_LIGHT_KEYS.has(key)) {
      _recordOrCoalesceUndoRedoAction(actionType, label, payload, `${stableAppId}.${key}`);
    } else {
      _recordUndoRedoAction(actionType, label, payload);
    }
  };

  // Footer Info
  container.add({
    class: ['winNotRightPaddedContent', 'winFlexContent'],
    html: () => `<div>
      <div><span class="winSmallLabel">Ent. ID:</span> ${entityId}</div>
      <div><span class="winSmallLabel">App ID:</span> ${appId || 'None'}</div>
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
  committed.enabled = light.visible;
  pane.addBinding(light, 'visible', { label: 'Enabled' }).on('change', (e) => {
    const value = e.value;
    setLightEnabled(entityId, value, world);
    save('enabled', value);
    record('enabled', value);
  });

  // Helper Toggle (Direct binding to the Three.js Helper object)
  const helperComp = world.getComponent(entityId, ComponentType.DEBUG_LIGHT_HELPER);
  if (helperComp && lightChars.hasHelper) {
    const helperProxy = { visible: prefs.helper };
    pane.addBinding(helperProxy, 'visible', { label: 'Show Helper' }).on('change', (e) => {
      const show = e.value;
      save('helperVisible', show);
      setLightDebugPreference(entityId, world, 'helperVisible', show);
      updateOnScreenTools('SWITCH');
    });
  }

  // Symbol Toggle (Binding to the ECS userVisible flag)
  const symbolComp = world.getComponent(entityId, ComponentType.DEBUG_SYMBOL);
  if (symbolComp && lightChars.hasSymbol) {
    symbolComp.value.visible = prefs.symbol;
    pane.addBinding(symbolComp, 'userVisible', { label: 'Show Symbol' }).on('change', (e) => {
      const show = e.value;
      save('symbolVisible', show);
      updateOnScreenTools('SWITCH');
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
      committed.color = colorProxy.sky;
      committed.groundColor = colorProxy.ground;
      pane
        .addBinding(colorProxy, 'sky', {
          label: 'Sky Color',
          view: 'color',
        })
        .on('change', (ev) => {
          hemi.color.setHex(ev.value);
          save('color', ev.value);
          record('color', ev.value);
        });
      pane
        .addBinding(colorProxy, 'ground', {
          label: 'Ground Color',
          view: 'color',
        })
        .on('change', (ev) => {
          hemi.groundColor.setHex(ev.value);
          save('groundColor', ev.value);
          record('groundColor', ev.value);
        });
    } else {
      const colorProxy = { hex: light.color.getHex() };
      committed.color = colorProxy.hex;
      pane
        .addBinding(colorProxy, 'hex', {
          label: 'Color',
          view: 'color',
        })
        .on('change', (ev) => {
          light.color.setHex(ev.value);
          save('color', ev.value);
          record('color', ev.value);
        });
    }
  }

  // Intensity
  committed.intensity = light.intensity;
  pane
    .addBinding(light, 'intensity', { label: 'Intensity', min: 0, step: 0.01 })
    .on('change', (ev) => {
      save('intensity', ev.value);
      record('intensity', ev.value);
    });

  // Distance
  if (lightChars.hasDistance) {
    const l = light as THREE.PointLight | THREE.SpotLight;
    committed.distance = l.distance;
    pane.addBinding(l, 'distance', { label: 'Distance', min: 0, step: 0.01 }).on('change', (ev) => {
      save('distance', ev.value);
      record('distance', ev.value);
    });
  }

  // Decay
  if (lightChars.hasDecay) {
    const l = light as THREE.PointLight | THREE.SpotLight;
    committed.decay = l.decay;
    pane.addBinding(l, 'decay', { label: 'Decay', min: 0, step: 0.01 }).on('change', (ev) => {
      save('decay', ev.value);
      record('decay', ev.value);
    });
  }

  // Frustum Culling (opt-in, ECS-only state — proxy binding)
  if (lightChars.supportsFrustumCulling) {
    const cullProxy = {
      enabled: world.hasComponent(entityId, ComponentType.FRUSTUM_CULLING_ENABLED),
    };
    committed.frustumCullingEnabled = cullProxy.enabled;
    pane.addBinding(cullProxy, 'enabled', { label: 'Frustum Culling' }).on('change', (ev) => {
      setLightFrustumCullingEnabled(entityId, ev.value, world);
      save('frustumCullingEnabled', ev.value);
      record('frustumCullingEnabled', ev.value);
    });
  }

  // Object Culling (opt-in, ECS-only state — proxy binding)
  if (lightChars.supportsFrustumCulling) {
    const objCullProxy = {
      enabled: world.hasComponent(entityId, ComponentType.OBJECT_CULLING_ENABLED),
    };
    committed.objectCullingEnabled = objCullProxy.enabled;
    pane.addBinding(objCullProxy, 'enabled', { label: 'Object Culling' }).on('change', (ev) => {
      setLightObjectCullingEnabled(entityId, ev.value, world);
      save('objectCullingEnabled', ev.value);
      record('objectCullingEnabled', ev.value);
    });
  }

  // Sync Position to ECS Transform
  if (transform && lightChars.hasPosition) {
    committed.position = toLightPos(transform.position);
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
        save('position', transform.position);
        record('position', toLightPos(transform.position));
      });
  }

  // Target position
  const targetLink = world.getComponent(entityId, ComponentType.TARGET_LINK);
  if (targetLink && lightChars.hasTarget) {
    const targetEntityId = targetLink.targetId;
    const targetTransform = world.getComponent(targetEntityId, ComponentType.TRANSFORM);
    if (targetTransform) {
      committed.targetPos = toLightPos(targetTransform.position);
      pane
        .addBinding(targetTransform, 'position', {
          label: 'Target Position',
        })
        .on('change', (e) => {
          if (!e.last) return;
          world.setTransform(targetEntityId, { pos: targetTransform.position });
          save('targetPos', targetTransform.position);
          record('targetPos', toLightPos(targetTransform.position));
        });
    }
  }

  // Shadows
  if (light.castShadow !== undefined && lightChars.canCastShadows) {
    const l = light as THREE.PointLight | THREE.SpotLight | THREE.DirectionalLight;
    const renderOptions = getRendererOptions();
    const isVSM = renderOptions.shadowMapType === THREE.VSMShadowMap;

    committed.castShadow = light.castShadow;
    committed.shadowBias = l.shadow.bias;
    committed.shadowNormalBias = l.shadow.normalBias;
    committed.shadowIntensity = l.shadow.intensity;
    committed.shadowBlurSamples = l.shadow.blurSamples;
    committed.shadowRadius = l.shadow.radius;
    committed.shadowMapSize = [l.shadow.mapSize.width, l.shadow.mapSize.height];
    committed.shadowCameraNearFar = [l.shadow.camera.near, l.shadow.camera.far];
    committed.shadowCameraFrustum = getOrthoBounds(l);

    pane.addBinding(light, 'castShadow', { label: 'Cast Shadow' }).on('change', (ev) => {
      reconcileDebugVisuals(entityId, world);
      // We need to wait a cycle for the pane to be updated
      setTimeout(() => updateDraggableWindow(EDIT_LIGHT_WIN_ID), 0);
      save('castShadow', ev.value);
      record('castShadow', ev.value);
    });

    const shadowFolder = pane
      .addFolder({ title: 'Shadow', expanded: uiState?._shadowFolderOpen || false })
      .on('fold', (ev) => save('_shadowFolderOpen', ev.expanded));

    shadowFolder
      .addBinding(l.shadow, 'bias', {
        label: 'Shadow Bias',
        step: 0.00001,
        disabled: !l.castShadow,
      })
      .on('change', (ev) => {
        save('shadowBias', ev.value);
        record('shadowBias', ev.value);
      });

    shadowFolder
      .addBinding(l.shadow, 'normalBias', {
        label: 'Normal Bias',
        step: 0.00001,
        disabled: !l.castShadow,
      })
      .on('change', (ev) => {
        save('shadowNormalBias', ev.value);
        record('shadowNormalBias', ev.value);
      });

    shadowFolder
      .addBinding(l.shadow, 'intensity', {
        label: 'Shadow Intensity',
        min: 0,
        max: 10,
        step: 0.001,
        disabled: !l.castShadow,
      })
      .on('change', (ev) => {
        save('shadowIntensity', ev.value);
        record('shadowIntensity', ev.value);
      });

    // --- VSM SPECIFIC PARAMETERS ---
    shadowFolder
      .addBinding(l.shadow, 'blurSamples', {
        label: 'Blur Samples (VSM only)',
        min: 0,
        max: 64,
        step: 1,
        disabled: !isVSM || !l.castShadow,
      })
      .on('change', (ev) => {
        save('shadowBlurSamples', ev.value);
        record('shadowBlurSamples', ev.value);
      });

    shadowFolder
      .addBinding(l.shadow, 'radius', {
        label: 'Shadow Radius (VSM only)',
        min: 0,
        disabled: !isVSM || !l.castShadow,
      })
      .on('change', (ev) => {
        save('shadowRadius', ev.value);
        record('shadowRadius', ev.value);
      });

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

      save('shadowMapSize', [value, l.shadow.mapSize.height]);
      record('shadowMapSize', [value, l.shadow.mapSize.height]);
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

      save('shadowMapSize', [l.shadow.mapSize.width, value]);
      record('shadowMapSize', [l.shadow.mapSize.width, value]);
    });

    const camFolder = shadowFolder
      .addFolder({
        title: 'Shadow Camera',
        expanded: uiState?._shadowCameraFolderOpen || false,
      })
      .on('fold', (ev) => save('_shadowCameraFolderOpen', ev.expanded));

    // Universal near/far
    camFolder
      .addBinding(l.shadow.camera, 'near', { label: 'Near', step: 0.01, disabled: !l.castShadow })
      .on('change', (ev) => {
        l.shadow.camera.updateProjectionMatrix();
        const helper = world.getComponent(entityId, ComponentType.DEBUG_LIGHT_HELPER);
        if (helper?.camHelper) helper.camHelper.update();
        save('shadowCameraNearFar', [ev.value, l.shadow.camera.far]);
        record('shadowCameraNearFar', [ev.value, l.shadow.camera.far]);
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
        save('shadowCameraNearFar', [l.shadow.camera.near, ev.value]);
        record('shadowCameraNearFar', [l.shadow.camera.near, ev.value]);
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
          save('shadowCameraFrustum', [ev.value, cam.right, cam.top, cam.bottom]);
          record('shadowCameraFrustum', [ev.value, cam.right, cam.top, cam.bottom]);
        });
      camFolder
        .addBinding(ortho, 'right', { label: 'Right', step, disabled: !l.castShadow })
        .on('change', (ev) => {
          ortho.updateProjectionMatrix();
          const helper = world.getComponent(entityId, ComponentType.DEBUG_LIGHT_HELPER);
          if (helper?.camHelper) helper.camHelper.update();
          const cam = l.shadow.camera as THREE.OrthographicCamera;
          save('shadowCameraFrustum', [cam.left, ev.value, cam.top, cam.bottom]);
          record('shadowCameraFrustum', [cam.left, ev.value, cam.top, cam.bottom]);
        });
      camFolder
        .addBinding(ortho, 'top', { label: 'Top', step, disabled: !l.castShadow })
        .on('change', (ev) => {
          ortho.updateProjectionMatrix();
          const helper = world.getComponent(entityId, ComponentType.DEBUG_LIGHT_HELPER);
          if (helper?.camHelper) helper.camHelper.update();
          const cam = l.shadow.camera as THREE.OrthographicCamera;
          save('shadowCameraFrustum', [cam.left, cam.right, ev.value, cam.bottom]);
          record('shadowCameraFrustum', [cam.left, cam.right, ev.value, cam.bottom]);
        });
      camFolder
        .addBinding(ortho, 'bottom', { label: 'Bottom', step, disabled: !l.castShadow })
        .on('change', (ev) => {
          ortho.updateProjectionMatrix();
          const helper = world.getComponent(entityId, ComponentType.DEBUG_LIGHT_HELPER);
          if (helper?.camHelper) helper.camHelper.update();
          const cam = l.shadow.camera as THREE.OrthographicCamera;
          save('shadowCameraFrustum', [cam.left, cam.right, cam.top, ev.value]);
          record('shadowCameraFrustum', [cam.left, cam.right, cam.top, ev.value]);
        });
    }
  }

  clearLSBtn = pane.addButton({
    title: 'Clear local storage',
    disabled: !loadLightDebugData(appId),
  });
  clearLSBtn.on('click', () => {
    if (!appId) return;
    clearLightFromLS(appId);
    clearLSBtn.disabled = true;
  });

  pane.addButton({ title: 'Delete light' }).on('click', () => {
    closeDraggableWindow(EDIT_LIGHT_WIN_ID);
    world.deleteEntity(entityId);
    // deleteEntity fires disposeLight's onDeleteEntity hook (which already
    // refreshes this list) before clearing the entity's component storages,
    // so that refresh still sees the entity in TAG_IS_LIGHT. Refresh again
    // now that deletion has fully completed.
    updateLightsDebuggerGUI('LIST');
  });

  if (appId || entityId) updateDebuggerLightsListSelectedClass(appId || String(entityId));

  return container;
};

/** Scene entries always carry both `lights` and `globalHelpersVisible` together;
 * once neither holds anything meaningful, drop the entry so `hasData` checks
 * (which only look at key/field presence) don't report stale data forever. */
const pruneEmptyLightScene = (data: LightDebugLSData, sceneId: string) => {
  const scene = data[sceneId];
  if (!scene) return;
  const lightsEmpty = !scene.lights || Object.keys(scene.lights).length === 0;
  if (lightsEmpty && !scene.globalHelpersVisible) delete data[sceneId];
};

const writeLightLSOrRemove = (data: LightDebugLSData) => {
  if (Object.keys(data).length === 0) lsRemoveItem(LS_LIGHTS_KEY);
  else lsSetItem(LS_LIGHTS_KEY, data);
};

/** Creates the Tab in the Debug Drawer */
let lightDebuggerGUIInitiated = false;
export const initLightDebuggerGUI = () => {
  if (lightDebuggerGUIInitiated) return;
  const icon = getSvgIcon('lightBulb');
  createDebuggerTab({
    id: 'lightsControls',
    buttonText: icon,
    title: 'Light controls',
    orderNr: 10,
    container: () => {
      const clearTabBtn = createClearTabLSButton({
        hasData: () => {
          const current = lsGetItem(LS_LIGHTS_KEY, {}) as LightDebugLSData;
          return Object.values(current).some((s) => s.globalHelpersVisible);
        },
        watchKey: LS_LIGHTS_KEY,
        onClear: () => {
          const current = lsGetItem(LS_LIGHTS_KEY, {}) as LightDebugLSData;
          const sceneIdsWithData = Object.keys(current).filter(
            (id) => current[id].globalHelpersVisible
          );
          const applyClear = (sceneIds: string[]) => {
            for (const sceneId of sceneIds) {
              current[sceneId].globalHelpersVisible = false;
              pruneEmptyLightScene(current, sceneId);
            }
            writeLightLSOrRemove(current);
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
          const current = lsGetItem(LS_LIGHTS_KEY, {}) as LightDebugLSData;
          return Object.values(current).some((s) => s.lights && Object.keys(s.lights).length > 0);
        },
        watchKey: LS_LIGHTS_KEY,
        onClear: () => {
          const current = lsGetItem(LS_LIGHTS_KEY, {}) as LightDebugLSData;
          const sceneIdsWithData = Object.keys(current).filter(
            (id) => current[id].lights && Object.keys(current[id].lights).length > 0
          );
          const applyClear = (sceneIds: string[]) => {
            for (const sceneId of sceneIds) {
              current[sceneId].lights = {};
              pruneEmptyLightScene(current, sceneId);
            }
            writeLightLSOrRemove(current);
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
      const container = createNewDebuggerContainer('debuggerLights', `${icon} Light Controls`, [
        clearTabBtn,
        clearListBtn,
      ]);
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
  lightDebuggerGUIInitiated = true;
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
  // A perspective shadow camera's aspect follows the map size (same as createLightEntity).
  // A directional light's ortho bounds are left as they are: createLightEntity applies
  // shadowCameraFrustum as-is regardless of the map size, so this preview must too.
  const l = light as THREE.SpotLight | THREE.DirectionalLight;
  if (l.shadow) {
    const { width, height } = l.shadow.mapSize;
    if (l.shadow.camera instanceof THREE.PerspectiveCamera) {
      l.shadow.camera.aspect = width / height;
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
  const { attachLightHelpers, disposeLightHelpers } = await import('./_dbg__LightHelpers');
  if (oldHelperComp) disposeLightHelpers(oldHelperComp);
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

/**
 * Returns a light's saved debugger state.
 * @param appId (string) the light's app id
 * @param sceneId (string) scene whose data to read, defaults to the current scene
 */
export const loadLightDebugData = (
  appId?: string,
  sceneId: string | null = getCurrentSceneId()
): LightEntityDebugState | undefined => {
  if (!appId) return;
  const currentData = lsGetItem(LS_LIGHTS_KEY, {}) as LightDebugLSData;
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

export const clearLightFromLS = (appId: string) => {
  const sceneId = getCurrentSceneId();
  const currentData = lsGetItem(LS_LIGHTS_KEY, {}) as LightDebugLSData;
  if (!sceneId || !currentData[sceneId]?.lights?.[appId]) return;
  delete currentData[sceneId].lights[appId];
  lsSetItem(LS_LIGHTS_KEY, currentData);
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
  onRemoveComponent: (id, w) => reconcileDebugVisuals(id, w, undefined, false),
});

// Run reconciler when a debug component is first attached to an entity
ECSWorld.registerComponentHooks(ComponentType.DEBUG_SYMBOL, {
  onAddComponent: (id, w) => reconcileDebugVisuals(id, w),
});
ECSWorld.registerComponentHooks(ComponentType.DEBUG_LIGHT_HELPER, {
  onAddComponent: (id, w) => reconcileDebugVisuals(id, w),
});
