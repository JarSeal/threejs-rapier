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
import {
  ImportedMeshAsset,
  ImportedMeshAssetSchema,
} from '../src/_engine/schemas/importedMeshSchema';
import { SkyBoxAsset, SkyBoxAssetSchema } from '../src/_engine/schemas/skyBoxSchema';
import { toUniqueJsIdentifier } from '../src/_engine/utils/jsIdentifier';

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
  importedMesh: '.importedMesh.json',
  skybox: '.skybox.json',
  // physicsObjects: '.physObj.json',
  // postFx: '.postFx.json',
};

const logValidationError = (msg: string, issues: z.ZodError['issues']) => {
  const errorDetails = issues
    .map((err) => ` └─ [${err.path.join('.')}]: ${err.message}`)
    .join('\n');
  console.error(`\x1b[31m✗ [Scene Gatherer] ${msg}:\n${errorDetails}\x1b[0m`);
};

const logDuplicateIdError = (type: string, id: string, file: string) => {
  console.error(
    `\x1b[31m✗ [Scene Gatherer] Duplicate ${type} ID found: ${id} in file: ${file}\x1b[0m`
  );
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
    { name: 'importedMesh.schema.json', schema: ImportedMeshAssetSchema },
    { name: 'skyBox.schema.json', schema: SkyBoxAssetSchema },
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
    importedMeshes: Record<string, unknown>;
    skyboxes: Record<string, unknown>;
  } = {
    scenes: {},
    cameras: {},
    lights: {},
    geometries: {},
    textures: {},
    materials: {},
    meshes: {},
    importedMeshes: {},
    skyboxes: {},
    // physicsObjects: {},
    // postFx: {},
  };
  let sceneFileImports = `// THIS IS AN AUTO-GENERATED FILE, DO NOT MODIFY!\n// ALSO, DO NOT MODIFY THE '${generatedAppDataJSONFilename}' FILE)!\n`;
  let addedFirstImport = false;
  let sceneFileObject = '';
  let tslMaterialFileObject = '';
  const usedMaterialNamespaces = new Set<string>();
  const ids: {
    scenes: string[];
    cameras: string[];
    lights: string[];
    geometries: string[];
    textures: string[];
    materials: string[];
    meshes: string[];
    importedMeshes: string[];
    skyboxes: string[];
  } = {
    scenes: [],
    cameras: [],
    lights: [],
    geometries: [],
    textures: [],
    materials: [],
    meshes: [],
    importedMeshes: [],
    skyboxes: [],
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
        const validation = SceneAssetSchema.safeParse(parsedData);
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
      } catch (e) {
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
      } catch (e) {
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
      } catch (e) {
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
        texJSON.id = texId;
        delete texJSON.$schema;
        texRegistry[texId] = texJSON;
      } catch (e) {
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
            usedMaterialNamespaces,
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
      } catch (e) {
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
      } catch (e) {
        logJSONError(file);
      }
    }
    combinedData.meshes = meshRegistry;

    // Imported meshes
    const importedMeshRegistry: Record<string, ImportedMeshAsset> = {};
    const importedMeshFiles = files.filter(
      (file) => typeof file === 'string' && file.endsWith(JSON_ENDING_SIGNATURES.importedMesh)
    ) as string[];
    for (const file of importedMeshFiles) {
      const fullPath = path.resolve(srcDir, file);
      const fileContent = fs.readFileSync(fullPath, 'utf-8');
      try {
        const parsedData = JSON.parse(fileContent);
        const validation = ImportedMeshAssetSchema.safeParse(parsedData);
        if (!validation.success) {
          logValidationError(
            `Validation error inside imported mesh file ${file}`,
            validation.error.issues
          );
          hasError = true;
          continue;
        }
        const importedMeshJSON = validation.data;
        const id =
          importedMeshJSON.props.appId ||
          importedMeshJSON.entityOpts?.appId ||
          path.basename(file, JSON_ENDING_SIGNATURES.importedMesh);
        if (ids.importedMeshes.includes(id)) {
          logDuplicateIdError('imported mesh', id, file);
          continue;
        }
        ids.importedMeshes.push(id);
        importedMeshJSON.props.appId = id;
        importedMeshJSON.__sourcePath = path.relative(path.resolve(__dirname, '..'), fullPath);
        delete importedMeshJSON.$schema;
        importedMeshRegistry[id] = importedMeshJSON;
      } catch (e) {
        logJSONError(file);
      }
    }
    combinedData.importedMeshes = importedMeshRegistry;

    // Skyboxes
    const skyRegistry: Record<string, SkyBoxAsset> = {};
    const skyFiles = files.filter(
      (file) => typeof file === 'string' && file.endsWith(JSON_ENDING_SIGNATURES.skybox)
    ) as string[];
    for (const file of skyFiles) {
      const fullPath = path.resolve(srcDir, file);
      const fileContent = fs.readFileSync(fullPath, 'utf-8');
      try {
        const skyJSON = JSON.parse(fileContent);
        const skyId = skyJSON.id || path.basename(file, JSON_ENDING_SIGNATURES.skybox);
        if (ids.skyboxes.includes(skyId)) {
          logDuplicateIdError('skybox', skyId, file);
          continue;
        }
        ids.skyboxes.push(skyId);
        skyJSON.id = skyId;
        skyJSON.__sourcePath = path.relative(path.resolve(__dirname, '..'), fullPath);
        delete skyJSON.$schema;
        skyRegistry[skyId] = skyJSON;
      } catch (e) {
        logJSONError(file);
      }
    }
    combinedData.skyboxes = skyRegistry;

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

      // Add imported meshes to scenes
      if (Array.isArray(fileContentJSON.importedMeshes)) {
        fileContentJSON.importedMeshes = fileContentJSON.importedMeshes.map((importedMeshId) => {
          if (typeof importedMeshId !== 'string') return importedMeshId;
          if (importedMeshRegistry[importedMeshId]) {
            const __saveData = importedMeshRegistry[importedMeshId].__saveData?.[sceneId]?.length
              ? importedMeshRegistry[importedMeshId].__saveData?.[sceneId]?.[0] || {}
              : {};
            if (isProduction) delete importedMeshRegistry[importedMeshId].entityOpts?.debugData;
            const meshData = {
              ...importedMeshRegistry[importedMeshId],
              props: { ...importedMeshRegistry[importedMeshId].props, ...__saveData },
            };
            if ('__meta' in meshData.props) delete meshData.props.__meta;
            delete meshData.__sourcePath;
            delete meshData.__saveData;
            return meshData;
          }
          return importedMeshId; // Fallback to raw string ID if asset file doesn't exist yet
        });
      }

      // Add skyboxes to scenes
      if (Array.isArray(fileContentJSON.skyboxes)) {
        fileContentJSON.skyboxes = fileContentJSON.skyboxes.map((skyId) => {
          if (typeof skyId !== 'string') return skyId;
          if (skyRegistry[skyId]) {
            const __saveData = skyRegistry[skyId].__saveData?.[sceneId]?.length
              ? skyRegistry[skyId].__saveData?.[sceneId]?.[0] || {}
              : {};
            if (isProduction) delete skyRegistry[skyId].debugData;
            const skyData = {
              id: skyId,
              type: skyRegistry[skyId].type,
              isCurrent: Boolean(skyRegistry[skyId].isCurrent),
              params: { ...skyRegistry[skyId].params, ...__saveData },
            };
            if ('__meta' in skyData.params) delete skyData.params.__meta;
            return skyData;
          }
          return skyId; // Fallback to raw string ID if asset file doesn't exist yet
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
    fs.mkdirSync(path.dirname(OUTPUT_FILE_FN), { recursive: true });
    fs.writeFileSync(
      OUTPUT_FILE_FN,
      `${sceneFileImports}\n${sceneFileObject}\n${tslMaterialFileObject}`,
      'utf-8'
    );

    console.log(
      `\x1b[32m✓ [Scene Gatherer] Consolidated ${sceneFiles.length} scene configurations (${isProduction ? 'prod' : 'dev'}).\x1b[0m`
    );
  } catch (err) {
    console.error(
      `\x1b[31m✗ [Scene Gatherer] Error gathering scene data (${isProduction ? 'production' : 'development'}):\x1b[0m`,
      err
    );
  }
};

// Execute automatically if run directly via Node command line
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  gatherSceneData();
}
