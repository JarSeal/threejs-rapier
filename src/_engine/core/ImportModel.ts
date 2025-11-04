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
  PhysicsObject,
  PhysicsParams,
  RigidBodyParams,
} from './PhysicsRapier';
import { generateUUID } from 'three/src/math/MathUtils.js';

export type ImportModelParams = {
  fileName: string;
  id?: string;
  importGroup?: boolean;
  meshIndex?: number | number[];
  throwOnError?: boolean;
  saveMaterial?: boolean;
};

type ImportReturnObj = {
  group?: THREE.Group | THREE.Group[];
  mesh?: THREE.Mesh | THREE.Mesh[];
  physObj?: PhysicsObject | PhysicsObject[];
};

const ALLOWED_FILENAME_EXTENSIONS = ['gltf', 'glb'];

const setDracoLoader = (loader: GLTFLoader) => {
  // @TODO: test this properly (setDecoderPath is probably wrong now)
  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath('/examples/jsm/libs/draco/');
  loader.setDRACOLoader(dracoLoader);
};

const parseImportResult = (
  groupOrMesh: THREE.Group | THREE.Mesh,
  params: ImportModelParams
): ImportReturnObj => {
  const { id, fileName, importGroup, meshIndex, throwOnError, saveMaterial } = params;
  const returnObj: ImportReturnObj = {};

  if (importGroup) {
    // Go through meshes and save them
    const kids = groupOrMesh.children;
    const customProps: CleanUpCustomPropsResult[] = [];
    let index = 0;
    returnObj.mesh = [];
    console.log('GOES HERE', groupOrMesh);
    for (let i = 0; i < kids.length; i++) {
      const kid = kids[i];
      if ('isMesh' in kid && kid.isMesh) {
        const newId = id ? `${id}-${index}` : kid.uuid;
        const userData = kid.userData;
        customProps.push(cleanUpCustomProps(userData as CustomPropsUserData, kid.uuid));
        if (!('isPhysObj' in userData) || !userData.isPhysObj) {
          const m = saveMesh(kid as THREE.Mesh, newId, !saveMaterial);
          if (m) returnObj.mesh.push(m);
        }
        index++;
      }
    }

    const physObj = importMultiplePhysicsObjects(customProps, groupOrMesh).filter(
      Boolean
    ) as PhysicsObject[];

    for (let i = 0; i < physObj.length; i++) {
      const obj = physObj[i];
      if (obj.mesh) {
        if (Array.isArray(returnObj.mesh)) {
          returnObj.mesh.push(obj.mesh);
        } else {
          returnObj.mesh = obj.mesh;
        }
      } else if (obj.meshes) {
        if (Array.isArray(returnObj.mesh)) {
          returnObj.mesh.concat(obj.meshes);
        } else {
          returnObj.mesh = obj.meshes;
        }
      }
    }

    if (Array.isArray(returnObj.group) && returnObj.group.length === 1) {
      returnObj.group = returnObj.group[0];
    }
    if (Array.isArray(returnObj.mesh) && returnObj.mesh.length === 1) {
      returnObj.mesh = returnObj.mesh[0];
    }
    if (physObj.length) {
      returnObj.physObj =
        physObj.length === 1 && physObj[0] ? physObj[0] : (physObj as PhysicsObject[]);
    }

    return returnObj;
  }

  const index = Array.isArray(meshIndex) && !meshIndex.length ? 0 : meshIndex || 0;
  let depthIndex = 0;
  let modelMesh: THREE.Mesh | null = null;

  const getIndexedChild = (children: THREE.Object3D[]): THREE.Mesh | null => {
    if (!Array.isArray(index)) {
      return (children[index] as THREE.Mesh) || null;
    }
    const child = children[index[depthIndex]];
    if (depthIndex + 1 === index.length || !child) {
      return (child as THREE.Mesh) || null;
    }
    depthIndex++;
    return getIndexedChild(child.children);
  };

  modelMesh = getIndexedChild(groupOrMesh.children);

  if (!modelMesh) {
    const errorMsg = `Could not find a mesh in importModelAsync with index ${Array.isArray(index) ? JSON.stringify(index) : index} (id: "${id}", fileName: "${fileName}")`;
    lerror(errorMsg);
    if (throwOnError) throw new Error('Error while trying to find children after importing mesh!');
    return {};
  }
  if (!(modelMesh as THREE.Mesh).isMesh) {
    const errorMsg = `Imported object is not a THREE.Mesh in importModelAsync with index ${Array.isArray(index) ? JSON.stringify(index) : index} (id: "${id}", fileName: "${fileName}")`;
    lerror(errorMsg);
    if (throwOnError) throw new Error('Error while trying to find children after importing mesh!');
    return {};
  }

  const userData = cleanUpCustomProps(modelMesh?.userData, modelMesh.userData.id);
  const rigidAndChildParamsResult = getRigidParamsAndChildColliders([userData]);
  if (rigidAndChildParamsResult) {
    const { physParamsObj, rigidMeshId } = rigidAndChildParamsResult;
    if (userData.keepMesh) {
      // Keep mesh
      returnObj.physObj = createPhysicsObjectWithMesh({
        ...physParamsObj,
        meshOrMeshId: modelMesh,
        id: rigidMeshId,
      });
      if (returnObj.physObj && Array.isArray(returnObj.physObj)) {
        for (let i = 0; i < returnObj.physObj.length; i++) {
          const obj = returnObj.physObj[i];
          if (obj.mesh) {
            if (Array.isArray(returnObj.mesh)) {
              returnObj.mesh.push(obj.mesh);
            } else {
              returnObj.mesh = obj.mesh;
            }
          } else if (obj.meshes) {
            if (Array.isArray(returnObj.mesh)) {
              returnObj.mesh.concat(obj.meshes);
            } else {
              returnObj.mesh = obj.meshes;
            }
          }
        }
      } else if (returnObj.physObj) {
        const obj = returnObj.physObj;
        if (obj.mesh) {
          if (Array.isArray(returnObj.mesh)) {
            returnObj.mesh.push(obj.mesh);
          } else {
            returnObj.mesh = obj.mesh;
          }
        } else if (obj.meshes) {
          if (Array.isArray(returnObj.mesh)) {
            returnObj.mesh.concat(obj.meshes);
          } else {
            returnObj.mesh = obj.meshes;
          }
        }
      }
    } else {
      // Physics object only (no mesh)
      returnObj.physObj = createPhysicsObjectWithoutMesh(physParamsObj);
      // Remove temp mesh, geometry, and material(s)
      modelMesh.geometry.dispose();
      if (Array.isArray(modelMesh.material)) {
        for (let i = 0; i < modelMesh.material.length; i++) {
          modelMesh.material[i].dispose();
        }
      } else {
        modelMesh.material.dispose();
      }
      modelMesh.remove();
    }
  } else {
    const m = saveMesh(modelMesh as THREE.Mesh, id, !saveMaterial);
    if (m) returnObj.mesh = m;
  }

  return returnObj;
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
 * @param params {@link ImportModelParams}
 * @returns Promise<{@link ImportReturnObj}>
 */
export const importModelAsync = async (params: ImportModelParams): Promise<ImportReturnObj> => {
  const { id, fileName, importGroup, throwOnError } = params;
  if (id && !importGroup) {
    const mesh = getMesh(id);
    if (mesh) return { mesh };
  }
  if (id && importGroup) {
    const group = getGroup(id);
    if (group) return { group };
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
    return {};
  }

  return parseImportResult(modelGroup, params);
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
        const meshOrGroup = parseImportResult(modelGroup, modelsParams[i]);
        if (meshOrGroup.group && Array.isArray(meshOrGroup.group)) {
          meshOrGroup.group.forEach((group) => {
            modelGroups.push(group);
            loadedCount++;
          });
        } else if (meshOrGroup.group) {
          modelGroups.push(meshOrGroup.group);
          loadedCount++;
        } else if (meshOrGroup.mesh && Array.isArray(meshOrGroup.mesh)) {
          meshOrGroup.mesh.forEach((mesh) => {
            modelGroups.push(mesh);
            loadedCount++;
          });
        } else if (meshOrGroup.mesh) {
          modelGroups.push(meshOrGroup.mesh);
          loadedCount++;
        }
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
  isPhysObj?: boolean;
  keepMesh?: boolean;
  rigidType?: RigidBodyParams['rigidType'];
  colliderType?: ColliderParams['type'];
  density?: number;
  friction?: number;
  frictionCombineRule?: ColliderParams['frictionCombineRule'];
  restitution?: number;
  restitutionCombineRule?: ColliderParams['restitutionCombineRule'];
  index?: number;
  id?: string;
  name?: string;
} & { [userDataKey: string]: unknown };

type CleanUpCustomPropsResult = {
  meshId: string;
  isPhysObj?: boolean;
  keepMesh?: boolean;
  rigidType?: RigidBodyParams['rigidType'];
  rigidBodyUserData?: { [userDataKey: string]: unknown };
  colliderParams?: ColliderParams;
  index?: number;
  id?: string;
  name?: string;
};

const cleanUpCustomProps = (
  userData: CustomPropsUserData,
  meshId?: string
): CleanUpCustomPropsResult => {
  const id = userData.id;
  const name = userData.name;
  const isPhysObj = Boolean(userData.isPhysObj);
  if (userData.isPhysObj !== undefined) delete userData.isPhysObj;
  const keepMesh = Boolean(userData.keepMesh);
  if (userData.keepMesh !== undefined) delete userData.keepMesh;
  const rigidType = (
    userData.rigidType !== undefined &&
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
  if (userData.friction !== undefined) delete userData.friction;
  const frictionCombineRule =
    userData.frictionCombineRule !== 'MAX' &&
    userData.frictionCombineRule !== 'MIN' &&
    userData.frictionCombineRule !== 'MULTIPLY'
      ? 'AVERAGE'
      : userData.frictionCombineRule;
  if (userData.frictionCombineRule) delete userData.frictionCombineRule;
  const restitution = typeof userData.restitution === 'number' ? userData.restitution : 0.2;
  if (userData.restitution !== undefined) delete userData.restitution;
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
      if (userData.hx !== undefined) delete userData.hx;
      if (userData.hy !== undefined) delete userData.hy;
      if (userData.hz !== undefined) delete userData.hz;
      if (userData.borderRadius !== undefined) delete userData.borderRadius;
      break;
    case 'BALL':
    case 'SPHERE':
      colliderParams = {
        type: colliderType,
        ...(typeof userData.radius === 'number' ? { radius: userData.radius } : {}),
      };
      if (userData.radius !== undefined) delete userData.radius;
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
      if (userData.halfHeight !== undefined) delete userData.halfHeight;
      if (userData.radius !== undefined) delete userData.radius;
      if (userData.borderRadius !== undefined) delete userData.borderRadius;
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

  return {
    isPhysObj,
    ...(isPhysObj ? { keepMesh } : {}),
    ...(rigidType ? { rigidType } : {}),
    ...(Object.keys(rigidBodyUserData) ? { rigidBodyUserData: rigidBodyUserData } : {}),
    ...(isPhysObj ? { colliderParams: colliderParams } : {}),
    ...(typeof userData.index === 'number' ? { index: userData.index } : {}),
    meshId: meshId || generateUUID(),
    id,
    name,
  };
};

const importMultiplePhysicsObjects = (
  customProps: CleanUpCustomPropsResult[],
  groupOrMesh: THREE.Group | THREE.Mesh
): (PhysicsObject | undefined)[] => {
  const physObj: (PhysicsObject | undefined)[] = [];
  if (!customProps.length) return [];
  const customPropsWithoutIndex: CleanUpCustomPropsResult[] = [];
  // Collect all the different indexes to an array
  const indexes = customProps.reduce((prev, cur) => {
    if (cur.index === undefined) {
      // meshes with no index
      customPropsWithoutIndex.push(cur);
    } else if (cur.index !== undefined && !prev.includes(cur.index)) {
      // Collect the unique index
      return [...prev, cur.index];
    }
    return prev;
  }, [] as number[]);
  const customPropsByIndex: CleanUpCustomPropsResult[][] = [customPropsWithoutIndex];
  for (let i = 0; i < indexes.length; i++) {
    const items = customProps.filter((item) => item.index === indexes[i]);
    customPropsByIndex.push(items);
  }
  for (let j = 0; j < customPropsByIndex.length; j++) {
    const props = customPropsByIndex[j];
    const rigidAndChildParamsResult = getRigidParamsAndChildColliders(props);
    if (!rigidAndChildParamsResult) return [];
    const { rigidMeshId, rigidParams, physParamsObj } = rigidAndChildParamsResult;

    const mesh = groupOrMesh.children.find((m) => m.uuid === rigidMeshId) as THREE.Mesh;
    if (mesh) physParamsObj.meshOrMeshId = physParamsObj.physicsParams.length > 1 ? [mesh] : mesh;

    if (physParamsObj) {
      if (
        rigidParams.keepMesh &&
        (physParamsObj.meshOrMeshId || physParamsObj.meshOrMeshId.length)
      ) {
        const newPhysObj = createPhysicsObjectWithMesh(physParamsObj);
        if (newPhysObj) physObj.push(newPhysObj);
      } else {
        const allKeys = Object.keys(physParamsObj);
        const keys = allKeys.filter((key) => key !== 'meshOrMeshId');
        const physParamsWithoutMesh: { [key: string]: unknown } = {};
        for (let i = 0; i < keys.length; i++) {
          physParamsWithoutMesh[keys[i]] = physParamsObj[keys[i] as keyof typeof physParamsObj];
        }
        if (!physParamsWithoutMesh.id) physParamsWithoutMesh.id = generateUUID();
        const newPhysObj = createPhysicsObjectWithoutMesh(
          physParamsWithoutMesh as typeof physParamsObj & { id: string }
        );
        if (newPhysObj) physObj.push(newPhysObj);
      }
    }
  }

  return physObj;
};

const getRigidParamsAndChildColliders = (
  props: CleanUpCustomPropsResult[]
): {
  rigidMeshId: string;
  rigidParams: CleanUpCustomPropsResult;
  physParamsObj: {
    physicsParams: PhysicsParams[];
    meshOrMeshId: (THREE.Mesh | string) | (THREE.Mesh | string)[];
    id: string;
    name?: string;
    isCompoundObject: boolean;
  };
} | null => {
  let rigidIndex = -1;
  let rigidMeshId = generateUUID();
  const rigidParams = props.find((item, index) => {
    if (item.rigidType !== undefined) {
      rigidIndex = index;
      rigidMeshId = item.meshId;
      return true;
    }
    return false;
  });
  if (!rigidParams?.isPhysObj || !rigidParams?.colliderParams) return null;
  const restOfColliderParams = props.filter((_, index) => index !== rigidIndex);
  const physParamsObj = {
    physicsParams: [
      {
        rigidBody: {
          rigidType: rigidParams?.rigidType,
          userData: rigidParams?.rigidBodyUserData,
        },
        collider: rigidParams?.colliderParams,
      },
    ] as PhysicsParams[],
    meshOrMeshId: [] as (THREE.Mesh | string) | (THREE.Mesh | string)[],
    id: rigidParams.id || rigidMeshId,
    name: rigidParams.name,
    isCompoundObject: Boolean(restOfColliderParams.length),
  };
  if (!physParamsObj.physicsParams[0].collider) return null;

  for (let i = 0; i < restOfColliderParams.length; i++) {
    const colliderParams = restOfColliderParams[i].colliderParams;
    if (!restOfColliderParams[i].isPhysObj || !colliderParams) {
      continue;
    }
    if (!physParamsObj.id) physParamsObj.id = rigidMeshId;
    physParamsObj.isCompoundObject = false;
    physParamsObj.physicsParams.push({ collider: colliderParams });
  }

  return {
    rigidMeshId,
    rigidParams,
    physParamsObj,
  };
};
