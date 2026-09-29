import * as THREE from 'three/webgpu';
import { DIRECTIONS } from '../utils/constants';
import { DebugModuleRef, loadDebugModuleAsync, useDebug } from '../utils/helpers';
import {
  IntervalCounterStats,
  type IntervalCounterSnapshot,
} from '../utils/stats/IntervalCounterStats';
import { DEFAULT_ECS_WORLD_ID, ECSWorld } from './ECS';
import { ECSSystemStage } from '../../AppECSRegistry';
import { RAY_STATS_WINDOWS, type RayDebugOpts } from './RayDebugTypes';

export type { RayDebugOpts, RayHelperKind } from './RayDebugTypes';

/**
 * Options of the `castRayFrom*` functions. The deprecated aliases (helperId, helperColor,
 * startLength, endLength, perIntersectFn, optionalTargetArr) still work and are removed in a
 * later major version.
 */
export type RayCastOpts<TIntersected extends THREE.Object3D = THREE.Object3D> = {
  /** Minimum hit distance (Raycaster.near), default 0 */
  near?: number;
  /** Maximum hit distance (Raycaster.far), default Infinity (castRayFromPoints: the from→to
   * distance) */
  far?: number;
  /** Whether the objects' descendants are tested too, default true */
  recursive?: boolean;
  /** Reused result array: it is cleared and filled, and returned instead of a new array */
  target?: Array<THREE.Intersection<TIntersected>>;
  /** Called per hit in distance order; return false to stop iterating. Don't cast another ray
   * from it (all casts share one raycaster): collect the hits first, then cast. */
  perIntersect?: (intersect: THREE.Intersection<TIntersected>) => void | boolean;
  /** Whether this ray is counted in the ray cast statistics, default true */
  countInStats?: boolean;
  /** Debug helper options, ignored outside debug */
  debug?: RayDebugOpts;
  /** Only castRayFromAngle: the local axis rotated by the angle, default FORWARD */
  directionForAngle?: keyof typeof DIRECTIONS;
  /** @deprecated use `debug.id` */
  helperId?: string;
  /** @deprecated use `debug.color` */
  helperColor?: THREE.ColorRepresentation;
  /** @deprecated use `near` */
  startLength?: number;
  /** @deprecated use `far` */
  endLength?: number;
  /** @deprecated use `perIntersect` */
  perIntersectFn?: (intersect: THREE.Intersection<TIntersected>) => void | boolean;
  /** @deprecated use `target` */
  optionalTargetArr?: Array<THREE.Intersection<TIntersected>>;
};

/** Shared by every cast. castPrepared restores its near/far after each cast. */
const raycaster = new THREE.Raycaster();
const scratchDirection = new THREE.Vector3();
const screenPos = new THREE.Vector2();
const legacyDebugOpts: RayDebugOpts = { id: '' };

/** Wires up the debug side: the Ray cast controls tab (a no-op outside debug). Called once by
 * the main loop init. */
export const initRayCasting = () => {
  useDebug(debugGUI)?._initRayCastingDebugger();
};

/** Maps the deprecated helperId/helperColor onto the debug options (without allocating). */
const resolveDebugOpts = (
  opts: Pick<RayCastOpts, 'debug' | 'helperId' | 'helperColor'>
): RayDebugOpts | undefined => {
  if (opts.debug) return opts.debug;
  if (!opts.helperId) return undefined;
  legacyDebugOpts.id = opts.helperId;
  legacyDebugOpts.color = opts.helperColor;
  return legacyDebugOpts;
};

/**
 * Intersects the objects with the already positioned raycaster. Every cast funnels through
 * here, and the deprecated option aliases are resolved here.
 */
const castPrepared = <TIntersected extends THREE.Object3D>(
  objects: THREE.Object3D | THREE.Object3D[],
  opts: RayCastOpts<TIntersected> | undefined,
  defaultFar: number
): Array<THREE.Intersection<TIntersected>> => {
  // The deprecated startLength/endLength were ignored when 0, so they still are
  const far = opts?.far ?? (opts?.endLength || defaultFar);
  const target = opts?.target ?? opts?.optionalTargetArr;
  const perIntersect = opts?.perIntersect ?? opts?.perIntersectFn;
  const recursive = opts?.recursive ?? true;

  let intersects: Array<THREE.Intersection<TIntersected>>;
  raycaster.near = opts?.near ?? (opts?.startLength || 0);
  raycaster.far = far;
  try {
    if (target) target.length = 0;
    intersects = Array.isArray(objects)
      ? raycaster.intersectObjects(objects, recursive, target)
      : raycaster.intersectObject(objects, recursive, target);
  } finally {
    raycaster.near = 0;
    raycaster.far = Infinity;
  }

  if (perIntersect) {
    for (let i = 0; i < intersects.length; i++) {
      if (perIntersect(intersects[i]) === false) break;
    }
  }
  if (statsEnabled && opts?.countInStats !== false) stats.add();
  // Every cast, with or without debug options: rays without an id are drawn when the Three.js
  // helpers show anonymous rays
  const helpers = useDebug(rayHelpers);
  if (helpers) {
    helpers._drawRay(
      'THREE',
      raycaster.ray.origin,
      raycaster.ray.direction,
      far,
      intersects.length ? intersects[0].distance : null,
      opts && resolveDebugOpts(opts),
      performance.now()
    );
  }
  return intersects;
};

/**
 * Casts a ray from an origin in a direction.
 * @param objects (THREE.Object3D | THREE.Object3D[]) object(s) to test against
 * @param origin (THREE.Vector3) ray origin
 * @param direction (THREE.Vector3) normalized ray direction
 * @param opts ({@link RayCastOpts}) optional ray cast options
 * @returns (Array<THREE.Intersection>) intersections sorted by distance, closest first
 */
export const castRayFromDirection = <TIntersected extends THREE.Object3D = THREE.Object3D>(
  objects: THREE.Object3D | THREE.Object3D[],
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  opts?: RayCastOpts<TIntersected>
): Array<THREE.Intersection<TIntersected>> => {
  raycaster.set(origin, direction);
  return castPrepared(objects, opts, Infinity);
};

/**
 * Casts a ray from a point to another point: only hits between them are returned (`far`
 * defaults to the from→to distance).
 *
 * Changed in engine 2.2.0: `to` used to be treated as a direction (use
 * {@link castRayFromDirection} for that).
 * @param objects (THREE.Object3D | THREE.Object3D[]) object(s) to test against
 * @param from (THREE.Vector3) ray origin
 * @param to (THREE.Vector3) ray end point
 * @param opts ({@link RayCastOpts}) optional ray cast options
 * @returns (Array<THREE.Intersection>) intersections sorted by distance, closest first
 */
export const castRayFromPoints = <TIntersected extends THREE.Object3D = THREE.Object3D>(
  objects: THREE.Object3D | THREE.Object3D[],
  from: THREE.Vector3,
  to: THREE.Vector3,
  opts?: RayCastOpts<TIntersected>
): Array<THREE.Intersection<TIntersected>> => {
  const distance = from.distanceTo(to);
  raycaster.set(from, scratchDirection.subVectors(to, from).normalize());
  return castPrepared(objects, opts, distance);
};

/**
 * Casts a ray from an origin in the direction of an angle: `opts.directionForAngle` (default
 * FORWARD, -Z) rotated by the angle.
 * @param objects (THREE.Object3D | THREE.Object3D[]) object(s) to test against
 * @param from (THREE.Vector3) ray origin
 * @param angle (THREE.Euler | THREE.Quaternion) rotation of the direction
 * @param opts ({@link RayCastOpts}) optional ray cast options
 * @returns (Array<THREE.Intersection>) intersections sorted by distance, closest first
 */
export const castRayFromAngle = <TIntersected extends THREE.Object3D = THREE.Object3D>(
  objects: THREE.Object3D | THREE.Object3D[],
  from: THREE.Vector3,
  angle: THREE.Euler | THREE.Quaternion,
  opts?: RayCastOpts<TIntersected>
): Array<THREE.Intersection<TIntersected>> => {
  scratchDirection.copy(DIRECTIONS[opts?.directionForAngle || 'FORWARD']);
  if ('isEuler' in angle) {
    scratchDirection.applyEuler(angle).normalize();
  } else {
    scratchDirection.applyQuaternion(angle).normalize();
  }
  raycaster.set(from, scratchDirection);
  return castPrepared(objects, opts, Infinity);
};

/**
 * Casts a ray from a screen position through the camera (picking), e.g. for mouse/touch input.
 * @param objects (THREE.Object3D | THREE.Object3D[]) object(s) to test against
 * @param ndcX (number) normalized device coordinate x, -1 (left) .. 1 (right)
 * @param ndcY (number) normalized device coordinate y, -1 (bottom) .. 1 (top)
 * @param camera (THREE.Camera) the camera the screen position is relative to (usually the one rendering)
 * @param opts ({@link RayCastOpts}) optional ray cast options (directionForAngle is ignored)
 * @returns (Array<THREE.Intersection>) intersections sorted by distance, closest first
 */
export const castRayFromScreenPosition = <TIntersected extends THREE.Object3D = THREE.Object3D>(
  objects: THREE.Object3D | THREE.Object3D[],
  ndcX: number,
  ndcY: number,
  camera: THREE.Camera,
  opts?: RayCastOpts<TIntersected>
): Array<THREE.Intersection<TIntersected>> => {
  raycaster.setFromCamera(screenPos.set(ndcX, ndcY), camera);
  return castPrepared(objects, opts, Infinity);
};

// Stats

/** Ray cast statistics windows (per rendered frame) */
const stats = new IntervalCounterStats(RAY_STATS_WINDOWS);
let statsEnabled = false;

/**
 * Enables or disables the ray cast statistics. Enabling resets them. While disabled, a cast
 * costs one boolean check and nothing is counted.
 * @param enabled (boolean) whether casts are counted
 */
export const setRayCastStatsEnabled = (enabled: boolean) => {
  if (enabled && !statsEnabled) stats.reset();
  statsEnabled = enabled;
};

/**
 * Whether the ray cast statistics are enabled
 * @returns boolean
 */
export const isRayCastStatsEnabled = () => statsEnabled;

/**
 * The ray cast statistics: rays cast per rendered frame (the last frame, the max ever and the
 * min/max/average of rolling intervals). Casts made on frames the FPS limiter skips count toward
 * the next rendered frame.
 *
 * The returned object is the same on every call and is updated in place every rendered frame,
 * so polling it allocates nothing. Copy the values out to keep them.
 * @returns (Readonly<IntervalCounterSnapshot>) the live statistics snapshot
 */
export const getRayCastStats = (): Readonly<IntervalCounterSnapshot> => stats.snapshot();

/** Resets the ray cast statistics. The scene loader calls it on every scene enter. */
export const resetRayCastStats = () => {
  stats.reset();
};

/** Once per rendered frame (LATE_MAIN, after rendering): ends the stats frame, then runs the
 * debug helpers' update pass (hold, fade out, recycle). */
const rayCastFrameEndSystem = () => {
  const now = performance.now();
  if (statsEnabled) stats.endFrame(now);
  useDebug(rayHelpers)?._updateRayHelpers(now);
};

ECSWorld.registerPlugin((world) => {
  // Only the default world: LATE_MAIN runs once per world, and a frame must end only once
  if (world.id !== DEFAULT_ECS_WORLD_ID) return;
  world.addSystem(ECSSystemStage.LATE_MAIN, 'rayCastFrameEndSystem', rayCastFrameEndSystem, -1000);
});

// Debug
type RaycastGUIModule = typeof import('../core/Debug/_dbg__Raycast');
type RayHelpersModule = typeof import('../core/Debug/_dbg__RayHelpers');
let debugGUI: DebugModuleRef<RaycastGUIModule> | null = null;
let rayHelpers: DebugModuleRef<RayHelpersModule> | null = null;

/** Loads the ray cast debug modules: the tab and the helper renderer (debug env only). */
export const registerRaycastDebugGUI = async () => {
  [debugGUI, rayHelpers] = await Promise.all([
    loadDebugModuleAsync(() => import('../core/Debug/_dbg__Raycast')),
    loadDebugModuleAsync(() => import('../core/Debug/_dbg__RayHelpers')),
  ]);
};

/** Hides every ray debug helper (they are pooled, not disposed). The scene loader calls it on
 * every scene exit. */
export const deleteAllRayHelpers = () => {
  useDebug(rayHelpers)?._clearRayHelpers();
};
