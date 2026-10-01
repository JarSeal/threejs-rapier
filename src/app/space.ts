import { getECSWorld } from '../_engine/core/ECS';
import { IS_DEBUG_ENV } from '../_engine/core/Config';
import { saveBufferGeometry } from '../_engine/core/Geometry';
import { getMaterial } from '../_engine/core/Material';
import { createMeshEntity } from '../_engine/core/MeshManager';
import { getPhysicsWorld } from '../_engine/core/PhysicsAPI';
import { createPhysicsEntity } from '../_engine/core/PhysicsManager';
import type { PhysVector } from '../_engine/core/Physics/PhysicsAPITypes';
import { getLoaderStatusUpdater } from '../_engine/core/SceneLoader';
import { existsOrThrow } from '../_engine/utils/assert';
import {
  addGravityBody,
  getMutualGravityConfig,
  setMutualGravityConfig,
  type MutualGravityConfig,
} from '../toolkit/ecs/effects/MutualGravity';
import { generateAsteroid, type GeneratedAsteroid } from '../toolkit/geometry/generateAsteroid';
import { createSeededRandom } from '../toolkit/geometry/seededRandom';

export const SPACE_SCENE_ID = 'space';

/** The demo's mutual gravity, set on every scene load (the debug tab changes it until then). */
export const SPACE_GRAVITY: MutualGravityConfig = { G: 1, softening: 0.5, enabled: true };
const DENSITY = 1;
const RESTITUTION = 0.3;

/** Rock colours for the asteroid material's colorNode (its `seed` is the asteroid's). */
const PALETTES = [
  // The material's own grey-brown
  { colorA: '#5d554d', colorB: '#8a7f72', pitColor: '#2b2622' },
  // Iron-rich, rusty
  { colorA: '#5a3f30', colorB: '#8c6248', pitColor: '#2a1b14' },
  // Carbonaceous, dark
  { colorA: '#34343a', colorB: '#505058', pitColor: '#151517' },
];

type AsteroidOrbit = {
  /** Distance from the primary. */
  radius: number;
  /** Tilt of the orbit's plane about the x axis, in degrees. */
  inclination: number;
  /** Starting angle in the orbit's plane, in degrees. */
  phase: number;
  /** Starting speed as a fraction of the circular speed: 1 is a circular orbit, below 1 an
   * ellipse that starts at its far point. Default 1. */
  speed?: number;
  /** The other way round. */
  retrograde?: boolean;
};

type AsteroidDef = {
  name: string;
  seed: number;
  radius: number;
  shape?: [number, number, number];
  /** Index into PALETTES. */
  palette: number;
  /** Starting spin (rad/s). */
  spin: PhysVector;
};

/** The demo set: a primary with three rocks round it. The inner two are on (softened) circular
 * orbits, tilted and one retrograde, which the others perturb into loose ones; the last starts
 * slow and falls in on a narrow ellipse, close enough to hit the primary (the collision demo). */
const DEMO_ASTEROIDS: (AsteroidDef & { orbit?: AsteroidOrbit })[] = [
  {
    name: 'Primary',
    seed: 3,
    radius: 2.2,
    shape: [1.15, 0.9, 1],
    palette: 0,
    spin: { x: 0.02, y: 0.08, z: 0.01 },
  },
  {
    name: 'Inner moonlet',
    seed: 11,
    radius: 0.8,
    palette: 1,
    orbit: { radius: 6.5, inclination: 8, phase: 20 },
    spin: { x: 0.3, y: -0.1, z: 0.2 },
  },
  {
    name: 'Outer shard',
    seed: 27,
    radius: 0.6,
    shape: [1.6, 0.8, 0.9],
    palette: 2,
    orbit: { radius: 9.5, inclination: -14, phase: 200, retrograde: true },
    spin: { x: -0.1, y: 0.4, z: 0.15 },
  },
  {
    name: 'Eccentric pebble',
    seed: 42,
    radius: 0.5,
    palette: 0,
    orbit: { radius: 11, inclination: 4, phase: 110, speed: 0.75 },
    spin: { x: 0.5, y: 0.2, z: -0.3 },
  },
];

export type SpaceAsteroid = {
  entityId: number;
  name: string;
  seed: number;
  /** Gravitational mass: density × the hull's volume, which is also Rapier's mass. */
  mass: number;
  boundingRadius: number;
};

let asteroids: SpaceAsteroid[] = [];
let spawnCount = 0;
const pose = new Float64Array(7);

type BuiltAsteroid = { def: AsteroidDef; rock: GeneratedAsteroid; mass: number };

const buildAsteroid = (def: AsteroidDef): BuiltAsteroid => {
  const rock = generateAsteroid({ seed: def.seed, radius: def.radius, shape: def.shape });
  return { def, rock, mass: rock.hullVolume * DENSITY };
};

/** The circular orbit speed at `r` around `mass`, with the mutual gravity's softening:
 * v² = G·M·r² / (r² + ε²)^(3/2). */
const circularSpeed = (mass: number, r: number) => {
  const { G, softening } = getMutualGravityConfig();
  const d2 = r * r + softening * softening;
  return Math.sqrt((G * mass * r * r) / (d2 * Math.sqrt(d2)));
};

/** Where an orbit starts, and its velocity, around `centralMass` at the origin. */
const orbitStart = (orbit: AsteroidOrbit, centralMass: number) => {
  const inc = (orbit.inclination * Math.PI) / 180;
  const phase = (orbit.phase * Math.PI) / 180;
  const speed =
    circularSpeed(centralMass, orbit.radius) * (orbit.speed ?? 1) * (orbit.retrograde ? -1 : 1);
  // In the orbit's plane (xz before the tilt about x): the position, and the motion at right angles
  const tilt = (x: number, z: number): PhysVector => ({
    x,
    y: -z * Math.sin(inc),
    z: z * Math.cos(inc),
  });
  return {
    position: tilt(Math.cos(phase) * orbit.radius, Math.sin(phase) * orbit.radius),
    linvel: tilt(-Math.sin(phase) * speed, Math.cos(phase) * speed),
  };
};

const addAsteroid = async (
  { def, rock, mass }: BuiltAsteroid,
  appId: string,
  position: PhysVector,
  linvel: PhysVector
) => {
  // The id names what generated it, so a cached geometry (a reset before the old one was
  // released) is the same rock, and the fresh copy can go
  const shape = def.shape ?? [1, 1, 1];
  const geo = saveBufferGeometry(rock.geometry, {
    id: `spaceAsteroidGeo-${def.seed}-${def.radius}-${shape.join('x')}`,
  });
  if (geo !== rock.geometry) rock.geometry.dispose();

  const entityId = createMeshEntity(
    {
      geo,
      mat: existsOrThrow(getMaterial('asteroid'), 'The space scene needs the asteroid material.'),
      matOverrides: { nodes: { colorNode: { seed: def.seed, ...PALETTES[def.palette] } } },
      position,
      castShadow: true,
      receiveShadow: true,
    },
    { appId, debugData: { name: `Asteroid: ${def.name}` } }
  );
  asteroids.push({
    entityId,
    name: def.name,
    seed: def.seed,
    mass,
    boundingRadius: rock.boundingRadius,
  });
  await createPhysicsEntity(
    {
      type: 'CONVEXHULL',
      vertices: rock.hullVertices,
      density: DENSITY,
      restitution: RESTITUTION,
    },
    { rigidType: 'DYNAMIC', translation: position, linvel, angvel: def.spin },
    entityId
  );
  addGravityBody(entityId, mass);
  return entityId;
};

const createDemoAsteroids = async () => {
  const built = DEMO_ASTEROIDS.map(buildAsteroid);
  const primaryMass = built[0].mass;
  const starts = DEMO_ASTEROIDS.map((def, i) =>
    def.orbit
      ? orbitStart(def.orbit, primaryMass + built[i].mass)
      : { position: { x: 0, y: 0, z: 0 }, linvel: { x: 0, y: 0, z: 0 } }
  );

  // Centre of mass at the origin and no net momentum, so the group stays in view
  let totalMass = 0;
  const com = { x: 0, y: 0, z: 0 };
  const momentum = { x: 0, y: 0, z: 0 };
  starts.forEach(({ position, linvel }, i) => {
    const m = built[i].mass;
    totalMass += m;
    com.x += position.x * m;
    com.y += position.y * m;
    com.z += position.z * m;
    momentum.x += linvel.x * m;
    momentum.y += linvel.y * m;
    momentum.z += linvel.z * m;
  });
  for (const { position, linvel } of starts) {
    position.x -= com.x / totalMass;
    position.y -= com.y / totalMass;
    position.z -= com.z / totalMass;
    linvel.x -= momentum.x / totalMass;
    linvel.y -= momentum.y / totalMass;
    linvel.z -= momentum.z / totalMass;
  }

  await Promise.all(
    built.map((b, i) => addAsteroid(b, `spaceAsteroid${i}`, starts[i].position, starts[i].linvel))
  );
};

/** The space scene's asteroids that still exist. */
export const getSpaceAsteroids = () => {
  const world = getECSWorld();
  asteroids = asteroids.filter((a) => world.isAlive(a.entityId));
  return asteroids;
};

/** Deletes every asteroid (spawned ones too) and creates the demo set again, on orbits for the
 * current G and softening. */
export const resetSpaceAsteroids = async () => {
  const world = getECSWorld();
  for (const a of asteroids) if (world.isAlive(a.entityId)) world.deleteEntity(a.entityId);
  asteroids = [];
  await createDemoAsteroids();
};

/** Adds a random asteroid (random seed, size and shape) 6-11 m from the origin, on a slower than
 * circular orbit round the whole group, so it falls inward. */
export const spawnSpaceAsteroid = async () => {
  const seed = Math.floor(Math.random() * 1e6);
  const random = createSeededRandom(seed);
  const built = buildAsteroid({
    name: `Rock ${seed}`,
    seed,
    radius: 0.35 + random() * 0.5,
    shape: [0.8 + random() * 0.8, 0.7 + random() * 0.5, 0.8 + random() * 0.5],
    palette: Math.floor(random() * PALETTES.length),
    spin: { x: random() - 0.5, y: random() - 0.5, z: random() - 0.5 },
  });
  const totalMass = getSpaceAsteroids().reduce((sum, a) => sum + a.mass, built.mass);
  const world = getECSWorld();

  // A few tries for a start that doesn't overlap a rock (the solver would fling them apart)
  let start = orbitStart({ radius: 8, inclination: 0, phase: 0 }, totalMass);
  for (let attempt = 0; attempt < 8; attempt++) {
    start = orbitStart(
      {
        radius: 6 + random() * 5,
        inclination: (random() - 0.5) * 40,
        phase: random() * 360,
        speed: 0.4 + random() * 0.5,
        retrograde: random() < 0.3,
      },
      totalMass
    );
    const { x, y, z } = start.position;
    const overlaps = asteroids.some((a) => {
      const rb = world.getRigidBody(a.entityId);
      if (!rb) return false;
      rb.readPoseInto(pose);
      const minDist = a.boundingRadius + built.rock.boundingRadius + 0.5;
      return (pose[0] - x) ** 2 + (pose[1] - y) ** 2 + (pose[2] - z) ** 2 < minDist * minDist;
    });
    if (!overlaps) break;
  }

  await addAsteroid(built, `spaceAsteroidSpawn${++spawnCount}`, start.position, start.linvel);
};

/**
 * The space demo (p114): the SPACE sky box (`space.skybox.json`, which owns the lights) around a
 * few procedural asteroids near the origin. World gravity is zero, and the toolkit's mutual
 * gravity pulls the rocks together; the demo set starts on loose orbits round the biggest one.
 * In the debug env the scene creates its own "Space demo" tab (removed on exit).
 */
export const scene = async () => {
  const updateLoaderFn = getLoaderStatusUpdater();
  updateLoaderFn({ loadedCount: 0, totalCount: 1 });

  asteroids = [];
  // Every scene load gets a fresh physics world (p101), so this doesn't reach other scenes
  getPhysicsWorld().setGravity({ x: 0, y: 0, z: 0 });
  // The mutual gravity's config is global: set the demo's on every load
  setMutualGravityConfig(SPACE_GRAVITY);

  await createDemoAsteroids();

  if (IS_DEBUG_ENV) {
    const { createSpaceDemoTab } = await import('./_dbg__spaceDemo');
    createSpaceDemoTab();
  }

  updateLoaderFn({ loadedCount: 1, totalCount: 1 });
};
