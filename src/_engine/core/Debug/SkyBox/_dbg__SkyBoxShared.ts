import { lsGetItem, lsRemoveItem, lsSetItem } from '../../../utils/LocalAndSessionStorage';
import { updateDebuggerTab } from '../../../debug/DebuggerGUI';
import { getCurrentSceneId } from '../../Scene';
import {
  _getSkyBoxRegistry,
  getActiveSkyBox,
  setActiveSkyBox,
  SKYBOX_DEBUG_OVERRIDES_LS_KEY,
  updateSkyBox,
  type SkyBoxUpdate,
} from '../../SkyBox/SkyBox';
import type { SkyBoxDef, SkyBoxOverrides } from '../../SkyBox/SkyBoxTypes';
import { BASE_DEFAULTS, ENV_DEFAULTS } from '../../SkyBox/layers/base';
import { toSkyColor } from '../../SkyBox/skyColor';
import { ATMOSPHERE_DEFAULTS } from '../../SkyBox/layers/atmosphere';
import { SUN_DEFAULTS } from '../../SkyBox/layers/sun';
import {
  AMBIENT_LIGHT_DEFAULTS,
  MOON_LIGHT_DEFAULTS,
  SUN_LIGHT_DEFAULTS,
} from '../../SkyBox/SkyLights';
import { CLOUDS_DEFAULTS } from '../../SkyBox/layers/clouds';
import { MOON_DEFAULTS } from '../../SkyBox/layers/moon';
import { STARS_DEFAULTS } from '../../SkyBox/layers/stars';
import { GROUND_DEFAULTS } from '../../SkyBox/layers/ground';
import { SHADOW_PRESETS } from '../../LightManager';
import { getEnvSize } from '../../SkyBox/SkyComposite';
import {
  _recordOrCoalesceUndoRedoAction,
  _recordUndoRedoAction,
  _registerUndoRedoActionHandler,
} from '../_dbg__UndoRedo';

export const SKYBOX_TAB_ID = 'skyBoxControls';

/** The layers the tab edits. p112-p114 add theirs here (and a folder file each). */
export type SkyBoxLayerKey =
  | 'base'
  | 'env'
  | 'atmosphere'
  | 'sun'
  | 'sunLight'
  | 'moon'
  | 'moonLight'
  | 'stars'
  | 'starsTwinkle'
  | 'milkyWay'
  | 'ambient'
  | 'clouds'
  | 'ground';

/** Where each layer lives in the definition. */
export const LAYER_PATHS: Record<SkyBoxLayerKey, string> = {
  base: 'base',
  env: 'env',
  atmosphere: 'atmosphere',
  sun: 'suns.0',
  sunLight: 'suns.0.light',
  moon: 'moons.0',
  moonLight: 'moons.0.light',
  stars: 'stars',
  starsTwinkle: 'stars.twinkle',
  milkyWay: 'stars.milkyWay',
  ambient: 'ambientLight',
  clouds: 'clouds',
  ground: 'ground',
};

/** Values a definition doesn't set fall back to these (the renderer's defaults), by path. */
const DEFAULTS_TREE = {
  base: BASE_DEFAULTS,
  env: ENV_DEFAULTS,
  atmosphere: ATMOSPHERE_DEFAULTS,
  suns: [{ ...SUN_DEFAULTS, light: SUN_LIGHT_DEFAULTS }],
  moons: [{ ...MOON_DEFAULTS, light: MOON_LIGHT_DEFAULTS }],
  stars: STARS_DEFAULTS,
  ambientLight: AMBIENT_LIGHT_DEFAULTS,
  clouds: CLOUDS_DEFAULTS,
  ground: GROUND_DEFAULTS,
};

/** A sun or moon light's bias, normal bias and map size default to its shadow preset's. */
const PRESET_KEY_PATH =
  /^((?:suns|moons)\.\d+\.light)\.(shadowBias|shadowNormalBias|shadowMapSize)$/;
const getPresetDefault = (def: SkyBoxDef | undefined, path: string) => {
  const match = PRESET_KEY_PATH.exec(path);
  if (!match) return undefined;
  const presetName = (getPath(def, `${match[1]}.shadowPreset`) ??
    SUN_LIGHT_DEFAULTS.shadowPreset) as keyof typeof SHADOW_PRESETS;
  const preset = SHADOW_PRESETS[presetName] || SHADOW_PRESETS[SUN_LIGHT_DEFAULTS.shadowPreset];
  if (match[2] === 'shadowBias') return preset.bias;
  if (match[2] === 'shadowNormalBias') return preset.normalBias;
  return preset.mapSize[0];
};

type Obj = Record<string, unknown>;
type AllOverrides = { [sceneId: string]: { [skyBoxId: string]: SkyBoxOverrides } };

const isObj = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const asObj = (value: unknown): Obj => (isObj(value) ? value : {});
const isEqual = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A value by path; array entries by index ('suns.0.elevation'). */
const getPath = (obj: unknown, path: string) =>
  path
    .split('.')
    .reduce<unknown>(
      (acc, key) => (isObj(acc) ? acc[key] : Array.isArray(acc) ? acc[Number(key)] : undefined),
      obj
    );

/** `'env.backgroundRoughness', 0.2` → `{ env: { backgroundRoughness: 0.2 } }` */
export const toSkyBoxUpdate = (path: string, value: unknown) =>
  path.split('.').reduceRight<unknown>((acc, key) => ({ [key]: acc }), value) as SkyBoxUpdate;

/** A registered definition, looked up by scene and id every time (never held on to). */
export const getSkyBoxDef = (sceneId: string, skyBoxId: string) =>
  _getSkyBoxRegistry().get(sceneId)?.get(skyBoxId);

/** The value a path has when nothing overrides it: the definition's, else the layer default.
 * A procedural layer's `enabled` defaults to whether the definition has that layer at all. */
export const getDefValue = (def: SkyBoxDef | undefined, path: string) => {
  const value = getPath(def, path);
  if (value !== undefined) return value;
  if (path.endsWith('.enabled') && path !== 'enabled') {
    return getPath(def, path.slice(0, -'.enabled'.length)) !== undefined;
  }
  // The env bake's default size depends on day-night
  if (path === 'env.size') return getEnvSize(def);
  return getPresetDefault(def, path) ?? getPath(DEFAULTS_TREE, path);
};

// Overrides (AEK_debugSkyBox): only the values changed from the definition

const readAllOverrides = () => (lsGetItem(SKYBOX_DEBUG_OVERRIDES_LS_KEY, {}) || {}) as AllOverrides;

const writeAllOverrides = (all: AllOverrides) => {
  if (Object.keys(all).length) lsSetItem(SKYBOX_DEBUG_OVERRIDES_LS_KEY, all);
  else lsRemoveItem(SKYBOX_DEBUG_OVERRIDES_LS_KEY);
};

export const getSkyBoxOverrides = (sceneId: string, skyBoxId: string) =>
  readAllOverrides()[sceneId]?.[skyBoxId];

/** Sets (or, with undefined, removes) one sky box's overrides, dropping empty scene entries. */
export const setSkyBoxOverrides = (
  sceneId: string,
  skyBoxId: string,
  overrides: SkyBoxOverrides | undefined
) => {
  const all = readAllOverrides();
  const scene = { ...all[sceneId] };
  if (overrides && Object.keys(overrides).length) scene[skyBoxId] = overrides;
  else delete scene[skyBoxId];
  if (Object.keys(scene).length) all[sceneId] = scene;
  else delete all[sceneId];
  writeAllOverrides(all);
};

/** Sets or deletes a path in a copy of `obj`, dropping objects the deletion left empty. */
const withPath = (obj: Obj, keys: string[], value: unknown, remove: boolean): Obj => {
  const [key, ...rest] = keys;
  const result = { ...obj };
  if (!rest.length) {
    if (remove) delete result[key];
    else result[key] = value;
    return result;
  }
  const child = withPath(asObj(obj[key]), rest, value, remove);
  if (Object.keys(child).length) result[key] = child;
  else delete result[key];
  return result;
};

/** Writes one override value. A value equal to the definition's is removed instead. */
export const writeSkyBoxOverride = (
  sceneId: string,
  skyBoxId: string,
  path: string,
  value: unknown
) => {
  const def = getSkyBoxDef(sceneId, skyBoxId);
  const remove = value === undefined || isEqual(value, getDefValue(def, path));
  const current = (getSkyBoxOverrides(sceneId, skyBoxId) || {}) as Obj;
  setSkyBoxOverrides(sceneId, skyBoxId, withPath(current, path.split('.'), value, remove));
};

// What the panes bind to: every edited layer value of the active sky box, synced before every
// build and refresh. Mutated in place, so the bindings stay valid across refreshes.

export const skyBoxProxy: Record<SkyBoxLayerKey, Obj> & { select: { skyBoxId: string } } = {
  select: { skyBoxId: '' },
  base: {},
  env: {},
  atmosphere: {},
  sun: {},
  sunLight: {},
  moon: {},
  moonLight: {},
  stars: {},
  starsTwinkle: {},
  milkyWay: {},
  ambient: {},
  clouds: {},
  ground: {},
};

/** The keys a layer folder binds, synced from the active sky box (and its layer defaults). */
const PROXY_KEYS: Record<SkyBoxLayerKey, string[]> = {
  base: ['type', 'file', 'path', 'textureId', 'colorSpace', 'rotate', 'flipY', 'intensity'],
  env: [
    'backgroundRoughness',
    'backgroundIntensity',
    'environmentIntensity',
    'size',
    'dynamic',
    'updateAngleDeg',
    'maxUpdatesPerSec',
  ],
  atmosphere: [
    'enabled',
    'turbidity',
    'rayleigh',
    'mieCoefficient',
    'mieDirectionalG',
    'exposure',
    'sunIntensity',
    'twilightLength',
  ],
  sun: [
    'enabled',
    'elevation',
    'azimuth',
    'discSize',
    'discIntensity',
    'glowIntensity',
    'glowSize',
  ],
  sunLight: [
    'enabled',
    'intensity',
    'castShadow',
    'shadowPreset',
    'shadowBias',
    'shadowNormalBias',
    'shadowMapSize',
    'shadowFrustumSize',
    'distance',
    'shadowFollow',
  ],
  moon: [
    'enabled',
    'elevation',
    'azimuth',
    'discSize',
    'intensity',
    'limbDarkening',
    'earthshine',
    'phase',
    'phaseMode',
    'lunarCycleDays',
    'inclination',
  ],
  moonLight: [
    'enabled',
    'intensity',
    'castShadow',
    'shadowPreset',
    'shadowBias',
    'shadowNormalBias',
    'shadowMapSize',
    'shadowFrustumSize',
    'distance',
    'shadowFollow',
  ],
  stars: ['enabled', 'density', 'brightness', 'size', 'colorVariance', 'rotateWithSky', 'seed'],
  starsTwinkle: ['amount', 'frequency'],
  milkyWay: ['enabled', 'intensity', 'width'],
  ambient: ['enabled', 'type', 'intensity'],
  clouds: ['enabled', 'coverage', 'density', 'scale', 'speed', 'elevation'],
  ground: ['enabled', 'horizonBlend', 'height', 'useAtmosphereHorizon'],
};
/** 2-tuples, bound as `${key}0` and `${key}1`. */
const TUPLE_KEYS: Partial<Record<SkyBoxLayerKey, string[]>> = {
  sunLight: ['horizonFade'],
  moonLight: ['horizonFade'],
  stars: ['fadeRange'],
  clouds: ['windDirection'],
};
/** Read-only text bindings need a string, even when the definition has no value. */
const TEXT_KEYS = new Set(['type', 'file', 'path', 'textureId', 'colorSpace']);
/** Colour keys, bound as '#rrggbb'. */
const COLOR_KEYS: Partial<Record<SkyBoxLayerKey, string[]>> = {
  atmosphere: ['horizonTint', 'zenithTint'],
  moon: ['color'],
  clouds: ['color'],
  ground: ['color'],
};
/** 'AUTO' or a colour: bound as `${key}Mode` ('AUTO' | 'CUSTOM') and `${key}` (a colour, the
 * last custom one or this fallback). */
const AUTO_COLOR_KEYS: Partial<Record<SkyBoxLayerKey, Record<string, string>>> = {
  atmosphere: { nightSkyColor: '#0c0c0c' },
  sun: { color: '#fff4e0' },
  sunLight: { color: '#fff4e0' },
  moonLight: { color: '#b8c6ff' },
  ambient: { skyColor: '#9ec9ff', groundColor: '#3b3a36' },
};

/** A ColorJSON as '#rrggbb' (sRGB). */
const toHex = (value: unknown) =>
  `#${toSkyColor(value as string | { r: number; g: number; b: number }).getHexString()}`;

export const NO_SKYBOX_ID = '__noSkyBox';

export const syncSkyBoxProxy = () => {
  const active = getActiveSkyBox();
  skyBoxProxy.select.skyBoxId = active?.id ?? NO_SKYBOX_ID;
  for (const layer of Object.keys(PROXY_KEYS) as SkyBoxLayerKey[]) {
    const layerPath = LAYER_PATHS[layer];
    const proxy = skyBoxProxy[layer];
    for (const key of PROXY_KEYS[layer]) {
      const value = getDefValue(active?.def, `${layerPath}.${key}`);
      proxy[key] = TEXT_KEYS.has(key) ? String(value ?? '') : value;
    }
    for (const key of COLOR_KEYS[layer] || []) {
      proxy[key] = toHex(getDefValue(active?.def, `${layerPath}.${key}`));
    }
    for (const key of TUPLE_KEYS[layer] || []) {
      const [first, second] = getDefValue(active?.def, `${layerPath}.${key}`) as [number, number];
      proxy[`${key}0`] = first;
      proxy[`${key}1`] = second;
    }
    for (const [key, fallback] of Object.entries(AUTO_COLOR_KEYS[layer] || {})) {
      const value = getDefValue(active?.def, `${layerPath}.${key}`);
      proxy[`${key}Mode`] = value === 'AUTO' ? 'AUTO' : 'CUSTOM';
      // Keep the picker's last custom colour while on AUTO
      if (value !== 'AUTO') proxy[key] = toHex(value);
      else if (typeof proxy[key] !== 'string') proxy[key] = fallback;
    }
  }
  const base = active?.def.base;
  skyBoxProxy.base.fileNames = base?.type === 'CUBE_TEXTURE' ? base.fileNames.join('\n') : '';
  skyBoxProxy.base.color = base?.type === 'COLOR' ? base.color : '#000000';
};

// Undo/redo. The handlers resolve the sky box by scene and id every time.

type SkyBoxParamPayload = {
  sceneId: string;
  skyBoxId: string;
  /** A layer value's path in the definition, eg. 'env.backgroundRoughness'. */
  path: string;
  prev: unknown;
  next: unknown;
};
type SkyBoxResetLayerPayload = {
  sceneId: string;
  skyBoxId: string;
  /** The layer's path in the definition (LAYER_PATHS). */
  layer: string;
  /** The layer's override subtree before the reset. */
  prev: Obj | undefined;
};

const isActive = (sceneId: string, skyBoxId: string) => {
  const active = getActiveSkyBox();
  return active?.id === skyBoxId && active.sceneId === sceneId;
};

/** Refreshes the tab when a change can't reach it through SkyBox.ts (an inactive sky box). */
const refreshTab = () => updateDebuggerTab(SKYBOX_TAB_ID);

/** Writes a param to the override store and, when that sky box is showing, to the render. */
const applyParam = async (sceneId: string, skyBoxId: string, path: string, value: unknown) => {
  writeSkyBoxOverride(sceneId, skyBoxId, path, value);
  if (isActive(sceneId, skyBoxId)) await updateSkyBox(skyBoxId, toSkyBoxUpdate(path, value));
  else refreshTab();
};

/** Tweakpane's step snapping leaves float noise (0.49999999999999994): keep 6 decimals, so the
 * stored and copied values stay clean. */
const roundNumber = (value: unknown) =>
  typeof value === 'number' ? Math.round(value * 1e6) / 1e6 : value;

/**
 * Sets a layer value of the active sky box from a binding: renders it, stores it as an override
 * and records it for undo (ticks of one drag coalesce). `label` names it in the undo history.
 */
export const setSkyBoxParam = (
  path: string,
  label: string,
  rawValue: unknown,
  e: { prev: unknown }
) => {
  const active = getActiveSkyBox();
  if (!active) return;
  const { sceneId, id: skyBoxId } = active;
  const value = roundNumber(rawValue);
  const prev = roundNumber(e.prev);
  void applyParam(sceneId, skyBoxId, path, value);
  if (isEqual(prev, value)) return;
  _recordOrCoalesceUndoRedoAction<SkyBoxParamPayload>(
    'skybox.param',
    `Sky box ${skyBoxId}: ${label}`,
    { sceneId, skyBoxId, path, prev, next: value },
    `${sceneId}.${skyBoxId}.${path}`
  );
};

/** Sets a layer's override subtree, and renders the result when that sky box is showing:
 * every key the change touches gets its overridden value, or else the definition's. */
const applyLayerOverride = async (
  sceneId: string,
  skyBoxId: string,
  layerPath: string,
  layerOverride: Obj | undefined
) => {
  const current = (getSkyBoxOverrides(sceneId, skyBoxId) || {}) as Obj;
  const touchedKeys = new Set([
    ...Object.keys(asObj(getPath(current, layerPath))),
    ...Object.keys(layerOverride || {}),
  ]);
  setSkyBoxOverrides(
    sceneId,
    skyBoxId,
    withPath(
      current,
      layerPath.split('.'),
      layerOverride,
      !layerOverride || !Object.keys(layerOverride).length
    )
  );
  if (!isActive(sceneId, skyBoxId)) {
    refreshTab();
    return;
  }
  // A nested layer (eg. a sun's light) can't be "set back" key by key when the definition
  // doesn't have it: activate again from the definition and the remaining overrides instead
  const prevLayer = asObj(getPath(current, layerPath));
  if ([...touchedKeys].some((key) => isObj(prevLayer[key]) || isObj(layerOverride?.[key]))) {
    await setActiveSkyBox(skyBoxId, sceneId);
    return;
  }
  const def = getSkyBoxDef(sceneId, skyBoxId);
  const layerUpdate: Obj = {};
  for (const key of touchedKeys) {
    layerUpdate[key] = layerOverride?.[key] ?? getDefValue(def, `${layerPath}.${key}`);
  }
  await updateSkyBox(skyBoxId, toSkyBoxUpdate(layerPath, layerUpdate));
};

/** "Reset layer": drops the active sky box's overrides of one layer (undoable). */
export const resetSkyBoxLayer = (layer: SkyBoxLayerKey) => {
  const active = getActiveSkyBox();
  if (!active) return;
  const { sceneId, id: skyBoxId } = active;
  const layerPath = LAYER_PATHS[layer];
  const prev = getPath(getSkyBoxOverrides(sceneId, skyBoxId), layerPath) as Obj | undefined;
  void applyLayerOverride(sceneId, skyBoxId, layerPath, undefined);
  if (!prev || !Object.keys(prev).length) return;
  _recordUndoRedoAction<SkyBoxResetLayerPayload>(
    'skybox.resetLayer',
    `Sky box ${skyBoxId}: reset ${layer}`,
    { sceneId, skyBoxId, layer: layerPath, prev }
  );
};

_registerUndoRedoActionHandler<SkyBoxParamPayload>('skybox.param', {
  undo: ({ sceneId, skyBoxId, path, prev }) => applyParam(sceneId, skyBoxId, path, prev),
  redo: ({ sceneId, skyBoxId, path, next }) => applyParam(sceneId, skyBoxId, path, next),
});
_registerUndoRedoActionHandler<SkyBoxResetLayerPayload>('skybox.resetLayer', {
  undo: ({ sceneId, skyBoxId, layer, prev }) => applyLayerOverride(sceneId, skyBoxId, layer, prev),
  redo: ({ sceneId, skyBoxId, layer }) => applyLayerOverride(sceneId, skyBoxId, layer, undefined),
});

/** Whether the current scene has any sky box overrides stored. */
export const currentSceneHasOverrides = () => {
  const sceneId = getCurrentSceneId();
  return Boolean(sceneId && readAllOverrides()[sceneId]);
};

/** Scene ids that have overrides stored. */
export const getSceneIdsWithOverrides = () => Object.keys(readAllOverrides());

/** Removes the stored overrides of these scenes. */
export const clearSkyBoxOverrides = (sceneIds: string[]) => {
  const all = readAllOverrides();
  for (const sceneId of sceneIds) delete all[sceneId];
  writeAllOverrides(all);
};

// One-time migration of the pre-p111 key (a full copy of each sky box's flat state)

const LEGACY_LS_KEY = 'AEK_debugSkyBoxStates';

type LegacySkyBoxState = {
  type?: string;
  equiRectRoughness?: number;
  cubeTextRoughness?: number;
};

/**
 * Moves each saved background roughness that isn't zero and differs from its definition into
 * AEK_debugSkyBox, then removes the old key. Nothing else in it is worth keeping (the selection
 * is session-only). A sky box created in code isn't registered yet at this point, so its value
 * is compared to the default (0) only.
 */
export const migrateLegacySkyBoxLS = () => {
  const legacy = lsGetItem(LEGACY_LS_KEY, {}) as {
    [sceneId: string]: { [id: string]: LegacySkyBoxState } | null;
  } | null;
  if (!legacy || !Object.keys(legacy).length) {
    lsRemoveItem(LEGACY_LS_KEY);
    return;
  }
  for (const [sceneId, states] of Object.entries(legacy)) {
    for (const [skyBoxId, state] of Object.entries(states || {})) {
      const roughness =
        state?.type === 'CUBETEXTURE' ? state.cubeTextRoughness : state?.equiRectRoughness;
      if (
        !roughness ||
        getSkyBoxOverrides(sceneId, skyBoxId)?.env?.backgroundRoughness !== undefined
      ) {
        continue;
      }
      writeSkyBoxOverride(sceneId, skyBoxId, 'env.backgroundRoughness', roughness);
    }
  }
  lsRemoveItem(LEGACY_LS_KEY);
};
