import * as THREE from 'three/webgpu';
import { DIRECTIONS } from '../utils/constants';
import { DebugModuleRef, loadDebugModuleAsync, useDebug } from '../utils/helpers';

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
  useDebug(debugGUI)?.initRayCastingDebugger();
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
  // drawRayHelper({ from, to, endLength, helperId, helperColor });
  useDebug(debugGUI)?.drawRayHelper({ from, to, endLength, helperId, helperColor });
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
  // drawRayHelper({ from, to: angleDirection, endLength, helperId, helperColor });
  useDebug(debugGUI)?.drawRayHelper({ from, to: angleDirection, endLength, helperId, helperColor });
  return intersects;
};

// Debug
type RaycastGUIModule = typeof import('../core/Debug/_dbg__Raycast');
let debugGUI: DebugModuleRef<RaycastGUIModule> | null = null;

export const registerRaycastDebugGUI = async () => {
  debugGUI = await loadDebugModuleAsync(() => import('../core/Debug/_dbg__Raycast'));
};

export const countRayCastFrames = () => {
  useDebug(debugGUI)?.countRayCastFrames();
};

export const deleteAllRayHelpers = () => {
  useDebug(debugGUI)?.deleteAllRayHelpers();
};

export const resetRayCastStats = () => {
  useDebug(debugGUI)?.resetRayCastStats();
};

export const cleanUpRayHelpers = () => {
  useDebug(debugGUI)?.cleanUpRayHelpers();
};
