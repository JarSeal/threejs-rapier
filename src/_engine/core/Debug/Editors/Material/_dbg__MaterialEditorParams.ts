/**
 * The material editor's editable params
 * (docs/plans/_DONE_p085_material-editor-params-and-persistence.md DD2): the param catalogue (key, folder, kind, range, whether a change rebuilds the render
 * pipeline), reading and setting a param on the editor copy, the TSL inputs (read and set through
 * their uniforms), and the Params tab's pane items.
 *
 * One catalogue covers every material type: a param is shown and applied only when the copy has
 * the key with the expected kind (eg. `roughness` only on standard and physical materials).
 * Values are JSON values (colours as `#rrggbb`), the format of the material JSON's `params` and
 * of the editor's overrides.
 */
import * as THREE from 'three/webgpu';
import type { DebuggerPaneItem } from '../../../../debug/DebuggerGUI';
import type { MaterialAsset } from '../../../../schemas/materialSchema';

type ParamKind = 'COLOR' | 'NUMBER' | 'BOOLEAN' | 'SIDE';

export type MaterialParamFolder =
  | 'Base'
  | 'Surface'
  | 'Transparency'
  | 'Rendering'
  | 'Points / lines';

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
  /** Limits the param to some material types, when the key alone doesn't (eg. a sprite also has
   * `sizeAttenuation`). */
  appliesTo?: (mat: THREE.Material) => boolean;
};

const always = () => true;
const isPointsMaterial = (mat: THREE.Material) =>
  (mat as THREE.PointsMaterial).isPointsMaterial === true;
const isLineDashedMaterial = (mat: THREE.Material) =>
  (mat as THREE.LineDashedMaterial).isLineDashedMaterial === true;

const MATERIAL_PARAM_FOLDERS: MaterialParamFolder[] = [
  'Base',
  'Surface',
  'Transparency',
  'Rendering',
  'Points / lines',
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
  // Physical. Their setters bump the material's version when a value crosses 0 (the feature is
  // compiled in or not), so they need no needsUpdate here
  { key: 'clearcoat', folder: 'Surface', kind: 'NUMBER', label: 'Clearcoat', min: 0, max: 1 },
  {
    key: 'clearcoatRoughness',
    folder: 'Surface',
    kind: 'NUMBER',
    label: 'Clearcoat roughness',
    min: 0,
    max: 1,
  },
  { key: 'sheen', folder: 'Surface', kind: 'NUMBER', label: 'Sheen', min: 0, max: 1 },
  { key: 'iridescence', folder: 'Surface', kind: 'NUMBER', label: 'Iridescence', min: 0, max: 1 },
  {
    key: 'transmission',
    folder: 'Surface',
    kind: 'NUMBER',
    label: 'Transmission',
    min: 0,
    max: 1,
  },
  { key: 'ior', folder: 'Surface', kind: 'NUMBER', label: 'IOR', min: 1, max: 2.333 },

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

  {
    key: 'size',
    folder: 'Points / lines',
    kind: 'NUMBER',
    label: 'Size',
    min: 0,
    appliesTo: isPointsMaterial,
  },
  {
    key: 'sizeAttenuation',
    folder: 'Points / lines',
    kind: 'BOOLEAN',
    label: 'Size attenuation',
    // A build-time branch of the points' vertex stage
    needsUpdate: always,
    appliesTo: isPointsMaterial,
  },
  {
    key: 'dashSize',
    folder: 'Points / lines',
    kind: 'NUMBER',
    label: 'Dash size',
    min: 0,
    step: 0.01,
    appliesTo: isLineDashedMaterial,
  },
  {
    key: 'gapSize',
    folder: 'Points / lines',
    kind: 'NUMBER',
    label: 'Gap size',
    min: 0,
    step: 0.01,
    appliesTo: isLineDashedMaterial,
  },
  {
    key: 'scale',
    folder: 'Points / lines',
    kind: 'NUMBER',
    label: 'Dash scale',
    min: 0,
    step: 0.01,
    appliesTo: isLineDashedMaterial,
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
  if (!(def.key in mat) || (def.appliesTo && !def.appliesTo(mat))) return false;
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

/** A JSON value as a read-only row shows it (a texture id as it is). */
const formatReadOnlyValue = (value: unknown) => {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value) ?? String(value);
};

/** Read-only rows (Tweakpane monitors) of a record's values, in its key order. */
const getReadOnlyItems = (values: Record<string, unknown>): DebuggerPaneItem[] => {
  const target: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) target[key] = formatReadOnlyValue(value);
  return Object.keys(target).map((key) => ({ key, target, label: key, readonly: true }));
};

/**
 * The "Other asset params" folder: the asset's `params` that no binding of
 * {@link getMaterialParamPaneItems} shows (texture slots, keys the catalogue doesn't have, a
 * catalogue key the copy doesn't have), read-only, so nothing in the JSON is invisible.
 * @param mat (THREE.Material) the editor copy
 * @param assetParams (Record<string, unknown> | undefined) the asset's `params`
 * @returns (DebuggerPaneItem[]) the folder, or none when every param has a binding
 */
export const getOtherAssetParamPaneItems = (
  mat: THREE.Material,
  assetParams: Record<string, unknown> | undefined
): DebuggerPaneItem[] => {
  const others: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(assetParams ?? {})) {
    const def = getMaterialParamDef(key);
    if (!def || !hasMaterialParam(mat, def)) others[key] = value;
  }
  if (!Object.keys(others).length) return [];
  return [
    {
      type: 'folder',
      id: 'params/Other',
      title: 'Other asset params',
      content: getReadOnlyItems(others),
    },
  ];
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

/** A material asset's TSL node inputs by socket (its `nodes`). */
export type MaterialNodeInputs = Record<string, Record<string, unknown>>;

/**
 * The asset's TSL node inputs (only TSL materials have them).
 * @param asset (MaterialAsset)
 * @returns ({@link MaterialNodeInputs} | undefined)
 */
export const getAssetNodeInputs = (asset: MaterialAsset) =>
  ('nodes' in asset ? asset.nodes : undefined) as MaterialNodeInputs | undefined;

/**
 * The asset's material-wide `staticDefines` (only TSL materials have them).
 * @param asset (MaterialAsset)
 * @returns (Record<string, unknown> | undefined)
 */
export const getAssetStaticDefines = (asset: MaterialAsset) =>
  ('staticDefines' in asset ? asset.staticDefines : undefined) as
    | Record<string, unknown>
    | undefined;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const VECTOR_KEYS = { VEC2: ['x', 'y'], VEC3: ['x', 'y', 'z'], VEC4: ['x', 'y', 'z', 'w'] };

/** A TSL input's uniform node, as createMaterial keeps it in `userData.uniforms`. */
type InputUniform = { isUniformNode?: boolean; isTextureNode?: boolean; value: unknown };

const uniformValueHasKind = (value: unknown, kind: NodeInputKind) => {
  switch (kind) {
    case 'NUMBER':
      return typeof value === 'number';
    case 'BOOLEAN':
      return typeof value === 'boolean';
    case 'COLOR':
      return value instanceof THREE.Color;
    case 'VEC2':
      return value instanceof THREE.Vector2;
    case 'VEC3':
      return value instanceof THREE.Vector3;
    case 'VEC4':
      return value instanceof THREE.Vector4;
    default:
      return false;
  }
};

/** An input the copy lets the editor edit: an editable kind in the asset, and a uniform of that
 * kind on the copy (none when createMaterial skipped the socket). The kind is the asset's: a
 * `{ r, g, b }` input also becomes a colour uniform, but its overrides are never merged. */
const getEditableNodeInput = (
  mat: THREE.Material,
  assetNodes: MaterialNodeInputs | undefined,
  socket: string,
  input: string
) => {
  const inputs = assetNodes?.[socket];
  if (!inputs || !(input in inputs)) return null;
  const kind = getNodeInputKind(input, inputs[input]);
  if (!isEditableNodeInputKind(kind)) return null;
  const uniforms = mat.userData.uniforms as Record<string, InputUniform | undefined> | undefined;
  const uniform = uniforms?.[`${socket}_${input}`];
  if (!uniform?.isUniformNode || uniform.isTextureNode) return null;
  return uniformValueHasKind(uniform.value, kind) ? { kind, uniform } : null;
};

/**
 * Checks a TSL input value against a kind (eg. an override from LocalStorage, a Tweakpane point).
 * @param kind ({@link NodeInputKind}) an editable kind
 * @param value (unknown)
 * @returns (unknown) the JSON value (a colour as `#rrggbb`, a vector as `{ x, y(, z, w) }`, from
 * an array too), or undefined when it isn't valid
 */
export const normalizeNodeInputValue = (kind: NodeInputKind, value: unknown) => {
  if (!isEditableNodeInputKind(kind) || getNodeInputKind('', value) !== kind) return undefined;
  if (kind === 'COLOR') return `#${new THREE.Color(value as string).getHexString()}`;
  if (kind === 'VEC2' || kind === 'VEC3' || kind === 'VEC4') {
    const vector: Record<string, number> = {};
    VECTOR_KEYS[kind].forEach((key, i) => {
      const n = Array.isArray(value) ? value[i] : (value as Record<string, unknown>)[key];
      // createMaterial reads a missing component as 0
      vector[key] = typeof n === 'number' && Number.isFinite(n) ? n : 0;
    });
    return vector;
  }
  return value;
};

/** A uniform's value as a JSON value. */
const readUniformValue = ({ kind, uniform }: { kind: NodeInputKind; uniform: InputUniform }) => {
  const value = uniform.value;
  if (value instanceof THREE.Color) return `#${value.getHexString()}`;
  if (kind === 'VEC2' || kind === 'VEC3' || kind === 'VEC4') {
    return normalizeNodeInputValue(kind, value);
  }
  return value;
};

/**
 * Reads one editable TSL input of the copy (from its uniform).
 * @param mat (THREE.Material) the editor copy
 * @param assetNodes ({@link MaterialNodeInputs} | undefined) the asset's `nodes`
 * @param socket (string) eg. `colorNode`
 * @param input (string) eg. `gridScale`
 * @returns (unknown) the JSON value, or undefined when it isn't an editable input of the copy
 */
export const getNodeInputValue = (
  mat: THREE.Material,
  assetNodes: MaterialNodeInputs | undefined,
  socket: string,
  input: string
) => {
  const editable = getEditableNodeInput(mat, assetNodes, socket, input);
  return editable ? readUniformValue(editable) : undefined;
};

/**
 * Reads the copy's editable TSL inputs (from their uniforms).
 * @param mat (THREE.Material) the editor copy
 * @param assetNodes ({@link MaterialNodeInputs} | undefined) the asset's `nodes`
 * @returns ({@link MaterialNodeInputs}) the JSON values by socket and input (only sockets with
 * an editable input)
 */
export const readNodeInputs = (mat: THREE.Material, assetNodes: MaterialNodeInputs | undefined) => {
  const values: MaterialNodeInputs = {};
  for (const [socket, inputs] of Object.entries(assetNodes ?? {})) {
    for (const input of Object.keys(inputs)) {
      const editable = getEditableNodeInput(mat, assetNodes, socket, input);
      if (editable) (values[socket] ??= {})[input] = readUniformValue(editable);
    }
  }
  return values;
};

/**
 * Sets a TSL input on the copy through its uniform's `value` (no rebuild).
 * @param mat (THREE.Material) the editor copy
 * @param assetNodes ({@link MaterialNodeInputs} | undefined) the asset's `nodes`
 * @param socket (string) eg. `colorNode`
 * @param input (string) eg. `gridScale`
 * @param value (unknown) a JSON value (or a Tweakpane point)
 * @returns (unknown) the JSON value it set, or undefined when it wasn't set (not an editable
 * input of the copy, or a value of the wrong kind)
 */
export const setNodeInputValue = (
  mat: THREE.Material,
  assetNodes: MaterialNodeInputs | undefined,
  socket: string,
  input: string,
  value: unknown
) => {
  const editable = getEditableNodeInput(mat, assetNodes, socket, input);
  if (!editable) return undefined;
  const next = normalizeNodeInputValue(editable.kind, value);
  if (next === undefined) return undefined;
  const current = editable.uniform.value;
  if (current instanceof THREE.Color) current.set(next as string);
  else if (typeof current === 'object' && current !== null) Object.assign(current, next);
  else editable.uniform.value = next;
  return next;
};

/**
 * Checks a TSL input value against the kind of the asset's own value (an override written without
 * the copy, eg. an undo of another material).
 * @param assetNodes ({@link MaterialNodeInputs} | undefined) the asset's `nodes`
 * @param socket (string)
 * @param input (string)
 * @param value (unknown)
 * @returns (unknown) the JSON value, or undefined when the asset has no editable input there or
 * the value has the wrong kind
 */
export const normalizeAssetNodeInputValue = (
  assetNodes: MaterialNodeInputs | undefined,
  socket: string,
  input: string,
  value: unknown
) => {
  const inputs = assetNodes?.[socket];
  if (!inputs || !(input in inputs)) return undefined;
  return normalizeNodeInputValue(getNodeInputKind(input, inputs[input]), value);
};

/**
 * The asset's own value of a TSL input, as a JSON value (what an override is compared with).
 * @param assetNodes ({@link MaterialNodeInputs} | undefined) the asset's `nodes`
 * @param socket (string)
 * @param input (string)
 * @returns (unknown) undefined when the asset doesn't have an editable input there
 */
export const getNodeInputBaseValue = (
  assetNodes: MaterialNodeInputs | undefined,
  socket: string,
  input: string
) => {
  const value = assetNodes?.[socket]?.[input];
  return normalizeNodeInputValue(getNodeInputKind(input, value), value);
};

/**
 * Whether two normalized TSL input values are equal ({@link normalizeNodeInputValue} builds
 * vectors with their keys in one order).
 * @param a (unknown)
 * @param b (unknown)
 * @returns (boolean)
 */
export const isSameNodeInputValue = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

const getStaticDefinesFolder = (
  id: string,
  defines: Record<string, unknown>
): DebuggerPaneItem => ({
  type: 'folder',
  id,
  title: 'staticDefines (read-only)',
  content: getReadOnlyItems(defines),
});

/**
 * The "TSL inputs" folder: a sub-folder per node socket with a binding per editable input
 * (numbers without a range, the asset declares none; `#hex` colours; booleans; vectors as
 * Tweakpane points), and read-only rows for the rest (texture ids, `staticDefines`, inputs the
 * copy has no uniform of).
 * @param mat (THREE.Material) the editor copy
 * @param assetNodes ({@link MaterialNodeInputs} | undefined) the asset's `nodes`
 * @param staticDefines (Record<string, unknown> | undefined) the asset's material-wide ones
 * @param getTarget (function) a socket's binding target (fill it with {@link readNodeInputs})
 * @param onChange (function) called with the socket, the input, its new value, and whether it is
 * the last change of a drag
 * @returns (DebuggerPaneItem[]) the folder, or none for a material without TSL inputs
 */
export const getNodeInputPaneItems = (
  mat: THREE.Material,
  assetNodes: MaterialNodeInputs | undefined,
  staticDefines: Record<string, unknown> | undefined,
  getTarget: (socket: string) => Record<string, unknown>,
  onChange: (socket: string, input: string, value: unknown, last: boolean) => void
): DebuggerPaneItem[] => {
  const content: DebuggerPaneItem[] = [];
  for (const [socket, inputs] of Object.entries(assetNodes ?? {})) {
    const folderId = `params/TSL inputs/${socket}`;
    const target = getTarget(socket);
    const readOnlyTarget: Record<string, string> = {};
    const socketContent: DebuggerPaneItem[] = [];
    for (const [input, value] of Object.entries(inputs)) {
      if (input === 'staticDefines' && isPlainObject(value)) {
        socketContent.push(getStaticDefinesFolder(`${folderId}/staticDefines`, value));
        continue;
      }
      const editable = getEditableNodeInput(mat, assetNodes, socket, input);
      if (editable && input in target) {
        socketContent.push({
          key: input,
          target,
          label: input,
          ...(editable.kind === 'COLOR' ? { view: 'color' } : {}),
          onChange: (next, e) => onChange(socket, input, next, e.last),
        });
      } else {
        readOnlyTarget[input] = formatReadOnlyValue(value);
        socketContent.push({ key: input, target: readOnlyTarget, label: input, readonly: true });
      }
    }
    content.push({ type: 'folder', id: folderId, title: socket, content: socketContent });
  }
  if (staticDefines && Object.keys(staticDefines).length) {
    content.push(getStaticDefinesFolder('params/TSL inputs/staticDefines', staticDefines));
  }
  if (!content.length) return [];
  return [{ type: 'folder', id: 'params/TSL inputs', title: 'TSL inputs', content }];
};
