import * as THREE from 'three/webgpu';
import { DIRECTIONS } from '../utils/constants';
import { DebugModuleRef, loadDebugModuleAsync, useDebug } from '../utils/helpers';
import {
  IntervalCounterStats,
  type IntervalCounterSnapshot,
} from '../utils/stats/IntervalCounterStats';
import { DEFAULT_ECS_WORLD_ID, ECSWorld } from './ECS';
import { ECSSystemStage } from '../../AppECSRegistry';

type Opts<TIntersected extends THREE.Object3D = THREE.Object3D> = {
  startLength?: number;
  endLength?: number;
  perIntersectFn?: (intersect: THREE.Intersection<TIntersected>) => void | boolean;
  helperId?: string;
  helperColor?: THREE.ColorRepresentation;
  optionalTargetArr?: Array<THREE.Intersection<TIntersected>>;
  recursive?: boolean;
  directionForAngle?: keyof typeof DIRECTIONS;
};

let ray: THREE.Raycaster | null = null;
const defaultDirectionForAngle = DIRECTIONS.FORWARD;

export const initRayCasting = () => {
  ray = new THREE.Raycaster();
  useDebug(debugGUI)?._initRayCastingDebugger();
};

const getRayCastIntersects = <TIntersected extends THREE.Object3D = THREE.Object3D>({
  ray,
  objects,
  startLength,
  endLength,
  perIntersectFn,
  optionalTargetArr,
  recursive,
}: {
  ray: THREE.Raycaster;
  objects: THREE.Object3D | THREE.Object3D[];
  startLength?: number;
  endLength?: number;
  perIntersectFn?: (intersect: THREE.Intersection<TIntersected>) => void | boolean;
  optionalTargetArr?: Array<THREE.Intersection<TIntersected>>;
  recursive?: boolean;
}) => {
  let intersects: Array<THREE.Intersection<TIntersected>>;
  if (Array.isArray(objects)) {
    // intersectObjects (multiple objects)
    intersects = ray.intersectObjects(objects, recursive, optionalTargetArr);
  } else {
    // intersectObject (one object)
    intersects = ray.intersectObject(objects, recursive, optionalTargetArr);
  }
  if (perIntersectFn) {
    for (let i = 0; i < intersects.length; i++) {
      const int = intersects[i];
      if (startLength && startLength > int.distance) continue;
      if (endLength && endLength < int.distance) return intersects;
      perIntersectFn(int);
    }
  }
  return intersects;
};

export const castRayFromPoints = <TIntersected extends THREE.Object3D = THREE.Object3D>(
  objects: THREE.Object3D | THREE.Object3D[],
  from: THREE.Vector3,
  to: THREE.Vector3,
  opts?: Opts<TIntersected>
): Array<THREE.Intersection<TIntersected>> => {
  const {
    startLength,
    endLength,
    perIntersectFn,
    optionalTargetArr,
    recursive,
    helperId,
    helperColor,
  } = opts || {};
  (ray as THREE.Raycaster).set(from, to);
  const intersects = getRayCastIntersects({
    ray: ray as THREE.Raycaster,
    objects,
    startLength,
    endLength,
    perIntersectFn,
    optionalTargetArr,
    recursive,
  });
  if (statsEnabled) stats.add();
  // drawRayHelper({ from, to, endLength, helperId, helperColor });
  useDebug(debugGUI)?._drawRayHelper({ from, to, endLength, helperId, helperColor });
  return intersects;
};

const getAngleDirectionPoint = (
  angle: THREE.Euler | THREE.Quaternion,
  directionForAngle?: keyof typeof DIRECTIONS
) => {
  const angleDirection = directionForAngle
    ? DIRECTIONS[directionForAngle].clone()
    : defaultDirectionForAngle.clone();
  if ('isEuler' in angle) {
    // Euler angle
    angleDirection.applyEuler(angle).normalize();
  } else {
    // Quaternion angle
    angleDirection.applyQuaternion(angle).normalize();
  }
  return angleDirection;
};

export const castRayFromAngle = <TIntersected extends THREE.Object3D = THREE.Object3D>(
  objects: THREE.Object3D | THREE.Object3D[],
  from: THREE.Vector3,
  angle: THREE.Euler | THREE.Quaternion,
  opts?: Opts<TIntersected>
): Array<THREE.Intersection<TIntersected>> => {
  const {
    startLength,
    endLength,
    perIntersectFn,
    optionalTargetArr,
    recursive,
    directionForAngle,
    helperId,
    helperColor,
  } = opts || {};
  const angleDirection = getAngleDirectionPoint(angle, directionForAngle);
  (ray as THREE.Raycaster).set(from, angleDirection);
  const intersects = getRayCastIntersects({
    ray: ray as THREE.Raycaster,
    objects,
    startLength,
    endLength,
    perIntersectFn,
    optionalTargetArr,
    recursive,
  });
  if (statsEnabled) stats.add();
  // drawRayHelper({ from, to: angleDirection, endLength, helperId, helperColor });
  useDebug(debugGUI)?._drawRayHelper({
    from,
    to: angleDirection,
    endLength,
    helperId,
    helperColor,
  });
  return intersects;
};

const screenPos = new THREE.Vector2();

/**
 * Casts a ray from a screen position through the camera (picking), e.g. for mouse/touch input.
 * @param objects (THREE.Object3D | THREE.Object3D[]) object(s) to test against
 * @param ndcX (number) normalized device coordinate x, -1 (left) .. 1 (right)
 * @param ndcY (number) normalized device coordinate y, -1 (bottom) .. 1 (top)
 * @param camera (THREE.Camera) the camera the screen position is relative to (usually the one rendering)
 * @param opts ({@link Opts}) optional ray cast options (directionForAngle is ignored)
 * @returns (Array<THREE.Intersection>) intersections sorted by distance, closest first
 */
export const castRayFromScreenPosition = <TIntersected extends THREE.Object3D = THREE.Object3D>(
  objects: THREE.Object3D | THREE.Object3D[],
  ndcX: number,
  ndcY: number,
  camera: THREE.Camera,
  opts?: Opts<TIntersected>
): Array<THREE.Intersection<TIntersected>> => {
  const {
    startLength,
    endLength,
    perIntersectFn,
    optionalTargetArr,
    recursive,
    helperId,
    helperColor,
  } = opts || {};
  // Input events can arrive before initMainLoop has called initRayCasting
  if (!ray) ray = new THREE.Raycaster();
  ray.setFromCamera(screenPos.set(ndcX, ndcY), camera);
  const intersects = getRayCastIntersects({
    ray,
    objects,
    startLength,
    endLength,
    perIntersectFn,
    optionalTargetArr,
    recursive,
  });
  if (statsEnabled) stats.add();
  useDebug(debugGUI)?._drawRayHelper({
    from: ray.ray.origin,
    to: ray.ray.direction,
    endLength,
    helperId,
    helperColor,
  });
  return intersects;
};

// Stats

/** Ray cast statistics windows (per rendered frame) */
const stats = new IntervalCounterStats([
  { id: 'minMax3s', intervalMs: 3000, kind: 'MIN_MAX' },
  { id: 'minMax10s', intervalMs: 10000, kind: 'MIN_MAX' },
  { id: 'average3s', intervalMs: 3000, kind: 'AVERAGE' },
  { id: 'average20s', intervalMs: 20000, kind: 'AVERAGE' },
]);
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

/** Resets the ray cast statistics (eg. on scene enter). */
export const resetRayCastStats = () => {
  stats.reset();
};

/** Once per rendered frame (LATE_MAIN, after rendering): ends the stats frame, then runs the
 * debug side's frame end (helper cleanup, stats view refresh). */
const rayCastFrameEndSystem = () => {
  if (statsEnabled) stats.endFrame(performance.now());
  useDebug(debugGUI)?._onRayCastFrameEnd();
};

ECSWorld.registerPlugin((world) => {
  // Only the default world: LATE_MAIN runs once per world, and a frame must end only once
  if (world.id !== DEFAULT_ECS_WORLD_ID) return;
  world.addSystem(ECSSystemStage.LATE_MAIN, 'rayCastFrameEndSystem', rayCastFrameEndSystem, -1000);
});

// Debug
type RaycastGUIModule = typeof import('../core/Debug/_dbg__Raycast');
let debugGUI: DebugModuleRef<RaycastGUIModule> | null = null;

export const registerRaycastDebugGUI = async () => {
  debugGUI = await loadDebugModuleAsync(() => import('../core/Debug/_dbg__Raycast'));
};

export const deleteAllRayHelpers = () => {
  useDebug(debugGUI)?._deleteAllRayHelpers();
};
