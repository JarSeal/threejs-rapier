import * as THREE from 'three/webgpu';
import { normalWorldGeometry, pmremTexture } from 'three/tsl';
import { lerror, lwarn } from '../../utils/Logger';
import { getCurrentSceneId, getRootScene } from '../Scene';
import { getNextSceneId, isCurrentlyLoading } from '../SceneLoader';
import { isDebugEnvironment } from '../Config';
import { lsGetItem } from '../../utils/LocalAndSessionStorage';
import { DebugModuleRef, loadDebugModuleAsync, useDebug } from '../../utils/helpers';
import { deepMerge } from '../../utils/deepMerge';
import { ECSWorld, getECSWorld } from '../ECS';
import { ECSSystemStage } from '../../../AppECSRegistry';
import type { SkyBoxBaseDef, SkyBoxDef, SkyBoxEnvDef, SkyBoxOverrides } from './SkyBoxTypes';
import { fromLegacySkyBoxProps, isLegacySkyBoxProps, type LegacySkyBoxProps } from './legacySkyBox';
import {
  BASE_DEFAULTS,
  BASE_STRUCTURAL_KEYS,
  buildBaseLayer,
  ENV_DEFAULTS,
  loadBaseTexture,
} from './layers/base';
import {
  applySkyUniforms,
  buildSkyComposite,
  createSkyUniforms,
  hasProceduralLayer,
  type SkyUniforms,
} from './SkyComposite';
import {
  disposeEnvBake,
  getPMREMTexture,
  isEnvBakeRequested,
  requestEnvBake,
  runRequestedEnvBake,
  setEnvBake,
} from './SkyEnvironment';

export type { SkyBoxDef } from './SkyBoxTypes';

/** The one sky box the root scene shows. */
export type ActiveSkyBox = {
  id: string;
  sceneId: string;
  /** The definition with the debug overrides (debug env only) and updateSkyBox changes merged in. */
  def: SkyBoxDef;
  /** Every layer's uniforms, created on activation and kept across node rebuilds. */
  uniforms: SkyUniforms;
  /** Whether it's on the composite path (SkyComposite.ts), whose environment is an env bake,
   * or on the direct path (a texture or colour base only, sampled as is). */
  isComposite: boolean;
  nodes: { background: THREE.Node; environment: THREE.Node | null };
  /** The base's source texture, and the PMREM the environment samples (the texture's, or the
   * env bake's target). */
  textures: { source: THREE.Texture | null; environment: THREE.Texture | null };
};

/** A change to the active sky box: any subset of its layers' values. */
export type SkyBoxUpdate = {
  base?: NonNullable<SkyBoxOverrides['base']> & { texture?: THREE.Texture };
  env?: SkyBoxEnvDef;
};

export type SkyBoxChangeReason = 'activate' | 'update' | 'clear';
type SkyBoxChangeListener = (active: ActiveSkyBox | null, reason: SkyBoxChangeReason) => void;

/** @internal The debug tab's override store: `{ [sceneId]: { [skyBoxId]: SkyBoxOverrides } }`. */
export const SKYBOX_DEBUG_OVERRIDES_LS_KEY = 'AEK_debugSkyBox';

/** Definitions by scene, in registration order. */
const registry = new Map<string, Map<string, SkyBoxDef>>();
/** Per scene, the last sky box registered with `isDefault: true`. */
const sceneDefaultIds = new Map<string, string>();
let active: ActiveSkyBox | null = null;
/** Every activation and clear takes the next number; an activation that finds a newer one when
 * its texture has loaded was superseded, and drops its result. */
let activationSeq = 0;
const listeners = new Set<SkyBoxChangeListener>();

const notify = (reason: SkyBoxChangeReason) => {
  for (const listener of listeners) listener(active, reason);
  // An update keeps the tab's panes (a rebuild would drop a slider mid-drag)
  createSkyBoxDebugGUI({ rebuild: reason !== 'update' });
};

/** The scene a sky box without an explicit one belongs to: the loading scene, else the current. */
const resolveSceneId = (sceneId?: string) =>
  sceneId || (isCurrentlyLoading() ? getNextSceneId() : getCurrentSceneId());

// Registry

/**
 * Registers (or replaces, by id) a sky box definition without showing it. Without a sceneId,
 * it belongs to the loading scene, or else the current one.
 * @returns the scene id it was registered in
 */
export const registerSkyBox = (def: SkyBoxDef, sceneId?: string) => {
  const targetSceneId = resolveSceneId(sceneId || def.sceneId);
  if (!targetSceneId) {
    const msg = `Could not find a scene to register sky box "${def.id}" in (no current or loading scene).`;
    lerror(msg);
    throw new Error(msg);
  }
  let sceneDefs = registry.get(targetSceneId);
  if (!sceneDefs) {
    sceneDefs = new Map();
    registry.set(targetSceneId, sceneDefs);
  }
  sceneDefs.set(def.id, def);
  if (def.isDefault) {
    sceneDefaultIds.set(targetSceneId, def.id);
  } else if (sceneDefaultIds.get(targetSceneId) === def.id) {
    sceneDefaultIds.delete(targetSceneId);
  }
  createSkyBoxDebugGUI();
  return targetSceneId;
};

/** The sky box a scene starts with: the last registered with `isDefault: true`, else the first registered. */
export const getSceneDefaultSkyBoxId = (sceneId: string) => {
  const sceneDefs = registry.get(sceneId);
  if (!sceneDefs?.size) return null;
  const defaultId = sceneDefaultIds.get(sceneId);
  if (defaultId && sceneDefs.has(defaultId)) return defaultId;
  return sceneDefs.keys().next().value ?? null;
};

/** @internal Debug accessor: the registry (read it, don't change it). */
export const _getSkyBoxRegistry = (): ReadonlyMap<string, ReadonlyMap<string, SkyBoxDef>> =>
  registry;

/** Registry ids of the textures a scene's sky boxes use. */
export const getSceneSkyBoxTextureIds = (sceneId: string) =>
  [...(registry.get(sceneId)?.values() || [])]
    .map((def) => (def.base.type === 'COLOR' ? undefined : def.base.textureId))
    .filter((id): id is string => Boolean(id));

// Activation

/** The definition with its debug overrides merged in (debug env only: production never reads LS). */
const resolveSkyBoxDef = (def: SkyBoxDef, sceneId: string): SkyBoxDef => {
  if (!isDebugEnvironment()) return def;
  const allOverrides = lsGetItem(SKYBOX_DEBUG_OVERRIDES_LS_KEY, {}) as {
    [sceneId: string]: { [id: string]: SkyBoxOverrides } | undefined;
  } | null;
  const overrides = allOverrides?.[sceneId]?.[def.id];
  return overrides ? deepMerge(def, overrides) : def;
};

const applySceneProperties = (def: SkyBoxDef, isComposite: boolean) => {
  const rootScene = getRootScene() as THREE.Scene;
  rootScene.environmentIntensity =
    def.env?.environmentIntensity ?? ENV_DEFAULTS.environmentIntensity;
  rootScene.backgroundIntensity = def.env?.backgroundIntensity ?? ENV_DEFAULTS.backgroundIntensity;
  // Direct path: PMREMNode applies it to the environment; the background applies it itself
  // (layers/base.ts). Composite path: the rotation is baked into the environment already.
  const rotate =
    isComposite || def.base.type === 'COLOR' ? 0 : def.base.rotate ?? BASE_DEFAULTS.rotate;
  rootScene.environmentRotation.set(0, rotate, 0);
};

const resetSceneProperties = () => {
  const rootScene = getRootScene() as THREE.Scene | undefined;
  if (!rootScene) return;
  rootScene.backgroundNode = null;
  rootScene.environmentNode = null;
  rootScene.environmentIntensity = ENV_DEFAULTS.environmentIntensity;
  rootScene.backgroundIntensity = ENV_DEFAULTS.backgroundIntensity;
  rootScene.environmentRotation.set(0, 0, 0);
};

/** Debug only: routes every sky box through the composite path (see _setSkyCompositeForced). */
let isCompositeForced = false;

const usesComposite = (def: SkyBoxDef) =>
  hasProceduralLayer(def) || (isCompositeForced && isDebugEnvironment());

/** On the composite path, a blurred background samples the env bake (switching is a rebuild). */
const isBackgroundFromBake = (def: SkyBoxDef) =>
  (def.env?.backgroundRoughness ?? ENV_DEFAULTS.backgroundRoughness) > 0;

const isBakeDynamic = (def: SkyBoxDef) => def.env?.dynamic ?? ENV_DEFAULTS.dynamic;

type SkyBoxBuild = Pick<ActiveSkyBox, 'isComposite' | 'nodes' | 'textures'>;

/** Builds a definition's nodes (and, on the composite path, its env bake, with a bake requested). */
const buildNodes = (def: SkyBoxDef, u: SkyUniforms, texture: THREE.Texture | null): SkyBoxBuild => {
  if (!usesComposite(def)) {
    disposeEnvBake();
    const layer = buildBaseLayer(def.base, u.base, texture);
    return {
      isComposite: false,
      nodes: { background: layer.backgroundNode, environment: layer.environmentNode },
      textures: { source: layer.texture, environment: layer.environmentTexture },
    };
  }
  const sources = { basePMREM: texture ? getPMREMTexture(texture) : null };
  const bake = setEnvBake(
    def.env?.size ?? ENV_DEFAULTS.size,
    buildSkyComposite(def, u, 'ENV_BAKE', sources, normalWorldGeometry)
  );
  const background = isBackgroundFromBake(def)
    ? pmremTexture(bake.target.texture, normalWorldGeometry, u.base.backgroundRoughness)
    : buildSkyComposite(def, u, 'VIEW', sources, normalWorldGeometry);
  return {
    isComposite: true,
    nodes: { background, environment: bake.environmentNode },
    textures: { source: texture, environment: bake.target.texture },
  };
};

/** Whether going from `current` to `def` (same base) needs new nodes. */
const needsRebuild = (current: ActiveSkyBox, def: SkyBoxDef) => {
  if (usesComposite(def) !== current.isComposite) return true;
  if (!current.isComposite) return false;
  return (
    (def.env?.size ?? ENV_DEFAULTS.size) !== (current.def.env?.size ?? ENV_DEFAULTS.size) ||
    isBackgroundFromBake(def) !== isBackgroundFromBake(current.def)
  );
};

/** Makes `next` the active sky box and shows it. */
const show = (next: ActiveSkyBox) => {
  const rootScene = getRootScene() as THREE.Scene;
  rootScene.backgroundNode = next.nodes.background;
  // Typed vec3, but EnvironmentNode takes any PMREM-like node (as the three.js examples do)
  rootScene.environmentNode = next.nodes.environment as THREE.Node<'vec3'> | null;
  applySceneProperties(next.def, next.isComposite);
  active = next;
};

/** Loads, builds and shows a resolved definition. */
const activate = async (sceneId: string, def: SkyBoxDef) => {
  const seq = ++activationSeq;
  const texture = await loadBaseTexture(def.base);
  if (seq !== activationSeq) return active; // Superseded by a later activation or clear

  const uniforms = createSkyUniforms(def);
  show({ id: def.id, sceneId, def, uniforms, ...buildNodes(def, uniforms, texture) });
  notify('activate');
  return active;
};

/**
 * Shows a registered sky box of the current scene (with its debug overrides, in the debug env),
 * or none with null. When called again before an earlier call has loaded its texture, the
 * latest call wins.
 * @returns the active sky box, or null
 */
export const setActiveSkyBox = async (id: string | null, sceneId?: string) => {
  if (id === null) {
    clearSkyBox();
    return null;
  }
  const currentSceneId = getCurrentSceneId();
  const targetSceneId = sceneId || currentSceneId;
  if (!targetSceneId || targetSceneId !== currentSceneId) {
    lwarn(
      `Could not activate sky box "${id}": only the current scene's sky boxes can be shown (scene: "${targetSceneId}").`
    );
    return active;
  }
  const def = registry.get(targetSceneId)?.get(id);
  if (!def) {
    lwarn(`Could not find sky box "${id}" in scene "${targetSceneId}".`);
    return active;
  }
  return activate(targetSceneId, resolveSkyBoxDef(def, targetSceneId));
};

/** Shows a scene's default sky box (see getSceneDefaultSkyBoxId), if it has any. Called by the
 * scene loader when a scene is entered. */
export const activateSceneDefaultSkyBox = async (sceneId: string) => {
  const id = getSceneDefaultSkyBoxId(sceneId);
  if (!id) return null;
  return setActiveSkyBox(id, sceneId);
};

/** The sky box the root scene shows, or null. */
export const getActiveSkyBox = () => active;

const LEGACY_WARN = (message: string) => {
  if (isDebugEnvironment()) lwarn(message);
};

/**
 * Registers a sky box and, when it belongs to the current scene and `isDefault` isn't false,
 * shows it. While a scene loads, a sky box without a sceneId belongs to the loading scene: it's
 * only registered, and the loader shows the scene's default once the scene is entered.
 * Unlike registerSkyBox, `isDefault` defaults to true here (as the legacy `isCurrent` did), so
 * the last sky box created for a scene is its default.
 * The legacy `{ type, params }` props still work (with a dev warning).
 */
export const createSkyBox = async (defOrLegacy: SkyBoxDef | LegacySkyBoxProps) => {
  const converted = isLegacySkyBoxProps(defOrLegacy)
    ? fromLegacySkyBoxProps(defOrLegacy, LEGACY_WARN)
    : defOrLegacy;
  if (!converted) {
    // Legacy `type: ''`: "no sky box"
    const legacy = defOrLegacy as LegacySkyBoxProps;
    if (legacy.isCurrent !== false && resolveSceneId(legacy.sceneId) === getCurrentSceneId()) {
      clearSkyBox();
    }
    return null;
  }
  const def = { ...converted, isDefault: converted.isDefault ?? true };
  const sceneId = registerSkyBox(def);
  if (def.isDefault && sceneId === getCurrentSceneId()) return setActiveSkyBox(def.id, sceneId);
  return null;
};

const isStructuralBaseUpdate = (current: SkyBoxBaseDef, update: SkyBoxUpdate['base']) => {
  if (!update) return false;
  const currentValues = current as Record<string, unknown>;
  const updateValues = update as Record<string, unknown>;
  return BASE_STRUCTURAL_KEYS.some(
    (key) =>
      key in updateValues &&
      updateValues[key] !== undefined &&
      JSON.stringify(updateValues[key]) !== JSON.stringify(currentValues[key])
  );
};

/**
 * Changes the active sky box (a no-op for any other id). A change to a structural key (for the
 * base: type, file, fileNames, path, textureId, texture, colorSpace, flipY) re-runs the
 * activation; one that changes which nodes exist (on the composite path: env.size, or
 * env.backgroundRoughness crossing 0) rebuilds the nodes; any other change only writes uniforms
 * and scene properties, and (with env.dynamic) re-bakes the environment. Changes last until
 * it's activated again, which starts from its definition.
 */
export const updateSkyBox = async (id: string, update: SkyBoxUpdate) => {
  if (!active || active.id !== id) return active;
  const current = active;
  const def = deepMerge(current.def, update);
  if (isStructuralBaseUpdate(current.def.base, update.base)) return activate(current.sceneId, def);

  applySkyUniforms(current.uniforms, def);
  if (needsRebuild(current, def)) {
    show({ ...current, def, ...buildNodes(def, current.uniforms, current.textures.source) });
  } else {
    show({ ...current, def });
    // The env layer is scene properties and the view's blur, none of it baked; turning
    // `dynamic` on catches up on what changed while it was off
    const affectsBake = Object.keys(update).some((key) => key !== 'env');
    const turnedDynamic = isBakeDynamic(def) && !isBakeDynamic(current.def);
    if (current.isComposite && ((affectsBake && isBakeDynamic(def)) || turnedDynamic)) {
      requestEnvBake();
    }
  }
  notify('update');
  return active;
};

/** Removes the shown sky box (and resets the scene's environment intensity and rotation). */
export const clearSkyBox = () => {
  activationSeq++;
  active = null;
  disposeEnvBake();
  resetSceneProperties();
  notify('clear');
};

/**
 * Re-bakes the active sky box's environment on the next frame (at most one bake per frame,
 * and none while a scene loads). Only a composite sky box (procedural layers) has an env bake:
 * for any other this is a no-op. Useful with `env.dynamic: false`, which bakes only on
 * activation and rebuilds.
 */
export const bakeEnvironment = () => requestEnvBake();

/** The source texture of the sky box the root scene shows, or null. */
export const getActiveSkyBoxTexture = () => active?.textures.source ?? null;

/** The PMREM the root scene's environment samples, or null. */
export const getActiveEnvironmentTexture = () =>
  active?.nodes.environment ? active.textures.environment : null;

/** Calls `listener` whenever the active sky box is activated, updated or cleared.
 * @returns a function that removes the listener */
export const onSkyBoxChange = (listener: SkyBoxChangeListener) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

// System

ECSWorld.registerPlugin((world) => {
  // MAIN, order 1: before object3DSyncSystem (order 0), where the sky lights' transforms go
  world.addSystem(ECSSystemStage.MAIN, 'skyBoxSystem', skyBoxSystem, 1);
});

/** Runs a requested env bake (the sky box is global: only the default world drives it). */
function skyBoxSystem(world: ECSWorld) {
  if (!isEnvBakeRequested() || world !== getECSWorld() || isCurrentlyLoading()) return;
  runRequestedEnvBake();
}

// Debug

type SkyBoxGUIModule = typeof import('../Debug/_dbg__SkyBox');
let debugGUI: DebugModuleRef<SkyBoxGUIModule> | null = null;

export const registerSkyBoxDebugGUI = async () => {
  debugGUI = await loadDebugModuleAsync(() => import('../Debug/_dbg__SkyBox'));
};

/** Builds the sky box debug tab, or rebuilds (default) or refreshes it. */
export const createSkyBoxDebugGUI = (opts?: { rebuild?: boolean }) => {
  useDebug(debugGUI)?._createSkyBoxDebugGUI(opts);
};

/**
 * @internal Debug only: routes every sky box through the composite path and its env bake,
 * rebuilding the active one (session-only, to check the composite against the direct path).
 */
export const _setSkyCompositeForced = (forced: boolean) => {
  isCompositeForced = forced;
  const current = active;
  if (!current || usesComposite(current.def) === current.isComposite) return;
  show({ ...current, ...buildNodes(current.def, current.uniforms, current.textures.source) });
  notify('update');
};

/** @internal */
export const _isSkyCompositeForced = () => isCompositeForced;
