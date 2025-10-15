import * as THREE from 'three/webgpu';
import { isDebugEnvironment } from './Config';
import { getRootScene, registerOnSceneExit } from './Scene';
import { DIRECTIONS } from '../utils/constants';
import { Pane } from 'tweakpane';
import { lsGetItem } from '../utils/LocalAndSessionStorage';
import { getSvgIcon } from './UI/icons/SvgIcon';
import { createDebuggerTab, createNewDebuggerPane, getDrawerState } from '../debug/DebuggerGUI';
import { TCMP } from '../utils/CMP';

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

const DEFAULT_HELPER_COLOR = '#ff0000';
const DEFAULT_MAX_HELPER_LENGTH = 1000;
const LS_KEY = 'debugRayCast';
let HIDE_ALL_DEBUG_HELPERS = false;
let ray: THREE.Raycaster | null = null;
let helperLineGeom: THREE.BufferGeometry | null = null;
let helperIds: string[] = [];
let drawnHelperIds: string[] = [];
const defaultDirectionForAngle = DIRECTIONS.FORWARD;
let rayCastDebugGUI: Pane | null = null;
let rayCastState = {};
const stats = {
  current: 0,
  sceneMaxEver: 0,
  sceneMax: 0,
  sceneMin: 0,
  sceneMaxLong: 0,
  sceneMinLong: 0,
  sceneAverage: 0,
  sceneAverageTotal: 0,
  sceneLongAverage: 0,
  sceneLongAverageTotal: 0,
  _framesSceneMaxMin: 0,
  _framesSceneLongMaxMin: 0,
  _framesSceneAverage: 0,
  _framesSceneLongAverage: 0,
  _lastSceneMaxMinTime: 0,
  _lastSceneLongMaxMinTime: 0,
  _lastSceneAverageTime: 0,
  _lastSceneLongAverageTime: 0,
};
const DEFAULT_STATS_CONFIG = {
  sceneMaxMinIntervalInMs: 3000,
  sceneLongMaxMinIntervalInMs: 10000,
  sceneAverageInMs: 3000,
  sceneLongAverageInMs: 20000,
};
const statsConfig = { ...DEFAULT_STATS_CONFIG };
let statsCMP: TCMP | null = null;

export const initRayCasting = () => {
  ray = new THREE.Raycaster();
  if (isDebugEnvironment()) {
    helperLineGeom = new THREE.BufferGeometry();
    castRayFromPoints = _castRayFromPointsDebug;
    castRayFromAngle = _castRayFromAngleDebug;
    createDebugControls();
  }
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

export let castRayFromPoints = <TIntersected extends THREE.Object3D = THREE.Object3D>(
  objects: THREE.Object3D | THREE.Object3D[],
  from: THREE.Vector3,
  to: THREE.Vector3,
  opts?: Opts<TIntersected>
): Array<THREE.Intersection<TIntersected>> => {
  const { startLength, endLength, perIntersectFn, optionalTargetArr, recursive } = opts || {};
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
  return intersects;
};

const _castRayFromPointsDebug = <TIntersected extends THREE.Object3D = THREE.Object3D>(
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
  drawRayHelper({ from, to, endLength, helperId, helperColor });
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

export let castRayFromAngle = <TIntersected extends THREE.Object3D = THREE.Object3D>(
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
  return intersects;
};

const _castRayFromAngleDebug = <TIntersected extends THREE.Object3D = THREE.Object3D>(
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
  drawRayHelper({ from, to: angleDirection, endLength, helperId, helperColor });
  return intersects;
};

// Debug stuff *******************

const drawRayHelper = ({
  from,
  to,
  endLength,
  helperId,
  helperColor,
}: {
  from: THREE.Vector3;
  to: THREE.Vector3;
  endLength?: number;
  helperId?: string;
  helperColor?: THREE.ColorRepresentation;
}) => {
  stats.current++;
  stats._framesSceneMaxMin++;
  stats._framesSceneLongMaxMin++;
  stats._framesSceneAverage++;
  stats._framesSceneLongAverage++;
  if (!helperId || HIDE_ALL_DEBUG_HELPERS) return;
  const rootScene = getRootScene() as THREE.Scene;
  if (helperIds.includes(helperId)) {
    // Update helper
    const rayLine = rootScene.children.find(
      (line) => line.userData.helperId === helperId
    ) as THREE.Line;
    rayLine.geometry.setFromPoints([
      from,
      from.clone().add(to.clone().multiplyScalar(endLength || DEFAULT_MAX_HELPER_LENGTH)),
    ]);
  } else {
    // Create the helper
    const geo = (helperLineGeom as THREE.BufferGeometry)
      .clone()
      .setFromPoints([
        from,
        from.clone().add(to.clone().multiplyScalar(endLength || DEFAULT_MAX_HELPER_LENGTH)),
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
};

export const cleanUpRayHelpers = () => {
  const lines = (getRootScene() as THREE.Scene).children.filter(
    (line) => line.userData.isRayHelper
  );
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as THREE.Line;
    if (!drawnHelperIds.includes(line.userData.helperId)) {
      helperIds = helperIds.filter((id) => id !== line.userData.helperId);
      line.geometry.dispose();
      line.removeFromParent();
    }
  }
  helperIds = [...drawnHelperIds];
  drawnHelperIds = [];
  updateStats();
  stats.current = 0;
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

export const toggleAllRayDebugHelpers = (show?: boolean) => {
  if (show === undefined) {
    HIDE_ALL_DEBUG_HELPERS = !HIDE_ALL_DEBUG_HELPERS;
    return;
  }
  HIDE_ALL_DEBUG_HELPERS = show;
};

const createDebugControls = () => {
  const savedValues = lsGetItem(LS_KEY, rayCastState);
  rayCastState = {
    ...rayCastState,
    ...savedValues,
  };

  const icon = getSvgIcon('heartArrow');
  createDebuggerTab({
    id: 'rayCastControls',
    buttonText: icon,
    title: 'Ray cast controls',
    orderNr: 10,
    container: () => {
      const { container, debugGUI } = createNewDebuggerPane('rayCast', `${icon} Ray Cast Controls`);
      rayCastDebugGUI = debugGUI;
      buildRayCastDebugGUI();
      statsCMP = container.add({ class: 'rayCastStats' }).add({ text: '' });
      return container;
    },
  });
};

export const buildRayCastDebugGUI = () => {
  const debugGUI = rayCastDebugGUI;
  if (!debugGUI) return;

  const blades = debugGUI?.children || [];
  for (let i = 0; i < blades.length; i++) {
    blades[i].dispose();
  }

  debugGUI
    .addButton({ title: 'Hide / show all ray cast helpers' })
    .on('click', toggleAllRayHelpers);
};

export const toggleAllRayHelpers = () => {
  console.log('Tadaa');
};

export const updateStats = () => {
  // const timeNow = performance.now();

  const current = stats.current;

  // current
  // if (stats._lastCurrentTime + statsConfig.currentIntervalInMs < timeNow) {
  //   stats._lastCurrentTime = performance.now();
  // }

  // Update Ray Cast Controls drawer view
  const drawerState = getDrawerState();
  // @TODO: if stats window and total stats (with ray stats) are implemented, add checks for those as well here
  if (drawerState.isOpen && drawerState.currentTabId === 'rayCastControls') {
    statsCMP?.update({
      html: `<div>
  Current rays: ${current}<br />
  Max rays (last ${statsConfig.sceneMaxMinIntervalInMs} ms): ${stats.sceneMax}<br />
  Min rays (last ${statsConfig.sceneMaxMinIntervalInMs} ms): ${stats.sceneMin}<br />
</div>`,
    });
  }
};
