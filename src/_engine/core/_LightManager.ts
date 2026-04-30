import * as THREE from 'three/webgpu';
import { CoreEntityOpts, ECSWorld, getECSWorld } from './ECS';
import { getCurrentSceneId, getRootScene, registerOnAllSceneEnterings } from './Scene';
import { DebugModuleRef, existsOrThrow, loadDebugModule, useDebug } from '../utils/helpers';
import { ComponentType, Transform } from './ECS/ECSCoreComponents';
import { IS_DEBUG_ENV } from './Config';
import { lsGetItem, lsSetItem } from '../utils/LocalAndSessionStorage';

export const registerLightManager = (world: ECSWorld) => {
  if (IS_DEBUG_ENV) {
    debugGUI = loadDebugModule(() => import('./Debug/Light/_dbg__LightGUI'));
    debugHelpers = loadDebugModule(() => import('./Debug/Light/_dbg__LightHelpers'));

    registerOnAllSceneEnterings('lightHelpersSceneSync', () => {
      const sceneId = getCurrentSceneId();
      if (sceneId) syncLightHelpersFromLS(sceneId, world);

      useDebug(debugGUI)?.initLightDebuggerGUI();
    });
    ECSWorld.registerComponentHooks(ComponentType.TAG_IS_LIGHT, {
      onAddComponent: () => useDebug(debugGUI)?.updateLightsDebuggerGUI(),
      onDeleteEntity: (entityId, w) => {
        disposeLight(entityId, w);
        useDebug(debugGUI)?.updateLightsDebuggerGUI();
      },
    });
  } else {
    ECSWorld.registerComponentHooks(ComponentType.TAG_IS_LIGHT, {
      onDeleteEntity: (entityId, w) => disposeLight(entityId, w),
    });
  }
};

export enum ShadowQuality {
  LOW = 'LOW', // Mobile / Integrated Graphics
  MEDIUM = 'MEDIUM', // Standard Laptops
  HIGH = 'HIGH', // Gaming Desktops
  ULTRA = 'ULTRA', // M4 Max / RTX 4090 Tier
}

export const SHADOW_PRESETS = {
  [ShadowQuality.LOW]: {
    mapSize: [512, 512] as [number, number],
    blurSamples: 4,
    radius: 1,
    bias: -0.0005,
    normalBias: 0.02,
  },
  [ShadowQuality.MEDIUM]: {
    mapSize: [1024, 1024] as [number, number],
    blurSamples: 8,
    radius: 2,
    bias: -0.0002,
    normalBias: 0.04,
  },
  [ShadowQuality.HIGH]: {
    mapSize: [2048, 2048] as [number, number],
    blurSamples: 16,
    radius: 4,
    bias: -0.0001,
    normalBias: 0.05,
  },
  [ShadowQuality.ULTRA]: {
    mapSize: [4096, 4096] as [number, number],
    blurSamples: 32,
    radius: 5,
    bias: -0.00005,
    normalBias: 0.06,
  },
};

export type LightProps = {
  enabled?: boolean;
  shadowPreset?: ShadowQuality;
} & (
  | { type: 'AMBIENT'; color?: THREE.ColorRepresentation; intensity?: number }
  | {
      type: 'HEMISPHERE';
      skyColor?: THREE.ColorRepresentation;
      groundColor?: THREE.ColorRepresentation;
      intensity?: number;
    }
  | {
      type: 'POINT';
      color?: THREE.ColorRepresentation;
      intensity?: number;
      distance?: number;
      decay?: number;
      castShadow?: boolean;
      // Shadow Tuning
      shadowBias?: number;
      shadowNormalBias?: number;
      shadowMapSize?: [number, number];
      shadowCameraNearFar?: [number, number];
      shadowBlurSamples?: number;
      shadowRadius?: number;
      shadowIntensity?: number;
    }
  | {
      type: 'DIRECTIONAL';
      color?: THREE.ColorRepresentation;
      intensity?: number;
      castShadow?: boolean;
      targetPos?: { x: number; y: number; z: number };
      // Shadow Tuning
      shadowBias?: number;
      shadowNormalBias?: number;
      shadowMapSize?: [number, number];
      shadowCameraNearFar?: [number, number];
      shadowCameraFrustum?: [number, number, number, number]; // Left, Right, Top, Bottom
      shadowBlurSamples?: number;
      shadowRadius?: number;
      shadowIntensity?: number;
    }
  | {
      type: 'SPOT';
      color?: THREE.ColorRepresentation;
      intensity?: number;
      distance?: number;
      angle?: number;
      penumbra?: number;
      decay?: number;
      castShadow?: boolean;
      targetPos?: { x: number; y: number; z: number };
      // Shadow Tuning
      shadowBias?: number;
      shadowNormalBias?: number;
      shadowMapSize?: [number, number];
      shadowCameraNearFar?: [number, number];
      shadowBlurSamples?: number;
      shadowRadius?: number;
      shadowIntensity?: number;
    }
);

export const createLightEntity = (
  props: LightProps,
  entityOpts?: CoreEntityOpts,
  ecsWorld?: ECSWorld
): number => {
  const world = ecsWorld || getECSWorld();
  const rootScene = existsOrThrow(getRootScene(), 'Could not find root scene.');

  let light:
    | THREE.AmbientLight
    | THREE.HemisphereLight
    | THREE.PointLight
    | THREE.DirectionalLight
    | THREE.SpotLight;

  switch (props.type) {
    case 'AMBIENT':
      light = new THREE.AmbientLight(props.color, props.intensity);
      break;
    case 'HEMISPHERE':
      light = new THREE.HemisphereLight(props.skyColor, props.groundColor, props.intensity);
      break;
    case 'POINT':
      light = new THREE.PointLight(props.color, props.intensity, props.distance, props.decay);
      break;
    case 'DIRECTIONAL':
      light = new THREE.DirectionalLight(props.color, props.intensity);
      break;
    case 'SPOT':
      light = new THREE.SpotLight(
        props.color,
        props.intensity,
        props.distance,
        props.angle,
        props.penumbra,
        props.decay
      );
      break;
    default:
      throw new Error('Unsupported light type');
  }

  // --- Shadow Logic (Full Tuning) ---
  if (
    'castShadow' in props &&
    props.castShadow &&
    (light instanceof THREE.PointLight ||
      light instanceof THREE.DirectionalLight ||
      light instanceof THREE.SpotLight)
  ) {
    light.castShadow = true;
    const s = light.shadow;

    // 1. Apply Preset Defaults
    const preset = SHADOW_PRESETS[props.shadowPreset || ShadowQuality.MEDIUM];
    s.mapSize.set(preset.mapSize[0], preset.mapSize[1]);
    s.blurSamples = preset.blurSamples;
    s.radius = preset.radius;
    s.bias = preset.bias;
    s.normalBias = preset.normalBias;

    // 2. Apply Developer Overrides (Fine-tuning)
    if (props.shadowMapSize) s.mapSize.set(props.shadowMapSize[0], props.shadowMapSize[1]);
    if (props.shadowBias !== undefined) s.bias = props.shadowBias;
    if (props.shadowNormalBias !== undefined) s.normalBias = props.shadowNormalBias;
    if (props.shadowRadius !== undefined) s.radius = props.shadowRadius;
    if (props.shadowBlurSamples !== undefined) s.blurSamples = props.shadowBlurSamples;
    if (props.shadowIntensity !== undefined) s.intensity = props.shadowIntensity;

    if (props.shadowCameraNearFar) {
      s.camera.near = props.shadowCameraNearFar[0];
      s.camera.far = props.shadowCameraNearFar[1];
    }

    // Directional specific frustum (Ortho Camera)
    if (
      props.type === 'DIRECTIONAL' &&
      props.shadowCameraFrustum &&
      s.camera instanceof THREE.OrthographicCamera
    ) {
      const [l, r, t, b] = props.shadowCameraFrustum;
      s.camera.left = l;
      s.camera.right = r;
      s.camera.top = t;
      s.camera.bottom = b;
    }

    s.camera.updateProjectionMatrix();
  }

  light.visible = props.enabled ?? true;

  const entityId = world.createEntity(entityOpts);
  world.addComponent(entityId, ComponentType.OBJECT3D, { value: light, _lastVersion: -1 });

  // --- Target Logic ---
  if (
    (props.type === 'DIRECTIONAL' || props.type === 'SPOT') &&
    (light instanceof THREE.DirectionalLight || light instanceof THREE.SpotLight)
  ) {
    const targetId = world.createEntity({ userData: { name: 'LightTarget' } });
    if (entityOpts?.persistent) {
      world.addComponent(targetId, ComponentType.PERSISTENT, true);
    }
    const tPos = props.targetPos || { x: 0, y: 0, z: 0 };

    world.addComponent(targetId, ComponentType.TRANSFORM, new Transform({ pos: tPos }));

    const targetObj = new THREE.Object3D();
    world.addComponent(targetId, ComponentType.OBJECT3D, { value: targetObj, _lastVersion: -1 });

    light.target = targetObj;
    rootScene.add(targetObj);
    world.addComponent(entityId, ComponentType.TARGET_LINK, { targetId });
  }

  // --- Transform Logic ---
  world.addComponent(
    entityId,
    ComponentType.TRANSFORM,
    new Transform({
      pos: { x: light.position.x, y: light.position.y, z: light.position.z },
      rot: {
        x: light.quaternion.x,
        y: light.quaternion.y,
        z: light.quaternion.z,
        w: light.quaternion.w,
      },
    })
  );

  rootScene.add(light);

  // Debug light helpers attachment
  useDebug(debugHelpers)?.attachLightHelpers(entityId, light, world, rootScene);

  return entityId;
};

/**
 * Returns the entityId of the light's target, if it exists.
 */
export const getLightTargetId = (lightId: number, world: ECSWorld): number | undefined =>
  world.getComponent(lightId, ComponentType.TARGET_LINK)?.targetId;

/**
 * Returns the Transform component of the light's target.
 */
export const getLightTargetTransform = (
  lightId: number,
  world: ECSWorld
): Transform | undefined => {
  const targetId = getLightTargetId(lightId, world);
  if (targetId === undefined) return undefined;
  return world.getComponent(targetId, ComponentType.TRANSFORM);
};

/**
 * Updates the light target's position, if it has a target.
 */
export const setLightTargetPosition = (
  lightId: number,
  pos: { x: number; y: number; z: number },
  world: ECSWorld
): void => {
  const transform = getLightTargetTransform(lightId, world);
  if (transform) {
    transform.position.set(pos.x, pos.y, pos.z);
    transform.setDirty();
  }
};

/**
 * Aim the light target at a specific entity by copying its position.
 * Great for "locking" a spotlight onto a character.
 */
export const aimLightAtEntity = (
  lightId: number,
  targetEntityId: number,
  world: ECSWorld
): void => {
  const targetTransform = world.getComponent(targetEntityId, ComponentType.TRANSFORM);
  const lightTargetTransform = getLightTargetTransform(lightId, world);

  if (targetTransform && lightTargetTransform) {
    lightTargetTransform.position.copy(targetTransform.position);
    lightTargetTransform.setDirty();
  }
};

export const setLightShadowEnabled = (lightId: number, enabled: boolean, world: ECSWorld) => {
  const objComp = world.getComponent(lightId, ComponentType.OBJECT3D);
  if (objComp && objComp.value instanceof THREE.Light) {
    objComp.value.castShadow = enabled;
    // @Note: Some WebGPU materials might need a re-compile if shadows are toggled,
    // but the WebGPU renderer generally handles this via its node system.
  }
};

export const setLightEnabled = (lightId: number, enabled: boolean, world: ECSWorld) => {
  if (enabled) {
    world.removeComponent(lightId, ComponentType.DISABLED);
  } else {
    world.addComponent(lightId, ComponentType.DISABLED, true);
  }
};

/**
 * Cleanup Light Resources and its linked Target
 */
export const disposeLight = (entityId: number, world: ECSWorld) => {
  const targetLink = world.getComponent(entityId, ComponentType.TARGET_LINK);
  if (targetLink) {
    world.deleteEntity(targetLink.targetId);
  }

  const objComp = world.getComponent(entityId, ComponentType.OBJECT3D);
  if (!objComp) return;

  const light = objComp.value as THREE.Light;

  if (light instanceof THREE.DirectionalLight || light instanceof THREE.SpotLight) {
    light.target.removeFromParent();
  }
  light.removeFromParent();
  light.dispose();
};

// --- DEBUG LIGHT HELPERS ---

type LightGUIModule = typeof import('./Debug/Light/_dbg__LightGUI');
type LightHelperModule = typeof import('./Debug/Light/_dbg__LightHelpers');

export interface LightEntityDebugState {
  helperVisible: boolean;
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

const LS_LIGHTS_KEY = 'AEK_debugLights';
let debugHelpers: DebugModuleRef<LightHelperModule> | null = null;
let globalHelpersVisible = false;
let debugGUI: DebugModuleRef<LightGUIModule> | null = null;

export const isAnyLightHelperVisible = (): boolean => globalHelpersVisible;

export const toggleAllLightHelpers = (show?: boolean) => {
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
    const helper = world.getComponent(entityId, ComponentType.DEBUG_LIGHT_HELPER);
    const appIdComp = world.getComponent(entityId, ComponentType.APP_ID);
    const objComp = world.getComponent(entityId, ComponentType.OBJECT3D);

    if (helper && appIdComp) {
      helper.value.visible = targetState;

      if (appIdComp.isFixed) {
        if (!currentData[sceneId].lights[appIdComp.id]) {
          currentData[sceneId].lights[appIdComp.id] = { helperVisible: false };
        }
        currentData[sceneId].lights[appIdComp.id].helperVisible = targetState;

        // Save state for future features
        if (objComp?.value && 'intensity' in objComp.value) {
          const lightObj = objComp.value as THREE.Light;
          currentData[sceneId].lights[appIdComp.id].intensity = lightObj.intensity;
          currentData[sceneId].lights[appIdComp.id].color = lightObj.color.getHex();
        }
      }
    }
  }
  lsSetItem(LS_LIGHTS_KEY, currentData);
};

export const syncLightHelpersFromLS = (sceneId: string, world: ECSWorld) => {
  const currentData = lsGetItem(LS_LIGHTS_KEY, {}) as LightDebugLSData;

  // Restore global visibility preference
  globalHelpersVisible = Boolean(currentData[sceneId]?.globalHelpersVisible);

  const storage = world.getStorage(ComponentType.DEBUG_LIGHT_HELPER);
  for (const [entityId, helper] of storage) {
    const appIdComp = world.getComponent(entityId, ComponentType.APP_ID);
    if (appIdComp?.isFixed) {
      const saved = currentData[sceneId]?.lights?.[appIdComp.id];
      // Fallback to global setting if no per-light setting exists
      helper.value.visible =
        saved !== undefined ? Boolean(saved.helperVisible) : globalHelpersVisible;
    } else {
      helper.value.visible = globalHelpersVisible;
    }
  }
};
