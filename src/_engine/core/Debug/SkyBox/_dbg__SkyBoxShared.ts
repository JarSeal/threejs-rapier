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
import { MAX_SUNS, SUN_DEFAULTS } from '../../SkyBox/layers/sun';
import {
  AMBIENT_LIGHT_DEFAULTS,
  EXTRA_SUN_LIGHT_DEFAULTS,
  MOON_LIGHT_DEFAULTS,
  SUN_LIGHT_DEFAULTS,
} from '../../SkyBox/SkyLights';
import { CLOUDS_DEFAULTS } from '../../SkyBox/layers/clouds';
import { MAX_MOONS, MOON_DEFAULTS } from '../../SkyBox/layers/moon';
import { STARS_DEFAULTS } from '../../SkyBox/layers/stars';
import { DAY_NIGHT_DEFAULTS } from '../../SkyBox/SkyTime';
import { getMoonPhase } from '../../SkyBox/SkyBox';
import { isDayNightEnabled } from '../../SkyBox/SkyComposite';
import { GROUND_DEFAULTS } from '../../SkyBox/layers/ground';
import { MAX_NEBULAE, NEBULA_DEFAULTS } from '../../SkyBox/layers/nebula';
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
  | 'dayNight'
  | 'ambient'
  | 'clouds'
  | 'ground'
  | 'nebula';

/** Where each layer lives in the definition. A list entry's layers point at the selected entry
 * (selectListEntry). */
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
  dayNight: 'dayNight',
  ambient: 'ambientLight',
  clouds: 'clouds',
  ground: 'ground',
  nebula: 'nebulae.0',
};

/** The definition's lists the tab edits one entry at a time (p114). */
export type SkyBoxListKey = 'suns' | 'moons' | 'nebulae';

export const LIST_MAX: Record<SkyBoxListKey, number> = {
  suns: MAX_SUNS,
  moons: MAX_MOONS,
  nebulae: MAX_NEBULAE,
};

/** The layers that point at a list's selected entry. */
const LIST_LAYERS: Record<SkyBoxListKey, SkyBoxLayerKey[]> = {
  suns: ['sun', 'sunLight'],
  moons: ['moon', 'moonLight'],
  nebulae: ['nebula'],
};

/** The entry each list's folder edits (session only). */
const selectedIndex: Record<SkyBoxListKey, number> = { suns: 0, moons: 0, nebulae: 0 };

export const getSelectedIndex = (list: SkyBoxListKey) => selectedIndex[list];

/** Selects the entry a list's folder edits (repoints its layer paths; the tab must be rebuilt,
 * its items capture their paths). */
export const selectListEntry = (list: SkyBoxListKey, index: number) => {
  const next = Math.max(0, Math.floor(index));
  selectedIndex[list] = next;
  for (const layer of LIST_LAYERS[list]) {
    LAYER_PATHS[layer] = LAYER_PATHS[layer].replace(/^(\w+)\.\d+/, `$1.${next}`);
  }
};

/** The active sky box's entries of a list (as many as it draws). */
export const getListEntries = <T = Record<string, unknown>>(list: SkyBoxListKey) =>
  ((getActiveSkyBox()?.def[list] ?? []) as T[]).slice(0, LIST_MAX[list]);

/** Values a definition doesn't set fall back to these (the renderer's defaults), by path. */
const DEFAULTS_TREE = {
  base: BASE_DEFAULTS,
  env: ENV_DEFAULTS,
  atmosphere: ATMOSPHERE_DEFAULTS,
  suns: [{ ...SUN_DEFAULTS, light: SUN_LIGHT_DEFAULTS }],
  moons: [{ ...MOON_DEFAULTS, light: MOON_LIGHT_DEFAULTS }],
  stars: STARS_DEFAULTS,
  dayNight: DAY_NIGHT_DEFAULTS,
  ambientLight: AMBIENT_LIGHT_DEFAULTS,
  clouds: CLOUDS_DEFAULTS,
  ground: GROUND_DEFAULTS,
  nebulae: [NEBULA_DEFAULTS],
};

/** Every sun, moon and nebula falls back to the first one's defaults (but see getDefValue). */
const toDefaultsPath = (path: string) => path.replace(/^(suns|moons|nebulae)\.\d+/, '$1.0');

/** Only suns[0]'s light casts shadows by default. */
const EXTRA_SUN_CAST_SHADOW_PATH = /^suns\.[1-9]\d*\.light\.castShadow$/;

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
  // A definition without a list has none (the defaults tree's entry is for its entries' keys)
  if (path === 'suns' || path === 'moons' || path === 'nebulae') return [];
  if (EXTRA_SUN_CAST_SHADOW_PATH.test(path)) return EXTRA_SUN_LIGHT_DEFAULTS.castShadow;
  return getPresetDefault(def, path) ?? getPath(DEFAULTS_TREE, toDefaultsPath(path));
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

type Container = Obj | unknown[];

/**
 * Sets or deletes a path in a copy of `obj`, dropping objects the deletion left empty. Arrays
 * on the way (a whole-array override, eg. the nebulae after an add) are copied and written by
 * index; nothing is ever deleted from one.
 */
const withPath = (obj: Container, keys: string[], value: unknown, remove: boolean): Container => {
  const [key, ...rest] = keys;
  const isArray = Array.isArray(obj);
  const result = (isArray ? [...obj] : { ...obj }) as Record<string, unknown>;
  if (!rest.length) {
    if (remove && !isArray) delete result[key];
    else result[key] = value;
    return result;
  }
  const next = result[key];
  const child = withPath(Array.isArray(next) ? next : asObj(next), rest, value, remove);
  if (isArray || Array.isArray(child) || Object.keys(child).length) result[key] = child;
  else delete result[key];
  return result;
};

/** Whether a path goes through an array in `obj` (a whole-array override). */
const crossesArray = (obj: unknown, path: string) => {
  let node = obj;
  for (const key of path.split('.').slice(0, -1)) {
    node = isObj(node) ? node[key] : Array.isArray(node) ? node[Number(key)] : undefined;
    if (Array.isArray(node)) return true;
  }
  return false;
};

/** Writes one override value. A value equal to the definition's is removed instead, unless it
 * is inside a whole-array override (whose entries are complete: they replace the definition's). */
export const writeSkyBoxOverride = (
  sceneId: string,
  skyBoxId: string,
  path: string,
  value: unknown
) => {
  const def = getSkyBoxDef(sceneId, skyBoxId);
  const current = (getSkyBoxOverrides(sceneId, skyBoxId) || {}) as Obj;
  const remove =
    value === undefined || (!crossesArray(current, path) && isEqual(value, getDefValue(def, path)));
  setSkyBoxOverrides(
    sceneId,
    skyBoxId,
    withPath(current, path.split('.'), value, remove) as SkyBoxOverrides
  );
};

/** Whether the active sky box's override of a list is a whole array (after an add, duplicate
 * or remove): then an entry can't be reset on its own, only the whole list. */
export const isListOverrideAnArray = (list: SkyBoxListKey) => {
  const active = getActiveSkyBox();
  return Boolean(active && Array.isArray(getSkyBoxOverrides(active.sceneId, active.id)?.[list]));
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
  dayNight: {},
  ambient: {},
  clouds: {},
  ground: {},
  nebula: {},
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
    'nebulaSize',
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
    'rotateWithSky',
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
  dayNight: [
    'enabled',
    'timeOfDay',
    'cycleDurationSec',
    'speed',
    'playing',
    'timeSource',
    'latitude',
    'dayOfYear',
    'axialTilt',
    'northOffset',
  ],
  ambient: ['enabled', 'type', 'intensity'],
  clouds: ['enabled', 'coverage', 'density', 'scale', 'speed', 'elevation'],
  ground: ['enabled', 'horizonBlend', 'height', 'useAtmosphereHorizon'],
  nebula: [
    'enabled',
    'seed',
    'size',
    'falloff',
    'stretch',
    'orientation',
    'density',
    'octaves',
    'warp',
    'dust',
    'brightness',
    'starBoost',
  ],
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

const toDegrees = (radians: number) => Math.round(((radians * 180) / Math.PI) * 100) / 100;

/** A unit direction's elevation and azimuth (degrees, rounded to 0.01; the sun's convention:
 * 0 = +z, 90 = +x). */
export const getElevationAzimuth = (direction: { x: number; y: number; z: number }) => ({
  elevation: toDegrees(Math.asin(Math.min(1, Math.max(-1, direction.y)))),
  azimuth: (toDegrees(Math.atan2(direction.x, direction.z)) + 360) % 360,
});

const setElevationAzimuth = (proxy: Obj, direction: { x: number; y: number; z: number }) =>
  Object.assign(proxy, getElevationAzimuth(direction));

/** With day-night on, the (disabled) sliders of the primary sun and of the selected moon show
 * where the time puts them, and the moon's phase slider its running phase. An extra sun's
 * sliders stay its definition's (where it stands at the start time). */
const syncDerivedPositions = (active: NonNullable<ReturnType<typeof getActiveSkyBox>>) => {
  if (selectedIndex.suns === 0) {
    setElevationAzimuth(skyBoxProxy.sun, active.uniforms.suns[0].direction.value);
  }
  const moon = selectedIndex.moons;
  setElevationAzimuth(skyBoxProxy.moon, active.uniforms.moons[moon].direction.value);
  const phase = getMoonPhase(moon);
  if (phase !== null) skyBoxProxy.moon.phase = Math.round(phase * 1000) / 1000;
};

/** Keeps each list's selection within its entries. */
const clampSelections = (def: SkyBoxDef | undefined) => {
  for (const list of Object.keys(selectedIndex) as SkyBoxListKey[]) {
    const count = Math.min(def?.[list]?.length ?? 0, LIST_MAX[list]);
    if (selectedIndex[list] >= count) selectListEntry(list, Math.max(0, count - 1));
  }
};

/** The selected nebula's colours ('#rrggbb' each, the third one repeating the second with two
 * stops), its stop count, its direction as elevation and azimuth, and the list's size (the
 * selection is clamped to it). */
const syncNebulaProxy = (def: SkyBoxDef | undefined) => {
  const proxy = skyBoxProxy.nebula;
  proxy.count = def?.nebulae?.length ?? 0;
  const path = LAYER_PATHS.nebula;
  for (const key of PROXY_KEYS.nebula) proxy[key] = getDefValue(def, `${path}.${key}`);
  const colors = getDefValue(def, `${path}.colors`) as unknown[];
  proxy.colorStops = colors.length >= 3 ? 3 : 2;
  proxy.color0 = toHex(colors[0]);
  proxy.color1 = toHex(colors[1] ?? colors[0]);
  proxy.color2 = toHex(colors[2] ?? colors[1] ?? colors[0]);
  const [x, y, z] = getDefValue(def, `${path}.direction`) as [number, number, number];
  const length = Math.hypot(x, y, z) || 1;
  setElevationAzimuth(proxy, { x: x / length, y: y / length, z: z / length });
};

export const syncSkyBoxProxy = () => {
  const active = getActiveSkyBox();
  skyBoxProxy.select.skyBoxId = active?.id ?? NO_SKYBOX_ID;
  clampSelections(active?.def);
  for (const layer of Object.keys(PROXY_KEYS) as SkyBoxLayerKey[]) {
    // Synced with its colours, direction and selection (syncNebulaProxy)
    if (layer === 'nebula') continue;
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
  if (active && isDayNightEnabled(active.def)) syncDerivedPositions(active);
  syncNebulaProxy(active?.def);
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

/** Writes a param to the override store and, when that sky box is showing, to the render. A
 * whole array (a list edit: suns, moons, nebulae) changes the list's options, so the tab is
 * rebuilt. */
const applyParam = async (sceneId: string, skyBoxId: string, path: string, value: unknown) => {
  writeSkyBoxOverride(sceneId, skyBoxId, path, value);
  if (isActive(sceneId, skyBoxId)) await updateSkyBox(skyBoxId, toSkyBoxUpdate(path, value));
  if (Array.isArray(value) && !path.includes('.'))
    updateDebuggerTab(SKYBOX_TAB_ID, { rebuild: true });
  else if (!isActive(sceneId, skyBoxId)) refreshTab();
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

/**
 * Replaces a whole array of the active sky box (a list edit: add, duplicate or remove a sun,
 * moon or nebula), as one undo step (not coalesced). `prev` is the array before the edit.
 */
export const setSkyBoxArray = (path: string, label: string, prev: unknown[], next: unknown[]) => {
  const active = getActiveSkyBox();
  if (!active || isEqual(prev, next)) return;
  const { sceneId, id: skyBoxId } = active;
  void applyParam(sceneId, skyBoxId, path, next);
  _recordUndoRedoAction<SkyBoxParamPayload>('skybox.param', `Sky box ${skyBoxId}: ${label}`, {
    sceneId,
    skyBoxId,
    path,
    prev,
    next,
  });
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
    ) as SkyBoxOverrides
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
