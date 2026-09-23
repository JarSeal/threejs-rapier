import * as THREE from 'three/webgpu';
import { GLTF, GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/Addons.js';
import { BufferGeometryUtils } from 'three/examples/jsm/Addons.js';
import { lerror, lwarn } from '../utils/Logger';
import { ColliderParams, RigidBodyParams } from './Physics/PhysicsAPITypes';
import { createPhysicsEntity, deriveColliderDimensionsFromMesh } from './PhysicsManager';
import { generateUUID } from 'three/src/math/MathUtils.js';
import { isOnlyObject3D, setMeshCreatePropsToUserData } from '../utils/helpers';
import { type CoreEntityOpts } from '../schemas/_helperSchemas';
import { createMeshEntity, getMeshByAppId, MeshProps } from './MeshManager';
import { existsOrThrow } from '../utils/assert';
import { getECSWorld } from './ECS';
import { addToGroupEntity, createGroupEntity, getGroupByAppId } from './GroupManager';
import { ComponentType } from './ECS/ECSCoreComponents';

/** This file's own internal grouping of one collider (+ optionally the shared rigid body) for
 * a physics-tagged imported mesh — the engine-agnostic Physics API has no single equivalent
 * combined type since `createPhysicsEntity` takes collider(s) and the rigid body as separate
 * params; this local type is what the Blender-custom-property extraction pipeline below
 * (`cleanUpCustomProps`/`getRigidParamsAndChildColliders`) builds before that call. */
export type PhysicsParams = {
  /** Collider type and params {@link ColliderParams} */
  collider: ColliderParams;
  /** Rigid body type and params {@link RigidBodyParams} */
  rigidBody?: RigidBodyParams;
  /** Mesh id to be used in multi object importing */
  meshId?: string;
};

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
  /** @deprecated No-op: a mesh's visibility is decided by its own custom props alone (non-physics
   * and keepMesh physics meshes are rendered, collider-only physics meshes never are). */
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
  /** The rendered mesh(es) of the created mesh entities (same order as `meshId`) */
  mesh?: THREE.Mesh | THREE.Mesh[];
  /** Entity id(s) of the created mesh entities (collider-only meshes don't get one) */
  meshId?: number | number[];
  /** Entity id(s) carrying the rigid bodies. Usually one of the `meshId` entities, or a
   * headless physics entity when none of that physics object's meshes are kept visible. */
  physicsEntityId?: number | number[];
};

const ALLOWED_FILENAME_EXTENSIONS = ['gltf', 'glb'];

const setDracoLoader = (loader: GLTFLoader) => {
  // @TODO: test this properly (setDecoderPath is probably wrong now)
  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath('/examples/jsm/libs/draco/');
  loader.setDRACOLoader(dracoLoader);
};

/** Creates the ECS mesh entity for one loaded glTF mesh. The entity gets its own new
 * THREE.Mesh (sharing the glTF mesh's geometry/material) — the glTF mesh itself is only a
 * template and must never end up rendered. Returns the entity id and its real, rendered mesh. */
const createEntityFromImportedMesh = (
  m: THREE.Mesh,
  mProps: Partial<MeshProps> | undefined,
  appId: string,
  entityOpts?: CoreEntityOpts
) => {
  const entityId = createMeshEntity(
    {
      geo: mProps?.geo || m.geometry,
      mat: mProps?.mat || (Array.isArray(m.material) ? m.material[0] : m.material),
      castShadow: mProps?.castShadow || m.castShadow,
      receiveShadow: mProps?.receiveShadow || m.receiveShadow,
      frustumCullingEnabled: mProps?.frustumCullingEnabled ?? m.frustumCulled,
      position: mProps?.position || m.position,
      rotation: mProps?.rotation || m.rotation,
      quaternion: mProps?.rotation ? undefined : mProps?.quaternion || m.quaternion,
      appId: mProps?.appId || appId,
    },
    entityOpts
  );
  const mesh = getECSWorld().getComponent(entityId, ComponentType.OBJECT3D)?.value as THREE.Mesh;
  return { entityId, mesh };
};

const parseImportResult = async (
  groupOrMesh: THREE.Group | THREE.Mesh,
  params: ImportModelParams
): Promise<ImportReturnObj> => {
  const { appId, fileName, entityOpts, importGroup, meshIndex, throwOnError, physicsParams } =
    params;
  const returnObj: ImportReturnObj = {};
  const overridePhysParams = Array.isArray(physicsParams)
    ? physicsParams
    : [...(physicsParams ? [physicsParams] : [])];
  const meshPropsArr = params.meshProps || [];

  if (importGroup) {
    // Every glTF mesh becomes exactly one ECS mesh entity, or none if it's a collider-only
    // physics mesh (isPhysObj without keepMesh). The glTF meshes themselves are only templates:
    // they're linked to their entity via userData.entityId (so the physics pass below attaches
    // to that entity instead of creating a second one) and removed from the group at the end.
    const kids = groupOrMesh.children;
    const customProps: CleanUpCustomPropsResult[] = [];
    const gltfMeshes: THREE.Mesh[] = [];
    const meshes: THREE.Mesh[] = [];
    const meshIds: number[] = [];
    let index = 0;
    if ('isGroup' in groupOrMesh) returnObj.group = groupOrMesh;
    for (let i = 0; i < kids.length; i++) {
      const kid = kids[i];
      if ('isMesh' in kid && kid.isMesh) {
        const m = kid as THREE.Mesh;
        gltfMeshes.push(m);
        const id = appId || entityOpts?.appId || m.userData.id || m.uuid;
        const newId = id ? `${id}-${index}-${i}` : m.uuid;
        // Resolved with the physicsParams overrides applied, so an override's isPhysObj/keepMesh
        // decides visibility the same way the GLB's own custom properties would.
        const props = cleanUpCustomProps(
          m.userData as CustomPropsUserData,
          overridePhysParams[i],
          m.uuid
        );
        customProps.push(props);
        if (!props.isPhysObj || props.keepMesh) {
          const { entityId, mesh } = createEntityFromImportedMesh(
            m,
            meshPropsArr[i],
            newId,
            params.entityOpts
          );
          m.userData.entityId = entityId;
          meshes.push(mesh);
          meshIds.push(entityId);
        }
        index++;
      }
    }

    const physEntityIds = await importMultiplePhysicsObjects(customProps, groupOrMesh, params);

    if (gltfMeshes.length) groupOrMesh.remove(...gltfMeshes);

    returnObj.mesh = meshes.length === 1 ? meshes[0] : meshes;
    returnObj.meshId = meshIds.length === 1 ? meshIds[0] : meshIds;
    if (physEntityIds.length) {
      returnObj.physicsEntityId = physEntityIds.length === 1 ? physEntityIds[0] : physEntityIds;
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
    const { physParamsObj } = rigidAndChildParamsResult;
    if (userData.keepMesh) {
      // Keep mesh
      const m = modelMesh;
      const { entityId, mesh } = createEntityFromImportedMesh(
        m,
        meshPropsArr[0],
        id,
        params.entityOpts
      );
      // TRIMESH/HEIGHTFIELD/CONVEXHULL shape data (see deriveMeshDependentColliderFields) plus
      // each secondary collider's local offset from the shared rigid body (mirrors the legacy
      // system's post-creation `collider.setTranslationWrtParent(mesh.position)`).
      const colliderParamsArray = physParamsObj.physicsParams.map((p, i) => {
        const collider = deriveMeshDependentColliderFields(p.collider, m);
        return i > 0 ? { ...collider, translation: m.position } : collider;
      });
      await createPhysicsEntity(
        colliderParamsArray,
        physParamsObj.physicsParams[0].rigidBody,
        entityId
      );
      returnObj.mesh = mesh;
      returnObj.meshId = entityId;
      returnObj.physicsEntityId = entityId;
    } else {
      // Physics object only (no mesh)
      const colliderParamsArray = physParamsObj.physicsParams.map((p, i) => {
        const collider = deriveMeshDependentColliderFields(p.collider, modelMesh);
        return i > 0 ? { ...collider, translation: modelMesh.position } : collider;
      });
      const entityId = await createPhysicsEntity(
        colliderParamsArray,
        physParamsObj.physicsParams[0].rigidBody,
        undefined,
        { appId: physParamsObj.id }
      );
      returnObj.meshId = entityId;
      returnObj.physicsEntityId = entityId;
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
    const { entityId, mesh } = createEntityFromImportedMesh(
      modelMesh,
      meshPropsArr[0],
      id,
      params.entityOpts
    );
    returnObj.mesh = mesh;
    returnObj.meshId = entityId;
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

  const parsedResult = await parseImportResult(modelGroup, params);

  if (!params.importGroup) {
    // The glTF children are only templates by now. Detach them first: disposeGroup deletes any
    // entity whose appId matches a child's userData.id, which can be the mesh entity just
    // created from that child (a GLB `id` custom property becomes its appId).
    modelGroup.clear();
    world.deleteEntity(entityId);
  }

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
      async (gltf: GLTF) => {
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
        const meshOrGroup = await parseImportResult(modelGroup, modelsParams[i]);
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

/**
 * For TRIMESH/HEIGHTFIELD/CONVEXHULL, the legacy PhysicsRapier system auto-derived the shape
 * data straight from the attached mesh's geometry — the new Physics API's collider builder has
 * no such mesh-based inference, so this pipeline extracts it explicitly. Ported verbatim from
 * PhysicsRapier.ts's own TRIMESH/HEIGHTFIELD/CONVEXHULL createCollider cases (HEIGHTFIELD's
 * row/col derivation in particular is fragile, geometry-dependent logic — kept exactly as-is,
 * not rewritten). Other shape types (BOX/BALL/CAPSULE/CONE/CYLINDER/TRIANGLE) don't need this:
 * their legacy mesh-geometry-inference fallback only ever fired for meshes created via this
 * engine's own createGeometry() (reading geo.userData.props.params), never for GLTF-imported
 * geometries, so for imports it was always a no-op that fell through to the same hardcoded
 * defaults the new API's collider builder already applies.
 */
const deriveMeshDependentColliderFields = (
  colliderParams: ColliderParams,
  mesh: THREE.Mesh
): ColliderParams => {
  if (colliderParams.type === 'TRIMESH') {
    if (colliderParams.vertices && colliderParams.indices) return colliderParams;
    const geo = mesh.geometry;
    const vertices = new Float32Array(geo.attributes.position.array);
    const indices = geo.index
      ? new Uint32Array(geo.index.array)
      : new Uint32Array([...Array(vertices.length / 3).keys()]);
    return { ...colliderParams, vertices, indices };
  }

  if (colliderParams.type === 'CONVEXHULL') {
    if (colliderParams.vertices) return colliderParams;
    const geo = existsOrThrow(
      mesh.geometry,
      'Could not find mesh or geometry in the mesh for convex hull in deriveMeshDependentColliderFields.'
    );
    const geoClone = geo.clone();
    geoClone.applyMatrix4(new THREE.Matrix4().makeScale(mesh.scale.x, mesh.scale.y, mesh.scale.z));
    geoClone.center();
    const vertices = new Float32Array(geoClone.attributes.position.array);
    geoClone.dispose();
    return { ...colliderParams, vertices };
  }

  if (colliderParams.type === 'HEIGHTFIELD') {
    let geo = existsOrThrow(
      mesh.geometry,
      'Could not find mesh or geometry in the mesh for heightfield. Could not create height field physics shape in deriveMeshDependentColliderFields.'
    );
    geo = BufferGeometryUtils.mergeVertices(geo);
    mesh.geometry = geo;

    let nRows = colliderParams.nrows || 0;
    let nCols = colliderParams.ncols || 0;

    const bbox = new THREE.Box3().setFromObject(mesh);
    const meshSize = new THREE.Vector3();
    bbox.getSize(meshSize);
    const scale = { x: meshSize.x, y: 1, z: meshSize.z };

    const totalVertices = geo.attributes.position.count;

    if (!nCols && nRows > 0) {
      nCols = totalVertices / nRows;
    } else if (!nRows && nCols > 0) {
      nRows = totalVertices / nCols;
    } else if (!nRows && !nCols) {
      nRows = Math.sqrt(totalVertices) - 1;
      nCols = nRows;
      if (!Number.isInteger(nRows)) {
        lerror(
          `The HEIGHTFIELD importing failed because the squareroot of the totalVertices count (${totalVertices}) is not an integer (${nRows}). The vertices are either unindexed or the grid's number of columns does not match the number of rows. Index the vertices, use shade smooth, or provide the ncols and nrows as custom properties.`
        );
        return colliderParams;
      }
    }
    const sizeX = nRows + 1;
    const sizeZ = nCols + 1;
    const heights = new Float32Array(sizeX * sizeZ);
    const posAttr = geo.attributes.position;
    for (let i = 0; i < sizeX; i++) {
      for (let j = 0; j < sizeZ; j++) {
        const rapierIndex = i * sizeZ + j;
        const flippedZ = sizeZ - 1 - j;
        const threeIndex = flippedZ * sizeX + i;
        heights[rapierIndex] = posAttr.getY(threeIndex);
      }
    }
    return {
      ...colliderParams,
      nrows: Math.round(nRows),
      ncols: Math.round(nCols),
      heights,
      scale,
    };
  }

  return colliderParams;
};

/** Resolves and creates the physics objects of a group import: one rigid body (and entity) per
 * custom prop "index" group, with one collider per physics mesh in that index group. Returns the
 * entity ids carrying the rigid bodies.
 *
 * The rigid body attaches to an existing mesh entity (the anchor) — the rigid body mesh itself
 * when it's kept visible, otherwise the first kept mesh of the same index group — so a physics
 * object never gets a second, duplicate visual. Every collider is offset (translation + rotation)
 * from that anchor by its own mesh's glTF-local transform. Only an index group with no kept mesh
 * at all becomes a headless physics entity, spawned at the rigid body mesh's transform. */
const importMultiplePhysicsObjects = async (
  customProps: CleanUpCustomPropsResult[],
  groupOrMesh: THREE.Group | THREE.Mesh,
  params: ImportModelParams
): Promise<number[]> => {
  const physEntityIds: number[] = [];
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

  // customProps' meshId is the source glTF mesh's uuid (see parseImportResult)
  const getGltfMesh = (uuid?: string) =>
    uuid
      ? (groupOrMesh.children.find((c) => c.uuid === uuid) as THREE.Mesh | undefined)
      : undefined;
  const hasEntity = (m?: THREE.Mesh) => typeof m?.userData.entityId === 'number';

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
    if (!rigidAndChildParamsResult) continue;
    const { physParamsObj } = rigidAndChildParamsResult;

    const rigidMesh = getGltfMesh(physParamsObj.physicsParams[0].meshId);
    if (!rigidMesh) {
      lwarn('Could not find the rigid body mesh from groupOrMesh in importMultiplePhysicsObjects');
      continue;
    }
    const anchorMesh = hasEntity(rigidMesh)
      ? rigidMesh
      : props.map((p) => getGltfMesh(p.meshId)).find(hasEntity) || rigidMesh;
    const anchorEntityId = anchorMesh.userData.entityId as number | undefined;
    anchorMesh.updateMatrix();
    const anchorInverse = anchorMesh.matrix.clone().invert();

    const colliderParamsArray = physParamsObj.physicsParams.map((p) => {
      const mesh = getGltfMesh(p.meshId) || rigidMesh;
      // Primitive shape dimensions come from each collider's own mesh (createPhysicsEntity's
      // fallback derivation would only ever look at the anchor mesh).
      setMeshCreatePropsToUserData(p.collider.type, mesh);
      let collider = deriveColliderDimensionsFromMesh(
        deriveMeshDependentColliderFields(p.collider, mesh),
        mesh
      );
      if (mesh !== anchorMesh && !collider.translation && !collider.rotation) {
        mesh.updateMatrix();
        const offset = new THREE.Matrix4().multiplyMatrices(anchorInverse, mesh.matrix);
        const pos = new THREE.Vector3();
        const rot = new THREE.Quaternion();
        offset.decompose(pos, rot, new THREE.Vector3());
        // Identity rotation is left out so it can't override a shape's own `orientation`
        const isRotated = Math.abs(rot.w) < 1 - 1e-6;
        collider = {
          ...collider,
          translation: { x: pos.x, y: pos.y, z: pos.z },
          ...(isRotated ? { rotation: { x: rot.x, y: rot.y, z: rot.z, w: rot.w } } : {}),
        };
      }
      return collider;
    });

    const rigidBody = physParamsObj.physicsParams[0].rigidBody;
    const entityId = await createPhysicsEntity(
      colliderParamsArray,
      anchorEntityId !== undefined || !rigidBody
        ? rigidBody
        : {
            ...rigidBody,
            translation: rigidBody.translation ?? {
              x: anchorMesh.position.x,
              y: anchorMesh.position.y,
              z: anchorMesh.position.z,
            },
            rotation: rigidBody.rotation ?? {
              x: anchorMesh.quaternion.x,
              y: anchorMesh.quaternion.y,
              z: anchorMesh.quaternion.z,
              w: anchorMesh.quaternion.w,
            },
          },
      anchorEntityId,
      anchorEntityId === undefined ? { appId: `${physParamsObj.id}-phys-${j}` } : undefined
    );
    physEntityIds.push(entityId);
  }

  return physEntityIds;
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
        meshId: rigidParams.meshId,
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
    physParamsObj.physicsParams.push({
      collider: colliderParams,
      meshId: restOfColliderParams[i].meshId,
    });
  }

  return {
    rigidMeshId,
    rigidParams,
    physParamsObj,
  };
};
