import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const generatedAppDataJSONFilename = 'generatedAppData.json';
export const generatedAppFnsFilename = 'generatedAppFns.ts';
export const OUTPUT_FILE_DATA = path.resolve(
  __dirname,
  `../src/_engine/${generatedAppDataJSONFilename}`
);
export const OUTPUT_FILE_FN = path.resolve(__dirname, `../src/_engine/${generatedAppFnsFilename}`);
const SCENE_JSON_ENDING_SIGNATURE = '.scene.json';
const CAMERA_JSON_ENDING_SIGNATURE = '.camera.json';
const LIGHT_JSON_ENDING_SIGNATURE = '.light.json';
const GEOMETRY_JSON_ENDING_SIGNATURE = '.geometry.json';
const TEXTURE_JSON_ENDING_SIGNATURE = '.texture.json';
const MATERIAL_JSON_ENDING_SIGNATURE = '.material.json';
const PRIMITIVE_MESH_JSON_ENDING_SIGNATURE = '.primitiveMesh.json';
const MESH_JSON_ENDING_SIGNATURE = '.mesh.json';
const SKYBOX_JSON_ENDING_SIGNATURE = '.skybox.json';

export const isFilePathValid = (filePath) =>
  filePath.endsWith(SCENE_JSON_ENDING_SIGNATURE) ||
  filePath.endsWith(CAMERA_JSON_ENDING_SIGNATURE) ||
  filePath.endsWith(LIGHT_JSON_ENDING_SIGNATURE) ||
  filePath.endsWith(GEOMETRY_JSON_ENDING_SIGNATURE) ||
  filePath.endsWith(TEXTURE_JSON_ENDING_SIGNATURE) ||
  filePath.endsWith(MATERIAL_JSON_ENDING_SIGNATURE) ||
  filePath.endsWith(PRIMITIVE_MESH_JSON_ENDING_SIGNATURE) ||
  filePath.endsWith(MESH_JSON_ENDING_SIGNATURE) ||
  filePath.endsWith(SKYBOX_JSON_ENDING_SIGNATURE);

export const getBasePath = (fullPath) => {
  const splitPath = fullPath.split('/src/');
  if (!splitPath.length) return '';
  const splitFolders = splitPath[splitPath.length - 1].split('/');
  return splitFolders[0];
};

export const gatherSceneData = () => {
  const isProduction = process.env.NODE_ENV === 'production';

  const srcDir = path.resolve(__dirname, '../src');
  const combinedData = {
    scenes: {},
    cameras: {},
    lights: {},
    geometries: {},
    textures: {},
    materials: {},
    primitiveMeshes: {},
    meshes: {},
    skyboxes: {},
    // physicsObjects: {},
  };
  let sceneFileImports = `// THIS IS AN AUTO-GENERATED FILE, DO NOT MODIFY (ALSO, DO NOT MODIFY THE '${generatedAppFnsFilename}' FILE)!\n`;
  let addedFirstImport = false;
  let sceneFileObject = '';
  let tslMaterialFileObject = '';

  const logJSONError = (file) =>
    console.error(
      `\x1b[31m✗ [Scene Gatherer] File content for file '${file}' is invalid or empty.\x1b[0m`
    );

  try {
    // Read src directory recursively (Supported natively in Node 22+)
    const files = fs.readdirSync(srcDir, { recursive: true });

    // Gather scene files
    const sceneFilesArray = [];
    const sceneFiles = files.filter((file) => file.endsWith(SCENE_JSON_ENDING_SIGNATURE));
    for (const file of sceneFiles) {
      const fullPath = path.resolve(srcDir, file);
      const fileContent = fs.readFileSync(fullPath, 'utf-8');
      try {
        const fileContentJSON = JSON.parse(fileContent);
        sceneFilesArray.push(fileContentJSON);
      } catch (e) {
        logJSONError(file);
        throw new Error(e);
      }
    }

    // Cameras
    const cameraRegistry = {};
    const cameraFiles = files.filter((file) => file.endsWith(CAMERA_JSON_ENDING_SIGNATURE));
    for (const file of cameraFiles) {
      const fullPath = path.resolve(srcDir, file);
      const fileContent = fs.readFileSync(fullPath, 'utf-8');
      try {
        const cameraJSON = JSON.parse(fileContent);
        const cameraId =
          cameraJSON.camProps?.appId ||
          cameraJSON.entityOpts?.appId ||
          path.basename(file, CAMERA_JSON_ENDING_SIGNATURE);
        cameraJSON.__sourcePath = path.relative(path.resolve(__dirname, '..'), fullPath);
        cameraRegistry[cameraId] = cameraJSON;
      } catch (e) {
        logJSONError(file);
      }
    }
    combinedData.cameras = cameraRegistry;

    // Lights
    const lightRegistry = {};
    const lightFiles = files.filter((file) => file.endsWith(LIGHT_JSON_ENDING_SIGNATURE));
    for (const file of lightFiles) {
      const fullPath = path.resolve(srcDir, file);
      const fileContent = fs.readFileSync(fullPath, 'utf-8');
      try {
        const lightJSON = JSON.parse(fileContent);
        const lightId =
          lightJSON.lightProps?.appId ||
          lightJSON.entityOpts?.appId ||
          path.basename(file, LIGHT_JSON_ENDING_SIGNATURE);
        lightJSON.__sourcePath = path.relative(path.resolve(__dirname, '..'), fullPath);
        lightRegistry[lightId] = lightJSON;
      } catch (e) {
        logJSONError(file);
      }
    }
    combinedData.lights = lightRegistry;

    // Geometries
    const geoRegistry = {};
    const geoFiles = files.filter((file) => file.endsWith(GEOMETRY_JSON_ENDING_SIGNATURE));
    for (const file of geoFiles) {
      const fullPath = path.resolve(srcDir, file);
      const fileContent = fs.readFileSync(fullPath, 'utf-8');
      try {
        const geoJSON = JSON.parse(fileContent);
        const geoId = geoJSON.id || path.basename(file, GEOMETRY_JSON_ENDING_SIGNATURE);
        geoJSON.__sourcePath = path.relative(path.resolve(__dirname, '..'), fullPath);
        geoRegistry[geoId] = geoJSON;
      } catch (e) {
        logJSONError(file);
      }
    }
    combinedData.geometries = geoRegistry;

    // Textures
    const texRegistry = {};
    const texFiles = files.filter((file) => file.endsWith(TEXTURE_JSON_ENDING_SIGNATURE));
    for (const file of texFiles) {
      const fullPath = path.resolve(srcDir, file);
      const fileContent = fs.readFileSync(fullPath, 'utf-8');
      try {
        const texJSON = JSON.parse(fileContent);
        const texId = texJSON.id || path.basename(file, TEXTURE_JSON_ENDING_SIGNATURE);
        texJSON.__sourcePath = path.relative(path.resolve(__dirname, '..'), fullPath);
        texRegistry[texId] = texJSON;
      } catch (e) {
        logJSONError(file);
      }
    }
    combinedData.textures = texRegistry;

    // Materials
    const matRegistry = {};
    const matFiles = files.filter((file) => file.endsWith(MATERIAL_JSON_ENDING_SIGNATURE));
    for (const file of matFiles) {
      const fullPath = path.resolve(srcDir, file);
      const fileContent = fs.readFileSync(fullPath, 'utf-8');
      try {
        const matJSON = JSON.parse(fileContent);
        const matId = matJSON.id || path.basename(file, MATERIAL_JSON_ENDING_SIGNATURE);
        matJSON.__sourcePath = path.relative(path.resolve(__dirname, '..'), fullPath);
        matRegistry[matId] = matJSON;
        const isFoundInAScene = sceneFilesArray.find(
          (sceneFile) => sceneFile.materials?.includes(matId) || false
        );
        // For production builds remove unused TSL materials and
        // for development builds include unused TSL materials (to be shown in the library).
        if (
          (isProduction && isFoundInAScene && 'tslFile' in matJSON && matJSON.tslFile) ||
          (!isProduction && 'tslFile' in matJSON && matJSON.tslFile)
        ) {
          const basePath = getBasePath(fullPath);
          sceneFileImports += `import { material as ${matId}Fn } from '../${basePath}/${matJSON.tslFile}';\n`;
          if (!tslMaterialFileObject) {
            tslMaterialFileObject += 'export const tslMaterialFileObjects = {\n';
          }
          tslMaterialFileObject += `  ${matId}: ${matId}Fn,\n`;
        }
      } catch (e) {
        logJSONError(file);
      }
    }
    combinedData.materials = matRegistry;

    // Primitive meshes
    const primitiveMeshRegistry = {};
    const primitiveMeshFiles = files.filter((file) =>
      file.endsWith(PRIMITIVE_MESH_JSON_ENDING_SIGNATURE)
    );
    for (const file of primitiveMeshFiles) {
      const fullPath = path.resolve(srcDir, file);
      const fileContent = fs.readFileSync(fullPath, 'utf-8');
      try {
        const primitiveMeshJSON = JSON.parse(fileContent);
        const primitiveMeshId =
          primitiveMeshJSON.id || path.basename(file, PRIMITIVE_MESH_JSON_ENDING_SIGNATURE);
        primitiveMeshJSON.__sourcePath = path.relative(path.resolve(__dirname, '..'), fullPath);
        primitiveMeshRegistry[primitiveMeshId] = primitiveMeshJSON;
      } catch (e) {
        logJSONError(file);
      }
    }
    combinedData.primitiveMeshes = primitiveMeshRegistry;

    // Meshes
    const meshRegistry = {};
    const meshFiles = files.filter((file) => file.endsWith(MESH_JSON_ENDING_SIGNATURE));
    for (const file of meshFiles) {
      const fullPath = path.resolve(srcDir, file);
      const fileContent = fs.readFileSync(fullPath, 'utf-8');
      try {
        const meshJSON = JSON.parse(fileContent);
        const meshId = meshJSON.id || path.basename(file, MESH_JSON_ENDING_SIGNATURE);
        meshJSON.__sourcePath = path.relative(path.resolve(__dirname, '..'), fullPath);
        meshRegistry[meshId] = meshJSON;
      } catch (e) {
        logJSONError(file);
      }
    }
    combinedData.meshes = meshRegistry;

    // Skyboxes
    const skyRegistry = {};
    const skyFiles = files.filter((file) => file.endsWith(SKYBOX_JSON_ENDING_SIGNATURE));
    for (const file of skyFiles) {
      const fullPath = path.resolve(srcDir, file);
      const fileContent = fs.readFileSync(fullPath, 'utf-8');
      try {
        const skyJSON = JSON.parse(fileContent);
        const skyId = skyJSON.id || path.basename(file, SKYBOX_JSON_ENDING_SIGNATURE);
        skyJSON.__sourcePath = path.relative(path.resolve(__dirname, '..'), fullPath);
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
      const fileContentJSON = JSON.parse(fileContent);

      // Use the scene id as a key or filename (minus extension) as the key
      const sceneId =
        'id' in fileContentJSON && fileContentJSON.id
          ? fileContentJSON.id
          : path.basename(file, SCENE_JSON_ENDING_SIGNATURE);

      // Remove debug scenes from production builds
      if (isProduction && fileContentJSON.isDebugScene) continue;

      if ('sceneFile' in fileContentJSON && fileContentJSON.sceneFile) {
        if (!addedFirstImport) {
          sceneFileImports += "import { type SceneData } from './core/Scene.ts';\n";
          addedFirstImport = true;
        }
        const basePath = getBasePath(fullPath);
        sceneFileImports += `import { scene as ${sceneId}Fn } from '../${basePath}/${fileContentJSON.sceneFile}';\n`;
        if (!sceneFileObject) {
          sceneFileObject +=
            'export const sceneFileObjects: { [sceneId: string]: (sceneData: SceneData) => void } = {\n';
        }
        sceneFileObject += `  ${sceneId}: ${sceneId}Fn,\n`;
      }

      // --- CURRENT SCENE ASSETS per SCENE: ---

      // Add cameras to scenes
      if (Array.isArray(fileContentJSON.cameras)) {
        fileContentJSON.cameras = fileContentJSON.cameras.map((camId) => {
          if (typeof camId !== 'string') return camId;
          if (cameraRegistry[camId]) {
            const __saveData = cameraRegistry[camId].__saveData?.[sceneId]?.length
              ? cameraRegistry[camId].__saveData[sceneId][0]
              : {};
            const entityOpts = cameraRegistry[camId].entityOpts;
            if (isProduction) delete entityOpts.debugData;
            const cameraData = {
              camProps: { ...cameraRegistry[camId].camProps, ...__saveData },
              entityOpts: entityOpts,
            };
            if (cameraData.camProps?.__meta) delete cameraData.camProps.__meta;
            return cameraData;
          }
          return camId; // Fallback to raw string ID if asset file doesn't exist yet
        });
      } else if (!fileContentJSON.cameras?.length) {
        // If the scene does not have a camera, a temp camera is created (every scene needs a camera)
        fileContentJSON.cameras = {
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
        };
      }

      // Add lights to scenes
      if (Array.isArray(fileContentJSON.lights)) {
        fileContentJSON.lights = fileContentJSON.lights.map((lightId) => {
          if (typeof lightId !== 'string') return lightId;
          if (lightRegistry[lightId]) {
            const __saveData = lightRegistry[lightId].__saveData?.[sceneId]?.length
              ? lightRegistry[lightId].__saveData[sceneId][0]
              : {};
            const entityOpts = lightRegistry[lightId].entityOpts;
            if (isProduction) delete entityOpts.debugData;
            const lightData = {
              lightProps: { ...lightRegistry[lightId].lightProps, ...__saveData },
              entityOpts: entityOpts,
            };
            if (lightData.lightProps?.__meta) delete lightData.lightProps.__meta;
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
              ? geoRegistry[geoId].__saveData[sceneId][0]
              : {};
            if (isProduction) delete geoRegistry[geoId].debugData;
            const geoData = {
              id: geoId,
              type: geoRegistry[geoId].type,
              params: { ...geoRegistry[geoId].params, ...__saveData },
            };
            if (geoData.params?.__meta) delete geoData.params.__meta;
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
              ? texRegistry[texId].__saveData[sceneId][0]
              : {};
            if (isProduction) delete texRegistry[texId].debugData;
            const texData = { ...texRegistry[texId], ...__saveData };
            delete texData.__meta;
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
              ? matRegistry[matId].__saveData[sceneId][0]
              : {};
            if (isProduction) delete matRegistry[matId].debugData;
            let matData = {};
            if (matRegistry[matId].tslFile) {
              matData = { ...matRegistry[matId], ...__saveData };
              delete matData.__meta;
              delete matData.__sourcePath;
              delete matData.__saveData;
            } else {
              matData = {
                id: matId,
                type: matRegistry[matId].type,
                params: { ...matRegistry[matId].params, ...__saveData },
              };
              if (matData.params?.__meta) delete matData.params.__meta;
            }
            return matData;
          }
          return matId; // Fallback to raw string ID if asset file doesn't exist yet
        });
      }

      // Add primitive meshes to scenes
      if (Array.isArray(fileContentJSON.primitiveMeshes)) {
        fileContentJSON.primitiveMeshes = fileContentJSON.primitiveMeshes.map((primitiveMeshId) => {
          if (typeof primitiveMeshId !== 'string') return primitiveMeshId;
          if (primitiveMeshRegistry[primitiveMeshId]) {
            const __saveData = primitiveMeshRegistry[primitiveMeshId].__saveData?.[sceneId]?.length
              ? primitiveMeshRegistry[primitiveMeshId].__saveData[sceneId][0]
              : {};
            if (isProduction) delete primitiveMeshRegistry[primitiveMeshId].debugData;
            const primitiveMeshData = { ...primitiveMeshRegistry[primitiveMeshId], ...__saveData };
            delete primitiveMeshData.__meta;
            delete primitiveMeshData.__sourcePath;
            delete primitiveMeshData.__saveData;
            return primitiveMeshData;
          }
          return primitiveMeshId; // Fallback to raw string ID if asset file doesn't exist yet
        });
      }

      // Add meshes to scenes
      if (Array.isArray(fileContentJSON.meshes)) {
        fileContentJSON.meshes = fileContentJSON.meshes.map((meshId) => {
          if (typeof meshId !== 'string') return meshId;
          if (meshRegistry[meshId]) {
            const __saveData = meshRegistry[meshId].__saveData?.[sceneId]?.length
              ? meshRegistry[meshId].__saveData[sceneId][0]
              : {};
            if (isProduction) delete meshRegistry[meshId].debugData;
            const meshData = { ...meshRegistry[meshId], ...__saveData };
            delete meshData.__meta;
            delete meshData.__sourcePath;
            delete meshData.__saveData;
            return meshData;
          }
          return meshId; // Fallback to raw string ID if asset file doesn't exist yet
        });
      }

      // Add skyboxes to scenes
      if (Array.isArray(fileContentJSON.skyboxes)) {
        fileContentJSON.skyboxes = fileContentJSON.skyboxes.map((skyId) => {
          if (typeof skyId !== 'string') return skyId;
          if (skyRegistry[skyId]) {
            const __saveData = skyRegistry[skyId].__saveData?.[sceneId]?.length
              ? skyRegistry[skyId].__saveData[sceneId][0]
              : {};
            if (isProduction) delete skyRegistry[skyId].debugData;
            const skyData = {
              id: skyId,
              type: skyRegistry[skyId].type,
              isCurrent: Boolean(skyRegistry[skyId].isCurrent),
              params: { ...skyRegistry[skyId].params, ...__saveData },
            };
            if (skyData.params?.__meta) delete skyData.params.__meta;
            return skyData;
          }
          return skyId; // Fallback to raw string ID if asset file doesn't exist yet
        });
      }

      if (isProduction) {
        // Remove debug data from scene files for production build
        delete fileContentJSON.sceneFile;
        delete fileContentJSON.name;
        delete fileContentJSON.description;
        delete fileContentJSON.comments;
        delete fileContentJSON.todo;
      }

      combinedData.scenes[`${sceneId}`] = fileContentJSON;
    }

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
  } catch (error) {
    console.error(
      `\x1b[31m✗ [Scene Gatherer] Error gathering scene data (${isProduction ? 'production' : 'development'}):\x1b[0m`,
      error
    );
  }
};

// Execute automatically if run directly via Node command line
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  gatherSceneData();
}
