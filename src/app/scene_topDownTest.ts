import * as THREE from 'three/webgpu';
import { createGeometry, saveBufferGeometry } from '../_engine/core/Geometry';
import { getMaterial, getMaterialVariant } from '../_engine/core/Material';
import { createMeshEntity } from '../_engine/core/MeshManager';
import { getLoaderStatusUpdater } from '../_engine/core/SceneLoader';
import { createDynamicCharacter } from '../_engine/core/Character/DynamicCharacter';
import { SunShadowFitComponentType } from '../toolkit/ecs/effects/SunShadowFit';
import { getECSWorld, getEntityIdByAppId } from '../_engine/core/ECS';
import { registerOnSceneEnter, registerOnSceneExit } from '../_engine/core/Scene';
import { createPhysicsEntity } from '../_engine/core/PhysicsManager';
import { getCameraByAppId } from '../_engine/core/CameraManager';
import {
  createFollowObjectCameraRig,
  deleteFollowObjectCameraRig,
} from '../_engine/utils/cameras/followObjectCameraRig';
import { existsOrThrow } from '../_engine/utils/assert';
import { lwarn } from '../_engine/utils/Logger';
import { generateTerrain } from '../toolkit/geometry/generateTerrain';
import { createSeededRandom } from '../toolkit/geometry/seededRandom';
import { createCharacterVisual } from './characterVisual';

/**
 * Top-down character test scene (docs/plans/_DONE_p066_character-definitions-and-refactoring.md
 * Phase 6). A WORLD_FIXED player on a large flat ground, seen from straight South of and above
 * it, so W (North, -Z) is screen-up. The sun's shadow is fitted to the camera view by the
 * toolkit's SunShadowFit effect.
 *
 * The camera, the lights and the sky box come from topDownTest.scene.json. The character, its
 * bindings and the sun's SUN_SHADOW_FIT component go with their entities on scene exit (the
 * CHARACTER and component hooks); only the follow camera rig is deleted by hand.
 */
export const SCENE_TOP_DOWN_TEST_META = {
  id: 'topDownTestScene',
};

const GROUND_SIZE = 300;
const GROUND_THICKNESS = 0.2;
/** The player's spawn point, on the flat part (the ground's top is at y = 0). */
const SPAWN = { x: 0, y: 1, z: 0 };

const CAMERA_RIG_ID = 'topDownTestFollowCam';
const SUN_APP_ID = 'topDownTestSun';

/** The toolkit's grid material (listed in the scene JSON), for the static meshes */
const getGridMaterial = () =>
  existsOrThrow(
    getMaterial('triplanarGrid'),
    'Could not find the triplanarGrid material for the top-down test scene.'
  );

/** The flat ground: a thin box with a box collider, its top at y = 0. */
const createGround = async () => {
  const position = { x: 0, y: -GROUND_THICKNESS / 2, z: 0 };
  const groundEntityId = createMeshEntity(
    {
      geo: createGeometry({
        id: 'topDownTestGroundGeo',
        type: 'BOX',
        params: { width: GROUND_SIZE, height: GROUND_THICKNESS, depth: GROUND_SIZE },
      }),
      mat: getGridMaterial(),
      receiveShadow: true,
      position,
      // The gym ground's lighter tint (a material variant, same shader)
      matOverrides: {
        staticDefines: { minorLines: false },
        nodes: { colorNode: { backgroundColor: '#9c9c9c', lineColor: '#a5a5a5' } },
      },
    },
    { appId: 'topDownTestGround' }
  );
  await createPhysicsEntity(
    { type: 'BOX', friction: 2 },
    { rigidType: 'FIXED', translation: position },
    groundEntityId
  );
};

/** The hills patch on the East side of the ground (world-space center and size). */
const HILLS = {
  centerX: GROUND_SIZE / 2 - 60,
  width: 120,
  depth: GROUND_SIZE,
  /** Height scale of the noise (the highest peak is ~14 m) */
  peak: 16,
  /** The patch's edges sink this far below the ground, so no seam shows where it pokes out */
  edgeSink: -0.3,
  /** The hills rise over this distance from the patch's West edge */
  westRamp: 35,
  /** ...and fall over this distance to its other edges (the ground's edges) */
  edgeFalloff: 12,
};

const smoothstep = (edge0: number, edge1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
};

/** The hills: a generated terrain patch with a trimesh collider. Its noise is reshaped into
 * hills with flat valleys, masked to rise from the West edge and sunk below the ground at every
 * edge. About 5% of it is steeper than the character's 45° walkable slope. Returns the world-space
 * ground height (the hills or the flat ground, whichever is higher). */
const createHills = async () => {
  const { width, depth, peak, edgeSink, westRamp, edgeFalloff } = HILLS;
  const terrain = generateTerrain({
    width,
    depth,
    // 2 m square cells
    widthSegments: 60,
    depthSegments: 150,
    // Noise in about -1..1, reshaped by the modifier
    maxHeight: 1,
    seed: 2,
    noiseOctaves: [
      { frequency: 1 / 45, amplitude: 1 },
      { frequency: 1 / 16, amplitude: 0.25 },
    ],
    heightModifier: (x, z, h) => {
      const mask =
        smoothstep(0, westRamp, x + width / 2) *
        smoothstep(0, edgeFalloff, Math.min(width / 2 - x, z + depth / 2, depth / 2 - z));
      const n = Math.min(1, Math.max(0, (h + 1) / 2));
      return edgeSink + mask * (n * n * peak - edgeSink);
    },
  });

  const position = { x: HILLS.centerX, y: 0, z: 0 };
  const geometry = saveBufferGeometry(terrain.geometry, { id: 'topDownTestHillsGeo' });
  const hillsEntityId = createMeshEntity(
    {
      geo: geometry,
      mat: getGridMaterial(),
      castShadow: true,
      receiveShadow: true,
      position,
      matOverrides: {
        nodes: {
          colorNode: {
            backgroundColor: '#7f8c70',
            lineColor: '#8e9b80',
            minorLineColor: '#869378',
          },
        },
      },
    },
    { appId: 'topDownTestHills' }
  );
  await createPhysicsEntity(
    {
      type: 'TRIMESH',
      vertices: geometry.getAttribute('position').array as Float32Array,
      indices: Uint32Array.from(geometry.getIndex()!.array),
      friction: 1,
    },
    { rigidType: 'FIXED', translation: position },
    hillsEntityId
  );

  return (x: number, z: number) => {
    const localX = x - HILLS.centerX;
    if (Math.abs(localX) > width / 2 || Math.abs(z) > depth / 2) return 0;
    return Math.max(0, terrain.getHeightAt(localX, z));
  };
};

type StaticObstacleKind = 'WALL' | 'PILLAR' | 'RAMP' | 'LOW_BOX' | 'BLOCK';

/** The scattered static obstacles: on the flat (around the spawn, which they keep clear of)
 * and on the hills' first slopes, East of it. */
const OBSTACLES = {
  seed: 66,
  flat: {
    kinds: [
      'RAMP',
      'LOW_BOX',
      'WALL',
      'WALL',
      'WALL',
      'WALL',
      'WALL',
      'PILLAR',
      'PILLAR',
      'PILLAR',
      'PILLAR',
    ] as StaticObstacleKind[],
    area: { minX: -28, maxX: 24, minZ: -24, maxZ: 24 },
  },
  hills: {
    kinds: ['PILLAR', 'PILLAR', 'BLOCK', 'BLOCK'] as StaticObstacleKind[],
    area: { minX: 40, maxX: 80, minZ: -30, maxZ: 30 },
  },
  /** Free radius around the spawn point (plus each obstacle's own radius) */
  spawnClearance: 6,
  /** Free space between two obstacles' footprint circles */
  gap: 3,
  /** How deep an obstacle on the hills sinks below the lowest ground under it */
  hillsSink: 0.3,
};

type StaticObstacleShape = {
  geo: Parameters<typeof createGeometry>[0];
  collider: 'BOX' | 'CYLINDER';
  /** Height above the ground of the shape's center */
  centerY: number;
  /** Tilt about the local X axis (radians), the ramp's slope */
  pitch?: number;
  /** Footprint circle radius (spacing and spawn clearance) */
  radius: number;
};

/** One obstacle's random size and shape. */
const getStaticObstacleShape = (
  kind: StaticObstacleKind,
  random: () => number,
  index: number
): StaticObstacleShape => {
  const id = `topDownTestObstacleGeo${index}`;
  const between = (min: number, max: number) => min + random() * (max - min);
  switch (kind) {
    case 'WALL': {
      const length = between(6, 12);
      const height = 2.5;
      return {
        geo: { id, type: 'BOX', params: { width: length, height, depth: 0.6 } },
        collider: 'BOX',
        centerY: height / 2,
        radius: length / 2,
      };
    }
    case 'PILLAR': {
      const radius = between(0.5, 1.1);
      const height = between(3, 5);
      return {
        geo: {
          id,
          type: 'CYLINDER',
          params: { radiusTop: radius, radiusBottom: radius, height, radialSegments: 20 },
        },
        collider: 'CYLINDER',
        centerY: height / 2,
        radius,
      };
    }
    case 'RAMP': {
      // A walkable 18° slope, from the ground up to ~3 m (its low end's top at ground level)
      const length = 10;
      const thickness = 0.4;
      const pitch = THREE.MathUtils.degToRad(18);
      return {
        geo: { id, type: 'BOX', params: { width: 4, height: thickness, depth: length } },
        collider: 'BOX',
        centerY: (length / 2) * Math.sin(pitch) - (thickness / 2) * Math.cos(pitch),
        pitch,
        radius: length / 2,
      };
    }
    case 'LOW_BOX': {
      // Low enough to jump onto (a standing jump is ~1.1 m)
      const height = 0.8;
      return {
        geo: { id, type: 'BOX', params: { width: 3, height, depth: 3 } },
        collider: 'BOX',
        centerY: height / 2,
        radius: 2.2,
      };
    }
    case 'BLOCK': {
      const size = between(2, 3);
      return {
        geo: { id, type: 'BOX', params: { width: size, height: size, depth: size } },
        collider: 'BOX',
        centerY: size / 2,
        radius: size * 0.71,
      };
    }
  }
};

/** A placed object's footprint circle on the ground. */
type Footprint = { x: number; z: number; radius: number };

/**
 * A random spot in `area` for a footprint of `radius` that keeps `spawnClearance` (plus the
 * radius) from the spawn point and `gap` from every footprint in `placed`, or undefined when
 * 200 tries find none. Adds the new footprint to `placed`.
 */
const findFreeSpot = (
  random: () => number,
  area: { minX: number; maxX: number; minZ: number; maxZ: number },
  radius: number,
  spawnClearance: number,
  gap: number,
  placed: Footprint[]
) => {
  for (let tries = 0; tries < 200; tries++) {
    const x = area.minX + random() * (area.maxX - area.minX);
    const z = area.minZ + random() * (area.maxZ - area.minZ);
    if (
      Math.hypot(x - SPAWN.x, z - SPAWN.z) >= spawnClearance + radius &&
      placed.every((p) => Math.hypot(x - p.x, z - p.z) >= p.radius + radius + gap)
    ) {
      placed.push({ x, z, radius });
      return { x, z };
    }
  }
  return undefined;
};

/** The static obstacles, scattered with a seeded random (the same layout on every visit). Each
 * kind gets a random spot in its area that keeps clear of the spawn point and of the other
 * obstacles, and a random yaw. On the hills, an obstacle stands on the lowest ground under its
 * footprint, sunk a little, so it never floats on a slope. Returns their footprints. */
const createStaticObstacles = async (getGroundHeightAt: (x: number, z: number) => number) => {
  const random = createSeededRandom(OBSTACLES.seed);
  const gridMat = getGridMaterial();
  // Flat slopes: one projection only, or two blended ones show doubled lines (see the gym)
  const flatSlopesMat = getMaterialVariant('triplanarGrid', {
    staticDefines: { dominantAxis: true },
  });
  const placed: Footprint[] = [];
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');
  let index = 0;

  for (const { kinds, area, onHills } of [
    { ...OBSTACLES.flat, onHills: false },
    { ...OBSTACLES.hills, onHills: true },
  ]) {
    for (const kind of kinds) {
      const shape = getStaticObstacleShape(kind, random, index);
      const { spawnClearance, gap } = OBSTACLES;
      const spot = findFreeSpot(random, area, shape.radius, spawnClearance, gap, placed);
      if (!spot) {
        lwarn(`Top-down test scene: no free spot for a ${kind} obstacle, skipped.`);
        continue;
      }

      let groundY = 0;
      if (onHills) {
        groundY = Infinity;
        for (const [dx, dz] of [
          [0, 0],
          [1, 0],
          [-1, 0],
          [0, 1],
          [0, -1],
        ]) {
          const h = getGroundHeightAt(spot.x + dx * shape.radius, spot.z + dz * shape.radius);
          groundY = Math.min(groundY, h);
        }
        groundY -= OBSTACLES.hillsSink;
      }
      euler.set(shape.pitch ?? 0, random() * Math.PI * 2, 0);
      const entityId = createMeshEntity(
        {
          geo: createGeometry(shape.geo),
          mat: kind === 'RAMP' ? flatSlopesMat : gridMat,
          castShadow: true,
          receiveShadow: true,
          position: { x: spot.x, y: groundY + shape.centerY, z: spot.z },
          quaternion: new THREE.Quaternion().setFromEuler(euler),
        },
        { appId: `topDownTestObstacle${index}`, debugData: { name: `Obstacle ${index} (${kind})` } }
      );
      // The body takes the mesh's position and rotation, the collider its geometry's size. The
      // default friction (0.5): with 1, a character pushing into a wall at 45° can stick to it
      // instead of sliding along it.
      await createPhysicsEntity({ type: shape.collider }, { rigidType: 'FIXED' }, entityId);
      index++;
    }
  }
  return placed;
};

type DynamicPropKind = 'BOX' | 'BALL' | 'CYLINDER' | 'CAPSULE';

/** The dynamic props lying around the spawn, between the obstacles. */
const PROPS = {
  seed: 67,
  kinds: [
    ...Array<DynamicPropKind>(8).fill('BOX'),
    ...Array<DynamicPropKind>(7).fill('BALL'),
    ...Array<DynamicPropKind>(5).fill('CYLINDER'),
    ...Array<DynamicPropKind>(5).fill('CAPSULE'),
  ],
  area: OBSTACLES.flat.area,
  spawnClearance: 2.5,
  gap: 1,
  /** Light, normal and heavy (each prop picks one; the light and heavy ones get their own
   * checker colors, so how hard a prop is to push reads from above) */
  densities: [
    { density: 0.2, colors: ['#c9b58f', '#b4a07a'] },
    { density: 1 },
    { density: 4, colors: ['#5e5e66', '#4f4f57'] },
  ],
};

type DynamicPropShape = {
  geo: Parameters<typeof createGeometry>[0];
  collider: 'BOX' | 'BALL' | 'CYLINDER' | 'CAPSULE';
  /** Height above the ground of the shape's center, lying as rotated */
  centerY: number;
  /** Lying on its side (a quarter turn about the local X axis) */
  onItsSide: boolean;
  radius: number;
};

/** One prop's random size and shape. Cylinders and capsules lie on their side half the time. */
const getDynamicPropShape = (
  kind: DynamicPropKind,
  random: () => number,
  index: number
): DynamicPropShape => {
  const id = `topDownTestPropGeo${index}`;
  const between = (min: number, max: number) => min + random() * (max - min);
  switch (kind) {
    case 'BOX': {
      const width = between(0.4, 1.6);
      const height = between(0.4, 1.6);
      const depth = between(0.4, 1.6);
      return {
        geo: { id, type: 'BOX', params: { width, height, depth } },
        collider: 'BOX',
        centerY: height / 2,
        onItsSide: false,
        radius: Math.hypot(width, depth) / 2,
      };
    }
    case 'BALL': {
      const radius = between(0.3, 0.9);
      return {
        geo: { id, type: 'SPHERE', params: { radius, widthSegments: 24, heightSegments: 16 } },
        collider: 'BALL',
        centerY: radius,
        onItsSide: false,
        radius,
      };
    }
    case 'CYLINDER': {
      const radius = between(0.3, 0.6);
      const height = between(0.6, 1.8);
      const onItsSide = random() < 0.5;
      return {
        geo: {
          id,
          type: 'CYLINDER',
          params: { radiusTop: radius, radiusBottom: radius, height, radialSegments: 20 },
        },
        collider: 'CYLINDER',
        centerY: onItsSide ? radius : height / 2,
        onItsSide,
        radius: onItsSide ? Math.max(radius, height / 2) : radius,
      };
    }
    case 'CAPSULE': {
      const radius = between(0.25, 0.5);
      // The straight middle part (the collider's halfHeight is half of it)
      const length = between(0.4, 1.4);
      const onItsSide = random() < 0.5;
      return {
        geo: { id, type: 'CAPSULE', params: { radius, height: length } },
        collider: 'CAPSULE',
        centerY: onItsSide ? radius : length / 2 + radius,
        onItsSide,
        radius: onItsSide ? length / 2 + radius : radius,
      };
    }
  }
};

/** The dynamic props: boxes, balls, cylinders and capsules of mixed sizes and densities, resting
 * on the flat around the spawn (seeded, the same on every visit), clear of the obstacles. */
const createDynamicProps = async (obstacles: Footprint[]) => {
  const random = createSeededRandom(PROPS.seed);
  const placed = [...obstacles];
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const materials = PROPS.densities.map(({ colors }) =>
    colors
      ? getMaterialVariant('triplanarCheckerboard', {
          nodes: { colorNode: { checkerColorA: colors[0], checkerColorB: colors[1] } },
        })
      : existsOrThrow(
          getMaterial('triplanarCheckerboard'),
          'Could not find the triplanarCheckerboard material for the top-down test scene.'
        )
  );

  for (let index = 0; index < PROPS.kinds.length; index++) {
    const kind = PROPS.kinds[index];
    const shape = getDynamicPropShape(kind, random, index);
    const densityIndex = Math.floor(random() * PROPS.densities.length);
    const { area, spawnClearance, gap } = PROPS;
    const spot = findFreeSpot(random, area, shape.radius, spawnClearance, gap, placed);
    if (!spot) {
      lwarn(`Top-down test scene: no free spot for a ${kind} prop, skipped.`);
      continue;
    }
    euler.set(shape.onItsSide ? Math.PI / 2 : 0, random() * Math.PI * 2, 0);
    const entityId = createMeshEntity(
      {
        geo: createGeometry(shape.geo),
        mat: materials[densityIndex],
        castShadow: true,
        receiveShadow: true,
        // A hair above the ground, so nothing starts in contact
        position: { x: spot.x, y: shape.centerY + 0.01, z: spot.z },
        quaternion: new THREE.Quaternion().setFromEuler(euler),
      },
      { appId: `topDownTestProp${index}`, debugData: { name: `Prop ${index} (${kind})` } }
    );
    await createPhysicsEntity(
      { type: shape.collider, density: PROPS.densities[densityIndex].density },
      { rigidType: 'DYNAMIC' },
      entityId
    );
  }
};

/** The WORLD_FIXED player (WASD: North / West / South / East; Space, Shift, Control) and the
 * follow camera rig. Returns the player's entity id. */
const createPlayer = async () => {
  // #region dynamic-character (shown in the Hub: hub/pages/features/characters/)
  const charData = { _height: 1.6, _radius: 0.5 };
  const visual = createCharacterVisual({
    key: 'topDownPlayer',
    height: charData._height,
    radius: charData._radius,
    beakColor: '#333',
  });
  const { character } = await createDynamicCharacter({
    id: 'topDownPlayer',
    name: 'Top-down player',
    visual,
    charData,
    input: {
      scheme: 'WORLD_FIXED',
      mappings: {
        moveNorth: ['w'],
        moveSouth: ['s'],
        moveWest: ['a'],
        moveEast: ['d'],
        jump: [' '],
        run: ['Shift'],
        crouch: ['Control'],
      },
    },
  });
  // #endregion dynamic-character
  getECSWorld().getRigidBody(character.entityId)?.setTranslation(SPAWN, true);

  // Straight South of and above the player: North (-Z) is screen-up
  createFollowObjectCameraRig({
    id: CAMERA_RIG_ID,
    camera: existsOrThrow(
      getCameraByAppId('topDownTestCamera'),
      'Could not find the topDownTestCamera for the top-down test scene.'
    ),
    targetMesh: visual,
    offset: { x: 0, y: 20, z: 8 },
    smoothingTime: 0.2,
  });

  return character.entityId;
};

export const scene = async () => {
  const updateLoaderFn = getLoaderStatusUpdater();
  updateLoaderFn({ loadedCount: 0, totalCount: 3 });

  await createGround();
  const getGroundHeightAt = await createHills();
  const obstacles = await createStaticObstacles(getGroundHeightAt);
  await createDynamicProps(obstacles);
  updateLoaderFn({ loadedCount: 1, totalCount: 3 });

  const playerEntityId = await createPlayer();
  updateLoaderFn({ loadedCount: 2, totalCount: 3 });

  // The JSON lights are created after this function runs, so the sun gets its shadow fit on
  // enter. The camera is 20 m above the player at a ~68° pitch, so the view's farthest ground
  // (its top corners) is ~28 m deep on the flat, and ~46 m deep from the highest peak (14 m)
  // looking down to the valleys: a 48 m slice covers the screen everywhere (a ~±46 m shadow box,
  // ~4.5 cm texels). The peaks cast ~24 m along a 38° sun, hence the caster extension.
  registerOnSceneEnter(SCENE_TOP_DOWN_TEST_META.id, () => {
    const world = getECSWorld();
    const sunId = getEntityIdByAppId(SUN_APP_ID, world);
    if (sunId === undefined) {
      lwarn(`Top-down test scene: could not find the sun light '${SUN_APP_ID}'.`);
      return;
    }
    world.addComponent(sunId, SunShadowFitComponentType.SUN_SHADOW_FIT, {
      maxDistance: 48,
      casterExtension: 25,
      followEntityId: playerEntityId,
    });
  });
  // (One exit callback per scene: registerOnSceneExit replaces any earlier one.)
  registerOnSceneExit(SCENE_TOP_DOWN_TEST_META.id, () => {
    deleteFollowObjectCameraRig(CAMERA_RIG_ID);
  });

  updateLoaderFn({ loadedCount: 2, totalCount: 2 });
};
