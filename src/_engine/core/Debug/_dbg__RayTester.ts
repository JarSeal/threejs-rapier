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
import type { RayDebugOpts, RayHelperKind } from '../RayDebugTypes';
import { getRayHelperSettings } from './_dbg__RayHelpers';
import { _setRayHelpersShown } from './_dbg__Raycast';

/**
 * Ray tester windows (p143), opened from the Ray cast controls tab: configure a ray, fire it
 * into the current scene through the same code paths gameplay uses, see it as a debug helper
 * and read the hits.
 *
 * The state holds a list of rays and Fire casts all of them (results per ray), but the window
 * edits and shows only `rays[activeIndex]`, so multi-ray patterns are a UI-only addition later.
 *
 * Tester rays are never counted in the ray statistics, and their helper ids start with
 * `rayTester_`.
 */

type AnyState = Record<string, unknown>;

type Vec3 = { x: number; y: number; z: number };

/** DIRECTION: origin + dir (normalized on fire). TARGET_POINT: origin → point. CAMERA_FORWARD:
 * origin and dir are taken from the active camera at fire time. Every mode keeps its own
 * values, so switching modes loses nothing. */
type RayAimMode = 'DIRECTION' | 'TARGET_POINT' | 'CAMERA_FORWARD';
type RayAim = { mode: RayAimMode; dir: Vec3; point: Vec3 };

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

type ThreeRayParams = {
  origin: Vec3;
  aim: RayAim;
  near: number;
  far: number;
  recursive: boolean;
  target: { type: ThreeRayTargetType; appId: string };
  helper: RayTesterHelperParams;
};

type RayTesterState<P> = { version: 1; rays: P[]; activeIndex: number };

/** One hit as plain data (no object references), ready to show and to copy as JSON */
type ThreeHitRow = {
  distance: number;
  point: Vec3;
  /** Face normal in world space */
  normal: Vec3 | null;
  objectName: string;
  objectType: string;
  instanceId: number | null;
  entityId: number | null;
  appId: string | null;
  /** False for generated app ids, which change on every reload */
  appIdIsFixed: boolean;
};

type ThreeRayResult = {
  error?: string;
  /** The ray as cast (null when its aim couldn't be resolved) */
  ray: { origin: Vec3; dir: Vec3 } | null;
  hits: ThreeHitRow[];
};

const WINDOW_IDS = { THREE: 'debugRayTesterThree' } as const;
type RayTesterKind = keyof typeof WINDOW_IDS;

const HELPER_ID_PREFIX = 'rayTester_';
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

const createThreeRayParams = (): ThreeRayParams => ({
  origin: { x: 0, y: 5, z: 0 },
  aim: { mode: 'DIRECTION', dir: { x: 0, y: -1, z: 0 }, point: { x: 0, y: 0, z: 0 } },
  near: 0,
  far: 100,
  recursive: true,
  target: { type: 'CURRENT_SCENE', appId: '' },
  // Apart from the kind's default colors, so tester rays stand out from gameplay rays
  helper: {
    color: '#ffd60a',
    inactiveColor: '#7a6a1f',
    width: 4,
    holdMs: 3000,
    depthTest: 'KIND',
  },
});

const createThreeState = (): RayTesterState<ThreeRayParams> => ({
  version: 1,
  rays: [createThreeRayParams()],
  activeIndex: 0,
});

let threeState: RayTesterState<ThreeRayParams> | null = null;
const getThreeState = () => (threeState ??= createThreeState());

/** The last fire's results (not persisted) */
let threeResults: ThreeRayResult[] | null = null;
/** The mounted views (null or stale while the window is closed: they are only written to) */
let threeResultsCmp: TCMP | null = null;
const helperNotices: Partial<Record<RayHelperKind, TCMP>> = {};

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
    title: 'Three.js ray tester',
    isDebugWindow: true,
    saveToLS: true,
    position: { x: 120, y: 80 },
    size: { w: 380, h: 640 },
    content: createThreeTesterContent,
  });
};

/** Shows or hides the "helpers are off" notices of the mounted tester windows. The Ray cast
 * controls tab calls it whenever a kind's helper settings change. */
export const _refreshRayTesterHelperNotices = () => {
  syncHelperNotice('THREE');
  syncHelperNotice('PHYSICS');
};

const syncHelperNotice = (kind: RayHelperKind) => {
  helperNotices[kind]?.updateStyle({ display: getRayHelperSettings(kind).show ? 'none' : '' });
};

/** A tester ray is only drawn while its kind's helpers are shown (the tab's "Show helpers"). */
const createHelperNotice = (kind: RayHelperKind, kindName: string) => {
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

// ----------------------------------------------------------------------------
// Three.js ray tester
// ----------------------------------------------------------------------------

const createThreeTesterContent = () => {
  const state = getThreeState();
  const ray = state.rays[state.activeIndex];
  const container = CMP({ class: 'rayTesterWindow' });
  container.add(createHelperNotice('THREE', 'Three.js'));

  let built: BuiltDebuggerPane | null = null;
  const refreshPane = () => built?.refresh();
  const section: DebuggerPaneSection<ThreeRayParams> = {
    pane: true,
    content: threePaneItems(ray, refreshPane),
  };
  built = _buildDebuggerPane(
    { id: WINDOW_IDS.THREE, state: ray as unknown as AnyState },
    section as unknown as DebuggerPaneSection<AnyState>
  );
  container.add(built.cmp);

  threeResultsCmp = container.add({ class: ['winPaddedContent', 'rayTesterResults'] });
  renderThreeResults();
  return container;
};

const threePaneItems = (
  ray: ThreeRayParams,
  refreshPane: () => void
): DebuggerPaneItem<ThreeRayParams>[] => [
  { type: 'button', title: 'Fire', onClick: fireThreeRays },
  { type: 'separator' },
  { key: 'aim.mode', label: 'Aim', options: AIM_MODE_OPTIONS, onChange: refreshPane },
  { key: 'origin', label: 'Origin', hidden: () => ray.aim.mode === 'CAMERA_FORWARD' },
  {
    type: 'button',
    title: 'Set origin from active camera',
    hidden: () => ray.aim.mode === 'CAMERA_FORWARD',
    onClick: () => {
      const camera = getActiveCamera();
      if (!camera) return;
      const pos = camera.getWorldPosition(scratchOrigin);
      ray.origin.x = pos.x;
      ray.origin.y = pos.y;
      ray.origin.z = pos.z;
      refreshPane();
    },
  },
  { key: 'aim.dir', label: 'Direction', hidden: () => ray.aim.mode !== 'DIRECTION' },
  { key: 'aim.point', label: 'Target point', hidden: () => ray.aim.mode !== 'TARGET_POINT' },
  { key: 'near', label: 'Near', min: 0, step: 0.1 },
  { key: 'far', label: 'Far', min: 0, step: 0.1 },
  { key: 'recursive', label: 'Recursive' },
  { key: 'target.type', label: 'Target', options: THREE_TARGET_OPTIONS, onChange: refreshPane },
  { key: 'target.appId', label: 'Entity app id', hidden: () => ray.target.type !== 'ENTITY' },
  {
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
  },
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
  renderThreeResults();
};

const fireThreeRay = (ray: ThreeRayParams, index: number): ThreeRayResult => {
  const origin = scratchOrigin;
  const dir = scratchDir;
  const aimError = resolveAim(ray, origin, dir);
  if (aimError) return { error: aimError, ray: null, hits: [] };
  const result: ThreeRayResult = { ray: { origin: toVec3(origin), dir: toVec3(dir) }, hits: [] };

  const targets = resolveThreeTargets(ray);
  if (typeof targets === 'string') return { ...result, error: targets };

  const opts: RayCastOpts = {
    near: ray.near,
    far: ray.far,
    recursive: ray.recursive,
    countInStats: false,
    debug: toRayDebugOpts(`${HELPER_ID_PREFIX}three_${index}`, ray.helper),
  };
  let hits: THREE.Intersection[];
  if (ray.aim.mode === 'TARGET_POINT') {
    const to = scratchTo.set(ray.aim.point.x, ray.aim.point.y, ray.aim.point.z);
    // The target point ends the ray, unless far is shorter
    opts.far = Math.min(ray.far, origin.distanceTo(to));
    hits = castRayFromPoints(targets, origin, to, opts);
  } else {
    hits = castRayFromDirection(targets, origin, dir, opts);
  }
  result.hits = hits.map(toThreeHitRow);
  return result;
};

/** Writes the ray's origin and normalized direction. Returns an error text, or null. */
const resolveAim = (ray: ThreeRayParams, origin: THREE.Vector3, dir: THREE.Vector3) => {
  const { aim } = ray;
  if (aim.mode === 'CAMERA_FORWARD') {
    const camera = getActiveCamera();
    if (!camera) return 'No active camera';
    camera.getWorldPosition(origin);
    camera.getWorldDirection(dir);
    return null;
  }
  origin.set(ray.origin.x, ray.origin.y, ray.origin.z);
  if (aim.mode === 'TARGET_POINT') {
    dir.set(aim.point.x, aim.point.y, aim.point.z).sub(origin);
    if (dir.lengthSq() === 0) return 'The target point is at the origin';
  } else {
    dir.set(aim.dir.x, aim.dir.y, aim.dir.z);
    if (dir.lengthSq() === 0) return 'The direction is zero';
  }
  dir.normalize();
  return null;
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

const toThreeHitRow = (hit: THREE.Intersection): ThreeHitRow => {
  const entityId = getEntityIdForObject3D(hit.object);
  const appIdComp =
    entityId === null ? undefined : getECSWorld().getComponent(entityId, CoreComponentType.APP_ID);
  return {
    distance: hit.distance,
    point: toVec3(hit.point),
    normal: getWorldFaceNormal(hit),
    objectName: hit.object.name,
    objectType: hit.object.type,
    instanceId: hit.instanceId ?? null,
    entityId,
    appId: appIdComp?.id ?? null,
    appIdIsFixed: Boolean(appIdComp?.isFixed),
  };
};

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

const renderThreeResults = () => {
  const root = threeResultsCmp;
  if (!root) return;
  root.removeChildren();
  if (!threeResults) {
    root.add({ tag: 'p', class: 'rayTesterNote', text: 'Fire to see the hits.' });
    return;
  }
  for (let i = 0; i < threeResults.length; i++) {
    const result = threeResults[i];
    const block = root.add({ class: 'rayTesterRay' });
    if (threeResults.length > 1) block.add({ tag: 'h4', text: `Ray #${i + 1}` });
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
    for (let h = 0; h < listed; h++) addThreeHitRow(list, result.hits[h], h);
    if (count > listed) {
      list.add({ tag: 'li', class: 'rayTesterMore', text: `+${count - listed} more` });
    }
  }
};

const addThreeHitRow = (list: TCMP, hit: ThreeHitRow, index: number) => {
  const row = list.add({ tag: 'li' });
  const head = row.add({ class: 'rayTesterHitHead' });
  head.add({ tag: 'span', text: `#${index + 1} · distance ${fmt(hit.distance)}` });
  head.add({
    class: 'winSmallIconButton',
    html: () => `<button title="Copy this hit as JSON">${getSvgIcon('fileCode')}</button>`,
    onClick: () => copyAsJson(hit),
  });
  addField(row, 'Point', fmtVec(hit.point));
  addField(row, 'Normal', hit.normal ? fmtVec(hit.normal) : '—');
  const instance = hit.instanceId === null ? '' : ` · instance ${hit.instanceId}`;
  addField(row, 'Object', `${hit.objectName || '(unnamed)'} · ${hit.objectType}${instance}`);
  addField(row, 'Entity', hit.entityId === null ? '—' : String(hit.entityId));
  addField(
    row,
    'App id',
    hit.appId === null ? '—' : `${hit.appId}${hit.appIdIsFixed ? '' : ' (generated)'}`
  );
};

// ----------------------------------------------------------------------------
// Shared helpers
// ----------------------------------------------------------------------------

const toRayDebugOpts = (id: string, helper: RayTesterHelperParams): RayDebugOpts => ({
  id,
  color: helper.color,
  inactiveColor: helper.inactiveColor,
  width: helper.width,
  holdMs: helper.holdMs,
  depthTest: helper.depthTest === 'KIND' ? undefined : helper.depthTest === 'ON',
});

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
