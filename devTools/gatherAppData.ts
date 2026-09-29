/* eslint-disable no-console */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import z from 'zod';
import { SceneAsset, SceneAssetSchema } from '../src/_engine/schemas/sceneSchema';
import { CameraAsset, CameraAssetSchema } from '../src/_engine/schemas/cameraSchema';
import { LightAsset, LightAssetSchema } from '../src/_engine/schemas/lightSchema';
import { GeoAsset, GeoAssetSchema } from '../src/_engine/schemas/geometrySchema';
import { TextureAsset, TextureAssetSchema } from '../src/_engine/schemas/textureSchema';
import { MaterialAsset, MaterialAssetSchema } from '../src/_engine/schemas/materialSchema';
import { MeshAsset, MeshAssetSchema } from '../src/_engine/schemas/meshSchema';
import { ImportedAsset, ImportedAssetSchema } from '../src/_engine/schemas/importedAssetSchema';
import { SkyBoxAsset, SkyBoxAssetSchema } from '../src/_engine/schemas/skyBoxSchema';
import { PostFxAsset, PostFxAssetSchema } from '../src/_engine/schemas/postFxSchema';
import { toUniqueJsIdentifier } from '../src/_engine/utils/jsIdentifier';
import { MetaSchema } from '../src/_engine/schemas/_saveDataSchema';
import {
  isLegacySkyBoxProps,
  LEGACY_SKYBOX_WARNING,
} from '../src/_engine/core/SkyBox/legacySkyBox';
import { deepMerge } from '../src/_engine/utils/deepMerge';
import pkg from '../package.json';

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
  material: '.material.json',
  mesh: '.mesh.json',
  importedAsset: '.importedAsset.json',
  skybox: '.skybox.json',
  // physicsObjects: '.physObj.json',
  postFx: '.postFx.json',
};

const logValidationError = (msg: string, issues: z.ZodError['issues']) => {
  const errorDetails = issues
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

/** Size in bytes of a file served from src/public by its URL path (eg.
 * '/debugger/assets/box.glb'), summed over an array of files, or undefined if any is missing.
 * Remote URLs have no size here (the debugger can measure them on demand). */
const getPublicFileSize = (fileName?: string | string[], urlPath?: string) => {
  const fileNames = Array.isArray(fileName) ? fileName : fileName ? [fileName] : [];
  if (!fileNames.length) return undefined;
  let size = 0;
  for (const name of fileNames) {
    if (/^[a-z]+:\/\//i.test(name)) return undefined;
    const filePath = path.resolve(
      __dirname,
      '../src/public',
      (urlPath || '').replace(/^\//, ''),
      name.replace(/^\//, '')
    );
    if (!fs.existsSync(filePath)) return undefined;
    size += fs.statSync(filePath).size;
  }
  return size;
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
    { name: 'material.schema.json', schema: MaterialAssetSchema },
    { name: 'mesh.schema.json', schema: MeshAssetSchema },
    { name: 'importedAsset.schema.json', schema: ImportedAssetSchema },
    { name: 'skyBox.schema.json', schema: SkyBoxAssetSchema },
    { name: 'postFx.schema.json', schema: PostFxAssetSchema },
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

export const gatherSceneData = () => {
  const isProduction = process.env.NODE_ENV === 'production';
  let hasError = false;

  const srcDir = path.resolve(__dirname, '../src');
  const combinedData: {
    scenes: Record<string, SceneAsset>;
    cameras: Record<string, CameraAsset>;
    lights: Record<string, LightAsset>;
    geometries: Record<string, GeoAsset>;
    textures: Record<string, TextureAsset>;
    materials: Record<string, MaterialAsset>;
    meshes: Record<string, unknown>;
    importedAssets: Record<string, unknown>;
    skyboxes: Record<string, unknown>;
    postFx: Record<string, PostFxAsset>;
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
  };

  const logJSONError = (file: string) =>
    console.error(
      `\x1b[31m✗ [Scene Gatherer] File content for file '${file}' is invalid or empty.\x1b[0m`
    );

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
        const texId = texJSON.id || path.basename(file, JSON_ENDING_SIGNATURES.texture);
        if (ids.textures.includes(texId)) {
          logDuplicateIdError('texture', texId, file);
          continue;
        }
        ids.textures.push(texId);
        texJSON.__sourcePath = path.relative(path.resolve(__dirname, '..'), fullPath);
        texJSON.__fileSize = getPublicFileSize(texJSON.fileName, texJSON.path);
        texJSON.id = texId;
        delete texJSON.$schema;
        texRegistry[texId] = texJSON;
      } catch {
        logJSONError(file);
      }
    }
    combinedData.textures = texRegistry;

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
        const id =
          importedAssetJSON.id || path.basename(file, JSON_ENDING_SIGNATURES.importedAsset);
        if (ids.importedAssets.includes(id)) {
          logDuplicateIdError('imported asset', id, file);
          continue;
        }
        ids.importedAssets.push(id);
        importedAssetJSON.id = id;
        importedAssetJSON.__sourcePath = path.relative(path.resolve(__dirname, '..'), fullPath);
        importedAssetJSON.__fileSize = getPublicFileSize(importedAssetJSON.fileName);
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
        const skyJSON = validation.data;
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
          "import { type SceneData } from './core/Scene.ts';\nimport { type ScenePrimitiveAssets } from './core/SceneLoader.ts';\n";
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

      // Add textures to scenes
      if (Array.isArray(fileContentJSON.textures)) {
        fileContentJSON.textures = fileContentJSON.textures.map((texId) => {
          if (typeof texId !== 'string') return texId;
          if (texRegistry[texId]) {
            const __saveData = texRegistry[texId].__saveData?.[sceneId]?.length
              ? texRegistry[texId].__saveData?.[sceneId]?.[0] || {}
              : {};
            if (isProduction) delete texRegistry[texId].debugData;
            const texData = { ...texRegistry[texId], ...__saveData };
            // A per-scene override can point at another file
            texData.__fileSize = getPublicFileSize(texData.fileName, texData.path);
            if ('__meta' in texData) delete texData.__meta;
            delete texData.__sourcePath;
            delete texData.__saveData;
            return texData;
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
            importData.__fileSize = getPublicFileSize(importData.fileName);
            if ('__meta' in importData) delete importData.__meta;
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
            typeof skyIdOrInline === 'string' ? skyRegistry[skyIdOrInline] : skyIdOrInline;
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

// Execute automatically if run directly via Node command line
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  gatherSceneData();
}
