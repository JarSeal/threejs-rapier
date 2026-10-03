import * as THREE from 'three/webgpu';
import { getActiveCamera, isDebugCameraActive } from '../../CameraManager';
import { ComponentType } from '../../ECS/ECSCoreComponents';
import { getAllECSWorlds, type ECSWorld } from '../../ECS';
import { getRootScene } from '../../Scene';
import { DEBUG_HELPER_USER_DATA_KEY } from '../../../debug/Profiler';

/**
 * The "in view" census (§2.7): a walk of the root scene that repeats three r186's culling rules
 * (WebGPU `Renderer._projectObject`) against the active camera, because three exposes no
 * per-object culling result. Sampled at the profiler's update rate, never per frame.
 *
 * - An invisible object skips its whole subtree; the layer test only gates the object itself
 *   (its children are still walked), like three.
 * - Drawables (meshes, lines, points, sprites) are in view when one of their materials is
 *   visible and they pass the frustum test (`object.intersectsFrustum`, three's own call).
 *   Lights and cameras are never culled: in view = shown.
 * - Totals count everything in the root scene, hidden objects included.
 * - Every counted object goes into one kind bucket and one owner bucket (the nearest entity
 *   above it, by its MANAGED_BY / PERSISTENT components), so both breakdowns add up to the same
 *   totals.
 *
 * Viewport scenes (axes gizmo, env ball) and the sky box's bake scenes are not in the root
 * scene: they appear in the drawn counters (`info.render`) only.
 */

export const CENSUS_KINDS = [
  'MESH',
  'INSTANCED_MESH',
  'BATCHED_MESH',
  'SKINNED_MESH',
  'LINES',
  'POINTS',
  'SPRITES',
  'LIGHTS',
  'CAMERAS',
  'DEBUG_HELPERS',
] as const;
export type CensusKind = (typeof CENSUS_KINDS)[number];

/** The mesh kinds: their primitives are triangles. */
const MESH_KINDS: readonly CensusKind[] = [
  'MESH',
  'INSTANCED_MESH',
  'BATCHED_MESH',
  'SKINNED_MESH',
];

export type InViewTotal = { inView: number; total: number };

export type CensusBucket = {
  objects: InViewTotal;
  /** Drawn instances: an InstancedMesh's `count`, a BatchedMesh's visible instances, else 1. */
  instances: InViewTotal;
  /** Triangles for the mesh kinds, segments for lines, points for points, quads for sprites,
   * 0 for lights and cameras. Debug helpers mix them. Instances included. */
  primitives: InViewTotal;
  /** The primitives of mesh-kind objects only (the same as `primitives` for a mesh kind, a part
   * of it for the debug helpers and the owners, 0 for the other kinds). */
  triangles: InViewTotal;
  /** Vertices of the drawn range, instances included (a sprite is 4, a line segment 2). */
  vertices: InViewTotal;
};

/** Who an object belongs to: the nearest ECS entity whose OBJECT3D is the object or an ancestor
 * of it. */
export type CensusOwnerKey =
  | 'SCENE'
  | 'PERSISTENT'
  | `MANAGED:${string}`
  | 'NON_ECS'
  | 'DEBUG_HELPERS';

export type CensusOwner = { key: CensusOwnerKey; label: string; bucket: CensusBucket };

/** One of the heaviest objects in view (mesh kinds, debug helpers left out). Holds no scene
 * graph reference. */
export type CensusHeavyObject = {
  /** The object's name, or its three type. */
  name: string;
  /** The owning entity's debug name or app id, or ''. */
  entityName: string;
  kind: CensusKind;
  /** Triangles in view, instances included. */
  triangles: number;
  instances: number;
  /** The owning entity (the nearest one above the object), or -1. */
  entityId: number;
  /** The owning entity's world id, or ''. */
  worldId: string;
};

/** How many heaviest objects the census keeps. */
export const CENSUS_HEAVY_OBJECT_COUNT = 10;

export type SceneCensus = {
  kinds: Record<CensusKind, CensusBucket>;
  /** The same objects as `kinds`, by owner: Scene, Persistent, one per manager, Non-ECS, Debug
   * helpers (in this order, only the owners with objects). */
  owners: readonly CensusOwner[];
  /** The heaviest objects in view by triangles, heaviest first. */
  heaviest: readonly CensusHeavyObject[];
  /** The mesh kinds summed. */
  meshes: CensusBucket;
  /** Shown lights (they pass the visibility and layer tests). */
  lights: {
    count: number;
    shadowCasters: number;
    /** Extra scene passes for shadows: 6 per point light, 1 per other caster. */
    shadowPasses: number;
  };
  /** ECS entities with an OBJECT3D whose object (or a descendant) was drawn in view, and every
   * entity over all worlds. */
  entities: InViewTotal;
  worlds: number;
  /** Counted against the debug camera, not the main camera. */
  isDebugCamera: boolean;
  /** A BatchedMesh was counted whole (its per-instance culling isn't repeated). */
  isApprox: boolean;
  /** Debug helpers went into `kinds.DEBUG_HELPERS` instead of their own kinds. */
  excludesDebugHelpers: boolean;
  /** How long the walk took. */
  sampleMs: number;
  /** `performance.now()` of the walk. */
  sampledAt: number;
};

const createInViewTotal = (): InViewTotal => ({ inView: 0, total: 0 });
const createBucket = (): CensusBucket => ({
  objects: createInViewTotal(),
  instances: createInViewTotal(),
  primitives: createInViewTotal(),
  triangles: createInViewTotal(),
  vertices: createInViewTotal(),
});

const resetBucket = (bucket: CensusBucket) => {
  bucket.objects.inView = bucket.objects.total = 0;
  bucket.instances.inView = bucket.instances.total = 0;
  bucket.primitives.inView = bucket.primitives.total = 0;
  bucket.triangles.inView = bucket.triangles.total = 0;
  bucket.vertices.inView = bucket.vertices.total = 0;
};

const addBucket = (target: CensusBucket, source: CensusBucket) => {
  target.objects.inView += source.objects.inView;
  target.objects.total += source.objects.total;
  target.instances.inView += source.instances.inView;
  target.instances.total += source.instances.total;
  target.primitives.inView += source.primitives.inView;
  target.primitives.total += source.primitives.total;
  target.triangles.inView += source.triangles.inView;
  target.triangles.total += source.triangles.total;
  target.vertices.inView += source.vertices.inView;
  target.vertices.total += source.vertices.total;
};

/** Adds the `measured` drawable to a bucket. */
const addMeasured = (bucket: CensusBucket, isInView: boolean, isMeshKind: boolean) => {
  const triangles = isMeshKind ? measured.primitives : 0;
  bucket.objects.total++;
  bucket.instances.total += measured.instances;
  bucket.primitives.total += measured.primitives;
  bucket.triangles.total += triangles;
  bucket.vertices.total += measured.vertices;
  if (!isInView) return;
  bucket.objects.inView++;
  bucket.instances.inView += measured.instances;
  bucket.primitives.inView += measured.primitives;
  bucket.triangles.inView += triangles;
  bucket.vertices.inView += measured.vertices;
};

// --- OWNERS ---

const OWNER_LABELS: Record<'SCENE' | 'PERSISTENT' | 'NON_ECS' | 'DEBUG_HELPERS', string> = {
  SCENE: 'Scene entities',
  PERSISTENT: 'Persistent entities',
  NON_ECS: 'Non-ECS objects',
  DEBUG_HELPERS: 'Debug helpers',
};

/** Every owner seen so far, kept (and reset) across samples so a manager's bucket is reused. */
const ownerBuckets = new Map<CensusOwnerKey, CensusOwner>();

const getOwner = (key: CensusOwnerKey): CensusOwner => {
  let owner = ownerBuckets.get(key);
  if (!owner) {
    const label = key.startsWith('MANAGED:')
      ? `Managed: ${key.slice(8)}`
      : OWNER_LABELS[key as keyof typeof OWNER_LABELS];
    owner = { key, label, bucket: createBucket() };
    ownerBuckets.set(key, owner);
  }
  return owner;
};

/** The owners in their display order: Scene, Persistent, managers (by name), Non-ECS, helpers. */
const getOwnerOrder = (key: CensusOwnerKey) => {
  if (key === 'SCENE') return 0;
  if (key === 'PERSISTENT') return 1;
  if (key === 'NON_ECS') return 3;
  if (key === 'DEBUG_HELPERS') return 4;
  return 2;
};

const shownOwners: CensusOwner[] = [];

// --- HEAVIEST OBJECTS ---

const heavySlots: CensusHeavyObject[] = Array.from({ length: CENSUS_HEAVY_OBJECT_COUNT }, () => ({
  name: '',
  entityName: '',
  kind: 'MESH',
  triangles: 0,
  instances: 0,
  entityId: -1,
  worldId: '',
}));
const heaviest: CensusHeavyObject[] = [];

const census: SceneCensus = {
  kinds: Object.fromEntries(CENSUS_KINDS.map((kind) => [kind, createBucket()])) as Record<
    CensusKind,
    CensusBucket
  >,
  owners: shownOwners,
  heaviest,
  meshes: createBucket(),
  lights: { count: 0, shadowCasters: 0, shadowPasses: 0 },
  entities: createInViewTotal(),
  worlds: 0,
  isDebugCamera: false,
  isApprox: false,
  excludesDebugHelpers: true,
  sampleMs: 0,
  sampledAt: -Infinity,
};

// --- WALK STATE (module-level, so the recursion allocates nothing) ---

const frustum = new THREE.Frustum();
let frustumArray: THREE.FrustumArray | null = null;
const projScreenMatrix = new THREE.Matrix4();
let walkCamera: THREE.Camera | null = null;
let walkFrustum: THREE.Frustum | THREE.FrustumArray = frustum;
let walkExcludesHelpers = true;
/** Objects drawn in view, or with a descendant that was (the entity count reads it). */
const inViewObjects = new Set<THREE.Object3D>();

/** The OBJECT3D of every entity in every world, built before each walk: its index in the
 * entity arrays below. */
const entityObjects = new Map<THREE.Object3D, number>();
const entityIds: number[] = [];
const entityWorlds: ECSWorld[] = [];
const entityOwners: CensusOwner[] = [];
/** `MANAGED:<manager>` owner keys by manager, so a sample doesn't build the strings again. */
const managerKeys = new Map<string, CensusOwnerKey>();

/** One drawable's figures, filled by `measureDrawable`. */
const measured = { instances: 0, primitives: 0, vertices: 0 };

type BatchedInternals = {
  _instanceInfo: { active: boolean; visible: boolean; geometryIndex: number }[];
  _geometryInfo: { vertexCount: number; indexCount: number }[];
};

type CensusObject = THREE.Object3D & {
  isMesh?: boolean;
  isInstancedMesh?: boolean;
  isBatchedMesh?: boolean;
  isSkinnedMesh?: boolean;
  isFatLineSegments?: boolean;
  isLineSegments2?: boolean;
  isLine?: boolean;
  isLineSegments?: boolean;
  isPoints?: boolean;
  isSprite?: boolean;
  isLight?: boolean;
  isCamera?: boolean;
  count?: number;
  geometry?: THREE.BufferGeometry;
  material?: THREE.Material | THREE.Material[];
};

const isDebugHelper = (obj: THREE.Object3D) =>
  Boolean(obj.userData[DEBUG_HELPER_USER_DATA_KEY]) ||
  Boolean(obj.userData.isHelperSymbol) ||
  obj.type.endsWith('Helper');

const getKind = (obj: CensusObject): CensusKind | null => {
  if (obj.isMesh) {
    // The FAT line backend (and three's Line2) draw lines as instanced quads
    if (obj.isFatLineSegments || obj.isLineSegments2) return 'LINES';
    if (obj.isInstancedMesh) return 'INSTANCED_MESH';
    if (obj.isBatchedMesh) return 'BATCHED_MESH';
    if (obj.isSkinnedMesh) return 'SKINNED_MESH';
    return 'MESH';
  }
  if (obj.isLine) return 'LINES';
  if (obj.isPoints) return 'POINTS';
  if (obj.isSprite) return 'SPRITES';
  if (obj.isLight) return 'LIGHTS';
  if (obj.isCamera) return 'CAMERAS';
  return null;
};

const isMaterialVisible = (material: CensusObject['material']) => {
  if (!material) return false;
  if (!Array.isArray(material)) return material.visible;
  for (let i = 0; i < material.length; i++) if (material[i].visible) return true;
  return false;
};

/** The drawn index or vertex range of a geometry (its `drawRange`), three's item count. */
const getDrawnItems = (geometry: THREE.BufferGeometry) => {
  const itemCount = geometry.index
    ? geometry.index.count
    : geometry.attributes.position?.count || 0;
  const { start, count } = geometry.drawRange;
  const first = Math.max(start, 0);
  const last = Math.min(start + count, itemCount);
  return last > first ? last - first : 0;
};

/** three's draw instance count (RenderObject.getDrawParameters). */
const getInstanceCount = (obj: CensusObject, geometry: THREE.BufferGeometry) => {
  const n = (geometry as THREE.InstancedBufferGeometry).isInstancedBufferGeometry
    ? (geometry as THREE.InstancedBufferGeometry).instanceCount
    : obj.count !== undefined
      ? Math.max(0, obj.count)
      : 1;
  return Number.isFinite(n) ? n : 1;
};

const measureBatched = (obj: CensusObject) => {
  const { _instanceInfo: instances, _geometryInfo: geometries } =
    obj as unknown as BatchedInternals;
  const isIndexed = Boolean(obj.geometry?.index);
  for (let i = 0; i < instances.length; i++) {
    const instance = instances[i];
    if (!instance.active || !instance.visible) continue;
    const info = geometries[instance.geometryIndex];
    if (!info) continue;
    measured.instances++;
    measured.primitives += Math.floor((isIndexed ? info.indexCount : info.vertexCount) / 3);
    measured.vertices += info.vertexCount;
  }
};

/** Fills `measured` for one drawable of a kind. */
const measureDrawable = (obj: CensusObject, kind: CensusKind) => {
  measured.instances = 0;
  measured.primitives = 0;
  measured.vertices = 0;
  if (kind === 'LIGHTS' || kind === 'CAMERAS') return;
  if (kind === 'SPRITES') {
    measured.instances = 1;
    measured.primitives = 1;
    measured.vertices = 4;
    return;
  }
  const geometry = obj.geometry;
  if (!geometry) return;
  if (kind === 'BATCHED_MESH') {
    measureBatched(obj);
    census.isApprox = true;
    return;
  }
  const instances = getInstanceCount(obj, geometry);
  if (obj.isFatLineSegments || obj.isLineSegments2) {
    // One instance per segment
    measured.instances = 1;
    measured.primitives = instances;
    measured.vertices = instances * 2;
    return;
  }
  const items = getDrawnItems(geometry);
  let perInstance: number;
  if (obj.isLineSegments) perInstance = Math.floor(items / 2);
  else if (obj.isLine) perInstance = Math.max(0, items - 1);
  else if (obj.isPoints) perInstance = items;
  else perInstance = Math.floor(items / 3);
  measured.instances = instances;
  measured.primitives = perInstance * instances;
  measured.vertices = (geometry.attributes.position?.count || 0) * instances;
};

const countLight = (light: THREE.Light & { shadow?: THREE.LightShadow }) => {
  census.lights.count++;
  if (!light.castShadow || !light.shadow) return;
  census.lights.shadowCasters++;
  census.lights.shadowPasses += (light as THREE.PointLight).isPointLight ? 6 : 1;
};

/** Keeps an in-view mesh among the heaviest (by the `measured` triangles), heaviest first. */
const considerHeavy = (obj: CensusObject, kind: CensusKind, entityIndex: number) => {
  const triangles = measured.primitives;
  const count = heaviest.length;
  if (!triangles) return;
  if (count === CENSUS_HEAVY_OBJECT_COUNT && triangles <= heaviest[count - 1].triangles) return;
  // The slots fill in order before any is reused, so a free one is the next one
  const slot =
    count < CENSUS_HEAVY_OBJECT_COUNT ? heavySlots[count] : (heaviest.pop() as CensusHeavyObject);
  slot.name = obj.name || obj.type;
  slot.kind = kind;
  slot.triangles = triangles;
  slot.instances = measured.instances;
  slot.entityId = entityIndex === -1 ? -1 : entityIds[entityIndex];
  slot.worldId = entityIndex === -1 ? '' : entityWorlds[entityIndex].id;
  let i = heaviest.length;
  while (i > 0 && heaviest[i - 1].triangles < triangles) i--;
  heaviest.splice(i, 0, slot);
};

/**
 * Counts one object and walks its children.
 * @param parentShown every ancestor is visible
 * @param parentInHelper an ancestor is a debug helper (and helpers are excluded)
 * @param parentEntity the index of the nearest entity above (see `entityObjects`), or -1
 * @returns whether the object or a descendant was drawn in view
 */
const visit = (
  object: THREE.Object3D,
  parentShown: boolean,
  parentInHelper: boolean,
  parentEntity: number
): boolean => {
  const obj = object as CensusObject;
  const isShown = parentShown && obj.visible;
  const isInHelper = parentInHelper || (walkExcludesHelpers && isDebugHelper(obj));
  const entityIndex = entityObjects.get(obj) ?? parentEntity;
  let isAnyInView = false;

  const kind = getKind(obj);
  if (kind) {
    const isRendered = isShown && obj.layers.test((walkCamera as THREE.Camera).layers);
    let isInView = isRendered;
    if (isRendered && kind !== 'LIGHTS' && kind !== 'CAMERAS') {
      isInView =
        isMaterialVisible(obj.material) &&
        (!obj.frustumCulled || (obj as THREE.Mesh).intersectsFrustum(walkFrustum as THREE.Frustum));
    }
    measureDrawable(obj, kind);
    const isMeshKind = MESH_KINDS.includes(kind);
    addMeasured(census.kinds[isInHelper ? 'DEBUG_HELPERS' : kind], isInView, isMeshKind);
    const owner = isInHelper
      ? getOwner('DEBUG_HELPERS')
      : entityIndex === -1
        ? getOwner('NON_ECS')
        : entityOwners[entityIndex];
    addMeasured(owner.bucket, isInView, isMeshKind);
    if (isInView) {
      if (kind === 'LIGHTS' && !isInHelper) countLight(obj as unknown as THREE.Light);
      // A drawable, not a light or camera, makes its entity "in view"
      else if (kind !== 'CAMERAS' && kind !== 'LIGHTS') isAnyInView = true;
      if (isMeshKind && !isInHelper) considerHeavy(obj, kind, entityIndex);
    }
  }

  const children = obj.children;
  for (let i = 0; i < children.length; i++) {
    if (visit(children[i], isShown, isInHelper, entityIndex)) isAnyInView = true;
  }
  if (isAnyInView) inViewObjects.add(obj);
  return isAnyInView;
};

/** Fills `entityObjects` and the entity arrays from every world's OBJECT3D storage. */
const collectEntityObjects = (worlds: readonly ECSWorld[]) => {
  let index = 0;
  for (let w = 0; w < worlds.length; w++) {
    const world = worlds[w];
    for (const [entityId, obj] of world.getStorage(ComponentType.OBJECT3D)) {
      // An object shared by two entities belongs to the first one
      if (entityObjects.has(obj.value)) continue;
      let key: CensusOwnerKey = 'SCENE';
      const managedBy = world.getComponent(entityId, ComponentType.MANAGED_BY);
      if (managedBy) {
        let managerKey = managerKeys.get(managedBy.manager);
        if (!managerKey) {
          managerKey = `MANAGED:${managedBy.manager}`;
          managerKeys.set(managedBy.manager, managerKey);
        }
        key = managerKey;
      } else if (world.hasComponent(entityId, ComponentType.PERSISTENT)) {
        key = 'PERSISTENT';
      }
      entityObjects.set(obj.value, index);
      entityIds[index] = entityId;
      entityWorlds[index] = world;
      entityOwners[index] = getOwner(key);
      index++;
    }
  }
  entityIds.length = entityWorlds.length = entityOwners.length = index;
};

const clearEntityObjects = () => {
  entityObjects.clear();
  entityIds.length = entityWorlds.length = entityOwners.length = 0;
};

/** Names the heaviest objects' entities (only the kept ones, after the walk). */
const nameHeavyEntities = (worlds: readonly ECSWorld[]) => {
  for (let i = 0; i < heaviest.length; i++) {
    const entry = heaviest[i];
    entry.entityName = '';
    if (entry.entityId === -1) continue;
    let world: ECSWorld | null = null;
    for (let w = 0; w < worlds.length && !world; w++) {
      if (worlds[w].id === entry.worldId) world = worlds[w];
    }
    if (!world) continue;
    entry.entityName =
      world.getComponent(entry.entityId, ComponentType.DEBUG_DATA)?.name ||
      world.getComponent(entry.entityId, ComponentType.APP_ID)?.id ||
      `[${entry.entityId}]`;
  }
};

/** The owners with objects, in display order. */
const collectShownOwners = () => {
  shownOwners.length = 0;
  for (const owner of ownerBuckets.values()) {
    if (owner.bucket.objects.total) shownOwners.push(owner);
  }
  shownOwners.sort(
    (a, b) => getOwnerOrder(a.key) - getOwnerOrder(b.key) || a.label.localeCompare(b.label)
  );
};

const countEntities = (worlds: readonly ECSWorld[]) => {
  census.worlds = worlds.length;
  census.entities.total = 0;
  census.entities.inView = 0;
  for (let i = 0; i < worlds.length; i++) {
    const world = worlds[i];
    census.entities.total += world.getEntityCount();
    if (!inViewObjects.size) continue;
    for (const [, obj] of world.getStorage(ComponentType.OBJECT3D)) {
      if (inViewObjects.has(obj.value)) census.entities.inView++;
    }
  }
};

/** Why a census can't be taken right now, or true. */
export const getCensusAvailability = (): true | string => {
  if (!getRootScene()) return 'no root scene';
  return getActiveCamera() ? true : 'no active camera';
};

/**
 * Walks the root scene against the active camera.
 * @param excludeDebugHelpers (boolean) debug helpers go into their own bucket
 * @returns the same {@link SceneCensus} object on every call, or null without a scene or camera
 */
export const runSceneCensus = (excludeDebugHelpers: boolean): Readonly<SceneCensus> | null => {
  const scene = getRootScene();
  const camera = getActiveCamera();
  if (!scene || !camera) return null;
  const startedAt = performance.now();

  for (let i = 0; i < CENSUS_KINDS.length; i++) resetBucket(census.kinds[CENSUS_KINDS[i]]);
  resetBucket(census.meshes);
  for (const owner of ownerBuckets.values()) resetBucket(owner.bucket);
  heaviest.length = 0;
  census.lights.count = census.lights.shadowCasters = census.lights.shadowPasses = 0;
  census.isApprox = false;
  census.excludesDebugHelpers = excludeDebugHelpers;
  census.isDebugCamera = isDebugCameraActive();

  // The camera's matrices are the last render's (the renderer updates them)
  if ((camera as THREE.ArrayCamera).isArrayCamera) {
    frustumArray ||= new THREE.FrustumArray();
    frustumArray.setFromArrayCamera(camera as THREE.ArrayCamera);
    walkFrustum = frustumArray;
  } else {
    projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(
      projScreenMatrix,
      camera.coordinateSystem,
      camera.reversedDepth
    );
    walkFrustum = frustum;
  }
  walkCamera = camera;
  walkExcludesHelpers = excludeDebugHelpers;
  inViewObjects.clear();
  const worlds = getAllECSWorlds();
  collectEntityObjects(worlds);

  visit(scene, true, false, -1);

  for (let i = 0; i < MESH_KINDS.length; i++) addBucket(census.meshes, census.kinds[MESH_KINDS[i]]);
  countEntities(worlds);
  collectShownOwners();
  nameHeavyEntities(worlds);

  // Don't keep the scene graph (or the worlds) alive between samples
  inViewObjects.clear();
  clearEntityObjects();
  walkCamera = null;

  census.sampledAt = performance.now();
  census.sampleMs = census.sampledAt - startedAt;
  return census;
};
