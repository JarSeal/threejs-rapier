import * as THREE from 'three/webgpu';
import { GLTF, GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/Addons.js';
import { lerror } from '../utils/Logger';
import { getMesh, saveMesh } from './Mesh';
import { getGroup } from './Group';

export type ImportModelParams = {
  fileName: string;
  id?: string;
  importGroup?: boolean;
  meshIndex?: number | number[];
  throwOnError?: boolean;
  saveMaterial?: boolean;
};

const ALLOWED_FILENAME_EXTENSIONS = ['gltf', 'glb'];

const setDracoLoader = (loader: GLTFLoader) => {
  // @TODO: test this properly (setDecoderPath is probably wrong now)
  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath('/examples/jsm/libs/draco/');
  loader.setDRACOLoader(dracoLoader);
};

const parseImportResult = <T extends THREE.Group | THREE.Mesh>(
  groupOrMesh: T,
  params: ImportModelParams
): T | null => {
  const { id, fileName, importGroup, meshIndex, throwOnError, saveMaterial } = params;

  if (importGroup) {
    // Go through meshes and save them
    const kids = groupOrMesh.children;
    let index = 0;
    for (let i = 0; i < kids.length; i++) {
      const kid = kids[i];
      // @TODO: saveGroup (this should replace this implementation below)
      if ('isMesh' in kid && kid.isMesh) {
        const newId = id ? `${id}-${index}` : undefined;
        saveMesh(kid as THREE.Mesh, newId, !saveMaterial);
        index++;
      }
    }

    return groupOrMesh as T;
  }

  const index = Array.isArray(meshIndex) && !meshIndex.length ? 0 : meshIndex || 0;
  let depthIndex = 0;
  let modelMesh: unknown = null;

  const getIndexedChild = (children: THREE.Object3D[]): THREE.Object3D | null => {
    if (!Array.isArray(index)) {
      return children[index] || null;
    }
    const child = children[index[depthIndex]];
    if (depthIndex + 1 === index.length || !child) {
      return child || null;
    }
    depthIndex++;
    return getIndexedChild(child.children);
  };

  modelMesh = getIndexedChild(groupOrMesh.children);

  if (!modelMesh) {
    const errorMsg = `Could not find a mesh in importModelAsync with index ${Array.isArray(index) ? JSON.stringify(index) : index} (id: "${id}", fileName: "${fileName}")`;
    lerror(errorMsg);
    if (throwOnError) throw new Error('Error while trying to find children after importing mesh!');
    return null;
  }
  if (!(modelMesh as THREE.Mesh).isMesh) {
    const errorMsg = `Imported object is not a THREE.Mesh in importModelAsync with index ${Array.isArray(index) ? JSON.stringify(index) : index} (id: "${id}", fileName: "${fileName}")`;
    lerror(errorMsg);
    if (throwOnError) throw new Error('Error while trying to find children after importing mesh!');
    return null;
  }

  saveMesh(modelMesh as THREE.Mesh, id, !saveMaterial);

  return modelMesh as T;
};

const checkImportFileName = (fileName: string) => {
  if (!fileName) {
    throw new Error('To import a model, the "filename" param is required.');
  }
  const splitFileName = fileName.split('.');
  const extension = splitFileName[splitFileName.length - 1];
  if (!extension || !ALLOWED_FILENAME_EXTENSIONS.includes(extension)) {
    throw new Error(
      `Unkown file extension in importModel (extension: ${extension ? `"${extension}"` : extension}).`
    );
  }
};

/**
 * Imports a model asynchronously using the GLTFLoader
 * @param params ({@link ImportModelParams})
 * @returns Promise<T | null>
 */
export const importModelAsync = async <T extends THREE.Group | THREE.Mesh>(
  params: ImportModelParams
): Promise<T | null> => {
  const { id, fileName, importGroup, throwOnError } = params;
  if (id && !importGroup) {
    const mesh = getMesh(id);
    if (mesh) return mesh as T;
  }
  if (id && importGroup) {
    const group = getGroup(id);
    if (group) return group as T;
  }
  checkImportFileName(fileName);

  const loader = new GLTFLoader();
  setDracoLoader(loader);

  let modelGroup: THREE.Group | null = null;
  try {
    const gltf = await loader.loadAsync(fileName);
    modelGroup = new THREE.Group();
    modelGroup.children = gltf?.scene?.children || [];
  } catch (err) {
    const errorMsg = `Could not import ${importGroup ? 'group' : 'model'} in importModelAsync (id: "${id}", fileName: "${fileName}")`;
    lerror(errorMsg, err);
    if (throwOnError) throw new Error('Error while importing!');
    return null;
  }

  return parseImportResult<T>(modelGroup as T, params);
};

/**
 * Imports models synchronously using the GLTFLoader
 * @param modelParams (array of {@link ImportModelParams})
 * @param updateStatusFn (function) optional status update function: (loadedModels: (THREE.Group | THREE.Mesh)[], loadedCount: number, totalCount: number) => void
 * @param throwOnErrors (boolean) optional value to determine whether the importing should throw on errors or not
 */
export const importModels = (
  modelsParams: ImportModelParams[],
  updateStatusFn?: (
    loadedModels: (THREE.Group | THREE.Mesh)[],
    loadedCount: number,
    totalCount: number
  ) => void,
  throwOnErrors?: boolean
) => {
  const modelGroups: (THREE.Group | THREE.Mesh)[] = [];
  let loadedCount = 0;

  const loader = new GLTFLoader();
  setDracoLoader(loader);

  for (let i = 0; i < modelsParams.length; i++) {
    const { id, fileName, importGroup, throwOnError } = modelsParams[i];
    if (id && !importGroup) {
      const mesh = getMesh(id);
      if (mesh) {
        modelGroups.push(mesh);
        loadedCount++;
        if (updateStatusFn) updateStatusFn(modelGroups, loadedCount, modelsParams.length);
        continue;
      }
    }
    if (id && importGroup) {
      const group = getGroup(id);
      if (group) {
        modelGroups.push(group);
        loadedCount++;
        if (updateStatusFn) updateStatusFn(modelGroups, loadedCount, modelsParams.length);
        continue;
      }
    }

    checkImportFileName(fileName);

    loader.load(
      fileName,
      (gltf: GLTF) => {
        const modelGroup = new THREE.Group();
        modelGroup.children = gltf?.scene?.children || [];
        const meshOrGroup = parseImportResult<THREE.Group>(modelGroup, modelsParams[i]);
        if (meshOrGroup) modelGroups.push(meshOrGroup);
        loadedCount++;
        if (updateStatusFn) updateStatusFn(modelGroups, loadedCount, modelsParams.length);
      },
      undefined, // @TODO: add onProgress loader data to be tracked
      (err) => {
        const errorMsg = `Could not import ${importGroup ? 'group' : 'model'} in importModels (id: "${id}", fileName: "${fileName}")`;
        lerror(errorMsg, err);
        if (throwOnError || throwOnErrors) throw new Error('Error while importing!');
        loadedCount++;
        if (updateStatusFn) updateStatusFn(modelGroups, loadedCount, modelsParams.length);
      }
    );
  }
};

/**
 * Imports a model synchronously using the GLTFLoader
 * @param modelParams ({@link ImportModelParams})
 * @param updateStatusFn (function) optional status update function: (loadedModels: (THREE.Group | THREE.Mesh)[], loadedCount: number, totalCount: number) => void
 * @param throwOnError (boolean) optional value to determine whether the importing should throw on error or not
 */
export const importModel = (
  modelParams: ImportModelParams,
  updateStatusFn?: (
    loadedModels: (THREE.Group | THREE.Mesh)[],
    loadedCount: number,
    totalCount: number
  ) => void,
  throwOnError?: boolean
) => importModels([modelParams], updateStatusFn, throwOnError);
