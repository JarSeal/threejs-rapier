import * as THREE from 'three/webgpu';
import {
  createGeometry,
  incGeometryRef,
  decGeometryRef,
  GeoProps,
  getGeometryRegistry,
} from './Geometry';
import {
  createMaterial,
  incMaterialRef,
  decMaterialRef,
  MatProps,
  getMaterial,
  getMaterialRegistry,
  getMaterialVariant,
  MaterialVariantOverrides,
} from './Material';
import { ECSWorld, getECSWorld, getEntityIdByAppId } from './ECS';
import { getRootScene } from './Scene';
import { ThreeEuler, ThreeQuoternion } from '../utils/helpers';
import { getRenderer } from './Renderer';
import { ComponentType } from './ECS/ECSCoreComponents';
import { setTransform } from '../utils/ECSHelpers';
import { lerror, lwarn } from '../utils/Logger';
import { type CoreEntityOpts } from '../schemas/_helperSchemas';
import { existsOrThrow } from '../utils/assert';
import { getGeometry } from './Geometry';
import { CoreComponentType } from './ECS/ECSRegistry';
import { setFrustumCullingEnabled } from './ECS/ObjectFrustumCullingSystem';
import { IS_DEBUG_ENV } from './Config';
import type { LodDef, MeshLodDef } from './Lod/LodTypes';

// Register onDeleteEntity hook for TAG_IS_MESH
ECSWorld.registerComponentHooks(ComponentType.TAG_IS_MESH, {
  onDeleteEntity: (entityId, world) => disposeMesh(entityId, world),
});

export type MeshProps = {
  // @CONSIDER: We could also allow passing an id for geo and mat (as strings), and then look them up in the asset manager.
  geo: THREE.BufferGeometry | GeoProps | string;
  mat: THREE.Material | MatProps;
  /** Per-mesh material overrides: the mesh gets a cached variant of its (registered) material, see getMaterialVariant */
  matOverrides?: MaterialVariantOverrides;
  castShadow?: boolean;
  receiveShadow?: boolean;
  preWarm?: boolean;
  position?: { x?: number; y?: number; z?: number };
  rotation?: { x?: number; y?: number; z?: number };
  quaternion?: THREE.Quaternion;
  scale?: { x: number; y: number; z: number };
  appId?: string;
  /** Native Object3D.frustumCulled (Three.js's own per-mesh render-list culling). Defaults to Three's own default (true). */
  frustumCullingEnabled?: boolean;
  /** Levels of detail, or `AUTO` from the geometry's LOD chain, see {@link setMeshLod}. */
  lod?: MeshLodDef;
};

/** Debug only: warns about a geometry or material that isn't the registered one under its id (it
 * has no id, or it's eg. a `.clone()` carrying its source's id). Mesh refs only release registered
 * assets, so nothing ever disposes these, and they leak GPU memory on every scene visit. */
const warnIfUnregistered = (
  appId: string,
  geo?: THREE.BufferGeometry,
  material?: THREE.Material | THREE.Material[]
) => {
  if (!IS_DEBUG_ENV) return;
  const describe = (id?: string) => (id ? `a copy carrying the id "${id}"` : 'no id');
  const geoId = geo?.userData.id as string | undefined;
  if (geo && getGeometryRegistry()[geoId || '']?.resource !== geo) {
    lwarn(
      `[MeshManager] Mesh "${appId}" uses an unregistered geometry (${describe(geoId)}), which is never disposed. Create it with createGeometry or register it with saveBufferGeometry.`
    );
  }
  for (const m of Array.isArray(material) ? material : material ? [material] : []) {
    const matId = m.userData.id as string | undefined;
    if (getMaterialRegistry()[matId || '']?.resource === m) continue;
    lwarn(
      `[MeshManager] Mesh "${appId}" uses an unregistered material (${describe(matId)}), which is never disposed. Create it with createMaterial or register it with saveMaterial.`
    );
  }
};

/**
 * Compiles a mesh's pipelines ahead of its first draw (`renderer.compileAsync`), so the frame it
 * first shows in doesn't stall on it. Used by `createMeshEntity`'s `preWarm` and for every level
 * of a pre-warmed mesh's LOD.
 * @param mesh the mesh, or a stand-in with the geometry and material to compile
 * @param label names the mesh in the warning
 */
export const preWarmMesh = (mesh: THREE.Mesh, label: string) => {
  const renderer = getRenderer();
  const rootScene = getRootScene();
  const camera = new THREE.PerspectiveCamera(); // Consider using the actual active camera if available
  if (!renderer || !rootScene) return;

  // Check if we have any valid shadow maps in the scene
  // WebGPU TSL needs a valid texture instance to compile a shadow-receiving shader.
  const hasInitializedShadows = rootScene.children.some(
    (child) =>
      child instanceof THREE.Light &&
      child.castShadow &&
      'shadow' in child &&
      (child as { shadow: { map?: unknown } }).shadow?.map
  );

  // Only compile if it's "safe"
  if (!mesh.receiveShadow || hasInitializedShadows) {
    renderer.compileAsync(mesh, camera, rootScene);
  } else {
    // If we can't pre-warm now, the renderer will just compile it
    // on the first actual draw call (standard behavior).
    lwarn(`[Engine] Skipping preWarm for ${label} - ShadowMap not ready.`);
  }
};

export const createMeshEntity = (
  props: MeshProps,
  entityOpts?: CoreEntityOpts,
  ecsWorld?: ECSWorld
): number => {
  const world =
    ecsWorld || existsOrThrow(getECSWorld(), 'Could not get ECS world in createMeshEntity.');

  let geo;
  if (props.geo instanceof THREE.BufferGeometry) {
    geo = props.geo;
  } else if (typeof props.geo === 'string') {
    geo = existsOrThrow(
      getGeometry(props.geo) as THREE.BufferGeometry,
      `Could not find geometry with id "${props.geo}" in createMeshEntity (mesh appId "${props.appId || entityOpts?.appId}").`
    );
  } else {
    geo = createGeometry(props.geo);
  }

  let mat;
  if (props.mat instanceof THREE.Material) {
    mat = props.mat;
  } else if (typeof props.mat === 'string') {
    mat = existsOrThrow(
      getMaterial(props.mat),
      `Could not find material with id "${props.mat}" in createMeshEntity (mesh appId "${props.appId || entityOpts?.appId}").`
    );
  } else {
    mat = createMaterial(props.mat);
  }

  if (props.matOverrides) {
    const baseMatId = mat.userData.id as string | undefined;
    if (baseMatId && getMaterialRegistry()[baseMatId]?.resource === mat) {
      mat = getMaterialVariant(baseMatId, props.matOverrides);
    } else {
      lwarn(
        `[MeshManager] Mesh "${props.appId || entityOpts?.appId}" has matOverrides but its material is not registered, ignoring the overrides.`
      );
    }
  }

  const mesh = new THREE.Mesh(geo, mat);
  const appId = props.appId || entityOpts?.appId || mesh.uuid;
  mesh.castShadow = props.castShadow ?? false;
  mesh.receiveShadow = props.receiveShadow ?? false;
  mesh.frustumCulled = props.frustumCullingEnabled ?? true;
  mesh.userData.id = appId;

  warnIfUnregistered(appId, geo, mat);
  if (geo.userData.id) incGeometryRef(geo.userData.id);
  if (mat.userData.id) incMaterialRef(mat.userData.id);

  const rootScene = existsOrThrow(getRootScene(), 'Could not find root scene in createMeshEntity.');

  if (props.preWarm) {
    // Remembered so a LOD added later pre-warms its levels too (Lod/LodSystem.ts)
    mesh.userData.preWarm = true;
    preWarmMesh(mesh, entityOpts?.appId || 'mesh');
  }

  // The appId resolved above is the entity's real (fixed) appId too, whichever of props/entityOpts
  // it came from — otherwise a props-only appId (JSON-authored and imported meshes) would leave
  // the entity with a random per-load id: unfindable via getMeshByAppId, and without the stable
  // id per-entity persisted settings (e.g. physics debug wireframes) are keyed by.
  const explicitAppId = props.appId || entityOpts?.appId;
  const entityId = world.createEntity(
    explicitAppId ? { ...entityOpts, appId: explicitAppId } : entityOpts
  );
  mesh.userData.entityId = entityId;

  world.addComponent(entityId, ComponentType.OBJECT3D, {
    value: mesh,
    _lastVersion: -1,
  });
  world.addComponent(entityId, ComponentType.TAG_IS_MESH, true);

  if (!entityOpts?.doNotAddToScene) rootScene.add(mesh);

  const tra = {
    pos: { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z },
    rot: { x: mesh.quaternion.x, y: mesh.quaternion.y, z: mesh.quaternion.z, w: mesh.quaternion.w },
  };
  if (props.position) {
    if (props.position.x !== undefined) tra.pos.x = props.position.x;
    if (props.position.y !== undefined) tra.pos.y = props.position.y;
    if (props.position.z !== undefined) tra.pos.z = props.position.z;
  }
  if (props.quaternion) {
    tra.rot.x = props.quaternion.x;
    tra.rot.y = props.quaternion.y;
    tra.rot.z = props.quaternion.z;
    tra.rot.w = props.quaternion.w;
  } else if (props.rotation) {
    const rot = ThreeEuler.set(mesh.rotation.x, mesh.rotation.y, mesh.rotation.z);
    if (props.rotation.x !== undefined) rot.x = props.rotation.x;
    if (props.rotation.y !== undefined) rot.y = props.rotation.y;
    if (props.rotation.z !== undefined) rot.z = props.rotation.z;
    const quat = ThreeQuoternion.setFromEuler(rot);
    tra.rot.x = quat.x;
    tra.rot.y = quat.y;
    tra.rot.z = quat.z;
    tra.rot.w = quat.w;
  }
  setTransform(entityId, tra, world);
  if (props.scale) {
    const transform = world.getComponent(entityId, ComponentType.TRANSFORM);
    if (transform) {
      transform.scale.set(props.scale.x, props.scale.y, props.scale.z);
      transform.setDirty();
      world.commitTransform(entityId, transform);
    }
  }

  // After the transform is finalized so the spatial index's initial insert
  // (docs/plans/_DONE_p050_spatial-index.md §3) uses this mesh's real position,
  // not createEntity()'s default (0,0,0).
  if (entityOpts?.spatialIndex !== false) {
    world.addComponent(entityId, ComponentType.SPATIAL_INDEXED, true);
  }

  // ECS-queryable frustum culling (docs/plans/_DONE_p080_object3d-frustum-culling.md §2.1/§2.4) —
  // opt-in, off by default, distinct from `props.frustumCullingEnabled` above (Three's native
  // render-time culling, on by default).
  if (entityOpts?.ecsFrustumCullingEnabled) {
    setFrustumCullingEnabled(entityId, true, world);
  }

  // Last: the LOD's level 0 is the mesh as created, and its add hook pre-warms the other levels
  // when the mesh has preWarm
  if (props.lod) setMeshLod(entityId, props.lod, world);

  return entityId;
};

/** Per world: the `AUTO` LODs waiting for their chain, by entity. A later setMeshLod or
 * removeMeshLod replaces or drops the entry, which cancels the wait. */
const pendingAutoLods = new WeakMap<ECSWorld, Map<number, object>>();

const getPendingAutoLods = (world: ECSWorld) => {
  let pending = pendingAutoLods.get(world);
  if (!pending) {
    pending = new Map();
    pendingAutoLods.set(world, pending);
  }
  return pending;
};

const addLodComponent = (entityId: number, def: LodDef, world: ECSWorld) => {
  world.addComponent(entityId, ComponentType.LOD, {
    def,
    level: -1,
    applied: -1,
    radius: 0,
    _levels: [],
  });
};

/**
 * Gives a mesh entity levels of detail (docs/plans/_DONE_p348_ecs-lod-selection.md): from the next
 * frame, lodSelectionSystem picks a level by the mesh's screen size and lodApplySystem swaps its
 * geometry, material(s) and `castShadow`. Level 0 is the mesh's own unless it names others. Every
 * level's assets are held (ref counted) until the LOD is removed or the entity deleted, and
 * pre-warmed when the mesh was created with `preWarm`. Replaces a LOD the mesh already has (back
 * to level 0 first). The definition is read, not copied: after changing its levels, set it again.
 *
 * Level changes and hiding / showing cross-fade with a dither over `fadeSeconds` (default
 * `AppConfig.lod.fadeSeconds`; docs/plans/_DONE_p351_impostor-billboard-lod.md §2.4): the previous level
 * is drawn by a temporary copy of the mesh meanwhile. Unless `fadeSeconds` is 0, the levels'
 * materials get `enableLodDither` (shared with other meshes, those get it too).
 *
 * `'AUTO'` (or `{ auto: true, ... }`) reads the levels from the geometry's LOD chain (p347): each
 * is used while its simplification error stays within `maxPixelError` pixels at a viewport height
 * of 1080. The mesh stays on level 0 until the chain is ready (it waits for one the geometry's
 * import requested or one being generated), and warns when the geometry has none.
 *
 * An `InstancedMesh` entity (eg. a static instance cell) switches all its instances at once, by
 * level 0's bounds over every instance: write its instance matrices first, and call
 * `refreshLodBounds` after they change. Its mesh needs `userData.entityId` when it holds registry
 * refs, like a pool's mesh, so the level swaps move them.
 * @param entityId a mesh entity: one created with createMeshEntity, or an `InstancedMesh` entity
 * @param def the levels, `screenSize` descending, or `AUTO`
 * @param ecsWorld the entity's world (default: the default world)
 * @returns resolves to whether the LOD was set: at once for levels, when the chain is ready for
 *   `AUTO` (false when it has none, or the LOD was replaced, removed or the entity deleted first)
 */
export const setMeshLod = (
  entityId: number,
  def: MeshLodDef,
  ecsWorld?: ECSWorld
): Promise<boolean> => {
  const world = ecsWorld || getECSWorld();
  // addComponent overwrites without the remove hook: it would keep the old levels' refs and take
  // the current (maybe coarser) level as level 0
  removeMeshLod(entityId, world);
  if (def !== 'AUTO' && !('auto' in def)) {
    addLodComponent(entityId, def, world);
    return Promise.resolve(true);
  }

  const mesh = world.getComponent(entityId, ComponentType.OBJECT3D)?.value;
  if (!(mesh instanceof THREE.Mesh)) {
    lwarn(`[LOD] Entity ${entityId} has no mesh: its LOD does nothing.`);
    return Promise.resolve(false);
  }
  const geometry = mesh.geometry;
  const request = {};
  const pending = getPendingAutoLods(world);
  pending.set(entityId, request);
  const isCurrent = () => pending.get(entityId) === request;
  return import('./Lod/LodAuto')
    .then(({ resolveAutoLod }) =>
      isCurrent() ? resolveAutoLod(geometry, def, mesh.userData.id || mesh.uuid, mesh) : null
    )
    .catch((err) => {
      lerror(`[LOD] Mesh "${mesh.userData.id || mesh.uuid}": lod AUTO failed.`, err);
      return null;
    })
    .then((resolved) => {
      if (!isCurrent()) return false;
      pending.delete(entityId);
      // Deleted meanwhile, or its geometry changed: the chain isn't its level 0's any more
      if (!resolved || !world.isAlive(entityId) || mesh.geometry !== geometry) return false;
      addLodComponent(entityId, resolved, world);
      return true;
    });
};

/**
 * Removes a mesh entity's levels of detail: it goes back to level 0, shows again if the LOD hid
 * it, and the other levels' assets are released. Cancels an `AUTO` LOD still waiting for its
 * chain. A no-op without a LOD.
 * @param entityId a mesh entity
 * @param ecsWorld the entity's world (default: the default world)
 */
export const removeMeshLod = (entityId: number, ecsWorld?: ECSWorld) => {
  const world = ecsWorld || getECSWorld();
  pendingAutoLods.get(world)?.delete(entityId);
  if (world.hasComponent(entityId, ComponentType.LOD)) {
    world.removeComponent(entityId, ComponentType.LOD);
  }
};

export const disposeMesh = (entityId: number, ecsWorld?: ECSWorld) => {
  const world = ecsWorld || getECSWorld();

  const meshComp = world.getComponent(entityId, ComponentType.OBJECT3D);
  if (!meshComp) return;

  const mesh = meshComp.value as THREE.Mesh;

  mesh.removeFromParent();

  const geoId = mesh.geometry?.userData.id;
  if (geoId) decGeometryRef(geoId);

  if (Array.isArray(mesh.material)) {
    mesh.material.forEach((m) => {
      if (m.userData.id) decMaterialRef(m.userData.id);
    });
  } else if (mesh.material.userData.id) {
    decMaterialRef(mesh.material.userData.id);
  }
};

const forEachMaterialId = (
  material: THREE.Material | THREE.Material[],
  fn: (id: string) => void
) => {
  for (const m of Array.isArray(material) ? material : [material]) {
    if (m.userData.id) fn(m.userData.id);
  }
};

/**
 * Swaps a mesh entity's material and moves its material ref count to the new material. Assigning
 * `mesh.material` directly would leave the old material's ref taken (never freed) and release a
 * ref the new one never got (freed while still in use) when the mesh is disposed.
 * @param mesh a mesh created with createMeshEntity (other meshes take no refs: only assigned)
 * @param material the new material(s)
 */
export const setMeshMaterial = (mesh: THREE.Mesh, material: THREE.Material | THREE.Material[]) => {
  const prev = mesh.material;
  mesh.material = material;
  if (mesh.userData.entityId === undefined || prev === material) return;
  warnIfUnregistered(mesh.userData.id, undefined, material);
  // New refs first: the old and new material can share ids (eg. the same one in an array)
  forEachMaterialId(material, incMaterialRef);
  forEachMaterialId(prev, decMaterialRef);
};

/**
 * Swaps a mesh entity's geometry and moves its geometry ref count to the new one, like
 * {@link setMeshMaterial} does for materials.
 * @param mesh a mesh created with createMeshEntity (other meshes take no refs: only assigned)
 * @param geometry the new geometry
 */
export const setMeshGeometry = (mesh: THREE.Mesh, geometry: THREE.BufferGeometry) => {
  const prev = mesh.geometry;
  mesh.geometry = geometry;
  if (mesh.userData.entityId === undefined || prev === geometry) return;
  warnIfUnregistered(mesh.userData.id, geometry);
  if (geometry.userData.id) incGeometryRef(geometry.userData.id);
  if (prev.userData.id) decGeometryRef(prev.userData.id);
};

export const getMeshByAppId = (appId: string, ecsWorld?: ECSWorld) => {
  const world = ecsWorld || getECSWorld();
  const entityId = getEntityIdByAppId(appId, world);
  let mesh: THREE.Mesh | undefined = undefined;
  if (entityId) {
    const obj = world.getComponent(entityId, CoreComponentType.OBJECT3D)?.value;
    if (obj && !(obj as THREE.Mesh).isMesh) {
      const msg = `Found Object3D is not a mesh (type: ${obj.type}).`;
      lerror(msg);
      throw new Error(msg);
    }
    mesh = obj as THREE.Mesh | undefined;
  }
  return mesh;
};
