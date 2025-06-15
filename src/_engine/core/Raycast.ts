import * as THREE from 'three/webgpu';
import { isDebugEnvironment } from './Config';
import { getRootScene } from './Scene';

type Opts<TIntersected extends THREE.Object3D = THREE.Object3D> = {
  startLength?: number;
  endLength?: number;
  perIntersectFn?: (intersect: THREE.Intersection<TIntersected>) => void | boolean;
  helperId?: string;
  helperColor?: THREE.ColorRepresentation;
  optionalTargetArr?: Array<THREE.Intersection<TIntersected>>;
  recursive?: boolean;
};

const DEFAULT_HELPER_COLOR = '#ff0000';
const DEFAULT_MAX_HELPER_LENGTH = 1000;
let ray: THREE.Raycaster | null = null;
// let vec3: THREE.Vector3 | null = null;
let helperLineGeom: THREE.BufferGeometry | null = null;
let helperIds: string[] = [];
let drawnHelperIds: string[] = [];

export const initRayCasting = () => {
  ray = new THREE.Raycaster();
  // vec3 = new THREE.Vector3();
  if (isDebugEnvironment()) {
    helperLineGeom = new THREE.BufferGeometry();
    castRayFromPoints = _castRayFromPointsDebug;
  }
};

export const cleanUpRayHelpers = () => {
  const lines = (getRootScene() as THREE.Scene).children.filter(
    (line) => line.userData.isRayHelper
  );
  // const stillActiveIds = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as THREE.Line;
    if (!drawnHelperIds.includes(line.userData.helperId)) {
      // Remove because not anymore drawn
      helperIds = helperIds.filter((id) => id !== line.userData.helperId);
      line.geometry.dispose();
      line.removeFromParent();
    }
    // if (helperIds.includes(line.userData.helperId)) {
    //   stillActiveIds.push(line.userData.helperId);
    // }
    // if (!helperIds.includes(line.userData.helperId)) {
    //   line.geometry.dispose();
    //   line.removeFromParent();
    // }
  }
  helperIds = [...drawnHelperIds];
  drawnHelperIds = [];
};

export const deleteAllRayHelpers = () => {
  if (!isDebugEnvironment()) return;
  const lines = (getRootScene() as THREE.Scene).children.filter(
    (line) => line.userData.isRayHelper
  );
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as THREE.Line;
    line.geometry.dispose();
    line.removeFromParent();
  }
  helperIds = [];
};

export let castRayFromPoints = <TIntersected extends THREE.Object3D = THREE.Object3D>(
  objects: THREE.Object3D | THREE.Object3D[],
  from: THREE.Vector3,
  direction: THREE.Vector3,
  opts?: Opts<TIntersected>
): Array<THREE.Intersection<TIntersected>> => {
  const { startLength, endLength, perIntersectFn, optionalTargetArr, recursive } = opts || {};
  (ray as THREE.Raycaster).set(from, direction);
  let intersects: Array<THREE.Intersection<TIntersected>>;
  if (Array.isArray(objects)) {
    // intersectObjects (multiple objects)
    intersects = (ray as THREE.Raycaster).intersectObjects(objects, recursive, optionalTargetArr);
  } else {
    // intersectObject (one object)
    intersects = (ray as THREE.Raycaster).intersectObject(objects, recursive, optionalTargetArr);
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

const _castRayFromPointsDebug = <TIntersected extends THREE.Object3D = THREE.Object3D>(
  objects: THREE.Object3D | THREE.Object3D[],
  from: THREE.Vector3,
  direction: THREE.Vector3,
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
  (ray as THREE.Raycaster).set(from, direction);
  let intersects: Array<THREE.Intersection<TIntersected>>;
  if (Array.isArray(objects)) {
    // intersectObjects (multiple objects)
    intersects = (ray as THREE.Raycaster).intersectObjects(objects, recursive, optionalTargetArr);
  } else {
    // intersectObject (one object)
    intersects = (ray as THREE.Raycaster).intersectObject(objects, recursive, optionalTargetArr);
  }
  if (helperId) {
    const rootScene = getRootScene() as THREE.Scene;
    if (helperIds.includes(helperId)) {
      // Update helper
      const rayLine = rootScene.children.find(
        (line) => line.userData.helperId === helperId
      ) as THREE.Line;
      rayLine.geometry.setFromPoints([
        from,
        from.clone().add(direction.clone().multiplyScalar(endLength || DEFAULT_MAX_HELPER_LENGTH)),
      ]);
    } else {
      // Create the helper
      const geo = (helperLineGeom as THREE.BufferGeometry)
        .clone()
        .setFromPoints([
          from,
          from
            .clone()
            .add(direction.clone().multiplyScalar(endLength || DEFAULT_MAX_HELPER_LENGTH)),
        ]);
      const rayLine = new THREE.Line(
        geo,
        new THREE.LineBasicMaterial({ color: helperColor || DEFAULT_HELPER_COLOR })
      );
      rayLine.userData.isRayHelper = true;
      rayLine.userData.helperId = helperId;
      rootScene.add(rayLine);
    }
    helperIds.push(helperId);
    drawnHelperIds.push(helperId);
  }
  if (perIntersectFn) {
    for (let i = 0; i < intersects.length; i++) {
      const int = intersects[i];
      if (startLength && startLength > int.distance) continue;
      if (endLength && endLength < int.distance) return intersects;
      if (perIntersectFn(int)) break;
    }
  }
  return intersects;
};
