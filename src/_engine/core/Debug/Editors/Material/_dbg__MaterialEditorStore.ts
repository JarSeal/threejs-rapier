/**
 * The material editor's LocalStorage (docs/plans/p084_material-editor-stage-and-selector.md DD4,
 * DD8):
 * - the editor's UI state, `AEK_debugMatEditorUI`: the selected material, the selector's and the
 *   right drawer's state;
 * - one record per material, `AEK_debugMatEditorMat_<id>` (p085 DD1): its overrides (the edited
 *   params and TSL inputs) and its camera pose here. The editor module owns the record: every
 *   write is a read, merge, write of the fields it changes, so the fields another part wrote are
 *   kept;
 * - the folder open states of the right drawer's tabs, `AEK_debugMatEditorTabsUI`, shared by
 *   every material (a material's clear doesn't reset them).
 */
import {
  lsGetItem,
  lsGetKeysWithPrefix,
  lsRemoveItem,
  lsSetItem,
} from '../../../../utils/LocalAndSessionStorage';
import {
  createViewCameraLSStore,
  type ViewCameraPose,
  type ViewCameraStore,
} from '../_dbg__ViewCamera';
import type { EditorDrawerState } from '../_dbg__EditorDrawer';
import type { MaterialSelectorState } from './_dbg__MaterialEditorSelector';

export const MATERIAL_EDITOR_UI_LS_KEY = 'AEK_debugMatEditorUI';
export const MATERIAL_EDITOR_RECORD_LS_KEY_PREFIX = 'AEK_debugMatEditorMat_';
/** Not `${recordKey}UI` (the tabs' default): that would start with the record prefix. */
export const MATERIAL_EDITOR_TABS_UI_LS_KEY = 'AEK_debugMatEditorTabsUI';

/** The structure of 'AEK_debugMatEditorUI' in LocalStorage (the camera pose without a material is
 * the view camera's own, in 'AEK_debugViewCams'). */
export type MaterialEditorUIState = {
  selectedMaterialId: string | null;
  selector: Partial<MaterialSelectorState>;
  drawer: Partial<EditorDrawerState>;
};

/** A material's edits in the editor, deviation-only (a value the user changed): the shape of
 * `MaterialOverridesSchema`'s `params` and `nodes` (schemas/materialSchema.ts), with JSON values
 * only (colours as `#rrggbb`, numbers, booleans, vectors as `{ x, y(, z, w) }`), so it can be
 * written into the material JSON or its `__saveData` as it is. */
export type MaterialEditorOverrides = {
  params?: Record<string, unknown>;
  nodes?: Record<string, Record<string, unknown>>;
};

/** Where a value of the record's overrides is: a `params` key, or a TSL input as
 * `<socket>.<input>` (eg. `colorNode.gridScale`). */
export type MaterialOverrideSection = 'params' | 'nodes';

/** The structure of a material's 'AEK_debugMatEditorMat_<id>' record in LocalStorage. */
export type MaterialEditorRecord = {
  overrides?: MaterialEditorOverrides;
  /** The camera pose of this material (the view camera's pose key is the material id). */
  camera?: ViewCameraPose;
};

/** A record patch: a field set to undefined is removed. */
export type MaterialEditorRecordPatch = {
  [K in keyof MaterialEditorRecord]?: MaterialEditorRecord[K] | undefined;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** An object from LocalStorage, or an empty one (a missing or broken value). */
const readObject = (key: string) => {
  try {
    const value: unknown = lsGetItem(key, {});
    return isPlainObject(value) ? value : {};
  } catch {
    return {};
  }
};

/**
 * The LocalStorage key of a material's record.
 * @param materialId (string) a `*.material.json` id
 * @returns (string)
 */
export const getMaterialRecordKey = (materialId: string) =>
  MATERIAL_EDITOR_RECORD_LS_KEY_PREFIX + materialId;

/**
 * Reads a material's record (an empty one when it has none).
 * @param materialId (string) a `*.material.json` id
 * @returns ({@link MaterialEditorRecord})
 */
export const readMaterialRecord = (materialId: string) =>
  readObject(getMaterialRecordKey(materialId)) as MaterialEditorRecord;

/**
 * Merges a patch into a material's record and writes it; a record left empty is removed.
 * @param materialId (string) a `*.material.json` id
 * @param patch ({@link MaterialEditorRecordPatch}) the fields to set (undefined removes one)
 */
export const patchMaterialRecord = (materialId: string, patch: MaterialEditorRecordPatch) => {
  const record: Record<string, unknown> = { ...readMaterialRecord(materialId) };
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) delete record[field];
    else record[field] = value;
  }
  const key = getMaterialRecordKey(materialId);
  if (Object.keys(record).length) lsSetItem(key, record);
  else lsRemoveItem(key);
};

/**
 * A material's overrides from its record: only the plain objects of the expected shape (a
 * hand-edited or older value is left out). The values themselves are checked where they are
 * applied, against the copy and the asset.
 * @param materialId (string) a `*.material.json` id
 * @returns ({@link MaterialEditorOverrides}) new objects, empty when it has none
 */
export const readMaterialOverrides = (materialId: string) => {
  const saved = readMaterialRecord(materialId).overrides as unknown;
  const params: Record<string, unknown> = {};
  const nodes: Record<string, Record<string, unknown>> = {};
  if (isPlainObject(saved)) {
    if (isPlainObject(saved.params)) Object.assign(params, saved.params);
    if (isPlainObject(saved.nodes)) {
      for (const [socket, inputs] of Object.entries(saved.nodes)) {
        if (isPlainObject(inputs)) nodes[socket] = { ...inputs };
      }
    }
  }
  return { params, nodes };
};

/**
 * Sets or removes one value of a material's overrides (read, merge, write); emptied objects are
 * removed, and so is an emptied record.
 * @param materialId (string) a `*.material.json` id
 * @param section ({@link MaterialOverrideSection})
 * @param path (string) a `params` key, or `<socket>.<input>` for `nodes`
 * @param value (unknown) a JSON value, or undefined to remove it (the asset's value applies again)
 */
export const setMaterialOverride = (
  materialId: string,
  section: MaterialOverrideSection,
  path: string,
  value: unknown
) => {
  const { params, nodes } = readMaterialOverrides(materialId);
  if (section === 'params') {
    if (value === undefined) delete params[path];
    else params[path] = value;
  } else {
    const dotIndex = path.indexOf('.');
    if (dotIndex <= 0) return;
    const socket = path.slice(0, dotIndex);
    const input = path.slice(dotIndex + 1);
    const inputs = (nodes[socket] ??= {});
    if (value === undefined) delete inputs[input];
    else inputs[input] = value;
    if (!Object.keys(inputs).length) delete nodes[socket];
  }
  const overrides: MaterialEditorOverrides = {};
  if (Object.keys(params).length) overrides.params = params;
  if (Object.keys(nodes).length) overrides.nodes = nodes;
  patchMaterialRecord(materialId, {
    overrides: Object.keys(overrides).length ? overrides : undefined,
  });
};

/**
 * The ids of the materials that have a record.
 * @returns (string[])
 */
export const getMaterialRecordIds = () =>
  lsGetKeysWithPrefix(MATERIAL_EDITOR_RECORD_LS_KEY_PREFIX).map((key) =>
    key.slice(MATERIAL_EDITOR_RECORD_LS_KEY_PREFIX.length)
  );

/**
 * The editor camera's store: a material's pose in its record (`camera`), the view's own pose
 * (`null`, no material selected) in the view camera's default store ('AEK_debugViewCams').
 * @param viewId (string) the material editor's view id
 * @returns ({@link ViewCameraStore})
 */
export const createMaterialCameraStore = (viewId: string): ViewCameraStore => {
  const viewStore = createViewCameraLSStore(viewId);
  return {
    // The view camera validates what it loads
    load: (key) => (key === null ? viewStore.load(null) : readMaterialRecord(key).camera),
    save: (key, pose) => {
      if (key === null) viewStore.save(null, pose);
      else patchMaterialRecord(key, { camera: pose });
    },
    clear: (key) => {
      if (key === null) {
        viewStore.clear(null);
      } else if (key !== undefined) {
        patchMaterialRecord(key, { camera: undefined });
      } else {
        viewStore.clear();
        for (const id of getMaterialRecordIds()) patchMaterialRecord(id, { camera: undefined });
      }
    },
  };
};

const pickBoolean = (value: unknown) => (typeof value === 'boolean' ? value : undefined);
const pickString = (value: unknown) => (typeof value === 'string' ? value : undefined);
const pickNumber = (value: unknown) =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** Drops the undefined values, so a state's own defaults apply to them. */
const withoutUndefined = <T extends Record<string, unknown>>(obj: T) =>
  Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== undefined)) as Partial<T>;

/**
 * Reads the editor's UI state; values of the wrong type (a hand-edited or older value) are left
 * out, so their defaults apply.
 * @returns ({@link MaterialEditorUIState})
 */
export const readMaterialEditorUIState = (): MaterialEditorUIState => {
  const saved = readObject(MATERIAL_EDITOR_UI_LS_KEY);
  const selector = isPlainObject(saved.selector) ? saved.selector : {};
  const drawer = isPlainObject(saved.drawer) ? saved.drawer : {};
  const scrollPos: Record<string, number> = {};
  if (isPlainObject(drawer.scrollPos)) {
    for (const [tabId, value] of Object.entries(drawer.scrollPos)) {
      const pos = pickNumber(value);
      if (pos !== undefined) scrollPos[tabId] = pos;
    }
  }
  return {
    selectedMaterialId: pickString(saved.selectedMaterialId) ?? null,
    selector: withoutUndefined({
      isOpen: pickBoolean(selector.isOpen),
      filterText: pickString(selector.filterText),
      scrollTop: pickNumber(selector.scrollTop),
    }),
    drawer: withoutUndefined({
      isOpen: pickBoolean(drawer.isOpen),
      currentTabId: pickString(drawer.currentTabId),
      scrollPos,
    }),
  };
};

/**
 * Writes the editor's UI state.
 * @param state ({@link MaterialEditorUIState})
 */
export const writeMaterialEditorUIState = (state: MaterialEditorUIState) => {
  lsSetItem(MATERIAL_EDITOR_UI_LS_KEY, state);
};
