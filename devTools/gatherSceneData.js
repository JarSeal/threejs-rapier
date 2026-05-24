import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const OUTPUT_FILE_DATA = path.resolve(__dirname, '../src/_engine/generatedScenes.json');
export const OUTPUT_FILE_FN = path.resolve(__dirname, '../src/_engine/generatedScenes.ts');
const SCENE_JSON_ENDING_SIGNATURE = '.scene.json';
const CAMERA_JSON_ENDING_SIGNATURE = '.camera.json';
const LIGHT_JSON_ENDING_SIGNATURE = '.light.json';
const GEOMETRY_JSON_ENDING_SIGNATURE = '.geometry.json';
const TEXTURE_JSON_ENDING_SIGNATURE = '.texture.json';
const MATERIAL_JSON_ENDING_SIGNATURE = '.material.json';
const PRIMITIVE_MESH_JSON_ENDING_SIGNATURE = '.primitiveMesh.json';

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
    __sourcePaths: {},
  };
  let sceneFileImports = '// THIS IS AN AUTO-GENERATED FILE, DO NOT MODIFY!\n';
  let addedFirstImport = false;
  let sceneFileObject = '';

  try {
    // Read src directory recursively (Supported natively in Node 22+)
    const files = fs.readdirSync(srcDir, { recursive: true });

    // Cameras
    const cameraRegistry = {};
    const cameraFiles = files.filter((file) => file.endsWith(CAMERA_JSON_ENDING_SIGNATURE));
    for (const file of cameraFiles) {
      const fullPath = path.resolve(srcDir, file);
      const fileContent = fs.readFileSync(fullPath, 'utf-8');
      const cameraJSON = JSON.parse(fileContent);
      const cameraId =
        cameraJSON.camProps?.appId ||
        cameraJSON.entityOpts?.appId ||
        path.basename(file, CAMERA_JSON_ENDING_SIGNATURE);
      cameraJSON.__sourcePath = path.relative(path.resolve(__dirname, '..'), fullPath);
      cameraRegistry[cameraId] = cameraJSON;
    }
    combinedData.cameras = cameraRegistry;

    // Lights
    const lightRegistry = {};
    const lightFiles = files.filter((file) => file.endsWith(LIGHT_JSON_ENDING_SIGNATURE));
    for (const file of lightFiles) {
      const fullPath = path.resolve(srcDir, file);
      const fileContent = fs.readFileSync(fullPath, 'utf-8');
      const lightJSON = JSON.parse(fileContent);
      const lightId =
        lightJSON.lightProps?.appId ||
        lightJSON.entityOpts?.appId ||
        path.basename(file, LIGHT_JSON_ENDING_SIGNATURE);
      lightJSON.__sourcePath = path.relative(path.resolve(__dirname, '..'), fullPath);
      lightRegistry[lightId] = lightJSON;
    }
    combinedData.lights = lightRegistry;

    // Geometries
    const geoRegistry = {};
    const geoFiles = files.filter((file) => file.endsWith(GEOMETRY_JSON_ENDING_SIGNATURE));
    for (const file of geoFiles) {
      const fullPath = path.resolve(srcDir, file);
      const fileContent = fs.readFileSync(fullPath, 'utf-8');
      const geoJSON = JSON.parse(fileContent);
      const geoId = geoJSON.id || path.basename(file, GEOMETRY_JSON_ENDING_SIGNATURE);
      geoJSON.__sourcePath = path.relative(path.resolve(__dirname, '..'), fullPath);
      geoRegistry[geoId] = geoJSON;
    }
    combinedData.geometries = geoRegistry;

    // Textures
    const texRegistry = {};
    const texFiles = files.filter((file) => file.endsWith(TEXTURE_JSON_ENDING_SIGNATURE));
    for (const file of texFiles) {
      const fullPath = path.resolve(srcDir, file);
      const fileContent = fs.readFileSync(fullPath, 'utf-8');
      const texJSON = JSON.parse(fileContent);
      const texId = texJSON.id || path.basename(file, TEXTURE_JSON_ENDING_SIGNATURE);
      texJSON.__sourcePath = path.relative(path.resolve(__dirname, '..'), fullPath);
      texRegistry[texId] = texJSON;
    }
    combinedData.textures = texRegistry;

    // Materials
    const matRegistry = {};
    const matFiles = files.filter((file) => file.endsWith(MATERIAL_JSON_ENDING_SIGNATURE));
    for (const file of matFiles) {
      const fullPath = path.resolve(srcDir, file);
      const fileContent = fs.readFileSync(fullPath, 'utf-8');
      const matJSON = JSON.parse(fileContent);
      const matId = matJSON.id || path.basename(file, MATERIAL_JSON_ENDING_SIGNATURE);
      matJSON.__sourcePath = path.relative(path.resolve(__dirname, '..'), fullPath);
      matRegistry[matId] = matJSON;
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
      const primitiveMeshJSON = JSON.parse(fileContent);
      const primitiveMeshId =
        primitiveMeshJSON.id || path.basename(file, PRIMITIVE_MESH_JSON_ENDING_SIGNATURE);
      primitiveMeshJSON.__sourcePath = path.relative(path.resolve(__dirname, '..'), fullPath);
      primitiveMeshRegistry[primitiveMeshId] = primitiveMeshJSON;
    }
    combinedData.primitiveMeshes = primitiveMeshRegistry;

    // Scenes
    const sceneFiles = files.filter((file) => file.endsWith(SCENE_JSON_ENDING_SIGNATURE));
    for (const file of sceneFiles) {
      const fullPath = path.resolve(srcDir, file);
      const fileContent = fs.readFileSync(fullPath, 'utf-8');
      const fileContentJSON = JSON.parse(fileContent);

      // Use the scene id as a key or filename (minus extension) as the key
      const sceneId =
        'id' in fileContentJSON && fileContentJSON.id
          ? fileContentJSON.id
          : path.basename(file, SCENE_JSON_ENDING_SIGNATURE);

      if ('sceneFile' in fileContentJSON && fileContentJSON.sceneFile) {
        if (!addedFirstImport) {
          sceneFileImports += "import { type SceneData } from './core/Scene.ts';\n";
          addedFirstImport = true;
        }
        sceneFileImports += `import { scene as ${sceneId}Fn } from '../app/${fileContentJSON.sceneFile}';\n`;
        if (!sceneFileObject) {
          sceneFileObject +=
            'export const sceneFileObjects: { [sceneId: string]: (sceneData: SceneData) => void } = {\n';
        }
        sceneFileObject += `  ${sceneId}: ${sceneId}Fn,\n`;
      }

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
            const matData = {
              id: matId,
              type: matRegistry[matId].type,
              params: { ...matRegistry[matId].params, ...__saveData },
            };
            if (matData.params?.__meta) delete matData.params.__meta;
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
      sceneFileObject += 'export const sceneFileObjects = {};\n';
    }
    fs.mkdirSync(path.dirname(OUTPUT_FILE_FN), { recursive: true });
    fs.writeFileSync(OUTPUT_FILE_FN, `${sceneFileImports}\n${sceneFileObject}`, 'utf-8');

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
