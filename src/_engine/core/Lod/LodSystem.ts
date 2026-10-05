import * as THREE from 'three/webgpu';
import { APP_RENDER_SYNC_ORDER, ECSSystemStage } from '../../../AppECSRegistry';
import { ECSWorld } from '../ECS';
import { ComponentType } from '../ECS/ECSCoreComponents';
import { reconcileObject3DVisibility } from '../ECS/ECSCoreSystems';
import { getMainCamera } from '../CameraManager';
import { getConfig, IS_DEBUG_ENV } from '../Config';
import { decGeometryRef, getGeometryRegistry, incGeometryRef } from '../Geometry';
import { decMaterialRef, getMaterialRegistry, incMaterialRef } from '../Material';
import { preWarmMesh, setMeshGeometry, setMeshMaterial } from '../MeshManager';
import { getConservativeGeometryRadius } from '../Spatial/SpatialIndexSystem';
import { lwarn } from '../../utils/Logger';
import type { LodData, LodResolvedLevel } from './LodTypes';

// LOD selection and apply (docs/plans/p348_ecs-lod-selection.md). `LOD` is the opt-in definition
// and the selected/applied level; TAG_LOD_CULLED is the runtime state "beyond the last level",
// a fourth cull reason next to DISABLED, TAG_FRUSTUM_CULLED and TAG_OBJECT_CULLED.
//
// Refs: the mesh always holds one ref on the geometry and material it shows (the apply moves it
// with setMeshGeometry/setMeshMaterial), and the LOD component one on every level's. So a level's
// assets live as long as the component, and deleting the entity releases them in any hook order.

const DEFAULT_HYSTERESIS = 0.1;

ECSWorld.registerComponentHooks(ComponentType.TAG_LOD_CULLED, {
  onAddComponent: (entityId, world) => {
    reconcileObject3DVisibility(entityId, world, { isLodCulled: true });
  },
  onRemoveComponent: (entityId, world) => {
    reconcileObject3DVisibility(entityId, world, { isLodCulled: false });
  },
});

// --- GLOBAL BIAS ---

let globalBias: number | undefined;

/** The global LOD bias: multiplies every entity's screen size, >1 keeps detail longer. */
export const getLodBias = () => (globalBias ??= getConfig().lod?.bias ?? 1);

/** Sets the global LOD bias (initially `AppConfig.lod.bias`). Takes effect at the next selection. */
export const setLodBias = (bias: number) => {
  globalBias = bias;
};

// --- LEVELS AND REFS ---

const forEachMaterial = (
  material: THREE.Material | THREE.Material[],
  fn: (m: THREE.Material) => void
) => {
  if (Array.isArray(material)) material.forEach(fn);
  else fn(material);
};

const refLevel = (level: LodResolvedLevel, isInc: boolean) => {
  const geoId = level.geometry.userData.id as string | undefined;
  if (geoId) (isInc ? incGeometryRef : decGeometryRef)(geoId);
  forEachMaterial(level.material, (m) => {
    const matId = m.userData.id as string | undefined;
    if (matId) (isInc ? incMaterialRef : decMaterialRef)(matId);
  });
};

/** Resolves `def.levels` against the registries. Omitted assets and `castShadow` come from the
 * previous level, level 0's from the mesh. A missing id warns and keeps the previous level's. */
const resolveLevels = (mesh: THREE.Mesh, lod: LodData): LodResolvedLevel[] => {
  const levels = lod.def.levels;
  const label = mesh.userData.id || mesh.uuid;
  if (IS_DEBUG_ENV) {
    for (let i = 1; i < levels.length; i++) {
      if (levels[i].screenSize < levels[i - 1].screenSize) continue;
      lwarn(
        `[LOD] Mesh "${label}": level ${i}'s screenSize (${levels[i].screenSize}) isn't below level ${i - 1}'s (${levels[i - 1].screenSize}). Levels go from level 0 down, screenSize descending.`
      );
    }
  }

  const geometries = getGeometryRegistry();
  const materials = getMaterialRegistry();
  let prev: LodResolvedLevel = {
    geometry: mesh.geometry,
    material: mesh.material,
    castShadow: mesh.castShadow,
  };
  const resolved: LodResolvedLevel[] = [];
  for (let i = 0; i < levels.length; i++) {
    const def = levels[i];
    let geometry = prev.geometry;
    if (def.geo !== undefined) {
      const entry = geometries[def.geo];
      if (entry) geometry = entry.resource;
      else lwarn(`[LOD] Mesh "${label}", level ${i}: no registered geometry "${def.geo}".`);
    }
    let material = prev.material;
    if (def.mat !== undefined) {
      const entry = materials[def.mat];
      if (entry) material = entry.resource;
      else lwarn(`[LOD] Mesh "${label}", level ${i}: no registered material "${def.mat}".`);
    }
    prev = { geometry, material, castShadow: def.castShadow ?? prev.castShadow };
    resolved.push(prev);
  }
  return resolved;
};

/** Pre-warms the levels the mesh doesn't already show (createMeshEntity pre-warmed that one). */
const preWarmLevels = (mesh: THREE.Mesh, levels: LodResolvedLevel[]) => {
  const label = mesh.userData.id || 'mesh';
  const warmed: LodResolvedLevel[] = [
    { geometry: mesh.geometry, material: mesh.material, castShadow: mesh.castShadow },
  ];
  for (const level of levels) {
    const isWarmed = warmed.some(
      (w) =>
        w.geometry === level.geometry &&
        w.material === level.material &&
        w.castShadow === level.castShadow
    );
    if (isWarmed) continue;
    warmed.push(level);
    const standIn = new THREE.Mesh(level.geometry, level.material);
    standIn.castShadow = level.castShadow;
    standIn.receiveShadow = mesh.receiveShadow;
    preWarmMesh(standIn, label);
  }
};

const getLodMesh = (entityId: number, world: ECSWorld) => {
  const obj = world.getComponent(entityId, ComponentType.OBJECT3D)?.value;
  return obj instanceof THREE.Mesh ? obj : undefined;
};

ECSWorld.registerComponentHooks(ComponentType.LOD, {
  onAddComponent: (entityId, world) => {
    const lod = world.getComponent(entityId, ComponentType.LOD);
    if (!lod) return;
    lod.level = -1;
    lod.applied = -1;
    lod._levels = [];
    const mesh = getLodMesh(entityId, world);
    if (!mesh) {
      lwarn(`[LOD] Entity ${entityId} has no mesh: its LOD does nothing.`);
      return;
    }
    if (lod.def.levels.length === 0) {
      lwarn(`[LOD] Mesh "${mesh.userData.id || mesh.uuid}" has a LOD without levels.`);
      return;
    }
    lod._levels = resolveLevels(mesh, lod);
    lod.radius = getConservativeGeometryRadius(lod._levels[0].geometry);
    for (const level of lod._levels) refLevel(level, true);
    if (mesh.userData.preWarm) preWarmLevels(mesh, lod._levels);
  },
  // The entity stays: back to level 0 and visible, then release the levels (the mesh took its
  // own ref on level 0's assets first).
  onRemoveComponent: (entityId, world) => {
    const lod = world.getComponent(entityId, ComponentType.LOD);
    if (!lod) return;
    const mesh = getLodMesh(entityId, world);
    const level0 = lod._levels[0];
    if (mesh && level0 && lod.applied > 0) {
      setMeshGeometry(mesh, level0.geometry);
      setMeshMaterial(mesh, level0.material);
      mesh.castShadow = level0.castShadow;
    }
    if (world.hasComponent(entityId, ComponentType.TAG_LOD_CULLED)) {
      world.removeComponent(entityId, ComponentType.TAG_LOD_CULLED);
    }
    for (const level of lod._levels) refLevel(level, false);
    lod._levels = [];
  },
  onDeleteEntity: (entityId, world) => {
    const lod = world.getComponent(entityId, ComponentType.LOD);
    if (!lod) return;
    for (const level of lod._levels) refLevel(level, false);
    lod._levels = [];
  },
});

// --- SELECTION ---

/**
 * The level for screen size `s`, coming from level `current` (-1 = first selection). The finest
 * level whose screenSize `s` reaches (below all of them, the last level). A move to a finer level
 * happens at its screenSize; a move to a coarser one only once `s` is below the current level's
 * screenSize × (1 - hysteresis).
 */
const selectLevel = (levels: LodData['def']['levels'], s: number, current: number, h: number) => {
  const last = levels.length - 1;
  let raw = last;
  for (let i = 0; i < last; i++) {
    if (s >= levels[i].screenSize) {
      raw = i;
      break;
    }
  }
  if (current < 0 || raw <= current) return raw;
  const f = 1 - h;
  for (let i = current; i < last; i++) {
    if (s >= levels[i].screenSize * f) return i;
  }
  return last;
};

/** Per world: entities whose selected level differs from the applied one, for lodApplySystem. */
const pendingApplies = new WeakMap<ECSWorld, number[]>();

const _camPos = new THREE.Vector3();
const _objPos = new THREE.Vector3();

/**
 * Selects a level per `LOD` entity from its projected screen size (bounding-sphere diameter /
 * viewport height, × its `def.bias` × the global bias), with hysteresis, and adds or removes
 * TAG_LOD_CULLED. Uses the main camera, like frustum culling. Skips DISABLED and frustum-culled
 * entities, which keep their level: frustum culling runs first, so an entity re-entering the
 * view gets a fresh level in the same frame.
 */
export const lodSelectionSystem = (world: ECSWorld) => {
  const storage = world.getStorage(ComponentType.LOD);
  if (storage.size === 0) return;

  const camera = getMainCamera();
  if (!camera) return;

  // Camera terms, once per frame: screen size = worldRadius × k / distance (perspective) or
  // worldRadius × k (orthographic)
  let k: number;
  let isOrtho = false;
  if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
    const cam = camera as THREE.PerspectiveCamera;
    k = cam.zoom / Math.tan(THREE.MathUtils.DEG2RAD * cam.fov * 0.5);
  } else if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
    const cam = camera as THREE.OrthographicCamera;
    k = (2 * cam.zoom) / (cam.top - cam.bottom);
    isOrtho = true;
  } else {
    return;
  }
  k *= getLodBias();
  camera.updateWorldMatrix(true, false);
  _camPos.setFromMatrixPosition(camera.matrixWorld);

  let pending = pendingApplies.get(world);
  if (!pending) {
    pending = [];
    pendingApplies.set(world, pending);
  }
  pending.length = 0;

  for (const [entityId, lod] of storage) {
    const levels = lod.def.levels;
    if (lod._levels.length === 0) continue;
    if (world.isDisabled(entityId)) continue;
    if (world.hasComponent(entityId, ComponentType.TAG_FRUSTUM_CULLED)) continue;
    const obj = world.getComponent(entityId, ComponentType.OBJECT3D)?.value;
    if (!obj) continue;

    // Directly under the scene (the usual case), the local transform object3DSyncSystem wrote is
    // the world one; nested, read the world matrix
    let maxScale: number;
    const parent = obj.parent;
    if (!parent || !parent.parent) {
      _objPos.copy(obj.position);
      const { x, y, z } = obj.scale;
      maxScale = Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
    } else {
      obj.updateWorldMatrix(true, false);
      _objPos.setFromMatrixPosition(obj.matrixWorld);
      maxScale = obj.matrixWorld.getMaxScaleOnAxis();
    }

    const worldRadius = lod.radius * maxScale;
    let s: number;
    if (isOrtho) {
      s = worldRadius * k;
    } else {
      const distance = _objPos.distanceTo(_camPos);
      s = distance > 0 ? (worldRadius * k) / distance : Infinity;
    }
    s *= lod.def.bias ?? 1;

    const h = lod.def.hysteresis ?? DEFAULT_HYSTERESIS;
    const cull = lod.def.cullScreenSize ?? 0;
    const isCulled = world.hasComponent(entityId, ComponentType.TAG_LOD_CULLED);
    if (cull > 0 && s < (isCulled ? cull : cull * (1 - h))) {
      // Hidden: the level holds (no swap while nothing shows it)
      if (!isCulled) world.addComponent(entityId, ComponentType.TAG_LOD_CULLED, true);
      continue;
    }
    if (isCulled) world.removeComponent(entityId, ComponentType.TAG_LOD_CULLED);

    // Coming back from culled, it comes from beyond the last level
    lod.level = selectLevel(levels, s, isCulled ? levels.length - 1 : lod.level, h);
    if (lod.level !== lod.applied) pending.push(entityId);
  }
};

// --- APPLY ---

/** Applies the levels lodSelectionSystem changed this frame: a mesh's geometry, material(s) and
 * `castShadow`. */
export const lodApplySystem = (world: ECSWorld) => {
  const pending = pendingApplies.get(world);
  if (!pending || pending.length === 0) return;

  for (let i = 0; i < pending.length; i++) {
    const entityId = pending[i];
    const lod = world.getComponent(entityId, ComponentType.LOD);
    if (!lod || lod.level < 0 || lod.level === lod.applied) continue;
    const level = lod._levels[lod.level];
    const mesh = getLodMesh(entityId, world);
    if (mesh && level) {
      setMeshGeometry(mesh, level.geometry);
      setMeshMaterial(mesh, level.material);
      mesh.castShadow = level.castShadow;
    }
    lod.applied = lod.level;
  }
  pending.length = 0;
};

ECSWorld.registerPlugin((world) => {
  // Same order: selection runs first (registration order breaks the tie)
  world.addSystem(
    ECSSystemStage.APP_RENDER_SYNC,
    'lodSelectionSystem',
    lodSelectionSystem,
    APP_RENDER_SYNC_ORDER.LOD_SELECTION
  );
  world.addSystem(
    ECSSystemStage.APP_RENDER_SYNC,
    'lodApplySystem',
    lodApplySystem,
    APP_RENDER_SYNC_ORDER.LOD_SELECTION
  );
  return world;
});
