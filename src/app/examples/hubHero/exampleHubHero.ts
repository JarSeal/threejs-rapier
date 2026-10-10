import * as THREE from 'three/webgpu';
import { getECSWorld } from '../../../_engine/core/ECS';
import { SpinComponentType } from '../ecs/SpinComponent';
import { saveBufferGeometry } from '../../../_engine/core/Geometry';
import { getMaterial } from '../../../_engine/core/Material';
import { createMeshEntity } from '../../../_engine/core/MeshManager';
import { existsOrThrow } from '../../../_engine/utils/assert';
import { generateAsteroid } from '../../../toolkit/geometry/generateAsteroid';
import { createSeededRandom } from '../../../toolkit/geometry/seededRandom';

/** Dark rock colours for the asteroid material (its own grey-brown, a carbonaceous grey) */
const PALETTES = [
  { colorA: '#4a4540', colorB: '#6e665d', pitColor: '#1f1c19' },
  { colorA: '#2e2e33', colorB: '#47474f', pitColor: '#121214' },
];

/**
 * The Ækasha Hub homepage's image (p554 §2.4), saved from the scene's Hub tab (`HERO` size). Not an example page of its own: a
 * large asteroid in a glowing ring, smaller ones around it, the SPACE sky box and a bloom pass.
 * The left of the frame is left empty: the homepage fades the image out under its text.
 */
export const scene = async () => {
  const world = getECSWorld();
  const material = existsOrThrow(getMaterial('asteroid'), 'No asteroid material.');

  const addAsteroid = (opts: {
    seed: number;
    radius: number;
    shape?: [number, number, number];
    detail?: number;
    position: { x: number; y: number; z: number };
    spin: number;
  }) => {
    const rock = generateAsteroid(opts);
    const geo = saveBufferGeometry(rock.geometry, { id: `heroAsteroid${opts.seed}` });
    if (geo !== rock.geometry) rock.geometry.dispose();
    const entityId = createMeshEntity({
      geo,
      mat: material,
      matOverrides: { nodes: { colorNode: { seed: opts.seed, ...PALETTES[opts.seed % 2] } } },
      position: opts.position,
      castShadow: true,
      receiveShadow: true,
    });
    const axis = { x: Math.sin(opts.seed), y: 1, z: Math.cos(opts.seed) };
    world.addComponent(entityId, SpinComponentType.SPIN, { axis, speed: opts.spin });
    return entityId;
  };

  // The large one, and its ring: a thin torus whose emissive colour is bright enough to bloom,
  // tilted so its near side passes below the rock's centre
  addAsteroid({
    seed: 3,
    radius: 2.4,
    shape: [1.08, 0.94, 1],
    detail: 10,
    position: { x: 0, y: 0, z: 0 },
    spin: 0.05,
  });
  const torus = new THREE.TorusGeometry(3.7, 0.035, 12, 256);
  const ringGeo = saveBufferGeometry(torus, { id: 'heroRing' });
  if (ringGeo !== torus) torus.dispose();
  const ringId = createMeshEntity({
    geo: ringGeo,
    mat: {
      id: 'heroRing',
      type: 'STANDARD',
      params: { color: '#000000', emissive: '#7fe3ff', emissiveIntensity: 6 },
    },
    rotation: { x: 1.92, y: 0, z: -0.32 },
  });
  world.addComponent(ringId, SpinComponentType.SPIN, { axis: { x: 0, y: 0, z: 1 }, speed: 0.08 });

  // Smaller ones to the right of it and behind it (the left is under the homepage's text), the
  // same every time
  const random = createSeededRandom(11);
  for (let i = 0; i < 16; i++) {
    const position = { x: 1 + random() * 11, y: (random() - 0.5) * 8, z: 3 - random() * 17 };
    // Not in the ring
    if (Math.hypot(position.x, position.y, position.z) < 5) position.z -= 6;
    addAsteroid({
      seed: 20 + i,
      radius: 0.15 + random() * 0.55,
      shape: [0.8 + random() * 0.7, 0.7 + random() * 0.5, 0.8 + random() * 0.5],
      position,
      spin: 0.1 + random() * 0.3,
    });
  }
};
