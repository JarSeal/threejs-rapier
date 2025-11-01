import * as THREE from 'three/webgpu';
import { GLTF, GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/Addons.js';
import { lerror } from '../utils/Logger';
import { getMesh, saveMesh } from './Mesh';
import { getGroup } from './Group';
import {
  ColliderParams,
  createPhysicsObjectWithMesh,
  createPhysicsObjectWithoutMesh,
  RigidBodyParams,
} from './PhysicsRapier';

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
        const newId = id ? `${id}-${index}` : kid.uuid;
        const userData = kid.userData;
        if ('isPhysObj' in userData && userData.isPhysObj) {
          const customProps = cleanUpCustomProps(userData as CustomPropsUserData);
          // @TODO: this does not work like this, we need to
          // save customProps as an array and either set them as
          // child colliders or in the case of a compound object,
          // they need to probably be defined differently (not yet implemented)
          if (customProps.keepMesh) {
            // Create phys obj with mesh
            const physObj = createPhysicsObjectWithMesh({
              id: newId,
              physicsParams: {
                rigidBody: {
                  rigidType: customProps.rigidType,
                  userData: customProps.rigidBodyUserData,
                },
                collider: customProps.colliderParams,
              },
              meshOrMeshId: kid as THREE.Mesh,
            });
          } else {
            // Create phys obj without mesh
            const physObj = createPhysicsObjectWithoutMesh({
              id: newId,
              physicsParams: {
                rigidBody: {
                  rigidType: customProps.rigidType,
                  userData: customProps.rigidBodyUserData,
                },
                collider: customProps.colliderParams,
              },
            });
          }
        } else {
          saveMesh(kid as THREE.Mesh, newId, !saveMaterial);
        }
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
 * @param {@link ImportModelParams} params
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
 * @param updateStatusFn (function) optional status update function
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

type CustomPropsUserData = {
  isPhysObj: boolean;
  keepMesh?: boolean;
  rigidType?: RigidBodyParams['rigidType'];
  colliderType?: ColliderParams['type'];
  density?: number;
  friction?: number;
  frictionCombineRule?: ColliderParams['frictionCombineRule'];
  restitution?: number;
  restitutionCombineRule?: ColliderParams['restitutionCombineRule'];
} & { [userDataKey: string]: unknown };

const cleanUpCustomProps = (userData: CustomPropsUserData) => {
  const keepMesh = Boolean(userData.keepMesh);
  const rigidType = (
    userData.rigidType !== 'DYNAMIC' &&
    userData.rigidType !== 'POS_BASED' &&
    userData.rigidType !== 'VELO_BASED'
      ? 'FIXED'
      : userData.rigidType
  ) as RigidBodyParams['rigidType'];
  if (userData.rigidType) delete userData.rigidType;
  const colliderType = (
    userData.colliderType !== 'CUBOID' &&
    userData.colliderType !== 'BOX' &&
    userData.colliderType !== 'BALL' &&
    userData.colliderType !== 'SPHERE' &&
    userData.colliderType !== 'CAPSULE' &&
    userData.colliderType !== 'CONE' &&
    userData.colliderType !== 'CYLINDER' &&
    userData.colliderType !== 'TRIANGLE'
      ? 'TRIMESH'
      : userData.colliderType
  ) as ColliderParams['type'];
  if (userData.colliderType) delete userData.colliderType;
  const density = typeof userData.density === 'number' ? userData.density : 0.2;
  if (userData.density) delete userData.density;
  const friction = typeof userData.friction === 'number' ? userData.friction : 0.2;
  if (userData.friction) delete userData.friction;
  const frictionCombineRule =
    userData.frictionCombineRule !== 'MAX' &&
    userData.frictionCombineRule !== 'MIN' &&
    userData.frictionCombineRule !== 'MULTIPLY'
      ? 'AVERAGE'
      : userData.frictionCombineRule;
  if (userData.frictionCombineRule) delete userData.frictionCombineRule;
  const restitution = typeof userData.restitution === 'number' ? userData.restitution : 0.2;
  if (userData.restitution) delete userData.restitution;
  const restitutionCombineRule =
    userData.restitutionCombineRule !== 'MAX' &&
    userData.restitutionCombineRule !== 'MIN' &&
    userData.restitutionCombineRule !== 'MULTIPLY'
      ? 'AVERAGE'
      : userData.restitutionCombineRule;
  if (userData.restitutionCombineRule) delete userData.restitutionCombineRule;

  let colliderParams: ColliderParams;
  switch (colliderType) {
    case 'CUBOID':
    case 'BOX':
      colliderParams = {
        type: colliderType,
        ...(typeof userData.hx === 'number' ? { hx: userData.hx } : {}),
        ...(typeof userData.hy === 'number' ? { hy: userData.hy } : {}),
        ...(typeof userData.hz === 'number' ? { hz: userData.hz } : {}),
        ...(typeof userData.borderRadius === 'number'
          ? { borderRadius: userData.borderRadius }
          : {}),
      };
      break;
    case 'BALL':
    case 'SPHERE':
      colliderParams = {
        type: colliderType,
        ...(typeof userData.radius === 'number' ? { radius: userData.radius } : {}),
      };
      break;
    case 'CAPSULE':
    case 'CONE':
    case 'CYLINDER':
      colliderParams = {
        type: colliderType,
        ...(typeof userData.halfHeight === 'number' ? { halfHeight: userData.halfHeight } : {}),
        ...(typeof userData.radius === 'number' ? { radius: userData.radius } : {}),
        ...(typeof userData.borderRadius === 'number'
          ? { borderRadius: userData.borderRadius }
          : {}),
      };
      break;
    default:
      // TRIMESH (vertices and indices will come from the mesh)
      colliderParams = { type: 'TRIMESH' };
      break;
  }
  colliderParams = {
    ...colliderParams,
    density,
    friction,
    frictionCombineRule,
    restitution,
    restitutionCombineRule,
  };

  const allKeys = Object.keys(userData);
  const rigidBodyUserData: { [userDataKey: string]: unknown } = {};
  for (let i = 0; i < allKeys.length; i++) {
    if (allKeys[i].startsWith('userData_')) {
      const key = allKeys[i].split('userData_')[1];
      if (key) {
        const value = userData[allKeys[i]];
        rigidBodyUserData[key] = value;
      }
    }
  }

  return { keepMesh, rigidType, rigidBodyUserData, colliderParams };
};
