import * as THREE from 'three/webgpu';

import { ECSSystemStage } from '../_engine/core/ECS/SystemStages';
import {
  createCameraEntity,
  getActiveCameraId,
  setMainCamera,
} from '../_engine/core/CameraManager';
import type { ECSWorld } from '../_engine/core/ECS';
import { getECSWorld, getEntityIdByAppId } from '../_engine/core/ECS';
import { ComponentType } from '../_engine/core/ECS/ECSCoreComponents';
import { createGeometry } from '../_engine/core/Geometry';
import { createKeyBinding } from '../_engine/core/Input/KeyboardInput';
import { createLines, polylineToSegments } from '../_engine/core/LineManager';
import { createMaterial, decMaterialRef, incMaterialRef } from '../_engine/core/Material';
import { createMeshEntity, setMeshMaterial } from '../_engine/core/MeshManager';
import type { PhysicsTier, PhysicsTierRing } from '../_engine/core/Physics/PhysicsTierTypes';
import { createPhysicsEntity } from '../_engine/core/PhysicsManager';
import { setPhysicsTierPolicy } from '../_engine/core/PhysicsTierPolicy';
import { registerOnSceneEnter, registerOnSceneExit } from '../_engine/core/Scene';
import { getLoaderStatusUpdater } from '../_engine/core/SceneLoader';
import { existsOrThrow } from '../_engine/utils/assert';
import { lwarn } from '../_engine/utils/Logger';

/**
 * Physics simulation tiers demo (docs/plans/_DONE_p352_physics-simulation-tiers.md §5): crate piles
 * whose tiers follow a distance policy around a kinematic plough ball. The plough mows a
 * serpentine through the piles, so the crates it scatters freeze (STATIC), drop out of the
 * simulation (DISABLED) and out of the physics world (REMOVED) as it moves on, and come back where
 * they were left when it returns. Each crate is tinted by its tier. The policy runs on fixed
 * steps (the default STEPS cadence, p343) and the plough moves on them, so a visit plays out the
 * same way every time, in both worker targets.
 */

export const PHYSICS_TIERS_SCENE_ID = 'physicsTiers';

const GRID = 7;
const PILE_SPACING = 70;
/** Pile layers, bottom first: a 3 × 3, a 2 × 2 and one crate on top (14 crates). */
const PILE_LAYERS = [3, 2, 1];
const CRATE_HALF = 1.2;
const GROUND_SIZE = 600;
const PLOUGH_RADIUS = 4;
const PLOUGH_SPEED = 20;

const RINGS: PhysicsTierRing[] = [
  { tier: 'FULL', within: 40 },
  { tier: 'STATIC', within: 90 },
  { tier: 'DISABLED', within: 160 },
  { tier: 'REMOVED' },
];

const TIER_COLORS: Record<PhysicsTier, number> = {
  FULL: 0xd9822b,
  STATIC: 0x3d7bd9,
  DISABLED: 0x7a7a7a,
  REMOVED: 0xbfc8d6,
};

const STEP_SYSTEM_ID = 'physicsTiersPloughSystem';
const TINT_SYSTEM_ID = 'physicsTiersTintSystem';

/** The plough's path: along each pile row, alternating direction, then back to the start. */
const createPloughPath = () => {
  const half = ((GRID - 1) / 2) * PILE_SPACING;
  const reach = half + 25;
  const points: THREE.Vector3[] = [];
  for (let row = 0; row < GRID; row++) {
    const z = -half + row * PILE_SPACING;
    const fromX = row % 2 ? reach : -reach;
    points.push(
      new THREE.Vector3(fromX, PLOUGH_RADIUS, z),
      new THREE.Vector3(-fromX, PLOUGH_RADIUS, z)
    );
  }
  points.push(points[0].clone());
  const lengths = points.slice(1).map((p, i) => p.distanceTo(points[i]));
  const total = lengths.reduce((sum, length) => sum + length, 0);
  /** The point `distance` along the (looping) path, written into `out`. */
  const pointAt = (distance: number, out: THREE.Vector3) => {
    let d = distance % total;
    for (let i = 0; i < lengths.length; i++) {
      if (d <= lengths[i]) return out.lerpVectors(points[i], points[i + 1], d / lengths[i]);
      d -= lengths[i];
    }
    return out.copy(points[0]);
  };
  return { start: points[0], pointAt };
};

/** Flat `xyz` segments of a circle on the XZ plane. */
const circleSegments = (radius: number, y: number) => {
  const points: THREE.Vector3[] = [];
  const count = Math.max(32, Math.round(radius * 1.5));
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2;
    points.push(new THREE.Vector3(Math.cos(angle) * radius, y, Math.sin(angle) * radius));
  }
  return polylineToSegments(points, true);
};

/** Tints each crate by its tier: one shared material per tier, swapped only on a change. The
 * scene holds a ref on each until `release`: a material no crate shows would be disposed. */
const createTintSystem = (crateMeshes: Map<number, THREE.Mesh>) => {
  const materials = {} as Record<PhysicsTier, THREE.Material>;
  const materialIds = (Object.keys(TIER_COLORS) as PhysicsTier[]).map(
    (tier) => `physicsTiersCrate_${tier}`
  );
  for (const tier of Object.keys(TIER_COLORS) as PhysicsTier[]) {
    const removed = tier === 'REMOVED';
    materials[tier] = createMaterial({
      id: `physicsTiersCrate_${tier}`,
      type: 'STANDARD',
      params: {
        color: TIER_COLORS[tier],
        roughness: 0.7,
        ...(removed ? { transparent: true, opacity: 0.25, depthWrite: false } : {}),
      },
    });
  }
  for (const id of materialIds) incMaterialRef(id);
  const release = () => {
    for (const id of materialIds) decMaterialRef(id);
  };
  const shown = new Map<number, PhysicsTier>();
  const system = (world: ECSWorld) => {
    const tiers = world.getStorage(ComponentType.PHYSICS_SIM_TIER);
    for (const [entityId, mesh] of crateMeshes) {
      const tier = tiers.get(entityId)?.tier ?? 'FULL';
      if (shown.get(entityId) === tier) continue;
      shown.set(entityId, tier);
      setMeshMaterial(mesh, materials[tier]);
      // A ghost casts no shadow
      mesh.castShadow = tier !== 'REMOVED';
    }
  };
  return { material: materials.FULL, system, release };
};

export const scene = async () => {
  const updateLoaderFn = getLoaderStatusUpdater();
  const world = getECSWorld();
  const pileCount = GRID * GRID;
  updateLoaderFn({ loadedCount: 0, totalCount: pileCount + 1 });

  // --- Ground
  const groundId = createMeshEntity(
    {
      geo: createGeometry({
        id: 'physicsTiersGround',
        type: 'BOX',
        params: { width: GROUND_SIZE, height: 1, depth: GROUND_SIZE },
      }),
      mat: createMaterial({
        id: 'physicsTiersGround',
        type: 'STANDARD',
        params: { color: 0x3c4a3a, roughness: 0.95 },
      }),
      position: { x: 0, y: -0.5, z: 0 },
      receiveShadow: true,
    },
    { appId: 'physicsTiersGround', debugData: { name: 'Physics tiers ground' } }
  );
  await createPhysicsEntity({ type: 'BOX' }, { rigidType: 'FIXED' }, groundId);

  // --- Crate piles, every crate in the tier policy
  const crateMeshes = new Map<number, THREE.Mesh>();
  const tint = createTintSystem(crateMeshes);
  const crateGeo = createGeometry({
    id: 'physicsTiersCrate',
    type: 'BOX',
    params: { width: CRATE_HALF * 2, height: CRATE_HALF * 2, depth: CRATE_HALF * 2 },
  });
  const half = ((GRID - 1) / 2) * PILE_SPACING;
  const size = CRATE_HALF * 2;
  for (let pz = 0; pz < GRID; pz++) {
    for (let px = 0; px < GRID; px++) {
      const pileX = -half + px * PILE_SPACING;
      const pileZ = -half + pz * PILE_SPACING;
      const creates: Promise<number>[] = [];
      PILE_LAYERS.forEach((perSide, layer) => {
        const offset = ((perSide - 1) / 2) * size;
        for (let iz = 0; iz < perSide; iz++) {
          for (let ix = 0; ix < perSide; ix++) {
            const position = {
              x: pileX - offset + ix * size,
              y: CRATE_HALF + layer * size,
              z: pileZ - offset + iz * size,
            };
            const appId = `physicsTiersCrate_${px}_${pz}_${layer}_${ix}_${iz}`;
            const meshId = createMeshEntity(
              {
                geo: crateGeo,
                mat: tint.material,
                position,
                castShadow: true,
                receiveShadow: true,
              },
              { appId }
            );
            const mesh = world.getComponent(meshId, ComponentType.OBJECT3D)?.value as THREE.Mesh;
            crateMeshes.set(meshId, mesh);
            creates.push(
              createPhysicsEntity(
                { type: 'BOX', hx: CRATE_HALF, hy: CRATE_HALF, hz: CRATE_HALF, friction: 0.8 },
                { rigidType: 'DYNAMIC', translation: position },
                meshId,
                { tierPolicy: true }
              )
            );
          }
        }
      });
      await Promise.all(creates);
      updateLoaderFn({ loadedCount: pz * GRID + px + 1, totalCount: pileCount + 1 });
    }
  }

  // --- The plough: a kinematic ball the policy is centred on, with its rings drawn around it
  const path = createPloughPath();
  const ploughId = createMeshEntity(
    {
      geo: createGeometry({
        id: 'physicsTiersPlough',
        type: 'SPHERE',
        params: { radius: PLOUGH_RADIUS, widthSegments: 32, heightSegments: 16 },
      }),
      mat: createMaterial({
        id: 'physicsTiersPlough',
        type: 'STANDARD',
        params: { color: 0xffe08a, emissive: 0xffb02e, emissiveIntensity: 0.6 },
      }),
      position: path.start,
      castShadow: true,
    },
    { appId: 'physicsTiersPlough', debugData: { name: 'Physics tiers plough' } }
  );
  await createPhysicsEntity(
    { type: 'BALL', radius: PLOUGH_RADIUS },
    { rigidType: 'POS_BASED', translation: path.start },
    ploughId
  );
  const ploughBody = existsOrThrow(
    world.getRigidBody(ploughId),
    'Could not find the plough body in the physicsTiers scene.'
  );
  RINGS.forEach(({ tier, within }) => {
    if (within === undefined) return;
    createLines({
      id: `physicsTiersRing_${tier}`,
      segments: circleSegments(within, 0.15 - PLOUGH_RADIUS),
      color: TIER_COLORS[tier],
      width: 2,
      attach: { to: 'ENTITY', entityId: ploughId, world },
    });
  });

  setPhysicsTierPolicy(
    {
      focus: () => ploughId,
      rings: RINGS,
      interval: 10,
      cadence: 'STEPS', // Optional (default is 'STEPS')
      sceneId: PHYSICS_TIERS_SCENE_ID,
    },
    world
  );

  // Moved on fixed steps (scene time, not frame time), so the plough runs the same every visit
  let travelled = 0;
  const target = new THREE.Vector3();
  world.removeSystem(STEP_SYSTEM_ID);
  world.addSystem(ECSSystemStage.APP_PHYSICS_STEP, STEP_SYSTEM_ID, (_world, dt) => {
    travelled += PLOUGH_SPEED * dt;
    ploughBody.setNextKinematicTranslation(path.pointAt(travelled, target));
  });
  world.removeSystem(TINT_SYSTEM_ID);
  world.addSystem(ECSSystemStage.APP_RENDER_SYNC, TINT_SYSTEM_ID, tint.system);

  // --- Chase camera, C switches between it and the overview
  const chaseOffset = new THREE.Vector3(0, 55, 80);
  const chaseId = createCameraEntity(
    {
      type: 'PERSPECTIVE',
      fov: 55,
      near: 0.5,
      far: 1200,
      active: false,
      position: {
        x: path.start.x + chaseOffset.x,
        y: path.start.y + chaseOffset.y,
        z: path.start.z + chaseOffset.z,
      },
      lookAtPoint: { x: path.start.x, y: path.start.y, z: path.start.z },
    },
    {
      appId: 'physicsTiersChase',
      debugData: { name: 'Physics tiers chase camera', description: 'Follows the plough.' },
    },
    world
  );
  world.addComponent(chaseId, ComponentType.FOLLOW, {
    leaderId: ploughId,
    offset: chaseOffset,
    targetOffset: new THREE.Vector3(),
    speed: 4,
  });
  createKeyBinding({
    id: 'physicsTiersToggleCamera',
    chord: { key: 'c' },
    caseInsensitive: true,
    type: 'KEY_UP',
    sceneId: PHYSICS_TIERS_SCENE_ID,
    fn: () => {
      const overviewId = getEntityIdByAppId('physicsTiersOverview', world);
      if (overviewId === undefined) return;
      setMainCamera(world, getActiveCameraId() === overviewId ? chaseId : overviewId);
    },
  });

  // The JSON lights are created after this function runs: the sun gets its shadow fit on enter
  registerOnSceneEnter(PHYSICS_TIERS_SCENE_ID, () => {
    const sunId = getEntityIdByAppId('physicsTiersSun', world);
    if (sunId === undefined) {
      lwarn("Physics tiers scene: could not find the sun light 'physicsTiersSun'.");
      return;
    }
    world.addComponent(sunId, ComponentType.SUN_SHADOW_FIT, {
      maxDistance: 160,
      casterExtension: 10,
    });
  });
  // (One exit callback per scene: registerOnSceneExit replaces any earlier one.)
  registerOnSceneExit(PHYSICS_TIERS_SCENE_ID, () => {
    world.removeSystem(STEP_SYSTEM_ID);
    world.removeSystem(TINT_SYSTEM_ID);
    tint.release();
  });

  updateLoaderFn({ loadedCount: pileCount + 1, totalCount: pileCount + 1 });
};
