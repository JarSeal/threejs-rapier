import { createGeometry } from '../_engine/core/Geometry';
import { createMaterial } from '../_engine/core/Material';
import { createMeshEntity } from '../_engine/core/MeshManager';
import { createPhysicsEntity } from '../_engine/core/PhysicsManager';
import { addToast } from '../_engine/core/UI/Toaster';
import { getECSWorld } from '../_engine/core/ECS';
import { createJoint, getPhysicsWorld } from '../_engine/core/PhysicsAPI';
import { JointAxesMask, PhysVector } from '../_engine/core/Physics/PhysicsAPITypes';
import { existsOrThrow } from '../_engine/utils/assert';
import { IS_DEBUG_ENV } from '../_engine/core/Config';
import { llog } from '../_engine/utils/Logger';

/**
 * Main-thread physics API MVP verification scene
 * (docs/plans/p020_main-thread-physics-api-mvp.md §3.7): a static ground box,
 * a falling ball, and a falling box — plus one worked example per impulse-joint
 * type (docs/plans/p026_physics-api-support-for-joints.md, Phase 3) and a
 * shape-cast worked example against the ground box
 * (docs/plans/p028_refactor-old-phys-objs-to-phys-entities.md, Phase 0).
 */
export const scene = async () => {
  const ecsWorld = getECSWorld();

  /** Reads back the RigidBodyAPI.id a createPhysicsEntity() call attached to `entityId`. */
  const rigidBodyIdOf = (entityId: number, label: string) =>
    existsOrThrow(
      ecsWorld.getRigidBody(entityId),
      `Could not find a rigid body on entity ${entityId} (${label}) in physicsTest scene.`
    ).id;

  /** A small dark static anchor box — the shared visual language for every joint demo's
   * fixed attachment point below. */
  const createAnchorBody = async (id: string, position: PhysVector) => {
    const geo = createGeometry({
      id,
      type: 'BOX',
      params: { width: 0.4, height: 0.4, depth: 0.4 },
    });
    const mat = createMaterial({ id, type: 'STANDARD', params: { color: 0x2a2a2a } });
    const entityId = createMeshEntity(
      { geo, mat, position, castShadow: true, receiveShadow: true },
      { appId: id }
    );
    await createPhysicsEntity(
      { type: 'BOX', hx: 0.2, hy: 0.2, hz: 0.2 },
      { rigidType: 'FIXED', translation: position },
      entityId
    );
    return rigidBodyIdOf(entityId, id);
  };

  /** A dynamic colored box, half-extents (hx, hy, hz) default 0.4. */
  const createDynamicBox = async (
    id: string,
    position: PhysVector,
    color: number,
    opts?: { hx?: number; hy?: number; hz?: number; restitution?: number }
  ) => {
    const hx = opts?.hx ?? 0.4;
    const hy = opts?.hy ?? 0.4;
    const hz = opts?.hz ?? 0.4;
    const geo = createGeometry({
      id,
      type: 'BOX',
      params: { width: hx * 2, height: hy * 2, depth: hz * 2 },
    });
    const mat = createMaterial({ id, type: 'STANDARD', params: { color } });
    const entityId = createMeshEntity(
      { geo, mat, position, castShadow: true, receiveShadow: true },
      { appId: id }
    );
    await createPhysicsEntity(
      { type: 'BOX', hx, hy, hz, restitution: opts?.restitution },
      { rigidType: 'DYNAMIC', translation: position },
      entityId
    );
    return rigidBodyIdOf(entityId, id);
  };

  /** A dynamic colored ball, radius default 0.4. */
  const createDynamicBall = async (
    id: string,
    position: PhysVector,
    color: number,
    radius = 0.4
  ) => {
    const geo = createGeometry({ id, type: 'SPHERE', params: { radius } });
    const mat = createMaterial({ id, type: 'STANDARD', params: { color } });
    const entityId = createMeshEntity(
      { geo, mat, position, castShadow: true, receiveShadow: true },
      { appId: id }
    );
    await createPhysicsEntity(
      { type: 'BALL', radius },
      { rigidType: 'DYNAMIC', translation: position },
      entityId
    );
    return rigidBodyIdOf(entityId, id);
  };

  // --- Ground -------------------------------------------------------------
  const groundGeo = createGeometry({
    id: 'physicsTestGround',
    type: 'BOX',
    params: { width: 50, height: 0.5, depth: 50 },
  });
  const groundMat = createMaterial({
    id: 'physicsTestGround',
    type: 'STANDARD',
    params: { color: 0x666666 },
  });
  const groundEntityId = createMeshEntity(
    {
      geo: groundGeo,
      mat: groundMat,
      position: { x: 0, y: 0, z: 0 },
      castShadow: true,
      receiveShadow: true,
    },
    { appId: 'physicsTestGroundMesh' }
  );
  await createPhysicsEntity(
    { type: 'BOX', hx: 25, hy: 0.25, hz: 25 },
    { rigidType: 'FIXED', translation: { x: 0, y: 0, z: 0 } },
    groundEntityId
  );

  // --- Shape-cast demo (docs/plans/p028, Phase 0) --------------------------
  // Two casts of a small ball shape from the same point: one straight down into the ground
  // box (expects a hit with a sane normal/TOI), one straight up into open air (expects no
  // hit) — the two cases this phase's manual-verification step calls for. Always uses the
  // async castShape (not castShapeSync, which throws in WORKER_THREAD mode) so this works
  // identically in both workerTarget modes.
  //
  // Deliberately NOT awaited by scene() (fire-and-forget, `void`): the short delay below is
  // required (Rapier's query pipeline only indexes a newly-created collider once the physics
  // world has stepped at least once, so querying synchronously right after
  // createPhysicsEntity() resolves reports no hit even when the geometry genuinely overlaps —
  // confirmed against castRay too, not specific to castShape), but awaiting it inside scene()
  // would hold up the whole scene-loading chain (setCurrentScene() runs only after scene()
  // resolves) long enough to race the main loop, which can start as soon as the root Three.js
  // scene gets any children — independent of scene loading. That race crashed
  // renderPhysicsObjects() with "Could not get current scene id" when this scene was set as
  // the debug start scene, where the extra ~200ms was enough to matter. Real gameplay queries
  // don't hit either issue, since they naturally run from a system that already ticks after
  // the scene has fully loaded and the world has been stepping for a while.
  void (async () => {
    // Reports via toast when the debug UI is up, falling back to a console log otherwise —
    // when this scene is set as the debug start scene, this demo can run before the debug
    // drawer's toaster has been created (toast infra registers after appStartFn() resolves,
    // which this fire-and-forget block deliberately doesn't block on, see above).
    const report = (title: string, message: string) => {
      if (!IS_DEBUG_ENV) return;
      try {
        addToast({ title, message });
      } catch {
        llog(`[physicsTest] ${title}: ${message}`);
      }
    };

    const castOrigin: PhysVector = { x: 0, y: 5, z: 20 };
    const noRotation = { x: 0, y: 0, z: 0, w: 1 };
    const castShapeParams = { type: 'BALL' as const, radius: 0.5 };

    await new Promise((resolve) => setTimeout(resolve, 200));

    const groundHit = await getPhysicsWorld().castShape(
      castOrigin,
      noRotation,
      { x: 0, y: -1, z: 0 },
      castShapeParams,
      0,
      10,
      true
    );
    report(
      'Shape-cast toward ground',
      groundHit
        ? `Hit, TOI ${groundHit.timeOfImpact.toFixed(2)}, normal (${groundHit.normal1.x.toFixed(2)}, ${groundHit.normal1.y.toFixed(2)}, ${groundHit.normal1.z.toFixed(2)})`
        : 'No hit (unexpected)'
    );

    const emptyHit = await getPhysicsWorld().castShape(
      castOrigin,
      noRotation,
      { x: 0, y: 1, z: 0 },
      castShapeParams,
      0,
      10,
      true
    );
    report('Shape-cast away from ground', emptyHit ? 'Hit (unexpected)' : 'No hit, as expected');
  })();

  // --- Original falling ball/box demo (shifted off to the side, away from the
  // joint demo row below) ---------------------------------------------------
  const ballGeo = createGeometry({
    id: 'physicsTestBall',
    type: 'SPHERE',
    params: { radius: 0.5 },
  });
  const ballMat = createMaterial({
    id: 'physicsTestBall',
    type: 'STANDARD',
    params: { color: 0xff4444 },
  });
  const ballEntityId = createMeshEntity(
    {
      geo: ballGeo,
      mat: ballMat,
      position: { x: -1, y: 5, z: 10 },
      castShadow: true,
      receiveShadow: true,
    },
    { appId: 'physicsTestBallMesh' }
  );
  await createPhysicsEntity(
    { type: 'BALL', radius: 0.5, userData: { name: 'Ball' } },
    { rigidType: 'DYNAMIC', translation: { x: -1, y: 5, z: 10 }, angvel: { x: 0, y: 0, z: -3 } },
    ballEntityId
  );

  const boxGeo = createGeometry({
    id: 'physicsTestBox',
    type: 'BOX',
    params: { width: 1, height: 1, depth: 1 },
  });
  const boxMat = createMaterial({
    id: 'physicsTestBox',
    type: 'STANDARD',
    params: { color: 0x4488ff },
  });
  const boxEntityId = createMeshEntity(
    {
      geo: boxGeo,
      mat: boxMat,
      position: { x: 1, y: 7, z: 10 },
      castShadow: true,
      receiveShadow: true,
    },
    { appId: 'physicsTestBoxMesh' }
  );
  await createPhysicsEntity(
    { type: 'BOX', hx: 0.5, hy: 0.5, hz: 0.5, userData: { name: 'Box' } },
    { rigidType: 'DYNAMIC', translation: { x: 1, y: 7, z: 10 }, angvel: { x: 1, y: 7, z: 0 } },
    boxEntityId
  );

  // Invisible sensor just above the ground's top face (ground: hy: 0.25, top face at
  // y = 0.25) — toasts the entering entity's name on contact start. Moved along with the
  // ball/box demo above so it still sits under them.
  await createPhysicsEntity(
    {
      type: 'BOX',
      hx: 5,
      hy: 0.25,
      hz: 5,
      isSensor: true,
      collisionEventFn: (_sensor, other, started) => {
        if (!started) return;
        const otherName = other.getUserDataSync().name;
        const name = typeof otherName === 'string' ? otherName : String(other.id);
        if (IS_DEBUG_ENV) {
          addToast({ title: 'Physics sensor', message: `${name} entered` });
        }
      },
    },
    { rigidType: 'FIXED', translation: { x: 0, y: 0.5, z: 10 } },
    // No mesh to hang off, so this one creates its own entity — give it an explicit appId
    // like the three above have, otherwise it gets a fresh UUID on every load and any
    // per-entity debug settings (e.g. a wireframe toggle) can't survive a reload.
    undefined,
    { appId: 'physicsTestSensor' }
  );

  // --- Joint showcase (Phase 3) ---------------------------------------------
  // One worked example per impulse-joint geometry type, arranged in a row along
  // z = JOINT_DEMO_Z, separate from the ball/box demo above.
  const JOINT_DEMO_Z = -15;

  // FIXED (orange) — a dynamic box rigidly locked to a static anchor: no relative motion at all,
  // it just floats in place next to it.
  {
    const x = -21;
    const anchorId = await createAnchorBody('physicsJointFixedAnchor', {
      x,
      y: 6,
      z: JOINT_DEMO_Z,
    });
    const boxId = await createDynamicBox(
      'physicsJointFixedBox',
      { x, y: 5, z: JOINT_DEMO_Z },
      0xff8844
    );
    const joint = await createJoint({
      type: 'FIXED',
      body1Id: anchorId,
      body2Id: boxId,
      anchor1: { x: 0, y: -1, z: 0 },
      frame1: { x: 0, y: 0, z: 0, w: 1 },
      anchor2: { x: 0, y: 0, z: 0 },
      frame2: { x: 0, y: 0, z: 0, w: 1 },
    });
    joint.setContactsEnabled(false);
  }

  // REVOLUTE (yellow) — a thin arm hinged on its static anchor's Y axis, spun continuously by a
  // velocity motor: an obviously visible rotating arm.
  {
    const x = -14;
    const anchorPos = { x, y: 6, z: JOINT_DEMO_Z };
    const armHalfLength = 1;
    const anchorId = await createAnchorBody('physicsJointRevoluteAnchor', anchorPos);
    const armId = await createDynamicBox(
      'physicsJointRevoluteArm',
      { x: anchorPos.x + armHalfLength, y: anchorPos.y, z: anchorPos.z },
      0xffee44,
      { hx: armHalfLength, hy: 0.2, hz: 0.2 }
    );
    const joint = await createJoint({
      type: 'REVOLUTE',
      body1Id: anchorId,
      body2Id: armId,
      anchor1: { x: 0, y: 0, z: 0 },
      anchor2: { x: -armHalfLength, y: 0, z: 0 },
      axis: { x: 0, y: 1, z: 0 },
    });
    joint.setContactsEnabled(false);
    joint.configureMotorModel('ACCELERATION_BASED');
    joint.configureMotorVelocity(2, 1);
  }

  // PRISMATIC (teal) — a block sliding vertically along its static anchor's Y axis, bounded by
  // setLimits and given some restitution so it bounces between the two limits.
  {
    const x = -7;
    const anchorPos = { x, y: 8, z: JOINT_DEMO_Z };
    const anchorId = await createAnchorBody('physicsJointPrismaticAnchor', anchorPos);
    const blockId = await createDynamicBox(
      'physicsJointPrismaticBlock',
      { ...anchorPos },
      0x44ffaa,
      { restitution: 0.7 }
    );
    const joint = await createJoint({
      type: 'PRISMATIC',
      body1Id: anchorId,
      body2Id: blockId,
      anchor1: { x: 0, y: 0, z: 0 },
      anchor2: { x: 0, y: 0, z: 0 },
      axis: { x: 0, y: 1, z: 0 },
    });
    joint.setContactsEnabled(false);
    joint.setLimits(-4, 0);
  }

  // SPHERICAL (purple) — a ball swinging freely on all rotational axes (unlike Revolute's
  // single-axis swing), started off-center on two axes for a visibly conical pendulum.
  {
    const x = 0;
    const anchorPos = { x, y: 8, z: JOINT_DEMO_Z };
    const ballPos = { x: x + 2, y: 6, z: JOINT_DEMO_Z + 1 };
    const anchorId = await createAnchorBody('physicsJointSphericalAnchor', anchorPos);
    const ballId = await createDynamicBall('physicsJointSphericalBall', ballPos, 0xaa44ff);
    const joint = await createJoint({
      type: 'SPHERICAL',
      body1Id: anchorId,
      body2Id: ballId,
      anchor1: { x: 0, y: 0, z: 0 },
      anchor2: {
        x: anchorPos.x - ballPos.x,
        y: anchorPos.y - ballPos.y,
        z: anchorPos.z - ballPos.z,
      },
    });
    joint.setContactsEnabled(false);
  }

  // ROPE (blue) — a ball started closer to its static anchor than the rope's max length, so it
  // free-falls with visible slack before the rope pulls taut.
  {
    const x = 7;
    const anchorPos = { x, y: 8, z: JOINT_DEMO_Z };
    const ballPos = { x, y: 7, z: JOINT_DEMO_Z };
    const anchorId = await createAnchorBody('physicsJointRopeAnchor', anchorPos);
    const ballId = await createDynamicBall('physicsJointRopeBall', ballPos, 0x44aaff);
    const joint = await createJoint({
      type: 'ROPE',
      body1Id: anchorId,
      body2Id: ballId,
      length: 4,
      anchor1: { x: 0, y: 0, z: 0 },
      anchor2: { x: 0, y: 0, z: 0 },
    });
    joint.setContactsEnabled(false);
  }

  // SPRING (pink) — a ball started well below the spring's rest length, so gravity and the
  // spring force visibly bounce it before it settles near the new equilibrium.
  {
    const x = 14;
    const anchorPos = { x, y: 8, z: JOINT_DEMO_Z };
    const ballPos = { x, y: 3, z: JOINT_DEMO_Z };
    const anchorId = await createAnchorBody('physicsJointSpringAnchor', anchorPos);
    const ballId = await createDynamicBall('physicsJointSpringBall', ballPos, 0xff44aa);
    const joint = await createJoint({
      type: 'SPRING',
      body1Id: anchorId,
      body2Id: ballId,
      restLength: 2,
      stiffness: 30,
      damping: 2,
      anchor1: { x: 0, y: 0, z: 0 },
      anchor2: { x: 0, y: 0, z: 0 },
    });
    joint.setContactsEnabled(false);
  }

  // GENERIC (lime) — a box whose axesMask frees only the Y translation axis: it falls straight
  // down onto the ground with zero rotation and zero horizontal drift, the joint type most
  // others (Fixed/Revolute/Prismatic/Spherical) are specializations of.
  {
    const x = 21;
    const anchorPos = { x, y: 6, z: JOINT_DEMO_Z };
    const anchorId = await createAnchorBody('physicsJointGenericAnchor', anchorPos);
    const boxId = await createDynamicBox('physicsJointGenericBox', { ...anchorPos }, 0x88ff44);
    const joint = await createJoint({
      type: 'GENERIC',
      body1Id: anchorId,
      body2Id: boxId,
      anchor1: { x: 0, y: 0, z: 0 },
      anchor2: { x: 0, y: 0, z: 0 },
      axis: { x: 0, y: 1, z: 0 },
      axesMask: JointAxesMask.LinY,
    });
    joint.setContactsEnabled(false);
  }
};
