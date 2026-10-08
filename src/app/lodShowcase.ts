import type * as THREE from 'three/webgpu';
import { IS_DEBUG_ENV } from '../_engine/core/Config';
import { getECSWorld } from '../_engine/core/ECS';
import { createMaterial } from '../_engine/core/Material';
import { createMeshEntity } from '../_engine/core/MeshManager';
import { getRootScene, registerOnSceneEnter, type SceneData } from '../_engine/core/Scene';
import { getLoaderStatusUpdater } from '../_engine/core/SceneLoader';
import { pauseDayNight, setTimeOfDay } from '../_engine/core/SkyBox/SkyBox';
import { existsOrThrow } from '../_engine/utils/assert';
import {
  createLaneContext,
  getStartCamera,
  LANE_FAR_DISTANCE,
  type ShowcaseLane,
  type ShowcaseLaneState,
} from './lodShowcase/layout';
import { handMadeLevelsLane } from './lodShowcase/lanes/handMadeLevels';
import { generatedChainLane } from './lodShowcase/lanes/generatedChain';
import { treeGroveLane } from './lodShowcase/lanes/treeGrove';
import { instanceCellLane } from './lodShowcase/lanes/instanceCell';
import { knotImpostorLane } from './lodShowcase/lanes/knotImpostor';
import { rockImpostorsLane } from './lodShowcase/lanes/rockImpostors';

export const LOD_SHOWCASE_SCENE_ID = 'lodShowcase';
/** lodShowcaseCamera.camera.json: the lanes are laid out from its pose. */
export const SHOWCASE_CAMERA_APP_ID = 'lodShowcaseCamera';

/** The time of day the sky holds on every enter (the demo tab plays it). */
export const SHOWCASE_START_TIME_OF_DAY = 15;
const LANE_SPACING = 8;
/** Slots side by side, centred on the camera: lane `slot` stands at x = (slot - 2.5) × spacing. */
const LANE_SLOT_COUNT = 6;
/**
 * The lanes and their slots: a later plan adds a lane with a module and an entry here. A lane
 * whose finest level needs the camera close (lane 2's, within 21 m) takes a centre slot: an outer
 * lane only comes into view farther down (lodShowcase/layout.ts).
 */
const LANES: { lane: ShowcaseLane; slot: number }[] = [
  { lane: treeGroveLane, slot: 0 },
  { lane: handMadeLevelsLane, slot: 1 },
  { lane: generatedChainLane, slot: 2 },
  { lane: knotImpostorLane, slot: 3 },
  { lane: rockImpostorsLane, slot: 4 },
  { lane: instanceCellLane, slot: 5 },
];

export type ShowcaseLaneEntry = { lane: ShowcaseLane; x: number; state: ShowcaseLaneState };

let laneEntries: ShowcaseLaneEntry[] = [];
let startCamera: THREE.PerspectiveCamera | null = null;
let enterListeners: (() => void)[] = [];

/** The current visit's lanes, with what each one created. */
export const getShowcaseLanes = (): readonly ShowcaseLaneEntry[] => laneEntries;

/** The start camera's pose, from its JSON (a private camera: never the scene's own). */
export const getShowcaseStartCamera = () => startCamera;

/** Runs `fn` when the current visit's scene enter runs (after the JSON objects and the sky box
 * exist). The listeners are dropped on every load. */
export const addShowcaseEnterListener = (fn: () => void) => enterListeners.push(fn);

/**
 * The LOD showcase (docs/plans/_DONE_p351_impostor-billboard-lod.md Phase 5): the LOD system lane by lane,
 * side by side along x, each lane running away from the start camera along -z with an object in
 * every level band (lodShowcase/layout.ts), so every level of every lane is on screen at once. The
 * camera and the `dayNight` sky box (which owns the lights) come from `lodShowcase.scene.json`. In
 * the debug env the scene creates its own "LOD demo" tab (removed on exit).
 */
export const scene = async ({ sceneData }: { sceneData: SceneData }) => {
  const updateLoaderFn = getLoaderStatusUpdater();
  updateLoaderFn({ loadedCount: 0, totalCount: LANES.length + 1 });

  const world = getECSWorld();
  const rootScene = existsOrThrow(getRootScene(), 'The lodShowcase scene needs the root scene.');
  const camera = getStartCamera(sceneData, SHOWCASE_CAMERA_APP_ID);
  startCamera = camera;
  enterListeners = [];

  const groundDepth = LANE_FAR_DISTANCE + 20;
  createMeshEntity(
    {
      geo: {
        type: 'BOX',
        params: { width: LANE_SPACING * LANE_SLOT_COUNT + 100, height: 0.2, depth: groundDepth },
      },
      mat: createMaterial({
        id: 'lodShowcaseGroundMat',
        type: 'STANDARD',
        params: { color: '#6f7468', roughness: 0.95, metalness: 0 },
      }),
      // From just behind the camera to the lanes' far end
      position: { x: 0, y: -0.1, z: camera.position.z + 10 - groundDepth / 2 },
      receiveShadow: true,
    },
    { appId: 'lodShowcaseGround', debugData: { name: 'LOD showcase ground' } }
  );
  updateLoaderFn({ loadedCount: 1, totalCount: LANES.length + 1 });

  laneEntries = [];
  for (let i = 0; i < LANES.length; i++) {
    const { lane, slot } = LANES[i];
    const x = (slot - (LANE_SLOT_COUNT - 1) / 2) * LANE_SPACING;
    const ctx = createLaneContext({ world, rootScene, sceneData, camera }, lane.id, x);
    laneEntries.push({ lane, x, state: await lane.create(ctx) });
    updateLoaderFn({ loadedCount: i + 2, totalCount: LANES.length + 1 });
  }

  if (IS_DEBUG_ENV) {
    const { createLodShowcaseTab } = await import('./_dbg__lodShowcase');
    createLodShowcaseTab();
  }

  // The sky box is activated after this file runs
  registerOnSceneEnter(LOD_SHOWCASE_SCENE_ID, () => {
    setTimeOfDay(SHOWCASE_START_TIME_OF_DAY);
    pauseDayNight();
    for (const fn of enterListeners) fn();
  });
};
