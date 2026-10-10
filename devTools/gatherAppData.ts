/* eslint-disable no-console */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import z from 'zod';
import type { SceneAsset } from '../src/_engine/schemas/sceneSchema';
import { SceneAssetSchema } from '../src/_engine/schemas/sceneSchema';
import type { CameraAsset } from '../src/_engine/schemas/cameraSchema';
import { CameraAssetSchema } from '../src/_engine/schemas/cameraSchema';
import type { LightAsset } from '../src/_engine/schemas/lightSchema';
import { LightAssetSchema } from '../src/_engine/schemas/lightSchema';
import type { GeoAsset } from '../src/_engine/schemas/geometrySchema';
import { GeoAssetSchema } from '../src/_engine/schemas/geometrySchema';
import type { TextureAsset } from '../src/_engine/schemas/textureSchema';
import { TextureAssetSchema } from '../src/_engine/schemas/textureSchema';
import type { TextureArrayAsset } from '../src/_engine/schemas/textureArraySchema';
import { TextureArrayAssetSchema } from '../src/_engine/schemas/textureArraySchema';
import type { MaterialAsset } from '../src/_engine/schemas/materialSchema';
import { MaterialAssetSchema } from '../src/_engine/schemas/materialSchema';
import type { MeshAsset } from '../src/_engine/schemas/meshSchema';
import { MeshAssetSchema } from '../src/_engine/schemas/meshSchema';
import type { ImportedAsset } from '../src/_engine/schemas/importedAssetSchema';
import { ImportedAssetSchema } from '../src/_engine/schemas/importedAssetSchema';
import type { SkyBoxAsset } from '../src/_engine/schemas/skyBoxSchema';
import { SkyBoxAssetSchema } from '../src/_engine/schemas/skyBoxSchema';
import type { PostFxAsset } from '../src/_engine/schemas/postFxSchema';
import { PostFxAssetSchema } from '../src/_engine/schemas/postFxSchema';
import {
  AssetsConfigSchema,
  type AssetOptimize,
  type TexturePack,
} from '../src/_engine/schemas/assetsConfigSchema';
import { toUniqueJsIdentifier } from '../src/_engine/utils/jsIdentifier';
import type { MetaSchema } from '../src/_engine/schemas/_saveDataSchema';
import {
  isLegacySkyBoxProps,
  LEGACY_SKYBOX_WARNING,
} from '../src/_engine/core/SkyBox/legacySkyBox';
import { deepMerge } from '../src/_engine/utils/deepMerge';
import { mergeSkyBoxPreset } from '../src/_engine/core/SkyBox/presets';
import pkg from '../package.json';
import { createSettingsResolver } from './assetPipeline/settings';
import { listPackFiles } from './assetPipeline/pack';
import { BUDGET_FIX, getBudgetViolations } from './assetPipeline/budgets';
import {
  GENERATED_FIELD_KEYS,
  getAssetResult,
  getGeneratedFields,
  getTextureArrayGeneratedFields,
  getTextureArrayResult,
  getTextureAtlasSlotGeneratedFields,
  getTextureAtlasSlotResult,
  isKtxOnlyAsset,
  isMissingOutput,
} from './assetPipeline/generated';
import type { PipelineRun, PipelineRunResult } from './assetPipeline/run';
import {
  ALLOW_UNOPTIMIZED_ENV_KEY,
  isUnoptimizedAllowed,
  loadProjectOptOut,
} from './assetPipeline/switches';
import {
  createPackSource,
  getAssetSourceFileSize,
  resolveAssetSource,
  resolvePackFile,
  toRepoPath,
} from './assetPipeline/sources';
import {
  getTextureArraySlotSettings,
  resolveTextureArrayLayers,
  type TextureLookup,
} from './assetPipeline/textureArrays';
import {
  getAtlasSlotTextureId,
  TextureAtlasAssetSchema,
  type TextureAtlasSlotTexture,
} from '../src/_engine/schemas/textureAtlasSchema';
import { getAtlasCellTable, resolveTextureAtlas } from './assetPipeline/textureAtlases';
import {
  ImpostorAssetSchema,
  type ImpostorAsset,
  type ImpostorDef,
} from '../src/_engine/schemas/impostorSchema';
import {
  getImpostorDefSlots,
  IMPOSTOR_EXPORT_FORMAT_VERSION,
} from '../src/_engine/core/Lod/Impostors/ImpostorFormat';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const generatedAppDataJSONFilename = 'generatedAppData.json';
export const generatedAppFnsFilename = 'generatedAppFns.ts';
export const OUTPUT_FILE_DATA = path.resolve(
  __dirname,
  `../src/_engine/${generatedAppDataJSONFilename}`
);
export const OUTPUT_FILE_FN = path.resolve(__dirname, `../src/_engine/${generatedAppFnsFilename}`);

const JSON_ENDING_SIGNATURES = {
  scene: '.scene.json',
  camera: '.camera.json',
  light: '.light.json',
  geometry: '.geometry.json',
  texture: '.texture.json',
  textureArray: '.textureArray.json',
  textureAtlas: '.textureAtlas.json',
  material: '.material.json',
  mesh: '.mesh.json',
  importedAsset: '.importedAsset.json',
  skybox: '.skybox.json',
  // physicsObjects: '.physObj.json',
  postFx: '.postFx.json',
  impostor: '.impostor.json',
};

type ZodIssue = z.ZodError['issues'][number];

/** A union's "Invalid input" says nothing: when exactly one branch got past its type check (eg.
 * `optimize`'s object, not its `false`), its own issues are the ones to show. Nor does a record's
 * "Invalid key in record": the key's own issues are shown instead. */
const expandUnionIssues = (issues: ZodIssue[]): ZodIssue[] =>
  issues.flatMap((issue) => {
    if (issue.code === 'invalid_key') {
      return expandUnionIssues(
        issue.issues.map((keyIssue) => ({ ...keyIssue, path: [...issue.path, ...keyIssue.path] }))
      );
    }
    if (issue.code !== 'invalid_union') return [issue];
    const isTypeMismatch = (branchIssue: ZodIssue) =>
      !branchIssue.path.length &&
      (branchIssue.code === 'invalid_type' || branchIssue.code === 'invalid_value');
    const matching = issue.errors.filter((branch) => !branch.every(isTypeMismatch));
    if (matching.length !== 1) return [issue];
    return expandUnionIssues(
      matching[0].map((branchIssue) => ({
        ...branchIssue,
        path: [...issue.path, ...branchIssue.path],
      }))
    );
  });

// The schema each gathered JSON is validated with
const GATHERED_SCHEMAS: Record<keyof typeof JSON_ENDING_SIGNATURES, z.ZodType> = {
  scene: SceneAssetSchema,
  camera: CameraAssetSchema,
  light: LightAssetSchema,
  geometry: GeoAssetSchema,
  texture: TextureAssetSchema,
  textureArray: TextureArrayAssetSchema,
  textureAtlas: TextureAtlasAssetSchema,
  material: MaterialAssetSchema,
  mesh: MeshAssetSchema,
  importedAsset: ImportedAssetSchema,
  skybox: SkyBoxAssetSchema,
  postFx: PostFxAssetSchema,
  impostor: ImpostorAssetSchema,
};

// The gathered types without per-scene `__saveData`
const TYPES_WITHOUT_SAVE_DATA: (keyof typeof JSON_ENDING_SIGNATURES)[] = [
  'textureArray',
  'textureAtlas',
  'impostor',
];

const getGatheredJsonType = (filePath: string) =>
  (Object.keys(JSON_ENDING_SIGNATURES) as (keyof typeof JSON_ENDING_SIGNATURES)[]).find((key) =>
    filePath.endsWith(JSON_ENDING_SIGNATURES[key])
  );

/** Whether the file name is a gathered type whose schema has `__saveData` (the dev file server's
 * save entry writes, p342) */
export const hasGatheredSaveData = (filePath: string) => {
  const type = getGatheredJsonType(filePath);
  return !!type && !TYPES_WITHOUT_SAVE_DATA.includes(type);
};

/**
 * Validates a JSON value against the schema of the gathered type its file name says (the dev
 * file server's writes, p342), as the gather would. Returns null when it passes or the file isn't
 * a gathered type, else the issues the gatherer would log.
 */
export const validateGatheredJson = (filePath: string, data: unknown) => {
  const type = getGatheredJsonType(filePath);
  if (!type) return null;
  let value = data;
  // The gather defaults a sky box's id to its file name before validating
  if (type === 'skybox' && value && typeof value === 'object' && !('id' in value && value.id)) {
    value = { ...value, id: path.basename(filePath, JSON_ENDING_SIGNATURES.skybox) };
  }
  const validation = GATHERED_SCHEMAS[type].safeParse(value);
  if (validation.success) return null;
  return expandUnionIssues(validation.error.issues).map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
};

const logValidationError = (msg: string, issues: z.ZodError['issues']) => {
  const errorDetails = expandUnionIssues(issues)
    .map((err) => ` └─ [${err.path.join('.')}]: ${err.message}`)
    .join('\n');
  console.error(`\x1b[31m✗ [Scene Gatherer] ${msg}:\n${errorDetails}\x1b[0m`);
};

// Versions of the current build, compared against the ones stamped in save entries' __meta
const CURRENT_VERSIONS = {
  engineVersion: pkg.engine_metadata.version,
  toolkitVersion: pkg.toolkit_metadata.version,
  appVersion: pkg.app_metadata.version,
};
const majorOf = (version: string) => Number(version.split('.')[0]);

/** Warns (doesn't fail) when a scene's applied save entry (the latest, index 0) was stamped
 * under another major version of a part than the current build: a breaking change may have
 * changed what its overrides mean. Entries without stamps are never warned about. */
const warnOnStaleSaveData = (
  file: string,
  data: { __saveData?: Record<string, { __meta?: z.infer<typeof MetaSchema> }[]> }
) => {
  for (const [sceneId, entries] of Object.entries(data.__saveData ?? {})) {
    const meta = entries?.[0]?.__meta;
    if (!meta) continue;
    for (const key of Object.keys(CURRENT_VERSIONS) as (keyof typeof CURRENT_VERSIONS)[]) {
      const saved = meta[key];
      const current = CURRENT_VERSIONS[key];
      if (!saved || majorOf(saved) === majorOf(current)) continue;
      console.warn(
        `\x1b[33m⚠ [Scene Gatherer] Save data for scene "${sceneId}" in ${file} was saved with ${key} ${saved}, the current one is ${current} (another major version). Check that its overrides still apply.\x1b[0m`
      );
    }
  }
};

/** Warns (doesn't fail) about a sky box in the legacy `{ type, params }` shape: the schema still
 * converts it, but it should be migrated to the layered one. */
const warnOnLegacySkyBox = (file: string, data: unknown) => {
  if (!isLegacySkyBoxProps(data)) return;
  const skyAndSunNote =
    data.type === 'SKYANDSUN'
      ? ' The SKYANDSUN type is now the atmosphere layer (p112), so it becomes a COLOR base.'
      : '';
  console.warn(
    `\x1b[33m⚠ [Scene Gatherer] Sky box "${data.id}" in ${file}: ${LEGACY_SKYBOX_WARNING}.${skyAndSunNote}\x1b[0m`
  );
};

const logDuplicateIdError = (type: string, id: string, file: string) => {
  console.error(
    `\x1b[31m✗ [Scene Gatherer] Duplicate ${type} ID found: ${id} in file: ${file}\x1b[0m`
  );
};

/** Bytes on disk of an asset JSON's source file (relative to the JSON, or served from
 * src/public by its URL path, eg. '/debugger/assets/box.glb'), or undefined if it is missing.
 * Remote URLs have no size here (the debugger can measure them on demand). */
const getSourceFileSize = (jsonFile: string, fileName?: string, urlPath?: string) => {
  if (!fileName) return undefined;
  const source = resolveAssetSource({ jsonFile, fileName, path: urlPath });
  return 'error' in source ? undefined : getAssetSourceFileSize(source);
};

type SourcedAsset = {
  fileName?: string;
  path?: string;
  optimize?: AssetOptimize;
  pack?: TexturePack;
  useHDRLoader?: boolean;
  __saveData?: Record<string, { fileName?: string; path?: string }[] | undefined>;
};

/** A texture's `pack` (p300 DD5): in place of `fileName`, and every source file must exist. */
const checkPackSources = (fullPath: string, data: SourcedAsset & { pack: TexturePack }) => {
  const errors: string[] = [];
  if (data.fileName || data.path) {
    errors.push('"pack" builds the texture: it can\'t be combined with "fileName" or "path"');
  }
  if (data.useHDRLoader) errors.push('"pack" writes an 8-bit image: remove "useHDRLoader"');
  for (const src of listPackFiles(data.pack)) {
    try {
      resolvePackFile(fullPath, src);
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  return errors;
};

/** Checks an asset JSON's source files, its own and each scene's latest save entry's (p300 DD3),
 * and resolves its `optimize` settings for each (an unknown profile throws). Logs every problem
 * and returns false if there was one. */
const checkAssetSources = (
  file: string,
  fullPath: string,
  data: SourcedAsset,
  resolveSettings: ReturnType<typeof createSettingsResolver>
) => {
  if (data.pack) {
    const { pack } = data;
    const errors = checkPackSources(fullPath, { ...data, pack });
    try {
      const { repoPath } = createPackSource(fullPath, pack);
      resolveSettings({ sourcePath: repoPath, optimize: data.optimize });
    } catch (e) {
      errors.push((e as Error).message);
    }
    for (const error of errors) {
      console.error(`\x1b[31m✗ [Scene Gatherer] ${file}: ${error}\x1b[0m`);
    }
    if (errors.length) return false;
  }
  const sources = [{ label: '', fileName: data.fileName, path: data.path }];
  for (const [sceneId, entries] of Object.entries(data.__saveData ?? {})) {
    const entry = entries?.[0];
    if (!entry?.fileName && !entry?.path) continue;
    sources.push({
      label: ` (save data of scene "${sceneId}")`,
      fileName: entry.fileName ?? data.fileName,
      path: entry.path ?? data.path,
    });
  }
  let isValid = true;
  for (const { label, fileName, path: urlPath } of sources) {
    if (!fileName) continue;
    const source = resolveAssetSource({ jsonFile: fullPath, fileName, path: urlPath });
    let error = 'error' in source ? source.error : undefined;
    if (!('error' in source) && data.optimize) {
      if (source.kind === 'remote') {
        error = `"optimize" is set, but a remote file ("${fileName}") can't be optimized`;
      } else {
        try {
          resolveSettings({ sourcePath: source.repoPath, optimize: data.optimize });
        } catch (e) {
          error = (e as Error).message;
        }
      }
    }
    if (error) {
      console.error(`\x1b[31m✗ [Scene Gatherer] ${file}${label}: ${error}\x1b[0m`);
      isValid = false;
    }
  }
  return isValid;
};

export const isFilePathValid = (filePath: string) => {
  const keys = Object.keys(JSON_ENDING_SIGNATURES);
  for (let i = 0; i < keys.length; i++) {
    if (filePath.endsWith(JSON_ENDING_SIGNATURES[keys[i] as keyof typeof JSON_ENDING_SIGNATURES]))
      return true;
  }
  return false;
};

export const getBasePath = (fullPath: string) => {
  const splitPath = fullPath.split('/src/');
  if (!splitPath.length) return '';
  const splitFolders = splitPath[splitPath.length - 1].split('/');
  return splitFolders[0];
};

// Helper to write JSON Schema definitions to a hidden workspace folder
const compileJsonSchemas = () => {
  const schemasDir = path.resolve(__dirname, '../.schemas');
  fs.mkdirSync(schemasDir, { recursive: true });

  const targets = [
    { name: 'scene.schema.json', schema: SceneAssetSchema },
    { name: 'camera.schema.json', schema: CameraAssetSchema },
    { name: 'light.schema.json', schema: LightAssetSchema },
    { name: 'geometry.schema.json', schema: GeoAssetSchema },
    { name: 'texture.schema.json', schema: TextureAssetSchema },
    { name: 'textureArray.schema.json', schema: TextureArrayAssetSchema },
    { name: 'textureAtlas.schema.json', schema: TextureAtlasAssetSchema },
    { name: 'material.schema.json', schema: MaterialAssetSchema },
    { name: 'mesh.schema.json', schema: MeshAssetSchema },
    { name: 'importedAsset.schema.json', schema: ImportedAssetSchema },
    { name: 'skyBox.schema.json', schema: SkyBoxAssetSchema },
    { name: 'postFx.schema.json', schema: PostFxAssetSchema },
    { name: 'impostor.schema.json', schema: ImpostorAssetSchema },
    { name: 'assetsConfig.schema.json', schema: AssetsConfigSchema },
  ];

  for (const target of targets) {
    const nativeSchema = z.toJSONSchema(target.schema, { target: 'draft-07' });
    const finalSchema = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      ...nativeSchema,
    };
    fs.writeFileSync(
      path.resolve(schemasDir, target.name),
      JSON.stringify(finalSchema, null, 2),
      'utf-8'
    );
  }
  console.log(
    '\x1b[32m✓ [Schema Compiler] Natively generated IDE autocompletion blueprints.\x1b[0m'
  );
};
// Execute compilation immediately when the script spins up
compileJsonSchemas();

/**
 * Gathers the asset JSONs into the generated data.
 * @param opts.pipeline An asset pipeline run over the same JSONs (p300 §5): each texture and
 * imported asset gets its output's `__url` and figures, per scene when a scene's save entry
 * points at another file. Without one, they get none.
 */
export const gatherSceneData = (opts: { pipeline?: PipelineRun } = {}) => {
  const isProduction = process.env.NODE_ENV === 'production';
  let hasError = false;
  // Removes the asset's own generated keys from a scene entry and adds its file's
  const setGeneratedFields = (
    data: Parameters<typeof getGeneratedFields>[3],
    type: 'texture' | 'importedAsset',
    jsonFile: string
  ) => {
    for (const key of GENERATED_FIELD_KEYS) delete (data as Record<string, unknown>)[key];
    Object.assign(data, getGeneratedFields(opts.pipeline, type, jsonFile, data, { isProduction }));
  };
  // A production build ships only the outputs (p300), within their budgets (Phase 4): the scenes
  // using an asset without one, or over its budget
  const missingOutputs = new Map<PipelineRunResult, Set<string>>();
  const overBudget = new Map<PipelineRunResult, Set<string>>();
  const checkShippedResult = (result: PipelineRunResult | null, sceneId: string) => {
    if (!result) return;
    const failed = isMissingOutput(result)
      ? missingOutputs
      : getBudgetViolations(result).length
        ? overBudget
        : null;
    failed?.set(result, (failed.get(result) ?? new Set()).add(sceneId));
  };
  const checkShippedOutput = (
    data: Parameters<typeof getGeneratedFields>[3],
    type: 'texture' | 'importedAsset',
    jsonFile: string,
    sceneId: string
  ) => {
    if (!isProduction || !opts.pipeline) return;
    checkShippedResult(getAssetResult(opts.pipeline, type, jsonFile, data), sceneId);
  };
  const checkShippedArray = (jsonFile: string, sceneId: string) => {
    if (!isProduction || !opts.pipeline) return;
    checkShippedResult(getTextureArrayResult(opts.pipeline, jsonFile), sceneId);
  };
  const checkShippedAtlasSlot = (jsonFile: string, slot: string, sceneId: string) => {
    if (!isProduction || !opts.pipeline) return;
    checkShippedResult(getTextureAtlasSlotResult(opts.pipeline, jsonFile, slot), sceneId);
  };

  const srcDir = path.resolve(__dirname, '../src');
  const combinedData: {
    scenes: Record<string, SceneAsset>;
    cameras: Record<string, CameraAsset>;
    lights: Record<string, LightAsset>;
    geometries: Record<string, GeoAsset>;
    textures: Record<string, TextureAsset | TextureArrayAsset | TextureAtlasSlotTexture>;
    materials: Record<string, MaterialAsset>;
    meshes: Record<string, unknown>;
    importedAssets: Record<string, unknown>;
    skyboxes: Record<string, unknown>;
    postFx: Record<string, PostFxAsset>;
    impostors: Record<string, ImpostorAsset>;
  } = {
    scenes: {},
    cameras: {},
    lights: {},
    geometries: {},
    textures: {},
    materials: {},
    meshes: {},
    importedAssets: {},
    skyboxes: {},
    // physicsObjects: {},
    postFx: {},
    impostors: {},
  };
  let sceneFileImports = `// THIS IS AN AUTO-GENERATED FILE, DO NOT MODIFY!\n// ALSO, DO NOT MODIFY THE '${generatedAppDataJSONFilename}' FILE)!\n`;
  let addedFirstImport = false;
  let sceneFileObject = '';
  let tslMaterialFileObject = '';
  let postFxFileObject = '';
  // Shared by material and PostFX TS imports, which land in the same generated file
  const usedImportNamespaces = new Set<string>();
  const ids: {
    scenes: string[];
    cameras: string[];
    lights: string[];
    geometries: string[];
    textures: string[];
    materials: string[];
    meshes: string[];
    importedAssets: string[];
    skyboxes: string[];
    postFx: string[];
    impostors: string[];
  } = {
    scenes: [],
    cameras: [],
    lights: [],
    geometries: [],
    textures: [],
    materials: [],
    meshes: [],
    importedAssets: [],
    skyboxes: [],
    postFx: [],
    impostors: [],
  };

  const logJSONError = (file: string) =>
    console.error(
      `\x1b[31m✗ [Scene Gatherer] File content for file '${file}' is invalid or empty.\x1b[0m`
    );

  // Validates assets.config.json (p300); its errors stop the gathering like an asset's would
  let resolveSettings: ReturnType<typeof createSettingsResolver>;
  try {
    resolveSettings = createSettingsResolver();
  } catch (err) {
    console.error(`\x1b[31m✗ [Scene Gatherer] ${(err as Error).message}\x1b[0m`);
    return false;
  }

  try {
    // Read src directory recursively (Supported natively in Node 22+)
    const files = fs.readdirSync(srcDir, { recursive: true });

    // Gather scene files
    const sceneFilesArray = [];
    const sceneFiles = files.filter(
      (file) => typeof file === 'string' && file.endsWith(JSON_ENDING_SIGNATURES.scene)
    ) as string[];
    for (const file of sceneFiles) {
      const fullPath = path.resolve(srcDir, file);
      const fileContent = fs.readFileSync(fullPath, 'utf-8');
      try {
        const parsedData = JSON.parse(fileContent);

        // Validate scene file content against schema
        for (const sky of parsedData?.skyboxes || []) warnOnLegacySkyBox(file, sky);
        const validation = SceneAssetSchema.safeParse(parsedData);
        if (validation.success) warnOnStaleSaveData(file, validation.data);
        if (!validation.success) {
          logValidationError(`Validation error inside scene file ${file}`, validation.error.issues);
          hasError = true;
          continue;
        }

        const sceneId = validation.data.id || path.basename(file, JSON_ENDING_SIGNATURES.scene);
        if (ids.scenes.includes(sceneId)) {
          logDuplicateIdError('scene', sceneId, file);
          continue;
        }
        ids.scenes.push(sceneId);

        const latestSave = validation.data.__saveData?.[sceneId]?.[0] || {};
        const fileContentJSON = { ...validation.data, ...latestSave };
        fileContentJSON.__sourcePath = path.relative(path.resolve(__dirname, '..'), fullPath);
        if (fileContentJSON.sceneFile) sceneFilesArray.push(fileContentJSON);
      } catch (e) {
        logJSONError(file);
        throw new Error((e as Error).message);
      }
    }

    // Cameras
    const cameraRegistry: Record<string, CameraAsset> = {};
    const cameraFiles = files.filter(
      (file) => typeof file === 'string' && file.endsWith(JSON_ENDING_SIGNATURES.camera)
    ) as string[];
    for (const file of cameraFiles) {
      const fullPath = path.resolve(srcDir, file);
      const fileContent = fs.readFileSync(fullPath, 'utf-8');
      try {
        const parsedData = JSON.parse(fileContent);
        const validation = CameraAssetSchema.safeParse(parsedData);
        if (validation.success) warnOnStaleSaveData(file, validation.data);
        if (!validation.success) {
          logValidationError(
            `Validation error inside camera file ${file}`,
            validation.error.issues
          );
          hasError = true;
          continue;
        }
        const cameraJSON = validation.data;
        const cameraId =
          cameraJSON.camProps?.appId ||
          cameraJSON.entityOpts?.appId ||
          path.basename(file, JSON_ENDING_SIGNATURES.camera);
        if (ids.cameras.includes(cameraId)) {
          logDuplicateIdError('camera', cameraId, file);
          continue;
        }
        ids.cameras.push(cameraId);
        cameraJSON.camProps.appId = cameraId;
        cameraJSON.__sourcePath = path.relative(path.resolve(__dirname, '..'), fullPath);
        delete cameraJSON.$schema;
        cameraRegistry[cameraId] = cameraJSON;
      } catch {
        logJSONError(file);
      }
    }
    combinedData.cameras = cameraRegistry;

    // Lights
    const lightRegistry: Record<string, LightAsset> = {};
    const lightFiles = files.filter(
      (file) => typeof file === 'string' && file.endsWith(JSON_ENDING_SIGNATURES.light)
    ) as string[];
    for (const file of lightFiles) {
      const fullPath = path.resolve(srcDir, file);
      const fileContent = fs.readFileSync(fullPath, 'utf-8');
      try {
        const parsedData = JSON.parse(fileContent);
        const validation = LightAssetSchema.safeParse(parsedData);
        if (validation.success) warnOnStaleSaveData(file, validation.data);
        if (!validation.success) {
          logValidationError(`Validation error inside light file ${file}`, validation.error.issues);
          hasError = true;
          continue;
        }
        const lightJSON = validation.data;
        const lightId =
          lightJSON.lightProps?.appId ||
          lightJSON.entityOpts?.appId ||
          path.basename(file, JSON_ENDING_SIGNATURES.light);
        if (ids.lights.includes(lightId)) {
          logDuplicateIdError('light', lightId, file);
          continue;
        }
        ids.lights.push(lightId);
        lightJSON.lightProps.appId = lightId;
        lightJSON.__sourcePath = path.relative(path.resolve(__dirname, '..'), fullPath);
        delete lightJSON.$schema;
        lightRegistry[lightId] = lightJSON;
      } catch {
        logJSONError(file);
      }
    }
    combinedData.lights = lightRegistry;

    // Geometries
    const geoRegistry: Record<string, GeoAsset> = {};
    const geoFiles = files.filter(
      (file) => typeof file === 'string' && file.endsWith(JSON_ENDING_SIGNATURES.geometry)
    ) as string[];
    for (const file of geoFiles) {
      const fullPath = path.resolve(srcDir, file);
      const fileContent = fs.readFileSync(fullPath, 'utf-8');
      try {
        const parsedData = JSON.parse(fileContent);
        const validation = GeoAssetSchema.safeParse(parsedData);
        if (validation.success) warnOnStaleSaveData(file, validation.data);
        if (!validation.success) {
          logValidationError(
            `Validation error inside geometry file ${file}`,
            validation.error.issues
          );
          hasError = true;
          continue;
        }
        const geoJSON = validation.data;
        const geoId = geoJSON.geoProps.id || path.basename(file, JSON_ENDING_SIGNATURES.geometry);
        if (ids.geometries.includes(geoId)) {
          logDuplicateIdError('geometry', geoId, file);
          continue;
        }
        ids.geometries.push(geoId);
        geoJSON.geoProps.id = geoId;
        geoJSON.__sourcePath = path.relative(path.resolve(__dirname, '..'), fullPath);
        delete geoJSON.$schema;
        geoRegistry[geoId] = geoJSON;
      } catch {
        logJSONError(file);
      }
    }
    combinedData.geometries = geoRegistry;

    // Textures
    const texRegistry: Record<string, TextureAsset> = {};
    const texFiles = files.filter(
      (file) => typeof file === 'string' && file.endsWith(JSON_ENDING_SIGNATURES.texture)
    ) as string[];
    for (const file of texFiles) {
      const fullPath = path.resolve(srcDir, file);
      const fileContent = fs.readFileSync(fullPath, 'utf-8');
      try {
        const parsedData = JSON.parse(fileContent);
        const validation = TextureAssetSchema.safeParse(parsedData);
        if (validation.success) warnOnStaleSaveData(file, validation.data);
        if (!validation.success) {
          logValidationError(
            `Validation error inside texture file ${file}`,
            validation.error.issues
          );
          hasError = true;
          continue;
        }
        const texJSON = validation.data;
        if (!checkAssetSources(file, fullPath, texJSON, resolveSettings)) {
          hasError = true;
          continue;
        }
        const texId = texJSON.id || path.basename(file, JSON_ENDING_SIGNATURES.texture);
        if (ids.textures.includes(texId)) {
          logDuplicateIdError('texture', texId, file);
          continue;
        }
        ids.textures.push(texId);
        texJSON.__sourcePath = path.relative(path.resolve(__dirname, '..'), fullPath);
        texJSON.__fileSize = getSourceFileSize(fullPath, texJSON.fileName, texJSON.path);
        setGeneratedFields(texJSON, 'texture', fullPath);
        texJSON.id = texId;
        delete texJSON.$schema;
        texRegistry[texId] = texJSON;
      } catch {
        logJSONError(file);
      }
    }

    // A texture asset by id, for the arrays' layers and the atlases' cells
    const findTexture: TextureLookup = (id) =>
      texRegistry[id] && {
        jsonFile: path.resolve(__dirname, '..', texRegistry[id].__sourcePath || ''),
        data: texRegistry[id],
      };

    // Texture arrays (p299 D2): textures at runtime, in the textures' registry and id space. After
    // the textures: a layer can be a texture asset's source.
    const arrayRegistry: Record<string, TextureArrayAsset> = {};
    const arrayFiles = files.filter(
      (file) => typeof file === 'string' && file.endsWith(JSON_ENDING_SIGNATURES.textureArray)
    ) as string[];
    for (const file of arrayFiles) {
      const fullPath = path.resolve(srcDir, file);
      const fileContent = fs.readFileSync(fullPath, 'utf-8');
      try {
        const parsedData = JSON.parse(fileContent);
        const validation = TextureArrayAssetSchema.safeParse(parsedData);
        if (!validation.success) {
          logValidationError(
            `Validation error inside texture array file ${file}`,
            validation.error.issues
          );
          hasError = true;
          continue;
        }
        const arrayJSON = validation.data;
        const { layers, errors } = resolveTextureArrayLayers(
          fullPath,
          arrayJSON.layers,
          findTexture,
          { isSrgb: arrayJSON.texOpts?.colorSpace === 'srgb' }
        );
        try {
          getTextureArraySlotSettings(
            resolveSettings({ sourcePath: toRepoPath(fullPath), optimize: arrayJSON.optimize })
          );
        } catch (e) {
          errors.push((e as Error).message);
        }
        if (errors.length) {
          for (const error of errors) {
            console.error(`\x1b[31m✗ [Scene Gatherer] ${file}: ${error}\x1b[0m`);
          }
          hasError = true;
          continue;
        }
        const arrayId = arrayJSON.id || path.basename(file, JSON_ENDING_SIGNATURES.textureArray);
        if (ids.textures.includes(arrayId)) {
          logDuplicateIdError('texture (or texture array)', arrayId, file);
          continue;
        }
        ids.textures.push(arrayId);
        arrayJSON.__sourcePath = path.relative(path.resolve(__dirname, '..'), fullPath);
        arrayJSON.__layers = layers.map((layer) => layer.key);
        for (const key of GENERATED_FIELD_KEYS) delete (arrayJSON as Record<string, unknown>)[key];
        Object.assign(arrayJSON, getTextureArrayGeneratedFields(opts.pipeline, fullPath));
        arrayJSON.id = arrayId;
        delete arrayJSON.$schema;
        arrayRegistry[arrayId] = arrayJSON;
      } catch {
        logJSONError(file);
      }
    }
    // Texture atlases (p299 D3): each slot is a texture at runtime (`<atlasId>.<slot>`), in the
    // textures' registry and id space; the atlas id is taken too (a scene lists it for every slot).
    // After the textures: a cell's source can be a texture asset's.
    const atlasSlotRegistry: Record<string, TextureAtlasSlotTexture> = {};
    // An atlas's slot ids in the JSON's order: what a scene listing the atlas id gets
    const atlasSlotIds: Record<string, string[]> = {};
    const atlasFiles = files.filter(
      (file) => typeof file === 'string' && file.endsWith(JSON_ENDING_SIGNATURES.textureAtlas)
    ) as string[];
    for (const file of atlasFiles) {
      const fullPath = path.resolve(srcDir, file);
      const fileContent = fs.readFileSync(fullPath, 'utf-8');
      try {
        const parsedData = JSON.parse(fileContent);
        const validation = TextureAtlasAssetSchema.safeParse(parsedData);
        if (!validation.success) {
          logValidationError(
            `Validation error inside texture atlas file ${file}`,
            validation.error.issues
          );
          hasError = true;
          continue;
        }
        const atlasJSON = validation.data;
        const { layout, errors, warnings } = resolveTextureAtlas(fullPath, atlasJSON, findTexture);
        for (const [slot, { optimize }] of Object.entries(atlasJSON.slots)) {
          try {
            getTextureArraySlotSettings(
              resolveSettings({ sourcePath: toRepoPath(fullPath), optimize }),
              'an atlas slot'
            );
          } catch (e) {
            errors.push(`slots.${slot}: ${(e as Error).message}`);
          }
        }
        for (const warning of warnings) {
          console.warn(`\x1b[33m⚠ [Scene Gatherer] ${file}: ${warning}\x1b[0m`);
        }
        if (errors.length || !layout) {
          for (const error of errors) {
            console.error(`\x1b[31m✗ [Scene Gatherer] ${file}: ${error}\x1b[0m`);
          }
          hasError = true;
          continue;
        }
        const atlasId = atlasJSON.id || path.basename(file, JSON_ENDING_SIGNATURES.textureAtlas);
        const slotIds = Object.keys(atlasJSON.slots).map((slot) =>
          getAtlasSlotTextureId(atlasId, slot)
        );
        const takenId = [atlasId, ...slotIds].find((id) => ids.textures.includes(id));
        if (takenId) {
          logDuplicateIdError('texture (or a texture atlas or its slot)', takenId, file);
          continue;
        }
        ids.textures.push(atlasId, ...slotIds);
        atlasSlotIds[atlasId] = slotIds;
        const sourcePath = path.relative(path.resolve(__dirname, '..'), fullPath);
        const cells = getAtlasCellTable(layout);
        for (const [slot, slotJSON] of Object.entries(atlasJSON.slots)) {
          const slotId = getAtlasSlotTextureId(atlasId, slot);
          const userData = { ...atlasJSON.userData, ...slotJSON.userData };
          const debugData = slotJSON.debugData ?? atlasJSON.debugData;
          atlasSlotRegistry[slotId] = {
            id: slotId,
            ...(slotJSON.texOpts ? { texOpts: slotJSON.texOpts } : {}),
            ...(atlasJSON.throwOnError !== undefined
              ? { throwOnError: atlasJSON.throwOnError }
              : {}),
            ...(Object.keys(userData).length ? { userData } : {}),
            ...(debugData ? { debugData } : {}),
            __sourcePath: sourcePath,
            __atlas: {
              id: atlasId,
              slot,
              size: layout.size,
              padding: layout.padding,
              levels: layout.levels,
              ...(layout.mipChain === 'FULL' ? { mipChain: 'FULL' as const } : {}),
              ...(slotJSON.image ? { fromImage: true as const } : {}),
              cells,
            },
            ...getTextureAtlasSlotGeneratedFields(opts.pipeline, fullPath, slot),
          };
        }
      } catch {
        logJSONError(file);
      }
    }
    combinedData.textures = { ...texRegistry, ...arrayRegistry, ...atlasSlotRegistry };

    // Exported impostors (p351 Phase 4), in their own id space. After the atlases: an impostor's
    // atlas must have its kind's slots, at its layout's size.
    const impostorRegistry: Record<string, ImpostorAsset> = {};
    const impostorFiles = files.filter(
      (file) => typeof file === 'string' && file.endsWith(JSON_ENDING_SIGNATURES.impostor)
    ) as string[];
    for (const file of impostorFiles) {
      const fullPath = path.resolve(srcDir, file);
      const fileContent = fs.readFileSync(fullPath, 'utf-8');
      try {
        const parsedData = JSON.parse(fileContent);
        const validation = ImpostorAssetSchema.safeParse(parsedData);
        if (!validation.success) {
          logValidationError(
            `Validation error inside impostor file ${file}`,
            validation.error.issues
          );
          hasError = true;
          continue;
        }
        const impostorJSON = validation.data;
        const errors: string[] = [];
        const slotIds = atlasSlotIds[impostorJSON.atlas];
        if (!slotIds) {
          errors.push(`its atlas "${impostorJSON.atlas}" isn't a *.textureAtlas.json id`);
        } else {
          const slots = new Set(slotIds.map((id) => atlasSlotRegistry[id].__atlas.slot));
          const reads = getImpostorDefSlots(impostorJSON);
          const missing = reads.filter((slot) => !slots.has(slot));
          if (missing.length) {
            errors.push(
              `its atlas "${impostorJSON.atlas}" has no slot ${missing.map((slot) => `"${slot}"`).join(', ')} (this ${impostorJSON.kind} impostor reads ${reads.join(', ')})`
            );
          }
          const { atlasSize } = impostorJSON.layout;
          const [layoutWidth, layoutHeight] =
            typeof atlasSize === 'number' ? [atlasSize, atlasSize] : atlasSize;
          const [width, height] = atlasSlotRegistry[slotIds[0]].__atlas.size;
          if (width !== layoutWidth || height !== layoutHeight) {
            errors.push(
              `its atlas "${impostorJSON.atlas}" is ${width}×${height}, its layout's atlasSize is ${layoutWidth}×${layoutHeight}`
            );
          }
        }
        if (errors.length) {
          for (const error of errors) {
            console.error(`\x1b[31m✗ [Scene Gatherer] ${file}: ${error}\x1b[0m`);
          }
          hasError = true;
          continue;
        }
        // The runtime refuses another format and bakes instead: valid, but worth a re-export
        if (impostorJSON.formatVersion !== IMPOSTOR_EXPORT_FORMAT_VERSION) {
          console.warn(
            `\x1b[33m⚠ [Scene Gatherer] ${file}: export format ${impostorJSON.formatVersion}, the engine's is ${IMPOSTOR_EXPORT_FORMAT_VERSION}. Scenes listing it don't load it, and the runtime bakes it instead: re-export it (the LOD tab's Impostors).\x1b[0m`
          );
        }
        const impostorId = impostorJSON.id || path.basename(file, JSON_ENDING_SIGNATURES.impostor);
        if (ids.impostors.includes(impostorId)) {
          logDuplicateIdError('impostor', impostorId, file);
          continue;
        }
        ids.impostors.push(impostorId);
        impostorJSON.id = impostorId;
        impostorJSON.__sourcePath = path.relative(path.resolve(__dirname, '..'), fullPath);
        delete impostorJSON.$schema;
        impostorRegistry[impostorId] = impostorJSON;
      } catch {
        logJSONError(file);
      }
    }
    combinedData.impostors = impostorRegistry;

    // Materials
    const matRegistry: Record<string, MaterialAsset> = {};
    const matFiles = files.filter(
      (file) => typeof file === 'string' && file.endsWith(JSON_ENDING_SIGNATURES.material)
    ) as string[];
    for (const file of matFiles) {
      const fullPath = path.resolve(srcDir, file);
      const fileContent = fs.readFileSync(fullPath, 'utf-8');
      try {
        const parsedData = JSON.parse(fileContent);
        const validation = MaterialAssetSchema.safeParse(parsedData);
        if (validation.success) warnOnStaleSaveData(file, validation.data);
        if (!validation.success) {
          logValidationError(
            `Validation error inside material file ${file}`,
            validation.error.issues
          );
          hasError = true;
          continue;
        }
        const matJSON = validation.data;
        const matId = matJSON.id || path.basename(file, JSON_ENDING_SIGNATURES.material);
        if (ids.materials.includes(matId)) {
          logDuplicateIdError('material', matId, file);
          continue;
        }
        ids.materials.push(matId);
        matJSON.id = matId;
        matJSON.__sourcePath = path.relative(path.resolve(__dirname, '..'), fullPath);
        delete matJSON.$schema;
        matRegistry[matId] = matJSON;
        const isFoundInAScene = sceneFilesArray.find(
          (sceneFile) => sceneFile.materials?.includes(matId) || false
        );

        if ((isFoundInAScene || !isProduction) && 'tslFile' in matJSON && matJSON.tslFile) {
          const basePath = getBasePath(fullPath);

          // Assert physical existence of script tracking path on disk
          let matTslFilePath = path.resolve(srcDir, basePath, matJSON.tslFile);
          if (!fs.existsSync(matTslFilePath) && !path.extname(matTslFilePath)) {
            if (fs.existsSync(matTslFilePath + '.ts')) {
              matTslFilePath += '.ts';
            }
          }
          if (!fs.existsSync(matTslFilePath)) {
            console.error(
              `\x1b[31m✗ [Scene Gatherer] Error gathering material data: specified tslFile "${matJSON.tslFile}" does not exist on disk.\n  └─ Expected path: ${matTslFilePath}\x1b[0m`
            );
            hasError = true;
            continue;
          }

          const runtimeUniqueNamespace = toUniqueJsIdentifier(
            `${matId}Fn`,
            usedImportNamespaces,
            'mat'
          );
          sceneFileImports += `import * as ${runtimeUniqueNamespace} from '../${basePath}/${matJSON.tslFile}';\n`;

          if (!tslMaterialFileObject) {
            tslMaterialFileObject += 'export const tslMaterialFileObjects = {\n';
          }

          // Use single quotes if the identifier starts with a number or contains characters that are not valid in JS identifiers, otherwise keep it unquoted to match lint rules
          tslMaterialFileObject += `  ${matId.match(/^[0-9]/) ? `'${matId}'` : matId}: {\n`;
          if (matJSON.nodes) {
            for (const nodeSocket of Object.keys(matJSON.nodes)) {
              // Automatically match keys from the JSON configuration mapping straight to the typescript exports namespace
              tslMaterialFileObject += `    ${nodeSocket}: ${runtimeUniqueNamespace}.${nodeSocket},\n`;
            }
          }
          tslMaterialFileObject += `  },\n`;
        }
      } catch {
        logJSONError(file);
      }
    }
    combinedData.materials = matRegistry;

    // Meshes
    const meshRegistry: Record<string, MeshAsset> = {};
    const meshFiles = files.filter(
      (file) => typeof file === 'string' && file.endsWith(JSON_ENDING_SIGNATURES.mesh)
    ) as string[];
    for (const file of meshFiles) {
      const fullPath = path.resolve(srcDir, file);
      const fileContent = fs.readFileSync(fullPath, 'utf-8');
      try {
        const parsedData = JSON.parse(fileContent);
        const validation = MeshAssetSchema.safeParse(parsedData);
        if (validation.success) warnOnStaleSaveData(file, validation.data);
        if (!validation.success) {
          logValidationError(`Validation error inside mesh file ${file}`, validation.error.issues);
          hasError = true;
          continue;
        }
        const meshJSON = validation.data;
        const meshId =
          meshJSON.props.appId ||
          meshJSON.entityOpts?.appId ||
          path.basename(file, JSON_ENDING_SIGNATURES.mesh);
        if (ids.meshes.includes(meshId)) {
          logDuplicateIdError('mesh', meshId, file);
          continue;
        }
        ids.meshes.push(meshId);
        meshJSON.props.appId = meshId;
        meshJSON.__sourcePath = path.relative(path.resolve(__dirname, '..'), fullPath);
        delete meshJSON.$schema;
        meshRegistry[meshId] = meshJSON;
      } catch {
        logJSONError(file);
      }
    }
    combinedData.meshes = meshRegistry;

    // Imported assets
    const importedAssetRegistry: Record<string, ImportedAsset> = {};
    const importedAssetFiles = files.filter(
      (file) => typeof file === 'string' && file.endsWith(JSON_ENDING_SIGNATURES.importedAsset)
    ) as string[];
    for (const file of importedAssetFiles) {
      const fullPath = path.resolve(srcDir, file);
      const fileContent = fs.readFileSync(fullPath, 'utf-8');
      try {
        const parsedData = JSON.parse(fileContent);
        const validation = ImportedAssetSchema.safeParse(parsedData);
        if (validation.success) warnOnStaleSaveData(file, validation.data);
        if (!validation.success) {
          logValidationError(
            `Validation error inside imported asset file ${file}`,
            validation.error.issues
          );
          hasError = true;
          continue;
        }
        const importedAssetJSON = validation.data;
        if (!checkAssetSources(file, fullPath, importedAssetJSON, resolveSettings)) {
          hasError = true;
          continue;
        }
        const id =
          importedAssetJSON.id || path.basename(file, JSON_ENDING_SIGNATURES.importedAsset);
        if (ids.importedAssets.includes(id)) {
          logDuplicateIdError('imported asset', id, file);
          continue;
        }
        ids.importedAssets.push(id);
        importedAssetJSON.id = id;
        importedAssetJSON.__sourcePath = path.relative(path.resolve(__dirname, '..'), fullPath);
        importedAssetJSON.__fileSize = getSourceFileSize(fullPath, importedAssetJSON.fileName);
        setGeneratedFields(importedAssetJSON, 'importedAsset', fullPath);
        delete importedAssetJSON.$schema;
        importedAssetRegistry[id] = importedAssetJSON;
      } catch {
        logJSONError(file);
      }
    }
    combinedData.importedAssets = importedAssetRegistry;

    // Skyboxes
    const skyRegistry: Record<string, SkyBoxAsset> = {};
    const skyFiles = files.filter(
      (file) => typeof file === 'string' && file.endsWith(JSON_ENDING_SIGNATURES.skybox)
    ) as string[];
    for (const file of skyFiles) {
      const fullPath = path.resolve(srcDir, file);
      const fileContent = fs.readFileSync(fullPath, 'utf-8');
      try {
        const parsedData = JSON.parse(fileContent);
        // The id defaults to the file name (set before validating: the schema requires one)
        if (parsedData && typeof parsedData === 'object' && !parsedData.id) {
          parsedData.id = path.basename(file, JSON_ENDING_SIGNATURES.skybox);
        }
        warnOnLegacySkyBox(file, parsedData);
        const validation = SkyBoxAssetSchema.safeParse(parsedData);
        if (validation.success) warnOnStaleSaveData(file, validation.data);
        if (!validation.success) {
          logValidationError(
            `Validation error inside skybox file ${file}`,
            validation.error.issues
          );
          hasError = true;
          continue;
        }
        // The runtime only sees plain definitions: the preset is merged in here
        const skyJSON: SkyBoxAsset = mergeSkyBoxPreset(validation.data);
        const skyId = skyJSON.id;
        if (ids.skyboxes.includes(skyId)) {
          logDuplicateIdError('skybox', skyId, file);
          continue;
        }
        ids.skyboxes.push(skyId);
        skyJSON.__sourcePath = path.relative(path.resolve(__dirname, '..'), fullPath);
        delete skyJSON.$schema;
        skyRegistry[skyId] = skyJSON;
      } catch {
        logJSONError(file);
      }
    }
    combinedData.skyboxes = skyRegistry;

    // PostFX passes
    const postFxRegistry: Record<string, PostFxAsset> = {};
    const postFxFiles = files.filter(
      (file) => typeof file === 'string' && file.endsWith(JSON_ENDING_SIGNATURES.postFx)
    ) as string[];
    for (const file of postFxFiles) {
      const fullPath = path.resolve(srcDir, file);
      const fileContent = fs.readFileSync(fullPath, 'utf-8');
      try {
        const parsedData = JSON.parse(fileContent);
        const validation = PostFxAssetSchema.safeParse(parsedData);
        if (validation.success) warnOnStaleSaveData(file, validation.data);
        if (!validation.success) {
          logValidationError(
            `Validation error inside PostFX file ${file}`,
            validation.error.issues
          );
          hasError = true;
          continue;
        }
        const postFxJSON = validation.data;
        const postFxId = postFxJSON.id || path.basename(file, JSON_ENDING_SIGNATURES.postFx);
        if (ids.postFx.includes(postFxId)) {
          logDuplicateIdError('PostFX pass', postFxId, file);
          continue;
        }
        ids.postFx.push(postFxId);
        postFxJSON.id = postFxId;
        postFxJSON.__sourcePath = path.relative(path.resolve(__dirname, '..'), fullPath);
        delete postFxJSON.$schema;
        postFxRegistry[postFxId] = postFxJSON;
        const isFoundInAScene = sceneFilesArray.find(
          (sceneFile) => sceneFile.postFx?.includes(postFxId) || false
        );

        if (isFoundInAScene || !isProduction) {
          const basePath = getBasePath(fullPath);

          // Assert physical existence of script tracking path on disk
          let postFxTslFilePath = path.resolve(srcDir, basePath, postFxJSON.tslFile);
          if (!fs.existsSync(postFxTslFilePath) && !path.extname(postFxTslFilePath)) {
            if (fs.existsSync(postFxTslFilePath + '.ts')) {
              postFxTslFilePath += '.ts';
            }
          }
          if (!fs.existsSync(postFxTslFilePath)) {
            console.error(
              `\x1b[31m✗ [Scene Gatherer] Error gathering PostFX data: specified tslFile "${postFxJSON.tslFile}" does not exist on disk.\n  └─ Expected path: ${postFxTslFilePath}\x1b[0m`
            );
            hasError = true;
            continue;
          }

          const runtimeUniqueNamespace = toUniqueJsIdentifier(
            `${postFxId}PostFxFn`,
            usedImportNamespaces,
            'postFx'
          );
          sceneFileImports += `import * as ${runtimeUniqueNamespace} from '../${basePath}/${postFxJSON.tslFile}';\n`;

          if (!postFxFileObject) {
            postFxFileObject += 'export const postFxFileObjects = {\n';
          }

          // Use single quotes if the identifier starts with a number, otherwise keep it unquoted to match lint rules
          postFxFileObject += `  ${postFxId.match(/^[0-9]/) ? `'${postFxId}'` : postFxId}: {\n`;
          postFxFileObject += `    fxNode: ${runtimeUniqueNamespace}.fxNode,\n`;
          postFxFileObject += `  },\n`;
        }
      } catch {
        logJSONError(file);
      }
    }
    combinedData.postFx = postFxRegistry;

    // --- SCENES ---
    // --------------
    for (const file of sceneFiles) {
      const fullPath = path.resolve(srcDir, file);
      const fileContent = fs.readFileSync(fullPath, 'utf-8');
      const parsedData = JSON.parse(fileContent);
      const validation = SceneAssetSchema.safeParse(parsedData);
      if (!validation.success) continue;
      const fileContentJSON = validation.data;
      delete fileContentJSON.$schema;

      // Use the scene id as a key or filename (minus extension) as the key
      const sceneId =
        'id' in fileContentJSON && fileContentJSON.id
          ? fileContentJSON.id
          : path.basename(file, JSON_ENDING_SIGNATURES.scene);
      fileContentJSON.id = sceneId;

      // Check if the file has a sceneFile property set
      if (!fileContentJSON.sceneFile) {
        console.error(
          `\x1b[31m✗ [Scene Gatherer] Error gathering scene data (${isProduction ? 'production' : 'development'}): missing 'sceneFile' property and/or value (required) for scene file ${fullPath}.\x1b[0m`
        );
        hasError = true;
        continue;
      }

      // Check that the scene file actually exists
      let sceneFilePath = path.resolve(srcDir, 'app', fileContentJSON.sceneFile);
      // Fallback Check: If the exact path isn't found and has no extension, test it with '.ts'
      if (!fs.existsSync(sceneFilePath) && !path.extname(sceneFilePath)) {
        if (fs.existsSync(sceneFilePath + '.ts')) {
          sceneFilePath += '.ts';
        }
      }
      if (!fs.existsSync(sceneFilePath)) {
        console.error(
          `\x1b[31m✗ [Scene Gatherer] Error gathering scene data: the specified sceneFile "${fileContentJSON.sceneFile}" does not exist on disk.\n  └─ Expected path: ${sceneFilePath}\x1b[0m`
        );
        hasError = true;
        continue;
      }

      // Remove debug scenes from production builds
      if (isProduction && fileContentJSON.isDebugScene) continue;

      if (!addedFirstImport) {
        sceneFileImports +=
          "import type { SceneData } from './core/Scene.ts';\nimport type { ScenePrimitiveAssets } from './core/SceneLoader.ts';\n";
        addedFirstImport = true;
      }
      const basePath = getBasePath(fullPath);
      if (!sceneFileObject) {
        sceneFileObject += 'export const sceneFileObjects: {\n';
        sceneFileObject += `  [sceneId: string]: (sceneData: {\n`;
        sceneFileObject += `    sceneData: SceneData;\n`;
        sceneFileObject += `    assets: ScenePrimitiveAssets;\n`;
        sceneFileObject += `  }) => Promise<void>;\n`;
        sceneFileObject += `} = {\n`;
      }
      sceneFileObject += `  ${sceneId}: async ({ sceneData, assets }) => {\n`;
      sceneFileObject += `    const module = await import('../${basePath}/${fileContentJSON.sceneFile}');\n`;
      sceneFileObject += `    await (\n`;
      sceneFileObject += `      module as {\n`;
      sceneFileObject += `        scene: (sceneData: { sceneData: SceneData; assets: ScenePrimitiveAssets }) => Promise<void>;\n`;
      sceneFileObject += `      }\n`;
      sceneFileObject += `    ).scene({ sceneData, assets });\n`;
      sceneFileObject += `  },\n`;

      // --- CURRENT SCENE ASSETS per SCENE: ---

      // Add cameras to scenes
      if (Array.isArray(fileContentJSON.cameras)) {
        fileContentJSON.cameras = fileContentJSON.cameras.map((camId) => {
          if (typeof camId !== 'string') return camId;
          if (cameraRegistry[camId]) {
            const __saveData = cameraRegistry[camId].__saveData?.[sceneId]?.length
              ? cameraRegistry[camId].__saveData?.[sceneId]?.[0] || {}
              : {};
            const entityOpts = cameraRegistry[camId].entityOpts;
            if (isProduction && entityOpts) delete entityOpts.debugData;
            const cameraData = {
              camProps: { ...cameraRegistry[camId].camProps, ...__saveData },
              entityOpts: entityOpts,
            };
            if ('__meta' in cameraData.camProps) delete cameraData.camProps.__meta;
            return cameraData;
          }
          return camId; // Fallback to raw string ID if asset file doesn't exist yet
        });
      } else if (!Object.keys(fileContentJSON.cameras || {}).length) {
        // If the scene does not have a camera, a temp camera is created (every scene needs a camera)
        fileContentJSON.cameras = [
          {
            camProps: { type: 'PERSPECTIVE', fov: 90, active: true },
            ...(isProduction
              ? {}
              : {
                  entityOpts: {
                    debugData: {
                      name: '_camera',
                      description: 'Auto-generated camera for the scene',
                    },
                  },
                }),
          },
        ];
      }

      // Add lights to scenes
      if (Array.isArray(fileContentJSON.lights)) {
        fileContentJSON.lights = fileContentJSON.lights.map((lightId) => {
          if (typeof lightId !== 'string') return lightId;
          if (lightRegistry[lightId]) {
            const __saveData = lightRegistry[lightId].__saveData?.[sceneId]?.length
              ? lightRegistry[lightId].__saveData?.[sceneId]?.[0] || {}
              : {};
            const entityOpts = lightRegistry[lightId].entityOpts;
            if (isProduction && entityOpts) delete entityOpts.debugData;
            const lightData = {
              lightProps: { ...lightRegistry[lightId].lightProps, ...__saveData },
              entityOpts: entityOpts,
            };
            if ('__meta' in lightData.lightProps) delete lightData.lightProps.__meta;
            return lightData;
          }
          return lightId; // Fallback to raw string ID if asset file doesn't exist yet
        });
      }

      // Add geometries to scenes
      if (Array.isArray(fileContentJSON.geometries)) {
        fileContentJSON.geometries = fileContentJSON.geometries.map((geoId) => {
          if (typeof geoId !== 'string') return geoId;
          if (geoRegistry[geoId]) {
            const __saveData = geoRegistry[geoId].__saveData?.[sceneId]?.length
              ? geoRegistry[geoId].__saveData?.[sceneId]?.[0] || {}
              : { debugData: {}, params: {} };
            if (isProduction) delete geoRegistry[geoId].geoProps.debugData;
            const geoData = {
              id: geoId,
              type: geoRegistry[geoId].geoProps.type,
              params: { ...geoRegistry[geoId].geoProps.params, ...(__saveData.params || {}) },
              ...(geoRegistry[geoId].geoProps.debugData
                ? {
                    debugData: {
                      ...geoRegistry[geoId].geoProps.debugData,
                      ...(__saveData.debugData || {}),
                    },
                  }
                : {}),
            };
            if ('__meta' in geoData.params && geoData.params.__meta) delete geoData.params.__meta;
            return geoData;
          }
          return geoId; // Fallback to raw string ID if asset file doesn't exist yet
        });
      }

      // Add impostors to scenes (p351 Phase 4): the definitions (a production build keeps only the
      // scenes), and their atlases' slots go into the scene's textures, so the loader loads them
      // like any texture. One not found is left out: its generator call bakes as without an export.
      if (Array.isArray(fileContentJSON.impostors)) {
        const impostorDefs: ImpostorDef[] = [];
        const impostorSlotIds: string[] = [];
        for (const impostorId of fileContentJSON.impostors) {
          const impostor = impostorRegistry[impostorId];
          if (!impostor) {
            console.warn(
              `\x1b[33m⚠ [Scene Gatherer] Scene "${sceneId}" lists the impostor "${impostorId}", which has no *.impostor.json (or an invalid one): it bakes at load.\x1b[0m`
            );
            continue;
          }
          // The runtime would refuse it and bake: its slots would load for nothing (warned above)
          if (impostor.formatVersion !== IMPOSTOR_EXPORT_FORMAT_VERSION) continue;
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { $schema, __sourcePath, ...def } = impostor;
          if (isProduction) delete def.debugData;
          impostorDefs.push({ ...def, id: impostorId });
          // The slots it reads (the atlas id would load every slot), all checked above
          for (const slot of getImpostorDefSlots(impostor)) {
            impostorSlotIds.push(getAtlasSlotTextureId(impostor.atlas, slot));
          }
        }
        // The generated data's shape: the definitions in place of the ids
        fileContentJSON.impostors = impostorDefs as unknown as string[];
        if (impostorSlotIds.length) {
          fileContentJSON.textures = [...(fileContentJSON.textures ?? []), ...impostorSlotIds];
        }
      }

      // Add textures to scenes
      if (Array.isArray(fileContentJSON.textures)) {
        // An atlas id stands for every slot of it; a slot listed twice (by the atlas id and its
        // own) is loaded once
        const listedSlotIds = new Set<string>();
        const listed = fileContentJSON.textures;
        const sceneTextures = listed.flatMap((texId): typeof listed => {
          if (typeof texId !== 'string') return [texId];
          const slotIds = atlasSlotIds[texId] ?? (atlasSlotRegistry[texId] ? [texId] : null);
          if (!slotIds) return [texId];
          const unlisted = slotIds.filter((slotId) => !listedSlotIds.has(slotId));
          for (const slotId of unlisted) listedSlotIds.add(slotId);
          return unlisted;
        });
        fileContentJSON.textures = sceneTextures.map((texId) => {
          if (typeof texId !== 'string') return texId;
          if (texRegistry[texId]) {
            const __saveData = texRegistry[texId].__saveData?.[sceneId]?.length
              ? texRegistry[texId].__saveData?.[sceneId]?.[0] || {}
              : {};
            if (isProduction) delete texRegistry[texId].debugData;
            const texData = { ...texRegistry[texId], ...__saveData };
            // A per-scene override can point at another file
            texData.__fileSize = getSourceFileSize(
              texRegistry[texId].__sourcePath || '',
              texData.fileName,
              texData.path
            );
            setGeneratedFields(texData, 'texture', texRegistry[texId].__sourcePath || '');
            checkShippedOutput(texData, 'texture', texRegistry[texId].__sourcePath || '', sceneId);
            if ('__meta' in texData) delete texData.__meta;
            delete texData.optimize; // Build time only (p300)
            delete texData.pack;
            delete texData.__sourcePath;
            delete texData.__saveData;
            return texData;
          }
          if (arrayRegistry[texId]) {
            // Build time only: the runtime loads the encoded array (its generated fields, from
            // the registry entry: an array has no scene entries)
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            const { layers, size, optimize, __sourcePath, ...arrayData } = arrayRegistry[texId];
            checkShippedArray(__sourcePath || '', sceneId);
            if (isProduction) delete arrayData.debugData;
            return arrayData;
          }
          if (atlasSlotRegistry[texId]) {
            // Its generated fields and cell table come with it, like an array's
            const { __sourcePath, ...slotData } = atlasSlotRegistry[texId];
            checkShippedAtlasSlot(__sourcePath || '', slotData.__atlas.slot, sceneId);
            if (isProduction) delete slotData.debugData;
            return slotData;
          }
          return texId; // Fallback to raw string ID if asset file doesn't exist yet
        });
      }

      // Add materials to scenes
      if (Array.isArray(fileContentJSON.materials)) {
        fileContentJSON.materials = fileContentJSON.materials.map((matId) => {
          if (typeof matId !== 'string') return matId;
          if (matRegistry[matId]) {
            const __saveData = matRegistry[matId].__saveData?.[sceneId]?.length
              ? matRegistry[matId].__saveData?.[sceneId]?.[0] || {}
              : {};
            if (isProduction) delete matRegistry[matId].debugData;
            const registryData = matRegistry[matId];
            const nodeKeys =
              'nodes' in registryData && registryData.nodes ? Object.keys(registryData.nodes) : [];
            let nodes = {};
            if (nodeKeys.length && 'nodes' in registryData && registryData.nodes) {
              nodes = nodeKeys.reduce(
                (acc, key) => {
                  const nodeData =
                    'nodes' in registryData && registryData.nodes ? registryData.nodes[key] : {};
                  const nodeSaveData = __saveData.nodes?.[key] || {};
                  if ('__meta' in nodeData) delete nodeData.__meta;
                  acc[key] = {
                    ...nodeData,
                    ...nodeSaveData,
                  };
                  return acc;
                },
                {} as Record<string, unknown>
              );
            }
            const matData = {
              ...registryData,
              ...__saveData,
              ...(nodes ? { nodes } : {}),
              ...('params' in registryData
                ? { params: { ...registryData.params, ...__saveData.params } }
                : {}),
              id: matId,
              type: registryData.type,
            };
            if ('__meta' in matData) delete matData.__meta;
            if ('__sourcePath' in matData) delete matData.__sourcePath;
            if ('__saveData' in matData) delete matData.__saveData;
            return matData as MaterialAsset;
          }
          return matId; // Fallback to raw string ID if asset file doesn't exist yet
        });
      }

      // Add meshes to scenes
      if (Array.isArray(fileContentJSON.meshes)) {
        fileContentJSON.meshes = fileContentJSON.meshes.map((meshId) => {
          if (typeof meshId !== 'string') return meshId;
          if (meshRegistry[meshId]) {
            const __saveData = meshRegistry[meshId].__saveData?.[sceneId]?.length
              ? meshRegistry[meshId].__saveData?.[sceneId]?.[0] || {}
              : {};
            if (isProduction && meshRegistry[meshId].entityOpts?.debugData) {
              delete meshRegistry[meshId].entityOpts?.debugData;
            }
            const meshData = {
              ...meshRegistry[meshId],
              props: { ...meshRegistry[meshId].props, ...__saveData },
            };
            if ('__meta' in meshData.props) delete meshData.props.__meta;
            delete meshData.__sourcePath;
            delete meshData.__saveData;
            return meshData;
          }
          return meshId; // Fallback to raw string ID if asset file doesn't exist yet
        });
      }

      // Add imported assets to scenes
      if (Array.isArray(fileContentJSON.importedAssets)) {
        fileContentJSON.importedAssets = fileContentJSON.importedAssets.map((importId) => {
          if (typeof importId !== 'string') return importId;
          if (importedAssetRegistry[importId]) {
            const __saveData = importedAssetRegistry[importId].__saveData?.[sceneId]?.length
              ? importedAssetRegistry[importId].__saveData?.[sceneId]?.[0] || {}
              : {};
            if (isProduction) delete importedAssetRegistry[importId].debugData;
            const importData = { ...importedAssetRegistry[importId], ...__saveData, id: importId };
            importData.__fileSize = getSourceFileSize(
              importedAssetRegistry[importId].__sourcePath || '',
              importData.fileName
            );
            setGeneratedFields(
              importData,
              'importedAsset',
              importedAssetRegistry[importId].__sourcePath || ''
            );
            checkShippedOutput(
              importData,
              'importedAsset',
              importedAssetRegistry[importId].__sourcePath || '',
              sceneId
            );
            if ('__meta' in importData) delete importData.__meta;
            delete importData.optimize; // Build time only (p300)
            delete importData.__sourcePath;
            delete importData.__saveData;
            return importData;
          }
          return importId; // Fallback to raw string ID if asset file doesn't exist yet
        });
      }

      // Add skyboxes to scenes (the definition with this scene's latest save entry deep-merged
      // over it; inline ones too)
      if (Array.isArray(fileContentJSON.skyboxes)) {
        fileContentJSON.skyboxes = fileContentJSON.skyboxes.map((skyIdOrInline) => {
          const sky =
            typeof skyIdOrInline === 'string'
              ? skyRegistry[skyIdOrInline]
              : mergeSkyBoxPreset(skyIdOrInline);
          if (!sky) return skyIdOrInline; // Fallback to raw string ID if asset file doesn't exist yet
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { $schema, __sourcePath, __saveData, ...def } = sky;
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { __meta, ...overrides } = __saveData?.[sceneId]?.[0] || {};
          const skyData = deepMerge(def, overrides);
          if (isProduction) delete skyData.debugData;
          return skyData;
        });
      }

      // Add PostFX passes to scenes (order is kept: it is the execution order)
      if (Array.isArray(fileContentJSON.postFx)) {
        fileContentJSON.postFx = fileContentJSON.postFx.map((postFxId) => {
          if (typeof postFxId !== 'string') return postFxId;
          if (postFxRegistry[postFxId]) {
            const __saveData = postFxRegistry[postFxId].__saveData?.[sceneId]?.length
              ? postFxRegistry[postFxId].__saveData?.[sceneId]?.[0] || {}
              : {};
            if (isProduction) delete postFxRegistry[postFxId].debugData;
            const registryData = postFxRegistry[postFxId];
            const postFxData = {
              ...registryData,
              ...__saveData,
              params: { ...registryData.params, ...__saveData.params },
              id: postFxId,
            };
            if ('__meta' in postFxData) delete postFxData.__meta;
            delete postFxData.__sourcePath;
            delete postFxData.__saveData;
            return postFxData;
          }
          return postFxId; // Fallback to raw string ID if asset file doesn't exist yet
        });
      }

      if (isProduction) {
        // Remove debug data from scene files for production build
        fileContentJSON.sceneFile = '';
        delete fileContentJSON.name;
        delete fileContentJSON.description;
        delete fileContentJSON.comments;
        delete fileContentJSON.todo;
        delete fileContentJSON.__sourcePath;
      }

      combinedData.scenes[sceneId] = fileContentJSON;
    }

    if (missingOutputs.size) {
      hasError = true;
      const results = [...missingOutputs.keys()];
      console.error(
        `\x1b[31m✗ [Scene Gatherer] A production build ships the asset pipeline's outputs only, and ${results.length} asset(s) that shipped scenes use have none:\x1b[0m`
      );
      for (const [result, sceneIds] of missingOutputs) {
        const { asset } = result;
        const source = asset.source.kind === 'remote' ? asset.source.url : asset.source.repoPath;
        // The run's one ktx setup failure, and its fix, are printed by the [Assets] lines above
        const reason =
          result.status === 'error'
            ? `failed: ${result.reason}`
            : result.status === 'skipped'
              ? `no output: ${result.reason}`
              : 'encoder missing';
        console.error(`  ${asset.id} (${source}; ${[...sceneIds].join(', ')}): ${reason}`);
      }
      const encoderMissing = results.filter((result) => result.status === 'encoderMissing');
      if (encoderMissing.length) {
        const unoptimized = encoderMissing.some((result) => !isKtxOnlyAsset(result))
          ? ` Or ship them unoptimized in this build: ${ALLOW_UNOPTIMIZED_ENV_KEY}=true yarn build`
          : '';
        const ktxOnly = encoderMissing.some(isKtxOnlyAsset)
          ? ` A texture array or atlas slot has no unoptimized form: it needs ktx, even with ${ALLOW_UNOPTIMIZED_ENV_KEY}.`
          : '';
        console.error(
          `  Without ktx: set it up (see [Assets] above), run yarn assets, and commit src/public/aek-assets/ and assets.lock.json.${unoptimized}${ktxOnly}`
        );
      }
      if (results.some((result) => result.status === 'skipped' && isKtxOnlyAsset(result))) {
        console.error(
          `  A texture array or atlas slot is only ever its KTX2 output, and it has none while its textures side is off (a rule's "textures": false, the project switches): turn it on for it, or don't use it in a shipped scene.`
        );
      }
      if (results.some((result) => result.status === 'error')) {
        console.error(
          `  A failed asset: fix it, or opt it out with "optimize": false in its JSON.`
        );
      }
    }
    if (overBudget.size) {
      hasError = true;
      console.error(
        `\x1b[31m✗ [Scene Gatherer] ${overBudget.size} asset(s) that shipped scenes use are over their budget (p300 Phase 4):\x1b[0m`
      );
      for (const [result, sceneIds] of overBudget) {
        const { asset } = result;
        const source = asset.source.kind === 'remote' ? asset.source.url : asset.source.repoPath;
        console.error(`  ${asset.id} (${source}; ${[...sceneIds].join(', ')}):`);
        for (const violation of getBudgetViolations(result)) console.error(`    ${violation}`);
      }
      console.error(`  ${BUDGET_FIX}`);
    }

    if (hasError) return false;

    // Create generatedScenes.json
    fs.mkdirSync(path.dirname(OUTPUT_FILE_DATA), { recursive: true });
    fs.writeFileSync(
      OUTPUT_FILE_DATA,
      JSON.stringify(isProduction ? { scenes: combinedData.scenes } : combinedData, null, 2),
      'utf-8'
    );

    // Create generatedScenes.ts
    if (sceneFileObject) {
      sceneFileObject += '};\n';
    } else {
      sceneFileObject = 'export const sceneFileObjects = {};\n';
    }
    if (tslMaterialFileObject) {
      tslMaterialFileObject += '};\n';
    } else {
      tslMaterialFileObject = 'export const tslMaterialFileObjects = {};\n';
    }
    if (postFxFileObject) {
      postFxFileObject += '};\n';
    } else {
      postFxFileObject = 'export const postFxFileObjects = {};\n';
    }
    fs.mkdirSync(path.dirname(OUTPUT_FILE_FN), { recursive: true });
    fs.writeFileSync(
      OUTPUT_FILE_FN,
      `${sceneFileImports}\n${sceneFileObject}\n${tslMaterialFileObject}\n${postFxFileObject}`,
      'utf-8'
    );

    console.log(
      `\x1b[32m✓ [Scene Gatherer] Consolidated ${sceneFiles.length} scene configurations (${isProduction ? 'prod' : 'dev'}).\x1b[0m`
    );
    return true;
  } catch (err) {
    console.error(
      `\x1b[31m✗ [Scene Gatherer] Error gathering scene data (${isProduction ? 'production' : 'development'}):\x1b[0m`,
      err
    );
    return false;
  }
};

/**
 * `yarn gatherAppData` (before `dev` and `build`): the asset pipeline's cached run (p300), then
 * the gather with its outputs. It builds what isn't in the cache, but never removes stale outputs:
 * that's `yarn assets`' full run. A run that can't start (an invalid `assets.lock.json`) gathers
 * nothing, so the generated data keeps its `__url`s.
 *
 * In production (`yarn build`), a failed gather exits 1 and stops the build, and so does an asset
 * a shipped scene uses without an output or over its budget. `AEK_ASSETS_ALLOW_UNOPTIMIZED=true`
 * ships the ones that lack `ktx` unoptimized instead.
 */
const gatherWithAssetPipeline = async () => {
  const { runAssetsCommand } = await import('./assetPipeline/command');
  const isProduction = process.env.NODE_ENV === 'production';
  let pipeline: PipelineRun;
  try {
    ({ run: pipeline } = await runAssetsCommand({
      projectOptOut: await loadProjectOptOut(),
      verbosity: 'brief',
      isUnoptimizedFallback: isProduction && isUnoptimizedAllowed(),
    }));
  } catch (err) {
    console.error(`\x1b[31m✗ [Assets] ${(err as Error).message}\x1b[0m`);
    process.exitCode = 1;
    return;
  }
  if (!gatherSceneData({ pipeline }) && isProduction) process.exitCode = 1;
};

// Execute automatically if run directly via Node command line
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void gatherWithAssetPipeline();
}
