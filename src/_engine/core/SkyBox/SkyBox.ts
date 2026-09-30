import * as THREE from 'three/webgpu';
import { normalWorldGeometry, pmremTexture } from 'three/tsl';
import { lerror, lwarn } from '../../utils/Logger';
import { getCurrentSceneId, getRootScene } from '../Scene';
import { getNextSceneId, isCurrentlyLoading } from '../SceneLoader';
import { isDebugEnvironment } from '../Config';
import { lsGetItem } from '../../utils/LocalAndSessionStorage';
import { DebugModuleRef, loadDebugModuleAsync, useDebug } from '../../utils/helpers';
import { deepMerge, isIndexObject } from '../../utils/deepMerge';
import { ECSWorld, getECSWorld } from '../ECS';
import { getRenderer } from '../Renderer';
import { ECSSystemStage } from '../../../AppECSRegistry';
import { getElapsedTime, isAppPlaying } from '../MainLoop';
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
  applySkyTimeUniforms,
  applySkyUniforms,
  buildSkyComposite,
  computeMoonDirectionOf,
  computeSunDirectionOf,
  createSkyUniforms,
  getCompositeSignature,
  getEnvSize,
  getMoonCount,
  getSunCount,
  getStaticLayersSourceOf,
  hasProceduralLayer,
  isAtmosphereEnabled,
  isDayNightEnabled,
  isOn,
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
import {
  disposeStaticLayers,
  requestStaticLayersBake,
  runRequestedStaticLayersBake,
  setStaticLayers,
} from './SkyStaticLayers';
import {
  deleteSkyLights,
  syncSkyLights,
  updateSkyLightsForTime,
  updateSkyLightsFrame,
} from './SkyLights';
import { loadMoonTexture, MAX_MOONS } from './layers/moon';
import { MAX_SUNS } from './layers/sun';
import {
  advanceSkyTime,
  applyDayNightChange,
  createSkyTimeState,
  DAY_NIGHT_DEFAULTS,
  getMoonPhaseOf,
  resetSkyTimeState,
  setSkyTimeMoonPhase,
  wrap24,
  type SkyTimeState,
} from './SkyTime';

export type { SkyBoxDef } from './SkyBoxTypes';
export {
  resolveSkyBoxPreset,
  SKYBOX_PRESET_NAMES,
  type SkyBoxPresetDef,
  type SkyBoxPresetName,
} from './presets';

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
  /** The base's source texture, the PMREM the environment samples (the texture's, or the env
   * bake's target), and each moon's texture (by index). */
  textures: {
    source: THREE.Texture | null;
    environment: THREE.Texture | null;
    moons: (THREE.Texture | null)[];
  };
  /** The day-night cycle's runtime time (used while `def.dayNight` is on). Games drive it
   * through setTimeOfDay etc.; it's never written to the definition. */
  time: SkyTimeState;
};

/** A change to the active sky box: any subset of its layers' values. */
export type SkyBoxUpdate = {
  base?: NonNullable<SkyBoxOverrides['base']> & { texture?: THREE.Texture };
  env?: SkyBoxEnvDef;
  atmosphere?: SkyBoxOverrides['atmosphere'];
  /** An array replaces the suns; an index object (`{ 0: { ... } }`) changes those entries.
   * Adding or removing one rebuilds the nodes. */
  suns?: SkyBoxOverrides['suns'];
  /** As `suns`. A change to a moon's texture reloads the sky box; one to its phase also sets
   * its running phase. */
  moons?: SkyBoxOverrides['moons'];
  /** As `suns`. A change re-bakes the nebula cube (throttled: at most every 150 ms). */
  nebulae?: SkyBoxOverrides['nebulae'];
  ambientLight?: SkyBoxOverrides['ambientLight'];
  clouds?: SkyBoxOverrides['clouds'];
  ground?: SkyBoxOverrides['ground'];
  /** Its runtime keys (timeOfDay, speed, cycleDurationSec, playing) also set the running
   * cycle's; turning it on starts the cycle from the definition's values. */
  dayNight?: SkyBoxOverrides['dayNight'];
};

export type SkyBoxChangeReason = 'activate' | 'update' | 'clear';
type SkyBoxChangeListener = (active: ActiveSkyBox | null, reason: SkyBoxChangeReason) => void;

export { SKYBOX_MANAGER_ID } from './SkyLights';

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
  if ('preset' in def && isDebugEnvironment()) {
    lwarn(
      `Sky box "${def.id}" still has a preset, which is ignored here: pass the definition through resolveSkyBoxPreset first (JSON sky boxes are resolved at build time).`
    );
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

/** Registry ids of the textures a scene's sky boxes use (their bases' and moons'). */
export const getSceneSkyBoxTextureIds = (sceneId: string) =>
  [...(registry.get(sceneId)?.values() || [])]
    .flatMap((def) => [
      def.base.type === 'COLOR' ? undefined : def.base.textureId,
      ...(def.moons?.slice(0, MAX_MOONS).map((moon) => moon.texture?.textureId) ?? []),
    ])
    .filter((id): id is string => Boolean(id));

// Activation

/** The definition with its debug overrides merged in (debug env only: production never reads LS). */
const resolveSkyBoxDef = (def: SkyBoxDef, sceneId: string): SkyBoxDef => {
  if (!isDebugEnvironment()) return def;
  const allOverrides = lsGetItem(SKYBOX_DEBUG_OVERRIDES_LS_KEY, {}) as {
    [sceneId: string]: { [id: string]: SkyBoxOverrides } | undefined;
  } | null;
  const overrides = allOverrides?.[sceneId]?.[def.id];
  return overrides ? mergeSkyBoxDef(def, overrides) : def;
};

/** An index object left where an array goes (nothing to merge into), as the array. */
const toArray = <T extends object>(value: T[] | Record<string, T>): T[] => {
  if (!isIndexObject(value)) return value as T[];
  const entries: T[] = [];
  for (const [index, entry] of Object.entries(value)) entries[Number(index)] = entry;
  return Array.from(entries, (entry) => entry ?? ({} as T));
};

/** A definition with a change merged in. An index object merges into the suns (or moons,
 * nebulae) array, and one with none to merge into becomes the array (eg. a debug override
 * turning suns[0] on). */
const mergeSkyBoxDef = (def: SkyBoxDef, change: unknown): SkyBoxDef => {
  const merged = deepMerge(def, change);
  if (merged.suns) merged.suns = toArray(merged.suns);
  if (merged.moons) merged.moons = toArray(merged.moons);
  if (merged.nebulae) merged.nebulae = toArray(merged.nebulae);
  return merged;
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

/** On the composite path, a blurred background samples the env bake (switching is a rebuild). */
const isBackgroundFromBake = (def: SkyBoxDef) =>
  (def.env?.backgroundRoughness ?? ENV_DEFAULTS.backgroundRoughness) > 0;

const isBakeDynamic = (def: SkyBoxDef) => def.env?.dynamic ?? ENV_DEFAULTS.dynamic;

type SkyBoxBuild = Pick<ActiveSkyBox, 'isComposite' | 'nodes' | 'textures'>;

/** Builds a definition's nodes (and, on the composite path, its env bake, with a bake requested). */
const buildNodes = (
  def: SkyBoxDef,
  u: SkyUniforms,
  texture: THREE.Texture | null,
  moonTextures: (THREE.Texture | null)[]
): SkyBoxBuild => {
  if (!hasProceduralLayer(def)) {
    disposeEnvBake();
    disposeStaticLayers();
    const layer = buildBaseLayer(def.base, u.base, texture);
    return {
      isComposite: false,
      nodes: { background: layer.backgroundNode, environment: layer.environmentNode },
      textures: { source: layer.texture, environment: layer.environmentTexture, moons: [] },
    };
  }
  // Before the composites: they sample its cube
  const staticSource = getStaticLayersSourceOf(def, u);
  const staticLayers = staticSource ? setStaticLayers(staticSource).target.texture : null;
  if (!staticSource) disposeStaticLayers();
  const sources = {
    basePMREM: texture ? getPMREMTexture(texture) : null,
    moonTextures,
    staticLayers,
  };
  const bake = setEnvBake(
    getEnvSize(def),
    buildSkyComposite(def, u, 'ENV_BAKE', sources, normalWorldGeometry)
  );
  const background = isBackgroundFromBake(def)
    ? pmremTexture(bake.target.texture, normalWorldGeometry, u.base.backgroundRoughness)
    : buildSkyComposite(def, u, 'VIEW', sources, normalWorldGeometry);
  return {
    isComposite: true,
    nodes: { background, environment: bake.environmentNode },
    textures: { source: texture, environment: bake.target.texture, moons: moonTextures },
  };
};

/** Whether going from `current` to `def` (same base) needs new nodes. */
const needsRebuild = (current: ActiveSkyBox, def: SkyBoxDef) => {
  if (hasProceduralLayer(def) !== current.isComposite) return true;
  if (!current.isComposite) return false;
  return (
    getCompositeSignature(def) !== getCompositeSignature(current.def) ||
    getEnvSize(def) !== getEnvSize(current.def) ||
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
  syncSkyLights(next.id, next.def, next.uniforms);
};

/** Loads, builds and shows a resolved definition. `time` carries a running cycle's time over
 * (a structural update of the same sky box); without it, the cycle starts from the definition. */
const activate = async (sceneId: string, def: SkyBoxDef, time?: SkyTimeState) => {
  const seq = ++activationSeq;
  const [texture, ...moonTextures] = await Promise.all([
    loadBaseTexture(def.base),
    ...Array.from({ length: getMoonCount(def) }, (_, i) => loadMoonTexture(def.moons?.[i])),
  ]);
  if (seq !== activationSeq) return active; // Superseded by a later activation or clear

  if (isOn(def.clouds) && !isAtmosphereEnabled(def) && isDebugEnvironment()) {
    lwarn(`Sky box "${def.id}": clouds need an enabled atmosphere, they are left out.`);
  }
  // A definition made in code isn't validated by the schema
  if ((def.suns?.length ?? 0) > MAX_SUNS && isDebugEnvironment()) {
    lwarn(`Sky box "${def.id}": only ${MAX_SUNS} suns are drawn, the others are ignored.`);
  }
  if ((def.moons?.length ?? 0) > MAX_MOONS && isDebugEnvironment()) {
    lwarn(`Sky box "${def.id}": only ${MAX_MOONS} moons are drawn, the others are ignored.`);
  }
  const skyTime = time ?? createSkyTimeState(def);
  const uniforms = createSkyUniforms(def, skyTime);
  show({
    id: def.id,
    sceneId,
    def,
    uniforms,
    time: skyTime,
    ...buildNodes(def, uniforms, texture, moonTextures),
  });
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
 * base: type, file, fileNames, path, textureId, texture, colorSpace, flipY; a moon's texture) re-runs the
 * activation; one that changes which nodes exist (on the composite path: env.size, or
 * env.backgroundRoughness crossing 0; which suns, moons and their lights exist; which nebulae
 * exist, their octaves, env.nebulaSize)
 * rebuilds the nodes; any other change only writes uniforms and scene properties, and (with
 * env.dynamic) re-bakes the environment (a nebula change re-bakes the nebula cube first). Changes last until
 * it's activated again, which starts from its definition.
 */
export const updateSkyBox = async (id: string, update: SkyBoxUpdate) => {
  if (!active || active.id !== id) return active;
  const current = active;
  const def = mergeSkyBoxDef(current.def, update);
  if (update.dayNight) {
    if (isDayNightEnabled(def) && !isDayNightEnabled(current.def)) {
      resetSkyTimeState(current.time, def);
    } else {
      applyDayNightChange(current.time, update.dayNight);
    }
  }
  for (let i = 0; i < getMoonCount(def); i++) {
    const moonPhase = def.moons?.[i]?.phase;
    if (moonPhase !== undefined && moonPhase !== current.def.moons?.[i]?.phase) {
      setSkyTimeMoonPhase(current.time, i, moonPhase);
    }
  }
  // Only the moons with a texture: adding or removing a plain moon is a rebuild, not a reload
  const moonTexturesOf = (d: SkyBoxDef) =>
    JSON.stringify(
      d.moons?.slice(0, MAX_MOONS).flatMap((moon, i) => (moon.texture ? [[i, moon.texture]] : []))
    );
  if (
    isStructuralBaseUpdate(current.def.base, update.base) ||
    moonTexturesOf(def) !== moonTexturesOf(current.def)
  ) {
    return activate(current.sceneId, def, current.time);
  }

  applySkyUniforms(current.uniforms, def, current.time);
  if (needsRebuild(current, def)) {
    show({
      ...current,
      def,
      ...buildNodes(def, current.uniforms, current.textures.source, current.textures.moons),
    });
  } else {
    show({ ...current, def });
    // A drag re-bakes the nebulae at most every 150 ms; the env bake follows each of those
    if (update.nebulae) requestStaticLayersBake(true);
    // The env layer is scene properties and the view's blur, none of it baked; turning
    // `dynamic` on catches up on what changed while it was off
    const affectsBake = Object.keys(update).some((key) => key !== 'env' && key !== 'nebulae');
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
  disposeStaticLayers();
  deleteSkyLights();
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

// Day-night (p113). Runtime only: nothing here writes the definition or the debug overrides.
// The setters are no-ops without an active sky box with day-night on.

/** The active sky box's day-night time, or null (no sky box, or day-night off). */
const getSkyTime = () => (active && isDayNightEnabled(active.def) ? active.time : null);

/**
 * Sets the time of day (hours, wrapped into [0, 24)). The sky, sun and lights follow on the
 * next frame, whether the cycle is playing or not.
 */
export const setTimeOfDay = (hours: number) => {
  const time = getSkyTime();
  if (!time || !Number.isFinite(hours)) return;
  time.timeOfDay = wrap24(hours);
  time.isDirty = true;
};

/** The time of day in hours [0, 24), or null without day-night. */
export const getTimeOfDay = () => getSkyTime()?.timeOfDay ?? null;

/** Runs the day-night cycle (it advances with its `timeSource`). */
export const playDayNight = () => {
  const time = getSkyTime();
  if (time) time.playing = true;
};

/** Stops the day-night cycle where it is (setTimeOfDay still moves it). */
export const pauseDayNight = () => {
  const time = getSkyTime();
  if (time) time.playing = false;
};

export const isDayNightPlaying = () => Boolean(getSkyTime()?.playing);

/** Sets the cycle's time multiplier: negative runs it backwards, 0 freezes it. */
export const setDayNightSpeed = (multiplier: number) => {
  const time = getSkyTime();
  if (!time || !Number.isFinite(multiplier)) return;
  // Reversing catches the environment up once (a stop does too, see scheduleDayNightBake)
  if (multiplier * time.speed < 0) needsCatchUpBake = true;
  time.speed = multiplier;
};

/** The cycle's time multiplier, or null without day-night. */
export const getDayNightSpeed = () => getSkyTime()?.speed ?? null;

/** Sets how many real seconds 24 in-game hours take (at speed 1). */
export const setDayNightCycleDuration = (seconds: number) => {
  const time = getSkyTime();
  if (time && Number.isFinite(seconds) && seconds > 0) time.cycleDurationSec = seconds;
};

/**
 * The unit world direction toward a sun, into `out` (with day-night on, for the current time
 * of day, including a setTimeOfDay made this frame). suns[0]'s is there without any suns too:
 * it's the atmosphere's.
 * @returns `out`, or null (no active sky box, or no such sun)
 */
export const getSunDirection = (out: THREE.Vector3, i = 0) => {
  if (!active || i < 0 || (i > 0 && i >= getSunCount(active.def))) return null;
  return computeSunDirectionOf(active.def, i, active.time.timeOfDay, out);
};

const _sunDirection = new THREE.Vector3();

/** A sun's elevation above the horizon in radians (negative below it), or null (see
 * getSunDirection). */
export const getSunElevation = (i = 0) => {
  const direction = getSunDirection(_sunDirection, i);
  return direction ? Math.asin(THREE.MathUtils.clamp(direction.y, -1, 1)) : null;
};

// Budgeted re-bakes while the cycle moves (p110 §0.3): a re-bake once the sky has turned more
// than env.updateAngleDeg since the last bake, at most env.maxUpdatesPerSec, plus one bake to
// catch up when it stops (pause, speed 0, the end of a scrub or a one-off setTimeOfDay) or
// reverses. A cycle that keeps playing after a setTimeOfDay jump catches up within the rate
// cap (bakeEnvironment() bakes on the next frame). env.dynamic: false turns all of it off.

/** The sun's and moon's directions the last env bake saw (any bake), and when it ran
 * (performance.now). */
const lastBakeSunDir = new THREE.Vector3();
const lastBakeMoonDir = new THREE.Vector3();
let lastBakeTimeMs = -Infinity;
/** Whether the time moved on the previous day-night step. */
let wasTimeMoving = false;
/** Set when the cycle reverses: the next step bakes once to catch up. */
let needsCatchUpBake = false;
/** Any movement at all counts for the catch-up bake. */
const CATCH_UP_ANGLE_COS = Math.cos(THREE.MathUtils.degToRad(0.01));

/** Whether the sun or the moon has turned further from the last bake's direction than
 * `angleCos` (a cosine). */
const hasSkyTurnedSinceBake = (u: SkyUniforms, angleCos: number) =>
  // The primary sun and moon only: the extra suns turn with the sky and the second moon moves
  // like the first (by the time of day), about as fast
  u.suns[0].direction.value.dot(lastBakeSunDir) < angleCos ||
  u.moons[0].direction.value.dot(lastBakeMoonDir) < angleCos;

const scheduleDayNightBake = (current: ActiveSkyBox, moved: boolean) => {
  const def = current.def;
  if (!current.isComposite || !isBakeDynamic(def)) return;
  if (moved && !needsCatchUpBake) {
    const maxPerSec = def.env?.maxUpdatesPerSec ?? ENV_DEFAULTS.maxUpdatesPerSec;
    if (maxPerSec <= 0 || performance.now() - lastBakeTimeMs < 1000 / maxPerSec) return;
    const angleDeg = def.env?.updateAngleDeg ?? ENV_DEFAULTS.updateAngleDeg;
    if (hasSkyTurnedSinceBake(current.uniforms, Math.cos(THREE.MathUtils.degToRad(angleDeg)))) {
      requestEnvBake();
    }
    return;
  }
  if (!wasTimeMoving && !needsCatchUpBake) return;
  needsCatchUpBake = false;
  if (hasSkyTurnedSinceBake(current.uniforms, CATCH_UP_ANGLE_COS)) requestEnvBake();
};

/** Records what a bake that just ran saw (for the day-night bake rules). */
const noteEnvBake = () => {
  if (!active) return;
  lastBakeSunDir.copy(active.uniforms.suns[0].direction.value);
  lastBakeMoonDir.copy(active.uniforms.moons[0].direction.value);
  lastBakeTimeMs = performance.now();
};

/**
 * The unit world direction toward a moon, into `out` (with day-night on, for the current time
 * and its phase).
 * @returns `out`, or null (no active sky box, or no such moon)
 */
export const getMoonDirection = (out: THREE.Vector3, i = 0) => {
  if (!active || i < 0 || i >= getMoonCount(active.def)) return null;
  return computeMoonDirectionOf(active.def, i, active.time, out);
};

/** A moon's phase in [0, 1) (0 new, 0.5 full): with day-night, the running one (a 'CYCLE' moon
 * advances with the days). Null without an active sky box or such a moon. */
export const getMoonPhase = (i = 0) => {
  if (!active || i < 0 || i >= getMoonCount(active.def)) return null;
  return getMoonPhaseOf(active.def, active.time, isDayNightEnabled(active.def), i);
};

/** Last frame's getElapsedTime: the day-night step advances by the difference, which (unlike
 * the MAIN delta) is 0 on the frame the master loop pauses and the frame it resumes. */
let lastElapsedTime = 0;

const isTimeSourceRunning = (def: SkyBoxDef) => {
  const source = def.dayNight?.timeSource ?? DAY_NIGHT_DEFAULTS.timeSource;
  return source === 'MAIN' || (source === 'APP' && isAppPlaying());
};

/**
 * Advances the active sky box's day-night time and, when it changed, writes the sun-dependent
 * uniforms and lights. Stands still while a scene loads, so a scene starts at its start time.
 * Allocates nothing.
 */
const stepDayNight = (world: ECSWorld) => {
  const elapsed = getElapsedTime();
  const dt = elapsed - lastElapsedTime;
  lastElapsedTime = elapsed;
  const current = active;
  if (!current || !isDayNightEnabled(current.def) || isCurrentlyLoading()) return;
  const time = current.time;
  if (isTimeSourceRunning(current.def) && advanceSkyTime(time, dt, current.def)) {
    time.isDirty = true;
  }
  const moved = time.isDirty;
  if (moved) {
    time.isDirty = false;
    applySkyTimeUniforms(current.uniforms, current.def, time);
    updateSkyLightsForTime(current.def, current.uniforms, world);
  }
  scheduleDayNightBake(current, moved);
  wasTimeMoving = moved;
};

// System

ECSWorld.registerPlugin((world) => {
  // MAIN, order 1: before object3DSyncSystem (order 0), where the sky lights' transforms go
  world.addSystem(ECSSystemStage.MAIN, 'skyBoxSystem', skyBoxSystem, 1);
});

/** Steps the day-night cycle, moves the sky lights with their follow point, and runs a
 * requested static-layer bake and then env bake (it samples the static layers), never while a
 * scene loads. The sky box is global: only the default world drives it. */
function skyBoxSystem(world: ECSWorld) {
  if (world !== getECSWorld()) return;
  stepDayNight(world);
  updateSkyLightsFrame(world);
  if (isCurrentlyLoading()) return;
  // The environment follows the static layers (activation requests both anyway)
  if (runRequestedStaticLayersBake() && active && isBakeDynamic(active.def)) requestEnvBake();
  if (!isEnvBakeRequested()) return;
  // The bake's clouds are frozen where the view's are now
  if (active) active.uniforms.clouds.bakeTime.value = getFrameTime();
  if (runRequestedEnvBake()) noteEnvBake();
}

/** three's `time` node value (the renderer's node frame time, in seconds). */
const getFrameTime = () =>
  (getRenderer() as unknown as { _nodes?: { nodeFrame?: { time?: number } } } | undefined)?._nodes
    ?.nodeFrame?.time ?? 0;

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
