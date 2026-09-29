import * as THREE from 'three/webgpu';
import { CMP, type TCMP } from '../../utils/CMP';
import {
  DEBUG_TOASTER_ID,
  type DebuggerPaneItem,
  type DebuggerPaneSection,
} from '../../debug/DebuggerGUI';
import { _buildDebuggerPane, type BuiltDebuggerPane } from './_dbg__DebuggerPaneBuilder';
import {
  closeDraggableWindow,
  getDraggableWindow,
  openDraggableWindow,
  registerDraggableWindowContentFn,
} from '../UI/DraggableWindow';
import { getSvgIcon } from '../UI/icons/SvgIcon';
import { addToast } from '../UI/Toaster';
import { getCurrentScene, getRootScene } from '../Scene';
import { getActiveCamera } from '../CameraManager';
import { getECSWorld, getEntityIdByAppId } from '../ECS';
import { CoreComponentType } from '../ECS/ECSRegistry';
import { castRayFromDirection, castRayFromPoints, type RayCastOpts } from '../Raycast';
import { getPhysicsWorld, isPhysicsWorldEnabled } from '../PhysicsAPI';
import {
  QueryFilterFlags,
  type ColliderAPI,
  type PhysRay,
  type PhysVector,
  type RigidBodyAPI,
} from '../Physics/PhysicsAPITypes';
import { RAY_TESTER_ID_PREFIX, type RayDebugOpts, type RayHelperKind } from '../RayDebugTypes';
import { getRayHelperSettings } from './_dbg__RayHelpers';
import { _setRayHelpersShown } from './_dbg__Raycast';

/**
 * Ray tester windows (p143), opened from the Ray cast controls tab: configure a ray, fire it
 * into the current scene through the same code paths gameplay uses, see it as a debug helper
 * and read the hits. One window per ray kind: Three.js rays (Raycast.ts) and physics rays (the
 * WorldAPI queries, in either workerTarget mode).
 *
 * The state holds a list of rays and Fire casts all of them (results per ray), but the window
 * edits and shows only `rays[activeIndex]`, so multi-ray patterns are a UI-only addition later.
 *
 * Tester rays are never counted in the ray statistics: Three.js rays pass `countInStats: false`,
 * and physics queries are skipped by their helper id prefix (RAY_TESTER_ID_PREFIX).
 */

type AnyState = Record<string, unknown>;

type Vec3 = { x: number; y: number; z: number };

/** DIRECTION: origin + dir (normalized on fire). TARGET_POINT: origin → point. CAMERA_FORWARD:
 * origin and dir are taken from the active camera at fire time. Every mode keeps its own
 * values, so switching modes loses nothing. */
type RayAimMode = 'DIRECTION' | 'TARGET_POINT' | 'CAMERA_FORWARD';
type RayAim = { mode: RayAimMode; dir: Vec3; point: Vec3 };
/** The part of the ray params every kind has */
type AimedRay = { origin: Vec3; aim: RayAim };

/** KIND follows the kind's "Respect depth" setting (Ray cast controls tab) */
type RayTesterDepthTest = 'KIND' | 'ON' | 'OFF';

type RayTesterHelperParams = {
  color: string;
  inactiveColor: string;
  width: number;
  holdMs: number;
  depthTest: RayTesterDepthTest;
};

type ThreeRayTargetType = 'CURRENT_SCENE' | 'ENTITY';

type ThreeRayParams = AimedRay & {
  near: number;
  far: number;
  recursive: boolean;
  target: { type: ThreeRayTargetType; appId: string };
  helper: RayTesterHelperParams;
};

type PhysicsRayQuery = 'CAST_RAY' | 'CAST_RAY_AND_GET_NORMAL' | 'INTERSECTIONS_WITH_RAY';

/** One checkbox per QueryFilterFlags bit (the ONLY_* flags are combinations of these) */
type PhysicsRayFilterFlags = {
  excludeFixed: boolean;
  excludeKinematic: boolean;
  excludeDynamic: boolean;
  excludeSensors: boolean;
  excludeSolids: boolean;
};

type PhysicsRayParams = AimedRay & {
  query: PhysicsRayQuery;
  maxToi: number;
  solid: boolean;
  filterFlags: PhysicsRayFilterFlags;
  useFilterGroups: boolean;
  filterGroups: number;
  /** An entity whose rigid body (or single collider) the ray ignores, empty for none */
  excludeAppId: string;
  helper: RayTesterHelperParams;
};

type RayTesterState<P> = { version: 1; rays: P[]; activeIndex: number };

/** The entity a hit resolved to, as plain data */
type HitEntityInfo = {
  entityId: number | null;
  appId: string | null;
  /** False for generated app ids, which change on every reload */
  appIdIsFixed: boolean;
};

/** One hit as plain data (no object references), ready to show and to copy as JSON */
type ThreeHitRow = HitEntityInfo & {
  distance: number;
  point: Vec3;
  /** Face normal in world space */
  normal: Vec3 | null;
  objectName: string;
  objectType: string;
  instanceId: number | null;
};

type PhysicsHitRow = HitEntityInfo & {
  /** Time of impact: the distance, as the tester's ray direction is normalized */
  toi: number;
  point: Vec3;
  /** Null for CAST_RAY, which returns no normal */
  normal: Vec3 | null;
  colliderId: number;
  bodyId: number | null;
};

type RayTesterResult<H> = {
  error?: string;
  /** The ray as cast (null when its aim couldn't be resolved) */
  ray: { origin: Vec3; dir: Vec3 } | null;
  hits: H[];
};

type RayTesterKind = RayHelperKind;

const WINDOW_IDS: Record<RayTesterKind, string> = {
  THREE: 'debugRayTesterThree',
  PHYSICS: 'debugRayTesterPhysics',
};
const WINDOW_TITLES: Record<RayTesterKind, string> = {
  THREE: 'Three.js ray tester',
  PHYSICS: 'Physics ray tester',
};

const MAX_LISTED_HITS = 20;

const AIM_MODE_OPTIONS: { value: RayAimMode; text: string }[] = [
  { value: 'DIRECTION', text: 'Origin + direction' },
  { value: 'TARGET_POINT', text: 'Origin → target point' },
  { value: 'CAMERA_FORWARD', text: 'Active camera forward' },
];
const DEPTH_TEST_OPTIONS: { value: RayTesterDepthTest; text: string }[] = [
  { value: 'KIND', text: 'Tab setting' },
  { value: 'ON', text: 'On' },
  { value: 'OFF', text: 'Off' },
];
const THREE_TARGET_OPTIONS: { value: ThreeRayTargetType; text: string }[] = [
  { value: 'CURRENT_SCENE', text: 'Current scene' },
  { value: 'ENTITY', text: 'Entity (app id)' },
];
const PHYSICS_QUERY_OPTIONS: { value: PhysicsRayQuery; text: string }[] = [
  { value: 'CAST_RAY', text: 'castRay' },
  { value: 'CAST_RAY_AND_GET_NORMAL', text: 'castRayAndGetNormal' },
  { value: 'INTERSECTIONS_WITH_RAY', text: 'intersectionsWithRay' },
];
const FILTER_FLAG_BITS: Record<keyof PhysicsRayFilterFlags, QueryFilterFlags> = {
  excludeFixed: QueryFilterFlags.EXCLUDE_FIXED,
  excludeKinematic: QueryFilterFlags.EXCLUDE_KINEMATIC,
  excludeDynamic: QueryFilterFlags.EXCLUDE_DYNAMIC,
  excludeSensors: QueryFilterFlags.EXCLUDE_SENSORS,
  excludeSolids: QueryFilterFlags.EXCLUDE_SOLIDS,
};
const FILTER_FLAG_KEYS = Object.keys(FILTER_FLAG_BITS) as (keyof PhysicsRayFilterFlags)[];
/** Every membership and filter bit: interacts with every group */
const ALL_INTERACTION_GROUPS = 0xffffffff;

// Defaults: straight down from above the origin. Apart from the kinds' default helper colors,
// so tester rays stand out from gameplay rays.
const createAim = (): AimedRay => ({
  origin: { x: 0, y: 5, z: 0 },
  aim: { mode: 'DIRECTION', dir: { x: 0, y: -1, z: 0 }, point: { x: 0, y: 0, z: 0 } },
});

const createHelperParams = (color: string, inactiveColor: string): RayTesterHelperParams => ({
  color,
  inactiveColor,
  width: 4,
  holdMs: 3000,
  depthTest: 'KIND',
});

const createThreeRayParams = (): ThreeRayParams => ({
  ...createAim(),
  near: 0,
  far: 100,
  recursive: true,
  target: { type: 'CURRENT_SCENE', appId: '' },
  helper: createHelperParams('#ffd60a', '#7a6a1f'),
});

const createPhysicsRayParams = (): PhysicsRayParams => ({
  ...createAim(),
  query: 'CAST_RAY_AND_GET_NORMAL',
  maxToi: 100,
  solid: true,
  filterFlags: {
    excludeFixed: false,
    excludeKinematic: false,
    excludeDynamic: false,
    excludeSensors: false,
    excludeSolids: false,
  },
  useFilterGroups: false,
  filterGroups: ALL_INTERACTION_GROUPS,
  excludeAppId: '',
  helper: createHelperParams('#bf5af2', '#5b2d73'),
});

const createState = <P>(createParams: () => P): RayTesterState<P> => ({
  version: 1,
  rays: [createParams()],
  activeIndex: 0,
});

let threeState: RayTesterState<ThreeRayParams> | null = null;
let physicsState: RayTesterState<PhysicsRayParams> | null = null;
const getThreeState = () => (threeState ??= createState(createThreeRayParams));
const getPhysicsState = () => (physicsState ??= createState(createPhysicsRayParams));

/** The last fire's results (not persisted) */
let threeResults: RayTesterResult<ThreeHitRow>[] | null = null;
let physicsResults: RayTesterResult<PhysicsHitRow>[] | null = null;
/** True while the physics queries are in flight (≥1 frame in WORKER_THREAD mode) */
let isPhysicsFiring = false;

/** The mounted views (stale while a window is closed: they are only written to) */
const resultsViews: Partial<Record<RayTesterKind, TCMP>> = {};
const helperNotices: Partial<Record<RayTesterKind, TCMP>> = {};
const paneRefreshers: Partial<Record<RayTesterKind, () => void>> = {};

// ----------------------------------------------------------------------------
// Windows
// ----------------------------------------------------------------------------

/** Opens the kind's tester window, or closes it when it is open. */
export const _toggleRayTesterWindow = (kind: RayTesterKind) => {
  const id = WINDOW_IDS[kind];
  if (getDraggableWindow(id)?.isOpen) {
    closeDraggableWindow(id);
    return;
  }
  openDraggableWindow({
    id,
    title: WINDOW_TITLES[kind],
    isDebugWindow: true,
    saveToLS: true,
    position: kind === 'THREE' ? { x: 120, y: 80 } : { x: 160, y: 110 },
    size: { w: 380, h: 640 },
    content: CONTENT_FNS[kind],
  });
};

/** Shows or hides the "helpers are off" notices of the mounted tester windows. The Ray cast
 * controls tab calls it whenever a kind's helper settings change. */
export const _refreshRayTesterHelperNotices = () => {
  syncHelperNotice('THREE');
  syncHelperNotice('PHYSICS');
};

const syncHelperNotice = (kind: RayTesterKind) => {
  helperNotices[kind]?.updateStyle({ display: getRayHelperSettings(kind).show ? 'none' : '' });
};

/** A tester ray is only drawn while its kind's helpers are shown (the tab's "Show helpers"). */
const createHelperNotice = (kind: RayTesterKind) => {
  const kindName = kind === 'THREE' ? 'Three.js' : 'Physics';
  const notice = CMP({ class: ['winPaddedContent', 'rayTesterNotice'] });
  notice.add({
    tag: 'span',
    text: `${kindName} ray helpers are off, so fired rays aren't drawn.`,
  });
  notice.add({
    tag: 'button',
    text: 'Show helpers',
    onClick: () => _setRayHelpersShown(kind, true),
  });
  helperNotices[kind] = notice;
  syncHelperNotice(kind);
  return notice;
};

/** A tester window's content: the helper notice, the ray's pane and the results. */
const createTesterContent = <P extends AimedRay>(
  kind: RayTesterKind,
  ray: P,
  paneItems: (refreshPane: () => void) => DebuggerPaneItem<P>[],
  renderResults: () => void
) => {
  const container = CMP({ class: 'rayTesterWindow' });
  container.add(createHelperNotice(kind));

  let built: BuiltDebuggerPane | null = null;
  const refreshPane = () => built?.refresh();
  const section: DebuggerPaneSection<P> = { pane: true, content: paneItems(refreshPane) };
  built = _buildDebuggerPane(
    { id: WINDOW_IDS[kind], state: ray as unknown as AnyState },
    section as unknown as DebuggerPaneSection<AnyState>
  );
  container.add(built.cmp);
  paneRefreshers[kind] = refreshPane;

  resultsViews[kind] = container.add({ class: ['winPaddedContent', 'rayTesterResults'] });
  renderResults();
  return container;
};

/** The aim bindings every kind has. */
const aimItems = (ray: AimedRay, refreshPane: () => void): DebuggerPaneItem<AimedRay>[] => [
  { key: 'aim.mode', label: 'Aim', options: AIM_MODE_OPTIONS, onChange: refreshPane },
  { key: 'origin', label: 'Origin', hidden: () => ray.aim.mode === 'CAMERA_FORWARD' },
  {
    type: 'button',
    title: 'Set origin from active camera',
    hidden: () => ray.aim.mode === 'CAMERA_FORWARD',
    onClick: () => {
      const camera = getActiveCamera();
      if (!camera) return;
      const pos = camera.getWorldPosition(scratchVec);
      ray.origin.x = pos.x;
      ray.origin.y = pos.y;
      ray.origin.z = pos.z;
      refreshPane();
    },
  },
  { key: 'aim.dir', label: 'Direction', hidden: () => ray.aim.mode !== 'DIRECTION' },
  { key: 'aim.point', label: 'Target point', hidden: () => ray.aim.mode !== 'TARGET_POINT' },
];

const helperFolder = (): DebuggerPaneItem<{ helper: RayTesterHelperParams }> => ({
  type: 'folder',
  id: 'helper',
  title: 'Helper',
  expanded: false,
  content: [
    { key: 'helper.color', label: 'Color', view: 'color' },
    { key: 'helper.inactiveColor', label: 'Inactive color', view: 'color' },
    { key: 'helper.width', label: 'Width (px)', min: 1, max: 20, step: 0.5 },
    { key: 'helper.holdMs', label: 'Hold (ms)', min: 0, max: 10000, step: 50 },
    { key: 'helper.depthTest', label: 'Respect depth', options: DEPTH_TEST_OPTIONS },
  ],
});

const scratchVec = new THREE.Vector3();

/** Writes the ray's origin and normalized direction. Returns an error text, or how far the
 * target point is (Infinity outside TARGET_POINT mode). */
const resolveAim = (
  ray: AimedRay,
  origin: THREE.Vector3,
  dir: THREE.Vector3
): { error: string } | { toTarget: number } => {
  const { aim } = ray;
  if (aim.mode === 'CAMERA_FORWARD') {
    const camera = getActiveCamera();
    if (!camera) return { error: 'No active camera' };
    camera.getWorldPosition(origin);
    camera.getWorldDirection(dir);
    return { toTarget: Infinity };
  }
  origin.set(ray.origin.x, ray.origin.y, ray.origin.z);
  let toTarget = Infinity;
  if (aim.mode === 'TARGET_POINT') {
    dir.set(aim.point.x, aim.point.y, aim.point.z).sub(origin);
    toTarget = dir.length();
    if (toTarget === 0) return { error: 'The target point is at the origin' };
  } else {
    dir.set(aim.dir.x, aim.dir.y, aim.dir.z);
    if (dir.lengthSq() === 0) return { error: 'The direction is zero' };
  }
  dir.normalize();
  return { toTarget };
};

// ----------------------------------------------------------------------------
// Three.js ray tester
// ----------------------------------------------------------------------------

const createThreeTesterContent = () => {
  const state = getThreeState();
  const ray = state.rays[state.activeIndex];
  return createTesterContent(
    'THREE',
    ray,
    (refresh) => threePaneItems(ray, refresh),
    () => renderResults('THREE', threeResults, false, addThreeHitRow)
  );
};

const threePaneItems = (
  ray: ThreeRayParams,
  refreshPane: () => void
): DebuggerPaneItem<ThreeRayParams>[] => [
  { type: 'button', title: 'Fire', onClick: fireThreeRays },
  { type: 'separator' },
  ...aimItems(ray, refreshPane),
  { key: 'near', label: 'Near', min: 0, step: 0.1 },
  { key: 'far', label: 'Far', min: 0, step: 0.1 },
  { key: 'recursive', label: 'Recursive' },
  { key: 'target.type', label: 'Target', options: THREE_TARGET_OPTIONS, onChange: refreshPane },
  { key: 'target.appId', label: 'Entity app id', hidden: () => ray.target.type !== 'ENTITY' },
  helperFolder(),
];

const scratchOrigin = new THREE.Vector3();
const scratchDir = new THREE.Vector3();
const scratchTo = new THREE.Vector3();
const scratchMatrix = new THREE.Matrix4();
const scratchInstanceMatrix = new THREE.Matrix4();
const scratchNormalMatrix = new THREE.Matrix3();
const scratchNormal = new THREE.Vector3();

/** Casts every ray of the state, then shows the results. */
const fireThreeRays = () => {
  const { rays } = getThreeState();
  threeResults = rays.map(fireThreeRay);
  renderResults('THREE', threeResults, false, addThreeHitRow);
};

const fireThreeRay = (ray: ThreeRayParams, index: number): RayTesterResult<ThreeHitRow> => {
  const origin = scratchOrigin;
  const dir = scratchDir;
  const aim = resolveAim(ray, origin, dir);
  if ('error' in aim) return { error: aim.error, ray: null, hits: [] };
  const result: RayTesterResult<ThreeHitRow> = {
    ray: { origin: toVec3(origin), dir: toVec3(dir) },
    hits: [],
  };

  const targets = resolveThreeTargets(ray);
  if (typeof targets === 'string') return { ...result, error: targets };

  const opts: RayCastOpts = {
    near: ray.near,
    // The target point ends the ray, unless far is shorter
    far: Math.min(ray.far, aim.toTarget),
    recursive: ray.recursive,
    countInStats: false,
    debug: toRayDebugOpts(`${RAY_TESTER_ID_PREFIX}three_${index}`, ray.helper),
  };
  const hits =
    ray.aim.mode === 'TARGET_POINT'
      ? castRayFromPoints(targets, origin, scratchTo.copy(ray.aim.point), opts)
      : castRayFromDirection(targets, origin, dir, opts);
  result.hits = hits.map(toThreeHitRow);
  return result;
};

/** The ray's target objects, or an error text when there are none. */
const resolveThreeTargets = (ray: ThreeRayParams): THREE.Object3D | THREE.Object3D[] | string => {
  if (ray.target.type === 'CURRENT_SCENE') {
    const targets = collectSceneTargets();
    return targets.length ? targets : 'No current scene';
  }
  const appId = ray.target.appId.trim();
  if (!appId) return 'Enter the target entity app id';
  const world = getECSWorld();
  const entityId = getEntityIdByAppId(appId, world);
  if (entityId === undefined) return `No entity with the app id "${appId}"`;
  const obj = world.getComponent(entityId, CoreComponentType.OBJECT3D)?.value;
  return obj ?? `The entity "${appId}" has no Object3D`;
};

const sceneTargets: THREE.Object3D[] = [];

/**
 * The current scene's objects. Scene entities are added to the root scene (MeshManager,
 * GroupManager), not to the current scene's group, so these are the root scene's entity-owned
 * children plus that group. The root scene's other children are the debug visuals (light and
 * camera symbols and helpers, grids), which are not entities and must not be hit.
 */
const collectSceneTargets = () => {
  sceneTargets.length = 0;
  const current = getCurrentScene();
  if (current) sceneTargets.push(current);
  const root = getRootScene();
  if (!root) return sceneTargets;
  for (let i = 0; i < root.children.length; i++) {
    const child = root.children[i];
    if (child !== current && typeof child.userData.entityId === 'number') sceneTargets.push(child);
  }
  return sceneTargets;
};

const toThreeHitRow = (hit: THREE.Intersection): ThreeHitRow => ({
  distance: hit.distance,
  point: toVec3(hit.point),
  normal: getWorldFaceNormal(hit),
  objectName: hit.object.name,
  objectType: hit.object.type,
  instanceId: hit.instanceId ?? null,
  ...getHitEntityInfo(getEntityIdForObject3D(hit.object)),
});

/**
 * The entity an object belongs to: its own `userData.entityId`, or the closest ancestor's (the
 * children of imported models aren't tagged).
 * @param obj (THREE.Object3D) the object, eg. a ray hit's object
 * @returns (number | null) the entity id, or null when no ancestor belongs to an entity
 */
export const getEntityIdForObject3D = (obj: THREE.Object3D | null): number | null => {
  for (let o = obj; o; o = o.parent) {
    const entityId = o.userData.entityId;
    if (typeof entityId === 'number') return entityId;
  }
  return null;
};

/** The hit face's normal in world space (the normal matrix, so non-uniform scale is right). */
const getWorldFaceNormal = (hit: THREE.Intersection): Vec3 | null => {
  if (!hit.face) return null;
  const obj = hit.object;
  scratchMatrix.copy(obj.matrixWorld);
  if (hit.instanceId !== undefined && (obj as THREE.InstancedMesh).isInstancedMesh) {
    (obj as THREE.InstancedMesh).getMatrixAt(hit.instanceId, scratchInstanceMatrix);
    scratchMatrix.multiply(scratchInstanceMatrix);
  }
  scratchNormalMatrix.getNormalMatrix(scratchMatrix);
  return toVec3(scratchNormal.copy(hit.face.normal).applyMatrix3(scratchNormalMatrix).normalize());
};

const addThreeHitRow = (list: TCMP, hit: ThreeHitRow, index: number) => {
  const row = addHitRowHead(list, `#${index + 1} · distance ${fmt(hit.distance)}`, hit);
  addField(row, 'Point', fmtVec(hit.point));
  addField(row, 'Normal', hit.normal ? fmtVec(hit.normal) : '—');
  const instance = hit.instanceId === null ? '' : ` · instance ${hit.instanceId}`;
  addField(row, 'Object', `${hit.objectName || '(unnamed)'} · ${hit.objectType}${instance}`);
  addEntityFields(row, hit);
};

// ----------------------------------------------------------------------------
// Physics ray tester
// ----------------------------------------------------------------------------

const createPhysicsTesterContent = () => {
  const state = getPhysicsState();
  const ray = state.rays[state.activeIndex];
  return createTesterContent(
    'PHYSICS',
    ray,
    (refresh) => physicsPaneItems(ray, refresh),
    () => renderResults('PHYSICS', physicsResults, isPhysicsFiring, addPhysicsHitRow)
  );
};

const physicsPaneItems = (
  ray: PhysicsRayParams,
  refreshPane: () => void
): DebuggerPaneItem<PhysicsRayParams>[] => [
  {
    type: 'button',
    title: 'Fire',
    disabled: () => isPhysicsFiring,
    onClick: () => void firePhysicsRays(),
  },
  { type: 'separator' },
  { key: 'query', label: 'Query', options: PHYSICS_QUERY_OPTIONS },
  ...aimItems(ray, refreshPane),
  { key: 'maxToi', label: 'Max toi', min: 0, step: 0.1 },
  { key: 'solid', label: 'Solid' },
  {
    type: 'folder',
    id: 'filters',
    title: 'Filters',
    expanded: false,
    content: [
      { key: 'filterFlags.excludeFixed', label: 'Exclude fixed' },
      { key: 'filterFlags.excludeKinematic', label: 'Exclude kinematic' },
      { key: 'filterFlags.excludeDynamic', label: 'Exclude dynamic' },
      { key: 'filterFlags.excludeSensors', label: 'Exclude sensors' },
      { key: 'filterFlags.excludeSolids', label: 'Exclude solids' },
      { key: 'useFilterGroups', label: 'Use filter groups', onChange: refreshPane },
      {
        key: 'filterGroups',
        label: 'Filter groups (u32)',
        min: 0,
        max: ALL_INTERACTION_GROUPS,
        step: 1,
        hidden: () => !ray.useFilterGroups,
      },
      { key: 'excludeAppId', label: 'Exclude entity (app id)' },
    ],
  },
  helperFolder(),
];

/**
 * Casts every ray of the state, then shows the results. The queries run concurrently, so a
 * multi-ray fire in WORKER_THREAD mode still takes about one frame.
 */
const firePhysicsRays = async () => {
  if (isPhysicsFiring) return;
  setPhysicsFiring(true);
  try {
    const { rays } = getPhysicsState();
    physicsResults = await Promise.all(rays.map(firePhysicsRay));
  } finally {
    setPhysicsFiring(false);
  }
};

const setPhysicsFiring = (isFiring: boolean) => {
  isPhysicsFiring = isFiring;
  paneRefreshers.PHYSICS?.();
  renderResults('PHYSICS', physicsResults, isFiring, addPhysicsHitRow);
};

type RawPhysicsHit = { collider: ColliderAPI; toi: number; normal: PhysVector | null };

const firePhysicsRay = async (
  ray: PhysicsRayParams,
  index: number
): Promise<RayTesterResult<PhysicsHitRow>> => {
  if (!isPhysicsWorldEnabled()) return { error: 'No physics world', ray: null, hits: [] };
  // Not the shared scratch vectors: the rays are in flight together
  const origin = new THREE.Vector3();
  const dir = new THREE.Vector3();
  const aim = resolveAim(ray, origin, dir);
  if ('error' in aim) return { error: aim.error, ray: null, hits: [] };
  const physRay: PhysRay = { origin: toVec3(origin), dir: toVec3(dir) };
  const result: RayTesterResult<PhysicsHitRow> = { ray: physRay, hits: [] };

  const exclude = resolvePhysicsExclusion(ray);
  if (typeof exclude === 'string') return { ...result, error: exclude };

  // The direction is normalized, so toi is the distance: the target point ends the ray, unless
  // maxToi is shorter
  const maxToi = Math.min(ray.maxToi, aim.toTarget);
  const flags = getFilterFlags(ray.filterFlags);
  const groups = ray.useFilterGroups ? ray.filterGroups : undefined;
  const debug = toRayDebugOpts(`${RAY_TESTER_ID_PREFIX}physics_${index}`, ray.helper);
  const world = getPhysicsWorld();
  const hits: RawPhysicsHit[] = [];
  try {
    if (ray.query === 'CAST_RAY') {
      const hit = await world.castRay(
        physRay,
        maxToi,
        ray.solid,
        flags,
        groups,
        exclude.collider,
        exclude.body,
        undefined,
        debug
      );
      if (hit) hits.push({ collider: hit.collider, toi: hit.timeOfImpact, normal: null });
    } else if (ray.query === 'CAST_RAY_AND_GET_NORMAL') {
      const hit = await world.castRayAndGetNormal(
        physRay,
        maxToi,
        ray.solid,
        flags,
        groups,
        exclude.collider,
        exclude.body,
        undefined,
        debug
      );
      if (hit) hits.push({ collider: hit.collider, toi: hit.timeOfImpact, normal: hit.normal });
    } else {
      await world.intersectionsWithRay(
        physRay,
        maxToi,
        ray.solid,
        (hit) => {
          hits.push({ collider: hit.collider, toi: hit.timeOfImpact, normal: hit.normal });
          return true;
        },
        flags,
        groups,
        exclude.collider,
        exclude.body,
        undefined,
        debug
      );
      // Reported in no particular order
      hits.sort((a, b) => a.toi - b.toi);
    }
  } catch (err) {
    return { ...result, error: `The query failed: ${err instanceof Error ? err.message : err}` };
  }

  const colliderEntities = getColliderEntityMap();
  result.hits = hits.map((hit) => toPhysicsHitRow(hit, physRay, colliderEntities));
  return result;
};

const getFilterFlags = (filterFlags: PhysicsRayFilterFlags): QueryFilterFlags | undefined => {
  let flags = 0;
  for (const key of FILTER_FLAG_KEYS) if (filterFlags[key]) flags |= FILTER_FLAG_BITS[key];
  return flags || undefined;
};

/** The excluded entity's rigid body, or its collider when it has one collider and no body.
 * Returns an error text when the entity can't be excluded. */
const resolvePhysicsExclusion = (
  ray: PhysicsRayParams
): { body?: RigidBodyAPI; collider?: ColliderAPI } | string => {
  const appId = ray.excludeAppId.trim();
  if (!appId) return {};
  const world = getECSWorld();
  const entityId = getEntityIdByAppId(appId, world);
  if (entityId === undefined) return `No entity with the app id "${appId}" to exclude`;
  const body = world.getRigidBody(entityId);
  if (body) return { body };
  const colliders = world.getComponent(entityId, CoreComponentType.COLLIDER);
  if (colliders?.length === 1) return { collider: colliders[0] };
  return `The entity "${appId}" has no rigid body${colliders?.length ? ` and ${colliders.length} colliders` : ''}: only a body or a single collider can be excluded`;
};

/** Collider id → entity id, from the physics entities' COLLIDER components (there is no
 * reverse lookup: the tester builds it per fire). Colliders without a body are covered too. */
const getColliderEntityMap = () => {
  const map = new Map<number, number>();
  const world = getECSWorld();
  for (const entityId of world.getEntitiesWith(CoreComponentType.COLLIDER)) {
    const colliders = world.getComponent(entityId, CoreComponentType.COLLIDER);
    if (!colliders) continue;
    for (let i = 0; i < colliders.length; i++) map.set(colliders[i].id, entityId);
  }
  return map;
};

const toPhysicsHitRow = (
  hit: RawPhysicsHit,
  ray: PhysRay,
  colliderEntities: Map<number, number>
): PhysicsHitRow => ({
  toi: hit.toi,
  point: {
    x: ray.origin.x + ray.dir.x * hit.toi,
    y: ray.origin.y + ray.dir.y * hit.toi,
    z: ray.origin.z + ray.dir.z * hit.toi,
  },
  normal: hit.normal ? toVec3(hit.normal) : null,
  colliderId: hit.collider.id,
  bodyId: hit.collider.parentId ?? null,
  ...getHitEntityInfo(colliderEntities.get(hit.collider.id) ?? null),
});

const addPhysicsHitRow = (list: TCMP, hit: PhysicsHitRow, index: number) => {
  const row = addHitRowHead(list, `#${index + 1} · toi ${fmt(hit.toi)}`, hit);
  addField(row, 'Point', fmtVec(hit.point));
  addField(row, 'Normal', hit.normal ? fmtVec(hit.normal) : '—');
  const body = hit.bodyId === null ? 'no body' : `body ${hit.bodyId}`;
  addField(row, 'Collider', `${hit.colliderId} · ${body}`);
  addEntityFields(row, hit);
};

// ----------------------------------------------------------------------------
// Shared helpers
// ----------------------------------------------------------------------------

const CONTENT_FNS: Record<RayTesterKind, () => TCMP> = {
  THREE: createThreeTesterContent,
  PHYSICS: createPhysicsTesterContent,
};

const toRayDebugOpts = (id: string, helper: RayTesterHelperParams): RayDebugOpts => ({
  id,
  color: helper.color,
  inactiveColor: helper.inactiveColor,
  width: helper.width,
  holdMs: helper.holdMs,
  depthTest: helper.depthTest === 'KIND' ? undefined : helper.depthTest === 'ON',
});

const getHitEntityInfo = (entityId: number | null): HitEntityInfo => {
  const appIdComp =
    entityId === null ? undefined : getECSWorld().getComponent(entityId, CoreComponentType.APP_ID);
  return {
    entityId,
    appId: appIdComp?.id ?? null,
    appIdIsFixed: Boolean(appIdComp?.isFixed),
  };
};

/** Writes a kind's results into its mounted view: per ray, the ray, then the hits or its
 * error. */
const renderResults = <H>(
  kind: RayTesterKind,
  results: RayTesterResult<H>[] | null,
  isPending: boolean,
  addHitRow: (list: TCMP, hit: H, index: number) => void
) => {
  const root = resultsViews[kind];
  if (!root) return;
  root.removeChildren();
  if (isPending || !results) {
    const text = isPending ? 'Waiting for the physics results…' : 'Fire to see the hits.';
    root.add({ tag: 'p', class: 'rayTesterNote', text });
    return;
  }
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const block = root.add({ class: 'rayTesterRay' });
    if (results.length > 1) block.add({ tag: 'h4', text: `Ray #${i + 1}` });
    if (result.ray) {
      addField(block, 'Ray', `${fmtVec(result.ray.origin)} → dir ${fmtVec(result.ray.dir)}`);
    }
    if (result.error) {
      block.add({ tag: 'p', class: 'rayTesterError', text: result.error });
      continue;
    }
    const count = result.hits.length;
    block.add({
      tag: 'p',
      class: 'rayTesterSummary',
      text: count ? `${count} hit${count === 1 ? '' : 's'}` : 'No hits',
    });
    if (!count) continue;
    const list = block.add({ tag: 'ol' });
    const listed = Math.min(count, MAX_LISTED_HITS);
    for (let h = 0; h < listed; h++) addHitRow(list, result.hits[h], h);
    if (count > listed) {
      list.add({ tag: 'li', class: 'rayTesterMore', text: `+${count - listed} more` });
    }
  }
};

/** A hit's list row with its heading and a copy-as-JSON button. Returns the row. */
const addHitRowHead = (list: TCMP, title: string, hit: unknown) => {
  const row = list.add({ tag: 'li' });
  const head = row.add({ class: 'rayTesterHitHead' });
  head.add({ tag: 'span', text: title });
  head.add({
    class: 'winSmallIconButton',
    html: () => `<button title="Copy this hit as JSON">${getSvgIcon('fileCode')}</button>`,
    onClick: () => copyAsJson(hit),
  });
  return row;
};

const addEntityFields = (row: TCMP, info: HitEntityInfo) => {
  addField(row, 'Entity', info.entityId === null ? '—' : String(info.entityId));
  const appId =
    info.appId === null ? '—' : `${info.appId}${info.appIdIsFixed ? '' : ' (generated)'}`;
  addField(row, 'App id', appId);
};

/** A label + value row. The value is set as text (object names are not html). */
const addField = (parent: TCMP, label: string, value: string) => {
  const field = parent.add({ class: 'rayTesterField' });
  field.add({ tag: 'span', class: 'winSmallLabel', text: label });
  field.add({ tag: 'span', text: value });
};

const copyAsJson = (data: unknown) => {
  navigator.clipboard.writeText(JSON.stringify(data, null, 2)).then(
    () => addToast({ title: 'Copied', message: 'Hit copied as JSON', toasterId: DEBUG_TOASTER_ID }),
    () =>
      addToast({
        type: 'warning',
        title: 'Copy failed',
        message: 'The clipboard is not available',
        toasterId: DEBUG_TOASTER_ID,
      })
  );
};

const toVec3 = (v: THREE.Vector3Like): Vec3 => ({ x: v.x, y: v.y, z: v.z });
const fmt = (n: number) => (Number.isFinite(n) ? n.toFixed(3) : String(n));
const fmtVec = (v: Vec3) => `(${fmt(v.x)}, ${fmt(v.y)}, ${fmt(v.z)})`;

// Registered at module load (before the saved windows are restored), so a tester window that
// was open before a reload gets its content
registerDraggableWindowContentFn(WINDOW_IDS.THREE, createThreeTesterContent);
registerDraggableWindowContentFn(WINDOW_IDS.PHYSICS, createPhysicsTesterContent);
