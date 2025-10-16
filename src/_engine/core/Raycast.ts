import * as THREE from 'three/webgpu';
import { isDebugEnvironment } from './Config';
import { getRootScene } from './Scene';
import { DIRECTIONS } from '../utils/constants';
import { type Pane } from 'tweakpane';
import { lsGetItem, lsSetItem } from '../utils/LocalAndSessionStorage';
import { getSvgIcon } from './UI/icons/SvgIcon';
import { createDebuggerTab, createNewDebuggerPane, getDrawerState } from '../debug/DebuggerGUI';
import { TCMP } from '../utils/CMP';
import { PercentagePieHtml } from '../utils/PercentagePieHtml';

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
let ray: THREE.Raycaster | null = null;
let helperLineGeom: THREE.BufferGeometry | null = null;
let helperIds: string[] = [];
let drawnHelperIds: string[] = [];
const defaultDirectionForAngle = DIRECTIONS.FORWARD;
let rayCastDebugGUI: Pane | null = null;
let rayCastState = {
  showAllRayDebugHelpers: false,
  enableRayStatistics: false,
};
const DEFAULT_STATS = {
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
  _framesSceneAverage: 0,
  _framesSceneLongAverage: 0,
  _lastSceneMaxMinTime: 0,
  _lastSceneLongMaxMinTime: 0,
  _lastSceneAverageTime: 0,
  _lastSceneLongAverageTime: 0,
  _minCounter: Infinity,
  _maxCounter: 0,
  _minLongCounter: Infinity,
  _maxLongCounter: 0,
  _percentageSceneMaxMinInterval: 0,
  _percentageSceneLongMaxMinInterval: 0,
  _percentageSceneAverageInterval: 0,
  _percentageSceneLongAverageInterval: 0,
};
let stats = { ...DEFAULT_STATS };
const DEFAULT_STATS_CONFIG = {
  sceneMaxMinIntervalInMs: 3000,
  sceneLongMaxMinIntervalInMs: 10000,
  sceneAverageIntervalInMs: 3000,
  sceneLongAverageIntervalInMs: 20000,
};
const statsConfig = { ...DEFAULT_STATS_CONFIG };
let statsCMP: TCMP | null = null;
let maxMinIntervalText = '';
let maxMinLongIntervalText = '';
let averageIntervalText = '';
let averageLongIntervalText = '';

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
  countStats();
  if (!helperId || !rayCastState.showAllRayDebugHelpers) return;
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
    rayCastState.showAllRayDebugHelpers = !rayCastState.showAllRayDebugHelpers;
    buildRayCastDebugGUI();
    return;
  }
  rayCastState.showAllRayDebugHelpers = show;
  buildRayCastDebugGUI();
};

const createDebugControls = () => {
  const savedValues = lsGetItem(LS_KEY, rayCastState);
  rayCastState = {
    ...rayCastState,
    ...savedValues,
  };
  createIntervalTexts();

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
      statsCMP = container.add({ class: 'rayCastStats' }).add();
      if (!rayCastState.enableRayStatistics) disableStats();
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
    .addBinding(rayCastState, 'showAllRayDebugHelpers', { label: 'Show ray cast helpers' })
    .on('change', () => {
      lsSetItem(LS_KEY, rayCastState);
    });
  debugGUI
    .addBinding(rayCastState, 'enableRayStatistics', { label: 'Enable ray cast statistics' })
    .on('change', () => {
      stats._percentageSceneMaxMinInterval = 0;
      stats._percentageSceneLongMaxMinInterval = 0;
      stats._percentageSceneAverageInterval = 0;
      stats._percentageSceneLongAverageInterval = 0;
      stats._lastSceneMaxMinTime = performance.now();
      stats._lastSceneLongMaxMinTime = performance.now();
      stats._lastSceneAverageTime = performance.now();
      stats._lastSceneLongAverageTime = performance.now();
      stats.current = 0;
      stats.sceneAverageTotal = 0;
      stats.sceneLongAverageTotal = 0;
      lsSetItem(LS_KEY, rayCastState);
      disableStats();
    });
};

const countStats = () => {
  stats.current++;
  stats.sceneAverageTotal++;
  stats.sceneLongAverageTotal++;
};

export const countRayCastFrames = () => {
  if (!rayCastState.enableRayStatistics) return;
  stats._framesSceneAverage++;
  stats._framesSceneLongAverage++;
};

export const updateStats = () => {
  if (rayCastState.enableRayStatistics) {
    const timeNow = performance.now();
    let targetTime = 0;

    // Max/min rays
    targetTime = stats._lastSceneMaxMinTime + statsConfig.sceneMaxMinIntervalInMs;
    if (targetTime < timeNow) {
      stats.sceneMax = stats._maxCounter;
      stats.sceneMin = stats._minCounter;
      stats._maxCounter = 0;
      stats._minCounter = Infinity;
      stats._lastSceneMaxMinTime = performance.now();
      stats._percentageSceneMaxMinInterval = 0;
    } else {
      stats._percentageSceneMaxMinInterval = Math.min(
        100,
        Math.round(
          ((timeNow - stats._lastSceneMaxMinTime) / (targetTime - stats._lastSceneMaxMinTime)) * 100
        )
      );
    }

    // Max/min rays LONG
    targetTime = stats._lastSceneLongMaxMinTime + statsConfig.sceneLongMaxMinIntervalInMs;
    if (targetTime < timeNow) {
      stats.sceneMaxLong = stats._maxLongCounter;
      stats.sceneMinLong = stats._minLongCounter;
      stats._maxLongCounter = 0;
      stats._minLongCounter = Infinity;
      stats._lastSceneLongMaxMinTime = performance.now();
      stats._percentageSceneLongMaxMinInterval = 0;
    } else {
      stats._percentageSceneLongMaxMinInterval = Math.min(
        100,
        Math.round(
          ((timeNow - stats._lastSceneLongMaxMinTime) /
            (targetTime - stats._lastSceneLongMaxMinTime)) *
            100
        )
      );
    }

    // Average
    targetTime = stats._lastSceneAverageTime + statsConfig.sceneAverageIntervalInMs;
    if (targetTime < timeNow) {
      stats.sceneAverage = parseFloat(
        (stats.sceneAverageTotal / stats._framesSceneAverage).toFixed(2)
      );
      stats.sceneAverageTotal = 0;
      stats._framesSceneAverage = 0;
      stats._lastSceneAverageTime = performance.now();
      stats._percentageSceneAverageInterval = 0;
    } else {
      stats._percentageSceneAverageInterval = Math.min(
        100,
        Math.round(
          ((timeNow - stats._lastSceneAverageTime) / (targetTime - stats._lastSceneAverageTime)) *
            100
        )
      );
    }

    // Average LONG
    targetTime = stats._lastSceneLongAverageTime + statsConfig.sceneLongAverageIntervalInMs;
    if (targetTime < timeNow) {
      stats.sceneLongAverage = parseFloat(
        (stats.sceneLongAverageTotal / stats._framesSceneLongAverage).toFixed(2)
      );
      stats.sceneLongAverageTotal = 0;
      stats._framesSceneLongAverage = 0;
      stats._lastSceneLongAverageTime = performance.now();
      stats._percentageSceneLongAverageInterval = 0;
    } else {
      stats._percentageSceneLongAverageInterval = Math.min(
        100,
        Math.round(
          ((timeNow - stats._lastSceneLongAverageTime) /
            (targetTime - stats._lastSceneLongAverageTime)) *
            100
        )
      );
    }

    // Update Ray Cast Controls drawer view
    const drawerState = getDrawerState();
    // @TODO: if stats window and total stats (with ray stats) are implemented, add checks for those as well here
    if (drawerState.isOpen && drawerState.currentTabId === 'rayCastControls') {
      statsCMP?.update({
        html: statsHtml(stats, 'active'),
      });
    }
  }

  if (stats.current > stats._maxCounter) stats._maxCounter = stats.current;
  if (stats.current < stats._minCounter) stats._minCounter = stats.current;
  if (stats.current > stats._maxLongCounter) stats._maxLongCounter = stats.current;
  if (stats.current < stats._minLongCounter) stats._minLongCounter = stats.current;
  if (stats.current > stats.sceneMaxEver) stats.sceneMaxEver = stats.current;
  stats.current = 0;
};

const statsHtml = (s: typeof stats, className: string) => `<div>
  <h3>Stats:</h3>
  <ul class="${className}">
    <li><span class="rayStatLabel">Current rays:</span> ${s.current}</li>
    <li class="rayStatHeading">Average per frame</li>
    <li><span class="rayStatLabel">${averageIntervalText}: ${PercentagePieHtml(s._percentageSceneAverageInterval)}</span> ${s.sceneAverage}</li>
    <li><span class="rayStatLabel">${averageLongIntervalText}: ${PercentagePieHtml(s._percentageSceneLongAverageInterval)}</span> ${s.sceneLongAverage}</li>
    <li class="rayStatHeading">Maximum per frame</li>
    <li><span class="rayStatLabel">Ever:</span> ${s.sceneMaxEver}</li>
    <li><span class="rayStatLabel">${maxMinIntervalText}: ${PercentagePieHtml(s._percentageSceneMaxMinInterval)}</span> ${s.sceneMax}</li>
    <li><span class="rayStatLabel">${maxMinLongIntervalText}: ${PercentagePieHtml(s._percentageSceneLongMaxMinInterval)}</span> ${s.sceneMaxLong}</li>
    <li class="rayStatHeading">Minimum per frame</li>
    <li><span class="rayStatLabel">${maxMinIntervalText}: ${PercentagePieHtml(s._percentageSceneMaxMinInterval)}</span> ${s.sceneMin}</li>
    <li><span class="rayStatLabel">${maxMinLongIntervalText}: ${PercentagePieHtml(s._percentageSceneLongMaxMinInterval)}</span> ${s.sceneMinLong}</li>
  </ul>
</div>`;

const disableStats = () => {
  statsCMP?.update({
    html: statsHtml(
      {
        ...stats,
        current: '-',
      } as unknown as typeof stats,
      'inactive'
    ),
  });
};

const createIntervalTexts = () => {
  const maxMin = statsConfig.sceneMaxMinIntervalInMs / 1000;
  const maxMinLong = statsConfig.sceneLongMaxMinIntervalInMs / 1000;
  const average = statsConfig.sceneAverageIntervalInMs / 1000;
  const averageLong = statsConfig.sceneLongAverageIntervalInMs / 1000;
  maxMinIntervalText = `Last ${maxMin}s`;
  maxMinLongIntervalText = `Last ${maxMinLong}s`;
  averageIntervalText = `Last ${average}s`;
  averageLongIntervalText = `Last ${averageLong}s`;
};

export const resetRayCastStats = () => (stats = { ...DEFAULT_STATS });
