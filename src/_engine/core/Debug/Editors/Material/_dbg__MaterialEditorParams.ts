/**
 * The material editor's editable params (docs/plans/p085_material-editor-params-and-persistence.md
 * DD2): the param catalogue (key, folder, kind, range, whether a change rebuilds the render
 * pipeline), reading and setting a param on the editor copy, and the Params tab's pane items.
 *
 * One catalogue covers every material type: a param is shown and applied only when the copy has
 * the key with the expected kind (eg. `roughness` only on standard and physical materials).
 * Values are JSON values (colours as `#rrggbb`), the format of the material JSON's `params` and
 * of the editor's overrides.
 */
import * as THREE from 'three/webgpu';
import type { DebuggerPaneItem } from '../../../../debug/DebuggerGUI';

type ParamKind = 'COLOR' | 'NUMBER' | 'BOOLEAN' | 'SIDE';

export type MaterialParamFolder = 'Base' | 'Surface' | 'Transparency' | 'Rendering';

export type MaterialParamDef = {
  key: string;
  folder: MaterialParamFolder;
  kind: ParamKind;
  label: string;
  min?: number;
  max?: number;
  step?: number;
  /** Whether going from `prev` to `next` changes the render pipeline, so the material needs
   * `needsUpdate` (three r186). */
  needsUpdate?: (prev: unknown, next: unknown) => boolean;
};

const always = () => true;

const MATERIAL_PARAM_FOLDERS: MaterialParamFolder[] = [
  'Base',
  'Surface',
  'Transparency',
  'Rendering',
];

/** The editable params, in folder and display order. */
export const MATERIAL_PARAMS: MaterialParamDef[] = [
  { key: 'color', folder: 'Base', kind: 'COLOR', label: 'Color' },
  { key: 'emissive', folder: 'Base', kind: 'COLOR', label: 'Emissive' },
  {
    key: 'emissiveIntensity',
    folder: 'Base',
    kind: 'NUMBER',
    label: 'Emissive intensity',
    min: 0,
    step: 0.01,
  },
  // Phong
  { key: 'specular', folder: 'Base', kind: 'COLOR', label: 'Specular' },
  { key: 'shininess', folder: 'Base', kind: 'NUMBER', label: 'Shininess', min: 0, step: 0.1 },

  { key: 'roughness', folder: 'Surface', kind: 'NUMBER', label: 'Roughness', min: 0, max: 1 },
  { key: 'metalness', folder: 'Surface', kind: 'NUMBER', label: 'Metalness', min: 0, max: 1 },

  {
    key: 'transparent',
    folder: 'Transparency',
    kind: 'BOOLEAN',
    label: 'Transparent',
    needsUpdate: always,
  },
  { key: 'opacity', folder: 'Transparency', kind: 'NUMBER', label: 'Opacity', min: 0, max: 1 },
  {
    key: 'alphaTest',
    folder: 'Transparency',
    kind: 'NUMBER',
    label: 'Alpha test',
    min: 0,
    max: 1,
    // Only between 0 and non-0 (the alpha test is compiled in or not)
    needsUpdate: (prev, next) => (prev as number) > 0 !== (next as number) > 0,
  },

  { key: 'side', folder: 'Rendering', kind: 'SIDE', label: 'Side', needsUpdate: always },
  {
    key: 'wireframe',
    folder: 'Rendering',
    kind: 'BOOLEAN',
    label: 'Wireframe',
    needsUpdate: always,
  },
  {
    key: 'flatShading',
    folder: 'Rendering',
    kind: 'BOOLEAN',
    label: 'Flat shading',
    needsUpdate: always,
  },
];

const SIDE_OPTIONS = { Front: THREE.FrontSide, Back: THREE.BackSide, Double: THREE.DoubleSide };
const SIDE_VALUES: number[] = Object.values(SIDE_OPTIONS);

const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

const getMaterialProp = (mat: THREE.Material, key: string) =>
  (mat as unknown as Record<string, unknown>)[key];

/**
 * Whether the material has the param with the expected kind.
 * @param mat (THREE.Material)
 * @param def ({@link MaterialParamDef})
 * @returns (boolean)
 */
export const hasMaterialParam = (mat: THREE.Material, def: MaterialParamDef) => {
  if (!(def.key in mat)) return false;
  const value = getMaterialProp(mat, def.key);
  switch (def.kind) {
    case 'COLOR':
      return value instanceof THREE.Color;
    case 'BOOLEAN':
      return typeof value === 'boolean';
    default:
      return typeof value === 'number';
  }
};

/**
 * Checks a value against the param's kind (eg. an override from LocalStorage).
 * @param def ({@link MaterialParamDef})
 * @param value (unknown)
 * @returns (unknown) the JSON value (a colour lower-cased), or undefined when it isn't valid
 */
export const normalizeMaterialParamValue = (def: MaterialParamDef, value: unknown) => {
  switch (def.kind) {
    case 'COLOR':
      return typeof value === 'string' && HEX_COLOR_RE.test(value)
        ? value.toLowerCase()
        : undefined;
    case 'BOOLEAN':
      return typeof value === 'boolean' ? value : undefined;
    case 'SIDE':
      return typeof value === 'number' && SIDE_VALUES.includes(value) ? value : undefined;
    default:
      return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  }
};

/**
 * Reads a param of the material as a JSON value (a colour as `#rrggbb`).
 * @param mat (THREE.Material)
 * @param def ({@link MaterialParamDef})
 * @returns (unknown) undefined when the material doesn't have it
 */
export const getMaterialParamValue = (mat: THREE.Material, def: MaterialParamDef) => {
  if (!hasMaterialParam(mat, def)) return undefined;
  const value = getMaterialProp(mat, def.key);
  return value instanceof THREE.Color ? `#${value.getHexString()}` : value;
};

/**
 * Sets a param on the material (`Color.set` for colours, the conversion the JSON params get at
 * creation), with `needsUpdate` when the change rebuilds the render pipeline.
 * @param mat (THREE.Material)
 * @param def ({@link MaterialParamDef})
 * @param value (unknown) a JSON value
 * @returns (boolean) whether it was set (false: the material doesn't have the param, or the
 * value has the wrong kind)
 */
export const setMaterialParamValue = (
  mat: THREE.Material,
  def: MaterialParamDef,
  value: unknown
) => {
  const next = normalizeMaterialParamValue(def, value);
  if (next === undefined || !hasMaterialParam(mat, def)) return false;
  const prev = getMaterialProp(mat, def.key);
  if (prev instanceof THREE.Color) {
    prev.set(next as string);
    return true;
  }
  if (prev === next) return true;
  (mat as unknown as Record<string, unknown>)[def.key] = next;
  if (def.needsUpdate?.(prev, next)) mat.needsUpdate = true;
  return true;
};

/**
 * The param with this key, if the catalogue has one.
 * @param key (string)
 * @returns ({@link MaterialParamDef} | undefined)
 */
export const getMaterialParamDef = (key: string) => MATERIAL_PARAMS.find((def) => def.key === key);

/**
 * Reads every catalogue param the material has.
 * @param mat (THREE.Material)
 * @returns (Record<string, unknown>) the JSON values by param key
 */
export const readMaterialParams = (mat: THREE.Material) => {
  const values: Record<string, unknown> = {};
  for (const def of MATERIAL_PARAMS) {
    const value = getMaterialParamValue(mat, def);
    if (value !== undefined) values[def.key] = value;
  }
  return values;
};

/**
 * The params pane's items: one folder per {@link MaterialParamFolder} with the params the
 * material has (a folder without any is left out). Every binding binds to `target` (fill it with
 * {@link readMaterialParams}), and `onChange` gets each user change.
 * @param mat (THREE.Material) the editor copy
 * @param target (Record<string, unknown>) the binding target
 * @param onChange (function) called with the param, its new value, and whether it is the last
 * change of a drag
 * @returns (DebuggerPaneItem[])
 */
export const getMaterialParamPaneItems = (
  mat: THREE.Material,
  target: Record<string, unknown>,
  onChange: (def: MaterialParamDef, value: unknown, last: boolean) => void
): DebuggerPaneItem[] => {
  const items: DebuggerPaneItem[] = [];
  for (const folder of MATERIAL_PARAM_FOLDERS) {
    const content: DebuggerPaneItem[] = [];
    for (const def of MATERIAL_PARAMS) {
      if (def.folder !== folder || !hasMaterialParam(mat, def)) continue;
      content.push({
        key: def.key,
        target,
        label: def.label,
        ...(def.kind === 'COLOR' ? { view: 'color' } : {}),
        ...(def.kind === 'SIDE' ? { options: SIDE_OPTIONS } : {}),
        ...(def.min !== undefined ? { min: def.min } : {}),
        ...(def.max !== undefined ? { max: def.max } : {}),
        ...(def.step !== undefined ? { step: def.step } : {}),
        onChange: (value, e) => onChange(def, value, e.last),
      });
    }
    if (content.length)
      items.push({ type: 'folder', id: `params/${folder}`, title: folder, content });
  }
  return items;
};

/** A TSL node input's kind (see createMaterial's input handling in core/Material.ts). */
export type NodeInputKind =
  | 'NUMBER'
  | 'BOOLEAN'
  | 'COLOR'
  | 'VEC2'
  | 'VEC3'
  | 'VEC4'
  | 'TEXTURE'
  | 'STATIC_DEFINES'
  | 'OTHER';

/**
 * The kind of a TSL node input value, as createMaterial reads it.
 * @param input (string) the input key
 * @param value (unknown) its value
 * @returns ({@link NodeInputKind}) 'OTHER' for a kind the editor doesn't edit (eg. `{ r, g, b }`)
 */
export const getNodeInputKind = (input: string, value: unknown): NodeInputKind => {
  if (input === 'staticDefines') return 'STATIC_DEFINES';
  if (typeof value === 'number') return Number.isFinite(value) ? 'NUMBER' : 'OTHER';
  if (typeof value === 'boolean') return 'BOOLEAN';
  if (typeof value === 'string') return value.startsWith('#') ? 'COLOR' : 'TEXTURE';
  if (Array.isArray(value)) {
    if (!value.every((n) => typeof n === 'number')) return 'OTHER';
    return value.length === 2
      ? 'VEC2'
      : value.length === 3
        ? 'VEC3'
        : value.length === 4
          ? 'VEC4'
          : 'OTHER';
  }
  if (typeof value === 'object' && value !== null) {
    const obj = value as Record<string, unknown>;
    if ('w' in obj) return 'VEC4';
    if ('z' in obj) return 'VEC3';
    if ('y' in obj) return 'VEC2';
  }
  return 'OTHER';
};

/** The input kinds the editor can edit (a texture or `staticDefines` needs a rebuild). */
const isEditableNodeInputKind = (kind: NodeInputKind) =>
  kind !== 'TEXTURE' && kind !== 'STATIC_DEFINES' && kind !== 'OTHER';

/**
 * The asset's TSL node inputs with the overrides merged over them: an override applies only to an
 * input the asset has, of an editable kind, with a value of the same kind (the uniform the input
 * becomes depends on it).
 * @param assetNodes (Record<string, Record<string, unknown>> | undefined) the asset's `nodes`
 * @param overrides (Record<string, Record<string, unknown>>) the editor's node overrides
 * @returns (Record<string, Record<string, unknown>> | undefined) new objects, or undefined when
 * the asset has no nodes
 */
export const mergeNodeOverrides = (
  assetNodes: Record<string, Record<string, unknown>> | undefined,
  overrides: Record<string, Record<string, unknown>>
) => {
  if (!assetNodes) return undefined;
  const merged: Record<string, Record<string, unknown>> = {};
  for (const [socket, inputs] of Object.entries(assetNodes)) {
    merged[socket] = { ...inputs };
    const socketOverrides = overrides[socket];
    if (!socketOverrides) continue;
    for (const [input, value] of Object.entries(socketOverrides)) {
      if (!(input in inputs)) continue;
      const kind = getNodeInputKind(input, inputs[input]);
      if (!isEditableNodeInputKind(kind) || getNodeInputKind(input, value) !== kind) continue;
      merged[socket][input] = value;
    }
  }
  return merged;
};
