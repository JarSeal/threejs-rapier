import * as THREE from 'three/webgpu';
import type { ECSWorld } from '../../_engine/core/ECS';
import type { SceneData } from '../../_engine/core/Scene';
import type { LodDef } from '../../_engine/core/Lod/LodTypes';
import { DEFAULT_LOD_HYSTERESIS, getLodBias } from '../../_engine/core/Lod/LodSystem';
import { lwarn } from '../../_engine/utils/Logger';

// The LOD showcase's layout (docs/plans/p351_impostor-billboard-lod.md Phase 5): lanes side by side
// along x, each running away from the start camera along -z. A level is used while the screen size
// r × k / d is at least its screenSize (LodSystem.ts), so a lane's levels are distance bands from
// the camera, and the layout puts objects in each.

/** The aspect the lanes' nearest objects are kept in view at (the narrowest one expected). */
const MIN_ASPECT = 4 / 3;
/** Kept between a lane's nearest object and the view's side. */
const VIEW_MARGIN = 2;
/** The ground's far end: no object goes past it. */
export const LANE_FAR_DISTANCE = 290;

export type LanePosition = { x: number; y: number; z: number };

/** One object of a lane: where it stands and the level the start camera shows it at (-1: LOD
 * culled). */
export type LaneSlot = { level: number; distance: number };

export type ShowcaseLaneContext = {
  world: ECSWorld;
  rootScene: THREE.Scene;
  /** The scene's generated data (its JSON assets resolved, with the scene's save entries). */
  sceneData: SceneData;
  /** The lane's centre line. */
  x: number;
  /** The start camera's pose (built from its JSON, see getStartCamera): the layout measures from
   * it. */
  camera: THREE.PerspectiveCamera;
  /** Where on the lane's line an object's centre at height `y` is `distance` from the start camera
   * (as near as the lane can be when it's closer). */
  placeAt: (distance: number, y: number) => LanePosition;
  /** The distances to put objects at so every level band of `def` holds `perBand` of them (and
   * one past the cull distance, when it hides), for a level 0 radius of `radius` (world units, at
   * the object's scale). Bands outside the lane are left out, warned. */
  getSlots: (radius: number, def: LodDef, perBand?: number) => LaneSlot[];
  /** The start camera's distances where `def`'s levels switch, coming closer (the finer level's
   * threshold), and where it hides, if it does. */
  getSwitchDistances: (radius: number, def: LodDef) => number[];
};

/** What a lane hands back: the demo tab reads it. */
export type ShowcaseLaneState = {
  /** Its LOD entities (a pool's instances). A function: a JSON mesh only exists after the scene
   * file has run. */
  getEntityIds: () => number[];
  /** Level 0's radius at scale 1. */
  radius: number;
  /** The start camera's distances where its levels switch (and it hides). */
  switchDistances: number[];
};

export type ShowcaseLane = {
  id: string;
  title: string;
  description: string;
  create: (ctx: ShowcaseLaneContext) => Promise<ShowcaseLaneState>;
};

/**
 * The start camera's pose from the scene's camera JSON, as a private camera. Not the scene's own
 * camera object: when a scene loads again, that one hasn't turned to its `lookAtPoint` yet while
 * the scene file runs.
 * @param sceneData the scene's data
 * @param appId the start camera's appId
 */
export const getStartCamera = (sceneData: SceneData, appId: string) => {
  const entry = sceneData.cameras?.find(
    (cam) => typeof cam !== 'string' && cam.entityOpts?.appId === appId
  );
  const props = typeof entry === 'string' ? undefined : entry?.camProps;
  if (!props || props.type !== 'PERSPECTIVE') {
    throw new Error(`The LOD showcase needs a perspective start camera "${appId}" in its scene.`);
  }
  const camera = new THREE.PerspectiveCamera(props.fov, MIN_ASPECT, props.near, props.far);
  const { position: p, lookAtPoint: at } = props;
  camera.position.set(p?.x ?? 0, p?.y ?? 0, p?.z ?? 0);
  if (at) camera.lookAt(at.x ?? 0, at.y ?? 0, at.z ?? 0);
  camera.updateMatrixWorld();
  return camera;
};

/** `k` in r × k / d (LodSystem.ts's perspective projection). */
export const getScreenSizeFactor = (camera: THREE.PerspectiveCamera) =>
  camera.zoom / Math.tan(THREE.MathUtils.DEG2RAD * camera.fov * 0.5);

const _view = new THREE.Vector3();

/** How far down the lane (along -z from the camera) its line on the ground comes into the start
 * camera's view, `VIEW_MARGIN` in from its edges, at `MIN_ASPECT`. */
const getNearDepth = (camera: THREE.PerspectiveCamera, x: number) => {
  const tanY = Math.tan(THREE.MathUtils.DEG2RAD * camera.fov * 0.5);
  const tanX = tanY * MIN_ASPECT;
  for (let depth = 1; depth < LANE_FAR_DISTANCE; depth += 0.25) {
    _view.set(x, 0, camera.position.z - depth).applyMatrix4(camera.matrixWorldInverse);
    const ahead = -_view.z;
    if (
      ahead > 0 &&
      Math.abs(_view.x) + VIEW_MARGIN <= ahead * tanX &&
      Math.abs(_view.y) + VIEW_MARGIN <= ahead * tanY
    ) {
      return depth;
    }
  }
  return LANE_FAR_DISTANCE;
};

/** The distance where an object of radius `radius` has screen size `screenSize` (with the LOD's own
 * and the global bias). */
const distanceAt = (radius: number, k: number, def: LodDef, screenSize: number) =>
  (radius * k * (def.bias ?? 1) * getLodBias()) / screenSize;

export const createLaneContext = (
  base: Pick<ShowcaseLaneContext, 'world' | 'rootScene' | 'sceneData' | 'camera'>,
  laneId: string,
  x: number
): ShowcaseLaneContext => {
  const { camera } = base;
  const cam = camera.position;
  const k = getScreenSizeFactor(camera);
  const nearDepth = getNearDepth(camera, x);

  const placeAt = (distance: number, y: number): LanePosition => {
    const lateral2 = (x - cam.x) ** 2 + (y - cam.y) ** 2;
    const depth = Math.max(nearDepth, Math.sqrt(Math.max(0, distance * distance - lateral2)));
    return { x, y, z: cam.z - depth };
  };
  // At the ground, which every object is near enough to for the bands
  const nearDistance = Math.hypot(nearDepth, x - cam.x, cam.y);

  const getSwitchDistances = (radius: number, def: LodDef) => {
    const distances: number[] = [];
    for (let i = 0; i < def.levels.length - 1; i++) {
      distances.push(distanceAt(radius, k, def, def.levels[i].screenSize));
    }
    if (def.cullScreenSize) distances.push(distanceAt(radius, k, def, def.cullScreenSize));
    return distances;
  };

  const getSlots = (radius: number, def: LodDef, perBand = 1) => {
    const h = def.hysteresis ?? DEFAULT_LOD_HYSTERESIS;
    const levels = def.levels;
    const cull = def.cullScreenSize ?? 0;
    // Each band from where the camera moving away switches to it (past the hysteresis) to where
    // the camera coming closer switches to the next finer one: the same level from either side
    const bands: { level: number; near: number; far: number }[] = [];
    for (let i = 0; i < levels.length; i++) {
      const near = i === 0 ? 0 : distanceAt(radius, k, def, levels[i - 1].screenSize * (1 - h));
      const nextSize = i < levels.length - 1 ? levels[i].screenSize : cull;
      const far = nextSize > 0 ? distanceAt(radius, k, def, nextSize) : LANE_FAR_DISTANCE;
      bands.push({ level: i, near, far });
    }
    if (cull > 0) {
      const near = distanceAt(radius, k, def, cull * (1 - h));
      // One object past the cull distance: it hides there, and fades in on the way in
      bands.push({ level: -1, near, far: Math.min(near * 1.25, LANE_FAR_DISTANCE) });
    }

    const slots: LaneSlot[] = [];
    for (const band of bands) {
      const near = Math.max(band.near, nearDistance);
      const far = Math.min(band.far, LANE_FAR_DISTANCE);
      if (far <= near) {
        lwarn(
          `[lodShowcase] Lane "${laneId}": ${band.level < 0 ? 'the LOD culled band' : `level ${band.level}'s band`} (${band.near.toFixed(1)}-${band.far.toFixed(1)} m) is outside the lane (${nearDistance.toFixed(1)}-${LANE_FAR_DISTANCE} m): no object shows it.`
        );
        continue;
      }
      // Spread evenly in log distance, the way screen size falls off
      const count = band.level < 0 ? 1 : perBand;
      for (let j = 0; j < count; j++) {
        slots.push({ level: band.level, distance: near * (far / near) ** ((j + 0.5) / count) });
      }
    }
    return slots;
  };

  return { ...base, x, placeAt, getSlots, getSwitchDistances };
};
