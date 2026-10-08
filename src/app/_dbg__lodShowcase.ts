import * as THREE from 'three/webgpu';
import { cameraLookAtPoint } from '../_engine/core/CameraManager';
import { getECSWorld, getEntityIdByAppId } from '../_engine/core/ECS';
import { ComponentType } from '../_engine/core/ECS/ECSCoreComponents';
import { getLodFrameStats, getLodWorldSphere } from '../_engine/core/Lod/LodSystem';
import { createSceneAppLooper } from '../_engine/core/Scene';
import {
  getTimeOfDay,
  isDayNightPlaying,
  pauseDayNight,
  playDayNight,
  setTimeOfDay,
} from '../_engine/core/SkyBox/SkyBox';
import {
  createDebuggerTab,
  debuggerListCMP,
  openDebuggerTab,
  persistDebuggerTabValue,
  updateDebuggerTab,
} from '../_engine/debug/DebuggerGUI';
import {
  isProfilerAvailable,
  isProfilerWindowOpen,
  toggleProfilerWindow,
} from '../_engine/debug/Profiler';
import {
  addShowcaseEnterListener,
  getShowcaseLanes,
  getShowcaseStartCamera,
  LOD_SHOWCASE_SCENE_ID,
  SHOWCASE_CAMERA_APP_ID,
  SHOWCASE_START_TIME_OF_DAY,
  type ShowcaseLaneEntry,
} from './lodShowcase';

const TAB_ID = 'lodShowcaseDemo';
const LS_KEY = 'AEK_debugLodShowcase';
/** The engine's LOD tab (core/Debug/_dbg__LOD.ts). */
const LOD_TAB_ID = 'lodControls';

/** How far the dolly runs down the lanes before it turns back. */
const DOLLY_LENGTH = 240;
/** A switch stop's camera distance from its object, as a share of the switch distance: just
 * inside shows the finer level, just past the coarser one (past the 10 % hysteresis). */
const SIDE_FACTORS = { INSIDE: 0.95, PAST: 1.15 } as const;
type StopSide = keyof typeof SIDE_FACTORS;

type Pose = { position: THREE.Vector3; target: THREE.Vector3 };
type CameraStop = { id: string; label: string; getPose: (side: StopSide) => Pose | null };

const state = {
  /** The camera stop (persisted). */
  stop: 'start',
  /** Which side of a switch a switch stop stands on (persisted). */
  side: 'INSIDE' as StopSide,
  dollySpeed: 15,
  dollyStatus: 'stopped',
  timeOfDay: SHOWCASE_START_TIME_OF_DAY,
  dayNightPlaying: false,
  fading: 0,
};

const dolly = { running: false, travelled: 0 };
const _sphere = new THREE.Sphere();
const _forward = new THREE.Vector3();

const getStartPose = (): Pose | null => {
  const start = getShowcaseStartCamera();
  if (!start) return null;
  start.getWorldDirection(_forward);
  return {
    position: start.position.clone(),
    target: start.position.clone().addScaledVector(_forward, 50),
  };
};

/** Moves the scene's camera (its Transform) to `pose`. */
const setCameraPose = ({ position, target }: Pose) => {
  const world = getECSWorld();
  const id = getEntityIdByAppId(SHOWCASE_CAMERA_APP_ID, world);
  if (id === undefined) return;
  const transform = world.getComponent(id, ComponentType.TRANSFORM);
  if (!transform) return;
  transform.position.copy(position);
  transform.setDirty();
  world.commitTransform(id, transform);
  cameraLookAtPoint(id, target, world);
};

/**
 * A switch's stop: the camera on the line from the start camera to the lane's first object past
 * the switch (as the start camera sees it), the switch distance × the side's factor from it,
 * looking at it. The other objects of the lane stand behind it.
 */
const getSwitchPose = (entry: ShowcaseLaneEntry, index: number, side: StopSide) => {
  const start = getShowcaseStartCamera();
  const distance = entry.state.switchDistances[index];
  if (!start) return null;
  const world = getECSWorld();
  let best: THREE.Vector3 | null = null;
  let bestDistance = Infinity;
  for (const id of entry.state.getEntityIds()) {
    const lod = world.getComponent(id, ComponentType.LOD);
    if (!lod || !getLodWorldSphere(id, lod, world, _sphere)) continue;
    const d = _sphere.center.distanceTo(start.position);
    if (d > distance && d < bestDistance) {
      bestDistance = d;
      best = _sphere.center.clone();
    }
  }
  if (!best) return null;
  const toStart = start.position.clone().sub(best).normalize();
  return {
    position: best.clone().addScaledVector(toStart, distance * SIDE_FACTORS[side]),
    target: best,
  };
};

const getStops = (): CameraStop[] => {
  const stops: CameraStop[] = [
    { id: 'start', label: 'Start view', getPose: getStartPose },
    {
      id: 'overhead',
      label: 'Overhead',
      getPose: () => ({
        position: new THREE.Vector3(0, 140, -40),
        target: new THREE.Vector3(0, 0, -120),
      }),
    },
  ];
  const world = getECSWorld();
  for (const entry of [...getShowcaseLanes()].sort((a, b) => a.x - b.x)) {
    const firstId = entry.state
      .getEntityIds()
      .find((id) => world.hasComponent(id, ComponentType.LOD));
    const levelCount =
      firstId === undefined
        ? 0
        : world.getComponent(firstId, ComponentType.LOD)?.def.levels.length ?? 0;
    entry.state.switchDistances.forEach((distance, i) => {
      const what = i < levelCount - 1 ? `level ${i} → ${i + 1}` : 'hides';
      stops.push({
        id: `${entry.lane.id}:${i}`,
        label: `${entry.lane.title}: ${what} (${distance.toFixed(0)} m)`,
        getPose: (side) => getSwitchPose(entry, i, side),
      });
    });
  }
  return stops;
};

const applyStop = () => {
  const stops = getStops();
  const stop = stops.find((s) => s.id === state.stop) ?? stops[0];
  state.stop = stop.id;
  const pose = stop.getPose(state.side);
  if (pose) setCameraPose(pose);
};

/** The camera stops' ids and labels (switch stops are `${laneId}:${switch index}`). */
export const getShowcaseCameraStops = () => getStops().map(({ id, label }) => ({ id, label }));

/** Moves the camera to a stop (and side), as the tab's Stop does, and saves it. */
export const setShowcaseCameraStop = (id: string, side: StopSide = state.side) => {
  stopShowcaseDolly();
  state.stop = id;
  state.side = side;
  applyStop();
  persistDebuggerTabValue(TAB_ID, 'stop');
  persistDebuggerTabValue(TAB_ID, 'side');
  updateDebuggerTab(TAB_ID);
};

/** Runs the dolly from the start view down the lanes and back (the same path every run), at the
 * tab's speed. */
export const startShowcaseDolly = () => {
  dolly.running = true;
  dolly.travelled = 0;
};

/** Stops the dolly where it is. */
export const stopShowcaseDolly = () => {
  dolly.running = false;
};

export const isShowcaseDollyRunning = () => dolly.running;

const dollyLooper = (delta: number) => {
  if (!dolly.running) return;
  const startPose = getStartPose();
  if (!startPose) return;
  dolly.travelled += state.dollySpeed * delta;
  if (dolly.travelled >= DOLLY_LENGTH * 2) {
    dolly.running = false;
    dolly.travelled = 0;
    setCameraPose(startPose);
    return;
  }
  const offset =
    dolly.travelled <= DOLLY_LENGTH ? dolly.travelled : DOLLY_LENGTH * 2 - dolly.travelled;
  startPose.position.z -= offset;
  startPose.target.z -= offset;
  setCameraPose(startPose);
};

const getDollyStatus = () => {
  if (!dolly.running) return 'stopped';
  const out = dolly.travelled <= DOLLY_LENGTH;
  const offset = out ? dolly.travelled : DOLLY_LENGTH * 2 - dolly.travelled;
  return `${out ? 'out' : 'back'}, ${offset.toFixed(0)} m`;
};

/** A geometry's triangles. */
const getTriangles = (geometry: THREE.BufferGeometry) =>
  Math.floor((geometry.index ? geometry.index.count : geometry.attributes.position.count) / 3);

/** A lane's row: its entities per level shown, and the triangles of what they show (the main
 * pass, before frustum culling; a fading entity's outgoing copy not counted). */
const getLaneRow = (entry: ShowcaseLaneEntry) => {
  const world = getECSWorld();
  const perLevel: number[] = [];
  let culled = 0;
  let fading = 0;
  let noLod = 0;
  let triangles = 0;
  for (const id of entry.state.getEntityIds()) {
    const lod = world.getComponent(id, ComponentType.LOD);
    if (world.hasComponent(id, ComponentType.TAG_LOD_TRANSITIONING)) fading++;
    const isCulled = world.hasComponent(id, ComponentType.TAG_LOD_CULLED);
    if (!lod) noLod++;
    else if (isCulled) culled++;
    else perLevel[lod.applied] = (perLevel[lod.applied] ?? 0) + 1;
    if (isCulled && !world.hasComponent(id, ComponentType.TAG_LOD_TRANSITIONING)) continue;
    const slot = world.getComponent(id, ComponentType.INSTANCED_MESH_SLOT);
    if (slot) {
      if (slot.index >= 0) triangles += getTriangles(slot.mesh.geometry);
      continue;
    }
    const obj = world.getComponent(id, ComponentType.OBJECT3D)?.value;
    if (obj instanceof THREE.Mesh) {
      const count = (obj as THREE.InstancedMesh).isInstancedMesh
        ? (obj as THREE.InstancedMesh).count
        : 1;
      triangles += getTriangles(obj.geometry) * count;
    }
  }
  const levels = perLevel
    .map((count, level) => (count ? `L${level} ${count}` : ''))
    .filter(Boolean);
  if (culled) levels.push(`culled ${culled}`);
  if (noLod) levels.push(`no LOD ${noLod}`);
  if (fading) levels.push(`fading ${fading}`);
  return {
    itemId: entry.lane.id,
    title: entry.lane.title,
    subTitle: `[x ${entry.x}] ${entry.state.switchDistances.map((d) => `${d.toFixed(0)} m`).join(' · ')}`,
    suffix: `${triangles.toLocaleString('en-US')} tris`,
    description: levels.join(' · '),
    tooltip: entry.lane.description,
  };
};

/**
 * The lodShowcase scene's "LOD demo" tab (a scene tab: removed on the scene's exit, created again
 * on every visit): camera stops (the start view, overhead, and both sides of every lane's switch),
 * a dolly down the lanes and back, the time of day, each lane's entities per level and triangles,
 * and shortcuts to the LOD tab and the profiler. Only the camera stop is persisted, and applied
 * again on the scene's enter.
 */
export const createLodShowcaseTab = () => {
  dolly.running = false;
  dolly.travelled = 0;
  createSceneAppLooper(dollyLooper, LOD_SHOWCASE_SCENE_ID);

  const stopOptions = () =>
    Object.fromEntries(getStops().map((stop) => [stop.label, stop.id])) as Record<string, string>;

  createDebuggerTab({
    id: TAB_ID,
    title: 'LOD demo',
    icon: 'easel',
    sceneId: LOD_SHOWCASE_SCENE_ID,
    lsKey: LS_KEY,
    state,
    persistKeys: ['stop', 'side'],
    onClearLS: () => {
      state.stop = 'start';
      state.side = 'INSIDE';
      applyStop();
      updateDebuggerTab(TAB_ID);
    },
    refreshIntervalMs: 250,
    onRefresh: () => {
      state.dollyStatus = getDollyStatus();
      state.timeOfDay = getTimeOfDay() ?? state.timeOfDay;
      state.dayNightPlaying = isDayNightPlaying();
      state.fading = getLodFrameStats(getECSWorld()).fading;
    },
    content: () => [
      {
        pane: true,
        content: [
          {
            type: 'folder',
            title: 'Camera',
            content: [
              {
                key: 'stop',
                label: 'Stop',
                options: stopOptions(),
                onChange: () => {
                  stopShowcaseDolly();
                  applyStop();
                },
              },
              {
                key: 'side',
                label: 'Switch side',
                options: { 'Just inside (finer)': 'INSIDE', 'Just past (coarser)': 'PAST' },
                onChange: () => {
                  stopShowcaseDolly();
                  applyStop();
                },
              },
              {
                type: 'button',
                title: 'Go to the stop',
                label: 'Camera',
                onClick: () => {
                  stopShowcaseDolly();
                  applyStop();
                },
              },
            ],
          },
          {
            type: 'folder',
            title: 'Dolly',
            content: [
              { key: 'dollySpeed', label: 'Speed (m/s)', min: 1, max: 60, step: 1 },
              { key: 'dollyStatus', label: 'Dolly', readonly: true },
              {
                type: 'button',
                title: 'Run',
                label: `Down the lanes (${DOLLY_LENGTH} m) and back`,
                onClick: startShowcaseDolly,
              },
              {
                type: 'button',
                title: 'Stop',
                label: 'Where it is',
                onClick: stopShowcaseDolly,
              },
            ],
          },
          {
            type: 'folder',
            title: 'Time of day',
            content: [
              {
                key: 'timeOfDay',
                label: 'Hours',
                min: 0,
                max: 23.99,
                step: 0.25,
                onChange: (value) => setTimeOfDay(Number(value)),
              },
              { key: 'dayNightPlaying', label: 'Playing', readonly: true },
              { type: 'button', title: 'Play', label: 'Day-night', onClick: playDayNight },
              { type: 'button', title: 'Pause', label: 'Day-night', onClick: pauseDayNight },
            ],
          },
          { key: 'fading', label: 'Fading now', readonly: true, format: (v: number) => `${v}` },
          {
            type: 'button',
            title: 'LOD tab',
            label: 'Overlay, bias, forced level, fades, impostors',
            onClick: () => openDebuggerTab(LOD_TAB_ID),
          },
          {
            type: 'button',
            title: 'Profiler',
            label: 'GPU time, triangles, draws',
            disabled: () => !isProfilerAvailable(),
            onClick: () => {
              if (!isProfilerWindowOpen()) toggleProfilerWindow();
            },
          },
        ],
      },
      debuggerListCMP({
        id: 'lodShowcaseLanes',
        heading: 'Lanes, left to right',
        emptyText: 'No lanes.',
        data: () => [...getShowcaseLanes()].sort((a, b) => a.x - b.x).map(getLaneRow),
      }),
    ],
  });

  // The saved stop, once the scene's JSON objects exist
  addShowcaseEnterListener(() => {
    if (state.stop !== 'start') applyStop();
  });
};
