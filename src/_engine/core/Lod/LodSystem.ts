import * as THREE from 'three/webgpu';
import { APP_RENDER_SYNC_ORDER, ECSSystemStage } from '../../../AppECSRegistry';
import { ECSWorld, getECSWorld } from '../ECS';
import { ComponentType } from '../ECS/ECSCoreComponents';
import { reconcileObject3DVisibility } from '../ECS/ECSCoreSystems';
import { getActiveCamera, getMainCamera } from '../CameraManager';
import { getConfig, IS_DEBUG_ENV } from '../Config';
import { decGeometryRef, getGeometryRegistry, incGeometryRef } from '../Geometry';
import { decMaterialRef, getMaterialRegistry, incMaterialRef } from '../Material';
import { preWarmMesh, setMeshGeometry, setMeshMaterial } from '../MeshManager';
import { getConservativeGeometryRadius } from '../Spatial/SpatialIndexSystem';
import { lwarn } from '../../utils/Logger';
import { DebugModuleRef, loadDebugModuleAsync, useDebug } from '../../utils/helpers';
import { getInstancedLodBounds } from './LodBounds';
import type { LodData, LodResolvedLevel, LodTarget } from './LodTypes';

// Debug
type LodDebugModule = typeof import('../Debug/_dbg__LOD');
let debugGUI: DebugModuleRef<LodDebugModule> | null = null;

export const registerLodDebugGUI = async () => {
  debugGUI = await loadDebugModuleAsync(() => import('../Debug/_dbg__LOD'));
  useDebug(debugGUI)?._createLodDebugGUI();
};

// LOD selection and apply (docs/plans/p348_ecs-lod-selection.md). `LOD` is the opt-in definition
// and the selected/applied level; TAG_LOD_CULLED is the runtime state "beyond the last level",
// a fourth cull reason next to DISABLED, TAG_FRUSTUM_CULLED and TAG_OBJECT_CULLED.
//
// Refs: the mesh always holds one ref on the geometry and material it shows (the apply moves it
// with setMeshGeometry/setMeshMaterial), and the LOD component one on every level's. So a level's
// assets live as long as the component, and deleting the entity releases them in any hook order.
//
// An entity without a plain mesh (an instanced LOD pool's instance) gets its levels from a LodTarget
// registered for one of its components, which then applies them and handles LOD culling.
//
// An InstancedMesh entity (a static instance cell, §4.3) is a plain mesh whose swap changes every
// instance: its bounds are level 0 over all its instances (Lod/LodBounds.ts), not one instance.

const DEFAULT_HYSTERESIS = 0.1;

ECSWorld.registerComponentHooks(ComponentType.TAG_LOD_CULLED, {
  onAddComponent: (entityId, world) => {
    reconcileObject3DVisibility(entityId, world, { isLodCulled: true });
    world.getComponent(entityId, ComponentType.LOD)?._target?.setCulled(entityId, world, true);
  },
  onRemoveComponent: (entityId, world) => {
    reconcileObject3DVisibility(entityId, world, { isLodCulled: false });
    world.getComponent(entityId, ComponentType.LOD)?._target?.setCulled(entityId, world, false);
  },
});

// --- TARGETS ---

const lodTargets: { componentType: ComponentType; target: LodTarget }[] = [];

/**
 * Lets `LOD` work on entities with `componentType` that have no plain mesh (eg. the
 * instanced LOD pool). See {@link LodTarget}. Registering a type again replaces its target.
 */
export const registerLodTarget = (componentType: ComponentType, target: LodTarget) => {
  const index = lodTargets.findIndex((e) => e.componentType === componentType);
  if (index >= 0) lodTargets[index].target = target;
  else lodTargets.push({ componentType, target });
};

/** Sets the entity's levels from the first target that has them. False when none does. */
const resolveTargetLevels = (entityId: number, world: ECSWorld, lod: LodData) => {
  for (const { componentType, target } of lodTargets) {
    if (!world.hasComponent(entityId, componentType)) continue;
    const levels = target.resolveLevels(entityId, world, lod);
    if (!levels || levels.length === 0) continue;
    lod._levels = levels;
    lod._target = target;
    lod.radius = getConservativeGeometryRadius(levels[0].geometry);
    return true;
  }
  return false;
};

// --- GLOBAL BIAS ---

let globalBias: number | undefined;

/** The global LOD bias: multiplies every entity's screen size, >1 keeps detail longer. */
export const getLodBias = () => (globalBias ??= getConfig().lod?.bias ?? 1);

/** Sets the global LOD bias (initially `AppConfig.lod.bias`). Takes effect at the next selection. */
export const setLodBias = (bias: number) => {
  globalBias = bias;
};

// --- DEBUG CONTROLS AND STATS ---

/** Overrides of the selection, for inspecting levels (the LOD debug tab). Every world. */
export type LodDebugOptions = {
  /** Stops selecting: every entity keeps its level and LOD-culled state. */
  freeze: boolean;
  /** -1 = off. Otherwise every entity shows this level (or its last, when it has fewer) and none
   * is LOD-culled. Wins over `freeze`. */
  forceLevel: number;
  /** Selects against the active camera (eg. the debug camera) instead of the main camera. */
  useActiveCamera: boolean;
};

const debugOptions: LodDebugOptions = { freeze: false, forceLevel: -1, useActiveCamera: false };

export const getLodDebugOptions = (): Readonly<LodDebugOptions> => debugOptions;

/** Changes the selection's debug overrides ({@link LodDebugOptions}), from the next frame. */
export const setLodDebugOptions = (opts: Partial<LodDebugOptions>) => {
  Object.assign(debugOptions, opts);
};

/** What the LOD systems did in a world's last frame. */
export type LodFrameStats = {
  /** Entities whose level was (re)selected. */
  selections: number;
  /** Level swaps applied. */
  applies: number;
  /** Level swaps applied since the start. */
  totalApplies: number;
  /** lodSelectionSystem's duration. Measured in the debug environment only (else 0). */
  selectionMs: number;
};

const frameStats = new WeakMap<ECSWorld, LodFrameStats>();

const getFrameStats = (world: ECSWorld) => {
  let stats = frameStats.get(world);
  if (!stats) {
    stats = { selections: 0, applies: 0, totalApplies: 0, selectionMs: 0 };
    frameStats.set(world, stats);
  }
  return stats;
};

/** What the LOD systems did in the world's last frame. */
export const getLodFrameStats = (world: ECSWorld): Readonly<LodFrameStats> => getFrameStats(world);

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

/** A mesh that compiles to the pipelines `mesh` would draw `level` with: an InstancedMesh's shares
 * its instance attributes. Never frustum culled, as compileAsync culls against its own camera. */
const createStandIn = (mesh: THREE.Mesh, level: LodResolvedLevel) => {
  let standIn: THREE.Mesh;
  if ((mesh as THREE.InstancedMesh).isInstancedMesh) {
    const instanced = mesh as THREE.InstancedMesh;
    const standInInstanced = new THREE.InstancedMesh(level.geometry, level.material, 0);
    standInInstanced.instanceMatrix = instanced.instanceMatrix;
    standInInstanced.instanceColor = instanced.instanceColor;
    standInInstanced.count = instanced.count;
    standIn = standInInstanced;
  } else {
    standIn = new THREE.Mesh(level.geometry, level.material);
  }
  standIn.castShadow = level.castShadow;
  standIn.receiveShadow = mesh.receiveShadow;
  standIn.frustumCulled = false;
  return standIn;
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
    preWarmMesh(createStandIn(mesh, level), label);
  }
};

const getLodMesh = (entityId: number, world: ECSWorld) => {
  const obj = world.getComponent(entityId, ComponentType.OBJECT3D)?.value;
  return obj instanceof THREE.Mesh ? obj : undefined;
};

/** Sets the LOD's radius (and an InstancedMesh's centre) from level 0. */
const setMeshLodBounds = (mesh: THREE.Mesh, lod: LodData) => {
  const geometry = lod._levels[0].geometry;
  if ((mesh as THREE.InstancedMesh).isInstancedMesh) {
    const bounds = getInstancedLodBounds(mesh as THREE.InstancedMesh, geometry);
    lod.radius = bounds.radius;
    lod._center = bounds.center;
  } else {
    lod.radius = getConservativeGeometryRadius(geometry);
    lod._center = undefined;
  }
};

/**
 * Re-reads an `InstancedMesh` entity's LOD bounds (eg. a static instance cell's) after its instance
 * matrices or `count` changed: they are level 0 at every instance, read when the LOD was added. An
 * `AUTO` LOD's thresholds were computed from the bounds then: after a large change, set the LOD
 * again. A no-op for other entities (their bounds are level 0's geometry) and without a LOD.
 * @param entityId the mesh entity
 * @param ecsWorld the entity's world (default: the default world)
 */
export const refreshLodBounds = (entityId: number, ecsWorld?: ECSWorld) => {
  const world = ecsWorld || getECSWorld();
  const lod = world.getComponent(entityId, ComponentType.LOD);
  const mesh = getLodMesh(entityId, world);
  if (!lod || lod._target || lod._levels.length === 0) return;
  if (!(mesh as THREE.InstancedMesh | undefined)?.isInstancedMesh) return;
  setMeshLodBounds(mesh as THREE.Mesh, lod);
};

ECSWorld.registerComponentHooks(ComponentType.LOD, {
  onAddComponent: (entityId, world) => {
    const lod = world.getComponent(entityId, ComponentType.LOD);
    if (!lod) return;
    lod.level = -1;
    lod.applied = -1;
    lod._levels = [];
    lod._target = undefined;
    lod._center = undefined;
    const mesh = getLodMesh(entityId, world);
    if (!mesh) {
      if (resolveTargetLevels(entityId, world, lod)) return;
      lwarn(`[LOD] Entity ${entityId} has no mesh: its LOD does nothing.`);
      return;
    }
    if (lod.def.levels.length === 0) {
      lwarn(`[LOD] Mesh "${mesh.userData.id || mesh.uuid}" has a LOD without levels.`);
      return;
    }
    lod._levels = resolveLevels(mesh, lod);
    setMeshLodBounds(mesh, lod);
    for (const level of lod._levels) refLevel(level, true);
    if (mesh.userData.preWarm) preWarmLevels(mesh, lod._levels);
  },
  // The entity stays: back to level 0 and visible, then release the levels (the mesh took its
  // own ref on level 0's assets first).
  onRemoveComponent: (entityId, world) => {
    const lod = world.getComponent(entityId, ComponentType.LOD);
    if (!lod) return;
    if (world.hasComponent(entityId, ComponentType.TAG_LOD_CULLED)) {
      world.removeComponent(entityId, ComponentType.TAG_LOD_CULLED);
    }
    const target = lod._target;
    if (target) {
      if (lod.applied > 0) target.applyLevel(entityId, world, 0);
      lod._target = undefined;
      lod._levels = [];
      return;
    }
    const mesh = getLodMesh(entityId, world);
    const level0 = lod._levels[0];
    if (mesh && level0 && lod.applied > 0) {
      setMeshGeometry(mesh, level0.geometry);
      setMeshMaterial(mesh, level0.material);
      mesh.castShadow = level0.castShadow;
    }
    for (const level of lod._levels) refLevel(level, false);
    lod._levels = [];
  },
  onDeleteEntity: (entityId, world) => {
    const lod = world.getComponent(entityId, ComponentType.LOD);
    if (!lod) return;
    if (!lod._target) {
      for (const level of lod._levels) refLevel(level, false);
    }
    lod._levels = [];
    lod._target = undefined;
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

// The camera terms of the frame: screen size = worldRadius × k / distance (perspective) or
// worldRadius × k (orthographic), k including the global bias
let _k = 0;
let _isOrtho = false;

/** Computes the frame's camera terms. False for a camera that is neither perspective nor
 * orthographic. */
const setCameraTerms = (camera: THREE.Camera) => {
  if ((camera as THREE.PerspectiveCamera).isPerspectiveCamera) {
    const cam = camera as THREE.PerspectiveCamera;
    _k = cam.zoom / Math.tan(THREE.MathUtils.DEG2RAD * cam.fov * 0.5);
    _isOrtho = false;
  } else if ((camera as THREE.OrthographicCamera).isOrthographicCamera) {
    const cam = camera as THREE.OrthographicCamera;
    _k = (2 * cam.zoom) / (cam.top - cam.bottom);
    _isOrtho = true;
  } else {
    return false;
  }
  _k *= getLodBias();
  camera.updateWorldMatrix(true, false);
  _camPos.setFromMatrixPosition(camera.matrixWorld);
  return true;
};

/**
 * Selects a level per `LOD` entity from its projected screen size (bounding-sphere diameter /
 * viewport height, × its `def.bias` × the global bias), with hysteresis, and adds or removes
 * TAG_LOD_CULLED. Uses the main camera, like frustum culling. Skips DISABLED and frustum-culled
 * entities, which keep their level: frustum culling runs first, so an entity re-entering the
 * view gets a fresh level in the same frame. {@link setLodDebugOptions} can freeze or force the
 * levels, or select against the active camera.
 */
export const lodSelectionSystem = (world: ECSWorld) => {
  const stats = getFrameStats(world);
  stats.selections = 0;
  stats.selectionMs = 0;

  const storage = world.getStorage(ComponentType.LOD);
  if (storage.size === 0) return;

  const forceLevel = debugOptions.forceLevel;
  const isForced = forceLevel >= 0;
  if (debugOptions.freeze && !isForced) return;
  if (!isForced) {
    const camera = debugOptions.useActiveCamera ? getActiveCamera() : getMainCamera();
    if (!camera || !setCameraTerms(camera)) return;
  }
  const start = IS_DEBUG_ENV ? performance.now() : 0;

  let pending = pendingApplies.get(world);
  if (!pending) {
    pending = [];
    pendingApplies.set(world, pending);
  }
  pending.length = 0;

  // Read once per frame: a world.hasComponent / getComponent per entity looks the storage up again
  // every time, which dominated the loop for a few thousand pool instances
  // (docs/plans/p348_ecs-lod-selection.md, Phase 3 step 4)
  const disabled = world.getStorage(ComponentType.DISABLED);
  const frustumCulled = world.getStorage(ComponentType.TAG_FRUSTUM_CULLED);
  const lodCulled = world.getStorage(ComponentType.TAG_LOD_CULLED);
  const object3Ds = world.getStorage(ComponentType.OBJECT3D);
  const transforms = world.getStorage(ComponentType.TRANSFORM);

  let selections = 0;
  for (const [entityId, lod] of storage) {
    const levels = lod.def.levels;
    if (lod._levels.length === 0) continue;
    if (disabled.has(entityId) || frustumCulled.has(entityId)) continue;
    selections++;

    const isCulled = lodCulled.has(entityId);
    if (isForced) {
      if (isCulled) world.removeComponent(entityId, ComponentType.TAG_LOD_CULLED);
      lod.level = Math.min(forceLevel, levels.length - 1);
      if (lod.level !== lod.applied) pending.push(entityId);
      continue;
    }

    // A target's entity (LodTarget) reads its Transform, which is in world space. A mesh directly
    // under the scene (the usual case) reads the local transform object3DSyncSystem wrote, which is
    // the world one; nested, the world matrix. An InstancedMesh measures from its bounds' centre.
    let maxScale: number;
    if (lod._target) {
      const transform = transforms.get(entityId);
      if (!transform) continue;
      _objPos.copy(transform.position);
      const { x, y, z } = transform.scale;
      maxScale = Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
    } else {
      const obj = object3Ds.get(entityId)?.value;
      if (!obj) continue;
      if (lod._center) {
        obj.updateWorldMatrix(true, false);
        _objPos.copy(lod._center).applyMatrix4(obj.matrixWorld);
        maxScale = obj.matrixWorld.getMaxScaleOnAxis();
      } else if (!obj.parent || !obj.parent.parent) {
        _objPos.copy(obj.position);
        const { x, y, z } = obj.scale;
        maxScale = Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
      } else {
        obj.updateWorldMatrix(true, false);
        _objPos.setFromMatrixPosition(obj.matrixWorld);
        maxScale = obj.matrixWorld.getMaxScaleOnAxis();
      }
    }

    const worldRadius = lod.radius * maxScale;
    let s: number;
    if (_isOrtho) {
      s = worldRadius * _k;
    } else {
      const distance = _objPos.distanceTo(_camPos);
      s = distance > 0 ? (worldRadius * _k) / distance : Infinity;
    }
    s *= lod.def.bias ?? 1;

    const h = lod.def.hysteresis ?? DEFAULT_HYSTERESIS;
    const cull = lod.def.cullScreenSize ?? 0;
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

  stats.selections = selections;
  if (IS_DEBUG_ENV) stats.selectionMs = performance.now() - start;
};

// --- APPLY ---

/** Applies the levels lodSelectionSystem changed this frame: a mesh's geometry, material(s) and
 * `castShadow`, or the entity's {@link LodTarget}. */
export const lodApplySystem = (world: ECSWorld) => {
  const stats = getFrameStats(world);
  stats.applies = 0;
  const pending = pendingApplies.get(world);
  if (!pending || pending.length === 0) return;

  let applies = 0;
  for (let i = 0; i < pending.length; i++) {
    const entityId = pending[i];
    const lod = world.getComponent(entityId, ComponentType.LOD);
    if (!lod || lod.level < 0 || lod.level === lod.applied) continue;
    const level = lod._levels[lod.level];
    if (lod._target) {
      if (level) lod._target.applyLevel(entityId, world, lod.level);
      lod.applied = lod.level;
      applies++;
      continue;
    }
    const mesh = getLodMesh(entityId, world);
    if (mesh && level) {
      setMeshGeometry(mesh, level.geometry);
      setMeshMaterial(mesh, level.material);
      mesh.castShadow = level.castShadow;
    }
    lod.applied = lod.level;
    applies++;
  }
  pending.length = 0;
  stats.applies = applies;
  stats.totalApplies += applies;
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
