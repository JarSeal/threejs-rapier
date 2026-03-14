import * as THREE from 'three/webgpu';
import { GLTF, GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/Addons.js';
import { lerror, lwarn } from '../utils/Logger';
import { deleteMesh, getMesh, saveMesh } from './Mesh';
import { createGroup, getGroup } from './Group';
import {
  ColliderParams,
  createPhysicsObjectWithMesh,
  createPhysicsObjectWithoutMesh,
  PhysicsObject,
  PhysicsParams,
  RigidBodyParams,
} from './PhysicsRapier';
import { generateUUID } from 'three/src/math/MathUtils.js';
import { isOnlyObject3D, setMeshCreatePropsToUserData } from '../utils/helpers';

export type AdditionalImportPhysicsParams = {
  isPhysObj?: boolean;
  keepMesh?: boolean;
  id?: string;
  name?: string;
  index?: number;
};

export type ImportModelParams = {
  fileName: string;
  id?: string;
  importGroup?: boolean;
  groupId?: string;
  meshIndex?: number | number[];
  throwOnError?: boolean;
  saveMaterial?: boolean;

  /** These physics params will override the imported custom params or then just
   * create a physics object out of the object if no import custom params are
   * present (a collider and a rigidBody must be defined).
   */
  physicsParams?:
    | Partial<PhysicsParams & AdditionalImportPhysicsParams>
    | Partial<PhysicsParams & AdditionalImportPhysicsParams>[];
};

type ImportReturnObj = {
  group?: THREE.Group;
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
  const { id, fileName, importGroup, meshIndex, throwOnError, saveMaterial, physicsParams } =
    params;
  const returnObj: ImportReturnObj = {};
  const overridePhysParams = Array.isArray(physicsParams)
    ? physicsParams
    : [...(physicsParams ? [physicsParams] : [])];

  if (importGroup) {
    // Go through meshes and save them
    const kids = groupOrMesh.children;
    const customProps: CleanUpCustomPropsResult[] = [];
    let index = 0;
    returnObj.mesh = [];
    if ('isGroup' in groupOrMesh) returnObj.group = groupOrMesh;
    for (let i = 0; i < kids.length; i++) {
      const kid = kids[i];
      if ('isMesh' in kid && kid.isMesh) {
        const newId = id ? `${id}-${index}-${i}` : kid.uuid;
        const userData = kid.userData;
        customProps.push(
          cleanUpCustomProps(userData as CustomPropsUserData, overridePhysParams[i], kid.uuid)
        );
        if (!('isPhysObj' in userData) || !userData.isPhysObj) {
          const m = saveMesh(kid as THREE.Mesh, newId, !saveMaterial);
          if (m) returnObj.mesh.push(m);
        }
        if (userData.isPhysObj !== undefined) delete userData.isPhysObj;
        index++;
      }
    }

    const physObj = importMultiplePhysicsObjects(customProps, groupOrMesh).filter(
      Boolean
    ) as PhysicsObject[];

    for (let i = 0; i < physObj.length; i++) {
      const obj = physObj[i];
      if (obj.mesh?.userData.keepMesh) {
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

      if (
        (!returnObj.mesh || (Array.isArray(returnObj.mesh) && !returnObj.mesh.length)) &&
        obj.meshes?.length
      ) {
        const firstMesh = obj.meshes.find((m) => m.userData.keepMesh);
        if (firstMesh) {
          firstMesh.visible = true;
          returnObj.mesh = [firstMesh];
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

    deleteUnwantedImportedMeshes(returnObj);

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

  const userData = cleanUpCustomProps(
    modelMesh?.userData,
    overridePhysParams[0],
    modelMesh.userData.id
  );
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

  deleteUnwantedImportedMeshes(returnObj);

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
    // @TODO: add a debugger rule here to console.log the gltf
    modelGroup = createGroup({ id: params.groupId });
    modelGroup.children =
      // Check if the first and only child is an empty object and add that if found
      gltf?.scene?.children.length === 1 && isOnlyObject3D(gltf.scene.children[0])
        ? gltf.scene.children[0].children
        : gltf?.scene?.children || [];
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
        // @TODO: add a debugger rule here to console.log the gltf
        const modelGroup = createGroup({ id: modelsParams[i].groupId });
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
  overridePhysParams?: Partial<PhysicsParams & AdditionalImportPhysicsParams>,
  meshId?: string
): CleanUpCustomPropsResult => {
  userData = {
    ...userData,
    ...(overridePhysParams?.isPhysObj !== undefined
      ? { isPhysObj: overridePhysParams.isPhysObj }
      : {}),
    ...(overridePhysParams?.id ? { id: overridePhysParams.id } : {}),
    ...(overridePhysParams?.name ? { name: overridePhysParams.name } : {}),
    ...(overridePhysParams?.keepMesh !== undefined
      ? { keepMesh: overridePhysParams.keepMesh }
      : {}),
    ...(overridePhysParams?.index !== undefined ? { index: overridePhysParams.index } : {}),
    ...(overridePhysParams?.rigidBody?.rigidType
      ? { rigidType: overridePhysParams.rigidBody.rigidType }
      : {}),
    ...(overridePhysParams?.collider?.type
      ? { colliderType: overridePhysParams.collider.type }
      : {}),
    ...(overridePhysParams?.collider?.density !== undefined
      ? { density: overridePhysParams.collider.density }
      : {}),
    ...(overridePhysParams?.collider?.friction !== undefined
      ? { friction: overridePhysParams.collider.friction }
      : {}),
    ...(overridePhysParams?.collider?.restitution !== undefined
      ? { restitution: overridePhysParams.collider.restitution }
      : {}),
    ...(overridePhysParams?.collider?.frictionCombineRule
      ? { frictionCombineRule: overridePhysParams.collider.frictionCombineRule }
      : {}),
    ...(overridePhysParams?.collider?.restitutionCombineRule
      ? { restitutionCombineRule: overridePhysParams.collider.restitutionCombineRule }
      : {}),
    ...(overridePhysParams?.collider
      ? {
          ...('borderRadius' in overridePhysParams.collider &&
          overridePhysParams.collider.borderRadius !== undefined
            ? { borderRadius: overridePhysParams.collider.borderRadius }
            : {}),
          ...('hx' in overridePhysParams.collider && overridePhysParams.collider.hx !== undefined
            ? { hx: overridePhysParams.collider.hx }
            : {}),
          ...('hy' in overridePhysParams.collider && overridePhysParams.collider.hy !== undefined
            ? { hy: overridePhysParams.collider.hy }
            : {}),
          ...('hz' in overridePhysParams.collider && overridePhysParams.collider.hz !== undefined
            ? { hz: overridePhysParams.collider.hz }
            : {}),
          ...('radius' in overridePhysParams.collider &&
          overridePhysParams.collider.radius !== undefined
            ? { radius: overridePhysParams.collider.radius }
            : {}),
          ...('halfHeight' in overridePhysParams.collider &&
          overridePhysParams.collider.halfHeight !== undefined
            ? { halfHeight: overridePhysParams.collider.halfHeight }
            : {}),
        }
      : {}),
  };
  const id = userData.id;
  const name = userData.name;
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
  const colliderType = userData.colliderType;
  // @TODO: Remove this after the multi import is working
  // const colliderType = (
  //   userData.colliderType !== 'CUBOID' &&
  //   userData.colliderType !== 'BOX' &&
  //   userData.colliderType !== 'BALL' &&
  //   userData.colliderType !== 'SPHERE' &&
  //   userData.colliderType !== 'CAPSULE' &&
  //   userData.colliderType !== 'CONE' &&
  //   userData.colliderType !== 'CYLINDER' &&
  //   userData.colliderType !== 'TRIANGLE'
  //     ? 'TRIMESH'
  //     : userData.colliderType
  // ) as ColliderParams['type'];
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

  let colliderParams: ColliderParams | null = null;
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
    case 'TRIMESH':
      // TRIMESH (vertices and indices will come from the mesh)
      colliderParams = { type: 'TRIMESH' };
      break;
  }

  const isPhysObj = Boolean(userData.isPhysObj);

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

  if (!colliderParams) {
    return {
      isPhysObj,
      ...(isPhysObj ? { keepMesh } : {}),
      ...(rigidType ? { rigidType } : {}),
      ...(Object.keys(rigidBodyUserData) ? { rigidBodyUserData: rigidBodyUserData } : {}),
      ...(typeof userData.index === 'number' ? { index: userData.index } : {}),
      meshId: meshId || generateUUID(),
      id,
      name,
    };
  }

  colliderParams = {
    ...colliderParams,
    density,
    friction,
    frictionCombineRule,
    restitution,
    restitutionCombineRule,
  };

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
  const customPropsByIndex: CleanUpCustomPropsResult[][] = customPropsWithoutIndex.length
    ? [customPropsWithoutIndex]
    : [];
  for (let i = 0; i < indexes.length; i++) {
    const items = customProps.filter((item) => item.index === indexes[i]);
    customPropsByIndex.push(items);
  }
  for (let j = 0; j < customPropsByIndex.length; j++) {
    const allProps = customPropsByIndex[j];
    const propsWithRigidParams = allProps.find((p) => p.rigidType);
    const propsWithoutColliders = allProps.filter((p) => !p.colliderParams && !p.rigidType);
    const propsWithColliders = allProps.filter((p) => p.colliderParams && !p.rigidType);
    const props = [
      ...(propsWithRigidParams ? [propsWithRigidParams] : []),
      ...propsWithColliders,
      ...propsWithoutColliders,
    ];
    const rigidAndChildParamsResult = getRigidParamsAndChildColliders(props);
    if (!rigidAndChildParamsResult) return [];
    const { rigidMeshId, physParamsObj } = rigidAndChildParamsResult;
    if (props.length > 1) physParamsObj.isCompoundObject = true;

    for (let i = 0; i < props.length; i++) {
      let mesh = groupOrMesh.children.find((m) => m.userData.id === props[i].id) as THREE.Mesh;
      if (!mesh) mesh = groupOrMesh.children.find((m) => m.uuid === rigidMeshId) as THREE.Mesh;
      if (mesh) {
        if (physParamsObj.physicsParams.length > 1) {
          if (!physParamsObj.meshOrMeshId) physParamsObj.meshOrMeshId = [];
          if (Array.isArray(physParamsObj.meshOrMeshId)) {
            physParamsObj.meshOrMeshId.push(mesh);
          }
        } else {
          physParamsObj.meshOrMeshId = mesh;
        }
      } else {
        lwarn('Could not find a mesh from groupOrMesh in importMultiplePhysicsObjects');
      }
    }

    if (physParamsObj) {
      // Set dimensions of primitive shapes to the mesh userData
      setPhysParamsObjMeshesWithDimensions(physParamsObj);

      if (
        physParamsObj.meshOrMeshId ||
        (Array.isArray(physParamsObj.meshOrMeshId) && physParamsObj.meshOrMeshId.length)
      ) {
        const newPhysObj = createPhysicsObjectWithMesh(physParamsObj);
        if (newPhysObj) physObj.push(newPhysObj);
      } else {
        // @CONSIDER: This branch might be unnecessary because we need the data from the meshes to create physics objects and there cannot be any physics objects without the mesh.
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

      // Set positions
      for (let i = 0; i < physObj.length; i++) {
        const obj = physObj[i];
        if (!obj?.meshes?.length) continue;
        for (let j = 0; j < obj.meshes.length; j++) {
          const collider = Array.isArray(obj.collider) ? obj.collider[j] : obj.collider;
          if (!collider || (j > 0 && !Array.isArray(obj.collider))) continue;
          const mesh = obj.meshes[j];
          collider.setTranslationWrtParent(mesh.position);
        }
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
  if (!rigidParams?.isPhysObj) return null;
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

const setPhysParamsObjMeshesWithDimensions = (physParamsObj: {
  physicsParams: PhysicsParams[];
  meshOrMeshId: (THREE.Mesh | string) | (THREE.Mesh | string)[];
  id: string;
  name?: string;
  isCompoundObject: boolean;
}) => {
  const { physicsParams, meshOrMeshId } = physParamsObj;
  if (
    !meshOrMeshId ||
    (Array.isArray(meshOrMeshId) && !meshOrMeshId.length) ||
    !physicsParams?.length
  ) {
    return;
  }

  if (Array.isArray(meshOrMeshId)) {
    for (let i = 0; i < meshOrMeshId.length; i++) {
      const colliderParams = physicsParams[i]?.collider;
      if (!colliderParams) continue;
      let mesh = meshOrMeshId[i];
      if (typeof mesh === 'string') {
        const m = getMesh(mesh);
        mesh = m;
      }
      setMeshCreatePropsToUserData(colliderParams.type, mesh);
    }
  } else {
    let mesh = meshOrMeshId;
    if (typeof mesh === 'string') {
      const m = getMesh(mesh);
      mesh = m;
    }
    setMeshCreatePropsToUserData(physicsParams[0].collider.type, mesh);
  }
};

const deleteUnwantedImportedMeshes = (obj: ImportReturnObj) => {
  const removeUUIDs: string[] = [];
  const removeMeshes: THREE.Mesh[] = [];

  // obj.group
  if (obj.group) {
    const group = obj.group;
    for (let i = 0; i < group.children.length; i++) {
      const mesh = group.children[i] as THREE.Mesh;
      if (mesh?.userData.keepMesh === false && !removeUUIDs.includes(mesh.uuid)) {
        removeUUIDs.push(mesh.uuid);
        removeMeshes.push(mesh);
      }
    }
    if (group.children.length && removeMeshes.length) {
      group.remove(...removeMeshes);
    }
  }

  // obj.mesh
  if (Array.isArray(obj.mesh)) {
    for (let i = 0; i < obj.mesh.length; i++) {
      const mesh = obj.mesh[i];
      if (mesh?.userData.keepMesh === false && !removeUUIDs.includes(mesh.uuid)) {
        removeUUIDs.push(mesh.uuid);
        removeMeshes.push(mesh);
      }
    }
    if (obj.mesh?.length) {
      const newMeshes = obj.mesh.filter((m) => !removeUUIDs.includes(m.uuid));
      obj.mesh = newMeshes;
    }
  } else {
    const mesh = obj.mesh;
    if (mesh?.userData.keepMesh === false && !removeUUIDs.includes(mesh.uuid)) {
      removeUUIDs.push(mesh.uuid);
      removeMeshes.push(mesh);
    }
    if (obj.mesh && removeUUIDs.includes(obj.mesh.uuid)) {
      obj.mesh = undefined;
    }
  }

  // obj.physObj
  const physObj = obj.physObj;
  if (!physObj) return;
  if (Array.isArray(physObj)) {
    for (let i = 0; i < physObj.length; i++) {
      const mesh = physObj[i].mesh;
      if (mesh?.userData.keepMesh === false && !removeUUIDs.includes(mesh.uuid)) {
        removeUUIDs.push(mesh.uuid);
        removeMeshes.push(mesh);
      }
      const meshes = physObj[i].meshes;
      if (meshes) {
        for (let j = 0; j < meshes.length; j++) {
          const mesh = meshes[j];
          if (mesh?.userData.keepMesh === false && !removeUUIDs.includes(mesh.uuid)) {
            removeUUIDs.push(mesh.uuid);
            removeMeshes.push(mesh);
          }
        }
      }
      const curPhysObj = physObj[i];
      if (curPhysObj.mesh && removeUUIDs.includes(curPhysObj.mesh.uuid)) {
        curPhysObj.mesh = undefined;
      }
      if (curPhysObj.meshes?.length) {
        const newMeshes = curPhysObj.meshes.filter((m) => !removeUUIDs.includes(m.uuid));
        curPhysObj.meshes = newMeshes;
      }
    }
  } else {
    const mesh = physObj.mesh;
    if (mesh?.userData.keepMesh === false && !removeUUIDs.includes(mesh.uuid)) {
      removeUUIDs.push(mesh.uuid);
      removeMeshes.push(mesh);
    }
    const meshes = physObj.meshes;
    if (meshes) {
      for (let j = 0; j < meshes.length; j++) {
        const mesh = meshes[j];
        if (mesh?.userData.keepMesh === false && !removeUUIDs.includes(mesh.uuid)) {
          removeUUIDs.push(mesh.uuid);
          removeMeshes.push(mesh);
        }
      }
    }
    if (physObj.mesh && removeUUIDs.includes(physObj.mesh.uuid)) {
      physObj.mesh = undefined;
    }
    if (physObj.meshes?.length) {
      const newMeshes = physObj.meshes.filter((m) => !removeUUIDs.includes(m.uuid));
      physObj.meshes = newMeshes;
    }
  }

  const ids = removeMeshes.map((m) => (m.userData.id !== undefined ? m.userData.id : m.uuid));
  if (ids.length) {
    deleteMesh(ids, { deleteAll: true });
  }
};
