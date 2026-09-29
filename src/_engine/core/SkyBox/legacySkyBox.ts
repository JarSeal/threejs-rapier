// Converts the pre-p111 sky box shape (`{ type, params }`) to a layered definition. Used by both
// the schema (legacy *.skybox.json and inline scene sky boxes) and createSkyBox.
// Import only types here: the data pipeline (devTools/gatherAppData.ts) runs this in Node.
import type * as THREE from 'three/webgpu';
import type { SkyBoxBaseDef, SkyBoxDef, SkyBoxEnvDef, SkyBoxOverrides } from './SkyBoxTypes';

type LegacySkyBoxParams = {
  file?: string | THREE.Texture;
  fileNames?: string[] | string;
  /** The legacy JSON name of fileNames. */
  fileName?: string[] | string;
  path?: string;
  textureId?: string;
  colorSpace?: THREE.ColorSpace;
  roughness?: number;
  /** A multiple of π. */
  cubeTextRotate?: number;
  /** The legacy JSON name of cubeTextRotate (a multiple of π). */
  cubeTextureRotate?: number;
  flipY?: boolean;
};

/** The pre-p111 createSkyBox props and *.skybox.json shape. */
export type LegacySkyBoxProps = {
  id: string;
  /** Default true. */
  isCurrent?: boolean;
  sceneId?: string;
  debugData?: SkyBoxDef['debugData'];
  /** '' is "no sky box". CUBEMAP is the legacy JSON name of CUBETEXTURE. */
  type: '' | 'EQUIRECTANGULAR' | 'CUBETEXTURE' | 'CUBEMAP' | 'SKYANDSUN';
  params?: LegacySkyBoxParams | null;
  $schema?: string;
  __sourcePath?: string;
  __saveData?: SkyBoxDef['__saveData'];
};

export const LEGACY_SKYBOX_WARNING =
  'legacy sky box shape ({ type, params }), see p111 migration notes';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Whether `input` has the legacy `{ type, params }` shape, not the layered one. */
export const isLegacySkyBoxProps = (input: unknown): input is LegacySkyBoxProps =>
  isObject(input) && 'type' in input && !('base' in input);

/** Legacy cube file names: an array, or one comma-separated string. */
const toFileNames = (names?: string[] | string) =>
  typeof names === 'string' ? names.split(',').map((name) => name.trim()) : names;

/** The legacy cube rotate was a multiple of π, `rotate` is in radians. */
const toRadians = (piMultiple?: number) =>
  piMultiple !== undefined ? piMultiple * Math.PI : undefined;

const warnedIds = new Set<string>();

/**
 * Converts legacy sky box props to a definition, or returns null for `type: ''` ("no sky box").
 * With `warn`, warns once per sky box id.
 */
export const fromLegacySkyBoxProps = (
  input: LegacySkyBoxProps,
  warn?: (message: string) => void
): SkyBoxDef | null => {
  const { type, params, isCurrent, ...rest } = input;
  const p = params || {};

  if (warn && !warnedIds.has(input.id)) {
    warnedIds.add(input.id);
    const skyAndSunNote =
      type === 'SKYANDSUN'
        ? ' The SKYANDSUN type is now the atmosphere layer (p112), so this shows a COLOR base.'
        : '';
    warn(`Sky box "${input.id}": ${LEGACY_SKYBOX_WARNING}.${skyAndSunNote}`);
  }

  let base: SkyBoxBaseDef;
  if (type === 'EQUIRECTANGULAR') {
    base = {
      type: 'EQUIRECTANGULAR',
      ...(typeof p.file === 'string' ? { file: p.file } : p.file ? { texture: p.file } : {}),
      path: p.path,
      textureId: p.textureId,
      colorSpace: p.colorSpace,
    };
  } else if (type === 'CUBETEXTURE' || type === 'CUBEMAP') {
    base = {
      type: 'CUBE_TEXTURE',
      fileNames: toFileNames(p.fileNames ?? p.fileName) || [],
      path: p.path,
      textureId: p.textureId,
      colorSpace: p.colorSpace,
      rotate: toRadians(p.cubeTextRotate ?? p.cubeTextureRotate),
      flipY: p.flipY,
    };
  } else if (type === 'SKYANDSUN') {
    base = { type: 'COLOR', color: '#000000' };
  } else {
    return null;
  }

  const env: SkyBoxEnvDef = {};
  if (p.roughness !== undefined) env.backgroundRoughness = p.roughness;

  return {
    ...rest,
    ...(isCurrent !== undefined ? { isDefault: isCurrent } : {}),
    base,
    ...(Object.keys(env).length ? { env } : {}),
  };
};

const LEGACY_OVERRIDE_KEYS = [
  'file',
  'fileName',
  'fileNames',
  'path',
  'textureId',
  'colorSpace',
  'roughness',
  'cubeTextRotate',
  'cubeTextureRotate',
  'flipY',
];

/**
 * Converts a legacy (flat, pre-p111) save data entry, eg. `{ colorSpace, roughness }`, to layered
 * overrides. Returns null when `entry` isn't a legacy entry.
 */
export const fromLegacySkyBoxOverrides = (entry: unknown): SkyBoxOverrides | null => {
  if (!isObject(entry) || 'base' in entry || 'env' in entry) return null;
  if (!LEGACY_OVERRIDE_KEYS.some((key) => key in entry)) return null;
  const p = entry as LegacySkyBoxParams & { __meta?: SkyBoxOverrides['__meta'] };
  const base: NonNullable<SkyBoxOverrides['base']> = {
    ...(typeof p.file === 'string' ? { file: p.file } : {}),
    fileNames: toFileNames(p.fileNames ?? p.fileName),
    path: p.path,
    textureId: p.textureId,
    colorSpace: p.colorSpace,
    rotate: toRadians(p.cubeTextRotate ?? p.cubeTextureRotate),
    flipY: p.flipY,
  };
  return {
    ...(p.__meta ? { __meta: p.__meta } : {}),
    base,
    ...(p.roughness !== undefined ? { env: { backgroundRoughness: p.roughness } } : {}),
  };
};
