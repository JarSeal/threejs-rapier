import { IS_DEBUG_ENV } from '../../Config';
import { lsGetItem, lsRemoveItem, lsSetItem } from '../../../utils/LocalAndSessionStorage';
import { llog, lwarn } from '../../../utils/Logger';
import { getCurrentSceneId } from '../../Scene';
import { getNextSceneId, isCurrentlyLoading } from '../../SceneLoader';
import type { CharacterObject } from '../../Character/CharacterTypes';

/**
 * Tuned character configuration (the Character state window's edits), saved per scene and
 * character id so it survives a reload: only the values that differ from the character's
 * creation-time ones (`initialConfig`). Applied when the character is created, debug env only.
 * Copy changes is still the way to make the tuning permanent.
 */

export const CHAR_CONFIG_LS_KEY = 'AEK_debugCharConfig';

export type SavedConfigValue = number | boolean;
type SavedCharacterConfig = Record<string, SavedConfigValue>;
type SavedConfigs = { [sceneId: string]: { [charId: string]: SavedCharacterConfig } };

/** Equal, or numbers equal but for float noise (eg. a value typed in degrees, which comes back a
 * rounding step off the code's `Math.PI / 4`). */
export const isSameConfigValue = (a: unknown, b: unknown) =>
  a === b ||
  (typeof a === 'number' &&
    typeof b === 'number' &&
    Math.abs(a - b) <= 1e-12 * Math.max(1, Math.abs(b)));

const isObject = (value: unknown): value is object =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const readSavedConfigs = (): SavedConfigs => {
  let saved: unknown = null;
  try {
    saved = lsGetItem(CHAR_CONFIG_LS_KEY, {});
  } catch {
    saved = null;
  }
  return isObject(saved) ? (saved as SavedConfigs) : {};
};

/** Writes the saved configs back, without the empty objects (none left: the key is removed). */
const writeSavedConfigs = (all: SavedConfigs) => {
  for (const sceneId of Object.keys(all)) {
    const scene = all[sceneId];
    if (!isObject(scene)) {
      delete all[sceneId];
      continue;
    }
    for (const charId of Object.keys(scene)) {
      if (!isObject(scene[charId]) || !Object.keys(scene[charId]).length) delete scene[charId];
    }
    if (!Object.keys(scene).length) delete all[sceneId];
  }
  if (Object.keys(all).length) lsSetItem(CHAR_CONFIG_LS_KEY, all);
  else lsRemoveItem(CHAR_CONFIG_LS_KEY);
};

/** The scene a character being created belongs to: the loading scene, else the current one. */
const getCreationSceneId = () => (isCurrentlyLoading() ? getNextSceneId() : getCurrentSceneId());

/** The scene each character was created in (set when its saved values are applied), so its edits
 * are saved there even while another scene loads. */
const characterSceneIds = new WeakMap<CharacterObject, string>();

const getCharacterSceneId = (character: CharacterObject) =>
  characterSceneIds.get(character) ?? getCurrentSceneId();

/** The character's saved overrides (in the scene it was created in), or null when it has none. */
export const getSavedCharacterConfig = (
  character: CharacterObject
): Readonly<SavedCharacterConfig> | null => {
  const sceneId = getCharacterSceneId(character);
  if (!sceneId) return null;
  const saved = readSavedConfigs()[sceneId]?.[character.id];
  return isObject(saved) && Object.keys(saved).length ? saved : null;
};

/** Removes the character's saved overrides (in the scene it was created in). The live values stay:
 * the code values return on its next creation. */
export const clearSavedCharacterConfig = (character: CharacterObject) => {
  const sceneId = getCharacterSceneId(character);
  if (!sceneId) return;
  const all = readSavedConfigs();
  const scene = all[sceneId];
  if (!isObject(scene) || !Object.prototype.hasOwnProperty.call(scene, character.id)) return;
  delete scene[character.id];
  writeSavedConfigs(all);
};

/** The scenes that have saved overrides (the Characters tab's clear button). */
export const getSceneIdsWithSavedConfig = () => {
  const all = readSavedConfigs();
  return Object.keys(all).filter((sceneId) => isObject(all[sceneId]));
};

/** Removes the scenes' saved overrides (every character's). The live values stay: the code values
 * return on each character's next creation. */
export const clearSavedConfigScenes = (sceneIds: string[]) => {
  const all = readSavedConfigs();
  for (const sceneId of sceneIds) delete all[sceneId];
  writeSavedConfigs(all);
};

/**
 * Saves the keys' live values as the character's overrides, or clears the ones back at their
 * creation-time value (debug env only). Only values with the creation-time value's type are
 * saved, never a baked key: those are what applying can use. One LS write, only on a change.
 */
export const saveCharacterConfig = (character: CharacterObject, keys: string[]) => {
  if (!IS_DEBUG_ENV) return;
  const sceneId = getCharacterSceneId(character);
  if (!sceneId) return;
  const all = readSavedConfigs();
  // A malformed entry (eg. hand-edited) is replaced
  if (!isObject(all[sceneId])) all[sceneId] = {};
  const scene = all[sceneId];
  if (!isObject(scene[character.id])) scene[character.id] = {};
  const saved = scene[character.id];
  const baked = character.controller?.config?.bakedKeys;
  let isChanged = false;
  for (const key of keys) {
    if (baked?.has(key)) continue;
    const value = character.data[key];
    const initial = character.initialConfig[key];
    if (
      (typeof value === 'number' || typeof value === 'boolean') &&
      typeof value === typeof initial &&
      !isSameConfigValue(value, initial)
    ) {
      if (saved[key] !== value) {
        saved[key] = value;
        isChanged = true;
      }
    } else if (Object.prototype.hasOwnProperty.call(saved, key)) {
      delete saved[key];
      isChanged = true;
    }
  }
  if (isChanged) writeSavedConfigs(all);
};

/**
 * Applies the character's saved configuration overrides (debug env only): writes each one to the
 * live data and lets the controller recompute what derives from it. A key the character no longer
 * has with the same type (eg. a renamed config key) or a baked key is skipped, with one warning,
 * and kept (it may come back). A saved value equal to the creation-time one (the code caught up)
 * is dropped.
 */
export const _applySavedCharacterConfig = (character: CharacterObject) => {
  if (!IS_DEBUG_ENV) return;
  const sceneId = getCreationSceneId();
  if (!sceneId) return;
  characterSceneIds.set(character, sceneId);
  const all = readSavedConfigs();
  const saved = all[sceneId]?.[character.id];
  if (!isObject(saved)) return;

  const config = character.controller?.config;
  const applied: string[] = [];
  const skipped: string[] = [];
  let hasDropped = false;
  for (const key of Object.keys(saved)) {
    const value = saved[key];
    const initial = character.initialConfig[key];
    if (
      (typeof value !== 'number' && typeof value !== 'boolean') ||
      typeof initial !== typeof value ||
      config?.bakedKeys.has(key)
    ) {
      skipped.push(key);
      continue;
    }
    if (isSameConfigValue(value, initial)) {
      delete saved[key];
      hasDropped = true;
      continue;
    }
    character.data[key] = value;
    config?.onChange(key);
    applied.push(key);
  }
  if (hasDropped) writeSavedConfigs(all);

  const name = `'${character.id}'`;
  if (skipped.length) {
    lwarn(
      `[Character] ${name}: skipped ${skipped.length} saved debug config ${skipped.length === 1 ? 'override' : 'overrides'} the character doesn't have (renamed, retyped or baked): ${skipped.join(', ')}`
    );
  }
  if (applied.length) {
    llog(
      `[Character] ${name}: ${applied.length} debug config ${applied.length === 1 ? 'override' : 'overrides'} applied (${applied.join(', ')})`
    );
  }
};
