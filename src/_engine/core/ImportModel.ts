import * as THREE from 'three/webgpu';
import { GLTF, GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/Addons.js';
import { lerror, lwarn } from '../utils/Logger';
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
import { type CoreEntityOpts } from '../schemas/_helperSchemas';
import { createMeshEntity, disposeMesh, getMeshByAppId, MeshProps } from './MeshManager';
import { existsOrThrow } from '../utils/assert';
import { getECSWorld } from './ECS';
import { addToGroupEntity, createGroupEntity, getGroupByAppId } from './GroupManager';
import { ComponentType } from './ECS/ECSCoreComponents';

export type AdditionalImportPhysicsParams = {
  isPhysObj?: boolean;
  keepMesh?: boolean;
  appId?: string;
  name?: string;
  index?: number;
};

export type ImportModelParams = {
  fileName: string;
  appId?: string;
  /** Mesh props to apply to the meshes */
  meshProps?: Partial<MeshProps>[];
  /** Core entity options for all imported meshes and groups */
  entityOpts?: CoreEntityOpts;
  allMeshesVisible?: boolean;
  importGroup?: boolean;
  groupId?: string;
  groupName?: string;
  meshIndex?: number | number[];
  throwOnError?: boolean;

  /** These physics params will override the imported custom params or then just
   * create a physics object out of the object if no import custom params are
   * present (a collider and a rigidBody must be defined).
   */
  physicsParams?:
    | Partial<PhysicsParams & AdditionalImportPhysicsParams>
    | Partial<PhysicsParams & AdditionalImportPhysicsParams>[];
};

export type ImportReturnObj = {
  group?: THREE.Group;
  groupId?: number;
  mesh?: THREE.Mesh | THREE.Mesh[];
  meshId?: number | number[];
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
  const { appId, fileName, entityOpts, importGroup, meshIndex, throwOnError, physicsParams } =
    params;
  const returnObj: ImportReturnObj = {};
  const overridePhysParams = Array.isArray(physicsParams)
    ? physicsParams
    : [...(physicsParams ? [physicsParams] : [])];
  const meshPropsArr = params.meshProps || [];

  if (importGroup) {
    // Go through meshes and create entities
    const kids = groupOrMesh.children;
    const customProps: CleanUpCustomPropsResult[] = [];
    let index = 0;
    returnObj.mesh = [];
    returnObj.meshId = [];
    if ('isGroup' in groupOrMesh) returnObj.group = groupOrMesh;
    for (let i = 0; i < kids.length; i++) {
      const kid = kids[i];
      if ('isMesh' in kid && kid.isMesh) {
        const m = kid as THREE.Mesh;
        const id = appId || entityOpts?.appId || m.userData.id || m.uuid;
        const newId = id ? `${id}-${index}-${i}` : m.uuid;
        const userData = m.userData;
        if (userData.keepMesh) {
          const mProps = meshPropsArr[i];
          const entityId = createMeshEntity(
            {
              geo: mProps?.geo || m.geometry,
              mat: mProps?.mat || (Array.isArray(m.material) ? m.material[0] : m.material),
              castShadow: mProps?.castShadow || m.castShadow,
              receiveShadow: mProps?.receiveShadow || m.receiveShadow,
              position: mProps?.position || m.position,
              rotation: mProps?.rotation || m.rotation,
              quaternion: mProps?.rotation ? undefined : mProps?.quaternion || m.quaternion,
              appId: mProps?.appId || newId,
            },
            params.entityOpts
          );
          returnObj.meshId.push(entityId);
        }
        customProps.push(
          cleanUpCustomProps(userData as CustomPropsUserData, overridePhysParams[i], m.uuid)
        );
        if (!userData.keepMesh && (!('isPhysObj' in userData) || !userData.isPhysObj)) {
          const m = kid as THREE.Mesh;
          const mProps = meshPropsArr[i];
          const entityId = createMeshEntity(
            {
              geo: mProps?.geo || m.geometry,
              mat: mProps?.mat || (Array.isArray(m.material) ? m.material[0] : m.material),
              castShadow: mProps?.castShadow || m.castShadow,
              receiveShadow: mProps?.receiveShadow || m.receiveShadow,
              position: mProps?.position || m.position,
              rotation: mProps?.rotation || m.position,
              quaternion: mProps?.rotation ? undefined : mProps?.quaternion || m.quaternion,
              appId: mProps?.appId || newId,
            },
            params.entityOpts
          );
          returnObj.mesh.push(m);
          returnObj.meshId.push(entityId);
        }
        if (userData.isPhysObj !== undefined) delete userData.isPhysObj;
        index++;
      }
    }

    const physObj = importMultiplePhysicsObjects(customProps, groupOrMesh, params).filter(
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
          returnObj.meshId = [firstMesh.userData.entityId];
        }
      }

      if (params.allMeshesVisible && obj.meshes) {
        for (let i = 0; i < obj.meshes.length; i++) {
          obj.meshes[i].visible = true;
        }
      }
    }

    if (Array.isArray(returnObj.mesh) && returnObj.mesh.length === 1) {
      returnObj.mesh = returnObj.mesh[0];
    }
    if (Array.isArray(returnObj.meshId) && returnObj.meshId.length === 1) {
      returnObj.meshId = returnObj.meshId[0];
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

  const id =
    appId || entityOpts?.appId || modelMesh?.userData.id || modelMesh?.uuid || generateUUID();

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

  const userData = cleanUpCustomProps(modelMesh?.userData, overridePhysParams[0], id);
  const rigidAndChildParamsResult = getRigidParamsAndChildColliders([userData], params);
  if (rigidAndChildParamsResult) {
    const { physParamsObj, rigidMeshId } = rigidAndChildParamsResult;
    if (userData.keepMesh) {
      // Keep mesh
      const meshId = modelMesh.userData.id || modelMesh.uuid;
      const m = modelMesh;
      const savedMesh = m;
      const mProps = meshPropsArr[0];
      createMeshEntity(
        {
          geo: mProps?.geo || m.geometry,
          mat: mProps?.mat || (Array.isArray(m.material) ? m.material[0] : m.material),
          castShadow: mProps?.castShadow || m.castShadow,
          receiveShadow: mProps?.receiveShadow || m.receiveShadow,
          position: mProps?.position || m.position,
          rotation: mProps?.rotation || m.rotation,
          quaternion: mProps?.rotation ? undefined : mProps?.quaternion || m.quaternion,
          appId: mProps?.appId || meshId,
        },
        params.entityOpts
      );
      returnObj.physObj = createPhysicsObjectWithMesh({
        ...physParamsObj,
        meshOrMeshId: savedMesh || meshId,
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
            if (Array.isArray(returnObj.meshId)) {
              returnObj.meshId.push(obj.mesh.userData.entityId);
            } else {
              returnObj.meshId = obj.mesh.userData.entityId;
            }
          } else if (obj.meshes) {
            if (Array.isArray(returnObj.mesh)) {
              returnObj.mesh.concat(obj.meshes);
            } else {
              returnObj.mesh = obj.meshes;
            }
            if (Array.isArray(returnObj.meshId)) {
              returnObj.meshId.concat(obj.meshes.map((m: THREE.Mesh) => m.userData.entityId));
            } else {
              returnObj.meshId = obj.meshes.map((m: THREE.Mesh) => m.userData.entityId);
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
          if (Array.isArray(returnObj.meshId)) {
            returnObj.meshId.push(obj.mesh.userData.entityId);
          } else {
            returnObj.meshId = obj.mesh.userData.entityId;
          }
        } else if (obj.meshes) {
          if (Array.isArray(returnObj.mesh)) {
            returnObj.mesh.concat(obj.meshes);
          } else {
            returnObj.mesh = obj.meshes;
          }
          if (Array.isArray(returnObj.meshId)) {
            returnObj.meshId.concat(obj.meshes.map((m: THREE.Mesh) => m.userData.entityId));
          } else {
            returnObj.meshId = obj.meshes.map((m: THREE.Mesh) => m.userData.entityId);
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
    const m = modelMesh;
    const mProps = meshPropsArr[0];
    const entityId = createMeshEntity(
      {
        geo: mProps?.geo || m.geometry,
        mat: mProps?.mat || (Array.isArray(m.material) ? m.material[0] : m.material),
        castShadow: mProps?.castShadow || m.castShadow,
        receiveShadow: mProps?.receiveShadow || m.receiveShadow,
        position: mProps?.position || m.position,
        rotation: mProps?.rotation || m.rotation,
        quaternion: mProps?.rotation ? undefined : mProps?.quaternion || m.quaternion,
        appId: mProps?.appId || id,
      },
      params.entityOpts
    );
    returnObj.mesh = m;
    returnObj.meshId = entityId;
  }

  deleteUnwantedImportedMeshes(returnObj);

  if (returnObj.group?.userData.entityId) {
    getECSWorld().deleteEntity(returnObj.group?.userData.entityId);
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
  const { appId, fileName, importGroup, entityOpts, throwOnError } = params;
  const id = appId || entityOpts?.appId;
  const world = getECSWorld();
  if (id && !importGroup) {
    const mesh = getMeshByAppId(id, world);
    if (mesh) return { mesh, meshId: mesh.userData.entityId };
  }
  if (id && importGroup) {
    const group = getGroupByAppId(id, world);
    if (group) return { group };
  }
  checkImportFileName(fileName);

  const loader = new GLTFLoader();
  setDracoLoader(loader);

  let entityId;
  try {
    const gltf = await loader.loadAsync(fileName);
    // @TODO: add a debugger rule here to console.log the gltf
    entityId = createGroupEntity({ appId: id }, params.entityOpts, world);
    // Check if the first and only child is an empty object and import the children
    if (gltf?.scene?.children.length === 1 && isOnlyObject3D(gltf.scene.children[0])) {
      const children = [...gltf.scene.children[0].children];
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        addToGroupEntity(entityId, child);
      }
      world.setTransform(entityId, {
        pos: gltf.scene.children[0].position,
        rot: gltf.scene.children[0].quaternion,
      });
    } else {
      const children = [...gltf?.scene?.children];
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        addToGroupEntity(entityId, child);
      }
    }
  } catch (err) {
    const errorMsg = `Could not import ${importGroup ? 'group' : 'model'} in importModelAsync (id: "${id}", fileName: "${fileName}")`;
    lerror(errorMsg, err);
    if (throwOnError) throw new Error('Error while importing!');
    return {};
  }

  const modelGroup = existsOrThrow(
    world.getComponent(entityId, ComponentType.OBJECT3D)?.value,
    `Could not find group component in importModelAsync.`
  ) as THREE.Group;

  const parsedResult = parseImportResult(modelGroup, params);

  if (!params.importGroup) world.deleteEntity(entityId);

  return parsedResult;
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

  const world = getECSWorld();

  for (let i = 0; i < modelsParams.length; i++) {
    const { appId, fileName, entityOpts, importGroup, throwOnError } = modelsParams[i];
    const id = appId || entityOpts?.appId;
    if (id && !importGroup) {
      const mesh = getMeshByAppId(id, world);
      if (mesh) {
        modelGroups.push(mesh);
        loadedCount++;
        if (updateStatusFn) updateStatusFn(modelGroups, loadedCount, modelsParams.length);
        continue;
      }
    }
    if (id && importGroup) {
      const group = getGroupByAppId(id, world);
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
        // const modelGroup = createGroup({ id: modelsParams[i].groupId });
        const entityId = createGroupEntity(
          { appId: modelsParams[i].groupId },
          modelsParams[i].entityOpts,
          world
        );
        const modelGroup = existsOrThrow(
          world.getComponent(entityId, ComponentType.OBJECT3D)?.value,
          'Could not find modelGroup in importModels.'
        ) as THREE.Group;
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
  nCols?: number;
  nRows?: number;
  hx?: number;
  hy?: number;
  hz?: number;
  radius?: number;
  borderRadius?: number;
  halfHeight?: number;
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
    ...(overridePhysParams?.meshId ? { id: overridePhysParams.meshId } : {}),
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
  if (userData.colliderType) delete userData.colliderType;
  const density = userData.density !== undefined ? userData.density : 0.2;
  if (userData.density) delete userData.density;
  const friction = userData.friction !== undefined ? userData.friction : 0.2;
  if (userData.friction !== undefined) delete userData.friction;
  const frictionCombineRule =
    userData.frictionCombineRule !== 'MAX' &&
    userData.frictionCombineRule !== 'MIN' &&
    userData.frictionCombineRule !== 'MULTIPLY'
      ? 'AVERAGE'
      : userData.frictionCombineRule;
  if (userData.frictionCombineRule) delete userData.frictionCombineRule;
  const restitution = userData.restitution !== undefined ? userData.restitution : 0.2;
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
        ...(userData.hx !== undefined ? { hx: userData.hx } : {}),
        ...(userData.hy !== undefined ? { hy: userData.hy } : {}),
        ...(userData.hz !== undefined ? { hz: userData.hz } : {}),
        ...(userData.borderRadius !== undefined ? { borderRadius: userData.borderRadius } : {}),
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
        ...(userData.radius !== undefined ? { radius: userData.radius } : {}),
      };
      if (userData.radius !== undefined) delete userData.radius;
      break;
    case 'CAPSULE':
    case 'CONE':
    case 'CYLINDER':
      colliderParams = {
        type: colliderType,
        ...(userData.halfHeight !== undefined ? { halfHeight: userData.halfHeight } : {}),
        ...(userData.radius !== undefined ? { radius: userData.radius } : {}),
        ...(userData.borderRadius !== undefined ? { borderRadius: userData.borderRadius } : {}),
      };
      if (userData.halfHeight !== undefined) delete userData.halfHeight;
      if (userData.radius !== undefined) delete userData.radius;
      if (userData.borderRadius !== undefined) delete userData.borderRadius;
      break;
    case 'TRIMESH':
      // TRIMESH (vertices and indices will come from the mesh)
      colliderParams = { type: colliderType };
      break;
    case 'HEIGHTFIELD':
      colliderParams = {
        type: colliderType,
        ...(userData.nCols !== undefined ? { ncols: userData.nCols } : {}),
        ...(userData.nRows !== undefined ? { nrows: userData.nRows } : {}),
      };
      if (userData.nCols !== undefined) delete userData.nCols;
      if (userData.nRows !== undefined) delete userData.nRows;
      break;
    case 'CONVEXHULL':
      colliderParams = { type: colliderType };
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
  groupOrMesh: THREE.Group | THREE.Mesh,
  params: ImportModelParams
): (PhysicsObject | undefined)[] => {
  const physObj: (PhysicsObject | undefined)[] = [];
  if (!customProps.length) return [];
  const customPropsWithoutIndex: CleanUpCustomPropsResult[] = [];
  // Collect all the different indexes to an array
  const indexes = customProps.reduce((prev, cur) => {
    if (cur.index === undefined || typeof cur.index !== 'number') {
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
    const rigidAndChildParamsResult = getRigidParamsAndChildColliders(props, params);
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
  props: CleanUpCustomPropsResult[],
  params: ImportModelParams
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
    id: params.appId || params.entityOpts?.appId || rigidParams.id || rigidMeshId,
    name: params.entityOpts?.debugData?.name || rigidParams.name,
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
        mesh = existsOrThrow(
          getMeshByAppId(mesh),
          `Could not find the mesh with appId "${mesh}" in setPhysParamsObjMeshesWithDimensions (meshOrMeshId is an array).`
        );
      }
      setMeshCreatePropsToUserData(colliderParams.type, mesh);
    }
  } else {
    let mesh = meshOrMeshId;
    if (typeof mesh === 'string') {
      mesh = existsOrThrow(
        getMeshByAppId(mesh),
        `Could not find the mesh with appId "${mesh}" in setPhysParamsObjMeshesWithDimensions (meshOrMeshId is a string).`
      );
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

  const ids = removeMeshes.map((m) => m.userData.entityId).filter(Boolean);
  const world = getECSWorld();
  for (let i = 0; i < ids.length; i++) {
    disposeMesh(ids[i], world);
  }
};
