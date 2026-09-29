import { lsGetItem, lsRemoveItem, lsSetItem } from '../../../utils/LocalAndSessionStorage';
import { updateDebuggerTab } from '../../../debug/DebuggerGUI';
import { getCurrentSceneId } from '../../Scene';
import {
  _getSkyBoxRegistry,
  getActiveSkyBox,
  SKYBOX_DEBUG_OVERRIDES_LS_KEY,
  updateSkyBox,
  type SkyBoxUpdate,
} from '../../SkyBox/SkyBox';
import type { SkyBoxDef, SkyBoxOverrides } from '../../SkyBox/SkyBoxTypes';
import { BASE_DEFAULTS, ENV_DEFAULTS } from '../../SkyBox/layers/base';
import {
  _recordOrCoalesceUndoRedoAction,
  _recordUndoRedoAction,
  _registerUndoRedoActionHandler,
} from '../_dbg__UndoRedo';

export const SKYBOX_TAB_ID = 'skyBoxControls';

/** The layers the tab edits. p112-p114 add theirs here (and a folder file each). */
export type SkyBoxLayerKey = 'base' | 'env';

/** Values a definition doesn't set fall back to these (the renderer's defaults). */
const LAYER_DEFAULTS: Record<SkyBoxLayerKey, Record<string, unknown>> = {
  base: BASE_DEFAULTS,
  env: ENV_DEFAULTS,
};

type Obj = Record<string, unknown>;
type AllOverrides = { [sceneId: string]: { [skyBoxId: string]: SkyBoxOverrides } };

const isObj = (value: unknown): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const asObj = (value: unknown): Obj => (isObj(value) ? value : {});
const isEqual = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

const getPath = (obj: unknown, path: string) =>
  path.split('.').reduce<unknown>((acc, key) => (isObj(acc) ? acc[key] : undefined), obj);

/** `'env.backgroundRoughness', 0.2` → `{ env: { backgroundRoughness: 0.2 } }` */
export const toSkyBoxUpdate = (path: string, value: unknown) =>
  path.split('.').reduceRight<unknown>((acc, key) => ({ [key]: acc }), value) as SkyBoxUpdate;

/** A registered definition, looked up by scene and id every time (never held on to). */
export const getSkyBoxDef = (sceneId: string, skyBoxId: string) =>
  _getSkyBoxRegistry().get(sceneId)?.get(skyBoxId);

/** The value a path has when nothing overrides it: the definition's, else the layer default. */
export const getDefValue = (def: SkyBoxDef | undefined, path: string) =>
  getPath(def, path) ?? getPath(LAYER_DEFAULTS, path);

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
};

/** The keys a layer folder binds, synced from the active sky box (and its layer defaults). */
const PROXY_KEYS: Record<SkyBoxLayerKey, string[]> = {
  base: ['type', 'file', 'path', 'textureId', 'colorSpace', 'rotate', 'flipY', 'intensity'],
  env: ['backgroundRoughness', 'backgroundIntensity', 'environmentIntensity', 'size', 'dynamic'],
};
/** Read-only text bindings need a string, even when the definition has no value. */
const TEXT_KEYS = new Set(['type', 'file', 'path', 'textureId', 'colorSpace']);

export const NO_SKYBOX_ID = '__noSkyBox';

export const syncSkyBoxProxy = () => {
  const active = getActiveSkyBox();
  skyBoxProxy.select.skyBoxId = active?.id ?? NO_SKYBOX_ID;
  for (const layer of Object.keys(PROXY_KEYS) as SkyBoxLayerKey[]) {
    for (const key of PROXY_KEYS[layer]) {
      const value = getDefValue(active?.def, `${layer}.${key}`);
      skyBoxProxy[layer][key] = TEXT_KEYS.has(key) ? String(value ?? '') : value;
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
  layer: SkyBoxLayerKey;
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
  layer: SkyBoxLayerKey,
  layerOverride: Obj | undefined
) => {
  const current = (getSkyBoxOverrides(sceneId, skyBoxId) || {}) as Obj;
  const touchedKeys = new Set([
    ...Object.keys(asObj(current[layer])),
    ...Object.keys(layerOverride || {}),
  ]);
  setSkyBoxOverrides(
    sceneId,
    skyBoxId,
    withPath(current, [layer], layerOverride, !layerOverride || !Object.keys(layerOverride).length)
  );
  if (!isActive(sceneId, skyBoxId)) {
    refreshTab();
    return;
  }
  const def = getSkyBoxDef(sceneId, skyBoxId);
  const layerUpdate: Obj = {};
  for (const key of touchedKeys) {
    layerUpdate[key] = layerOverride?.[key] ?? getDefValue(def, `${layer}.${key}`);
  }
  await updateSkyBox(skyBoxId, { [layer]: layerUpdate } as SkyBoxUpdate);
};

/** "Reset layer": drops the active sky box's overrides of one layer (undoable). */
export const resetSkyBoxLayer = (layer: SkyBoxLayerKey) => {
  const active = getActiveSkyBox();
  if (!active) return;
  const { sceneId, id: skyBoxId } = active;
  const prev = getSkyBoxOverrides(sceneId, skyBoxId)?.[layer] as Obj | undefined;
  void applyLayerOverride(sceneId, skyBoxId, layer, undefined);
  if (!prev || !Object.keys(prev).length) return;
  _recordUndoRedoAction<SkyBoxResetLayerPayload>(
    'skybox.resetLayer',
    `Sky box ${skyBoxId}: reset ${layer}`,
    { sceneId, skyBoxId, layer, prev }
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
